import { Client, type Pool } from 'pg';
import bcrypt from 'bcrypt';

// Always use test_db for tests. Prefer DATABASE_URL or TEST_ADMIN_DATABASE_URL from env
// (set by test:ci or command line) with correct password; fallback to local postgres one.
export const ROOT_DB_URL = process.env.DATABASE_URL?.includes('test_db')
  ? process.env.DATABASE_URL
  : (process.env.TEST_ADMIN_DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/test_db');

// ── Honest-skip helper ────────────────────────────────────────────────
// Used in `beforeEach` to mark a test as SKIPPED (not silently PASSED)
// when the local DB is unavailable. Origin: 2026-05-15 — the prior
// pattern `if (!dbAvailable) return;` inside every `it` body let tests
// count as passed without running any assertions, hiding the fact that
// the suite never exercised the real DB. ctx.skip() makes Vitest report
// the test as skipped; REQUIRE_DB_TESTS=1 turns the same condition into
// a hard failure (CI must fail rather than tolerate a missing DB).
//
// Usage: beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));
export function skipIfDbDown(ctx: { skip: () => void }, isDbAvailable: () => boolean): void {
  if (isDbAvailable()) return;
  if (process.env.REQUIRE_DB_TESTS === '1') {
    throw new Error(
      'REQUIRE_DB_TESTS=1 set but local DB unreachable — start `docker compose up -d db` and run `npm run db:migrate` against test_db before retrying.'
    );
  }
  ctx.skip();
}

// Derived API URL: extract host/port/dbname from ROOT_DB_URL but use api_user
const apiHostPortDb = ROOT_DB_URL.split('@')[1] || 'localhost:5433/test_db';
export const API_DB_URL = `postgres://api_user:api_password@${apiHostPortDb}`;

export async function getRootClient() {
  const client = new Client({ connectionString: ROOT_DB_URL });
  await client.connect();
  return client;
}

export async function getApiClient() {
  const client = new Client({ connectionString: API_DB_URL });
  await client.connect();
  return client;
}

export async function clearDB(client: Client) {
  // Truncate all known tables, ignoring missing ones (schema may vary between environments)
  const tables = [
    'tenants',
    'resources',
    'customers',
    'appointments',
    'call_summaries',
    'call_transcripts',
    'soft_reservations',
    'users',
    'services',
    'employees',
    'employee_schedule',
    'service_employee',
    'service_resource',
    'tenant_docs',
    'tenant_skills',
  ];
  for (const table of tables) {
    await client.query(`TRUNCATE ${table} CASCADE`).catch(() => {
      /* table may not exist */
    });
  }
}

/** Check if a table exists in the current database */
export async function tableExists(client: Client, tableName: string): Promise<boolean> {
  const res = await client.query(
    'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)',
    [tableName]
  );
  return res.rows[0].exists;
}

export async function setupBasicTenant(client: Client) {
  const tRes = await client.query(
    "INSERT INTO tenants (name, business_type) VALUES ('DynaTire', 'mobile-tire') RETURNING tenant_id;"
  );
  const tenantId = tRes.rows[0].tenant_id;
  const rRes = await client.query(
    "INSERT INTO resources (tenant_id, name) VALUES ($1, 'Truck 1') RETURNING resource_id;",
    [tenantId]
  );
  const resourceId = rRes.rows[0].resource_id;
  const cRes = await client.query(
    "INSERT INTO customers (tenant_id, phone, name) VALUES ($1, '+15550001111', 'Alice') RETURNING customer_id;",
    [tenantId]
  );
  const customerId = cRes.rows[0].customer_id;

  return { tenantId, resourceId, customerId };
}

// ── Transaction-based test isolation ──────────────────────────────────
// Use savepoints instead of TRUNCATE for fast test isolation.
// beforeAll: clearDB + setupBasicTenant (once per file)
// beforeEach: SAVEPOINT (instant)
// afterEach: ROLLBACK TO SAVEPOINT (instant — undoes test changes)
//
// Deadlock prevention principles applied here:
// 1. CONSISTENT LOCK ORDERING — tests using clearDB() TRUNCATE all tables in one statement
//    with CASCADE, avoiding partial-lock states that cause circular waits.
// 2. SHORT TRANSACTIONS — savepoint/rollback pattern keeps test transactions brief.
// 3. TIMEOUT PROTECTION — lock_timeout set on connections to fail fast on contested locks.
// 4. SEQUENTIAL EXECUTION — vitest.config.ts sets fileParallelism:false so test files
//    never compete for table locks across parallel threads.

export async function beginTestTransaction(client: Client) {
  await client.query('BEGIN');
  await client.query('SAVEPOINT test_start');
}

export async function rollbackTestTransaction(client: Client) {
  // Try ROLLBACK TO SAVEPOINT first (preserves the outer transaction for next test).
  // Falls back to bare ROLLBACK for tests that manage their own BEGIN/COMMIT internally
  // and call rollbackTestTransaction without a matching beginTestTransaction.
  try {
    await client.query('ROLLBACK TO SAVEPOINT test_start');
  } catch {
    // No savepoint active — fall back to bare ROLLBACK (ends any open transaction)
    try {
      await client.query('ROLLBACK');
    } catch {
      /* no transaction — safe to ignore */
    }
  }
}

// ── Data creation helpers ─────────────────────────────────────────────

export async function createTenant(
  client: Client,
  name: string,
  businessType: string,
  timezone?: string
): Promise<string> {
  if (timezone) {
    const res = await client.query(
      'INSERT INTO tenants (name, business_type, timezone) VALUES ($1, $2, $3) RETURNING tenant_id',
      [name, businessType, timezone]
    );
    return res.rows[0].tenant_id;
  }
  const res = await client.query(
    'INSERT INTO tenants (name, business_type) VALUES ($1, $2) RETURNING tenant_id',
    [name, businessType]
  );
  return res.rows[0].tenant_id;
}

export async function createResource(
  client: Client,
  tenantId: string,
  name: string,
  description?: string
): Promise<string> {
  const res = await client.query(
    'INSERT INTO resources (tenant_id, name, description) VALUES ($1, $2, $3) RETURNING resource_id',
    [tenantId, name, description || null]
  );
  return res.rows[0].resource_id;
}

export async function createEmployee(
  client: Client,
  tenantId: string,
  name: string,
  skills?: string[]
): Promise<string> {
  const res = await client.query(
    'INSERT INTO employees (tenant_id, name, skills) VALUES ($1, $2, $3) RETURNING employee_id',
    [tenantId, name, skills || []]
  );
  return res.rows[0].employee_id;
}

/**
 * Insert one date-specific schedule entry into `employee_schedule`.
 * Booking + availability RPCs (book_appointment_atomic,
 * book_with_scheduling_atomic, check_availability_with_tz,
 * check_coverage_gaps) read employee_schedule exclusively — there is
 * no weekly-pattern table anymore (employee_shifts was dropped in
 * migration 20260430000002). Tests that need an employee to be
 * bookable on a specific date seed it here.
 */
export async function createScheduleEntry(
  client: Client,
  tenantId: string,
  employeeId: string,
  shiftDate: string,
  startTime: string,
  endTime: string,
  isOff: boolean = false
): Promise<void> {
  // 2026-05-18 composite-key retrofit pilot #3 dropped employee_schedule_id.
  // The composite PK (tenant_id, employee_id, shift_date) IS the row identity;
  // callers that need to reference the row use those three columns directly
  // rather than chaining off a returned UUID.
  await client.query(
    `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
         VALUES ($1, $2, $3::DATE, $4::TIME, $5::TIME, $6)
         ON CONFLICT (tenant_id, employee_id, shift_date) DO UPDATE SET
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           is_off = EXCLUDED.is_off`,
    [tenantId, employeeId, shiftDate, isOff ? null : startTime, isOff ? null : endTime, isOff]
  );
}

export async function createService(
  client: Client,
  tenantId: string,
  name: string,
  durationMinutes: number,
  price?: number
): Promise<string> {
  const res = await client.query(
    'INSERT INTO services (tenant_id, name, duration_minutes, price) VALUES ($1, $2, $3, $4) RETURNING service_id',
    [tenantId, name, durationMinutes, price || null]
  );
  return res.rows[0].service_id;
}

export async function createCustomer(
  client: Client,
  tenantId: string,
  name: string,
  phone: string
): Promise<string> {
  const res = await client.query(
    'INSERT INTO customers (tenant_id, phone, name) VALUES ($1, $2, $3) RETURNING customer_id',
    [tenantId, phone, name]
  );
  return res.rows[0].customer_id;
}

export async function createCustomerFull(
  client: Client,
  tenantId: string,
  phone: string,
  name: string,
  email?: string
): Promise<string> {
  const res = await client.query(
    'INSERT INTO customers (tenant_id, phone, name, email) VALUES ($1, $2, $3, $4) RETURNING customer_id',
    [tenantId, phone, name, email || null]
  );
  return res.rows[0].customer_id;
}

export async function createAppointment(
  client: Client,
  tenantId: string,
  resourceId: string,
  customerId: string,
  startTime: string,
  endTime: string,
  description: string,
  status?: string,
  employeeId?: string
): Promise<string> {
  const res = await client.query(
    `INSERT INTO appointments (tenant_id, resource_id, customer_id, start_time, end_time, description, status, employee_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING appointment_id`,
    [
      tenantId,
      resourceId,
      customerId,
      startTime,
      endTime,
      description,
      status || 'scheduled',
      employeeId || null,
    ]
  );
  return res.rows[0].appointment_id;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function createUser(
  client: Client,
  tenantId: string,
  email: string,
  password: string,
  fullName: string
): Promise<string> {
  const hash = await hashPassword(password);
  const res = await client.query(
    'INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, $2, $3, $4) RETURNING user_id',
    [tenantId, email, hash, fullName]
  );
  return res.rows[0].user_id;
}

// ── Service mapping helpers ───────────────────────────────────────────

export async function assignEmployeeToService(
  client: Client,
  tenantId: string,
  serviceId: string,
  employeeId: string
): Promise<void> {
  await client.query(
    'INSERT INTO service_employee (tenant_id, service_id, employee_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [tenantId, serviceId, employeeId]
  );
}

export async function assignResourceToService(
  client: Client,
  tenantId: string,
  serviceId: string,
  resourceId: string
): Promise<void> {
  await client.query(
    'INSERT INTO service_resource (tenant_id, service_id, resource_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [tenantId, serviceId, resourceId]
  );
}

/**
 * Delete a tenant, retrying through a Postgres deadlock.
 *
 * WHY (PR #242, CI run 29220656800): booking routes seed reminders FIRE-AND-FORGET
 * (`void scheduleRemindersForAppointment(...)`), so the INSERT into
 * reminder_schedules is still running after the HTTP response returned and the test
 * has moved on to teardown. That INSERT takes FK locks tenants → appointments; the
 * cascading DELETE takes them appointments → tenants. Opposite order = AB-BA cycle.
 * Postgres kills one side AT RANDOM, which is why the teardown failed roughly one
 * run in two and looked exactly like flake.
 *
 * Retry is the correct remedy, not a workaround: a deadlock is a transient
 * scheduling accident, not a logic error. One transaction is killed precisely so
 * the other can make progress, and the killed statement is perfectly valid the
 * instant it is retried. (Postgres's own docs say so: "applications should be
 * prepared to retry transactions aborted by deadlock".)
 *
 * 40P01 = deadlock_detected.
 */
export async function deleteTenantWithDeadlockRetry(
  pool: Pool,
  tenantId: string,
  maxAttempts = 5
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query('DELETE FROM tenants WHERE tenant_id = $1', [tenantId]);
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '40P01' || attempt === maxAttempts) throw err;
      // Back off a little so the racing transaction can finish and release.
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
  return false;
}
