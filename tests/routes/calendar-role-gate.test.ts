/**
 * SECURITY: owner-role gate on POST /calendar/sync, POST /calendar/settings,
 * POST /calendar/settings/disconnect (2026-09-16 role-check audit,
 * docs/planning/TODO.md).
 *
 * WHO:   a front-desk login trying to rewire or disconnect the tenant's
 *        calendar integration.
 * WHERE: src/routes/calendar.ts.
 * WHY:   previously these routes checked only `requireTenantId`
 *        (`/calendar/sync` didn't even check that).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/services/googleCalendar', () => ({
  isGoogleCalendarEnabled: () => true,
  getAuthUrl: vi.fn(),
  verifyState: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  revokeToken: vi.fn(),
}));
vi.mock('../../src/services/outlookCalendar', () => ({
  isOutlookCalendarEnabled: () => true,
  getAuthUrl: vi.fn(),
  verifyState: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  revokeToken: vi.fn(),
}));

import { registerCalendarRoutes } from '../../src/routes/calendar';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let handle: RouteTestAppHandle;
let app: FastifyInstance;

beforeAll(async () => {
  handle = buildRouteTestApp((a, pool, withTenantClient) => {
    registerCalendarRoutes(a, pool, withTenantClient);
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
  setAuth('owner');
});

function dataQueries() {
  return handle.queries.filter(
    (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
  );
}

const mutatingRoutes: Array<[string, string, Record<string, unknown>]> = [
  ['/calendar/sync', 'sync webhook trigger', { provider: 'google' }],
  ['/calendar/settings', 'manual save', { provider: 'google', external_calendar_id: 'cal-1' }],
  ['/calendar/settings/disconnect', 'disconnect', {}],
];

describe('POST /calendar/* mutating routes — owner-role gate', () => {
  it.each(mutatingRoutes)(
    'SECURITY: %s is rejected 403 for a front-desk user before any query runs',
    async (path, _name, payload) => {
      setAuth('front_desk');

      const res = await app.inject({ method: 'POST', url: path, payload });

      expect(res.statusCode).toBe(403);
      expect(res.json().success).toBe(false);
      expect(dataQueries()).toHaveLength(0);
    }
  );

  it.each(mutatingRoutes)(
    'SECURITY: %s is rejected 401 when unauthenticated',
    async (path, _name, payload) => {
      setAuth(null);

      const res = await app.inject({ method: 'POST', url: path, payload });

      expect(res.statusCode).toBe(401);
      expect(dataQueries()).toHaveLength(0);
    }
  );

  it('HAPPY: an owner can hit /calendar/sync (202 accepted, no role block)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/calendar/sync',
      payload: { provider: 'google' },
    });

    expect(res.statusCode).toBe(202);
  });
});
