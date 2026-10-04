/**
 * An in-process stand-in for Stripe, so the whole billing path (checkout, trial,
 * webhooks, the billing portal, cancellation) runs end to end with no Stripe
 * account. It is selected by STRIPE_MODE=mock and never in production (see
 * gateway.ts). When the real account is attached the app does not change: the
 * same routes talk to the real SDK instead.
 *
 * What it keeps faithful to Stripe, because the app's own logic depends on it:
 *   - ids look like Stripe's (`cus_mock_1`, `cs_mock_2`, `sub_mock_3`);
 *   - `subscriptions.list` includes canceled subscriptions, so the one-trial-per-
 *     customer rule behaves exactly as it does against Stripe;
 *   - a subscription started with `trial_period_days` is `trialing`, else `active`;
 *   - webhook payloads are signed with Stripe's scheme (`t=<ts>,v1=HMAC-SHA256`)
 *     and verified with the same tolerance, so the real signature gate is exercised.
 *
 * State is in memory: a server restart forgets open sessions and history. That is
 * fine for local dev and CI; it is not a billing system.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type Stripe from 'stripe';
import type { StripeGateway } from './gateway';

/** Same replay window Stripe's SDK enforces by default. */
const TOLERANCE_SECONDS = 300;

export type MockCheckoutOutcome = 'paid' | 'declined';

export interface MockCheckoutSession {
  id: string;
  customer: string | null;
  priceId: string | null;
  metadata: Record<string, string>;
  trialDays: number;
  successUrl: string;
  cancelUrl: string;
  status: 'open' | 'complete' | 'expired';
  subscriptionId: string | null;
}

export interface MockSubscription {
  id: string;
  customer: string;
  priceId: string;
  status: 'trialing' | 'active' | 'past_due' | 'canceled';
}

export interface SignedWebhook {
  body: string;
  header: string;
}

export function mockBackendBase(env: Record<string, string | undefined> = process.env): string {
  return env.BACKEND_PUBLIC_URL || 'https://localhost:4001';
}

/** Build Stripe's `Stripe-Signature` header for a payload. */
export function signWebhookPayload(
  payload: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000)
): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/** Verify a `Stripe-Signature` header; throws like the SDK's constructEvent does. */
export function verifyWebhookSignature(
  payload: string | Buffer,
  header: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): void {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    })
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || !parts.v1) {
    throw new Error('Unable to extract timestamp and signatures from header');
  }
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${typeof payload === 'string' ? payload : payload.toString('utf8')}`)
    .digest();
  const given = Buffer.from(parts.v1, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Error('No signatures found matching the expected signature for payload');
  }
  if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) {
    throw new Error('Timestamp outside the tolerance zone');
  }
}

export class MockStripe implements StripeGateway {
  readonly mode = 'mock' as const;

  private seq = 0;
  private readonly sessions = new Map<string, MockCheckoutSession>();
  private readonly subscriptionsById = new Map<string, MockSubscription>();
  private readonly customerIds = new Set<string>();

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_mock_${this.seq}`;
  }

  readonly customers = {
    create: (params: Stripe.CustomerCreateParams) => {
      void params;
      const id = this.nextId('cus');
      this.customerIds.add(id);
      return Promise.resolve({ id });
    },
  };

  readonly subscriptions = {
    list: (params: Stripe.SubscriptionListParams) => {
      let data = [...this.subscriptionsById.values()].filter((s) => s.customer === params.customer);
      // Like Stripe, the default listing hides canceled subscriptions; status 'all' includes them.
      if (params.status !== 'all') data = data.filter((s) => s.status !== 'canceled');
      if (params.limit) data = data.slice(0, params.limit);
      return Promise.resolve({ data });
    },
  };

  readonly checkout = {
    sessions: {
      create: (params: Stripe.Checkout.SessionCreateParams) => {
        const id = this.nextId('cs');
        const session: MockCheckoutSession = {
          id,
          customer: typeof params.customer === 'string' ? params.customer : null,
          priceId: params.line_items?.[0]?.price ?? null,
          metadata: Object.fromEntries(
            Object.entries(params.metadata ?? {})
              .filter(([, v]) => v !== null)
              .map(([k, v]) => [k, String(v)])
          ),
          trialDays: params.subscription_data?.trial_period_days ?? 0,
          successUrl: params.success_url ?? '',
          cancelUrl: params.cancel_url ?? '',
          status: 'open',
          subscriptionId: null,
        };
        this.sessions.set(id, session);
        return Promise.resolve({ id, url: `${mockBackendBase()}/billing/mock/checkout/${id}` });
      },
    },
  };

  readonly billingPortal = {
    sessions: {
      create: (params: Stripe.BillingPortal.SessionCreateParams) =>
        Promise.resolve({
          url:
            `${mockBackendBase()}/billing/mock/portal` +
            `?customer=${encodeURIComponent(params.customer ?? '')}` +
            `&return_url=${encodeURIComponent(params.return_url ?? '')}`,
        }),
    },
  };

  readonly webhooks = {
    constructEvent: (
      payload: string | Buffer,
      header: string | string[],
      secret: string
    ): Stripe.Event => {
      verifyWebhookSignature(payload, Array.isArray(header) ? (header[0] ?? '') : header, secret);
      return JSON.parse(
        typeof payload === 'string' ? payload : payload.toString('utf8')
      ) as Stripe.Event;
    },
  };

  // ── What a person does on Stripe's hosted pages ──────────────────────────

  getSession(id: string): MockCheckoutSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * The customer finishes the hosted checkout. Returns the webhook events Stripe
   * would send, in order, for the caller to deliver to /billing/webhook.
   * - 'paid':     checkout.session.completed
   * - 'declined': the card is refused; the subscription never starts, nothing is sent.
   */
  completeCheckout(id: string, outcome: MockCheckoutOutcome): Stripe.Event[] {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'open')
      throw new Error(`Checkout session ${id} is not open`);
    if (outcome === 'declined') return [];

    const subscriptionId = this.nextId('sub');
    const customer = session.customer ?? this.nextId('cus');
    this.subscriptionsById.set(subscriptionId, {
      id: subscriptionId,
      customer,
      priceId: session.priceId ?? '',
      status: session.trialDays > 0 ? 'trialing' : 'active',
    });
    session.status = 'complete';
    session.subscriptionId = subscriptionId;
    return [
      this.event('checkout.session.completed', {
        id: session.id,
        object: 'checkout.session',
        mode: 'subscription',
        customer,
        subscription: subscriptionId,
        payment_status: session.trialDays > 0 ? 'no_payment_required' : 'paid',
        metadata: session.metadata,
      }),
    ];
  }

  /** The customer abandons checkout. No event: Stripe sends none for an open session the customer leaves. */
  cancelCheckout(id: string): void {
    const session = this.sessions.get(id);
    if (session && session.status === 'open') session.status = 'expired';
  }

  /** The customer cancels in the billing portal. */
  cancelSubscriptionFor(customerId: string): Stripe.Event[] {
    const events: Stripe.Event[] = [];
    for (const sub of this.subscriptionsById.values()) {
      if (sub.customer === customerId && sub.status !== 'canceled') {
        sub.status = 'canceled';
        events.push(
          this.event('customer.subscription.deleted', {
            id: sub.id,
            object: 'subscription',
            customer: customerId,
            status: 'canceled',
            items: { data: [{ price: { id: sub.priceId } }] },
          })
        );
      }
    }
    return events;
  }

  /** A renewal payment is declined for this customer's subscription. */
  failPaymentFor(customerId: string): Stripe.Event[] {
    for (const sub of this.subscriptionsById.values()) {
      if (sub.customer === customerId && sub.status !== 'canceled') sub.status = 'past_due';
    }
    return [
      this.event('invoice.payment_failed', {
        id: this.nextId('in'),
        object: 'invoice',
        customer: customerId,
      }),
    ];
  }

  /** A past-due customer's payment succeeds on retry. */
  recoverPaymentFor(customerId: string): Stripe.Event[] {
    let subscriptionId: string | null = null;
    for (const sub of this.subscriptionsById.values()) {
      if (sub.customer === customerId && sub.status === 'past_due') {
        sub.status = 'active';
        subscriptionId = sub.id;
      }
    }
    return [
      this.event('invoice.paid', {
        id: this.nextId('in'),
        object: 'invoice',
        customer: customerId,
        subscription: subscriptionId,
      }),
    ];
  }

  /** Wrap an event for delivery: the exact body and `Stripe-Signature` header Stripe would send. */
  sign(event: Stripe.Event, secret: string): SignedWebhook {
    const body = JSON.stringify(event);
    return { body, header: signWebhookPayload(body, secret) };
  }

  private event(type: string, object: Record<string, unknown>): Stripe.Event {
    return {
      id: this.nextId('evt'),
      object: 'event',
      type,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object },
    } as unknown as Stripe.Event;
  }
}
