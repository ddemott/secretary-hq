/**
 * Route-handler tests for src/routes/billing.ts.
 *
 * Why a separate file from src/billing.test.ts:
 *   The existing file tests DB-level schema and subscription gate logic
 *   against real Postgres. This file tests the HTTP layer (status codes,
 *   request validation, response envelopes) via Fastify inject + mock pool.
 *
 * Stripe env constraint:
 *   STRIPE_SECRET_KEY is read at module load time as a module-level const.
 *   vitest does not auto-load .env files, so the key is empty in the test
 *   process. This means checkout + webhook routes return 503 before reaching
 *   plan-validation or signature-check guards. Tests below verify:
 *     (a) the 503 path itself (missing Stripe config guard)
 *     (b) billing/status routes (no Stripe dependency)
 *
 * Coverage targets:
 *   - POST /billing/checkout — Stripe not configured → 503
 *   - POST /billing/webhook  — Stripe not configured → 503
 *   - GET  /billing/status   — happy path → subscription fields
 *   - GET  /billing/status   — tenant not found → 404
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerBillingRoutes } from '../../src/routes/billing';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let handle: RouteTestAppHandle;
let app: FastifyInstance;

beforeAll(async () => {
  handle = buildRouteTestApp((app, pool) => {
    registerBillingRoutes(app, pool);
  });
  app = handle.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  handle.queries.length = 0;
  handle.queryResponses.length = 0;
  handle.tenantIdOverride.current = null;
  handle.auth.current = {
    user_id: '00000000-0000-0000-0000-000000000001',
    tenant_id: TENANT_ID,
    email: 'owner@test.local',
    role: 'owner',
  };
});

// ────────────────────────────────────────────────────────────────────
// POST /billing/checkout
// ────────────────────────────────────────────────────────────────────

describe('POST /billing/checkout', () => {
  it('SAD: returns 503 when Stripe is not configured', async () => {
    // WHO: any caller hitting checkout when STRIPE_SECRET_KEY is unset
    // WHAT: getStripe() returns null → 503 before tenant resolution or plan check
    // WHEN: checkout request in a deployment without Stripe credentials
    // WHERE: `if (!stripe)` guard at the top of /billing/checkout
    // WHY: without the guard, the route crashes on stripe.customers.create(…)
    //      with an unformatted 500; the 503 signals misconfiguration clearly
    const res = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      payload: { plan: 'solo' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      success: false,
      error: 'Billing not configured',
    });
    // The only DB read before the config guard is the email-verification gate
    // (users row for the caller) — no tenant or Stripe-customer query runs.
    expect(handle.queries.every((q) => q.text.includes('FROM users WHERE user_id'))).toBe(true);
    expect(handle.queries.length).toBeLessThanOrEqual(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// POST /billing/webhook
// ────────────────────────────────────────────────────────────────────

describe('POST /billing/webhook', () => {
  it('SAD: returns 503 when Stripe is not configured', async () => {
    // WHO: Stripe calling the webhook endpoint when STRIPE_SECRET_KEY is unset
    // WHAT: same getStripe() null-check fires before signature verification
    // WHEN: webhook POST in a deployment without Stripe credentials
    // WHERE: `if (!stripe)` guard at the top of /billing/webhook
    // WHY: the webhook must gate on config presence; otherwise constructEvent
    //      would throw a 500 that Stripe retries indefinitely
    const res = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      payload: '{}',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=123,v1=abc',
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      success: false,
      error: 'Billing not configured',
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// GET /billing/status
// ────────────────────────────────────────────────────────────────────

describe('GET /billing/status', () => {
  it('HAPPY: returns subscription_status and subscription_plan for known tenant', async () => {
    // WHO: dashboard billing page polling subscription state on mount
    // WHAT: pool.query returns status + plan → reply sends the row directly
    // WHEN: GET /billing/status from an authenticated tenant session
    // WHERE: /billing/status handler
    // WHY: the dashboard uses this to show the current plan and upgrade CTAs
    handle.queryResponses.push({
      rows: [{ subscription_status: 'active', subscription_plan: 'solo' }],
    });

    const res = await app.inject({ method: 'GET', url: '/billing/status' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      subscription_status: 'active',
      subscription_plan: 'solo',
    });
  });

  it('SAD: returns 404 when tenant not found', async () => {
    // WHO: a billing status poll where the tenant was deleted between login and poll
    // WHAT: pool.query returns 0 rows → handler sends 404
    // WHEN: GET /billing/status for a tenant_id with no DB row
    // WHERE: `if (res.rows.length === 0)` guard in /billing/status
    // WHY: without the guard, destructuring an empty rows array would return undefined
    //      fields instead of a clear 404
    handle.queryResponses.push({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/billing/status' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false, error: 'Tenant not found' });
  });
});
