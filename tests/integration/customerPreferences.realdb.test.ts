/**
 * GET /customers/:id/preferences — real DB.
 *
 * WHO  — an owner opening a customer's profile in the CRM
 * WHAT — the preferences the AI receptionist saved for that caller
 * WHEN — any time after a call where the caller mentioned one
 * WHERE — src/routes/customers.ts → customer_preferences (written by the
 *         agent's remember_preference tool)
 * WHY  — before this route nothing in the dashboard read these rows: the
 *        agent used them on the next call but the owner could never see them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Client, Pool } from 'pg';
import {
  API_DB_URL,
  getRootClient,
  createTenant,
  createCustomerFull,
  skipIfDbDown,
} from '../utils';
import { createWithTenantClient } from '../../src/database';
import { registerCustomerRoutes } from '../../src/routes/customers';

type TenantRequest = FastifyRequest & {
  tenantId?: string;
  auth?: { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
};

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
let tenantA: string;
let tenantB: string;
let customerA: string;
let customerB: string;

function getPrefs(customerId: string, asTenant: string) {
  return app.inject({
    method: 'GET',
    url: `/customers/${customerId}/preferences`,
    headers: { 'x-tenant-id': asTenant },
  });
}

async function addPref(tenantId: string, customerId: string, key: string, value: string) {
  await setup.query(
    `INSERT INTO customer_preferences (tenant_id, customer_id, pref_key, pref_value)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, customerId, key, value]
  );
}

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });

    app = Fastify({ logger: false });
    app.addHook('preHandler', async (request: TenantRequest) => {
      const tid = request.headers['x-tenant-id'] as string | undefined;
      if (tid) {
        request.tenantId = tid;
        request.auth = {
          tenant_id: tid,
          user_id: '77777777-7777-4777-8777-777777777777',
          email: 'realdb-prefs@example.com',
          role: 'owner',
        };
      }
    });
    registerCustomerRoutes(app, pool, createWithTenantClient(pool));
    await app.ready();

    tenantA = await createTenant(setup, 'Prefs Tenant A', 'salon');
    tenantB = await createTenant(setup, 'Prefs Tenant B', 'salon');
    customerA = await createCustomerFull(setup, tenantA, '+15554550001', 'Pat Prefs');
    customerB = await createCustomerFull(setup, tenantB, '+15554550002', 'Other Tenant');
    await addPref(tenantA, customerA, 'preferred_staff', 'Jordan');
    await addPref(tenantA, customerA, 'contact_method', 'Email');
    await addPref(tenantB, customerB, 'preferred_staff', 'Someone else');

    dbAvailable = true;
  } catch (err) {
    console.warn('[customerPreferences.realdb.test] DB not available, skipping', err);
  }
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (setup) {
    for (const id of [tenantA, tenantB].filter(Boolean)) {
      await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
    }
    await setup.end();
  }
});

beforeEach((ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
});

describe('GET /customers/:id/preferences', () => {
  it("HAPPY: returns the customer's saved preferences, ordered by key", async () => {
    const res = await getPrefs(customerA, tenantA);
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows.map((r) => [r.pref_key, r.pref_value])).toEqual([
      ['contact_method', 'Email'],
      ['preferred_staff', 'Jordan'],
    ]);
    expect(rows[0].updated_at).toBeTruthy();
  });

  it("HAPPY: each preference carries its label in this business's wording", async () => {
    const rows = (await getPrefs(customerA, tenantA)).json();
    expect(rows.find((r) => r.pref_key === 'preferred_staff')?.label).toBe(
      'Preferred staff member'
    );
    expect(rows.every((r) => r.label && !r.label.includes('_'))).toBe(true);
  });

  it('SAD: another tenant cannot read them — returns an empty list, not the rows', async () => {
    // WHY: tenant isolation. The customer id alone must never be enough.
    const res = await getPrefs(customerA, tenantB);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('HAPPY: a customer with no preferences gets an empty list', async () => {
    const fresh = await createCustomerFull(setup, tenantA, '+15554550003', 'No Prefs');
    const res = await getPrefs(fresh, tenantA);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("SAD: a deleted customer's preferences are not shown", async () => {
    const gone = await createCustomerFull(setup, tenantA, '+15554550004', 'Gone Customer');
    await addPref(tenantA, gone, 'preferred_days', 'Weekends');
    await setup.query('UPDATE customers SET is_deleted = true WHERE customer_id = $1', [gone]);
    const res = await getPrefs(gone, tenantA);
    expect(res.json()).toEqual([]);
  });

  it('SAD: a malformed id is a 400, not a database error', async () => {
    const res = await getPrefs('not-a-uuid', tenantA);
    expect(res.statusCode).toBe(400);
  });
});
