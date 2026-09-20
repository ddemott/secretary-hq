/**
 * Real-DB coverage for POST /setup/commit (setup-wizard Phase B).
 *
 * Twin of coverageDryRun.realdb.test.ts (same draft-graph shape, same
 * insertDraftGraph body) but this one actually COMMITs. The properties this
 * suite pins:
 *   (1) the full column set is written — the "lossy insert" bug found in
 *       design review (reusing dry-run's INSERT verbatim would silently drop
 *       description/price/employee-contact fields) does NOT reproduce here.
 *   (2) shifts actually land in employee_schedule (proves the fan-out ran).
 *   (3) the idempotency guard rejects a second commit on an already-set-up
 *       tenant, and rejects it BEFORE writing anything.
 *   (4) a broken draft graph (dangling tmp_id) is rejected before any insert.
 *
 * Note on atomicity: a literal "mid-graph DB-constraint failure leaves zero
 * rows" test was investigated and deliberately NOT written — services/
 * employees/resources have no UNIQUE or CHECK constraint reachable via valid
 * API input in the current schema (name/description are unbounded TEXT), so
 * there is no honest way to trigger one without fabricating a fake failure.
 * BEGIN/COMMIT/ROLLBACK is standard Postgres transaction semantics, not
 * bespoke code; the route's try/ROLLBACK/throw wrapper is straightforward
 * enough to read. If a future migration adds a real constraint here, add a
 * matching atomicity test then.
 *
 * WHO: an owner clicking into the wizard's "Go Live" step (commit-on-enter,
 * per docs/superpowers/specs/2026-07-05-wizard-phase-b-design.md §2)
 * WHAT: the draft entity graph becomes real, committed rows
 * WHEN: Phase B draft-commit flow | WHERE: src/routes/setup.ts
 * WHY: single insert path shared with dry-run — same trust, real persistence.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool, type Client } from 'pg';
import { API_DB_URL, getRootClient, createTenant, skipIfDbDown } from '../utils';
import { createWithTenantClient } from '../../src/database';
import { registerSetupRoutes } from '../../src/routes/setup';

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
let tenantId: string;
const tenantsToClean: string[] = [];

function post(url: string, body: unknown, tenant: string | false = tenantId) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (tenant) headers['x-tenant-id'] = tenant;
  return app.inject({ method: 'POST', url, headers, payload: body as object });
}

const EVERY_WEEKDAY = [0, 1, 2, 3, 4, 5, 6];

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    dbAvailable = true;
  } catch {
    return; // DB down → beforeEach skips every test
  }
  pool = new Pool({ connectionString: API_DB_URL, max: 5 });
  app = Fastify({ logger: false });
  type TenantRequest = FastifyRequest & {
    tenantId?: string;
    auth?: { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
  };
  app.addHook('preHandler', async (request: TenantRequest) => {
    const h = request.headers['x-tenant-id'];
    if (typeof h === 'string' && h) {
      request.tenantId = h;
      // Owner by default — /setup/commit, /setup/impact, and
      // /setup/default-service are all owner-gated (requireOwnerRole,
      // 2026-09-16 role-check audit).
      request.auth = {
        tenant_id: h,
        user_id: '00000000-0000-0000-0000-000000000001',
        email: 'owner@test.local',
        role: 'owner',
      };
    }
  });
  registerSetupRoutes(app, pool, createWithTenantClient(pool));
  await app.ready();
});

afterAll(async () => {
  if (!dbAvailable) return;
  for (const t of tenantsToClean) {
    await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [t]).catch(() => undefined);
  }
  await app?.close();
  await pool?.end();
  await setup?.end();
});

beforeEach(async (ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
  if (dbAvailable) {
    tenantId = await createTenant(setup, 'Setup Commit Tenant', 'salon', 'Etc/UTC');
    tenantsToClean.push(tenantId);
  }
});

describe('POST /setup/commit', () => {
  it('SAD: rejects a malformed draft (missing services) with 400', async () => {
    const res = await post('/setup/commit', { resources: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
  });

  it('SAD: no tenant header → 401 (never runs the insert anonymously)', async () => {
    const res = await post('/setup/commit', { services: [] }, false);
    expect(res.statusCode).toBe(401);
  });

  it('SAD: a repeated tmp_id within employees → 400, writes nothing', async () => {
    const res = await post('/setup/commit', {
      services: [{ tmp_id: 's1', name: 'Cut', duration_minutes: 30 }],
      employees: [
        { tmp_id: 'e1', name: 'Tess' },
        { tmp_id: 'e1', name: 'Duplicate Tess' },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/duplicate tmp_ids/i);

    const { rows } = await setup.query(
      'SELECT count(*)::int AS n FROM employees WHERE tenant_id = $1',
      [tenantId]
    );
    expect(rows[0].n).toBe(0);
  });

  it('SAD: a mapping referencing an unknown tmp_id → 400, writes nothing', async () => {
    const res = await post('/setup/commit', {
      services: [{ tmp_id: 's1', name: 'Cut', duration_minutes: 30 }],
      employees: [{ tmp_id: 'e1', name: 'Tess' }],
      service_employee: [{ service_tmp_id: 's1', employee_tmp_id: 'ghost' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/unknown tmp_ids/i);

    const { rows } = await setup.query(
      'SELECT count(*)::int AS n FROM services WHERE tenant_id = $1',
      [tenantId]
    );
    expect(rows[0].n).toBe(0);
  });

  it('HAPPY: commits the full graph with the FULL column set (price + employee contact round-trip)', async () => {
    const draft = {
      services: [
        {
          tmp_id: 's1',
          name: 'Signature Cut',
          duration_minutes: 45,
          description: 'A full consult and cut',
          price: 65.5,
          subtitle: 'Includes wash',
        },
      ],
      resources: [{ tmp_id: 'r1', name: 'Chair 1', description: 'Front window chair' }],
      employees: [
        {
          tmp_id: 'e1',
          name: 'Tess Stylist',
          first_name: 'Tess',
          last_name: 'Stylist',
          email: 'tess@example.com',
          phone: '+16085551234',
        },
      ],
      shifts: EVERY_WEEKDAY.map((d) => ({
        employee_tmp_id: 'e1',
        day_of_week: d,
        start_time: '09:00',
        end_time: '17:00',
      })),
      service_employee: [{ service_tmp_id: 's1', employee_tmp_id: 'e1' }],
      service_resource: [{ service_tmp_id: 's1', resource_tmp_id: 'r1' }],
    };

    const res = await post('/setup/commit', draft);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    // `updated`/`pruned` are 0 on a create-mode commit by definition: it only
    // ever INSERTs, and it never touches rows the draft didn't mention. Asserted
    // explicitly (rather than loosened to toMatchObject) so a create-mode commit
    // that silently starts updating or soft-deleting a tenant's rows FAILS here.
    // `upcoming_appointments_affected` is likewise 0 — nothing was removed.
    expect(body.counts).toEqual({
      services: 1,
      resources: 1,
      employees: 1,
      serviceEmployee: 1,
      serviceResource: 1,
      updated: 0,
      pruned: 0,
      upcoming_appointments_affected: 0,
    });

    // The decisive check: description/price/subtitle and employee contact
    // fields actually persisted — NOT silently dropped like a naive reuse
    // of the dry-run INSERT would do.
    const svc = await setup.query(
      'SELECT description, price, subtitle FROM services WHERE tenant_id = $1',
      [tenantId]
    );
    expect(svc.rows[0].description).toBe('A full consult and cut');
    expect(Number(svc.rows[0].price)).toBe(65.5);
    expect(svc.rows[0].subtitle).toBe('Includes wash');

    const emp = await setup.query(
      'SELECT first_name, last_name, email, phone FROM employees WHERE tenant_id = $1',
      [tenantId]
    );
    expect(emp.rows[0]).toMatchObject({
      first_name: 'Tess',
      last_name: 'Stylist',
      email: 'tess@example.com',
      phone: '+16085551234',
    });

    // Filter by name: a fresh salon tenant auto-seeds a default resource
    // ("Main chair for hair services") via a DB trigger, so the tenant has
    // more than one resource row by the time this query runs.
    const res2 = await setup.query(
      'SELECT description FROM resources WHERE tenant_id = $1 AND name = $2',
      [tenantId, 'Chair 1']
    );
    expect(res2.rows[0].description).toBe('Front window chair');
  });

  it('HAPPY: shifts actually fan into employee_schedule (proves the fan-out ran)', async () => {
    const draft = {
      services: [{ tmp_id: 's1', name: 'Cut', duration_minutes: 30 }],
      employees: [{ tmp_id: 'e1', name: 'Tess' }],
      shifts: [{ employee_tmp_id: 'e1', day_of_week: 1, start_time: '09:00', end_time: '17:00' }],
      service_employee: [{ service_tmp_id: 's1', employee_tmp_id: 'e1' }],
    };
    const res = await post('/setup/commit', draft);
    expect(res.statusCode).toBe(200);

    const { rows } = await setup.query(
      `SELECT es.start_time, es.end_time FROM employee_schedule es
       JOIN employees e ON e.employee_id = es.employee_id
       WHERE e.tenant_id = $1`,
      [tenantId]
    );
    // 4-week default horizon → at least 4 Mondays land in employee_schedule.
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((r) => r.start_time.slice(0, 5) === '09:00')).toBe(true);
  });

  it('HAPPY: a duplicate mapping in the draft reports the real row count, not the attempt count', async () => {
    // Two services both mapped to the same employee, PLUS the same mapping
    // listed twice — ON CONFLICT DO NOTHING must skip the repeat, and the
    // returned count must reflect rows actually created (2), not attempts (3).
    const draft = {
      services: [
        { tmp_id: 's1', name: 'Cut', duration_minutes: 30 },
        { tmp_id: 's2', name: 'Color', duration_minutes: 60 },
      ],
      employees: [{ tmp_id: 'e1', name: 'Tess' }],
      service_employee: [
        { service_tmp_id: 's1', employee_tmp_id: 'e1' },
        { service_tmp_id: 's2', employee_tmp_id: 'e1' },
        { service_tmp_id: 's1', employee_tmp_id: 'e1' }, // repeat of the first
      ],
    };
    const res = await post('/setup/commit', draft);
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.serviceEmployee).toBe(2);

    const { rows } = await setup.query(
      'SELECT count(*)::int AS n FROM service_employee se JOIN employees e ON e.employee_id = se.employee_id WHERE e.tenant_id = $1',
      [tenantId]
    );
    expect(rows[0].n).toBe(2);
  });

  it('SAD: idempotency guard rejects a second commit on an already-set-up tenant with 409, writes nothing new', async () => {
    const draft = {
      services: [{ tmp_id: 's1', name: 'Cut', duration_minutes: 30 }],
    };
    const first = await post('/setup/commit', draft);
    expect(first.statusCode).toBe(200);

    const before = await setup.query(
      'SELECT count(*)::int AS n FROM services WHERE tenant_id = $1',
      [tenantId]
    );

    const second = await post('/setup/commit', {
      services: [{ tmp_id: 's2', name: 'Color', duration_minutes: 60 }],
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().success).toBe(false);

    const after = await setup.query(
      'SELECT count(*)::int AS n FROM services WHERE tenant_id = $1',
      [tenantId]
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
