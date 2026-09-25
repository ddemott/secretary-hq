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

  it('HAPPY: GET /demo redirects to dashboard /demo using DASHBOARD_URL', async () => {
    // WHO: a tenant owner opening /demo from the backend entrypoint.
    // WHAT: redirect should target the configured dashboard /demo route.
    // WHEN: DASHBOARD_URL is present.
    // WHERE: registerHealthRoutes() /demo handler.
    // WHY: production demo traffic must land on the real dashboard experience.
    const app = buildApp();
    process.env.DASHBOARD_URL = 'https://dash.example.com';

    const res = await app.inject({ method: 'GET', url: '/demo' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://dash.example.com/demo');
  });

  it('HAPPY: GET /demo falls back to localhost dashboard when DASHBOARD_URL is unset', async () => {
    // WHO: a developer opening /demo locally without DASHBOARD_URL configured.
    // WHAT: backend redirect should fall back to localhost dashboard /demo.
    // WHEN: env var is unset.
    // WHERE: registerHealthRoutes() /demo handler.
    // WHY: local demo path must stay usable without extra env wiring.
    const app = buildApp();

    const res = await app.inject({ method: 'GET', url: '/demo' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://localhost:4400/demo');
  });
});
