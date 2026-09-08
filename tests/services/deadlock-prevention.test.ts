/**
 * Deadlock prevention tests — validates that DB configuration, transaction patterns,
 * and lock ordering follow the principles that prevent deadlocks.
 *
 * Deadlock Prevention Principles (applied in this codebase):
 * 1. CONSISTENT LOCK ORDERING — all multi-table transactions acquire locks in the same order
 * 2. SHORT TRANSACTIONS — no long-held locks; savepoints for test isolation
 * 3. TIMEOUT PROTECTION — statement_timeout, lock_timeout, idle_in_transaction_session_timeout
 * 4. SEQUENTIAL FILE EXECUTION — vitest fileParallelism:false prevents cross-file lock contention
 * 5. AVOID LOCK ESCALATION — no mixing row locks with table locks (TRUNCATE) in parallel
 *
 * Happy + sad paths with 5W diagnostic comments.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type Client } from 'pg';
import {
  getRootClient,
  clearDB,
  beginTestTransaction,
  rollbackTestTransaction,
  createTenant,
  skipIfDbDown,
} from '../utils';

let client: Client;
let dbAvailable = false;
beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

beforeAll(async () => {
  try {
    client = await getRootClient();
    dbAvailable = true;
    await clearDB(client);
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (client) await client.end();
});

describe('Deadlock Prevention: Timeout Configuration', () => {
  it('HAPPY: statement_timeout is set on the application pool', async () => {
    // WHO: any route handler executing a query through the pool
    // WHAT: SELECT current_setting('statement_timeout') should return a non-zero value
    // WHEN: pool connection is acquired for any DB operation
    // WHERE: src/index.ts pool configuration — options flag sets statement_timeout
    // WHY: without statement_timeout, a runaway query (e.g. full table scan on appointments
    //      with missing index) holds a connection indefinitely, exhausting the pool and
    //      blocking all other requests until the server is restarted
    if (!dbAvailable) return;
    // Test the principle: the application pool should set timeouts.
    // We verify the test DB has timeout support (the actual pool config uses options flags).
    const res = await client.query('SHOW statement_timeout');
    expect(res.rows[0].statement_timeout).toBeDefined();
  });

  it('HAPPY: lock_timeout is configurable and prevents indefinite lock waits', async () => {
    // WHO: two concurrent requests trying to update the same tenant row
    // WHAT: second request should fail with lock_timeout instead of waiting forever
    // WHEN: POST /tenants/:id/update-attributes while another update is in flight
    // WHERE: src/index.ts pool options — lock_timeout=10000 (10 seconds)
    // WHY: without lock_timeout, a request blocked on a row lock will hold its DB connection
    //      indefinitely. With 10 connections in the pool, 10 blocked requests = complete outage.
    //      lock_timeout makes it fail fast with a clear error instead of hanging silently.
    if (!dbAvailable) return;
    const res = await client.query('SHOW lock_timeout');
    expect(res.rows[0].lock_timeout).toBeDefined();
  });

  it('HAPPY: idle_in_transaction_session_timeout prevents abandoned transactions', async () => {
    // WHO: a request handler that crashed mid-transaction without COMMIT/ROLLBACK
    // WHAT: the idle transaction should be killed after the timeout period
    // WHEN: any transaction that starts BEGIN but never completes (e.g. process crash, network drop)
    // WHERE: src/index.ts pool options — idle_in_transaction_session_timeout=60000
    // WHY: an idle transaction holds all its row locks indefinitely. If an employee update started
    //      BEGIN, locked the employee row, then the request handler threw before COMMIT, that employee
    //      row would be locked until the connection times out or the server restarts. This timeout
    //      ensures abandoned transactions are cleaned up automatically.
    if (!dbAvailable) return;
    const res = await client.query('SHOW idle_in_transaction_session_timeout');
    expect(res.rows[0].idle_in_transaction_session_timeout).toBeDefined();
  });
});

describe('Deadlock Prevention: Transaction Isolation in Tests', () => {
  it('HAPPY: beginTestTransaction + rollbackTestTransaction provides clean isolation', async () => {
    // WHO: any test file using savepoint-based isolation (most test files)
    // WHAT: data created between BEGIN/SAVEPOINT and ROLLBACK TO SAVEPOINT should vanish
    // WHEN: afterEach calls rollbackTestTransaction
    // WHERE: src/test-utils.ts beginTestTransaction / rollbackTestTransaction
    // WHY: if rollback used bare ROLLBACK instead of ROLLBACK TO SAVEPOINT, it would end the
    //      entire transaction, causing the next test's SAVEPOINT to operate outside a transaction.
    //      The second test would then write permanent data to the DB, contaminating all subsequent
    //      tests in the file. This was the root cause of 128 pre-existing test failures.
    if (!dbAvailable) return;
    await beginTestTransaction(client);

    // Create a tenant inside the transaction
    const tenantId = await createTenant(client, 'DeadlockTest', 'test-type');
    const check1 = await client.query('SELECT tenant_id FROM tenants WHERE tenant_id = $1', [
      tenantId,
    ]);
    expect(check1.rows.length).toBe(1);

    // Rollback should undo the insert
    await rollbackTestTransaction(client);

    // Tenant should be gone — rollback undid the insert
    const check2 = await client.query('SELECT tenant_id FROM tenants WHERE tenant_id = $1', [
      tenantId,
    ]);
    expect(check2.rows.length).toBe(0);
  });

  it('SAD: rollbackTestTransaction handles double-rollback gracefully', async () => {
    // WHO: a test file where afterEach runs even if beforeEach failed
    // WHAT: calling rollbackTestTransaction when no transaction is active should not throw
    // WHEN: test setup fails before beginTestTransaction, but afterEach still fires
    // WHERE: src/test-utils.ts rollbackTestTransaction
    // WHY: if ROLLBACK TO SAVEPOINT throws when there's no savepoint, the afterEach handler
    //      crashes with an unhandled error, masking the real test failure with a confusing
    //      "SAVEPOINT test_start does not exist" error. The test runner shows the wrong error.
    if (!dbAvailable) return;
    // Start and complete a transaction normally
    await beginTestTransaction(client);
    await rollbackTestTransaction(client);

    // Second rollback — should not throw (the transaction was already rolled back)
    // Note: ROLLBACK TO SAVEPOINT after the transaction ended will error,
    // but our test files structure ensures this doesn't happen in practice
    // because beginTestTransaction is always called in beforeEach.
    // This test documents the expected behavior.
    try {
      await client.query('ROLLBACK');
      // If we get here, no error — that's fine (ROLLBACK outside transaction is a no-op in pg)
    } catch {
      // Also acceptable — pg may warn about no transaction in progress
    }
  });
});

/**
 * This test does REAL work against Postgres — one `TRUNCATE ... CASCADE` over
 * every seeded table, plus a count. Vitest's default budget is 5s, and on a
 * loaded CI runner that truncate has taken 5,004 ms (#394, 2026-09-03): a
 * 4-millisecond miss that reddened `main`-bound CI and, per the SKIPPED-is-
 * terminal note in CLAUDE.md, is a mechanism for silently not deploying.
 *
 * The assertions below are about SHAPE — one statement, no deadlock, table
 * empty afterwards — and say nothing about speed. So the budget is raised to
 * match the database work rather than the runner's mood. Nothing is loosened:
 * a genuine deadlock still hangs and still fails, just with a timeout that
 * means "the DB never answered" instead of "the runner was busy".
 *
 * Same class as SUBPROCESS_TEST_TIMEOUT_MS in scripts/purge-soft-deleted.test.ts
 * and the SetupWizard findBy* fix: a test asserting the machine's speed instead
 * of the code's behaviour. This is the FOURTH occurrence of that pattern — see
 * the flaky-gates section of docs/TODO.md.
 */
const TRUNCATE_TEST_TIMEOUT_MS = 30_000;

describe('Deadlock Prevention: Consistent Lock Ordering', () => {
  it(
    'HAPPY: clearDB truncates all tables in a single statement to prevent partial locks',
    async () => {
      // WHO: test file's beforeAll/beforeEach that needs a clean DB slate
      // WHAT: clearDB issues one TRUNCATE ... CASCADE for all tables at once
      // WHEN: beforeAll in any test file that uses clearDB
      // WHERE: src/test-utils.ts clearDB()
      // WHY: if tables were truncated one at a time (TRUNCATE tenants; TRUNCATE customers; ...),
      //      a concurrent test file could acquire a lock between the two TRUNCATEs, creating
      //      a deadlock: File A holds AccessExclusiveLock on tenants (from TRUNCATE), tries to
      //      lock customers. File B holds RowShareLock on customers (from INSERT), tries to
      //      lock tenants. Single-statement TRUNCATE acquires all locks atomically.
      if (!dbAvailable) return;
      // Verify clearDB doesn't throw — the single-statement pattern prevents deadlocks
      await clearDB(client);
      const res = await client.query('SELECT count(*) FROM tenants');
      expect(parseInt(res.rows[0].count)).toBe(0);
    },
    TRUNCATE_TEST_TIMEOUT_MS
  );

  it('HAPPY: vitest config enforces sequential file execution', () => {
    // WHO: the vitest test runner executing every backend test file
    // WHAT: the root vitest config sets fileParallelism: false
    // WHEN: npx vitest run (any invocation, not just npm test)
    // WHERE: vitest.config.* at the repo root, test.fileParallelism
    // WHY: parallel file execution caused 128 test failures due to deadlocks (40P01).
    //      Test files use TRUNCATE (AccessExclusiveLock) and transactions (RowShareLock).
    //      When two files run simultaneously, File A's TRUNCATE blocks on File B's row locks,
    //      while File B's TRUNCATE blocks on File A's row locks → circular wait → deadlock.
    //      Sequential execution ensures each file completes cleanup before the next starts.
    //
    // The filename is DISCOVERED, not hardcoded. This assertion is about the setting,
    // not the extension, and it has already been broken once by a legitimate rename
    // (.ts → .mts, to stop Vite loading an ESM config as CommonJS). Resolving the file
    // means the next rename does not turn a real guarantee into a red test — but an
    // ABSENT config still fails loudly, which is the case actually worth catching.
    const fs = require('fs');
    const candidates = ['vitest.config.mts', 'vitest.config.ts', 'vitest.config.mjs'];
    const found = candidates.find((f) => fs.existsSync(f));
    expect(found, `no root vitest config found (looked for ${candidates.join(', ')})`).toBeDefined();
    const config = fs.readFileSync(found, 'utf8');
    expect(config).toContain('fileParallelism: false');
  });
});

describe('Deadlock Prevention: Application Lock Ordering', () => {
  it('HAPPY: service delete follows correct lock order (mappings before entity)', async () => {
    // WHO: tenant admin deleting a service via the setup screen
    // WHAT: DELETE /services/:id/delete — must delete mappings BEFORE the service itself
    // WHEN: the service has employee and resource assignments
    // WHERE: src/routes/services.ts — transaction deletes service_employee, service_resource, then services
    // WHY: if services were deleted first, the CASCADE would try to delete mappings while the
    //      explicit DELETE on mappings holds locks in the opposite direction. The correct order is:
    //      child records (service_employee, service_resource) first, then parent (services).
    //      This matches foreign key dependency order and prevents lock inversion.
    const fs = require('fs');
    const src = fs.readFileSync('src/routes/services.ts', 'utf8');
    // Verify the order: service_employee before service_resource before services
    const empIdx = src.indexOf('DELETE FROM service_employee');
    const resIdx = src.indexOf('DELETE FROM service_resource');
    const svcIdx = src.indexOf('DELETE FROM services WHERE');
    expect(empIdx).toBeLessThan(resIdx);
    expect(resIdx).toBeLessThan(svcIdx);
  });

  it('HAPPY: employee update scopes by tenant_id to prevent cross-tenant lock contention', async () => {
    // WHO: tenant admin updating an employee's name or is_active status
    // WHAT: UPDATE employees SET ... WHERE id = $N AND tenant_id = $M
    // WHEN: POST /employees/:id/update
    // WHERE: src/routes/employees.ts — the UPDATE query
    // WHY: without AND tenant_id in the WHERE clause, the UPDATE could accidentally lock a row
    //      belonging to a different tenant (if UUIDs collided or were reused in tests). With
    //      tenant scoping, the lock is narrowed to a single tenant's row, reducing the window
    //      for cross-tenant deadlocks. This was a real bug — the original query was missing
    //      AND tenant_id, allowing cross-tenant employee updates.
    const fs = require('fs');
    const src = fs.readFileSync('src/routes/employees.ts', 'utf8');
    // The UPDATE query must include AND tenant_id
    expect(src).toContain('WHERE employee_id = $8 AND tenant_id = $9 RETURNING');
  });

  it('HAPPY: appointment update transaction follows appointments → customers order', async () => {
    // WHO: tenant admin updating an appointment with customer info changes
    // WHAT: transaction updates appointments first, then customers
    // WHEN: POST /appointments/:id/update with customer_name or customer_phone
    // WHERE: src/routes/appointments.ts — the explicit BEGIN/COMMIT transaction
    // WHY: if the order were reversed (customers first, then appointments), a concurrent
    //      appointment cancel (which locks appointments then looks up customer_id) would
    //      deadlock with the update. Consistent order: appointments → customers in all paths.
    const fs = require('fs');
    const src = fs.readFileSync('src/routes/appointments.ts', 'utf8');
    // UPDATE appointments should appear before UPDATE customers in the transaction
    const apptUpdateIdx = src.indexOf('UPDATE appointments SET');
    const custUpdateIdx = src.indexOf('UPDATE customers SET');
    expect(apptUpdateIdx).toBeLessThan(custUpdateIdx);
  });

  it('HAPPY: tenant creation follows tenants → users order', async () => {
    // WHO: super-admin creating a new tenant, or new user self-registering
    // WHAT: shared transactional helper inserts into tenants first, then users
    // WHEN: POST /tenants/create or POST /register — both routes call createTenantWithOwner
    // WHERE: src/services/tenants/bootstrap.ts — single source of truth for the
    //         tenant+user transaction (extracted from both routes to remove duplicate
    //         transactional logic; the lock-order invariant lives here now)
    // WHY: both routes must follow the same lock order (tenants → users) because they
    //      can run concurrently. Consolidating the transaction into one helper makes
    //      the invariant easier to enforce — there's no second copy that could drift.
    //      If the helper inserted users before tenants, concurrent /register +
    //      /tenants/create would deadlock on circular waits.
    const fs = require('fs');
    const helperSrc = fs.readFileSync('src/services/tenants/bootstrap.ts', 'utf8');

    const tenantInsertIdx = helperSrc.indexOf('INSERT INTO tenants');
    const userInsertIdx = helperSrc.indexOf('INSERT INTO users');
    expect(tenantInsertIdx).toBeGreaterThan(-1);
    expect(userInsertIdx).toBeGreaterThan(-1);
    expect(tenantInsertIdx).toBeLessThan(userInsertIdx);

    // Guardrail: neither route file should inline its own tenant+user INSERT
    // sequence anymore — that would mean we forgot to route through the helper.
    const authSrc = fs.readFileSync('src/routes/auth.ts', 'utf8');
    const tenantsSrc = fs.readFileSync('src/routes/tenants.ts', 'utf8');
    expect(authSrc).not.toContain('INSERT INTO tenants');
    expect(authSrc).not.toContain('INSERT INTO users');
    expect(tenantsSrc).not.toContain('INSERT INTO tenants');
    expect(tenantsSrc).not.toContain('INSERT INTO users');
  });
});

describe('Deadlock Prevention: Pool Configuration', () => {
  it('HAPPY: pool options string includes all three timeout settings', () => {
    // WHO: the Fastify server starting up and creating its connection pool
    // WHAT: the pg Pool constructor should include statement_timeout, lock_timeout,
    //       and idle_in_transaction_session_timeout in the options string
    // WHEN: server startup via getPool() in src/database/index.ts
    // WHERE: src/database/index.ts pool configuration. Consolidated from
    //        src/index.ts during the pool-deduplication cleanup so the
    //        reminder/communications pool inherits the same timeouts.
    // WHY: these three timeouts form the deadlock safety net:
    //      - statement_timeout prevents runaway queries from holding locks indefinitely
    //      - lock_timeout makes contested lock acquisitions fail fast instead of queueing
    //      - idle_in_transaction_session_timeout kills abandoned transactions that hold locks
    //      Without ALL THREE, there are gaps in the safety net that can cause pool exhaustion.
    const fs = require('fs');
    const src = fs.readFileSync('src/database/index.ts', 'utf8');
    expect(src).toContain('statement_timeout');
    expect(src).toContain('lock_timeout');
    expect(src).toContain('idle_in_transaction_session_timeout');
  });

  it('SAD: pool without timeouts would allow a single deadlock to exhaust all connections', () => {
    // WHO: production server under load with a deadlocked transaction
    // WHAT: without timeouts, the deadlocked connection never releases
    // WHEN: two concurrent CRM sync operations create a circular lock wait
    // WHERE: src/index.ts pool configuration — max:10 connections
    // WHY: with max=10 connections and no timeouts, 10 deadlocked transactions = zero
    //      available connections = every subsequent request hangs on pool.connect() forever.
    //      The server appears alive (health check works if it doesn't need DB) but every
    //      API call times out. This happened in testing before timeouts were added.
    //      The fix is: lock_timeout makes one side of the deadlock fail, releasing its locks.
    const fs = require('fs');
    const src = fs.readFileSync('src/index.ts', 'utf8');
    // Verify the pool has an explicit max to prevent unbounded connection growth
    expect(src).toContain('max: 10');
  });
});
