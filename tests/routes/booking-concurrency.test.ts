/**
 * Concurrent-booking race tests for the atomic booking RPCs.
 *
 * The contract under test: when N callers race for the same slot, exactly
 * one wins and the rest get TIMESLOT_OCCUPIED. Without an EXCLUDE
 * constraint on appointments, the existing find-then-insert pattern in
 * book_with_scheduling_atomic / book_appointment_atomic loses the race
 * under READ COMMITTED — two transactions can both pass the NOT EXISTS
 * check before either has committed its INSERT.
 *
 * 5W context for sad-path failures:
 *   WHO  — N concurrent voice agents (or dashboard front-desk users)
 *   WHAT — calling book_with_scheduling_atomic with the same start/end
 *   WHEN — within the same millisecond window, before either commits
 *   WHERE — at the INSERT step, after both passed the NOT EXISTS check
 *   WHY  — without an EXCLUDE constraint the DB cannot reject the second
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type Client, Pool } from 'pg';
import {
  ROOT_DB_URL,
  getRootClient,
  clearDB,
  createTenant,
  createResource,
  createEmployee,
  createScheduleEntry,
} from '../utils';

const N = 20; // concurrent callers competing for the same slot

describe('book_with_scheduling_atomic: concurrent-booking race', () => {
  let setup: Client;
  let pool: Pool;
  let tenantId: string;
  let employeeId: string;
  let dbAvailable = false;

  beforeAll(async () => {
    try {
      setup = await getRootClient();
      const res = await setup.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'employee_schedule')"
      );
      if (!res.rows[0].exists) {
        if (process.env.REQUIRE_DB_TESTS === '1') {
          throw new Error(
            'employee_schedule missing in test_db — run `npm run db:migrate` against test_db before running with REQUIRE_DB_TESTS=1'
          );
        }
        console.warn('[booking-concurrency] employee_schedule missing, skipping');
        return;
      }
      await clearDB(setup);
      tenantId = await createTenant(setup, 'Race Test Co', 'auto-repair', 'America/Chicago');
      await createResource(setup, tenantId, 'Bay 1');
      employeeId = await createEmployee(setup, tenantId, 'Alex', ['repair']);

      // The pool is the source of true concurrency. Each pool.query()
      // gets its own connection, each in its own implicit transaction.
      pool = new Pool({ connectionString: ROOT_DB_URL, max: N + 5 });
      dbAvailable = true;
    } catch (err) {
      // REQUIRE_DB_TESTS=1 turns DB-down from "silent skip" into a hard
      // failure. Use it in CI and any setting where a missing DB must
      // not masquerade as a green test run. Locally, DB-down still
      // routes through ctx.skip() in each `it` so the test shows as
      // SKIPPED (not PASSED). Origin: 2026-05-15 — the prior pattern
      // returned early from each `it`, which Vitest reports as PASSED
      // even though zero assertions ran.
      if (process.env.REQUIRE_DB_TESTS === '1') throw err;
      console.warn('[booking-concurrency] DB not available:', err);
    }
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (setup) await setup.end();
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    // Truncate appointments + customers between tests so each test sees
    // a fresh slot. We can't use savepoints here because the concurrent
    // calls commit on different connections.
    await setup.query('DELETE FROM appointments WHERE tenant_id = $1', [tenantId]);
    await setup.query('DELETE FROM customers WHERE tenant_id = $1', [tenantId]);
    await setup.query('DELETE FROM employee_schedule WHERE tenant_id = $1', [tenantId]);
    await createScheduleEntry(setup, tenantId, employeeId, '2030-06-26', '08:00', '17:00');
  });

  it(
    'SAD: 20 concurrent callers for the same slot — exactly one books, others get TIMESLOT_OCCUPIED',
    { timeout: 30_000 },
    async (ctx) => {
      // WHO: 20 separate voice-agent sessions, each with a unique caller phone
      // WHAT: All call book_with_scheduling_atomic for 2030-06-26 10:00–10:30 CDT
      // WHEN: fired within the same JS tick across N pool connections
      // WHERE: Inside the RPC, between the find-pair NOT EXISTS check and the INSERT
      // WHY: We promise the user "exactly one wins; everyone else hears it's taken."
      if (!dbAvailable) {
        ctx.skip();
        return;
      }

      const startISO = '2030-06-26T10:00:00-05:00';
      const endISO = '2030-06-26T10:30:00-05:00';

      const calls = Array.from({ length: N }, (_, i) =>
        pool.query(
          `SELECT * FROM book_with_scheduling_atomic(
                    $1,                                  -- p_tenant_id
                    $2,                                  -- p_phone (unique per caller)
                    $3,                                  -- p_customer_name
                    'Race test booking',                 -- p_description
                    NULL, NULL,                          -- p_call_id, p_location
                    $4::TIMESTAMPTZ, $5::TIMESTAMPTZ,    -- p_start_time, p_end_time
                    NULL, NULL,                          -- p_window_from, p_window_to
                    '{repair}', '{}',                    -- p_required_skills, p_required_capabilities
                    NULL, NULL, NULL, 30                 -- preferred_resource, preferred_employee, service_type, duration
                )`,
          [tenantId, `+1555000${String(i).padStart(4, '0')}`, `Caller ${i}`, startISO, endISO]
        )
      );

      // allSettled, not all: under N-way concurrency the GiST exclusion-constraint
      // check can deadlock (Postgres 40P01) between two transactions instead of
      // returning a clean TIMESLOT_OCCUPIED. The deadlock victim's transaction
      // rolls back — data integrity is preserved (the constraint still caps the
      // slot at one INSERT) — and prod does NOT retry it (toolsClient retries only
      // read-only 5xx), so a real caller would hear "something went wrong, try
      // again". That is an accepted outcome (see the employee-race test below).
      //
      // Promise.all would also REJECT on the first 40P01 and leave the other 19
      // queries in flight, orphaning their pool connections — afterAll's
      // pool.end() (and the next test's beforeEach DELETE) then block on the held
      // locks until the 10s hook timeout. allSettled lets all 20 settle first.
      //
      // We still assert the strong contract: exactly one winner, every *clean*
      // loser gets the honest TIMESLOT_OCCUPIED (never a generic error or silent
      // double-book), the only tolerated rejection is a deadlock, and all 20
      // callers are accounted for.
      const settled = await Promise.allSettled(calls);
      const fulfilled = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const rejected = settled.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));

      const deadlocks = rejected.filter((e) => (e as { code?: string })?.code === '40P01');
      const otherRejections = rejected.filter((e) => (e as { code?: string })?.code !== '40P01');
      expect(
        otherRejections,
        'only deadlocks (40P01) may reject; anything else is a real bug'
      ).toEqual([]);

      const wins = fulfilled.filter((r) => r.rows[0].success === true);
      const losses = fulfilled.filter((r) => r.rows[0].success === false);

      // The lock-acquisition winner never waits on anyone, so it is never the
      // deadlock victim — at least one always commits and the exclusion
      // constraint caps it at one. Hence exactly one, not "at most one".
      expect(wins).toHaveLength(1);

      // Every fulfilled loser gets the honest message — not a generic
      // NO_AVAILABILITY, not a raw exclusion_violation SQL error.
      const lossErrorCodes = losses.map((r) => r.rows[0].error_code);
      expect(lossErrorCodes.every((c) => c === 'TIMESLOT_OCCUPIED')).toBe(true);

      // All 20 callers accounted for: 1 winner + clean losers + deadlock victims.
      expect(wins.length + losses.length + deadlocks.length).toBe(N);

      // Exactly one row in the appointments table for this slot, regardless of
      // how many callers deadlocked vs got a clean TIMESLOT_OCCUPIED.
      const persisted = await setup.query(
        `SELECT COUNT(*)::INT AS n FROM appointments
             WHERE tenant_id = $1 AND status = 'scheduled'
             AND start_time = $2::TIMESTAMPTZ`,
        [tenantId, startISO]
      );
      expect(persisted.rows[0].n).toBe(1);
    }
  );

  it(
    'SAD: 20 concurrent callers for same employee at same time on different resources still has exactly one winner',
    { timeout: 30_000 },
    async (ctx) => {
      // WHO: 20 callers competing for Alex's 10am slot
      // WHAT: Same employee_id, same time — even if resources differ, the
      //       employee can only be in one appointment at once
      // WHEN: Concurrent calls
      // WHERE: Employee-overlap check inside the RPC
      // WHY: Double-booking the employee is just as bad as double-booking the resource
      if (!dbAvailable) {
        ctx.skip();
        return;
      }

      // Add a second resource so the find-pair query has alternatives. The
      // employee constraint should still force exactly one winner.
      const resource2Id = await createResource(setup, tenantId, 'Bay 2');

      const startISO = '2030-06-26T11:00:00-05:00';
      const endISO = '2030-06-26T11:30:00-05:00';

      const calls = Array.from({ length: N }, (_, i) =>
        pool.query(
          `SELECT * FROM book_with_scheduling_atomic(
                    $1, $2, $3, 'Employee race', NULL, NULL,
                    $4::TIMESTAMPTZ, $5::TIMESTAMPTZ,
                    NULL, NULL,
                    '{repair}', '{}',
                    NULL, $6, NULL, 30
                )`,
          [
            tenantId,
            `+1555111${String(i).padStart(4, '0')}`,
            `EmpRace ${i}`,
            startISO,
            endISO,
            employeeId,
          ]
        )
      );

      // allSettled (not all) because under extreme concurrency the GiST
      // exclusion-constraint check can deadlock between two concurrent
      // transactions, surfacing as `40P01` rejection rather than a clean
      // TIMESLOT_OCCUPIED return. Both outcomes preserve data integrity
      // (the constraint guarantees at most one INSERT wins); the agent
      // prompt would surface a deadlock as "something went wrong, please
      // try again" which is acceptable user-facing behavior. The
      // contract this test enforces is "at most one winner across all
      // 20 callers", not "every loser gets the prettiest error code."
      const results = await Promise.allSettled(calls);
      const fulfilled = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const wins = fulfilled.filter((r) => r.rows[0].success === true);
      expect(wins, 'at most one of 20 concurrent callers may book the slot').toHaveLength(1);

      // Belt-and-suspenders: regardless of how many callers got which
      // error shape, exactly one row must persist for this slot.
      const persisted = await setup.query(
        `SELECT COUNT(*)::INT AS n FROM appointments
             WHERE tenant_id = $1 AND status = 'scheduled'
             AND start_time = $2::TIMESTAMPTZ`,
        [tenantId, startISO]
      );
      expect(persisted.rows[0].n).toBe(1);

      // Cleanup the second resource so we don't leak it into the next test.
      await setup.query('DELETE FROM resources WHERE resource_id = $1', [resource2Id]);
    }
  );
});
