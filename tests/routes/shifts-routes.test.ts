/**
 * Route-level tests for POST /shifts/expand-weekly — the wizard's
 * "fan weekly availability into bookable date-specific schedule"
 * bridge. The helper itself is exhaustively tested in
 * src/services/expandWeeklyToSchedule.test.ts; this file covers the
 * route-handler concerns: Zod validation, withTenantClient wiring,
 * and the response envelope.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';

import { registerShiftRoutes } from '../../src/routes/shifts';

// Real v4 UUIDs — Zod's .uuid() validator requires the proper version
// (4xxx) and variant (8/9/a/b) nibbles. Pattern-filler UUIDs like
// "aaaa-bbbb-cccc-dddd-eeee" fail validation.
const TENANT_ID = 'f234e471-0e60-4163-86c9-93cfd9338e3a';
const EMPLOYEE_ID = 'a1b2c3d4-e5f6-4789-ab12-cdef34567890';

interface MockQuery {
  text: string;
  params: unknown[];
}

let app: FastifyInstance;
let queries: MockQuery[];
let queryResponses: Array<{ rows: unknown[]; rowCount?: number }>;

type TestAuth = { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
/**
 * `undefined` = use the default owner stub (every route in this file is
 * owner-gated via requireOwnerRole); set explicitly per-test to exercise
 * the gate itself (front_desk → 403, null → 401).
 */
let authOverride: TestAuth | null | undefined;

function buildApp() {
  queries = [];
  queryResponses = [];

  const mockClient = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params: params ?? [] });
      const next = queryResponses.shift();
      // INSERTs default to a rowCount that reflects the number of
      // rows actually being inserted. The expand-weekly path uses a
      // single multi-row INSERT (5 placeholders per row), so derive
      // the count from the params length. Falls back to 1 for
      // INSERTs with no params (e.g. parameter-less DEFAULT inserts).
      if (text.startsWith('INSERT')) {
        if (next) return next;
        const p = params ?? [];
        const rowCount = p.length > 0 ? Math.max(1, Math.floor(p.length / 5)) : 1;
        return { rows: [], rowCount };
      }
      return next ?? { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };

  const mockPool = {
    connect: vi.fn(async () => mockClient),
  } as unknown as Pool;

  const withTenantClient = async <T>(
    _tenantId: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> => fn(mockClient as unknown as PoolClient);

  const fastify = Fastify({ logger: false });

  // Test-only request shape: the preHandler injects tenantId + auth so the
  // route can read them. All routes in this file are owner-gated
  // (requireOwnerRole) — default to an owner so existing tests keep
  // exercising the handler body; the SECURITY block below sets
  // `authOverride` to prove the gate itself.
  type TenantRequest = FastifyRequest & { tenantId?: string; auth?: TestAuth | null };
  fastify.addHook('preHandler', async (request: TenantRequest) => {
    const tenantId =
      (request.query as Record<string, string>)?.tenant_id ||
      (request.headers['x-tenant-id'] as string);
    if (tenantId) request.tenantId = tenantId;
    request.auth =
      authOverride !== undefined
        ? authOverride
        : { tenant_id: tenantId || TENANT_ID, user_id: 'owner-user', email: 'owner@test.local', role: 'owner' };
  });

  registerShiftRoutes(fastify, mockPool, withTenantClient);
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
// HAPPY PATHS
// ════════════════════════════════════════════════════════════════════

describe('POST /shifts/expand-weekly — happy paths', () => {
  it('1. fans the supplied weekly pattern and returns inserted count + range', async () => {
    // WHO: setup wizard finalizing onboarding for an employee whose
    //      weekly availability was just configured in the Hours step.
    // WHAT: route validates the pattern array, delegates to
    //      expandWeeklyToSchedule, returns { success: true, inserted,
    //      rangeStart, rangeEnd } so the dashboard can confirm
    //      "Schedule extends through May 24".
    // WHERE: src/routes/shifts.ts /shifts/expand-weekly.
    // WHEN: SoloWizard handleFinalize and team wizard goNext at the
    //      step-6 → step-7 transition.
    // WHY: the response shape is what the wizard's success path keys
    //      on — adding fields is fine, removing or renaming is not.
    // INSERT responses default to rowCount: 1 in the mock.

    const res = await app.inject({
      method: 'POST',
      url: '/shifts/expand-weekly',
      payload: {
        tenant_id: TENANT_ID,
        employee_id: EMPLOYEE_ID,
        pattern: [
          { day_of_week: 1, start_time: '09:00:00', end_time: '17:00:00' },
          { day_of_week: 3, start_time: '09:00:00', end_time: '17:00:00' },
        ],
        weeks_ahead: 2,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    // 2 weeks × 2 matching weekdays = 4 INSERTs, all rowCount: 1.
    expect(body.inserted).toBe(4);
    expect(body.rangeStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.rangeEnd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('2. accepts weeks_ahead omitted (defaults to 4)', async () => {
    // WHO: caller — including any non-wizard tool — that omits the
    //      optional weeks_ahead field.
    // WHAT: Zod schema marks weeks_ahead optional; helper applies the
    //      4-week default. Response should still be 200 + success: true.
    // WHERE: ExpandWeeklySchema in src/routes/shifts.ts.
    // WHEN: every "use the default window" call from the dashboard.
    // WHY: explicit nullability test prevents accidental tightening
    //      of the schema (e.g., dropping .optional()) which would
    //      silently break wizard finalize.
    const res = await app.inject({
      method: 'POST',
      url: '/shifts/expand-weekly',
      payload: { tenant_id: TENANT_ID, employee_id: EMPLOYEE_ID, pattern: [] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// SAD PATHS — Zod validation
// ════════════════════════════════════════════════════════════════════

describe('POST /shifts/expand-weekly — validation', () => {
  it('3. returns 400 on missing tenant_id', async () => {
    // WHAT: Zod marks tenant_id required and UUID-formatted; missing
    //       request must reject with 400 BEFORE any DB call.
    // WHERE: ExpandWeeklySchema.safeParse in the handler.
    // WHEN: caller forgot to include tenant context (e.g., a buggy
    //       dashboard build that loses session before this call).
    // WHY: no tenant_id means RLS context can't be set; better to
    //      hard-fail with a clear validation error than silently
    //      execute against the wrong tenant.
    const res = await app.inject({
      method: 'POST',
      url: '/shifts/expand-weekly',
      payload: { employee_id: EMPLOYEE_ID, pattern: [] },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Validation failed');
    expect(queries).toHaveLength(0);
  });

  it('4. returns 400 on missing employee_id', async () => {
    // WHAT: Same shape as #3, different field — guards against the
    //       fan-out happening for an entire tenant by accident.
    // WHY: if the schema permitted a missing employee_id, the helper
    //      would have nowhere to attribute the inserted rows.
    //      Zod-level rejection is cleaner than a downstream FK error.
    const res = await app.inject({
      method: 'POST',
      url: '/shifts/expand-weekly',
      payload: { tenant_id: TENANT_ID, pattern: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it('5. returns 400 on non-UUID tenant_id', async () => {
    // WHO: malformed client input — typo, copy-paste error, or
    //      legacy code passing an integer ID.
    // WHAT: Zod's .uuid() rejects anything that isn't a real UUID v4.
    // WHY: a bad tenant_id would attempt to set RLS to garbage and
    //      either crash Postgres or return zero rows in confusing ways.
    const res = await app.inject({
      method: 'POST',
      url: '/shifts/expand-weekly',
      payload: { tenant_id: 'not-a-uuid', employee_id: EMPLOYEE_ID, pattern: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it('6. returns 400 when weeks_ahead is below the minimum (0)', async () => {
    // WHO: caller passing weeks_ahead: 0 (perhaps from a misconfigured
    //      slider that allows zero).
    // WHAT: Zod schema enforces min(1). 0 → 400 with no DB call.
    // WHY: weeks_ahead = 0 would generate 0 dates, which silently
    //      no-ops — owner sees "Setup complete" but no schedule was
    //      created. Hard fail is better than silent no-op.
    const res = await app.inject({
      method: 'POST',
      url: '/shifts/expand-weekly',
      payload: { tenant_id: TENANT_ID, employee_id: EMPLOYEE_ID, pattern: [], weeks_ahead: 0 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it('7. returns 400 when weeks_ahead exceeds 52', async () => {
    // WHO: defensive — guards against a caller passing a year+ which
    //      would balloon DB writes (52 × 7 = 364 INSERTs per call).
    // WHAT: Zod max(52). 53 → 400.
    // WHERE: ExpandWeeklySchema.weeks_ahead.
    // WHEN: any caller passing a value above 52 — reject before
    //      the loop kicks off.
    // WHY: protects the Postgres pool from a single request running
    //      hundreds of INSERTs and holding a connection for seconds.
    //      The cap is conservative — bump if we ever see legitimate
    //      "12-month-ahead" use cases.
    const res = await app.inject({
      method: 'POST',
      url: '/shifts/expand-weekly',
      payload: { tenant_id: TENANT_ID, employee_id: EMPLOYEE_ID, pattern: [], weeks_ahead: 53 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it('8. returns 400 when weeks_ahead is non-integer', async () => {
    // WHAT: Zod .int() rejects floats; 4.5 → 400.
    // WHY: a non-integer weeks_ahead would propagate into the
    //      dayCount = weeksAhead × 7 multiplication and produce
    //      non-integer iteration bounds. Reject up front.
    const res = await app.inject({
      method: 'POST',
      url: '/shifts/expand-weekly',
      payload: { tenant_id: TENANT_ID, employee_id: EMPLOYEE_ID, pattern: [], weeks_ahead: 4.5 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
    expect(queries).toHaveLength(0);
  });
});

describe('POST /shifts/expand-weekly — replace also retires the declared RULE', () => {
  it('replace + an EMPTY pattern clears employee_schedule_pattern', async () => {
    // WHO: an owner who cleared every day out of the weekly grid and saved.
    // WHAT: `replace` deletes the future employee_schedule rows AND the
    //       declared weekly rule.
    // WHEN: any wizard save whose grid ends up empty.
    // WHERE: src/routes/shifts.ts POST /shifts/expand-weekly, replace branch.
    // WHY: expandWeeklyToSchedule early-returns on an empty pattern and
    //      deliberately does NOT touch the rule — an empty pattern on its own
    //      is ambiguous. `replace` removes the ambiguity: the caller is stating
    //      this pattern is the complete truth. Without this delete the rows go,
    //      the rule stays, and the schedule extender puts the hours straight
    //      back from a rule nobody can see — resurrecting exactly what the
    //      owner just dropped, through the table added to prevent that.
    const app2 = buildApp();
    const res = await app2.inject({
      method: 'POST',
      url: '/shifts/expand-weekly',
      payload: {
        tenant_id: TENANT_ID,
        employee_id: EMPLOYEE_ID,
        pattern: [],
        replace: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const ruleDeletes = queries.filter((q) =>
      q.text.includes('DELETE FROM employee_schedule_pattern')
    );
    expect(ruleDeletes).toHaveLength(1);
    expect(ruleDeletes[0].params).toEqual([TENANT_ID, EMPLOYEE_ID]);
  });

  it('WITHOUT replace, an empty pattern leaves the rule alone', async () => {
    // WHY: the additive default merges into whatever is already there, so an
    //      empty pattern carries no statement about the rule. Wiping a working
    //      rule on that reading is how a bookable business goes dark.
    const app2 = buildApp();
    const res = await app2.inject({
      method: 'POST',
      url: '/shifts/expand-weekly',
      payload: {
        tenant_id: TENANT_ID,
        employee_id: EMPLOYEE_ID,
        pattern: [],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(queries.filter((q) => q.text.includes('employee_schedule_pattern'))).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// SECURITY — owner-role gate (2026-09-16 role-check audit)
// ════════════════════════════════════════════════════════════════════

describe('POST /shifts/expand-weekly — owner-role gate', () => {
  it('SECURITY: a front-desk user is rejected 403 before any query runs', async () => {
    authOverride = {
      tenant_id: TENANT_ID,
      user_id: 'fd-user',
      email: 'frontdesk@test.local',
      role: 'front_desk',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/shifts/expand-weekly',
      payload: {
        tenant_id: TENANT_ID,
        employee_id: EMPLOYEE_ID,
        pattern: [{ day_of_week: 1, start_time: '09:00:00', end_time: '17:00:00' }],
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it('SECURITY: an unauthenticated request is rejected 401', async () => {
    authOverride = null;

    const res = await app.inject({
      method: 'POST',
      url: '/shifts/expand-weekly',
      payload: {
        tenant_id: TENANT_ID,
        employee_id: EMPLOYEE_ID,
        pattern: [{ day_of_week: 1, start_time: '09:00:00', end_time: '17:00:00' }],
      },
    });

    expect(res.statusCode).toBe(401);
    expect(queries).toHaveLength(0);
  });
});
