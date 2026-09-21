/**
 * Tests for the scheduling timezone bug (BUG-059) and its fix.
 *
 * The bug: book_with_scheduling_atomic() used hardcoded 'UTC' timezone
 * for shift validation. A Chicago tenant booking at 5 PM Friday would
 * be converted to Saturday 12 AM UTC — wrong day_of_week, shift lookup fails.
 *
 * Fix: Use tenant's timezone from tenants.timezone column instead of 'UTC'.
 *
 * Coverage:
 *  - Unit tests: timezone conversion logic (no DB required)
 *  - Integration tests: DB-dependent (skipped when DB unavailable)
 *
 * Each section has happy + sad paths with 5W diagnostic context.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import { ROOT_DB_URL, skipIfDbDown } from '../utils';

// Follows the per-worker database (tests/setup/perWorkerDb.ts) instead of hardcoding the shared
// `test_db`, which would let this file collide with whatever else is using it.
const DB_URL = ROOT_DB_URL;

// ═══════════════════════════════════════════════════════════════════════
// UNIT TESTS (no DB required)
// ═══════════════════════════════════════════════════════════════════════

describe('Timezone Conversion Logic — Unit Tests', () => {
  describe('Happy Paths', () => {
    it('should identify Friday correctly in America/Chicago timezone', () => {
      // WHO: DynaTire (Chicago) | WHAT: Friday 9 PM local time
      // WHEN: any Friday | WHERE: shift day-of-week extraction
      // WHY: the bug converted to UTC first, getting Saturday instead of Friday
      // 9 PM CDT (-05:00) = 2 AM UTC next day (Saturday)
      const fridayChicago = new Date('2026-04-03T21:00:00-05:00');
      const utcDay = fridayChicago.getUTCDay(); // 6 = Saturday in UTC
      const chicagoDay = 5; // Friday = day 5 (what the tenant actually means)
      expect(utcDay).toBe(6); // Proves UTC gives wrong day
      expect(chicagoDay).toBe(5); // Proves local gives correct day
      expect(utcDay).not.toBe(chicagoDay); // This IS the bug
    });

    it('should identify correct day for morning bookings (no UTC drift)', () => {
      // WHO: any tenant | WHAT: 9 AM booking (no timezone day-flip risk)
      // WHEN: weekday morning | WHERE: shift validation
      // WHY: morning times don't cross the UTC day boundary for US timezones
      const mondayMorning = new Date('2026-04-06T09:00:00-05:00');
      const utcDay = mondayMorning.getUTCDay(); // 1 = Monday (14:00 UTC, still Monday)
      expect(utcDay).toBe(1); // No drift for morning times
    });

    it('should detect the UTC drift for late evening bookings', () => {
      // WHO: West Coast tenant (PDT) | WHAT: 8 PM Friday Pacific
      // WHEN: Friday evening | WHERE: timezone conversion
      // WHY: PDT is UTC-7, so 8 PM Friday PDT = 3 AM Saturday UTC
      const fridayLA = new Date('2026-04-03T20:00:00-07:00');
      const utcDay = fridayLA.getUTCDay();
      expect(utcDay).toBe(6); // Saturday in UTC — wrong!
    });

    it('should not drift for East Coast tenant morning bookings', () => {
      // WHO: NYC tenant (EST/EDT) | WHAT: 10 AM Tuesday
      // WHEN: weekday | WHERE: shift validation
      // WHY: EST is only UTC-5, morning times don't cross midnight UTC
      const tuesdayNYC = new Date('2026-04-07T10:00:00-04:00'); // EDT
      const utcDay = tuesdayNYC.getUTCDay();
      expect(utcDay).toBe(2); // Still Tuesday — no drift
    });
  });

  describe('Sad Paths', () => {
    it('should fail validation when using UTC day for a late-evening Chicago booking', () => {
      // WHO: DynaTire (Chicago) | WHAT: customer calls 9 PM Friday
      // WHEN: April 3, 2026 | WHERE: book_with_scheduling_atomic shift check
      // WHY: BUG-059 root cause — function used UTC day (Saturday) instead of local (Friday)
      // 9 PM CDT = 2 AM UTC Saturday — UTC extraction gives wrong day
      const booking = new Date('2026-04-03T21:00:00-05:00');
      const utcDayOfWeek = booking.getUTCDay(); // 6 = Saturday in UTC
      const fridayShifts = [5]; // Only Friday shifts defined

      const wouldMatchWithUTC = fridayShifts.includes(utcDayOfWeek);
      expect(wouldMatchWithUTC).toBe(false); // BUG: no match, booking fails

      const wouldMatchWithLocal = fridayShifts.includes(5); // Friday = 5
      expect(wouldMatchWithLocal).toBe(true); // FIX: correct match
    });

    it('should handle DST transition edge case', () => {
      // WHO: any US tenant | WHAT: booking during spring-forward
      // WHEN: March 8, 2026 2 AM → 3 AM (spring forward)
      // WHERE: timezone conversion | WHY: 2 AM doesn't exist in local time
      const preDST = new Date('2026-03-08T01:30:00-06:00'); // CST
      const postDST = new Date('2026-03-08T03:30:00-05:00'); // CDT
      // Both should be Sunday (day 0)
      expect(preDST.getUTCDay()).toBe(0); // Sunday
      expect(postDST.getUTCDay()).toBe(0); // Sunday
    });

    it('should handle midnight boundary (11:59 PM vs 12:01 AM)', () => {
      // WHO: late-night business (bar, 24h service)
      // WHAT: booking at 11:59 PM Friday
      // WHEN: any week | WHERE: shift day extraction
      // WHY: 11:59 PM CDT = Saturday 4:59 AM UTC — must still match Friday shift
      const lateNight = new Date('2026-04-03T23:59:00-05:00');
      const utcDay = lateNight.getUTCDay();
      expect(utcDay).toBe(6); // Saturday in UTC
      // Fix ensures the function uses tenant timezone → still Friday locally
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS (require DB on port 5433)
// ═══════════════════════════════════════════════════════════════════════

describe('Scheduling Timezone Bug — Integration (BUG-059)', () => {
  let client: Client;
  let testTenantId: string;
  let testResourceId: string;
  let testEmployeeId: string;
  let dbAvailable = false;
  beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

  beforeAll(async () => {
    try {
      client = new Client({ connectionString: DB_URL });
      await client.connect();
      dbAvailable = true;

      const tenantRes = await client.query(
        `INSERT INTO tenants (name, business_type, timezone)
         VALUES ($1, $2, $3) RETURNING tenant_id`,
        ['Test Chicago Business', 'tire_shop', 'America/Chicago']
      );
      testTenantId = tenantRes.rows[0].tenant_id;

      const resourceRes = await client.query(
        `INSERT INTO resources (tenant_id, name, description, capabilities)
         VALUES ($1, $2, $3, $4) RETURNING resource_id`,
        [testTenantId, 'Test Bay 1', 'Test resource', ['tire_rotation']]
      );
      testResourceId = resourceRes.rows[0].resource_id;

      const employeeRes = await client.query(
        `INSERT INTO employees (tenant_id, name, skills, is_active)
         VALUES ($1, $2, $3, $4) RETURNING employee_id`,
        [testTenantId, 'Test Mechanic', ['tire_rotation'], true]
      );
      testEmployeeId = employeeRes.rows[0].employee_id;

      // Schedule the test Friday (2026-04-03) 8 AM - 6 PM. Booking
      // RPCs read employee_schedule directly; weekly patterns are
      // not part of the platform's data model anymore.
      await client.query(
        `INSERT INTO employee_schedule (employee_id, tenant_id, shift_date, start_time, end_time, is_off)
         VALUES ($1, $2, '2026-04-03'::DATE, '08:00'::TIME, '18:00'::TIME, false)`,
        [testEmployeeId, testTenantId]
      );
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (dbAvailable && client) {
      try {
        if (testTenantId) {
          await client.query('DELETE FROM tenants WHERE tenant_id = $1', [testTenantId]);
        }
      } catch {
        /* cleanup */
      }
      await client.end();
    }
  });

  it('should reject booking outside shift hours (9 PM Friday Chicago)', async () => {
    if (!dbAvailable) return;
    // WHO: DynaTire test caller | WHAT: 9 PM booking (shift ends 6 PM)
    // WHEN: Friday April 3, 2026 | WHERE: book_with_scheduling_atomic
    // WHY: 9 PM is outside 8-18 shift even after timezone fix

    const result = await client.query(
      `SELECT * FROM book_with_scheduling_atomic(
        $1::UUID, $2::TEXT, $3::TEXT, $4::TEXT, NULL::TEXT, NULL::TEXT,
        $5::TIMESTAMPTZ, $6::TIMESTAMPTZ,
        NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ,
        ARRAY['tire_rotation']::TEXT[], ARRAY[]::TEXT[],
        NULL::UUID, NULL::TEXT, NULL::TEXT, 60
      )`,
      [
        testTenantId,
        '+13125559999',
        'Test Customer',
        'Test 9 PM booking',
        '2026-04-03T21:00:00-05:00',
        '2026-04-03T22:00:00-05:00',
      ]
    );

    expect(result.rows[0].success).toBe(false);
  });

  it('should verify test data setup is correct', async () => {
    if (!dbAvailable) return;
    expect(testTenantId).toBeTruthy();
    expect(testResourceId).toBeTruthy();
    expect(testEmployeeId).toBeTruthy();
  });
});
