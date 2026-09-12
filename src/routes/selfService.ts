/**
 * Self-service appointment actions — token-gated, no session auth required.
 *
 * These routes are intentionally unauthenticated: the token (sent via SMS/email
 * link) IS the auth. They are registered WITHOUT tenantMiddleware so the JWT
 * hook never fires; the token's `tenant_id` + `appointment_id` claims scope
 * every DB write.
 *
 * RLS note: appointments uses FORCE ROW LEVEL SECURITY. We must use
 * withTenantClient (which sets app.current_tenant_id) rather than pool.query
 * directly — bare pool queries see every row blocked by RLS even with an
 * explicit WHERE tenant_id = $n clause.
 *
 * Currently supported:
 *   GET /self/cancel?token=...     — cancel a single appointment
 *   GET /self/reschedule?token=... — notify owner of a reschedule request
 */

import type { PoolClient } from 'pg';
import type { AppFastifyInstance } from '../types/fastify.js';
import { withHandler, logEvent } from '../middleware/fastify-middleware';
import { verifySelfServiceToken } from '../services/selfServiceToken.js';
import { sendSms } from '../services/telnyxSms.js';
import { normalizePhone, isValidPhone } from '../services/phoneUtils.js';

export function registerSelfServiceRoutes(
  app: AppFastifyInstance,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  /**
   * GET /self/cancel?token=...
   *
   * Cancel a single appointment via a 24-hour signed token.
   * Returns JSON so mobile browsers and raw curl both get a usable response.
   * Idempotent: canceling an already-canceled appointment returns 200.
   */
  app.get(
    '/self/cancel',
    withHandler(async (req, reply) => {
      const { token } = req.query as { token?: string };
      if (!token) {
        return reply
          .status(400)
          .send({ success: false, error: 'Missing cancel token. The link may be incomplete.' });
      }

      const payload = verifySelfServiceToken(token, 'cancel');
      if (!payload) {
        return reply.status(400).send({
          success: false,
          error:
            'This cancel link has expired or is invalid. Please call us to cancel your appointment.',
        });
      }

      const { appointment_id, tenant_id } = payload;

      // withTenantClient sets app.current_tenant_id so FORCE RLS passes.
      // Token claims scope the write to this specific tenant — cross-tenant
      // cancel is structurally impossible even with a replayed token.
      const result = await withTenantClient(tenant_id, async (client) => {
        return client.query(
          `UPDATE appointments
           SET status = 'canceled'
           WHERE appointment_id = $1
             AND tenant_id = $2
             AND status != 'canceled'
           RETURNING appointment_id`,
          [appointment_id, tenant_id]
        );
      });

      if (result.rowCount === 0) {
        const check = await withTenantClient(tenant_id, async (client) => {
          return client.query(
            `SELECT status FROM appointments WHERE appointment_id = $1 AND tenant_id = $2`,
            [appointment_id, tenant_id]
          );
        });
        if (check.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: 'Appointment not found. It may have already been removed.',
          });
        }
        return reply.send({
          success: true,
          message: 'Your appointment has already been canceled.',
        });
      }

      logEvent(req, 'appointment_self_canceled', {
        appointmentId: appointment_id,
        tenantId: tenant_id,
      });

      return reply.send({
        success: true,
        message: 'Your appointment has been canceled. We hope to see you again soon!',
      });
    }, 'Failed to cancel appointment')
  );

  /**
   * GET /self/reschedule?token=...
   *
   * Notify the business owner that a customer wants to reschedule.
   * Does NOT modify the appointment — the owner calls back to find a new time.
   * Returns JSON so mobile browsers and raw curl both get a usable response.
   */
  app.get(
    '/self/reschedule',
    withHandler(async (req, reply) => {
      const { token } = req.query as { token?: string };
      if (!token) {
        return reply
          .status(400)
          .send({ success: false, error: 'Missing reschedule token. The link may be incomplete.' });
      }

      const payload = verifySelfServiceToken(token, 'reschedule');
      if (!payload) {
        return reply.status(400).send({
          success: false,
          error:
            'This reschedule link has expired or is invalid. Please call us to reschedule your appointment.',
        });
      }

      const { appointment_id, tenant_id } = payload;

      // Look up the appointment + customer details and the tenant's phone numbers.
      const { appt, forwardPhone, inboundPhone } = await withTenantClient(
        tenant_id,
        async (client) => {
          const apptRes = await client.query<{
            start_time: string;
            description: string;
            customer_name: string;
            customer_phone: string;
          }>(
            `SELECT a.start_time, a.description, c.name AS customer_name, c.phone AS customer_phone
             FROM appointments a
             JOIN customers c ON a.customer_id = c.customer_id
             WHERE a.appointment_id = $1
               AND a.tenant_id = $2
               AND a.status = 'scheduled'`,
            [appointment_id, tenant_id]
          );

          const tenantRes = await client.query<{
            forward_phone: string | null;
            inbound_phone: string | null;
          }>(`SELECT forward_phone, inbound_phone FROM tenants WHERE tenant_id = $1`, [tenant_id]);

          return {
            appt: apptRes.rows[0] ?? null,
            forwardPhone: tenantRes.rows[0]?.forward_phone ?? null,
            inboundPhone: tenantRes.rows[0]?.inbound_phone ?? null,
          };
        }
      );

      if (!appt) {
        return reply.status(404).send({
          success: false,
          error: 'Appointment not found or is no longer scheduled.',
        });
      }

      // Fire-and-forget SMS to owner if both phone numbers are valid.
      if (forwardPhone && inboundPhone) {
        const normalizedForward = normalizePhone(forwardPhone);
        const normalizedInbound = normalizePhone(inboundPhone);
        if (
          normalizedForward &&
          normalizedInbound &&
          isValidPhone(normalizedForward) &&
          isValidPhone(normalizedInbound)
        ) {
          const body =
            `Reschedule request from ${appt.customer_name} (${appt.customer_phone}) ` +
            `for ${appt.description} on ${new Date(appt.start_time).toLocaleDateString()}. ` +
            `Reply to schedule a new time.`;
          // sendSms is a chokepoint that never rejects (see telnyxSms.ts) — it
          // already counts the failure in errors_total, but a bare .catch()
          // here can never fire, so a failed owner-nudge produced no local
          // log line at all. Check result.ok instead.
          void sendSms({ from: normalizedInbound, to: normalizedForward, body }).then((result) => {
            if (!result.ok) {
              req.log.error(
                { error: result.error, status: result.status },
                'Failed to send reschedule-request SMS to owner'
              );
            }
          });
        }
      }

      logEvent(req, 'appointment_reschedule_requested', {
        appointmentId: appointment_id,
        tenantId: tenant_id,
      });

      return reply.send({
        success: true,
        message:
          "Your reschedule request has been sent. We'll contact you shortly to find a new time.",
      });
    }, 'Failed to submit reschedule request')
  );
}
