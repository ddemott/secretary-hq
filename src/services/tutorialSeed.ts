/**
 * Seed a freshly-created tutorial tenant: a copy of the Auto Shop Template plus sample customers and appointments.
 *
 * Seeds in a single transaction so partial failure leaves no orphaned rows
 * (the tenant itself lives outside this transaction — it is created by the
 * caller before invoking this function so the tenant_id is known up front).
 *
 * Customers and staff are fictional names/phones so they don't collide with the
 * real seed fixtures.
 */

import type { Pool, PoolClient } from 'pg';

import { withTenantContext } from '../database/index';

/** The business_templates / tenants.template_vertical key of the template the Tutorial copies. */
export const TUTORIAL_TEMPLATE_VERTICAL = 'auto_shop';

export interface TutorialSeedParams {
  tenantId: string;
  userId: string;
}

/**
 * Insert tutorial business data for the given tenant.
 * Must be called after the tenant + owner user rows already exist.
 *
 * RUNS UNDER THE TENANT'S RLS CONTEXT. This used to say "uses the raw pool (no
 * RLS context) — admin-level write", which was true only because the app
 * connected as a BYPASSRLS role and every policy was inert. The first time
 * production ran as `app_user` (2026-07-27) this function was the first thing to
 * break — `POST /demo/start`, the public "Try live demo" button (as it was
 * named then), 500'd with
 *
 *     new row violates row-level security policy for table "tenant_skills"
 *
 * because `tenant_skills` (like every tenant-scoped table except tenants/users/
 * business_templates) has an isolation policy and no admin bypass: with no
 * context `tenant_ctx_uuid()` is NULL and the WITH CHECK denies every row.
 *
 * There was never a reason for this write to be context-free — it seeds data for
 * ONE known tenant. Setting the context is both the fix and the honest
 * description of what it does.
 */
export async function seedTutorialTenant(pool: Pool, params: TutorialSeedParams): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, params.tenantId, () => insertTutorialData(client, params));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertTutorialData(
  client: PoolClient,
  { tenantId }: TutorialSeedParams
): Promise<void> {
  // Idempotency guard: if customers already exist, this tenant is already seeded.
  // Appointments have a GiST exclusion that rejects duplicates, so we must not
  // re-run the INSERT block. Checking customers (5 rows) is the lightest proxy.
  const already = await client.query('SELECT 1 FROM customers WHERE tenant_id = $1 LIMIT 1', [
    tenantId,
  ]);
  if (already.rows.length > 0) return;

  // ── Business shape: a COPY of the Auto Shop Template ─────────────────
  // The Tutorial shows exactly what a new auto shop gets, so it starts the same
  // way a real signup does: copy_business_template_to_tenant() duplicates the
  // template's skills, bays, services (no prices), placeholder staff, who-does-
  // what links and knowledge starters into this tenant's own rows. It also drops
  // the generic default bay create_default_resources() added on tenant insert.
  const copied = await client.query<{ copied: boolean }>(
    'SELECT copy_business_template_to_tenant($1, $2) AS copied',
    [tenantId, TUTORIAL_TEMPLATE_VERTICAL]
  );
  if (copied.rows[0]?.copied !== true) {
    throw new Error(
      `Tutorial seed: no "${TUTORIAL_TEMPLATE_VERTICAL}" template business to copy ` +
        '(migrations/seed not applied?)'
    );
  }

  // The template's staff are placeholders ("Mechanic 1") for an owner to rename.
  // The Tutorial renames them to named people, as an owner would.
  await client.query(
    `UPDATE employees AS e
        SET name = v.full_name, first_name = v.first_name, last_name = v.last_name,
            email = v.email, phone = v.phone, is_auto_seeded = false
       FROM (VALUES
         ('Mechanic 1', 'Alex Rivera', 'Alex',   'Rivera', 'alex@quicklubedemo.com',   '555-0101'),
         ('Mechanic 2', 'Jordan Kim',  'Jordan', 'Kim',    'jordan@quicklubedemo.com', '555-0102')
       ) AS v(placeholder, full_name, first_name, last_name, email, phone)
      WHERE e.tenant_id = $1 AND e.name = v.placeholder`,
    [tenantId]
  );

  const idByName = async (
    table: 'services' | 'resources' | 'employees',
    idCol: string,
    name: string
  ) => {
    const r = await client.query<Record<string, string>>(
      `SELECT ${idCol} FROM ${table} WHERE tenant_id = $1 AND name = $2 AND is_deleted = false`,
      [tenantId, name]
    );
    if (!r.rows[0]) throw new Error(`Tutorial seed: template copy has no ${table} row "${name}"`);
    return r.rows[0][idCol];
  };
  const bay1Id = await idByName('resources', 'resource_id', 'Bay 1');
  const bay2Id = await idByName('resources', 'resource_id', 'Bay 2');
  const alexId = await idByName('employees', 'employee_id', 'Alex Rivera');
  const jordanId = await idByName('employees', 'employee_id', 'Jordan Kim');
  const svcOilId = await idByName('services', 'service_id', 'Oil Change');
  const svcTiresId = await idByName('services', 'service_id', 'Tire Rotation');
  const svcBrakesId = await idByName('services', 'service_id', 'Brake Inspection');

  // ── Shifts (Mon–Fri 8am–5pm, 4 weeks) ───────────────────────────────
  await expandShifts(client, tenantId, alexId, '08:00', '17:00', 28);
  await expandShifts(client, tenantId, jordanId, '08:00', '17:00', 28);

  // ── Customers ────────────────────────────────────────────────────────
  const custRes = await client.query<{ customer_id: string }>(
    `INSERT INTO customers (tenant_id, phone, name, email)
     VALUES
       ($1, '555-1001', 'Maria Santos',   'maria@demo.example'),
       ($1, '555-1002', 'Tyler Brooks',   'tyler@demo.example'),
       ($1, '555-1003', 'Priya Nair',     'priya@demo.example'),
       ($1, '555-1004', 'James Whitmore', 'james@demo.example'),
       ($1, '555-1005', 'Carmen Ortega',  'carmen@demo.example')
     RETURNING customer_id`,
    [tenantId]
  );
  const [cust1, cust2, cust3, cust4, cust5] = custRes.rows.map((r) => r.customer_id);

  // ── Appointments (past, today, future) ───────────────────────────────
  // Appointments need a resource_id (NOT NULL). Use bay1Id / bay2Id.
  // Past appointments use 'completed' status, future use 'scheduled'.
  await client.query(
    `INSERT INTO appointments
       (tenant_id, resource_id, employee_id, customer_id, service_id,
        start_time, end_time, status, description)
     VALUES
       -- Yesterday — completed
       ($1,$2,$3,$4,$5,
        (CURRENT_DATE - 1)::timestamptz + TIME '09:00:00',
        (CURRENT_DATE - 1)::timestamptz + TIME '09:45:00',
        'completed', 'Demo: past oil change'),
       ($1,$6,$7,$8,$9,
        (CURRENT_DATE - 1)::timestamptz + TIME '11:00:00',
        (CURRENT_DATE - 1)::timestamptz + TIME '11:30:00',
        'completed', 'Demo: past tire rotation'),
       -- Today — scheduled
       ($1,$2,$3,$10,$11,
        CURRENT_DATE::timestamptz + TIME '10:00:00',
        CURRENT_DATE::timestamptz + TIME '11:00:00',
        'scheduled', 'Demo: today brake inspection'),
       ($1,$6,$7,$12,$13,
        CURRENT_DATE::timestamptz + TIME '14:00:00',
        CURRENT_DATE::timestamptz + TIME '14:45:00',
        'scheduled', 'Demo: today oil change'),
       -- Tomorrow — scheduled
       ($1,$2,$3,$14,$5,
        (CURRENT_DATE + 1)::timestamptz + TIME '09:00:00',
        (CURRENT_DATE + 1)::timestamptz + TIME '09:45:00',
        'scheduled', 'Demo: tomorrow oil change'),
       -- Day after tomorrow — scheduled
       ($1,$6,$7,$4,$9,
        (CURRENT_DATE + 2)::timestamptz + TIME '10:00:00',
        (CURRENT_DATE + 2)::timestamptz + TIME '10:30:00',
        'scheduled', 'Demo: future tire rotation')`,
    [
      tenantId,
      bay1Id,
      alexId,
      cust1,
      svcOilId,
      bay2Id,
      jordanId,
      cust2,
      svcTiresId,
      cust3,
      svcBrakesId,
      cust4,
      svcOilId,
      cust5,
    ]
  );
}

/**
 * Insert Mon–Fri shifts for one employee over `days` days starting today.
 */
async function expandShifts(
  client: PoolClient,
  tenantId: string,
  employeeId: string,
  startTime: string,
  endTime: string,
  days: number
): Promise<void> {
  const valuesSql: string[] = [];
  const params: string[] = [tenantId, employeeId];
  let paramIdx = 3;

  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + i);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    const iso = d.toISOString().split('T')[0];
    valuesSql.push(
      `($1, $2, $${paramIdx}::DATE, $${paramIdx + 1}::TIME, $${paramIdx + 2}::TIME, false)`
    );
    params.push(iso, startTime, endTime);
    paramIdx += 3;
  }

  if (valuesSql.length === 0) return;
  await client.query(
    `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
     VALUES ${valuesSql.join(', ')}
     ON CONFLICT (tenant_id, employee_id, shift_date) DO NOTHING`,
    params
  );
}
