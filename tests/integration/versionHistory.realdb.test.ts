/**
 * Real-DB companion tests for the version-history routes' IDENTIFIER-
 * INTERPOLATED SQL (per docs/TODO.md "Verification blind spots").
 *
 * src/routes/versionHistory.ts builds SQL by template-interpolating
 * IDENTIFIERS — `${table}` / `${pkColumn}` — into the statement text
 * (history record lookup ~line 205, deleted-records list ~lines 541 +
 * 561-576, restore-preview ~line 767) plus a dynamically-assembled
 * `whereClause += ... $${paramIndex}` on /records/recent-changes
 * (~lines 685-733). Identifiers are NOT bind parameters: a mocked pg
 * (src/versionHistory.test.ts) never parses the statement, so a typo'd
 * table/PK-column in the interpolation map, a column that doesn't exist
 * on one of the six mapped tables, or a mis-numbered $n placeholder all
 * ship GREEN under mocks. Only a real Postgres can reject them. This
 * suite executes every interpolated statement against every table in the
 * route's map, on a real pool (API_DB_URL) through the real
 * createWithTenantClient (RLS included).
 *
 * Versions are written by the `auto_version_trigger` (migration
 * 20260512000009) which fires on INSERT/UPDATE/DELETE of all six
 * versioned tables — fixtures here do a real INSERT + UPDATE per table
 * so record_versions rows exist without any manual seeding of that table.
 *
 * Isolation: this file creates its OWN tenants and deletes only them in
 * afterAll (FK cascade removes children + record_versions). No TRUNCATE —
 * other suites share this DB.
 *
 * 5W for sad-path failures (applies suite-wide; per-test comments refine):
 *   WHO  — a dashboard owner using the record-history / undelete UI
 *   WHAT — GET/POST /records/:table/... version-history endpoints
 *   WHEN — after editing or deleting a customer/appointment/etc.
 *   WHERE — src/routes/versionHistory.ts interpolated SQL → real Postgres
 *   WHY  — a bad identifier in the interpolation map is invisible to the
 *          mocked suite and 500s in production on first click
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Client, Pool } from 'pg';
import {
  API_DB_URL,
  getRootClient,
  createTenant,
  createCustomer,
  createEmployee,
  createService,
  createResource,
  createAppointment,
  skipIfDbDown,
} from '../utils';
import { createWithTenantClient } from '../../src/database';
import { registerVersionHistoryRoutes } from '../../src/routes/versionHistory';

// Test-only request shape: the preHandler injects tenantId (normally set by
// tenantMiddleware after JWT validation) for requireTenantId to read. Same
// wiring as the mocked src/versionHistory.test.ts.
type TenantRequest = FastifyRequest & {
  tenantId?: string;
  auth?: { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
};

/**
 * One entry per table in the route's VERSIONED_TABLES / PK_COLUMN_BY_TABLE
 * map. If the route adds a table, add a case here — the suite is only a
 * blindspot-closer while it covers the WHOLE map.
 *
 * `listName` / `listPhone`: expected display values on the
 * /records/:table/deleted response. HISTORY: pre-2026-07-01 that SQL
 * hard-coded `t.name, t.phone` for every table, but only customers +
 * employees have BOTH columns — the other four threw 42703
 * (undefined_column) → 500 on a real DB, a REAL BUG this suite caught and
 * pinned (the mocked suite shipped it green). Fixed 2026-07-01 with
 * per-table display-column expressions in the route; these expectations
 * assert the fixed mapping (appointments → description, voice_sessions →
 * call_id/caller_phone, services/resources → name only).
 * `listName: 'DYNAMIC'` = value is generated per-run (voice_sessions
 * call_id embeds a timestamp) — assert non-empty instead of an exact match.
 */
const TABLE_CASES = [
  {
    table: 'customers',
    pkColumn: 'customer_id',
    changedField: 'name',
    originalValue: 'Versioned Vera',
    updatedValue: 'Versioned Vera II',
    listName: 'Versioned Vera II',
    listPhone: '+15559980001',
  },
  {
    table: 'appointments',
    pkColumn: 'appointment_id',
    changedField: 'description',
    originalValue: 'Initial visit',
    updatedValue: 'Rescheduled visit notes',
    listName: 'Rescheduled visit notes', // COALESCE(description, ...)
    listPhone: null, // appointments have no phone column
  },
  {
    table: 'voice_sessions',
    pkColumn: 'voice_session_id',
    changedField: 'summary',
    originalValue: null,
    updatedValue: 'Caller asked about hours',
    listName: 'DYNAMIC', // call_id (per-run timestamp)
    listPhone: '+15559980001', // caller_phone
  },
  {
    table: 'employees',
    pkColumn: 'employee_id',
    changedField: 'name',
    originalValue: 'Versioned Eddie',
    updatedValue: 'Versioned Eddie II',
    listName: 'Versioned Eddie II',
    listPhone: null, // fixture employee has no phone set
  },
  {
    table: 'services',
    pkColumn: 'service_id',
    changedField: 'name',
    originalValue: 'Versioned Trim',
    updatedValue: 'Versioned Trim II',
    listName: 'Versioned Trim II',
    listPhone: null, // services have no phone column
  },
  {
    table: 'resources',
    pkColumn: 'resource_id',
    changedField: 'name',
    originalValue: 'Versioned Chair',
    updatedValue: 'Versioned Chair II',
    listName: 'Versioned Chair II',
    listPhone: null, // resources have no phone column
  },
] as const;

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
let tenantId: string;
let otherTenantId: string;
let otherTenantCustomerId: string;
const tenantsToClean: string[] = [];

/** record_id per versioned table, populated in beforeAll. */
const recordIds: Record<string, string> = {};

function get(url: string, tenant: string | null = tenantId) {
  return app.inject({
    method: 'GET',
    url,
    headers: tenant ? { 'x-tenant-id': tenant } : {},
  });
}

function post(url: string, payload: unknown, tenant: string | null = tenantId) {
  return app.inject({
    method: 'POST',
    url,
    headers: tenant ? { 'x-tenant-id': tenant } : {},
    payload: payload as Record<string, unknown>,
  });
}

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });

    app = Fastify({ logger: false });
    app.addHook('preHandler', async (request: TenantRequest) => {
      const headerTenant = request.headers['x-tenant-id'];
      if (typeof headerTenant === 'string' && headerTenant) {
        request.tenantId = headerTenant;
        // Owner by default — restore-fields/soft-delete/restore/copy-fields
        // are owner-gated (requireOwnerRole, 2026-09-16 role-check audit).
        request.auth = {
          tenant_id: headerTenant,
          user_id: '00000000-0000-0000-0000-000000000001',
          email: 'owner@test.local',
          role: 'owner',
        };
      }
    });
    registerVersionHistoryRoutes(app, pool, createWithTenantClient(pool));
    await app.ready();

    tenantId = await createTenant(setup, 'VersionHistory RealDB Tenant', 'salon');
    tenantsToClean.push(tenantId);

    // One row per versioned table: INSERT (→ trigger writes v1 'create') then
    // UPDATE one field (→ trigger writes v2 'update'). This is exactly how
    // record_versions rows are produced in production — no manual seeding.
    recordIds.customers = await createCustomer(setup, tenantId, 'Versioned Vera', '+15559980001');
    await setup.query(`UPDATE customers SET name = $2 WHERE customer_id = $1`, [
      recordIds.customers,
      'Versioned Vera II',
    ]);

    recordIds.employees = await createEmployee(setup, tenantId, 'Versioned Eddie');
    await setup.query(`UPDATE employees SET name = $2 WHERE employee_id = $1`, [
      recordIds.employees,
      'Versioned Eddie II',
    ]);

    recordIds.services = await createService(setup, tenantId, 'Versioned Trim', 30);
    await setup.query(`UPDATE services SET name = $2 WHERE service_id = $1`, [
      recordIds.services,
      'Versioned Trim II',
    ]);

    recordIds.resources = await createResource(setup, tenantId, 'Versioned Chair');
    await setup.query(`UPDATE resources SET name = $2 WHERE resource_id = $1`, [
      recordIds.resources,
      'Versioned Chair II',
    ]);

    recordIds.appointments = await createAppointment(
      setup,
      tenantId,
      recordIds.resources,
      recordIds.customers,
      '2027-03-01T15:00:00Z',
      '2027-03-01T16:00:00Z',
      'Initial visit'
    );
    await setup.query(`UPDATE appointments SET description = $2 WHERE appointment_id = $1`, [
      recordIds.appointments,
      'Rescheduled visit notes',
    ]);

    const vs = await setup.query<{ voice_session_id: string }>(
      `INSERT INTO voice_sessions (tenant_id, call_id, caller_phone)
       VALUES ($1, $2, $3) RETURNING voice_session_id`,
      [tenantId, `realdb-vh-${Date.now()}`, '+15559980001']
    );
    recordIds.voice_sessions = vs.rows[0].voice_session_id;
    await setup.query(`UPDATE voice_sessions SET summary = $2 WHERE voice_session_id = $1`, [
      recordIds.voice_sessions,
      'Caller asked about hours',
    ]);

    // Second tenant for cross-tenant isolation checks on the interpolated SQL.
    otherTenantId = await createTenant(setup, 'VersionHistory RealDB Other Tenant', 'salon');
    tenantsToClean.push(otherTenantId);
    otherTenantCustomerId = await createCustomer(
      setup,
      otherTenantId,
      'Other-Tenant Olga',
      '+15559980002'
    );

    dbAvailable = true;
  } catch (err) {
     
    console.warn('[versionHistory.realdb.test] DB not available, skipping', err);
  }
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (setup) {
    // Own-tenant cleanup ONLY — FK cascade removes customers/appointments/
    // voice_sessions/employees/services/resources AND record_versions rows.
    for (const id of tenantsToClean) {
      await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
    }
    await setup.end();
  }
});

beforeEach(async (ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
});

// ─────────────────────────────────────────────────────────────────────────
// GET /records/:table/:recordId/history — `${table}` + `${pkColumn}`
// interpolated into the record-info SELECT (route ~line 205).
// ─────────────────────────────────────────────────────────────────────────
describe('history endpoint — ${table}/${pkColumn} interpolation per table', () => {
  for (const c of TABLE_CASES) {
    it(`HAPPY ${c.table}: interpolated history SQL executes and returns create+update versions`, async () => {
      // WHO: an owner opening the record's History panel on the dashboard.
      // WHAT: GET /records/${c.table}/:id/history — the route interpolates
      //       `FROM ${c.table} WHERE ${c.pkColumn} = $1` into raw SQL.
      // WHEN: after the fixture row was INSERTed then UPDATEd (trigger wrote
      //       version 1 'create' and version 2 'update').
      // WHERE: versionHistory.ts history handler → real Postgres via RLS pool.
      // WHY: a wrong entry in PK_COLUMN_BY_TABLE (e.g. 'id' after the PK
      //      rename sprint) is a guaranteed prod 500 that mocks cannot see.
      const res = await get(`/records/${c.table}/${recordIds[c.table]}/history`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.table_name).toBe(c.table);
      expect(body.record_id).toBe(recordIds[c.table]);
      expect(body.is_deleted).toBe(false);
      expect(body.versions.length).toBeGreaterThanOrEqual(2);
      expect(body.current_version).toBe(body.versions[0].version_number);
      const types = body.versions.map((v: { change_type: string }) => v.change_type);
      expect(types).toContain('create');
      expect(types).toContain('update');
      // The 'update' version must record the field we actually changed.
      const update = body.versions.find((v: { change_type: string }) => v.change_type === 'update');
      expect(update.changed_fields).toContain(c.changedField);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /records/:table/:recordId/restore-preview — `${table}` + `${pkColumn}`
// interpolated into `SELECT to_jsonb(t.*) FROM ${table} t WHERE ${pkColumn}`
// (route ~line 767).
// ─────────────────────────────────────────────────────────────────────────
describe('restore-preview endpoint — ${table}/${pkColumn} interpolation per table', () => {
  for (const c of TABLE_CASES) {
    it(`HAPPY ${c.table}: interpolated restore-preview SQL executes and surfaces the changed field`, async () => {
      // WHO: an owner opening the field-level restore UI for a record.
      // WHAT: GET /records/${c.table}/:id/restore-preview — interpolates the
      //       table into a to_jsonb(t.*) SELECT with the mapped PK column.
      // WHEN: fixture has 2 trigger-written versions (create + update).
      // WHERE: versionHistory.ts restore-preview handler → real Postgres.
      // WHY: this handler reads the module-level PK_COLUMN_BY_TABLE map — a
      //      typo'd entry there is invisible to mocks; only executing the
      //      interpolated SQL against the live schema proves the mapping.
      const res = await get(`/records/${c.table}/${recordIds[c.table]}/restore-preview`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.record_id).toBe(recordIds[c.table]);
      expect(body.table_name).toBe(c.table);
      const field = body.fields.find((f: { field: string }) => f.field === c.changedField);
      expect(field).toBeDefined();
      expect(field.current_value).toBe(c.updatedValue);
      expect(field.versions.length).toBeGreaterThanOrEqual(2);
      // Correctness gap this closed: the table's REAL primary key
      // (customer_id, appointment_id, …) must NOT appear as a restorable
      // field. The old exclusion list only dropped a bare `id`, so the
      // renamed PK leaked into the options. excludedSystemFields(table) now
      // excludes it.
      const pkField = body.fields.find((f: { field: string }) => f.field === c.pkColumn);
      expect(
        pkField,
        `restore-preview must not expose ${c.pkColumn} as restorable`
      ).toBeUndefined();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Soft-delete → GET /records/:table/deleted → restore, per table.
// The deleted-list SQL (route ~lines 541 + 561-576) interpolates `${table}`
// THREE times plus `${pkColumn}` and per-table display-column expressions.
// ─────────────────────────────────────────────────────────────────────────
describe('soft-delete → deleted-list → restore round-trip per table', () => {
  for (const c of TABLE_CASES) {
    it(`HAPPY ${c.table}: delete → interpolated deleted-list → restore round-trip`, async () => {
      // WHO: an owner deleting a record then browsing the "deleted records"
      //      view to undelete it.
      // WHAT: POST soft-delete → GET /records/${c.table}/deleted (SQL with
      //       `FROM ${c.table} t`, `t.${c.pkColumn}`, literal '${c.table}'
      //       in record_versions subqueries, plus per-table display-column
      //       expressions) → POST restore.
      // WHEN: immediately after the soft delete, while is_deleted = true.
      // WHERE: versionHistory.ts deleted-records handler → real Postgres.
      // WHY: REAL BUG caught by this suite pre-fix — the SELECT hard-coded
      //      t.name and t.phone for every table, but appointments +
      //      voice_sessions have neither and services + resources have no
      //      phone, so 4 of the 6 supported tables threw 42703
      //      (undefined_column) → 500 on a real DB while the mocked suite
      //      shipped it green. FIXED 2026-07-01 (route change: per-table
      //      display-column map); this test now asserts the fixed behavior
      //      on every table, including the mapped name/phone values.
      const id = recordIds[c.table];

      const delRes = await post(`/records/${c.table}/${id}/soft-delete`, {
        deleted_by: 'realdb-test',
      });
      expect(delRes.statusCode).toBe(200);
      expect(delRes.json().success).toBe(true);

      const flagAfterDelete = await setup.query(
        `SELECT is_deleted FROM ${c.table} WHERE ${c.pkColumn} = $1`,
        [id]
      );
      expect(flagAfterDelete.rows[0].is_deleted).toBe(true);

      const listRes = await get(`/records/${c.table}/deleted`);
      expect(listRes.statusCode).toBe(200);
      const body = listRes.json();
      expect(body.total).toBeGreaterThanOrEqual(1);
      const row = body.records.find((r: { record_id: string }) => r.record_id === id);
      expect(row).toBeDefined();
      expect(row.table_name).toBe(c.table);
      expect(row.deleted_by).toBe('realdb-test');
      // Display columns per the 2026-07-01 mapping (name/phone keys always
      // present; null where the table has no natural counterpart).
      if (c.listName === 'DYNAMIC') {
        expect(typeof row.name).toBe('string');
        expect(row.name.length).toBeGreaterThan(0);
      } else {
        expect(row.name).toBe(c.listName);
      }
      expect(row.phone).toBe(c.listPhone);
      // record_versions correlated subqueries (interpolated table literal +
      // pk column) must have found the trigger-written versions.
      expect(parseInt(row.version_count)).toBeGreaterThanOrEqual(2);
      expect(row.last_data).toBeTruthy();

      const restoreRes = await post(`/records/${c.table}/${id}/restore`, {
        restored_by: 'realdb-test',
      });
      expect(restoreRes.statusCode).toBe(200);
      expect(restoreRes.json().success).toBe(true);

      const flagAfterRestore = await setup.query(
        `SELECT is_deleted FROM ${c.table} WHERE ${c.pkColumn} = $1`,
        [id]
      );
      expect(flagAfterRestore.rows[0].is_deleted).toBe(false);

      // The lifecycle must be visible in history: delete + restore versions.
      const histRes = await get(`/records/${c.table}/${id}/history`);
      expect(histRes.statusCode).toBe(200);
      const types = histRes.json().versions.map((v: { change_type: string }) => v.change_type);
      expect(types).toContain('delete');
      expect(types).toContain('restore');
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /records/recent-changes — dynamically-assembled whereClause with
// incrementing $${paramIndex} placeholders (route ~lines 685-733).
// ─────────────────────────────────────────────────────────────────────────
describe('recent-changes — dynamic whereClause branches against real SQL', () => {
  it('HAPPY: unfiltered query returns changes covering all six versioned tables', async () => {
    // WHO: an owner opening the "Recent changes" dashboard feed.
    // WHAT: GET /records/recent-changes with no filters — whereClause is just
    //       the tenant predicate; LIMIT/OFFSET land at $2/$3.
    // WHEN: after every fixture table has trigger-written versions.
    // WHERE: versionHistory.ts recent-changes handler → record_versions.
    // WHY: proves the base query + jsonb name/phone projections execute and
    //      that all six tables' trigger output is visible through the route.
    const res = await get(`/records/recent-changes?limit=200`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(12); // ≥2 versions × 6 tables
    const tables = new Set(body.changes.map((ch: { table_name: string }) => ch.table_name));
    for (const c of TABLE_CASES) {
      expect(tables).toContain(c.table);
    }
  });

  it('HAPPY: table filter appends $2 and only that table comes back', async () => {
    // WHY: the first optional branch — `AND rv.table_name = $2`. A mis-
    //      numbered placeholder here silently binds the wrong value; only a
    //      real parse+execute proves the index arithmetic.
    const res = await get(`/records/recent-changes?table=services`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(2);
    for (const ch of body.changes) {
      expect(ch.table_name).toBe('services');
      expect(ch.record_id).toBe(recordIds.services);
    }
  });

  it('HAPPY: change_type filter branch executes ($2 as change_type when table absent)', async () => {
    // WHY: when `table` is absent, change_type must claim $2 — the paramIndex
    //      is shared mutable state across the three branches.
    const res = await get(`/records/recent-changes?change_type=create`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(6); // one 'create' per table
    for (const ch of body.changes) {
      expect(ch.change_type).toBe('create');
    }
  });

  it('HAPPY: all three filters stack ($2/$3/$4) with LIMIT $5 OFFSET $6', async () => {
    // WHO: a filtered + paginated dashboard query — the deepest whereClause.
    // WHAT: table + change_type + change_source all present, so LIMIT/OFFSET
    //       must land at $5/$6. Fixture writes have no app.change_source
    //       session var, and the live auto_version_trigger defaults that to
    //       'local' (NOT the 'system' the 20260512000009 migration text
    //       suggests — a later revision changed the fallback).
    // WHY: the maximal paramIndex path is exactly where an off-by-one in the
    //      `$${paramIndex}` arithmetic would bind LIMIT into the filter (or
    //      throw) — invisible to mocks, fatal on real Postgres.
    const res = await get(
      `/records/recent-changes?table=customers&change_type=create&change_source=local&limit=1&offset=0`
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].table_name).toBe('customers');
    expect(body.changes[0].change_type).toBe('create');
    expect(body.changes[0].change_source).toBe('local');
  });

  it('HAPPY: non-matching change_source returns empty set, not an error', async () => {
    // WHY: filter that matches nothing must produce {changes: [], total: 0} —
    //      a benign empty state for the UI, never a 500.
    const res = await get(`/records/recent-changes?change_source=square`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changes: [], total: 0 });
  });

  it('HAPPY: cross-tenant isolation — tenant A never sees tenant B versions', async () => {
    // WHO: tenant A's owner; tenant B has its own customer + versions.
    // WHY: recent-changes is tenant-scoped only by `rv.tenant_id = $1` + RLS;
    //      a leak here exposes another business's customer edit history.
    const res = await get(`/records/recent-changes?limit=200`);
    expect(res.statusCode).toBe(200);
    const leaked = res
      .json()
      .changes.find((ch: { record_id: string }) => ch.record_id === otherTenantCustomerId);
    expect(leaked).toBeUndefined();

    // And the interpolated history SQL for tenant B's record under tenant A's
    // context must come back empty (not tenant B's data, not an error).
    const hist = await get(`/records/customers/${otherTenantCustomerId}/history`);
    expect(hist.statusCode).toBe(200);
    expect(hist.json().versions).toHaveLength(0);
    expect(hist.json().current_version).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Version read / compare / restore-fields / copy-fields against the real
// record_versions rows + DB functions the routes delegate to.
// ─────────────────────────────────────────────────────────────────────────
describe('version read, compare, restore-fields, copy-fields (real record_versions)', () => {
  it('HAPPY: GET a specific version returns the trigger-written v1 snapshot', async () => {
    // WHO: an owner inspecting version 1 of a customer in the history UI.
    // WHY: proves the trigger's snapshot (data jsonb) round-trips through the
    //      route with the original field value, and version numbering starts
    //      at 1 as the restore endpoints assume.
    const res = await get(`/records/customers/${recordIds.customers}/version/1`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version_number).toBe(1);
    expect(body.change_type).toBe('create');
    expect(body.data.name).toBe('Versioned Vera');
  });

  it('HAPPY: compare v1 vs v2 reports the changed field with both values', async () => {
    // WHAT: GET .../compare/1/2 → compare_versions() DB function.
    // WHY: the diff powers the side-by-side restore UI; a signature or
    //      column drift in the function is invisible to mocks.
    const res = await get(`/records/customers/${recordIds.customers}/compare/1/2`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version_a).toBe(1);
    expect(body.version_b).toBe(2);
    const nameDiff = body.differences.find((d: { field_name: string }) => d.field_name === 'name');
    expect(nameDiff).toBeDefined();
    expect(nameDiff.value_a).toBe('Versioned Vera');
    expect(nameDiff.value_b).toBe('Versioned Vera II');
  });

  it('HAPPY: restore-fields pulls the v1 value back onto the live row', async () => {
    // WHO: an owner clicking "restore this field" after a bad edit.
    // WHAT: POST restore-fields {source_version: 1, fields: ['name']} →
    //       restore_fields_from_version() DB function against the real row.
    // WHEN: after the fixture UPDATE moved name to 'Versioned Vera II'.
    // WHERE: versionHistory.ts restore-fields handler → PK-aware dynamic SQL.
    // WHY: REAL BUG caught by this suite pre-fix — the function's dynamic SQL
    //      still queried bare `id` after the 2026-05-12 PK rename sprint, so
    //      every restore-fields call on every table threw 42703 → 500
    //      (soft_delete_record/restore_deleted_record had been fixed by
    //      20260513000004; this function was missed). FIXED 2026-07-01 by
    //      migration 20260701010000_fix_version_rpc_pk_names.sql
    //      (information_schema PK lookup, same pattern). The field value
    //      must actually change in the table, not just return success:true.
    const res = await post(`/records/customers/${recordIds.customers}/restore-fields`, {
      source_version: 1,
      fields: ['name'],
      restored_by: 'realdb-test',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('Versioned Vera'); // returned final state
    expect(body.message).toContain('Restored 1 field');

    const row = await setup.query(`SELECT name FROM customers WHERE customer_id = $1`, [
      recordIds.customers,
    ]);
    expect(row.rows[0].name).toBe('Versioned Vera'); // back to the v1 value
  });

  it('HAPPY: copy-fields copies a field from one record to another', async () => {
    // WHO: an owner merging data from a duplicate customer.
    // WHAT: POST /records/customers/copy-fields → copy_fields_between_records().
    // WHEN: source customer currently holds the v1-restored name.
    // WHERE: versionHistory.ts copy-fields handler → PK-aware dynamic SQL.
    // WHY: REAL BUG caught by this suite pre-fix — same bare-`id` defect as
    //      restore_fields_from_version (verified directly against the DB:
    //      `... FROM customers t WHERE id = $1 ...` → 42703 on every table).
    //      FIXED 2026-07-01 by migration
    //      20260701010000_fix_version_rpc_pk_names.sql. The target row must
    //      actually receive the source's current value.
    const targetId = await createCustomer(setup, tenantId, 'Copy Target Tina', '+15559980003');

    const res = await post(`/records/customers/copy-fields`, {
      source_record_id: recordIds.customers,
      target_record_id: targetId,
      fields: ['name'],
      copied_by: 'realdb-test',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const src = await setup.query(`SELECT name FROM customers WHERE customer_id = $1`, [
      recordIds.customers,
    ]);
    const tgt = await setup.query(`SELECT name FROM customers WHERE customer_id = $1`, [targetId]);
    expect(tgt.rows[0].name).toBe(src.rows[0].name);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Sad paths — the zod table whitelist is the ONLY thing between the URL and
// an SQL identifier; these prove it holds and that malformed input degrades
// to clean 4xx on a real database.
// ─────────────────────────────────────────────────────────────────────────
describe('sad paths — invalid identifiers and params against real Postgres', () => {
  it('SAD: unknown entity type is a clean 400 INVALID_TABLE, never reaching SQL', async () => {
    // WHO: a buggy dashboard build (or a curious caller) requesting a table
    //      the route does not version.
    // WHAT: GET /records/widgets/:id/history.
    // WHY: 'widgets' must be rejected by the zod enum BEFORE it is ever
    //      interpolated into `FROM ${table}` — a 500 here would mean raw
    //      user input reached the SQL text.
    const res = await get(`/records/widgets/${recordIds.customers}/history`);
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('INVALID_TABLE');
    expect(body.error).toContain('widgets');
  });

  it('SAD: SQL-injection-shaped table name is rejected by the whitelist (400)', async () => {
    // WHO: a hostile caller aiming an injection at the identifier slot.
    // WHAT: GET /records/<'customers; DROP TABLE tenants;--'>/deleted.
    // WHY: `${table}` is string-interpolated — the zod enum whitelist is the
    //      entire injection defense for this route. This test pins that any
    //      non-whitelisted value (however crafted) gets 400, and (implicitly)
    //      that the suite's own tenants table still exists afterwards.
    const evil = encodeURIComponent('customers; DROP TABLE tenants;--');
    const res = await get(`/records/${evil}/deleted`);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_TABLE');
  });

  it('SAD: non-UUID recordId hits real Postgres and degrades to 400, not 500', async () => {
    // WHO: a caller with a mangled record link.
    // WHAT: GET /records/customers/not-a-uuid/history — passes the zod table
    //       check, so the interpolated SQL executes with 'not-a-uuid' bound
    //       against a uuid PK column → Postgres 22P02.
    // WHY: withHandler maps SQLSTATE class 22 to a 400 'Invalid request
    //      parameter'. Mocks can never exercise this: only a real Postgres
    //      throws 22P02. A regression here turns client garbage into 5xx
    //      alert noise.
    const res = await get(`/records/customers/not-a-uuid/history`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Invalid request parameter');
  });

  it('SAD: request without a tenant context is 401, not a cross-tenant read', async () => {
    // WHO: an unauthenticated caller (no tenantMiddleware-set tenantId).
    // WHY: requireTenantId must refuse before any interpolated SQL runs —
    //      version history is per-tenant PII.
    const res = await get(`/records/customers/${recordIds.customers}/history`, null);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Authentication required');
  });

  it('SAD: nonexistent version number is a 404 VERSION_NOT_FOUND', async () => {
    // WHO: an owner following a stale deep-link to a pruned version.
    // WHY: a missing record_versions row must be a clean 404 with the 5W
    //      context payload, not an empty 200 or a 500.
    const res = await get(`/records/customers/${recordIds.customers}/version/9999`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('VERSION_NOT_FOUND');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Batch restore — POST restore-fields { restores: [{source_version, fields}] }
// runs every group in ONE transaction (added 2026-07-02). A record whose
// fields changed across DIFFERENT versions can be restored from several
// versions in one request; a bad group rolls the whole batch back.
// ─────────────────────────────────────────────────────────────────────────
describe('restore-fields batch payload — multi-version groups in one transaction', () => {
  // Build a customer with 3 versions: v1 create, v2 renames, v3 re-phones.
  // So name@v1 and phone@v2 are both non-current, restorable from two versions.
  async function seedThreeVersionCustomer(name: string, phone: string): Promise<string> {
    const id = await createCustomer(setup, tenantId, name, phone); // v1
    await setup.query(`UPDATE customers SET name = $2 WHERE customer_id = $1`, [id, `${name} V2`]); // v2
    await setup.query(`UPDATE customers SET phone = $2 WHERE customer_id = $1`, [
      id,
      '+15559990999',
    ]); // v3
    return id;
  }

  it('HAPPY: one request restores fields spanning two versions', async () => {
    // WHO: an owner who cherry-picks name from v1 and phone from v2 in the
    //      restore modal, then clicks Restore once.
    // WHAT: POST restore-fields { restores: [{v1, [name]}, {v2, [phone]}] }.
    // WHEN: live row currently holds the v3 name+phone.
    // WHERE: versionHistory.ts restore-fields → BEGIN → 2× RPC → COMMIT.
    // WHY: the modal used to fire one request PER version group; this proves
    //      the batch applies BOTH groups and returns the final row state.
    const id = await seedThreeVersionCustomer('Batch Betty', '+15559990001');
    const res = await post(`/records/customers/${id}/restore-fields`, {
      restores: [
        { source_version: 1, fields: ['name'] }, // name → 'Batch Betty'
        { source_version: 2, fields: ['phone'] }, // phone → '+15559990001' (v2 kept v1 phone)
      ],
      restored_by: 'realdb-test',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain('Restored 2 field(s) from 2 version(s)');

    const row = await setup.query(`SELECT name, phone FROM customers WHERE customer_id = $1`, [id]);
    expect(row.rows[0].name).toBe('Batch Betty'); // from v1
    expect(row.rows[0].phone).toBe('+15559990001'); // from v2
  });

  it('SAD: a bad group rolls the WHOLE batch back — no partial restore', async () => {
    // WHO: same flow, but one group references a version that doesn't exist.
    // WHAT: POST { restores: [{v1, [name]}, {v999, [phone]}] } → the first
    //       group would succeed alone, but the second fails.
    // WHERE: the route's BEGIN/…/ROLLBACK wrapper.
    // WHY: without one transaction, name would be restored while phone failed,
    //      leaving a half-applied restore. The row must be UNCHANGED (still
    //      the v3 values) and the response a non-2xx error.
    const id = await seedThreeVersionCustomer('Rollback Rita', '+15559991001');
    const res = await post(`/records/customers/${id}/restore-fields`, {
      restores: [
        { source_version: 1, fields: ['name'] },
        { source_version: 999, fields: ['phone'] },
      ],
      restored_by: 'realdb-test',
    });
    expect(res.statusCode).toBe(500);
    // The DB function RAISEs P0001 for a missing version; the route must turn
    // that into the STRUCTURED RESTORE_FAILED 5W body (not a generic 500).
    expect(res.json().code).toBe('RESTORE_FAILED');

    const row = await setup.query(`SELECT name, phone FROM customers WHERE customer_id = $1`, [id]);
    // Still the current (v3) values — the valid group's change was rolled back.
    expect(row.rows[0].name).toBe('Rollback Rita V2');
    expect(row.rows[0].phone).toBe('+15559990999');
  });
});
