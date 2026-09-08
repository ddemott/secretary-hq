/**
 * E2E coverage for the booking-alignment work shipped 2026-05-07
 * (commits 967402d, 4bf2e00, dbb845d). The unit and integration tests
 * pin the wiring with mocks; this spec exercises the same behavior
 * end-to-end against a real backend, real Postgres, and real
 * Playwright-driven UI.
 *
 * Four tests:
 *   1. UI alignment filter — picking a service narrows the employee
 *      dropdown to mapped staff (Blake and Casey are missing from the
 *      Balancing dropdown because only Alex is in service_employee for it).
 *   2. RPC enforcement — POST /appointments/create directly with a
 *      mismatched (service, employee) pair → 400 with "not assigned
 *      to perform this service" and zero rows inserted.
 *   3. Cross-view popover Cancel — pre-INSERT an appointment, open it
 *      from the List sub-tab (not Calendar), click the popover Cancel
 *      button, confirm DB row is `status='canceled'`.
 *   4. Soft-cancel frees the slot — cancel an appointment, then book
 *      a new one at the same resource+time. Should succeed (no
 *      overlap rejection — the canceled row doesn't block the slot).
 *
 * Setup: backend on https://localhost:4001, dashboard on
 * https://localhost:4000, Postgres on localhost:5433. Each spec
 * registers its own fresh tenant and cleans up in afterAll.
 */
import { test, expect } from './helpers/test';
import { type Page } from '@playwright/test';
import { Pool } from 'pg';
import { registerFreshTenant, cleanTenantData, BACKEND_URL } from './helpers/fixtures';

const PG_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';
const ADMIN_EMAIL = 'admin@secretaryhq.com';
const ADMIN_PASSWORD = 'p@ssw0rd';

let pool: Pool;

// Module-level IDs populated in beforeAll and used across all four tests.
let freshTenant: { tenantId: string; token: string; email: string };
let employeeAId: string; // only qualified for "Balancing"
let employeeBId: string; // NOT qualified for "Balancing"
let employeeCId: string; // NOT qualified for "Balancing"
let resourceId: string;
let fixtureCustomerId: string;
let serviceBalancingId: string;

function uniqueTag(): string {
  return `e2e-align-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function ensureLoggedIn(page: Page) {
  await page.goto('/dashboard');
  await page.waitForTimeout(1500);
  const loginLink = page.getByText('Log in', { exact: true }).first();
  if (await loginLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await loginLink.click();
    await page.waitForTimeout(500);
  }
  const emailInput = page.locator('input[type="email"]');
  if (await emailInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    await emailInput.fill(ADMIN_EMAIL);
    await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(2500);
  }
  await expect(page.getByText('Home').first()).toBeVisible({ timeout: 15000 });
}

async function switchToTestTenant(page: Page) {
  await page.evaluate((id) => {
    localStorage.setItem('managedTenantId', id);
    localStorage.setItem('managedTenantName', 'E2E Test Business');
  }, freshTenant.tenantId);
  await page.reload();
  await page.waitForTimeout(1500);
}

async function getApiToken(page: Page): Promise<string> {
  const result = await page.evaluate(
    async ({ email, password, backendUrl }) => {
      const res = await fetch(`${backendUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return await res.json();
    },
    { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, backendUrl: BACKEND_URL }
  );
  if (!result?.token) throw new Error(`Login failed: ${JSON.stringify(result)}`);
  return result.token as string;
}

test.beforeAll(async () => {
  pool = new Pool({ connectionString: PG_URL });

  // Need an APIRequestContext to call registerFreshTenant.
  const { request: pr } = await import('@playwright/test');
  const ctx = await pr.newContext({ ignoreHTTPSErrors: true });

  freshTenant = await registerFreshTenant(ctx);
  const tid = freshTenant.tenantId;
  const tok = freshTenant.token;
  const hdr = { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` };

  // Create 3 employees — only Alex will be mapped to the Balancing service.
  const [eA, eB, eC] = await Promise.all([
    ctx
      .post(`${BACKEND_URL}/employees/create`, {
        headers: hdr,
        data: { tenant_id: tid, first_name: 'Alex', last_name: 'Smith' },
      })
      .then((r) => r.json())
      .then((b) => b.employee.employee_id as string),
    ctx
      .post(`${BACKEND_URL}/employees/create`, {
        headers: hdr,
        data: { tenant_id: tid, first_name: 'Blake', last_name: 'Jones' },
      })
      .then((r) => r.json())
      .then((b) => b.employee.employee_id as string),
    ctx
      .post(`${BACKEND_URL}/employees/create`, {
        headers: hdr,
        data: { tenant_id: tid, first_name: 'Casey', last_name: 'Lee' },
      })
      .then((r) => r.json())
      .then((b) => b.employee.employee_id as string),
  ]);
  employeeAId = eA;
  employeeBId = eB;
  employeeCId = eC;

  // Create resource (Bay 1) used across tests 2–4.
  const rRes = await ctx.post(`${BACKEND_URL}/resources/create`, {
    headers: hdr,
    data: { tenant_id: tid, name: 'Bay 1' },
  });
  resourceId = (await rRes.json()).resource.resource_id as string;

  // Create the "Balancing" service (30 min).
  const sRes = await ctx.post(`${BACKEND_URL}/services/create`, {
    headers: hdr,
    data: { tenant_id: tid, name: 'Balancing', duration_minutes: 30 },
  });
  serviceBalancingId = (await sRes.json()).service.service_id as string;

  // Map ONLY Alex and Bay 1 to Balancing — Blake and Casey are intentionally excluded.
  await ctx.post(`${BACKEND_URL}/services/${serviceBalancingId}/employees/${employeeAId}/assign`, {
    headers: hdr,
    data: { tenant_id: tid },
  });
  await ctx.post(`${BACKEND_URL}/services/${serviceBalancingId}/resources/${resourceId}/assign`, {
    headers: hdr,
    data: { tenant_id: tid },
  });

  // Seed shifts for the next 14 days for all 3 employees so booking
  // tests land within a known valid window. expand-weekly fans 4 weeks
  // from today; 14 days is well inside that range.
  for (const empId of [employeeAId, employeeBId, employeeCId]) {
    await ctx.post(`${BACKEND_URL}/shifts/expand-weekly`, {
      headers: hdr,
      data: {
        tenant_id: tid,
        employee_id: empId,
        pattern: Array.from({ length: 7 }, (_, dow) => ({
          day_of_week: dow,
          start_time: '08:00',
          end_time: '17:00',
        })),
      },
    });
  }

  // Create a fixture customer for tests 2–4.
  const phone = `+1555${String(Date.now()).slice(-7)}`;
  const cRes = await ctx.post(`${BACKEND_URL}/customers/create`, {
    headers: hdr,
    data: { tenant_id: tid, name: 'E2E Fixture Customer', phone },
  });
  fixtureCustomerId = (await cRes.json()).customer.customer_id as string;

  await ctx.dispose();
});

test.afterAll(async () => {
  // Single cascade DELETE removes all test data (employees, services,
  // resources, appointments, customers, shifts, mappings).
  await cleanTenantData(pool, freshTenant.tenantId);
  await pool.end();
});

// ────────────────────────────────────────────────────────────────────────────
// 1. UI alignment filter — picking a service narrows the Tech dropdown
// ────────────────────────────────────────────────────────────────────────────
test('alignment: picking a service narrows the Tech dropdown to mapped staff only', async ({
  page,
}) => {
  // WHO: front-desk operator picking a service in Quick Book
  // WHAT: after selecting "Balancing" (only Alex is mapped to it),
  //        Blake and Casey must NOT appear in the Tech dropdown but Alex
  //        and "Unassigned" must.
  // WHEN: every booking flow on every sub-tab
  // WHERE: QuickBookPanel.tsx → useServiceMappings + filterEmployeesByService
  // WHY: the headline UX win of slice 1 — pre-fix every employee was
  //        selectable regardless of skill. The dashboard's filter contract
  //        is verified at the unit level via mocks; this test proves the
  //        same behavior runs end-to-end against a real backend with real
  //        service_employee rows.
  await ensureLoggedIn(page);
  await switchToTestTenant(page);

  await page
    .getByRole('tab', { name: /^Schedule$/ })
    .first()
    .click();
  await page.waitForTimeout(1000);

  // Resources sub-tab has Quick Book + the dropdown is the same one used
  // everywhere; switching there avoids any Staff-grid layout flakiness.
  const resourcesTab = page.getByTestId('day-mode-resources');
  await expect(resourcesTab).toBeVisible({ timeout: 10000 });
  await resourcesTab.click();
  await page.waitForTimeout(500);

  await page.locator('button').filter({ hasText: 'Quick Book' }).first().click();
  const panel = page.getByTestId('quick-book-panel');
  await expect(panel).toBeVisible({ timeout: 5000 });

  // Pick the Balancing service (mapped only to Alex).
  await page.getByTestId('quick-book-service').selectOption({ value: serviceBalancingId });
  await page.waitForTimeout(500); // let useEffect propagate the filter

  const techSelect = page.getByTestId('quick-book-employee');
  const techOptionTexts = await techSelect.locator('option').allTextContents();

  // Alex IS qualified → should be in the list. Unassigned is always offered.
  expect(techOptionTexts.some((t) => /unassigned/i.test(t))).toBe(true);
  expect(techOptionTexts.some((t) => /\bAlex\b/.test(t))).toBe(true);
  // Blake and Casey are NOT mapped to Balancing → must NOT appear.
  expect(
    techOptionTexts.some((t) => /\bBlake\b/.test(t)),
    `Blake must be filtered out — not in service_employee for Balancing. Got: ${techOptionTexts.join(' | ')}`
  ).toBe(false);
  expect(
    techOptionTexts.some((t) => /\bCasey\b/.test(t)),
    `Casey must be filtered out — not in service_employee for Balancing. Got: ${techOptionTexts.join(' | ')}`
  ).toBe(false);
});

// ────────────────────────────────────────────────────────────────────────────
// 2. RPC enforcement — direct API call with mismatched (service, employee)
// ────────────────────────────────────────────────────────────────────────────
test('alignment: POST /appointments/create rejects an unmapped (service, employee) pair', async ({
  page,
}) => {
  // WHO: a determined caller hitting the API directly (curl, Postman,
  //        future client app) — the gap the dashboard UI filter alone
  //        couldn't reach
  // WHAT: backend rejects with 400 + "not assigned to perform" and zero
  //        rows inserted.
  // WHEN: any caller bypasses the form's narrowed dropdown
  // WHERE: book_appointment_atomic — service_employee mapping check
  //        (migration 20260507000000)
  // WHY: defense-in-depth — the service_employee check fires BEFORE
  //        the shift check in book_appointment_atomic, so booking at +7
  //        days (within the seeded shift window) guarantees the mapping
  //        error is the only rejection path exercised.
  await page.goto('/dashboard');
  await ensureLoggedIn(page);

  const token = await getApiToken(page);

  // Book inside the seeded shift window (+7 days, 14:00) so the shift gate
  // is NOT the rejection cause. The service_employee mapping check fires
  // first in book_appointment_atomic and is the sole gating condition here.
  const start = new Date();
  start.setDate(start.getDate() + 7);
  start.setHours(14, 0, 0, 0);
  const end = new Date(start);
  end.setMinutes(start.getMinutes() + 30);

  const beforeCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM appointments WHERE tenant_id = $1 AND start_time = $2`,
    [freshTenant.tenantId, start.toISOString()]
  );

  const result = await page.evaluate(
    async ({ token: tok, payload, backendUrl }) => {
      const res = await fetch(`${backendUrl}/appointments/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tok}`,
        },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      return { status: res.status, body };
    },
    {
      token,
      backendUrl: BACKEND_URL,
      payload: {
        tenant_id: freshTenant.tenantId,
        resource_id: resourceId,
        customer_id: fixtureCustomerId,
        employee_id: employeeBId, // Blake — NOT mapped to Balancing
        service_id: serviceBalancingId,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        description: 'e2e-align — should be rejected',
      },
    }
  );

  // Booking RPC returned an error — surfaced as a 400 by the route.
  expect(
    result.status,
    `expected 400, got ${result.status} body=${JSON.stringify(result.body)}`
  ).toBe(400);
  expect(result.body?.success).toBe(false);
  expect(result.body?.error ?? '').toMatch(/not assigned to perform/i);

  // No row was inserted at this exact timestamp.
  const afterCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM appointments WHERE tenant_id = $1 AND start_time = $2`,
    [freshTenant.tenantId, start.toISOString()]
  );
  expect(afterCount.rows[0].n).toBe(beforeCount.rows[0].n);
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Cross-view popover Cancel — Cancel an appointment from the List sub-tab
// ────────────────────────────────────────────────────────────────────────────
test('cross-view: appointment popover Cancel works from the List sub-tab and soft-cancels in DB', async ({
  page,
}) => {
  // WHO: front-desk operator looking at the List sub-tab (not Calendar)
  // WHAT: click an appointment row → popover opens with Cancel button →
  //        click Cancel → confirm → DB row status flips to 'canceled'
  // WHEN: any non-Calendar sub-tab (Resources / List / Staff)
  // WHERE: AppointmentPopover (onCancel prop) + SchedulerView's
  //        handlePopoverCancel + Api.appointments.cancel + the
  //        /appointments/:id/cancel backend route
  // WHY: pre-fix the popover was read-only on these sub-tabs — the
  //        operator had to navigate to Calendar and click the
  //        appointment again before edit/cancel was reachable. This
  //        test exercises the cross-view pathway end-to-end and
  //        verifies the soft-cancel preserves the row (not a hard
  //        DELETE), so a refactor that reverts the wiring surfaces.
  const tag = uniqueTag();
  let apptId: string | null = null;

  try {
    // Pre-INSERT an appointment far enough in the future that it sits
    // alone on its day (easier to find in the List view).
    // Use TODAY's date with a non-seed minute offset — the List sub-tab
    // displays the scheduler's `selectedDate` (today by default), so a
    // far-future row would be off-screen. 13:45 is grid-aligned (DB CHECK
    // appointments_start_time_15min, applied 2026-05-08) and not a typical
    // seed value, so it avoids both the constraint and overlap rejection.
    const start = new Date();
    start.setHours(13, 45, 0, 0);
    const end = new Date(start);
    end.setMinutes(start.getMinutes() + 30);

    // Clean any leftover row at this exact slot from a previous failed run.
    await pool.query(
      'DELETE FROM appointments WHERE tenant_id = $1 AND resource_id = $2 AND start_time = $3',
      [freshTenant.tenantId, resourceId, start.toISOString()]
    );

    const ins = await pool.query(
      `INSERT INTO appointments (tenant_id, resource_id, customer_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
       RETURNING appointment_id`,
      [
        freshTenant.tenantId,
        resourceId,
        fixtureCustomerId,
        start.toISOString(),
        end.toISOString(),
        `${tag}-cross-view-cancel`,
      ]
    );
    apptId = ins.rows[0].appointment_id;

    await ensureLoggedIn(page);
    await switchToTestTenant(page);

    await page
      .getByRole('tab', { name: /^Schedule$/ })
      .first()
      .click();
    // Wait for NewSchedulerView (default staff sub-tab) to mount so that
    // day-mode-list is in the DOM before we try to click it.
    await expect(page.getByTestId('day-mode-list')).toBeVisible({ timeout: 8000 });

    // List sub-tab — a flat list of appointments, easiest to locate by tag.
    await page.getByTestId('day-mode-list').click();
    // The resources/list header (with the Refresh button) mounts after the view
    // switch. Wait for that button — it's present regardless of appointment count,
    // unlike appointment-list-view which is only rendered when sorted.length > 0.
    const refreshBtn = page.getByRole('button', { name: /Refresh/i }).first();
    await expect(refreshBtn).toBeVisible({ timeout: 8000 });

    // Trigger an explicit refresh so a just-inserted row (manual SQL) is guaranteed
    // to be in the current useSchedulerData response for the selected date.
    await refreshBtn.click();
    // Wait for the refresh network request to complete.
    await page.waitForLoadState('networkidle');

    // Find the row by appointment id (List view exposes
    // data-testid="list-item-${id}"). More reliable than text matching
    // since the tag also appears in screenshots / status comments.
    const row = page.getByTestId(`list-item-${apptId}`);
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.click();

    // Popover opens with the Cancel button.
    const cancelBtn = page.getByTestId('appointment-popover-cancel');
    await expect(cancelBtn).toBeVisible({ timeout: 5000 });

    // The popover cancel path now uses the custom ConfirmModal (not native window.confirm).
    // Click the danger button inside the modal (label matches handlePopoverCancel).
    const cancelResponsePromise = page.waitForResponse(
      (res) => res.url().includes('/appointments/') && res.url().includes('/cancel')
    );
    await cancelBtn.click();

    // The app opens its own ConfirmModal with this exact label.
    const confirmBtn = page.getByRole('button', { name: /Cancel appointment/i }).first();
    await expect(confirmBtn).toBeVisible({ timeout: 5000 });
    await confirmBtn.click();

    await cancelResponsePromise;
    await page.waitForTimeout(400); // brief settle for DB visibility in the subsequent SELECT

    // DB row is soft-canceled (still exists, status='canceled').
    const after = await pool.query(`SELECT status FROM appointments WHERE appointment_id = $1`, [
      apptId,
    ]);
    expect(after.rowCount, 'row must still exist (soft cancel, not hard delete)').toBe(1);
    expect(after.rows[0].status).toBe('canceled');
  } finally {
    if (apptId) {
      await pool.query('DELETE FROM appointments WHERE appointment_id = $1', [apptId]);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Soft-cancel frees the slot for re-booking
// ────────────────────────────────────────────────────────────────────────────
test('cancel-frees-slot: a canceled appointment does not block re-booking the same resource+time', async ({
  page,
}) => {
  // WHO: front-desk operator who canceled a booking and wants to reuse the slot
  // WHAT: book A → cancel A → book B at the same resource+time → B
  //        succeeds (the GiST resource-overlap exclusion treats canceled
  //        rows as not-blocking, since the route filters status='scheduled')
  // WHEN: the operational rebook-after-cancel pattern
  // WHERE: book_appointment_atomic resource-overlap pre-check + the
  //        appointments_no_resource_overlap exclusion constraint
  // WHY: the user's underlying concern was "after I cancel, is the slot
  //        actually freed?" The answer must be yes — if the canceled row
  //        kept the slot occupied, soft-cancel would be worse than the
  //        old hard-delete it replaced. This pins both the DB-level
  //        behavior (canceled row exists, doesn't block) and the route's
  //        active-only filter
  const tag = uniqueTag();
  const ids: string[] = [];

  try {
    const start = new Date();
    start.setDate(start.getDate() + 50);
    start.setHours(15, 0, 0, 0);
    const end = new Date(start);
    end.setMinutes(start.getMinutes() + 60);

    // Book A directly via INSERT (avoids RPC-level skill checks for setup
    // simplicity — we're testing the slot-freeing behavior, not the skill
    // gate which test 2 already covers).
    const insA = await pool.query(
      `INSERT INTO appointments (tenant_id, resource_id, customer_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
       RETURNING appointment_id`,
      [
        freshTenant.tenantId,
        resourceId,
        fixtureCustomerId,
        start.toISOString(),
        end.toISOString(),
        `${tag}-A`,
      ]
    );
    ids.push(insA.rows[0].appointment_id);

    await page.goto('/dashboard');
    await ensureLoggedIn(page);
    const token = await getApiToken(page);

    // Cancel A via the production API path.
    const cancelRes = await page.evaluate(
      async ({ tok, id, tenantId, backendUrl }) => {
        const res = await fetch(`${backendUrl}/appointments/${id}/cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tok}`,
          },
          body: JSON.stringify({ tenant_id: tenantId }),
        });
        return { status: res.status, body: await res.json() };
      },
      {
        tok: token,
        id: insA.rows[0].appointment_id,
        tenantId: freshTenant.tenantId,
        backendUrl: BACKEND_URL,
      }
    );
    expect(cancelRes.status, `cancel must succeed; body=${JSON.stringify(cancelRes.body)}`).toBe(
      200
    );

    // Book B at the same resource+time via /appointments/create. Without
    // the route's status='scheduled' filter the GiST exclusion would
    // reject the overlap. With it, B's INSERT lands cleanly.
    const bookRes = await page.evaluate(
      async ({ tok, payload, backendUrl }) => {
        const res = await fetch(`${backendUrl}/appointments/create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tok}`,
          },
          body: JSON.stringify(payload),
        });
        return { status: res.status, body: await res.json() };
      },
      {
        tok: token,
        backendUrl: BACKEND_URL,
        payload: {
          tenant_id: freshTenant.tenantId,
          resource_id: resourceId,
          customer_id: fixtureCustomerId,
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          description: `${tag}-B`,
        },
      }
    );

    expect(bookRes.status, `re-booking must succeed; body=${JSON.stringify(bookRes.body)}`).toBe(
      200
    );
    expect(bookRes.body?.success).toBe(true);
    expect(bookRes.body?.appointment_id).toBeTruthy();
    ids.push(bookRes.body.appointment_id as string);

    // Both rows exist: A canceled, B scheduled.
    const verify = await pool.query(
      `SELECT appointment_id, status, description FROM appointments
        WHERE tenant_id = $1 AND start_time = $2
        ORDER BY description`,
      [freshTenant.tenantId, start.toISOString()]
    );
    expect(verify.rowCount).toBe(2);
    const a = verify.rows.find((r) => r.description.endsWith('-A'));
    const b = verify.rows.find((r) => r.description.endsWith('-B'));
    expect(a?.status).toBe('canceled');
    expect(b?.status).toBe('scheduled');
  } finally {
    for (const id of ids) {
      await pool.query('DELETE FROM appointments WHERE appointment_id = $1', [id]);
    }
  }
});
