/**
 * Tests for Fix #30 (night shifts) and #32 (check_availability_with_tz employee_schedule)
 * Happy + sad paths with 5W diagnostic context.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { type Client } from 'pg';
import {
  getRootClient,
  clearDB,
  createTenant,
  createEmployee,
  createScheduleEntry,
  createResource,
  createCustomer,
  createAppointment,
  createService,
  assignEmployeeToService,
  beginTestTransaction,
  rollbackTestTransaction,
  skipIfDbDown,
} from '../utils';

describe('Fix #30: Night shifts (cross-midnight)', () => {
  let client: Client;
  let tenantId: string;
  let employeeId: string;
  let dbAvailable = false;
  beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

  beforeAll(async () => {
    try {
      client = await getRootClient();
      const res = await client.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'employee_schedule')"
      );
      if (!res.rows[0].exists) {
        console.warn('[night-shift] employee_schedule table missing, skipping DB tests');
        return;
      }
      await clearDB(client);
      tenantId = await createTenant(client, 'Night Shift Co', 'auto-repair', 'America/Chicago');
      await createResource(client, tenantId, 'Bay 1');
      employeeId = await createEmployee(client, tenantId, 'Night Worker', ['repair']);
      dbAvailable = true;
    } catch (err) {
      console.warn('[night-shift] DB not available:', err);
    }
  });

  afterAll(async () => {
    if (dbAvailable && client) await client.end();
  });

  beforeEach(async () => {
    if (dbAvailable) await beginTestTransaction(client);
  });

  afterEach(async () => {
    if (dbAvailable) await rollbackTestTransaction(client);
  });

  it('HAPPY: booking succeeds during night shift (23:00-06:00) at 1am', async () => {
    // WHO: Employee working 23:00-06:00 night shift
    // WHAT: Booking at 1am should succeed (within shift)
    // WHY: Night shifts cross midnight — time comparison must handle start > end
    if (!dbAvailable) return;

    // Schedule a night shift for 2030-05-27. Booking RPCs read
    // employee_schedule directly.
    await createScheduleEntry(client, tenantId, employeeId, '2030-05-27', '23:00', '06:00');

    // Book at 1am Tuesday (but shift started Monday night)
    // Use Monday 23:30 to be within the shift
    const result = await client.query(
      "SELECT * FROM book_with_scheduling_atomic($1, '+15551110001', 'Night Test', 'Night repair', NULL, NULL, $2::TIMESTAMPTZ, $3::TIMESTAMPTZ, NULL, NULL, '{repair}', '{}', NULL, NULL, NULL, 30)",
      [tenantId, '2030-05-27T23:30:00-05:00', '2030-05-28T00:00:00-05:00']
    );

    expect(result.rows[0].success).toBe(true);

    // Cleanup
    if (result.rows[0].appointment_id) {
      await client.query('DELETE FROM appointments WHERE appointment_id = $1', [
        result.rows[0].appointment_id,
      ]);
    }
  });

  it('HAPPY: normal day shift (8-5) still works correctly', async () => {
    // WHO: Employee with standard 8am-5pm shift
    // WHAT: Booking at 10am should succeed
    // WHY: Night shift logic must not break normal shifts
    if (!dbAvailable) return;

    await createScheduleEntry(client, tenantId, employeeId, '2030-05-27', '08:00', '17:00');

    const result = await client.query(
      "SELECT * FROM book_with_scheduling_atomic($1, '+15551110002', 'Day Test', 'Day repair', NULL, NULL, $2::TIMESTAMPTZ, $3::TIMESTAMPTZ, NULL, NULL, '{repair}', '{}', NULL, NULL, NULL, 30)",
      [tenantId, '2030-05-27T10:00:00-05:00', '2030-05-27T10:30:00-05:00']
    );

    expect(result.rows[0].success).toBe(true);

    if (result.rows[0].appointment_id) {
      await client.query('DELETE FROM appointments WHERE appointment_id = $1', [
        result.rows[0].appointment_id,
      ]);
    }
  });

  it('HAPPY (20260911010000): the MORNING HALF of a night shift can be booked', async () => {
    // WHO: Employee working 22:00-06:00 every day, schedule row dated the
    //      evening it starts (2030-05-27).
    // WHAT: Booking at 02:00 the NEXT calendar day (2030-05-28) should
    //       succeed — that's the wrapped tail of the 05-27 shift.
    // WHY: Found 2026-09-11 (docs/planning/TODO.md) — coverage used to be
    //      matched on the SLOT's own local date, so a shift that started the
    //      previous evening was never consulted for anything after
    //      midnight. shift_row_covers_booking() (20260911010000) is what
    //      makes this reachable: the JOIN now also looks at yesterday's row,
    //      and only a wrapping night shift's tail counts.
    if (!dbAvailable) return;

    await createScheduleEntry(client, tenantId, employeeId, '2030-05-27', '22:00', '06:00');

    const result = await client.query(
      "SELECT * FROM book_with_scheduling_atomic($1, '+15551110004', 'Morning Half', 'Post-midnight repair', NULL, NULL, $2::TIMESTAMPTZ, $3::TIMESTAMPTZ, NULL, NULL, '{repair}', '{}', NULL, NULL, NULL, 30)",
      [tenantId, '2030-05-28T02:00:00-05:00', '2030-05-28T02:30:00-05:00']
    );

    expect(result.rows[0].success).toBe(true);
    expect(result.rows[0].error_message).toBeNull();

    if (result.rows[0].appointment_id) {
      await client.query('DELETE FROM appointments WHERE appointment_id = $1', [
        result.rows[0].appointment_id,
      ]);
    }
  });

  it('SAD (20260911010000): a DAY shift never gains cross-day coverage', async () => {
    // WHO: Employee with a normal 08:00-17:00 day shift dated 2030-05-27.
    // WHAT: Booking at 02:00 the NEXT day (2030-05-28) must still fail —
    //       a day shift (end > start) is not a wrapping shift, so
    //       shift_row_covers_booking() must refuse the previous-day row.
    // WHY: Pins the boundary of the fix — only a genuine overnight shift's
    //      tail should ever reach into the next calendar day.
    if (!dbAvailable) return;

    await createScheduleEntry(client, tenantId, employeeId, '2030-05-27', '08:00', '17:00');

    const result = await client.query(
      "SELECT * FROM book_with_scheduling_atomic($1, '+15551110005', 'No Cross Day', 'Should fail', NULL, NULL, $2::TIMESTAMPTZ, $3::TIMESTAMPTZ, NULL, NULL, '{repair}', '{}', NULL, $4, NULL, 30)",
      [tenantId, '2030-05-28T02:00:00-05:00', '2030-05-28T02:30:00-05:00', employeeId]
    );

    expect(result.rows[0].success).toBe(false);
  });

  it('SAD: booking outside night shift hours fails', async () => {
    // WHO: Employee with 22:00-06:00 shift
    // WHAT: Booking at 2pm should fail (outside shift)
    // WHY: Night shift employees are only available during their shift
    if (!dbAvailable) return;

    // Schedule the night shift for 2030-05-27 (Monday). Booking at 2pm
    // local should still fail because 2pm is outside 22:00-06:00.
    await createScheduleEntry(client, tenantId, employeeId, '2030-05-27', '22:00', '06:00');

    const result = await client.query(
      "SELECT * FROM book_with_scheduling_atomic($1, '+15551110003', 'Out of range', 'Fail test', NULL, NULL, $2::TIMESTAMPTZ, $3::TIMESTAMPTZ, NULL, NULL, '{repair}', '{}', NULL, $4, NULL, 30)",
      [tenantId, '2030-05-27T14:00:00-05:00', '2030-05-27T14:30:00-05:00', employeeId]
    );

    expect(result.rows[0].success).toBe(false);
  });
});

describe('Fix #32: check_availability_with_tz with employee_schedule', () => {
  let client: Client;
  let tenantId: string;
  let resourceId: string;
  let employeeId: string;
  let dbAvailable = false;
  beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

  beforeAll(async () => {
    try {
      client = await getRootClient();
      const res = await client.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'employee_schedule')"
      );
      if (!res.rows[0].exists) {
        console.warn('[availability] employee_schedule table missing, skipping DB tests');
        return;
      }
      tenantId = await createTenant(client, 'Avail Check Co', 'auto-repair', 'America/Chicago');
      resourceId = await createResource(client, tenantId, 'Bay A');
      employeeId = await createEmployee(client, tenantId, 'Checker', ['oil']);
      dbAvailable = true;
    } catch (err) {
      console.warn('[availability] DB not available:', err);
    }
  });

  afterAll(async () => {
    if (dbAvailable && client) await client.end();
  });

  beforeEach(async () => {
    if (dbAvailable) await beginTestTransaction(client);
  });

  afterEach(async () => {
    if (dbAvailable) await rollbackTestTransaction(client);
  });

  it('HAPPY: available when resource free AND employee on shift', async () => {
    // WHO: Resource with no bookings, employee on shift
    // WHAT: check_availability_with_tz should return available=true
    // WHY: Both conditions met — slot is bookable
    if (!dbAvailable) return;

    await createScheduleEntry(client, tenantId, employeeId, '2030-05-27', '08:00', '17:00');

    const result = await client.query(
      "SELECT * FROM check_availability_with_tz($1, $2, '2030-05-27T10:00:00-05:00'::TIMESTAMPTZ, '2030-05-27T10:30:00-05:00'::TIMESTAMPTZ)",
      [tenantId, resourceId]
    );

    expect(result.rows[0].available).toBe(true);
  });

  it('SAD: unavailable when resource is booked (appointment overlap)', async () => {
    // WHO: Resource with existing appointment at the requested time
    // WHAT: Should return available=false
    // WHY: Resource conflict
    if (!dbAvailable) return;

    await createScheduleEntry(client, tenantId, employeeId, '2030-05-27', '08:00', '17:00');
    const custId = await createCustomer(client, tenantId, 'Existing', '+15559990001');
    await createAppointment(
      client,
      tenantId,
      resourceId,
      custId,
      '2030-05-27T10:00:00-05:00',
      '2030-05-27T11:00:00-05:00',
      'Existing booking'
    );

    const result = await client.query(
      "SELECT * FROM check_availability_with_tz($1, $2, '2030-05-27T10:00:00-05:00'::TIMESTAMPTZ, '2030-05-27T10:30:00-05:00'::TIMESTAMPTZ)",
      [tenantId, resourceId]
    );

    expect(result.rows[0].available).toBe(false);
  });

  it('SAD: unavailable when no employee_schedule row exists for the date', async () => {
    // WHO: Date with no schedule rows
    // WHAT: Should return available=false (no staff)
    // WHY: Resource is free but nobody is working that date
    if (!dbAvailable) return;

    // Seed a Monday-only schedule and check Saturday — no Saturday row.
    await createScheduleEntry(client, tenantId, employeeId, '2030-05-27', '08:00', '17:00');

    const result = await client.query(
      "SELECT * FROM check_availability_with_tz($1, $2, '2030-06-01T10:00:00-05:00'::TIMESTAMPTZ, '2030-06-01T10:30:00-05:00'::TIMESTAMPTZ)",
      [tenantId, resourceId]
    );

    expect(result.rows[0].available).toBe(false);
  });

  it('SAD: unavailable when employee has an is_off schedule entry for that date', async () => {
    // WHO: Employee whose date-specific schedule says is_off=true
    // WHAT: Should return available=false
    // WHY: is_off rows mark the employee as not working on that date
    if (!dbAvailable) return;

    await client.query(
      "INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, is_off) VALUES ($1, $2, '2030-05-27', true)",
      [tenantId, employeeId]
    );

    const result = await client.query(
      "SELECT * FROM check_availability_with_tz($1, $2, '2030-05-27T10:00:00-05:00'::TIMESTAMPTZ, '2030-05-27T10:30:00-05:00'::TIMESTAMPTZ)",
      [tenantId, resourceId]
    );

    expect(result.rows[0].available).toBe(false);
  });

  it('HAPPY: available when override provides coverage on normally-off day', async () => {
    // WHO: Employee with Saturday override (normally off)
    // WHAT: Should return available=true
    // WHY: Override adds coverage for that specific date
    if (!dbAvailable) return;

    await client.query(
      "INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time) VALUES ($1, $2, '2030-06-01', '09:00', '13:00')",
      [tenantId, employeeId]
    );

    const result = await client.query(
      "SELECT * FROM check_availability_with_tz($1, $2, '2030-06-01T10:00:00-05:00'::TIMESTAMPTZ, '2030-06-01T10:30:00-05:00'::TIMESTAMPTZ)",
      [tenantId, resourceId]
    );

    expect(result.rows[0].available).toBe(true);
  });

  it('HAPPY: returns correct timezone in response', async () => {
    // WHO: Tenant with America/Chicago timezone
    // WHAT: Should return timezone info in response
    // WHY: Caller needs timezone for display
    if (!dbAvailable) return;

    await createScheduleEntry(client, tenantId, employeeId, '2030-05-27', '08:00', '17:00');

    const result = await client.query(
      "SELECT * FROM check_availability_with_tz($1, $2, '2030-05-27T10:00:00-05:00'::TIMESTAMPTZ, '2030-05-27T10:30:00-05:00'::TIMESTAMPTZ)",
      [tenantId, resourceId]
    );

    expect(result.rows[0].tenant_timezone).toBe('America/Chicago');
    expect(result.rows[0].local_start).toContain('10:00');
  });

  it("HAPPY (20260913): available during the morning half of a night shift (yesterday's row)", async () => {
    // WHO: caller asking about 2:00 AM, an employee scheduled 22:00->06:00
    //      the evening BEFORE (row dated 2030-08-19).
    // WHAT: check_availability_with_tz must find yesterday's wrapping row
    //       and say available=true — before this fix it only ever looked
    //       for a row dated the SAME day as the request.
    if (!dbAvailable) return;

    await createScheduleEntry(client, tenantId, employeeId, '2030-08-19', '22:00', '06:00');

    const result = await client.query(
      "SELECT * FROM check_availability_with_tz($1, $2, '2030-08-20T02:00:00-05:00'::TIMESTAMPTZ, '2030-08-20T02:30:00-05:00'::TIMESTAMPTZ)",
      [tenantId, resourceId]
    );

    expect(result.rows[0].available).toBe(true);
  });

  it("SAD (20260913): a day shift dated yesterday still never covers today's early morning", async () => {
    // Pins the boundary: only a genuine wrapping shift's tail reaches
    // tomorrow — a plain day shift dated yesterday still refuses.
    if (!dbAvailable) return;

    await createScheduleEntry(client, tenantId, employeeId, '2030-08-21', '08:00', '17:00');

    const result = await client.query(
      "SELECT * FROM check_availability_with_tz($1, $2, '2030-08-22T02:00:00-05:00'::TIMESTAMPTZ, '2030-08-22T02:30:00-05:00'::TIMESTAMPTZ)",
      [tenantId, resourceId]
    );

    expect(result.rows[0].available).toBe(false);
  });
});

describe('Fix (20260913): check_coverage_gaps night-shift awareness', () => {
  let client: Client;
  let tenantId: string;
  let serviceId: string;
  let employeeId: string;
  let dbAvailable = false;
  beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

  beforeAll(async () => {
    try {
      client = await getRootClient();
      tenantId = await createTenant(client, 'Coverage Gaps Co', 'auto-repair', 'UTC');
      serviceId = await createService(client, tenantId, 'Overnight Service', 30);
      employeeId = await createEmployee(client, tenantId, 'Night Shift Nadia');
      await assignEmployeeToService(client, tenantId, serviceId, employeeId);
      dbAvailable = true;
    } catch (err) {
      console.warn('[coverage-gaps night-shift] DB not available:', err);
    }
  });

  afterAll(async () => {
    if (dbAvailable && client) await client.end();
  });

  beforeEach(async () => {
    if (dbAvailable) await beginTestTransaction(client);
  });

  afterEach(async () => {
    if (dbAvailable) await rollbackTestTransaction(client);
  });

  it('HAPPY: a night shift (22:00->06:00) reads as covered on BOTH sides of midnight', async () => {
    // WHO: the dashboard coverage bars / Setup Wizard dry-run
    // WHAT: an employee_schedule row dated 2027-09-01, 22:00->06:00, must
    //       show hours 22-23 covered on 2027-09-01 AND hours 0-5 covered on
    //       2027-09-02 — the pre-fix version showed ALL of it as a gap:
    //       even the same-day evening hours read as uncovered (naive
    //       start<=hr<end comparison doesn't know end<start means "wraps",
    //       not "backwards"), and the morning hours were never checked
    //       against yesterday's row at all.
    if (!dbAvailable) return;

    await createScheduleEntry(client, tenantId, employeeId, '2027-09-01', '22:00', '06:00');

    const result = await client.query(
      `SELECT check_date, gap_hours, covered_hours FROM check_coverage_gaps($1, '2027-09-01'::date, '2027-09-02'::date) ORDER BY check_date`,
      [tenantId]
    );

    expect(result.rows).toHaveLength(2);
    const day1 = result.rows.find((r) => r.check_date.toISOString().startsWith('2027-09-01'));
    const day2 = result.rows.find((r) => r.check_date.toISOString().startsWith('2027-09-02'));
    expect(day1.gap_hours).toEqual([]);
    expect(day1.covered_hours).toEqual([22, 23]);
    expect(day2.gap_hours).toEqual([]);
    expect(day2.covered_hours).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('SAD: hour 23 of a plain DAY shift is still covered (no regression from the night-shift fix)', async () => {
    // Pins the boundary the fix itself almost broke: framing each hour as
    // a synthetic hr:00->hr+1:00 slot and running it through
    // shift_row_covers_booking() makes hour 23's synthetic slot wrap into
    // the next day, and that function's DAY-shift branch treats ANY
    // wrapping slot as never covered — which would have shown hour 23 as
    // a gap for every ordinary late-closing shift. Caught before shipping;
    // pinned here so it can't come back.
    if (!dbAvailable) return;

    await createScheduleEntry(client, tenantId, employeeId, '2027-09-03', '08:00', '23:59');

    const result = await client.query(
      `SELECT check_date, gap_hours, covered_hours FROM check_coverage_gaps($1, '2027-09-03'::date, '2027-09-03'::date)`,
      [tenantId]
    );

    expect(result.rows[0].gap_hours).toEqual([]);
    expect(result.rows[0].covered_hours).toEqual([
      8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
  });

  it('SAD: a day shift dated yesterday does not leak coverage into the morning', async () => {
    if (!dbAvailable) return;

    await createScheduleEntry(client, tenantId, employeeId, '2027-09-05', '08:00', '17:00');

    const result = await client.query(
      `SELECT check_date, gap_hours, covered_hours FROM check_coverage_gaps($1, '2027-09-06'::date, '2027-09-06'::date)`,
      [tenantId]
    );

    // No shift on the 6th at all → nothing open, nothing covered, nothing
    // gapped (an unstaffed hour is only a "gap" relative to open_hours).
    expect(result.rows[0].covered_hours).toEqual([]);
    expect(result.rows[0].gap_hours).toEqual([]);
  });
});

describe('Fix (20260913): book_appointment_atomic (dashboard path) — night shift', () => {
  // The phone path (book_with_scheduling_atomic) got shift_row_covers_booking()
  // in 20260911010000; the dashboard path was named a deliberate, separate gap
  // in CLAUDE.md/TODO ("has never modeled night shifts by design"). Same fix,
  // same shape, different RPC.
  let client: Client;
  let tenantId: string;
  let employeeId: string;
  let resourceId: string;
  let customerId: string;
  let dbAvailable = false;
  beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

  beforeAll(async () => {
    try {
      client = await getRootClient();
      tenantId = await createTenant(
        client,
        'Dashboard Night Shift Co',
        'auto-repair',
        'America/Chicago'
      );
      resourceId = await createResource(client, tenantId, 'Bay 1');
      employeeId = await createEmployee(client, tenantId, 'Night Worker', ['repair']);
      customerId = await createCustomer(client, tenantId, 'Nina', '+15551119999');
      dbAvailable = true;
    } catch (err) {
      console.warn('[book_appointment_atomic night-shift] DB not available:', err);
    }
  });

  afterAll(async () => {
    if (dbAvailable && client) await client.end();
  });

  beforeEach(async () => {
    if (dbAvailable) await beginTestTransaction(client);
  });

  afterEach(async () => {
    if (dbAvailable) await rollbackTestTransaction(client);
  });

  it('HAPPY: the morning half of a night shift can be booked via the dashboard path', async () => {
    // WHO: a dashboard owner manually booking Night Worker.
    // WHAT: a shift dated 2030-05-27 22:00-06:00 covers a 2:00-2:30 AM
    //       booking on 2030-05-28 (the wrapped tail).
    // WHY: pre-fix, book_appointment_atomic only ever looked for a row dated
    //      the booking's OWN date and refused with "not on shift" here.
    if (!dbAvailable) return;

    await createScheduleEntry(client, tenantId, employeeId, '2030-05-27', '22:00', '06:00');

    const result = await client.query(
      `SELECT * FROM book_appointment_atomic($1, $2, $3, $4::TIMESTAMPTZ, $5::TIMESTAMPTZ, $6, $7, NULL, $8)`,
      [
        tenantId,
        resourceId,
        customerId,
        '2030-05-28T02:00:00-05:00',
        '2030-05-28T02:30:00-05:00',
        'Post-midnight repair',
        'call_dash_night_001',
        employeeId,
      ]
    );

    expect(result.rows[0].success).toBe(true);
    expect(result.rows[0].error_message).toBeNull();
  });

  it('SAD: a day shift dated yesterday still never covers today (dashboard path)', async () => {
    // Pins the boundary: only a genuine wrapping shift's tail reaches
    // tomorrow — a plain day shift dated yesterday still refuses.
    if (!dbAvailable) return;

    await createScheduleEntry(client, tenantId, employeeId, '2030-05-27', '08:00', '17:00');

    const result = await client.query(
      `SELECT * FROM book_appointment_atomic($1, $2, $3, $4::TIMESTAMPTZ, $5::TIMESTAMPTZ, $6, $7, NULL, $8)`,
      [
        tenantId,
        resourceId,
        customerId,
        '2030-05-28T02:00:00-05:00',
        '2030-05-28T02:30:00-05:00',
        'Should fail',
        'call_dash_night_002',
        employeeId,
      ]
    );

    expect(result.rows[0].success).toBe(false);
    expect(result.rows[0].error_message).toBe('Employee is not on shift during this time');
  });

  it('HAPPY: a normal day shift booking still works (no regression)', async () => {
    if (!dbAvailable) return;

    await createScheduleEntry(client, tenantId, employeeId, '2030-05-27', '08:00', '17:00');

    const result = await client.query(
      `SELECT * FROM book_appointment_atomic($1, $2, $3, $4::TIMESTAMPTZ, $5::TIMESTAMPTZ, $6, $7, NULL, $8)`,
      [
        tenantId,
        resourceId,
        customerId,
        '2030-05-27T10:00:00-05:00',
        '2030-05-27T10:30:00-05:00',
        'Day repair',
        'call_dash_day_001',
        employeeId,
      ]
    );

    expect(result.rows[0].success).toBe(true);
  });

  it('SAD: a booking exactly N weeks long (same weekday, different date) is still refused', async () => {
    // WHO: a dashboard owner fat-fingering an end date.
    // WHAT: 2030-05-27 (Monday) 10:00 -> 2030-06-03 (the FOLLOWING Monday)
    //       10:30 — same weekday at both ends, 7 calendar days apart.
    // WHY: Copilot review on PR #444 — the multi-day guard compared
    //      EXTRACT(DOW), which only detects a WEEKDAY change. A booking any
    //      whole number of weeks long lands on the same weekday at both
    //      ends and slipped straight through, undermining the very
    //      single-calendar-day assumption the night-shift coverage check
    //      below it relies on. Fixed to compare the local DATE directly.
    if (!dbAvailable) return;

    const result = await client.query(
      `SELECT * FROM book_appointment_atomic($1, $2, $3, $4::TIMESTAMPTZ, $5::TIMESTAMPTZ, $6, $7, NULL, $8)`,
      [
        tenantId,
        resourceId,
        customerId,
        '2030-05-27T10:00:00-05:00',
        '2030-06-03T10:30:00-05:00',
        'Should fail — spans a full week',
        'call_dash_dow_bug_001',
        employeeId,
      ]
    );

    expect(result.rows[0].success).toBe(false);
    expect(result.rows[0].error_message).toBe(
      'Appointment spans multiple days and cannot be validated against shifts'
    );
  });
});
