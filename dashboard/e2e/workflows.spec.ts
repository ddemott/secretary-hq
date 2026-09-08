/**
 * End-to-end happy-path workflow tests.
 *
 * Each test is independent and cleans up after itself:
 *  - Records are tagged with a unique e2e- prefix per run.
 *  - try/finally guarantees DB cleanup even when an assertion fails.
 *  - No test relies on data created by another.
 *
 * Setup: backend on https://localhost:4001, dashboard on https://localhost:4000,
 * Postgres on localhost:5433.
 */
import { test, expect } from './helpers/test';
import { type Page } from '@playwright/test';
import { Pool } from 'pg';
import * as crypto from 'crypto';
import {
  registerFreshTenant,
  seedBookingScenario,
  cleanTenantData,
  BACKEND_URL,
  bookAppointmentAs,
  isoDateDaysFromNow,
} from './helpers/fixtures';

const PG_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';

let pool: Pool;

// Per-spec fixture tenant + customer.
//
// WHY: each spec owns its full data lifecycle. We register a fresh tenant
// in beforeAll so all booking/customer/user tests work against isolated data.
// cleanTenantData() in afterAll cascades-deletes everything via the tenants FK.
let freshTenant: { tenantId: string; token: string; email: string };

test.beforeAll(async () => {
  pool = new Pool({ connectionString: PG_URL });

  // Register a fresh tenant via the real /register endpoint.
  const { request: pr } = await import('@playwright/test');
  const ctx = await pr.newContext({ ignoreHTTPSErrors: true });
  const ft = await registerFreshTenant(ctx);
  freshTenant = ft;

  const tid = freshTenant.tenantId;
  const tok = freshTenant.token;
  const hdr = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };

  // Create a service so the QuickBook service dropdown has an option.
  await ctx.post(`${BACKEND_URL}/services/create`, {
    headers: hdr,
    data: { tenant_id: tid, name: 'Test Service', duration_minutes: 30 },
  });

  // Seed 1 employee, 1 resource, 1 customer, shifts 1-14 days out.
  const datesAhead: string[] = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + i);
    datesAhead.push(d.toISOString().slice(0, 10));
  }
  await seedBookingScenario(ctx, pool, tok, tid, {
    employees: ['Test Tech'],
    resources: ['Bay 1'],
    customer: 'E2E Fixture Customer',
    shiftDates: datesAhead,
    shiftHours: { start: '06:00', end: '20:00' },
  });

  await ctx.dispose();
});

test.afterAll(async () => {
  await cleanTenantData(pool, freshTenant.tenantId);
  await pool.end();
});

function uniqueTag(): string {
  return `e2e-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

/** Format a Date as YYYY-MM-DDTHH:mm in the LOCAL timezone (matches what
 * <input type="datetime-local"> expects). Avoid toISOString() — that's UTC. */
function _toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Set super-admin's "managed tenant" to the fresh test tenant so tenant-scoped UI loads.
 */
async function switchToTestTenant(page: Page) {
  await page.evaluate((id) => {
    localStorage.setItem('managedTenantId', id);
    localStorage.setItem('managedTenantName', 'E2E Test Tenant');
  }, freshTenant.tenantId);
  await page.reload();
  await page.waitForTimeout(1500);
}

/**
 * Log out the shared admin and log in as a different user. Used by the
 * front-desk-gating and invite tests where the role of the caller is the
 * point of the test.
 */
async function loginAs(page: Page, email: string, password: string) {
  await page.context().clearCookies();
  await page.goto('/dashboard');
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.goto('/dashboard');
  await page.waitForTimeout(1000);

  const loginLink = page.getByText('Log in', { exact: true }).first();
  if (await loginLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await loginLink.click();
    await page.waitForTimeout(500);
  }
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page.locator('text=Home').first()).toBeVisible({ timeout: 15000 });
}

/** Login via API to get a JWT, then store it so page.evaluate(fetch) works. */
async function getApiToken(page: Page, email: string, password: string): Promise<string> {
  const result = await page.evaluate(
    async ({ email, password, backendUrl }) => {
      const res = await fetch(`${backendUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return await res.json();
    },
    { email, password, backendUrl: BACKEND_URL }
  );
  if (!result?.token) throw new Error(`Login failed for ${email}: ${JSON.stringify(result)}`);
  return result.token as string;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. SMOKE — admin lands, sees Home, clicks Schedule, calendar renders
// ────────────────────────────────────────────────────────────────────────────
test('smoke: admin can load dashboard and view the schedule', async ({ page }) => {
  // WHO: super-admin | WHAT: navigate dashboard root → Schedule | WHERE: shell + SchedulerView
  // WHY: catches build/server drift like the stale-bundle issue we just hit
  await page.goto('/dashboard');
  await switchToTestTenant(page);

  // Primary tabs visible
  await expect(page.getByRole('tab', { name: /^Home$/ }).first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('tab', { name: /^Schedule$/ }).first()).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Customers$/ }).first()).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Calls$/ }).first()).toBeVisible();

  // Click Schedule — calendar (default sub-view) renders
  await page
    .getByRole('tab', { name: /^Schedule$/ })
    .first()
    .click();
  await expect(page.locator('[data-testid="scheduler-view"]')).toBeVisible({ timeout: 10000 });

  // SchedulerView's date nav must also render — proves the sub-components
  // mounted, not just the outer container.
  await expect(page.locator('[data-testid="scheduler-date-display"]')).toBeVisible({
    timeout: 10000,
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. QUICK BOOK — book an appointment via UI; verify in DB; cleanup
// ────────────────────────────────────────────────────────────────────────────
test('quick book: booking creates an appointment row and shows it in the DB', async ({ page }) => {
  // WHO: tenant owner via super-admin | WHAT: open Quick Book, pick fields, submit
  // WHERE: SchedulerView (Resources tab) → QuickBookPanel → POST /appointments
  // WHY: end-to-end proof that the new appointmentValidation + booking RPC chain works
  const tag = uniqueTag();
  const description = `${tag}-quickbook`;
  let createdId: string | null = null;

  try {
    await page.goto('/dashboard');
    await switchToTestTenant(page);
    await page
      .getByRole('tab', { name: /^Schedule$/ })
      .first()
      .click();
    await page.waitForTimeout(1000);

    // Switch to Resources view (where Quick Book lives)
    const resourcesTab = page.getByTestId('day-mode-resources');
    await expect(resourcesTab).toBeVisible({ timeout: 10000 });
    await resourcesTab.click();
    await page.waitForTimeout(500);

    const quickBookBtn = page.locator('button').filter({ hasText: 'Quick Book' }).first();
    await expect(quickBookBtn).toBeVisible({ timeout: 10000 });
    await quickBookBtn.click();

    const panel = page.getByTestId('quick-book-panel');
    await expect(panel).toBeVisible({ timeout: 5000 });

    // Pick first real option in each select. Customer + Service dropdowns
    // include a placeholder/prompt at index 0, so index 1 is the first
    // real option. Resource dropdown does NOT include a prompt — it lists
    // eligible resources directly (post-2026-05-07 alignment filter), so
    // index 0 is the first real resource.
    await page.getByTestId('quick-book-customer').selectOption({ index: 1 });
    await page.getByTestId('quick-book-service').selectOption({ index: 1 });
    await page.getByTestId('quick-book-resource').selectOption({ index: 0 });

    // Pick a 30-min slot a few days out at a random grid-aligned hour
    // within the seeded business hours (06:00-20:00).
    const future = new Date();
    future.setDate(future.getDate() + 3);
    while (future.getDay() === 0 || future.getDay() === 6) {
      future.setDate(future.getDate() + 1);
    }
    const randomHour = 10 + Math.floor(Math.random() * 5); // 10-14 inclusive
    const ymd = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, '0')}-${String(future.getDate()).padStart(2, '0')}`;
    const hh = String(randomHour).padStart(2, '0');
    const startStr = `${ymd}T${hh}:15`;
    const endStr = `${ymd}T${hh}:45`;

    const startInput = panel.locator('input[type="datetime-local"]').first();
    const endInput = panel.locator('input[type="datetime-local"]').last();
    await startInput.fill(startStr);
    await endInput.fill(endStr);

    const beforeClick = new Date();
    await page.getByTestId('quick-book-confirm').click();

    // Wait for the panel to close (success) — booking can fail validly (e.g. no
    // employee skilled+scheduled at this time), so don't assert close. Instead
    // query the DB for any new row created since beforeClick.
    await page.waitForTimeout(2500);

    const dbRes = await pool.query(
      `SELECT appointment_id FROM appointments
        WHERE tenant_id = $1
          AND created_at >= $2
          AND is_deleted = false
        ORDER BY created_at DESC
        LIMIT 1`,
      [freshTenant.tenantId, beforeClick.toISOString()]
    );
    expect(
      dbRes.rowCount,
      `expected a new appointment created after ${beforeClick.toISOString()}; tag=${description}`
    ).toBeGreaterThanOrEqual(1);
    createdId = dbRes.rows[0].appointment_id;
  } finally {
    if (createdId) {
      await pool.query('DELETE FROM appointments WHERE appointment_id = $1', [createdId]);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 2b. QUICK BOOK REAL-TIME — new appointment appears in the grid w/o reload
// ────────────────────────────────────────────────────────────────────────────
test('quick book real-time: new appointment appears in the scheduler grid without manual page reload', async ({
  page,
}) => {
  // WHO: front-desk operator who just submitted a Quick Book and expects
  //        to see the appointment on the grid without doing anything else.
  // WHAT: open Quick Book → submit → assert the AppointmentBlock for the
  //        newly-created row becomes visible in the resource-columns grid
  //        WITHOUT a page reload (no page.reload() call, URL unchanged).
  //        The booking response's appointment_id is captured from the live
  //        POST /appointments/create response so the assertion targets the
  //        exact row that was just created (no name-collision noise).
  // WHEN: any successful Quick Book — the SchedulerView's handleQuickBooked
  //        callback calls useSchedulerData.refresh() which re-fetches the
  //        date's appointments. If that wiring breaks, the operator would
  //        book → see the panel close → and the grid would still look empty
  //        until they refresh the page — a real beta-stopping UX bug that
  //        unit tests would miss (refresh() is a useCallback closure that
  //        could be silently dropped from an effect's dep array).
  // WHERE: SchedulerView.handleQuickBooked → useSchedulerData.fetchData →
  //        Api.appointments.list → setAppointments → AppointmentBlock render.
  // WHY: the existing "quick book" test (above) verifies the BOOKING worked
  //        by checking the DB. This test verifies the GRID worked by checking
  //        the rendered UI. Both surfaces are required for the operator
  //        experience; either alone is insufficient.
  const tag = uniqueTag();
  let createdId: string | null = null;

  try {
    await page.goto('/dashboard');
    await switchToTestTenant(page);
    await page
      .getByRole('tab', { name: /^Schedule$/ })
      .first()
      .click();
    await page.waitForTimeout(1000);

    // Resources sub-view (where Quick Book + the resource-columns grid live)
    const resourcesTab = page.getByTestId('day-mode-resources');
    await expect(resourcesTab).toBeVisible({ timeout: 10000 });
    await resourcesTab.click();
    await page.waitForTimeout(500);

    // Compute target date: 3 weekdays forward (matching the existing quick
    // book test's date arithmetic). Then advance the scheduler's date nav by
    // that many clicks so selectedDate matches the booking date — otherwise
    // the new appointment lands outside the day-window useSchedulerData
    // queries and the grid wouldn't show it even with a correct refresh.
    const target = new Date();
    target.setDate(target.getDate() + 3);
    while (target.getDay() === 0 || target.getDay() === 6) {
      target.setDate(target.getDate() + 1);
    }
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const target0 = new Date(target);
    target0.setHours(0, 0, 0, 0);
    const daysForward = Math.round((target0.getTime() - today0.getTime()) / 86_400_000);
    const nextDayBtn = page.getByRole('button', { name: 'Next day' });
    for (let i = 0; i < daysForward; i++) {
      await nextDayBtn.click();
      await page.waitForTimeout(150);
    }

    // Guarantee a bookable slot: give every tech a full-day shift on the
    // target date via direct DB insert (the fixture seeded 14 days but the
    // exact target date could fall outside at timezone edges).
    const targetYmd = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
    await pool.query(
      `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
       SELECT tenant_id, employee_id, $2::date, '06:00', '20:00', false
         FROM employees
        WHERE tenant_id = $1 AND (is_deleted IS NULL OR is_deleted = false)
       ON CONFLICT (tenant_id, employee_id, shift_date)
         DO UPDATE SET start_time = '06:00', end_time = '20:00', is_off = false`,
      [freshTenant.tenantId, targetYmd]
    );

    // Capture URL before submission — assertion below confirms it didn't
    // change, i.e. no client-side route push and no reload.
    const urlBeforeBooking = page.url();

    // Open Quick Book + fill — same prefill pattern as the existing quick
    // book test (index 1 customer + service, index 0 resource, 10-14 local
    // hour) so this test fails for "real-time refresh broke" reasons, not
    // "I picked an unbookable combo" reasons.
    const quickBookBtn = page.locator('button').filter({ hasText: 'Quick Book' }).first();
    await expect(quickBookBtn).toBeVisible({ timeout: 10000 });
    await quickBookBtn.click();

    const panel = page.getByTestId('quick-book-panel');
    await expect(panel).toBeVisible({ timeout: 5000 });

    await page.getByTestId('quick-book-customer').selectOption({ index: 1 });
    await page.getByTestId('quick-book-service').selectOption({ index: 1 });
    await page.getByTestId('quick-book-resource').selectOption({ index: 0 });

    const randomHour = 10 + Math.floor(Math.random() * 5); // 10-14 LOCAL
    const ymd = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
    const hh = String(randomHour).padStart(2, '0');
    const startInput = panel.locator('input[type="datetime-local"]').first();
    const endInput = panel.locator('input[type="datetime-local"]').last();
    await startInput.fill(`${ymd}T${hh}:15`);
    await endInput.fill(`${ymd}T${hh}:45`);

    // Listen for the booking POST so we can grab the new appointment_id
    // directly from the same response the dashboard sees. This is more
    // reliable than "query DB for newest row" — there's no time-window
    // ambiguity.
    const bookingResponsePromise = page.waitForResponse(
      (resp) => resp.url().includes('/appointments/create') && resp.request().method() === 'POST',
      { timeout: 10_000 }
    );
    await page.getByTestId('quick-book-confirm').click();
    const bookingResponse = await bookingResponsePromise;
    const bookingBody = await bookingResponse.json();
    expect(
      bookingBody.success,
      `booking must succeed for the real-time assertion to be meaningful; tag=${tag}, body=${JSON.stringify(bookingBody)}`
    ).toBe(true);
    expect(bookingBody.appointment_id, 'booking response must include appointment_id').toBeTruthy();
    createdId = bookingBody.appointment_id as string;

    // The actual contract: an AppointmentBlock for the new id must become
    // visible in the grid WITHOUT a page reload. Playwright's `toBeVisible`
    // auto-waits up to expect.timeout (10s) which is plenty of time for the
    // refetch + setAppointments + render cycle (typically <1s on a warm
    // backend).
    const newBlock = page.locator(`[data-testid="appointment-block-${createdId}"]`);
    await expect(
      newBlock,
      `the new appointment must render in the grid without a page reload; tag=${tag}`
    ).toBeVisible({ timeout: 10_000 });

    // Belt-and-suspenders: confirm no navigation/reload happened.
    expect(page.url(), 'URL must not change between booking submit and grid render').toBe(
      urlBeforeBooking
    );
  } finally {
    if (createdId) {
      await pool.query('DELETE FROM appointments WHERE appointment_id = $1', [createdId]);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 3. EDIT APPOINTMENT — sad path validates, happy path saves to DB
// ────────────────────────────────────────────────────────────────────────────
test('edit appointment: time changes persist to DB through PUT /appointments', async ({ page }) => {
  // WHO: tenant owner | WHAT: load appt → change times → save → confirm DB
  // WHERE: AppointmentView → AppointmentDetailPanel → PUT /appointments/:id
  // WHY: end-to-end proof of the edit flow + new shared validateAppointmentTimeRange.
  // Sad-path validation is exercised by appointment.test.tsx (component test);
  // here we focus on the happy-path persistence loop.
  const tag = uniqueTag();
  const description = `${tag}-edit`;
  let apptId: string | null = null;
  // Composite key (employee_id, shift_date) — see pilot #3 (2026-05-18).
  // The afterEach cleanup uses both to delete the row.
  let shiftEmployeeId: string | null = null;
  let shiftDateForCleanup: string | null = null;

  try {
    // Pre-create via direct INSERT (no booking-RPC noise) — pick a future
    // weekday slot. Per the test-isolation principle: also ensure the
    // assigned employee has a shift covering that day, otherwise the row
    // is operationally inconsistent ("appointment exists for an employee
    // who isn't working") and any future cross-check that re-validates
    // existing rows against shift coverage would flag it. The test owns
    // the shift and the appointment together; both come and go together.
    const future = new Date();
    future.setDate(future.getDate() + 14);
    // Snap to next weekday in case getDate()+14 lands on a Sat/Sun.
    while (future.getDay() === 0 || future.getDay() === 6) {
      future.setDate(future.getDate() + 1);
    }
    future.setHours(10, 0, 0, 0);
    const startIso = future.toISOString();
    future.setHours(11, 0, 0, 0);
    const endIso = future.toISOString();
    const shiftDate = future.toISOString().slice(0, 10);

    const customer = await pool.query(
      `SELECT customer_id FROM customers WHERE tenant_id = $1 LIMIT 1`,
      [freshTenant.tenantId]
    );
    const resource = await pool.query(
      `SELECT resource_id FROM resources WHERE tenant_id = $1 LIMIT 1`,
      [freshTenant.tenantId]
    );
    // Use the first active employee seeded for this tenant (no name dependency).
    const employee = await pool.query(
      `SELECT employee_id FROM employees WHERE tenant_id = $1 AND (is_deleted IS NULL OR is_deleted = false) LIMIT 1`,
      [freshTenant.tenantId]
    );
    expect(
      employee.rowCount,
      'at least one employee must exist in the test tenant'
    ).toBeGreaterThanOrEqual(1);

    // Insert (or upsert) the employee's shift covering the test slot.
    await pool.query(
      `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
       VALUES ($1, $2, $3, '08:00', '17:00', false)
       ON CONFLICT (tenant_id, employee_id, shift_date) DO UPDATE
         SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, is_off = false`,
      [freshTenant.tenantId, employee.rows[0].employee_id, shiftDate]
    );
    shiftEmployeeId = employee.rows[0].employee_id;
    shiftDateForCleanup = shiftDate;

    const insert = await pool.query(
      `INSERT INTO appointments (tenant_id, customer_id, resource_id, employee_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled') RETURNING appointment_id`,
      [
        freshTenant.tenantId,
        customer.rows[0].customer_id,
        resource.rows[0].resource_id,
        employee.rows[0].employee_id,
        startIso,
        endIso,
        description,
      ]
    );
    apptId = insert.rows[0].appointment_id;

    // Edit via API (reuses the same PUT /appointments/:id route the UI calls).
    // We don't drive the form because (a) controlled-input fills don't reliably
    // dispatch React's onChange under Playwright, and (b) there's a real
    // z-index bug where react-big-calendar's date cells intercept clicks on
    // the confirmation modal. Both are tracked separately; the form path is
    // covered by appointment.test.tsx (component-level).
    const token = await getApiToken(page, freshTenant.email, 'password123');
    const newStart = new Date(future);
    newStart.setHours(13, 0, 0, 0);
    const newEnd = new Date(future);
    newEnd.setHours(14, 0, 0, 0);
    const updateResp = await page.evaluate(
      async ({ token, id, tenantId, startIso, endIso, backendUrl }) => {
        const res = await fetch(`${backendUrl}/appointments/${id}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ tenant_id: tenantId, start_time: startIso, end_time: endIso }),
        });
        return { status: res.status, body: await res.json() };
      },
      {
        token,
        id: apptId,
        tenantId: freshTenant.tenantId,
        startIso: newStart.toISOString(),
        endIso: newEnd.toISOString(),
        backendUrl: BACKEND_URL,
      }
    );
    expect(updateResp.status, `update response: ${JSON.stringify(updateResp)}`).toBeLessThan(400);

    // SAD path: API rejects end <= start
    const badResp = await page.evaluate(
      async ({ token, id, tenantId, startIso, backendUrl }) => {
        const earlier = new Date(startIso);
        earlier.setHours(earlier.getHours() - 2);
        const res = await fetch(`${backendUrl}/appointments/${id}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ tenant_id: tenantId, end_time: earlier.toISOString() }),
        });
        return { status: res.status, body: await res.json() };
      },
      {
        token,
        id: apptId,
        tenantId: freshTenant.tenantId,
        startIso: newStart.toISOString(),
        backendUrl: BACKEND_URL,
      }
    );
    expect(badResp.status, 'expected 400 from validator on end<=start').toBe(400);
    expect(String(badResp.body?.error || '')).toMatch(/End time must be after start time/i);

    // Verify DB reflects the *valid* update (sad-path was rejected)
    const after = await pool.query(
      `SELECT EXTRACT(EPOCH FROM start_time) AS s, EXTRACT(EPOCH FROM end_time) AS e
         FROM appointments WHERE appointment_id = $1`,
      [apptId]
    );
    expect(after.rowCount).toBe(1);
    expect(Number(after.rows[0].s) * 1000).toBe(newStart.getTime());
    expect(Number(after.rows[0].e) * 1000).toBe(newEnd.getTime());
  } finally {
    if (apptId) {
      await pool.query('DELETE FROM appointments WHERE appointment_id = $1', [apptId]);
    }
    if (shiftEmployeeId && shiftDateForCleanup) {
      await pool.query(
        'DELETE FROM employee_schedule WHERE tenant_id = $1 AND employee_id = $2 AND shift_date = $3',
        [freshTenant.tenantId, shiftEmployeeId, shiftDateForCleanup]
      );
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 4. CREATE CUSTOMER — POST /customers + verify appears in dashboard list
// ────────────────────────────────────────────────────────────────────────────
test('create customer: API insert renders in CRM list and is queryable', async ({ page }) => {
  // WHO: tenant owner | WHAT: insert customer via API, verify dashboard list refresh
  // WHERE: POST /customers/create → CRMView list
  // WHY: end-to-end auth + RLS + list-refresh proof; UI form is exercised by component tests
  const tag = uniqueTag();
  const customerName = `E2E Test ${tag}`;
  const phone = `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
  let customerId: string | null = null;

  try {
    await page.goto('/dashboard');
    await switchToTestTenant(page);
    const token = await getApiToken(page, freshTenant.email, 'password123');

    const created = await page.evaluate(
      async ({ token, name, phone, tenantId, backendUrl }) => {
        const res = await fetch(`${backendUrl}/customers/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ tenant_id: tenantId, name, phone }),
        });
        return { status: res.status, body: await res.json() };
      },
      { token, name: customerName, phone, tenantId: freshTenant.tenantId, backendUrl: BACKEND_URL }
    );
    expect(
      created.status,
      `expected 200 from /customers/create, got ${JSON.stringify(created)}`
    ).toBe(200);
    // /customers/create returns the new row under `customer` with PK
    // column `customer_id` post-rename. Multiple fallbacks so the test
    // isn't brittle to incidental route-shape refactors.
    customerId =
      created.body?.customer?.customer_id ??
      created.body?.customer?.id ??
      created.body?.customer_id ??
      created.body?.id ??
      null;
    expect(customerId, 'expected returned customer id').toBeTruthy();

    // Navigate to Customers view, refresh, and assert our row shows
    await page
      .getByRole('tab', { name: /^Customers$/ })
      .first()
      .click();
    await page.waitForTimeout(1000);
    await page.reload(); // force list re-fetch
    await switchToTestTenant(page);
    await page
      .getByRole('tab', { name: /^Customers$/ })
      .first()
      .click();
    await expect(page.locator(`text=${customerName}`).first()).toBeVisible({ timeout: 10000 });

    // DB verification
    const db = await pool.query(
      `SELECT phone FROM customers WHERE customer_id = $1 AND tenant_id = $2`,
      [customerId, freshTenant.tenantId]
    );
    expect(db.rowCount).toBe(1);
    expect(db.rows[0].phone).toBe(phone);
  } finally {
    if (customerId) {
      await pool.query('DELETE FROM customers WHERE customer_id = $1', [customerId]);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 5. FRONT-DESK ROLE GATING — only Primary tabs; restricted URL bounces home
// ────────────────────────────────────────────────────────────────────────────
test('front-desk role: cannot see Advanced tabs; stale URL redirects to Home', async ({ page }) => {
  // WHO: front_desk user | WHAT: log in, see only Primary tabs, navigate to ?tab=my-business
  // WHERE: OutlookLayout role gate + useEffect snap-back
  // WHY: regression-guard the role-based hiding from commit 8683222
  const tag = uniqueTag();
  const fdEmail = `e2e-fd-${tag}@example.com`;
  let fdUserId: string | null = null;

  try {
    // Hash 'password123' inline to avoid a precomputed hash dependency.
    const bcrypt = await import('bcrypt');
    const fdHash = await bcrypt.hash('password123', 10);

    const inserted = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, 'front_desk') RETURNING user_id`,
      [freshTenant.tenantId, fdEmail, fdHash, `Front Desk ${tag}`]
    );
    fdUserId = inserted.rows[0].user_id;

    await loginAs(page, fdEmail, 'password123');

    // Primary tabs visible
    await expect(page.getByRole('tab', { name: /^Home$/ }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Schedule$/ }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Customers$/ }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Calls$/ }).first()).toBeVisible();

    // Advanced tabs hidden (IA merge 2026-06-03: My Business + My Team +
    // Business Settings are now the single "Setup" tab, still owner-only).
    await expect(page.getByRole('tab', { name: /^Setup$/ })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /Phone Assistant/ })).toHaveCount(0);

    // Stale legacy URL → redirected to Setup, which front-desk can't see, so
    // they're snapped back to Home; the management-only content never renders.
    await page.goto('/dashboard?tab=my-business');
    await page.waitForTimeout(1500);
    // After the snap-back, the URL should not contain my-business as the active tab.
    // We don't assert URL specifically because the OutlookLayout uses internal state;
    // instead, assert the my-business-only content is not rendered.
    await expect(page.locator('text=Service Catalog')).toHaveCount(0);
  } finally {
    if (fdUserId) {
      await pool.query('DELETE FROM users WHERE user_id = $1', [fdUserId]);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 6. INVITE TEAMMATE — owner invites; user + password_resets row created
// ────────────────────────────────────────────────────────────────────────────
test('invite teammate: owner POST /users/invite creates user + reset token', async ({ page }) => {
  // WHO: tenant owner | WHAT: call /users/invite, expect user row + password_resets row
  // WHERE: POST /users/invite (requireOwner gate, DASHBOARD_URL fallback safe)
  // WHY: covers the owner-only invite flow from commit e65c833
  const tag = uniqueTag();
  const inviteEmail = `e2e-invite-${tag}@example.com`;
  let invitedId: string | null = null;

  try {
    await page.goto('/dashboard');
    const token = await getApiToken(page, freshTenant.email, 'password123');

    const result = await page.evaluate(
      async ({ token, email, tenantId, backendUrl }) => {
        const res = await fetch(`${backendUrl}/users/invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            tenant_id: tenantId,
            email,
            full_name: 'E2E Invitee',
            role: 'front_desk',
          }),
        });
        return { status: res.status, body: await res.json() };
      },
      { token, email: inviteEmail, tenantId: freshTenant.tenantId, backendUrl: BACKEND_URL }
    );
    expect(result.status, `expected 201 from /users/invite, got ${JSON.stringify(result)}`).toBe(
      201
    );

    // Verify user row + password_resets row exist
    const userRow = await pool.query(
      `SELECT user_id, role, password_hash FROM users WHERE email = $1 AND tenant_id = $2`,
      [inviteEmail, freshTenant.tenantId]
    );
    expect(userRow.rowCount).toBe(1);
    expect(userRow.rows[0].role).toBe('front_desk');
    expect(userRow.rows[0].password_hash, 'placeholder hash should be present').toBeTruthy();
    invitedId = userRow.rows[0].user_id;

    const resetRow = await pool.query(
      `SELECT 1 FROM password_resets WHERE user_id = $1 AND expires_at > NOW()`,
      [invitedId]
    );
    expect(resetRow.rowCount, 'expected an unexpired password_resets row').toBeGreaterThanOrEqual(
      1
    );
  } finally {
    if (invitedId) {
      await pool.query('DELETE FROM password_resets WHERE user_id = $1', [invitedId]);
      await pool.query('DELETE FROM users WHERE user_id = $1', [invitedId]);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Self-service links E2E (P1)
// Owner "Send Links" trigger + customer public pages for cancel/reschedule
// + negatives (invalid token, double-use) + DB side effects.
// Uses API setup + public page UI (the /self/* pages are served by the same
// Next.js app and require no login — the token is the credential).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimal HS256 JWT signer for E2E tests (matches selfServiceToken.ts dev
 * fallback secret + 24h). No extra deps.
 *
 * NOTE: this REIMPLEMENTS the production payload rather than importing
 * generateSelfServiceToken (the backend isn't importable from the Playwright
 * process). That duplication is a liability — it silently drifted the moment the
 * real payload gained a `typ` claim on 2026-07-13, and this spec was the only
 * thing that noticed. If you change SelfServiceTokenPayload, change it here too.
 */
function generateTestSelfServiceToken(
  appointmentId: string,
  tenantId: string,
  action: 'cancel' | 'reschedule'
): string {
  const secret = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    // The payload `typ` — NOT the JWS header `typ: 'JWT'` above, which is a
    // different field entirely. This one is what stops a cancel link from being
    // accepted as a login session (see middleware.ts JwtPayload). Without it the
    // backend's verifySelfServiceToken rejects the token outright.
    typ: 'self_service',
    appointment_id: appointmentId,
    tenant_id: tenantId,
    action,
    iat: now,
    exp: now + 24 * 3600,
  };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

test('self-service E2E: book → send links (API trigger) → customer uses cancel/reschedule public pages → negatives + double-use', async ({
  page,
}) => {
  // WHO: owner + customer (via public token links from SMS or "Send Links" button)
  // WHAT: full journey: owner triggers send (or booking embeds links), customer loads public cancel/reschedule UI, acts, sees feedback; negatives show friendly errors; double-use is safe.
  // WHEN: after a scheduled booking with customer phone.
  // WHERE: dashboard Send Links (or equivalent API), /self/cancel, /self/reschedule public pages, backend selfService + appointments routes.
  // WHY: this is the customer-trust P1 surface (no login required for the customer side); the backend trigger + pages shipped earlier, this E2E guards the end-to-end + error states that only appear in browser + real token flows.
  const tid = freshTenant.tenantId;
  const tok = freshTenant.token;
  const hdr = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };

  let apptId: string | null = null;

  // Use a fresh request context for API setup calls (same as other workflows tests).
  const { request: pwRequest } = await import('@playwright/test');
  const apiCtx = await pwRequest.newContext({ ignoreHTTPSErrors: true });

  try {
    // Ensure the tenant has an inbound_phone. The send-self-service-links handler
    // uses it (or TELNYX_PHONE_NUMBER env) as the SMS "from" number; both from and to
    // must normalize + pass isValidPhone, else it 400s with "Invalid phone number".
    // Freshly registered e2e tenants don't have one set (provisioning normally does this).
    await pool.query(`UPDATE tenants SET inbound_phone = '+15551234567' WHERE tenant_id = $1`, [
      tid,
    ]);

    // Seed supporting data (employee/resource/customer + shifts) so booking can succeed.
    // Use one UTC date string for BOTH the seeded shift and the booked time, and
    // build the booking as an explicit `...T10:00:00.000Z`. The booking RPC
    // compares the appointment's UTC time-of-day against the shift's 09:00-17:00
    // window, so any local-tz construction (setHours) drifts the instant outside
    // the window on a non-UTC CI runner → EMPLOYEE_NOT_SCHEDULED (400). This
    // matches the proven pattern in booking-enforcement.spec.ts.
    const bookingDate = isoDateDaysFromNow(7);
    const scenario = await seedBookingScenario(apiCtx, pool, tok, tid, {
      employees: ['Self Service Tech'],
      resources: ['Self Service Bay'],
      customer: 'Self Service Customer',
      shiftDates: [bookingDate],
    });

    const empId = scenario.employeeIds[0];
    const resId = scenario.resourceIds[0];
    const custId = scenario.customerId;

    // 10:00-10:30 on the seeded shift date, in explicit UTC (covered by 09:00-17:00).
    const startIso = `${bookingDate}T10:00:00.000Z`;
    const endIso = `${bookingDate}T10:30:00.000Z`;

    // Book a real scheduled appointment (the "book" part of the journey).
    const bookRes = await bookAppointmentAs(apiCtx, tok, {
      tenant_id: tid,
      resource_id: resId,
      customer_id: custId,
      employee_id: empId,
      start_time: startIso,
      end_time: endIso,
      description: 'Self-Service Test Booking',
    });
    expect(bookRes.status, 'booking for self-service E2E must succeed').toBe(200);
    apptId =
      (bookRes.body as any).appointment_id || (bookRes.body as any).appointment?.appointment_id;
    expect(apptId, 'expected appointment_id from book response').toBeTruthy();

    // 1. Owner "Send Links" trigger (the dashboard surface API; button in AppointmentDetailPanel calls exactly this).
    // Note: omit Content-Type (no JSON body for this endpoint). Including it with no body
    // causes Fastify's JSON parser to 400 "Invalid JSON". The dashboard apiMutate does
    // the same (deletes Content-Type when !body).
    const sendRes = await apiCtx.post(
      `${BACKEND_URL}/appointments/${apptId}/send-self-service-links`,
      {
        headers: { Authorization: `Bearer ${tok}` },
      }
    );
    const sendBody = (await sendRes.json().catch(() => ({}))) as {
      success?: boolean;
      message?: string;
      cancelLink?: string;
      rescheduleLink?: string;
    };
    // In full E2E env with DASHBOARD_URL set this is 200; if not configured the route returns clear 503 (still exercises the path).
    // 502 can happen if SMS provider (Telnyx) not configured in the test env (smsResult not ok) — the UI/token paths still work.
    if (sendRes.status() === 200) {
      expect(sendBody.success).toBe(true);
      expect(sendBody.message).toMatch(/sent/i);
      // Links are present when configured (useful for copy or for tests).
      if (sendBody.cancelLink) expect(sendBody.cancelLink).toMatch(/self\/cancel/);
    } else if ([502, 503].includes(sendRes.status())) {
      // Env-specific (no DASHBOARD_URL or Telnyx creds for real SMS in this test stack start).
      // We still proceed because the subsequent customer UI flows use manually-generated tokens (independent of the actual SMS send).
    } else {
      expect(sendRes.status(), 'unexpected status from send-self-service-links').toBe(200);
    }

    // 2. Generate real tokens (same secret + shape the backend uses) so we can drive the public pages.
    const cancelToken = generateTestSelfServiceToken(apptId!, tid, 'cancel');
    const rescheduleToken = generateTestSelfServiceToken(apptId!, tid, 'reschedule');

    // 3. Reschedule request page first (does NOT change appt status, so the token remains valid for lookup).
    // Load shows the confirm prompt + button; click performs the action (notifies owner) and shows success message.
    await page.goto(`/self/reschedule?token=${encodeURIComponent(rescheduleToken)}`);
    await expect(page.getByText(/Tap below to notify us/i)).toBeVisible();
    await page.getByRole('button', { name: /Send reschedule request/i }).click();
    await expect(page.getByText(/request has been sent/i)).toBeVisible();

    // 4. Customer cancel via public page (the link that would be in the SMS).
    await page.goto(`/self/cancel?token=${encodeURIComponent(cancelToken)}`);
    await expect(page.getByText(/Are you sure you want to cancel your appointment/i)).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole('button', { name: /Yes, cancel my appointment/i }).click();
    await expect(page.getByText(/has been canceled/i)).toBeVisible();

    // Verify DB side-effect (status flipped by the token-gated route).
    const afterCancel = await pool.query(
      'SELECT status FROM appointments WHERE appointment_id = $1',
      [apptId]
    );
    expect(afterCancel.rows[0]?.status).toBe('canceled');

    // 5. Double-use (idempotent): reload the link (shows confirm UI again), click the action button a second time;
    //    the backend cancel handler returns the "already been canceled" success message (idempotent, no error).
    await page.goto(`/self/cancel?token=${encodeURIComponent(cancelToken)}`);
    await expect(page.getByText(/Are you sure you want to cancel your appointment/i)).toBeVisible();
    await page.getByRole('button', { name: /Yes, cancel my appointment/i }).click();
    await expect(page.getByText(/already been canceled/i)).toBeVisible();

    // 6. Negatives: invalid/missing token shows clear error UI (no crash, no data leak).
    // Bad token (present but invalid): load shows confirm prompt (state based on token presence), click performs the fetch which fails -> error state with the message.
    await page.goto('/self/cancel?token=not.a.real.token');
    await expect(page.getByText(/Are you sure you want to cancel your appointment/i)).toBeVisible();
    await page.getByRole('button', { name: /Yes, cancel my appointment/i }).click();
    await expect(page.getByText(/expired or is invalid|missing a token/i)).toBeVisible();

    // No token at all: load immediately sets invalid state and shows the missing message (no button/click needed).
    await page.goto('/self/cancel');
    await expect(page.getByText(/missing a token/i)).toBeVisible();
  } finally {
    // The outer afterAll cleanTenantData on freshTenant will cascade-delete the appt + everything.
    // Nothing extra needed here.
  }
});
