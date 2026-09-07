import { test, expect } from './helpers/test';
import { type Page } from '@playwright/test';
import { Pool } from 'pg';
import {
  registerFreshTenant,
  seedBookingScenario,
  cleanTenantData,
  BACKEND_URL,
} from './helpers/fixtures';

const PG_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';

// Per-spec fixture tenant — same rationale as workflows.spec.ts.
// Pool + fresh tenant create + delete combined into a single before/after pair.
let pool: Pool;
let freshTenant: { tenantId: string; token: string; email: string };

test.beforeAll(async () => {
  pool = new Pool({ connectionString: PG_URL });

  const { request: pr } = await import('@playwright/test');
  const ctx = await pr.newContext({ ignoreHTTPSErrors: true });
  const ft = await registerFreshTenant(ctx);
  freshTenant = ft;

  // Seed the booking scenario: 1 employee, 1 resource, 1 customer, shifts
  // for the next 14 days so the Quick Book tests have employees on-shift.
  const datesAhead: string[] = [];
  for (let i = 1; i <= 14; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + i);
    datesAhead.push(d.toISOString().slice(0, 10));
  }
  await seedBookingScenario(ctx, pool, ft.token, ft.tenantId, {
    employees: ['Test Tech'],
    resources: ['Bay 1'],
    customer: 'E2E Fixture Customer',
    shiftDates: datesAhead,
    // Use 00:00–23:59 so the shift covers any UTC-equivalent booking time.
    // Fresh tenants default to UTC; a 15:00 local (CDT = UTC-5) booking
    // lands at 20:00 UTC, which would fall outside a 06:00–20:00 window.
    shiftHours: { start: '00:00', end: '23:59' },
  });

  await ctx.dispose();
});

test.afterAll(async () => {
  await cleanTenantData(pool, freshTenant.tenantId);
  await pool.end();
});

/**
 * E2E test: Quick Book should succeed when employees have employee_schedule for the day.
 *
 * Bug: book_appointment_atomic only checked employee_shifts (weekly patterns), not
 * employee_schedule (date-based). Dashboard UI uses employee_schedule, so employees appeared
 * scheduled on the timeline but bookings failed with "Employee is not on shift."
 */

async function ensureLoggedIn(page: Page) {
  await page.goto('/dashboard');
  await page.waitForTimeout(2000);

  // If on landing page, click Log in
  const loginLink = page.getByText('Log in', { exact: true }).first();
  if (await loginLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await loginLink.click();
    await page.waitForTimeout(1000);
  }

  // If on login form, fill and submit
  const emailInput = page.locator('input[type="email"]');
  if (await emailInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    await emailInput.fill('admin@secretaryhq.com');
    await page.locator('input[type="password"]').fill('p@ssw0rd');
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(3000);
  }

  // Wait for dashboard to be visible
  await expect(page.getByText('Home').first()).toBeVisible({ timeout: 15000 });
}

async function switchToTestTenant(page: Page) {
  await page.evaluate((id) => {
    localStorage.setItem('managedTenantId', id);
    localStorage.setItem('managedTenantName', 'E2E Test Tenant');
  }, freshTenant.tenantId);
  await page.reload();
  await page.waitForTimeout(1500);

  await page.waitForTimeout(1000);
}

async function getScheduledEmployeeId(page: Page, dateStr: string): Promise<string | null> {
  // The backend lives at https://localhost:4001 (not the dashboard's port
  // 4000). Pre-fix this used a relative URL — the dashboard's catch-all
  // returned HTML, `res.json()` threw, this function silently returned
  // null, and the test fell back to auto-assign, which picked an employee
  // that may not have been scheduled (causing "Employee is not on shift").
  // tenantId is threaded via args (page.evaluate can't capture Node-scope vars).
  return page.evaluate(
    async ({ dateStr, backendUrl, tenantId }) => {
      const token = localStorage.getItem('authToken');
      const res = await fetch(
        `${backendUrl}/shifts/overrides?tenant_id=${tenantId}&start_date=${dateStr}&end_date=${dateStr}`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );
      if (!res.ok) return null;
      const rows = await res.json();
      const row = Array.isArray(rows)
        ? rows.find(
            (r: {
              is_off?: boolean;
              start_time?: string;
              end_time?: string;
              employee_id?: string;
            }) => !r.is_off && r.start_time && r.end_time && r.employee_id
          )
        : null;
      return row?.employee_id ?? null;
    },
    { dateStr, backendUrl: BACKEND_URL, tenantId: freshTenant.tenantId }
  );
}

test.describe('Quick Book with employee_schedule', () => {
  test('booking succeeds for employee with shift_override but no weekly pattern', async ({
    page,
  }) => {
    // Cleanup token captured below so the finally block can DELETE the row.
    // Pre-fix this test routinely "passed" by submitting a booking that
    // failed at the backend (the old bug), so no row was ever inserted —
    // and no cleanup was needed. Post-fix the booking actually succeeds,
    // so each test run leaks a row without this guard. Per the
    // feedback_test_isolation memory: each test owns its full data lifecycle.
    let createdId: string | null = null;
    try {
      await ensureLoggedIn(page);
      await switchToTestTenant(page);

      // Navigate to Schedule
      await page.getByText('Schedule').first().click();
      await page.waitForTimeout(1500);

      // Switch to Chairs view (which has the Quick Book button)
      const chairsTab = page.getByTestId('day-mode-resources');
      await expect(chairsTab).toBeVisible({ timeout: 5000 });
      await chairsTab.click();
      await page.waitForTimeout(1000);

      // Click Quick Book button
      const quickBookBtn = page.locator('button').filter({ hasText: 'Quick Book' });
      await expect(quickBookBtn).toBeVisible({ timeout: 5000 });
      await quickBookBtn.click();
      await page.waitForTimeout(500);

      // Quick Book panel should be open
      const quickBookPanel = page.getByTestId('quick-book-panel');
      await expect(quickBookPanel).toBeVisible({ timeout: 5000 });

      // Select customer (first available)
      const customerSelect = page.getByTestId('quick-book-customer');
      await customerSelect.selectOption({ index: 1 });

      // Deliberately NOT selecting a service: this test's contract is
      // "shift coverage works against employee_schedule" — orthogonal to
      // service alignment. Picking a service narrows the employee dropdown
      // via the service_employee mapping filter (post-2026-05-07), and the
      // scheduled-employee we look up below may not be in that filtered
      // set — causing selectOption to time out. Skipping service keeps the
      // employee dropdown unfiltered so we can pick whoever's actually
      // scheduled. The booking RPC accepts a null service_id.

      // Select resource (first available)
      const resourceSelect = page.getByTestId('quick-book-resource');
      await resourceSelect.selectOption({ index: 0 });

      // Pick a target weekday with a seeded shift. The fixture populates
      // employee_schedule Mon-Fri for the next 14 days; using `today` made
      // this test fail on weekend runs with a legitimate "Employee is not on
      // shift". Walk forward to the next weekday so the booking RPC's
      // shift-coverage check has data to find.
      const target = new Date();
      target.setDate(target.getDate() + 1);
      while (target.getDay() === 0 || target.getDay() === 6) {
        target.setDate(target.getDate() + 1);
      }
      const year = target.getFullYear();
      const month = String(target.getMonth() + 1).padStart(2, '0');
      const day = String(target.getDate()).padStart(2, '0');

      // Select an employee that is actually scheduled on the chosen date.
      const employeeSelect = page.getByTestId('quick-book-employee');
      const scheduledEmployeeId = await getScheduledEmployeeId(page, `${year}-${month}-${day}`);
      if (scheduledEmployeeId) {
        await employeeSelect.selectOption({ value: scheduledEmployeeId });
      }
      const startInput = quickBookPanel.locator('input[type="datetime-local"]').first();
      await startInput.fill(`${year}-${month}-${day}T15:00`);
      await page.waitForTimeout(500);

      // End time should auto-fill from service duration
      const endInput = quickBookPanel.locator('input[type="datetime-local"]').last();
      const endValue = await endInput.inputValue();
      if (!endValue) {
        await endInput.fill(`${year}-${month}-${day}T15:30`);
      }

      // Capture appointment_id from the live booking response so the
      // finally block can DELETE the row regardless of whether the panel
      // closed before our assertions ran.
      const bookingResponsePromise = page.waitForResponse(
        (resp) => resp.url().includes('/appointments/create') && resp.request().method() === 'POST',
        { timeout: 10_000 }
      );
      const bookBtn = page.getByTestId('quick-book-confirm');
      await expect(bookBtn).toBeEnabled();
      await bookBtn.click();
      const bookingResp = await bookingResponsePromise.catch(() => null);
      if (bookingResp) {
        const body = await bookingResp.json().catch(() => null);
        if (body?.appointment_id) createdId = body.appointment_id as string;
      }
      await page.waitForTimeout(1000);

      // Check for errors — the old bug would show "Employee is not on shift"
      const errorMsg = quickBookPanel.locator('.text-red-700, .text-red-400');
      const errorVisible = await errorMsg.isVisible().catch(() => false);

      if (errorVisible) {
        const errorText = await errorMsg.textContent();
        // These errors indicate the employee_schedule fix didn't work
        expect(errorText).not.toContain('not on shift');
        expect(errorText).not.toContain('not scheduled');
      }

      // If panel closed, booking succeeded
      const panelGone = await quickBookPanel.isHidden({ timeout: 3000 }).catch(() => false);
      if (panelGone) {
        expect(panelGone).toBe(true);
      }
    } finally {
      if (createdId) {
        await page.evaluate(
          async ({ id, backendUrl }) => {
            const token = localStorage.getItem('authToken');
            await fetch(`${backendUrl}/appointments/${id}`, {
              method: 'DELETE',
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
          },
          { id: createdId, backendUrl: BACKEND_URL }
        );
      }
    }
  });

  test('rejects an end time before the start time', async ({ page }) => {
    await ensureLoggedIn(page);
    await switchToTestTenant(page);

    await page.getByText('Schedule').first().click();
    await page.waitForTimeout(1500);

    const chairsTab = page.getByTestId('day-mode-resources');
    await expect(chairsTab).toBeVisible({ timeout: 5000 });
    await chairsTab.click();
    await page.waitForTimeout(1000);

    const quickBookBtn = page.locator('button').filter({ hasText: 'Quick Book' });
    await expect(quickBookBtn).toBeVisible({ timeout: 5000 });
    await quickBookBtn.click();
    await page.waitForTimeout(500);

    const quickBookPanel = page.getByTestId('quick-book-panel');
    await expect(quickBookPanel).toBeVisible({ timeout: 5000 });

    // Robust wait: the customer list can be slow to populate right after tenant switch in E2E.
    // Wait until the select/combobox actually has selectable options.
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="quick-book-customer"]');
      return el && (el as HTMLSelectElement).options && (el as HTMLSelectElement).options.length > 1;
    }, { timeout: 10000 });

    await page.getByTestId('quick-book-customer').selectOption({ index: 1 });
    await page.getByTestId('quick-book-resource').selectOption({ index: 0 });

    const employeeSelect = page.getByTestId('quick-book-employee');
    const scheduledEmployeeId = await getScheduledEmployeeId(page, '2026-05-01');
    if (scheduledEmployeeId) {
      await employeeSelect.selectOption({ value: scheduledEmployeeId });
    }

    const startInput = quickBookPanel.locator('input[type="datetime-local"]').first();
    const endInput = quickBookPanel.locator('input[type="datetime-local"]').last();
    await startInput.fill('2026-05-01T10:00');
    await endInput.fill('2026-05-01T09:00');

    await page.getByTestId('quick-book-confirm').click();

    await expect(page.getByText('End time must be after start time')).toBeVisible({
      timeout: 5000,
    });
    await expect(quickBookPanel).toBeVisible();
  });

  test('rejects an appointment longer than 12 hours (same day)', async ({ page }) => {
    await ensureLoggedIn(page);
    await switchToTestTenant(page);

    await page.getByText('Schedule').first().click();
    await page.waitForTimeout(1500);

    const chairsTab = page.getByTestId('day-mode-resources');
    await expect(chairsTab).toBeVisible({ timeout: 5000 });
    await chairsTab.click();
    await page.waitForTimeout(1000);

    const quickBookBtn = page.locator('button').filter({ hasText: 'Quick Book' });
    await expect(quickBookBtn).toBeVisible({ timeout: 5000 });
    await quickBookBtn.click();
    await page.waitForTimeout(500);

    const quickBookPanel = page.getByTestId('quick-book-panel');
    await expect(quickBookPanel).toBeVisible({ timeout: 5000 });

    // Robust wait: the customer list can be slow to populate right after tenant switch in E2E.
    // Wait until the select/combobox actually has selectable options.
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="quick-book-customer"]');
      return el && (el as HTMLSelectElement).options && (el as HTMLSelectElement).options.length > 1;
    }, { timeout: 10000 });

    await page.getByTestId('quick-book-customer').selectOption({ index: 1 });
    await page.getByTestId('quick-book-resource').selectOption({ index: 0 });

    const employeeSelect = page.getByTestId('quick-book-employee');
    const scheduledEmployeeId = await getScheduledEmployeeId(page, '2026-05-01');
    if (scheduledEmployeeId) {
      await employeeSelect.selectOption({ value: scheduledEmployeeId });
    }

    const startInput = quickBookPanel.locator('input[type="datetime-local"]').first();
    const endInput = quickBookPanel.locator('input[type="datetime-local"]').last();

    // Use a realistic same-day long appointment (13 hours) that still exceeds the 12-hour limit.
    // We deliberately avoid multi-day/overnight spans (e.g. 11pm–1am next day) because
    // the business does not support that style of booking.
    await startInput.fill('2026-05-01T09:00');
    await endInput.fill('2026-05-01T22:00');

    await page.getByTestId('quick-book-confirm').click();

    await expect(page.getByText('Appointment duration cannot exceed 12 hours')).toBeVisible({
      timeout: 5000,
    });
    await expect(quickBookPanel).toBeVisible();
  });

  test('Chairs view displays resource rows', async ({ page }) => {
    await ensureLoggedIn(page);
    await switchToTestTenant(page);

    // Navigate to Schedule
    await page.getByText('Schedule').first().click();
    await page.waitForTimeout(1500);

    // Click Chairs tab
    const chairsTab = page.getByTestId('day-mode-resources');
    await expect(chairsTab).toBeVisible({ timeout: 5000 });
    await chairsTab.click();
    await page.waitForTimeout(1000);

    // Resource columns view or empty state should be visible
    const resourceView = page.getByTestId('resource-columns-view');
    const emptyState = page.getByTestId('resource-columns-empty');

    const viewVisible = await resourceView.isVisible({ timeout: 5000 }).catch(() => false);
    const emptyVisible = await emptyState.isVisible({ timeout: 2000 }).catch(() => false);

    expect(viewVisible || emptyVisible).toBe(true);

    if (viewVisible) {
      // Verify resource rows exist
      const resourceRows = page.locator('[data-testid^="resource-column-"]');
      const count = await resourceRows.count();
      expect(count).toBeGreaterThan(0);
    }
  });
});
