/**
 * The Stripe gateway seam and the in-process Stripe mock.
 *
 * WHO: any developer or CI run without a Stripe account | WHAT: the mock behaves like Stripe
 * where the app's own logic depends on it | WHEN: every run | WHERE: src/services/stripe/ |
 * WHY: billing is built and tested end to end on the mock, then attached to the real account
 * by configuration alone. A mock that drifts from Stripe would make that attach a surprise.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Stripe from 'stripe';
import {
  getStripeGateway,
  getMockStripe,
  resetMockStripeForTesting,
  resolveStripeMode,
  stripePriceIds,
  stripeWebhookSecret,
} from '../../src/services/stripe/gateway';
import {
  MockStripe,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../../src/services/stripe/mockStripe';

describe('resolveStripeMode', () => {
  it('HAPPY: STRIPE_MODE=mock selects the mock outside production', () => {
    expect(resolveStripeMode({ STRIPE_MODE: 'mock', NODE_ENV: 'development' })).toBe('mock');
    expect(resolveStripeMode({ STRIPE_MODE: 'mock' })).toBe('mock');
  });

  it('SAD: the mock can NEVER be selected in production, even with the flag set', () => {
    // A stray flag in prod must not be able to mint a plan.
    expect(resolveStripeMode({ STRIPE_MODE: 'mock', NODE_ENV: 'production' })).toBeNull();
    expect(
      resolveStripeMode({ STRIPE_MODE: 'mock', NODE_ENV: 'production', STRIPE_SECRET_KEY: 'sk_x' })
    ).toBe('stripe');
  });

  it('HAPPY: a Stripe key selects the real SDK; the mock flag wins over a key outside production', () => {
    expect(resolveStripeMode({ STRIPE_SECRET_KEY: 'sk_test_1' })).toBe('stripe');
    expect(resolveStripeMode({ STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_MODE: 'mock' })).toBe('mock');
  });

  it('SAD: nothing configured means billing is not configured', () => {
    expect(resolveStripeMode({})).toBeNull();
    expect(getStripeGateway({})).toBeNull();
  });
});

describe('configuration per mode', () => {
  it('mock mode uses recognisable price ids and a default webhook secret', () => {
    const env = { STRIPE_MODE: 'mock' };
    expect(stripePriceIds(env)).toEqual({
      solo: 'price_mock_solo',
      growth: 'price_mock_growth',
      professional: 'price_mock_professional',
    });
    expect(stripeWebhookSecret(env)).toBe('whsec_mock');
    expect(stripeWebhookSecret({ ...env, STRIPE_WEBHOOK_SECRET: 'whsec_mine' })).toBe('whsec_mine');
  });

  it('real mode reads the price ids and secret from the environment', () => {
    const env = {
      STRIPE_SECRET_KEY: 'sk_test_1',
      STRIPE_SOLO_PRICE_ID: 'price_s',
      STRIPE_GROWTH_PRICE_ID: 'price_g',
      STRIPE_PRO_PRICE_ID: 'price_p',
      STRIPE_WEBHOOK_SECRET: 'whsec_real',
    };
    expect(stripePriceIds(env)).toEqual({
      solo: 'price_s',
      growth: 'price_g',
      professional: 'price_p',
    });
    expect(stripeWebhookSecret(env)).toBe('whsec_real');
    // No mock fallback in real mode: an unset secret stays empty so verification fails closed.
    expect(stripeWebhookSecret({ STRIPE_SECRET_KEY: 'sk_test_1' })).toBe('');
  });

  it('the mock is one object per process, so its state persists across requests', () => {
    resetMockStripeForTesting();
    expect(getStripeGateway({ STRIPE_MODE: 'mock' })).toBe(getMockStripe());
    expect(getMockStripe()).toBe(getMockStripe());
  });
});

describe('MockStripe', () => {
  let mock: MockStripe;
  beforeEach(() => {
    mock = new MockStripe();
  });

  async function checkout(opts: { trial?: boolean; customer?: string } = {}) {
    const customer = opts.customer ?? (await mock.customers.create({ name: 'Biz' })).id;
    const session = await mock.checkout.sessions.create({
      customer,
      mode: 'subscription',
      line_items: [{ price: 'price_mock_growth', quantity: 1 }],
      ...(opts.trial && { subscription_data: { trial_period_days: 14 } }),
      success_url: 'https://app/ok',
      cancel_url: 'https://app/no',
      metadata: { tenant_id: 't-1', plan: 'growth' },
    });
    return { customer, session };
  }

  it('HAPPY: ids look like Stripe ids and a checkout points at the mock hosted page', async () => {
    const { customer, session } = await checkout();
    expect(customer).toMatch(/^cus_mock_\d+$/);
    expect(session.id).toMatch(/^cs_mock_\d+$/);
    expect(session.url).toContain(`/billing/mock/checkout/${session.id}`);
  });

  it('HAPPY: paying completes the session and emits checkout.session.completed with our metadata', async () => {
    const { customer, session } = await checkout();
    const events = mock.completeCheckout(session.id, 'paid');
    expect(events).toHaveLength(1);
    const obj = events[0].data.object as unknown as Record<string, unknown>;
    expect(events[0].type).toBe('checkout.session.completed');
    expect(obj.customer).toBe(customer);
    expect(obj.subscription).toMatch(/^sub_mock_\d+$/);
    expect(obj.payment_status).toBe('paid');
    expect(obj.metadata).toEqual({ tenant_id: 't-1', plan: 'growth' });
    expect(mock.getSession(session.id)?.status).toBe('complete');
  });

  it('HAPPY: a trial checkout starts trialing and is not "unpaid", so the tenant still activates', async () => {
    const { customer, session } = await checkout({ trial: true });
    const [event] = mock.completeCheckout(session.id, 'paid');
    expect((event.data.object as unknown as { payment_status: string }).payment_status).toBe(
      'no_payment_required'
    );
    const { data } = await mock.subscriptions.list({ customer, status: 'all' });
    expect((data[0] as { status: string }).status).toBe('trialing');
  });

  it('SAD: a declined card starts no subscription and sends no event', async () => {
    const { customer, session } = await checkout();
    expect(mock.completeCheckout(session.id, 'declined')).toEqual([]);
    expect((await mock.subscriptions.list({ customer, status: 'all' })).data).toHaveLength(0);
    expect(mock.getSession(session.id)?.status).toBe('open');
  });

  it('SAD: an abandoned or already-completed session cannot be paid', async () => {
    const a = await checkout();
    mock.cancelCheckout(a.session.id);
    expect(() => mock.completeCheckout(a.session.id, 'paid')).toThrow(/not open/);
    const b = await checkout();
    mock.completeCheckout(b.session.id, 'paid');
    expect(() => mock.completeCheckout(b.session.id, 'paid')).toThrow(/not open/);
    expect(() => mock.completeCheckout('cs_mock_nope', 'paid')).toThrow(/not open/);
  });

  it('REGRESSION: canceled subscriptions stay in the history, so a cancel + resubscribe gets no second trial', async () => {
    // The app's one-trial-per-customer rule lists with status "all". The mock must keep a
    // canceled subscription visible there, exactly as Stripe does.
    const { customer, session } = await checkout({ trial: true });
    mock.completeCheckout(session.id, 'paid');
    const [deleted] = mock.cancelSubscriptionFor(customer);
    expect(deleted.type).toBe('customer.subscription.deleted');
    expect(
      (await mock.subscriptions.list({ customer, status: 'all', limit: 1 })).data
    ).toHaveLength(1);
    // ...while the default listing hides it.
    expect((await mock.subscriptions.list({ customer })).data).toHaveLength(0);
  });

  it('HAPPY: a failed renewal then a recovery emit the events the webhook handler understands', async () => {
    const { customer, session } = await checkout();
    mock.completeCheckout(session.id, 'paid');
    const [failed] = mock.failPaymentFor(customer);
    expect(failed.type).toBe('invoice.payment_failed');
    expect((failed.data.object as unknown as { customer: string }).customer).toBe(customer);
    const [paid] = mock.recoverPaymentFor(customer);
    expect(paid.type).toBe('invoice.paid');
    const sub = (paid.data.object as unknown as { subscription: string }).subscription;
    expect(sub).toMatch(/^sub_mock_\d+$/);
  });

  it('HAPPY: the billing portal URL carries the customer and the return url', async () => {
    const { url } = await mock.billingPortal.sessions.create({
      customer: 'cus_mock_9',
      return_url: 'https://app/billing',
    });
    expect(url).toContain('/billing/mock/portal');
    expect(url).toContain('customer=cus_mock_9');
    expect(url).toContain(encodeURIComponent('https://app/billing'));
  });
});

describe('webhook signing', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { object: {} } });

  it('HAPPY: a signed payload verifies and parses', () => {
    const mock = new MockStripe();
    const header = signWebhookPayload(body, secret);
    expect(mock.webhooks.constructEvent(body, header, secret).id).toBe('evt_1');
  });

  it('REGRESSION: a header signed by the mock is accepted by the REAL Stripe SDK', () => {
    // The mock is only worth having if it speaks Stripe's actual signature scheme: then the
    // real webhook route verifies mock events and real events by the same code path.
    const real = new Stripe('sk_test_dummy');
    const header = signWebhookPayload(body, secret);
    expect(real.webhooks.constructEvent(body, header, secret).id).toBe('evt_1');
  });

  it('REGRESSION: a header signed by the REAL Stripe SDK is accepted by the mock', () => {
    const real = new Stripe('sk_test_dummy');
    const header = real.webhooks.generateTestHeaderString({ payload: body, secret });
    expect(() => verifyWebhookSignature(body, header, secret)).not.toThrow();
  });

  it('SAD: a tampered body, the wrong secret, and a stale timestamp are all rejected', () => {
    const header = signWebhookPayload(body, secret);
    expect(() => verifyWebhookSignature(body + ' ', header, secret)).toThrow(/signature/i);
    expect(() => verifyWebhookSignature(body, header, 'whsec_other')).toThrow(/signature/i);
    const old = signWebhookPayload(body, secret, Math.floor(Date.now() / 1000) - 3600);
    expect(() => verifyWebhookSignature(body, old, secret)).toThrow(/tolerance/i);
  });

  it('SAD: a malformed header is rejected rather than crashing', () => {
    expect(() => verifyWebhookSignature(body, 'garbage', secret)).toThrow();
    expect(() => verifyWebhookSignature(body, 't=abc,v1=zz', secret)).toThrow();
    expect(() => verifyWebhookSignature(body, '', secret)).toThrow();
  });
});
