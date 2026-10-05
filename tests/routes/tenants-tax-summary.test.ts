/**
 * GET /tenants/tax-summary — where our paying customers use the service (sales tax).
 * WHO: the platform super-admin | WHY: Stripe's threshold monitor skips Chicago lease tax, so we watch it ourselves.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerTenantRoutes } from '../../src/routes/tenants';
import { createMockClient, createMockPool, type MockResponse } from '../mock';

const SUPER_ADMIN_TENANT = '00000000-0000-0000-0000-000000000000';

let app: FastifyInstance;
let queryResponses: MockResponse[];
let authStub: {
  user_id: string;
  tenant_id: string;
  email: string;
  role: 'owner' | 'front_desk';
} | null;

beforeAll(async () => {
  const handle = createMockClient();
  queryResponses = handle.queryResponses;
  const fastify = Fastify({ logger: false });
  fastify.addHook('preHandler', async (request) => {
    (request as unknown as { auth: typeof authStub }).auth = authStub;
  });
  registerTenantRoutes(fastify, createMockPool(handle.mockClient), (async (
    _t: string,
    fn: (c: unknown) => Promise<unknown>
  ) => fn(handle.mockClient)) as unknown as Parameters<typeof registerTenantRoutes>[2]);
  app = fastify;
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  queryResponses.length = 0;
  authStub = { user_id: 'a', tenant_id: SUPER_ADMIN_TENANT, email: 'admin@test', role: 'owner' };
});

describe('GET /tenants/tax-summary', () => {
  it('HAPPY: a super-admin gets the summary', async () => {
    queryResponses.push({
      rows: [
        {
          tenant_id: 't1',
          name: 'Loop Salon',
          subscription_status: 'active',
          subscription_plan: 'solo',
          service_city: 'Chicago',
          service_state: 'IL',
          service_zip: '60602',
        },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/tenants/tax-summary' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      success: boolean;
      generated_at: string;
      states: { state: string }[];
      chicago: { tenants: number };
    }>();
    expect(body.success).toBe(true);
    expect(body.states.map((s) => s.state)).toEqual(['IL']);
    expect(body.chicago.tenants).toBe(1);
    expect(Number.isNaN(Date.parse(body.generated_at))).toBe(false);
  });

  it('SAD: an ordinary business owner is refused 403 (it spans every tenant)', async () => {
    authStub = {
      user_id: 'o',
      tenant_id: 'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0',
      email: 'o@test',
      role: 'owner',
    };
    const res = await app.inject({ method: 'GET', url: '/tenants/tax-summary' });
    expect(res.statusCode).toBe(403);
  });

  it('SAD: unauthenticated is refused 401', async () => {
    authStub = null;
    const res = await app.inject({ method: 'GET', url: '/tenants/tax-summary' });
    expect(res.statusCode).toBe(401);
  });
});
