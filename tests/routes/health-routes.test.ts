import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { Pool } from 'pg';

import { registerHealthRoutes } from '../../src/routes/health';

function buildApp() {
  const app = Fastify({ logger: false });
  const pool = {} as Pool;
  registerHealthRoutes(app as never, pool);
  return app;
}

describe('health routes', () => {
  const OLD_DASHBOARD_URL = process.env.DASHBOARD_URL;

  beforeEach(() => {
    delete process.env.DASHBOARD_URL;
  });

  afterEach(() => {
    if (OLD_DASHBOARD_URL === undefined) delete process.env.DASHBOARD_URL;
    else process.env.DASHBOARD_URL = OLD_DASHBOARD_URL;
  });

  it('HAPPY: GET /tutorial redirects to dashboard /tutorial using DASHBOARD_URL', async () => {
    // WHO: a prospect opening /tutorial from the backend entrypoint.
    // WHAT: redirect should target the configured dashboard /tutorial route.
    // WHEN: DASHBOARD_URL is present.
    // WHERE: registerHealthRoutes() /tutorial handler.
    // WHY: production tutorial traffic must land on the real dashboard experience.
    const app = buildApp();
    process.env.DASHBOARD_URL = 'https://dash.example.com';

    const res = await app.inject({ method: 'GET', url: '/tutorial' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://dash.example.com/tutorial');
  });

  it('HAPPY: GET /tutorial falls back to localhost dashboard when DASHBOARD_URL is unset', async () => {
    // WHO: a developer opening /tutorial locally without DASHBOARD_URL configured.
    // WHAT: backend redirect should fall back to localhost dashboard /tutorial.
    // WHEN: env var is unset.
    // WHERE: registerHealthRoutes() /tutorial handler.
    // WHY: local tutorial path must stay usable without extra env wiring.
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/tutorial' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:4400/tutorial');
  });

  it('HAPPY: GET /demo (legacy alias) also redirects to dashboard /tutorial', async () => {
    // WHO: someone following an old shared link or bookmark from before the
    //      demo→tutorial rename (2026-09-27).
    // WHAT: /demo must keep working, permanently, and land on the new page.
    // WHERE: registerHealthRoutes() /demo alias handler.
    // WHY: renaming the feature must not break links already in the wild.
    const app = buildApp();
    process.env.DASHBOARD_URL = 'https://dash.example.com';

    const res = await app.inject({ method: 'GET', url: '/demo' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://dash.example.com/tutorial');
  });
});
