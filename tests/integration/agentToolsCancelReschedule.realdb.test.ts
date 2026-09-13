/**
 * Real-DB companion for the cancel / reschedule agent tools.
 *
 * Motivation (docs/TEST_DB_AUDIT.md): the mocked agentToolsCancel /
 * reschedule suites prove the handler shape, not the SQL. But these two
 * handlers lean entirely on multi-condition SQL that only real Postgres
 * enforces — a JOIN to customers for phone-ownership, `status='scheduled'`,
 * `start_time > NOW()`, the `is_deleted` filter, and (reschedule) the GiST
 * exclusion constraint surfacing as 23P01. A mock returns whatever rows you
 * tell it to; it can't catch a phone-ownership hole or a missing is_deleted
 * clause. This suite drives the REAL route → REAL Postgres and asserts the
 * stored row.
 *
 * Strategy mirrors agentToolsBookingIntegration.test.ts: real pg.Pool on
 * API_DB_URL (api_user, RLS-scoped) + registerAgentToolRoutes on a throwaway
 * Fastify app, driven via x-agent-secret. Fixtures per-suite, cleaned in
 * afterAll (test-isolation rule). Skips when the DB is down; hard-fails under
 * REQUIRE_DB_TESTS=1 (CI).
 *
 * 5W for sad-path failures:
 *   WHO  — the voice agent acting for a live caller who wants to change a booking
 *   WHAT — POST /agent-tools/{cancel,reschedule}-appointment
 *   WHEN — mid-call, caller gives their phone + the appointment
 *   WHERE — agentTools.ts UPDATE … FROM customers … WHERE c.phone = $ (ownership)
 *   WHY  — a phone-ownership hole lets one caller cancel/move ANOTHER caller's
 *          appointment; a missing is_deleted/past-time guard mutates rows that
 *          should be untouchable
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { type Client, Pool } from 'pg';
import {
  API_DB_URL,
  getRootClient,
  createTenant,
  createResource,
  createCustomerFull,
  createAppointment,
  createEmployee,
  createScheduleEntry,
  createService,
  assignEmployeeToService,
  assignResourceToService,
  skipIfDbDown,
} from '../utils';
import { createWithTenantClient } from '../../src/database';
import { registerAgentToolRoutes } from '../../src/routes/agentTools';

const AGENT_SECRET = 'test-cancel-reschedule-secret';
// Capture any pre-existing value so afterAll restores it instead of blindly
// deleting — avoids clobbering an AGENT_SECRET set by the environment or a
// sibling suite that runs later in the same process.
let prevAgentSecret: string | undefined;
const stubEmbedding = (): Promise<number[]> => Promise.resolve(new Array(1536).fill(0));
const stubNormalizer = async (text: string): Promise<string> => text;

// The endpoint normalizes the caller-supplied phone (normalizePhone) before
// matching customers.phone, and real customers are ALWAYS stored normalized
// (the booking path normalizes before insert). So fixtures are seeded in
// E.164 while the tool is called with the raw spoken form — mirroring prod.
const OWNER_PHONE_RAW = '5557770001';
const OWNER_PHONE_E164 = '+15557770001';
const OTHER_PHONE_RAW = '5557770002';
const OTHER_PHONE_E164 = '+15557770002';

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
let tenantId: string;
let resourceId: string;
let ownerCustomerId: string;
const tenantsToClean: string[] = [];

function post(path: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'x-agent-secret': AGENT_SECRET },
    payload,
  });
}

/** ISO instant N hours from now, snapped to a 15-min boundary (the
 *  appointments_end_time_15min check constraint rejects arbitrary times). */
function hoursFromNow(h: number): string {
  const QUARTER = 900_000;
  const t = Math.round((Date.now() + h * 3_600_000) / QUARTER) * QUARTER;
  return new Date(t).toISOString();
}

async function apptRow(
  appointmentId: string
): Promise<{ status: string; start_time: Date } | undefined> {
  const res = await setup.query(
    `SELECT status, start_time FROM appointments WHERE appointment_id = $1`,
    [appointmentId]
  );
  return res.rows[0];
}

/** Create a scheduled appointment for the owner customer at [from,to]. */
async function ownerAppt(fromIso: string, toIso: string): Promise<string> {
  return createAppointment(
    setup,
    tenantId,
    resourceId,
    ownerCustomerId,
    fromIso,
    toIso,
    'owner appt'
  );
}

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });
    prevAgentSecret = process.env.AGENT_SECRET;
    process.env.AGENT_SECRET = AGENT_SECRET;

    app = Fastify({ logger: false });
    const withTenantClient = createWithTenantClient(pool);
    registerAgentToolRoutes(app, pool, withTenantClient, stubEmbedding, stubNormalizer);
    await app.ready();

    tenantId = await createTenant(setup, 'Cancel/Reschedule Salon', 'salon');
    tenantsToClean.push(tenantId);
    resourceId = await createResource(setup, tenantId, 'Chair 1');
    ownerCustomerId = await createCustomerFull(setup, tenantId, OWNER_PHONE_E164, 'Owner Olive');
    // A second caller exists so the phone-ownership tests use a REAL other
    // customer (not just an unknown number).
    await createCustomerFull(setup, tenantId, OTHER_PHONE_E164, 'Other Otto');

    dbAvailable = true;
  } catch (err) {
    console.warn('[agentToolsCancelReschedule.realdb.test] DB not available, skipping', err);
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
  if (prevAgentSecret === undefined) delete process.env.AGENT_SECRET;
  else process.env.AGENT_SECRET = prevAgentSecret;
});

beforeEach((ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
});

describe('cancel-appointment → real DB', () => {
  it('HAPPY: owner cancels their own future scheduled appointment → status=canceled', async () => {
    const id = await ownerAppt(hoursFromNow(48), hoursFromNow(49));
    const res = await post('/agent-tools/cancel-appointment', {
      tenant_id: tenantId,
      phone: OWNER_PHONE_RAW,
      appointment_id: id,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect((await apptRow(id))!.status).toBe('canceled');
  });

  it('SECURITY: a different caller CANNOT cancel — appointment stays scheduled', async () => {
    // WHY: the JOIN customers … c.phone = $ clause is the only thing stopping
    // one caller from canceling another's appointment. If it regressed, this
    // would flip to canceled — a real cross-caller tampering hole.
    const id = await ownerAppt(hoursFromNow(50), hoursFromNow(51));
    const res = await post('/agent-tools/cancel-appointment', {
      tenant_id: tenantId,
      phone: OTHER_PHONE_RAW,
      appointment_id: id,
    });
    expect(res.json().success).toBe(false);
    expect((await apptRow(id))!.status).toBe('scheduled');
  });

  it('SAD: a past appointment is not cancelable (start_time > NOW guard)', async () => {
    const id = await ownerAppt(hoursFromNow(-49), hoursFromNow(-48));
    const res = await post('/agent-tools/cancel-appointment', {
      tenant_id: tenantId,
      phone: OWNER_PHONE_RAW,
      appointment_id: id,
    });
    expect(res.json().success).toBe(false);
    // Untouched — still whatever it was (scheduled), not flipped.
    expect((await apptRow(id))!.status).toBe('scheduled');
  });

  it('SAD: a soft-deleted appointment is invisible to cancel (is_deleted filter)', async () => {
    const id = await ownerAppt(hoursFromNow(52), hoursFromNow(53));
    await setup.query(`UPDATE appointments SET is_deleted = true WHERE appointment_id = $1`, [id]);
    const res = await post('/agent-tools/cancel-appointment', {
      tenant_id: tenantId,
      phone: OWNER_PHONE_RAW,
      appointment_id: id,
    });
    expect(res.json().success).toBe(false);
  });
});

describe('reschedule-appointment → real DB', () => {
  it('HAPPY: owner moves their appointment to a new future time → row shows new start', async () => {
    const id = await ownerAppt(hoursFromNow(60), hoursFromNow(61));
    const newFrom = hoursFromNow(72);
    const newTo = hoursFromNow(73);
    const res = await post('/agent-tools/reschedule-appointment', {
      tenant_id: tenantId,
      phone: OWNER_PHONE_RAW,
      appointment_id: id,
      new_start_time: newFrom,
      new_end_time: newTo,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect((await apptRow(id))!.start_time.toISOString()).toBe(newFrom);
  });

  it('SECURITY: a different caller CANNOT reschedule — original time unchanged', async () => {
    const originalFrom = hoursFromNow(80);
    const id = await ownerAppt(originalFrom, hoursFromNow(81));
    const res = await post('/agent-tools/reschedule-appointment', {
      tenant_id: tenantId,
      phone: OTHER_PHONE_RAW,
      appointment_id: id,
      new_start_time: hoursFromNow(90),
      new_end_time: hoursFromNow(91),
    });
    expect(res.json().success).toBe(false);
    expect((await apptRow(id))!.start_time.toISOString()).toBe(originalFrom);
  });

  it('SAD: rescheduling to a past time is rejected, original unchanged', async () => {
    const originalFrom = hoursFromNow(96);
    const id = await ownerAppt(originalFrom, hoursFromNow(97));
    const res = await post('/agent-tools/reschedule-appointment', {
      tenant_id: tenantId,
      phone: OWNER_PHONE_RAW,
      appointment_id: id,
      new_start_time: hoursFromNow(-2),
      new_end_time: hoursFromNow(-1),
    });
    expect(res.json().success).toBe(false);
    expect((await apptRow(id))!.start_time.toISOString()).toBe(originalFrom);
  });

  it('SAD: rescheduling onto an occupied slot (same resource) → GiST 23P01 → friendly error, original unchanged', async () => {
    // WHERE: appointments_no_resource_overlap. Two scheduled appts on the
    // same chair; moving A onto B's window must be refused by the DB and
    // surfaced as a clean "already booked" message, NOT a 500 or a silent
    // overlap. A's time must stay put.
    const aFrom = hoursFromNow(100);
    const a = await ownerAppt(aFrom, hoursFromNow(101));
    const bFrom = hoursFromNow(104);
    const bTo = hoursFromNow(105);
    await ownerAppt(bFrom, bTo); // B occupies the target slot
    const res = await post('/agent-tools/reschedule-appointment', {
      tenant_id: tenantId,
      phone: OWNER_PHONE_RAW,
      appointment_id: a,
      new_start_time: bFrom,
      new_end_time: bTo,
    });
    expect(res.json().success).toBe(false);
    expect(String(res.json().error).toLowerCase()).toContain('booked');
    expect((await apptRow(a))!.start_time.toISOString()).toBe(aFrom);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// reschedule_appointment_atomic() (20260913020000) — the raw UPDATE this
// route used to run had NO re-validation against blackout dates, shift
// coverage, or the STRICT skill-map, unlike the booking RPCs. This tenant is
// created with the default UTC timezone (createTenant with no tz arg,
// tenants.timezone DEFAULT 'UTC'), so the literal Z timestamps below ARE the
// tenant-local wall clock — no offset arithmetic needed. Dates are fixed,
// far-future (2027), and distinct per test so they never collide with the
// hoursFromNow(...)-based fixtures above on the shared `resourceId`.
// ─────────────────────────────────────────────────────────────────────────
describe('reschedule-appointment → business-rule guards (real DB)', () => {
  it('SAD: rescheduling onto a blackout date is refused (BUSINESS_CLOSED)', async () => {
    const blackoutDate = '2027-04-12';
    await setup.query(
      `INSERT INTO blackout_dates (tenant_id, blackout_date, reason) VALUES ($1, $2::date, 'Test holiday')`,
      [tenantId, blackoutDate]
    );
    try {
      const originalFrom = hoursFromNow(120);
      const id = await ownerAppt(originalFrom, hoursFromNow(121));
      const res = await post('/agent-tools/reschedule-appointment', {
        tenant_id: tenantId,
        phone: OWNER_PHONE_RAW,
        appointment_id: id,
        new_start_time: `${blackoutDate}T10:00:00.000Z`,
        new_end_time: `${blackoutDate}T11:00:00.000Z`,
      });
      expect(res.json().success).toBe(false);
      expect(String(res.json().error)).toMatch(/closed/i);
      expect((await apptRow(id))!.start_time.toISOString()).toBe(originalFrom);
    } finally {
      await setup.query(
        `DELETE FROM blackout_dates WHERE tenant_id = $1 AND blackout_date = $2::date`,
        [tenantId, blackoutDate]
      );
    }
  });

  it('SAD: rescheduling an employee-assigned appointment onto an unstaffed time is refused (EMPLOYEE_NOT_SCHEDULED)', async () => {
    const employeeId = await createEmployee(setup, tenantId, 'Unscheduled Eddie');
    const originalFrom = hoursFromNow(130);
    const id = await createAppointment(
      setup,
      tenantId,
      resourceId,
      ownerCustomerId,
      originalFrom,
      hoursFromNow(131),
      'owner appt with employee',
      undefined,
      employeeId
    );
    // Deliberately NO employee_schedule row on 2027-04-15 — nobody is on shift.
    const res = await post('/agent-tools/reschedule-appointment', {
      tenant_id: tenantId,
      phone: OWNER_PHONE_RAW,
      appointment_id: id,
      new_start_time: '2027-04-15T10:00:00.000Z',
      new_end_time: '2027-04-15T11:00:00.000Z',
    });
    expect(res.json().success).toBe(false);
    expect(String(res.json().error)).toMatch(/not on shift/i);
    expect((await apptRow(id))!.start_time.toISOString()).toBe(originalFrom);
  });

  it('HAPPY: rescheduling into the morning half of a night shift succeeds (night-shift aware)', async () => {
    // WHO: an owner-assigned employee who works 22:00->06:00, schedule row
    //      dated 2027-04-19 (the evening it starts).
    // WHAT: moving the appointment to 2027-04-20 02:00-02:30 — the wrapped
    //       tail of the 04-19 shift — must succeed via
    //       shift_row_covers_booking(), the same fix already proven for
    //       get_available_slots and book_appointment_atomic.
    const employeeId = await createEmployee(setup, tenantId, 'Night Shift Nadia');
    await createScheduleEntry(setup, tenantId, employeeId, '2027-04-19', '22:00', '06:00');
    const originalFrom = hoursFromNow(140);
    const id = await createAppointment(
      setup,
      tenantId,
      resourceId,
      ownerCustomerId,
      originalFrom,
      hoursFromNow(141),
      'owner appt, night shift employee',
      undefined,
      employeeId
    );
    const res = await post('/agent-tools/reschedule-appointment', {
      tenant_id: tenantId,
      phone: OWNER_PHONE_RAW,
      appointment_id: id,
      new_start_time: '2027-04-20T02:00:00.000Z',
      new_end_time: '2027-04-20T02:30:00.000Z',
    });
    expect(res.json().success).toBe(true);
    expect((await apptRow(id))!.start_time.toISOString()).toBe('2027-04-20T02:00:00.000Z');
  });

  it('SAD: rescheduling is refused once the service is unlinked from its resource (NO_SKILLED_RESOURCE)', async () => {
    const serviceId = await createService(setup, tenantId, 'Guarded Service', 30, 0);
    const guardedResourceId = await createResource(setup, tenantId, 'Guarded Chair');
    const employeeId = await createEmployee(setup, tenantId, 'Skill Map Sam');
    await assignEmployeeToService(setup, tenantId, serviceId, employeeId);
    await assignResourceToService(setup, tenantId, serviceId, guardedResourceId);

    const originalFrom = hoursFromNow(150);
    const insertRes = await setup.query<{ appointment_id: string }>(
      `INSERT INTO appointments (tenant_id, resource_id, customer_id, employee_id, service_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'owner appt, linked service', 'scheduled')
       RETURNING appointment_id`,
      [
        tenantId,
        guardedResourceId,
        ownerCustomerId,
        employeeId,
        serviceId,
        originalFrom,
        hoursFromNow(151),
      ]
    );
    const id = insertRes.rows[0].appointment_id;

    // The business reconfigures: this resource no longer performs this service.
    await setup.query(
      `DELETE FROM service_resource WHERE tenant_id = $1 AND service_id = $2 AND resource_id = $3`,
      [tenantId, serviceId, guardedResourceId]
    );

    const res = await post('/agent-tools/reschedule-appointment', {
      tenant_id: tenantId,
      phone: OWNER_PHONE_RAW,
      appointment_id: id,
      new_start_time: '2027-04-25T10:00:00.000Z',
      new_end_time: '2027-04-25T10:30:00.000Z',
    });
    expect(res.json().success).toBe(false);
    expect(String(res.json().error)).toMatch(/no longer set up/i);
    expect((await apptRow(id))!.start_time.toISOString()).toBe(originalFrom);
  });
});
