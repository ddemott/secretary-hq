/**
 * Real-DB coverage for RE-RUNNING setup on a tenant that already has data —
 * GET /setup/graph + POST /setup/commit with `mode: 'sync'`.
 *
 * The bug this suite pins down: setup used to be a one-shot. A create-mode
 * commit is INSERT-only, so the route hard-409'd ("Setup already completed")
 * the moment a tenant had any live service — which meant the owners who most
 * needed to fix their setup (the ones who'd already done it) were the only ones
 * locked out of it. Sync mode makes a re-run an EDIT: rows carrying their real
 * uuid in `existing_id` are UPDATEd in place, brand-new rows are INSERTed, and
 * rows the owner dropped from the draft are soft-deleted.
 *
 * Why real-DB and not mocks: nearly all the risk here is SQL that a mock would
 * happily rubber-stamp — `<> ALL($2::uuid[])` against an EMPTY array (must match
 * every row, i.e. "the owner deleted everything"), the resources UPDATE that must
 * NOT touch a non-existent updated_at column, EXTRACT(DOW) round-tripping the
 * weekly grid, and soft-delete leaving booked appointments' FKs intact. A mocked
 * client proves the mock works, not the migration.
 *
 * WHO: an owner reopening the Setup Assistant on a live business
 * WHAT: their real graph loads, they edit it, and commit updates rather than duplicates
 * WHEN: every re-run | WHERE: src/routes/setup.ts + src/services/setupGraph.ts
 * WHY: regression guard — the dangerous direction is a sync commit PRUNING
 *      something it shouldn't, so most of these assert what SURVIVES.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Pool, type Client } from 'pg';
import { API_DB_URL, getRootClient, createTenant, skipIfDbDown } from '../utils';
import { createWithTenantClient } from '../../src/database';
import { registerSetupRoutes } from '../../src/routes/setup';
import { registerShiftRoutes } from '../../src/routes/shifts';

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

function get(url: string, tenant: string | false = tenantId) {
  const headers: Record<string, string> = {};
  if (tenant) headers['x-tenant-id'] = tenant;
  return app.inject({ method: 'GET', url, headers });
}

/** The starting business every test re-runs setup against: 2 services, 1 resource,
 *  1 employee working Mondays, with both mappings wired. */
const INITIAL_DRAFT = {
  services: [
    { tmp_id: 's1', name: 'Haircut', duration_minutes: 30, price: 40 },
    { tmp_id: 's2', name: 'Color', duration_minutes: 90, price: 120 },
  ],
  resources: [{ tmp_id: 'r1', name: 'Chair 1', description: 'Window chair' }],
  employees: [{ tmp_id: 'e1', name: 'Tess Stylist', email: 'tess@example.com' }],
  shifts: [{ employee_tmp_id: 'e1', day_of_week: 1, start_time: '09:00', end_time: '17:00' }],
  service_employee: [{ service_tmp_id: 's1', employee_tmp_id: 'e1' }],
  service_resource: [{ service_tmp_id: 's1', resource_tmp_id: 'r1' }],
};

interface LiveGraph {
  services: Array<{ service_id: string; name: string; duration_minutes: number }>;
  resources: Array<{ resource_id: string; name: string }>;
  employees: Array<{ employee_id: string; name: string }>;
  shifts: Array<{ employee_id: string; day_of_week: number; start_time: string; end_time: string }>;
  service_employee: Array<{ service_id: string; employee_id: string }>;
  service_resource: Array<{ service_id: string; resource_id: string }>;
}

/** Commit INITIAL_DRAFT in create mode, then read it back as the wizard would. */
async function seedBusiness(): Promise<LiveGraph> {
  const committed = await post('/setup/commit', INITIAL_DRAFT);
  expect(committed.statusCode).toBe(200);
  const res = await get('/setup/graph');
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** Turn a loaded graph back into the draft the wizard would post: every row keeps
 *  its real uuid as BOTH the graph key and its existing_id. */
function toSyncDraft(g: LiveGraph) {
  return {
    mode: 'sync',
    services: g.services.map((s) => ({
      tmp_id: s.service_id,
      existing_id: s.service_id,
      name: s.name,
      duration_minutes: s.duration_minutes,
    })),
    resources: g.resources.map((r) => ({
      tmp_id: r.resource_id,
      existing_id: r.resource_id,
      name: r.name,
    })),
    employees: g.employees.map((e) => ({
      tmp_id: e.employee_id,
      existing_id: e.employee_id,
      name: e.name,
    })),
    shifts: g.shifts.map((s) => ({
      employee_tmp_id: s.employee_id,
      day_of_week: s.day_of_week,
      start_time: s.start_time,
      end_time: s.end_time,
    })),
    service_employee: g.service_employee.map((m) => ({
      service_tmp_id: m.service_id,
      employee_tmp_id: m.employee_id,
    })),
    service_resource: g.service_resource.map((m) => ({
      service_tmp_id: m.service_id,
      resource_tmp_id: m.resource_id,
    })),
  };
}

const liveServices = (t: string) =>
  setup
    .query('SELECT name FROM services WHERE tenant_id = $1 AND is_deleted = false ORDER BY name', [
      t,
    ])
    .then((r) => r.rows.map((x: { name: string }) => x.name));

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
      // Owner by default — /shifts/expand-weekly is owner-gated
      // (requireOwnerRole, 2026-09-16 role-check audit).
      request.auth = {
        tenant_id: h,
        user_id: '00000000-0000-0000-0000-000000000001',
        email: 'owner@test.local',
        role: 'owner',
      };
    }
  });
  registerSetupRoutes(app, pool, createWithTenantClient(pool));
  // The solo wizard persists its hours through /shifts/expand-weekly rather than
  // the setup graph, so re-running SOLO setup exercises this route too.
  registerShiftRoutes(app, pool, createWithTenantClient(pool));
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
    tenantId = await createTenant(setup, 'Setup Sync Tenant', 'salon', 'Etc/UTC');
    tenantsToClean.push(tenantId);
  }
});

describe('GET /setup/graph — what the wizard preloads', () => {
  it('HAPPY: returns the live graph in draft shape, so a re-run starts from the real business', async () => {
    // WHY: the wizard's draft used to start EMPTY on every open. That is what
    //      made a re-run duplicate rather than edit — there was nothing to edit.
    const g = await seedBusiness();

    expect(g.services.map((s) => s.name).sort()).toEqual(['Color', 'Haircut']);
    // `toContain`, not `toEqual`: the salon business template backfills its own
    // default resource ("Styling Station 1") at tenant-create, so a real tenant
    // is never bare. The graph must surface THAT too — it's a live row, and a
    // sync commit that didn't preload it would prune it.
    expect(g.resources.map((r) => r.name)).toContain('Chair 1');
    expect(g.employees.map((e) => e.name)).toEqual(['Tess Stylist']);
    // The 4-week fan-out collapses back to ONE weekly row (DISTINCT + EXTRACT(DOW)),
    // which is the shape the wizard's Monday-through-Sunday grid speaks.
    expect(g.shifts).toHaveLength(1);
    expect(g.shifts[0]).toMatchObject({ day_of_week: 1, start_time: '09:00', end_time: '17:00' });
    expect(g.service_employee).toHaveLength(1);
    expect(g.service_resource).toHaveLength(1);
  });

  it('HAPPY: a fresh tenant returns empty collections (wizard stays in create mode)', async () => {
    // WHY: hydration only flips the wizard into sync mode when it finds a real
    //      business. An empty graph MUST stay create-mode — a sync commit on an
    //      un-hydrated draft would prune the tenant to nothing.
    const g = get('/setup/graph');
    const body = (await g).json();
    expect(body.services).toEqual([]);
    expect(body.employees).toEqual([]);
  });

  it('SAD: no tenant header → 401 (never leaks a graph anonymously)', async () => {
    const res = await get('/setup/graph', false);
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /setup/commit mode=sync — re-running setup edits in place', () => {
  it('HAPPY: is allowed on an already-set-up tenant (create mode still 409s)', async () => {
    // WHO/WHAT: the exact reported failure — an owner who finished setup once
    //           could never open it again. This is the regression guard.
    const g = await seedBusiness();

    // The old behavior, still intact for create-mode callers: INSERT-only on a
    // populated tenant would duplicate the catalog, so it must keep 409ing.
    const createAgain = await post('/setup/commit', INITIAL_DRAFT);
    expect(createAgain.statusCode).toBe(409);
    expect(createAgain.json().error).toMatch(/already completed/i);

    // Sync mode is the way back in.
    const syncAgain = await post('/setup/commit', toSyncDraft(g));
    expect(syncAgain.statusCode).toBe(200);
    expect(syncAgain.json().success).toBe(true);
  });

  it('HAPPY: an edited row is UPDATEd in place — no duplicate, no second catalog', async () => {
    const g = await seedBusiness();
    const draft = toSyncDraft(g);
    const haircut = draft.services.find((s) => s.name === 'Haircut')!;
    haircut.name = 'Haircut (Deluxe)';
    haircut.duration_minutes = 45;

    const res = await post('/setup/commit', draft);
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.updated).toBeGreaterThan(0);

    // The catalog is still 2 services — the pre-fix INSERT-only path would have
    // left 4 (the original two plus a second copy of each).
    expect(await liveServices(tenantId)).toEqual(['Color', 'Haircut (Deluxe)']);

    // Same row, not a replacement: the uuid is stable across the edit, so every
    // appointment already booked against it still points at the right service.
    const { rows } = await setup.query(
      'SELECT duration_minutes FROM services WHERE service_id = $1',
      [haircut.existing_id]
    );
    expect(rows[0].duration_minutes).toBe(45);
  });

  it('HAPPY: a NEW row added alongside existing ones is INSERTed, not rejected', async () => {
    const g = await seedBusiness();
    const draft = toSyncDraft(g);
    // No existing_id → this is the "add a service while I'm in here" case.
    draft.services.push({
      tmp_id: 'new-1',
      existing_id: undefined,
      name: 'Beard Trim',
      duration_minutes: 15,
    });

    const res = await post('/setup/commit', draft);
    expect(res.statusCode).toBe(200);
    expect(await liveServices(tenantId)).toEqual(['Beard Trim', 'Color', 'Haircut']);
  });

  it('HAPPY: a row the owner REMOVED from the draft is soft-deleted, not hard-deleted', async () => {
    const g = await seedBusiness();
    const draft = toSyncDraft(g);
    const colorId = g.services.find((s) => s.name === 'Color')!.service_id;
    draft.services = draft.services.filter((s) => s.name !== 'Color');
    // Drop the mappings that referenced it, as the wizard's delete-cascade does.
    draft.service_employee = draft.service_employee.filter((m) => m.service_tmp_id !== colorId);
    draft.service_resource = draft.service_resource.filter((m) => m.service_tmp_id !== colorId);

    const res = await post('/setup/commit', draft);
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.pruned).toBe(1);

    expect(await liveServices(tenantId)).toEqual(['Haircut']);
    // Soft, NOT hard: the row survives so any appointment FK pointing at it stays
    // valid and the history remains readable. A DELETE here would break bookings.
    const { rows } = await setup.query(
      'SELECT is_deleted, deleted_at FROM services WHERE service_id = $1',
      [colorId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_deleted).toBe(true);
    expect(rows[0].deleted_at).not.toBeNull();
  });

  it('HAPPY: unchecking an assignment actually removes it (mappings are declarative)', async () => {
    // WHY: the mapping INSERT is ON CONFLICT DO NOTHING — it can only ever ADD.
    //      Without the sync-mode delete-then-reinsert, an assignment the owner
    //      unchecked in the wizard would silently stay wired up.
    const g = await seedBusiness();
    const draft = toSyncDraft(g);
    draft.service_employee = [];

    const res = await post('/setup/commit', draft);
    expect(res.statusCode).toBe(200);

    const { rows } = await setup.query(
      'SELECT count(*)::int AS n FROM service_employee WHERE tenant_id = $1',
      [tenantId]
    );
    expect(rows[0].n).toBe(0);
  });

  it('HAPPY: changing the hours REPLACES the old pattern instead of stacking on it', async () => {
    // WHY: expandWeeklyToSchedule is ON CONFLICT DO NOTHING (idempotent, never
    //      overwrites). Without clearing the employee's future rows first, moving
    //      Monday→Tuesday would leave BOTH days on the schedule and the owner's
    //      edit would look like it did nothing.
    const g = await seedBusiness();
    const draft = toSyncDraft(g);
    draft.shifts = [
      {
        employee_tmp_id: g.employees[0].employee_id,
        day_of_week: 2, // Monday → Tuesday
        start_time: '10:00',
        end_time: '16:00',
      },
    ];

    const res = await post('/setup/commit', draft);
    expect(res.statusCode).toBe(200);

    const reloaded = (await get('/setup/graph')).json();
    expect(reloaded.shifts).toHaveLength(1);
    expect(reloaded.shifts[0]).toMatchObject({
      day_of_week: 2,
      start_time: '10:00',
      end_time: '16:00',
    });
  });

  it("SAD: an existing_id that is not this tenant's → 400, and the business is untouched", async () => {
    // WHY: failing loudly beats silently INSERTing a duplicate of the row the
    //      owner thought they were editing. Also the cross-tenant guard.
    const g = await seedBusiness();
    const draft = toSyncDraft(g);
    draft.services[0].existing_id = '00000000-0000-4000-8000-000000000abc';

    const res = await post('/setup/commit', draft);
    expect(res.statusCode).toBe(400);

    // Rolled back: nothing pruned, nothing renamed.
    expect(await liveServices(tenantId)).toEqual(['Color', 'Haircut']);
  });

  it('SAD: reports how many upcoming appointments the removals would strand', async () => {
    // WHY: the owner is about to retire a service someone is already booked for.
    //      Soft-delete keeps the booking intact, but they deserve to be told.
    const g = await seedBusiness();
    const colorId = g.services.find((s) => s.name === 'Color')!.service_id;

    const { rows: cust } = await setup.query(
      `INSERT INTO customers (tenant_id, name, phone) VALUES ($1, 'Booked Client', '+16305550199')
       RETURNING customer_id`,
      [tenantId]
    );
    // date_trunc('hour') snaps to :00:00 — appointments carry a CHECK constraint
    // requiring 15-minute increments, so a raw NOW()-based timestamp is rejected.
    await setup.query(
      `INSERT INTO appointments
         (tenant_id, customer_id, service_id, resource_id, employee_id,
          start_time, end_time, status, description)
       VALUES ($1, $2, $3, $4, $5,
               date_trunc('hour', NOW()) + interval '3 days',
               date_trunc('hour', NOW()) + interval '3 days 90 minutes',
               'scheduled', 'Color appt')`,
      [
        tenantId,
        cust[0].customer_id,
        colorId,
        g.resources[0].resource_id,
        g.employees[0].employee_id,
      ]
    );

    // Remove the service that client is booked for.
    const draft = toSyncDraft(g);
    draft.services = draft.services.filter((s) => s.existing_id !== colorId);
    draft.service_employee = draft.service_employee.filter((m) => m.service_tmp_id !== colorId);
    draft.service_resource = draft.service_resource.filter((m) => m.service_tmp_id !== colorId);

    const res = await post('/setup/commit', draft);
    expect(res.statusCode).toBe(200);
    expect(res.json().counts.upcoming_appointments_affected).toBe(1);

    // And the booking itself is still there — pruning must never delete history.
    const { rows } = await setup.query(
      `SELECT status FROM appointments WHERE tenant_id = $1 AND service_id = $2`,
      [tenantId, colorId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('scheduled');
  });
});

describe('POST /shifts/expand-weekly — re-answering "when do you work" (solo wizard)', () => {
  /** The owner's hours as the wizard's grid would reload them. */
  const reloadShifts = async () => {
    const g = (await get('/setup/graph')).json();
    return g.shifts.map((s) => s.day_of_week).sort((a, b) => a - b);
  };

  it('HAPPY: replace=true drops a day the owner UNCHECKED on the re-run', async () => {
    // WHO: a solo owner reopening Setup to change which days they work.
    // WHY: expand-weekly is ON CONFLICT DO NOTHING — additive by design, so it
    //      can only ever ADD days. Without replace, unchecking Monday would
    //      leave Monday on the schedule and the owner's edit would silently do
    //      nothing. This is the whole reason the flag exists.
    const g = await seedBusiness(); // Tess works Mondays (day 1)
    const employeeId = g.employees[0].employee_id;
    expect(await reloadShifts()).toEqual([1]);

    // Owner re-answers: not Monday any more — Tuesday and Wednesday instead.
    const res = await post('/shifts/expand-weekly', {
      tenant_id: tenantId,
      employee_id: employeeId,
      pattern: [
        { day_of_week: 2, start_time: '10:00', end_time: '16:00' },
        { day_of_week: 3, start_time: '10:00', end_time: '16:00' },
      ],
      replace: true,
    });
    expect(res.statusCode).toBe(200);

    // Monday is GONE — not merged alongside the new days.
    expect(await reloadShifts()).toEqual([2, 3]);
  });

  it('HAPPY: the default (no replace) stays additive — a failed preload can never erase hours', async () => {
    // WHY: replace is only safe when the grid was PRELOADED from the real
    //      schedule. If that preload fails, the wizard must fall back to the
    //      additive path — adding hours is recoverable, erasing them is not.
    //      Every pre-existing caller relies on this default too.
    const g = await seedBusiness(); // Mondays
    const employeeId = g.employees[0].employee_id;

    const res = await post('/shifts/expand-weekly', {
      tenant_id: tenantId,
      employee_id: employeeId,
      pattern: [{ day_of_week: 4, start_time: '10:00', end_time: '16:00' }],
    });
    expect(res.statusCode).toBe(200);

    // Monday SURVIVES alongside the newly added Thursday.
    expect(await reloadShifts()).toEqual([1, 4]);
  });
});

describe('POST /setup/impact — warn BEFORE destroying, not after', () => {
  /** Book `n` upcoming appointments against the given service. */
  async function bookUpcoming(serviceId: string, g: LiveGraph, n: number) {
    const { rows: cust } = await setup.query(
      `INSERT INTO customers (tenant_id, name, phone) VALUES ($1, 'Booked Client', '+16305550188')
       RETURNING customer_id`,
      [tenantId]
    );
    for (let i = 0; i < n; i++) {
      await setup.query(
        `INSERT INTO appointments
           (tenant_id, customer_id, service_id, resource_id, employee_id,
            start_time, end_time, status, description)
         VALUES ($1, $2, $3, $4, $5,
                 date_trunc('hour', NOW()) + ($6 || ' days')::interval,
                 date_trunc('hour', NOW()) + ($6 || ' days')::interval + interval '30 minutes',
                 'scheduled', 'booked')`,
        [
          tenantId,
          cust[0].customer_id,
          serviceId,
          g.resources[0].resource_id,
          g.employees[0].employee_id,
          String(i + 2),
        ]
      );
    }
  }

  it('HAPPY: names WHAT is being removed and how many bookings each one strands', async () => {
    // WHY: the whole point. A bare "3 appointments affected" doesn't tell an owner
    //      whether they're retiring a dead service or the one their book is on —
    //      so the warning has to name it. And this runs BEFORE the commit, because
    //      a report delivered after the soft-delete is no use to someone deciding
    //      whether to go through with it.
    const g = await seedBusiness();
    const colorId = g.services.find((s) => s.name === 'Color')!.service_id;
    await bookUpcoming(colorId, g, 2);

    const draft = toSyncDraft(g);
    draft.services = draft.services.filter((s) => s.existing_id !== colorId);
    draft.service_employee = draft.service_employee.filter((m) => m.service_tmp_id !== colorId);
    draft.service_resource = draft.service_resource.filter((m) => m.service_tmp_id !== colorId);

    const res = await post('/setup/impact', draft);
    expect(res.statusCode).toBe(200);

    const impact = res.json().impact;
    expect(impact.upcomingAppointments).toBe(2);
    expect(impact.removed).toContainEqual({
      kind: 'service',
      name: 'Color',
      upcomingAppointments: 2,
    });

    // Decisive: /setup/impact is READ-ONLY. Asking what a removal would cost must
    // not perform the removal — otherwise the "cancel" button in the warning would
    // be a lie.
    expect(await liveServices(tenantId)).toEqual(['Color', 'Haircut']);
  });

  it('HAPPY: an unchanged draft reports no impact (the warning must not nag)', async () => {
    const g = await seedBusiness();
    const res = await post('/setup/impact', toSyncDraft(g));

    expect(res.statusCode).toBe(200);
    expect(res.json().impact.upcomingAppointments).toBe(0);
    expect(res.json().impact.removed).toEqual([]);
  });

  it('HAPPY: removing an UNBOOKED service reports nothing — no false alarm', async () => {
    // Removing a service nobody is booked for is unremarkable. If this nagged, the
    // real warning would be trained away.
    const g = await seedBusiness();
    const colorId = g.services.find((s) => s.name === 'Color')!.service_id;

    const draft = toSyncDraft(g);
    draft.services = draft.services.filter((s) => s.existing_id !== colorId);
    draft.service_employee = draft.service_employee.filter((m) => m.service_tmp_id !== colorId);
    draft.service_resource = draft.service_resource.filter((m) => m.service_tmp_id !== colorId);

    const res = await post('/setup/impact', draft);
    expect(res.statusCode).toBe(200);
    expect(res.json().impact.upcomingAppointments).toBe(0);
    expect(res.json().impact.removed).toEqual([]);
  });

  it('SAD: a PAST booking against a removed service is not counted', async () => {
    // History is not at risk — only future bookings can be stranded.
    const g = await seedBusiness();
    const colorId = g.services.find((s) => s.name === 'Color')!.service_id;
    const { rows: cust } = await setup.query(
      `INSERT INTO customers (tenant_id, name, phone) VALUES ($1, 'Old Client', '+16305550177')
       RETURNING customer_id`,
      [tenantId]
    );
    await setup.query(
      `INSERT INTO appointments
         (tenant_id, customer_id, service_id, resource_id, employee_id,
          start_time, end_time, status, description)
       VALUES ($1, $2, $3, $4, $5,
               date_trunc('hour', NOW()) - interval '10 days',
               date_trunc('hour', NOW()) - interval '10 days' + interval '30 minutes',
               'scheduled', 'past')`,
      [
        tenantId,
        cust[0].customer_id,
        colorId,
        g.resources[0].resource_id,
        g.employees[0].employee_id,
      ]
    );

    const draft = toSyncDraft(g);
    draft.services = draft.services.filter((s) => s.existing_id !== colorId);
    draft.service_employee = draft.service_employee.filter((m) => m.service_tmp_id !== colorId);
    draft.service_resource = draft.service_resource.filter((m) => m.service_tmp_id !== colorId);

    const res = await post('/setup/impact', draft);
    expect(res.statusCode).toBe(200);
    expect(res.json().impact.upcomingAppointments).toBe(0);
  });

  it('GUARD: two staff with the SAME NAME produce TWO lines, not one merged line', async () => {
    // REGRESSION (caught by review on PR #240). The impact query GROUPed BY name.
    // Nothing enforces name uniqueness within a tenant — two stylists really can
    // both be "Alex" (the employees duplicate-name guard is a soft 409 that
    // deliberately allows namesakes).
    //
    // NOTE the shape of this test: an earlier cut removed only ONE Alex and was
    // VACUOUS — the WHERE clause filters the kept Alex out BEFORE the GROUP BY, so
    // only one row was left to group and the bug never showed. The merge only
    // misbehaves when BOTH namesakes are removed: grouping by name collapses them
    // into a single "Alex — 2 appointments" line, hiding the fact that TWO
    // separate people are being removed. Group by the PK and you get two lines.
    const g = await seedBusiness();
    const { rows: alexes } = await setup.query(
      `INSERT INTO employees (tenant_id, name, is_active) VALUES ($1,'Alex',true),($1,'Alex',true)
       RETURNING employee_id`,
      [tenantId]
    );
    const { rows: cust } = await setup.query(
      `INSERT INTO customers (tenant_id, name, phone) VALUES ($1,'C','+16305550155') RETURNING customer_id`,
      [tenantId]
    );
    // One booking on EACH Alex.
    for (const [i, row] of alexes.entries()) {
      await setup.query(
        `INSERT INTO appointments
           (tenant_id, customer_id, service_id, resource_id, employee_id,
            start_time, end_time, status, description)
         VALUES ($1,$2,$3,$4,$5,
                 date_trunc('hour', NOW()) + ($6 || ' days')::interval,
                 date_trunc('hour', NOW()) + ($6 || ' days')::interval + interval '30 minutes',
                 'scheduled','x')`,
        [
          tenantId,
          cust[0].customer_id,
          g.services[0].service_id,
          g.resources[0].resource_id,
          (row as { employee_id: string }).employee_id,
          String(i + 2),
        ]
      );
    }

    // Remove BOTH Alexes (the draft simply never mentions them).
    const res = await post('/setup/impact', toSyncDraft(g));
    expect(res.statusCode).toBe(200);

    const alexLines = res
      .json()
      .impact.removed.filter((r: { kind: string; name: string }) => r.name === 'Alex');

    // TWO distinct people, one booking each. Under GROUP BY name this was a single
    // line reading "Alex — 2 appointments", concealing the second person entirely.
    expect(alexLines).toHaveLength(2);
    expect(alexLines.map((r: { upcomingAppointments: number }) => r.upcomingAppointments)).toEqual([
      1, 1,
    ]);
  });

  it('SAD: no tenant header → 401 (never previews another business)', async () => {
    const res = await post('/setup/impact', { services: [] }, false);
    expect(res.statusCode).toBe(401);
  });
});

describe('setup sync — the declared weekly RULE is pruned with the shifts', () => {
  it('an employee whose shifts the owner removed loses their rule too', async () => {
    // WHO: an owner who deleted every shift for a staff member and saved.
    // WHAT: sync-mode prune clears both the future employee_schedule rows AND
    //       employee_schedule_pattern for the edited employees.
    // WHEN: any wizard save that removes an employee's hours entirely.
    // WHERE: src/services/setupGraph.ts, the prune branch.
    // WHY: an employee with NO shifts in the draft never reaches
    //      expandWeeklyToSchedule at all, so nothing else would ever retire
    //      their rule — and the schedule extender would keep projecting the
    //      removed hours forward forever, from a rule nobody can see. That is
    //      the resurrect-what-the-owner-dropped bug arriving through the very
    //      table added to prevent it.
    const g = await seedBusiness();

    // The create-mode commit wrote the rule from INITIAL_DRAFT's Monday shift.
    const before = await setup.query(
      'SELECT day_of_week FROM employee_schedule_pattern WHERE tenant_id = $1',
      [tenantId]
    );
    expect(before.rows).toEqual([{ day_of_week: 1 }]);

    const draft = toSyncDraft(g);
    draft.shifts = [];

    const res = await post('/setup/commit', draft);
    expect(res.statusCode).toBe(200);

    const after = await setup.query(
      'SELECT day_of_week FROM employee_schedule_pattern WHERE tenant_id = $1',
      [tenantId]
    );
    expect(after.rows).toEqual([]);
  });

  it('an employee whose shifts CHANGED keeps a rule, and it is the new one', async () => {
    // WHY: the prune deletes the rule for every edited employee and the fan-out
    //      immediately rewrites it for anyone still carrying shifts. If the
    //      order were wrong, or the rewrite missed, a normal edit would leave
    //      the employee with no rule at all and stop their calendar extending.
    const g = await seedBusiness();
    const draft = toSyncDraft(g);
    draft.shifts = [
      {
        employee_tmp_id: g.employees[0].employee_id,
        day_of_week: 4,
        start_time: '10:00',
        end_time: '14:00',
      },
    ];

    const res = await post('/setup/commit', draft);
    expect(res.statusCode).toBe(200);

    const after = await setup.query(
      `SELECT day_of_week, start_time::text AS start_time, end_time::text AS end_time
         FROM employee_schedule_pattern WHERE tenant_id = $1`,
      [tenantId]
    );
    expect(after.rows).toEqual([{ day_of_week: 4, start_time: '10:00:00', end_time: '14:00:00' }]);
  });
});
