/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

import type { Pool } from 'pg';
import type { AppFastifyInstance } from '../types/fastify';
import { z } from 'zod';
import {
  withHandler,
  logEvent,
  logError,
  requireOwnerRole,
  type AppRequest,
} from '../middleware/fastify-middleware';
import { type TelnyxNumbersClient } from '../services/telnyxNumbers';
import { activatePhone, deactivatePhone } from '../services/provisioningService';
import { SUPER_ADMIN_TENANT_ID } from '../constants';
import { sendPortRequestEmail } from '../services/communications/systemEmail';

const ActivateSchema = z.object({
  tenant_id: z.string().uuid(),
  area_code: z
    .string()
    .regex(/^\d{3}$/)
    .optional(),
});

export interface TelnyxProvisioningConfig {
  client: TelnyxNumbersClient;
  sipConnectionId: string;
}

export function registerProvisioningRoutes(
  app: AppFastifyInstance,
  pool: Pool,
  telnyx: TelnyxProvisioningConfig | null
) {
  // POST /provisioning/activate — purchase a Telnyx number and route it to LiveKit
  app.post(
    '/provisioning/activate',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): purchases a real Telnyx
      // number at real recurring cost — not a front-desk operation.
      if (!requireOwnerRole(req, reply)) return;
      if (!telnyx) {
        return reply.status(503).send({
          success: false,
          error:
            'Phone provisioning not configured (missing TELNYX_API_KEY or TELNYX_SIP_CONNECTION_ID)',
        });
      }

      const parsed = ActivateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const { tenant_id, area_code } = parsed.data;

      // Card-required gate (owner decision 2026-09-24): a real number costs real
      // money every month, so a tenant must have started a subscription — the
      // 14-day trial counts, and Checkout always takes a card — before it can
      // buy one. Stripe's 'trialing' is stored as 'active' (localStatusForStripe
      // in billing.ts). Super-admin provisioning for a tenant is exempt.
      if (req.auth?.tenant_id !== SUPER_ADMIN_TENANT_ID) {
        const sub = await pool.query<{ subscription_status: string | null }>(
          'SELECT subscription_status FROM tenants WHERE tenant_id = $1 AND is_deleted = false',
          [tenant_id]
        );
        if (sub.rows.length > 0 && sub.rows[0].subscription_status !== 'active') {
          logEvent(req, 'phone_provisioning_refused_no_subscription', {
            tenant_id,
            subscription_status: sub.rows[0].subscription_status,
          });
          const pastDue = sub.rows[0].subscription_status === 'past_due';
          return reply.status(402).send({
            success: false,
            error_code: 'subscription_required',
            // Worded per status: only a never-subscribed tenant gets a trial
            // (billing.ts isFirstSubscription), so only that message may
            // promise "no charge until the trial ends".
            error: pastDue
              ? 'Your last payment did not go through. Update your card on the Billing page before getting a phone number.'
              : 'Choose a plan on the Billing page before getting a phone number. A card is required; new accounts get a 14-day free trial and are not charged until it ends.',
          });
        }
      }

      const result = await activatePhone(pool, telnyx, tenant_id, area_code);

      switch (result.status) {
        case 'ok':
          logEvent(req, 'phone_provisioned', {
            tenant_id,
            phone: result.phone_number,
            telnyx_phone_number_id: result.telnyx_phone_number_id,
          });
          return reply.send({
            success: true,
            phone_number: result.phone_number,
            telnyx_phone_number_id: result.telnyx_phone_number_id,
          });

        case 'not_found':
          return reply.status(404).send({
            success: false,
            error: 'Tenant not found',
            tenant_id,
            timestamp: new Date().toISOString(),
          });

        case 'conflict':
          return reply.status(409).send({
            error:
              result.reason === 'already_active'
                ? 'Phone is already active for this tenant'
                : 'Phone provisioning is already in progress',
            tenant_id,
            tenant_name: result.tenant_name,
            current_status: result.current_status,
            timestamp: new Date().toISOString(),
          });

        case 'failed':
          if (result.cleanup_error !== undefined) {
            logError(req, 'telnyx_number_cleanup_failed', result.cleanup_error, {
              purchasedId: result.purchased_id,
            });
          }
          logError(req, 'phone_provisioning_failed', result.error, {
            tenant_id,
            purchasedId: result.purchased_id,
          });
          return reply.status(502).send({
            error: 'Phone provisioning failed',
            detail: result.detail,
            tenant_id,
            tenant_name: result.tenant_name,
            number_purchased: result.number_purchased,
            rolled_back: result.rolled_back,
            timestamp: new Date().toISOString(),
          });
      }
    }, 'Failed to activate phone')
  );

  // POST /provisioning/deactivate — release the Telnyx number
  app.post(
    '/provisioning/deactivate',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): takes the tenant's live
      // inbound line down — not a front-desk operation.
      if (!requireOwnerRole(req, reply)) return;
      if (!telnyx) {
        return reply.status(503).send({
          success: false,
          error:
            'Phone provisioning not configured (missing TELNYX_API_KEY or TELNYX_SIP_CONNECTION_ID)',
        });
      }

      const deactiveParsed = z.object({ tenant_id: z.string().uuid() }).safeParse(req.body);
      if (!deactiveParsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Validation failed',
          details: deactiveParsed.error.issues,
        });
      }
      const { tenant_id } = deactiveParsed.data;

      const result = await deactivatePhone(pool, telnyx, tenant_id);

      switch (result.status) {
        case 'not_found':
          return reply.status(404).send({ success: false, error: 'Tenant not found' });

        case 'ok':
          if (result.release_error !== undefined) {
            logError(req, 'telnyx_number_release_failed', result.release_error, {
              telnyx_phone_number_id: result.release_phone_number_id,
              tenant_id,
            });
          }
          logEvent(req, 'phone_deprovisioned', {
            tenant_id,
            warnings_count: result.warnings.length,
          });
          return reply.send({
            success: true,
            ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
          });
      }
    }, 'Failed to deactivate phone')
  );

  // GET /provisioning/status — get phone provisioning status for a tenant
  app.get(
    '/provisioning/status',
    withHandler(async (req: AppRequest, reply) => {
      const { tenant_id } = req.query as { tenant_id: string };
      if (!tenant_id) {
        return reply
          .status(400)
          .send({ success: false, error: 'tenant_id query parameter is required' });
      }

      const client = await pool.connect();
      try {
        // forwarded_from_phone added for GoLivePanel (docs/superpowers/specs/
        // 2026-07-05-wizard-phase-b-design.md §3) — the panel's Stage C
        // forwarding card needs to know the currently-saved value to render
        // "already configured" vs. the empty prompt, without a second fetch.
        const res = await client.query(
          'SELECT phone_status, inbound_phone, telnyx_phone_number_id, forwarded_from_phone FROM tenants WHERE tenant_id = $1 AND is_deleted = false',
          [tenant_id]
        );
        if (res.rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Tenant not found' });
        }

        return reply.send(res.rows[0]);
      } finally {
        client.release();
      }
    }, 'Failed to get provisioning status')
  );

  // POST /provisioning/port-inquiry — owner wants to port their existing
  // number into Telnyx instead of forwarding. No porting API is invoked (a
  // real LNP port always needs a human — LOA + carrier cutover); this just
  // emails Dale the details so he can start the manual process. No table,
  // no credentials collected — see design doc §3 "Kill Proposal 2's
  // port_requests table + credential intake entirely."
  const PortInquirySchema = z.object({
    tenant_id: z.string().uuid(),
    phone_number: z.string().min(7).max(30),
    notes: z.string().max(1000).optional(),
  });
  app.post(
    '/provisioning/port-inquiry',
    withHandler(async (req: AppRequest, reply) => {
      const parsed = PortInquirySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const { tenant_id, phone_number, notes } = parsed.data;

      const client = await pool.connect();
      let tenantName: string;
      try {
        const res = await client.query<{ name: string }>(
          'SELECT name FROM tenants WHERE tenant_id = $1',
          [tenant_id]
        );
        if (res.rows.length === 0) {
          return reply.status(404).send({ success: false, error: 'Tenant not found' });
        }
        tenantName = res.rows[0].name;
      } finally {
        client.release();
      }

      // Best-effort: the owner already sees a confirmation in the UI
      // regardless (the request itself succeeded); a flaky SMTP send
      // shouldn't block that. Logged so a silent failure is diagnosable.
      const adminEmail = process.env.PLATFORM_ADMIN_EMAIL || process.env.EMAIL_USER;
      if (!adminEmail) {
        // Neither env var configured — sendMail would otherwise be called
        // with an empty `to`, throwing on every single request and filling
        // logs with the same noise. Detect the misconfiguration explicitly
        // instead.
        logError(
          req,
          'port_inquiry_email_failed',
          new Error('PLATFORM_ADMIN_EMAIL and EMAIL_USER both unset — nowhere to send'),
          { tenant_id }
        );
      } else {
        try {
          await sendPortRequestEmail(adminEmail, {
            tenantId: tenant_id,
            tenantName,
            phoneNumber: phone_number,
            notes: notes ?? null,
          });
        } catch (err) {
          logError(req, 'port_inquiry_email_failed', err, { tenant_id });
        }
      }

      logEvent(req, 'port_inquiry_submitted', { tenant_id, phone_number });
      return reply.send({ success: true });
    }, 'Failed to submit port inquiry')
  );
}
