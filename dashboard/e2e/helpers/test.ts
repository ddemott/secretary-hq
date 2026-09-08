/**
 * Wrapped Playwright `test` with two safety nets every test gets
 * automatically. Drop-in replacement for `@playwright/test`:
 *
 *   import { test, expect } from './helpers/test';
 *
 * Two safety nets attached to every `page` fixture:
 *
 * 1. **pageerror watchdog** — any uncaught JavaScript exception in
 *    the browser fails the test at end-of-body. Pre-watchdog, an
 *    uncaught throw → React error boundary → "Something went wrong"
 *    screen → tests that didn't explicitly look for that text stayed
 *    green while the page was visibly broken.
 *
 * 2. **error-boundary visibility watchdog** — at end of every test,
 *    asserts the "Something went wrong" boundary text isn't rendered.
 *    Catches the case where a child component throw was caught by
 *    the boundary (so pageerror didn't fire at the page level) but
 *    the page is still broken.
 *
 * To opt OUT for a specific test (e.g., a test that intentionally
 * exercises an error path), import from the unwrapped library:
 *   import { test, expect } from '@playwright/test';
 *
 * Origin: 2026-05-13 — the May 12 PK rename sprint introduced a
 * regression in `TenantCard.tsx` where the bundled JS still read
 * `tenant.id` (renamed to `tenant.tenant_id` in the source). The
 * error boundary caught the resulting `Cannot read properties of
 * undefined (reading 'slice')`, the full existing E2E suite
 * stayed green, and the regression was only caught when a human
 * clicked the affected path during live testing. The watchdog
 * makes future regressions of the same shape visible immediately.
 *
 * Migration: 19 existing specs still import from `@playwright/test`
 * directly. They can be migrated one at a time — change the import
 * line, run the spec, address any new failures (which are real
 * regressions the watchdog has been masking). New specs should
 * always use this wrapper unless they have a clear reason not to.
 */
import { test as base, expect } from '@playwright/test';
import { Pool } from 'pg';

// ── DB quiescence ────────────────────────────────────────────────────
//
// One-connection pool used exclusively to poll pg_stat_activity for
// backend quiescence between tests. NOT shared with spec-level pools
// (those have their own lifecycle) — keeping it isolated means a spec
// that forgets to close its own pool can't accidentally exhaust this
// one. Single connection cap because we only ever issue one short
// SELECT against it.
const PG_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';
const quiescencePool = new Pool({ connectionString: PG_URL, max: 1 });

/**
 * Wait until the backend has no in-flight DB queries (other than our
 * own quiescence-check connection). Bounded to 5s — if something
 * really is wedged we surface a warning rather than blocking forever.
 *
 * Why this exists (2026-05-18): the multi-row INSERT in
 * expandWeeklyToSchedule eliminated one specific deadlock window,
 * but the broader principle — "each test completes before the next
 * one starts" — needs structural enforcement, not whack-a-mole.
 * Playwright's `workers: 1` keeps the TEST side serial, but the
 * shared backend can leave async writes (audit triggers, version
 * triggers, calendar-sync pushes) in flight after the API call has
 * already returned. Without this wait, those tails leak into the
 * next test's window and create exactly the kind of "false
 * deadlock" you don't want to debug.
 */
async function waitForDbQuiescence(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastActive = -1;
  while (Date.now() < deadline) {
    const result = await quiescencePool.query<{ active: string }>(
      `SELECT COUNT(*)::text AS active
       FROM pg_stat_activity
       WHERE state = 'active'
         AND pid <> pg_backend_pid()
         AND datname = current_database()
         AND query NOT LIKE 'SELECT COUNT(*)%pg_backend_pid%'`
    );
    const active = Number(result.rows[0]?.active ?? 0);
    if (active === 0) return;
    lastActive = active;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Don't fail the test — just emit a hint. Most cases that hit this
  // are a sign of something else broken (deadlock, runaway query),
  // and we'd rather see the downstream failure than mask it here.
  console.warn(
    `[quiesce] timeout waiting for DB quiescence; ${lastActive} other connections still active`
  );
}

interface TestFixtures {
  pgPool: Pool;
}

export const test = base.extend<TestFixtures>({
  page: async ({ page }, use, testInfo) => {
    const errors: string[] = [];

    page.on('pageerror', (err) => {
      // Filter out Next.js dev-server internal errors that are not app bugs.
      // The font manifest file (.next/next-font-manifest.json) can be read
      // while the dev server is still writing it, producing a truncated JSON
      // parse error. This is a dev-server race, not a code defect.
      if (err.stack?.includes('load-manifest.js') || err.stack?.includes('getNextFontManifest')) {
        return;
      }
      errors.push(`pageerror: ${err.message}\n${err.stack ?? '(no stack)'}`);
    });

    await use(page);

    // Surface uncaught JS errors as a test attachment for CI visibility.
    if (errors.length > 0) {
      await testInfo.attach('browser-errors.log', {
        body: errors.join('\n\n---\n\n'),
        contentType: 'text/plain',
      });
    }
    expect(
      errors,
      `Browser fired ${errors.length} uncaught JavaScript error(s) — see attached browser-errors.log`
    ).toHaveLength(0);

    // Error-boundary watchdog. Short timeout so a closed page or
    // navigated-away test doesn't slow the suite down; we only need to
    // know whether the boundary text is currently on screen.
    let boundaryVisible = false;
    try {
      boundaryVisible = await page.getByText('Something went wrong').isVisible({ timeout: 250 });
    } catch {
      // Page already closed or navigated away — not a watchdog failure.
    }
    expect(
      boundaryVisible,
      'Page rendered the generic error boundary — a child component threw silently'
    ).toBe(false);

    // Drain backend before letting Playwright start the next test.
    // See waitForDbQuiescence() above for the why.
    await waitForDbQuiescence();
  },

  pgPool: async ({}, use) => {
    const pool = new Pool({ connectionString: PG_URL });
    await use(pool);
    await pool.end();
  },
});

// Close the pool at suite end so the process can exit cleanly.
// Playwright's `globalTeardown` is the canonical place for this, but
// using `process.on('exit')` keeps the wrapper self-contained — every
// spec that imports `test` from here gets the cleanup for free.
process.on('exit', () => {
  void quiescencePool.end();
});

export { expect };
