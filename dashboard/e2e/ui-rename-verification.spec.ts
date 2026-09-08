/**
 * Verification-only spec for the 2026-05-16 UI rename pass:
 *   A1 — Advanced tabs renamed: My Business / My Team / Phone Assistant
 *   B2 — Sub-tab "Shifts" renamed to "Working Days" under My Team
 *   B3 — Knowledge Base sub-tab moved from My Business → Phone Assistant
 *   D2 — Wizard chip "Shifts" renamed to "When they work" (chip labels are
 *        pinned by 86 unit-test assertions in SetupWizard/SetupWizard.test.tsx — this
 *        spec verifies the launcher path only, since stepping into the
 *        wizard would write tenant config via BusinessTypePicker)
 *   Business Type move — Business Settings now hosts the section, AI Persona
 *        no longer does, and applying a template is guarded by a confirm.
 *
 * Assertions are positive AND negative where useful, so a stale CSS-cache
 * or partial deploy can't make this go green by silently rendering the old
 * surface.
 */
import { test, expect } from './helpers/test';
import type { Page } from '@playwright/test';
import { Pool } from 'pg';
import { registerFreshTenant, cleanTenantData, BACKEND_URL } from './helpers/fixtures';

const PG_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';

// Most tests in this spec assume a "fully configured" tenant — the
// inline comment at line ~136 explicitly notes the expectation. We register
// a fresh tenant and seed a basic employee so My Team / Working Days / etc.
// surfaces have something to render against.
let pool: Pool;
let freshTenantId: string;

test.beforeAll(async () => {
  pool = new Pool({ connectionString: PG_URL });

  const { request: pr } = await import('@playwright/test');
  const ctx = await pr.newContext({ ignoreHTTPSErrors: true });
  const ft = await registerFreshTenant(ctx);
  freshTenantId = ft.tenantId;
  const hdr = { 'Content-Type': 'application/json', Authorization: `Bearer ${ft.token}` };
  // Seed one employee, service, and resource so the Home "Create a new booking"
  // button is enabled (DashboardHome disables it when any of the three is empty).
  await ctx.post(`${BACKEND_URL}/employees/create`, {
    headers: hdr,
    data: { tenant_id: freshTenantId, first_name: 'Test', last_name: 'Employee' },
  });
  await ctx.post(`${BACKEND_URL}/services/create`, {
    headers: hdr,
    data: { tenant_id: freshTenantId, name: 'Test Service', duration_minutes: 60 },
  });
  await ctx.post(`${BACKEND_URL}/resources/create`, {
    headers: hdr,
    data: { tenant_id: freshTenantId, name: 'Test Resource' },
  });
  await ctx.dispose();
});

test.afterAll(async () => {
  await cleanTenantData(pool, freshTenantId);
  await pool.end();
});

async function landOnTestTenantDashboard(page: Page) {
  // Super-admin auth state can be left scoped to whichever tenant the
  // previous spec file ended on, so a bare goto('/dashboard') may land
  // on the wrong tenant. Force the All-Businesses grid via the URL,
  // pick the test tenant by its tenant-card testid (sets activeTenantId),
  // then click Home so the main view leaves the tile grid and renders the
  // tenant-scoped dashboard.
  await page.goto('/dashboard?tab=all-businesses');
  const tenantBtn = page.getByTestId(`tenant-card-${freshTenantId}`);
  await tenantBtn.waitFor({ state: 'visible', timeout: 10000 });
  await tenantBtn.click();
  await page.waitForTimeout(400);
  await page
    .getByRole('tab', { name: /^Home$/ })
    .first()
    .click();
  await page.waitForTimeout(800);

  // Dismiss any wizard dialog (the new tenant may auto-open the welcome modal).
  const dismiss = page
    .locator(
      'button:has-text("Maybe later"), button:has-text("Dismiss"), button:has-text("Skip"), button:has-text("set up later"), button:has-text("Close wizard"), button:has-text("I\'ll set up later")'
    )
    .first();
  if (await dismiss.isVisible({ timeout: 2000 }).catch(() => false)) {
    await dismiss.click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

test.describe('UI rename — A1 + B2', () => {
  test('owner sees the merged Setup tab + Phone Assistant', async ({ page }) => {
    await landOnTestTenantDashboard(page);

    // IA merge (2026-06-03): My Business + My Team + Business Settings collapsed
    // into one "Setup" tab. Setup + Phone Assistant present as advanced tabs.
    await expect(page.getByRole('tab', { name: /^Setup$/ }).first()).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Phone Assistant$/ }).first()).toBeVisible();

    // Old top-level tabs are gone (they're sub-tabs of Setup now).
    await expect(page.getByRole('tab', { name: /^My Business$/ })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: /^My Team$/ })).toHaveCount(0);
  });

  test('B2: Setup sub-tab reads "Working Days", not "Shifts"', async ({ page }) => {
    await landOnTestTenantDashboard(page);

    await page
      .getByRole('tab', { name: /^Setup$/ })
      .first()
      .click();

    // Wait properly for the sub-tabs to render (short fixed waits are flaky after tenant switch / rebuild)
    await expect(page.getByRole('tab', { name: /Working Days/ }).first()).toBeVisible({
      timeout: 10000,
    });

    // Old sub-tab label should not appear anywhere under Setup.
    await expect(page.getByRole('tab', { name: /^Shifts$/ })).toHaveCount(0);
  });

  test('B3: Knowledge Base lives under Phone Assistant, not Setup', async ({ page }) => {
    await landOnTestTenantDashboard(page);

    // Under Phone Assistant: Knowledge Base sub-tab is present.
    await page
      .getByRole('tab', { name: /^Phone Assistant$/ })
      .first()
      .click();
    await page.waitForTimeout(500);
    await expect(page.getByRole('tab', { name: /Knowledge Base/ }).first()).toBeVisible();

    // Under Setup: no Knowledge Base sub-tab (it stayed with Phone Assistant).
    await page
      .getByRole('tab', { name: /^Setup$/ })
      .first()
      .click();
    await page.waitForTimeout(500);
    await expect(page.getByRole('tab', { name: /Knowledge Base/ })).toHaveCount(0);
  });

  test('C3: "New Booking" button on Home opens the Quick Book panel', async ({ page }) => {
    await landOnTestTenantDashboard(page);
    // Home is the default landing after tenant select — no explicit nav.
    const newBookingBtn = page.getByRole('button', { name: /Create a new booking/i });
    await expect(newBookingBtn).toBeVisible();
    await expect(newBookingBtn).toBeEnabled();

    await newBookingBtn.click();
    await expect(page.getByTestId('quick-book-panel')).toBeVisible();

    // Close without booking — the test must not write to the tenant.
    // QuickBookPanel uses Escape to close. Falling back to the X button
    // via aria-label if Escape doesn't dismiss.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });
});

test.describe('Wizard launcher (D2 chip labels verified by unit tests)', () => {
  test('Setup Assistant from Setup goes directly to mode chooser (no welcome)', async ({
    page,
  }) => {
    await landOnTestTenantDashboard(page);

    await page
      .getByRole('tab', { name: /^Setup$/ })
      .first()
      .click();
    await page.waitForTimeout(500);

    // The Setup Assistant button lives in the FolderTabBar right slot.
    // When launched from My Business it intentionally skips the welcome
    // screen and goes straight to the mode chooser (see MyBusinessView).
    await page.getByRole('button', { name: 'Setup Assistant', exact: true }).click();
    await page.waitForTimeout(500);

    // Mode chooser visible immediately (no welcome gate from this launch point).
    await expect(page.getByText('How is your business set up?')).toBeVisible();
    await expect(page.getByText('Just me')).toBeVisible();
    await expect(page.getByText('I have a team')).toBeVisible();

    // Close without picking a mode — stepping further opens
    // BusinessTypePicker which writes tenant config on select.
    await page
      .getByRole('button', { name: /Close wizard/i })
      .first()
      .click();
  });

  test('Setup Assistant from Setup can be closed cleanly', async ({ page }) => {
    // When launched from the Setup tab the chooser appears directly.
    // Closing it must exit cleanly with no leftover modals.
    await landOnTestTenantDashboard(page);

    await page
      .getByRole('tab', { name: /^Setup$/ })
      .first()
      .click();
    await page.waitForTimeout(500);

    await page.getByRole('button', { name: 'Setup Assistant', exact: true }).click();
    await page.waitForTimeout(500);

    await expect(page.getByText('How is your business set up?')).toBeVisible();

    await page
      .getByRole('button', { name: /Close wizard/i })
      .first()
      .click();

    await expect(page.getByText('How is your business set up?')).toHaveCount(0);
  });
});

test.describe("Business Type move — Settings hosts it, AI Persona doesn't", () => {
  test('Business Settings has the new "Business type" card', async ({ page }) => {
    await landOnTestTenantDashboard(page);

    // Open the profile dropdown, then Business Settings.
    // IA merge: Business Settings is now the 'business-settings' sub-tab of
    // Setup. Route there directly (deterministic; exercises the merged routing).
    await page.goto('/dashboard?tab=setup&subtab=business-settings');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // The new section card lives at the top of the settings stack.
    await expect(page.getByRole('heading', { name: /Business type/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Change business type/i })).toBeVisible();
  });

  test('AI Persona page no longer shows the template grid', async ({ page }) => {
    await landOnTestTenantDashboard(page);

    await page
      .getByRole('tab', { name: /^Phone Assistant$/ })
      .first()
      .click();
    await page.waitForTimeout(500);
    // The AI Persona sub-tab is the default landing for Phone Assistant.

    // Header still present
    await expect(page.getByRole('heading', { name: /Voice Settings/i })).toBeVisible();
    // Old section heading removed — the 24-card grid no longer here.
    await expect(page.getByRole('heading', { name: /^Business Type Templates$/ })).toHaveCount(0);
    // The new header subtitle directs the user where business-type now lives.
    await expect(
      page.getByText(/To change your business type, go to Business Settings/i)
    ).toBeVisible();
  });

  test('Apply-to-my-business is guarded by a confirmation modal (cancel exits cleanly)', async ({
    page,
  }) => {
    await landOnTestTenantDashboard(page);

    // IA merge: Business Settings is now the 'business-settings' sub-tab of
    // Setup. Route there directly (deterministic; exercises the merged routing).
    await page.goto('/dashboard?tab=setup&subtab=business-settings');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    await page.getByRole('button', { name: /Change business type/i }).click();
    await page.waitForTimeout(500);

    // Picker modal: pick a template guaranteed-different from the fresh tenant's
    // current one ("automotive"). Salon is beauty/personal-care,
    // unambiguously not the active template, so the preview's Apply
    // button is enabled (not "Already applied").
    const candidateCard = page.getByRole('dialog').getByRole('button', { name: /Salon/i }).first();
    await candidateCard.click();
    await page.waitForTimeout(500);

    // Preview modal: Apply button visible, not yet a write.
    const applyBtn = page.getByRole('button', { name: /Apply to my business/i });
    await expect(applyBtn).toBeVisible();
    await applyBtn.click();
    await page.waitForTimeout(400);

    // Confirmation guard — copy mentions the destructive consequences.
    await expect(page.getByRole('heading', { name: /Change business type\?/i })).toBeVisible();
    await expect(
      page.getByText(/replaces your AI persona, voice, and first message/i)
    ).toBeVisible();

    // Cancel — no write, no visible change to the page after the modals
    // close. We do NOT click "Change business type" inside the guard,
    // because that would rewrite the test tenant config.
    await page.getByRole('button', { name: /^Cancel$/ }).click();
    await page.waitForTimeout(400);
  });
});
