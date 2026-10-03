/**
 * Seed a freshly-created tutorial tenant with realistic automotive data.
 *
 * Seeds in a single transaction so partial failure leaves no orphaned rows
 * (the tenant itself lives outside this transaction — it is created by the
 * caller before invoking this function so the tenant_id is known up front).
 *
 * Data modelled on a generic mobile-tire shop but with fictional names/phones
 * so it doesn't collide with the real seed fixtures.
 */

import type { Pool, PoolClient } from 'pg';

import { withTenantContext } from '../database/index';

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

  // ── Skill catalog (tenant_skills) ───────────────────────────────────
  // Uses composite PK (tenant_id, name) — no skill_id column.
  await client.query(
    `INSERT INTO tenant_skills (tenant_id, name, description)
     VALUES
       ($1, 'Oil Change',      'Engine oil and filter service'),
       ($1, 'Tires',           'Mount, balance, rotate, repair'),
       ($1, 'Brakes',          'Pad, rotor, caliper service'),
       ($1, 'General Service', 'Inspections and minor repairs')
     ON CONFLICT DO NOTHING`,
    [tenantId]
  );

  // ── Resources (bays) ────────────────────────────────────────────────
  // The tenant's business type has a business_templates row, so the AFTER INSERT
  // trigger create_default_resources() already added its default bay (tagged
  // is_auto_seeded). The Tutorial brings its own bays; drop the default so the
  // schedule shows exactly Bay 1 and Bay 2, not a third "Service Bay 1".
  await client.query('DELETE FROM resources WHERE tenant_id = $1 AND is_auto_seeded = true', [
    tenantId,
  ]);

  const resourceRes = await client.query<{ resource_id: string }>(
    `INSERT INTO resources (tenant_id, name, description, is_active)
     VALUES
       ($1, 'Bay 1', 'Main service bay',     true),
       ($1, 'Bay 2', 'Overflow service bay', true)
     RETURNING resource_id`,
    [tenantId]
  );
  const [bay1Id, bay2Id] = resourceRes.rows.map((r) => r.resource_id);

  // ── Services ────────────────────────────────────────────────────────
  // required_skills / required_resources are TEXT[] of names.
  const serviceRes = await client.query<{ service_id: string }>(
    `INSERT INTO services
       (tenant_id, name, description, duration_minutes, price,
        required_skills, required_resources)
     VALUES
       ($1, 'Oil Change',       'Full synthetic or conventional oil + filter', 45,  49.99,
        ARRAY['Oil Change'],      ARRAY['Bay 1']),
       ($1, 'Tire Rotation',    'Rotate and balance all four tires',           30,  29.99,
        ARRAY['Tires'],           ARRAY['Bay 1']),
       ($1, 'Brake Inspection', 'Visual + measurement inspection',             60,  19.99,
        ARRAY['Brakes'],          ARRAY['Bay 1']),
       ($1, 'Full Inspection',  '30-point vehicle safety inspection',          45,   0.00,
        ARRAY['General Service'], ARRAY['Bay 1'])
     RETURNING service_id`,
    [tenantId]
  );
  const [svcOilId, svcTiresId, svcBrakesId, svcInspectId] = serviceRes.rows.map(
    (r) => r.service_id
  );

  // ── Employees ────────────────────────────────────────────────────────
  // employees.skills is TEXT[] (skill names matching tenant_skills.name).
  const empRes = await client.query<{ employee_id: string }>(
    `INSERT INTO employees (tenant_id, name, email, phone, skills, is_active)
     VALUES
       ($1, 'Alex Rivera', 'alex@quicklubedemo.com',   '555-0101',
        ARRAY['Oil Change','Tires','Brakes','General Service'], true),
       ($1, 'Jordan Kim',  'jordan@quicklubedemo.com', '555-0102',
        ARRAY['Oil Change','Tires'], true)
     RETURNING employee_id`,
    [tenantId]
  );
  const [alexId, jordanId] = empRes.rows.map((r) => r.employee_id);

  // ── Service → employee mappings ─────────────────────────────────────
  await client.query(
    `INSERT INTO service_employee (service_id, employee_id, tenant_id)
     VALUES
       ($1,$3,$5), ($1,$4,$5),
       ($2,$3,$5), ($2,$4,$5),
       ($6,$3,$5),
       ($7,$3,$5)
     ON CONFLICT DO NOTHING`,
    [svcOilId, svcTiresId, alexId, jordanId, tenantId, svcBrakesId, svcInspectId]
  );

  // ── Service → resource mappings ──────────────────────────────────────
  await client.query(
    `INSERT INTO service_resource (service_id, resource_id, tenant_id)
     VALUES
       ($1,$3,$5), ($2,$3,$5), ($6,$3,$5), ($7,$3,$5),
       ($1,$4,$5), ($2,$4,$5)
     ON CONFLICT DO NOTHING`,
    [svcOilId, svcTiresId, bay1Id, bay2Id, tenantId, svcBrakesId, svcInspectId]
  );

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
