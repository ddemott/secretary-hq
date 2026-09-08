/**
 * Setup wizard → real POST /setup/commit → GoLivePanel Stage A→B, browser
 * click-path (Phase B / PR D follow-up, 2026-07-06).
 *
 * Complements the unit-level "commits the draft graph exactly once" test
 * (SetupWizard/SetupWizard.test.tsx, mocked fetch) with the real thing: drives the
 * wizard's actual UI through to step 9, then asserts against the REAL
 * database (not the UI) that the whole draft graph actually landed — proving
 * the full chain (click → Api.setup.commit → POST /setup/commit →
 * insertDraftGraph → Postgres), not just that the request was sent.
 *
 * Then exercises GoLivePanel's Stage A (Activate) → Stage B (verify) hand-off
 * via PROVISIONING_E2E_STUB, the real activatePhone() state machine with no
 * Telnyx account configured. setup-wizard-to-booking.spec.ts pins the
 * PRE-Phase-B per-entity + /shifts/expand-weekly path via direct API calls;
 * this spec is the one that actually drives /setup/commit through the UI.
 *
 * Tenant cleanup via cleanTenantData in finally (one DELETE cascades the tree).
 */
import { test, expect } from './helpers/test';
import type { Page } from '@playwright/test';
import { Pool } from 'pg';
import {
  PG_URL,
  registerFreshTenant,
  cleanTenantData,
  type RegisteredTenant,
} from './helpers/fixtures';

let pool: Pool;
test.beforeAll(() => {
  pool = new Pool({ connectionString: PG_URL });
});
test.afterAll(async () => {
  await pool.end();
});

/**
 * Point the super-admin browser at a fresh tenant via the same localStorage
 * keys OutlookLayout reads for managed-tenant switching, then land on Home so
 * the needsSetup calculation (and the welcome auto-open) reflects it. Mirrors
 * the helper in wizard-welcome-auto-open.spec.ts / wizard-website-scan.spec.ts.
 */
async function switchToFreshTenant(page: Page, tenantId: string, tenantName: string) {
  await page.goto('/dashboard');
  await page.evaluate(
    ({ id, name }) => {
      localStorage.setItem('managedTenantId', id);
      localStorage.setItem('managedTenantName', name);
    },
    { id: tenantId, name: tenantName }
  );
  await page.goto('/dashboard?tab=home');
  await page
    .getByRole('tab', { name: /^Home$/ })
    .first()
    .click();
  await page.waitForLoadState('networkidle');
}

test.describe('Setup wizard → real commit → Go Live Stage A/B (browser click-path)', () => {
  test('owner completes the wizard, commits real DB rows on entering step 9, activates the phone via the stub', async ({
    page,
    request,
  }) => {
    test.skip(
      process.env.PROVISIONING_E2E_STUB !== '1',
      'requires PROVISIONING_E2E_STUB=1 (no live Telnyx account)'
    );

    let tenant: RegisteredTenant | null = null;
    try {
      tenant = await registerFreshTenant(request);
      await switchToFreshTenant(page, tenant.tenantId, `GoLive ${tenant.tenantId.slice(0, 6)}`);

      // Welcome auto-opens (fresh tenant, needsSetup=true) → start setup.
      await expect(page.getByRole('dialog', { name: /welcome/i })).toBeVisible({ timeout: 8000 });
      await page.getByRole('button', { name: /Let's go/i }).click();

      // Mode chooser → "I have a team" (the SetupWizard path, not SoloWizard).
      await expect(page.getByText('How is your business set up?')).toBeVisible({ timeout: 4000 });
      await page.getByRole('button', { name: /I have a team/i }).click();

      // Business-type picker → first available type.
      await expect(page.getByPlaceholder('Search business types...')).toBeVisible({
        timeout: 4000,
      });
      await page.getByPlaceholder('Search business types...').fill('a');
      const firstType = page.getByTestId('wizard-biztype-option').first();
      await expect(firstType).toBeVisible({ timeout: 4000 });
      await firstType.click();

      const wizardDialog = page.getByRole('dialog', { name: /Setup Assistant/i });

      // Step 1: add a service through the real UI.
      await wizardDialog.getByRole('button', { name: /Add a service/i }).click();
      await wizardDialog.getByLabel('Service Name').fill('Commit Test Service');
      await wizardDialog.getByRole('button', { name: /^Add Service$/i }).click();
      await expect(wizardDialog.getByText('Commit Test Service')).toBeVisible();

      // Step 3: add an employee. Employee copy is vocab-personalized per
      // business type (no template uses the generic "Employee" label — see
      // wizard-website-scan.spec.ts) — matched by shape, not a specific word.
      const staffChip = wizardDialog.getByRole('button', { name: /Who works here/i });
      await expect(staffChip).toBeEnabled({ timeout: 10000 });
      await staffChip.click();
      await wizardDialog.getByRole('button', { name: /^Add (a|an) \S+$/i }).click();
      await wizardDialog.getByPlaceholder('First name').fill('Commit');
      await wizardDialog.getByPlaceholder('Last name').fill('Tester');
      await wizardDialog.getByRole('button', { name: /^Add \S+$/i }).click();
      await expect(wizardDialog.getByText('Commit Tester')).toBeVisible();

      // Steps 4 → 8 via Next; the footer button relabels to "Go Live" only
      // on step 8, which is what actually fires the commit (index.tsx
      // goNext() — the transition INTO step 9, not the final Done click).
      for (let i = 0; i < 5; i++) {
        await wizardDialog.getByRole('button', { name: /^Next$/ }).click();
      }
      const goLiveButton = wizardDialog.getByRole('button', { name: /^Go Live$/ });
      await expect(goLiveButton).toBeVisible({ timeout: 4000 });
      await goLiveButton.click();

      // The commit fired — assert against the REAL DB (not the UI) that the
      // whole draft graph actually landed via POST /setup/commit.
      await expect(async () => {
        const svcRes = await pool.query(
          'SELECT name FROM services WHERE tenant_id = $1 AND is_deleted = false',
          [tenant!.tenantId]
        );
        expect(svcRes.rows.map((r) => r.name)).toContain('Commit Test Service');

        const empRes = await pool.query(
          'SELECT first_name, last_name FROM employees WHERE tenant_id = $1',
          [tenant!.tenantId]
        );
        expect(empRes.rows.map((r) => `${r.first_name} ${r.last_name}`)).toContain('Commit Tester');
      }).toPass({ timeout: 5000 });

      // GoLivePanel Stage A renders inside the wizard, backed by the
      // now-real, now-committed business.
      await expect(wizardDialog.getByRole('heading', { name: 'Go Live' })).toBeVisible();
      const activateButton = wizardDialog.getByRole('button', {
        name: /Activate AI Phone Line/i,
      });
      await expect(activateButton).toBeVisible();

      // Activate via PROVISIONING_E2E_STUB — the real activatePhone() state
      // machine (provisioning → active) and DB UPDATE, zero Telnyx calls.
      await activateButton.click();
      await expect(wizardDialog.getByText('Your number is ready')).toBeVisible({
        timeout: 10000,
      });

      const tenantRow = await pool.query(
        'SELECT phone_status, inbound_phone FROM tenants WHERE tenant_id = $1',
        [tenant.tenantId]
      );
      expect(tenantRow.rows[0].phone_status).toBe('active');
      expect(tenantRow.rows[0].inbound_phone).toMatch(/^\+1\d+$/);
    } finally {
      if (tenant) await cleanTenantData(pool, tenant.tenantId);
    }
  });
});
