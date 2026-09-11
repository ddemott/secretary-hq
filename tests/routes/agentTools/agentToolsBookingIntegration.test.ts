/**
 * Real-DB end-to-end booking integration test — the "green but broken" guard.
 *
 * Motivation (docs/TODO.md "Verification blind spots", 2026-07-01): four booking bugs shipped
 * to prod through a green CI suite because agentTools.test.ts mocks the pg
 * client — SQL errors, timezone conversion, and the actually-stored row were
 * all invisible. This suite drives the REAL route → REAL RPC → REAL Postgres
 * and asserts the appointment row that lands, so those classes of bug fail CI:
 *
 *   Bug #1 — serviceResolver "column reference \"name\" is ambiguous" 500
 *            (SQL only runs against real pg; see the available-slots test).
 *   Bug #2 — a 3:30 PM caller-local request stored as 10:30 AM (no
 *            agent→route→RPC→DB clock test; see the UTC assertion).
 *   Bug #4 — booking landed Unassigned / at the wrong time (no end-to-end
 *            assertion of the stored row; see employee_id + start_time).
 *
 * Strategy mirrors agentToolsPreferences.test.ts: real pg.Pool on API_DB_URL
 * (api_user, RLS-scoped — same privileges as prod) + createWithTenantClient +
 * registerAgentToolRoutes on a throwaway Fastify app, driven via app.inject.
 * Fixtures are created per-suite and deleted in afterAll (test-isolation rule:
 * DB starts bare, tests own their data, DB ends bare). Skips when the test DB
 * is down; hard-fails under REQUIRE_DB_TESTS=1 (CI).
 *
 * 5W for sad-path failures:
 *   WHO  — the LiveKit voice agent booking on behalf of a live caller
 *   WHAT — POST /agent-tools/book-with-scheduling {requirements, window}
 *   WHEN — mid-call, after the caller picked a time ("tomorrow at 3:30")
 *   WHERE — agentTools.ts → applyTimezone → book_with_scheduling_atomic →
 *           appointments row (UTC timestamptz, employee_id, status)
 *   WHY  — a wrong stored instant or an unassigned employee is a booking the
 *          business misses; the caller shows up and nobody expects them
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { type Client, Pool } from 'pg';
import {
  API_DB_URL,
  getRootClient,
  createTenant,
  createService,
  createEmployee,
  createResource,
  createScheduleEntry,
  assignEmployeeToService,
  assignResourceToService,
  skipIfDbDown,
} from '../../utils';
import { createWithTenantClient } from '../../../src/database';
import { registerAgentToolRoutes } from '../../../src/routes/agentTools';

const AGENT_SECRET = 'test-booking-integration-secret';
const stubEmbedding = (): Promise<number[]> => Promise.resolve(new Array(1536).fill(0));
const stubNormalizer = async (text: string): Promise<string> => text;

const TENANT_TZ = 'America/Chicago';
const CALLER_PHONE_RAW = '5552220001'; // normalizePhone → +15552220001
const CALLER_PHONE_E164 = '+15552220001';

/** Today's date (YYYY-MM-DD) in the tenant's timezone, plus N days. */
function tenantLocalDatePlus(days: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TENANT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));
}

/**
 * Expected UTC instant for a tenant-local wall-clock time, computed
 * INDEPENDENTLY of the code under test (Intl longOffset, not applyTimezone) —
 * so a bug in the app's tz conversion can't cancel out in the assertion.
 */
function expectedUtc(dateIso: string, time: string): string {
  const probe = new Date(`${dateIso}T12:00:00Z`);
  const offset = new Intl.DateTimeFormat('en-US', {
    timeZone: TENANT_TZ,
    timeZoneName: 'longOffset',
  })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName')!
    .value.replace('GMT', '');
  return new Date(`${dateIso}T${time}${offset || 'Z'}`).toISOString();
}

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
let tenantId: string;
let serviceId: string;
let employeeId: string;
/** A date with a 09:00–17:00 shift seeded. */
let shiftDate: string;
/** The day after — deliberately NO shift row (EMPLOYEE_NOT_SCHEDULED path). */
let noShiftDate: string;
const tenantsToClean: string[] = [];

function post(path: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'x-agent-secret': AGENT_SECRET },
    payload,
  });
}

function bookingPayload(from: string, to: string, phone: string = CALLER_PHONE_RAW) {
  return {
    tenant_id: tenantId,
    phone,
    name: 'Integration Ida',
    requirements: { serviceType: 'Haircut' },
    window: { from, to }, // naive tenant-local wall-clock — the agent's shape
  };
}

async function appointmentRows(): Promise<
  Array<{
    start_time: Date;
    end_time: Date;
    employee_id: string | null;
    resource_id: string | null;
    customer_id: string | null;
    status: string;
  }>
> {
  const res = await setup.query(
    `SELECT start_time, end_time, employee_id, resource_id, customer_id, status
       FROM appointments WHERE tenant_id = $1 ORDER BY start_time`,
    [tenantId]
  );
  return res.rows;
}

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });
    process.env.AGENT_SECRET = AGENT_SECRET;

    app = Fastify({ logger: false });
    const withTenantClient = createWithTenantClient(pool);
    registerAgentToolRoutes(app, pool, withTenantClient, stubEmbedding, stubNormalizer);
    await app.ready();

    // Business shape: one 30-min skilled service, one skilled employee on a
    // 9–5 shift next week, one bookable chair. Small on purpose — every
    // outcome below is then attributable to exactly one seeded fact.
    tenantId = await createTenant(setup, 'Blindspot Booking Salon', 'salon', TENANT_TZ);
    tenantsToClean.push(tenantId);
    serviceId = await createService(setup, tenantId, 'Haircut', 30, 40);
    await setup.query(
      `UPDATE services SET required_skills = ARRAY['haircut'] WHERE service_id = $1`,
      [serviceId]
    );
    employeeId = await createEmployee(setup, tenantId, 'Test Stylist', ['haircut']);
    const chairId = await createResource(setup, tenantId, 'Chair 1');
    await assignEmployeeToService(setup, tenantId, serviceId, employeeId);
    // The room half of the skill map: haircuts happen in Chair 1. Strict since
    // migration 20260909210000 — a service linked to no room cannot be booked.
    await assignResourceToService(setup, tenantId, serviceId, chairId);
    // default_service_id makes serviceResolver's branch-2 (JOIN tenants —
    // the ambiguous-"name" bug site) reachable for unknown service types.
    await setup.query(`UPDATE tenants SET default_service_id = $1 WHERE tenant_id = $2`, [
      serviceId,
      tenantId,
    ]);

    shiftDate = tenantLocalDatePlus(7);
    noShiftDate = tenantLocalDatePlus(8);
    await createScheduleEntry(setup, tenantId, employeeId, shiftDate, '09:00', '17:00');

    dbAvailable = true;
  } catch (err) {
    console.warn('[agentToolsBookingIntegration.test] DB not available, skipping', err);
  }
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (setup) {
    for (const id of tenantsToClean) {
      await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
    }
    await setup.end();
  }
  delete process.env.AGENT_SECRET;
});

beforeEach((ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
});

describe('book-with-scheduling → real RPC → real appointments row', () => {
  it('HAPPY: a 3:30 PM tenant-local request stores the correct UTC instant, assigned to the on-shift employee', async () => {
    // WHY this exact assertion: bug #2 stored a 3:30 PM Chicago request as
    // 10:30 AM because the naive string was parsed in the server zone. The
    // expected instant here is computed via Intl (independent of
    // applyTimezone), so the test fails if EITHER side converts wrong.
    const res = await post(
      '/agent-tools/book-with-scheduling',
      bookingPayload(`${shiftDate}T15:30:00`, `${shiftDate}T16:00:00`)
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.result.success).toBe(true);
    expect(body.result.appointment_id).toBeTruthy();
    expect(body.result.employee_name).toBe('Test Stylist');
    // Read-back the agent SPEAKS to the caller must be tenant-local 3:30 PM,
    // not the UTC instant (the "agent confirms 8:30 PM" half of the tz bug).
    expect(String(body.result.booked_start)).toContain(`${shiftDate}T15:30`);

    const rows = await appointmentRows();
    const booked = rows.find(
      (r) => r.start_time.toISOString() === expectedUtc(shiftDate, '15:30:00')
    );
    expect(
      booked,
      `no appointment stored at the requested instant; rows: ${JSON.stringify(rows)}`
    ).toBeTruthy();
    expect(booked!.end_time.toISOString()).toBe(expectedUtc(shiftDate, '16:00:00'));
    // Bug #4 guard: the booking must be ASSIGNED to the skilled, on-shift
    // employee — an Unassigned row looks fine in the API response but is a
    // no-show waiting to happen on the dashboard schedule.
    expect(booked!.employee_id).toBe(employeeId);
    expect(booked!.resource_id).toBeTruthy();
    expect(booked!.status).toBe('scheduled');

    // The caller became a CRM customer and the row points at them.
    const cust = await setup.query(
      `SELECT customer_id FROM customers WHERE tenant_id = $1 AND phone = $2`,
      [tenantId, CALLER_PHONE_E164]
    );
    expect(cust.rows).toHaveLength(1);
    expect(booked!.customer_id).toBe(cust.rows[0].customer_id);

    // On-shift sanity: the stored instant falls inside the seeded shift when
    // viewed in the tenant's timezone (guards a UTC/local mixup in the RPC's
    // shift matching, which compares tenant-local date + time-of-day).
    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: TENANT_TZ }).format(
      booked!.start_time
    );
    expect(localDate).toBe(shiftDate);
  });

  it('SAD: no shift that day → EMPLOYEE_NOT_SCHEDULED, and NOTHING is stored', async () => {
    // WHO: a caller asking for a day the stylist simply isn't working.
    // WHY: the RPC must refuse (specific code, so the agent can say "she's
    //      not in that day") rather than book a ghost appointment.
    const res = await post(
      '/agent-tools/book-with-scheduling',
      bookingPayload(`${noShiftDate}T15:30:00`, `${noShiftDate}T16:00:00`)
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('EMPLOYEE_NOT_SCHEDULED');

    const rows = await appointmentRows();
    const strays = rows.filter(
      (r) => r.start_time.toISOString() === expectedUtc(noShiftDate, '15:30:00')
    );
    expect(strays).toHaveLength(0);
  });

  it('SAD: double-booking the same slot → TIMESLOT_OCCUPIED, exactly one row survives', async () => {
    // WHERE: the GiST exclusion constraints (appointments_no_employee_overlap)
    //        are the last line of defense against a double-book race — this
    //        proves the whole stack surfaces it as a clean error_code, not a
    //        500 or (worse) a silent second booking.
    const first = await post(
      '/agent-tools/book-with-scheduling',
      bookingPayload(`${shiftDate}T10:00:00`, `${shiftDate}T10:30:00`)
    );
    expect(first.json().success).toBe(true);

    const second = await post(
      '/agent-tools/book-with-scheduling',
      bookingPayload(`${shiftDate}T10:00:00`, `${shiftDate}T10:30:00`, '5552220002')
    );
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('TIMESLOT_OCCUPIED');

    const rows = await appointmentRows();
    const atSlot = rows.filter(
      (r) => r.start_time.toISOString() === expectedUtc(shiftDate, '10:00:00')
    );
    expect(atSlot).toHaveLength(1);
  });
});

describe('available-slots → real serviceResolver SQL (bug #1 regression)', () => {
  it('HAPPY: a known service on a shift day resolves and returns slots without a 500', async () => {
    const res = await post('/agent-tools/available-slots', {
      tenant_id: tenantId,
      service_type: 'Haircut',
      date: shiftDate,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('REGRESSION: an unknown service type falls through to default_service_id (the JOIN-tenants SQL that was ambiguous) without a 500', async () => {
    // WHAT broke in prod: serviceResolver branch 2 JOINs tenants (which also
    // has a `name` column); an unqualified `name` in the projection threw
    // `column reference "name" is ambiguous` → available-slots 500 on every
    // call. The mocked suite never ran the SQL, so CI stayed green. This test
    // exists to run that exact statement against real Postgres.
    const res = await post('/agent-tools/available-slots', {
      tenant_id: tenantId,
      service_type: 'totally unknown spoken thing',
      date: shiftDate,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });
});
