import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Reset the local DB to its bare-bones seed state before any spec
  // runs (UX audit session, 2026-05-18). The earlier pattern relied
  // on per-test try/finally cleanup which silently leaked rows when
  // an assertion fired before the cleanup line; now every run starts
  // from identical state. ~1-2s overhead before the suite begins.
  globalSetup: './e2e/globalSetup.ts',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  // workers:1 forces serial execution across spec files. fullyParallel:false
  // only disables WITHIN-file parallelism; without this setting Playwright
  // runs spec files in parallel by default (workers = half CPU cores), which
  // breaks the test-isolation principle when two specs touch the same tenant
  // at overlapping today-times — the GiST exclusion fails the loser.
  workers: 1,
  retries: 0,
  use: {
    // Local dev serves the dashboard over HTTPS (server.js + mkcert certs);
    // CI runs `next start` (plain HTTP). Honor DASHBOARD_URL so CI can point
    // at http://localhost:4400 without the TLS handshake failing every goto.
    baseURL: process.env.DASHBOARD_URL ?? 'https://localhost:4400',
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    // Pin the browser timezone to the seed tenants' tz. Quick-book specs fill
    // `<input type="datetime-local">`, which the browser interprets in ITS
    // timezone — Chicago on a local dev machine but UTC on the CI runner. That
    // 5h skew pushed a "10:00 local" booking to 05:00 Chicago, before the
    // seeded shift's 07:00 start → EMPLOYEE_NOT_SCHEDULED only in CI. Fixing
    // the browser tz makes datetime-local match the tenant's local time
    // everywhere.
    timezoneId: 'America/Chicago',
    // NB: storageState is set on the chromium project, NOT globally. A global
    // storageState is applied to the `setup` project too, so Playwright tries
    // to READ e2e/.auth/user.json before auth.setup.ts can write it — which
    // ENOENTs on a fresh checkout (the file is gitignored). The setup project
    // must run with no storage state.
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: { browserName: 'chromium', storageState: 'e2e/.auth/user.json' },
      dependencies: ['setup'],
    },
  ],
});
