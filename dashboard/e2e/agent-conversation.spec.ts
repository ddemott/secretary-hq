/**
 * E2E coverage for the voice-agent flow against the real backend.
 *
 * Why this exists: the agent has 78 unit tests + 88 live-QA assertions
 * but no end-to-end coverage of "the conversation actually works." The
 * Voice Calls section in full-functional-audit.spec.ts is a deliberate
 * skip pending Telnyx clear. This spec fills that gap WITHOUT needing
 * Telnyx by simulating the agent's tool-calling sequence directly
 * against the running backend.
 *
 * What's covered:
 *   - Multi-tool conversations (customer-context → scheduling-options
 *     → book) with realistic args and DB-state assertions.
 *   - The tool contracts the LLM relies on: success/failure envelopes,
 *     error_code values, next_available propagation.
 *   - Booking side effects (rows in DB, persisted across failures per
 *     the customer-create-as-separate-transaction guarantee).
 *
 * What's NOT covered (deliberately):
 *   - The LLM's tool-call decisions (non-deterministic; tested only
 *     in live-QA + production observation).
 *   - Audio I/O: STT/TTS plumbing is LiveKit's responsibility.
 *   - The LiveKit session lifecycle (dispatch, room join, track sub).
 *
 * Each test fully self-contained per the test-isolation memory: creates
 * its own employee_schedule + appointment fixtures in `try`, cleans up
 * in `finally`. Independent of other test files; runs in any order.
 *
 * Tenant isolation: beforeAll registers a fresh tenant via registerFreshTenant()
 * and seeds 2 employees + 2 resources + 1 customer + shifts for 14 days
 * via seedBookingScenario(). afterAll calls cleanTenantData() which cascades
 * the DELETE to all dependent rows.
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
  BACKEND_URL,
} from './helpers/fixtures';
import type { RegisteredTenant, SeededBookingScenario } from './helpers/fixtures';

const PG_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';

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
  throw new Error('AGENT_SECRET not found — the harness needs it to call /agent-tools/*');
}
const AGENT_SECRET = readAgentSecret();

let pool: Pool;
let freshTenant: RegisteredTenant;
let seededScenario: SeededBookingScenario;

function uniqueTag(): string {
  return `e2e-conv-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

/**
 * Call an /agent-tools/* route the same way the agent worker does:
 * shared-secret auth, JSON body, parse the success/failure envelope.
 * Mirrors the shape of agent/src/toolsClient.ts so failures here predict
 * runtime behavior.
 */
async function callAgentTool(
  req: APIRequestContext,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await req.post(`${BACKEND_URL}${path}`, {
    data: body,
    headers: { 'Content-Type': 'application/json', 'x-agent-secret': AGENT_SECRET },
  });
  const responseBody = await res.json().catch(() => ({}));
  return { status: res.status(), body: responseBody };
}

test.beforeAll(async () => {
  pool = new Pool({ connectionString: PG_URL });

  // Register a fresh tenant so this spec owns its full data lifecycle and
  // is never coupled to seed state that may change between runs.
  const { request: playwrightRequest } = await import('@playwright/test');
  const ctx = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });

  freshTenant = await registerFreshTenant(ctx);

  // Seed 2 employees, 2 resources, 1 customer, shifts for next 14 days.
  // Employees have no skills (default) — booking tests pass [] skills so
  // the RPC uses MODE B (resource-only) which is the correct path for
  // availability-contract tests. Skill-matching is covered separately.
  const shiftDates = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + i + 1);
    return d.toISOString().slice(0, 10);
  });
  seededScenario = await seedBookingScenario(ctx, pool, freshTenant.token, freshTenant.tenantId, {
    employees: ['Alex Smith', 'Sam Jones'],
    resources: ['Bay 1', 'Bay 2'],
    customer: 'Test Customer',
    shiftDates,
  });

  // Create a service so service-catalog tests have at least one row.
  const svcRes = await ctx.post(`${BACKEND_URL}/services/create`, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${freshTenant.token}`,
    },
    data: {
      tenant_id: freshTenant.tenantId,
      name: 'Tire Rotation',
      duration_minutes: 30,
    },
  });
  expect(svcRes.status(), 'Tire Rotation service create must succeed').toBe(200);

  // THE SKILL MAP (migration 20260909210000). The booking route passes the
  // resolved service id, and with one the RPC books ONLY people and bays the
  // map links to that service — an unlinked service is refused
  // NO_SKILLED_EMPLOYEE. So the shape these tests always assumed ("either tech,
  // either bay") is stated as links: every service here → both techs, both bays.
  await pool.query(
    `INSERT INTO service_employee (service_id, employee_id, tenant_id)
     SELECT s.service_id, e.employee_id, s.tenant_id
       FROM services s CROSS JOIN unnest($2::uuid[]) AS e(employee_id)
      WHERE s.tenant_id = $1
     ON CONFLICT DO NOTHING`,
    [freshTenant.tenantId, seededScenario.employeeIds]
  );
  await pool.query(
    `INSERT INTO service_resource (service_id, resource_id, tenant_id)
     SELECT s.service_id, r.resource_id, s.tenant_id
       FROM services s CROSS JOIN unnest($2::uuid[]) AS r(resource_id)
      WHERE s.tenant_id = $1
     ON CONFLICT DO NOTHING`,
    [freshTenant.tenantId, seededScenario.resourceIds]
  );

  await ctx.dispose();
});

test.afterAll(async () => {
  // Single-statement cascade removes all seeded rows (employees, resources,
  // customers, shifts, appointments, services, the tenant itself).
  await cleanTenantData(pool, freshTenant.tenantId);
  await pool.end();
});

// ────────────────────────────────────────────────────────────────────────────
// 1. Returning caller — get_customer_context returns name + history
// ────────────────────────────────────────────────────────────────────────────
test('conversation: returning caller is greeted by name (customer-context lookup)', async ({
  request,
}) => {
  // WHO: agent picks up a call from a caller whose phone is in the CRM
  // WHAT: /agent-tools/customer-context returns the customer's name and
  //        a brief history string the agent can read back ("Hi Alice...")
  // WHEN: every call where caller-ID is present
  // WHERE: src/routes/agentTools.ts customer-context route
  // WHY: this is the very first tool the agent calls per the system
  //        prompt. If it breaks, every conversation starts cold and
  //        the agent loses the personalization advantage that distinguishes
  //        it from a generic phone tree.
  const tag = uniqueTag();
  const phone = `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
  let customerId: string | null = null;

  try {
    const ins = await pool.query(
      `INSERT INTO customers (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING customer_id`,
      [freshTenant.tenantId, `${tag}-Alice Lee`, phone]
    );
    customerId = ins.rows[0].customer_id;

    const res = await callAgentTool(request, '/agent-tools/customer-context', {
      tenant_id: freshTenant.tenantId,
      phone,
      // Carrier-attested caller-ID — the normal inbound call this test models
      // ("WHEN: every call where caller-ID is present"). The disclosure gate
      // added 2026-07-13 defaults phone_source to the cautious 'spoken' and
      // withholds name/preferences until the caller proves possession by SMS
      // code, so an omitted field here would (correctly) return nothing.
      phone_source: 'caller_id',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Customer-context returns a structured object for known callers:
    //   { name: <customer name>, history: <summaries joined> }
    // Unknown callers get a plain string fallback ("New caller - no
    // history found.") — that shape is exercised in the next test.
    const result = res.body.result as { name?: string; history?: string };
    expect(result.name).toBe(`${tag}-Alice Lee`);
    // history may be 'No history' for our just-inserted customer.
    expect(typeof result.history).toBe('string');
  } finally {
    if (customerId) await pool.query('DELETE FROM customers WHERE customer_id = $1', [customerId]);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Unknown caller — customer-context returns "new caller"
// ────────────────────────────────────────────────────────────────────────────
test('conversation: unknown caller returns "new caller" prompt', async ({ request }) => {
  // WHO: first-time caller; phone has never appeared in the CRM
  // WHAT: customer-context returns a friendly "new caller" string the
  //        agent uses to ask the caller's name explicitly
  // WHY: the agent shouldn't pretend to know someone it doesn't —
  //        otherwise it greets every caller as a known returning
  //        customer, which is creepy and operationally wrong
  const phone = `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
  const res = await callAgentTool(request, '/agent-tools/customer-context', {
    tenant_id: freshTenant.tenantId,
    phone,
    // See the note above — carrier-attested caller-ID, so the gate opens.
    phone_source: 'caller_id',
  });

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  const rawResult: unknown = res.body.result;
  const result = (typeof rawResult === 'string' ? rawResult : '').toLowerCase();
  expect(result).toMatch(/new caller|don't have/i);
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Successful booking via book_with_scheduling
// ────────────────────────────────────────────────────────────────────────────
test('conversation: tire-rotation request books successfully via book_with_scheduling', async ({
  request,
}) => {
  // WHO: caller asks for a tire rotation tomorrow afternoon; agent
  //        bridges that to a specific window, books in one call
  // WHAT: /agent-tools/book-with-scheduling auto-picks a qualified
  //        employee available in the window, books them, returns the
  //        booked details (resource, employee, time).
  //        Skills are passed as [] so the RPC uses MODE B (resource-only
  //        matching) — this test pins availability-contract and booking
  //        side effects, not skill-filtering (covered separately).
  // WHEN: the most common voice booking path — caller doesn't pick a
  //        specific employee, just says "tire rotation, Friday at 2"
  // WHERE: src/routes/agentTools.ts book-with-scheduling +
  //        book_with_scheduling_atomic RPC
  // WHY: this is the load-bearing happy path. If it breaks, every voice
  //        booking falls back to manual operator entry. Pin both the
  //        wire contract AND the side effect (DB row exists with the
  //        right shape).
  const tag = uniqueTag();
  const phone = `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
  const apptIdsToCleanup: string[] = [];
  // Composite key (employee_id, shift_date) — pilot #3 (2026-05-18)
  // dropped the surrogate; cleanup uses the natural key now.
  const shiftsToCleanup: Array<{ employeeId: string; shiftDate: string }> = [];

  try {
    // Set up shifts on a far-future date so the booking has somewhere
    // to land without colliding with existing appointments.
    // Monday, well past the 14-day seeded window. Was '2026-07-13' — it went
    // stale, and once book_with_scheduling_atomic began refusing the past
    // (migration 20260909210000) it came back PAST_TIME. Moved 208 weeks forward:
    // same weekday, same CDT offset, so every UTC time below means the same thing.
    const FUTURE = '2030-07-08';
    const [alexId, samId] = seededScenario.employeeIds;
    for (const empId of [alexId, samId]) {
      await pool.query(
        `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
         VALUES ($1, $2, $3, '09:00', '17:00', false)
         ON CONFLICT (tenant_id, employee_id, shift_date) DO UPDATE
           SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, is_off = false`,
        [freshTenant.tenantId, empId, FUTURE]
      );
      shiftsToCleanup.push({ employeeId: empId, shiftDate: FUTURE });
    }

    const res = await callAgentTool(request, '/agent-tools/book-with-scheduling', {
      tenant_id: freshTenant.tenantId,
      phone,
      name: `${tag}-AgentBookCustomer`,
      description: `${tag}-rotation`,
      window: { from: `${FUTURE}T15:00:00.000Z`, to: `${FUTURE}T16:00:00.000Z` },
      requirements: {
        serviceType: 'rotation',
        // Empty skills → RPC MODE B (resource-only); availability is the
        // only constraint being tested here.
        requiredEmployeeSkills: [],
        requiredResourceCapabilities: [],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const result = res.body.result as Record<string, unknown>;
    expect(result.appointment_id, 'appointment_id present in result').toBeTruthy();
    // RULE CHANGE (migration 20260909210000): MODE B (empty skills) used to pick
    // a resource and leave the employee UNASSIGNED — a booking nobody would
    // attend. An appointment is with somebody now: the RPC names a scheduled,
    // linked tech. This asserted toBeNull() before the rule changed.
    expect(['Alex Smith', 'Sam Jones']).toContain(result.employee_name);
    expect(result.resource_name).toBeTruthy();
    apptIdsToCleanup.push(result.appointment_id as string);

    // Side-effect check: row landed in DB with our tag.
    const row = await pool.query(
      `SELECT description, status FROM appointments WHERE appointment_id = $1`,
      [result.appointment_id]
    );
    expect(row.rows[0].description).toBe(`${tag}-rotation`);
    expect(row.rows[0].status).toBe('scheduled');

    // Customer-create-as-separate-transaction: the customer row exists.
    const cust = await pool.query(
      `SELECT customer_id, name FROM customers WHERE tenant_id = $1 AND phone = $2`,
      [freshTenant.tenantId, phone]
    );
    expect(cust.rowCount).toBe(1);
    expect(cust.rows[0].name).toBe(`${tag}-AgentBookCustomer`);
  } finally {
    for (const id of apptIdsToCleanup)
      await pool.query('DELETE FROM appointments WHERE appointment_id = $1', [id]);
    for (const s of shiftsToCleanup)
      await pool.query(
        'DELETE FROM employee_schedule WHERE tenant_id = $1 AND employee_id = $2 AND shift_date = $3',
        [freshTenant.tenantId, s.employeeId, s.shiftDate]
      );
    await pool.query('DELETE FROM customers WHERE phone = $1', [phone]);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Conflict path — booking returns next_available alternatives
// ────────────────────────────────────────────────────────────────────────────
test('conversation: full-busy slot returns next_available alternatives the agent can propose', async ({
  request,
}) => {
  // WHO: caller wants a rotation at 2pm; every employee is already booked
  //        at that time on the only resource available
  // WHAT: book-with-scheduling fails NO_AVAILABILITY but the response
  //        includes a non-empty next_available array of (start, end,
  //        employee_name, resource_name) so the agent prompt's
  //        next-available section can read them aloud
  // WHEN: peak-hour bookings on small-staff tenants
  // WHERE: book-with-scheduling fallback path → findNextAvailableSlots
  //        helper (slice 1 of 2026-05-08) → response carries through
  //        to the agent (slices 2-3 + prompt update later same day)
  // WHY: pre-fix the agent said "no availability" and the caller had
  //        to guess another time — clunky. Now the agent gets concrete
  //        alternatives. Test pins the full data path because if any
  //        layer drops the array, the feature has zero runtime impact.
  const tag = uniqueTag();
  const phone = `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
  const apptIdsToCleanup: string[] = [];
  // Composite key (employee_id, shift_date) — pilot #3 (2026-05-18)
  // dropped the surrogate; cleanup uses the natural key now.
  const shiftsToCleanup: Array<{ employeeId: string; shiftDate: string }> = [];

  try {
    // Tuesday. Was '2026-07-14', stale → PAST_TIME; 208 weeks forward, same
    // weekday and offset (see the Monday case above).
    const FUTURE = '2030-07-09';
    const [alexId, samId] = seededScenario.employeeIds;
    const [bay1Id, bay2Id] = seededScenario.resourceIds;

    // Shifts for both employees on FUTURE.
    for (const empId of [alexId, samId]) {
      await pool.query(
        `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
         VALUES ($1, $2, $3, '09:00', '17:00', false)
         ON CONFLICT (tenant_id, employee_id, shift_date) DO UPDATE
           SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, is_off = false`,
        [freshTenant.tenantId, empId, FUTURE]
      );
      shiftsToCleanup.push({ employeeId: empId, shiftDate: FUTURE });
    }

    // Pre-book both employees (each on a different resource) at 14:00-14:30
    // UTC so the GiST resource-overlap doesn't reject the pre-INSERTs.
    // Result: every employee unavailable + every resource occupied at the
    // requested time → NO_AVAILABILITY or TIMESLOT_OCCUPIED for the next
    // booking attempt at that slot; alternatives kick in for 14:30+.
    const ph = await pool.query(
      `INSERT INTO customers (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING customer_id`,
      [
        freshTenant.tenantId,
        `${tag}-blocker-customer`,
        `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`,
      ]
    );
    const blockerCust = ph.rows[0].customer_id;

    for (const [empId, resId] of [
      [alexId, bay1Id],
      [samId, bay2Id],
    ] as [string, string][]) {
      const a = await pool.query(
        `INSERT INTO appointments (tenant_id, resource_id, customer_id, employee_id, start_time, end_time, description, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled')
         RETURNING appointment_id`,
        [
          freshTenant.tenantId,
          resId,
          blockerCust,
          empId,
          `${FUTURE}T14:00:00.000Z`,
          `${FUTURE}T14:30:00.000Z`,
          `${tag}-blocker`,
        ]
      );
      apptIdsToCleanup.push(a.rows[0].appointment_id);
    }

    // Now try to book — should fail, with alternatives.
    const res = await callAgentTool(request, '/agent-tools/book-with-scheduling', {
      tenant_id: freshTenant.tenantId,
      phone,
      name: `${tag}-second-customer`,
      description: `${tag}-tries-busy-slot`,
      window: { from: `${FUTURE}T14:00:00.000Z`, to: `${FUTURE}T14:30:00.000Z` },
      requirements: {
        serviceType: 'rotation',
        // Empty skills → RPC MODE B (resource-only); both employees are
        // busy at this slot regardless of skills.
        requiredEmployeeSkills: [],
        requiredResourceCapabilities: [],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    // Either NO_AVAILABILITY or TIMESLOT_OCCUPIED is correct here — both
    // describe the same situation (every employee + every resource is busy
    // at the requested slot) and both go through the same route response
    // shape that populates `next_available`. The RPC's check order returns
    // TIMESLOT_OCCUPIED first when the resource/employee overlap predicate
    // trips before the availability fallback. The agent prompt handles both
    // codes identically — it reads next_available and reads it aloud either
    // way. The test's real concern is the alternatives payload, asserted below.
    expect(['NO_AVAILABILITY', 'TIMESLOT_OCCUPIED']).toContain(res.body.error_code);
    // The critical assertion: alternatives propagated through the route.
    const alternatives = res.body.next_available as Array<Record<string, unknown>> | undefined;
    expect(alternatives, 'next_available must be present even on failure').toBeDefined();
    expect(
      alternatives!.length,
      'at least one alternative since employees are free at 14:30+'
    ).toBeGreaterThan(0);
    // Each alternative has the fields the agent prompt reads from.
    for (const alt of alternatives!.slice(0, 3)) {
      expect(alt.start_time).toBeTruthy();
      expect(alt.end_time).toBeTruthy();
      expect(alt.employee_name).toBeTruthy();
      expect(alt.resource_name).toBeTruthy();
    }

    // Side-effect check: NO new booking created for our tag (booking failed).
    const created = await pool.query(
      `SELECT count(*)::int AS n FROM appointments WHERE description = $1`,
      [`${tag}-tries-busy-slot`]
    );
    expect(created.rows[0].n).toBe(0);

    // But customer-create-as-separate-transaction — second customer persists.
    const cust = await pool.query(
      `SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1 AND phone = $2`,
      [freshTenant.tenantId, phone]
    );
    expect(cust.rows[0].n, 'customer persists despite booking failure').toBe(1);

    // Cleanup the blocker customer too.
    await pool.query('DELETE FROM customers WHERE customer_id = $1', [blockerCust]);
  } finally {
    for (const id of apptIdsToCleanup)
      await pool.query('DELETE FROM appointments WHERE appointment_id = $1', [id]);
    for (const s of shiftsToCleanup)
      await pool.query(
        'DELETE FROM employee_schedule WHERE tenant_id = $1 AND employee_id = $2 AND shift_date = $3',
        [freshTenant.tenantId, s.employeeId, s.shiftDate]
      );
    await pool.query('DELETE FROM customers WHERE phone = $1', [phone]);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Service catalog — agent gets the list it needs to discuss services
// ────────────────────────────────────────────────────────────────────────────
test("conversation: service-catalog returns the tenant's services for the LLM to discuss", async ({
  request,
}) => {
  // WHO: caller asks "what do you offer?" — agent calls service-catalog
  //        and reads the list (or summarizes for length)
  // WHAT: returns service name + duration + price for every active
  //        service in the tenant
  // WHEN: any "what services do you have" question, AND any time the
  //        agent needs a serviceType to pass to scheduling tools
  // WHERE: src/routes/agentTools.ts service-catalog
  // WHY: pin the contract — if the route ever drops `duration_minutes`
  //        or `price`, the agent can't correctly quote callers and
  //        scheduling tools break (they need duration to compute end).
  //        The 'Tire Rotation' service was created in beforeAll.
  const res = await callAgentTool(request, '/agent-tools/service-catalog', {
    tenant_id: freshTenant.tenantId,
  });

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  // Service-catalog returns { services: [...] } — keyed under `services`,
  // not the array directly. The agent's tool wrapper passes this through
  // to the LLM as JSON.
  const wrapped = res.body.result as { services: Array<Record<string, unknown>> };
  expect(Array.isArray(wrapped.services)).toBe(true);
  expect(
    wrapped.services.length,
    'at least the Tire Rotation service seeded in beforeAll'
  ).toBeGreaterThan(0);
  // Pin the service we seeded and the contract shape.
  const rotation = wrapped.services.find((s) =>
    String(s.name).toLowerCase().includes('tire rotation')
  );
  expect(rotation, "'Tire Rotation' service present in catalog").toBeTruthy();
  expect(typeof rotation!.duration_minutes).toBe('number');
});

// ────────────────────────────────────────────────────────────────────────────
// 7. Customer preferences — save on one call, recall on the next
// ────────────────────────────────────────────────────────────────────────────
test('conversation: a saved preference is recalled by customer-context on the next call', async ({
  request,
}) => {
  // WHO: a returning caller the AI is told to remember things about.
  // WHAT: save_customer_preference writes a durable fact to the
  //        customer_preferences table (one row per customer+key — it was a jsonb
  //        blob on customers.metadata until 2026-07-12); on a later call the
  //        agent's get_customer_context tool (→ /agent-tools/customer-context)
  //        hands that preference back so the LLM can personalize + upsell.
  // WHEN: every returning caller once the tenant enabled preference capture.
  // WHERE: /agent-tools/save-customer-preference (write) +
  //        /agent-tools/customer-context (recall) — the SAME route the agent
  //        actually calls, not the dashboard's get_customer_context_for_call.
  // WHY: this is the load-bearing round-trip of the feature. The recall path
  //        is the one that historically dropped preferences (returned only
  //        {name, history}); pin both the wire contract AND the DB side effect
  //        so a regression in either layer fails loudly here.
  const tag = uniqueTag();
  const phone = `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
  let customerId: string | null = null;

  try {
    const ins = await pool.query(
      `INSERT INTO customers (tenant_id, name, phone) VALUES ($1, $2, $3) RETURNING customer_id`,
      [freshTenant.tenantId, `${tag}-Sarah`, phone]
    );
    customerId = ins.rows[0].customer_id;

    // Call 1: the agent saves two durable facts.
    const save1 = await callAgentTool(request, '/agent-tools/save-customer-preference', {
      tenant_id: freshTenant.tenantId,
      phone,
      key: 'Preferred Stylist', // human label → slugified to preferred_stylist
      value: 'Maria',
    });
    expect(save1.status).toBe(200);
    expect(save1.body.success).toBe(true);
    expect((save1.body.result as { saved: boolean; key: string }).saved).toBe(true);
    expect((save1.body.result as { key: string }).key).toBe('preferred_stylist');

    await callAgentTool(request, '/agent-tools/save-customer-preference', {
      tenant_id: freshTenant.tenantId,
      phone,
      key: 'last_service',
      value: 'balayage',
    });

    // Side-effect check: both preferences landed as their own rows, keyed by
    // (customer_id, pref_key). Aggregated back to an object here so the
    // assertion still reads as "what the agent will see".
    const row = await pool.query(
      `SELECT jsonb_object_agg(pref_key, pref_value) AS prefs
         FROM customer_preferences WHERE customer_id = $1`,
      [customerId]
    );
    expect(row.rows[0].prefs).toEqual({ preferred_stylist: 'Maria', last_service: 'balayage' });

    // Call 2 (next week): customer-context hands the agent the preferences.
    const ctx = await callAgentTool(request, '/agent-tools/customer-context', {
      tenant_id: freshTenant.tenantId,
      phone,
      // Carrier-attested caller-ID — the normal inbound call this test models
      // ("WHEN: every call where caller-ID is present"). The disclosure gate
      // added 2026-07-13 defaults phone_source to the cautious 'spoken' and
      // withholds name/preferences until the caller proves possession by SMS
      // code, so an omitted field here would (correctly) return nothing.
      phone_source: 'caller_id',
    });
    expect(ctx.status).toBe(200);
    expect(ctx.body.success).toBe(true);
    const result = ctx.body.result as { name: string; preferences: Record<string, unknown> };
    expect(result.name).toBe(`${tag}-Sarah`);
    expect(result.preferences).toEqual({ preferred_stylist: 'Maria', last_service: 'balayage' });

    // Unknown caller: save is a graceful no-op (saved:false), never an error.
    const miss = await callAgentTool(request, '/agent-tools/save-customer-preference', {
      tenant_id: freshTenant.tenantId,
      phone: `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`,
      key: 'preferred_stylist',
      value: 'Maria',
    });
    expect(miss.status).toBe(200);
    expect(miss.body.success).toBe(true);
    expect((miss.body.result as { saved: boolean }).saved).toBe(false);
  } finally {
    if (customerId) await pool.query('DELETE FROM customers WHERE customer_id = $1', [customerId]);
    await pool.query('DELETE FROM customers WHERE phone = $1', [phone]);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 6. OTP — anonymous-caller flow end-to-end
// ────────────────────────────────────────────────────────────────────────────
test('conversation: anonymous caller verifies via OTP before booking', async ({ request }) => {
  // WHO: caller with blocked caller-ID — agent must collect + verify a
  //        phone before any booking tool will accept the request
  // WHAT: send_verification_code seeds a hashed code in
  //        phone_verifications; verify_phone_code accepts the unhashed
  //        match and stamps verified_at
  // WHEN: every anonymous-call booking attempt
  // WHERE: src/routes/agentTools.ts send-verification-code +
  //        verify-phone-code
  // WHY: the OTP gate is on the booking-precondition path. If it breaks,
  //        every anonymous voice booking fails with "I'll need a phone
  //        number first" no matter what the caller does next.
  //
  // Note: we exercise the verify path with a known bcrypt-hashed code
  // we INSERT directly. The send path actually dispatches an SMS via
  // Telnyx, which costs money + risks a real number receiving a real
  // text. That's covered by auth-flows.spec.ts otp-verify; here we
  // focus on the agent-side wire contract for the verify response.
  const tag = uniqueTag();
  const phone = `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
  // 4-digit code (2026-07-13 — shortened from 6; it is read back ALOUD mid-call).
  const knownCode = '6543';
  let pvId: string | null = null;

  try {
    const bcrypt = await import('bcrypt');
    const codeHash = await bcrypt.hash(knownCode, 10);
    const ins = await pool.query(
      `INSERT INTO phone_verifications (tenant_id, phone, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '10 minutes')
       RETURNING phone_verification_id`,
      [freshTenant.tenantId, phone, codeHash]
    );
    pvId = ins.rows[0].phone_verification_id;

    // Wrong code — agent reads the failure message verbatim.
    const wrong = await callAgentTool(request, '/agent-tools/verify-phone-code', {
      tenant_id: freshTenant.tenantId,
      phone,
      code: '0000',
    });
    expect(wrong.status).toBe(200);
    expect(wrong.body.success).toBe(false);

    // Correct code — agent proceeds with booking.
    const right = await callAgentTool(request, '/agent-tools/verify-phone-code', {
      tenant_id: freshTenant.tenantId,
      phone,
      code: knownCode,
    });
    expect(right.status).toBe(200);
    expect(right.body.success).toBe(true);

    const after = await pool.query(
      `SELECT verified_at FROM phone_verifications WHERE phone_verification_id = $1`,
      [pvId]
    );
    expect(after.rows[0].verified_at).not.toBeNull();
    void tag;
  } finally {
    if (pvId)
      await pool.query('DELETE FROM phone_verifications WHERE phone_verification_id = $1', [pvId]);
    await pool.query(`DELETE FROM phone_verifications WHERE tenant_id = $1 AND phone = $2`, [
      freshTenant.tenantId,
      phone,
    ]);
  }
});
