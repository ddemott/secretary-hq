/**
 * Template businesses end to end — signup, business-type switch, finish setup.
 * Real DB, as the PRODUCTION role (app_user, RLS enforced).
 *
 * WHO  — a new auto shop / salon owner
 * WHAT — signup hands them their own copy of their type's template business;
 *        switching type in the wizard swaps it for the new type's template;
 *        finishing setup makes the copy fully theirs
 * WHERE — src/services/tenants/bootstrap.ts, src/services/tenants/businessTemplate.ts,
 *         POST /tenants/:id/update-config and /finalize-setup (src/routes/tenants.ts)
 * WHY  — Dale 2026-09-25: the chosen business "is duplicated and used for them
 *        to fill out"; the template itself is never changed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Client, Pool } from 'pg';
import { getRootClient, skipIfDbDown, ensureTemplates, API_DB_URL } from '../utils';
import { createWithTenantClient } from '../../src/database';
import { registerTenantRoutes } from '../../src/routes/tenants';
import { registerKnowledgeRoutes } from '../../src/routes/knowledge';
import { registerSetupRoutes } from '../../src/routes/setup';
import { createTenantWithOwner } from '../../src/services/tenants/bootstrap';

const AUTO_TEMPLATE = '7e3a0000-0000-4000-8000-00000000a001';
const SALON_TEMPLATE = '7e3a0000-0000-4000-8000-00000000a002';

type TenantRequest = FastifyRequest & {
  tenantId?: string;
  auth?: { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
};

let root: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
const tenantsToClean: string[] = [];
let seq = 0;

async function names(sql: string, tenantId: string): Promise<string[]> {
  const res = await root.query<{ name: string }>(sql, [tenantId]);
  return res.rows.map((r) => r.name).sort();
}
const serviceNames = (t: string) =>
  names('SELECT name FROM services WHERE tenant_id = $1 AND is_deleted = false', t);
const resourceNames = (t: string) =>
  names('SELECT name FROM resources WHERE tenant_id = $1 AND is_deleted = false', t);
const employeeNames = (t: string) =>
  names('SELECT name FROM employees WHERE tenant_id = $1 AND is_deleted = false', t);
const docTitles = (t: string) =>
  names('SELECT title AS name FROM tenant_docs WHERE tenant_id = $1', t);

async function signUp(businessType: string): Promise<string> {
  seq += 1;
  const res = await createTenantWithOwner(pool, {
    tenantName: `Template Flow ${businessType} ${Date.now()}-${seq}`,
    businessType,
    ownerEmail: `template-flow-${Date.now()}-${seq}@example.com`,
    ownerPassword: 'secure-password-123',
    ownerFullName: 'Flow Owner',
    duplicateCheck: 'email',
  });
  if (!res.ok) throw new Error(`signup failed: ${JSON.stringify(res)}`);
  tenantsToClean.push(res.tenantId);
  return res.tenantId;
}

function updateConfig(tenantId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/tenants/${tenantId}/update-config`,
    headers: { 'x-tenant-id': tenantId },
    payload,
  });
}

beforeAll(async () => {
  try {
    root = await getRootClient();
    await root.query('SELECT 1');
    await ensureTemplates(root);
    pool = new Pool({
      connectionString: process.env.TEST_APP_USER_DATABASE_URL ?? API_DB_URL,
      max: 5,
    });
    await pool.query('SELECT 1');

    app = Fastify({ logger: false });
    app.addHook('preHandler', async (request: TenantRequest) => {
      const tid = request.headers['x-tenant-id'] as string | undefined;
      if (tid) {
        request.tenantId = tid;
        request.auth = {
          tenant_id: tid,
          user_id: '66666666-6666-4666-8666-666666666666',
          email: 'template-flow@example.com',
          role: 'owner',
        };
      }
    });
    const withTenantClient = createWithTenantClient(pool);
    registerTenantRoutes(app, pool, withTenantClient);
    // A fixed vector stands in for OpenAI: the test is about WHEN a starter
    // gets embedded, not what the embedding says.
    registerKnowledgeRoutes(app, pool, async () => Array(1536).fill(0.01), withTenantClient);
    registerSetupRoutes(app, pool, withTenantClient);
    await app.ready();
    dbAvailable = true;
  } catch (err) {
    console.warn('[businessTemplatesFlow.realdb.test] DB not available, skipping', err);
  }
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (root) {
    for (const id of tenantsToClean) {
      await root.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
    }
    await root.end();
  }
});

beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

describe('signup', () => {
  it('HAPPY: a new auto shop starts with its own copy of the Auto Shop Template', async () => {
    const tenant = await signUp('auto-shop');
    expect(await serviceNames(tenant)).toEqual(await serviceNames(AUTO_TEMPLATE));
    expect(await employeeNames(tenant)).toEqual(['Mechanic 1', 'Mechanic 2']);
    expect(await docTitles(tenant)).toEqual(await docTitles(AUTO_TEMPLATE));
  });

  it('HAPPY: exactly the template’s bays — the generic signup resource is replaced, not added to', async () => {
    const tenant = await signUp('auto-shop');
    expect(await resourceNames(tenant)).toEqual(await resourceNames(AUTO_TEMPLATE));
  });

  it('SAD: no prices, no customers, no appointments come with the copy', async () => {
    const tenant = await signUp('salon');
    const q = async (sql: string) => (await root.query<{ n: number }>(sql, [tenant])).rows[0].n;
    expect(
      await q('SELECT count(*)::int AS n FROM services WHERE tenant_id = $1 AND price IS NOT NULL')
    ).toBe(0);
    expect(await q('SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1')).toBe(0);
    expect(await q('SELECT count(*)::int AS n FROM appointments WHERE tenant_id = $1')).toBe(0);
  });

  it('HAPPY: a business type with no template still signs up, just empty', async () => {
    // Every type signup OFFERS has a template; a free-text/API type does not.
    const tenant = await signUp('dog-walking');
    expect(await serviceNames(tenant)).toEqual([]);
  });
});

describe('switching business type in the wizard', () => {
  it('HAPPY: auto shop → salon swaps the Auto Shop copy for a Salon copy', async () => {
    const tenant = await signUp('auto-shop');
    const res = await updateConfig(tenant, { business_type: 'salon' });
    expect(res.statusCode).toBe(200);
    expect(res.json().templateCopied).toBe(true);
    expect(await serviceNames(tenant)).toEqual(await serviceNames(SALON_TEMPLATE));
    expect(await resourceNames(tenant)).toEqual(await resourceNames(SALON_TEMPLATE));
    expect(await employeeNames(tenant)).toEqual(['Stylist 1', 'Stylist 2']);
    // No auto-shop leftovers: starters or skills.
    expect(await docTitles(tenant)).toEqual(await docTitles(SALON_TEMPLATE));
    const skills = await names('SELECT name FROM tenant_skills WHERE tenant_id = $1', tenant);
    expect(skills).toEqual(
      await names('SELECT name FROM tenant_skills WHERE tenant_id = $1', SALON_TEMPLATE)
    );
  });

  it('SAD: anything the owner typed survives a type switch, and nothing is copied over it', async () => {
    const tenant = await signUp('auto-shop');
    await root.query(
      `INSERT INTO services (tenant_id, name, duration_minutes, is_auto_seeded)
       VALUES ($1, 'Owner Custom Service', 30, false)`,
      [tenant]
    );
    const res = await updateConfig(tenant, { business_type: 'salon' });
    expect(res.statusCode).toBe(200);
    expect(res.json().templateCopied).toBe(false);
    expect(await serviceNames(tenant)).toEqual(['Owner Custom Service']);
  });

  it('SAD: a knowledge answer the owner saved is kept on a type switch', async () => {
    const tenant = await signUp('auto-shop');
    // Saving an entry in the dashboard embeds it; simulate that on one starter.
    await root.query(
      `UPDATE tenant_docs SET embedding = array_fill(0.01, ARRAY[1536])::vector
        WHERE tenant_id = $1 AND title = 'Can I wait while you work on my car?'`,
      [tenant]
    );
    await updateConfig(tenant, { business_type: 'salon' });
    expect(await docTitles(tenant)).toContain('Can I wait while you work on my car?');
  });

  it('HAPPY: the templates are untouched by all of the above', async () => {
    expect(await serviceNames(AUTO_TEMPLATE)).toContain('Oil Change');
    expect(await employeeNames(AUTO_TEMPLATE)).toEqual(['Mechanic 1', 'Mechanic 2']);
    expect(await employeeNames(SALON_TEMPLATE)).toEqual(['Stylist 1', 'Stylist 2']);
  });
});

describe('finishing setup', () => {
  it('HAPPY: finalize-setup makes the copied services, bays and staff the owner’s own', async () => {
    const tenant = await signUp('salon');
    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${tenant}/finalize-setup`,
      headers: { 'x-tenant-id': tenant },
    });
    expect(res.statusCode).toBe(200);
    for (const table of ['services', 'resources', 'employees']) {
      const left = await root.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND is_auto_seeded`,
        [tenant]
      );
      expect(left.rows[0].n, table).toBe(0);
    }
    // …so a later type switch no longer removes them.
    await updateConfig(tenant, { business_type: 'auto-shop' });
    expect(await serviceNames(tenant)).toEqual(await serviceNames(SALON_TEMPLATE));
  });
});

describe('templates stay out of the way', () => {
  it('SAD: the super-admin business list never shows a template', async () => {
    // WHY: a template is read-only; opening it from the switcher could only
    //      produce errors, and it is not a customer.
    const res = await app.inject({
      method: 'GET',
      url: '/tenants',
      headers: { 'x-tenant-id': '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().map((t) => t.tenant_id);
    expect(ids).not.toContain(AUTO_TEMPLATE);
    expect(ids).not.toContain(SALON_TEMPLATE);
  });
});

describe('knowledge starters', () => {
  it('HAPPY: starters show as not-yet-used, and saving one switches it on', async () => {
    const tenant = await signUp('salon');
    const list = async () =>
      (
        await app.inject({ method: 'GET', url: '/knowledge', headers: { 'x-tenant-id': tenant } })
      ).json();

    const before = await list();
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((d) => d.is_unreviewed_starter)).toBe(true);

    const walkIns = before.find((d) => d.title === 'Do you take walk-ins?')!;
    const put = await app.inject({
      method: 'PUT',
      url: `/knowledge/${walkIns.tenant_doc_id}`,
      headers: { 'x-tenant-id': tenant },
      payload: {
        question: 'Do you take walk-ins?',
        answer: 'Yes, Tuesday to Saturday until 4 PM.',
        source: 'template',
      },
    });
    expect(put.statusCode).toBe(200);

    const after = await list();
    const saved = after.find((d) => d.tenant_doc_id === walkIns.tenant_doc_id)!;
    expect(saved.is_unreviewed_starter).toBe(false);
    expect(after.filter((d) => d.is_unreviewed_starter)).toHaveLength(before.length - 1);
  });
});

describe('team wizard commit', () => {
  it('HAPPY: saving the wizard makes the copied services, bays and staff the owner’s own', async () => {
    // WHO: an owner who walks the TEAM wizard over their template copy.
    // WHAT: the wizard loads /setup/graph and posts it back in sync mode;
    //       every row it posts is one the owner reviewed, so none stays
    //       is_auto_seeded.
    // WHY: the team wizard never calls finalize-setup. Without this, the
    //      placeholder staff stay unclaimed, Home keeps reopening the setup
    //      welcome, and a later type switch would delete the owner's staff.
    const tenant = await signUp('auto-shop');
    const headers = { 'x-tenant-id': tenant };
    type Row = Record<string, string | number | null>;
    const graph: {
      services: Row[];
      resources: Row[];
      employees: Row[];
      service_employee: Row[];
      service_resource: Row[];
    } = (await app.inject({ method: 'GET', url: '/setup/graph', headers })).json();
    // Same shape the wizard posts (useWizardCrud hydrate → buildDraftGraph):
    // the real id doubles as the tmp id, and nulls become "not given".
    const u = <T>(v: T | null) => (v === null ? undefined : v);
    const draft = {
      services: graph.services.map((s) => ({
        tmp_id: s.service_id,
        existing_id: s.service_id,
        name: s.name,
        duration_minutes: s.duration_minutes,
        description: u(s.description),
        price: u(s.price),
      })),
      resources: graph.resources.map((r) => ({
        tmp_id: r.resource_id,
        existing_id: r.resource_id,
        name: r.name,
        description: u(r.description),
      })),
      employees: graph.employees.map((e) => ({
        tmp_id: e.employee_id,
        existing_id: e.employee_id,
        name: e.name,
        first_name: u(e.first_name),
        last_name: u(e.last_name),
      })),
      shifts: [],
      service_employee: graph.service_employee.map((m) => ({
        service_tmp_id: m.service_id,
        employee_tmp_id: m.employee_id,
      })),
      service_resource: graph.service_resource.map((m) => ({
        service_tmp_id: m.service_id,
        resource_tmp_id: m.resource_id,
      })),
      mode: 'sync',
    };
    const commit = await app.inject({
      method: 'POST',
      url: '/setup/commit',
      headers,
      payload: draft,
    });
    expect(commit.statusCode, commit.body).toBe(200);
    for (const table of ['services', 'resources', 'employees']) {
      const left = await root.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table}
          WHERE tenant_id = $1 AND is_deleted = false AND is_auto_seeded`,
        [tenant]
      );
      expect(left.rows[0].n, table).toBe(0);
    }
  });
});
