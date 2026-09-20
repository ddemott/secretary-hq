/**
 * SECURITY: owner-role gate on POST /setup/commit, POST /setup/impact,
 * POST /setup/default-service (2026-09-16 roady re-verify of #522).
 *
 * WHO:   a front-desk login POSTing a crafted draft graph directly.
 * WHAT:  /setup/commit is the onboarding wizard's bulk write — backed by
 *        insertDraftGraph (src/services/setupGraph.ts), it inserts/updates
 *        services, resources, employees, shifts, and skill mappings, and in
 *        `mode: 'sync'` it soft-deletes/hard-deletes anything the draft
 *        omits. This is the EXACT same write surface services.ts /
 *        employees.ts / resources.ts / shifts.ts / mappings.ts were each
 *        individually owner-gated for in #522, reached through a different
 *        code path that bypassed all five gates. /setup/impact is the
 *        dry-run preview over the same draft (no writes, but same
 *        business-structure exposure). /setup/default-service changes
 *        which service every unmatched call books.
 * WHERE: src/routes/setup.ts.
 * WHY:   previously all three checked only `requireTenantId`, no
 *        `req.auth.role` check anywhere in the file.
 *
 * GET /setup/graph is deliberately NOT covered here — it is the wizard's
 * own precondition read (every row an owner already has), not part of this
 * finding, and untouched by this fix.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerSetupRoutes } from '../../src/routes/setup';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let handle: RouteTestAppHandle;
let app: FastifyInstance;

beforeAll(async () => {
  handle = buildRouteTestApp((a, pool, withTenantClient) => {
    registerSetupRoutes(a, pool, withTenantClient);
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

const minimalDraft = { services: [], resources: [], employees: [], shifts: [] };

const gatedRoutes: Array<[string, string, Record<string, unknown>]> = [
  ['/setup/commit', 'bulk commit', minimalDraft],
  ['/setup/impact', 'sync-mode dry-run preview', minimalDraft],
  ['/setup/default-service', 'apply fallthrough-service policy', {}],
];

describe('POST /setup/* — owner-role gate', () => {
  it.each(gatedRoutes)(
    'SECURITY: %s (%s) is rejected 403 for a front-desk user before any query runs',
    async (path, _name, payload) => {
      setAuth('front_desk');

      const res = await app.inject({ method: 'POST', url: path, payload });

      expect(res.statusCode).toBe(403);
      expect(res.json().success).toBe(false);
      expect(dataQueries()).toHaveLength(0);
    }
  );

  it.each(gatedRoutes)(
    'SECURITY: %s (%s) is rejected 401 when unauthenticated',
    async (path, _name, payload) => {
      setAuth(null);

      const res = await app.inject({ method: 'POST', url: path, payload });

      expect(res.statusCode).toBe(401);
      expect(dataQueries()).toHaveLength(0);
    }
  );

  it('HAPPY: an owner posting a malformed draft to /setup/commit still gets past the role gate (400, not 403)', async () => {
    // Proves the gate doesn't accidentally shadow validation — an owner's
    // bad request should fail schema validation, not the role check.
    const res = await app.inject({
      method: 'POST',
      url: '/setup/commit',
      payload: { resources: [] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('HAPPY: an owner posting a malformed draft to /setup/impact still gets past the role gate (400, not 403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/setup/impact',
      payload: { resources: [] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('HAPPY: an owner can reach /setup/default-service past the role gate', async () => {
    // applyDefaultServicePolicy queries services for this tenant; an empty
    // result set means "nothing applied", which is still a 200 past the gate.
    handle.queryResponses.push({ rows: [] });

    const res = await app.inject({ method: 'POST', url: '/setup/default-service' });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });
});
