/**
 * Route-handler tests for src/routes/mappings.ts.
 *
 * Why this file exists:
 *   The pre-coverage baseline showed mappings.ts at 1.88% line coverage —
 *   the underlying SQL was exercised indirectly through other tests, but
 *   the Fastify handler glue (UUID validation, requireTenantId, response
 *   envelope) had no direct coverage. A bad ?serviceId= rename or a
 *   regressed UUID regex would slip past current tests.
 *
 *   First adopter of the `buildRouteTestApp()` helper from
 *   `src/test-utils-mock.ts` (the Phase 1 prototype for the broader
 *   route-handler coverage push tracked in docs/TODO.md).
 *
 * Coverage targets:
 *   - 6 endpoints × happy path = 6 tests
 *   - 4 mutation endpoints × invalid-UUID sad = 4 tests
 *   - 6 endpoints × missing-tenant sad = 1 representative test (helper-shared
 *     code path; full enumeration would just exercise the same require call)
 *   - Tenant-scoping invariant (tenant_id in every WHERE/INSERT) = 2 tests
 *
 * What this file does NOT cover:
 *   - DB-layer RLS enforcement on `service_resource` / `service_employee`
 *     (covered by `src/rls.test.ts` against real Postgres)
 *   - Cross-tenant override probes (covered by
 *     `src/multi-tenant-isolation.test.ts`)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerMappingRoutes } from '../../src/routes/mappings';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SERVICE_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const EMPLOYEE_ID = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
const RESOURCE_ID = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';

let handle: RouteTestAppHandle;
let app: FastifyInstance;

beforeAll(async () => {
  handle = buildRouteTestApp((app, pool, withTenantClient) => {
    registerMappingRoutes(app, pool, withTenantClient);
  });
  app = handle.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  handle.queries.length = 0;
  handle.queryResponses.length = 0;
  handle.tenantIdOverride.current = null;
  handle.auth.current = {
    user_id: '00000000-0000-0000-0000-000000000001',
    tenant_id: TENANT_ID,
    email: 'owner@test.local',
    role: 'owner',
  };
});

// ────────────────────────────────────────────────────────────────────
// GET endpoints — list mappings
// ────────────────────────────────────────────────────────────────────

describe('GET /mappings/service-resource', () => {
  it("HAPPY: returns rows scoped to the caller's tenant", async () => {
    // WHO: a tenant owner loading the Service Assignments view
    // WHAT: SELECT * FROM service_resource WHERE tenant_id = $1
    // WHEN: dashboard mounts the assignments matrix
    // WHERE: GET /mappings/service-resource handler
    // WHY: the matrix view depends on this list; if the SELECT loses its
    //       tenant_id filter, one tenant could see another's mappings —
    //       even though RLS would reject the read, that would surface as
    //       an empty list, not a clear error
    handle.queryResponses.push({
      rows: [{ tenant_id: TENANT_ID, service_id: SERVICE_ID, resource_id: RESOURCE_ID }],
    });

    const res = await app.inject({ method: 'GET', url: '/mappings/service-resource' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].service_id).toBe(SERVICE_ID);

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(1);
    expect(dataQueries[0].text).toContain('FROM service_resource WHERE tenant_id = $1');
    expect(dataQueries[0].params).toEqual([TENANT_ID]);
  });
});

describe('GET /mappings/service-employee', () => {
  it("HAPPY: returns service-employee mappings scoped to caller's tenant", async () => {
    // WHO: a tenant owner loading the Service Assignments view
    // WHAT: SELECT * FROM service_employee WHERE tenant_id = $1
    // WHEN: dashboard mounts the assignments matrix
    // WHERE: GET /mappings/service-employee handler
    // WHY: same tenant-scoping invariant as the resource mapping query —
    //       a missing WHERE clause here would silently surface another
    //       tenant's employee assignments
    handle.queryResponses.push({
      rows: [{ tenant_id: TENANT_ID, service_id: SERVICE_ID, employee_id: EMPLOYEE_ID }],
    });

    const res = await app.inject({ method: 'GET', url: '/mappings/service-employee' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries[0].text).toContain('FROM service_employee WHERE tenant_id = $1');
    expect(dataQueries[0].params).toEqual([TENANT_ID]);
  });
});

// ────────────────────────────────────────────────────────────────────
// POST assign/unassign endpoints — happy paths
// ────────────────────────────────────────────────────────────────────

describe('POST /services/:serviceId/employees/:employeeId/assign', () => {
  it('HAPPY: inserts service_employee row with tenant_id and returns success', async () => {
    // WHO: tenant owner assigning a tech to a service
    // WHAT: INSERT INTO service_employee (service_id, employee_id, tenant_id)
    //       ON CONFLICT DO NOTHING — idempotent assignment
    // WHEN: dashboard checkbox in Service Assignments matrix
    // WHERE: POST /services/:serviceId/employees/:employeeId/assign
    // WHY: ON CONFLICT DO NOTHING means double-assign returns success without
    //       a duplicate row — the dashboard doesn't need to track existing
    //       state before sending. The route must still tenant-scope the
    //       insert to prevent cross-tenant assignment injection.
    handle.queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'POST',
      url: `/services/${SERVICE_ID}/employees/${EMPLOYEE_ID}/assign`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries[0].text).toContain('INSERT INTO service_employee');
    expect(dataQueries[0].text).toContain('ON CONFLICT DO NOTHING');
    expect(dataQueries[0].params).toEqual([SERVICE_ID, EMPLOYEE_ID, TENANT_ID]);
  });

  it('SAD: rejects malformed serviceId UUID with 400 and never queries the DB', async () => {
    // WHO: a buggy client (typo, copy-paste error) sending a non-UUID
    // WHAT: route's UUID_RE check fires before reaching the DB
    // WHEN: any assign request with an invalid UUID in either path param
    // WHERE: UUID_RE.test() guard at top of handler
    // WHY: passing a non-UUID through to Postgres would surface as a 500
    //       "invalid input syntax for type uuid" — the guard turns it
    //       into a clean 400 with a message naming both expected params
    const res = await app.inject({
      method: 'POST',
      url: `/services/not-a-uuid/employees/${EMPLOYEE_ID}/assign`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      success: false,
      error: 'Invalid serviceId — must be UUID',
    });

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
  });

  it('SAD: rejects malformed employeeId UUID with 400', async () => {
    // WHO: a buggy client sending a valid serviceId but bad employeeId
    // WHAT: same UUID_RE check, this time triggered by employeeId
    // WHEN: any assign with malformed second path param
    // WHERE: UUID_RE.test() guard catches both params
    // WHY: confirms the guard is symmetric across both params, not just
    //       the first — defends against a regression that drops one half
    const res = await app.inject({
      method: 'POST',
      url: `/services/${SERVICE_ID}/employees/not-uuid/assign`,
    });

    expect(res.statusCode).toBe(400);
    expect(
      handle.queries.filter((q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET'))
    ).toHaveLength(0);
  });
});

describe('POST /services/:serviceId/employees/:employeeId/unassign', () => {
  it('HAPPY: deletes the assignment scoped to tenant_id', async () => {
    // WHO: tenant owner unassigning a tech from a service
    // WHAT: DELETE FROM service_employee WHERE service_id AND employee_id AND tenant_id
    // WHEN: dashboard checkbox unchecked
    // WHERE: POST /.../unassign handler
    // WHY: the tenant_id in the WHERE clause is load-bearing — without it,
    //       a malicious request with another tenant's IDs could delete
    //       another tenant's assignments. RLS would catch the read, but
    //       the WHERE-tenant_id is the primary application-layer guard.
    handle.queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'POST',
      url: `/services/${SERVICE_ID}/employees/${EMPLOYEE_ID}/unassign`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries[0].text).toContain('DELETE FROM service_employee');
    expect(dataQueries[0].text).toContain('tenant_id = $3');
    expect(dataQueries[0].params).toEqual([SERVICE_ID, EMPLOYEE_ID, TENANT_ID]);
  });

  it('SAD: rejects bad UUIDs with 400', async () => {
    // WHO: any caller with malformed path params
    // WHAT: UUID_RE guard rejects before DELETE runs
    // WHEN: bad serviceId or employeeId
    // WHERE: UUID_RE check at top of unassign handler
    // WHY: parallel coverage to the assign path — confirms the guard exists
    //       on both halves of the assign/unassign pair (a refactor that
    //       added the check to one but missed the other would slip here)
    const res = await app.inject({
      method: 'POST',
      url: `/services/bad-id/employees/${EMPLOYEE_ID}/unassign`,
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /services/:serviceId/resources/:resourceId/assign', () => {
  it('HAPPY: inserts service_resource row scoped to tenant', async () => {
    // WHO: tenant owner assigning a bay/chair/truck to a service
    // WHAT: INSERT INTO service_resource ON CONFLICT DO NOTHING
    // WHEN: dashboard Service Assignments resource column checkbox
    // WHERE: POST /services/:serviceId/resources/:resourceId/assign
    // WHY: same idempotency contract as employee assign — repeated clicks
    //       on a checkbox shouldn't error
    handle.queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'POST',
      url: `/services/${SERVICE_ID}/resources/${RESOURCE_ID}/assign`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries[0].text).toContain('INSERT INTO service_resource');
    expect(dataQueries[0].text).toContain('ON CONFLICT DO NOTHING');
    expect(dataQueries[0].params).toEqual([SERVICE_ID, RESOURCE_ID, TENANT_ID]);
  });

  it('SAD: rejects bad resourceId UUID with 400', async () => {
    // WHO: a buggy client sending a valid serviceId but bad resourceId
    // WHAT: UUID_RE guard fires
    // WHEN: malformed resourceId path param
    // WHERE: UUID_RE check
    // WHY: confirms the check covers the resource path (different from
    //       the employee path that it might have been copy-pasted from)
    const res = await app.inject({
      method: 'POST',
      url: `/services/${SERVICE_ID}/resources/not-uuid/assign`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      success: false,
      error: 'Invalid resourceId — must be UUID',
    });
  });
});

describe('POST /services/:serviceId/resources/:resourceId/unassign', () => {
  it('HAPPY: deletes service_resource row scoped to tenant', async () => {
    // WHO: tenant owner unassigning a resource from a service
    // WHAT: DELETE FROM service_resource scoped by all 3 IDs
    // WHEN: dashboard Service Assignments resource column unchecked
    // WHERE: POST /services/:serviceId/resources/:resourceId/unassign
    // WHY: confirms the unassign path matches the assign path's scoping —
    //       a refactor that loosened the WHERE clause in one direction
    //       and not the other would be caught here
    handle.queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'POST',
      url: `/services/${SERVICE_ID}/resources/${RESOURCE_ID}/unassign`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries[0].text).toContain('DELETE FROM service_resource');
    expect(dataQueries[0].params).toEqual([SERVICE_ID, RESOURCE_ID, TENANT_ID]);
  });

  it('SAD: rejects bad UUIDs with 400 and never DELETEs', async () => {
    // WHO: malformed unassign request
    // WHAT: UUID_RE rejects before DELETE
    // WHEN: bad resourceId
    // WHERE: UUID_RE check
    // WHY: regression guard — a future "let's accept any string" change
    //       would let bad input reach Postgres and surface as 500
    const res = await app.inject({
      method: 'POST',
      url: `/services/${SERVICE_ID}/resources/garbage/unassign`,
    });

    expect(res.statusCode).toBe(400);
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// Auth / tenant-context guards
// ────────────────────────────────────────────────────────────────────

describe('mappings — auth/tenant-context guards', () => {
  it('SAD: returns 400 when no tenant_id is on the request', async () => {
    // WHO: an unusual request that bypassed tenantMiddleware (or auth)
    // WHAT: requireTenantId() returns null → handler short-circuits with
    //       400 before any DB query runs
    // WHEN: missing tenant context (auth.tenant_id is null AND no override)
    // WHERE: requireTenantId() guard at the top of every handler
    // WHY: every mappings route depends on tenantId; without a guard,
    //       the SELECT/INSERT/DELETE would receive `undefined` as $1
    //       and either throw 500 or — worse — match unexpected rows
    handle.auth.current = null;
    handle.tenantIdOverride.current = null;

    const res = await app.inject({ method: 'GET', url: '/mappings/service-resource' });

    // 2026-05-21: no auth context → 401 (authentication is the real failure),
    // not the old misleading 400. Gate still fires before any DB query.
    expect(res.statusCode).toBe(401);
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// SECURITY — owner-role gate (2026-09-16 role-check audit)
// ────────────────────────────────────────────────────────────────────

describe('mappings — owner-role gate', () => {
  const mutatingRoutes: Array<[string, string]> = [
    ['assign employee', `/services/${SERVICE_ID}/employees/${EMPLOYEE_ID}/assign`],
    ['unassign employee', `/services/${SERVICE_ID}/employees/${EMPLOYEE_ID}/unassign`],
    ['assign resource', `/services/${SERVICE_ID}/resources/${RESOURCE_ID}/assign`],
    ['unassign resource', `/services/${SERVICE_ID}/resources/${RESOURCE_ID}/unassign`],
  ];

  it.each(mutatingRoutes)(
    'SECURITY: %s is rejected 403 for a front-desk user before any query runs',
    async (_name, path) => {
      handle.auth.current = {
        user_id: '00000000-0000-0000-0000-000000000002',
        tenant_id: TENANT_ID,
        email: 'frontdesk@test.local',
        role: 'front_desk',
      };

      const res = await app.inject({ method: 'POST', url: path });

      expect(res.statusCode).toBe(403);
      expect(res.json().success).toBe(false);
      const dataQueries = handle.queries.filter(
        (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
      );
      expect(dataQueries).toHaveLength(0);
    }
  );
});
