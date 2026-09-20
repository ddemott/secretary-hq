/**
 * Communications API Routes
 *
 * Endpoints for sending communications (email, SMS) and viewing history.
 * Routes:
 *   POST /communications/email - Send an email
 *   POST /communications/sms   - Send an SMS
 *   GET  /communications/history - Get communication history
 *   GET  /communications/consent - Get consent records
 *   POST /communications/consent - Record consent
 *   POST /communications/opt-out - Process opt-out request
 */

import type { AppFastifyInstance } from '../types/fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { withHandler, requireTenantId, type AppRequest } from '../middleware/fastify-middleware';
import { CommunicationService } from '../services/communications/index.js';
import { ConsentService } from '../services/consentService.js';
import { createDatabaseService } from '../database/index.js';
import { createTenantConfigService } from '../services/tenants/index.js';
import {
  messageDeliveryReceiptsTotal,
  inboundSmsTotal,
  errorsTotal,
  webhookSignatureFailuresTotal,
} from '../services/metrics.js';
import { verifyTelnyxSignature } from '../services/telnyxWebhookAuth.js';
import { classifySmsKeyword, NotAnOptOutCommandError } from '../services/smsKeywords.js';
import { normalizePhone } from '../services/phoneUtils.js';

/**
 * Record an SMS delivery-status callback (from any provider webhook).
 *
 * Exported (not inlined) so the unit test can drive the persistence path
 * directly with a mock pool — the handler around it stays a thin HTTP shell.
 * Upsert keyed on message_sid: providers fire the callback multiple times as
 * the message advances (queued → sent → delivered), latest status wins.
 */
export async function recordDeliveryStatus(
  pool: Pool,
  params: {
    messageSid: string;
    messageStatus: string;
    errorCode?: string | null;
    tenantId?: string | null;
  }
): Promise<void> {
  await pool.query(
    `INSERT INTO message_delivery_status (message_sid, message_status, error_code, tenant_id, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (message_sid)
     DO UPDATE SET message_status = EXCLUDED.message_status,
                   error_code = EXCLUDED.error_code,
                   tenant_id = COALESCE(EXCLUDED.tenant_id, message_delivery_status.tenant_id),
                   updated_at = now()`,
    [params.messageSid, params.messageStatus, params.errorCode ?? null, params.tenantId ?? null]
  );
}

// ── Validation Schemas ───────────────────────────────────────────────

const SendEmailSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
  html: z.string().max(50000).optional(),
  template: z.string().optional(),
  templateData: z.record(z.string(), z.unknown()).optional(),
});

const SendSMSSchema = z.object({
  to: z.string().min(10).max(20),
  body: z.string().min(1).max(1600),
  template: z.string().optional(),
  templateData: z.record(z.string(), z.unknown()).optional(),
});

const RecordConsentSchema = z
  .object({
    customer_email: z.string().email().optional(),
    customer_phone: z.string().min(10).max(20).optional(),
    customer_id: z.string().uuid().optional(),
    consent_type: z.enum(['email', 'sms', 'both']),
    consent_given: z.boolean(),
    consent_method: z.enum(['web_form', 'sms_reply', 'verbal', 'import', 'booking']),
    consent_source: z.string().max(200).optional(),
    ip_address: z.string().max(45).optional(), // IPv4 or IPv6
  })
  .refine((data) => data.customer_email || data.customer_phone, {
    message: 'Either customer_email or customer_phone is required',
  });

const ProcessOptOutSchema = z
  .object({
    command: z.string().min(1).max(50),
    customer_phone: z.string().min(10).max(20).optional(),
    customer_email: z.string().email().optional(),
    message_body: z.string().max(1000).optional(),
  })
  .refine((data) => data.customer_email || data.customer_phone, {
    message: 'Either customer_email or customer_phone is required',
  });

const HistoryQuerySchema = z.object({
  type: z.enum(['email', 'sms', 'all']).optional().default('all'),
  // Delivery-status filter. The values mirror the communications_history
  // status CHECK constraint (sent | failed | queued); 'all' (default) skips
  // the filter. Powers the dashboard "Failed only" drill-down.
  status: z.enum(['sent', 'failed', 'queued', 'all']).optional().default('all'),
  limit: z.coerce.number().min(1).max(100).optional().default(50),
  offset: z.coerce.number().min(0).optional().default(0),
});

// ── Route Registration ───────────────────────────────────────────────

export function registerCommunicationRoutes(
  app: AppFastifyInstance,
  pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  const db = createDatabaseService(pool);
  const configService = createTenantConfigService(pool);
  const consentService = new ConsentService(db);
  const communicationService = new CommunicationService(configService, consentService);

  /**
   * POST /communications/email - Send an email
   */
  app.post(
    '/communications/email',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = SendEmailSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Validation failed',
          details: parsed.error.issues,
        });
      }

      const { to, subject, body, html, template, templateData } = parsed.data;

      const result = await communicationService.sendEmail(tenantId, {
        to,
        subject,
        text: body,
        html,
        template,
        templateData,
      });

      if (result.success) {
        return reply.send({
          success: true,
          messageId: result.messageId,
        });
      } else {
        return reply.status(400).send({
          success: false,
          error: result.error || 'Failed to send email',
        });
      }
    }, 'Failed to send email')
  );

  /**
   * POST /communications/sms - Send an SMS
   *
   * Gated on ENABLE_SMS (default OFF, only the literal 'true' enables) — same
   * convention as the agent worker and POST /appointments/:id/send-self-service-links.
   */
  app.post(
    '/communications/sms',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      // SMS is globally OFF pending 10DLC registration (root CLAUDE.md
      // Architecture). Telnyx accepts the send and reports success anyway
      // (error 40010 at the carrier), so without this gate this route would
      // answer { success: true, messageId } for a text that never arrives —
      // the false-promise class ENABLE_SMS exists to prevent everywhere else.
      if (process.env.ENABLE_SMS !== 'true') {
        return reply.status(503).send({
          success: false,
          error:
            'SMS is not enabled for this platform yet (pending 10DLC registration) — no text was sent. Use email or another channel.',
        });
      }

      const parsed = SendSMSSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Validation failed',
          details: parsed.error.issues,
        });
      }

      const { to, body, template, templateData } = parsed.data;

      const result = await communicationService.sendSMS(tenantId, {
        to,
        body,
        template,
        templateData,
      });

      if (result.success) {
        return reply.send({
          success: true,
          messageId: result.messageId,
        });
      } else {
        return reply.status(400).send({
          success: false,
          error: result.error || 'Failed to send SMS',
        });
      }
    }, 'Failed to send SMS')
  );

  /**
   * GET /communications/history - Get communication history (paginated)
   *
   * Tenant-scoped read of the communications_history table. EmailService/
   * SMSService write a status='sent' row on the send success path, and a
   * best-effort status='failed' row (carrying the provider error) on the
   * send-failure catch path — so the ?status=failed drill-down below has real
   * rows. Filterable by channel via ?type=email|sms|all (default all) and by
   * delivery status via ?status=sent|failed|queued|all (default all — the
   * failed-delivery drill-down); paginated via ?limit (1-100, default 50) +
   * ?offset. `total` is the full filtered count, independent of the page
   * window, so the dashboard can render pagination controls. Rows carry the
   * `error` column (provider failure detail recorded at send time) for failed
   * sends.
   */
  app.get(
    '/communications/history',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = HistoryQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid query parameters',
          details: parsed.error.issues,
        });
      }

      const { type, status, limit, offset } = parsed.data;

      const { history, total } = await withTenantClient(tenantId, async (client) => {
        // COUNT(*) OVER() gives the full filtered count alongside the paged
        // rows in a single round-trip; it is NULL only when zero rows match,
        // which we coalesce to 0 below. Newest-first ordering matches the
        // idx_communications_history_tenant_created index.
        const result = await client.query(
          `SELECT communications_history_id,
                  tenant_id,
                  customer_id,
                  channel,
                  direction,
                  recipient,
                  subject,
                  body,
                  status,
                  provider_message_id,
                  error,
                  created_at,
                  COUNT(*) OVER() AS total_count
             FROM communications_history
            WHERE tenant_id = $1
              AND ($2 = 'all' OR channel = $2)
              AND ($3 = 'all' OR status = $3)
            ORDER BY created_at DESC, communications_history_id DESC
            LIMIT $4 OFFSET $5`,
          [tenantId, type, status, limit, offset]
        );

        const rows = result.rows as Array<Record<string, unknown> & { total_count: string }>;
        const totalCount = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
        // Drop the window-function helper column from each returned row.
        const history = rows.map(({ total_count: _ignored, ...rest }) => rest);
        return { history, total: totalCount };
      });

      return reply.send({
        success: true,
        history,
        total,
      });
    }, 'Failed to get communication history')
  );

  /**
   * GET /communications/consent - Get consent records for tenant
   */
  app.get(
    '/communications/consent',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const consents = await consentService.getConsentRecords(tenantId);

      return reply.send({
        success: true,
        consents,
      });
    }, 'Failed to get consent records')
  );

  /**
   * POST /communications/consent - Record customer consent
   */
  app.post(
    '/communications/consent',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = RecordConsentSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Validation failed',
          details: parsed.error.issues,
        });
      }

      const consent = await consentService.recordConsent({
        tenant_id: tenantId,
        customer_id: parsed.data.customer_id || undefined,
        customer_email: parsed.data.customer_email,
        customer_phone: parsed.data.customer_phone,
        consent_type: parsed.data.consent_type,
        consent_given: parsed.data.consent_given,
        consent_date: new Date().toISOString(),
        consent_method: parsed.data.consent_method,
        consent_source: parsed.data.consent_source,
        ip_address: parsed.data.ip_address,
      });

      return reply.send({
        success: true,
        consent,
      });
    }, 'Failed to record consent')
  );

  /**
   * POST /communications/opt-out - Process opt-out request (STOP, UNSUBSCRIBE)
   */
  app.post(
    '/communications/opt-out',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = ProcessOptOutSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Validation failed',
          details: parsed.error.issues,
        });
      }

      // `command` is a free-text string from the caller, so a non-opt-out word can
      // reach here. ConsentService now REFUSES those rather than quietly recording
      // an opt-out anyway (which is how 'START' used to opt people out of
      // everything). Translate that refusal into a 400 — it's a bad request, not a
      // server fault, and a 500 would tell the caller nothing about what to fix.
      let optOut: Awaited<ReturnType<typeof consentService.processOptOutCommand>>;
      try {
        optOut = await consentService.processOptOutCommand(
          tenantId,
          parsed.data.command,
          parsed.data.customer_phone,
          parsed.data.customer_email,
          parsed.data.message_body
        );
      } catch (err) {
        if (err instanceof NotAnOptOutCommandError) {
          return reply.status(400).send({ success: false, error: err.message });
        }
        throw err;
      }

      if (optOut) {
        return reply.send({
          success: true,
          optOut,
          message: 'Opt-out processed successfully',
        });
      } else {
        return reply.status(400).send({
          success: false,
          error: 'Failed to process opt-out',
        });
      }
    }, 'Failed to process opt-out')
  );

  /**
   * GET /communications/opt-outs - Get opt-out records for tenant
   */
  app.get(
    '/communications/opt-outs',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const optOuts = await consentService.getOptOutRecords(tenantId);

      return reply.send({
        success: true,
        optOuts,
      });
    }, 'Failed to get opt-out records')
  );

  /**
   * POST /communications/telnyx/status — Telnyx SMS delivery-status webhook.
   *
   * Telnyx POSTs JSON here when webhook_url is set on the message (see
   * TelnyxSmsAdapter.sendSMS). PUBLIC + tenant-exempt: no JWT; tenant_id
   * is read from ?tenant_id= on the URL the adapter appended.
   *
   * Verification: if TELNYX_PUBLIC_KEY is set we validate the Ed25519 signature
   * (telnyx-signature-ed25519 over `timestamp|rawBody`) against the exact bytes
   * received — never a re-stringified `req.body`, whose key order and whitespace
   * need not match what Telnyx signed. A bad signature → 403. Without the key
   * configured we accept + log (dev/staging) — this route is a read-only receipt
   * sink, so unlike /inbound it does not fail closed.
   *
   * This route was the ORIGIN of the wrong-algorithm bug: it verified an
   * HMAC-SHA256 `telnyx-signature: t=…,v1=…` header, which is Stripe's scheme.
   * Telnyx does not offer HMAC. It never fired because the secret was never set,
   * and /inbound was copied from it. Both now use the real Ed25519 path.
   *
   * Payload shape (Telnyx v2):
   *   data.event_type  — "message.finalized" | "message.sent" | "message.failed"
   *   data.payload.id  — message ID (our messageSid)
   *   data.payload.to[0].status — per-recipient delivery status
   *   data.payload.errors[]    — error objects (optional)
   */
  app.post('/communications/telnyx/status', async (req: AppRequest, reply) => {
    // Signature verification runs BEFORE the payload is read: an unsigned
    // caller must never reach the parsing/DB path.
    const publicKey = process.env.TELNYX_PUBLIC_KEY;
    if (publicKey) {
      const verdict = verifyTelnyxSignature({
        rawBody: (req as { rawBody?: Buffer | string }).rawBody,
        signatureHeader: req.headers['telnyx-signature-ed25519'] as string | undefined,
        timestampHeader: req.headers['telnyx-timestamp'] as string | undefined,
        publicKey,
      });
      if (!verdict.valid) {
        if (verdict.reason === 'missing_raw_body') {
          req.log.error(
            { event: 'telnyx_status_callback_missing_raw_body' },
            'Raw body missing for Telnyx status callback — verification cannot proceed'
          );
          return reply.status(400).send({ success: false, error: 'Raw body unavailable' });
        }
        webhookSignatureFailuresTotal.inc({
          provider: 'telnyx',
          endpoint: 'status_callback',
        });
        req.log.warn(
          { event: 'telnyx_status_callback_invalid_signature', reason: verdict.reason },
          'Telnyx status callback signature mismatch'
        );
        return reply.status(403).send({ success: false, error: 'Invalid Telnyx signature' });
      }
    } else {
      req.log.info(
        { event: 'telnyx_status_callback_unverified' },
        'TELNYX_PUBLIC_KEY unset — accepting Telnyx status callback without signature verification'
      );
    }

    const payload = (req.body ?? {}) as Record<string, unknown>;
    const data = payload.data as Record<string, unknown> | undefined;
    const innerPayload = data?.payload as Record<string, unknown> | undefined;
    const messageSid = innerPayload?.id as string | undefined;
    const toArray = innerPayload?.to as Array<{ status?: string }> | undefined;
    const messageStatus = toArray?.[0]?.status ?? (data?.event_type as string | undefined);
    const errors = innerPayload?.errors as Array<{ code?: string | number }> | undefined;
    const errorCode = errors?.[0]?.code ? String(errors[0].code) : null;

    if (!messageSid || !messageStatus) {
      req.log.warn(
        { event: 'telnyx_status_callback_malformed' },
        'Telnyx status callback missing message id or status'
      );
      return reply
        .status(400)
        .send({ success: false, error: 'Missing message id or status in Telnyx payload' });
    }

    const tenantId = (req.query as Record<string, string | undefined>)?.tenant_id ?? null;

    await recordDeliveryStatus(pool, {
      messageSid,
      messageStatus,
      errorCode,
      tenantId,
    });

    messageDeliveryReceiptsTotal.inc({ status: messageStatus });

    return reply.send({ success: true });
  });

  /**
   * POST /communications/telnyx/inbound — inbound SMS (customer → us).
   *
   * Phase 1 of the SMS-confirmation design (docs/superpowers/specs/
   * 2026-07-11-sms-appointment-confirmation-design.md). It handles the carrier
   * keywords ONLY — STOP/UNSUBSCRIBE and START — and takes no action on anything
   * else. The Y/N appointment-confirmation branches land in phases 2–3.
   *
   * Shipping this alone closes a live compliance gap: until now NOTHING in the
   * app received an inbound text, so a customer who replied STOP to one of our
   * messages was never recorded in `opt_out_records`. The opt-out machinery
   * (ConsentService.processOptOutCommand) already existed — it just had no
   * inbound path to reach it.
   *
   * SECURITY — fail CLOSED. Unlike /telnyx/status (a read-only receipt sink that
   * accepts unsigned callbacks in dev), this route MUTATES consent state, and
   * later cancels appointments. It is a public endpoint, so without a signature
   * check the `from` number is just an attacker-supplied string and this becomes
   * an unauthenticated "opt any number out / cancel any booking" API. So:
   * TELNYX_PUBLIC_KEY unset → reject everything (503), never run unguarded.
   * Same "never unlocked by default" rule as AGENT_SECRET.
   *
   * The key is Telnyx's Ed25519 PUBLIC key (Mission Control → Keys &
   * Credentials), not a shared secret we generate — see telnyxWebhookAuth.ts for
   * why the original HMAC implementation was verifying the wrong algorithm.
   *
   * Payload shape (Telnyx v2 message.received):
   *   data.payload.from.phone_number  — the customer
   *   data.payload.to[0].phone_number — OUR number (→ resolves the tenant)
   *   data.payload.text               — the body
   */
  app.post('/communications/telnyx/inbound', async (req: AppRequest, reply) => {
    const publicKey = process.env.TELNYX_PUBLIC_KEY;
    if (!publicKey) {
      // Fail closed. An unconfigured key must not silently degrade a mutating
      // endpoint into an open one — that is the exact failure mode this guard
      // exists to prevent, and it would be invisible in prod.
      errorsTotal.inc({ event: 'telnyx_inbound_public_key_unset' });
      req.log.error(
        { event: 'telnyx_inbound_public_key_unset' },
        'TELNYX_PUBLIC_KEY unset — refusing inbound SMS webhook (fail closed; set the key to enable)'
      );
      return reply.status(503).send({ success: false, error: 'Webhook not configured' });
    }

    // Verify BEFORE touching the payload: an unsigned caller must never reach
    // the parse/DB path. Verified against the exact received bytes (req.rawBody,
    // preserved by jsonContentTypeParser), never a re-stringified req.body —
    // Telnyx signed the original bytes, and key order/whitespace need not survive
    // a parse/serialize round-trip.
    const verdict = verifyTelnyxSignature({
      rawBody: (req as { rawBody?: Buffer | string }).rawBody,
      signatureHeader: req.headers['telnyx-signature-ed25519'] as string | undefined,
      timestampHeader: req.headers['telnyx-timestamp'] as string | undefined,
      publicKey,
    });
    if (!verdict.valid) {
      inboundSmsTotal.inc({ outcome: 'rejected' });
      errorsTotal.inc({ event: 'telnyx_inbound_invalid_signature' });
      // Same event, third counter (T-006): inbound_sms_total is about SMS
      // handling and errors_total is the generic sad-path tally, but an alert
      // on "is anyone forging webhooks at us" must not have to know which
      // providers exist this quarter. That is what this one is for.
      webhookSignatureFailuresTotal.inc({ provider: 'telnyx', endpoint: 'inbound_sms' });
      // 5W: WHAT a forged/unsigned inbound webhook, WHY the specific failure.
      // This is the line that tells you someone is POSTing at the endpoint
      // directly — the attack the signature check exists to stop.
      req.log.warn(
        { event: 'telnyx_inbound_invalid_signature', reason: verdict.reason },
        'Inbound SMS webhook REJECTED — signature invalid (forged or unsigned request)'
      );
      const status = verdict.reason === 'missing_raw_body' ? 400 : 403;
      return reply.status(status).send({ success: false, error: 'Invalid Telnyx signature' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const data = body.data as Record<string, unknown> | undefined;
    const eventType = data?.event_type as string | undefined;

    // A messaging profile has ONE webhook URL, and Telnyx delivers EVERY messaging
    // event to it — `message.received` (a customer texting us) but also
    // `message.sent` / `message.finalized` (delivery receipts for messages WE
    // sent). Only the first is an inbound text; the rest must be ignored here.
    //
    // Why this is a guard and not a nicety: on a delivery receipt, `payload.text`
    // is OUR OWN outbound message body — and every message we send ends with the
    // compliance line "Reply STOP to opt out." Feed that through
    // classifySmsKeyword() and it reads as an opt-out command. Today the tenant
    // lookup below happens to fail first (a DLR's `to` is the CUSTOMER's number,
    // which matches no tenant.inbound_phone) so we bail before classifying — but
    // that is luck, not intent: the route would otherwise opt a customer out of
    // all messaging because we reminded them of their appointment.
    //
    // 200, not 4xx: a DLR is a legitimate webhook, not a malformed one, and Telnyx
    // RETRIES non-2xx. (Delivery receipts are handled by /telnyx/status, which the
    // adapter targets per-message via webhook_url — that per-message URL takes
    // priority over the profile URL, so status receipts normally never land here.)
    if (eventType && eventType !== 'message.received') {
      req.log.debug(
        { event: 'telnyx_inbound_ignored_event', event_type: eventType },
        'Non-inbound Telnyx messaging event on the inbound webhook — ignored'
      );
      return reply.send({
        success: true,
        result: { handled: false, reason: 'not_an_inbound_message' },
      });
    }

    const payload = data?.payload as Record<string, unknown> | undefined;
    const from = (payload?.from as { phone_number?: string } | undefined)?.phone_number;
    const toArr = payload?.to as Array<{ phone_number?: string }> | undefined;
    const ourNumber = toArr?.[0]?.phone_number;
    const text = payload?.text as string | undefined;

    if (!from || !ourNumber) {
      req.log.warn(
        { event: 'telnyx_inbound_malformed' },
        'Inbound SMS webhook missing from/to phone number'
      );
      return reply.status(400).send({ success: false, error: 'Missing from/to in Telnyx payload' });
    }

    const fromPhone = normalizePhone(from);
    const toPhone = normalizePhone(ourNumber);

    // Resolve the tenant from OUR number (the message's destination). Cross-tenant
    // by nature — the sender isn't authenticated and no tenant context exists yet —
    // so this reads `tenants` on the raw pool, relying on the admin-bypass policy.
    const tenantRes = await pool.query<{ tenant_id: string }>(
      // is_deleted filter: a soft-deleted business must not still be answering its
      // phone. Without this, an inbound STOP would resolve to a zombie tenant and be
      // recorded against a business that no longer exists.
      `SELECT tenant_id FROM tenants WHERE inbound_phone = $1 AND is_deleted = false LIMIT 1`,
      [toPhone]
    );
    const tenantId = tenantRes.rows[0]?.tenant_id ?? null;
    if (!tenantId) {
      // 200, not an error: Telnyx RETRIES non-2xx, and a text to a number we
      // don't own is not a failure we can fix by being retried.
      inboundSmsTotal.inc({ outcome: 'unknown_tenant' });
      req.log.warn(
        { event: 'telnyx_inbound_unknown_tenant', to_last4: toPhone?.slice(-4) },
        'Inbound SMS for a number matching no tenant — ignored'
      );
      return reply.send({ success: true, result: { handled: false, reason: 'unknown_tenant' } });
    }

    const keyword = classifySmsKeyword(text);

    // Opt-out FIRST: a STOP must never be interpreted as anything else. (When the
    // Y/N flow lands, its branches go AFTER this one for the same reason.)
    if (keyword === 'opt_out' || keyword === 'opt_in') {
      try {
        if (keyword === 'opt_out') {
          await consentService.processOptOutCommand(
            tenantId,
            'STOP',
            fromPhone ?? undefined,
            undefined,
            text
          );
        } else {
          // START/UNSTOP must RESTORE consent, not record an opt-out.
          //
          // These deliberately do NOT share processOptOutCommand: that method
          // unconditionally calls recordOptOut() regardless of the command it's
          // handed, so passing it 'START' would have opted the customer OUT of
          // everything ('both', since 'start' matches neither its 'stop' nor
          // 'unsubscribe' branch) — the exact inverse of what they asked for.
          // Caught in review on PR #238.
          //
          // checkConsent() reads the LATEST consent record for the phone, so
          // writing a fresh consent_given=true row is what actually re-enables
          // messaging after a previous STOP revoked it.
          await consentService.recordConsent({
            tenant_id: tenantId,
            customer_phone: fromPhone ?? undefined,
            consent_type: 'sms',
            consent_given: true,
            consent_date: new Date().toISOString(),
            consent_method: 'sms_reply',
            consent_source: 'inbound_sms:start',
          });
        }
      } catch (err) {
        // Instrumented, not swallowed: a failing opt-out is a COMPLIANCE failure,
        // and it is invisible without this (the customer just keeps getting texts).
        errorsTotal.inc({ event: 'telnyx_inbound_optout_failed' });
        req.log.error(
          { event: 'telnyx_inbound_optout_failed', tenant_id: tenantId, keyword, err },
          'Inbound SMS opt-out/opt-in FAILED to record — customer may keep receiving messages'
        );
        // Non-2xx so Telnyx retries: unlike an unknown tenant, this IS fixable
        // by being retried, and silently dropping an opt-out is not acceptable.
        return reply.status(500).send({ success: false, error: 'Failed to process opt-out' });
      }

      inboundSmsTotal.inc({ outcome: keyword === 'opt_out' ? 'opted_out' : 'opted_in' });
      req.log.info(
        { event: 'telnyx_inbound_keyword', tenant_id: tenantId, keyword },
        `Inbound SMS keyword handled: ${keyword}`
      );
      return reply.send({ success: true, result: { handled: true, keyword } });
    }

    // Phase 1 takes no action on anything else. The Y/N appointment-confirmation
    // branches attach here (phases 2–3). Acked so Telnyx doesn't retry.
    inboundSmsTotal.inc({ outcome: 'ignored' });
    return reply.send({ success: true, result: { handled: false, reason: 'no_keyword' } });
  });
}
