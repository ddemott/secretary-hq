/**
 * The slice of Stripe this app uses, behind one seam.
 *
 * Everything billing needs from Stripe goes through a `StripeGateway`, so a mock
 * can stand in until the real account is attached. Attaching Stripe is then a
 * configuration change (set STRIPE_SECRET_KEY / the price ids / the webhook
 * secret, unset STRIPE_MODE), not a code change.
 *
 * Modes (`resolveStripeMode`):
 *   - 'stripe'  the real SDK. Chosen when STRIPE_SECRET_KEY is set.
 *   - 'mock'    `MockStripe`, in-process. Chosen by STRIPE_MODE=mock and ONLY outside
 *               production: a stray flag in prod can never mint a plan.
 *   - null      billing is not configured (the routes answer 503, as before).
 */
import Stripe from 'stripe';
import { MockStripe } from './mockStripe';

export type StripeMode = 'stripe' | 'mock';

export interface StripeGateway {
  readonly mode: StripeMode;
  customers: {
    create(params: Stripe.CustomerCreateParams): Promise<{ id: string }>;
  };
  subscriptions: {
    list(params: Stripe.SubscriptionListParams): Promise<{ data: unknown[] }>;
  };
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams
      ): Promise<{ id: string; url: string | null }>;
    };
  };
  invoiceItems: {
    /** Adds a one-off charge to the customer's next invoice. `idempotencyKey` makes a retry a no-op. */
    create(
      params: Stripe.InvoiceItemCreateParams,
      options?: { idempotencyKey?: string }
    ): Promise<{ id: string }>;
  };
  billingPortal: {
    sessions: {
      create(params: Stripe.BillingPortal.SessionCreateParams): Promise<{ url: string }>;
    };
  };
  webhooks: {
    constructEvent(
      payload: string | Buffer,
      header: string | string[],
      secret: string
    ): Stripe.Event;
  };
}

type Env = Record<string, string | undefined>;

/** Which mode this process runs billing in; null = not configured. */
export function resolveStripeMode(env: Env = process.env): StripeMode | null {
  if (env.STRIPE_MODE === 'mock' && env.NODE_ENV !== 'production') return 'mock';
  if (env.STRIPE_SECRET_KEY) return 'stripe';
  return null;
}

/** The mock is one object per process: its customers, subscriptions and sessions persist across requests. */
let mockSingleton: MockStripe | null = null;

export function getMockStripe(): MockStripe {
  mockSingleton ??= new MockStripe();
  return mockSingleton;
}

/** Test seam: forget the mock's state. */
export function resetMockStripeForTesting(): void {
  mockSingleton = null;
}

/** The gateway for the current mode, or null when billing is not configured. */
export function getStripeGateway(env: Env = process.env): StripeGateway | null {
  const mode = resolveStripeMode(env);
  if (mode === 'mock') return getMockStripe();
  if (mode === 'stripe') {
    // Omit apiVersion so the installed SDK sends the version its own types match.
    return Object.assign(new Stripe(env.STRIPE_SECRET_KEY ?? ''), { mode: 'stripe' as const });
  }
  return null;
}

export interface PriceIds {
  solo: string;
  growth: string;
  professional: string;
}

/** Real price ids come from the environment; the mock has its own, recognisable ones. */
export function stripePriceIds(env: Env = process.env): PriceIds {
  if (resolveStripeMode(env) === 'mock') {
    return {
      solo: 'price_mock_solo',
      growth: 'price_mock_growth',
      professional: 'price_mock_professional',
    };
  }
  return {
    solo: env.STRIPE_SOLO_PRICE_ID || '',
    growth: env.STRIPE_GROWTH_PRICE_ID || '',
    professional: env.STRIPE_PRO_PRICE_ID || '',
  };
}

/** The secret webhook signatures are checked against. */
export function stripeWebhookSecret(env: Env = process.env): string {
  if (resolveStripeMode(env) === 'mock') return env.STRIPE_WEBHOOK_SECRET || 'whsec_mock';
  return env.STRIPE_WEBHOOK_SECRET || '';
}
