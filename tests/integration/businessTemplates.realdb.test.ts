/**
 * Template businesses — real DB (migrations 20260925000000 + 20260925000100).
 *
 * WHO  — a new auto shop or salon picking its business at signup / in the wizard
 * WHAT — copy_business_template_to_tenant() duplicates "Auto Shop Template" /
 *        "Salon Template" into the new business's own rows; the templates
 *        themselves can never be changed
 * WHEN — tenant creation and business-type change
 * WHERE — supabase/migrations/20260925000000_business_template_tenants.sql
 * WHY  — Dale 2026-09-25: "If a customer picks it, the row is duplicated and
 *        used for them to fill out … never overwrite the original." Shape only:
 *        no prices ("we never deal with their money"), no customers, calls or
 *        appointments.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import { getRootClient, createTenant, skipIfDbDown, ensureTemplates } from '../utils';

const AUTO_TEMPLATE = '7e3a0000-0000-4000-8000-00000000a001';
const SALON_TEMPLATE = '7e3a0000-0000-4000-8000-00000000a002';

// The per-worker app_user URL (tests/setup/perWorkerDb.ts). Unset → the
// app_user case is skipped; the superuser cases still run.
const APP_USER_URL = process.env.TEST_APP_USER_DATABASE_URL;

let root: Client;
let dbAvailable = false;
const created: string[] = [];

/** Row counts of everything a template holds, for "unchanged" checks. */
async function shape(tenantId: string) {
  const one = async (sql: string) => (await root.query<{ n: number }>(sql, [tenantId])).rows[0].n;
  return {
    services: await one('SELECT count(*)::int AS n FROM services WHERE tenant_id = $1'),
    resources: await one('SELECT count(*)::int AS n FROM resources WHERE tenant_id = $1'),
    skills: await one('SELECT count(*)::int AS n FROM tenant_skills WHERE tenant_id = $1'),
    employees: await one('SELECT count(*)::int AS n FROM employees WHERE tenant_id = $1'),
    serviceEmployee: await one(
      'SELECT count(*)::int AS n FROM service_employee WHERE tenant_id = $1'
    ),
    serviceResource: await one(
      'SELECT count(*)::int AS n FROM service_resource WHERE tenant_id = $1'
    ),
    docs: await one('SELECT count(*)::int AS n FROM tenant_docs WHERE tenant_id = $1'),
  };
}

async function newTenant(name: string, businessType: string): Promise<string> {
  const id = await createTenant(root, name, businessType);
  created.push(id);
  return id;
}

async function copy(tenantId: string, vertical: string): Promise<boolean> {
  const res = await root.query<{ copied: boolean }>(
    'SELECT copy_business_template_to_tenant($1, $2) AS copied',
    [tenantId, vertical]
  );
  return res.rows[0].copied;
}

beforeAll(async () => {
  try {
    root = await getRootClient();
    await root.query('SELECT 1');
    await ensureTemplates(root);
    dbAvailable = true;
  } catch (err) {
    console.warn('[businessTemplates.realdb.test] DB not available, skipping', err);
  }
});

afterAll(async () => {
  if (!root) return;
  for (const id of created) {
    await root.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
  }
  await root.end();
});

beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

describe('the templates themselves', () => {
  it('HAPPY: Auto Shop Template and Salon Template exist, marked as templates', async () => {
    const res = await root.query<{ tenant_id: string; name: string; template_vertical: string }>(
      `SELECT tenant_id, name, template_vertical FROM tenants WHERE is_template ORDER BY name`
    );
    const byId = Object.fromEntries(res.rows.map((r) => [r.tenant_id, r]));
    expect(byId[AUTO_TEMPLATE]).toMatchObject({
      name: 'Auto Shop Template',
      template_vertical: 'auto_shop',
    });
    expect(byId[SALON_TEMPLATE]).toMatchObject({
      name: 'Salon Template',
      template_vertical: 'salon',
    });
  });

  it('HAPPY: each template is a complete business shape', async () => {
    for (const id of [AUTO_TEMPLATE, SALON_TEMPLATE]) {
      const s = await shape(id);
      expect(s.services, id).toBeGreaterThan(3);
      expect(s.resources, id).toBeGreaterThan(1);
      expect(s.skills, id).toBeGreaterThan(1);
      expect(s.employees, id).toBeGreaterThan(0);
      expect(s.serviceEmployee, id).toBeGreaterThanOrEqual(s.services);
      expect(s.serviceResource, id).toBeGreaterThanOrEqual(s.services);
      expect(s.docs, id).toBeGreaterThan(0);
    }
  });

  it('SAD: no template carries a price, a customer, an appointment or a call', async () => {
    const q = async (sql: string) =>
      (await root.query<{ n: number }>(sql, [[AUTO_TEMPLATE, SALON_TEMPLATE]])).rows[0].n;
    expect(
      await q(
        'SELECT count(*)::int AS n FROM services WHERE tenant_id = ANY($1) AND price IS NOT NULL'
      )
    ).toBe(0);
    expect(await q('SELECT count(*)::int AS n FROM customers WHERE tenant_id = ANY($1)')).toBe(0);
    expect(await q('SELECT count(*)::int AS n FROM appointments WHERE tenant_id = ANY($1)')).toBe(
      0
    );
    expect(await q('SELECT count(*)::int AS n FROM voice_sessions WHERE tenant_id = ANY($1)')).toBe(
      0
    );
    expect(await q('SELECT count(*)::int AS n FROM users WHERE tenant_id = ANY($1)')).toBe(0);
  });

  it('HAPPY: every service is bookable — someone can do it and somewhere to do it', async () => {
    for (const id of [AUTO_TEMPLATE, SALON_TEMPLATE]) {
      const res = await root.query<{ name: string }>(
        `SELECT s.name FROM services s
          WHERE s.tenant_id = $1
            AND (NOT EXISTS (SELECT 1 FROM service_employee se WHERE se.service_id = s.service_id)
              OR NOT EXISTS (SELECT 1 FROM service_resource sr WHERE sr.service_id = s.service_id))`,
        [id]
      );
      expect(
        res.rows.map((r) => r.name),
        id
      ).toEqual([]);
    }
  });
});

describe('copy_business_template_to_tenant', () => {
  it('HAPPY: an auto shop gets its own full copy of the Auto Shop Template', async () => {
    const tenant = await newTenant('Copy Test Auto', 'auto-shop');
    expect(await copy(tenant, 'auto_shop')).toBe(true);
    const tpl = await shape(AUTO_TEMPLATE);
    const mine = await shape(tenant);
    expect(mine).toEqual(tpl);
  });

  it('HAPPY: the copy is theirs — new ids, no prices, marked replaceable', async () => {
    const tenant = await newTenant('Copy Test Ids', 'auto-shop');
    await copy(tenant, 'auto_shop');
    const overlap = await root.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM services a JOIN services b USING (service_id)
        WHERE a.tenant_id = $1 AND b.tenant_id = $2`,
      [tenant, AUTO_TEMPLATE]
    );
    expect(overlap.rows[0].n).toBe(0);
    const svc = await root.query<{ price: string | null; is_auto_seeded: boolean }>(
      'SELECT price, is_auto_seeded FROM services WHERE tenant_id = $1',
      [tenant]
    );
    expect(svc.rows.every((r) => r.price === null)).toBe(true);
    expect(svc.rows.every((r) => r.is_auto_seeded)).toBe(true);
    const emp = await root.query<{ is_auto_seeded: boolean; name: string }>(
      'SELECT is_auto_seeded, name FROM employees WHERE tenant_id = $1',
      [tenant]
    );
    expect(emp.rows.every((r) => r.is_auto_seeded)).toBe(true);
    expect(emp.rows.map((r) => r.name).sort()).toEqual(['Technician 1', 'Technician 2']);
  });

  it('HAPPY: links point at the copy’s own rows, never the template’s', async () => {
    const tenant = await newTenant('Copy Test Links', 'salon');
    await copy(tenant, 'salon');
    const foreign = await root.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM service_employee se
         JOIN employees e ON e.employee_id = se.employee_id
        WHERE se.tenant_id = $1 AND e.tenant_id <> $1`,
      [tenant]
    );
    expect(foreign.rows[0].n).toBe(0);
    const foreignRes = await root.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM service_resource sr
         JOIN resources r ON r.resource_id = sr.resource_id
        WHERE sr.tenant_id = $1 AND r.tenant_id <> $1`,
      [tenant]
    );
    expect(foreignRes.rows[0].n).toBe(0);
  });

  it('SAD: knowledge starters arrive switched off (no embedding) until the owner saves them', async () => {
    // WHY: search_tenant_docs only matches embedded rows, so an unreviewed
    //      starter is never read to a caller.
    const tenant = await newTenant('Copy Test Docs', 'auto-shop');
    await copy(tenant, 'auto_shop');
    const docs = await root.query<{ embedded: boolean; source: string }>(
      'SELECT embedding IS NOT NULL AS embedded, source FROM tenant_docs WHERE tenant_id = $1',
      [tenant]
    );
    expect(docs.rows.length).toBeGreaterThan(0);
    expect(docs.rows.every((r) => !r.embedded && r.source === 'template')).toBe(true);
  });

  it('HAPPY: the business gets the template’s words for bays and staff', async () => {
    const tenant = await newTenant('Copy Test Labels', 'auto-shop');
    await copy(tenant, 'auto_shop');
    const t = await root.query<{ resource_plural: string; employee_plural: string }>(
      'SELECT resource_plural, employee_plural FROM tenants WHERE tenant_id = $1',
      [tenant]
    );
    expect(t.rows[0]).toMatchObject({ resource_plural: 'Bays', employee_plural: 'Technicians' });
  });

  it('SAD: a business that already has services is never overwritten or merged into', async () => {
    const tenant = await newTenant('Copy Test Existing', 'auto-shop');
    await root.query(
      `INSERT INTO services (tenant_id, name, duration_minutes) VALUES ($1, 'My Own Service', 30)`,
      [tenant]
    );
    expect(await copy(tenant, 'auto_shop')).toBe(false);
    const names = await root.query<{ name: string }>(
      'SELECT name FROM services WHERE tenant_id = $1',
      [tenant]
    );
    expect(names.rows.map((r) => r.name)).toEqual(['My Own Service']);
  });

  it('SAD: copying twice does not duplicate anything', async () => {
    const tenant = await newTenant('Copy Test Twice', 'salon');
    expect(await copy(tenant, 'salon')).toBe(true);
    expect(await copy(tenant, 'salon')).toBe(false);
    expect(await shape(tenant)).toEqual(await shape(SALON_TEMPLATE));
  });

  it('SAD: a business type with no template gets nothing and no error', async () => {
    const tenant = await newTenant('Copy Test None', 'plumber');
    expect(await copy(tenant, 'plumber')).toBe(false);
    expect((await shape(tenant)).services).toBe(0);
  });

  it('HAPPY: the owner editing their copy never touches the template', async () => {
    const tenant = await newTenant('Copy Test Edit', 'auto-shop');
    await copy(tenant, 'auto_shop');
    await root.query(
      `UPDATE services SET name = 'Synthetic Oil Change', price = 79.99
        WHERE tenant_id = $1 AND name = 'Oil Change'`,
      [tenant]
    );
    await root.query(
      `UPDATE employees SET name = 'Maria' WHERE tenant_id = $1 AND name = 'Technician 1'`,
      [tenant]
    );
    const tpl = await root.query<{ name: string; price: string | null }>(
      `SELECT name, price FROM services WHERE tenant_id = $1 AND name LIKE '%Oil Change%'`,
      [AUTO_TEMPLATE]
    );
    expect(tpl.rows).toEqual([{ name: 'Oil Change', price: null }]);
    const techs = await root.query<{ name: string }>(
      'SELECT name FROM employees WHERE tenant_id = $1 ORDER BY name',
      [AUTO_TEMPLATE]
    );
    expect(techs.rows.map((r) => r.name)).toEqual(['Technician 1', 'Technician 2']);
  });

  it('HAPPY: deleting a business that was copied from a template leaves the template intact', async () => {
    const before = await shape(AUTO_TEMPLATE);
    const tenant = await createTenant(root, 'Copy Test Delete', 'auto-shop');
    await copy(tenant, 'auto_shop');
    await root.query('DELETE FROM tenants WHERE tenant_id = $1', [tenant]);
    expect(await shape(AUTO_TEMPLATE)).toEqual(before);
  });

  it('SAD: a template cannot be copied into another template', async () => {
    await expect(copy(SALON_TEMPLATE, 'auto_shop')).rejects.toThrow(/template/i);
  });
});

describe('templates are read-only', () => {
  // Run every attempt as BOTH the superuser (no maintenance flag) and the
  // production role. Neither may change a template.
  const attempts: [string, string, unknown[]][] = [
    [
      'rename a service',
      `UPDATE services SET name = 'Hacked' WHERE tenant_id = $1`,
      [AUTO_TEMPLATE],
    ],
    ['add a price', `UPDATE services SET price = 10 WHERE tenant_id = $1`, [AUTO_TEMPLATE]],
    ['delete a bay', `DELETE FROM resources WHERE tenant_id = $1`, [AUTO_TEMPLATE]],
    [
      'add a service',
      `INSERT INTO services (tenant_id, name, duration_minutes) VALUES ($1, 'Extra', 30)`,
      [AUTO_TEMPLATE],
    ],
    [
      'add a customer',
      `INSERT INTO customers (tenant_id, phone, name) VALUES ($1, '555-0000', 'Nobody')`,
      [AUTO_TEMPLATE],
    ],
    [
      'rename the template',
      `UPDATE tenants SET name = 'Hacked' WHERE tenant_id = $1`,
      [AUTO_TEMPLATE],
    ],
    ['delete the template', `DELETE FROM tenants WHERE tenant_id = $1`, [SALON_TEMPLATE]],
    [
      'remove a knowledge starter',
      `DELETE FROM tenant_docs WHERE tenant_id = $1`,
      [SALON_TEMPLATE],
    ],
  ];

  it.each(attempts)(
    'SAD: the database refuses to %s (superuser, no maintenance flag)',
    async (_what, sql, params) => {
      const before = await shape(AUTO_TEMPLATE);
      await expect(root.query(sql, params)).rejects.toThrow(/read-only/i);
      expect(await shape(AUTO_TEMPLATE)).toEqual(before);
    }
  );

  it('SAD: TRUNCATE — which skips row triggers — is refused too', async () => {
    // WHY: a row trigger alone would let `TRUNCATE services CASCADE` wipe
    //      every template silently.
    const before = await shape(AUTO_TEMPLATE);
    await expect(root.query('TRUNCATE services CASCADE')).rejects.toThrow(/read-only/i);
    await expect(root.query('TRUNCATE tenants CASCADE')).rejects.toThrow(/read-only/i);
    expect(await shape(AUTO_TEMPLATE)).toEqual(before);
  });

  it('SAD: a new tenant cannot be created as a template, or a business turned into one', async () => {
    await expect(
      root.query(
        `INSERT INTO tenants (name, business_type, is_template, template_vertical)
         VALUES ('Sneaky Template', 'salon', true, 'nail_salon')`
      )
    ).rejects.toThrow(/migration/i);
    const tenant = await newTenant('Would Be Template', 'salon');
    await expect(
      root.query(
        `UPDATE tenants SET is_template = true, template_vertical = 'barbershop' WHERE tenant_id = $1`,
        [tenant]
      )
    ).rejects.toThrow(/cannot be turned into a template/i);
  });

  it('SAD: the production role (app_user) cannot change a template either', async () => {
    if (!APP_USER_URL) return;
    const app = new Client({ connectionString: APP_USER_URL });
    try {
      await app.connect();
    } catch {
      // app_user is bootstrapped by scripts/setup-test-db.ts; without it this
      // case is covered by the superuser cases above.
      return;
    }
    try {
      await app.query("SELECT set_config('app.current_tenant_id', $1, false)", [AUTO_TEMPLATE]);
      await expect(
        app.query(`UPDATE services SET name = 'Hacked' WHERE tenant_id = $1`, [AUTO_TEMPLATE])
      ).rejects.toThrow(/read-only/i);
    } finally {
      await app.end();
    }
  });
});
