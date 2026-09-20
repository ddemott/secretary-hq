/**
 * Real-DB companion for the employee-create duplicate guard.
 *
 * Motivation (docs/TODO.md "Data integrity / hygiene"): prod accumulated a
 * duplicate active "Dale DeMott" employee. POST /employees/create had no
 * duplicate check, so an owner (or a double-submit) could create a second
 * ACTIVE employee with the same name. This suite drives the real route → real
 * Postgres and proves the guard: a name that collides with an existing
 * NON-deleted employee is refused (409), while a soft-deleted twin does NOT
 * block a fresh create (re-add is allowed).
 *
 * Strategy mirrors users.realdb.test.ts: real pg.Pool on API_DB_URL + a
 * preHandler standing in for tenantMiddleware. Fixtures per-suite, cleaned in
 * afterAll. Skips when DB down; hard-fails under REQUIRE_DB_TESTS=1 (CI).
 *
 * 5W for sad-path failures:
 *   WHO  — an owner adding a team member
 *   WHAT — POST /employees/create
 *   WHEN — onboarding / re-adding staff
 *   WHERE — employees.ts CreateEmployeeSchema handler duplicate guard
 *   WHY  — a duplicate active employee splits schedules/skills across two rows
 *          and confuses booking assignment; a blocked re-add would be worse.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Client, Pool } from 'pg';
import {
  API_DB_URL,
  getRootClient,
  createTenant,
  createEmployee,
  skipIfDbDown,
} from '../utils';
import { createWithTenantClient } from '../../src/database';
import { registerEmployeeRoutes } from '../../src/routes/employees';

type TenantRequest = FastifyRequest & {
  tenantId?: string;
  auth?: { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
};

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
let tenantId: string;
const tenantsToClean: string[] = [];

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });

    tenantId = await createTenant(setup, 'Employees Realdb Tenant', 'salon');
    tenantsToClean.push(tenantId);

    app = Fastify({ logger: false });
    app.addHook('preHandler', async (request: TenantRequest) => {
      const tid = request.headers['x-tenant-id'] as string | undefined;
      if (tid) {
        request.tenantId = tid;
        const role = (request.headers['x-test-role'] as 'owner' | 'front_desk' | undefined) ?? 'owner';
        request.auth = { tenant_id: tid, user_id: 'test', email: 'o@e.test', role };
      }
    });
    const withTenantClient = createWithTenantClient(pool);
    registerEmployeeRoutes(
      app,
      pool,
      withTenantClient
    );
    await app.ready();

    dbAvailable = true;
  } catch (err) {
     
    console.warn('[employees.realdb.test] DB not available, skipping', err);
  }
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (setup) {
    for (const id of tenantsToClean) {
      await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
    }
    await setup.end();
  }
});

beforeEach((ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
});

function create(payload: Record<string, unknown>, role: 'owner' | 'front_desk' = 'owner') {
  return app.inject({
    method: 'POST',
    url: '/employees/create',
    headers: { 'x-tenant-id': tenantId, 'x-test-role': role },
    payload: { tenant_id: tenantId, ...payload },
  });
}

describe('POST /employees/create → duplicate-active guard (real DB)', () => {
  it('HAPPY: creates a new employee when no active namesake exists', async () => {
    const res = await create({ first_name: 'Nadia', last_name: 'Novak' });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().employee.name).toBe('Nadia Novak');
  });

  it('GUARD: a second ACTIVE employee with the same name is refused (409), no second row', async () => {
    await create({ first_name: 'Dana', last_name: 'Duplicate' });
    // Same name again — even with different casing/whitespace it must collide.
    const res = await create({ first_name: '  dana', last_name: 'DUPLICATE ' });
    expect(res.statusCode).toBe(409);
    expect(res.json().success).toBe(false);

    const rows = await setup.query(
      `SELECT 1 FROM employees WHERE tenant_id = $1 AND is_deleted = false AND LOWER(TRIM(name)) = 'dana duplicate'`,
      [tenantId]
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('ALLOWS: re-adding a name whose only match is soft-deleted (re-hire path)', async () => {
    const empId = await createEmployee(setup, tenantId, 'Rex Rehire');
    await setup.query(
      `UPDATE employees SET is_deleted = true, deleted_at = NOW(), is_active = false WHERE employee_id = $1`,
      [empId]
    );
    // The soft-deleted twin must NOT block the create.
    const res = await create({ first_name: 'Rex', last_name: 'Rehire' });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const active = await setup.query(
      `SELECT 1 FROM employees WHERE tenant_id = $1 AND is_deleted = false AND name = 'Rex Rehire'`,
      [tenantId]
    );
    expect(active.rows).toHaveLength(1);
  });

  it('SECURITY: a front-desk user is rejected 403 before any row is created', async () => {
    const res = await create({ first_name: 'Blocked', last_name: 'FrontDesk' }, 'front_desk');
    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);

    const rows = await setup.query(
      `SELECT 1 FROM employees WHERE tenant_id = $1 AND LOWER(TRIM(name)) = 'blocked frontdesk'`,
      [tenantId]
    );
    expect(rows.rows).toHaveLength(0);
  });
});
