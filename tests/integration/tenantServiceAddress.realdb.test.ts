/**
 * Tenant service address — real DB (migration 20261005000000).
 *
 * WHO  — a business signing up; the platform computing sales tax for it
 * WHAT — tenants carry the address where the service is USED (street, city, state, zip, country)
 * WHEN — signup / checkout; read when the Stripe customer is created
 * WHERE — supabase/migrations/20261005000000_tenant_service_address.sql
 * WHY  — SaaS tax follows where the customer uses the service. Existing tenants have no address, so
 *        the columns are nullable; but a value that IS stored must be well-formed and complete.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';
import { getRootClient, createTenant } from '../utils';

let root: Client;
let dbAvailable = false;
const created: string[] = [];

async function newTenant(): Promise<string> {
  const id = await createTenant(root, `Addr Test ${created.length}`, 'automotive');
  created.push(id);
  return id;
}

const setAddress = (
  id: string,
  street: string | null,
  city: string | null,
  state: string | null,
  zip: string | null
) =>
  root.query(
    'UPDATE tenants SET service_street=$2, service_city=$3, service_state=$4, service_zip=$5 WHERE tenant_id=$1',
    [id, street, city, state, zip]
  );

beforeAll(async () => {
  try {
    root = await getRootClient();
    await root.query('SELECT 1');
    dbAvailable = true;
  } catch (err) {
    console.warn('[tenantServiceAddress.realdb.test] DB not available, skipping', err);
  }
});

afterAll(async () => {
  if (!root) return;
  for (const id of created) {
    await root.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
  }
  await root.end();
});

describe('tenants.service_* address columns', () => {
  it('a new tenant has no address and defaults the country to US', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const id = await newTenant();
    const r = await root.query('SELECT * FROM tenants WHERE tenant_id = $1', [id]);
    expect(r.rows[0].service_street).toBeNull();
    expect(r.rows[0].service_zip).toBeNull();
    expect(r.rows[0].service_country).toBe('US');
  });

  it('stores a complete, well-formed address (zip and zip+4)', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const id = await newTenant();
    await setAddress(id, '1 N State St', 'Chicago', 'IL', '60602');
    await setAddress(id, '1 N State St', 'Chicago', 'IL', '60602-1234');
    const r = await root.query('SELECT service_city, service_zip FROM tenants WHERE tenant_id=$1', [
      id,
    ]);
    expect(r.rows[0]).toEqual({ service_city: 'Chicago', service_zip: '60602-1234' });
  });

  it('refuses a half-filled address', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const id = await newTenant();
    await expect(setAddress(id, '1 N State St', null, null, null)).rejects.toThrow(
      /tenants_service_address_complete/
    );
  });

  it.each([
    ['lowercase state', 'il', '60602', /tenants_service_state_format/],
    ['three-letter state', 'ILL', '60602', /tenants_service_state_format/],
    ['short zip', 'IL', '6060', /tenants_service_zip_format/],
    ['lettered zip', 'IL', 'ABCDE', /tenants_service_zip_format/],
  ])('refuses a malformed value: %s', async (_label, state, zip, err) => {
    if (!dbAvailable) return;
    const id = await newTenant();
    await expect(setAddress(id, '1 N State St', 'Chicago', state, zip)).rejects.toThrow(err);
  });

  it('refuses a malformed country', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const id = await newTenant();
    await expect(
      root.query("UPDATE tenants SET service_country='usa' WHERE tenant_id=$1", [id])
    ).rejects.toThrow(/tenants_service_country_format/);
  });

  it('lets the address be cleared back to nothing', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const id = await newTenant();
    await setAddress(id, '1 N State St', 'Chicago', 'IL', '60602');
    await setAddress(id, null, null, null, null);
    const r = await root.query('SELECT service_street FROM tenants WHERE tenant_id=$1', [id]);
    expect(r.rows[0].service_street).toBeNull();
  });
});
