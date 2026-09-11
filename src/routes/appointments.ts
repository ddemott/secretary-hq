/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

import type { AppFastifyInstance } from '../types/fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { SUPER_ADMIN_TENANT_ID } from '../constants';
import {
  withHandler,
  logEvent,
  requireTenantId,
  withPoolClient,
  type AppRequest,
} from '../middleware/fastify-middleware';
import { syncAppointmentToAll } from '../services/syncOrchestrator';
import {
  scheduleRemindersForAppointment,
  rescheduleRemindersForAppointment,
} from '../services/reminders/scheduleForAppointment';
import { validateAppointmentTimeRange } from '../services/appointmentValidation';
import {
  findOverlappingAppointment,
  isOverlapError,
  type AppointmentConflict,
} from '../services/conflictLookup';
import { findNextAvailableSlots, type AvailableSlot } from '../services/availabilitySearch';
import { bookingAttemptsTotal } from '../services/metrics';
import { assertRowAffected } from './routeHelpers';
import { generateSelfServiceToken } from '../services/selfServiceToken';
import { sendSms } from '../services/telnyxSms';
import { normalizePhone, isValidPhone } from '../services/phoneUtils';

/**
 * Map a book_with_scheduling_atomic error_message back to the canonical
 * outcome label used in the metric. Keeps metric labels consistent with
 * the error_code values surfaced to the dashboard / agent prompt.
 */
function bookingOutcomeFromError(errMessage: string | null | undefined): string {
  if (!errMessage) return 'other_error';
  const m = errMessage.toLowerCase();
  if (m.includes('timeslot') || m.includes('overlap') || m.includes('exclusion'))
    return 'timeslot_occupied';
  if (m.includes('not on shift') || m.includes('not_scheduled')) return 'employee_not_scheduled';
  if (m.includes('skill')) return 'no_skilled_employee';
  if (m.includes('availability') || m.includes('no availability')) return 'no_availability';
  if (m.includes('past')) return 'past_time';
  if (m.includes('15-minute') || m.includes('increment')) return 'increment_violation';
  return 'other_error';
}

/** Map RPC error message to the stable error_code the dashboard + tests expect. */
function mapErrorMessageToCode(errMessage: string | null | undefined): string | undefined {
  if (!errMessage) return undefined;
  const m = errMessage.toLowerCase();
  if (m.includes('not on shift') || m.includes('not_scheduled')) return 'EMPLOYEE_NOT_SCHEDULED';
  if (m.includes('skill')) return 'NO_SKILLED_EMPLOYEE';
  if (m.includes('availability') || m.includes('no availability')) return 'NO_AVAILABILITY';
  if (m.includes('past')) return 'PAST_TIME';
  if (m.includes('15-minute') || m.includes('increment')) return 'INCREMENT_VIOLATION';
  return undefined;
}

const AppointmentCreateSchema = z.object({
  tenant_id: z.string().uuid(),
  resource_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  start_time: z.string().min(1),
  end_time: z.string().min(1),
  description: z.string().min(1).max(1000),
  location: z.string().max(500).optional().nullable(),
  employee_id: z.union([z.string(), z.number()]).optional().nullable(),
  // Optional FK to services. When provided, the booking RPC enforces
  // service_employee + service_resource mapping (or, if the mapping is
  // empty for that service, the legacy required_skills/_resources array
  // check). Omitting it keeps unchanged behavior — every existing caller
  // before 2026-05-07 left it null.
  service_id: z.string().uuid().optional().nullable(),
});

const AppointmentUpdateSchema = z.object({
  tenant_id: z.string().uuid(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  description: z.string().max(1000).optional(),
  location: z.string().max(500).optional().nullable(),
  resource_id: z.string().uuid().optional(),
  employee_id: z.union([z.string(), z.number(), z.null()]).optional(),
  customer_name: z.string().max(200).optional(),
  customer_phone: z.string().max(30).optional(),
  customer_notes: z.string().max(2000).optional(),
});

export function registerAppointmentRoutes(
  app: AppFastifyInstance,
  pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  app.post(
    '/appointments/create',
    withHandler(async (req: AppRequest, reply) => {
      const parsed = AppointmentCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        bookingAttemptsTotal.inc({ outcome: 'validation_error', source: 'api' });
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const body = parsed.data;
      const timeValidationError = validateAppointmentTimeRange(body.start_time, body.end_time);
      if (timeValidationError) {
        bookingAttemptsTotal.inc({ outcome: 'validation_error', source: 'api' });
        return reply.status(400).send({
          success: false,
          error: timeValidationError.error,
          error_code: timeValidationError.code,
        });
      }

      type RpcResult =
        | { success: true; appointment_id: string; error_message: null }
        | { success: false; appointment_id: null; error_message: string };
      const outcome = await withTenantClient(body.tenant_id, async (client) => {
        const rpcRes = await client.query<RpcResult>(
          // Positional args mirror the RPC signature (12 params; null-defaulted
          // tail args supplied explicitly so the call is unambiguous):
          // tenant, resource, customer, start, end, description, call_id,
          // location, assignment_id (employee or user), service_id,
          // customer_phone, customer_name.
          `SELECT * FROM book_appointment_atomic(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL
         )`,
          [
            body.tenant_id,
            body.resource_id,
            body.customer_id,
            body.start_time,
            body.end_time,
            body.description,
            'manual-entry',
            body.location || null,
            body.employee_id ? body.employee_id.toString() : null,
            body.service_id || null,
          ]
        );
        const result = rpcRes.rows[0];
        // On overlap, query for the conflicting appointment in the same
        // connection so the operator can see WHICH booking is blocking.
        // Other failure modes (past time, no skilled employee, etc.) skip
        // this lookup — they have nothing to point at.
        let conflict: AppointmentConflict | null = null;
        let nextAvailable: AvailableSlot[] = [];
        if (result && !result.success && isOverlapError(result.error_message)) {
          conflict = await findOverlappingAppointment(client, {
            tenantId: body.tenant_id,
            resourceId: body.resource_id,
            employeeId: body.employee_id ? body.employee_id.toString() : null,
            startTime: body.start_time,
            endTime: body.end_time,
          });
          // Also fetch the next-available slots so the conflict modal can
          // show "Try one of these times instead" — same connection, same
          // tenant scope. Service requirements derive from the booking's
          // service_id when present (preferred) or fall open otherwise.
          let requiredSkills: string[] = [];
          let requiredCaps: string[] = [];
          let durationMinutes = Math.max(
            15,
            Math.round(
              (new Date(body.end_time).getTime() - new Date(body.start_time).getTime()) /
                (60 * 1000 * 15)
            ) * 15
          );
          if (body.service_id) {
            const svcRes = await client.query<{
              duration_minutes: number | null;
              required_skills: string[] | null;
              required_resources: string[] | null;
            }>(
              `SELECT duration_minutes, required_skills, required_resources
               FROM services WHERE service_id = $1 AND tenant_id = $2`,
              [body.service_id, body.tenant_id]
            );
            if (svcRes.rows[0]) {
              requiredSkills = svcRes.rows[0].required_skills ?? [];
              requiredCaps = svcRes.rows[0].required_resources ?? [];
              if (svcRes.rows[0].duration_minutes) {
                durationMinutes = svcRes.rows[0].duration_minutes;
              }
            }
          }
          nextAvailable = await findNextAvailableSlots(client, {
            tenantId: body.tenant_id,
            fromTime: body.start_time,
            durationMinutes,
            requiredSkills,
            requiredCapabilities: requiredCaps,
            count: 5,
            // Suggestions follow the skill map for the chosen service, the same
            // links book_appointment_atomic already enforces on this path.
            serviceId: body.service_id ?? null,
          });
        }
        return { result, conflict, nextAvailable };
      });
      const { result, conflict, nextAvailable } = outcome;
      if (!result) {
        return reply.status(500).send({ success: false, error: 'Booking RPC returned no result' });
      }
      if (result.success) {
        logEvent(req, 'appointment_created', { appointmentId: result.appointment_id });
        bookingAttemptsTotal.inc({ outcome: 'success', source: 'api' });
        void syncAppointmentToAll(pool, body.tenant_id, result.appointment_id, 'create', req.log);
        // Fire-and-forget: a reminder schedule miss must never fail the booking.
        // The 4 rows feed the 60s worker tick at src/workers/reminderScheduler.ts.
        void scheduleRemindersForAppointment(
          withTenantClient,
          body.tenant_id,
          result.appointment_id,
          req.log
        );
        return reply.send({ success: true, appointment_id: result.appointment_id });
      }
      if (conflict) {
        bookingAttemptsTotal.inc({ outcome: 'timeslot_occupied', source: 'api' });
        return reply.status(409).send({
          success: false,
          error: result.error_message,
          error_code: 'TIMESLOT_OCCUPIED',
          conflict,
          next_available: nextAvailable,
        });
      }
      bookingAttemptsTotal.inc({
        outcome: bookingOutcomeFromError(result.error_message),
        source: 'api',
      });
      const errorCode = mapErrorMessageToCode(result.error_message);
      const responseBody: any = { success: false, error: result.error_message };
      if (errorCode) responseBody.error_code = errorCode;
      return reply.status(400).send(responseBody);
    }, 'Failed to create appointment')
  );

  app.get(
    '/appointments',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const query = req.query as Record<string, string | undefined>;
      const limit = Math.min(parseInt(query['limit'] ?? '') || 200, 1000);
      const offset = parseInt(query['offset'] ?? '') || 0;
      const startDate = query['start_date'] || null;
      const endDate = query['end_date'] || null;

      const isSuperAdmin = tenantId === SUPER_ADMIN_TENANT_ID;

      // Build WHERE clauses and params dynamically for date filtering.
      // params is a pg parameterized-query value list — Postgres accepts
      // any JS primitive (string | number | boolean | Date | null) plus
      // arrays of same; `unknown[]` names "we don't statically know the
      // type per slot" without the bare `any[]` permission.
      const conditions: string[] = ['a.is_deleted = false'];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (!isSuperAdmin) {
        conditions.push(`a.tenant_id = $${paramIdx}`);
        params.push(tenantId);
        paramIdx++;
      }

      if (startDate) {
        conditions.push(`a.start_time >= $${paramIdx}`);
        params.push(startDate);
        paramIdx++;
      }

      if (endDate) {
        conditions.push(`a.start_time < $${paramIdx}`);
        params.push(endDate);
        paramIdx++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const baseQuery = `
      SELECT
         a.*,
         COALESCE(a.employee_id::text, a.assigned_to_user_id::text) as employee_id,
         jsonb_build_object(
           'name', c.name, 'first_name', c.first_name, 'last_name', c.last_name,
           'phone', c.phone, 'metadata', c.metadata
         ) AS customers,
         jsonb_build_object('name', r.name) AS resources
       FROM appointments a
       LEFT JOIN customers c ON c.customer_id = a.customer_id
       LEFT JOIN resources r ON r.resource_id = a.resource_id
       ${whereClause}
       ORDER BY a.start_time ASC`;

      if (isSuperAdmin) {
        params.push(limit, offset);
        return withPoolClient(pool, async (client) => {
          const res = await client.query(
            `${baseQuery} LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
            params
          );
          return reply.send(res.rows);
        });
      }

      params.push(limit, offset);
      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(`${baseQuery} LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`, params);
      });
      return reply.send(res.rows);
    }, 'Failed to fetch appointments')
  );

  app.delete(
    '/appointments/:id',
    withHandler(async (req: AppRequest, reply) => {
      const { id } = req.params as { id: string };
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      // Sync delete before removing from DB
      syncAppointmentToAll(pool, tenantId, id, 'delete', req.log);

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          'DELETE FROM appointments WHERE appointment_id = $1 AND tenant_id = $2 RETURNING appointment_id',
          [id, tenantId]
        );
      });
      if (!assertRowAffected(res, reply, 'Appointment')) return;

      logEvent(req, 'appointment_deleted', { appointmentId: id });
      return reply.send({ success: true });
    }, 'Failed to delete appointment')
  );

  // POST /appointments/:id/cancel - soft cancel (status update, not delete)
  app.post(
    '/appointments/:id/cancel',
    withHandler(async (req: AppRequest, reply) => {
      const { id } = req.params as { id: string };
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          "UPDATE appointments SET status = 'canceled' WHERE appointment_id = $1 AND tenant_id = $2 RETURNING appointment_id",
          [id, tenantId]
        );
      });
      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Appointment not found' });
      }

      logEvent(req, 'appointment_canceled', { appointmentId: id });
      // Remove from calendars/CRMs — canceled appointments shouldn't block the slot
      syncAppointmentToAll(pool, tenantId, id, 'delete', req.log);
      return reply.send({ success: true });
    }, 'Failed to cancel appointment')
  );

  // POST /appointments/:id/reactivate — restore a soft-canceled appointment.
  // Pairs with /cancel: cancel sets status='canceled' (which the GiST exclusion
  // constraints exclude from the scheduled set, freeing the slot); reactivate
  // flips back to 'scheduled', which re-enters the constraint set. If another
  // booking took the slot while this one was canceled, the UPDATE fails with
  // PG error 23P01 (exclusion_violation) and the route returns 409 with a
  // conflict block describing the blocker (mirrors /appointments/create's
  // 409 + conflict shape so the dashboard can surface "slot is taken — book
  // a new one instead"). Status guard: only currently-canceled rows can
  // reactivate (400 on already-scheduled or completed) — keeps the route
  // idempotent-friendly and prevents accidentally re-firing the create-sync
  // for a row that was never canceled.
  app.post(
    '/appointments/:id/reactivate',
    withHandler(async (req: AppRequest, reply) => {
      const { id } = req.params as { id: string };
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      let outcome: 'success' | 'not_found' | 'not_canceled' | 'conflict' = 'not_found';
      let conflict: AppointmentConflict | null = null;

      await withTenantClient(tenantId, async (client) => {
        const sel = await client.query<{
          status: string;
          resource_id: string;
          employee_id: string | null;
          start_time: string;
          end_time: string;
        }>(
          `SELECT status, resource_id, employee_id::text AS employee_id,
                start_time::text AS start_time, end_time::text AS end_time
           FROM appointments
          WHERE appointment_id = $1 AND tenant_id = $2 AND (is_deleted IS NULL OR is_deleted = false)`,
          [id, tenantId]
        );
        if (sel.rows.length === 0) {
          outcome = 'not_found';
          return;
        }
        const row = sel.rows[0];
        if (row.status !== 'canceled') {
          outcome = 'not_canceled';
          return;
        }

        try {
          await client.query(
            `UPDATE appointments SET status = 'scheduled' WHERE appointment_id = $1 AND tenant_id = $2`,
            [id, tenantId]
          );
          outcome = 'success';
        } catch (err: unknown) {
          const code = (err as { code?: string } | null)?.code;
          if (code === '23P01') {
            conflict = await findOverlappingAppointment(client, {
              tenantId,
              resourceId: row.resource_id,
              employeeId: row.employee_id,
              startTime: row.start_time,
              endTime: row.end_time,
            });
            outcome = 'conflict';
            return;
          }
          throw err;
        }
      });

      if (outcome === 'not_found') {
        return reply.status(404).send({ success: false, error: 'Appointment not found' });
      }
      if (outcome === 'not_canceled') {
        return reply.status(400).send({
          success: false,
          error: 'Only canceled appointments can be reactivated',
          error_code: 'NOT_CANCELED',
        });
      }
      if (outcome === 'conflict') {
        return reply.status(409).send({
          success: false,
          error: 'That time slot is no longer available',
          error_code: 'TIMESLOT_OCCUPIED',
          conflict,
        });
      }

      logEvent(req, 'appointment_reactivated', { appointmentId: id });
      // Re-add to calendars/CRMs — reactivated appointments are scheduled again
      syncAppointmentToAll(pool, tenantId, id, 'create', req.log);
      return reply.send({ success: true });
    }, 'Failed to reactivate appointment')
  );

  app.post(
    '/appointments/:id/update',
    withHandler(async (req: AppRequest, reply) => {
      const { id } = req.params as { id: string };
      const parsed = AppointmentUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const body = parsed.data;

      // Cross-check: body.tenant_id must match the authenticated user's tenant (unless super-admin)
      const authTenantId = req.auth?.tenant_id;
      if (
        authTenantId &&
        authTenantId !== SUPER_ADMIN_TENANT_ID &&
        body.tenant_id !== authTenantId
      ) {
        return reply
          .status(403)
          .send({ success: false, error: 'tenant_id does not match authenticated tenant' });
      }

      let shortCircuited = false;
      // Tracks whether the operator changed start_time — used after COMMIT to
      // decide whether to reschedule reminders. Comparing body.start_time !==
      // prior is the honest signal: a no-op update that re-submits the same
      // start_time shouldn't tear down and re-seed reminders.
      let startTimeChanged = false;
      await withTenantClient(body.tenant_id, async (client) => {
        // Wrap in transaction to ensure atomicity
        await client.query('BEGIN');
        try {
          let effectiveStartTime = body.start_time ?? null;
          let effectiveEndTime = body.end_time ?? null;
          if (body.start_time || body.end_time) {
            const existing = await client.query<{ start_time: string; end_time: string }>(
              'SELECT start_time::text AS start_time, end_time::text AS end_time FROM appointments WHERE appointment_id = $1 AND tenant_id = $2 AND is_deleted = false',
              [id, body.tenant_id]
            );
            if (existing.rows.length === 0) {
              await client.query('ROLLBACK');
              shortCircuited = true;
              void reply.status(404).send({ success: false, error: 'Appointment not found' });
              return;
            }
            effectiveStartTime = body.start_time ?? existing.rows[0].start_time;
            effectiveEndTime = body.end_time ?? existing.rows[0].end_time;
            if (body.start_time && body.start_time !== existing.rows[0].start_time) {
              startTimeChanged = true;
            }
            const timeValidationError = validateAppointmentTimeRange(
              effectiveStartTime,
              effectiveEndTime
            );
            if (timeValidationError) {
              await client.query('ROLLBACK');
              shortCircuited = true;
              void reply.status(400).send({
                success: false,
                error: timeValidationError.error,
                error_code: timeValidationError.code,
              });
              return;
            }
          }

          // Direct UPDATE instead of RPC — avoids integer/UUID type mismatch
          // on the overloaded update_appointment_customer functions
          const fields: string[] = [];
          const values: unknown[] = [];
          let idx = 1;

          if (body.start_time) {
            fields.push(`start_time = $${idx}`);
            values.push(body.start_time);
            idx++;
          }
          if (body.end_time) {
            fields.push(`end_time = $${idx}`);
            values.push(body.end_time);
            idx++;
          }
          if (body.description !== undefined) {
            fields.push(`description = $${idx}`);
            values.push(body.description);
            idx++;
          }
          if (body.location !== undefined) {
            fields.push(`location = $${idx}`);
            values.push(body.location || null);
            idx++;
          }
          if (body.resource_id) {
            fields.push(`resource_id = $${idx}`);
            values.push(body.resource_id);
            idx++;
          }
          if (body.employee_id !== undefined) {
            fields.push(`employee_id = $${idx}`);
            values.push(body.employee_id ? body.employee_id.toString() : null);
            idx++;
          }

          if (fields.length > 0) {
            values.push(id); // WHERE appointment_id = $N
            values.push(body.tenant_id); // AND tenant_id = $N+1
            await client.query(
              `UPDATE appointments SET ${fields.join(', ')} WHERE appointment_id = $${idx} AND tenant_id = $${idx + 1}`,
              values
            );
          }

          // Update customer info if provided
          if (body.customer_name || body.customer_phone || body.customer_notes) {
            const appt = await client.query(
              'SELECT customer_id FROM appointments WHERE appointment_id = $1 AND is_deleted = false',
              [id]
            );
            if (appt.rows[0]?.customer_id) {
              const custFields: string[] = [];
              const custValues: unknown[] = [];
              let ci = 1;
              if (body.customer_name) {
                custFields.push(`name = $${ci}`);
                custValues.push(body.customer_name);
                ci++;
              }
              if (body.customer_phone) {
                custFields.push(`phone = $${ci}`);
                custValues.push(body.customer_phone);
                ci++;
              }
              if (body.customer_notes !== undefined) {
                custFields.push(
                  `metadata = jsonb_set(COALESCE(metadata, '{}'), '{notes}', $${ci}::jsonb)`
                );
                custValues.push(JSON.stringify(body.customer_notes));
                ci++;
              }
              if (custFields.length > 0) {
                custValues.push(appt.rows[0].customer_id);
                custValues.push(body.tenant_id);
                await client.query(
                  `UPDATE customers SET ${custFields.join(', ')} WHERE customer_id = $${ci} AND tenant_id = $${ci + 1}`,
                  custValues
                );
              }
            }
          }

          await client.query('COMMIT');
          return { rows: [{ success: true }] };
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      });

      if (shortCircuited) {
        return;
      }

      logEvent(req, 'appointment_updated', { appointmentId: id });
      // Sync update to calendars/CRMs
      syncAppointmentToAll(pool, body.tenant_id, id, 'update', req.log);
      // If the operator moved the appointment in time, cancel the existing
      // reminder bundle and seed a fresh one so customers don't receive
      // reminders for the OLD time. Fire-and-forget — a reminder write
      // failure must never fail the update RPC itself.
      if (startTimeChanged) {
        void rescheduleRemindersForAppointment(withTenantClient, body.tenant_id, id, req.log);
      }
      return reply.send({ success: true });
    }, 'Failed to update appointment')
  );

  // POST /appointments/:id/send-self-service-links
  // Generates fresh cancel + reschedule tokens and SMSes them to the customer.
  // Requires JWT auth (staff/owner). Only works for scheduled appointments.
  app.post(
    '/appointments/:id/send-self-service-links',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      const { id } = req.params as { id: string };

      const baseUrl = (process.env.DASHBOARD_URL ?? process.env.BACKEND_PUBLIC_URL ?? '')
        .trim()
        .replace(/\/+$/, '');
      if (!baseUrl) {
        return reply.status(503).send({
          success: false,
          error: 'Self-service links not configured (set DASHBOARD_URL or BACKEND_PUBLIC_URL).',
        });
      }

      const row = await withTenantClient(tenantId, async (client) => {
        const res = await client.query<{
          start_time: string;
          description: string;
          customer_phone: string | null;
          inbound_phone: string | null;
        }>(
          `SELECT a.start_time, a.description, c.phone AS customer_phone, t.inbound_phone
             FROM appointments a
             JOIN customers c ON a.customer_id = c.customer_id
             JOIN tenants t ON t.tenant_id = a.tenant_id
             WHERE a.appointment_id = $1
               AND a.tenant_id = $2
               AND a.status = 'scheduled'
               AND a.is_deleted = false`,
          [id, tenantId]
        );
        return res.rows[0] ?? null;
      });

      if (!row) {
        return reply
          .status(404)
          .send({ success: false, error: 'Appointment not found or not scheduled.' });
      }
      if (!row.customer_phone) {
        return reply
          .status(400)
          .send({ success: false, error: 'Customer has no phone number on file.' });
      }

      const normalizedTo = normalizePhone(row.customer_phone);
      if (!normalizedTo || !isValidPhone(normalizedTo)) {
        return reply
          .status(400)
          .send({ success: false, error: 'Invalid phone number — check customer phone on file.' });
      }

      const consented = await withTenantClient(tenantId, async (client) => {
        const res = await client.query<{ consent_given: boolean; revoked_at: string | null }>(
          `SELECT consent_given, revoked_at
             FROM consent_records
            WHERE tenant_id = $1
              AND customer_phone = $2
              AND consent_type IN ('sms', 'both')
            ORDER BY consent_date DESC
            LIMIT 1`,
          [tenantId, normalizedTo]
        );

        const latest = res.rows[0];
        if (!latest) return false;
        if (latest.revoked_at) return false;
        return latest.consent_given === true;
      });

      if (!consented) {
        return reply.status(400).send({
          success: false,
          error: 'Customer has not consented to SMS communications.',
        });
      }

      const cancelToken = generateSelfServiceToken(id, tenantId, 'cancel');
      const rescheduleToken = generateSelfServiceToken(id, tenantId, 'reschedule');
      if (!cancelToken || !rescheduleToken) {
        return reply
          .status(503)
          .send({ success: false, error: 'Failed to generate self-service tokens.' });
      }

      const cancelLink = `${baseUrl}/self/cancel?token=${encodeURIComponent(cancelToken)}`;
      const rescheduleLink = `${baseUrl}/self/reschedule?token=${encodeURIComponent(rescheduleToken)}`;

      const dateStr = new Date(row.start_time).toLocaleDateString();
      const smsBody =
        `Your ${row.description} on ${dateStr} — ` +
        `Cancel: ${cancelLink} Reschedule: ${rescheduleLink} ` +
        `Reply STOP to opt out.`;

      const fromPhone = row.inbound_phone ?? process.env.TELNYX_PHONE_NUMBER ?? '';
      const normalizedFrom = fromPhone ? normalizePhone(fromPhone) : null;

      if (
        !normalizedFrom ||
        !normalizedTo ||
        !isValidPhone(normalizedFrom) ||
        !isValidPhone(normalizedTo)
      ) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid phone number — check customer phone and tenant inbound_phone.',
        });
      }

      const smsResult = await sendSms({ from: normalizedFrom, to: normalizedTo, body: smsBody });
      if (!smsResult.ok) {
        return reply
          .status(502)
          .send({ success: false, error: smsResult.error ?? 'SMS send failed.' });
      }

      logEvent(req, 'self_service_links_sent', { appointmentId: id });
      return reply.send({
        success: true,
        message: `Links sent to ${normalizedTo}.`,
        cancelLink,
        rescheduleLink,
      });
    }, 'Failed to send self-service links')
  );
}
