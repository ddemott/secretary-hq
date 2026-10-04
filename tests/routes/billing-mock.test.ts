/**
 * The whole billing flow on the Stripe mock, end to end through the real routes.
 *
 * WHO: a developer or CI run with no Stripe account | WHAT: checkout, the hosted page, payment,
 * the signed webhook, the billing portal, cancellation | WHEN: STRIPE_MODE=mock |
 * WHERE: /billing/checkout -> /billing/mock/* -> /billing/webhook | WHY: billing is built and
 * proven here, and attached to the real Stripe account by configuration alone.
 *
 * Only the database is faked (a recording pool). The Stripe side is the real MockStripe, and every
 * result reaches the app as a SIGNED POST to the real /billing/webhook, so the production webhook
 * handler and its signature gate are what is under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { registerBillingRoutes } from '../../src/routes/billing';
import { registerBillingMockRoutes, safeReturnUrl } from '../../src/routes/billingMock';
import {
  getMockStripe,
  resetMockStripeForTesting,
  stripeWebhookSecret,
} from '../../src/services/stripe/gateway';
import { jsonContentTypeParser } from '../../src/jsonContentTypeParser';
import type { AppRequest } from '../../src/middleware/fastify-middleware';

const TENANT_ID = 'f234e471-0e60-4163-86c9-93cfd9338e3a';
const DASHBOARD = 'https://dash.test';

interface Recorded {
  sql: string;
  params: unknown[];
}

function buildApp() {
  const queries: Recorded[] = [];
  // The tenant row as the checkout route reads it; updated by the writes it sees.
  const tenant = { customer: null as string | null, subscription: null as string | null };

  const pool = {
    query: vi.fn((sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const text = sql.replace(/\s+/g, ' ');
      if (text.includes('SELECT email, email_verified_at FROM users')) {
        return Promise.resolve({
          rows: [{ email: 'owner@test.com', email_verified_at: new Date() }],
          rowCount: 1,
        });
      }
      if (text.includes('SELECT tenant_id, name, stripe_customer_id, stripe_subscription_id')) {
        return Promise.resolve({
          rows: [
            {
              tenant_id: TENANT_ID,
              name: 'Test Biz',
              stripe_customer_id: tenant.customer,
              stripe_subscription_id: tenant.subscription,
            },
          ],
          rowCount: 1,
        });
      }
      if (text.includes('SELECT stripe_customer_id FROM tenants')) {
        return Promise.resolve({ rows: [{ stripe_customer_id: tenant.customer }], rowCount: 1 });
      }
      if (text.includes('SET stripe_customer_id = $1 WHERE tenant_id'))
        tenant.customer = params[0] as string;
      if (text.includes('SET stripe_subscription_id = $1'))
        tenant.subscription = params[0] as string;
      if (text.includes("subscription_status = 'canceled'")) tenant.subscription = null;
      return Promise.resolve({ rows: [], rowCount: 1 });
    }),
  } as unknown as Pool;

  const app = Fastify({ logger: false });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, jsonContentTypeParser);
  app.addHook('preHandler', async (request) => {
    (request as AppRequest).tenantId = TENANT_ID;
    (request as AppRequest).auth = {
      tenant_id: TENANT_ID,
      user_id: 'u1',
      email: 'owner@test.com',
      role: 'owner',
    };
  });
  registerBillingRoutes(app, pool);
  registerBillingMockRoutes(app);
  return { app, queries, tenant };
}

const post = (app: FastifyInstance, url: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

/** Start a checkout the way the dashboard does and return the mock session id. */
async function startCheckout(app: FastifyInstance, plan = 'growth') {
  const res = await post(app, '/billing/checkout', { plan });
  expect(res.statusCode).toBe(200);
  const url = res.json<{ url: string }>().url;
  const session = new URL(url).searchParams.get('session') as string;
  expect(session).toMatch(/^cs_mock_/);
  return { url, session };
}

const activations = (queries: Recorded[]) =>
  queries.filter(
    (q) =>
      q.sql.includes("subscription_status = 'active'") &&
      q.sql.includes('stripe_subscription_id = $1')
  );

beforeEach(() => {
  resetMockStripeForTesting();
  vi.stubEnv('STRIPE_MODE', 'mock');
  vi.stubEnv('DASHBOARD_URL', DASHBOARD);
  vi.stubEnv('BACKEND_PUBLIC_URL', 'https://api.test');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('checkout -> hosted page -> payment -> webhook', () => {
  it('HAPPY: paying activates the plan through the real webhook handler', async () => {
    const { app, queries, tenant } = buildApp();
    const { url, session } = await startCheckout(app);

    // The owner is sent to the mock hosted page, not to Stripe.
    expect(url.startsWith('https://api.test/billing/mock/checkout?session=')).toBe(true);
    const pageRes = await app.inject({
      method: 'GET',
      url: `/billing/mock/checkout?session=${session}`,
    });
    expect(pageRes.statusCode).toBe(200);
    expect(pageRes.headers['content-type']).toContain('text/html');
    expect(pageRes.body).toContain('Subscribe to Growth');
    expect(pageRes.body).toContain('Free for 14 days'); // first subscription gets the trial
    expect(pageRes.body).toContain('MOCK STRIPE');

    const paid = await post(app, '/billing/mock/checkout', { session, outcome: 'paid' });
    expect(paid.statusCode).toBe(200);
    expect(paid.json<{ redirect: string }>().redirect).toContain(
      `${DASHBOARD}/dashboard?tab=setup&subtab=billing&billing=success`
    );

    // The real handler ran: the tenant row was activated with the plan from our metadata.
    const [activation] = activations(queries);
    expect(activation).toBeDefined();
    expect(activation.params[0]).toMatch(/^sub_mock_/);
    expect(activation.params[1]).toBe('growth');
    expect(activation.params[2]).toBe(TENANT_ID);
    expect(tenant.customer).toMatch(/^cus_mock_/);
  });

  it('HAPPY: the Stripe customer is created once and reused', async () => {
    const { app, tenant } = buildApp();
    await startCheckout(app);
    const first = tenant.customer;
    await startCheckout(app);
    expect(tenant.customer).toBe(first);
  });

  it('SAD: a declined card activates nothing and the session stays payable', async () => {
    const { app, queries } = buildApp();
    const { session } = await startCheckout(app);
    const declined = await post(app, '/billing/mock/checkout', { session, outcome: 'declined' });
    expect(declined.statusCode).toBe(200);
    expect(declined.json<{ message: string }>().message).toMatch(/declined/i);
    expect(activations(queries)).toHaveLength(0);

    const retry = await post(app, '/billing/mock/checkout', { session, outcome: 'paid' });
    expect(retry.statusCode).toBe(200);
    expect(activations(queries)).toHaveLength(1);
  });

  it('SAD: going back sends the owner to the cancel url, and the abandoned session cannot be paid', async () => {
    const { app, queries } = buildApp();
    const { session } = await startCheckout(app);
    const back = await post(app, '/billing/mock/checkout', { session, outcome: 'cancel' });
    expect(back.json<{ redirect: string }>().redirect).toContain('billing=cancel');
    const late = await post(app, '/billing/mock/checkout', { session, outcome: 'paid' });
    expect(late.statusCode).toBe(409);
    expect(activations(queries)).toHaveLength(0);
  });

  it('SAD: paying the same session twice activates once', async () => {
    const { app, queries } = buildApp();
    const { session } = await startCheckout(app);
    await post(app, '/billing/mock/checkout', { session, outcome: 'paid' });
    const again = await post(app, '/billing/mock/checkout', { session, outcome: 'paid' });
    expect(again.statusCode).toBe(409);
    expect(activations(queries)).toHaveLength(1);
  });

  it('SAD: an unknown session and an unknown outcome are refused', async () => {
    const { app } = buildApp();
    expect(
      (await post(app, '/billing/mock/checkout', { session: 'cs_mock_nope', outcome: 'paid' }))
        .statusCode
    ).toBe(409);
    const { session } = await startCheckout(app);
    expect(
      (await post(app, '/billing/mock/checkout', { session, outcome: 'bogus' })).statusCode
    ).toBe(400);
    const expired = await app.inject({
      method: 'GET',
      url: '/billing/mock/checkout?session=cs_mock_nope',
    });
    expect(expired.body).toContain('expired');
  });
});

describe('billing portal', () => {
  async function subscribed() {
    const ctx = buildApp();
    const { session } = await startCheckout(ctx.app);
    await post(ctx.app, '/billing/mock/checkout', { session, outcome: 'paid' });
    const portal = await post(ctx.app, '/billing/portal', {});
    expect(portal.statusCode).toBe(200);
    return { ...ctx, portalUrl: portal.json<{ url: string }>().url };
  }

  it('HAPPY: the portal link works, and cancelling there cancels the tenant through the webhook', async () => {
    const { app, queries, tenant, portalUrl } = await subscribed();
    expect(portalUrl).toContain('https://api.test/billing/mock/portal?customer=');
    const u = new URL(portalUrl);
    const page = await app.inject({ method: 'GET', url: u.pathname + u.search });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Cancel subscription');

    const res = await post(app, '/billing/mock/portal', {
      customer: tenant.customer,
      action: 'cancel',
      return_url: `${DASHBOARD}/dashboard`,
    });
    expect(res.json<{ redirect: string }>().redirect).toBe(`${DASHBOARD}/dashboard`);
    const canceled = queries.filter((q) => q.sql.includes("subscription_status = 'canceled'"));
    expect(canceled).toHaveLength(1);
    expect(canceled[0].params[0]).toBe(tenant.customer);
  });

  it('HAPPY: a failed renewal marks past_due, and a recovery lifts it', async () => {
    const { app, queries, tenant } = await subscribed();
    await post(app, '/billing/mock/portal', { customer: tenant.customer, action: 'fail_payment' });
    expect(queries.some((q) => q.sql.includes("subscription_status = 'past_due'"))).toBe(true);
    const before = queries.length;
    await post(app, '/billing/mock/portal', {
      customer: tenant.customer,
      action: 'recover_payment',
    });
    const recovered = queries
      .slice(before)
      .find((q) => q.sql.includes("subscription_status = 'active'"));
    expect(recovered).toBeDefined();
  });

  it('REGRESSION: cancelling and subscribing again gets NO second trial (Stripe history, not our NULLed column)', async () => {
    const { app, tenant } = await subscribed();
    await post(app, '/billing/mock/portal', { customer: tenant.customer, action: 'cancel' });
    expect(tenant.subscription).toBeNull(); // our own column forgot the subscription...
    const second = await startCheckout(app);
    const pageRes = await app.inject({
      method: 'GET',
      url: `/billing/mock/checkout?session=${second.session}`,
    });
    // ...but the mock, like Stripe, remembers it, so the second checkout is billed from day one.
    expect(pageRes.body).toContain('Billed monthly, starting today');
    expect(pageRes.body).not.toContain('Free for 14 days');
  });

  it('SAD: a portal action without a customer, or an unknown action, is refused', async () => {
    const { app } = buildApp();
    expect((await post(app, '/billing/mock/portal', { action: 'cancel' })).statusCode).toBe(400);
    expect(
      (await post(app, '/billing/mock/portal', { customer: 'cus_mock_1', action: 'explode' }))
        .statusCode
    ).toBe(400);
  });
});

describe('safety', () => {
  it('SAD: outside mock mode the pages do not exist (404), whatever was registered', async () => {
    const { app } = buildApp();
    vi.stubEnv('STRIPE_MODE', '');
    for (const [method, url] of [
      ['GET', '/billing/mock/checkout?session=cs_mock_1'],
      ['GET', '/billing/mock/portal?customer=cus_mock_1'],
      ['POST', '/billing/mock/checkout'],
      ['POST', '/billing/mock/portal'],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('SAD: the mock can never be switched on in production', async () => {
    const { app } = buildApp();
    vi.stubEnv('NODE_ENV', 'production');
    const res = await app.inject({
      method: 'GET',
      url: '/billing/mock/checkout?session=cs_mock_1',
    });
    expect(res.statusCode).toBe(404);
  });

  it('SAD: the webhook signature gate is still real in mock mode', async () => {
    const { app, queries } = buildApp();
    const mock = getMockStripe();
    const event = {
      id: 'evt_x',
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_x',
          subscription: 'sub_x',
          metadata: { tenant_id: TENANT_ID, plan: 'solo' },
        },
      },
    } as never;

    const forged = mock.sign(event, 'whsec_attacker');
    const bad = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': forged.header },
      payload: forged.body,
    });
    expect(bad.statusCode).toBe(400);
    expect(activations(queries)).toHaveLength(0);

    const noSig = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: { 'content-type': 'application/json' },
      payload: forged.body,
    });
    expect(noSig.statusCode).toBe(400);

    const good = mock.sign(event, stripeWebhookSecret());
    const ok = await app.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': good.header },
      payload: good.body,
    });
    expect(ok.statusCode).toBe(200);
    expect(activations(queries)).toHaveLength(1);
  });

  it('SAD: the portal never redirects to a URL outside the dashboard (no open redirect)', async () => {
    const { app } = buildApp();
    const res = await post(app, '/billing/mock/portal', {
      customer: 'cus_mock_1',
      action: 'back',
      return_url: 'https://evil.example/phish',
    });
    expect(res.json<{ redirect: string }>().redirect).toBe(DASHBOARD);
    expect(safeReturnUrl('not a url')).toBe(DASHBOARD);
    expect(safeReturnUrl(`${DASHBOARD}/dashboard?x=1`)).toBe(`${DASHBOARD}/dashboard?x=1`);
  });

  it('SAD: request values are escaped into the page, never into script (no injection)', async () => {
    const { app } = buildApp();
    const evil = `"><script>alert(1)</script>`;
    const res = await app.inject({
      method: 'GET',
      url: `/billing/mock/portal?customer=${encodeURIComponent(evil)}&return_url=${encodeURIComponent(evil)}`,
    });
    expect(res.body).not.toContain('<script>alert(1)');
    expect(res.body).toContain('&lt;script&gt;');
    // Values travel in data- attributes read by one fixed script, not spliced into inline code.
    expect(res.body).not.toMatch(/onclick="act\('/);
  });
});
