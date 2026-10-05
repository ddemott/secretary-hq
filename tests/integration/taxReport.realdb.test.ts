/**
 * Tax-location report loader — real DB.
 * WHO: the super-admin tax summary | WHAT: only real businesses are counted — not deleted ones,
 * the template businesses, or the public Tutorial | WHY: a template or Tutorial row in the
 * numbers would invent customers in states we do not sell into.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';
import { Pool } from 'pg';
import { getRootClient, createTenant, ensureTemplates } from '../utils';
import { loadTaxLocationRows } from '../../src/services/taxReport';

let root: Client;
let pool: Pool;
let dbAvailable = false;
const created: string[] = [];

beforeAll(async () => {
  try {
    root = await getRootClient();
    await root.query('SELECT 1');
    await ensureTemplates(root);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    dbAvailable = true;
  } catch (err) {
    console.warn('[taxReport.realdb.test] DB not available, skipping', err);
  }
});

afterAll(async () => {
  if (root) {
    for (const id of created) {
      await root.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
    }
    await root.end();
  }
  if (pool) await pool.end();
});

describe('loadTaxLocationRows', () => {
  it('counts a real business with its address and leaves out deleted, tutorial and template rows', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const tag = `TaxRpt ${Date.now()}`;
    const real = await createTenant(root, `${tag} real`, 'automotive');
    const gone = await createTenant(root, `${tag} gone`, 'automotive');
    const tut = await createTenant(root, `${tag} tutorial`, 'automotive');
    created.push(real, gone, tut);
    await root.query(
      `UPDATE tenants SET service_street='1 N State St', service_city='Chicago',
              service_state='IL', service_zip='60602', subscription_status='active',
              subscription_plan='solo' WHERE tenant_id=$1`,
      [real]
    );
    await root.query('UPDATE tenants SET is_deleted = true WHERE tenant_id = $1', [gone]);
    await root.query('UPDATE tenants SET is_tutorial = true WHERE tenant_id = $1', [tut]);

    const rows = await loadTaxLocationRows(pool);
    const ids = rows.map((r) => r.tenant_id);

    expect(ids).toContain(real);
    expect(ids).not.toContain(gone);
    expect(ids).not.toContain(tut);
    expect(rows.every((r) => !r.name.includes('Template'))).toBe(true);
    const mine = rows.find((r) => r.tenant_id === real)!;
    expect(mine).toMatchObject({
      service_city: 'Chicago',
      service_state: 'IL',
      service_zip: '60602',
      subscription_plan: 'solo',
    });
  });
});
