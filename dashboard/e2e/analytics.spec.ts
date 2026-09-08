/**
 * E2E: the Analytics view (gap #2) + full analytics API contract.
 *
 * WHY THIS EXISTS
 * gap #2 replaced three hardcoded "Phase 2 / Requires call log integration"
 * stub panels in AnalyticsView with REAL data wired to /analytics/calls
 * (Call Volume, Booking Conversion, Caller Abandonment + a WHY outcome
 * breakdown). The backend route + the React component have unit coverage, but
 * nothing proved the tab loads in a browser, mounts, renders real call data,
 * and no longer shows the stub text. This is that proof — and the
 * error-boundary watchdog in helpers/test fails the test if the view throws.
 *
 * APPROACH
 * The seeded admin tenant has no calls, so AnalyticsView would show its global
 * "No data yet" empty state (no panels). To exercise the REAL panels we seed a
 * couple of voice_sessions via /agent-tools/voice-session-start for the admin
 * tenant (the same agent-secret pattern as auth-flows / calendar-sync specs),
 * then assert the call panels render. Cleaned up after.
 *
 * Navigation: Analytics is the "Analytics" sub-tab (role="tab") inside
 * "Phone Assistant" (main tab id `ai-insights`). Tests run pre-authenticated as
 * the platform admin (tenant 0000…0000) via storageState.
 *
 * API contract tests (2-7) use registerFreshTenant so each test owns its data
 * and does not depend on the admin-tenant state seeded in beforeAll.
 */
import { test, expect } from './helpers/test';
import { Client, Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import https from 'https';
import {
  BACKEND_URL,
  PG_URL,
  registerFreshTenant,
  cleanTenantData,
  isoDateDaysFromNow,
  type RegisteredTenant,
} from './helpers/fixtures';

const ADMIN_TENANT = '00000000-0000-0000-0000-000000000000';

function readAgentSecret(): string {
  if (process.env.AGENT_SECRET) return process.env.AGENT_SECRET;
  try {
    const content = readFileSync(join(__dirname, '../../.env'), 'utf8');
    const match = content.match(/^AGENT_SECRET=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    /* fall through */
  }
  throw new Error('AGENT_SECRET not found in .env or process.env — needed to seed calls');
}

const AGENT_SECRET = readAgentSecret();
// Unique call ids so we only clean up what we created.
const CALL_IDS = [`e2e-analytics-${Date.now()}-a`, `e2e-analytics-${Date.now()}-b`];

let pool: Pool;

// TLS-skipping agent for self-signed local backend
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

async function agentFetch(path: string, body: Record<string, unknown>): Promise<void> {
  await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'x-agent-secret': AGENT_SECRET, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // @ts-expect-error node fetch accepts agent
    agent: tlsAgent,
  });
}

test.beforeAll(async () => {
  pool = new Pool({ connectionString: PG_URL });
  // Seed two logged calls for the admin tenant so the call panels have data.
  for (const callId of CALL_IDS) {
    await agentFetch('/agent-tools/voice-session-start', {
      tenant_id: ADMIN_TENANT,
      call_id: callId,
      caller_phone: '+16305550000',
    });
  }
  // End one with a rich WHY outcome so the "Why Callers Reached Out" panel
  // has a real category to render.
  await agentFetch('/agent-tools/voice-session-end', {
    tenant_id: ADMIN_TENANT,
    call_id: CALL_IDS[0],
    duration_seconds: 30,
    outcome: 'no_availability',
    transcript: 'Caller: do you have Saturday? Agent: sorry, we are closed weekends.',
  });
});

test.afterAll(async () => {
  // Remove only the rows we created (the E2E DB is ephemeral, but be tidy).
  const c = new Client({ connectionString: PG_URL });
  await c.connect();
  await c.query('DELETE FROM voice_sessions WHERE tenant_id = $1 AND call_id = ANY($2)', [
    ADMIN_TENANT,
    CALL_IDS,
  ]);
  await c.end();
  await pool.end();
});

// ────────────────────────────────────────────────────────────────────────────
// 1. UI: Analytics tab renders real panels (no stubs)
// ────────────────────────────────────────────────────────────────────────────
test.describe('Analytics view (gap #2)', () => {
  test('renders the real call panels and no longer shows the Phase-2 stubs', async ({ page }) => {
    // Analytics is a sub-tab of the Calls tab (moved from Phone Assistant 2026-06-14)
    await page.goto('/dashboard?tab=calls');

    // The Analytics FolderTab renders with role="tab" inside the Calls sections tablist
    const analyticsTab = page.getByRole('tab', { name: 'Analytics' }).first();
    await expect(analyticsTab).toBeVisible({ timeout: 15000 });
    await analyticsTab.click();

    // The view mounted (header renders — not the global empty state, since we
    // seeded calls; and not the error boundary, which helpers/test also guards).
    await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible({ timeout: 15000 });

    // The real call panels render.
    await expect(page.getByText('Call Volume')).toBeVisible();
    await expect(page.getByText('Booking Conversion')).toBeVisible();
    await expect(page.getByText('Caller Abandonment')).toBeVisible();
    await expect(page.getByText('Why Callers Reached Out')).toBeVisible();

    // The WHY panel shows the agent's classified outcome as a friendly label
    // (we seeded a 'no_availability' call → "Wanted a time we couldn't offer").
    await expect(page.getByText("Wanted a time we couldn't offer")).toBeVisible();

    // The retired stub phrasing must be gone — its presence = a regression to
    // the pre-gap-#2 placeholders.
    await expect(page.getByText('Requires call log integration')).toHaveCount(0);
    await expect(page.getByText('Coming in Phase 2')).toHaveCount(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. GET /analytics/stats — shape + counts reflect seeded entities
// ────────────────────────────────────────────────────────────────────────────
test('analytics-stats-api: GET /analytics/stats returns typed shape with counts', async ({
  request,
}) => {
  // WHO: dashboard Home tab on mount (fetches to populate the summary cards)
  // WHAT: seed 1 call + 1 customer for a fresh tenant; GET /analytics/stats
  //       must return { calls, appointments, customers, recent_activity }
  //       with numeric fields and the seeded entities reflected
  // WHEN: every dashboard Home load for any tenant
  // WHERE: src/routes/analytics.ts GET /analytics/stats
  // WHY: Home tab stats cards are the first thing an owner sees; a broken
  //      shape (null counts, missing key) renders an empty or errored card
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);
    const hdr = { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant.token}` };

    // Create a customer so customers.total > 0
    await request.post(`${BACKEND_URL}/customers/create`, {
      headers: hdr,
      data: { tenant_id: tenant.tenantId, name: 'Stats Test Customer', phone: '+15550100001' },
    });

    // Seed a voice session so calls.total > 0
    const agentHdr = { 'x-agent-secret': AGENT_SECRET, 'content-type': 'application/json' };
    const callId = `e2e-stats-${Date.now()}`;
    await request.post(`${BACKEND_URL}/agent-tools/voice-session-start`, {
      headers: agentHdr,
      data: { tenant_id: tenant.tenantId, call_id: callId, caller_phone: '+15550100001' },
    });

    const res = await request.get(`${BACKEND_URL}/analytics/stats?tenant_id=${tenant.tenantId}`, {
      headers: hdr,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();

    // Shape contract
    expect(typeof body.calls.total).toBe('number');
    expect(typeof body.calls.today).toBe('number');
    expect(typeof body.calls.week).toBe('number');
    expect(typeof body.appointments.total).toBe('number');
    expect(typeof body.appointments.upcoming).toBe('number');
    expect(typeof body.customers.total).toBe('number');
    expect(typeof body.customers.new_this_week).toBe('number');
    expect(Array.isArray(body.recent_activity)).toBe(true);

    // Seeded entities reflected
    expect(body.calls.total).toBeGreaterThanOrEqual(1);
    expect(body.customers.total).toBeGreaterThanOrEqual(1);
    expect(body.customers.new_this_week).toBeGreaterThanOrEqual(1);
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 3. GET /analytics/calls — outcome breakdown + totals shape
// ────────────────────────────────────────────────────────────────────────────
test('analytics-calls-api: GET /analytics/calls returns totals + by_outcome + by_day', async ({
  request,
}) => {
  // WHO: Analytics tab on mount (fetches for the WHY + Volume + Conversion panels)
  // WHAT: seed 2 calls — one booked (appointment_id set), one abandoned;
  //       GET /analytics/calls returns totals.total=2, by_outcome contains both
  //       outcomes, by_day is an array
  // WHEN: every Analytics tab load
  // WHERE: src/routes/analytics.ts GET /analytics/calls
  // WHY: if by_outcome is empty or totals are wrong, the conversion rate shown
  //      to the owner will be 0% or NaN even when calls exist
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);
    const agentHdr = { 'x-agent-secret': AGENT_SECRET, 'content-type': 'application/json' };

    // Two calls: one with outcome, one abandoned (no end event = no_outcome)
    const callA = `e2e-calls-a-${Date.now()}`;
    const callB = `e2e-calls-b-${Date.now()}`;
    await request.post(`${BACKEND_URL}/agent-tools/voice-session-start`, {
      headers: agentHdr,
      data: { tenant_id: tenant.tenantId, call_id: callA, caller_phone: '+15550200001' },
    });
    await request.post(`${BACKEND_URL}/agent-tools/voice-session-end`, {
      headers: agentHdr,
      data: {
        tenant_id: tenant.tenantId,
        call_id: callA,
        duration_seconds: 45,
        outcome: 'booked',
      },
    });
    await request.post(`${BACKEND_URL}/agent-tools/voice-session-start`, {
      headers: agentHdr,
      data: { tenant_id: tenant.tenantId, call_id: callB, caller_phone: '+15550200002' },
    });
    // callB intentionally NOT ended → outcome = NULL → collapses to 'no_outcome'

    const hdr = { Authorization: `Bearer ${tenant.token}` };
    const res = await request.get(`${BACKEND_URL}/analytics/calls?tenant_id=${tenant.tenantId}`, {
      headers: hdr,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();

    // Shape contract
    expect(typeof body.totals.total).toBe('number');
    expect(typeof body.totals.booked).toBe('number');
    expect(typeof body.totals.abandoned).toBe('number');
    expect(Array.isArray(body.by_outcome)).toBe(true);
    expect(Array.isArray(body.by_day)).toBe(true);

    // Data contract: 2 calls seeded → total ≥ 2
    expect(body.totals.total).toBeGreaterThanOrEqual(2);

    // 'booked' outcome row must exist in by_outcome
    const bookedRow = body.by_outcome.find((r: { outcome: string }) => r.outcome === 'booked');
    expect(bookedRow, '"booked" outcome row must appear in by_outcome').toBeTruthy();
    expect(bookedRow.count).toBeGreaterThanOrEqual(1);

    // by_day entries have the expected shape
    if (body.by_day.length > 0) {
      const day = body.by_day[0];
      expect(day.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof day.total).toBe('number');
      expect(typeof day.booked).toBe('number');
    }
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 4. GET /call-summaries — returns summaries for a specific customer
// ────────────────────────────────────────────────────────────────────────────
test('call-summaries-api: GET /call-summaries returns rows scoped to customer_id', async ({
  request,
}) => {
  // WHO: CRM customer detail panel — loads call history for a selected customer
  // WHAT: insert a call_summary row directly; GET /call-summaries?customer_id=X
  //       returns it; another customer's summary is NOT returned (isolation)
  // WHEN: operator clicks a customer in the Customers tab to view their history
  // WHERE: src/routes/analytics.ts GET /call-summaries
  // WHY: call summaries are the post-call AI digest visible in the customer
  //      history panel; if the route returns wrong-customer rows the operator
  //      sees another caller's private conversation context
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);
    const hdr = { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant.token}` };

    // Create two customers
    const custARes = await request.post(`${BACKEND_URL}/customers/create`, {
      headers: hdr,
      data: { tenant_id: tenant.tenantId, name: 'Summary Customer A', phone: '+15550300001' },
    });
    const custBRes = await request.post(`${BACKEND_URL}/customers/create`, {
      headers: hdr,
      data: { tenant_id: tenant.tenantId, name: 'Summary Customer B', phone: '+15550300002' },
    });
    const customerAId = (await custARes.json()).customer.customer_id;
    const customerBId = (await custBRes.json()).customer.customer_id;

    // Insert a summary for customer A and one for customer B
    const callIdA = `e2e-summary-a-${Date.now()}`;
    const callIdB = `e2e-summary-b-${Date.now()}`;
    await pool.query(
      `INSERT INTO call_summaries (tenant_id, customer_id, call_id, summary)
       VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)`,
      [
        tenant.tenantId,
        customerAId,
        callIdA,
        'Customer A called about tire rotation pricing.',
        customerBId,
        callIdB,
        'Customer B asked about appointment availability.',
      ]
    );

    // GET for customer A must return only their row
    const res = await request.get(
      `${BACKEND_URL}/call-summaries?tenant_id=${tenant.tenantId}&customer_id=${customerAId}`,
      { headers: hdr }
    );
    expect(res.status()).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const found = rows.find((r: { call_id: string }) => r.call_id === callIdA);
    expect(found, 'customer A summary must appear').toBeTruthy();
    expect(found.summary).toContain('tire rotation pricing');

    // Customer B's summary must NOT appear in customer A's list
    const leaked = rows.find((r: { call_id: string }) => r.call_id === callIdB);
    expect(leaked, 'customer B summary must NOT appear in customer A list').toBeUndefined();
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 5. GET /call-summaries sad — missing customer_id → 400
// ────────────────────────────────────────────────────────────────────────────
test('call-summaries-sad-missing-id: GET /call-summaries without customer_id returns 400', async ({
  request,
}) => {
  // WHO: misconfigured API call (or a dashboard component that lost its props)
  // WHAT: omitting customer_id must return 400, not a full table scan
  // WHEN: any call to /call-summaries without the required filter param
  // WHERE: src/routes/analytics.ts early guard: if (!customerId) → 400
  // WHY: without the guard, the query would return ALL summaries for the tenant
  //      (or fail with a null FK error) — either is a data-exposure or crash risk
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);
    const res = await request.get(`${BACKEND_URL}/call-summaries?tenant_id=${tenant.tenantId}`, {
      headers: { Authorization: `Bearer ${tenant.token}` },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/customer_id/i);
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 6. POST /feedback + GET /feedback — submit and retrieve round-trip
// ────────────────────────────────────────────────────────────────────────────
test('feedback-submit-list: POST /feedback stores entry; GET /feedback returns it', async ({
  request,
}) => {
  // WHO: owner or front-desk user submitting feedback from any dashboard page
  // WHAT: POST /feedback with page + comment inserts a user_feedback row;
  //       GET /feedback for the same tenant returns the row in the list
  // WHEN: any "Submit Feedback" button click in the dashboard UI
  // WHERE: src/routes/analytics.ts POST/GET /feedback
  // WHY: feedback is the product team's signal for bugs and missing features;
  //      a broken submission silently discards operator input
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);
    const hdr = { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant.token}` };

    const uniqueComment = `E2E feedback test ${Date.now()} — schedule tab is great`;

    const postRes = await request.post(`${BACKEND_URL}/feedback`, {
      headers: hdr,
      data: {
        tenant_id: tenant.tenantId,
        page: 'Schedule',
        comment: uniqueComment,
        rating: 5,
      },
    });
    expect(postRes.status()).toBe(200);
    const postBody = await postRes.json();
    expect(postBody.success).toBe(true);

    // GET /feedback for the same tenant returns the row
    const getRes = await request.get(`${BACKEND_URL}/feedback?tenant_id=${tenant.tenantId}`, {
      headers: hdr,
    });
    expect(getRes.status()).toBe(200);
    const rows = await getRes.json();
    expect(Array.isArray(rows)).toBe(true);
    const found = rows.find((r: { comment: string }) => r.comment === uniqueComment);
    expect(found, 'submitted feedback must appear in list').toBeTruthy();
    expect(found.page).toBe('Schedule');
    expect(found.rating).toBe(5);
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 7. GET /coverage — date-range param passes through to check_coverage_gaps
// ────────────────────────────────────────────────────────────────────────────
test('coverage-api: GET /coverage with date range returns an array', async ({ request }) => {
  // WHO: owner viewing the coverage/gap bars in the Schedule tab
  // WHAT: GET /coverage?start_date=X&end_date=Y calls check_coverage_gaps()
  //       and returns an array (may be empty for a tenant with no services/shifts,
  //       which is fine — the contract is: 200 + array, never a crash)
  // WHEN: Schedule tab loads or owner changes the date range
  // WHERE: src/routes/analytics.ts GET /coverage + check_coverage_gaps() RPC
  // WHY: if start_date/end_date fail to parse or the RPC call throws, the
  //      Schedule tab's gap bars crash silently and show no coverage state
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);
    const hdr = { Authorization: `Bearer ${tenant.token}` };
    const startDate = isoDateDaysFromNow(0);
    const endDate = isoDateDaysFromNow(7);

    const res = await request.get(
      `${BACKEND_URL}/coverage?tenant_id=${tenant.tenantId}&start_date=${startDate}&end_date=${endDate}`,
      { headers: hdr }
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Must be an array (empty is valid for a fresh tenant with no services/shifts)
    expect(Array.isArray(body)).toBe(true);
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 7. GET /analytics/cohorts — repeat-caller cohorts + bookings-by-service
// ────────────────────────────────────────────────────────────────────────────
test('analytics-cohorts-api: two calls from one phone surface as a repeat caller', async ({
  request,
}) => {
  // WHO: an owner opening the analytics-depth panels.
  // WHAT: seed two calls from the SAME caller phone; GET /analytics/cohorts
  //       returns that phone in repeat_callers (call_count 2) and a summary
  //       counting it as a repeat caller.
  // WHEN: every Analytics-depth load.
  // WHERE: src/routes/analytics.ts GET /analytics/cohorts.
  // WHY: repeat callers are grouped on phone DIGITS — a regression in the
  //      normalization or the >1 HAVING filter would drop genuine repeat callers.
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);
    const agentHdr = { 'x-agent-secret': AGENT_SECRET, 'content-type': 'application/json' };

    // Same caller, two formats — must still count as ONE repeat caller.
    for (const [callId, phone] of [
      [`e2e-cohort-a-${Date.now()}`, '+16305559999'],
      [`e2e-cohort-b-${Date.now()}`, '630-555-9999'],
    ] as const) {
      await request.post(`${BACKEND_URL}/agent-tools/voice-session-start`, {
        headers: agentHdr,
        data: { tenant_id: tenant.tenantId, call_id: callId, caller_phone: phone },
      });
    }

    const hdr = { Authorization: `Bearer ${tenant.token}` };
    const res = await request.get(`${BACKEND_URL}/analytics/cohorts?tenant_id=${tenant.tenantId}`, {
      headers: hdr,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();

    // Shape contract
    expect(Array.isArray(body.repeat_callers)).toBe(true);
    expect(Array.isArray(body.by_service)).toBe(true);
    expect(Array.isArray(body.top_customers)).toBe(true); // CLV cut
    expect(Array.isArray(body.abandonment_by_service)).toBe(true); // abandonment-by-service cut
    expect(typeof body.summary.repeat_callers).toBe('number');

    // The two same-caller calls collapse to one repeat caller with count 2.
    const repeat = body.repeat_callers.find((r: { phone: string }) => r.phone === '6305559999');
    expect(repeat, 'the two same-phone calls must surface as one repeat caller').toBeTruthy();
    expect(repeat.call_count).toBe(2);
    expect(body.summary.repeat_callers).toBeGreaterThanOrEqual(1);
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});
