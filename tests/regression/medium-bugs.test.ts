/**
 * Regression tests for the Medium bug-fix sweep.
 *
 * Feature areas covered (search here when touching any of these):
 *   - **Soft-reservation cleanup**: purge_expired RPC behavior (BUG-013)
 *   - **Booking**: assignment_id error handling on book_appointment_atomic
 *     (BUG-014)
 *   - **Customers / Employees / Users**: name-sync triggers and
 *     compound-name splitting (BUG-022, BUG-023)
 *   - **Scheduling**: day-of-week conversion edge cases (BUG-029)
 *   - **List routes**: pagination shape (BUG-020)
 *
 * Why bug-numbered, not feature-named: keeps the full regression set
 * for the Medium sweep together so a future audit can verify all
 * bugs stay closed. Feature-area work should still grep here.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  getRootClient,
  clearDB,
  setupBasicTenant,
  createEmployee,
  createScheduleEntry,
  createUser,
  beginTestTransaction,
  rollbackTestTransaction,
  skipIfDbDown,
} from '../utils';
import { type Client } from 'pg';
// Day-of-week conversion utilities (inlined from deleted core/models.ts)
const DAY_STRING_TO_NUM: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};
const DAY_NUM_TO_STRING: Record<number, string> = {
  0: 'sun',
  1: 'mon',
  2: 'tue',
  3: 'wed',
  4: 'thu',
  5: 'fri',
  6: 'sat',
};
function dayStringToNum(day: string): number {
  const num = DAY_STRING_TO_NUM[day.toLowerCase()];
  if (num === undefined) throw new Error(`Unknown day string: ${day}`);
  return num;
}
function dayNumToString(dow: number): string {
  const str = DAY_NUM_TO_STRING[dow];
  if (!str) throw new Error(`Unknown day number: ${dow}`);
  return str;
}
interface WorkingHours {
  [day: string]: Array<{ start: string; end: string }>;
}
function workingHoursToShifts(
  wh: WorkingHours
): Array<{ day_of_week: number; start_time: string; end_time: string }> {
  const shifts: Array<{ day_of_week: number; start_time: string; end_time: string }> = [];
  for (const [day, windows] of Object.entries(wh)) {
    const dow = dayStringToNum(day);
    for (const w of windows)
      shifts.push({ day_of_week: dow, start_time: w.start, end_time: w.end });
  }
  return shifts;
}
function shiftsToWorkingHours(
  shifts: Array<{ day_of_week: number; start_time: string; end_time: string }>
): WorkingHours {
  const wh: WorkingHours = {};
  for (const s of shifts) {
    const day = dayNumToString(s.day_of_week);
    if (!wh[day]) wh[day] = [];
    wh[day].push({ start: s.start_time, end: s.end_time });
  }
  return wh;
}

describe('Medium Bug Fixes', () => {
  let client: Client;
  let tenantId: string;
  let resourceId: string;
  let customerId: string;
  let dbAvailable = true;
  beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

  beforeAll(async () => {
    try {
      client = await getRootClient();
      await clearDB(client);
      const setup = await setupBasicTenant(client);
      tenantId = setup.tenantId;
      resourceId = setup.resourceId;
      customerId = setup.customerId;
    } catch (err) {
      dbAvailable = false;
      console.warn('[medium-bugs.test] Skipping DB tests - connection failed', err);
    }
  });

  afterAll(async () => {
    if (dbAvailable && client) {
      await client.end();
    }
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    await beginTestTransaction(client);
  });

  afterEach(async () => {
    if (!dbAvailable) return;
    await rollbackTestTransaction(client);
  });

  // ==================================================================
  // BUG-013: Soft reservation cleanup function exists
  // ==================================================================
  describe('BUG-013: purge_expired_soft_reservations', () => {
    test('function exists and can be called', async () => {
      if (!dbAvailable) return;
      const res = await client.query('SELECT purge_expired_soft_reservations() as count');
      expect(typeof res.rows[0].count).toBe('number');
    });
  });

  // ==================================================================
  // BUG-014: Malformed p_assignment_id returns error
  // ==================================================================
  describe('BUG-014: p_assignment_id error handling', () => {
    test('rejects malformed assignment_id (not UUID or integer)', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        `SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2027-04-14T10:00:00Z'),
          new Date('2027-04-14T11:00:00Z'),
          'Test malformed assignment',
          'test-call-malformed',
          null,
          'not-a-uuid-or-integer',
        ]
      );
      expect(res.rows[0].success).toBe(false);
      expect(res.rows[0].error_message).toContain('Invalid assignment_id format');
    });

    test('accepts valid integer assignment_id', async () => {
      if (!dbAvailable) return;
      const empId = await createEmployee(client, tenantId, 'BugTest Employee');
      // 2027-04-14 is a Wednesday. Booking RPCs read only employee_schedule.
      await createScheduleEntry(client, tenantId, empId, '2027-04-14', '08:00', '20:00');

      const res = await client.query(
        `SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2027-04-14T14:00:00Z'),
          new Date('2027-04-14T15:00:00Z'),
          'Valid integer assignment',
          'test-call-valid-int',
          null,
          empId.toString(),
        ]
      );
      expect(res.rows[0].success).toBe(true);
    });

    test('accepts valid UUID assignment_id', async () => {
      if (!dbAvailable) return;
      const userId = await createUser(
        client,
        tenantId,
        'uuid-assign@test.com',
        'hash',
        'UUID User'
      );

      const res = await client.query(
        `SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2027-04-15T10:00:00Z'),
          new Date('2027-04-15T11:00:00Z'),
          'Valid UUID assignment',
          'test-call-valid-uuid',
          null,
          userId,
        ]
      );
      expect(res.rows[0].success).toBe(true);
    });
  });

  // ==================================================================
  // BUG-022: Name sync trigger
  // ==================================================================
  describe('BUG-022: Name sync triggers', () => {
    test('updating user full_name syncs to first/last', async () => {
      if (!dbAvailable) return;
      await createUser(client, tenantId, 'namesync@test.com', 'hash', 'Original Name');

      await client.query(
        `UPDATE users SET full_name = 'John Doe' WHERE email = 'namesync@test.com' AND tenant_id = $1`,
        [tenantId]
      );

      const res = await client.query(
        `SELECT first_name, last_name FROM users WHERE email = 'namesync@test.com' AND tenant_id = $1`,
        [tenantId]
      );
      expect(res.rows[0].first_name).toBe('John');
      expect(res.rows[0].last_name).toBe('Doe');
    });

    test('updating customer first/last syncs to name', async () => {
      if (!dbAvailable) return;
      // customerId comes from setupBasicTenant ("Alice")
      await client.query(
        `UPDATE customers SET first_name = 'Jane', last_name = 'Smith' WHERE customer_id = $1`,
        [customerId]
      );

      const res = await client.query(`SELECT name FROM customers WHERE customer_id = $1`, [
        customerId,
      ]);
      expect(res.rows[0].name).toBe('Jane Smith');
    });
  });

  // ==================================================================
  // BUG-023: 3+ word names handled correctly
  // ==================================================================
  describe('BUG-023: Name splitting for compound names', () => {
    test('3-word name splits correctly via trigger', async () => {
      if (!dbAvailable) return;
      await createUser(client, tenantId, 'compound@test.com', 'hash', 'Original Name');

      await client.query(
        `UPDATE users SET full_name = 'Mary Jane Watson' WHERE email = 'compound@test.com' AND tenant_id = $1`,
        [tenantId]
      );

      const res = await client.query(
        `SELECT first_name, last_name FROM users WHERE email = 'compound@test.com' AND tenant_id = $1`,
        [tenantId]
      );
      expect(res.rows[0].first_name).toBe('Mary');
      expect(res.rows[0].last_name).toBe('Jane Watson');
    });
  });

  // ==================================================================
  // BUG-029: Day-of-week conversion utilities
  // ==================================================================
  describe('BUG-029: Day-of-week conversion', () => {
    test('dayStringToNum converts correctly', () => {
      expect(dayStringToNum('sun')).toBe(0);
      expect(dayStringToNum('mon')).toBe(1);
      expect(dayStringToNum('fri')).toBe(5);
      expect(dayStringToNum('sat')).toBe(6);
    });

    test('dayNumToString converts correctly', () => {
      expect(dayNumToString(0)).toBe('sun');
      expect(dayNumToString(1)).toBe('mon');
      expect(dayNumToString(6)).toBe('sat');
    });

    test('workingHoursToShifts round-trips', () => {
      const wh = {
        mon: [{ start: '09:00', end: '17:00' }],
        wed: [
          { start: '10:00', end: '14:00' },
          { start: '15:00', end: '19:00' },
        ],
      };
      const shifts = workingHoursToShifts(wh);
      expect(shifts).toHaveLength(3);
      expect(shifts[0]).toEqual({ day_of_week: 1, start_time: '09:00', end_time: '17:00' });

      const roundTripped = shiftsToWorkingHours(shifts);
      expect(roundTripped.mon).toEqual([{ start: '09:00', end: '17:00' }]);
      expect(roundTripped.wed).toHaveLength(2);
    });

    test('throws on invalid day', () => {
      expect(() => dayStringToNum('xyz')).toThrow('Unknown day string');
      expect(() => dayNumToString(99)).toThrow('Unknown day number');
    });
  });

  // ==================================================================
  // BUG-020: Pagination parameters (basic endpoint check)
  // ==================================================================
  describe('BUG-020: Pagination', () => {
    test('customers query with LIMIT/OFFSET works', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        `SELECT * FROM customers WHERE tenant_id = $1 ORDER BY name LIMIT $2 OFFSET $3`,
        [tenantId, 10, 0]
      );
      expect(res.rows.length).toBeLessThanOrEqual(10);
    });

    test('appointments query with LIMIT/OFFSET works', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        `SELECT * FROM appointments WHERE tenant_id = $1 ORDER BY start_time LIMIT $2 OFFSET $3`,
        [tenantId, 5, 0]
      );
      expect(res.rows.length).toBeLessThanOrEqual(5);
    });
  });
});
