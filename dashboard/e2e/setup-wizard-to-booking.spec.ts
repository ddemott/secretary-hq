/**
 * E2E coverage for the wizard-finalize → first-booking-ready path.
 *
 * Why this exists: docs/TODO.md "Setup wizard finalize → first usable
 * tenant" was the only P1 E2E gap that could mask a beta-blocking
 * regression. critical-ux test 19 covers wizard step guards but stops
 * at "user can advance"; it never proves that a tenant who finishes
 * the wizard can immediately book without operator intervention.
 *
 * The wizard's load-bearing finalize work is fanning each employee's
 * in-memory weekly availability grid into 4 weeks of date-specific
 * employee_schedule rows. Pre-Phase-B this happened via a per-employee
 * POST /shifts/expand-weekly loop on the wizard's step 6→7 transition;
 * as of Phase B (2026-07-05, PR B/#205 + PR C) it's one call —
 * POST /setup/commit, fired on the transition into step 9 — that inserts
 * the whole entity graph (services/resources/employees/mappings) AND fans
 * shifts into employee_schedule inside a single transaction. This spec
 * doesn't drive the wizard UI itself (see wizard-website-scan.spec.ts and
 * wizard-solo-path.spec.ts for browser click-paths) — it calls the
 * underlying endpoints directly to pin the DOWNSTREAM contract: booking
 * RPCs read employee_schedule exclusively, so whichever endpoint fills it,
 * a silent fan-out failure means every booking attempt for the brand-new
 * tenant returns EMPLOYEE_NOT_SCHEDULED and the demo dies. That contract
 * is unchanged by Phase B, hence /shifts/expand-weekly (still a real,
 * standalone route) remains the direct, minimal way to pin it here.
 *
 * What's covered:
 *   - Happy path: /register → seed services + resource + employee +
 *     /shifts/expand-weekly → book a future appointment, succeeds with
 *     appointment_id returned.
 *   - Sad path: same flow but skip /shifts/expand-weekly. Booking fails
 *     with EMPLOYEE_NOT_SCHEDULED, pinning the contract that the
 *     fan-out is the load-bearing piece (not just a UX nicety).
 *   - Range coverage: after expand-weekly with default weeks_ahead=4,
 *     employee_schedule contains rows spanning ~28 days from today.
 *     Catches a regression where someone changes the default to a
 *     smaller window and ships a tenant who falls off the calendar
 *     mid-week.
 *
 * Each test owns its data lifecycle (per feedback_test_isolation
 * memory): registers a fresh unique tenant in the test body, drives
 * the API path, and DELETEs the tenant in `finally` — tenants cascade
 * to every dependent table, so cleanup is one statement.
 *
 * API-only design (matches calendar-sync.spec.ts): no page navigation,
 * no SSR/hydration flakes. The wizard's finalize sequence is
 * `Api.{services,resources,employees}.create` + `Api.shifts.expandWeekly`
 * — every call has a 1:1 backend route, so simulating the finalize
 * via direct HTTP is faithful to the production code path.
 */
import { test, expect } from './helpers/test';
import { type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import { cleanTenantData } from './helpers/fixtures';

const PG_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';
const BACKEND_URL = process.env.BACKEND_URL ?? 'https://localhost:4001';

let pool: Pool;

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

/**
 * Returns a date N days from today (UTC) in YYYY-MM-DD form. Used so
 * the booking lands inside the wizard's default 4-week fan-out window
 * and on a known weekday — every weekday gets a shift in our pattern.
 */
function isoDateDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Mirrors what SoloWizard / SetupWizard build before posting to
 * /shifts/expand-weekly: a row per day-of-week the employee works.
 * Every weekday gets the same hours so the test doesn't depend on
 * which day-of-week "today + N" lands on.
 */
function fullWeekPattern(): { day_of_week: number; start_time: string; end_time: string }[] {
  const pattern = [];
  for (let dow = 0; dow < 7; dow++) {
    pattern.push({ day_of_week: dow, start_time: '08:00', end_time: '18:00' });
  }
  return pattern;
}

interface RegisteredTenant {
  tenantId: string;
  userId: string;
  token: string;
  email: string;
}

async function registerFreshTenant(req: APIRequestContext): Promise<RegisteredTenant> {
  const suffix = uniqueSuffix();
  const email = `wizard-e2e-${suffix}@example.test`;
  const res = await req.post(`${BACKEND_URL}/register`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      business_name: `Wizard E2E ${suffix}`,
      // automotive matches the seeded business_templates entry; the
      // wizard auto-seeds example_services from this template, but our
      // test creates services explicitly so the auto-seed race doesn't
      // matter — we exercise the explicit path the wizard also uses
      // when the owner adds custom services.
      business_type: 'automotive',
      owner_name: `Owner ${suffix}`,
      email,
      password: 'password123',
      consent_attested: true,
    },
  });
  expect(res.status(), 'register must succeed for a brand-new tenant').toBe(201);
  const body = await res.json();
  expect(body.success).toBe(true);
  return {
    tenantId: body.tenant_id as string,
    userId: body.user_id as string,
    token: body.token as string,
    email,
  };
}

async function createServiceAs(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  name: string
): Promise<string> {
  const res = await req.post(`${BACKEND_URL}/services/create`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { tenant_id: tenantId, name, duration_minutes: 30 },
  });
  expect(res.status(), `service ${name} create must succeed`).toBe(200);
  const body = await res.json();
  return body.service.service_id as string;
}

async function createResourceAs(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  name: string
): Promise<string> {
  const res = await req.post(`${BACKEND_URL}/resources/create`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { tenant_id: tenantId, name },
  });
  expect(res.status(), `resource ${name} create must succeed`).toBe(200);
  const body = await res.json();
  return body.resource.resource_id as string;
}

async function createEmployeeAs(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  fullName: string
): Promise<string> {
  const [first, ...rest] = fullName.split(' ');
  const res = await req.post(`${BACKEND_URL}/employees/create`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: {
      tenant_id: tenantId,
      first_name: first,
      last_name: rest.join(' ') || 'Owner',
    },
  });
  expect(res.status(), `employee ${fullName} create must succeed`).toBe(200);
  const body = await res.json();
  return body.employee.employee_id as string;
}

async function createCustomerAs(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  name: string
): Promise<string> {
  const phone = `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
  const res = await req.post(`${BACKEND_URL}/customers/create`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { tenant_id: tenantId, name, phone },
  });
  expect(res.status(), `customer ${name} create must succeed`).toBe(200);
  const body = await res.json();
  return body.customer.customer_id as string;
}

async function expandWeeklyAs(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  employeeId: string
): Promise<{ inserted: number; rangeStart: string; rangeEnd: string }> {
  const res = await req.post(`${BACKEND_URL}/shifts/expand-weekly`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: {
      tenant_id: tenantId,
      employee_id: employeeId,
      pattern: fullWeekPattern(),
      // Omit weeks_ahead so the route applies its default of 4 — the
      // production wizard also leaves this unset; the range-coverage
      // test below proves that default is honored.
    },
  });
  expect(res.status(), 'expand-weekly must succeed at finalize').toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  return {
    inserted: body.inserted as number,
    rangeStart: body.rangeStart as string,
    rangeEnd: body.rangeEnd as string,
  };
}

test.beforeAll(() => {
  pool = new Pool({ connectionString: PG_URL });
});
test.afterAll(async () => {
  await pool.end();
});

// ────────────────────────────────────────────────────────────────────────────
// Happy path — wizard finalize leaves the tenant booking-ready.
// ────────────────────────────────────────────────────────────────────────────

test('wizard finalize → fresh tenant can immediately book', async ({ request }) => {
  // WHO: brand-new owner who just signed up and walked through the
  //      setup wizard — no manual SQL, no manual schedule editing.
  // WHAT: after /register + the wizard's finalize sequence (services,
  //      resource, employee, /shifts/expand-weekly), POST
  //      /appointments/create succeeds with an appointment_id.
  // WHEN: every new beta customer's first morning. If this fails,
  //      our demo experience is "register → tour the empty dashboard
  //      → try to book → cryptic EMPLOYEE_NOT_SCHEDULED error".
  // WHERE: SetupWizard/index.tsx:108-131 (the goNext step 6→7 fan-out)
  //      + src/routes/shifts.ts /shifts/expand-weekly + src/routes/
  //      appointments.ts /appointments/create.
  // WHY: this is the only path that proves the wizard's
  //      promise-of-completion is real. critical-ux test 19 covers
  //      wizard step guards but never crosses into "tenant is now
  //      bookable." Without this E2E, a refactor that changes
  //      Api.shifts.expandWeekly's body shape (or silently skips
  //      employees with no shifts) would still pass every existing
  //      unit test — the fan-out unit tests mock the DB; the e2e
  //      route tests assert response shape, not first-booking
  //      readiness.
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);

    // Drive the wizard's finalize sequence in the same order the UI
    // does: services first, then resource, then employee, then the
    // expand-weekly fan-out at the 6→7 boundary.
    await createServiceAs(request, tenant.token, tenant.tenantId, 'Tire Rotation');
    const resourceId = await createResourceAs(request, tenant.token, tenant.tenantId, 'Bay 1');
    const employeeId = await createEmployeeAs(request, tenant.token, tenant.tenantId, 'Sam Owner');
    const result = await expandWeeklyAs(request, tenant.token, tenant.tenantId, employeeId);

    // Sanity: 4 weeks × 7 days/week = 28 inserts when the pattern
    // covers every weekday. Pin both endpoints to catch a regression
    // where the fan-out silently inserts zero rows.
    expect(result.inserted, 'fan-out inserts a row per (date, weekday-with-pattern)').toBe(28);

    // Customer is the missing piece a real wizard run also requires —
    // the wizard collects services/employees but customers come from
    // the booking surface itself. Mirror that shape here.
    const customerId = await createCustomerAs(
      request,
      tenant.token,
      tenant.tenantId,
      'Walk-In Test'
    );

    // Pick a slot 7 days from now at 14:00-14:30 UTC (well inside
    // the 08:00-18:00 LOCAL pattern under any reasonable tenant
    // timezone — new tenants default to America/New_York which makes
    // 14:00 UTC = 10:00 EDT = squarely inside the shift). 7 days
    // future also clears the past-time rejection and the 15-minute
    // increment check (14:00 + 30min are both on the :00 grid).
    const bookingDate = isoDateDaysFromNow(7);
    const bookRes = await request.post(`${BACKEND_URL}/appointments/create`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant.token}` },
      data: {
        tenant_id: tenant.tenantId,
        resource_id: resourceId,
        customer_id: customerId,
        employee_id: employeeId,
        start_time: `${bookingDate}T14:00:00.000Z`,
        end_time: `${bookingDate}T14:30:00.000Z`,
        description: 'first booking after wizard finalize',
      },
    });
    const bookBody = await bookRes.json();
    expect(
      bookRes.status(),
      `booking must succeed for a wizard-finalized tenant; got error: ${bookBody.error ?? '(none)'}`
    ).toBe(200);
    expect(bookBody.success).toBe(true);
    expect(bookBody.appointment_id, 'route returns the new appointment_id').toBeTruthy();
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Sad path — skipping /shifts/expand-weekly leaves the tenant unbookable.
// Pins the contract that fan-out is load-bearing, not optional.
// ────────────────────────────────────────────────────────────────────────────

test('skipping expand-weekly leaves tenant with EMPLOYEE_NOT_SCHEDULED on every booking', async ({
  request,
}) => {
  // WHO: hypothetical refactor where someone "simplifies" the wizard
  //      by removing the step-6→7 fan-out (or changes the loop body
  //      such that no employee actually gets fanned out).
  // WHAT: same finalize sequence as the happy path MINUS the call to
  //      /shifts/expand-weekly. POST /appointments/create then fails
  //      with EMPLOYEE_NOT_SCHEDULED because employee_schedule is
  //      empty for that employee.
  // WHEN: every refactor of SetupWizard/index.tsx's finalize branch.
  //      Today the loop catches each employee's failure individually
  //      and continues — meaning a single broken expandWeekly call
  //      silently leaves SOME employees unbookable. This test pins
  //      the symptom so a refactor that breaks the fan-out for ALL
  //      employees fails loudly.
  // WHERE: src/routes/appointments.ts /appointments/create →
  //      book_appointment_atomic RPC's shift-coverage check returns
  //      'No matching shift found for the requested time'.
  // WHY: without this test, a regression that removes the fan-out
  //      step would still let the wizard "complete" (the user sees
  //      the Go Live screen) but every booking attempt would fail.
  //      The error message routes back to the dashboard as a generic
  //      400 — owners would not connect "wizard finished" to
  //      "scheduler is empty."
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);

    await createServiceAs(request, tenant.token, tenant.tenantId, 'Oil Change');
    const resourceId = await createResourceAs(request, tenant.token, tenant.tenantId, 'Bay 2');
    const employeeId = await createEmployeeAs(
      request,
      tenant.token,
      tenant.tenantId,
      'No Schedule'
    );
    // Deliberately skip expandWeeklyAs — this is the regression we
    // want to catch.

    const customerId = await createCustomerAs(
      request,
      tenant.token,
      tenant.tenantId,
      'Walk-In Sad'
    );
    const bookingDate = isoDateDaysFromNow(7);
    const bookRes = await request.post(`${BACKEND_URL}/appointments/create`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant.token}` },
      data: {
        tenant_id: tenant.tenantId,
        resource_id: resourceId,
        customer_id: customerId,
        employee_id: employeeId,
        start_time: `${bookingDate}T14:00:00.000Z`,
        end_time: `${bookingDate}T14:30:00.000Z`,
        description: 'booking with no schedule fan-out',
      },
    });
    const bookBody = await bookRes.json();
    expect(bookRes.status(), 'booking must reject when employee_schedule is empty').toBe(400);
    expect(bookBody.success).toBe(false);
    // Don't pin the exact message — the RPC's wording has changed
    // historically. Pin the substring that maps to the
    // employee_not_scheduled outcome label in
    // bookingOutcomeFromError().
    expect(
      String(bookBody.error ?? '').toLowerCase(),
      'error must indicate the employee is not on shift'
    ).toMatch(/shift|not_scheduled|not on shift/);
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Range coverage — default 4 weeks of fan-out lands at least 4 weeks of
// employee_schedule rows in the DB.
// ────────────────────────────────────────────────────────────────────────────

test('expand-weekly default produces ~4 weeks of employee_schedule rows', async ({ request }) => {
  // WHO: any refactor that changes weeksAhead's default in
  //      src/services/expandWeeklyToSchedule.ts.
  // WHAT: after /shifts/expand-weekly with no weeks_ahead override and
  //      a full-7-day pattern, the employee has at least 28 distinct
  //      future shift_date rows in employee_schedule, the latest of
  //      which is at least 27 days from today (allowing for the UTC
  //      day-boundary edge).
  // WHY: without a range pin, a refactor that changes the default to,
  //      say, 1 week would still pass the unit test ("inserted > 0")
  //      and still pass the happy-path test ("can book 7 days out").
  //      Beta customers would silently fall off the calendar after
  //      week 1 with no UI signal — they'd see EMPLOYEE_NOT_SCHEDULED
  //      on day 8 with no idea why "the wizard worked yesterday."
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);
    const employeeId = await createEmployeeAs(
      request,
      tenant.token,
      tenant.tenantId,
      'Range Check'
    );
    const result = await expandWeeklyAs(request, tenant.token, tenant.tenantId, employeeId);

    // 4 weeks × 7 days/week with a full-7-day pattern == 28 rows.
    expect(result.inserted, 'default fan-out inserts 28 rows').toBe(28);

    const rows = await pool.query<{ shift_date: Date }>(
      `SELECT shift_date FROM employee_schedule
       WHERE tenant_id = $1 AND employee_id = $2
       ORDER BY shift_date DESC LIMIT 1`,
      [tenant.tenantId, employeeId]
    );
    expect(rows.rowCount).toBe(1);
    const latest = rows.rows[0].shift_date;
    const daysOut = Math.floor(
      (latest.getTime() - new Date(new Date().toISOString().slice(0, 10)).getTime()) / 86_400_000
    );
    // 27 (not 28) accounts for the UTC date the helper uses as anchor:
    // start = today, range = [today, today+27], so the latest row is
    // at most 27 days ahead.
    expect(
      daysOut,
      `latest schedule row should be ~27 days out, got ${daysOut}`
    ).toBeGreaterThanOrEqual(27);
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});
