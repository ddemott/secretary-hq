/**
 * Real-DB guard: the two rules a booking system does not get to break.
 *
 * 5W:
 *   WHO  — every caller who books by phone, on every tenant
 *   WHAT — book_with_scheduling_atomic refuses a start time in the past, and
 *          refuses to write an appointment with no person on it
 *   WHEN — every booking; these are invariants, not edge cases
 *   WHERE— migration 20260909210000_booking_rules_past_and_person.sql
 *   WHY  — Dale, 2026-09-09: "you can't book in the past, that should be a given
 *          and a rule that we abide by", and "you can't book an appointment with
 *          a resource that doesn't exist." Neither was enforced. The past-time
 *          check existed only in book_appointment_atomic, which production does
 *          not call — proved by booking 1:00 PM against PRODUCTION at 6:52 PM the
 *          same day and getting an appointment_id back. And employee_id is
 *          nullable with the RPC's candidate initialised to NULL, so the
 *          fall-open path could write an appointment nobody is attending.
 *
 * WHY REAL POSTGRES: both rules live inside a plpgsql function. A mocked pool
 * would only prove the mock returns what the test told it to.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Client } from 'pg';
import { getRootClient, skipIfDbDown } from '../utils';

let setup: Client;
let dbAvailable = false;
let tenantId: string;
let employeeId: string;

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    dbAvailable = true;
  } catch (err) {
    console.warn('[bookingRules.realdb] DB not available, skipping', err);
    return;
  }

  const t = await setup.query<{ tenant_id: string }>(
    `INSERT INTO tenants (name, business_type, timezone)
     VALUES ('Booking Rules Fixture', 'local-service', 'America/Chicago')
     RETURNING tenant_id`
  );
  tenantId = t.rows[0].tenant_id;

  await setup.query(
    `INSERT INTO resources (tenant_id, name, is_active) VALUES ($1, 'Room 1', true)`,
    [tenantId]
  );
  const e = await setup.query<{ employee_id: string }>(
    `INSERT INTO employees (tenant_id, name, is_active) VALUES ($1, 'Ada Fixture', true)
     RETURNING employee_id`,
    [tenantId]
  );
  employeeId = e.rows[0].employee_id;

  // A shift covering 09:00-23:00 local for the next 3 days, so coverage is never
  // the reason a booking in these tests fails.
  for (let d = 0; d < 3; d++) {
    await setup.query(
      `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
       VALUES ($1, $2, (now() AT TIME ZONE 'America/Chicago')::date + ($3 || ' days')::interval, '09:00', '23:00', false)`,
      [tenantId, employeeId, d]
    );
  }
});

afterAll(async () => {
  if (!dbAvailable) {
    if (setup) await setup.end();
    return;
  }
  await setup.query('DELETE FROM appointments WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM employee_schedule WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM employees WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM resources WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM customers WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [tenantId]);
  await setup.end();
});

beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

/** Book via the production RPC. `startsInMinutes` is relative to now. */
async function book(startsInMinutes: number) {
  const res = await setup.query<{
    success: boolean;
    error_code: string | null;
    employee_id: string | null;
  }>(
    `SELECT success, error_code, employee_id FROM book_with_scheduling_atomic(
       p_tenant_id => $1,
       p_phone => '+15555550123',
       p_customer_name => 'Fixture Caller',
       p_window_from => date_trunc('hour', now()) + ($2 || ' minutes')::interval,
       p_window_to   => date_trunc('hour', now()) + ($2 || ' minutes')::interval + interval '30 minutes',
       p_duration_minutes => 30
     )`,
    [tenantId, startsInMinutes]
  );
  return res.rows[0];
}

/**
 * Book a FIXED slot: `hour`:00-:30 on local day `dayOffset`. For tests whose
 * point is not "now" — a slot pinned inside the fixture's 09:00-23:00 shift
 * passes at any hour of the day the suite happens to run.
 */
async function bookAt(dayOffset: number, hour: number) {
  const res = await setup.query<{
    success: boolean;
    error_code: string | null;
    employee_id: string | null;
  }>(
    `SELECT success, error_code, employee_id FROM book_with_scheduling_atomic(
       p_tenant_id => $1,
       p_phone => '+15555550127',
       p_customer_name => 'Fixed Slot Caller',
       p_window_from => date_trunc('day', now() AT TIME ZONE 'America/Chicago')::timestamptz
                        + ($2 || ' days')::interval + ($3 || ' hours')::interval,
       p_window_to   => date_trunc('day', now() AT TIME ZONE 'America/Chicago')::timestamptz
                        + ($2 || ' days')::interval + ($3 || ' hours')::interval + interval '30 minutes',
       p_duration_minutes => 30
     )`,
    [tenantId, dayOffset, hour]
  );
  return res.rows[0];
}

describe('you cannot book in the past', () => {
  it('SAD: a start time hours ago is refused with PAST_TIME', async () => {
    // The production repro: 1:00 PM booked at 6:52 PM, same day, succeeded.
    const r = await book(-360);
    expect(r.success).toBe(false);
    expect(r.error_code).toBe('PAST_TIME');
  });

  it('SAD: even one hour ago is refused — shift coverage cannot catch this', async () => {
    // An hour ago is still inside the fixture's 09:00-23:00 shift, so every
    // coverage test passes. Only an explicit clock check refuses it.
    const r = await book(-60);
    expect(r.error_code).toBe('PAST_TIME');
  });

  it('HAPPY: a future time books normally', async () => {
    // A FIXED slot tomorrow, not "two hours from now". The now-relative version
    // passed only while now+2h fell inside the fixture's 09:00-23:00 shift, and
    // failed when run at 00:51 CT (2026-09-11). A wall-clock test is a deploy
    // outage waiting for a CI run at the wrong hour.
    const r = await bookAt(1, 15);
    expect(r.success).toBe(true);
    expect(r.employee_id).toBe(employeeId);
  });

  it('HAPPY: one minute of grace — a start 30 seconds ago is NOT refused as past', async () => {
    // "One o'clock" said at 12:59:40 means the slot about to start. Refusing on a
    // rounding edge would be its own defect; the grace matches the shift-boundary
    // slack shipped the same day.
    //
    // HOW THIS IS ASSERTED: 30 seconds ago is not on the quarter-hour grid, so the
    // booking gets PAST the clock check and then dies at the INSERT on
    // appointments_end_time_15min. That constraint error is the proof — the
    // past-time guard returns BEFORE any insert, so reaching the constraint at all
    // means the guard did not fire. A PAST_TIME result would surface as a returned
    // row, not a thrown constraint violation.
    //
    // THIS ONE MUST BE "NOW", so it cannot also demand that the booking reach the
    // INSERT: that needs a shift covering the current minute, and the fixture's
    // 09:00-23:00 shift does not at night — run at 00:51 CT (2026-09-11) it got a
    // returned EMPLOYEE_NOT_SCHEDULED instead of the constraint, and failed.
    //
    // What the test is FOR is "not refused as past". The past-time guard runs
    // before coverage (the 2-minutes-ago half below proves it returns PAST_TIME
    // even where coverage would also fail), so ANY outcome other than PAST_TIME
    // means the guard let it through: the constraint by day, a coverage refusal
    // by night. Both halves together pin the boundary at every hour.
    const attempt = async (ago: string, phone: string): Promise<string> => {
      try {
        const res = await setup.query<{ error_code: string | null }>(
          `SELECT error_code FROM book_with_scheduling_atomic(
             p_tenant_id => $1,
             p_phone => $3,
             p_customer_name => 'Grace Caller',
             p_window_from => now() - $2::interval,
             p_window_to => now() - $2::interval + interval '30 minutes',
             p_duration_minutes => 30
           )`,
          [tenantId, ago, phone]
        );
        return res.rows[0].error_code ?? 'BOOKED';
      } catch (err) {
        // Reaching the INSERT is only acceptable as the quarter-hour grid refusal.
        expect(String(err)).toMatch(/appointments_(start|end)_time_15min/);
        return 'REACHED_INSERT';
      }
    };
    expect(await attempt('30 seconds', '+15555550125')).not.toBe('PAST_TIME');
    expect(await attempt('2 minutes', '+15555550129')).toBe('PAST_TIME');
  });
});

describe('an appointment is with somebody', () => {
  it('SAD: a tenant with no active staff cannot be booked at all', async () => {
    // Bella's Hair Studio sat in exactly this state in production: 0 active
    // employees, 0 schedule rows, 1 resource. The fall-open path would have
    // written an appointment with employee_id NULL — a customer, a time, a room,
    // and nobody to meet them.
    const empty = await setup.query<{ tenant_id: string }>(
      `INSERT INTO tenants (name, business_type, timezone)
       VALUES ('No Staff Fixture', 'local-service', 'America/Chicago')
       RETURNING tenant_id`
    );
    const emptyId = empty.rows[0].tenant_id;
    await setup.query(
      `INSERT INTO resources (tenant_id, name, is_active) VALUES ($1, 'Room 1', true)`,
      [emptyId]
    );
    try {
      const res = await setup.query<{ success: boolean; error_code: string | null }>(
        `SELECT success, error_code FROM book_with_scheduling_atomic(
           p_tenant_id => $1,
           p_phone => '+15555550124',
           p_customer_name => 'Fixture Caller',
           p_window_from => date_trunc('hour', now()) + interval '2 hours',
           p_window_to => date_trunc('hour', now()) + interval '2 hours 30 minutes',
           p_duration_minutes => 30
         )`,
        [emptyId]
      );
      expect(res.rows[0].success).toBe(false);
      expect(res.rows[0].error_code).toBe('NO_SKILLED_EMPLOYEE');

      const written = await setup.query(
        'SELECT count(*) AS n FROM appointments WHERE tenant_id = $1',
        [emptyId]
      );
      expect(Number(written.rows[0].n)).toBe(0);
    } finally {
      await setup.query('DELETE FROM appointments WHERE tenant_id = $1', [emptyId]);
      await setup.query('DELETE FROM customers WHERE tenant_id = $1', [emptyId]);
      await setup.query('DELETE FROM resources WHERE tenant_id = $1', [emptyId]);
      await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [emptyId]);
    }
  });

  it('every appointment this RPC writes names a real, active employee', async () => {
    // Fixed slot, same reason as the future-time case: now+3h left the shift at night.
    const r = await bookAt(1, 17);
    expect(r.success).toBe(true);
    const who = await setup.query<{ name: string; is_active: boolean }>(
      `SELECT e.name, e.is_active FROM appointments a
         JOIN employees e ON e.employee_id = a.employee_id
        WHERE a.tenant_id = $1 AND a.employee_id = $2 LIMIT 1`,
      [tenantId, r.employee_id]
    );
    expect(who.rows[0].is_active).toBe(true);
    expect(who.rows[0].name).toBe('Ada Fixture');
  });
});

describe('the person must actually be working', () => {
  // Dale, 2026-09-09: "make sure the person is scheduled to be working. If they
  // are on vacation they can't take the meeting."
  //
  // employee_schedule carries one dated row per shift with an is_off flag, so
  // "on vacation" is either is_off = true for that date or no row at all. Both
  // must refuse, and — the part that matters most — a caller who ASKED for that
  // person must not be silently handed somebody else.

  /** Book at a fixed 2-hours-out slot, optionally demanding a specific person. */
  async function bookOn(dayOffset: number, preferred?: string) {
    const res = await setup.query<{
      success: boolean;
      error_code: string | null;
      employee_id: string | null;
    }>(
      `SELECT success, error_code, employee_id FROM book_with_scheduling_atomic(
         p_tenant_id => $1,
         p_phone => '+15555550126',
         p_customer_name => 'Vacation Case',
         p_window_from => date_trunc('day', now() AT TIME ZONE 'America/Chicago')::timestamptz
                          + ($2 || ' days')::interval + interval '15 hours',
         p_window_to   => date_trunc('day', now() AT TIME ZONE 'America/Chicago')::timestamptz
                          + ($2 || ' days')::interval + interval '15 hours 30 minutes',
         p_duration_minutes => 30,
         p_preferred_employee_id => $3
       )`,
      [tenantId, dayOffset, preferred ?? null]
    );
    return res.rows[0];
  }

  it('SAD: the only employee is OFF that day → nothing is booked', async () => {
    // Day 2 of the fixture: flip the shift to is_off, the way a vacation day is
    // recorded, and the booking must fail rather than land on an absent person.
    await setup.query(
      `UPDATE employee_schedule SET is_off = true
         WHERE tenant_id = $1
           AND shift_date = (now() AT TIME ZONE 'America/Chicago')::date + interval '2 days'`,
      [tenantId]
    );
    try {
      const r = await bookOn(2);
      expect(r.success).toBe(false);
      expect(r.error_code).toBe('NO_SKILLED_EMPLOYEE');
    } finally {
      await setup.query(
        `UPDATE employee_schedule SET is_off = false
           WHERE tenant_id = $1
             AND shift_date = (now() AT TIME ZONE 'America/Chicago')::date + interval '2 days'`,
        [tenantId]
      );
    }
  });

  it('SAD: a day with NO shift row at all is refused too', async () => {
    // The fixture only schedules 3 days. Day 5 has no row, so nobody is working.
    const r = await bookOn(5);
    expect(r.success).toBe(false);
  });

  it('SAD: asking for a person who is off does NOT silently hand you someone else', async () => {
    // The failure this prevents: a caller asks for a named person, that person is
    // on vacation, and the RPC quietly assigns whoever is free — so the agent
    // confirms a meeting with someone the caller never agreed to see.
    const other = await setup.query<{ employee_id: string }>(
      `INSERT INTO employees (tenant_id, name, is_active) VALUES ($1, 'Bo Standin', true)
       RETURNING employee_id`,
      [tenantId]
    );
    const otherId = other.rows[0].employee_id;
    await setup.query(
      `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
       VALUES ($1, $2, (now() AT TIME ZONE 'America/Chicago')::date + interval '2 days', '09:00', '23:00', false)`,
      [tenantId, otherId]
    );
    await setup.query(
      `UPDATE employee_schedule SET is_off = true
         WHERE tenant_id = $1 AND employee_id = $2
           AND shift_date = (now() AT TIME ZONE 'America/Chicago')::date + interval '2 days'`,
      [tenantId, employeeId]
    );
    try {
      // Bo IS available that day, so an unqualified booking would succeed —
      // but the caller asked for the employee who is off.
      const asked = await bookOn(2, employeeId);
      expect(asked.success).toBe(false);
      expect(asked.employee_id).toBeNull();

      // Proof that the day itself was bookable: without a preference, Bo takes it.
      const anyone = await bookOn(2);
      expect(anyone.success).toBe(true);
      expect(anyone.employee_id).toBe(otherId);
    } finally {
      await setup.query('DELETE FROM appointments WHERE tenant_id = $1', [tenantId]);
      await setup.query('DELETE FROM employee_schedule WHERE employee_id = $1', [otherId]);
      await setup.query('DELETE FROM employees WHERE employee_id = $1', [otherId]);
      await setup.query(
        `UPDATE employee_schedule SET is_off = false WHERE tenant_id = $1 AND employee_id = $2`,
        [tenantId, employeeId]
      );
    }
  });
});
