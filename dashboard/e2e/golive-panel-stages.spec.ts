/**
 * GoLivePanel — Stage B (verify) and Stage C (the fork), browser click-path
 * against a real backend + database (Phase B / PR D follow-up, 2026-07-06).
 *
 * wizard-golive-commit.spec.ts covers Stage A (Activate) reached through the
 * real wizard commit. This spec seeds phone_status='active' directly via
 * POST /provisioning/activate (PROVISIONING_E2E_STUB — same "seed via API,
 * test the UI" pattern as setup-wizard-to-booking.spec.ts) so each test
 * starts at the state it actually cares about, rather than re-walking the
 * whole wizard three times.
 *
 * Real-call detection is simulated by inserting directly into
 * voice_sessions — GoLivePanel polls the real GET /voice/history endpoint
 * every 5s (POLL_INTERVAL_MS in GoLivePanel.tsx), so these assertions poll
 * the UI for up to that long rather than asserting instantly.
 *
 * Tenant cleanup via cleanTenantData in finally (one DELETE cascades the tree,
 * including the inserted voice_sessions rows).
 */
import { test, expect } from './helpers/test';
import type { Page, APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import {
  PG_URL,
  registerFreshTenant,
  startSubscriptionViaFixture,
  markEmailVerified,
  cleanTenantData,
  type RegisteredTenant,
} from './helpers/fixtures';

const BACKEND_URL = process.env.BACKEND_URL ?? 'https://localhost:4001';

let pool: Pool;
test.beforeAll(() => {
  pool = new Pool({ connectionString: PG_URL });
});
test.afterAll(async () => {
  await pool.end();
});

/** Mirrors wizard-golive-commit.spec.ts / wizard-welcome-auto-open.spec.ts. */
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

/** Activates the tenant's phone via the real state machine (no Telnyx account). */
async function activateViaStub(request: APIRequestContext, token: string, tenantId: string) {
  const res = await request.post(`${BACKEND_URL}/provisioning/activate`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { tenant_id: tenantId },
  });
  expect(res.status(), 'stub activation must succeed').toBe(200);
  const body = await res.json();
  expect(body.success).toBe(true);
  return body.phone_number as string;
}

/** Dismisses the fresh-tenant welcome dialog so Phone Assistant is reachable directly. */
async function dismissWelcome(page: Page) {
  const skip = page.getByText("I'll set up later, just show me around");
  await expect(skip).toBeVisible({ timeout: 8000 });
  await skip.click();
}

async function openPhoneAssistant(page: Page) {
  await page
    .getByRole('tab', { name: /Phone Assistant/i })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Go Live' })).toBeVisible({ timeout: 4000 });
}

test.describe('GoLivePanel — Stage B (verify the raw number)', () => {
  test('a real voice_sessions row started after activation advances Stage B → Stage C', async ({
    page,
    request,
  }) => {
    test.skip(process.env.PROVISIONING_E2E_STUB !== '1', 'requires PROVISIONING_E2E_STUB=1');

    let tenant: RegisteredTenant | null = null;
    try {
      tenant = await registerFreshTenant(request);
      // Buying a number needs a started (card-required) trial — see provisioning gate.
      await markEmailVerified(pool, tenant.userId);
      await startSubscriptionViaFixture(request, tenant.token);
      await activateViaStub(request, tenant.token, tenant.tenantId);

      await switchToFreshTenant(page, tenant.tenantId, `StageB ${tenant.tenantId.slice(0, 6)}`);
      await dismissWelcome(page);
      await openPhoneAssistant(page);

      await expect(page.getByText('Your number is ready')).toBeVisible();

      // Simulate a real call: insert directly into voice_sessions with
      // started_at after "now" (activatedAt was set the moment this session
      // saw phone_status flip to active, a few seconds ago at most).
      await pool.query(
        `INSERT INTO voice_sessions (tenant_id, call_id, caller_phone, started_at, status)
         VALUES ($1, $2, $3, now(), 'completed')`,
        [tenant.tenantId, `e2e-test-call-${Date.now()}`, '+16305550100']
      );

      // The poll runs every 5s — give it two cycles of margin.
      await expect(page.getByText('Your number is ready')).toBeHidden({ timeout: 12000 });
      await expect(
        page.getByText('Do you already have a phone number customers call today?')
      ).toBeVisible();
    } finally {
      if (tenant) await cleanTenantData(pool, tenant.tenantId);
    }
  });
});

test.describe('GoLivePanel — Stage C fork', () => {
  async function reachStageC(page: Page, tenant: RegisteredTenant) {
    await switchToFreshTenant(page, tenant.tenantId, `StageC ${tenant.tenantId.slice(0, 6)}`);
    await dismissWelcome(page);
    await openPhoneAssistant(page);
    await page.getByText(/test it later/i).click();
    await expect(
      page.getByText('Do you already have a phone number customers call today?')
    ).toBeVisible();
  }

  test('"No — this is new" shows the you\'re-all-set card', async ({ page, request }) => {
    test.skip(process.env.PROVISIONING_E2E_STUB !== '1', 'requires PROVISIONING_E2E_STUB=1');

    let tenant: RegisteredTenant | null = null;
    try {
      tenant = await registerFreshTenant(request);
      // Buying a number needs a started (card-required) trial — see provisioning gate.
      await markEmailVerified(pool, tenant.userId);
      await startSubscriptionViaFixture(request, tenant.token);
      await activateViaStub(request, tenant.token, tenant.tenantId);
      await reachStageC(page, tenant);

      await page.getByRole('button', { name: /No — this is new/i }).click();
      await expect(page.getByText("You're all set")).toBeVisible();
      await expect(page.getByText(/Forward your existing number/i)).toBeHidden();
    } finally {
      if (tenant) await cleanTenantData(pool, tenant.tenantId);
    }
  });

  test('"Yes, I have one" → forwarding save persists + verifies via a real call, porting inquiry submits', async ({
    page,
    request,
  }) => {
    test.skip(process.env.PROVISIONING_E2E_STUB !== '1', 'requires PROVISIONING_E2E_STUB=1');

    let tenant: RegisteredTenant | null = null;
    try {
      tenant = await registerFreshTenant(request);
      // Buying a number needs a started (card-required) trial — see provisioning gate.
      await markEmailVerified(pool, tenant.userId);
      await startSubscriptionViaFixture(request, tenant.token);
      await activateViaStub(request, tenant.token, tenant.tenantId);
      await reachStageC(page, tenant);

      await page.getByRole('button', { name: /Yes, I have one/i }).click();
      await expect(page.getByText(/Forward your existing number/i)).toBeVisible();

      // Forwarding save — real Api.tenants.updateConfig call.
      await page.getByLabel(/Your real business number/i).fill('(608) 217-5303');
      await page.getByRole('button', { name: /^Save$/i }).click();
      await expect(page.getByText(/if the AI answers, forwarding works/i)).toBeVisible();

      const configRow = await pool.query(
        'SELECT forwarded_from_phone FROM tenants WHERE tenant_id = $1',
        [tenant.tenantId]
      );
      expect(configRow.rows[0].forwarded_from_phone).toBe('+16082175303');

      // Verify via a real call to the forwarded-from number — same session,
      // so the poll (gated on forwardSavedAt, set by the save above) is
      // still active. Must happen BEFORE any reload: reloading resets
      // forwardSavedAt (deliberately not persisted — see GoLivePanel.tsx),
      // which would leave nothing polling for this exact assertion.
      await pool.query(
        `INSERT INTO voice_sessions (tenant_id, call_id, caller_phone, started_at, status)
         VALUES ($1, $2, $3, now(), 'completed')`,
        [tenant.tenantId, `e2e-fwd-call-${Date.now()}`, '+16082175303']
      );
      await expect(page.getByText(/Forwarding verified/i)).toBeVisible({ timeout: 12000 });

      // Porting inquiry — a notify-Dale email, no table, no automated port.
      await page.getByPlaceholder("Number you'd like to port").fill('+16082175303');
      await page.getByRole('button', { name: /Email us about porting/i }).click();
      await expect(page.getByText(/we'll follow up by email/i)).toBeVisible();

      // A real reload proves the number itself is persisted cross-session
      // (not just local component state) — but the verify prompt/banner
      // correctly does NOT reappear, since forwardSavedAt (this-session-only
      // by design) is gone. This is the exact behavior the "spinner forever
      // on a returning visit" fix pins.
      await page.reload();
      await openPhoneAssistant(page);
      await expect(page.getByLabel(/Your real business number/i)).toHaveValue('+16082175303', {
        timeout: 4000,
      });
      await expect(page.getByText(/if the AI answers, forwarding works/i)).toBeHidden();
    } finally {
      if (tenant) await cleanTenantData(pool, tenant.tenantId);
    }
  });
});
