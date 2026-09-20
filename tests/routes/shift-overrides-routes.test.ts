/**
 * Route-level tests for the shift-override CRUD endpoints:
 *   POST /shifts/overrides/create        — UPSERT one employee_schedule row
 *   POST /shifts/overrides/:id/update    — partial UPDATE on an existing row
 *   DELETE /shifts/overrides/:id         — remove an override
 *
 * The READ path (`GET /shifts/overrides` and the `get_effective_shifts` RPC)
 * is covered by `src/shift-overrides-edge.test.ts` (real-DB integration,
 * 9 tests pinning the RPC contract). This file covers the WRITE path —
 * Zod validation, `ON CONFLICT DO UPDATE` semantics on create, the
 * 404-on-missing-row path on update + delete.
 *
 * Origin: historical major refactor (see RESOLVED.md) "Add tests for destructive flows" —
 * the verify-first found that the override CRUD routes had route-handler
 * tests via `crud-routes.test.ts` only at the architectural-rule level;
 * the per-handler shape and validation paths weren't pinned directly.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerShiftRoutes } from '../../src/routes/shifts';
import {
  createMockClient,
  createMockPool,
  createMockWithTenantClient,
  type MockClient,
  type MockResponse,
} from '../mock';

// Real v4 UUIDs — Zod's .uuid() validator requires the proper version
// (4xxx) and variant (8/9/a/b) nibbles.
const TENANT_ID = 'f234e471-0e60-4163-86c9-93cfd9338e3a';
const EMPLOYEE_ID = 'a1b2c3d4-e5f6-4789-ab12-cdef34567890';
// Composite-key date used in the update + delete URLs (pilot #3,
// 2026-05-18: routes take (employee_id, shift_date) instead of the
// dropped surrogate).
const SHIFT_DATE = '2026-05-15';

let app: FastifyInstance;
let mockClient: MockClient;
let queryResponses: MockResponse[];
let queries: { text: string; params: unknown[] }[];

type TestAuth = { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
/**
 * `undefined` = default owner stub (every route in this file is owner-gated
 * via requireOwnerRole, 2026-09-16 role-check audit); set explicitly
 * per-test to exercise the gate itself (front_desk → 403, null → 401).
 */
let authOverride: TestAuth | null | undefined;

function buildApp() {
  const handle = createMockClient();
  mockClient = handle.mockClient;
  queryResponses = handle.queryResponses;
  queries = handle.queries;
  const mockPool = createMockPool(mockClient);
  const withTenantClient = createMockWithTenantClient(mockClient);

  const fastify = Fastify({ logger: false });

  // The DELETE route reads request.tenantId from middleware; simulate
  // tenant-id injection from query param or header for tests. Also stamp
  // request.auth so the routes' requireOwnerRole gate sees an owner by
  // default — real production requests always carry a JWT-derived auth.
  fastify.addHook('preHandler', async (request) => {
    const q = request.query as Record<string, string> | undefined;
    const tid = q?.tenant_id || (request.headers['x-tenant-id'] as string);
    if (tid) (request as unknown as { tenantId: string }).tenantId = tid;
    // A real dashboard request always carries a JWT-derived req.auth,
    // independent of whatever tenant_id (if any) is in the query/header/
    // body — that's a separate, unrelated field the Zod schema validates
    // on its own. Default to an authenticated owner here; tests that want
    // to simulate a genuinely unauthenticated request set
    // `authOverride = null` explicitly.
    (request as unknown as { auth: TestAuth | null | undefined }).auth =
      authOverride !== undefined
        ? authOverride
        : { tenant_id: tid || TENANT_ID, user_id: 'owner-user', email: 'owner@test.local', role: 'owner' };
  });

  registerShiftRoutes(
    fastify,
    mockPool,
    withTenantClient as Parameters<typeof registerShiftRoutes>[2]
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
  authOverride = undefined;
});

// ════════════════════════════════════════════════════════════════════
// POST /shifts/overrides/create
// ════════════════════════════════════════════════════════════════════

describe('POST /shifts/overrides/create — happy paths', () => {
  it('HAPPY: inserts an override with start/end hours and returns the row', async () => {
    // WHO: front desk owner setting a one-off shift for an employee
    // WHAT: route runs INSERT INTO employee_schedule with ON CONFLICT
    //       DO UPDATE so a second create for the same (tenant, employee, date)
    //       upserts cleanly. Returns the inserted row in `override`.
    // WHEN: owner picks a date in the override modal and clicks save
    // WHERE: src/routes/shifts.ts → app.post('/shifts/overrides/create', ...)
    // WHY: this is the WRITE path for date-specific scheduling. A regression
    //      here surfaces as missed shift bars in the scheduler view + voice
    //      AI booking failures (no eligible employees on that date)
    const insertedRow = {
      tenant_id: TENANT_ID,
      employee_id: EMPLOYEE_ID,
      shift_date: '2026-05-15',
      start_time: '09:00',
      end_time: '17:00',
      is_off: false,
    };
    queryResponses.push({ rows: [insertedRow], rowCount: 1 });

    const res = await app.inject({
      method: 'POST',
      url: '/shifts/overrides/create',
      payload: {
        tenant_id: TENANT_ID,
        employee_id: EMPLOYEE_ID,
        shift_date: '2026-05-15',
        start_time: '09:00',
        end_time: '17:00',
        is_off: false,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, override: insertedRow });
    expect(queries).toHaveLength(1);
    expect(queries[0].text).toContain('INSERT INTO employee_schedule');
    expect(queries[0].text).toContain('ON CONFLICT');
    expect(queries[0].params).toEqual([
      TENANT_ID,
      EMPLOYEE_ID,
      '2026-05-15',
      '09:00',
      '17:00',
      false,
    ]);
  });

  it('HAPPY: inserts an is_off override with null start/end times', async () => {
    // WHO: owner marking an employee unavailable for a specific day
    //      (sick, vacation, training)
    // WHAT: when is_off=true the start/end times are optional and the route
    //       passes null for missing hour fields rather than rejecting them
    // WHY: voice AI's get_effective_shifts must see the is_off=true row to
    //      keep the agent from offering bookings against an off employee
    const insertedRow = {
      tenant_id: TENANT_ID,
      employee_id: EMPLOYEE_ID,
      shift_date: '2026-05-20',
      start_time: null,
      end_time: null,
      is_off: true,
    };
    queryResponses.push({ rows: [insertedRow], rowCount: 1 });

    const res = await app.inject({
      method: 'POST',
      url: '/shifts/overrides/create',
      payload: {
        tenant_id: TENANT_ID,
        employee_id: EMPLOYEE_ID,
        shift_date: '2026-05-20',
        is_off: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, override: insertedRow });
    // start_time + end_time should be null in the params, not undefined
    expect(queries[0].params).toEqual([TENANT_ID, EMPLOYEE_ID, '2026-05-20', null, null, true]);
  });
});

describe('POST /shifts/overrides/create — sad paths', () => {
  it('SAD: rejects payload missing tenant_id with 400', async () => {
    // WHO: misconfigured client request without tenant_id
    // WHAT: Zod safeParse fails → 400 with details, no DB query runs
    // WHY: tenant_id is the primary scoping key. Reaching the DB without
    //      one would leak the override into a wrong tenant or fail noisily
    const res = await app.inject({
      method: 'POST',
      url: '/shifts/overrides/create',
      payload: {
        employee_id: EMPLOYEE_ID,
        shift_date: '2026-05-15',
        is_off: false,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: 'Validation failed' });
    expect(queries).toHaveLength(0);
  });

  it('SAD: rejects non-UUID employee_id with 400', async () => {
    // WHO: typo in employee_id, or stale UI state with non-UUID string
    // WHAT: Zod's .uuid() check fails → 400 before DB
    // WHY: same defense — invalid UUID would cause a runtime cast failure
    //      inside the SQL driver if it slipped through
    const res = await app.inject({
      method: 'POST',
      url: '/shifts/overrides/create',
      payload: {
        tenant_id: TENANT_ID,
        employee_id: 'not-a-uuid',
        shift_date: '2026-05-15',
        is_off: false,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(queries).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// POST /shifts/overrides/:id/update
// ════════════════════════════════════════════════════════════════════

describe('POST /shifts/overrides/:employeeId/:shiftDate/update — happy paths', () => {
  it('HAPPY: updates only the fields provided (partial update via COALESCE)', async () => {
    // WHO: owner changing an existing override's end_time only
    // WHAT: route uses COALESCE($1, start_time), COALESCE($2, end_time),
    //       COALESCE($3, is_off) so missing fields preserve the current
    //       column value rather than blanking it
    // WHEN: owner edits one field in the override modal and saves
    // WHERE: src/routes/shifts.ts → /shifts/overrides/:employeeId/:shiftDate/update
    //        (pilot #3, 2026-05-18: surrogate :id replaced by composite path).
    // WHY: the COALESCE shape lets the dashboard's edit form omit fields
    //      it didn't change. A regression to "all fields required" would
    //      break the partial-update UX silently
    const updatedRow = {
      tenant_id: TENANT_ID,
      employee_id: EMPLOYEE_ID,
      shift_date: SHIFT_DATE,
      start_time: '09:00',
      end_time: '15:00', // changed from 17:00
      is_off: false,
    };
    queryResponses.push({ rows: [updatedRow], rowCount: 1 });

    const res = await app.inject({
      method: 'POST',
      url: `/shifts/overrides/${EMPLOYEE_ID}/${SHIFT_DATE}/update?tenant_id=${TENANT_ID}`,
      payload: {
        tenant_id: TENANT_ID,
        end_time: '15:00',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, override: updatedRow });
    // null/undefined for unchanged fields → COALESCE keeps the existing column value
    expect(queries[0].params).toEqual([
      undefined,
      '15:00',
      undefined,
      TENANT_ID,
      EMPLOYEE_ID,
      SHIFT_DATE,
    ]);
  });
});

describe('POST /shifts/overrides/:employeeId/:shiftDate/update — sad paths', () => {
  it('SAD: returns 404 when no row matches the composite key', async () => {
    // WHO: a stale UI request to update an override that's already been
    //      deleted, or a wrong-tenant guess
    // WHAT: route checks res.rows.length === 0 → 404 envelope
    // WHEN: race between two admins, or a UI that didn't refresh after
    //       a delete elsewhere
    // WHY: a silent success here would mislead the admin into thinking
    //      their edit landed when no row was actually changed
    queryResponses.push({ rows: [], rowCount: 0 });

    const res = await app.inject({
      method: 'POST',
      url: `/shifts/overrides/${EMPLOYEE_ID}/${SHIFT_DATE}/update?tenant_id=${TENANT_ID}`,
      payload: { tenant_id: TENANT_ID, is_off: true },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false, error: 'Override not found' });
  });

  it('SAD: rejects update payload with no auth context (401)', async () => {
    // WHO: unauthenticated client posting without tenant context
    // WHAT: 2026-05-21 — no auth → 401 (authentication is the real failure),
    //       not the old misleading 400. Still no DB query runs.
    // WHY: same scoping argument as create — without an authenticated
    //      session a guessed composite key must not reach a cross-tenant UPDATE
    authOverride = null;
    const res = await app.inject({
      method: 'POST',
      url: `/shifts/overrides/${EMPLOYEE_ID}/${SHIFT_DATE}/update`,
      payload: { is_off: true },
    });

    expect(res.statusCode).toBe(401);
    expect(queries).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// DELETE /shifts/overrides/:employeeId/:shiftDate
// ════════════════════════════════════════════════════════════════════

describe('DELETE /shifts/overrides/:employeeId/:shiftDate — happy paths', () => {
  it('HAPPY: deletes the override when the row exists', async () => {
    // WHO: owner removing a previously-set override (revert to default)
    // WHAT: route runs DELETE FROM employee_schedule WHERE the composite
    //       key matches; returns success when rowCount=1
    // WHEN: owner clicks "Remove Override" in the override modal
    // WHERE: src/routes/shifts.ts → DELETE /shifts/overrides/:employeeId/:shiftDate
    // WHY: removing an override should restore the employee's default
    //      schedule for that date — the absence of the row is the signal
    queryResponses.push({ rows: [{ tenant_id: TENANT_ID }], rowCount: 1 });

    const res = await app.inject({
      method: 'DELETE',
      url: `/shifts/overrides/${EMPLOYEE_ID}/${SHIFT_DATE}?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
    expect(queries[0].text).toContain('DELETE FROM employee_schedule');
    expect(queries[0].params).toEqual([TENANT_ID, EMPLOYEE_ID, SHIFT_DATE]);
  });
});

describe('DELETE /shifts/overrides/:employeeId/:shiftDate — sad paths', () => {
  it('SAD: returns 404 when no row was affected', async () => {
    // WHO: a stale UI deleting an already-deleted override
    // WHAT: rowCount=0 → handler returns 404 + error envelope
    // WHY: silent success on no-op delete would let the dashboard mark
    //      the override as removed when the underlying state didn't
    //      actually change (e.g., wrong tenant scope on the request)
    queryResponses.push({ rows: [], rowCount: 0 });

    const res = await app.inject({
      method: 'DELETE',
      url: `/shifts/overrides/${EMPLOYEE_ID}/${SHIFT_DATE}?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false });
  });
});

// ════════════════════════════════════════════════════════════════════
// SECURITY — owner-role gate (2026-09-16 role-check audit)
// ════════════════════════════════════════════════════════════════════

describe('shift-override routes — owner-role gate', () => {
  const mutatingRoutes: Array<[string, string, string]> = [
    ['POST', '/shifts/overrides/create', 'create'],
    ['POST', `/shifts/overrides/${EMPLOYEE_ID}/${SHIFT_DATE}/update`, 'update'],
    ['DELETE', `/shifts/overrides/${EMPLOYEE_ID}/${SHIFT_DATE}`, 'delete'],
  ];

  it.each(mutatingRoutes)(
    'SECURITY: %s %s is rejected 403 for a front-desk user before any query runs',
    async (method, path) => {
      authOverride = {
        tenant_id: TENANT_ID,
        user_id: 'fd-user',
        email: 'frontdesk@test.local',
        role: 'front_desk',
      };

      const res = await app.inject({
        method: method as 'POST' | 'DELETE',
        url: path.includes('?') ? path : `${path}?tenant_id=${TENANT_ID}`,
        payload: {
          tenant_id: TENANT_ID,
          employee_id: EMPLOYEE_ID,
          shift_date: SHIFT_DATE,
          is_off: true,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().success).toBe(false);
      expect(queries).toHaveLength(0);
    }
  );

  it.each(mutatingRoutes)(
    'SECURITY: %s %s is rejected 401 when unauthenticated',
    async (method, path) => {
      authOverride = null;

      const res = await app.inject({
        method: method as 'POST' | 'DELETE',
        url: path.includes('?') ? path : `${path}?tenant_id=${TENANT_ID}`,
        payload: {
          tenant_id: TENANT_ID,
          employee_id: EMPLOYEE_ID,
          shift_date: SHIFT_DATE,
          is_off: true,
        },
      });

      expect(res.statusCode).toBe(401);
      expect(queries).toHaveLength(0);
    }
  );
});
