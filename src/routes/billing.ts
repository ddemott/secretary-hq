/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method, @typescript-eslint/no-explicit-any */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

import type { Pool } from 'pg';
import type { FastifyReply } from 'fastify';
import type { AppFastifyInstance } from '../types/fastify';
import Stripe from 'stripe';
import { withHandler, logEvent, logError, requireTenantId, type AppRequest } from '../middleware';
import { computeUsageStatements } from '../services/billingUsage';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_SOLO_PRICE_ID = process.env.STRIPE_SOLO_PRICE_ID || '';
const STRIPE_GROWTH_PRICE_ID = process.env.STRIPE_GROWTH_PRICE_ID || '';
const STRIPE_PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID || '';

const SUPER_ADMIN_TENANT_ID = '00000000-0000-0000-0000-000000000000';

function getStripe(): Stripe | null {
  if (!STRIPE_SECRET_KEY) return null;
  // The installed Stripe SDK's `apiVersion` literal union doesn't include
  // every release date — we pin to a specific version that may be newer
  // than the SDK's known set. Cast through `Stripe.StripeConfig['apiVersion']`
  // names the exact slot we're filling instead of bare `any`.
  return new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: '2025-02-24.acacia' as Stripe.StripeConfig['apiVersion'],
  });
}

export function registerBillingRoutes(app: AppFastifyInstance, pool: Pool) {
  // POST /billing/checkout — create a Stripe Checkout session
  app.post(
    '/billing/checkout',
    withHandler(async (req: AppRequest, reply) => {
      const stripe = getStripe();
      if (!stripe) {
        return reply.status(503).send({ success: false, error: 'Billing not configured' });
      }

      const tenant_id = requireTenantId(req, reply);
      if (!tenant_id) return;
      const { plan } = (req.body as { plan?: string } | undefined) || {};
      if (!plan || !['solo', 'growth', 'professional'].includes(plan)) {
        return reply
          .status(400)
          .send({ success: false, error: 'plan must be "solo", "growth", or "professional"' });
      }

      const priceMap: Record<string, string> = {
        solo: STRIPE_SOLO_PRICE_ID,
        growth: STRIPE_GROWTH_PRICE_ID,
        professional: STRIPE_PRO_PRICE_ID,
      };
      const priceId = priceMap[plan];
      if (!priceId) {
        return reply
          .status(503)
          .send({ success: false, error: `Price ID not configured for ${plan} plan` });
      }

      // Look up or create Stripe customer
      // is_deleted: never open a checkout — and never create a Stripe customer — for
      // a business that has been deleted. Taking money from a tenant that cannot log
      // in or answer a call is the worst shape a zombie-tenant leak could take.
      const tenantRes = await pool.query(
        'SELECT tenant_id, name, stripe_customer_id FROM tenants WHERE tenant_id = $1 AND is_deleted = false',
        [tenant_id]
      );
      if (tenantRes.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Tenant not found' });
      }

      const tenant = tenantRes.rows[0];
      let customerId = tenant.stripe_customer_id;

      if (!customerId) {
        const customer = await stripe.customers.create({
          metadata: { tenant_id },
          name: tenant.name,
        });
        customerId = customer.id;
        await pool.query('UPDATE tenants SET stripe_customer_id = $1 WHERE tenant_id = $2', [
          customerId,
          tenant_id,
        ]);
      }

      const dashboardUrl = process.env.DASHBOARD_URL || 'https://localhost:4000';
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${dashboardUrl}/dashboard?tab=setup&subtab=billing&billing=success`,
        cancel_url: `${dashboardUrl}/dashboard?tab=setup&subtab=billing&billing=cancel`,
        metadata: { tenant_id, plan },
        // Requires Stripe Tax enabled in dashboard + nexus registered.
        // Set STRIPE_AUTO_TAX=true on Railway once both are configured.
        ...(process.env.STRIPE_AUTO_TAX === 'true' && {
          automatic_tax: { enabled: true },
        }),
      });

      logEvent(req, 'checkout_session_created', { tenantId: tenant_id, plan });
      return reply.send({ url: session.url });
    }, 'Checkout failed')
  );

  // POST /billing/webhook — handle Stripe webhook events
  // IMPORTANT: Stripe requires the raw request body for signature verification.
  // Fastify's content-type parser must preserve the raw buffer for this route.
  app.post(
    '/billing/webhook',
    {
      config: {
        rawBody: true, // Enable raw body preservation for this route
      } as Record<string, unknown>,
    },
    async (req: AppRequest, reply) => {
      const stripe = getStripe();
      if (!stripe) {
        return reply.status(503).send({ success: false, error: 'Billing not configured' });
      }

      const sig = req.headers['stripe-signature'];
      if (!sig) {
        return reply.status(400).send({ success: false, error: 'Missing stripe-signature header' });
      }

      let event: Stripe.Event;
      try {
        // Access raw body from Fastify's rawBody property. The base
        // FastifyRequest type doesn't declare it (it's added by a plugin
        // / instance config), so a focused intersection type names exactly
        // what we're reaching for rather than dropping to `any`.
        const rawBody = (req as AppRequest & { rawBody?: string | Buffer }).rawBody;
        if (!rawBody) {
          throw new Error('Raw body not available — ensure Fastify rawBody is configured');
        }
        const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
        event = stripe.webhooks.constructEvent(bodyStr, sig as string, STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        logError(req, 'stripe_webhook_signature_failed', err);
        return reply.status(400).send({ success: false, error: 'Invalid webhook signature' });
      }

      try {
        switch (event.type) {
          case 'checkout.session.completed': {
            const session = event.data.object;
            const tenantId = session.metadata?.tenant_id;
            const plan = session.metadata?.plan;
            if (tenantId && session.subscription) {
              await pool.query(
                `UPDATE tenants
               SET stripe_subscription_id = $1, subscription_status = 'active', subscription_plan = $2
               WHERE tenant_id = $3`,
                [session.subscription, plan, tenantId]
              );
              logEvent(req, 'subscription_activated', { tenantId, plan });
            }
            break;
          }

          case 'invoice.payment_failed': {
            const invoice = event.data.object;
            const customerId =
              typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
            if (customerId) {
              await pool.query(
                `UPDATE tenants SET subscription_status = 'past_due' WHERE stripe_customer_id = $1`,
                [customerId]
              );
              req.log.warn({ customerId }, 'Payment failed — subscription past_due');
            }
            break;
          }

          case 'customer.subscription.deleted': {
            const subscription = event.data.object;
            const customerId =
              typeof subscription.customer === 'string'
                ? subscription.customer
                : subscription.customer?.id;
            if (customerId) {
              await pool.query(
                `UPDATE tenants
               SET subscription_status = 'canceled', stripe_subscription_id = NULL, subscription_plan = NULL
               WHERE stripe_customer_id = $1`,
                [customerId]
              );
              logEvent(req, 'subscription_canceled', { customerId });
            }
            break;
          }

          default:
            req.log.info({ type: event.type }, 'Unhandled webhook event');
        }

        return reply.send({ received: true });
      } catch (err) {
        logError(req, 'stripe_webhook_processing_failed', err);
        return reply.status(500).send({ success: false, error: 'Webhook processing failed' });
      }
    }
  );

  // GET /billing/status — check subscription status for a tenant
  app.get(
    '/billing/status',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await pool.query(
        'SELECT subscription_status, subscription_plan FROM tenants WHERE tenant_id = $1',
        [tenantId]
      );
      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Tenant not found' });
      }
      return reply.send(res.rows[0]);
    }, 'Failed to check billing status')
  );

  // GET /billing/usage — monthly usage + online billing statements ("no
  // paper" — the statement IS this endpoint + the Billing page rendering it).
  // Computed live from voice_sessions via the answered-call definition; see
  // src/services/billingUsage.ts for the model and docs/TODO.md §2 for the
  // decision record. Informational until Stripe pack-charging lands.
  app.get(
    '/billing/usage',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const months = Math.min(
        Math.max(parseInt((req.query as { months?: string })?.months ?? '6', 10) || 6, 1),
        24
      );
      try {
        const result = await computeUsageStatements(pool, tenantId, months);
        return reply.send({ success: true, ...result });
      } catch (err) {
        if ((err as Error).message === 'Tenant not found') {
          return reply.status(404).send({ success: false, error: 'Tenant not found' });
        }
        throw err;
      }
    }, 'Failed to compute usage')
  );

  // POST /billing/portal — create a Stripe Customer Portal session
  // Lets the owner manage payment methods, view invoices, and cancel.
  app.post(
    '/billing/portal',
    withHandler(async (req: AppRequest, reply) => {
      const stripe = getStripe();
      if (!stripe) {
        return reply.status(503).send({ success: false, error: 'Billing not configured' });
      }

      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await pool.query('SELECT stripe_customer_id FROM tenants WHERE tenant_id = $1', [
        tenantId,
      ]);
      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Tenant not found' });
      }
      if (!res.rows[0].stripe_customer_id) {
        return reply
          .status(400)
          .send({ success: false, error: 'No billing account found — complete checkout first' });
      }

      const dashboardUrl = process.env.DASHBOARD_URL || 'https://localhost:4000';
      const session = await stripe.billingPortal.sessions.create({
        customer: res.rows[0].stripe_customer_id,
        return_url: `${dashboardUrl}/dashboard?tab=setup&subtab=billing`,
      });

      logEvent(req, 'billing_portal_session_created', { tenantId });
      return reply.send({ url: session.url });
    }, 'Failed to create billing portal session')
  );
}

/**
 * Subscription gate middleware.
 * Returns 402 if the tenant's subscription is not active.
 * Exempt: super-admin tenant, public routes, billing routes, auth routes.
 */
export function subscriptionGate(pool: Pool) {
  const EXEMPT_PREFIXES = ['/health', '/login', '/billing', '/register'];

  return async (request: AppRequest, reply: FastifyReply) => {
    if (request.method === 'OPTIONS') return;

    const urlPath = request.url.split('?')[0];
    if (EXEMPT_PREFIXES.some((p) => urlPath.startsWith(p)) || urlPath === '/') return;

    // Get tenant_id from auth token, query param, or body. AppRequest
    // already carries the optional `auth` field, so no cast needed for
    // the JWT side. Query and body are unknown-shape on FastifyRequest
    // by default — a Record-of-string cast names exactly what we read.
    const auth = request.auth;
    const tenantId =
      auth?.tenant_id ||
      (request.query as Record<string, string> | undefined)?.tenant_id ||
      (request.body as Record<string, string> | undefined)?.tenant_id;

    if (!tenantId) return; // No tenant context — let route handle auth
    if (tenantId === SUPER_ADMIN_TENANT_ID) return; // Super-admin exempt

    try {
      const res = await pool.query('SELECT subscription_status FROM tenants WHERE tenant_id = $1', [
        tenantId,
      ]);
      if (res.rows.length === 0) return; // Tenant not found — let route handle
      const status = res.rows[0].subscription_status;

      if (status !== 'active' && status !== 'inactive') {
        // 'inactive' is the default for new tenants (grace period / free tier during beta)
        // 'past_due' and 'canceled' are blocked
        return reply.status(402).send({
          error: 'Subscription required',
          subscription_status: status,
        });
      }
    } catch (err) {
      // Log billing check errors but fail open to avoid blocking legitimate traffic
      // TODO: Consider fail-closed for production after monitoring is in place
      request.log.error(
        {
          event: 'subscription_gate_error',
          error_message: (err as Error).message,
          tenantId,
          timestamp: new Date().toISOString(),
        },
        `Subscription gate check failed for tenant ${tenantId}`
      );
    }
  };
}
