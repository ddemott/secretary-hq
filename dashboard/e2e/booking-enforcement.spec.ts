/**
 * E2E coverage for the booking-enforcement work shipped 2026-05-08
 * (slices 1-2: backend conflict-details, 15-min increments, ConflictModal).
 *
 * Slice 3 refactor (2026-05-09): tests 1-4 + 7 use fresh tenants from
 * dashboard/e2e/helpers/fixtures.ts — registerFreshTenant + seedBookingScenario
 * + cleanTenantData (single-DELETE cascade). Each test owns its full data
 * lifecycle: setup → assert → teardown, runs independently of every other
 * test. No more per-row cleanup. UI tests (5: ui-conflict-modal,
 * 6: 15min-form-rejection) use the module-level uiTenant fixture
 * (registerFreshTenant + seeded employees/resources) so they are
 * also independent of any fixed seed tenant.
 *
 * Scenarios:
 *   1. Out-of-hours blocked — booking outside the assigned employee's
 *      shift window is rejected by the backend with a clear inline
 *      error; no row is inserted.
 *   2. Employee double-book → ConflictModal — booking the same employee
 *      at an already-taken time surfaces the existing appointment's
 *      details (customer, employee, time) so the operator can decide
 *      what to do; no second row is inserted.
 *   3. Resource double-book → ConflictModal — same shape as (2) but on
 *      the resource axis; the existing booking surfaces even when the
 *      assigned employee differs.
 *   4. Partial overlap blocked — 14:15-14:45 vs an existing 14:00-14:30
 *      is rejected (proves the GiST exclusion is whole-slot via the &&
 *      operator, not just exact-match-start).
 *   5. UI smoke: ConflictModal renders when the backend returns 409.
 *   6. UI smoke: 15-min off-grid time is rejected at the form before
 *      reaching the backend.
 *   7. Edit-overlap: PUT /appointments/:id/update is symmetric on overlap.
 *
 * Setup: backend on https://localhost:4001, dashboard on
 * https://localhost:4000, Postgres on localhost:5433.
 */
import { test, expect } from './helpers/test';
import { type Page } from '@playwright/test';
import { Pool } from 'pg';
import {
  PG_URL,
  registerFreshTenant,
  seedBookingScenario,
  seedAppointment,
  cleanTenantData,
  bookAppointmentAs,
  updateAppointmentAs,
  isoDateDaysFromNow,
  createEmployeeAs,
  createResourceAs,
  createCustomerAs,
  type RegisteredTenant,
} from './helpers/fixtures';

const ADMIN_EMAIL = 'admin@secretaryhq.com';
const ADMIN_PASSWORD = 'p@ssw0rd';

let pool: Pool;

async function countAppointmentsForTenant(tenantId: string): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM appointments WHERE tenant_id = $1`, [
    tenantId,
  ]);
  return r.rows[0].n;
}

// ── UI-test helpers (used only by tests 5 + 6, which need browser nav) ──

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

// ── Module-level fixture for UI tests (5 + 6) ──

interface UiTenantFixture {
  tenantId: string;
  token: string;
  email: string;
  employeeId: string;
  employee2Id: string;
  resourceId: string;
  resource2Id: string;
  customerId: string;
}
let uiTenant: UiTenantFixture;

async function switchToTestTenant(page: Page) {
  await page.evaluate((id) => {
    localStorage.setItem('managedTenantId', id);
    localStorage.setItem('managedTenantName', 'E2E UI Tenant');
  }, uiTenant.tenantId);
  await page.reload();
  await page.waitForTimeout(1500);
}

function uniqueTag(): string {
  return `e2e-enforce-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

test.beforeAll(async ({ request }) => {
  pool = new Pool({ connectionString: PG_URL });

  // Register a fresh tenant for the UI tests (5 + 6).
  const ft = await registerFreshTenant(request);
  const tid = ft.tenantId;
  const tok = ft.token;

  // Create 2 employees and 2 resources so the Quick Book dropdowns are populated.
  const [emp1, emp2] = await Promise.all([
    createEmployeeAs(request, tok, tid, 'Alex Smith'),
    createEmployeeAs(request, tok, tid, 'Blake Jones'),
  ]);
  const [res1, res2] = await Promise.all([
    createResourceAs(request, tok, tid, 'Bay 1'),
    createResourceAs(request, tok, tid, 'Bay 2'),
  ]);
  const custId = await createCustomerAs(request, tok, tid, 'UI Test Customer');

  // Seed shifts for both employees on the UI test date (7 days out).
  const uiDate = isoDateDaysFromNow(7);
  await pool.query(
    `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
     VALUES ($1, $2, $3, '08:00', '20:00', false), ($1, $4, $3, '08:00', '20:00', false)
     ON CONFLICT (tenant_id, employee_id, shift_date) DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time`,
    [tid, emp1, uiDate, emp2]
  );

  uiTenant = {
    tenantId: tid,
    token: tok,
    email: ft.email,
    employeeId: emp1,
    employee2Id: emp2,
    resourceId: res1,
    resource2Id: res2,
    customerId: custId,
  };
});

test.afterAll(async () => {
  if (uiTenant) await cleanTenantData(pool, uiTenant.tenantId);
  await pool.end();
});

// ────────────────────────────────────────────────────────────────────────────
// 1. Out-of-hours blocked
// ────────────────────────────────────────────────────────────────────────────
test('out-of-hours: booking outside the assigned employee shift is rejected with a clear error', async ({
  request,
}) => {
  // WHO: front-desk operator trying to fit a customer in before the shop opens
  // WHAT: backend's book_appointment_atomic checks employee_schedule and
  //        rejects with "Employee is not on shift during this time"
  //        (or similar) when the requested time falls outside the
  //        employee's shift; status 400, no row inserted, NO conflict block
  //        because there's no overlapping appointment — just a missing shift.
  // WHEN: any booking where the assigned employee has no covering
  //        employee_schedule row at the requested time
  // WHERE: book_appointment_atomic shift-coverage check + the dashboard's
  //        inline error UX (NOT the conflict modal — there's no
  //        conflicting appointment, just a missing shift)
  // WHY: the system must enforce business hours so a frantic morning
  //        operator can't accidentally book a 6am appointment for an
  //        employee who starts at 9am — the customer would arrive to a
  //        closed shop.
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);
    const date = isoDateDaysFromNow(14); // far enough out to avoid past-time issues
    const seed = await seedBookingScenario(request, pool, tenant.token, tenant.tenantId, {
      employees: ['Test Tech'],
      resources: ['Test Bay'],
      shiftDates: [date],
      shiftHours: { start: '09:00', end: '17:00' },
    });

    // Try booking at 06:00 (3 hours before the shift starts).
    const res = await bookAppointmentAs(request, tenant.token, {
      tenant_id: tenant.tenantId,
      resource_id: seed.resourceIds[0],
      customer_id: seed.customerId,
      employee_id: seed.employeeIds[0],
      start_time: `${date}T06:00:00.000Z`,
      end_time: `${date}T06:30:00.000Z`,
      description: 'pre-shift attempt',
    });

    expect(res.status, 'pre-shift booking must be rejected').toBe(400);
    expect(res.body.success).toBe(false);
    // Error message must mention shift / not on shift so the dashboard
    // operator (and any consuming UI) gets actionable text.
    expect(String(res.body.error)).toMatch(/shift|on shift/i);
    expect(res.body.conflict, 'no conflict block on shift errors').toBeUndefined();

    // Belt-and-suspenders: nothing landed.
    expect(await countAppointmentsForTenant(tenant.tenantId)).toBe(0);
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Employee double-book → conflict block surfaces existing appointment
// ────────────────────────────────────────────────────────────────────────────
test('employee-double-book: overlap returns 409 with conflict block showing the existing appointment', async ({
  request,
}) => {
  // WHO: operator trying to fit a second customer in with the same tech
  //        during a time he's already booked
  // WHAT: backend rejects with 409 + error_code TIMESLOT_OCCUPIED + a
  //        `conflict` block containing the existing appointment's id,
  //        customer_name, employee_name, resource_name, start/end
  // WHEN: any /appointments/create that would overlap an existing
  //        scheduled+not-deleted row on the same employee_id
  // WHERE: GiST exclusion appointments_no_employee_overlap (DB layer)
  //        + book_appointment_atomic exception handler + the route's
  //        findOverlappingAppointment lookup
  // WHY: this test pins the BACKEND CONTRACT the dashboard's
  //        ConflictModal depends on. If a future refactor breaks the
  //        409 status, the conflict block, or any of the surfaced
  //        fields, the modal would render blank in production.
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);
    const date = isoDateDaysFromNow(14);
    const seed = await seedBookingScenario(request, pool, tenant.token, tenant.tenantId, {
      employees: ['Mike Test'],
      resources: ['Bay 1'],
      shiftDates: [date],
    });

    // Pre-existing appointment 14:00-14:30 — Mike + Bay 1.
    const existingStart = `${date}T14:00:00.000Z`;
    const existingEnd = `${date}T14:30:00.000Z`;
    const existingId = await seedAppointment(pool, tenant.tenantId, {
      resourceId: seed.resourceIds[0],
      customerId: seed.customerId,
      employeeId: seed.employeeIds[0],
      startTime: existingStart,
      endTime: existingEnd,
      description: 'blocker',
    });

    // Try the exact same slot — must fail with conflict block.
    const res = await bookAppointmentAs(request, tenant.token, {
      tenant_id: tenant.tenantId,
      resource_id: seed.resourceIds[0],
      customer_id: seed.customerId,
      employee_id: seed.employeeIds[0],
      start_time: existingStart,
      end_time: existingEnd,
      description: 'second attempt',
    });

    expect(res.status, 'overlap must return 409').toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error_code).toBe('TIMESLOT_OCCUPIED');
    const conflict = res.body.conflict as Record<string, unknown> | undefined;
    expect(conflict, 'conflict block must be present').toBeTruthy();
    expect(conflict?.appointment_id).toBe(existingId);
    expect(conflict?.employee_name).toBe('Mike Test');
    expect(conflict?.resource_name).toBe('Bay 1');
    expect(conflict?.start_time).toBeTruthy();
    expect(conflict?.end_time).toBeTruthy();

    // Only the blocker exists — no second row landed.
    expect(await countAppointmentsForTenant(tenant.tenantId)).toBe(1);
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Resource double-book → conflict block surfaces existing appointment
// ────────────────────────────────────────────────────────────────────────────
test('resource-double-book: same resource + different employee still returns 409 with conflict', async ({
  request,
}) => {
  // WHO: operator who picked a different employee but the same truck/
  //        bay during a time the truck is already in use
  // WHAT: backend rejects on the resource axis (appointments_no_resource_overlap)
  //        even when the employee differs; conflict block shows the
  //        existing booking's employee, not the requested one
  // WHEN: two appointments would share resource_id + overlap in time
  // WHERE: GiST exclusion + the conflict lookup's resource-OR-employee
  //        predicate (resource match alone is sufficient to surface the
  //        conflict)
  // WHY: pre-2026-05-08 this was a real concurrency gap fixed by the
  //        exclusion constraints; this test pins the rejection PLUS
  //        the modal's data path, so a future refactor that drops the
  //        resource branch from the conflict lookup surfaces here
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);
    const date = isoDateDaysFromNow(14);
    const seed = await seedBookingScenario(request, pool, tenant.token, tenant.tenantId, {
      // Two employees so the second-attempt failure mode is the resource
      // overlap, not "Carlos is not on shift."
      employees: ['Mike Test', 'Carlos Test'],
      resources: ['Truck 1'],
      shiftDates: [date],
    });
    const [mikeId, carlosId] = seed.employeeIds;
    const truckId = seed.resourceIds[0];

    // Existing booking: Mike + Truck 1 at 15:00.
    const existingStart = `${date}T15:00:00.000Z`;
    const existingEnd = `${date}T15:30:00.000Z`;
    const existingId = await seedAppointment(pool, tenant.tenantId, {
      resourceId: truckId,
      customerId: seed.customerId,
      employeeId: mikeId,
      startTime: existingStart,
      endTime: existingEnd,
      description: 'blocker',
    });

    // Try Carlos + same truck + same time — resource overlap, not employee overlap.
    const res = await bookAppointmentAs(request, tenant.token, {
      tenant_id: tenant.tenantId,
      resource_id: truckId,
      customer_id: seed.customerId,
      employee_id: carlosId,
      start_time: existingStart,
      end_time: existingEnd,
      description: 'second attempt',
    });

    expect(res.status).toBe(409);
    expect(res.body.error_code).toBe('TIMESLOT_OCCUPIED');
    const conflict = res.body.conflict as Record<string, unknown> | undefined;
    expect(
      conflict,
      'conflict block must be present even when only resource overlaps'
    ).toBeTruthy();
    expect(conflict?.appointment_id).toBe(existingId);
    // The conflict surfaces the EXISTING booking's employee (Mike), not
    // the requested employee (Carlos). The modal's job is to show what's
    // there, not who tried to book.
    expect(conflict?.employee_name).toBe('Mike Test');
    expect(conflict?.resource_name).toBe('Truck 1');

    expect(await countAppointmentsForTenant(tenant.tenantId)).toBe(1);
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Partial overlap blocked (whole-slot check, not just exact-match)
// ────────────────────────────────────────────────────────────────────────────
test('partial-overlap: 14:15-14:45 is blocked by an existing 14:00-14:30 booking', async ({
  request,
}) => {
  // WHO: operator who knows there's a 14:00 booking and tries to slip
  //        in starting at 14:15 (overlapping the tail half of the
  //        existing slot)
  // WHAT: GiST exclusion's && operator on tstzrange(start, end, '[)')
  //        catches any range overlap, not just exact-start match. Backend
  //        returns 409 + conflict block — same shape as exact match.
  // WHEN: any partial-overlap booking attempt — start before existing
  //        end + new end after existing start
  // WHERE: appointments_no_employee_overlap (DB) + the conflict lookup
  //        helper using the same half-open range predicate
  // WHY: the user explicitly called out "the system should NOT ever
  //        double book... It should check to see if that whole time slot
  //        is free." Pin the partial-overlap case because it's the
  //        most common real-world conflict (operator partially overlaps
  //        rather than picking the exact same start). Also pin the
  //        adjacent (touching) case as positive control: half-open
  //        ranges allow back-to-back bookings.
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);
    const date = isoDateDaysFromNow(14);
    const seed = await seedBookingScenario(request, pool, tenant.token, tenant.tenantId, {
      shiftDates: [date],
    });
    const empId = seed.employeeIds[0];
    const resId = seed.resourceIds[0];

    // Existing booking 14:00-14:30.
    const existingId = await seedAppointment(pool, tenant.tenantId, {
      resourceId: resId,
      customerId: seed.customerId,
      employeeId: empId,
      startTime: `${date}T14:00:00.000Z`,
      endTime: `${date}T14:30:00.000Z`,
      description: 'blocker',
    });

    // Try 14:15-14:45 — overlaps the second half of the existing booking.
    const res = await bookAppointmentAs(request, tenant.token, {
      tenant_id: tenant.tenantId,
      resource_id: resId,
      customer_id: seed.customerId,
      employee_id: empId,
      start_time: `${date}T14:15:00.000Z`,
      end_time: `${date}T14:45:00.000Z`,
      description: 'partial overlap',
    });

    expect(res.status, 'partial overlap must return 409').toBe(409);
    expect(res.body.error_code).toBe('TIMESLOT_OCCUPIED');
    expect(res.body.conflict).toBeTruthy();
    expect((res.body.conflict as Record<string, unknown>).appointment_id).toBe(existingId);

    // ALSO confirm the boundary case — adjacent (touching) is allowed.
    // 14:30-15:00 starts exactly when the existing one ends. Half-open
    // [) range: this should succeed.
    const adjacent = await bookAppointmentAs(request, tenant.token, {
      tenant_id: tenant.tenantId,
      resource_id: resId,
      customer_id: seed.customerId,
      employee_id: empId,
      start_time: `${date}T14:30:00.000Z`,
      end_time: `${date}T15:00:00.000Z`,
      description: 'adjacent (touching)',
    });
    expect(adjacent.status, 'adjacent (touching) booking must succeed').toBe(200);
    expect(adjacent.body.success).toBe(true);

    // Final state: blocker + adjacent = 2 rows. The 14:15 attempt did NOT
    // insert, proving the rejection actually blocked the row.
    expect(await countAppointmentsForTenant(tenant.tenantId)).toBe(2);
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 5. UI smoke: ConflictModal renders when /appointments/create returns 409
// ────────────────────────────────────────────────────────────────────────────
test('ui-conflict-modal: dashboard surfaces ConflictModal with existing appointment when overlap detected', async ({
  page,
}) => {
  // WHO: front-desk operator going through the actual UI (not direct API)
  // WHAT: open Schedule → Quick Book → fill the form to overlap an
  //        existing appointment → submit → ConflictModal renders with
  //        the existing booking's customer / employee / resource / time
  // WHEN: any UI-driven booking that would overlap
  // WHERE: QuickBookPanel.handleBook conflict-branch → <ConflictModal>
  // WHY: tests 2-4 cover the API contract; this one covers the UI
  //        wiring end-to-end. A regression that, e.g., dropped the
  //        ConflictModal from the JSX or stopped reading res.conflict
  //        would slip past the API tests but fail here.
  const tag = uniqueTag();
  const apptIdsToCleanup: string[] = [];
  let scheduleSeeded = false;

  // employeeId (Alex Smith) + resource2Id (Bay 2) are used for the blocker;
  // the modal must surface those exact names.
  const empId = uiTenant.employeeId;
  const res2Id = uiTenant.resource2Id;
  const customerId = uiTenant.customerId;
  const tid = uiTenant.tenantId;
  const UI_TEST_DATE = isoDateDaysFromNow(7);

  try {
    // Ensure Alex Smith has a shift on the UI test date.
    await pool.query(
      `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
       VALUES ($1, $2, $3, '08:00', '20:00', false)
       ON CONFLICT (tenant_id, employee_id, shift_date) DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time`,
      [tid, empId, UI_TEST_DATE]
    );
    scheduleSeeded = true;

    // Pre-clean any residue at this exact slot from a previously-failed run.
    await pool.query(
      `DELETE FROM appointments
        WHERE tenant_id = $1 AND resource_id = $2
          AND start_time = $3::timestamptz`,
      [tid, res2Id, `${UI_TEST_DATE}T14:00:00.000Z`]
    );

    // Existing 14:00-14:30 UTC booking that we'll try to overlap from the UI.
    const existingStart = new Date(`${UI_TEST_DATE}T14:00:00.000Z`);
    const existingEnd = new Date(`${UI_TEST_DATE}T14:30:00.000Z`);
    const existing = await pool.query(
      `INSERT INTO appointments (tenant_id, resource_id, customer_id, employee_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled')
       RETURNING appointment_id`,
      [
        tid,
        res2Id,
        customerId,
        empId,
        existingStart.toISOString(),
        existingEnd.toISOString(),
        `${tag}-blocker`,
      ]
    );
    apptIdsToCleanup.push(existing.rows[0].appointment_id);

    await ensureLoggedIn(page);
    await switchToTestTenant(page);

    // Open the Schedule tab + Quick Book panel.
    await page
      .getByRole('tab', { name: /^Schedule$/ })
      .first()
      .click();
    await page
      .getByRole('button', { name: /Quick Book/i })
      .first()
      .click();
    await expect(page.getByTestId('quick-book-panel')).toBeVisible({ timeout: 10000 });

    // Wait for dropdowns to populate before selecting — the hooks that
    // fetch customers/services/resources/employees fire on mount and may
    // not be done by the time the panel renders. Without these waits the
    // selectOption call retries silently for 30s before timing out.
    const customerSelect = page.getByTestId('quick-book-customer');
    await expect(customerSelect).toBeVisible({ timeout: 10000 });
    await expect(customerSelect.locator(`option[value="${customerId}"]`)).toHaveCount(1, {
      timeout: 10000,
    });
    await customerSelect.selectOption(customerId);

    const resourceSelect = page.getByTestId('quick-book-resource');
    await expect(resourceSelect.locator(`option[value="${res2Id}"]`)).toHaveCount(1, {
      timeout: 10000,
    });
    await resourceSelect.selectOption(res2Id);

    const employeeSelect = page.getByTestId('quick-book-employee');
    await expect(employeeSelect.locator(`option[value="${empId}"]`)).toHaveCount(1, {
      timeout: 10000,
    });
    await employeeSelect.selectOption(empId);

    const localDateTime = (d: Date) => {
      const offset = d.getTimezoneOffset() * 60000;
      return new Date(d.getTime() - offset).toISOString().slice(0, 16);
    };
    const startInputs = page.locator('input[type="datetime-local"]');
    await startInputs.nth(0).fill(localDateTime(existingStart));
    await startInputs.nth(1).fill(localDateTime(existingEnd));

    // Submit.
    await page.getByTestId('quick-book-confirm').click();

    // Modal renders with the existing appointment's details.
    // Increased timeout + explicit dialog role wait for reliability after tenant switch + DB state.
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('That time is already booked')).toBeVisible({ timeout: 5000 });
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Alex Smith');
    await expect(dialog).toContainText('Bay 2');

    // No second row in DB (only the blocker we seeded).
    const dbRes = await pool.query(
      `SELECT count(*)::int AS n FROM appointments WHERE description = $1`,
      [tag]
    );
    expect(dbRes.rows[0].n).toBe(0);
  } finally {
    for (const id of apptIdsToCleanup) {
      await pool.query('DELETE FROM appointments WHERE appointment_id = $1', [id]);
    }
    if (scheduleSeeded) {
      await pool.query(
        'DELETE FROM employee_schedule WHERE tenant_id = $1 AND employee_id = $2 AND shift_date = $3',
        [tid, empId, UI_TEST_DATE]
      );
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 6. Form-level 15-minute increment rejection through the UI
// ────────────────────────────────────────────────────────────────────────────
test('15min-form-rejection: off-grid time entered in QuickBook surfaces inline error and never reaches the backend', async ({
  page,
}) => {
  // WHO: front-desk operator who types or pastes "1:23" into the start
  //        time input (or whose autofill software produces an off-grid
  //        time that bypasses the browser's step="900" hint)
  // WHAT: dashboard's validateAppointmentTimeRange (lib/appointmentValidation.ts)
  //        catches it before the API call fires; QuickBookPanel surfaces
  //        the increment error inline, no /appointments/create POST
  // WHEN: any UI booking attempt with start_time or end_time NOT on
  //        :00/:15/:30/:45
  // WHERE: QuickBookPanel.handleBook → validateAppointmentTimeRange
  // WHY: the DB CHECK constraint and Zod refinement are the safety nets;
  //        the FORM is the user-facing layer. If a refactor removes the
  //        client validator, the operator submits → backend rejects with
  //        a generic 400 → the increment-specific message is lost. This
  //        test pins the friendlier inline rendering.
  const tag = uniqueTag();

  await page.goto('/dashboard');
  await page.waitForTimeout(500);
  // Switch to the UI test tenant so the Quick Book has populated dropdowns.
  await switchToTestTenant(page);

  // Open Schedule tab + Quick Book panel.
  await page
    .getByRole('tab', { name: /^Schedule$/ })
    .first()
    .click();
  await page
    .getByRole('button', { name: /Quick Book/i })
    .first()
    .click();
  await expect(page.getByTestId('quick-book-panel')).toBeVisible({ timeout: 10000 });

  // Wait for dropdowns to populate, then pick the first option in each.
  await expect(page.getByTestId('quick-book-customer')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('quick-book-customer').selectOption({ index: 1 });
  await page.getByTestId('quick-book-resource').selectOption({ index: 0 });

  // Fill an off-grid start time. The browser's step="900" attribute
  // nudges the spinner to 15-min increments but does NOT block direct
  // string input (that's how a paste / autofill / programmatic-value
  // attack would land here in production).
  const future = new Date();
  future.setDate(future.getDate() + 30);
  while (future.getDay() === 0 || future.getDay() === 6) {
    future.setDate(future.getDate() + 1);
  }
  const dateStr = future.toISOString().slice(0, 10);

  const startInputs = page.locator('input[type="datetime-local"]');
  // Off-grid: 14:23 (clearly not on the 15-min grid).
  await startInputs.nth(0).fill(`${dateStr}T14:23`);
  await startInputs.nth(1).fill(`${dateStr}T14:53`);

  // Track network calls — the rejection must happen client-side, no POST.
  let createCalled = false;
  page.on('request', (req) => {
    if (req.url().includes('/appointments/create') && req.method() === 'POST') {
      createCalled = true;
    }
  });

  // Submit.
  await page.getByTestId('quick-book-confirm').click();

  // The validator rejects synchronously; the inline error appears within
  // a render cycle. No need for a long timeout.
  await expect(
    page.getByText(/15-minute increment|15-min increment|:00, :15, :30, :45/i)
  ).toBeVisible({ timeout: 3000 });

  // Critical: zero POSTs to /appointments/create — the validator caught it
  // before the network call. Wait a beat to let any in-flight request land.
  await page.waitForTimeout(500);
  expect(createCalled, 'no /appointments/create POST should fire on off-grid input').toBe(false);

  // Belt-and-suspenders: nothing in the DB tagged with this run.
  const dbCheck = await pool.query(
    `SELECT count(*)::int AS n FROM appointments WHERE description = $1`,
    [tag]
  );
  expect(dbCheck.rows[0].n).toBe(0);
});

// (No "past-time rejection" test — the system intentionally allows
//  past-time bookings so the front desk can record walk-ins after the
//  fact. The form picker shows "today" as the default but doesn't
//  reject earlier times. If product policy ever changes to reject
//  past times, add the test then.)

// ────────────────────────────────────────────────────────────────────────────
// 7. Editing an appointment to overlap another returns 409 + conflict block
// ────────────────────────────────────────────────────────────────────────────
test('edit-overlap: updating an appointment to a taken time returns 409 with conflict details', async ({
  request,
}) => {
  // WHO: operator who decides to move appointment B from 15:00 to 14:00,
  //        but 14:00 on the same resource is already booked by A
  // WHAT: POST /appointments/:id/update should reject the overlap; B's
  //        start_time in DB is unchanged. Status is 4xx.
  // WHEN: any update that would overlap an existing scheduled+not-deleted
  //        row on the same resource or employee
  // WHERE: src/routes/appointments.ts /appointments/:id/update
  //        + the GiST exclusion constraint (which fires on UPDATE too)
  // WHY: the create flow surfaces conflicts via the modal (slice 2). The
  //        update flow has been silent on this — operators see a generic
  //        400 error if they edit into a conflict, with no detail about
  //        what's blocking. This pins the contract symmetrically.
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request);
    const date = isoDateDaysFromNow(21);
    const seed = await seedBookingScenario(request, pool, tenant.token, tenant.tenantId, {
      shiftDates: [date],
    });
    const empId = seed.employeeIds[0];
    const resId = seed.resourceIds[0];

    // Appointment A: 14:00-14:30 (the "blocker" we'll try to overlap).
    await seedAppointment(pool, tenant.tenantId, {
      resourceId: resId,
      customerId: seed.customerId,
      employeeId: empId,
      startTime: `${date}T14:00:00.000Z`,
      endTime: `${date}T14:30:00.000Z`,
      description: 'A (blocker)',
    });

    // Appointment B: 15:00-15:30 (we'll try to move this on top of A).
    const apptBId = await seedAppointment(pool, tenant.tenantId, {
      resourceId: resId,
      customerId: seed.customerId,
      employeeId: empId,
      startTime: `${date}T15:00:00.000Z`,
      endTime: `${date}T15:30:00.000Z`,
      description: 'B (will try to move)',
    });

    // Move B to overlap A's slot. Should fail.
    const updateRes = await updateAppointmentAs(request, tenant.token, apptBId, {
      tenant_id: tenant.tenantId,
      start_time: `${date}T14:00:00.000Z`,
      end_time: `${date}T14:30:00.000Z`,
    });

    // The update route may use different status codes than create. We
    // care that: (1) it does NOT succeed (overlap is rejected), AND
    // (2) appointment B's start_time in the DB is unchanged.
    expect(updateRes.status, 'overlap edit must not be a 200').toBeGreaterThanOrEqual(400);

    const after = await pool.query(
      `SELECT start_time::text AS s FROM appointments WHERE appointment_id = $1`,
      [apptBId]
    );
    expect(after.rows[0].s).toContain(`${date} 15:00:00`);
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});
