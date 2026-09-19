/**
 * Route-level tests for the admin-provisioned-tenant consent gate:
 *   POST /consent/confirm — consume an emailed invite token, stamp
 *                           tenants.legal_consent_*, send receipt emails.
 *   POST /consent/resend  — self-service reissue of the invite email.
 *
 * See supabase/migrations/20260916000000_tenant_admin_consent_gate.sql and
 * src/routes/consent.ts. Modeled on tests/routes/auth.test.ts's handler-
 * level style (captured route handlers run directly against a mock pool).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyReply } from 'fastify';
import bcrypt from 'bcrypt';
import type { AppRequest } from '../../src/middleware/fastify-middleware';
import { createMockClient, createMockPool } from '../mock';
import type { registerConsentRoutes as RegisterConsentRoutes } from '../../src/routes/consent';

vi.mock('../../src/services/communications/systemEmail', () => ({
  sendTenantConsentInviteEmail: vi.fn(async () => undefined),
  sendTenantConsentAttestedEmail: vi.fn(async () => undefined),
  sendTenantConsentPendingAdminNotice: vi.fn(async () => undefined),
  PLATFORM_ADMIN_EMAIL: 'admin@platform.test',
}));

type MockReply = FastifyReply & { statusCode: number; body: unknown };
type RouteHandler = (req: AppRequest, reply: FastifyReply) => Promise<unknown>;
type RouteOpts = { config?: { rateLimit?: { max: number; timeWindow: string } } };

function createMockReply(): MockReply {
  const reply = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(data: unknown) {
      reply.body = data;
      return reply;
    },
  } as unknown as MockReply;
  return reply;
}

function createMockRequest(body: Record<string, unknown> = {}): AppRequest {
  return {
    body,
    headers: {},
    ip: '127.0.0.1',
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: vi.fn().mockReturnThis() },
    url: '/test',
    method: 'POST',
  } as unknown as AppRequest;
}

interface RouteCapture {
  method: string;
  path: string;
  handler: RouteHandler;
  opts?: RouteOpts;
}

function captureRoutes() {
  const routes: RouteCapture[] = [];
  const app = {
    post: vi.fn((path: string, ...args: Array<RouteOpts | RouteHandler>) => {
      const handler = args[args.length - 1] as RouteHandler;
      const opts = args.length > 1 ? (args[0] as RouteOpts) : undefined;
      routes.push({ method: 'POST', path, handler, opts });
    }),
  };
  return { app, routes };
}

function findRoute(routes: RouteCapture[], path: string) {
  return routes.find((r) => r.path === path)!;
}

const TENANT_ID_MOCK = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_ID_MOCK = '11111111-2222-3333-4444-555555555555';
const INVITE_ID_MOCK = '22222222-3333-4444-5555-666666666666';

// Real base64url token of plausible length — ConfirmSchema requires 20-200 chars.
const RAW_TOKEN = 'a'.repeat(43);

describe('Consent Routes — Handler-Level', () => {
  let registerConsentRoutes: typeof RegisterConsentRoutes;

  beforeAll(async () => {
    const mod = await import('../../src/routes/consent');
    registerConsentRoutes = mod.registerConsentRoutes;
  });

  beforeEach(() => vi.clearAllMocks());

  // ── /consent/confirm ─────────────────────────────────────────────────

  describe('POST /consent/confirm handler', () => {
    it('WHO: owner clicking the emailed consent link | WHAT: valid unexpired unused token → stamps legal_consent_*, marks invite used, sends both receipt emails | WHERE: /consent/confirm | WHY: this is the write that actually closes the admin-tenant consent gap', async () => {
      const sysmail = await import('../../src/services/communications/systemEmail');
      const { mockClient: client, queryResponses, queries } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerConsentRoutes(app, pool);

      const attestedAt = new Date('2026-09-16T18:00:00Z');
      queryResponses.push({ rows: [] }); // BEGIN
      queryResponses.push({
        rows: [
          {
            tenant_consent_invite_id: INVITE_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            user_id: USER_ID_MOCK,
            owner_email: 'owner@business.com',
          },
        ],
      }); // SELECT invite ... FOR UPDATE
      queryResponses.push({
        rows: [{ name: 'Sharp Salon', legal_consent_attested_at: attestedAt }],
      }); // UPDATE tenants ... RETURNING
      queryResponses.push({ rows: [] }); // UPDATE tenant_consent_invites used_at
      queryResponses.push({ rows: [] }); // COMMIT

      const route = findRoute(routes, '/consent/confirm');
      const req = createMockRequest({ token: RAW_TOKEN });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body).toEqual({ success: true, business_name: 'Sharp Salon' });

      const updateTenants = queries.find((q) => /UPDATE tenants/i.test(q.text));
      expect(updateTenants).toBeDefined();
      expect(updateTenants?.params).toEqual([USER_ID_MOCK, '127.0.0.1', null, TENANT_ID_MOCK]);

      const markUsed = queries.find((q) => /UPDATE tenant_consent_invites/i.test(q.text));
      expect(markUsed?.params).toEqual([INVITE_ID_MOCK]);

      expect(queries[queries.length - 1].text).toBe('COMMIT');

      // Two receipt emails: owner + admin, both distinct from the original
      // invite email (never called by /consent/confirm itself).
      expect(sysmail.sendTenantConsentInviteEmail).not.toHaveBeenCalled();
      expect(sysmail.sendTenantConsentAttestedEmail).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(sysmail.sendTenantConsentAttestedEmail).mock.calls;
      const recipients = calls.map((c) => c[0]);
      expect(recipients).toContain('owner@business.com');
      expect(recipients).toContain('admin@platform.test');
      const audiences = calls.map((c) => c[2]);
      expect(audiences.sort()).toEqual(['admin', 'owner']);
    });

    it('WHO: someone with a stale/tampered/already-used link | WHAT: no matching row (miss, expired, or already used) | WHERE: /consent/confirm | WHY: 400 + generic message, ROLLBACK, no tenant write, no emails', async () => {
      const sysmail = await import('../../src/services/communications/systemEmail');
      const { mockClient: client, queryResponses, queries } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerConsentRoutes(app, pool);

      queryResponses.push({ rows: [] }); // BEGIN
      queryResponses.push({ rows: [] }); // SELECT invite — none found
      queryResponses.push({ rows: [] }); // ROLLBACK

      const route = findRoute(routes, '/consent/confirm');
      const req = createMockRequest({ token: RAW_TOKEN });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(400);
      expect(reply.body).toEqual({
        success: false,
        error: 'This link is invalid or has expired',
      });
      expect(queries.map((q) => q.text)).toEqual([
        'BEGIN',
        expect.stringContaining('SELECT tci.tenant_consent_invite_id'),
        'ROLLBACK',
      ]);
      expect(sysmail.sendTenantConsentAttestedEmail).not.toHaveBeenCalled();
    });

    it('rejects a malformed/missing token before touching the DB (WHO: any caller | WHAT: token shorter than 20 chars | WHERE: ConfirmSchema | WHY: same 400-before-query posture as /reset-password)', async () => {
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerConsentRoutes(app, pool);

      const route = findRoute(routes, '/consent/confirm');
      const req = createMockRequest({ token: 'short' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(400);
      expect(queryResponses).toHaveLength(0); // nothing was scripted, and nothing should be consumed
    });

    it('has rate limit of 5 per 15 minutes, same as /reset-password', () => {
      const pool = createMockPool({});
      const { app, routes } = captureRoutes();
      registerConsentRoutes(app, pool);

      const route = findRoute(routes, '/consent/confirm');
      expect(route.opts).toEqual({
        config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      });
    });
  });

  // ── /consent/resend ──────────────────────────────────────────────────

  describe('POST /consent/resend handler', () => {
    it('WHO: gated owner who never confirmed | WHAT: correct password, consent_gate_required=true, legal_consent_attested_at NULL | WHERE: /consent/resend | WHY: invalidates prior invites, issues a fresh one, emails it', async () => {
      const sysmail = await import('../../src/services/communications/systemEmail');
      const { mockClient: client, queryResponses, queries } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerConsentRoutes(app, pool);

      const realHash = await bcrypt.hash('pass123', 10);
      queryResponses.push({
        rows: [
          {
            user_id: USER_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            password_hash: realHash,
            email: 'gated@business.com',
            tenant_name: 'Gated Biz',
            consent_gate_required: true,
            legal_consent_attested_at: null,
          },
        ],
      }); // SELECT user+tenant
      queryResponses.push({ rows: [] }); // UPDATE invalidate prior invites
      queryResponses.push({ rows: [] }); // INSERT new invite

      const route = findRoute(routes, '/consent/resend');
      const req = createMockRequest({ email: 'gated@business.com', password: 'pass123' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body).toEqual({ success: true });
      const invalidate = queries.find((q) =>
        /UPDATE tenant_consent_invites SET used_at/i.test(q.text)
      );
      expect(invalidate?.params).toEqual([TENANT_ID_MOCK]);
      const insert = queries.find((q) => /INSERT INTO tenant_consent_invites/i.test(q.text));
      expect(insert?.params?.[0]).toBe(TENANT_ID_MOCK);
      expect(insert?.params?.[1]).toBe(USER_ID_MOCK);

      expect(sysmail.sendTenantConsentInviteEmail).toHaveBeenCalledTimes(1);
      const [to, , businessName] = vi.mocked(sysmail.sendTenantConsentInviteEmail).mock.calls[0];
      expect(to).toBe('gated@business.com');
      expect(businessName).toBe('Gated Biz');
    });

    it("WHO: someone guessing an email with the wrong password | WHAT: bcrypt compare fails | WHERE: /consent/resend | WHY: always returns success:true and never sends an email — matches /forgot-password's enumeration-safe shape", async () => {
      const sysmail = await import('../../src/services/communications/systemEmail');
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerConsentRoutes(app, pool);

      const realHash = await bcrypt.hash('correctpass', 10);
      queryResponses.push({
        rows: [
          {
            user_id: USER_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            password_hash: realHash,
            email: 'gated@business.com',
            tenant_name: 'Gated Biz',
            consent_gate_required: true,
            legal_consent_attested_at: null,
          },
        ],
      });

      const route = findRoute(routes, '/consent/resend');
      const req = createMockRequest({ email: 'gated@business.com', password: 'wrongpass' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body).toEqual({ success: true });
      expect(sysmail.sendTenantConsentInviteEmail).not.toHaveBeenCalled();
    });

    it('WHO: an email with no matching user | WHAT: SELECT returns nothing | WHERE: /consent/resend | WHY: still 200 success:true, no email sent — never reveals whether the account exists', async () => {
      const sysmail = await import('../../src/services/communications/systemEmail');
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerConsentRoutes(app, pool);

      queryResponses.push({ rows: [] });

      const route = findRoute(routes, '/consent/resend');
      const req = createMockRequest({ email: 'nobody@business.com', password: 'whatever' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body).toEqual({ success: true });
      expect(sysmail.sendTenantConsentInviteEmail).not.toHaveBeenCalled();
    });

    it('WHO: an owner on a tenant that is not gated at all (consent_gate_required=false) | WHAT: correct password, but nothing to resend | WHERE: /consent/resend | WHY: success:true, no email — resend is a no-op on a normal tenant', async () => {
      const sysmail = await import('../../src/services/communications/systemEmail');
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerConsentRoutes(app, pool);

      const realHash = await bcrypt.hash('pass123', 10);
      queryResponses.push({
        rows: [
          {
            user_id: USER_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            password_hash: realHash,
            email: 'normal@business.com',
            tenant_name: 'Normal Biz',
            consent_gate_required: false,
            legal_consent_attested_at: null,
          },
        ],
      });

      const route = findRoute(routes, '/consent/resend');
      const req = createMockRequest({ email: 'normal@business.com', password: 'pass123' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body).toEqual({ success: true });
      expect(sysmail.sendTenantConsentInviteEmail).not.toHaveBeenCalled();
    });

    it('WHO: an owner who already confirmed | WHAT: consent_gate_required=true but legal_consent_attested_at is set | WHERE: /consent/resend | WHY: success:true, no email — nothing left to resend', async () => {
      const sysmail = await import('../../src/services/communications/systemEmail');
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerConsentRoutes(app, pool);

      const realHash = await bcrypt.hash('pass123', 10);
      queryResponses.push({
        rows: [
          {
            user_id: USER_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            password_hash: realHash,
            email: 'confirmed@business.com',
            tenant_name: 'Confirmed Biz',
            consent_gate_required: true,
            legal_consent_attested_at: new Date('2026-09-16T00:00:00Z'),
          },
        ],
      });

      const route = findRoute(routes, '/consent/resend');
      const req = createMockRequest({ email: 'confirmed@business.com', password: 'pass123' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body).toEqual({ success: true });
      expect(sysmail.sendTenantConsentInviteEmail).not.toHaveBeenCalled();
    });

    it('has rate limit of 3 per hour, same as /forgot-password', () => {
      const pool = createMockPool({});
      const { app, routes } = captureRoutes();
      registerConsentRoutes(app, pool);

      const route = findRoute(routes, '/consent/resend');
      expect(route.opts).toEqual({
        config: { rateLimit: { max: 3, timeWindow: '1 hour' } },
      });
    });
  });
});
