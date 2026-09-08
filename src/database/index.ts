/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
/**
 * no-unsafe-* rules disabled: this file contains the core dynamic query layer
 * (raw SQL strings, pg result row access, error handling from external DB).
 * The dynamic nature is by design for flexibility in the repository layer.
 *
 * Part of ESLint debt reduction (historical REFACTORING_TODO.md item 10; see RESOLVED.md).
 */

/**
 * DatabaseService - Adapter layer for secretary-hq database operations.
 *
 * Bridges the gap between secretary-hq's withTenantClient(pool) pattern and
 * the DatabaseService interface expected by migrated communications/reminders services.
 *
 * Pattern: Repository with lazy pool initialization.
 */

import { Pool, type PoolClient } from 'pg';
import type {
  ConsentRecord,
  OptOutRecord,
  ReminderSchedule,
  ReminderData,
  AppointmentForReminder,
} from '../types/index.js';

// ── Pool Singleton ───────────────────────────────────────────────────

let _pool: Pool | null = null;

/**
 * Deadlock-prevention session settings applied to every pool connection.
 *
 * Without these a single deadlocked connection can hold locks indefinitely
 * and exhaust the pool (default 10 connections), blocking every other
 * request. Applied via the per-connection `options` parameter so they take
 * effect for every backend pg session this pool spawns — both for the
 * Fastify route surface and the reminder / communications workers.
 *
 *   - statement_timeout: kill queries that run too long
 *   - lock_timeout: fail fast if a row/table lock is contested
 *   - idle_in_transaction_session_timeout: close idle txns holding locks
 */
const POOL_TIMEOUT_OPTIONS =
  '-c statement_timeout=30000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=60000';

/**
 * Get or create the database pool. Lazy singleton; the same instance is
 * shared by Fastify routes, the reminder scheduler, and the communications
 * service so they all benefit from the same safety timeouts.
 */
export function getPool(): Pool {
  if (!_pool) {
    // `isLocal` only decides SSL: a localhost Postgres (dev, CI) has no TLS,
    // a managed one (prod) requires it. The connection STRING is always
    // honored when DATABASE_URL is set — including its database name. The
    // previous code hardcoded `database: 'postgres'` for the local branch,
    // which silently ignored DATABASE_URL's db name: CI seeds `test_db` but
    // the server connected to `postgres` → "relation users does not exist".
    const databaseUrl =
      process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';
    const isLocal = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1');
    // connectionTimeoutMillis bounds the CLIENT-side pool checkout wait.
    // POOL_TIMEOUT_OPTIONS above are Postgres server-side GUCs (statement /
    // lock / idle-in-txn) — they do NOT cap how long pool.connect() blocks
    // when all `max` clients are checked out. Without this, a request that
    // can't get a slot under high call concurrency waits forever (silent
    // hang). 5s = the request budget for a voice agent: fail fast and shed
    // load rather than build an unbounded queue. A rejected checkout
    // surfaces as an error → Fastify error handler → errors_total, so
    // saturation is visible instead of invisible. (2026-05-21)
    _pool = new Pool({
      connectionString: databaseUrl,
      // Local/CI Postgres serves plain TCP; managed Postgres requires TLS.
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
      max: 10,
      connectionTimeoutMillis: 5000,
      options: POOL_TIMEOUT_OPTIONS,
    });
  }
  return _pool;
}

/**
 * Close the pool (for graceful shutdown).
 */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * Set tenant context for RLS.
 */
async function setTenantContext(client: PoolClient, tenantId: string | number): Promise<void> {
  await client.query('SELECT set_tenant_context($1::UUID)', [tenantId.toString()]);
}

/**
 * Clear tenant context after operation.
 */
async function clearTenantContext(client: PoolClient): Promise<void> {
  await client.query("SELECT set_config('app.current_tenant_id', '', false)").catch(() => {});
}

// ── withTenantClient Factory ─────────────────────────────────────────

/**
 * Per-request RLS scope. The shape route handlers consume.
 */
export type WithTenantClient = <T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
) => Promise<T>;

/**
 * Build the `withTenantClient` helper that every Fastify route uses to
 * acquire a tenant-scoped DB client. Verifies the tenant exists, sets the
 * `app.current_tenant_id` GUC for the duration of the callback, and clears
 * it on the way out.
 *
 * Curried over the pool so tests can inject a fixture pool while production
 * binds against `getPool()`. Routes treat the returned function as opaque.
 *
 * Throws an error tagged `code: 'TENANT_NOT_FOUND'` / `statusCode: 404` for
 * an unknown tenant — the global error handler in src/index.ts maps that
 * to a 404 response.
 */
export function createWithTenantClient(pool: Pool): WithTenantClient {
  return async function withTenantClient<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await pool.connect();
    try {
      // Validate tenant exists AND IS NOT SOFT-DELETED, before setting context (so
      // RLS doesn't block the check).
      //
      // THIS IS THE CHOKE POINT FOR TENANT SOFT-DELETE (2026-07-13). Roughly 35
      // places in src/ read the tenants table, and a soft delete is only as good as
      // its filter coverage: miss ONE and a "deleted" business keeps answering its
      // phone, booking appointments, and billing — a zombie tenant, which is worse
      // than the hard delete we replaced. Rather than sprinkle `AND is_deleted =
      // false` across 35 call sites and hope, every tenant-scoped route funnels
      // through here, and a soft-deleted tenant is indistinguishable from a
      // nonexistent one: TENANT_NOT_FOUND → 404.
      //
      // That covers every route using withTenantClient. The remaining paths use the
      // raw pool (auth/login, the Stripe webhook, inbound-SMS tenant resolution by
      // phone, the demo reaper, the schedule extender, the tenant list) and are
      // filtered explicitly at each site — they are enumerated, not assumed.
      const tenantCheck = await client.query(
        'SELECT tenant_id FROM tenants WHERE tenant_id = $1 AND is_deleted = false',
        [tenantId]
      );
      if (tenantCheck.rows.length === 0) {
        const err = new Error(`Tenant ${tenantId} not found`);
        (err as unknown as { statusCode: number }).statusCode = 404;
        (err as unknown as { code: string }).code = 'TENANT_NOT_FOUND';
        throw err;
      }
      await setTenantContext(client, tenantId);
      return await fn(client);
    } finally {
      await clearTenantContext(client);
      client.release();
    }
  };
}

/**
 * Run `fn` with the tenant RLS context set on a client the caller ALREADY owns,
 * restoring whatever context was there before.
 *
 * WHY THIS EXISTS (2026-07-27, measured in production). The app connected as a
 * BYPASSRLS role for its whole life, so every policy was inert and a write with
 * no tenant context was indistinguishable from a correct one. Several services
 * therefore take the raw pool and write tenant-scoped rows with no context at
 * all — `demoSeed.ts` even documents it: "Uses the raw pool (no RLS context) —
 * admin-level write." Under enforcement that is not an admin write, it is a
 * REFUSED write:
 *
 *     new row violates row-level security policy for table "tenant_skills"
 *
 * That is the real error from the real switch: `POST /demo/start` — the public
 * "Try live demo" button — 500'd within seconds of `DATABASE_URL` moving to
 * `app_user`. Only `tenants`, `users` and `business_templates` carry an
 * admin_bypass policy; every other tenant-scoped table has isolation ONLY, so an
 * unset context means `tenant_ctx_uuid()` is NULL and the WITH CHECK denies.
 *
 * SAVE-AND-RESTORE, not set-and-clear. `createWithTenantClient` clears to '' on
 * the way out because it owns the connection and is handing it back to the pool.
 * A helper that runs INSIDE someone else's flow must not do that: clearing would
 * silently strip an outer context and the next statement in the caller's own
 * transaction would start failing, which is a far nastier bug than the one being
 * fixed. So we read the current value first and put it back.
 *
 * Session-level (`is_local = false`) so it works whether or not the caller has
 * a transaction open; the restore in `finally` is what bounds it.
 */
/**
 * Run queries that share ONE pg client one after another.
 *
 * `await Promise.all([client.query(a), client.query(b)])` looks concurrent and is
 * not: node-postgres serialises statements on a single client anyway, so the only
 * thing the array literal buys is starting every query before the first has
 * finished — which is exactly the state pg warns about,
 *
 *     DeprecationWarning: Calling client.query() when the client is already
 *     executing a query is deprecated and will be removed in pg@9.
 *
 * Passing THUNKS instead of promises is the whole point: `() => client.query(...)`
 * is not started until its turn, so nothing overlaps. They arrive as rest parameters
 * (`...thunks` — the JS spread form, nothing to do with REST APIs) rather than as one
 * array argument, because that is what makes TypeScript infer a TUPLE and give each
 * destructured result its own row type instead of a union of all of them. Wall-clock is unchanged
 * because there was never any real parallelism to lose. Giving each query its own
 * pooled client WOULD be concurrent, but every one of them would need the tenant
 * GUC set again, and a request that checks out five connections to render one
 * dashboard panel is a worse trade than a few serial round-trips.
 */
export async function queryInSeries<T extends readonly (() => Promise<unknown>)[]>(
  ...thunks: T
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const results: unknown[] = [];
  for (const thunk of thunks) {
    results.push(await thunk());
  }
  return results as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}

export async function withTenantContext<T>(
  client: PoolClient,
  tenantId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = await client.query<{ v: string }>(
    "SELECT coalesce(current_setting('app.current_tenant_id', true), '') AS v"
  );
  const previous = prev.rows[0]?.v ?? '';
  await client.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantId]);
  try {
    return await fn();
  } finally {
    await client
      .query("SELECT set_config('app.current_tenant_id', $1, false)", [previous])
      .catch(() => {});
  }
}

/**
 * Lead time for the four legacy reminder types, for writers that predate the
 * lead_minutes column. Confirmation fires at booking, so its lead is 0.
 */
const LEGACY_LEAD_MINUTES_BY_TYPE: Record<string, number> = {
  confirmation: 0,
  '72h': 4320,
  '24h': 1440,
  '2h': 120,
};

/**
 * The lead to write for a reminder row. Explicit value wins; a legacy type falls
 * back to its known lead.
 *
 * THROWS for anything else — notably a 'custom' reminder with no lead_minutes.
 * Defaulting that to 0 would write a reminder scheduled AT the appointment time
 * that the send path then describes as firing "shortly": a row that is silently,
 * unfixably wrong and only surfaces when a customer complains their reminder came
 * as they walked in. A caller that reaches here without a lead has a bug, and a
 * loud failure at write time is worth more than a plausible-looking bad row.
 */
function resolveLeadMinutesForInsert(data: ReminderData): number {
  const explicit = data.lead_minutes;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) return explicit;

  const legacy = LEGACY_LEAD_MINUTES_BY_TYPE[data.reminder_type as string];
  if (typeof legacy === 'number') return legacy;

  throw new Error(
    `createReminderSchedule: reminder_type '${String(data.reminder_type)}' has no legacy lead and no lead_minutes was supplied. ` +
      `A 'custom' reminder MUST carry the caller's chosen lead — refusing to default it to 0.`
  );
}

// ── DatabaseService Interface ────────────────────────────────────────

/**
 * Interface expected by ReminderService and ConsentService.
 * Abstracts database operations for testability and migration compatibility.
 */
export interface DatabaseService {
  // Reminder operations
  createReminderSchedule(data: ReminderData): Promise<ReminderSchedule>;
  getReminderSchedule(id: string): Promise<ReminderSchedule | null>;
  updateReminderSchedule(
    id: string,
    data: Partial<ReminderSchedule>
  ): Promise<ReminderSchedule | null>;
  getReminderSchedulesByTenant(tenantId: string, status?: string): Promise<ReminderSchedule[]>;
  getReminderSchedulesByAppointment(
    appointmentId: string,
    tenantId: string
  ): Promise<ReminderSchedule[]>;
  getDueReminders(): Promise<ReminderSchedule[]>;

  // Appointment operations
  //
  // `tenantId` is REQUIRED, and required in the TYPE rather than in a comment.
  // `appointments` carries FORCE ROW LEVEL SECURITY with a single policy —
  // `tenant_id = tenant_ctx_uuid()` — and NO admin-bypass policy, so a read on
  // a connection with no tenant context matches zero rows and returns null for
  // an appointment that plainly exists. An earlier version of this fix left the
  // parameter optional with a comment saying it was required in production;
  // that is documentation instead of enforcement, and it left a real
  // context-less caller (reminderRepository) compiling happily. Omitting it is
  // now a type error. See the implementation for the incident.
  getAppointmentById(id: string, tenantId: string): Promise<AppointmentForReminder | null>;

  // Consent operations
  createConsentRecord(data: Omit<ConsentRecord, 'consent_record_id'>): Promise<ConsentRecord>;
  getConsentRecordsByCustomer(
    tenantId: string,
    customerEmail?: string,
    customerPhone?: string
  ): Promise<ConsentRecord[]>;
  getConsentRecordsByTenant(tenantId: string): Promise<ConsentRecord[]>;
  updateConsentRecord(id: number, data: Partial<ConsentRecord>): Promise<ConsentRecord | null>;

  // Opt-out operations
  createOptOutRecord(data: Omit<OptOutRecord, 'opt_out_record_id'>): Promise<OptOutRecord>;
  getOptOutRecordsByTenant(tenantId: string): Promise<OptOutRecord[]>;
}

// ── PostgresDatabaseService Implementation ───────────────────────────

/**
 * PostgreSQL implementation of DatabaseService.
 * Uses secretary-hq's pool and RLS patterns.
 */
export class PostgresDatabaseService implements DatabaseService {
  private pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool || getPool();
  }

  // ── Helper ─────────────────────────────────────────────────────────

  private async withTenantClient<T>(
    tenantId: string | number,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await setTenantContext(client, tenantId);
      return await fn(client);
    } finally {
      await clearTenantContext(client);
      client.release();
    }
  }

  private async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  // ── Reminder Operations ────────────────────────────────────────────

  async createReminderSchedule(data: ReminderData): Promise<ReminderSchedule> {
    return this.withTenantClient(data.tenant_id, async (client) => {
      const result = await client.query(
        `INSERT INTO reminder_schedules
         (appointment_id, tenant_id, customer_email, customer_phone, reminder_type, scheduled_for, lead_minutes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          data.appointment_id,
          data.tenant_id,
          data.customer_email,
          data.customer_phone || null,
          data.reminder_type,
          data.scheduled_for,
          // lead_minutes is NOT NULL (migration 20260712010000) — the lead is data
          // now, not something you infer from the type name. Legacy types fall
          // back to their known lead so old callers still write truthful rows.
          // 'custom' has NO legacy mapping by definition, so a missing lead there
          // is a caller bug: defaulting it to 0 would write a reminder that fires
          // at the appointment time and reads as "shortly" — silently wrong, and
          // invisible until a customer complains. Fail loudly instead.
          resolveLeadMinutesForInsert(data),
          data.status || 'scheduled',
        ]
      );
      return result.rows[0];
    });
  }

  async getReminderSchedule(id: string): Promise<ReminderSchedule | null> {
    return this.withClient(async (client) => {
      const result = await client.query(
        'SELECT * FROM reminder_schedules WHERE reminder_schedule_id = $1',
        [id]
      );
      return result.rows[0] || null;
    });
  }

  async updateReminderSchedule(
    id: string,
    data: Partial<ReminderSchedule>
  ): Promise<ReminderSchedule | null> {
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (data.status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      values.push(data.status);
    }
    if (data.sent_at !== undefined) {
      updates.push(`sent_at = $${paramIndex++}`);
      values.push(data.sent_at);
    }
    if (data.error !== undefined) {
      updates.push(`error = $${paramIndex++}`);
      values.push(data.error);
    }
    // Retry-policy fields (migration 20260514000000). The worker writes
    // these on a transient failure to schedule the next attempt; nothing
    // outside the worker should be touching them, but the SET clause
    // accepts them to keep the API symmetric with the ReminderSchedule
    // type.
    if (data.retry_count !== undefined) {
      updates.push(`retry_count = $${paramIndex++}`);
      values.push(data.retry_count);
    }
    if (data.next_retry_at !== undefined) {
      updates.push(`next_retry_at = $${paramIndex++}`);
      values.push(data.next_retry_at);
    }

    if (updates.length === 0) {
      return this.getReminderSchedule(id);
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    return this.withClient(async (client) => {
      const result = await client.query(
        `UPDATE reminder_schedules SET ${updates.join(', ')} WHERE reminder_schedule_id = $${paramIndex} RETURNING *`,
        values
      );
      return result.rows[0] || null;
    });
  }

  async getReminderSchedulesByTenant(
    tenantId: string,
    status?: string
  ): Promise<ReminderSchedule[]> {
    return this.withTenantClient(tenantId, async (client) => {
      if (status) {
        const result = await client.query(
          'SELECT * FROM reminder_schedules WHERE tenant_id = $1 AND status = $2 ORDER BY scheduled_for',
          [tenantId, status]
        );
        return result.rows;
      }
      const result = await client.query(
        'SELECT * FROM reminder_schedules WHERE tenant_id = $1 ORDER BY scheduled_for',
        [tenantId]
      );
      return result.rows;
    });
  }

  async getReminderSchedulesByAppointment(
    appointmentId: string,
    tenantId: string
  ): Promise<ReminderSchedule[]> {
    return this.withTenantClient(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM reminder_schedules WHERE appointment_id = $1 AND tenant_id = $2',
        [appointmentId, tenantId]
      );
      return result.rows;
    });
  }

  async getDueReminders(): Promise<ReminderSchedule[]> {
    // The next_retry_at filter holds back rows that failed a previous
    // attempt and are still in their backoff window. A NULL value means
    // either the original attempt (no prior failure) or — for rows
    // pre-dating migration 20260514000000 — the column didn't exist yet.
    // Either way, NULL is "pick it up if scheduled_for is due."
    return this.withClient(async (client) => {
      const result = await client.query(
        // THE JOIN IS LOAD-BEARING (2026-07-13). Soft-deleting a tenant does NOT
        // cascade — its reminder_schedules rows survive, still 'scheduled', still
        // due. This sweep is cross-tenant, so without the is_deleted filter A
        // DELETED BUSINESS WOULD KEEP TEXTING ITS CUSTOMERS...
        //
        // FOR UPDATE SKIP LOCKED claims rows atomically. Prevents duplicate
        // processing if multiple workers or overlapping ticks hit the same due row.
        // SKIP LOCKED avoids blocking on rows already claimed by another worker.
        `SELECT rs.* FROM reminder_schedules rs
           JOIN tenants t ON t.tenant_id = rs.tenant_id AND t.is_deleted = false
          WHERE rs.status = 'scheduled'
            AND rs.scheduled_for <= NOW()
            AND (rs.next_retry_at IS NULL OR rs.next_retry_at <= NOW())
          ORDER BY rs.scheduled_for
          LIMIT 100
          FOR UPDATE SKIP LOCKED`
      );
      return result.rows;
    });
  }

  // ── Appointment Operations ─────────────────────────────────────────

  async getAppointmentById(id: string, tenantId: string): Promise<AppointmentForReminder | null> {
    // WHY THIS TAKES A tenantId. It used to run on `withClient`, which sets no
    // RLS tenant context. In production that is fatal and silent:
    // `appointments` has FORCE ROW LEVEL SECURITY and exactly one policy,
    // `tenant_id = tenant_ctx_uuid()`. With no context `tenant_ctx_uuid()` is
    // NULL, `tenant_id = NULL` evaluates to NULL, and the row is filtered out —
    // so this returned null for appointments that exist, and every reminder was
    // marked 'failed' with "Appointment not found".
    //
    // `reminder_schedules` did NOT show the problem because it carries an
    // `admin_bypass` policy (`tenant_ctx() = ''`) so the cross-tenant reminder
    // sweep can read it. `appointments` has no such policy and must not — it is
    // tenant data. So the fix is to supply the context, not to widen the policy.
    //
    // Observed on prod 2026-08-20, in the first 60 seconds after the reminder
    // pipeline was restored (migration 20260819000000): all 8 pending reminders
    // went straight to 'failed'. The path had never run before, so this was
    // never a regression — it was simply unreachable behind the earlier outage.
    return this.withTenantClient(tenantId, (client) => this.appointmentByIdQuery(client, id));
  }

  private async appointmentByIdQuery(
    client: PoolClient,
    id: string
  ): Promise<AppointmentForReminder | null> {
    const result = await client.query(
      `SELECT
          a.appointment_id as "appointmentId",
          a.tenant_id as "tenantId",
          a.customer_id as "customerId",
          c.email as "customerEmail",
          c.phone as "customerPhone",
          c.name as "customerName",
          s.name as "serviceName",
          e.name as "staffName",
          a.start_time as "dateTime",
          EXTRACT(EPOCH FROM (a.end_time - a.start_time))/60 as "duration",
          a.status,
          a.description as "notes"
        FROM appointments a
        LEFT JOIN customers c ON a.customer_id = c.customer_id
        LEFT JOIN services s ON a.service_id = s.service_id
        LEFT JOIN employees e ON a.employee_id = e.employee_id
        WHERE a.appointment_id = $1 AND a.is_deleted = false`,
      [id]
    );
    return result.rows[0] || null;
  }

  // ── Consent Operations ─────────────────────────────────────────────

  async createConsentRecord(
    data: Omit<ConsentRecord, 'consent_record_id'>
  ): Promise<ConsentRecord> {
    return this.withTenantClient(data.tenant_id, async (client) => {
      const result = await client.query(
        `INSERT INTO consent_records
         (tenant_id, customer_id, customer_email, customer_phone, consent_type,
          consent_given, consent_date, consent_method, consent_source, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          data.tenant_id,
          data.customer_id || null,
          data.customer_email || null,
          data.customer_phone || null,
          data.consent_type,
          data.consent_given,
          data.consent_date,
          data.consent_method,
          data.consent_source || null,
          data.ip_address || null,
        ]
      );
      return result.rows[0];
    });
  }

  async getConsentRecordsByCustomer(
    tenantId: string,
    customerEmail?: string,
    customerPhone?: string
  ): Promise<ConsentRecord[]> {
    return this.withTenantClient(tenantId, async (client) => {
      const conditions: string[] = ['tenant_id = $1'];
      const values: unknown[] = [tenantId];
      let paramIndex = 2;

      if (customerEmail) {
        conditions.push(`customer_email = $${paramIndex++}`);
        values.push(customerEmail);
      }
      if (customerPhone) {
        conditions.push(`customer_phone = $${paramIndex++}`);
        values.push(customerPhone);
      }

      const result = await client.query(
        `SELECT * FROM consent_records WHERE ${conditions.join(' AND ')} ORDER BY consent_date DESC`,
        values
      );
      return result.rows;
    });
  }

  async getConsentRecordsByTenant(tenantId: string): Promise<ConsentRecord[]> {
    return this.withTenantClient(tenantId, async (client) => {
      const result = await client.query(
        'SELECT * FROM consent_records WHERE tenant_id = $1 ORDER BY consent_date DESC',
        [tenantId]
      );
      return result.rows;
    });
  }

  async updateConsentRecord(
    id: number,
    data: Partial<ConsentRecord>
  ): Promise<ConsentRecord | null> {
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (data.revoked_at !== undefined) {
      updates.push(`revoked_at = $${paramIndex++}`);
      values.push(data.revoked_at);
    }
    if (data.revoke_reason !== undefined) {
      updates.push(`revoke_reason = $${paramIndex++}`);
      values.push(data.revoke_reason);
    }
    if (data.consent_given !== undefined) {
      updates.push(`consent_given = $${paramIndex++}`);
      values.push(data.consent_given);
    }

    if (updates.length === 0) {
      return this.withClient(async (client) => {
        const result = await client.query(
          'SELECT * FROM consent_records WHERE consent_record_id = $1',
          [id]
        );
        return result.rows[0] || null;
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    return this.withClient(async (client) => {
      const result = await client.query(
        `UPDATE consent_records SET ${updates.join(', ')} WHERE consent_record_id = $${paramIndex} RETURNING *`,
        values
      );
      return result.rows[0] || null;
    });
  }

  // ── Opt-Out Operations ─────────────────────────────────────────────

  async createOptOutRecord(data: Omit<OptOutRecord, 'opt_out_record_id'>): Promise<OptOutRecord> {
    return this.withTenantClient(data.tenant_id, async (client) => {
      const result = await client.query(
        `INSERT INTO opt_out_records
         (tenant_id, customer_email, customer_phone, opt_out_type, opt_out_date,
          opt_out_method, original_consent_record_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          data.tenant_id,
          data.customer_email || null,
          data.customer_phone || null,
          data.opt_out_type,
          data.opt_out_date,
          data.opt_out_method,
          data.original_consent_record_id || null,
          data.notes || null,
        ]
      );
      return result.rows[0];
    });
  }

  async getOptOutRecordsByTenant(tenantId: string): Promise<OptOutRecord[]> {
    return this.withTenantClient(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM opt_out_records WHERE tenant_id = $1 ORDER BY opt_out_date DESC`,
        [tenantId]
      );
      return result.rows;
    });
  }
}

// ── Factory Function ─────────────────────────────────────────────────

/**
 * Create a new DatabaseService instance.
 * Uses the shared pool by default.
 */
export function createDatabaseService(pool?: Pool): DatabaseService {
  return new PostgresDatabaseService(pool);
}

// ── Default Export ───────────────────────────────────────────────────

export default createDatabaseService;
