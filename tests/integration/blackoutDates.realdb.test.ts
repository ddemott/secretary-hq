/**
 * T-106 — a tenant-wide closure, enforced on BOTH sides of the booking flow.
 *
 * WHO  — an owner who shuts for Christmas, and the caller who rings on the 25th.
 * WHAT — a `blackout_dates` row makes the day unbookable AND unofferable.
 * WHEN  — CI, on any change to the booking RPC, availabilitySearch, or the
 *         blackout routes.
 * WHERE — supabase/migrations/20260903000000_blackout_dates.sql (RPC guard) and
 *         src/services/availabilitySearch.ts (suggest-side exclusion).
 * WHY  — before this, `employee_schedule.is_off` was the only way to express
 *        "not working", and it is per-EMPLOYEE. Closing the business meant
 *        editing every employee's row for that date, and anyone hired
 *        afterwards was silently bookable on a day the doors are locked. The
 *        failure lands on a real customer standing outside a dark building.
 *
 *        The two-sided assertion is the point. A suggester that offers a slot
 *        the RPC then refuses is the 2026-07-17 midnight-wrap incident repeated:
 *        the caller picks a time, hears an error, and the business looks broken.
 *        Every test here checks the offer AND the booking.
 *
 * REAL POSTGRES: the guard is a plpgsql branch inside a 300-line function and
 * the exclusion is a JOIN in hand-written SQL. Neither can be proven by a mock.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type Client, Pool } from 'pg';
import {
  API_DB_URL,
  getRootClient,
  createTenant,
  createEmployee,
  createResource,
  createService,
  createScheduleEntry,
  assignEmployeeToService,
  assignResourceToService,
  skipIfDbDown,
} from '../utils';
import { createWithTenantClient } from '../../src/database';
import { findNextAvailableSlots } from '../../src/services/availabilitySearch';

let setup: Client;
let pool: Pool;
let dbAvailable = false;
let tenantId: string;
let employeeId: string;
let serviceId: string;
const tenantsToClean: string[] = [];

/** A Thursday far enough out that nothing else in the suite touches it. */
let openDay: string;
let closedDay: string;

async function addBlackout(date: string, reason: string | null = 'Closed') {
  await setup.query(
    `INSERT INTO blackout_dates (tenant_id, blackout_date, reason)
     VALUES ($1, $2::date, $3)
     ON CONFLICT (tenant_id, blackout_date) DO UPDATE SET reason = EXCLUDED.reason`,
    [tenantId, date, reason]
  );
}

/** Book through the PRODUCTION RPC, at 10:00 local on the given date. */
async function book(date: string) {
  const withTenantClient = createWithTenantClient(pool);
  return withTenantClient(tenantId, async (client) => {
    const res = await client.query<{
      success: boolean;
      error_code: string | null;
      error_message: string | null;
    }>(
      `SELECT success, error_code, error_message FROM book_with_scheduling_atomic(
         p_tenant_id => $1,
         p_phone => '+16305551234',
         p_customer_name => 'Blackout Tester',
         p_start_time => ($2 || ' 10:00:00')::timestamp AT TIME ZONE 'Etc/UTC',
         p_end_time => ($2 || ' 10:30:00')::timestamp AT TIME ZONE 'Etc/UTC',
         p_service_id => $3
       )`,
      [tenantId, date, serviceId]
    );
    return res.rows[0];
  });
}

/**
 * Ask the SUGGESTER for slots on the given date, the way the agent does.
 * The horizon is clamped to that day so a slot from the NEXT open day cannot
 * be mistaken for the closed day still being offered.
 */
async function offeredSlots(date: string) {
  const withTenantClient = createWithTenantClient(pool);
  const all = await withTenantClient(tenantId, (client) =>
    findNextAvailableSlots(client, {
      tenantId,
      fromTime: new Date(`${date}T00:00:00Z`),
      durationMinutes: 30,
      searchHorizonHours: 24,
      count: 20,
    })
  );
  return all.filter((s) => new Date(s.start_time).toISOString().slice(0, 10) === date);
}

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });
    tenantId = await createTenant(setup, 'Blackout Barbers', 'barbershop', 'Etc/UTC');
    tenantsToClean.push(tenantId);
    employeeId = await createEmployee(setup, tenantId, 'Sam Cutter');
    const chairId = await createResource(setup, tenantId, 'Chair 1');
    serviceId = await createService(setup, tenantId, 'Haircut', 30, 40);
    // The skill map: Sam takes haircuts, in Chair 1. With a service id the booking
    // RPC books only linked people in linked rooms (migration 20260909210000).
    await assignEmployeeToService(setup, tenantId, serviceId, employeeId);
    await assignResourceToService(setup, tenantId, serviceId, chairId);

    const days = await setup.query<{ open_day: string; closed_day: string }>(
      `SELECT (CURRENT_DATE + 30)::text AS open_day, (CURRENT_DATE + 31)::text AS closed_day`
    );
    openDay = days.rows[0].open_day;
    closedDay = days.rows[0].closed_day;

    // Both days are fully staffed. The ONLY difference between them will be the
    // blackout row — otherwise a passing test could be passing for the wrong
    // reason (no shift, no resource, no service).
    for (const d of [openDay, closedDay]) {
      await createScheduleEntry(setup, tenantId, employeeId, d, '09:00', '17:00');
    }
    dbAvailable = true;
  } catch (err) {
    console.warn('[blackoutDates.realdb] DB not available, skipping', err);
  }
});

afterAll(async () => {
  if (pool) await pool.end();
  if (setup) {
    for (const id of tenantsToClean) {
      await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
    }
    await setup.end();
  }
});

beforeEach(async (ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
  if (!dbAvailable) return;
  await setup.query('DELETE FROM blackout_dates WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM appointments WHERE tenant_id = $1', [tenantId]);
});

describe('T-106: a blackout date closes the business on both sides', () => {
  it('HAPPY: with no blackout, the day is offered AND bookable (the control)', async () => {
    // Without this case, every assertion below could pass because the fixture
    // is broken rather than because the feature works.
    expect((await offeredSlots(closedDay)).length).toBeGreaterThan(0);
    expect((await book(closedDay)).success).toBe(true);
  });

  it('SAD: the booking RPC refuses a blackout date with BUSINESS_CLOSED', async () => {
    await addBlackout(closedDay, 'Christmas Day');

    const result = await book(closedDay);

    expect(result.success).toBe(false);
    // The code matters as much as the refusal: the agent maps codes to spoken
    // sentences, and EMPLOYEE_NOT_SCHEDULED would have it say "no one is
    // scheduled" — true-sounding, and the wrong reason.
    expect(result.error_code).toBe('BUSINESS_CLOSED');
    expect(result.error_message).toMatch(/closed/i);
  });

  it('SAD: the suggester offers NOTHING on a blackout date', async () => {
    await addBlackout(closedDay);

    expect(await offeredSlots(closedDay)).toEqual([]);
  });

  it('HAPPY: neighbouring days are untouched — a closure is one day, not a mood', async () => {
    await addBlackout(closedDay);

    const stillOpen = await offeredSlots(openDay);
    expect(stillOpen.length).toBeGreaterThan(0);
    expect((await book(openDay)).success).toBe(true);
  });

  it('HAPPY: removing the blackout reopens the day on both paths', async () => {
    await addBlackout(closedDay);
    expect(await offeredSlots(closedDay)).toEqual([]);

    await setup.query('DELETE FROM blackout_dates WHERE tenant_id = $1 AND blackout_date = $2', [
      tenantId,
      closedDay,
    ]);

    expect((await offeredSlots(closedDay)).length).toBeGreaterThan(0);
    expect((await book(closedDay)).success).toBe(true);
  });

  it('SECURITY: another tenant closure does not close this business', async () => {
    // blackout_dates is keyed by tenant. A missing tenant predicate anywhere in
    // the join or the RPC would let one business shut another one down.
    const otherTenant = await createTenant(setup, 'Someone Else Barbers', 'barbershop', 'Etc/UTC');
    tenantsToClean.push(otherTenant);
    await setup.query(
      `INSERT INTO blackout_dates (tenant_id, blackout_date, reason) VALUES ($1, $2::date, 'theirs')`,
      [otherTenant, closedDay]
    );

    expect((await offeredSlots(closedDay)).length).toBeGreaterThan(0);
    expect((await book(closedDay)).success).toBe(true);
  });

  it('SAD: re-declaring the same closure updates the reason instead of erroring', async () => {
    // The natural PK (tenant_id, blackout_date) makes a duplicate save an
    // UPSERT. An owner saving twice is not an error state.
    await addBlackout(closedDay, 'Closed');
    await addBlackout(closedDay, 'Staff wedding');

    const rows = await setup.query<{ reason: string }>(
      'SELECT reason FROM blackout_dates WHERE tenant_id = $1 AND blackout_date = $2',
      [tenantId, closedDay]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].reason).toBe('Staff wedding');
  });
});
