import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { type Client } from 'pg';
import {
  getRootClient,
  clearDB,
  createTenant,
  createResource,
  createEmployee,
  createScheduleEntry,
  createCustomerFull,
  createAppointment,
  beginTestTransaction,
  rollbackTestTransaction,
  skipIfDbDown,
} from '../utils';

/**
 * The tuning target for `book_with_scheduling_atomic` on a quiet local DB.
 * Asserted ONLY under `PERF_ASSERT=1` — see the comment at its use site. Run
 * `PERF_ASSERT=1 npx vitest run tests/services/scheduling-atomic.test.ts` when
 * you are actually working on the RPC's speed.
 */
const PERF_BUDGET_MS = 50;

/**
 * The always-on ceiling. Loose by design: it exists to catch a pathological
 * regression (a dropped index, an accidental N+1, a lock wait), not to measure
 * how busy the machine is. Anything under this is "not broken", not "fast".
 */
const PERF_SANITY_CEILING_MS = 2000;

let root: Client;
let dbAvailable = false;
beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

beforeAll(async () => {
  try {
    root = await getRootClient();
    dbAvailable = true;
    await clearDB(root);
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (root) await root.end();
});

beforeEach(async () => {
  if (dbAvailable) await beginTestTransaction(root);
});

afterEach(async () => {
  if (dbAvailable) await rollbackTestTransaction(root);
});

describe('book_with_scheduling_atomic()', () => {
  // Helper to call the RPC
  async function bookWithScheduling(params: Record<string, unknown>) {
    const res = await root.query(
      `SELECT * FROM book_with_scheduling_atomic(
                $1::UUID, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT, $6::TEXT,
                $7::TIMESTAMPTZ, $8::TIMESTAMPTZ, $9::TIMESTAMPTZ, $10::TIMESTAMPTZ,
                $11::TEXT[], $12::TEXT[], $13::UUID, $14::TEXT, $15::TEXT, $16::INTEGER
            )`,
      [
        params.tenant_id,
        params.phone || '+15551234567',
        params.customer_name || null,
        params.description || 'Test booking',
        params.call_id || 'test-call-1',
        params.location || null,
        params.start_time || null,
        params.end_time || null,
        params.window_from || null,
        params.window_to || null,
        params.required_skills || '{}',
        params.required_capabilities || '{}',
        params.preferred_resource_id || null,
        params.preferred_employee_id || null,
        params.service_type || null,
        params.duration_minutes || 30,
      ]
    );
    return res.rows[0];
  }

  // RULE CHANGE (migration 20260909210000): these used to be "1 resource, NO
  // employees", and the RPC booked the truck with nobody on it. An appointment is
  // with somebody now, so the solo operator is ON the roster and on shift all day
  // — the solo-operator shape (one person, one resource) is what these pin.
  describe('Solo operator (1 resource, 1 person on shift)', () => {
    it('books on the only resource when available', async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'Solo Tire Guy', 'mobile-tire');
      const resourceId = await createResource(root, tenantId, 'My Truck');
      const ownerId = await createEmployee(root, tenantId, 'Solo Owner');
      await createScheduleEntry(root, tenantId, ownerId, '2030-03-27', '00:00', '23:59');

      const result = await bookWithScheduling({
        tenant_id: tenantId,
        phone: '+15559999001',
        customer_name: 'Alice',
        start_time: '2030-03-27T10:00:00Z',
        end_time: '2030-03-27T10:30:00Z',
      });

      expect(result.success).toBe(true);
      expect(result.appointment_id).toBeTruthy();
      expect(result.resource_id).toBe(resourceId);
      expect(result.resource_name).toBe('My Truck');
      // Was toBeNull() — the appointment-with-nobody the rule change retired.
      expect(result.employee_id).toBe(ownerId);
      expect(result.customer_id).toBeTruthy();
    });

    it('creates customer if phone not found', async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'Solo Shop', 'auto-shop');
      await createResource(root, tenantId, 'Bay 1');
      const ownerId = await createEmployee(root, tenantId, 'Solo Owner');
      await createScheduleEntry(root, tenantId, ownerId, '2030-03-27', '00:00', '23:59');

      const result = await bookWithScheduling({
        tenant_id: tenantId,
        phone: '+15559999002',
        customer_name: 'New Person',
        start_time: '2030-03-27T14:00:00Z',
        end_time: '2030-03-27T14:30:00Z',
      });

      expect(result.success).toBe(true);
      // Verify customer was created
      const cust = await root.query('SELECT name, phone FROM customers WHERE customer_id = $1', [
        result.customer_id,
      ]);
      expect(cust.rows[0].name).toBe('New Person');
      expect(cust.rows[0].phone).toBe('+15559999002');
    });

    it('reuses existing customer by phone', async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'Solo Shop', 'auto-shop');
      await createResource(root, tenantId, 'Bay 1');
      const ownerId = await createEmployee(root, tenantId, 'Solo Owner');
      await createScheduleEntry(root, tenantId, ownerId, '2030-03-27', '00:00', '23:59');
      const custId = await createCustomerFull(root, tenantId, '+15559999003', 'Existing Joe');

      const result = await bookWithScheduling({
        tenant_id: tenantId,
        phone: '+15559999003',
        start_time: '2030-03-27T09:00:00Z',
        end_time: '2030-03-27T09:30:00Z',
      });

      expect(result.success).toBe(true);
      expect(result.customer_id).toBe(custId);
    });

    it('fails when all resources are booked', async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'Solo Shop', 'auto-shop');
      // Delete any auto-created resources from template trigger
      await root.query('DELETE FROM resources WHERE tenant_id = $1', [tenantId]);
      // Create exactly 1 resource
      const resourceId = await createResource(root, tenantId, 'Bay 1');
      const custId = await createCustomerFull(root, tenantId, '+15559999004', 'Bob');
      await createAppointment(
        root,
        tenantId,
        resourceId,
        custId,
        '2030-03-27T10:00:00Z',
        '2030-03-27T11:00:00Z',
        'Existing booking'
      );

      const result = await bookWithScheduling({
        tenant_id: tenantId,
        phone: '+15559999005',
        start_time: '2030-03-27T10:30:00Z',
        end_time: '2030-03-27T11:00:00Z',
      });

      expect(result.success).toBe(false);
      expect(result.error_message).toContain('No available');
    });
  });

  describe('Multi-employee shop (resources + employees + skills)', () => {
    it('matches employee by skill and shift', async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'Auto Pro', 'auto-shop');
      // Delete template-auto-seeded resources so the test's "Bay 1" is
      // the only candidate. Without this, the new assignment policy's
      // random() tiebreaker (added 2026-05-08) picks any matching
      // resource, and the assertion `result.resource_name === 'Bay 1'`
      // becomes flaky — auto-seeded "Service Bay 1" matches just as well.
      await root.query('DELETE FROM resources WHERE tenant_id = $1', [tenantId]);
      const _bayId = await createResource(root, tenantId, 'Bay 1');
      const empId = await createEmployee(root, tenantId, 'Alice', ['oil-change']);
      // 2030-04-01 is a Monday. Booking RPCs read only employee_schedule.
      await createScheduleEntry(root, tenantId, empId, '2030-04-01', '08:00', '17:00');

      // 2030-04-01 is a Monday
      const result = await bookWithScheduling({
        tenant_id: tenantId,
        phone: '+15559999010',
        required_skills: '{oil-change}',
        start_time: '2030-04-01T14:00:00Z',
        end_time: '2030-04-01T14:30:00Z',
      });

      expect(result.success).toBe(true);
      expect(result.resource_name).toBe('Bay 1');
      expect(result.employee_name).toBe('Alice');
    });

    it('skips employee without required skill', async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'Auto Pro', 'auto-shop');
      await createResource(root, tenantId, 'Bay 1');
      const emp1 = await createEmployee(root, tenantId, 'Bob', ['brakes']);
      // Bob is scheduled on 2030-04-01 but lacks the required skill.
      await createScheduleEntry(root, tenantId, emp1, '2030-04-01', '08:00', '17:00');

      const result = await bookWithScheduling({
        tenant_id: tenantId,
        phone: '+15559999011',
        required_skills: '{oil-change}',
        start_time: '2030-04-01T10:00:00Z',
        end_time: '2030-04-01T10:30:00Z',
      });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('NO_SKILLED_EMPLOYEE');
    });

    it('skips employee not on shift', async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'Auto Pro', 'auto-shop');
      await createResource(root, tenantId, 'Bay 1');
      const empId = await createEmployee(root, tenantId, 'Alice', ['oil-change']);
      // Only works Tuesday (2030-04-02), not Monday (2030-04-01).
      await createScheduleEntry(root, tenantId, empId, '2030-04-02', '08:00', '17:00');

      // Try Monday (DOW=1)
      const result = await bookWithScheduling({
        tenant_id: tenantId,
        phone: '+15559999012',
        required_skills: '{oil-change}',
        start_time: '2030-04-01T10:00:00Z',
        end_time: '2030-04-01T10:30:00Z',
      });

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('EMPLOYEE_NOT_SCHEDULED');
    });

    it('picks first available when multiple options exist', async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'Big Shop', 'auto-shop');
      await createResource(root, tenantId, 'Bay 1');
      await createResource(root, tenantId, 'Bay 2');
      const emp1 = await createEmployee(root, tenantId, 'Alice', ['oil-change']);
      const emp2 = await createEmployee(root, tenantId, 'Bob', ['oil-change']);
      await createScheduleEntry(root, tenantId, emp1, '2030-04-01', '08:00', '17:00');
      await createScheduleEntry(root, tenantId, emp2, '2030-04-01', '08:00', '17:00');

      const result = await bookWithScheduling({
        tenant_id: tenantId,
        phone: '+15559999013',
        required_skills: '{oil-change}',
        start_time: '2030-04-01T10:00:00Z',
        end_time: '2030-04-01T10:30:00Z',
      });

      expect(result.success).toBe(true);
      expect(result.employee_name).toBeTruthy();
      expect(result.resource_name).toBeTruthy();
    });

    it('respects preferred employee', async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'Big Shop', 'auto-shop');
      await createResource(root, tenantId, 'Bay 1');
      const emp1 = await createEmployee(root, tenantId, 'Alice', ['oil-change']);
      const emp2 = await createEmployee(root, tenantId, 'Bob', ['oil-change']);
      await createScheduleEntry(root, tenantId, emp1, '2030-04-01', '08:00', '17:00');
      await createScheduleEntry(root, tenantId, emp2, '2030-04-01', '08:00', '17:00');

      const result = await bookWithScheduling({
        tenant_id: tenantId,
        phone: '+15559999014',
        required_skills: '{oil-change}',
        preferred_employee_id: emp2,
        start_time: '2030-04-01T10:00:00Z',
        end_time: '2030-04-01T10:30:00Z',
      });

      expect(result.success).toBe(true);
      expect(result.employee_name).toBe('Bob');
    });
  });

  describe('Resource capabilities', () => {
    it('matches resource by capability', async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'Full Service', 'auto-shop');
      // Bay 1 has lift, Bay 2 doesn't
      const bay1 = await createResource(root, tenantId, 'Bay 1');
      await root.query('UPDATE resources SET capabilities = $1 WHERE resource_id = $2', [
        '{lift,air-tools}',
        bay1,
      ]);
      const bay2 = await createResource(root, tenantId, 'Bay 2');
      await root.query('UPDATE resources SET capabilities = $1 WHERE resource_id = $2', [
        '{basic}',
        bay2,
      ]);
      // Somebody to take it — an appointment is with somebody (20260909210000).
      // The capability match, not the person, is what this test pins.
      const techId = await createEmployee(root, tenantId, 'Bay Tech');
      await createScheduleEntry(root, tenantId, techId, '2030-03-27', '00:00', '23:59');

      const result = await bookWithScheduling({
        tenant_id: tenantId,
        phone: '+15559999020',
        required_capabilities: '{lift}',
        start_time: '2030-03-27T10:00:00Z',
        end_time: '2030-03-27T10:30:00Z',
      });

      expect(result.success).toBe(true);
      expect(result.resource_name).toBe('Bay 1');
    });
  });

  describe('Performance', () => {
    it('completes full find-and-book in under 50ms', async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'Perf Test Shop', 'auto-shop');
      await root.query('DELETE FROM resources WHERE tenant_id = $1', [tenantId]);

      // Set up realistic data: 3 bays, 4 employees, shifts, some existing appointments
      const bay1 = await createResource(root, tenantId, 'Bay 1');
      const bay2 = await createResource(root, tenantId, 'Bay 2');
      const bay3 = await createResource(root, tenantId, 'Bay 3');
      await root.query('UPDATE resources SET capabilities = $1 WHERE resource_id = ANY($2)', [
        '{lift,air-tools}',
        [bay1, bay2, bay3],
      ]);

      const emp1 = await createEmployee(root, tenantId, 'Alice', ['oil-change', 'brakes']);
      const emp2 = await createEmployee(root, tenantId, 'Bob', ['oil-change', 'tires']);
      const emp3 = await createEmployee(root, tenantId, 'Carol', ['tires', 'alignment']);
      const emp4 = await createEmployee(root, tenantId, 'Dave', ['oil-change', 'brakes', 'tires']);

      // 2030-04-01 (Monday) schedule for all four — booking RPCs
      // read employee_schedule, not weekly patterns.
      for (const empId of [emp1, emp2, emp3, emp4]) {
        await createScheduleEntry(root, tenantId, empId, '2030-04-01', '08:00', '17:00');
      }

      // Add some existing appointments to make it realistic
      const cust1 = await createCustomerFull(root, tenantId, '+15550001111', 'Existing 1');
      await createAppointment(
        root,
        tenantId,
        bay1,
        cust1,
        '2030-04-01T09:00:00Z',
        '2030-04-01T09:30:00Z',
        'Oil change',
        'scheduled',
        emp1
      );
      await createAppointment(
        root,
        tenantId,
        bay2,
        cust1,
        '2030-04-01T10:00:00Z',
        '2030-04-01T10:30:00Z',
        'Brakes',
        'scheduled',
        emp2
      );

      // Now time the atomic RPC
      const runs = 5;
      const times: number[] = [];

      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        const res = await root.query(
          `SELECT * FROM book_with_scheduling_atomic(
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
                    )`,
          [
            tenantId,
            `+1555000${2000 + i}`,
            `Perf Customer ${i}`,
            'Oil change perf test',
            `perf-call-${i}`,
            null,
            '2030-04-01T11:00:00Z',
            '2030-04-01T11:30:00Z',
            null,
            null,
            '{oil-change}',
            '{lift}',
            null,
            null,
            null,
            30,
          ]
        );
        const elapsed = performance.now() - start;
        times.push(elapsed);

        // Clean up the appointment so next iteration can book the same slot
        if (res.rows[0].success) {
          await root.query('DELETE FROM appointments WHERE appointment_id = $1', [
            res.rows[0].appointment_id,
          ]);
        }
      }

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const min = Math.min(...times);
      const max = Math.max(...times);

      console.log(`\n  ⏱  book_with_scheduling_atomic performance (${runs} runs):`);
      console.log(
        `     Avg: ${avg.toFixed(1)}ms | Min: ${min.toFixed(1)}ms | Max: ${max.toFixed(1)}ms`
      );
      console.log(`     Times: [${times.map((t) => t.toFixed(1) + 'ms').join(', ')}]`);

      // A BENCHMARK, NOT A CORRECTNESS TEST — see PERF_BUDGET_MS.
      //
      // This asserted `avg < 50` unconditionally, which is a statement about
      // the MACHINE, not the code: on 2026-08-15 this file was the one red file
      // in an otherwise green backend suite, purely because the box was busy
      // running the call sims at the same time. It passed on the next quiet
      // run. A shared CI runner will do that whenever something else is
      // building, and a suite that goes red for reasons unrelated to the change
      // teaches people to re-run instead of read.
      //
      // The measurement above is genuinely useful and still always prints. The
      // tight budget is now opt-in (PERF_ASSERT=1) for when someone is actually
      // tuning the RPC; the always-on ceiling is deliberately loose and exists
      // only to catch a pathological regression — a missing index, a lost
      // prepared statement, an accidental N+1 — not a slow afternoon.
      if (process.env.PERF_ASSERT === '1') expect(avg).toBeLessThan(PERF_BUDGET_MS);
      expect(avg).toBeLessThan(PERF_SANITY_CEILING_MS);
    });

    it('compare: old 4-query approach timing', async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'Perf Compare', 'auto-shop');
      await root.query('DELETE FROM resources WHERE tenant_id = $1', [tenantId]);

      const bay1 = await createResource(root, tenantId, 'Bay 1');
      await root.query('UPDATE resources SET capabilities = $1 WHERE resource_id = $2', [
        '{lift}',
        bay1,
      ]);
      const emp1 = await createEmployee(root, tenantId, 'Alice', ['oil-change']);
      await createScheduleEntry(root, tenantId, emp1, '2030-04-01', '08:00', '17:00');

      const runs = 5;
      const oldTimes: number[] = [];
      const newTimes: number[] = [];

      for (let i = 0; i < runs; i++) {
        // OLD approach: 4 separate queries (kept as a perf
        // baseline; the third now reads employee_schedule).
        const oldStart = performance.now();
        await root.query(
          'SELECT resource_id, capabilities FROM resources WHERE tenant_id = $1 AND is_active = true',
          [tenantId]
        );
        await root.query(
          'SELECT employee_id, skills FROM employees WHERE tenant_id = $1 AND is_active = true',
          [tenantId]
        );
        await root.query(
          'SELECT employee_id, shift_date, start_time, end_time FROM employee_schedule WHERE tenant_id = $1 AND is_off = false',
          [tenantId]
        );
        await root.query(
          "SELECT resource_id, start_time, end_time FROM appointments WHERE tenant_id = $1 AND status = 'scheduled'",
          [tenantId]
        );
        oldTimes.push(performance.now() - oldStart);

        // NEW approach: 1 atomic RPC
        const newStart = performance.now();
        const res = await root.query(
          `SELECT * FROM book_with_scheduling_atomic(
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
                    )`,
          [
            tenantId,
            `+1555000${3000 + i}`,
            'Compare Test',
            'Timing test',
            `compare-${i}`,
            null,
            '2030-04-01T14:00:00Z',
            '2030-04-01T14:30:00Z',
            null,
            null,
            '{oil-change}',
            '{lift}',
            null,
            null,
            null,
            30,
          ]
        );
        newTimes.push(performance.now() - newStart);

        if (res.rows[0].success) {
          await root.query('DELETE FROM appointments WHERE appointment_id = $1', [
            res.rows[0].appointment_id,
          ]);
        }
      }

      const oldAvg = oldTimes.reduce((a, b) => a + b, 0) / oldTimes.length;
      const newAvg = newTimes.reduce((a, b) => a + b, 0) / newTimes.length;

      console.log(
        `\n  ⏱  4-query approach: Avg ${oldAvg.toFixed(1)}ms [${oldTimes.map((t) => t.toFixed(1)).join(', ')}]`
      );
      console.log(
        `  ⏱  Atomic RPC:      Avg ${newAvg.toFixed(1)}ms [${newTimes.map((t) => t.toFixed(1)).join(', ')}]`
      );
      console.log(`  ⏱  Speedup: ${(oldAvg / newAvg).toFixed(1)}x faster`);

      // THE TEST IS CALLED "compare" AND NEVER COMPARED. It asserted an
      // absolute `newAvg < 100`, which says nothing about the claim in its own
      // comment ("atomic should be faster") and everything about how busy the
      // machine is — it was one of the two failures in the 2026-08-15 loaded
      // run. Now it asserts the actual claim, as a RATIO, which is what
      // survives a slow box: both halves slow down together.
      //
      // The bound is generous on purpose. On a local DB the two approaches are
      // genuinely close (the win is round trips, and localhost round trips are
      // nearly free), so the honest guard is "the atomic path must not become
      // dramatically WORSE", not "it must always win by X".
      expect(newAvg).toBeLessThan(oldAvg * 2);
      if (process.env.PERF_ASSERT === '1') expect(newAvg).toBeLessThan(oldAvg);
      expect(newAvg).toBeLessThan(PERF_SANITY_CEILING_MS);
    });
  });

  describe('Error diagnostics', () => {
    it('returns clear error when no time specified', async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'Test Biz', 'salon');

      const result = await bookWithScheduling({
        tenant_id: tenantId,
        phone: '+15559999030',
      });

      expect(result.success).toBe(false);
      expect(result.error_message).toContain('start_time');
      expect(result.error_message).toContain('window_from');
    });

    it('returns customer_id even on failure (for debugging)', async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'Test Biz', 'salon');
      // Delete any auto-created resources so booking fails
      await root.query('DELETE FROM resources WHERE tenant_id = $1', [tenantId]);

      const result = await bookWithScheduling({
        tenant_id: tenantId,
        phone: '+15559999031',
        customer_name: 'Sad Customer',
        start_time: '2030-03-27T10:00:00Z',
        end_time: '2030-03-27T10:30:00Z',
      });

      expect(result.success).toBe(false);
      expect(result.customer_id).toBeTruthy(); // customer was created even though booking failed
    });
  });
});
