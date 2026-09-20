import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { getRootClient, clearDB, createTenant, hashPassword, skipIfDbDown } from '../utils';
import { type Client } from 'pg';
import type { FastifyReply } from 'fastify';
import bcrypt from 'bcrypt';
import type { AppRequest } from '../../src/middleware/fastify-middleware';

// Mock the email sender so route tests don't try to send real mail
vi.mock('../../src/services/communications/systemEmail', () => ({
  sendPasswordResetEmail: vi.fn(async () => undefined),
}));

// ═══════════════════════════════════════════════════════════════════════
// Route-level tests for registerAuthRoutes (/login, /register, /auth/refresh)
// These test the actual Fastify route handler logic, not just DB queries.
// ═══════════════════════════════════════════════════════════════════════

// Mock bcrypt for route handler tests (the DB-level tests below use real bcrypt)
const _mockBcryptCompare = vi.fn();
const _mockBcryptHash = vi.fn();

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

function createMockRequest(
  body: Record<string, unknown> = {},
  auth?: AppRequest['auth']
): AppRequest {
  return {
    body,
    auth,
    headers: {},
    ip: '127.0.0.1',
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: vi.fn().mockReturnThis() },
    url: '/test',
    method: 'POST',
  } as unknown as AppRequest;
}

const TEST_TOKEN = 'jwt.test.token';
const TENANT_ID_MOCK = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_ID_MOCK = '11111111-2222-3333-4444-555555555555';

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

import { createMockClient, createMockPool } from '../mock';
import type * as AuthRoutes from '../../src/routes/auth';

describe('Auth Routes — Handler-Level', () => {
  let registerAuthRoutes: typeof AuthRoutes.registerAuthRoutes;
  const generateToken = vi.fn().mockReturnValue(TEST_TOKEN);

  beforeAll(async () => {
    // Dynamic import to allow bcrypt mock to take effect
    const mod = await import('../../src/routes/auth');
    registerAuthRoutes = mod.registerAuthRoutes;
  });

  beforeEach(() => vi.clearAllMocks());

  // ── /login ──────────────────────────────────────────────────────────

  describe('POST /login handler', () => {
    it('returns token on valid credentials (WHO: user | WHAT: email+password → JWT | WHERE: /login handler | WHY: successful auth grants session)', async () => {
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      queryResponses.push({
        rows: [
          {
            user_id: USER_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            email: 'test@example.com',
            password_hash: '$hash',
            full_name: 'Test User',
          },
        ],
      });

      const route = findRoute(routes, '/login');
      const req = createMockRequest({ email: 'test@example.com', password: 'pass123' });
      const reply = createMockReply();

      // bcrypt.compare is called via dynamic import inside the handler
      // We can't easily mock it, but we can verify the flow with real bcrypt
      // So let's use a real hash
      const realHash = await bcrypt.hash('pass123', 10);
      queryResponses.length = 0;
      queryResponses.push({
        rows: [
          {
            user_id: USER_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            email: 'test@example.com',
            password_hash: realHash,
            full_name: 'Test User',
            role: 'owner',
          },
        ],
      });

      await route.handler(req, reply);

      expect(reply.body.success).toBe(true);
      expect(reply.body.token).toBe(TEST_TOKEN);
      expect(reply.body.tenant_id).toBe(TENANT_ID_MOCK);
      expect(reply.body.user_id).toBe(USER_ID_MOCK);
      expect(reply.body.user_name).toBe('Test User');
      expect(reply.body.role).toBe('owner');
      expect(generateToken).toHaveBeenCalledWith({
        tenant_id: TENANT_ID_MOCK,
        user_id: USER_ID_MOCK,
        email: 'test@example.com',
        role: 'owner',
      });
    });

    // WHO: shop owner promoting a staff member to a stripped-down view.
    // WHAT: login user record carries role='front_desk'; the handler must
    // surface that on both the response body and the JWT payload so the
    // dashboard can hide Back Office and the JWT-only refresh path keeps
    // the role assignment intact.
    // WHERE: /login handler — runs before SessionContext sees the value.
    // WHY: without this the front-desk gating in OutlookLayout has nothing
    // to read; a front_desk user would still see Back Office.
    it('returns role=front_desk when user record has it', async () => {
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const realHash = await bcrypt.hash('pass123', 10);
      queryResponses.push({
        rows: [
          {
            user_id: USER_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            email: 'desk@example.com',
            password_hash: realHash,
            full_name: 'Desk Staff',
            role: 'front_desk',
          },
        ],
      });

      const route = findRoute(routes, '/login');
      const req = createMockRequest({ email: 'desk@example.com', password: 'pass123' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body.success).toBe(true);
      expect(reply.body.role).toBe('front_desk');
      expect(generateToken).toHaveBeenCalledWith({
        tenant_id: TENANT_ID_MOCK,
        user_id: USER_ID_MOCK,
        email: 'desk@example.com',
        role: 'front_desk',
      });
    });

    // WHO: legacy users created before the role column landed (defaulted
    // to 'owner' by the migration) — but also a defense-in-depth path for
    // any unexpected role value the DB might return.
    // WHAT: an unrecognized role value coerces to 'owner' so the user
    // never gets locked out of features they had access to yesterday.
    // WHERE: /login handler — between the bcrypt check and token mint.
    // WHY: a CHECK constraint already restricts the column, but the
    // server should never trust the row blindly; if a future migration
    // adds a third role and an old client deploys against new data, we
    // want graceful degradation, not a silent privilege downgrade.
    it("coerces unrecognized role values to 'owner'", async () => {
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const realHash = await bcrypt.hash('pass123', 10);
      queryResponses.push({
        rows: [
          {
            user_id: USER_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            email: 'legacy@example.com',
            password_hash: realHash,
            full_name: 'Legacy',
            role: 'unknown_future_role',
          },
        ],
      });

      const route = findRoute(routes, '/login');
      const req = createMockRequest({ email: 'legacy@example.com', password: 'pass123' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body.role).toBe('owner');
    });

    // WHO: a person whose email exists as an owner on more than one tenant
    //   (email is unique PER-TENANT — users_email_tenant_unique — not globally;
    //   a stray duplicate Bella tenant in prod exposed this on 2026-06-29).
    // WHAT: the login query now orders by created_at and the handler takes the
    //   oldest row deterministically, AND emits a `login_email_multi_tenant`
    //   warning so the collision is observable instead of silent.
    // WHERE: /login handler — the user lookup before bcrypt.
    // WHY: the old bare `rows[0]` with no ORDER BY let Postgres return the
    //   matching rows in arbitrary order, so the same credentials could log the
    //   user into a RANDOM tenant call-to-call. Determinism + a warning makes
    //   the behavior predictable and the duplicate visible to ops.
    it('logs a warning and picks the first row deterministically when an email spans multiple tenants', async () => {
      const { mockClient: client, queryResponses, queries } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const realHash = await bcrypt.hash('pass123', 10);
      const OTHER_TENANT = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';
      // Two rows for the same email — the query's ORDER BY guarantees the first
      // is the oldest; the handler must consume rows[0] and warn about the rest.
      queryResponses.push({
        rows: [
          {
            user_id: USER_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            email: 'dup@example.com',
            password_hash: realHash,
            full_name: 'First Tenant',
            role: 'owner',
          },
          {
            user_id: '99999999-2222-3333-4444-555555555555',
            tenant_id: OTHER_TENANT,
            email: 'dup@example.com',
            password_hash: realHash,
            full_name: 'Second Tenant',
            role: 'owner',
          },
        ],
      });

      const route = findRoute(routes, '/login');
      const req = createMockRequest({ email: 'dup@example.com', password: 'pass123' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body.success).toBe(true);
      expect(reply.body.tenant_id).toBe(TENANT_ID_MOCK);
      expect(reply.body.user_id).toBe(USER_ID_MOCK);
      expect(req.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'login_email_multi_tenant', tenant_count: 2 }),
        'login_email_multi_tenant'
      );
      // Guard the determinism at the source: the SQL must carry the ORDER BY,
      // else a future edit could regress to arbitrary row order and this test
      // (which only sees the mock's scripted order) would still pass blindly.
      const loginQuery = queries.find((q) => /FROM users/i.test(q.text));
      expect(loginQuery?.text).toMatch(/ORDER BY u\.created_at ASC NULLS LAST, u\.user_id ASC/i);
      // And the login query must EXCLUDE soft-deleted tenants (2026-07-13). A user
      // whose business was deleted must not get a token: every tenant-scoped route
      // would 404 anyway, and issuing a JWT for a business that no longer exists is
      // the zombie-tenant failure soft-delete exists to prevent. Asserted on the SQL
      // itself, because the mock can't tell us what the DB would have filtered.
      expect(loginQuery?.text).toMatch(/is_deleted = false/i);
    });

    it('returns 400 on invalid email (WHO: client | WHAT: Zod rejects bad email | WHERE: /login validation | WHY: prevents DB query with garbage)', async () => {
      const { mockClient: client } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const route = findRoute(routes, '/login');
      const req = createMockRequest({ email: 'not-email', password: 'pass' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(400);
      expect(reply.body.success).toBe(false);
    });

    it('returns 401 when user not found (WHO: unknown email | WHAT: no DB row | WHERE: /login | WHY: generic error prevents email enumeration)', async () => {
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      queryResponses.push({ rows: [] });

      const route = findRoute(routes, '/login');
      const req = createMockRequest({ email: 'nobody@test.com', password: 'pass123' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(401);
      expect(reply.body.error).toBe('Invalid email or password');
    });

    it("returns 401 on wrong password (WHO: user | WHAT: bcrypt compare fails | WHERE: /login | WHY: generic error doesn't reveal valid emails)", async () => {
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const realHash = await bcrypt.hash('correctpass', 10);
      queryResponses.push({
        rows: [
          {
            user_id: USER_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            email: 'test@example.com',
            password_hash: realHash,
            full_name: 'Test User',
          },
        ],
      });

      const route = findRoute(routes, '/login');
      const req = createMockRequest({ email: 'test@example.com', password: 'wrongpass' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(401);
      expect(generateToken).not.toHaveBeenCalled();
    });

    it('has rate limit of 5 per 5 minutes (WHO: system | WHAT: brute-force protection | WHERE: /login opts | WHY: prevents credential stuffing)', () => {
      const pool = createMockPool({});
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const route = findRoute(routes, '/login');
      expect(route.opts).toEqual({
        config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
      });
    });

    // ── Admin-provisioned-tenant consent gate ─────────────────────────
    // (supabase/migrations/20260916000000_tenant_admin_consent_gate.sql)
    //
    // THIS IS THE MOST IMPORTANT TEST IN THE WHOLE FEATURE: it protects
    // Dale's own production login. consent_gate_required defaults false
    // for every pre-existing tenant (seed data, self-serve /register
    // tenants) — those must be completely unaffected by this gate.

    it('WHO: owner of an admin-provisioned tenant who never confirmed | WHAT: password is correct but consent_gate_required=true and legal_consent_attested_at is NULL | WHERE: /login, after the bcrypt check | WHY: no JWT is issued until the emailed consent link is confirmed', async () => {
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const realHash = await bcrypt.hash('pass123', 10);
      queryResponses.push({
        rows: [
          {
            user_id: USER_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            email: 'gated@example.com',
            password_hash: realHash,
            full_name: 'Gated Owner',
            role: 'owner',
            consent_gate_required: true,
            legal_consent_attested_at: null,
          },
        ],
      });

      const route = findRoute(routes, '/login');
      const req = createMockRequest({ email: 'gated@example.com', password: 'pass123' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(403);
      expect(reply.body).toEqual({
        success: false,
        error: 'consent_required',
        error_code: 'consent_required',
      });
      expect(generateToken).not.toHaveBeenCalled();
    });

    it('WHO: owner of an admin-provisioned tenant who already confirmed via /consent/confirm | WHAT: consent_gate_required=true but legal_consent_attested_at is set | WHERE: /login | WHY: a confirmed tenant logs in exactly like any other — the gate only blocks the unconfirmed window', async () => {
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const realHash = await bcrypt.hash('pass123', 10);
      queryResponses.push({
        rows: [
          {
            user_id: USER_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            email: 'confirmed@example.com',
            password_hash: realHash,
            full_name: 'Confirmed Owner',
            role: 'owner',
            consent_gate_required: true,
            legal_consent_attested_at: new Date('2026-09-16T12:00:00Z'),
          },
        ],
      });

      const route = findRoute(routes, '/login');
      const req = createMockRequest({ email: 'confirmed@example.com', password: 'pass123' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body.success).toBe(true);
      expect(reply.body.token).toBe(TEST_TOKEN);
      expect(generateToken).toHaveBeenCalled();
    });

    it("WHO: every pre-existing tenant — Dale's own production account (seeded directly in supabase/seed.sql, never through createTenantWithOwner), the Bella's Hair Studio demo tenant, and every self-serve /register signup | WHAT: consent_gate_required is false (the column's schema default) | WHERE: /login | WHY: this is the test that protects Dale's own prod login — a gate that fired on a false consent_gate_required would lock out the platform owner", async () => {
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const realHash = await bcrypt.hash('pass123', 10);
      queryResponses.push({
        rows: [
          {
            user_id: USER_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            email: 'daledemott@gmail.com',
            password_hash: realHash,
            full_name: 'Dale DeMott',
            role: 'owner',
            consent_gate_required: false,
            legal_consent_attested_at: null,
          },
        ],
      });

      const route = findRoute(routes, '/login');
      const req = createMockRequest({ email: 'daledemott@gmail.com', password: 'pass123' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body.success).toBe(true);
      expect(reply.body.token).toBe(TEST_TOKEN);
      expect(generateToken).toHaveBeenCalled();
    });

    it('WHO: any row from a DB that predates this migration, where the join simply omits the two new columns | WHAT: consent_gate_required and legal_consent_attested_at come back undefined, not false/null | WHERE: /login | WHY: the gate check must not accidentally trip on undefined — it uses a strict === true check', async () => {
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const realHash = await bcrypt.hash('pass123', 10);
      queryResponses.push({
        rows: [
          {
            user_id: USER_ID_MOCK,
            tenant_id: TENANT_ID_MOCK,
            email: 'legacy-row@example.com',
            password_hash: realHash,
            full_name: 'Legacy Row',
            role: 'owner',
            // consent_gate_required / legal_consent_attested_at deliberately omitted
          },
        ],
      });

      const route = findRoute(routes, '/login');
      const req = createMockRequest({ email: 'legacy-row@example.com', password: 'pass123' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body.success).toBe(true);
      expect(generateToken).toHaveBeenCalled();
    });
  });

  // ── /register ───────────────────────────────────────────────────────

  describe('POST /register handler', () => {
    it('returns 400 on missing fields (WHO: incomplete form | WHAT: Zod rejects | WHERE: /register | WHY: prevents partial tenant creation)', async () => {
      const { mockClient: client } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const route = findRoute(routes, '/register');
      const req = createMockRequest({ email: 'a@b.com' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(400);
      expect(reply.body.error).toBe('Validation failed');
    });

    it('returns 400 on short password (WHO: new user | WHAT: password < 6 chars | WHERE: /register | WHY: minimum password strength)', async () => {
      const { mockClient: client } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const route = findRoute(routes, '/register');
      const req = createMockRequest({
        business_name: 'Shop',
        business_type: 'salon',
        owner_name: 'Test',
        email: 'a@b.com',
        password: '12345',
      });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(400);
    });

    // WHO: someone posting straight to the API, bypassing the picker
    //   entirely (the picker UI normally constrains business_type via a
    //   <select>, but falls back to free text on a GET /templates failure).
    // WHAT: RegisterSchema rejects a HIPAA-adjacent business_type before any
    //   DB work, independent of the dashboard picker.
    // WHERE: /register Zod validation (shared/hipaaVerticalDenylist.ts).
    // WHY: root CLAUDE.md Build Principles — "HIPAA verticals are
    //   permanently excluded... anything that surfaces them gets deleted
    //   on sight." A direct API call previously bypassed that entirely.
    it.each([
      'dental',
      'Dental Office',
      'veterinary-clinic',
      'chiropractic',
      'optometry',
      'Family Medical Group',
      'HIPAA Provider',
    ])(
      'returns 400 for HIPAA-adjacent business_type %j (WHO: direct API caller | WHAT: no <select> constraint | WHERE: /register | WHY: HIPAA verticals are permanently excluded)',
      async (businessType) => {
        const { mockClient: client } = createMockClient();
        const pool = createMockPool(client);
        const { app, routes } = captureRoutes();
        registerAuthRoutes(app, pool, generateToken);

        const route = findRoute(routes, '/register');
        const req = createMockRequest({
          business_name: 'Shop',
          business_type: businessType,
          owner_name: 'Owner',
          email: 'hipaa-test@test.com',
          password: 'secure123',
          consent_attested: true,
        });
        const reply = createMockReply();

        await route.handler(req, reply);

        expect(reply.statusCode).toBe(400);
        expect(reply.body.error).toBe('Validation failed');
      }
    );

    // WHO: someone posting straight to the API, bypassing the /register
    //   page's checkbox entirely (e.g. curl, a scripted signup).
    // WHAT: RegisterSchema requires consent_attested to be the literal
    //   `true` — omitting it must 400 before any DB work, exactly like
    //   any other missing required field.
    // WHERE: /register Zod validation.
    // WHY: the checkbox was enforced CLIENT-SIDE ONLY; a direct API call
    //   could create a fully functional tenant with zero record consent
    //   was ever given, defeating the ToS/DPA liability-shift the
    //   checkbox exists for.
    it('returns 400 when consent_attested is missing (WHO: direct API caller | WHAT: no consent field | WHERE: /register | WHY: closes the client-side-only consent bypass)', async () => {
      const { mockClient: client } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const route = findRoute(routes, '/register');
      const req = createMockRequest({
        business_name: 'Shop',
        business_type: 'salon',
        owner_name: 'Owner',
        email: 'nobox@test.com',
        password: 'secure123',
      });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(400);
      expect(reply.body.error).toBe('Validation failed');
    });

    it('returns 400 when consent_attested is false (WHO: tampered request | WHAT: field present but false | WHERE: /register | WHY: must not silently default to true)', async () => {
      const { mockClient: client } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const route = findRoute(routes, '/register');
      const req = createMockRequest({
        business_name: 'Shop',
        business_type: 'salon',
        owner_name: 'Owner',
        email: 'unchecked@test.com',
        password: 'secure123',
        consent_attested: false,
      });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(400);
      expect(reply.body.error).toBe('Validation failed');
    });

    it('returns 409 on duplicate email (WHO: returning user | WHAT: email exists in users table | WHERE: /register | WHY: prevents duplicate accounts)', async () => {
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      // BEGIN
      queryResponses.push({ rows: [] });
      // Check existing user — FOUND
      queryResponses.push({ rows: [{ user_id: 'existing' }] });
      // ROLLBACK
      queryResponses.push({ rows: [] });

      const route = findRoute(routes, '/register');
      const req = createMockRequest({
        business_name: 'Shop',
        business_type: 'salon',
        owner_name: 'Owner',
        email: 'dupe@test.com',
        password: 'secure123',
        consent_attested: true,
      });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(409);
      expect(reply.body.error).toContain('already exists');
    });

    it('creates tenant+user and returns 201 (WHO: new business | WHAT: full registration | WHERE: /register | WHY: self-service onboarding)', async () => {
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      // BEGIN
      queryResponses.push({ rows: [] });
      // Check existing — none
      queryResponses.push({ rows: [] });
      // INSERT tenant
      queryResponses.push({ rows: [{ tenant_id: TENANT_ID_MOCK }] });
      // INSERT user
      queryResponses.push({ rows: [{ user_id: USER_ID_MOCK }] });
      // UPDATE tenants SET legal_consent_* (consent stamp)
      queryResponses.push({ rows: [] });
      // COMMIT
      queryResponses.push({ rows: [] });

      const route = findRoute(routes, '/register');
      const req = createMockRequest({
        business_name: 'DynaTire',
        business_type: 'mobile-tire',
        owner_name: 'Dale',
        email: 'dale@test.com',
        password: 'secure123',
        consent_attested: true,
      });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(201);
      expect(reply.body.success).toBe(true);
      expect(reply.body.tenant_id).toBe(TENANT_ID_MOCK);
      expect(reply.body.token).toBe(TEST_TOKEN);
    });

    // WHO: same happy-path signup as above.
    // WHAT: createTenantWithOwner must actually be handed a legalConsent
    //   object built from the request's IP/User-Agent — the schema gate
    //   alone doesn't close the gap if the route never persists anything.
    // WHERE: /register handler → createTenantWithOwner call.
    // WHY: this is the assertion that would have caught a version of the
    //   fix that validated consent_attested but forgot to wire it through.
    it('passes a legalConsent object (ip + user agent) through to the tenant UPDATE (WHO: new business | WHAT: consent audit trail | WHERE: /register → bootstrap | WHY: validation alone does not persist proof of consent)', async () => {
      const { mockClient: client, queryResponses, queries } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      queryResponses.push({ rows: [] }); // BEGIN
      queryResponses.push({ rows: [] }); // SELECT existing — none
      queryResponses.push({ rows: [{ tenant_id: TENANT_ID_MOCK }] }); // INSERT tenant
      queryResponses.push({ rows: [{ user_id: USER_ID_MOCK }] }); // INSERT user
      queryResponses.push({ rows: [] }); // UPDATE tenants legal_consent_*
      queryResponses.push({ rows: [] }); // COMMIT

      const route = findRoute(routes, '/register');
      const req = createMockRequest({
        business_name: 'DynaTire',
        business_type: 'mobile-tire',
        owner_name: 'Dale',
        email: 'dale2@test.com',
        password: 'secure123',
        consent_attested: true,
      });
      req.headers = { 'x-forwarded-for': '203.0.113.5, 10.0.0.1', 'user-agent': 'TestAgent/1.0' };
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(201);
      const consentUpdate = queries.find((q) => /legal_consent_attested_at/i.test(q.text));
      expect(consentUpdate).toBeDefined();
      expect(consentUpdate?.params).toEqual([
        USER_ID_MOCK,
        '203.0.113.5',
        'TestAgent/1.0',
        TENANT_ID_MOCK,
      ]);
    });

    // WHO: a request that arrives through an intermediary that represents
    //   repeated headers as an array (Node's IncomingHttpHeaders types
    //   x-forwarded-for/user-agent as `string | string[] | undefined`,
    //   not just `string | undefined`).
    // WHAT: a naive `.split(',')` on an array would throw. This must not
    //   crash the request — it must degrade to a best-effort read instead.
    // WHY: an automated review of this PR flagged the original cast
    //   (`as string | undefined`) as unsound against the real header type.
    it('does not crash when x-forwarded-for / user-agent arrive as arrays (WHO: intermediary that arrays repeated headers | WHAT: registration must still succeed | WHERE: /register header extraction | WHY: audit-trail plumbing must never be able to break the main flow)', async () => {
      const { mockClient: client, queryResponses, queries } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      queryResponses.push({ rows: [] }); // BEGIN
      queryResponses.push({ rows: [] }); // SELECT existing — none
      queryResponses.push({ rows: [{ tenant_id: TENANT_ID_MOCK }] }); // INSERT tenant
      queryResponses.push({ rows: [{ user_id: USER_ID_MOCK }] }); // INSERT user
      queryResponses.push({ rows: [] }); // UPDATE tenants legal_consent_*
      queryResponses.push({ rows: [] }); // COMMIT

      const route = findRoute(routes, '/register');
      const req = createMockRequest({
        business_name: 'ArrayHeaderCo',
        business_type: 'salon',
        owner_name: 'Array Owner',
        email: 'arrayheader@test.com',
        password: 'secure123',
        consent_attested: true,
      });
      req.headers = {
        'x-forwarded-for': ['198.51.100.9', '10.0.0.1'],
        'user-agent': ['ArrayAgent/2.0'],
      } as unknown as typeof req.headers;
      const reply = createMockReply();

      await expect(route.handler(req, reply)).resolves.not.toThrow();

      expect(reply.statusCode).toBe(201);
      const consentUpdate = queries.find((q) => /legal_consent_attested_at/i.test(q.text));
      expect(consentUpdate?.params).toEqual([
        USER_ID_MOCK,
        '198.51.100.9',
        'ArrayAgent/2.0',
        TENANT_ID_MOCK,
      ]);
    });

    // WHO: a request whose x-forwarded-for was set to garbage by a
    //   misconfigured proxy or a client probing the endpoint directly.
    // WHAT: legal_consent_ip is an INET column — a non-IP value would
    //   fail the INSERT and take the whole registration down with it.
    // WHY: an automated review of this PR flagged that the original code
    //   could write non-IP values into an INET column. The extraction
    //   must validate and fall back to null rather than ever writing
    //   garbage into that column.
    it('stores null ip when x-forwarded-for is not a real IP address (WHO: malformed/garbage header | WHAT: registration must still succeed, ip column stays null | WHERE: /register header extraction | WHY: an INET column rejects non-IP values, which would 500 the whole registration)', async () => {
      const { mockClient: client, queryResponses, queries } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      queryResponses.push({ rows: [] }); // BEGIN
      queryResponses.push({ rows: [] }); // SELECT existing — none
      queryResponses.push({ rows: [{ tenant_id: TENANT_ID_MOCK }] }); // INSERT tenant
      queryResponses.push({ rows: [{ user_id: USER_ID_MOCK }] }); // INSERT user
      queryResponses.push({ rows: [] }); // UPDATE tenants legal_consent_*
      queryResponses.push({ rows: [] }); // COMMIT

      const route = findRoute(routes, '/register');
      const req = createMockRequest({
        business_name: 'GarbageHeaderCo',
        business_type: 'salon',
        owner_name: 'Garbage Owner',
        email: 'garbageheader@test.com',
        password: 'secure123',
        consent_attested: true,
      });
      req.headers = { 'x-forwarded-for': 'unknown', 'user-agent': 'RealBrowser/1.0' };
      // req.ip on the mock request also isn't a real IP here — nothing
      // valid to fall back to, which is exactly the case that must
      // resolve to null rather than throwing or writing garbage.
      (req as { ip?: string }).ip = 'not-an-ip';
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(201);
      const consentUpdate = queries.find((q) => /legal_consent_attested_at/i.test(q.text));
      expect(consentUpdate?.params).toEqual([
        USER_ID_MOCK,
        null,
        'RealBrowser/1.0',
        TENANT_ID_MOCK,
      ]);
    });
  });

  // ── /auth/refresh ───────────────────────────────────────────────────

  describe('POST /auth/refresh handler', () => {
    it('returns fresh token when authenticated (WHO: logged-in user | WHAT: new JWT from existing auth | WHERE: /auth/refresh | WHY: extend session)', async () => {
      const pool = createMockPool({});
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const route = findRoute(routes, '/auth/refresh');
      const req = createMockRequest(
        {},
        {
          tenant_id: TENANT_ID_MOCK,
          user_id: USER_ID_MOCK,
          email: 'test@test.com',
          role: 'front_desk',
        }
      );
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body).toEqual({ success: true, token: TEST_TOKEN });
      // WHY: refresh must preserve the role from the inbound auth context.
      // If it didn't, every refresh would silently promote a front_desk
      // user back to owner.
      expect(generateToken).toHaveBeenCalledWith({
        tenant_id: TENANT_ID_MOCK,
        user_id: USER_ID_MOCK,
        email: 'test@test.com',
        role: 'front_desk',
      });
    });

    it("returns 401 when not authenticated (WHO: expired JWT | WHAT: no auth context | WHERE: /auth/refresh | WHY: can't refresh without valid session)", async () => {
      const pool = createMockPool({});
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const route = findRoute(routes, '/auth/refresh');
      const req = createMockRequest({});
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(401);
      expect(reply.body.error).toBe('Authentication required');
    });
  });

  // ── /forgot-password ────────────────────────────────────────────────

  describe('POST /forgot-password handler', () => {
    it('returns 200 + sends email when user exists (WHO: registered user | WHAT: requests reset | WHERE: /forgot-password | WHY: enables self-service recovery)', async () => {
      const sysmail = await import('../../src/services/communications/systemEmail');
      vi.mocked(sysmail.sendPasswordResetEmail).mockClear();

      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      // SELECT user — found
      queryResponses.push({ rows: [{ user_id: USER_ID_MOCK }] });
      // INSERT password_resets
      queryResponses.push({ rows: [] });

      const route = findRoute(routes, '/forgot-password');
      const req = createMockRequest({ email: 'me@test.com' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body).toEqual({ success: true });
      expect(sysmail.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
      // Token in URL must be a base64url string of reasonable length
      const [to, link] = vi.mocked(sysmail.sendPasswordResetEmail).mock.calls[0];
      expect(to).toBe('me@test.com');
      expect(link).toMatch(/\/reset-password\?token=[A-Za-z0-9_-]{30,}/);
    });

    it('THE HANG: answers 200 even when the email send NEVER settles', async () => {
      // WHO: a locked-out owner clicking "Forgot password?".
      // WHAT: on production 2026-07-27 this endpoint answered HTTP 000 after 30s
      //       — the handler AWAITED an SMTP send that hung (Railway cannot reach
      //       Gmail SMTP; the same transport failed on 2026-07-17). The token row
      //       was written, so the work was done; only the reply was hostage.
      // WHEN: every reset request while the mail transport is unreachable.
      // WHERE: routes/auth.ts /forgot-password — `void ... .catch()`, not `await`.
      // WHY: the token is durable before the send, so the response owes the mail
      //       transport nothing. A hang is not an error, so nothing logged and
      //       nothing alerted — the user just watched a spinner.
      //
      // This test FAILS BY TIMEOUT against the pre-fix code, which is the point:
      // a never-settling send must not be able to hold the handler open.
      const sysmail = await import('../../src/services/communications/systemEmail');
      vi.mocked(sysmail.sendPasswordResetEmail).mockClear();
      // Never settles — a hung SMTP socket, exactly as seen in production.
      vi.mocked(sysmail.sendPasswordResetEmail).mockReturnValueOnce(new Promise(() => {}));

      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      queryResponses.push({ rows: [{ user_id: USER_ID_MOCK }] }); // SELECT user
      queryResponses.push({ rows: [] }); // INSERT password_resets

      const route = findRoute(routes, '/forgot-password');
      const req = createMockRequest({ email: 'me@test.com' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body, 'the reply must not wait on the mail transport').toEqual({
        success: true,
      });
      expect(sysmail.sendPasswordResetEmail, 'the send is still attempted').toHaveBeenCalledTimes(
        1
      );
    }, 5000);

    it('returns 200 silently when user does NOT exist (WHO: stranger | WHAT: probes for account | WHERE: /forgot-password | WHY: prevent email enumeration)', async () => {
      const sysmail = await import('../../src/services/communications/systemEmail');
      vi.mocked(sysmail.sendPasswordResetEmail).mockClear();

      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      // SELECT user — not found
      queryResponses.push({ rows: [] });

      const route = findRoute(routes, '/forgot-password');
      const req = createMockRequest({ email: 'ghost@test.com' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body).toEqual({ success: true });
      expect(sysmail.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('returns 400 when email is malformed (WHO: garbage input | WHAT: Zod rejects | WHERE: /forgot-password | WHY: skip DB lookup on bad data)', async () => {
      const { mockClient: client } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const route = findRoute(routes, '/forgot-password');
      const req = createMockRequest({ email: 'not-an-email' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(400);
    });

    it('has rate limit of 3 per hour (WHO: system | WHAT: throttle reset abuse | WHERE: /forgot-password opts | WHY: limit email-spam vector)', () => {
      const pool = createMockPool({});
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);
      const route = findRoute(routes, '/forgot-password');
      expect(route.opts).toEqual({ config: { rateLimit: { max: 3, timeWindow: '1 hour' } } });
    });
  });

  // ── /reset-password ─────────────────────────────────────────────────

  describe('POST /reset-password handler', () => {
    it('updates password + marks token used on valid token (WHO: user with reset link | WHAT: completes reset | WHERE: /reset-password | WHY: changes credentials and forces re-login of other sessions)', async () => {
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      // BEGIN
      queryResponses.push({ rows: [] });
      // SELECT password_resets — found, unused, not expired
      queryResponses.push({ rows: [{ password_reset_id: 'reset-id', user_id: USER_ID_MOCK }] });
      // UPDATE users (password + password_changed_at)
      queryResponses.push({ rows: [] });
      // UPDATE password_resets SET used_at (this token)
      queryResponses.push({ rows: [] });
      // UPDATE password_resets SET used_at (any others for user)
      queryResponses.push({ rows: [] });
      // COMMIT
      queryResponses.push({ rows: [] });

      const route = findRoute(routes, '/reset-password');
      const req = createMockRequest({ token: 'a'.repeat(43), new_password: 'newSecure123' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.body).toEqual({ success: true });
      // Verify the queries: BEGIN, SELECT, UPDATE users, UPDATE this reset, UPDATE other resets, COMMIT
      const queries = client.query.mock.calls.map((c) => (c[0] as string).trim().split('\n')[0]);
      expect(queries[0]).toBe('BEGIN');
      expect(queries[1]).toContain('SELECT password_reset_id, user_id FROM password_resets');
      expect(queries[2]).toContain('UPDATE users SET password_hash');
      expect(queries[2]).toContain('password_changed_at = NOW()');
      expect(queries[5]).toBe('COMMIT');
    });

    it("returns 400 when token is invalid/expired (WHO: stale link clicker | WHAT: token not found | WHERE: /reset-password | WHY: don't change password on bad token)", async () => {
      const { mockClient: client, queryResponses } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      // BEGIN
      queryResponses.push({ rows: [] });
      // SELECT — none
      queryResponses.push({ rows: [] });
      // ROLLBACK
      queryResponses.push({ rows: [] });

      const route = findRoute(routes, '/reset-password');
      const req = createMockRequest({ token: 'b'.repeat(43), new_password: 'newSecure123' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(400);
      expect(reply.body.error).toMatch(/invalid|expired/i);
    });

    it('returns 400 when password is too short (WHO: user picks weak password | WHAT: Zod rejects <6 chars | WHERE: /reset-password | WHY: enforce minimum strength)', async () => {
      const { mockClient: client } = createMockClient();
      const pool = createMockPool(client);
      const { app, routes } = captureRoutes();
      registerAuthRoutes(app, pool, generateToken);

      const route = findRoute(routes, '/reset-password');
      const req = createMockRequest({ token: 'c'.repeat(43), new_password: '123' });
      const reply = createMockReply();

      await route.handler(req, reply);

      expect(reply.statusCode).toBe(400);
    });
  });
});

describe('Auth - Database Level', () => {
  let client: Client;
  let dbAvailable = true;
  beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

  beforeAll(async () => {
    try {
      client = await getRootClient();
    } catch (err) {
      dbAvailable = false;
      console.warn('[auth.test] Skipping DB tests - connection failed', err);
    }
  });

  afterAll(async () => {
    if (dbAvailable && client) {
      await client.end();
    }
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    await clearDB(client);
  });

  // ── Section 1: Login ──────────────────────────────────────────────────

  describe('Login', () => {
    it('should verify correct password with bcrypt.compare', async () => {
      if (!dbAvailable) return;

      const password = 'securePass123';
      const hash = await hashPassword(password);

      const tenantId = await createTenant(client, 'LoginTest', 'salon');

      await client.query(
        'INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)',
        [tenantId, 'login@test.com', hash, 'Test User']
      );

      // Simulate the login query
      const res = await client.query('SELECT * FROM users WHERE email = $1', ['login@test.com']);
      expect(res.rows).toHaveLength(1);

      const user = res.rows[0];
      const match = await bcrypt.compare(password, user.password_hash);
      expect(match).toBe(true);
      expect(user.tenant_id).toBe(tenantId);
      expect(user.full_name).toBe('Test User');
    });

    it('should reject wrong password with bcrypt.compare', async () => {
      if (!dbAvailable) return;

      const hash = await hashPassword('correctPassword');

      const tenantId = await createTenant(client, 'LoginTest2', 'salon');

      await client.query(
        'INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)',
        [tenantId, 'wrong@test.com', hash, 'Wrong Pass User']
      );

      const res = await client.query('SELECT * FROM users WHERE email = $1', ['wrong@test.com']);
      const user = res.rows[0];

      const match = await bcrypt.compare('wrongPassword', user.password_hash);
      expect(match).toBe(false);
    });

    it('should return no user for non-existent email', async () => {
      if (!dbAvailable) return;

      const res = await client.query('SELECT * FROM users WHERE email = $1', ['noone@test.com']);
      expect(res.rows).toHaveLength(0);
    });
  });

  // ── Section 2: Registration ───────────────────────────────────────────

  describe('Registration', () => {
    it('should create tenant and user in a transaction', async () => {
      if (!dbAvailable) return;

      const hash = await hashPassword('newUser123');

      await client.query('BEGIN');

      const tenantRes = await client.query(
        'INSERT INTO tenants (name, business_type) VALUES ($1, $2) RETURNING tenant_id',
        ['New Business', 'mobile-tire']
      );
      const tenantId = tenantRes.rows[0].tenant_id;

      const userRes = await client.query(
        'INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, $2, $3, $4) RETURNING user_id, full_name',
        [tenantId, 'new@biz.com', hash, 'Owner Name']
      );

      await client.query('COMMIT');

      expect(tenantId).toBeDefined();
      expect(userRes.rows[0].user_id).toBeDefined();
      expect(userRes.rows[0].full_name).toBe('Owner Name');

      // Verify both exist after commit
      const tenantCheck = await client.query('SELECT * FROM tenants WHERE tenant_id = $1', [
        tenantId,
      ]);
      const userCheck = await client.query('SELECT * FROM users WHERE tenant_id = $1', [tenantId]);
      expect(tenantCheck.rows).toHaveLength(1);
      expect(userCheck.rows).toHaveLength(1);
    });

    it('should create a tenant and user in a single transaction (with template verification)', async () => {
      if (!dbAvailable) return;

      // Simulate what POST /tenants/register does
      await client.query('BEGIN');

      const tenantRes = await client.query(
        'INSERT INTO tenants (name, business_type) VALUES ($1, $2) RETURNING tenant_id',
        ['Test Salon', 'salon']
      );
      const tenantId = tenantRes.rows[0].tenant_id;

      const hash = await hashPassword('testpass123');

      const userRes = await client.query(
        'INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, $2, $3, $4) RETURNING user_id, tenant_id, email, full_name',
        [tenantId, 'owner@testsalon.com', hash, 'Salon Owner']
      );

      await client.query('COMMIT');

      expect(userRes.rows[0].tenant_id).toBe(tenantId);
      expect(userRes.rows[0].email).toBe('owner@testsalon.com');
      expect(userRes.rows[0].full_name).toBe('Salon Owner');

      // Verify template defaults were applied via trigger
      const tenantCheck = await client.query(
        'SELECT system_prompt, voice_id, first_message FROM tenants WHERE tenant_id = $1',
        [tenantId]
      );
      expect(tenantCheck.rows[0].system_prompt).toContain('receptionist');
      expect(tenantCheck.rows[0].voice_id).toBeTruthy();
      expect(tenantCheck.rows[0].first_message).toBeTruthy();

      // Verify default resource was created via trigger
      const resourceCheck = await client.query('SELECT name FROM resources WHERE tenant_id = $1', [
        tenantId,
      ]);
      expect(resourceCheck.rows[0].name).toBe('Styling Station 1');
    });

    it('should apply template defaults (system_prompt populated) for known business_type', async () => {
      if (!dbAvailable) return;

      const tenantRes = await client.query(
        'INSERT INTO tenants (name, business_type) VALUES ($1, $2) RETURNING *',
        ['Template Test', 'mobile-tire']
      );

      const tenant = tenantRes.rows[0];
      expect(tenant.system_prompt).toBeTruthy();
      expect(tenant.system_prompt).toContain('tire');
      expect(tenant.voice_id).toBeTruthy();
      expect(tenant.first_message).toBeTruthy();
    });

    it('should create default resource for known business_type', async () => {
      if (!dbAvailable) return;

      const tenantId = await createTenant(client, 'Resource Test', 'salon');

      const resources = await client.query('SELECT * FROM resources WHERE tenant_id = $1', [
        tenantId,
      ]);

      expect(resources.rows).toHaveLength(1);
      expect(resources.rows[0].name).toBe('Styling Station 1');
    });
  });

  // ── Section 3: Email Uniqueness ───────────────────────────────────────

  describe('Email Uniqueness', () => {
    it('should reject duplicate email within same tenant (per-tenant unique constraint)', async () => {
      if (!dbAvailable) return;

      const hash = await hashPassword('pass123');
      const tenantId = await createTenant(client, 'Biz1', 'salon');

      await client.query(
        'INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)',
        [tenantId, 'dupe@test.com', hash, 'First User']
      );

      // Same email within same tenant should fail (unique on tenant_id, email)
      await expect(
        client.query(
          'INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)',
          [tenantId, 'dupe@test.com', hash, 'Second User']
        )
      ).rejects.toThrow();
    });

    it('should reject duplicate email within same tenant (unique constraint message)', async () => {
      if (!dbAvailable) return;

      const tenantId = await createTenant(client, 'Dup Test', 'salon');
      const hash = await hashPassword('pass');

      await client.query(
        "INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, 'dupe@test.com', $2, 'User 1')",
        [tenantId, hash]
      );

      await expect(
        client.query(
          "INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, 'dupe@test.com', $2, 'User 2')",
          [tenantId, hash]
        )
      ).rejects.toThrow(/unique/i);
    });

    it('should allow same email across different tenants', async () => {
      if (!dbAvailable) return;

      const t1Id = await createTenant(client, 'T1', 'salon');
      const t2Id = await createTenant(client, 'T2', 'auto-shop');

      const hash = await hashPassword('pass');

      await client.query(
        "INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, 'same@email.com', $2, 'User 1')",
        [t1Id, hash]
      );

      const res = await client.query(
        "INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, 'same@email.com', $2, 'User 2') RETURNING user_id",
        [t2Id, hash]
      );

      expect(res.rows[0].user_id).toBeTruthy();
    });

    it('should detect duplicate email across tenants via application-level check', async () => {
      if (!dbAvailable) return;

      const hash = await hashPassword('pass123');
      const t1Id = await createTenant(client, 'Biz1', 'salon');

      await client.query(
        'INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)',
        [t1Id, 'crosscheck@test.com', hash, 'First User']
      );

      // Application-level check used by /register
      const existing = await client.query('SELECT user_id FROM users WHERE email = $1', [
        'crosscheck@test.com',
      ]);
      expect(existing.rows.length).toBeGreaterThan(0);
    });

    it('should detect existing email before registration (application-level check)', async () => {
      if (!dbAvailable) return;

      const hash = await hashPassword('pass123');
      const t1Id = await createTenant(client, 'ExistingBiz', 'salon');

      await client.query(
        'INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)',
        [t1Id, 'exists@test.com', hash, 'Existing User']
      );

      // Simulate the registration check query
      const existingUser = await client.query('SELECT user_id FROM users WHERE email = $1', [
        'exists@test.com',
      ]);
      expect(existingUser.rows.length).toBeGreaterThan(0);

      // For a new email, should return empty
      const newUser = await client.query('SELECT user_id FROM users WHERE email = $1', [
        'fresh@test.com',
      ]);
      expect(newUser.rows).toHaveLength(0);
    });
  });

  // ── Section 4: Onboarding ─────────────────────────────────────────────

  describe('Onboarding', () => {
    it('should default onboarding_completed to false', async () => {
      if (!dbAvailable) return;

      const tenantRes = await client.query(
        'INSERT INTO tenants (name, business_type) VALUES ($1, $2) RETURNING *',
        ['Onboarding Test', 'auto-shop']
      );

      expect(tenantRes.rows[0].onboarding_completed).toBe(false);
    });

    it('should set onboarding_completed to false by default (plumber)', async () => {
      if (!dbAvailable) return;

      const res = await client.query(
        "INSERT INTO tenants (name, business_type) VALUES ('New Biz', 'plumber') RETURNING onboarding_completed"
      );
      expect(res.rows[0].onboarding_completed).toBe(false);
    });
  });

  // ── Section 5: Transaction Rollback ───────────────────────────────────

  describe('Transaction Rollback', () => {
    it('should rollback both tenant and user if user creation fails', async () => {
      if (!dbAvailable) return;

      const countBefore = await client.query('SELECT count(*) FROM tenants');
      const tenantCountBefore = parseInt(countBefore.rows[0].count);

      try {
        await client.query('BEGIN');

        await client.query(
          'INSERT INTO tenants (name, business_type) VALUES ($1, $2) RETURNING tenant_id',
          ['Rollback Test', 'salon']
        );

        // Force an error by inserting a user with missing required field (password_hash NOT NULL)
        await client.query(
          'INSERT INTO users (tenant_id, email, password_hash) VALUES ($1, $2, NULL)',
          ['00000000-0000-0000-0000-000000000000', 'fail@test.com']
        );

        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK');
      }

      const countAfter = await client.query('SELECT count(*) FROM tenants');
      const tenantCountAfter = parseInt(countAfter.rows[0].count);

      expect(tenantCountAfter).toBe(tenantCountBefore);
    });
  });
});
