/**
 * E2E: the Customer Preferences config persists through the real
 * browser → Next.js → backend → Postgres stack.
 *
 * WHY THIS EXISTS
 * AIConfigView.test.tsx proves the component logic with a mocked API, and
 * tenant-routes.test.ts proves the update-config route persists the two new
 * columns. What neither covers is the literal wiring: an owner toggles the
 * feature on in the browser, types guidance, hits Save, and on the next visit
 * the form reflects what the database stored. This pins that round-trip so a
 * regression in Api.tenants.updateConfig, the form binding, or the route
 * shows up as a failed reload assertion — not a silently cosmetic toggle.
 *
 * Auth: the shared auth.setup logs in as admin@secretaryhq.com (super-admin,
 * platform tenant). We edit that tenant's AI config and reset it afterward so
 * the change doesn't bleed into other specs (the DB is also rebuilt per run).
 */
import { test, expect } from './helpers/test';
import { openAiPersona, saveAiPersona } from './helpers/aiPersona';

const PG_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';

// The super-admin tenant this spec edits (auth.setup logs in as
// admin@secretaryhq.com). Scoping every write to it is the point — see afterAll.
const PLATFORM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

test.afterAll(async ({ pgPool }) => {
  // Reset ONLY the tenant this spec touched. This used to be an unconditional
  // `UPDATE tenants SET save_preferences_enabled = false,
  // preferences_instructions = NULL` with no WHERE clause — it reset the
  // preference config of EVERY tenant in the database, including any a
  // concurrently-developed spec had just set up. It is harmless today only
  // because playwright.config.ts pins `workers: 1` and `fullyParallel: false`;
  // the day anyone raises that for speed, this becomes a cross-spec data
  // corruption that presents as a flake somewhere else entirely. The house rule
  // is that a test owns its data and cleans up ITS OWN rows.
  await pgPool
    .query(
      `UPDATE tenants SET save_preferences_enabled = false, preferences_instructions = NULL
        WHERE tenant_id = $1`,
      [PLATFORM_TENANT_ID]
    )
    .catch(() => {});
});

test('owner enables Customer Preferences + guidance, and it survives a reload', async ({
  page,
  pgPool,
}) => {
  // WHO: a salon owner configuring how the AI remembers customers.
  // WHAT: toggle the feature on, type guidance, Save, reload — the toggle is
  //        still on and the guidance is still there (read back from the DB).
  // WHEN: the ongoing self-service config path (not the wizard).
  // WHERE: AIConfigView Customer Preferences section → POST /tenants/:id/update-config.
  // WHY: end-to-end proof the browser control actually persists; the unit
  //      test mocks the API, so only this catches a real wiring break.
  const guidance = `E2E remember stylist + last service ${Date.now()}`;

  await openAiPersona(page);

  const toggle = page.getByRole('switch', { name: /save customer preferences/i });
  const textarea = page.getByTestId('preferences-instructions');

  // Textarea is disabled until the feature is on — flip the toggle first.
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(textarea).toBeEnabled();

  await textarea.fill(guidance);

  // Waits for the WRITE, not just the label, and asserts the Save button was
  // ENABLED first — an enabled button is proof React registered the edit. See
  // helpers/aiPersona.ts.
  await saveAiPersona(page);

  // Prove the DB actually holds it before reloading. This spec has failed twice
  // in CI (2026-08-20, on two different PRs) with the toggle persisted and the
  // guidance coming back empty — so the interesting question is whether the
  // write landed or the read lost it. Asserting here splits those two cases
  // apart: a failure at this line is a WRITE bug, a failure after the reload is
  // a READ/render bug. The root cause is not yet proven either way; this makes
  // the next occurrence diagnostic instead of ambiguous.
  const stored = await pgPool.query<{ preferences_instructions: string | null }>(
    `SELECT preferences_instructions FROM tenants WHERE tenant_id = $1`,
    [PLATFORM_TENANT_ID]
  );
  expect(stored.rows[0]?.preferences_instructions).toBe(guidance);

  // Reload from scratch — re-fetches config from the backend/DB.
  await openAiPersona(page);

  await expect(page.getByRole('switch', { name: /save customer preferences/i })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(page.getByTestId('preferences-instructions')).toHaveValue(guidance);
});
