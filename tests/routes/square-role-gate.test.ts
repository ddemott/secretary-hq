/**
 * SECURITY: owner-role gate on GET /square/auth, POST /square/settings/disconnect,
 * POST /square/sync (2026-09-16 roady re-verify of #522).
 *
 * WHO:   a front-desk login initiating/tearing down a real external OAuth
 *        connection directly.
 * WHAT:  these three routes are the scaffold's action endpoints
 *        (src/routes/crmRouteScaffold.ts, registered for Square in
 *        src/routes/square.ts) — same class of action as billing.ts's
 *        checkout/portal and provisioning.ts's activate/deactivate (both
 *        correctly owner-gated in #522). GET /square/settings and
 *        GET /square/sync/status are deliberately NOT covered here — they
 *        are reads, gated the same way calendar.ts's reads are left ungated.
 * WHERE: src/routes/crmRouteScaffold.ts (registerCrmScaffoldRoutes) —
 *        exercised directly with a fake provider config rather than through
 *        square.ts, since the gate lives in the shared scaffold and applies
 *        to every provider that uses it.
 * WHY:   previously these three checked only `requireTenantId`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerCrmScaffoldRoutes } from '../../src/routes/crmRouteScaffold';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const fullSync = vi.fn().mockResolvedValue({ customersSynced: 0 });

let handle: RouteTestAppHandle;
let app: FastifyInstance;

beforeAll(async () => {
  handle = buildRouteTestApp((a, pool, withTenantClient) => {
    registerCrmScaffoldRoutes(a, pool, withTenantClient, {
      provider: 'square',
      displayName: 'Square',
      isEnabled: () => true,
      getAuthUrl: () => 'https://connect.squareup.com/oauth2/authorize?client_id=test',
      verifyState: () => null,
      exchangeCodeForTokens: () =>
        Promise.resolve({ access_token: 'a', refresh_token: 'r', expiry_date: 0 }),
      fullSync,
    });
  });
  app = handle.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function setAuth(role: 'owner' | 'front_desk' | null) {
  handle.auth.current =
    role === null
      ? null
      : {
          user_id: '00000000-0000-0000-0000-000000000001',
          tenant_id: TENANT_ID,
          email: `${role}@test.local`,
          role,
        };
}

beforeEach(() => {
  handle.queries.length = 0;
  handle.queryResponses.length = 0;
  handle.tenantIdOverride.current = null;
  fullSync.mockClear();
  setAuth('owner');
});

function dataQueries() {
  return handle.queries.filter(
    (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
  );
}

const gatedRoutes: Array<['GET' | 'POST', string, string]> = [
  ['GET', '/square/auth', 'initiate OAuth'],
  ['POST', '/square/settings/disconnect', 'disconnect'],
  ['POST', '/square/sync', 'trigger full sync'],
];

describe('/square/* action routes — owner-role gate', () => {
  it.each(gatedRoutes)(
    'SECURITY: %s %s (%s) is rejected 403 for a front-desk user before any query runs',
    async (method, path, _name) => {
      setAuth('front_desk');

      const res = await app.inject({ method, url: path });

      expect(res.statusCode).toBe(403);
      expect(res.json().success).toBe(false);
      expect(dataQueries()).toHaveLength(0);
      expect(fullSync).not.toHaveBeenCalled();
    }
  );

  it.each(gatedRoutes)(
    'SECURITY: %s %s (%s) is rejected 401 when unauthenticated',
    async (method, path, _name) => {
      setAuth(null);

      const res = await app.inject({ method, url: path });

      expect(res.statusCode).toBe(401);
      expect(dataQueries()).toHaveLength(0);
      expect(fullSync).not.toHaveBeenCalled();
    }
  );

  it('HAPPY: an owner can reach GET /square/auth past the role gate', async () => {
    const res = await app.inject({ method: 'GET', url: '/square/auth' });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('HAPPY: an owner can reach POST /square/settings/disconnect past the role gate', async () => {
    handle.queryResponses.push({ rows: [], rowCount: 1 });
    handle.queryResponses.push({ rows: [], rowCount: 0 });

    const res = await app.inject({ method: 'POST', url: '/square/settings/disconnect' });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('HAPPY: an owner can reach POST /square/sync past the role gate', async () => {
    const res = await app.inject({ method: 'POST', url: '/square/sync' });

    expect(res.statusCode).toBe(200);
    expect(fullSync).toHaveBeenCalledWith(expect.anything(), TENANT_ID);
  });
});
