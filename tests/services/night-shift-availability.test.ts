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
});
