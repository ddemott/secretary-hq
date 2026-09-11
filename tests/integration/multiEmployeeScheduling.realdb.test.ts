/**
 * Multi-employee / multi-service scheduling coverage — real DB.
 *
 * Motivation (docs/TODO.md "Verification blind spots" P0): ALL live testing has been one
 * tenant, one employee (Dale), one service. Skill matching, employee
 * assignment, resource conflicts, and the concurrent double-book (GiST)
 * guarantee were unproven against realistic data — a salon with several
 * staff of different skills is exactly the beta-customer shape.
 *
 * Strategy mirrors agentToolsBookingIntegration.test.ts: real pg.Pool on
 * API_DB_URL → registerAgentToolRoutes on a throwaway Fastify app →
 * POST /agent-tools/book-with-scheduling → book_with_scheduling_atomic →
 * assert the appointments rows that actually land. Fixtures created in
 * beforeAll, deleted in afterAll (test-isolation rule). Skips when the
 * test DB is down; hard-fails under REQUIRE_DB_TESTS=1 (CI).
 *
 * Business shape (each outcome attributable to exactly one seeded fact):
 *   services   Haircut 30m [haircut] · Color 60m [color] · Manicure 30m
 *              [nails] · Perm 60m [perm] (NOBODY has perm)
 *   employees  Alice Allskill [haircut,color] 09–17 · Bob Barber [haircut]
 *              09–13 (partial shift, on purpose) · Cara Nails [nails] 09–17
 *              · Dana Nails [nails] 09–17
 *   resources  Chair 1, Chair 2 (no capabilities) · Nail Station
 *              (capabilities [nail_station] — the only one manicures accept)
 *
 * Slot map (every test uses its own window so failures are independent):
 *   09:00 spillover pair · 09:45 third-haircut reject (books its own pair) ·
 *   11:00 manicures · 13:30–14:30 Color skill-match · 15:00 Bob-off-shift
 *   pair · 16:00 GiST race
 *
 * 5W for sad-path failures:
 *   WHO  — the voice agent booking for concurrent live callers
 *   WHAT — book_with_scheduling_atomic's skill/shift/overlap selection
 *   WHEN — same-slot and overlapping-slot requests on a multi-staff day
 *   WHERE — employee_schedule join + skills @> filter + GiST exclusion
 *          (appointments_no_employee_overlap / _no_resource_overlap)
 *   WHY  — a mis-assigned employee (wrong skill / off shift) or a silent
 *          double-book is a no-show or an angry walk-in at a real salon
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { type Client, Pool } from 'pg';
import {
  API_DB_URL,
  getRootClient,
  createTenant,
  createService,
  createEmployee,
  createResource,
  createScheduleEntry,
  assignEmployeeToService,
  assignResourceToService,
  skipIfDbDown,
} from '../utils';
import { createWithTenantClient } from '../../src/database';
import { registerAgentToolRoutes } from '../../src/routes/agentTools';

const AGENT_SECRET = 'test-multi-employee-secret';
const stubEmbedding = (): Promise<number[]> => Promise.resolve(new Array(1536).fill(0));
const stubNormalizer = async (text: string): Promise<string> => text;

const TENANT_TZ = 'America/Chicago';

function tenantLocalDatePlus(days: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TENANT_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));
}

/** Expected UTC instant for a tenant-local wall-clock, computed independently
 *  of applyTimezone (Intl longOffset) so an app tz bug can't cancel out. */
function expectedUtc(dateIso: string, time: string): string {
  const probe = new Date(`${dateIso}T12:00:00Z`);
  const offset = new Intl.DateTimeFormat('en-US', {
    timeZone: TENANT_TZ,
    timeZoneName: 'longOffset',
  })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName')!
    .value.replace('GMT', '');
  return new Date(`${dateIso}T${time}${offset || 'Z'}`).toISOString();
}

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
let tenantId: string;
let aliceId: string;
let bobId: string;
let caraId: string;
let danaId: string;
let nailStationId: string;
let shiftDate: string;
const tenantsToClean: string[] = [];

function post(path: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'x-agent-secret': AGENT_SECRET },
    payload,
  });
}

interface BookOpts {
  service: string;
  from: string;
  to: string;
  phone: string;
  capabilities?: string[];
}

function book(opts: BookOpts) {
  return post('/agent-tools/book-with-scheduling', {
    tenant_id: tenantId,
    phone: opts.phone,
    name: `Caller ${opts.phone.slice(-4)}`,
    requirements: {
      serviceType: opts.service,
      ...(opts.capabilities ? { requiredResourceCapabilities: opts.capabilities } : {}),
    },
    window: { from: opts.from, to: opts.to },
  });
}

async function rowsAtInstant(utcIso: string): Promise<
  Array<{
    employee_id: string | null;
    resource_id: string | null;
    status: string;
  }>
> {
  const res = await setup.query(
    `SELECT employee_id, resource_id, status
       FROM appointments
      WHERE tenant_id = $1 AND start_time = $2 AND status = 'scheduled'`,
    [tenantId, utcIso]
  );
  return res.rows;
}

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 8 });
    process.env.AGENT_SECRET = AGENT_SECRET;

    app = Fastify({ logger: false });
    const withTenantClient = createWithTenantClient(pool);
    registerAgentToolRoutes(app, pool, withTenantClient, stubEmbedding, stubNormalizer);
    await app.ready();

    tenantId = await createTenant(setup, 'Multi-Staff Salon', 'salon', TENANT_TZ);
    tenantsToClean.push(tenantId);

    const haircutId = await createService(setup, tenantId, 'Haircut', 30, 40);
    const colorId = await createService(setup, tenantId, 'Color', 60, 90);
    const manicureId = await createService(setup, tenantId, 'Manicure', 30, 35);
    const permId = await createService(setup, tenantId, 'Perm', 60, 120);
    await setup.query(
      `UPDATE services SET required_skills = ARRAY['haircut'] WHERE service_id = $1`,
      [haircutId]
    );
    await setup.query(
      `UPDATE services SET required_skills = ARRAY['color'] WHERE service_id = $1`,
      [colorId]
    );
    await setup.query(
      `UPDATE services SET required_skills = ARRAY['nails'] WHERE service_id = $1`,
      [manicureId]
    );
    await setup.query(`UPDATE services SET required_skills = ARRAY['perm'] WHERE service_id = $1`, [
      permId,
    ]);

    aliceId = await createEmployee(setup, tenantId, 'Alice Allskill', ['haircut', 'color']);
    bobId = await createEmployee(setup, tenantId, 'Bob Barber', ['haircut']);
    caraId = await createEmployee(setup, tenantId, 'Cara Nails', ['nails']);
    danaId = await createEmployee(setup, tenantId, 'Dana Nails', ['nails']);

    const chair1Id = await createResource(setup, tenantId, 'Chair 1');
    const chair2Id = await createResource(setup, tenantId, 'Chair 2');
    nailStationId = await createResource(setup, tenantId, 'Nail Station');
    await setup.query(
      `UPDATE resources SET capabilities = ARRAY['nail_station'] WHERE resource_id = $1`,
      [nailStationId]
    );

    // THE SKILL MAP (migration 20260909210000). The route passes the resolved
    // service id, and with one the RPC books ONLY linked people in linked rooms —
    // the tags above are no longer consulted. So the same business shape is
    // stated here as links, one-for-one with the tags: Haircut → Alice + Bob in
    // the chairs; Color → Alice in the chairs; Manicure → Cara + Dana at the
    // Nail Station only. Perm stays linked to NOBODY — still NO_SKILLED_EMPLOYEE.
    for (const e of [aliceId, bobId]) await assignEmployeeToService(setup, tenantId, haircutId, e);
    await assignEmployeeToService(setup, tenantId, colorId, aliceId);
    for (const e of [caraId, danaId]) await assignEmployeeToService(setup, tenantId, manicureId, e);
    for (const svc of [haircutId, colorId]) {
      await assignResourceToService(setup, tenantId, svc, chair1Id);
      await assignResourceToService(setup, tenantId, svc, chair2Id);
    }
    await assignResourceToService(setup, tenantId, manicureId, nailStationId);
    await assignResourceToService(setup, tenantId, permId, chair1Id);

    shiftDate = tenantLocalDatePlus(7);
    await createScheduleEntry(setup, tenantId, aliceId, shiftDate, '09:00', '17:00');
    // Bob's shift ENDS at 13:00 — the shift-aware-assignment probe.
    await createScheduleEntry(setup, tenantId, bobId, shiftDate, '09:00', '13:00');
    await createScheduleEntry(setup, tenantId, caraId, shiftDate, '09:00', '17:00');
    await createScheduleEntry(setup, tenantId, danaId, shiftDate, '09:00', '17:00');

    dbAvailable = true;
  } catch (err) {
    console.warn('[multiEmployeeScheduling.realdb.test] DB not available, skipping', err);
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
  delete process.env.AGENT_SECRET;
});

beforeEach((ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
});

describe('skill matching across multiple employees', () => {
  it('HAPPY: Color goes to the ONLY color-skilled employee, never a free unskilled one', async () => {
    // WHY: with Alice + Bob both free, a skills-blind picker would grab Bob
    // ("Bob Barber" < alphabetical tie-breaks don't matter — he lacks color).
    // Live risk: a colorist no-show while the barber stands at the dryer.
    const res = await book({
      service: 'Color',
      from: `${shiftDate}T13:30:00`,
      to: `${shiftDate}T14:30:00`,
      phone: '5553330001',
    });
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.result.employee_name).toBe('Alice Allskill');

    const rows = await rowsAtInstant(expectedUtc(shiftDate, '13:30:00'));
    expect(rows).toHaveLength(1);
    expect(rows[0].employee_id).toBe(aliceId);
  });

  it('SAD: a service whose skill NO employee has → NO_SKILLED_EMPLOYEE, nothing stored', async () => {
    // WHO: a caller asking for a perm at a salon with no perm-certified staff.
    // WHY: the agent needs the specific code to say "we don't offer that"
    // instead of booking an appointment nobody can perform.
    const res = await book({
      service: 'Perm',
      from: `${shiftDate}T10:00:00`,
      to: `${shiftDate}T11:00:00`,
      phone: '5553330002',
    });
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('NO_SKILLED_EMPLOYEE');
    expect(await rowsAtInstant(expectedUtc(shiftDate, '10:00:00'))).toHaveLength(0);
  });
});

describe('employee assignment under contention', () => {
  it('HAPPY: two same-slot Haircuts land on TWO DIFFERENT skilled employees and resources', async () => {
    // WHAT: the spillover path — first booking takes one stylist, the second
    // must take the OTHER (both haircut-skilled, both on shift at 09:00),
    // never double-assign one employee (GiST employee-overlap would fire).
    const first = await book({
      service: 'Haircut',
      from: `${shiftDate}T09:00:00`,
      to: `${shiftDate}T09:30:00`,
      phone: '5553330003',
    });
    const second = await book({
      service: 'Haircut',
      from: `${shiftDate}T09:00:00`,
      to: `${shiftDate}T09:30:00`,
      phone: '5553330004',
    });
    expect(first.json().success).toBe(true);
    expect(second.json().success).toBe(true);

    const rows = await rowsAtInstant(expectedUtc(shiftDate, '09:00:00'));
    expect(rows).toHaveLength(2);
    const employees = rows.map((r) => r.employee_id).sort();
    expect(employees).toEqual([aliceId, bobId].sort());
    const resources = new Set(rows.map((r) => r.resource_id));
    expect(resources.size).toBe(2);
  });

  it('SAD: a third same-slot Haircut → clean TIMESLOT_OCCUPIED, still exactly two rows', async () => {
    // WHERE: both skilled employees occupied at 09:45 — booked INSIDE this
    // test (own slot, self-contained; Copilot review on PR #157 flagged the
    // earlier version's dependence on the spillover test's 09:00 bookings).
    // WHY: the third caller must get a refusal the agent can relay + offer
    // alternatives for — not a 500, not a ghost third booking.
    const occupyAlice = await book({
      service: 'Haircut',
      from: `${shiftDate}T09:45:00`,
      to: `${shiftDate}T10:15:00`,
      phone: '5553330014',
    });
    const occupyBob = await book({
      service: 'Haircut',
      from: `${shiftDate}T09:45:00`,
      to: `${shiftDate}T10:15:00`,
      phone: '5553330015',
    });
    expect(occupyAlice.json().success).toBe(true);
    expect(occupyBob.json().success).toBe(true);

    const third = await book({
      service: 'Haircut',
      from: `${shiftDate}T09:45:00`,
      to: `${shiftDate}T10:15:00`,
      phone: '5553330005',
    });
    const body = third.json();
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('TIMESLOT_OCCUPIED');
    expect(await rowsAtInstant(expectedUtc(shiftDate, '09:45:00'))).toHaveLength(2);
  });

  it('SAD: skilled employee whose shift ENDED is never assigned — 15:00 Haircut pair leaves Bob (09–13) out', async () => {
    // WHAT: shift-aware assignment against realistic data. At 15:00 Bob is
    // haircut-skilled but OFF SHIFT; Alice takes the first booking, and the
    // second must be refused — NOT silently assigned to the absent Bob.
    const first = await book({
      service: 'Haircut',
      from: `${shiftDate}T15:00:00`,
      to: `${shiftDate}T15:30:00`,
      phone: '5553330006',
    });
    const firstBody = first.json();
    expect(firstBody.success).toBe(true);
    expect(firstBody.result.employee_name).toBe('Alice Allskill');

    const second = await book({
      service: 'Haircut',
      from: `${shiftDate}T15:00:00`,
      to: `${shiftDate}T15:30:00`,
      phone: '5553330007',
    });
    const secondBody = second.json();
    expect(secondBody.success).toBe(false);
    expect(secondBody.error_code).toBe('TIMESLOT_OCCUPIED');

    const rows = await rowsAtInstant(expectedUtc(shiftDate, '15:00:00'));
    expect(rows).toHaveLength(1);
    expect(rows[0].employee_id).toBe(aliceId);
    // The absent-employee guard, stated directly:
    expect(rows.some((r) => r.employee_id === bobId)).toBe(false);
  });
});

describe('resource conflicts (capability-gated)', () => {
  it('SAD: two nail techs, ONE nail station → second same-slot Manicure refused, never lands on a chair', async () => {
    // WHAT: resource exhaustion distinct from employee exhaustion — Cara and
    // Dana are BOTH free at 11:00, but manicures require the single
    // nail_station-capable resource. The second booking must fail rather
    // than "succeed" on Chair 1 (a manicure at a barber chair).
    const first = await book({
      service: 'Manicure',
      from: `${shiftDate}T11:00:00`,
      to: `${shiftDate}T11:30:00`,
      phone: '5553330008',
      capabilities: ['nail_station'],
    });
    const firstBody = first.json();
    expect(firstBody.success).toBe(true);

    const second = await book({
      service: 'Manicure',
      from: `${shiftDate}T11:00:00`,
      to: `${shiftDate}T11:30:00`,
      phone: '5553330009',
      capabilities: ['nail_station'],
    });
    const secondBody = second.json();
    expect(secondBody.success).toBe(false);
    expect(secondBody.error_code).toBe('TIMESLOT_OCCUPIED');

    const rows = await rowsAtInstant(expectedUtc(shiftDate, '11:00:00'));
    expect(rows).toHaveLength(1);
    expect(rows[0].resource_id).toBe(nailStationId);
    expect([caraId, danaId]).toContain(rows[0].employee_id);
  });
});

describe('concurrent double-book — the GiST race', () => {
  it('RACE: four PARALLEL same-slot Color requests → exactly one success, losers get TIMESLOT_OCCUPIED, exactly one row', async () => {
    // WHERE: the GiST exclusion constraints are the only defense that holds
    // under READ COMMITTED concurrency — the RPC's pre-checks can all pass
    // simultaneously for racing transactions; the losers must surface as a
    // clean TIMESLOT_OCCUPIED (exclusion_violation handler), not a 500 and
    // not a second stored booking. This is the first test to actually RACE
    // the constraint (everything before ran sequentially).
    const results = await Promise.all(
      ['5553330010', '5553330011', '5553330012', '5553330013'].map((phone) =>
        book({
          service: 'Color',
          from: `${shiftDate}T16:00:00`,
          to: `${shiftDate}T17:00:00`,
          phone,
        })
      )
    );
    const bodies = results.map((r) => r.json());
    const winners = bodies.filter((b) => b.success === true);
    const losers = bodies.filter((b) => b.success === false);
    expect(
      winners,
      `expected exactly 1 winner; outcomes: ${JSON.stringify(bodies.map((b) => b.error_code ?? 'OK'))}`
    ).toHaveLength(1);
    expect(losers).toHaveLength(3);
    for (const l of losers) expect(l.error_code).toBe('TIMESLOT_OCCUPIED');

    const rows = await rowsAtInstant(expectedUtc(shiftDate, '16:00:00'));
    expect(rows).toHaveLength(1);
    expect(rows[0].employee_id).toBe(aliceId);
  });
});
