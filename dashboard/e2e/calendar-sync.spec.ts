/**
 * E2E coverage for the calendar + CRM sync orchestration layer.
 *
 * Why this exists: TEST_COVERAGE.md flagged "Calendar sync (Google +
 * Outlook OAuth)" + the CRM bidirectional flows as having zero
 * e2e coverage. The unit tests in src/calendar-sync.test.ts and the
 * src/square-sync.test.ts file mock the provider modules and
 * prove the conversion logic; what was missing is "do the routes
 * actually invoke the orchestrator on every appointment and customer
 * lifecycle event."
 *
 * What's covered:
 *   - POST /appointments/create → 2 sync dispatches (calendar + Square)
 *   - POST /appointments/:id/update → 2 dispatches with action='update'
 *   - DELETE /appointments/:id → 2 dispatches with action='delete'
 *   - POST /customers/create → 1 CRM dispatch (calendars don't get
 *     customer events — that's part of the contract)
 *   - PUT  /customers/:id  → 1 dispatch with action='update'
 *   - DELETE /customers/:id → 1 dispatch with action='delete'
 *   - Fire-and-forget: HTTP response returns within ~3s even with all
 *     provider promises in flight
 *
 * What's NOT covered:
 *   - Whether each provider's actual outbound HTTP request is well-formed
 *     (that's at the unit level — src/calendar-sync.test.ts et al.).
 *   - OAuth refresh + token rotation (token-management.test.ts).
 *
 * Mechanism: the orchestrator records every dispatch into an in-memory
 * buffer when SYNC_TEST_RECORDER=1 is set on the backend at boot. The
 * /agent-tools/_test/sync-events route exposes that buffer for
 * assertion. If the recorder isn't enabled, every test in this file
 * skips with a clear message — so a forgotten env var doesn't silently
 * pass tests that assert nothing.
 *
 * API-only design: this spec uses Playwright's APIRequestContext (no
 * page navigation) so it's not affected by dashboard SSR/hydration
 * flakes that block the page-based specs. Each test creates its own
 * employee_schedule + customer + appointment fixtures and cleans them
 * up in `finally`, per the test-isolation feedback memory.
 */
import { test, expect } from './helpers/test';
import { type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  registerFreshTenant,
  seedBookingScenario,
  cleanTenantData,
  isoDateDaysFromNow,
  BACKEND_URL,
} from './helpers/fixtures';

const PG_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';
const FUTURE_DATE = isoDateDaysFromNow(7);

function readAgentSecret(): string {
  if (process.env.AGENT_SECRET) return process.env.AGENT_SECRET;
  try {
    const envPath = join(__dirname, '..', '..', '.env');
    const content = readFileSync(envPath, 'utf8');
    const match = content.match(/^AGENT_SECRET=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // fall through
  }
  throw new Error('AGENT_SECRET not found — needed to read /agent-tools/_test/sync-events');
}
const AGENT_SECRET = readAgentSecret();

let pool: Pool;
let freshTenant: { tenantId: string; token: string; email: string };
let seededScenario: { employeeIds: string[]; resourceIds: string[]; customerId: string };

function uniqueTag(): string {
  return `e2e-sync-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function uniquePhone(): string {
  return `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
}

type SyncEvent = {
  ts: string;
  provider: string;
  entity: 'appointment' | 'customer';
  action: 'create' | 'update' | 'delete';
  tenantId: string;
  entityId: string;
};

async function getSyncEvents(req: APIRequestContext): Promise<SyncEvent[]> {
  const res = await req.get(`${BACKEND_URL}/agent-tools/_test/sync-events`, {
    headers: { 'x-agent-secret': AGENT_SECRET },
  });
  if (res.status() === 404) throw new Error('SYNC_TEST_RECORDER not enabled');
  const body = await res.json();
  return (body.result?.events ?? []) as SyncEvent[];
}

async function clearSyncEvents(req: APIRequestContext): Promise<void> {
  const res = await req.delete(`${BACKEND_URL}/agent-tools/_test/sync-events`, {
    // No Content-Type: application/json on a body-less DELETE — Fastify's
    // parser otherwise rejects it as Invalid JSON and we can't tell
    // "recorder disabled" from "request never reached the route".
    headers: { 'x-agent-secret': AGENT_SECRET },
  });
  if (res.status() === 404) throw new Error('SYNC_TEST_RECORDER not enabled');
}

async function recorderAvailable(req: APIRequestContext): Promise<boolean> {
  try {
    const res = await req.get(`${BACKEND_URL}/agent-tools/_test/sync-events`, {
      headers: { 'x-agent-secret': AGENT_SECRET },
    });
    return res.status() === 200;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  pool = new Pool({ connectionString: PG_URL });
  // Register a fresh tenant and seed booking scenario so every test in
  // this spec has employees, resources, and shifts to act on — no
  // dependency on any seed data.
  const { request: playwrightRequest } = await import('@playwright/test');
  const ctx = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
  freshTenant = await registerFreshTenant(ctx);
  seededScenario = await seedBookingScenario(ctx, pool, freshTenant.token, freshTenant.tenantId, {
    employees: ['Test Tech'],
    resources: ['Test Bay'],
    shiftDates: [
      FUTURE_DATE,
      ...Array.from({ length: 7 }, (_, i) => {
        const d = new Date(FUTURE_DATE);
        d.setDate(d.getDate() + i + 1);
        return d.toISOString().slice(0, 10);
      }),
    ],
  });
  await ctx.dispose();
});

test.afterAll(async () => {
  await cleanTenantData(pool, freshTenant.tenantId);
  await pool.end();
});

test.beforeEach(async ({ request }, testInfo) => {
  const ok = await recorderAvailable(request);
  if (!ok) {
    testInfo.skip(
      true,
      'SYNC_TEST_RECORDER=1 must be set on the backend before npm start. ' +
        'Run: `SYNC_TEST_RECORDER=1 npm start` then re-run this spec.'
    );
    return;
  }
  // Clear the recorder so each test asserts on a fresh window. Without
  // this the buffer cross-contaminates and a 5-event assertion lands
  // on a 10-event buffer.
  await clearSyncEvents(request);
});

// ────────────────────────────────────────────────────────────────────────────
// Appointment lifecycle dispatch
// ────────────────────────────────────────────────────────────────────────────

test('appointment-create dispatches all sync providers (calendar + Square)', async ({
  request,
}) => {
  // WHO: front-desk creates a normal appointment via the API
  // WHAT: /appointments/create returns 200 + the orchestrator records 5
  //        sync dispatches with action='create' and matching appointmentId
  // WHEN: every successful appointment-create lifecycle event
  // WHERE: src/routes/appointments.ts line 148 calls syncAppointmentToAll
  // WHY: this is the load-bearing promise of the integration story —
  //        when an operator books an appointment, downstream calendars
  //        + CRMs find out. If any future refactor accidentally skips
  //        the dispatch (or only fires it for some routes), the
  //        customer's Google Calendar silently goes stale and they
  //        double-book themselves with another vendor.
  const tag = uniqueTag();
  const apptIdsToCleanup: string[] = [];
  let scheduleSeeded = false;
  let customerId: string | null = null;

  const techId = seededScenario.employeeIds[0];
  const bayId = seededScenario.resourceIds[0];

  try {
    const cIns = await pool.query(
      `INSERT INTO customers (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING customer_id`,
      [freshTenant.tenantId, `${tag}-cust`, uniquePhone()]
    );
    customerId = cIns.rows[0].customer_id;

    await pool.query(
      `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
       VALUES ($1, $2, $3, '09:00', '17:00', false)
       ON CONFLICT (tenant_id, employee_id, shift_date) DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time`,
      [freshTenant.tenantId, techId, FUTURE_DATE]
    );
    scheduleSeeded = true;

    await clearSyncEvents(request); // be defensive before the actual call

    const res = await request.post(`${BACKEND_URL}/appointments/create`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshTenant.token}` },
      data: {
        tenant_id: freshTenant.tenantId,
        resource_id: bayId,
        customer_id: customerId,
        employee_id: techId,
        start_time: `${FUTURE_DATE}T14:00:00.000Z`,
        end_time: `${FUTURE_DATE}T14:30:00.000Z`,
        description: tag,
      },
    });
    const body = await res.json();

    expect(res.status(), 'happy-path appointment-create must succeed').toBe(200);
    expect(body.success).toBe(true);
    const appointmentId = body.appointment_id as string;
    expect(appointmentId, 'route must return appointment_id').toBeTruthy();
    apptIdsToCleanup.push(appointmentId);

    // Fire-and-forget: events may not all land before the route returns.
    // 500ms is plenty for in-process synchronous record() calls.
    await new Promise((r) => setTimeout(r, 500));
    const events = await getSyncEvents(request);
    const matching = events.filter(
      (e) => e.entity === 'appointment' && e.action === 'create' && e.entityId === appointmentId
    );
    expect(matching).toHaveLength(2);
    expect(matching.map((e) => e.provider).sort()).toEqual(['calendar', 'square']);
    for (const e of matching) {
      expect(e.tenantId).toBe(freshTenant.tenantId);
    }
  } finally {
    for (const id of apptIdsToCleanup)
      await pool.query('DELETE FROM appointments WHERE appointment_id = $1', [id]);
    if (scheduleSeeded)
      await pool.query(
        'DELETE FROM employee_schedule WHERE tenant_id = $1 AND employee_id = $2 AND shift_date = $3',
        [freshTenant.tenantId, techId, FUTURE_DATE]
      );
    if (customerId) await pool.query('DELETE FROM customers WHERE customer_id = $1', [customerId]);
  }
});

test('appointment-update dispatches all providers with action=update', async ({ request }) => {
  // WHO: operator drags an appointment to a new time on the scheduler
  // WHAT: POST /appointments/:id/update fires 5 'update' dispatches
  // WHY: route appointments.ts:369 must call syncAppointmentToAll on
  //        successful updates. If skipped, the external calendar shows
  //        the OLD time and the customer arrives at the wrong slot.
  const tag = uniqueTag();
  let apptId: string | null = null;
  let scheduleSeeded = false;
  let customerId: string | null = null;

  const techId = seededScenario.employeeIds[0];
  const bayId = seededScenario.resourceIds[0];

  try {
    const cIns = await pool.query(
      `INSERT INTO customers (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING customer_id`,
      [freshTenant.tenantId, `${tag}-cust`, uniquePhone()]
    );
    customerId = cIns.rows[0].customer_id;

    await pool.query(
      `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
       VALUES ($1, $2, $3, '09:00', '17:00', false)
       ON CONFLICT (tenant_id, employee_id, shift_date) DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time`,
      [freshTenant.tenantId, techId, FUTURE_DATE]
    );
    scheduleSeeded = true;

    // Pre-insert directly so creation doesn't dispatch sync events
    // and pollute the assertion below.
    const aIns = await pool.query(
      `INSERT INTO appointments (tenant_id, resource_id, customer_id, employee_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled') RETURNING appointment_id`,
      [
        freshTenant.tenantId,
        bayId,
        customerId,
        techId,
        `${FUTURE_DATE}T15:00:00.000Z`,
        `${FUTURE_DATE}T15:30:00.000Z`,
        tag,
      ]
    );
    apptId = aIns.rows[0].appointment_id;

    await clearSyncEvents(request);

    const res = await request.post(`${BACKEND_URL}/appointments/${apptId}/update`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshTenant.token}` },
      data: {
        tenant_id: freshTenant.tenantId,
        start_time: `${FUTURE_DATE}T16:00:00.000Z`,
        end_time: `${FUTURE_DATE}T16:30:00.000Z`,
      },
    });
    const body = await res.json();

    expect(res.status(), 'update must succeed').toBe(200);
    expect(body.success).toBe(true);

    await new Promise((r) => setTimeout(r, 500));
    const events = await getSyncEvents(request);
    const matching = events.filter(
      (e) => e.entity === 'appointment' && e.action === 'update' && e.entityId === apptId
    );
    expect(matching).toHaveLength(2);
    expect(matching.map((e) => e.provider).sort()).toEqual(['calendar', 'square']);
  } finally {
    if (apptId) await pool.query('DELETE FROM appointments WHERE appointment_id = $1', [apptId]);
    if (scheduleSeeded)
      await pool.query(
        'DELETE FROM employee_schedule WHERE tenant_id = $1 AND employee_id = $2 AND shift_date = $3',
        [freshTenant.tenantId, techId, FUTURE_DATE]
      );
    if (customerId) await pool.query('DELETE FROM customers WHERE customer_id = $1', [customerId]);
  }
});

test('appointment-delete dispatches all providers with action=delete', async ({ request }) => {
  // WHO: customer cancels and operator hard-deletes the appointment
  // WHAT: DELETE /appointments/:id fires 5 'delete' dispatches so the
  //        external calendar event is removed and CRMs flip their
  //        status mirror to "cancelled"
  // WHY: a stale "scheduled" event in Google Calendar after a cancel
  //        leads to no-shows showing up at a closed bay or worse
  let apptId: string | null = null;
  let scheduleSeeded = false;
  let customerId: string | null = null;
  const tag = uniqueTag();

  const techId = seededScenario.employeeIds[0];
  const bayId = seededScenario.resourceIds[0];

  try {
    const cIns = await pool.query(
      `INSERT INTO customers (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING customer_id`,
      [freshTenant.tenantId, `${tag}-cust`, uniquePhone()]
    );
    customerId = cIns.rows[0].customer_id;

    await pool.query(
      `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
       VALUES ($1, $2, $3, '09:00', '17:00', false)
       ON CONFLICT (tenant_id, employee_id, shift_date) DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time`,
      [freshTenant.tenantId, techId, FUTURE_DATE]
    );
    scheduleSeeded = true;

    const aIns = await pool.query(
      `INSERT INTO appointments (tenant_id, resource_id, customer_id, employee_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled') RETURNING appointment_id`,
      [
        freshTenant.tenantId,
        bayId,
        customerId,
        techId,
        `${FUTURE_DATE}T13:00:00.000Z`,
        `${FUTURE_DATE}T13:30:00.000Z`,
        tag,
      ]
    );
    apptId = aIns.rows[0].appointment_id;

    await clearSyncEvents(request);

    // No body on DELETE — passing Content-Type: application/json with an
    // empty payload trips Fastify's JSON parser ("Invalid JSON" → 500).
    const res = await request.delete(`${BACKEND_URL}/appointments/${apptId}`, {
      headers: { Authorization: `Bearer ${freshTenant.token}` },
    });
    const body = await res.json();
    expect(res.status(), 'delete must succeed').toBe(200);
    expect(body.success).toBe(true);

    await new Promise((r) => setTimeout(r, 500));
    const events = await getSyncEvents(request);
    const matching = events.filter(
      (e) => e.entity === 'appointment' && e.action === 'delete' && e.entityId === apptId
    );
    expect(matching).toHaveLength(2);
    expect(matching.map((e) => e.provider).sort()).toEqual(['calendar', 'square']);
    apptId = null; // already deleted
  } finally {
    if (apptId) await pool.query('DELETE FROM appointments WHERE appointment_id = $1', [apptId]);
    if (scheduleSeeded)
      await pool.query(
        'DELETE FROM employee_schedule WHERE tenant_id = $1 AND employee_id = $2 AND shift_date = $3',
        [freshTenant.tenantId, techId, FUTURE_DATE]
      );
    if (customerId) await pool.query('DELETE FROM customers WHERE customer_id = $1', [customerId]);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Customer lifecycle dispatch — only 4 providers, no calendar
// ────────────────────────────────────────────────────────────────────────────

test('customer-create dispatches to Square (no calendar — by contract)', async ({ request }) => {
  // WHO: operator adds a new walk-in customer via the Customers tab
  // WHAT: /customers/create fires 1 'create' dispatch — Square only.
  //        Calendars are not in the customer dispatch list because they
  //        don't store contacts.
  // WHY: pin the customer-side contract. If a refactor accidentally
  //        adds calendar to syncCustomerToAll, this test fails (count
  //        becomes 2) — would mean we tried to push contacts to Google
  //        Calendar, which has no concept of contact records.
  const tag = uniqueTag();
  let customerId: string | null = null;

  try {
    await clearSyncEvents(request);

    const res = await request.post(`${BACKEND_URL}/customers/create`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshTenant.token}` },
      data: {
        tenant_id: freshTenant.tenantId,
        name: `${tag}-customer`,
        phone: uniquePhone(),
        email: `${tag}@example.test`,
      },
    });
    const body = await res.json();

    expect(res.status(), 'customer-create must succeed').toBe(200);
    expect(body.success).toBe(true);
    customerId = (body.customer as { customer_id: string }).customer_id;

    await new Promise((r) => setTimeout(r, 500));
    const events = await getSyncEvents(request);
    const matching = events.filter(
      (e) => e.entity === 'customer' && e.action === 'create' && e.entityId === customerId
    );
    expect(matching).toHaveLength(1);
    expect(matching.map((e) => e.provider).sort()).toEqual(['square']);
    expect(
      matching.find((e) => e.provider === 'calendar'),
      'calendars must NOT receive customer events'
    ).toBeUndefined();
  } finally {
    if (customerId) await pool.query('DELETE FROM customers WHERE customer_id = $1', [customerId]);
  }
});

test('customer-update + customer-delete each dispatch to Square', async ({ request }) => {
  // WHO: operator updates a customer's name, then later deletes the record
  // WHAT: both lifecycle events fire 1 'update' / 'delete' dispatch
  // WHY: collapse two related assertions into one test to keep the
  //        spec count manageable — the dispatch contract is identical
  //        between update and delete, only the action label differs
  const tag = uniqueTag();
  const phone = uniquePhone();
  let customerId: string | null = null;

  try {
    const cIns = await pool.query(
      `INSERT INTO customers (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING customer_id`,
      [freshTenant.tenantId, `${tag}-cust`, phone]
    );
    customerId = cIns.rows[0].customer_id;

    await clearSyncEvents(request);

    // Update phase. The /customers/:id PUT handler overwrites every
    // column with the body — phone is NOT NULL, so we round-trip the
    // original phone or the constraint trips and the dispatch never
    // happens.
    const up = await request.put(`${BACKEND_URL}/customers/${customerId}`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshTenant.token}` },
      data: { name: `${tag}-renamed`, phone },
    });
    expect(up.status(), 'update must succeed').toBe(200);

    await new Promise((r) => setTimeout(r, 500));
    let events = await getSyncEvents(request);
    let matching = events.filter(
      (e) => e.entity === 'customer' && e.action === 'update' && e.entityId === customerId
    );
    expect(matching).toHaveLength(1);

    // Delete phase — clear and re-assert.
    await clearSyncEvents(request);
    const del = await request.delete(`${BACKEND_URL}/customers/${customerId}`, {
      headers: { Authorization: `Bearer ${freshTenant.token}` },
    });
    expect(del.status(), 'delete must succeed').toBe(200);

    await new Promise((r) => setTimeout(r, 500));
    events = await getSyncEvents(request);
    matching = events.filter(
      (e) => e.entity === 'customer' && e.action === 'delete' && e.entityId === customerId
    );
    expect(matching).toHaveLength(1);
    customerId = null; // already deleted
  } finally {
    if (customerId) await pool.query('DELETE FROM customers WHERE customer_id = $1', [customerId]);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Fire-and-forget contract — HTTP returns fast even with sync running
// ────────────────────────────────────────────────────────────────────────────

test('fire-and-forget: HTTP response does not wait for sync provider work', async ({ request }) => {
  // WHO: any operator booking an appointment under a slow CRM
  // WHAT: /appointments/create returns within 3s even though sync
  //        provider promises are still in flight
  // WHY: the orchestrator IS fire-and-forget by contract. If a future
  //        refactor accidentally awaits the dispatch promises, every
  //        booking call latency would balloon by Σ(provider latency).
  //        For CRMs over WAN that's easily 8-20 seconds — completely
  //        unacceptable for a phone-call use case.
  const tag = uniqueTag();
  const apptIdsToCleanup: string[] = [];
  let scheduleSeeded = false;
  let customerId: string | null = null;

  const techId = seededScenario.employeeIds[0];
  const bayId = seededScenario.resourceIds[0];

  try {
    const cIns = await pool.query(
      `INSERT INTO customers (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING customer_id`,
      [freshTenant.tenantId, `${tag}-cust`, uniquePhone()]
    );
    customerId = cIns.rows[0].customer_id;
    await pool.query(
      `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
       VALUES ($1, $2, $3, '09:00', '17:00', false)
       ON CONFLICT (tenant_id, employee_id, shift_date) DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time`,
      [freshTenant.tenantId, techId, FUTURE_DATE]
    );
    scheduleSeeded = true;

    await clearSyncEvents(request);

    const t0 = Date.now();
    const res = await request.post(`${BACKEND_URL}/appointments/create`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshTenant.token}` },
      data: {
        tenant_id: freshTenant.tenantId,
        resource_id: bayId,
        customer_id: customerId,
        employee_id: techId,
        // 15:00-15:30 UTC — inside the tech's 09:00-17:00 shift whatever the
        // tenant's zone: a freshly registered tenant defaults to UTC (15:00
        // local), and a Chicago one would read it as 10:00 CDT. This was 17:00
        // UTC under a comment assuming CDT; on the real default (UTC) 17:00 IS
        // the shift end, the booking was refused EMPLOYEE_NOT_SCHEDULED, and it
        // went unseen because this spec needs SYNC_TEST_RECORDER, which CI does
        // not set (found 2026-09-11). Clear of the 14:00 UTC appointment-create
        // slot earlier in this file, which is cleaned up anyway.
        start_time: `${FUTURE_DATE}T15:00:00.000Z`,
        end_time: `${FUTURE_DATE}T15:30:00.000Z`,
        description: tag,
      },
    });
    const elapsed = Date.now() - t0;
    const body = await res.json();

    expect(res.status(), 'create must succeed').toBe(200);
    if (body.appointment_id) apptIdsToCleanup.push(body.appointment_id as string);

    // 3000ms is generous given local-only providers. Real prod traffic
    // adding seconds for external HTTPS would trip this immediately if
    // the dispatch ever became blocking.
    expect(elapsed, `HTTP must return in <3s; took ${elapsed}ms`).toBeLessThan(3000);

    // And the orchestrator did fire — proving the speed isn't because
    // the dispatch was skipped. The providers are calendar + square: this said
    // ">= 5" from the era of five sync providers, and went stale when the dormant
    // CRM adapters were deleted (2026-06-12; the provider CHECK narrowed in
    // 20260821020000). It went unseen because this spec needs SYNC_TEST_RECORDER,
    // which CI does not set (found 2026-09-11). Now pinned exactly, the same way
    // the appointment-create test above pins it.
    await new Promise((r) => setTimeout(r, 500));
    const events = await getSyncEvents(request);
    const fired = events.filter(
      (e) =>
        e.entity === 'appointment' && e.action === 'create' && e.entityId === body.appointment_id
    );
    expect(fired.map((e) => e.provider).sort()).toEqual(['calendar', 'square']);
  } finally {
    for (const id of apptIdsToCleanup)
      await pool.query('DELETE FROM appointments WHERE appointment_id = $1', [id]);
    if (scheduleSeeded)
      await pool.query(
        'DELETE FROM employee_schedule WHERE tenant_id = $1 AND employee_id = $2 AND shift_date = $3',
        [freshTenant.tenantId, techId, FUTURE_DATE]
      );
    if (customerId) await pool.query('DELETE FROM customers WHERE customer_id = $1', [customerId]);
  }
});
