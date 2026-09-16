/**
 * Route-handler tests for src/routes/appointments.ts.
 *
 * Why this file exists:
 *   Pre-coverage baseline: 5.83% lines on the booking core. The underlying
 *   `book_appointment_atomic` RPC is exhaustively tested in
 *   `scheduling-atomic.test.ts` and `skill-resource-matching-sweep.test.ts`,
 *   but the Fastify route handler glue (Zod parsing, super-admin tenant
 *   widening, transactional update branch, cross-tenant 403 gate, fire-and-
 *   forget syncAppointmentToAll dispatch) had no direct coverage. A regression
 *   in the handler — say, dropping the cross-tenant check or swapping the
 *   wrong RPC — would slip past current tests.
 *
 * Phase 2.1 of the route-handler coverage push (docs/TODO.md). Built on the
 * `buildRouteTestApp()` helper proven in `src/routes/mappings.test.ts`.
 *
 * Coverage targets (each route, happy + at least one sad):
 *   - POST /appointments/create — Zod fail / RPC success / RPC failure / RPC empty
 *   - GET  /appointments        — tenant-scoped / super-admin / date-range / no-tenant
 *   - DELETE /appointments/:id  — happy / 404
 *   - POST /appointments/:id/cancel — happy / 404
 *   - POST /appointments/:id/update — happy minimal / happy with customer info /
 *     Zod fail / cross-tenant 403
 *
 * What this file does NOT cover:
 *   - DB-layer atomicity / RLS (covered by scheduling-atomic.test.ts /
 *     booking-concurrency.test.ts / rls.test.ts against real Postgres).
 *   - Full sync-fan-out behavior (covered by services/syncOrchestrator
 *     tests; here we only assert that it's invoked with the right args).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Mock the sync orchestrator so the fire-and-forget calls inside route
// handlers don't try to talk to real CRMs/calendars during tests. We assert
// against the mock to confirm wiring without exercising the orchestrator.
vi.mock('../../src/services/syncOrchestrator', () => ({
  syncAppointmentToAll: vi.fn(),
}));
vi.mock('../../src/services/reminders/scheduleForAppointment', () => ({
  scheduleRemindersForAppointment: vi.fn(),
  rescheduleRemindersForAppointment: vi.fn(),
}));
vi.mock('../../src/services/telnyxSms', () => ({
  sendSms: vi.fn().mockResolvedValue({ ok: true }),
}));

import { registerAppointmentRoutes } from '../../src/routes/appointments';
import { syncAppointmentToAll } from '../../src/services/syncOrchestrator';
import {
  scheduleRemindersForAppointment,
  rescheduleRemindersForAppointment,
} from '../../src/services/reminders/scheduleForAppointment';
import { sendSms } from '../../src/services/telnyxSms';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';
import { SUPER_ADMIN_TENANT_ID } from '../../src/constants';

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_TENANT_ID = 'eeeeeeee-ffff-4aaa-8bbb-cccccccccccc';
const APPOINTMENT_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const CUSTOMER_ID = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
const RESOURCE_ID = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
const EMPLOYEE_ID = 'ffffffff-1111-4222-8333-444444444444';

let handle: RouteTestAppHandle;
let app: FastifyInstance;

beforeAll(async () => {
  handle = buildRouteTestApp((app, pool, withTenantClient) => {
    registerAppointmentRoutes(app, pool, withTenantClient);
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
  vi.clearAllMocks();
});

const validCreatePayload = {
  tenant_id: TENANT_ID,
  resource_id: RESOURCE_ID,
  customer_id: CUSTOMER_ID,
  start_time: '2026-04-15T14:00:00Z',
  end_time: '2026-04-15T15:00:00Z',
  description: 'Brake replacement',
  location: 'Bay 1',
};

// ────────────────────────────────────────────────────────────────────
// POST /appointments/create
// ────────────────────────────────────────────────────────────────────

describe('POST /appointments/create', () => {
  it('HAPPY: calls book_appointment_atomic, returns appointment_id, fires sync', async () => {
    // WHO: tenant owner creating an appointment from the dashboard
    // WHAT: route delegates to book_appointment_atomic RPC; on success
    //       returns appointment_id and dispatches sync to all CRMs/calendars
    // WHEN: POST /appointments/create with valid Zod-shaped body
    // WHERE: src/routes/appointments.ts → app.post('/appointments/create', ...)
    // WHY: this is the manual-entry path (call_id='manual-entry'); the agent
    //       uses book_with_scheduling_atomic instead. Both must remain
    //       distinct so manual entries don't accidentally trigger the agent's
    //       skill-matching scan.
    handle.queryResponses.push({
      rows: [{ success: true, appointment_id: APPOINTMENT_ID, error_message: null }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/appointments/create',
      payload: validCreatePayload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, appointment_id: APPOINTMENT_ID });

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries[0].text).toContain('book_appointment_atomic');
    expect(dataQueries[0].params[0]).toBe(TENANT_ID);
    expect(dataQueries[0].params[6]).toBe('manual-entry');
    expect(syncAppointmentToAll).toHaveBeenCalledWith(
      handle.mockPool,
      TENANT_ID,
      APPOINTMENT_ID,
      'create',
      expect.anything()
    );
    // WHO: dashboard user creating a future appointment with a customer
    //      who has a phone on file
    // WHAT: route fires the reminder-scheduling helper after sync, with
    //       the same tenant scope and the new appointment_id
    // WHEN: immediately after the booking RPC succeeds, before responding
    // WHERE: src/routes/appointments.ts POST /appointments/create
    // WHY: a regression that drops this call would leave reminders
    //      unscheduled — the worker would have nothing to deliver
    expect(scheduleRemindersForAppointment).toHaveBeenCalledWith(
      expect.any(Function),
      TENANT_ID,
      APPOINTMENT_ID,
      expect.anything()
    );
  });

  it('SAD: rejects absurd 23-hour appointments before hitting the RPC', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/appointments/create',
      payload: {
        ...validCreatePayload,
        end_time: '2026-04-16T13:00:00Z',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      success: false,
      error: 'Appointment duration cannot exceed 12 hours',
      error_code: 'INVALID_DURATION',
    });
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
  });

  it('SAD: rejects off-grid start time with INVALID_INCREMENT before any DB call', async () => {
    // WHO: dashboard user (or curl bypassing the form's snap-to-grid picker)
    // WHAT: validateAppointmentTimeRange catches a :07 start time and the
    //        route returns 400 + INVALID_INCREMENT before the booking RPC runs
    // WHEN: Slice 1.5 of booking enforcement hardening, 2026-05-09
    // WHERE: src/routes/appointments.ts POST /appointments/create
    // WHY: third-layer enforcement — DB CHECK constraint applied 2026-05-08
    //       is the floor; this Zod-equivalent gate gives a clean error_code
    //       BEFORE consuming a DB connection. Without it, off-grid times
    //       would 500 with a generic "constraint violation" Postgres error.
    const res = await app.inject({
      method: 'POST',
      url: '/appointments/create',
      payload: {
        ...validCreatePayload,
        start_time: '2026-04-15T10:07:00Z',
        end_time: '2026-04-15T11:00:00Z',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      success: false,
      error: 'Start time must land on a 15-minute increment (:00, :15, :30, :45)',
      error_code: 'INVALID_INCREMENT',
    });
    // Critical: no DB activity. Validation gate must fire BEFORE the
    // BEGIN/SET LOCAL/RPC sequence — otherwise the constraint catches
    // it server-side but burns a transaction round-trip.
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
  });

  it('SAD: rejects off-grid end time (start was on-grid)', async () => {
    // WHY: pin both halves of the predicate independently — a future
    //       change that drops the end-time check while keeping start
    //       would silently let half-bad rows through Zod and rely
    //       solely on the DB CHECK to reject.
    const res = await app.inject({
      method: 'POST',
      url: '/appointments/create',
      payload: {
        ...validCreatePayload,
        start_time: '2026-04-15T10:00:00Z',
        end_time: '2026-04-15T10:23:00Z',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      success: false,
      error: 'End time must land on a 15-minute increment (:00, :15, :30, :45)',
      error_code: 'INVALID_INCREMENT',
    });
  });

  it('SAD: returns 400 on Zod validation failure (missing required field)', async () => {
    // WHO: a buggy client that omitted required body fields
    // WHAT: AppointmentCreateSchema.safeParse fails → 400 with details
    // WHEN: any POST with malformed body
    // WHERE: AppointmentCreateSchema check at top of handler
    // WHY: schema validation must fire BEFORE the booking RPC — a malformed
    //       request reaching the RPC could fail with an opaque Postgres
    //       type-cast error (500); the Zod gate gives a clean 400 with
    //       per-field details the dashboard can render
    const res = await app.inject({
      method: 'POST',
      url: '/appointments/create',
      payload: { tenant_id: 'not-uuid' }, // missing everything else too
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Validation failed');
    expect(Array.isArray(body.details)).toBe(true);

    // No DB query should have fired — Zod gate ran first
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
  });

  it('SAD: non-overlap RPC failures pass through with 400 + plain error (no conflict lookup)', async () => {
    // WHO: dashboard user trying to book a slot that fails an RPC constraint
    //       OTHER THAN overlap — e.g. past time, no skilled employee, off-shift
    // WHAT: route forwards the RPC's `error_message` verbatim with status 400
    //        and skips the conflict-lookup query (nothing to point at)
    // WHEN: book_appointment_atomic returns `{ success: false, error_message }`
    //        with a non-"already booked" message
    // WHERE: appointments.ts isOverlapError(...) gate
    // WHY: the RPC's diagnostic messages for non-overlap failures are useful
    //       on their own ("Employee is not on shift during this time"); a
    //       conflict block would be misleading because there's no conflicting
    //       appointment to display. Also: skipping the lookup saves a DB
    //       round-trip on every non-overlap rejection.
    handle.queryResponses.push({
      rows: [
        {
          success: false,
          appointment_id: null,
          error_message: 'Employee is not on shift during this time',
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/appointments/create',
      payload: validCreatePayload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      success: false,
      error: 'Employee is not on shift during this time',
      error_code: 'EMPLOYEE_NOT_SCHEDULED',
    });
    // Critical: only 1 RPC query, no follow-up conflict lookup.
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(1);
    expect(dataQueries[0].text).toContain('book_appointment_atomic');
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
    expect(scheduleRemindersForAppointment).not.toHaveBeenCalled();
  });

  it('SAD: overlap rejection returns 409 + conflict block with existing appointment details', async () => {
    // WHO: front-desk operator trying to double-book a resource/employee
    // WHAT: RPC returns "Resource already booked"; route runs the follow-up
    //        SELECT to find the conflicting row and surfaces its details
    //        (id, customer name, employee name, resource name, time range)
    //        so the operator can decide what to do. Status flips to 409.
    // WHEN: any /appointments/create where the GiST exclusion constraint or
    //        the RPC's pre-check rejects on time-overlap
    // WHERE: appointments.ts isOverlapError + findOverlappingAppointment
    // WHY: a string error alone ("Resource already booked") gives the
    //       operator no actionable info. Showing "Bay 1 is taken by Alice
    //       with Mike from 2:00-2:30 (Tire rotation)" lets them pick another
    //       time, ask Alice to reschedule, or look up Alice's record.
    handle.queryResponses.push(
      {
        rows: [
          {
            success: false,
            appointment_id: null,
            error_message: 'Resource already booked during this timeslot',
          },
        ],
      },
      {
        rows: [
          {
            appointment_id: 'existing-id',
            start_time: '2026-05-10T14:00:00.000Z',
            end_time: '2026-05-10T14:30:00.000Z',
            customer_name: 'Alice',
            employee_name: 'Mike',
            resource_name: 'Bay 1',
            description: 'Tire rotation',
          },
        ],
      },
      // tenants tz lookup (findNextAvailableSlots)
      { rows: [{ timezone: 'America/Chicago' }] },
      // findNextAvailableSlots SQL — returns empty in mock land,
      // which is fine; test asserts presence of next_available key,
      // not specific slot data. Real-DB integration is covered by
      // src/availability-search.test.ts.
      { rows: [] }
    );

    const res = await app.inject({
      method: 'POST',
      url: '/appointments/create',
      payload: validCreatePayload,
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body).toMatchObject({
      success: false,
      error: 'Resource already booked during this timeslot',
      error_code: 'TIMESLOT_OCCUPIED',
      conflict: {
        appointment_id: 'existing-id',
        start_time: '2026-05-10T14:00:00.000Z',
        end_time: '2026-05-10T14:30:00.000Z',
        customer_name: 'Alice',
        employee_name: 'Mike',
        resource_name: 'Bay 1',
        description: 'Tire rotation',
      },
    });
    // The new next-available alternatives field is always present in
    // conflict responses — even when empty — so the dashboard can
    // unconditionally render the "Try another time" section.
    expect(body.next_available).toEqual([]);
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
    // Four data queries: RPC, conflict lookup, tenant-tz lookup, and
    // the next-available SQL.
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries.length).toBeGreaterThanOrEqual(2);
    expect(dataQueries[0].text).toContain('book_appointment_atomic');
    expect(dataQueries[1].text).toMatch(/SELECT[\s\S]*FROM appointments/i);
  });

  it('SAD: overlap rejection with service_id derives next_available from service requirements', async () => {
    // WHO: dashboard operator booking against a specific service that has
    //       its own duration + skills + capabilities (e.g. "Brake Job —
    //       60 min, requires brake-cert + lift-bay") and the slot collides
    // WHAT: when body.service_id is provided, the conflict path SELECTs
    //       services to get duration_minutes / required_skills /
    //       required_resources, then uses those (not the booking's own
    //       end-start delta + empty arrays) to find next-available slots
    // WHEN: POST /appointments/create with service_id where the slot is taken
    // WHERE: src/routes/appointments.ts L137-153 — the `if (body.service_id)`
    //        branch inside the overlap-conflict path
    // WHY: pre-fix this branch was uncovered (branch coverage 73.94%). The
    //        operator booking with a service got alternatives derived from
    //        a fallback duration (rounded from start-end delta) and empty
    //        skill/cap requirements — meaning "Try one of these times
    //        instead" might propose techs/bays unqualified for the actual
    //        service. Pin the SELECT services + the propagation of its
    //        fields into findNextAvailableSlots.
    const SERVICE_ID = 'aaaa1111-bbbb-4ccc-8ddd-eeee22223333';
    handle.queryResponses.push(
      // book_appointment_atomic — overlap reject
      {
        rows: [
          {
            success: false,
            appointment_id: null,
            error_message: 'Resource already booked during this timeslot',
          },
        ],
      },
      // findOverlappingAppointment lookup
      {
        rows: [
          {
            appointment_id: 'existing-id',
            start_time: '2026-05-10T14:00:00.000Z',
            end_time: '2026-05-10T14:30:00.000Z',
            customer_name: 'Alice',
            employee_name: 'Mike',
            resource_name: 'Bay 1',
            description: 'Tire rotation',
          },
        ],
      },
      // SELECT services — branch under test. Returns a 60-min "brake"
      // service with one skill + one cap so the propagation is visible.
      {
        rows: [
          {
            duration_minutes: 60,
            required_skills: ['brake-cert'],
            required_resources: ['lift-bay'],
          },
        ],
      },
      // findNextAvailableSlots — tenant tz lookup
      { rows: [{ timezone: 'America/Chicago' }] },
      // findNextAvailableSlots — main slot search (returns empty in mock)
      { rows: [] }
    );

    const res = await app.inject({
      method: 'POST',
      url: '/appointments/create',
      payload: { ...validCreatePayload, service_id: SERVICE_ID },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe('TIMESLOT_OCCUPIED');

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    // Pin the order: RPC → conflict lookup → service SELECT → tenants tz → slots search.
    expect(dataQueries[0].text).toContain('book_appointment_atomic');
    expect(dataQueries[1].text).toMatch(/SELECT[\s\S]*FROM appointments/i);
    expect(dataQueries[2].text).toContain('FROM services');
    expect(dataQueries[2].params).toEqual([SERVICE_ID, TENANT_ID]);
    // Pin the slot-search params include the service-derived skills + caps.
    // findNextAvailableSlots is called with requiredSkills + requiredCapabilities;
    // those land in the slot-search SQL's params. The exact param positions
    // depend on availabilitySearch's binding order; assert by content rather
    // than position so a refactor of the SQL doesn't break this test.
    const slotsQuery = dataQueries[dataQueries.length - 1];
    expect(slotsQuery.params).toEqual(expect.arrayContaining([['brake-cert']]));
    expect(slotsQuery.params).toEqual(expect.arrayContaining([['lift-bay']]));
  });

  it('SAD: overlap rejection but conflict lookup empty returns 400 + plain error (defensive)', async () => {
    // WHO: extreme-edge race — RPC said "already booked" but by the time
    //        the follow-up SELECT runs, the conflicting row was canceled
    //        or soft-deleted (millisecond window between snapshot reads)
    // WHAT: route falls back to the plain 400 + error_message shape — no
    //        bogus conflict block claiming details we don't actually have
    // WHY: the dashboard's conflict modal would show empty fields if the
    //       backend returned a partial conflict object; null lets the UI
    //       branch on "no conflict to display" and just toast the message
    handle.queryResponses.push(
      {
        rows: [{ success: false, appointment_id: null, error_message: 'Employee already booked' }],
      },
      { rows: [] } // conflict lookup finds nothing
    );

    const res = await app.inject({
      method: 'POST',
      url: '/appointments/create',
      payload: validCreatePayload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      success: false,
      error: 'Employee already booked',
    });
    expect(res.json().conflict).toBeUndefined();
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
  });

  it('SAD: returns 500 when RPC returns no rows (DB-layer anomaly)', async () => {
    // WHO: a request hitting an unexpected DB state (RPC dropped/recreated
    //       mid-query, transaction snapshot anomaly)
    // WHAT: handler defends against `res.rows[0]` being undefined → 500
    // WHEN: book_appointment_atomic returns an empty result set
    // WHERE: `if (!result)` branch
    // WHY: without this guard, accessing `result.success` would throw a
    //       TypeError surfacing as 500 with a stack trace. The explicit
    //       guard returns a clean message the operator can search logs for.
    handle.queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'POST',
      url: '/appointments/create',
      payload: validCreatePayload,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      success: false,
      error: 'Booking RPC returned no result',
    });
  });

  it('HAPPY: passes employee_id stringified when provided', async () => {
    // WHO: dashboard creating an appointment with an explicit employee assignment
    // WHAT: route stringifies employee_id (which may arrive as number or
    //       string) before passing to the RPC's TEXT param
    // WHEN: POST with employee_id present
    // WHERE: `body.employee_id ? body.employee_id.toString() : null`
    // WHY: book_appointment_atomic's p_assignment_id is TEXT (because it
    //       handles both employee UUIDs and user UUIDs); the route must
    //       coerce to string regardless of input type
    handle.queryResponses.push({
      rows: [{ success: true, appointment_id: APPOINTMENT_ID, error_message: null }],
    });

    await app.inject({
      method: 'POST',
      url: '/appointments/create',
      payload: { ...validCreatePayload, employee_id: EMPLOYEE_ID },
    });

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    // employee_id is the 9th param (index 8)
    expect(dataQueries[0].params[8]).toBe(EMPLOYEE_ID);
  });
});

// ────────────────────────────────────────────────────────────────────
// GET /appointments
// ────────────────────────────────────────────────────────────────────

describe('GET /appointments', () => {
  it('HAPPY: tenant user gets appointments scoped to their tenant', async () => {
    // WHO: tenant owner viewing the appointment list
    // WHAT: SELECT joins customer + resource info, scoped by tenant_id
    // WHEN: GET /appointments without query params
    // WHERE: appointments.ts non-super-admin path (line ~127)
    // WHY: the WHERE includes a.tenant_id = $1 filter for non-admin callers;
    //       missing this filter would expose other tenants' appointments
    handle.queryResponses.push({
      rows: [{ appointment_id: APPOINTMENT_ID, customer_id: CUSTOMER_ID }],
    });

    const res = await app.inject({ method: 'GET', url: '/appointments' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].appointment_id).toBe(APPOINTMENT_ID);

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries[0].text).toContain('FROM appointments');
    expect(dataQueries[0].text).toContain('a.tenant_id = $1');
    expect(dataQueries[0].params[0]).toBe(TENANT_ID);
  });

  it('HAPPY: super-admin with explicit all_tenants=true opt-in gets cross-tenant appointments', async () => {
    // WHO: platform super-admin viewing all appointments across tenants
    //      (the "all businesses" scheduler flow)
    // WHAT: route widens the query — drops the a.tenant_id = $N filter —
    //       but ONLY when the caller explicitly opts in with ?all_tenants=true
    // WHEN: caller's tenant_id matches SUPER_ADMIN_TENANT_ID AND the opt-in
    //       query param is present
    // WHERE: `if (isSuperAdmin)` gate in appointments.ts
    // WHY: the super-admin dashboard needs cross-tenant visibility for its
    //      one legitimate use (matching a customer to their tenant when
    //      creating an appointment with no tenant selected), but that must
    //      be a deliberate request, not the default for ANY request that
    //      happens to be running with no managed tenant selected — audit
    //      finding 2026-09-16
    handle.auth.current = {
      user_id: '00000000-0000-0000-0000-000000000001',
      tenant_id: SUPER_ADMIN_TENANT_ID,
      email: 'admin@platform',
      role: 'owner',
    };
    handle.queryResponses.push({ rows: [{ appointment_id: APPOINTMENT_ID }] });

    const res = await app.inject({
      method: 'GET',
      url: '/appointments?all_tenants=true',
    });

    expect(res.statusCode).toBe(200);
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    // No tenant filter — query starts WHERE a.is_deleted = false then jumps to LIMIT
    expect(dataQueries[0].text).not.toContain('a.tenant_id = $');
    // Super-admin path goes through withPoolClient (pool.connect), not withTenantClient
    // The mock pool delegates pool.query to mockClient.query so we still capture it.
  });

  it('SAD: super-admin WITHOUT the all_tenants opt-in gets an empty list, not a cross-tenant dump', async () => {
    // WHO: any request running as the super-admin sentinel tenant that did
    //      NOT explicitly ask for cross-tenant data — e.g. a stale/legacy
    //      caller, or a side-effect fetch that never intended to widen scope
    // WHAT: without ?all_tenants=true, the route must not query at all and
    //       must not leak any tenant's appointments (PII included via the
    //       joined customer object)
    // WHY: audit finding 2026-09-16 — this used to be the DEFAULT behavior
    //      for any super-admin request with no managed tenant selected
    handle.auth.current = {
      user_id: '00000000-0000-0000-0000-000000000001',
      tenant_id: SUPER_ADMIN_TENANT_ID,
      email: 'admin@platform',
      role: 'owner',
    };

    const res = await app.inject({ method: 'GET', url: '/appointments' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
  });

  it('HAPPY: applies start_date and end_date filters when provided', async () => {
    // WHO: dashboard scheduler view filtering by visible date range
    // WHAT: query string adds two extra parameters bound into the WHERE clause
    // WHEN: GET /appointments?start_date=...&end_date=...
    // WHERE: dynamic `conditions` + `params` array build
    // WHY: scheduler view loads only the visible week; without these filters
    //       the API would return every historical appointment and the UI
    //       would have to filter client-side (slow + unbounded payload)
    handle.queryResponses.push({ rows: [] });

    await app.inject({
      method: 'GET',
      url: '/appointments?start_date=2026-04-15&end_date=2026-04-22',
    });

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries[0].text).toContain('a.start_time >=');
    expect(dataQueries[0].text).toContain('a.start_time <');
    expect(dataQueries[0].params).toContain('2026-04-15');
    expect(dataQueries[0].params).toContain('2026-04-22');
  });

  it('SAD: returns 400 when no tenant context is on the request', async () => {
    // WHO: a request that bypassed auth + tenantMiddleware
    // WHAT: requireTenantId() short-circuits with 400
    // WHEN: missing auth + missing tenantId override
    // WHERE: `if (!tenantId) return;`
    // WHY: every appointment query depends on tenant context (or super-admin
    //       widening); a missing context is a malformed request
    handle.auth.current = null;
    handle.tenantIdOverride.current = null;

    const res = await app.inject({ method: 'GET', url: '/appointments' });

    // 2026-05-21: no auth context → 401 (authentication is the real failure),
    // not the old misleading 400. Load-bearing assertion unchanged: the gate
    // fires BEFORE any DB query runs.
    expect(res.statusCode).toBe(401);
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// DELETE /appointments/:id
// ────────────────────────────────────────────────────────────────────

describe('DELETE /appointments/:id', () => {
  it('HAPPY: hard-deletes the row, fires sync, returns success', async () => {
    // WHO: tenant owner deleting an appointment
    // WHAT: DELETE FROM appointments WHERE appointment_id AND tenant_id, also fires
    //       sync('delete') BEFORE the DELETE so external systems see the
    //       cancellation
    // WHEN: DELETE /appointments/:id
    // WHERE: appointments.ts delete handler
    // WHY: sync-before-delete is intentional — if sync fires after the
    //       row is gone, the orchestrator can't read the row to know
    //       which external IDs to cancel
    handle.queryResponses.push({ rows: [{ appointment_id: APPOINTMENT_ID }] });

    const res = await app.inject({
      method: 'DELETE',
      url: `/appointments/${APPOINTMENT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries[0].text).toContain('DELETE FROM appointments');
    expect(dataQueries[0].text).toContain('AND tenant_id = $2');
    expect(dataQueries[0].params).toEqual([APPOINTMENT_ID, TENANT_ID]);
    expect(syncAppointmentToAll).toHaveBeenCalledWith(
      handle.mockPool,
      TENANT_ID,
      APPOINTMENT_ID,
      'delete',
      expect.anything()
    );
  });

  it('SAD: returns 404 when the row does not exist or is in a different tenant', async () => {
    // WHO: a stale dashboard view, or a cross-tenant delete attempt that
    //       was scoped correctly by the WHERE clause
    // WHAT: assertRowAffected sees rowCount=0 → 404
    // WHEN: DELETE for a non-existent id (or one in another tenant)
    // WHERE: assertRowAffected guard
    // WHY: BUG fixed in a prior sweep — without the row-count check, the
    //       handler returned `{ success: true }` even when nothing was
    //       deleted, masking cross-tenant access attempts
    handle.queryResponses.push({ rows: [], rowCount: 0 });

    const res = await app.inject({
      method: 'DELETE',
      url: `/appointments/${APPOINTMENT_ID}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false });
  });

  it('SAD: returns 400 when no tenant context is on the request (auth short-circuit)', async () => {
    // WHO: malformed call where the JWT preHandler somehow didn't stamp
    //       request.tenantId AND there's no body.tenant_id (e.g. middleware
    //       order regression, or a future internal caller that bypasses it)
    // WHAT: requireTenantId() short-circuits with 400 + "tenant_id is
    //       required" before any DB activity or sync dispatch
    // WHEN: DELETE /appointments/:id without auth + without tenant override
    // WHERE: src/routes/appointments.ts L259 — `if (!tenantId) return`
    // WHY: pre-fix this branch was uncovered (the route's safety net for
    //       a missing tenant context). Without it, the route would fall
    //       through to syncAppointmentToAll(undefined, ...) and a DELETE
    //       with no tenant filter — potentially destructive. Pin that the
    //       gate fires AND nothing else runs.
    handle.auth.current = null;
    handle.tenantIdOverride.current = null;

    const res = await app.inject({
      method: 'DELETE',
      url: `/appointments/${APPOINTMENT_ID}`,
    });

    // 2026-05-21: unauthenticated → 401 before any DB activity or sync.
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'Authentication required' });
    // Critical: zero DB activity AND no sync dispatch. requireTenantId
    // must short-circuit BEFORE the route reaches the DELETE or the
    // fire-and-forget syncAppointmentToAll call.
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// POST /appointments/:id/cancel
// ────────────────────────────────────────────────────────────────────

describe('POST /appointments/:id/cancel', () => {
  it('HAPPY: sets status=canceled, fires delete-sync, returns success', async () => {
    // WHO: tenant cancelling an appointment without removing the audit row
    // WHAT: UPDATE appointments SET status = 'canceled' (soft cancel)
    //       then sync('delete') because canceled appointments shouldn't
    //       block the slot in external calendars/CRMs
    // WHEN: POST /appointments/:id/cancel
    // WHERE: cancel handler
    // WHY: distinct from DELETE because it preserves the row (audit /
    //       customer history); but external systems should treat it
    //       like a delete since the slot is now free
    handle.queryResponses.push({ rows: [{ appointment_id: APPOINTMENT_ID }] });

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/cancel`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries[0].text).toContain("status = 'canceled'");
    expect(dataQueries[0].text).toContain('AND tenant_id = $2');
    expect(syncAppointmentToAll).toHaveBeenCalledWith(
      handle.mockPool,
      TENANT_ID,
      APPOINTMENT_ID,
      'delete', // not 'update' or 'cancel' — external systems see it as removal
      expect.anything()
    );
  });

  it('SAD: returns 404 when no row matches', async () => {
    // WHO: cancel attempt on a missing/cross-tenant id
    // WHAT: rows.length === 0 → 404 explicit response (not assertRowAffected)
    // WHEN: UPDATE matches no rows
    // WHERE: `if (res.rows.length === 0)` branch
    // WHY: the cancel handler uses RETURNING id rather than rowCount; if
    //       the WHERE clause matched nothing the rows array is empty
    handle.queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/cancel`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ success: false, error: 'Appointment not found' });
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
  });

  it('SAD: returns 400 when no tenant context is on the request (auth short-circuit)', async () => {
    // WHO: same shape as the DELETE auth-short-circuit test — symmetric
    //       coverage so the gate behavior is pinned on every destructive
    //       single-row endpoint
    // WHAT: requireTenantId() returns null + sends 400 before the cancel
    //       UPDATE runs. No fire-and-forget sync dispatch fires either.
    // WHEN: POST /appointments/:id/cancel without auth context
    // WHERE: src/routes/appointments.ts L277 — `if (!tenantId) return`
    // WHY: pre-fix this branch was uncovered. Without it, a missing tenant
    //       context would let the cancel UPDATE run with `tenant_id = $2`
    //       bound to undefined → potential cross-tenant write.
    handle.auth.current = null;
    handle.tenantIdOverride.current = null;

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/cancel`,
    });

    // 2026-05-21: unauthenticated → 401 before the cancel UPDATE or sync.
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'Authentication required' });
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// POST /appointments/:id/reactivate
// ────────────────────────────────────────────────────────────────────

describe('POST /appointments/:id/reactivate', () => {
  it('HAPPY: flips canceled→scheduled, fires create-sync, returns success', async () => {
    // WHO: tenant restoring a canceled appointment from customer history
    // WHAT: SELECT current row → UPDATE status='scheduled' → sync('create')
    // WHEN: POST /appointments/:id/reactivate on a canceled row whose slot
    //       is still free (no exclusion_violation on the UPDATE)
    // WHERE: reactivate handler (src/routes/appointments.ts)
    // WHY: pairs with /cancel — cancel set status='canceled' (excluded
    //       from GiST set, slot freed) and fired sync('delete') to remove
    //       from external calendars/CRMs; reactivate flips back and fires
    //       sync('create') to re-add. Without sync('create') the dashboard
    //       would show the appointment as scheduled but Google Calendar /
    //       Jobber / etc. would still consider it deleted, drifting the
    //       state of truth between us and the integrations.
    handle.queryResponses.push({
      rows: [
        {
          status: 'canceled',
          resource_id: RESOURCE_ID,
          employee_id: EMPLOYEE_ID,
          start_time: '2026-04-15T14:00:00Z',
          end_time: '2026-04-15T15:00:00Z',
        },
      ],
    }); // SELECT
    handle.queryResponses.push({ rows: [] }); // UPDATE

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/reactivate`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries[0].text).toContain('SELECT status');
    expect(dataQueries[1].text).toContain("UPDATE appointments SET status = 'scheduled'");
    expect(dataQueries[1].text).toContain('AND tenant_id = $2');
    expect(syncAppointmentToAll).toHaveBeenCalledWith(
      handle.mockPool,
      TENANT_ID,
      APPOINTMENT_ID,
      'create', // re-add to externals (mirrors cancel's 'delete' inversely)
      expect.anything()
    );
  });

  it('SAD: returns 404 when no row matches the id+tenant+not-deleted predicate', async () => {
    // WHO: reactivate attempt on a missing/cross-tenant/soft-deleted id
    // WHAT: SELECT returns zero rows → 404, no UPDATE issued, no sync fired
    // WHEN: appointment doesn't exist OR is_deleted=true OR belongs to
    //       another tenant (RLS would have already filtered the latter,
    //       but the explicit AND tenant_id = $2 + soft-delete clause is
    //       defense in depth)
    // WHERE: outcome === 'not_found' branch
    // WHY: 404 is the right shape for "doesn't exist" — distinct from the
    //       400 "exists but isn't canceled" case below. UI can route on
    //       status code to decide whether to refresh customer history
    //       (404 → row was hard-deleted) vs surface a status-conflict
    //       toast (400 → row is already scheduled, refresh shows truth).
    handle.queryResponses.push({ rows: [] }); // SELECT empty

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/reactivate`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ success: false, error: 'Appointment not found' });
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    // Only the SELECT ran — no UPDATE attempted on a missing row
    expect(dataQueries).toHaveLength(1);
  });

  it('SAD: returns 400 NOT_CANCELED when the row is already scheduled', async () => {
    // WHO: stale-UI reactivate attempt — operator clicks "Reactivate" on
    //       a row another session already restored (or never canceled)
    // WHAT: SELECT returns status='scheduled' → 400 NOT_CANCELED, no
    //       UPDATE, no sync. Symmetric with /cancel's no-op semantics:
    //       reactivate is a state-machine transition canceled→scheduled,
    //       not idempotent flip-to-scheduled.
    // WHEN: operator clicks reactivate on a row that's already scheduled
    // WHERE: outcome === 'not_canceled' branch
    // WHY: without this guard, reactivating an already-scheduled row
    //       would silently fire sync('create') a second time — duplicate
    //       calendar events on Google / Outlook / Jobber. The error_code
    //       lets the dashboard distinguish from a 409 "slot taken" so it
    //       can refresh + show "this appointment is already active"
    //       rather than the conflict modal.
    handle.queryResponses.push({
      rows: [
        {
          status: 'scheduled',
          resource_id: RESOURCE_ID,
          employee_id: EMPLOYEE_ID,
          start_time: '2026-04-15T14:00:00Z',
          end_time: '2026-04-15T15:00:00Z',
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/reactivate`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      success: false,
      error: 'Only canceled appointments can be reactivated',
      error_code: 'NOT_CANCELED',
    });
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    // Only SELECT ran
    expect(dataQueries).toHaveLength(1);
  });

  it('SAD: returns 409 TIMESLOT_OCCUPIED with conflict block when slot was rebooked', async () => {
    // WHO: operator tries to reactivate a canceled appointment whose slot
    //       was already rebooked by another customer in the meantime
    // WHAT: SELECT returns status='canceled' → UPDATE throws PG 23P01
    //       (exclusion_violation, GiST appointments_no_resource_overlap
    //       OR appointments_no_employee_overlap fired) → route runs
    //       findOverlappingAppointment to surface the blocker → 409 with
    //       conflict block
    // WHEN: race-condition pattern between cancel and reactivate where
    //       another booking landed in the freed slot
    // WHERE: try/catch around UPDATE, code === '23P01' branch
    // WHY: this is the most important sad path — without it, reactivate
    //       would surface a generic 500 on a real, common operational
    //       case (the slot got rebooked while canceled). The conflict
    //       block matches /appointments/create's 409 shape so the
    //       dashboard can reuse the existing ConflictModal pattern.
    const CONFLICT_APPT_ID = '99999999-aaaa-4bbb-8ccc-dddddddddddd';

    // Sequencing the three queries:
    //   call 1 (SELECT)  → mockImplementationOnce returns canceled row
    //   call 2 (UPDATE)  → mockImplementationOnce throws PG 23P01
    //   call 3 (conflict SELECT) → falls through to default impl which
    //                              pops from queryResponses
    // Why mockImplementationOnce rather than mockImplementation: Once
    // is auto-consumed so subsequent tests inherit the default impl
    // (mockImplementation would persist and poison sibling describes).
    handle.mockClient.query.mockImplementationOnce(async (text: string, params?: unknown[]) => {
      handle.queries.push({ text, params: params || [] });
      return {
        rows: [
          {
            status: 'canceled',
            resource_id: RESOURCE_ID,
            employee_id: EMPLOYEE_ID,
            start_time: '2026-04-15T14:00:00Z',
            end_time: '2026-04-15T15:00:00Z',
          },
        ],
      };
    });
    handle.mockClient.query.mockImplementationOnce(async (text: string, params?: unknown[]) => {
      handle.queries.push({ text, params: params || [] });
      const err: Error & { code?: string } = new Error(
        'conflicting key value violates exclusion constraint "appointments_no_resource_overlap"'
      );
      err.code = '23P01';
      throw err;
    });
    handle.queryResponses.push({
      rows: [
        {
          appointment_id: CONFLICT_APPT_ID,
          start_time: '2026-04-15T14:00:00Z',
          end_time: '2026-04-15T15:00:00Z',
          customer_name: 'New Customer',
          employee_name: 'Mike',
          resource_name: 'Bay 1',
          description: 'Rebooked oil change',
        },
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/reactivate`,
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body).toMatchObject({
      success: false,
      error: 'That time slot is no longer available',
      error_code: 'TIMESLOT_OCCUPIED',
      conflict: {
        appointment_id: CONFLICT_APPT_ID,
        customer_name: 'New Customer',
        employee_name: 'Mike',
        resource_name: 'Bay 1',
      },
    });
    // Critical: sync NOT fired on conflict — would push a deleted-then-recreated
    // event to externals based on a state that didn't actually commit.
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
  });

  it('SAD: returns 400 when no tenant context is on the request (auth short-circuit)', async () => {
    // WHO: reactivate hit without auth context (mirrors the cancel/delete
    //       short-circuit tests so every destructive single-row endpoint
    //       has the same gate coverage)
    // WHAT: requireTenantId() returns null + sends 400 before any DB
    //       activity. No SELECT, no UPDATE, no sync.
    // WHEN: missing JWT or middleware ordering bug strips req.auth
    // WHERE: src/routes/appointments.ts — `if (!tenantId) return`
    // WHY: pre-fix-pattern this branch could let a SELECT/UPDATE run
    //       with `tenant_id = $2` bound to undefined → potential
    //       cross-tenant flip canceled→scheduled. Symmetry with /cancel
    //       coverage is deliberate.
    handle.auth.current = null;
    handle.tenantIdOverride.current = null;

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/reactivate`,
    });

    // 2026-05-21: unauthenticated → 401 before any SELECT/UPDATE/sync.
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'Authentication required' });
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// POST /appointments/:id/update
// ────────────────────────────────────────────────────────────────────

describe('POST /appointments/:id/update', () => {
  it('HAPPY: updates appointment fields in a transaction, fires sync', async () => {
    // WHO: tenant rescheduling an appointment
    // WHAT: BEGIN → UPDATE appointments SET ... → COMMIT, then sync('update')
    // WHEN: POST /:id/update with one or more updatable fields
    // WHERE: update handler transaction block
    // WHY: the transaction wraps both the appointment update AND the
    //       optional customer-info update so they commit atomically;
    //       a partial failure rolls back both
    // BEGIN, SELECT existing appointment, UPDATE appointments, COMMIT — 4 scripted responses
    handle.queryResponses.push({ rows: [] }); // BEGIN
    handle.queryResponses.push({
      rows: [{ start_time: '2026-04-15T15:00:00Z', end_time: '2026-04-15T16:00:00Z' }],
    }); // SELECT existing
    handle.queryResponses.push({ rows: [{ timezone: 'UTC' }] }); // tenant timezone (time changed)
    handle.queryResponses.push({ rows: [] }); // blackout_dates check — not closed
    handle.queryResponses.push({ rows: [] }); // UPDATE appointments
    handle.queryResponses.push({ rows: [] }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/update`,
      payload: {
        tenant_id: TENANT_ID,
        start_time: '2026-04-15T15:00:00Z',
        end_time: '2026-04-15T16:00:00Z',
        description: 'Rescheduled brake replacement',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries[0].text).toBe('BEGIN');
    expect(dataQueries[1].text).toContain('SELECT start_time::text AS start_time');
    // dataQueries[2] = tenant timezone lookup, dataQueries[3] = blackout_dates
    // check — both fire on any time change (2026-09-13 revalidation).
    expect(dataQueries[4].text).toContain('UPDATE appointments SET');
    expect(dataQueries[4].text).toContain('start_time =');
    expect(dataQueries[4].text).toContain('description =');
    expect(dataQueries[5].text).toBe('COMMIT');
    expect(syncAppointmentToAll).toHaveBeenCalledWith(
      handle.mockPool,
      TENANT_ID,
      APPOINTMENT_ID,
      'update',
      expect.anything()
    );
  });

  it('HAPPY: updates customer info when customer_name/phone/notes provided', async () => {
    // WHO: tenant updating customer details from the appointment detail panel
    // WHAT: in addition to UPDATE appointments, the handler does a SELECT
    //       customer_id then UPDATE customers (atomically in the same txn)
    // WHEN: payload includes customer_name / customer_phone / customer_notes
    // WHERE: customer-info update branch (line ~217)
    // WHY: the customer detail edit lives on the appointment view for UX
    //       reasons; the route accepts both kinds of edits in one call
    //       so the dashboard doesn't need two round-trips
    handle.queryResponses.push({ rows: [] }); // BEGIN
    handle.queryResponses.push({ rows: [{}] }); // SELECT existing (always runs now)
    handle.queryResponses.push({ rows: [] }); // UPDATE appointments (no fields → 0 statements actually) — wait, the description does count
    handle.queryResponses.push({ rows: [{ customer_id: CUSTOMER_ID }] }); // SELECT customer_id
    handle.queryResponses.push({ rows: [] }); // UPDATE customers
    handle.queryResponses.push({ rows: [] }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/update`,
      payload: {
        tenant_id: TENANT_ID,
        description: 'Updated note',
        customer_name: 'New Name',
        customer_phone: '+15559999999',
      },
    });

    expect(res.statusCode).toBe(200);
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    // Should see SELECT customer_id and UPDATE customers in addition to UPDATE appointments
    const customerUpdateQueries = dataQueries.filter((q) => q.text.includes('UPDATE customers'));
    expect(customerUpdateQueries).toHaveLength(1);
    expect(customerUpdateQueries[0].text).toContain('name =');
    expect(customerUpdateQueries[0].text).toContain('phone =');
  });

  it('HAPPY: updates ONLY customer_notes (covers notes-defined branch in isolation)', async () => {
    // WHO: dashboard user editing a single note field on the appointment
    //       detail view — name and phone untouched
    // WHAT: customer-info update sub-block builds a UPDATE customers SET
    //       statement with ONLY the metadata jsonb_set fragment; the
    //       name= and phone= fragments stay absent
    // WHEN: payload carries customer_notes but neither customer_name nor
    //        customer_phone
    // WHERE: src/routes/appointments.ts L375-378 — the per-field
    //        if-statements inside the customer-info sub-block. Each builds
    //        the UPDATE fragment only when its own field is set; the
    //        notes-defined-only path was untested (branch coverage gap).
    // WHY: pre-test, a refactor that swapped which field maps to which
    //       SQL fragment (name <-> phone, notes <-> phone, etc.) would
    //       silently corrupt rows in production — the existing happy test
    //       always sent name + phone together, masking ordering bugs.
    handle.queryResponses.push(
      { rows: [] }, // BEGIN
      { rows: [{}] }, // SELECT existing (always runs now)
      { rows: [] }, // UPDATE appointments (description-only field set)
      { rows: [{ customer_id: CUSTOMER_ID }] }, // SELECT customer_id
      { rows: [] }, // UPDATE customers
      { rows: [] } // COMMIT
    );

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/update`,
      payload: {
        tenant_id: TENANT_ID,
        description: 'Updated note',
        customer_notes: 'Allergic to mint air freshener',
      },
    });

    expect(res.statusCode).toBe(200);
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    const custUpdate = dataQueries.find((q) => q.text.includes('UPDATE customers'));
    expect(custUpdate).toBeDefined();
    // Pin the SET clause shape: only metadata jsonb_set, no name=, no phone=.
    expect(custUpdate!.text).toContain("jsonb_set(COALESCE(metadata, '{}'), '{notes}'");
    expect(custUpdate!.text).not.toMatch(/\bname\s*=/);
    expect(custUpdate!.text).not.toMatch(/\bphone\s*=/);
  });

  it('SAD: customer-info update is skipped when SELECT returns no customer_id (orphan row)', async () => {
    // WHO: edge case — appointment row exists but its customer_id FK was
    //       null'd out (rare, but possible after a customer hard-delete
    //       race or a partial migration)
    // WHAT: the SELECT customer_id ... clause returns rows[0] with
    //       customer_id = null, so `appt.rows[0]?.customer_id` is falsy
    //       and the UPDATE customers branch is skipped. The appointment
    //       update still commits.
    // WHEN: payload includes customer_name etc. but the appointment's
    //        customer_id is null in the DB
    // WHERE: src/routes/appointments.ts L371 — `if (appt.rows[0]?.customer_id)`
    //        false branch (uncovered pre-test).
    // WHY: pre-test, this defensive guard was never exercised by tests.
    //       A refactor that dropped the `?.customer_id` chain (e.g. wrote
    //       `appt.rows[0]` directly) would attempt UPDATE customers WHERE
    //       id = null, which is a silent no-op but masks the data anomaly.
    //       Pinning the skip behavior makes the contract explicit.
    handle.queryResponses.push(
      { rows: [] }, // BEGIN
      { rows: [{}] }, // SELECT existing (always runs now)
      { rows: [] }, // UPDATE appointments
      { rows: [{ customer_id: null }] }, // SELECT customer_id — orphan
      { rows: [] } // COMMIT (no UPDATE customers in between)
    );

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/update`,
      payload: {
        tenant_id: TENANT_ID,
        description: 'Updated',
        customer_name: 'Should be ignored',
      },
    });

    expect(res.statusCode).toBe(200);
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    // Critical: NO UPDATE customers despite the payload requesting one,
    // because the appointment's customer_id was null.
    expect(dataQueries.find((q) => q.text.includes('UPDATE customers'))).toBeUndefined();
  });

  it('SAD: returns 400 on Zod validation failure', async () => {
    // WHO: client sending malformed update payload (e.g., bad UUID)
    // WHAT: AppointmentUpdateSchema.safeParse fails → 400 with details
    // WHEN: POST /:id/update with bad body
    // WHERE: schema check at top of handler
    // WHY: same defense-first pattern as create — keep malformed data
    //       out of Postgres
    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/update`,
      payload: { tenant_id: 'not-uuid' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation failed');
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
  });

  it('SAD: returns 403 when body.tenant_id does not match auth tenant (cross-tenant attempt)', async () => {
    // WHO: an authenticated user trying to update another tenant's appointment
    //       by passing a different tenant_id in the body
    // WHAT: cross-tenant guard — body.tenant_id must match req.auth.tenant_id
    //       unless the caller is super-admin
    // WHEN: payload.tenant_id !== auth.tenant_id (and not super-admin)
    // WHERE: cross-tenant gate (line ~182)
    // WHY: closes the same class of cross-tenant injection that
    //       multi-tenant-isolation.test.ts catches — defense-in-depth
    //       inside the handler in addition to the middleware-layer gate
    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/update`,
      payload: {
        tenant_id: OTHER_TENANT_ID, // different from auth's tenant_id
        description: 'malicious update attempt',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      success: false,
      error: 'tenant_id does not match authenticated tenant',
    });
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
    // No DB query should have fired
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
  });

  it('SAD: rejects absurd 23-hour updates before the write', async () => {
    handle.queryResponses.push({ rows: [] }); // BEGIN
    handle.queryResponses.push({
      rows: [{ start_time: '2026-04-15T10:00:00Z', end_time: '2026-04-15T11:00:00Z' }],
    });
    handle.queryResponses.push({ rows: [] }); // ROLLBACK

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/update`,
      payload: {
        tenant_id: TENANT_ID,
        start_time: '2026-04-15T10:00:00Z',
        end_time: '2026-04-16T09:00:00Z',
        description: 'Way too long',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      success: false,
      error: 'Appointment duration cannot exceed 12 hours',
      error_code: 'INVALID_DURATION',
    });
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
  });

  it('SAD: update with off-grid time is rejected with INVALID_INCREMENT', async () => {
    // WHO: dashboard reschedule, or curl PUT bypassing the time-picker
    // WHAT: validateAppointmentTimeRange runs after the existing-row SELECT
    //        on the update path; off-grid times ROLLBACK the transaction
    //        and return 400 + INVALID_INCREMENT
    // WHY: parity with create — both surfaces must enforce the same grid
    //       so a row can't end up off-grid via either route, regardless
    //       of the DB CHECK as floor.
    // The handler reads existing row first, then validates effective times.
    handle.queryResponses.push({ rows: [] }); // BEGIN
    handle.queryResponses.push({
      rows: [
        {
          id: APPOINTMENT_ID,
          tenant_id: TENANT_ID,
          start_time: '2026-04-15T10:00:00Z',
          end_time: '2026-04-15T10:30:00Z',
        },
      ],
    }); // SELECT existing
    handle.queryResponses.push({ rows: [] }); // ROLLBACK

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/update`,
      payload: {
        tenant_id: TENANT_ID,
        start_time: '2026-04-15T10:07:00Z',
        end_time: '2026-04-15T10:30:00Z',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      success: false,
      error: 'Start time must land on a 15-minute increment (:00, :15, :30, :45)',
      error_code: 'INVALID_INCREMENT',
    });
    expect(syncAppointmentToAll).not.toHaveBeenCalled();
  });

  it("HAPPY: super-admin can update any tenant's appointment (cross-tenant gate exempted)", async () => {
    // WHO: platform super-admin doing support-driven update
    // WHAT: cross-tenant gate is bypassed when auth.tenant_id is the super-admin
    //       sentinel — body.tenant_id can target any tenant
    // WHEN: super-admin caller, body.tenant_id is some other tenant
    // WHERE: cross-tenant gate `authTenantId !== SUPER_ADMIN_TENANT_ID` clause
    // WHY: support workflow needs cross-tenant write access; without this
    //       carve-out, super-admins couldn't fix customer issues
    handle.auth.current = {
      user_id: '00000000-0000-0000-0000-000000000001',
      tenant_id: SUPER_ADMIN_TENANT_ID,
      email: 'admin@platform',
      role: 'owner',
    };
    handle.queryResponses.push({ rows: [] }); // BEGIN
    handle.queryResponses.push({ rows: [{}] }); // SELECT existing (always runs now)
    handle.queryResponses.push({ rows: [] }); // UPDATE appointments
    handle.queryResponses.push({ rows: [] }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/update`,
      payload: {
        tenant_id: OTHER_TENANT_ID, // different from super-admin's tenant
        description: 'Support update',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(syncAppointmentToAll).toHaveBeenCalledWith(
      handle.mockPool,
      OTHER_TENANT_ID, // sync targets the body tenant, not the caller's tenant
      APPOINTMENT_ID,
      'update',
      expect.anything()
    );
  });

  it('HAPPY: rescheduleRemindersForAppointment fires when start_time changes', async () => {
    // WHO: tenant moving an appointment from 14:00 to 16:00 via the
    //      detail panel — the canonical reschedule case the worker has
    //      to follow.
    // WHAT: after the UPDATE commits, the route fires
    //       rescheduleRemindersForAppointment(withTenantClient, tenant,
    //       appointmentId, log) — fire-and-forget — so the worker stops
    //       firing the old-time reminders and seeds fresh ones for the
    //       new start_time.
    // WHEN: update payload carries start_time AND it differs from the
    //       row's current start_time (the SELECT in the handler reads
    //       the prior value to compare).
    // WHERE: src/routes/appointments.ts after COMMIT, the
    //        `if (startTimeChanged) rescheduleRemindersForAppointment(...)`
    //        branch.
    // WHY: pinned 2026-05-13. Pre-fix, /appointments/:id/update updated
    //      the appointment but left reminder_schedules rows pointing at
    //      the OLD start_time, so the worker fired customer-facing
    //      reminders ("your appointment is in 2 hours") for a time the
    //      appointment no longer existed at. Surfaced by the 2026-05-13
    //      Communications/Reminders TODO reconciliation.
    handle.queryResponses.push({ rows: [] }); // BEGIN
    handle.queryResponses.push({
      rows: [{ start_time: '2026-04-15T14:00:00Z', end_time: '2026-04-15T15:00:00Z' }],
    }); // SELECT prior
    handle.queryResponses.push({ rows: [{ timezone: 'UTC' }] }); // tenant timezone (time changed)
    handle.queryResponses.push({ rows: [] }); // blackout_dates check — not closed
    handle.queryResponses.push({ rows: [] }); // UPDATE appointments
    handle.queryResponses.push({ rows: [] }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/update`,
      payload: {
        tenant_id: TENANT_ID,
        start_time: '2026-04-15T16:00:00Z', // moved 2h later
        end_time: '2026-04-15T17:00:00Z',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(rescheduleRemindersForAppointment).toHaveBeenCalledTimes(1);
    expect(rescheduleRemindersForAppointment).toHaveBeenCalledWith(
      expect.any(Function), // withTenantClient
      TENANT_ID,
      APPOINTMENT_ID,
      expect.anything() // logger
    );
  });

  it('HAPPY: rescheduleRemindersForAppointment does NOT fire when start_time is unchanged', async () => {
    // WHO: tenant updating ONLY the description / location / employee on
    //      an appointment — no time change, no need to disturb the
    //      already-scheduled reminders.
    // WHAT: the route detects body.start_time === prior.start_time (or
    //       body.start_time absent entirely) and skips the reschedule
    //       call. Reminders stay as-is.
    // WHEN: updates that don't touch the time axis. The dashboard
    //        detail panel can edit description/customer notes without
    //        moving the appointment — this is the dominant non-move
    //        case.
    // WHERE: same branch as above; the `if (startTimeChanged)` guard.
    // WHY: tearing down and re-seeding 4 reminders for every cosmetic
    //      edit would burn DB writes, pollute the audit trail with
    //      cancelled rows, and risk a brief window where the worker
    //      sees zero scheduled rows for the appointment (mid-reschedule
    //      race). The guard pins the no-op case.
    handle.queryResponses.push({ rows: [] }); // BEGIN
    handle.queryResponses.push({ rows: [{}] }); // SELECT existing (always runs now)
    handle.queryResponses.push({ rows: [] }); // UPDATE appointments
    handle.queryResponses.push({ rows: [] }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/update`,
      payload: {
        tenant_id: TENANT_ID,
        description: 'Edited note — no time change',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(rescheduleRemindersForAppointment).not.toHaveBeenCalled();
  });

  it('HAPPY: same start_time as the existing row does NOT trigger reschedule (no-op submit)', async () => {
    // WHO: a UX where the dashboard re-submits the entire appointment
    //      payload on every save, including the unchanged start_time.
    //      We've seen this pattern from form libraries that don't
    //      diff-by-field.
    // WHAT: the route SELECTs the prior start_time, sees it matches
    //       body.start_time exactly, and SKIPS the reschedule call.
    //       Tested explicitly because the "any start_time in body"
    //       heuristic would over-trigger, sending unnecessary
    //       reschedule traffic on every save.
    // WHEN: every redundant save the dashboard issues — common shape.
    // WHERE: src/routes/appointments.ts — the
    //        `body.start_time !== existing.rows[0].start_time` arm of
    //        the startTimeChanged flag.
    // WHY: cheap-but-easy-to-get-wrong heuristic. Without this test, a
    //      naive refactor ("just check if start_time was sent") would
    //      churn the reminders table on every form save.
    handle.queryResponses.push({ rows: [] }); // BEGIN
    handle.queryResponses.push({
      rows: [{ start_time: '2026-04-15T14:00:00Z', end_time: '2026-04-15T15:00:00Z' }],
    }); // SELECT prior
    handle.queryResponses.push({ rows: [{ timezone: 'UTC' }] }); // tenant timezone (time "changed" — same value resubmitted)
    handle.queryResponses.push({ rows: [] }); // blackout_dates check — not closed
    handle.queryResponses.push({ rows: [] }); // UPDATE appointments
    handle.queryResponses.push({ rows: [] }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/update`,
      payload: {
        tenant_id: TENANT_ID,
        start_time: '2026-04-15T14:00:00Z', // identical to prior
        end_time: '2026-04-15T15:00:00Z',
        description: 'Edited note only',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(rescheduleRemindersForAppointment).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// POST /appointments/:id/send-self-service-links
// ────────────────────────────────────────────────────────────────────

describe('POST /appointments/:id/send-self-service-links', () => {
  const OLD_DASHBOARD_URL = process.env.DASHBOARD_URL;
  const OLD_BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL;
  const OLD_ENABLE_SMS = process.env.ENABLE_SMS;

  beforeEach(() => {
    process.env.DASHBOARD_URL = 'https://example.secretaryhq.com';
    delete process.env.BACKEND_PUBLIC_URL;
    // SMS is globally OFF by default (pending 10DLC) — these tests exercise
    // the send path, so opt in explicitly. The dedicated ENABLE_SMS=false
    // test below overrides this per-test.
    process.env.ENABLE_SMS = 'true';
  });

  afterEach(() => {
    if (OLD_DASHBOARD_URL === undefined) {
      delete process.env.DASHBOARD_URL;
    } else {
      process.env.DASHBOARD_URL = OLD_DASHBOARD_URL;
    }
    if (OLD_BACKEND_PUBLIC_URL === undefined) {
      delete process.env.BACKEND_PUBLIC_URL;
    } else {
      process.env.BACKEND_PUBLIC_URL = OLD_BACKEND_PUBLIC_URL;
    }
    if (OLD_ENABLE_SMS === undefined) {
      delete process.env.ENABLE_SMS;
    } else {
      process.env.ENABLE_SMS = OLD_ENABLE_SMS;
    }
  });

  it('SAD: returns 503 and never calls sendSms when ENABLE_SMS is off (default)', async () => {
    // WHO: owner tapping "Send Links" while the platform's SMS capability is
    //      off (pending 10DLC registration — the default and current prod
    //      state for the whole platform)
    // WHAT: the route refuses before any DB/SMS work, with a clear message,
    //       instead of reporting success for a text that can never arrive
    // WHY: audit finding 2026-09-16 — Telnyx accepts the send and reports
    //      success anyway (carrier-side error 40010), so without this gate
    //      the staff member sees a green success toast for a dead text
    delete process.env.ENABLE_SMS;

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/send-self-service-links`,
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/sms/i);
    expect(sendSms).not.toHaveBeenCalled();
    // No DB queries either — the gate fires before any lookup.
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
  });

  it('HAPPY: sends SMS with cancel + reschedule links and returns 200', async () => {
    // WHO: owner tapping "Send Links" button on a scheduled appointment
    // WHAT: two self-service tokens generated; SMS body contains both links
    // WHEN: appointment is scheduled and customer has a phone number
    // WHERE: POST /appointments/:id/send-self-service-links
    // WHY: customers need one-tap cancel/reschedule without a dashboard login
    handle.queryResponses.push({
      rows: [
        {
          start_time: '2026-07-10T14:00:00Z',
          description: 'Haircut',
          customer_phone: '+16345550199',
          inbound_phone: '+16345550986',
        },
      ],
      rowCount: 1,
    });

    handle.queryResponses.push({
      rows: [{ consent_given: true, revoked_at: null }],
      rowCount: 1,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/send-self-service-links`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      success: boolean;
      message: string;
      cancelLink?: string;
      rescheduleLink?: string;
    };
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/sent/i);
    expect(body.cancelLink).toMatch(/\/self\/cancel\?token=/);
    expect(body.rescheduleLink).toMatch(/\/self\/reschedule\?token=/);
    expect(sendSms).toHaveBeenCalledOnce();
    const callArgs = (sendSms as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      body: string;
      from: string;
      to: string;
    };
    expect(callArgs.body).toMatch(/cancel/i);
    expect(callArgs.body).toMatch(/reschedule/i);
    expect(callArgs.to).toBe('+16345550199');
  });

  it('SAD: returns 400 when customer has no SMS consent on file', async () => {
    // WHO: owner clicking "Send Links" for a customer with no consent record
    // WHAT: 400, no SMS attempted
    // WHY: this route must honor the same SMS consent gate as the rest of the
    //       communications stack instead of bypassing it.
    handle.queryResponses.push({
      rows: [
        {
          start_time: '2026-07-10T14:00:00Z',
          description: 'Haircut',
          customer_phone: '+16345550199',
          inbound_phone: '+16345550986',
        },
      ],
      rowCount: 1,
    });
    handle.queryResponses.push({
      rows: [],
      rowCount: 0,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/send-self-service-links`,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/consented to SMS/i);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('SAD: returns 404 when appointment not found or not scheduled', async () => {
    // WHO: owner clicking "Send Links" on a stale/deleted appointment
    // WHAT: 404 with clear error message
    handle.queryResponses.push({ rows: [], rowCount: 0 });

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/send-self-service-links`,
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { success: boolean };
    expect(body.success).toBe(false);
  });

  it('SAD: returns 400 when customer has no phone number', async () => {
    // WHO: owner clicking "Send Links" for a customer with no phone on file
    // WHAT: 400 with descriptive error — no SMS attempted
    handle.queryResponses.push({
      rows: [
        {
          start_time: '2026-07-10T14:00:00Z',
          description: 'Haircut',
          customer_phone: null,
          inbound_phone: '+16308229086',
        },
      ],
      rowCount: 1,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/send-self-service-links`,
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/phone/i);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('SAD: returns 503 when no public base URL is configured', async () => {
    // WHO: owner on a deployment where neither DASHBOARD_URL nor BACKEND_PUBLIC_URL is set
    // WHAT: 503 before any DB query — links can't be built without at least one base URL
    delete process.env.DASHBOARD_URL;
    delete process.env.BACKEND_PUBLIC_URL;

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/send-self-service-links`,
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { success: boolean };
    expect(body.success).toBe(false);
  });

  it('SAD: returns 401 when unauthenticated', async () => {
    // WHO: anonymous request (no JWT)
    // WHAT: rejected before any DB call — JWT auth is required
    handle.auth.current = null;

    const res = await app.inject({
      method: 'POST',
      url: `/appointments/${APPOINTMENT_ID}/send-self-service-links`,
    });

    expect(res.statusCode).toBe(401);
  });
});
