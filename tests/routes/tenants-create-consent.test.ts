/**
 * POST /tenants/create — the admin-provisioned-tenant consent-invite side
 * effects.
 *
 * createTenantWithOwner's own transactional behavior (consent_gate_required
 * on the INSERT) is covered in tests/services/tenants/bootstrap.test.ts.
 * This file covers what the ROUTE does once that helper returns ok:true
 * with consentGateRequired:true — issuing a tenant_consent_invites row and
 * attempting both emails — without re-testing the helper itself.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerTenantRoutes } from '../../src/routes/tenants';
import { createMockClient, createMockPool, type MockClient, type MockResponse } from '../mock';

vi.mock('../../src/services/communications/systemEmail', () => ({
  sendTenantConsentInviteEmail: vi.fn(async () => undefined),
  sendTenantConsentPendingAdminNotice: vi.fn(async () => undefined),
  sendTenantConsentAttestedEmail: vi.fn(async () => undefined),
  PLATFORM_ADMIN_EMAIL: 'admin@platform.test',
}));

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const USER_ID = '11111111-2222-3333-8444-555555555555';

let app: FastifyInstance;
let mockClient: MockClient;
let queryResponses: MockResponse[];
let queries: { text: string; params: unknown[] }[];
let authStub: { user_id: string; tenant_id: string; email: string; role: 'owner' | 'front_desk' };

function buildApp() {
  const handle = createMockClient();
  mockClient = handle.mockClient;
  queryResponses = handle.queryResponses;
  queries = handle.queries;
  const mockPool = createMockPool(mockClient);

  const fastify = Fastify({ logger: false });
  fastify.addHook('preHandler', async (request) => {
    (request as unknown as { auth: typeof authStub }).auth = authStub;
  });

  const withTenantClient = async <T>(
    _tenantId: string,
    fn: (client: typeof mockClient) => Promise<T>
  ): Promise<T> => fn(mockClient);

  registerTenantRoutes(
    fastify,
    mockPool,
    withTenantClient as unknown as Parameters<typeof registerTenantRoutes>[2]
  );
  return fastify;
}

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  queryResponses.length = 0;
  authStub = {
    user_id: 'admin-user',
    tenant_id: '00000000-0000-0000-0000-000000000000',
    email: 'admin@test',
    role: 'owner',
  };
});

function scriptHappyCreate() {
  queryResponses.push({ rows: [] }); // BEGIN
  queryResponses.push({ rows: [] }); // SELECT tenants (no dup)
  queryResponses.push({ rows: [{ tenant_id: TENANT_ID }] }); // INSERT tenant
  queryResponses.push({ rows: [{ user_id: USER_ID }] }); // INSERT user
  queryResponses.push({ rows: [] }); // COMMIT
  queryResponses.push({ rows: [] }); // INSERT tenant_consent_invites (via withPoolClient)
}

describe('POST /tenants/create — consent-invite side effects', () => {
  it('HAPPY: admin-created tenant gets a tenant_consent_invites row and both emails are attempted', async () => {
    const sysmail = await import('../../src/services/communications/systemEmail');
    scriptHappyCreate();

    const res = await app.inject({
      method: 'POST',
      url: '/tenants/create',
      payload: {
        tenant_name: 'New Biz',
        business_type: 'salon',
        owner_first_name: 'Jane',
        owner_last_name: 'Doe',
        owner_email: 'jane@newbiz.com',
        owner_pass: 'secure123',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      tenant_id: TENANT_ID,
      consent_invite_issued: true,
    });

    const inviteInsert = queries.find((q) => /INSERT INTO tenant_consent_invites/i.test(q.text));
    expect(inviteInsert).toBeDefined();
    expect(inviteInsert?.params[0]).toBe(TENANT_ID);
    expect(inviteInsert?.params[1]).toBe(USER_ID);

    // Fire-and-forget sends are not awaited by the handler — give the
    // microtask queue a tick to let the `void ....catch()` promises settle.
    await new Promise((r) => setImmediate(r));

    expect(sysmail.sendTenantConsentInviteEmail).toHaveBeenCalledTimes(1);
    const [to, link, businessName] = vi.mocked(sysmail.sendTenantConsentInviteEmail).mock.calls[0];
    expect(to).toBe('jane@newbiz.com');
    expect(link).toMatch(/\/consent\?token=[A-Za-z0-9_-]{30,}/);
    expect(businessName).toBe('New Biz');

    expect(sysmail.sendTenantConsentPendingAdminNotice).toHaveBeenCalledTimes(1);
    const [adminTo, fields] = vi.mocked(sysmail.sendTenantConsentPendingAdminNotice).mock.calls[0];
    expect(adminTo).toBe('admin@platform.test');
    expect(fields.businessName).toBe('New Biz');
    expect(fields.ownerEmail).toBe('jane@newbiz.com');
  });

  it('SAD (review thread): an invite-INSERT failure after COMMIT is best-effort — 200 (not 500), no dead link emailed, admin still told, owner can /consent/resend', async () => {
    const sysmail = await import('../../src/services/communications/systemEmail');
    scriptHappyCreate();
    const realQuery = mockClient.query.getMockImplementation()!;
    mockClient.query.mockImplementation(async (text: string, params?: unknown[]) => {
      if (/INSERT INTO tenant_consent_invites/i.test(text)) throw new Error('db down');
      return realQuery(text, params);
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/tenants/create',
        payload: {
          tenant_name: 'New Biz',
          business_type: 'salon',
          owner_first_name: 'Jane',
          owner_last_name: 'Doe',
          owner_email: 'jane@newbiz.com',
          owner_pass: 'secure123',
        },
      });

      // The tenant + owner already committed: a 500 here would tell the admin to
      // retry a create that can only conflict on the existing owner.
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        success: true,
        tenant_id: TENANT_ID,
        consent_invite_issued: false,
      });
      await new Promise((r) => setImmediate(r));
      // No stored token -> a link in an email could never work.
      expect(sysmail.sendTenantConsentInviteEmail).not.toHaveBeenCalled();
      // The admin still learns a tenant is pending consent.
      expect(sysmail.sendTenantConsentPendingAdminNotice).toHaveBeenCalledTimes(1);
    } finally {
      mockClient.query.mockImplementation(realQuery);
    }
  });

  it('SAD: non-super-admin cannot create a tenant, so no invite row and no emails', async () => {
    const sysmail = await import('../../src/services/communications/systemEmail');
    authStub = {
      user_id: 'front-desk-user',
      tenant_id: TENANT_ID,
      email: 'staff@test',
      role: 'front_desk',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/tenants/create',
      payload: {
        tenant_name: 'Nope Biz',
        business_type: 'salon',
        owner_first_name: 'Jane',
        owner_last_name: 'Doe',
        owner_email: 'jane@nope.com',
        owner_pass: 'secure123',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(queries).toHaveLength(0);
    expect(sysmail.sendTenantConsentInviteEmail).not.toHaveBeenCalled();
  });
});
