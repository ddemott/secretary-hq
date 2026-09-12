/**
 * Route-level tests for the billing module (/billing/*).
 *
 * Strategy: mock the Stripe SDK entirely; test that route handlers call the
 * right Stripe methods, pass tenant data through correctly, and translate
 * Stripe responses + errors into the right HTTP shapes. DB state transitions
 * are verified at the query level (what SQL was fired), not by replaying
 * real migrations — that is already covered by billing.test.ts.
 *
 * NOTE: vi.mock + vi.hoisted are hoisted by Vitest before static imports
 * resolve, so billing.ts's module-level env constants capture the stubbed
 * values at module-evaluation time. No prod-code change needed.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

// ── Env stubs must be set BEFORE billing.ts is evaluated ─────────────────
vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fakefakefake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  process.env.STRIPE_SOLO_PRICE_ID = 'price_solo_test';
  process.env.STRIPE_GROWTH_PRICE_ID = 'price_growth_test';
  process.env.STRIPE_PRO_PRICE_ID = 'price_pro_test';
});

// ── Stripe SDK mock ───────────────────────────────────────────────────────
const mockCheckoutCreate = vi.fn();
const mockConstructEvent = vi.fn();
const mockPortalCreate = vi.fn();
const mockCustomersCreate = vi.fn();

vi.mock('stripe', () => ({
  // Must use function() not arrow — `new Stripe()` in billing.ts fails with an arrow impl.
  default: vi.fn(function () {
    return {
      checkout: { sessions: { create: mockCheckoutCreate } },
      webhooks: { constructEvent: mockConstructEvent },
      billingPortal: { sessions: { create: mockPortalCreate } },
      customers: { create: mockCustomersCreate },
    };
  }),
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { registerBillingRoutes, subscriptionGate } from '../../src/routes/billing';
import { registry, errorsTotal } from '../../src/services/metrics';
import { jsonContentTypeParser } from '../../src/jsonContentTypeParser';

function errorsTotalFor(event: string): number {
  return errorsTotal.snapshot().find((s) => s.labels.event === event)?.value ?? 0;
}
import type { AppRequest } from '../../src/middleware/fastify-middleware';

const TENANT_ID = 'f234e471-0e60-4163-86c9-93cfd9338e3a';

/**
 * Current value of webhook_signature_failures_total for a label set (T-006).
 * Read as a DELTA around the request under test — the registry is a process
 * singleton and other suites in the same worker also increment it.
 */
function sigFailures(provider: string, endpoint: string): number {
  const line = registry
    .expose()
    .split('\n')
    .find(
      (l) =>
        l.startsWith('webhook_signature_failures_total{') &&
        l.includes(`provider="${provider}"`) &&
        l.includes(`endpoint="${endpoint}"`)
    );
  if (!line) return 0;
  const n = Number(line.trim().split(/\s+/).pop());
  return Number.isFinite(n) ? n : 0;
}

const STRIPE_CUSTOMER_ID = 'cus_test_12345';
const STRIPE_SUBSCRIPTION_ID = 'sub_test_67890';

interface MockQuery {
  text: string;
  params: unknown[];
}

function buildApp(opts: {
  poolResponses: Array<{ rows: unknown[]; rowCount?: number }>;
  injectTenantId?: boolean; // default true
}): { app: FastifyInstance; queries: MockQuery[] } {
  const queries: MockQuery[] = [];
  const responses = [...opts.poolResponses];
  const mockPool = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params: params ?? [] });
      return responses.shift() ?? { rows: [], rowCount: 0 };
    }),
  } as unknown as Pool;

  const app = Fastify({ logger: false });

  // Override Fastify's default JSON parser so webhook routes get req.rawBody.
  // removeContentTypeParser must precede addContentTypeParser for built-in types.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, jsonContentTypeParser);

  // Simulate the JWT + tenantMiddleware pipeline for authenticated routes
  if (opts.injectTenantId !== false) {
    app.addHook('preHandler', async (request) => {
      (request as AppRequest).tenantId = TENANT_ID;
      (request as AppRequest).auth = {
        tenant_id: TENANT_ID,
        user_id: 'u1',
        email: 'owner@test.com',
        role: 'owner',
      };
    });
  }

  registerBillingRoutes(app, mockPool);
  return { app, queries };
}

function post(
  app: FastifyInstance,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {}
) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(payload),
  });
}

function get(app: FastifyInstance, path: string) {
  return app.inject({ method: 'GET', url: path });
}

beforeEach(() => {
  mockCheckoutCreate.mockReset();
  mockConstructEvent.mockReset();
  mockPortalCreate.mockReset();
  mockCustomersCreate.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── POST /billing/checkout ────────────────────────────────────────────────

describe('POST /billing/checkout', () => {
  it('HAPPY: existing Stripe customer — returns checkout URL directly', async () => {
    // WHO: Tenant owner upgrading to a paid plan; already has a Stripe customer record
    // WHAT: Route skips customer creation, creates checkout session with existing customer
    // WHY: We must NOT create duplicate Stripe customers for re-subscribing tenants
    mockCheckoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_test_123' });
    const { app, queries } = buildApp({
      poolResponses: [
        {
          rows: [
            { tenant_id: TENANT_ID, name: 'Test Biz', stripe_customer_id: STRIPE_CUSTOMER_ID },
          ],
        },
      ],
    });

    const res = await post(app, '/billing/checkout', { plan: 'solo' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ url: string }>().url).toBe('https://checkout.stripe.com/pay/cs_test_123');
    expect(mockCustomersCreate).not.toHaveBeenCalled();
    expect(mockCheckoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: STRIPE_CUSTOMER_ID, mode: 'subscription' })
    );
    // DB: only one query (lookup), no customer_id UPDATE
    expect(queries).toHaveLength(1);
  });

  it('HAPPY: no Stripe customer yet — creates customer then checkout session', async () => {
    // WHO: First-time subscriber with no existing Stripe customer
    // WHAT: Route creates a Stripe customer, stores the id, then creates the session
    // WHY: Stripe sessions must have a customer to support subscriptions
    mockCustomersCreate.mockResolvedValue({ id: 'cus_brand_new' });
    mockCheckoutCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_test_new' });
    const { app, queries } = buildApp({
      poolResponses: [
        { rows: [{ tenant_id: TENANT_ID, name: 'Test Biz', stripe_customer_id: null }] },
        { rows: [], rowCount: 1 }, // UPDATE stripe_customer_id
      ],
    });

    const res = await post(app, '/billing/checkout', { plan: 'growth' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ url: string }>().url).toBe('https://checkout.stripe.com/pay/cs_test_new');
    expect(mockCustomersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { tenant_id: TENANT_ID } })
    );
    // DB: lookup + UPDATE with new customer id
    expect(queries[1].text).toContain('UPDATE tenants SET stripe_customer_id');
    expect(queries[1].params[0]).toBe('cus_brand_new');
  });

  it('SAD: invalid plan name → 400', async () => {
    // WHO: Malformed request or LLM supplying wrong plan key
    // WHAT: Route validates plan before touching Stripe
    // WHY: Unknown plan has no price ID; proceeding would produce a 503, not a 400
    const { app } = buildApp({ poolResponses: [] });
    const res = await post(app, '/billing/checkout', { plan: 'enterprise' });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ success: boolean }>().success).toBe(false);
    expect(mockCheckoutCreate).not.toHaveBeenCalled();
  });

  it('SAD: missing plan body field → 400', async () => {
    // WHO: Client omitting the plan field
    const { app } = buildApp({ poolResponses: [] });
    const res = await post(app, '/billing/checkout', {});

    expect(res.statusCode).toBe(400);
    expect(res.json<{ success: boolean }>().success).toBe(false);
  });

  it('SAD: no authenticated session → 401', async () => {
    // WHO: Unauthenticated request hitting the billing route
    // WHAT: requireTenantId sends 401 before route logic runs
    const { app } = buildApp({ poolResponses: [], injectTenantId: false });
    const res = await post(app, '/billing/checkout', { plan: 'solo' });

    expect(res.statusCode).toBe(401);
  });
});

// ── POST /billing/webhook ─────────────────────────────────────────────────

describe('POST /billing/webhook', () => {
  it('HAPPY: checkout.session.completed → activates subscription in DB', async () => {
    // WHO: Stripe sending a successful checkout event after payment
    // WHAT: Route updates tenant subscription_status=active + saves subscription id + plan
    // WHEN: Customer completes Stripe Checkout flow for the first time
    // WHERE: billing.ts checkout.session.completed handler
    // WHY: This is the critical payment → access gate. Tenant must switch active before
    //      the next request, or they'll hit the subscription gate.
    const event = {
      type: 'checkout.session.completed',
      data: {
        object: {
          subscription: STRIPE_SUBSCRIPTION_ID,
          metadata: { tenant_id: TENANT_ID, plan: 'solo' },
        },
      },
    };
    mockConstructEvent.mockReturnValue(event);
    const { app, queries } = buildApp({ poolResponses: [{ rows: [], rowCount: 1 }] });

    const res = await post(app, '/billing/webhook', event, { 'stripe-signature': 'sig_test' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ received: boolean }>().received).toBe(true);
    expect(queries[0].text).toContain("subscription_status = 'active'");
    expect(queries[0].text).toContain('stripe_subscription_id');
    expect(queries[0].params).toContain(STRIPE_SUBSCRIPTION_ID);
    expect(queries[0].params).toContain('solo');
    expect(queries[0].params).toContain(TENANT_ID);
  });

  it('HAPPY: invoice.payment_failed → marks subscription past_due', async () => {
    // WHO: Stripe notifying that a renewal payment failed
    // WHAT: Route flips subscription_status=past_due by stripe_customer_id
    // WHY: past_due is blocked by subscriptionGate — owner sees the UI warning
    const event = {
      type: 'invoice.payment_failed',
      data: { object: { customer: STRIPE_CUSTOMER_ID } },
    };
    mockConstructEvent.mockReturnValue(event);
    const { app, queries } = buildApp({ poolResponses: [{ rows: [], rowCount: 1 }] });

    const res = await post(app, '/billing/webhook', event, { 'stripe-signature': 'sig_test' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ received: boolean }>().received).toBe(true);
    expect(queries[0].text).toContain("subscription_status = 'past_due'");
    expect(queries[0].params).toContain(STRIPE_CUSTOMER_ID);
  });

  it('HAPPY: customer.subscription.deleted → cancels and clears sub fields', async () => {
    // WHO: Stripe notifying that a subscription was canceled (owner-initiated or failed)
    // WHAT: Route sets status=canceled + NULLs subscription_id + plan
    // WHY: subscription_id must be cleared so a future checkout can create a new sub
    //      without being treated as a modification
    const event = {
      type: 'customer.subscription.deleted',
      data: { object: { customer: STRIPE_CUSTOMER_ID } },
    };
    mockConstructEvent.mockReturnValue(event);
    const { app, queries } = buildApp({ poolResponses: [{ rows: [], rowCount: 1 }] });

    const res = await post(app, '/billing/webhook', event, { 'stripe-signature': 'sig_test' });

    expect(res.statusCode).toBe(200);
    expect(queries[0].text).toContain("subscription_status = 'canceled'");
    expect(queries[0].text).toContain('stripe_subscription_id = NULL');
    expect(queries[0].text).toContain('subscription_plan = NULL');
    expect(queries[0].params).toContain(STRIPE_CUSTOMER_ID);
  });

  it('HAPPY: unknown event type → 200 received:true, no DB call', async () => {
    // WHO: Stripe sending events we haven't subscribed to (e.g. payment_intent.created)
    // WHAT: Route logs the event and returns 200 without touching DB
    // WHY: Stripe retries on non-200 — unknown events must not return errors
    const event = { type: 'payment_intent.created', data: { object: {} } };
    mockConstructEvent.mockReturnValue(event);
    const { app, queries } = buildApp({ poolResponses: [] });

    const res = await post(app, '/billing/webhook', event, { 'stripe-signature': 'sig_test' });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ received: boolean }>().received).toBe(true);
    expect(queries).toHaveLength(0);
  });

  it('SAD (security): missing stripe-signature header → 400', async () => {
    // WHO: Any caller posting to the webhook without a Stripe signature
    // WHAT: Route returns 400 immediately — does not attempt event processing
    // WHY: Without signature verification, anyone could forge events and
    //      activate subscriptions they haven't paid for
    const { app, queries } = buildApp({ poolResponses: [] });
    const before = sigFailures('stripe', 'billing_webhook');

    const res = await post(app, '/billing/webhook', { type: 'checkout.session.completed' });

    expect(res.statusCode).toBe(400);
    expect(queries).toHaveLength(0);
    expect(mockConstructEvent).not.toHaveBeenCalled();
    // T-006: a MISSING signature is counted the same as a bad one. Both mean an
    // unverifiable POST arrived; splitting them would let an attacker choose
    // the quieter counter.
    expect(sigFailures('stripe', 'billing_webhook')).toBe(before + 1);
  });

  it('SAD (security): invalid signature → 400, no DB mutation', async () => {
    // WHO: Attacker replaying a captured Stripe request with a bad signature,
    //      or a misconfigured STRIPE_WEBHOOK_SECRET
    // WHAT: constructEvent throws → route returns 400, no tenant DB mutations
    // WHY: THE authorization gate for webhook processing — a forged checkout.session.completed
    //      event would activate a subscription without real payment
    mockConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });
    const { app, queries } = buildApp({ poolResponses: [] });
    const before = sigFailures('stripe', 'billing_webhook');

    const res = await post(
      app,
      '/billing/webhook',
      { type: 'checkout.session.completed' },
      {
        'stripe-signature': 'bad_sig',
      }
    );

    expect(res.statusCode).toBe(400);
    expect(queries).toHaveLength(0);
    // T-006: this is the series docs/ALERTS.md pages on. Without it, a forged
    // webhook run leaves nothing behind but a log line in a sink nobody reads.
    expect(sigFailures('stripe', 'billing_webhook')).toBe(before + 1);
  });
});

// ── GET /billing/status ───────────────────────────────────────────────────

describe('GET /billing/status', () => {
  it('HAPPY: returns subscription_status and subscription_plan', async () => {
    // WHO: Dashboard loading the Billing subtab
    // WHAT: Returns the two Stripe-related fields from the tenants row
    const { app } = buildApp({
      poolResponses: [{ rows: [{ subscription_status: 'active', subscription_plan: 'growth' }] }],
    });

    const res = await get(app, '/billing/status');

    expect(res.statusCode).toBe(200);
    const body = res.json<{ subscription_status: string; subscription_plan: string }>();
    expect(body.subscription_status).toBe('active');
    expect(body.subscription_plan).toBe('growth');
  });

  it('SAD: tenant not found in DB → 404', async () => {
    // WHO: Stale JWT for a deleted tenant
    const { app } = buildApp({ poolResponses: [{ rows: [] }] });
    const res = await get(app, '/billing/status');
    expect(res.statusCode).toBe(404);
  });

  it('SAD: no authenticated session → 401', async () => {
    const { app } = buildApp({ poolResponses: [], injectTenantId: false });
    const res = await get(app, '/billing/status');
    expect(res.statusCode).toBe(401);
  });
});

// ── POST /billing/portal ──────────────────────────────────────────────────

describe('POST /billing/portal', () => {
  it('HAPPY: tenant with Stripe customer → returns portal URL', async () => {
    // WHO: Owner clicking "Manage Billing" to update payment method or view invoices
    // WHAT: Route creates a Stripe Customer Portal session + returns the URL
    // WHY: Customer Portal gives owners self-service access to invoices/cancellations
    mockPortalCreate.mockResolvedValue({ url: 'https://billing.stripe.com/p/session_test' });
    const { app } = buildApp({
      poolResponses: [{ rows: [{ stripe_customer_id: STRIPE_CUSTOMER_ID }] }],
    });

    const res = await post(app, '/billing/portal', {});

    expect(res.statusCode).toBe(200);
    expect(res.json<{ url: string }>().url).toBe('https://billing.stripe.com/p/session_test');
    expect(mockPortalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: STRIPE_CUSTOMER_ID })
    );
  });

  it('SAD: tenant has no Stripe customer yet → 400', async () => {
    // WHO: Owner clicking "Manage Billing" before ever completing checkout
    // WHAT: Route returns 400 with actionable message (not a 500)
    // WHY: Customer Portal requires a customer record — direct owner to checkout first
    const { app } = buildApp({
      poolResponses: [{ rows: [{ stripe_customer_id: null }] }],
    });

    const res = await post(app, '/billing/portal', {});

    expect(res.statusCode).toBe(400);
    const body = res.json<{ success: boolean; error: string }>();
    expect(body.success).toBe(false);
    expect(body.error).toContain('checkout');
    expect(mockPortalCreate).not.toHaveBeenCalled();
  });

  it('SAD: no authenticated session → 401', async () => {
    const { app } = buildApp({ poolResponses: [], injectTenantId: false });
    const res = await post(app, '/billing/portal', {});
    expect(res.statusCode).toBe(401);
  });
});

// ── subscriptionGate middleware ───────────────────────────────────────────

describe('subscriptionGate middleware/fastify-middleware', () => {
  function buildGatedApp(status: string | null) {
    // Create a minimal app with subscriptionGate + a probe route that returns 200
    const mockPool = {
      query: vi.fn(async () => ({
        rows: status !== null ? [{ subscription_status: status }] : [],
        rowCount: status !== null ? 1 : 0,
      })),
    } as unknown as Pool;

    const app = Fastify({ logger: false });

    // Register the gate globally
    app.addHook('preHandler', subscriptionGate(mockPool));
    // Probe route behind the gate
    app.get('/some-data', async (_req, reply) => reply.send({ ok: true }));

    return app;
  }

  it("PASS: 'active' subscription is allowed through", async () => {
    // WHO: Paying subscriber accessing any endpoint
    // WHAT: Gate queries DB, sees active, calls next() — no blocking
    const app = buildGatedApp('active');
    const res = await app.inject({ method: 'GET', url: '/some-data?tenant_id=' + TENANT_ID });
    expect(res.statusCode).toBe(200);
  });

  it("PASS: 'inactive' subscription is allowed (beta grace period)", async () => {
    // WHO: New tenant on free trial / pre-payment
    // WHAT: inactive is the default; gate explicitly allows it
    const app = buildGatedApp('inactive');
    const res = await app.inject({ method: 'GET', url: '/some-data?tenant_id=' + TENANT_ID });
    expect(res.statusCode).toBe(200);
  });

  it("BLOCK: 'past_due' subscription returns 402", async () => {
    // WHO: Tenant whose payment failed; renewal window expired
    // WHAT: Gate returns 402 so the dashboard can show the "update payment" warning
    // WHY: Subscriptions must be maintained; past_due blocks API access to enforce it
    const app = buildGatedApp('past_due');
    const res = await app.inject({ method: 'GET', url: '/some-data?tenant_id=' + TENANT_ID });
    expect(res.statusCode).toBe(402);
    expect(res.json<{ subscription_status: string }>().subscription_status).toBe('past_due');
  });

  it("BLOCK: 'canceled' subscription returns 402", async () => {
    // WHO: Former subscriber who canceled or was canceled after prolonged non-payment
    // WHAT: Gate returns 402; owner must re-subscribe to regain access
    const app = buildGatedApp('canceled');
    const res = await app.inject({ method: 'GET', url: '/some-data?tenant_id=' + TENANT_ID });
    expect(res.statusCode).toBe(402);
    expect(res.json<{ subscription_status: string }>().subscription_status).toBe('canceled');
  });

  it('PASS: super-admin tenant is always exempt', async () => {
    // WHO: Platform super-admin (tenant 00000000-...) performing cross-tenant ops
    // WHAT: Gate short-circuits before DB query for the super-admin tenant ID
    // WHY: Super-admin must never be blocked by subscription logic
    const SUPER_ADMIN_ID = '00000000-0000-0000-0000-000000000000';
    const mockPool = {
      query: vi.fn().mockRejectedValue(new Error('should not be called')),
    } as unknown as Pool;
    const app = Fastify({ logger: false });
    app.addHook('preHandler', subscriptionGate(mockPool));
    app.get('/admin-action', async (_req, reply) => reply.send({ ok: true }));

    const res = await app.inject({
      method: 'GET',
      url: `/admin-action?tenant_id=${SUPER_ADMIN_ID}`,
    });

    expect(res.statusCode).toBe(200);
    // Pool must NOT have been queried — the ID check gates before any DB call
    expect((mockPool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('PASS: /billing/* routes are exempt (allow checkout even when past_due)', async () => {
    // WHO: Past-due tenant clicking "Update Payment" → must reach /billing/checkout
    // WHAT: Billing prefix is in EXEMPT_PREFIXES; gate skips DB check
    // WHY: If the billing routes are gated, a past_due tenant can never fix their billing
    const mockPool = {
      query: vi.fn().mockRejectedValue(new Error('should not be called')),
    } as unknown as Pool;
    const app = Fastify({ logger: false });
    app.addHook('preHandler', subscriptionGate(mockPool));
    app.post('/billing/checkout', async (_req, reply) => reply.send({ ok: true }));

    const res = await app.inject({
      method: 'POST',
      url: `/billing/checkout?tenant_id=${TENANT_ID}`,
      payload: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(200);
    expect((mockPool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('SAD: a DB error fails open (request still passes) but bumps errors_total', async () => {
    // WHO: platform operator watching /metrics, not the caller
    // WHAT: the gate's own query throws; the request must still reach the
    //       route handler (fail-open is deliberate — see the comment in
    //       billing.ts), but the failure must be COUNTED so it can be acted
    //       on, per this codebase's "instrument every sad path" rule
    // WHY: a silently-swallowed error here means nobody would ever notice
    //      the gate stopped protecting anything
    const mockPool = {
      query: vi.fn().mockRejectedValue(new Error('connection reset')),
    } as unknown as Pool;
    const app = Fastify({ logger: false });
    app.addHook('preHandler', subscriptionGate(mockPool));
    app.get('/some-data', async (_req, reply) => reply.send({ ok: true }));

    const before = errorsTotalFor('subscription_gate_error');
    const res = await app.inject({ method: 'GET', url: '/some-data?tenant_id=' + TENANT_ID });

    expect(res.statusCode).toBe(200);
    expect(errorsTotalFor('subscription_gate_error')).toBe(before + 1);
  });
});
