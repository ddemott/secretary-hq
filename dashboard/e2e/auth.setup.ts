import { test as setup, expect } from '@playwright/test';

/**
 * Login once and save auth state for all tests.
 *
 * Captures state as soon as the JWT lands in localStorage rather than
 * waiting for "Home" to be visible. The older flow had a race: once the
 * dashboard rendered it fired tenant-scoped API calls, and if any of
 * those 401'd, `forceLogout()` would wipe `tenantId/userName/authToken`
 * (but not `userEmail/userRole/theme`), persisting a partial state that
 * silently logged 30+ specs out mid-run.
 */
setup('login as admin', async ({ page }) => {
  await page.goto('/dashboard');
  await page.waitForTimeout(1500);

  const alreadyLoggedIn = await page.evaluate(() => !!localStorage.getItem('authToken'));

  if (!alreadyLoggedIn) {
    // May have landed on a marketing intercept — click Log in if visible.
    const loginLink = page.getByText('Log in', { exact: true }).first();
    if (await loginLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loginLink.click();
      await page.waitForTimeout(800);
    }

    await page.locator('input[type="email"]').fill('admin@secretaryhq.com');
    await page.locator('input[type="password"]').fill('p@ssw0rd');
    await page.locator('button[type="submit"]').click();

    // Wait for the JWT to land in localStorage. Polling the token
    // directly is race-free: we don't depend on any post-login UI to
    // render, and we capture BEFORE any tenant-scoped fetch can fail.
    await page.waitForFunction(
      () => !!localStorage.getItem('authToken') && !!localStorage.getItem('tenantId'),
      undefined,
      { timeout: 15000 }
    );
  }

  // Sanity-assert the state we're about to persist is actually usable.
  // A green setup test that saves a partial state silently breaks every
  // downstream spec.
  const state = await page.evaluate(() => ({
    authToken: localStorage.getItem('authToken'),
    tenantId: localStorage.getItem('tenantId'),
    userName: localStorage.getItem('userName'),
  }));
  expect(
    state.authToken,
    'authToken must be present in localStorage before storageState save'
  ).toBeTruthy();
  expect(
    state.tenantId,
    'tenantId must be present in localStorage before storageState save'
  ).toBeTruthy();

  await page.context().storageState({ path: 'e2e/.auth/user.json' });
});
