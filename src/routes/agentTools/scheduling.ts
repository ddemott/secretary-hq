/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method, @typescript-eslint/no-explicit-any */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

/**
 * Booking agent tools: what the business sells (service catalog), when it can
 * be booked (availability, scheduling options, open slots), the two booking
 * RPCs, and the caller-owned mutations (my-appointments, cancel, reschedule).
 */
import {
  AttachMeetingNotesSchema,
  BookAppointmentSchema,
  BookWithSchedulingSchema,
  CancelAppointmentSchema,
  CheckAvailabilitySchema,
  GetAvailableSlotsSchema,
  GetSchedulingOptionsSchema,
  GetServiceCatalogSchema,
  MyAppointmentsSchema,
  RescheduleAppointmentSchema,
} from './schemas';
import {
  ok,
  fail,
  toolRoute,
  captureRequestedService,
  bookingOutcomeFromAgentError,
  timeToMinutes,
  mergeIntervals,
  subtractIntervals,
  pickOfferTimes,
  type AgentToolDeps,
} from './helpers';
import type { PoolClient } from 'pg';
import { applyTimezone, toLocalWallClock } from '../../services/timezoneUtils';
import { CALLER_NOTES_PREFIX, toStampText } from '../../../shared/callContext';
import {
  validateAppointmentTimeRange,
  isFifteenMinuteIncrement,
} from '../../services/appointmentValidation';
import { normalizePhone, isValidPhone } from '../../services/phoneUtils';
import { getOrCreateCustomerByPhone } from '../../services/customerLookup';
import { findNextAvailableSlots, type AvailableSlot } from '../../services/availabilitySearch';
import { resolveServiceForBooking } from '../../services/serviceResolver';
import { getTenantBufferMinutes } from '../../services/tenantBuffer';
import {
  explainRequestedTime,
  formatMinutesOfDay,
  parseRequestedTimeCandidates,
  resolveRequestedTime,
  reasonNote,
  spokenReason,
  type BookedInterval,
} from '../../services/availabilityReason';
import {
  findOverlappingAppointment,
  isOverlapError,
  type AppointmentConflict,
} from '../../services/conflictLookup';
import { syncAppointmentToAll } from '../../services/syncOrchestrator';
import { bookingAttemptsTotal } from '../../services/metrics';
import {
  selectAssignments,
  type ResourceCandidate,
  type EmployeeCandidate,
  type ExistingAppointment,
  type ShiftOverride,
  type Shift,
} from '../../../shared/scheduling';
import {
  scheduleRemindersForAppointment,
  rescheduleRemindersForAppointment,
  saveReminderLeadPreference,
} from '../../services/reminders/scheduleForAppointment';

/**
 * Speak a list of open slots the way a receptionist would: "Monday the 13th at
 * 1:00 PM with Dale". Times are rendered in the TENANT's timezone — the slots
 * come back as UTC instants, and reading those aloud would offer a Chicago caller
 * a 6 PM appointment for a 1 PM shift.
 */
function describeSlots(slots: AvailableSlot[], ianaTimezone: string, max = 2): string {
  return slots
    .slice(0, max)
    .map((s) => {
      const when = new Date(s.start_time).toLocaleString('en-US', {
        timeZone: ianaTimezone,
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      return s.employee_name ? `${when} with ${s.employee_name}` : when;
    })
    .join(', or ');
}

/**
 * The SOONEST real openings, searched from NOW — not from whatever date the
 * caller guessed.
 *
 * THIS IS THE FIX FOR THE 2026-07-12 CALL. The alternatives search used to start
 * at the caller's REQUESTED time and look 24 hours ahead. She asked for Aug 26;
 * the shop's schedule ended Aug 19; so we searched Aug 26–27 — a stretch of
 * calendar where nothing exists and nothing ever would — found zero slots, and
 * handed the agent an empty list. With nothing to offer, all it could say was
 * "would you like a different day?", so she guessed blind, three times, and gave
 * up after seven minutes. Meanwhile dozens of open slots sat in the following
 * week, invisible, because nobody looked backward.
 *
 * A caller who names an impossible date needs to be TOLD when we're actually
 * open. Searching forward from their mistake can only ever find more nothing.
 */
async function findSoonestSlots(
  client: PoolClient,
  params: {
    tenantId: string;
    durationMinutes: number;
    requiredSkills?: string[];
    requiredCapabilities?: string[];
    bufferMinutes: number;
  }
): Promise<AvailableSlot[]> {
  return findNextAvailableSlots(client, {
    tenantId: params.tenantId,
    // From NOW. The whole point.
    fromTime: new Date().toISOString(),
    durationMinutes: params.durationMinutes,
    requiredSkills: params.requiredSkills ?? [],
    requiredCapabilities: params.requiredCapabilities ?? [],
    count: 3,
    // 168h (7 days) is the cap findNextAvailableSlots enforces. A week is enough
    // to find something for any business that works at all; if it isn't, the
    // honest answer really is "let me take a message."
    searchHorizonHours: 168,
    bufferMinutes: params.bufferMinutes,
  });
}

export function registerSchedulingRoutes({
  app,
  pool,
  withTenantClient,
  // Booking now matches the SERVICE by MEANING, not by substring — the caller says
  // "a meeting to talk about a role" and pgvector finds Programming Consultation.
  // Previously the LLM guessed a catalog name and an ILIKE dutifully matched its
  // guess, which is how a six-month-contract conversation got booked as a 15-minute
  // Personal Callback. See serviceResolver.
  getEmbedding,
}: AgentToolDeps): void {
  // get_service_catalog — list public services for the tenant.
  toolRoute(
    app,
    '/agent-tools/service-catalog',
    GetServiceCatalogSchema,
    async (args, reply) => {
      const res = await withTenantClient(args.tenant_id, (client) =>
        client.query(
          `SELECT service_id, name, subtitle, description, duration_minutes, price
           FROM services
          WHERE tenant_id = $1 AND is_deleted = false
          ORDER BY name ASC`,
          [args.tenant_id]
        )
      );
      return ok(reply, { services: res.rows });
    },
    'Failed to fetch service catalog'
  );

  // check_availability — wraps check_availability_with_tz() RPC. The agent
  // sends naive datetimes; we apply the tenant's timezone before the RPC
  // since Postgres can't know which zone "2026-05-01 14:00" is meant in.
  toolRoute(
    app,
    '/agent-tools/check-availability',
    CheckAvailabilitySchema,
    async (args, reply) => {
      if (isNaN(Date.parse(args.start_time)) || isNaN(Date.parse(args.end_time))) {
        return fail(reply, 'Invalid date format provided for availability check.');
      }
      if (new Date(args.end_time) <= new Date(args.start_time)) {
        return fail(reply, 'End time must be after start time.');
      }

      const result = await withTenantClient(args.tenant_id, async (client) => {
        const tz = await client.query<{ timezone: string; default_buffer_minutes: number | null }>(
          `SELECT COALESCE(timezone, 'America/Chicago') AS timezone, default_buffer_minutes FROM tenants WHERE tenant_id = $1`,
          [args.tenant_id]
        );
        const ianaTimezone = tz.rows[0]?.timezone || 'America/Chicago';
        // Buffer makes "is this slot free?" agree with what booking will accept,
        // so the agent never reports a within-buffer time as available.
        const bufferMinutes =
          typeof tz.rows[0]?.default_buffer_minutes === 'number' &&
          tz.rows[0].default_buffer_minutes > 0
            ? tz.rows[0].default_buffer_minutes
            : 0;
        const start = applyTimezone(args.start_time, ianaTimezone);
        const end = applyTimezone(args.end_time, ianaTimezone);
        const rpc = await client.query(
          'SELECT * FROM check_availability_with_tz($1, $2, $3::timestamptz, $4::timestamptz, $5, $6)',
          [args.tenant_id, args.resource_id, start, end, null, bufferMinutes]
        );
        if (rpc.rows.length === 0) {
          throw new Error('check_availability_with_tz returned no result');
        }
        return rpc.rows[0];
      });

      return ok(reply, {
        available: result.available,
        tenant_timezone: result.tenant_timezone,
        local_start: result.local_start,
        local_end: result.local_end,
      });
    },
    'Failed to check availability'
  );

  // book_appointment — upsert customer by phone, then call
  // book_appointment_atomic RPC. The RPC does all the conflict / shift /
  // skill validation server-side; we just translate the (success, err)
  // tuple into the conversational response shape.
  toolRoute(
    app,
    '/agent-tools/book-appointment',
    BookAppointmentSchema,
    async (args, reply) => {
      // Gate: without a valid phone we can't confirm, reschedule, or follow
      // up with the caller. The agent's system prompt hears this message
      // and kicks into the /send-verification-code OTP flow to collect one.
      if (!isValidPhone(args.phone)) {
        return fail(
          reply,
          "Before I book, I'll need a good phone number so we can confirm your appointment and reach you if anything changes. What's the best number to text or call?"
        );
      }
      const normalized = normalizePhone(args.phone)!;
      const timeValidationError = validateAppointmentTimeRange(args.start_time, args.end_time);
      if (timeValidationError) {
        // Hand-rolled response (not fail()) so the agent sees error_code —
        // its prompt branches differently for INVALID_INCREMENT (re-snap to
        // grid) vs INVALID_RANGE (re-ask for end time) vs INVALID_PARAMS
        // (re-ask for both). Same outcome label as the dashboard route.
        bookingAttemptsTotal.inc({ outcome: 'validation_error', source: 'agent' });
        (reply as unknown as { _toolOutcome?: string })._toolOutcome = 'error';
        return reply.status(200).send({
          success: false,
          error: timeValidationError.error,
          error_code: timeValidationError.code,
        });
      }

      // Step 1 — get-or-create the customer in its own transaction so the row
      // persists even if the booking RPC below returns failure. See
      // services/customerLookup.ts for the rationale.
      const customerId = await getOrCreateCustomerByPhone(
        withTenantClient,
        args.tenant_id,
        normalized,
        args.name || 'Valued Customer'
      );

      // Step 2 — booking RPC in a fresh transaction. On overlap, do a follow-up
      // SELECT in the same connection to find the conflicting appointment so
      // the response can carry conflict details (matches /appointments/create
      // contract — Slice 1 of the booking enforcement hardening 2026-05-09).
      const outcome = await withTenantClient(args.tenant_id, async (client) => {
        // Buffer enforced on the agent path only (owner manual booking via
        // /appointments/create passes no buffer → 0 → unrestricted).
        const bufferMinutes = await getTenantBufferMinutes(client, args.tenant_id);
        // The agent supplies the caller's LOCAL wall-clock time (tenant tz), not
        // UTC. Without this, a naive "T15:30:00" is parsed as 15:30 UTC and the
        // appointment lands hours off (10:30 CDT for a 3:30 PM request). Convert
        // via applyTimezone (DST-correct; a no-op if the value already carries a
        // Z/offset) using the tenant's zone — matching check-availability.
        const tzRes = await client.query<{ timezone: string }>(
          `SELECT COALESCE(timezone, 'America/Chicago') AS timezone FROM tenants WHERE tenant_id = $1`,
          [args.tenant_id]
        );
        const ianaTimezone = tzRes.rows[0]?.timezone || 'America/Chicago';
        const startUtc = applyTimezone(args.start_time, ianaTimezone);
        const endUtc = applyTimezone(args.end_time, ianaTimezone);
        // p_assignment_id is TEXT in the current RPC (holds UUID post-Phase 9).
        // Trailing NULLs are p_service_id / p_customer_phone / p_customer_name
        // (unused on this path); the final arg is p_buffer_minutes.
        const rpc = await client.query<{
          success: boolean;
          appointment_id: string | null;
          error_message: string | null;
        }>(
          `SELECT * FROM book_appointment_atomic(
           $1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9, NULL, NULL, NULL, $10
         )`,
          [
            args.tenant_id,
            args.resource_id,
            customerId,
            startUtc,
            endUtc,
            args.description,
            args.call_id,
            args.location || null,
            args.employee_id || null,
            bufferMinutes,
          ]
        );
        const result = rpc.rows[0];
        let conflict: AppointmentConflict | null = null;
        if (result && !result.success && isOverlapError(result.error_message)) {
          conflict = await findOverlappingAppointment(client, {
            tenantId: args.tenant_id,
            resourceId: args.resource_id,
            employeeId: args.employee_id || null,
            startTime: args.start_time,
            endTime: args.end_time,
          });
        }
        return { result, conflict };
      });
      const { result, conflict } = outcome;

      if (!result || !result.success) {
        bookingAttemptsTotal.inc({
          outcome: bookingOutcomeFromAgentError(result?.error_message),
          source: 'agent',
        });
        // Hand-rolled response (not fail()) when conflict info is present so
        // the agent + dashboard can read structured fields. Mirrors the
        // book-with-scheduling shape so consumers see one error contract.
        if (conflict) {
          (reply as unknown as { _toolOutcome?: string })._toolOutcome = 'error';
          return reply.status(200).send({
            success: false,
            error: result?.error_message || 'That time is already booked.',
            error_code: 'TIMESLOT_OCCUPIED',
            conflict,
          });
        }
        return fail(reply, result?.error_message || 'Booking failed due to a scheduling conflict.');
      }
      bookingAttemptsTotal.inc({ outcome: 'success', source: 'agent' });
      // Fire-and-forget: schedule confirmation SMS + reminders. Errors are
      // swallowed inside scheduleRemindersForAppointment — a reminder failure
      // must never fail the booking response.
      if (result.appointment_id) {
        void scheduleRemindersForAppointment(
          withTenantClient,
          args.tenant_id,
          result.appointment_id,
          app.log
        );
      }
      return ok(reply, {
        success: true,
        appointment_id: result.appointment_id,
        error_message: null,
      });
    },
    'Failed to book appointment'
  );

  // get_scheduling_options — pure-selector scheduling helper. Loads the
  // tenant's resources/employees/shifts/appointments for the day of the
  // window and runs the shared selectAssignments() algorithm. Diagnostics
  // explain *why* nothing matched when options is empty — the agent uses
  // the reason string to ask a better follow-up question.
  toolRoute(
    app,
    '/agent-tools/scheduling-options',
    GetSchedulingOptionsSchema,
    async (args, reply) => {
      if (isNaN(Date.parse(args.window.from)) || isNaN(Date.parse(args.window.to))) {
        return fail(reply, 'Invalid date format in scheduling window.');
      }
      const windowFrom = new Date(args.window.from);
      const windowTo = new Date(args.window.to);
      if (windowTo <= windowFrom) {
        return fail(reply, 'Window end must be after window start.');
      }
      const dateStr = windowFrom.toISOString().substring(0, 10);

      // Pure availability inquiry → attribute the requested service to this
      // call's voice_session so a caller who never attempts a booking still
      // counts toward abandonment-by-service. Fire-and-forget.
      captureRequestedService(
        withTenantClient,
        args.tenant_id,
        args.call_id,
        args.requirements.serviceType
      );

      const data = await withTenantClient(args.tenant_id, async (client) => {
        // Resources with union of explicit caps + derived from services.
        const resRes = await client.query<{ resource_id: string; capabilities: string[] }>(
          `SELECT r.resource_id,
                ARRAY(
                  SELECT DISTINCT unnest(
                    r.capabilities ||
                    COALESCE(array_agg(DISTINCT cap) FILTER (WHERE cap IS NOT NULL), '{}')
                  )
                ) AS capabilities
           FROM resources r
           LEFT JOIN service_resource sr ON r.resource_id = sr.resource_id
           LEFT JOIN services s ON sr.service_id = s.service_id
           LEFT JOIN LATERAL unnest(s.required_resources) cap ON true
          WHERE r.tenant_id = $1
            AND r.is_active = true
            AND (r.is_deleted IS NULL OR r.is_deleted = false)
          GROUP BY r.resource_id, r.capabilities`,
          [args.tenant_id]
        );

        const empRes = await client.query<{ employee_id: string; skills: string[] }>(
          `SELECT employee_id::text AS employee_id, skills
           FROM employees
          WHERE tenant_id = $1 AND is_active = true
            AND (is_deleted IS NULL OR is_deleted = false)`,
          [args.tenant_id]
        );

        const apptRes = await client.query<{
          resource_id: string;
          start_time: string;
          end_time: string;
        }>(
          `SELECT resource_id, start_time, end_time
           FROM appointments
          WHERE tenant_id = $1
            AND status = 'scheduled'
            AND (is_deleted IS NULL OR is_deleted = false)
            AND start_time < $2::timestamptz
            AND end_time > $3::timestamptz`,
          [args.tenant_id, windowTo.toISOString(), windowFrom.toISOString()]
        );

        // Effective shifts for the date via bulk RPC (single call rather
        // than the N+1 per-employee loop the Deno repo still uses).
        const shiftRes = await client.query<{
          employee_id: string;
          start_time: string | null;
          end_time: string | null;
          is_off: boolean;
        }>(
          `SELECT employee_id::text AS employee_id,
                start_time::text AS start_time,
                end_time::text AS end_time,
                is_off
           FROM get_effective_shifts_bulk($1, $2::date, $2::date)`,
          [args.tenant_id, dateStr]
        );

        const bufferMinutes = await getTenantBufferMinutes(client, args.tenant_id);
        return { resRes, empRes, apptRes, shiftRes, bufferMinutes };
      });

      const resources: ResourceCandidate[] = data.resRes.rows.map((r) => ({
        resource_id: r.resource_id,
        capabilities: r.capabilities || [],
      }));
      const employees: EmployeeCandidate[] = data.empRes.rows.map((e) => ({
        employee_id: e.employee_id,
        skills: e.skills || [],
      }));
      const existingAppointments: ExistingAppointment[] = data.apptRes.rows.map((a) => ({
        resourceId: a.resource_id,
        start: new Date(a.start_time),
        end: new Date(a.end_time),
      }));
      const shiftOverrides: ShiftOverride[] = data.shiftRes.rows
        .filter((s) => s.is_off || (s.start_time && s.end_time))
        .map((s) => ({
          employee_id: s.employee_id,
          shift_date: dateStr,
          start_time: s.start_time,
          end_time: s.end_time,
          is_off: s.is_off,
        }));

      const { options, diagnostics } = selectAssignments({
        requirements: args.requirements,
        window: { from: windowFrom, to: windowTo },
        resources,
        employees,
        shifts: [] as Shift[], // date-based scheduling only; no weekly patterns
        shiftOverrides,
        existingAppointments,
        bufferMinutes: data.bufferMinutes,
      });

      return ok(reply, { options, diagnostics });
    },
    'Failed to compute scheduling options'
  );

  // book_with_scheduling — single-query booking via RPC that does customer
  // upsert + skill/shift matching + conflict check + insert in one tx.
  // Surfaces the RPC's error_code (TIMESLOT_OCCUPIED / NO_SKILLED_EMPLOYEE
  // / EMPLOYEE_NOT_SCHEDULED / NO_AVAILABILITY) so the agent can explain
  // the failure specifically rather than "something went wrong".
  toolRoute(
    app,
    '/agent-tools/book-with-scheduling',
    BookWithSchedulingSchema,
    async (args, reply) => {
      if (isNaN(Date.parse(args.window.from)) || isNaN(Date.parse(args.window.to))) {
        return fail(reply, 'Invalid date format in scheduling window.');
      }
      // Gate: see book-appointment above — same rationale, same message.
      if (!isValidPhone(args.phone)) {
        return fail(
          reply,
          "Before I book, I'll need a good phone number so we can confirm your appointment and reach you if anything changes. What's the best number to text or call?"
        );
      }
      const normalized = normalizePhone(args.phone)!;

      // Appointments live on a quarter-hour grid (appointments_start/end_time_15min
      // CHECKs). An off-grid window used to sail through to the RPC's INSERT and
      // come back as an unhandled 500 — which the agent relayed as "Backend
      // returned 500" and the model retried, identically, into the same wall.
      // Fail SPOKEN instead, naming the grid, so the model can renegotiate the time.
      if (
        !isFifteenMinuteIncrement(args.window.from) ||
        !isFifteenMinuteIncrement(args.window.to)
      ) {
        (reply as unknown as { _toolOutcome?: string })._toolOutcome = 'error';
        return reply.status(200).send({
          success: false,
          error:
            'We book on the quarter hour — times ending in :00, :15, :30, or :45. Please offer the caller the nearest quarter-hour time instead.',
          error_code: 'OFF_GRID_TIME',
          next_available: [],
        });
      }

      // Step 1 — get-or-create the customer in its own transaction. The RPC
      // would otherwise do this inside its own plpgsql function execution;
      // pulling it out guarantees the customer persists even when the RPC
      // returns NO_AVAILABILITY / TIMESLOT_OCCUPIED / etc., so the next
      // attempt doesn't re-collect the caller's identity. The RPC still
      // receives phone+name in step 2 — its lookup-by-phone will find the
      // customer we just inserted and skip its own INSERT branch.
      await getOrCreateCustomerByPhone(
        withTenantClient,
        args.tenant_id,
        normalized,
        args.name || 'Caller'
      );

      const outcomeOfBooking = await withTenantClient(args.tenant_id, async (client) => {
        // Resolve the service (falls through to the tenant default when the
        // spoken type doesn't match — so the booking uses a REAL service that
        // carries required_skills, and the RPC can assign a qualified employee
        // instead of failing NO_SKILLED_EMPLOYEE / booking an employee-less slot).
        const resolved = await resolveServiceForBooking(
          client,
          args.tenant_id,
          args.requirements.serviceType,
          getEmbedding
        );
        // Buffer enforced on the agent path; the RPC's internal slot selection
        // skips any resource/employee that would land within the buffer of an
        // existing appointment, so the slot it picks is one booking will accept.
        const bufferMinutes = await getTenantBufferMinutes(client, args.tenant_id);
        // The agent's window is the caller's LOCAL wall-clock (tenant tz), not
        // UTC. `new Date(naive).toISOString()` would read it in the SERVER zone
        // (Railway = UTC) and search the wrong absolute window. Convert via
        // applyTimezone (DST-correct; no-op if already offset-carrying) — same
        // as check-availability + book-appointment.
        // One SELECT, two facts: the zone the window is expressed in, and the
        // owner's words for what happens at the appointment. booking_mechanics
        // rides along here rather than in its own round-trip because this is a
        // LIVE CALL — the caller is holding while these run.
        const tzRes = await client.query<{ timezone: string; booking_mechanics: string | null }>(
          `SELECT COALESCE(timezone, 'America/Chicago') AS timezone, booking_mechanics
             FROM tenants WHERE tenant_id = $1`,
          [args.tenant_id]
        );
        const ianaTimezone = tzRes.rows[0]?.timezone || 'America/Chicago';
        const mechanicsRaw = tzRes.rows[0]?.booking_mechanics;
        const mechanics =
          typeof mechanicsRaw === 'string' && mechanicsRaw.trim() ? mechanicsRaw.trim() : null;

        // CROSS-CALL DUPLICATE GUARD (2026-07-31).
        //
        // wrapAction's anti-double-book gate lives in the agent's in-memory
        // tracker: it stops a repeat WITHIN one call and knows nothing about
        // the call before it. On 2026-07-27 Jaya booked 1:00 PM on one call
        // (SCL_yyZ7Qd7WTcQx) and 2:30 PM for the same thing six minutes later
        // on the next (SCL_6QQqjBf7kNQj) — two live appointments ninety
        // minutes apart, the first never cancelled and never honored
        // (CALL_IMPROVEMENTS.md #9/#10).
        //
        // Same customer + same LOCAL DAY + still scheduled + a DIFFERENT call
        // → refuse, and hand the model the booking they already have so it can
        // offer keep / move / both. "Both" comes back as allow_duplicate — a
        // deliberate second appointment is legitimate (two cars, two people);
        // an accidental one is the bug. Same call_id is exempt: a retry of THIS
        // booking is the idempotency path, not a duplicate. Scoped to the same
        // DAY on purpose — next week's booking must not block today's.
        if (!args.allow_duplicate) {
          const dup = await client.query<{ start_time: string; service: string | null }>(
            `SELECT a.start_time, s.name AS service
               FROM appointments a
               JOIN customers c ON c.customer_id = a.customer_id AND c.tenant_id = a.tenant_id
               LEFT JOIN services s ON s.service_id = a.service_id AND s.tenant_id = a.tenant_id
              WHERE a.tenant_id = $1 AND c.phone = $2
                AND a.status = 'scheduled'
                AND (a.is_deleted IS NULL OR a.is_deleted = false)
                AND (a.call_id IS DISTINCT FROM $3)
                AND (a.start_time AT TIME ZONE $4)::date
                    = ($5::timestamptz AT TIME ZONE $4)::date
              ORDER BY a.start_time ASC
              LIMIT 1`,
            [
              args.tenant_id,
              normalized,
              args.call_id || null,
              ianaTimezone,
              applyTimezone(args.window.from, ianaTimezone),
            ]
          );
          if (dup.rows[0]) {
            return {
              kind: 'duplicate' as const,
              spokenTime: toLocalWallClock(dup.rows[0].start_time, ianaTimezone),
              service: dup.rows[0].service,
            };
          }
        }

        const rpc = await client.query<{
          success: boolean;
          appointment_id: string | null;
          resource_id: string | null;
          resource_name: string | null;
          employee_id: string | null;
          employee_name: string | null;
          booked_start: string | null;
          booked_end: string | null;
          customer_id: string | null;
          error_message: string | null;
          error_code: string | null;
        }>(
          `SELECT * FROM book_with_scheduling_atomic(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
         )`,
          [
            args.tenant_id,
            normalized,
            args.name || null,
            args.description,
            args.call_id || null,
            args.location || null,
            null, // p_start_time — unused when window provided
            null, // p_end_time
            applyTimezone(args.window.from, ianaTimezone),
            applyTimezone(args.window.to, ianaTimezone),
            // Prefer the resolved service's required_skills (so the RPC assigns
            // a skilled employee); fall back to any the agent explicitly supplied.
            (resolved?.required_skills?.length
              ? resolved.required_skills
              : args.requirements.requiredEmployeeSkills) || [],
            args.requirements.requiredResourceCapabilities || [],
            args.requirements.preferredResourceId || null,
            null, // p_preferred_employee_id
            resolved?.name ?? args.requirements.serviceType ?? null,
            resolved?.duration_minutes ?? 30,
            bufferMinutes, // p_buffer_minutes
            // p_service_id — WHAT WAS ACTUALLY BOOKED.
            //
            // The RPC has always taken p_service_type (a NAME) and used it only to pick
            // a skilled employee, then thrown it away: its INSERT never listed
            // service_id. So every appointment this product has ever booked by phone
            // has a NULL service. The owner sees a customer, a time, and a blank.
            // The service was resolved right here, in `resolved`, and never sent.
            resolved?.service_id ?? null,
          ]
        );
        const row = rpc.rows[0];
        // Response symmetry: the RPC returns booked_start/end as UTC. The agent
        // speaks these back to confirm ("booked for 3:30 PM"), so convert them
        // to the tenant-local wall-clock — otherwise it would confirm the UTC
        // instant (8:30 PM for a 3:30 PM Chicago booking), reintroducing the
        // same tz mismatch on the read-back that we just fixed on the write.
        if (row) {
          if (row.booked_start) row.booked_start = toLocalWallClock(row.booked_start, ianaTimezone);
          if (row.booked_end) row.booked_end = toLocalWallClock(row.booked_end, ianaTimezone);
        }
        return { kind: 'booked' as const, row, mechanics };
      });

      // The caller already has something today — refuse before anything is
      // written, and tell the model exactly what they have.
      if (outcomeOfBooking.kind === 'duplicate') {
        const { spokenTime, service } = outcomeOfBooking;
        bookingAttemptsTotal.inc({ outcome: 'duplicate_same_day', source: 'agent' });
        (reply as unknown as { _toolOutcome?: string })._toolOutcome = 'error';
        return reply.status(200).send({
          success: false,
          error:
            `This caller ALREADY has an appointment today at ${spokenTime}` +
            `${service ? ` (${service})` : ''}. Do NOT book a second one silently — tell them ` +
            `what they already have and ask whether they want to KEEP it, MOVE it to the new ` +
            `time (reschedule_appointment), or genuinely book a SECOND separate appointment. ` +
            `Only if they clearly want both, call this again with allow_duplicate true. ` +
            // WITHOUT THIS LINE THE CALL CANNOT END. The booking action stays
            // unresolved after a refusal, and the goodbye gate holds the call
            // open — on the first sim run of this guard the agent correctly
            // relayed the existing 1:00 PM, the caller said "let's keep that
            // one", and then both sides looped "anything else?" until the
            // transcript ran out. A refusal has to come with its own exit.
            `IF THEY KEEP THE ONE THEY HAVE: their goal is already met — record the booking ` +
            `step as declined (record_answer, declined true) so the call can close. Do not ` +
            `keep asking "anything else?" against a booking that is never coming.`,
          error_code: 'EXISTING_SAME_DAY',
          existing_appointment: { start_time: spokenTime, service },
          next_available: [],
        });
      }
      const result = outcomeOfBooking.row;
      const mechanics = outcomeOfBooking.mechanics;

      // Best-effort: record the service the caller was trying to book — runs
      // whether the booking SUCCEEDED or FAILED, so an abandoned booking
      // attempt still shows which service they came for.
      captureRequestedService(
        withTenantClient,
        args.tenant_id,
        args.call_id,
        args.requirements.serviceType
      );

      if (!result || !result.success) {
        // Fetch next-available alternatives so the agent can propose them verbally
        // instead of saying "no availability." Same skill + capability filters as
        // the booking attempt. Two stages — see below. Failure to find anything
        // leaves next_available empty; the agent prompt handles both shapes.
        const nextAvailable = await withTenantClient(args.tenant_id, async (client) => {
          // Same buffer as the booking attempt, so every suggested alternative
          // is one the agent can actually book under this tenant's buffer.
          const bufferMinutes = await getTenantBufferMinutes(client, args.tenant_id);
          const searchParams = {
            tenantId: args.tenant_id,
            durationMinutes: args.requirements.durationMinutes || 30,
            requiredSkills: args.requirements.requiredEmployeeSkills || [],
            requiredCapabilities: args.requirements.requiredResourceCapabilities || [],
            bufferMinutes,
          };

          // STAGE 1 — look NEAR the time they asked for. Someone who wanted 2pm
          // Tuesday would rather hear "I have 2:30 Tuesday" than "how about next
          // Monday?". Now a 7-day horizon rather than the old 24h default, so a
          // fully-booked Tuesday still surfaces Wednesday and Thursday.
          const nearRequested = await findNextAvailableSlots(client, {
            ...searchParams,
            fromTime: new Date(args.window.from).toISOString(),
            count: 5,
            searchHorizonHours: 168,
          });
          if (nearRequested.length > 0) return nearRequested;

          // STAGE 2 — THE FIX FOR THE 2026-07-12 CALL. Nothing near their time at
          // all, which almost always means they named a date the shop cannot
          // reach: past the end of the schedule, or a day nobody works. Searching
          // FURTHER FORWARD from that date can only ever find more nothing — that
          // is exactly what happened (asked for Aug 26, schedule ended Aug 19, we
          // searched Aug 26–27, found zero, and the agent had nothing to say but
          // "try another day"). Search from NOW so we can tell them when we are
          // actually open.
          return findSoonestSlots(client, searchParams);
        }).catch(() => []);
        bookingAttemptsTotal.inc({
          outcome: bookingOutcomeFromAgentError(result?.error_message, result?.error_code),
          source: 'agent',
        });
        // Hand-rolled response (not ok/fail) so the agent can read
        // error_code + next_available; mirror the success-flag for the
        // tool-call counter so the validation-error branch isn't double-bumped.
        (reply as unknown as { _toolOutcome?: string })._toolOutcome = 'error';
        return reply.status(200).send({
          success: false,
          error: result?.error_message || 'No available scheduling options',
          error_code: result?.error_code || 'NO_AVAILABILITY',
          next_available: nextAvailable,
        });
      }

      bookingAttemptsTotal.inc({ outcome: 'success', source: 'agent' });
      if (result.appointment_id) {
        // reminder_lead_minutes is the caller's answer to "would you like a text
        // reminder, and how far ahead?" — passed explicitly rather than read back
        // from their preferences, because seeding is fire-and-forget and racing a
        // just-written preference on a live call is not a thing worth debugging.
        // Absent → the seeder falls back to their stored preference, then to the
        // standard bundle. See scheduleForAppointment.ts.
        void scheduleRemindersForAppointment(
          withTenantClient,
          args.tenant_id,
          result.appointment_id,
          app.log,
          { reminderLeadMinutes: args.reminder_lead_minutes ?? null }
        );
        // Remember the lead for next time, so a returning caller doesn't have to
        // ask twice (and so a reschedule rebuilds the row at the same lead).
        // Fire-and-forget for the same reason the seeding is: a preference write
        // must never fail a confirmed booking.
        if (args.reminder_lead_minutes != null) {
          void saveReminderLeadPreference(
            withTenantClient,
            args.tenant_id,
            args.phone,
            args.reminder_lead_minutes,
            app.log
          );
        }
      }
      // WHAT HAPPENS AT THE BOOKED TIME — the owner's own words, spoken
      // verbatim (fetched with the timezone above; no extra round-trip).
      //
      // Booking a "call" never defined who dials whom, so when the 2026-07-27
      // caller asked, the model invented the agreeable answer: "call Dale
      // directly at two thirty… you can use the same number" — the AI's own
      // line. Four more failed calls followed from that one sentence
      // (CALL_IMPROVEMENTS.md #9, #5-#8). The model could not have known; nobody
      // had ever written the fact down. Now the tenant writes it once.
      // NULL/blank tenant → the field is absent and the confirmation is
      // unchanged, because saying nothing is honest and guessing is not.
      return ok(reply, {
        success: true,
        appointment_id: result.appointment_id,
        resource_name: result.resource_name,
        employee_name: result.employee_name,
        booked_start: result.booked_start,
        booked_end: result.booked_end,
        error_message: null,
        ...(mechanics
          ? {
              what_happens_next: mechanics,
              instruction: `Confirm the booked time, then say this VERBATIM: "${mechanics}" — it is what actually happens at the appointment, and you must never improvise your own version of it.`,
            }
          : {}),
      });
    },
    'Failed to book with scheduling'
  );

  // get_available_slots — computes open windows for a service on a given
  // date. Single SQL union-all pulls service + shifts + appointments in
  // one round trip; interval math then merges shift coverage and subtracts
  // bookings. Returns a *spoken* string because the agent relays it
  // verbatim to the caller.
  toolRoute(
    app,
    '/agent-tools/available-slots',
    GetAvailableSlotsSchema,
    async (args, reply) => {
      // Pure availability inquiry → attribute the requested service to this
      // call's voice_session so a caller who never attempts a booking still
      // counts toward abandonment-by-service. Fire-and-forget.
      captureRequestedService(withTenantClient, args.tenant_id, args.call_id, args.service_type);

      // Resolve the service FIRST — falls through to the tenant default when
      // the caller's spoken type doesn't match a real service, so "a meeting" /
      // "consulting" / anything never dead-ends with "couldn't find a service".
      // Null only when the tenant has no bookable service at all.
      const service = await withTenantClient(args.tenant_id, (client) =>
        resolveServiceForBooking(client, args.tenant_id, args.service_type, getEmbedding)
      );

      if (!service) {
        // "someone", not a name. This string is SPOKEN TO THE CALLER, and it used to
        // say "I'll have DALE get back to you" — a hardcoded first name, in a route
        // that every tenant on the platform shares. A caller to Bella's Hair Studio
        // was told a man named Dale would ring them back. (Found 2026-07-14 while
        // grepping for exactly this after the same bug turned up in the job-inquiry
        // reply.) The route has no owner name to hand and does not need one: a
        // receptionist saying "someone will get back to you" is correct for every
        // business, and a name we cannot look up is a name we must not invent.
        return ok(
          reply,
          `I'm not able to pull up our booking options right now. Would you like to leave a message and I'll have someone get back to you?`
        );
      }

      // NO DATE = THE SOONEST-OPENINGS OPENER (Dale's design, 2026-07-17).
      //
      // An open "what day works for you?" is a question against a calendar the
      // caller cannot see — the 2026-07-12 caller guessed impossibly three
      // times and hung up. The agent now LEADS with the next three real times
      // and closes with the invitation to name their own: options first, open
      // question last. The offers are duration-stepped (same rule as
      // offer_times), span days when the soonest day runs short, and respect a
      // lead buffer so a caller is never offered a meeting that starts in ten
      // minutes.
      if (!args.date) {
        const { name: svcName, duration_minutes: svcDur, price: svcPrice } = service;
        const svcInfo =
          svcPrice && svcPrice > 0
            ? `${svcName} takes about ${svcDur} minutes and costs $${svcPrice.toFixed(0)}.`
            : `${svcName} takes about ${svcDur} minutes.`;
        // One hour: enough that "soonest" never means "leave for it right now".
        // A fixed platform default on purpose — becomes a tenant knob when a
        // real tenant asks for a different one (build-for-real-customers).
        const SOONEST_LEAD_MINUTES = 60;
        const { slots, ianaTimezone } = await withTenantClient(args.tenant_id, async (client) => {
          const tzRes = await client.query<{ timezone: string }>(
            `SELECT COALESCE(timezone, 'America/Chicago') AS timezone FROM tenants WHERE tenant_id = $1`,
            [args.tenant_id]
          );
          const bufferMinutes = await getTenantBufferMinutes(client, args.tenant_id);
          return {
            ianaTimezone: tzRes.rows[0]?.timezone || 'America/Chicago',
            slots: await findNextAvailableSlots(client, {
              tenantId: args.tenant_id,
              fromTime: new Date(Date.now() + SOONEST_LEAD_MINUTES * 60_000).toISOString(),
              durationMinutes: svcDur,
              requiredSkills: [],
              requiredCapabilities: [],
              // Enough grid slots to step three duration-length offers across
              // booked gaps and day boundaries.
              count: 12,
              searchHorizonHours: 168,
              bufferMinutes,
            }),
          };
        });

        if (slots.length === 0) {
          return ok(reply, {
            spoken: `${svcInfo} I'm not finding anything open in the next week. Would you like me to take a message so someone can call you back?`,
            date: null,
            open_times: [],
            offer_times: [],
            note: 'Nothing is open in the next week. Do NOT offer any time. Offer to take a message.',
          });
        }

        // Relative day label in the TENANT's clock: "today" / "tomorrow" /
        // "Monday". Beyond a week is unreachable (168h horizon).
        const dayKey = (iso: string): string =>
          new Date(iso).toLocaleDateString('en-CA', { timeZone: ianaTimezone });
        const todayKey = dayKey(new Date().toISOString());
        const tomorrowKey = dayKey(new Date(Date.now() + 86_400_000).toISOString());
        const dayLabel = (iso: string): string => {
          const k = dayKey(iso);
          if (k === todayKey) return 'today';
          if (k === tomorrowKey) return 'tomorrow';
          return new Date(iso).toLocaleDateString('en-US', {
            timeZone: ianaTimezone,
            weekday: 'long',
          });
        };
        const timeLabel = (iso: string): string =>
          new Date(iso).toLocaleTimeString('en-US', {
            timeZone: ianaTimezone,
            hour: 'numeric',
            minute: '2-digit',
          });

        // Duration-step across the grid slots (epoch minutes feed the same
        // pickOfferTimes the day view uses), then keep the picked slots' ISO
        // order for grouping.
        const mins = slots.map((s) => Math.floor(new Date(s.start_time).getTime() / 60_000));
        const isoLabels = slots.map((s) => s.start_time);
        const pickedIso = pickOfferTimes(mins, isoLabels, svcDur);
        const offers = pickedIso.map((iso) => ({ day: dayLabel(iso), time: timeLabel(iso) }));
        const offerTimes = offers.map((o) => `${o.day} at ${o.time}`);

        // Group consecutive same-day offers so the sentence reads the way a
        // person says it: "today at 4:30 PM, or tomorrow at 1:00 PM or 1:30 PM".
        const groups: string[] = [];
        for (const o of offers) {
          const last = groups.length - 1;
          if (groups.length > 0 && groups[last].startsWith(`${o.day} at `)) {
            groups[last] += ` or ${o.time}`;
          } else {
            groups.push(`${o.day} at ${o.time}`);
          }
        }
        const spokenOffers = groups.join(', or ');

        return ok(reply, {
          spoken: `${svcInfo} The soonest I can get you in is ${spokenOffers}. Would any of those work, or is there another day or time that suits you better?`,
          date: null,
          // Day-scoped membership does not exist in a cross-day answer — the
          // note routes a caller-named day or time to a dated call.
          open_times: [],
          offer_times: offerTimes,
          note: 'These offer_times are the SOONEST bookable openings. Offer exactly these, as ONE natural sentence with commas — never a bulleted or numbered list. If the caller picks one, book it. If the caller names their OWN day or time, call get_available_slots again WITH that date to check it — open_times is empty here because this answer spans days, not because nothing is open.',
        });
      }

      // The caller's own number, normalized once, for attributing a blocking
      // appointment back to them. Server-injected by the agent runtime.
      const callerPhoneNormalized = args.caller_phone ? normalizePhone(args.caller_phone) : null;
      // The specific time they asked for, if any. A bare "2" carries two
      // readings; the day's OPEN HOURS decide which (a shop open 1-5 PM makes
      // it 2 PM, with nothing guessed) — resolved once `coverage` exists below.
      // Still unresolvable → no explanation at all, never an invented one.
      const requestedCandidates = parseRequestedTimeCandidates(args.requested_time);

      // Format date for speech ("Wednesday, April 2")
      const dateObj = new Date(args.date + 'T12:00:00');
      const dayName = dateObj.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });

      const data = await withTenantClient(args.tenant_id, async (client) => {
        const res = await client.query<{
          source: 'shift' | 'appointment';
          start_time: string | null;
          end_time: string | null;
          is_caller: boolean | null;
        }>(
          `WITH active_employees AS (
             SELECT employee_id FROM employees
              WHERE tenant_id = $1 AND is_active = true
                AND (is_deleted IS NULL OR is_deleted = false)
           ),
           effective_shifts AS (
             SELECT DISTINCT es.start_time::text AS start_time, es.end_time::text AS end_time
               FROM active_employees ae
               JOIN employee_schedule es
                 ON es.employee_id = ae.employee_id
                AND es.tenant_id = $1
                AND es.shift_date = $2::date
                AND es.is_off = false
                AND es.start_time IS NOT NULL
           ),
           day_appointments AS (
             -- TENANT-LOCAL WALL-CLOCK, both the filter and the rendering.
             -- start_time is timestamptz; the un-annotated casts here rendered
             -- it in the SESSION timezone — UTC on the prod pooler — while the
             -- shifts above are local TIME columns. So Jack's 1:00 PM Monday
             -- booking came back as "18:00", fell OUTSIDE the 13:00-17:00
             -- shift coverage, and subtracted NOTHING: on 2026-07-17 this
             -- route offered his exact taken slot to the next caller, who
             -- picked it and bounced off TIMESLOT_OCCUPIED (the GiST layer
             -- knew). The suggest layer and the enforce layer must read the
             -- same clock: the tenant's. (The date filter needs it too, or a
             -- late-evening local booking files under the wrong UTC day.)
             -- is_caller: does this appointment belong to the person on the
             -- phone? "You already have 2:30 booked" and "2:30 is taken" are
             -- different answers, and only one of them stops a double-booking.
             -- $3 is server-injected (agent runtime), never model-supplied.
             SELECT ((a.start_time AT TIME ZONE t.timezone)::time)::text AS start_time,
                    ((a.end_time   AT TIME ZONE t.timezone)::time)::text AS end_time,
                    ($3::text IS NOT NULL AND c.phone = $3::text) AS is_caller
               FROM appointments a
               JOIN tenants t ON t.tenant_id = a.tenant_id
               LEFT JOIN customers c ON c.customer_id = a.customer_id
              WHERE a.tenant_id = $1 AND a.status = 'scheduled'
                AND (a.is_deleted IS NULL OR a.is_deleted = false)
                AND (a.start_time AT TIME ZONE t.timezone)::date = $2::date
           )
           SELECT 'shift'::text AS source, start_time, end_time, false AS is_caller
             FROM effective_shifts
           UNION ALL
           SELECT 'appointment'::text, start_time, end_time, is_caller FROM day_appointments
           ORDER BY source, start_time`,
          [args.tenant_id, args.date, callerPhoneNormalized]
        );
        const shifts: Array<{ start_time: string; end_time: string }> = [];
        const appointments: Array<{ start_time: string; end_time: string; is_caller: boolean }> =
          [];
        for (const row of res.rows) {
          if (row.source === 'shift' && row.start_time && row.end_time) {
            shifts.push({ start_time: row.start_time, end_time: row.end_time });
          } else if (row.source === 'appointment' && row.start_time && row.end_time) {
            appointments.push({
              start_time: row.start_time,
              end_time: row.end_time,
              is_caller: row.is_caller === true,
            });
          }
        }
        // Buffer so the openings we read aloud match what booking will accept.
        const bufferMinutes = await getTenantBufferMinutes(client, args.tenant_id);
        // The tenant timezone drives the past-time filter below. Without it the
        // "is today / what time is it now" check runs on the SERVER clock (UTC
        // on Railway), which at 7pm Chicago has already rolled to tomorrow — so
        // the filter was skipped and past slots were offered. Same clock as the
        // shift/appointment rendering above: the tenant's.
        const tzRes = await client.query<{ timezone: string }>(
          `SELECT COALESCE(timezone, 'America/Chicago') AS timezone FROM tenants WHERE tenant_id = $1`,
          [args.tenant_id]
        );
        const timezone = tzRes.rows[0]?.timezone || 'America/Chicago';
        return { shifts, appointments, bufferMinutes, timezone };
      });

      const { name: serviceName, duration_minutes, price } = service;
      const serviceInfo =
        price && price > 0
          ? `${serviceName} takes about ${duration_minutes} minutes and costs $${price.toFixed(0)}.`
          : `${serviceName} takes about ${duration_minutes} minutes.`;

      if (data.shifts.length === 0) {
        // Nobody works that day — but DON'T leave the caller guessing. Tell them
        // when we ARE open.
        //
        // This is the line the 2026-07-12 caller heard, three times: "we don't
        // have anyone scheduled to work on Wednesday. Would you like to try a
        // different day?" She had no way to know which days WERE open, so she
        // guessed — twice more, both wrong — and gave up after seven minutes. To
        // her it sounded like a business with no staff. Offering the soonest real
        // opening turns a dead end into a booking.
        const { soonest, ianaTimezone } = await withTenantClient(args.tenant_id, async (client) => {
          const tzRes = await client.query<{ timezone: string }>(
            `SELECT COALESCE(timezone, 'America/Chicago') AS timezone FROM tenants WHERE tenant_id = $1`,
            [args.tenant_id]
          );
          const bufferMinutes = await getTenantBufferMinutes(client, args.tenant_id);
          return {
            ianaTimezone: tzRes.rows[0]?.timezone || 'America/Chicago',
            soonest: await findSoonestSlots(client, {
              tenantId: args.tenant_id,
              durationMinutes: duration_minutes,
              bufferMinutes,
            }),
          };
        });

        if (soonest.length > 0) {
          // Same SHAPE on every path (see the open_times comment below). A route that
          // returns a bare string sometimes and an object other times makes the model
          // guess which it got, and a model that guesses is the whole problem.
          // open_times is empty because nothing is open ON THE REQUESTED DAY — the
          // alternatives live in the spoken text, which is where the caller needs them.
          return ok(reply, {
            spoken: `${serviceInfo} We don't have anyone scheduled on ${dayName}, but the soonest I can get you in is ${describeSlots(soonest, ianaTimezone)}. Would either of those work?`,
            date: args.date,
            open_times: [],
            note: 'Nothing is open on the requested day. open_times is empty — do NOT offer a time on this day. Offer the alternatives named in spoken.',
          });
        }
        // Genuinely nothing open for a week — now "try another day" IS the honest
        // answer, and a message is the right fallback.
        return ok(reply, {
          spoken: `${serviceInfo} Unfortunately, we don't have anyone scheduled to work on ${dayName}, and I'm not finding anything open in the next week. Would you like me to take a message so someone can call you back?`,
          date: args.date,
          open_times: [],
          note: 'Nothing is open. open_times is empty — do NOT offer any time. Offer to take a message.',
        });
      }

      const coverage = mergeIntervals(
        data.shifts.map((s) => ({
          start: timeToMinutes(s.start_time),
          end: timeToMinutes(s.end_time),
        }))
      );
      // NOW the ambiguity can be settled with a fact instead of a coin-flip:
      // "2" against a 1-5 PM shop is 2 PM, because 2 AM is not a time this
      // business exists at. Unresolvable (open at both, or at neither) → null,
      // and the response simply carries no explanation.
      const requestedMinutes = resolveRequestedTime(requestedCandidates, coverage);
      const requestedLabel =
        requestedMinutes !== null
          ? formatMinutesOfDay(requestedMinutes)
          : (args.requested_time ?? '');
      // Expand each booking by the tenant's buffer on both sides before
      // subtracting it from shift coverage, so the open windows we offer keep
      // the required gap around existing appointments (matches the booking RPC).
      // timeToMinutes, NOT dateTimeToMinutes: the query renders appointments as
      // tenant-local bare times ('13:00:00'), same shape as the shifts. The old
      // dateTimeToMinutes path was the SECOND half of the timezone bug — it ran
      // new Date(dt).getHours(), which renders in the SERVER's timezone (UTC on
      // Railway), so even a correctly-fetched timestamp would have been read on
      // the wrong clock.
      const booked = data.appointments.map((a) => ({
        start: timeToMinutes(a.start_time) - data.bufferMinutes,
        end: timeToMinutes(a.end_time) + data.bufferMinutes,
      }));
      // UNBUFFERED, with attribution — the reason engine answers "is the
      // caller's own meeting sitting on this time", and the tenant's buffer is
      // not part of that fact. (The buffered copy above is what shapes the
      // offer list; conflating the two would report a neighbouring booking as
      // occupying a time it merely sits near.)
      const bookedForReason: BookedInterval[] = data.appointments.map((a) => ({
        start: timeToMinutes(a.start_time),
        end: timeToMinutes(a.end_time),
        isCaller: a.is_caller,
      }));
      const open = subtractIntervals(coverage, booked);
      const usable = open.filter((slot) => slot.end - slot.start >= duration_minutes);

      // If today, filter out past times — in the TENANT's timezone, not the
      // server's. `now.getHours()` / `now.toLocaleDateString` render in the
      // process tz (UTC on Railway). At 7pm America/Chicago that is 00:00 the
      // NEXT day, so `isToday` went false, `currentMinutes` fell to 0, and the
      // whole past-time filter was bypassed — the route offered slots from
      // earlier that same afternoon (already in the past). Reading "today" and
      // the current minute-of-day in `data.timezone` matches the tenant-local
      // wall-clock the slots themselves are built in. `% 24` guards the '24:00'
      // midnight spelling some runtimes emit for a 2-digit hour.
      const now = new Date();
      const todayKey = now.toLocaleDateString('en-CA', { timeZone: data.timezone });
      const isToday = args.date === todayKey;
      const nowParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: data.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(now);
      const nowHour = Number(nowParts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
      const nowMinute = Number(nowParts.find((p) => p.type === 'minute')?.value ?? '0');
      const currentMinutes = isToday ? nowHour * 60 + nowMinute : 0;
      const futureSlots = isToday
        ? usable
            .filter((s) => s.end > currentMinutes)
            .map((s) => ({ start: Math.max(s.start, currentMinutes), end: s.end }))
            .filter((s) => s.end - s.start >= duration_minutes)
        : usable;

      // THE EXPLANATION (2026-07-31). Computed from the same intervals that
      // built the list, so the reason can never disagree with the offer. Only
      // when the caller actually named a time — an unrequested explanation is
      // noise, and an unparseable one is a guess.
      const explainRequested = (openMins: number[]): Record<string, unknown> => {
        if (requestedMinutes === null) return {};
        const explanation = explainRequestedTime({
          requestedMinutes,
          durationMinutes: duration_minutes,
          coverage,
          booked: bookedForReason,
          openMinutes: openMins,
          isToday,
          currentMinutes,
        });
        const conflictLabel =
          explanation.conflictStart !== undefined
            ? formatMinutesOfDay(explanation.conflictStart)
            : undefined;
        const spoken = spokenReason(explanation, requestedLabel, conflictLabel);
        return {
          requested: {
            time: requestedLabel,
            available: explanation.verdict === 'available',
            reason: explanation.verdict,
            ...(conflictLabel ? { conflict_start: conflictLabel } : {}),
            ...(spoken ? { spoken_reason: spoken } : {}),
            note: reasonNote(explanation),
          },
        };
      };

      if (futureSlots.length === 0) {
        return ok(reply, {
          spoken: `${serviceInfo} Unfortunately, we're fully booked on ${dayName}. Would you like to try a different day?`,
          date: args.date,
          open_times: [],
          note: 'Fully booked. open_times is empty — do NOT offer any time on this day.',
          ...explainRequested([]),
        });
      }

      // The prose slot RANGES ("all day from 1 PM to 5 PM", "our hours are ...") that
      // used to be built here are GONE, deliberately — they are what the model reasoned
      // over instead of reading the list, and it is why it refused an available 4:30 and
      // offered a 4:00 that was not open. See the comment below. Nothing derives a range
      // any more; `spoken` is built FROM open_times.

      // DO NOT MAKE THE MODEL DO ARITHMETIC. GIVE IT A LIST.
      //
      // This route used to return ONE PROSE SENTENCE: "We have openings all day from
      // 1 PM to 5 PM." To answer "can I have 3 PM?" the model then had to work out
      // whether 3 PM falls inside that interval — and on 2026-07-14, handed exactly
      // that sentence, gpt-4o-mini told the caller:
      //
      //   "He has openings from 1 PM to 5 PM. Unfortunately, 3 PM is not in that
      //    time range. Would you like to choose a different time?"
      //
      // It called the tool. It got the right answer. It then misread it, refused a
      // slot that was wide open, and the caller settled for a time he did not want.
      //
      // The earlier version of this bug was the model NOT CALLING the tool. We fixed
      // that, and uncovered this one underneath: a tool result the model cannot
      // reliably READ is barely better than no tool at all. Interval reasoning over a
      // sentence is exactly the kind of thing a small model fumbles, and it fumbles it
      // SILENTLY — with the confidence of something that just looked it up.
      //
      // So the model no longer computes anything. `open_times` is the enumerated list
      // of every start time that can actually be booked (15-minute grid, service
      // duration fits before the window closes). Membership, not arithmetic: if the
      // caller's time is in the list it is available, and if it is absent it is not.
      // `spoken` stays for what to read aloud.
      const GRID_MINUTES = 15;
      // ALWAYS "H:MM AM/PM", never "1 PM". minutesToTime drops the :00 because it is
      // built for SPEECH, where "one PM" is what a person says. But open_times is not
      // speech — it is a lookup table the model matches the caller's time against, and
      // a list that mixes "1 PM" with "1:15 PM" is a list the model has to normalise
      // before it can search it. That is arithmetic again, by the back door. One shape.
      const gridTime = (mins: number): string => {
        const h24 = Math.floor(mins / 60);
        const m = mins % 60;
        const ampm = h24 >= 12 ? 'PM' : 'AM';
        const h = h24 % 12 === 0 ? 12 : h24 % 12;
        return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
      };
      const openTimes: string[] = [];
      // Parallel minutes array — pickOfferTimes steps through the OPEN list by
      // service duration, and minutes are what it steps in.
      const openMinutes: number[] = [];
      for (const win of futureSlots) {
        // Round the window start UP to the grid — the booking RPC rejects off-grid
        // times, so offering one would be offering a slot that cannot be booked.
        const first = Math.ceil(win.start / GRID_MINUTES) * GRID_MINUTES;
        for (let t = first; t + duration_minutes <= win.end; t += GRID_MINUTES) {
          openTimes.push(gridTime(t));
          openMinutes.push(t);
        }
      }

      // A window can survive the futureSlots duration filter and still yield ZERO
      // grid starts: rounding its start up to the quarter-hour can leave no t
      // with t + duration <= end (an odd-minute window from buffer arithmetic).
      // Review catch on #283: an empty openTimes fed the sentence builder
      // " or undefined". An empty grid IS "fully booked" — say that.
      if (openTimes.length === 0) {
        return ok(reply, {
          spoken: `${serviceInfo} Unfortunately, we're fully booked on ${dayName}. Would you like to try a different day?`,
          date: args.date,
          open_times: [],
          offer_times: [],
          note: 'Fully booked. open_times is empty — do NOT offer any time on this day.',
          ...explainRequested([]),
        });
      }

      // ONE SOURCE OF TRUTH. NEVER TWO.
      //
      // The first version of this fix returned BOTH the list AND the old prose
      // sentence — "we have openings all day from 1 PM to 5 PM" — with the sentence
      // first. The model read the sentence, reasoned about the RANGE exactly as it
      // always had, and ignored the list sitting underneath it: on 2026-07-14 it
      // refused 4:30 PM (which was in the list) and offered "1:00, 2:30, or 4:00"
      // (which were not).
      //
      // That is on me, not the model. I added a list to stop it doing interval
      // arithmetic and left the invitation to interval arithmetic directly above it.
      // Given a prose range and a table, a language model will read the prose. So the
      // range language is GONE. `spoken` is now BUILT FROM the list — the only times it
      // can utter are times that are actually bookable, because they are the only times
      // in the sentence.
      //
      // A few concrete times, not the whole list: reading fourteen options at a
      // caller is its own failure. WHICH few changed 2026-07-17 (Dale's spec,
      // from a live call): the old sample spread first/middle/last across the
      // day ("1:00, 2:45, or 4:30"), which callers heard as arbitrary jumps.
      // Offers are now the earliest open times stepped by the SERVICE
      // DURATION — consecutive meetings a caller can actually picture
      // ("1:00, 1:30, or 2:00") — computed here, not by the model (the same
      // no-arithmetic rule that created open_times). See pickOfferTimes.
      const offerTimes = pickOfferTimes(openMinutes, openTimes, duration_minutes);
      const spokenTimes =
        offerTimes.length === 1
          ? offerTimes[0]
          : `${offerTimes.slice(0, -1).join(', ')} or ${offerTimes[offerTimes.length - 1]}`;

      // When the caller named a time, LEAD with the verdict on THAT time —
      // the model reads top-down, and a caller who asked for 2:30 wants to
      // hear about 2:30 before they hear a menu (2026-07-27: they got the
      // menu, with an invented reason attached).
      const requestedBlock = explainRequested(openMinutes);
      const requestedSpoken =
        requestedMinutes !== null &&
        (requestedBlock.requested as { spoken_reason?: string } | undefined)?.spoken_reason;

      return ok(reply, {
        ...requestedBlock,
        // The LIST first, and the prose derived FROM it. Order matters: it is what the
        // model reads first, and there is no longer a range for it to reason about.
        open_times: openTimes,
        offer_times: offerTimes,
        date: args.date,
        note: 'open_times is the COMPLETE and ONLY list of bookable start times. A time in this list IS available — book it, do not second-guess it. A time NOT in this list is not available. Never state a time that is not in this list, and never refuse one that is. Do NOT reason about opening hours or ranges — they do not tell you what is free. When OFFERING times, offer exactly offer_times, speaking them as ONE natural sentence with commas ("I have 1:00, 1:30, or 2:00 — which works for you?") — never a bulleted or numbered list, and never more than these; a caller who names a different time from open_times gets a yes.',
        spoken: requestedSpoken
          ? // Their time first, with the true reason, THEN the alternatives.
            `${requestedSpoken} On ${dayName} I have ${spokenTimes}. Would any of those work?`
          : `${serviceInfo} On ${dayName} I have ${spokenTimes}. Would any of those work, or did you have another time in mind?`,
      });
    },
    'Failed to compute available slots'
  );

  // my-appointments — return upcoming scheduled appointments for the calling phone.
  // Phone is server-injected (never from LLM) to prevent cross-caller enumeration.
  toolRoute(
    app,
    '/agent-tools/my-appointments',
    MyAppointmentsSchema,
    async (args, reply) => {
      const normalized = normalizePhone(args.phone);
      if (!normalized) return fail(reply, 'Invalid phone number');

      const rows = await withTenantClient(args.tenant_id, async (client) => {
        return client.query<{
          appointment_id: string;
          start_time: string;
          end_time: string;
          description: string | null;
          status: string;
          service_name: string | null;
          employee_name: string | null;
        }>(
          `SELECT a.appointment_id, a.start_time, a.end_time, a.description, a.status,
                  s.name AS service_name,
                  e.name AS employee_name
           FROM appointments a
           JOIN customers c ON a.customer_id = c.customer_id
           LEFT JOIN services s ON a.service_id = s.service_id AND s.tenant_id = a.tenant_id
           LEFT JOIN employees e ON a.employee_id = e.employee_id AND e.tenant_id = a.tenant_id
           WHERE c.tenant_id = $1 AND c.phone = $2
             AND a.status = 'scheduled' AND a.start_time > NOW()
             AND (a.is_deleted IS NULL OR a.is_deleted = false)
             AND (c.is_deleted IS NULL OR c.is_deleted = false)
           ORDER BY a.start_time
           LIMIT 5`,
          [args.tenant_id, normalized]
        );
      });

      return ok(reply, { appointments: rows.rows });
    },
    'Failed to fetch appointments'
  );

  // cancel-appointment — soft-cancel a scheduled appointment owned by the caller.
  // Ownership verified by phone match so the LLM can never cancel another caller's
  // appointment even if it hallucinates a UUID.
  toolRoute(
    app,
    '/agent-tools/cancel-appointment',
    CancelAppointmentSchema,
    async (args, reply) => {
      const normalized = normalizePhone(args.phone);
      if (!normalized) return fail(reply, 'Invalid phone number');

      const result = await withTenantClient(args.tenant_id, async (client) => {
        return client.query<{ appointment_id: string }>(
          `UPDATE appointments a SET status = 'canceled'
           FROM customers c
           WHERE a.appointment_id = $1
             AND a.tenant_id = $2
             AND a.customer_id = c.customer_id
             AND c.phone = $3
             AND a.status = 'scheduled'
             AND a.start_time > NOW()
             AND (a.is_deleted IS NULL OR a.is_deleted = false)
           RETURNING a.appointment_id`,
          [args.appointment_id, args.tenant_id, normalized]
        );
      });

      if (result.rows.length === 0) {
        return fail(
          reply,
          "I couldn't find that appointment under your number, or it may already be past or canceled."
        );
      }

      // Fire-and-forget calendar sync so the slot opens up immediately.
      syncAppointmentToAll(pool, args.tenant_id, args.appointment_id, 'delete', app.log);

      return ok(reply, { cancelled: true, appointment_id: args.appointment_id });
    },
    'Failed to cancel appointment'
  );

  // reschedule-appointment — move a scheduled appointment to a new time.
  // Phone ownership verified server-side (LLM can't move another caller's appointment).
  // GiST exclusion constraints reject double-bookings at the DB layer (23P01).
  toolRoute(
    app,
    '/agent-tools/reschedule-appointment',
    RescheduleAppointmentSchema,
    async (args, reply) => {
      const normalized = normalizePhone(args.phone);
      if (!normalized) return fail(reply, 'Invalid phone number');

      const timeError = validateAppointmentTimeRange(args.new_start_time, args.new_end_time);
      if (timeError) return fail(reply, timeError.error);

      if (new Date(args.new_start_time) <= new Date()) {
        return fail(reply, 'New appointment time must be in the future.');
      }

      try {
        const result = await withTenantClient(args.tenant_id, async (client) => {
          return client.query<{ appointment_id: string }>(
            `UPDATE appointments a SET start_time = $4, end_time = $5
             FROM customers c
             WHERE a.appointment_id = $1
               AND a.tenant_id = $2
               AND a.customer_id = c.customer_id
               AND c.tenant_id = $2
               AND c.phone = $3
               AND a.status = 'scheduled'
               AND a.start_time > NOW()
               AND (a.is_deleted IS NULL OR a.is_deleted = false)
             RETURNING a.appointment_id`,
            [
              args.appointment_id,
              args.tenant_id,
              normalized,
              args.new_start_time,
              args.new_end_time,
            ]
          );
        });

        if (result.rows.length === 0) {
          return fail(
            reply,
            "I couldn't find that appointment under your number, or it may already be past or canceled."
          );
        }
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23P01') {
          return fail(reply, 'That time slot is already booked. Please choose a different time.');
        }
        throw err;
      }

      // Fire-and-forget: update calendar sync + reschedule reminders.
      syncAppointmentToAll(pool, args.tenant_id, args.appointment_id, 'update', app.log);
      void rescheduleRemindersForAppointment(
        withTenantClient,
        args.tenant_id,
        args.appointment_id,
        app.log
      );

      return ok(reply, { rescheduled: true, appointment_id: args.appointment_id });
    },
    'Failed to reschedule appointment'
  );

  // attach-meeting-notes — append the caller's own context to the meeting just booked.
  // The meeting-goals rung asks one light wrap-up question ("anything you'd like the
  // owner to know before the meeting?"); the answer lands here, on the appointment's
  // description, so the calendar entry says what the meeting is ABOUT. appointment_id
  // is injected by the agent runtime from the call-outcome tracker — the model passes
  // only the notes — so a lookup miss is a bug surfaced honestly, never silent success.
  toolRoute(
    app,
    '/agent-tools/attach-meeting-notes',
    AttachMeetingNotesSchema,
    async (args, reply) => {
      const updated = await withTenantClient(args.tenant_id, async (client) => {
        const res = await client.query<{ appointment_id: string }>(
          `UPDATE appointments
              SET description = COALESCE(NULLIF(description, '') || E'\n\n', '') || $3,
                  updated_at = now()
            WHERE tenant_id = $1 AND appointment_id = $2 AND is_deleted = false
            RETURNING appointment_id`,
          [args.tenant_id, args.appointment_id, `${CALLER_NOTES_PREFIX}${toStampText(args.notes)}`]
        );
        return res.rows[0]?.appointment_id ?? null;
      });

      if (!updated) {
        return fail(
          reply,
          "I couldn't find that meeting to attach the note to — nothing was saved. Offer to pass it along as a message for the owner instead."
        );
      }

      return ok(reply, {
        appointment_id: updated,
        message: "Noted — I've added that to the meeting.",
      });
    },
    'Failed to attach meeting notes'
  );
}
