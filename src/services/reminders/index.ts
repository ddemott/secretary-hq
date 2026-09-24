/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
/**
 * no-unsafe-* rules disabled: this file contains dynamic DB query builders
 * and reminder scheduling logic that works with loosely typed data from
 * the database layer and external scheduling concerns.
 *
 * Part of the ESLint debt reduction effort (historical REFACTORING_TODO.md item 10; see RESOLVED.md).
 */

import type { DatabaseService } from '../../database/index.js';
import { CommunicationService } from '../communications/index.js';
import { ConsentService } from '../consentService.js';
import { remindersSentTotal, remindersSkippedTotal } from '../metrics.js';
import { smsDeliveryDisabled } from '../communications/smsService.js';
import type { TenantConfigService } from '../tenants/index.js';

import type { ReminderSchedule } from './types.js';

export type { ReminderSchedule } from './types.js';

/**
 * A send that failed without telling us why.
 *
 * `sendReminder` collapses the provider's answer to a boolean, so when it says
 * `false` we have no HTTP status to classify. retryPolicy's `isRetryable`
 * treats a status-less error as RETRYABLE on purpose ("better to over-retry
 * than lose"), which is the behavior we want: a transient Telnyx blip gets the
 * 5m/30m/2h backoff instead of silently killing the customer's reminder.
 *
 * This exists to be THROWN. The whole point of the 2026-07-13 fix is that
 * processReminder must not decide a reminder's fate itself — the worker owns
 * retry-vs-fail, and it can only do that if the failure actually reaches it.
 */
export class ReminderSendError extends Error {
  constructor(
    message: string,
    public readonly reminderId: string
  ) {
    super(message);
    this.name = 'ReminderSendError';
  }
}

/**
 * Did the reminder actually reach the customer on ANY channel?
 *
 * CommunicationService returns `{ email?: {success}, sms?: {success} }` — a key
 * is present only for a channel it attempted. This used to read
 * `result?.email?.success === true`, which meant an SMS-only customer (no email
 * on file, or email not consented) sent their text successfully and was still
 * reported as a failure. processReminder then marked the row 'failed', and
 * retryPolicy re-sent it at 5m/30m/2h — so the customer got the SAME reminder
 * up to four times. Any SMS-only reminder flow is a text-spam flow until this
 * reads both channels. (2026-07-12)
 */
function anyChannelSucceeded(result?: {
  email?: { success?: boolean };
  sms?: { success?: boolean };
}): boolean {
  return result?.email?.success === true || result?.sms?.success === true;
}

/**
 * Is this appointment cancelled?
 *
 * Exported so the check has ONE home. `appointments.status` carries the
 * American `'canceled'`; `reminder_schedules.status` carries the British
 * `'cancelled'`. Both spellings are accepted here because the appointments
 * column has no CHECK constraint, so nothing prevents either from existing,
 * and the safe direction is to skip a reminder we were unsure about rather
 * than send one for an appointment that is off.
 */
export function isCancelledAppointmentStatus(status: unknown): boolean {
  if (typeof status !== 'string') return false;
  const s = status.trim().toLowerCase();
  return s === 'canceled' || s === 'cancelled';
}

/** Legacy lead, recoverable from the type name. Only used when lead_minutes is absent. */
const LEAD_BY_TYPE: Record<string, number> = { '72h': 4320, '24h': 1440, '2h': 120 };

/**
 * How far before the appointment does this reminder fire?
 *
 * `lead_minutes` (migration 20260712010000) is the source of truth. The
 * type-name fallback exists only for rows written before that column and for
 * hand-built test fixtures. A 'custom' reminder has no name to parse — its lead
 * lives only in the column — so a missing lead_minutes there means the row is
 * unsendable rather than silently mis-timed.
 */
function resolveLeadMinutes(reminder: {
  reminderType?: string;
  leadMinutes?: number | null;
  lead_minutes?: number | null;
}): number | null {
  const stored = reminder.leadMinutes ?? reminder.lead_minutes;
  if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) return stored;
  return LEAD_BY_TYPE[reminder.reminderType ?? ''] ?? null;
}

export class ReminderService {
  // Use injected mocks directly for all testable methods
  public db: DatabaseService;
  public configService: TenantConfigService;
  public consentService: ConsentService;
  public communicationService: CommunicationService;
  public scheduledReminders: Map<string, NodeJS.Timeout> = new Map();

  constructor(db: DatabaseService, configService: TenantConfigService) {
    this.db = db;
    this.configService = configService;
    this.consentService = new ConsentService(db);
    this.communicationService = new CommunicationService(configService, this.consentService);
  }

  /**
   * Schedule reminders for a new appointment.
   *
   * Back-compat shim: accepts either camelCase (AppointmentForReminder) or
   * snake_case (legacy DB-row) shapes — the `any` is a permissive boundary
   * for older tests that predate the typed signature in reminderScheduler.ts.
   * Real (production) callers use ReminderScheduler.scheduleAppointmentReminders;
   * remove this method once those tests migrate.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- back-compat shim, see jsdoc
  async scheduleAppointmentReminders(appointment: any): Promise<void> {
    // Normalize appointment fields to camelCase. IDs are UUID strings
    // (matches the appointments.appointment_id + tenants.tenant_id schema),
    // so no integer coercion happens here — passing them through to the
    // DB layer as-is. Accepts both camelCase (appointmentId) and snake_case
    // (appointment_id) shapes since callers vary.
    const normalizedAppointment = {
      ...appointment,
      appointmentId: appointment.appointmentId || appointment.appointment_id,
      tenantId: appointment.tenantId || appointment.tenant_id,
      serviceId: appointment.serviceId || appointment.service_id,
      staffId: appointment.staffId || appointment.staff_id,
      customerEmail: appointment.customerEmail || appointment.customer_email,
      customerPhone: appointment.customerPhone || appointment.customer_phone,
      customerName: appointment.customerName || appointment.customer_name,
      serviceName: appointment.serviceName || appointment.service_name,
      staffName: appointment.staffName || appointment.staff_name,
      dateTime: appointment.dateTime || appointment.date_time,
      duration: appointment.duration,
      status: appointment.status,
      createdAt: appointment.createdAt || appointment.created_at,
      updatedAt: appointment.updatedAt || appointment.updated_at,
    };

    // Validate that we have a valid dateTime
    if (!normalizedAppointment.dateTime) {
      console.error(
        '❌ Cannot schedule reminders: appointment dateTime is missing or invalid',
        normalizedAppointment
      );
      return;
    }

    const appointmentDateTime = new Date(normalizedAppointment.dateTime);
    if (isNaN(appointmentDateTime.getTime())) {
      console.error(
        '❌ Cannot schedule reminders: appointment dateTime is invalid',
        normalizedAppointment.dateTime
      );
      return;
    }

    const now = new Date();
    // Only schedule reminders for future appointments
    if (appointmentDateTime <= now) {
      // Do not schedule any reminders for past appointments
      return;
    }

    // Always schedule all 4 reminders for future appointments
    const reminders = [
      { type: 'confirmation', hoursBefore: 0 },
      { type: '72h', hoursBefore: 72 },
      { type: '24h', hoursBefore: 24 },
      { type: '2h', hoursBefore: 2 },
    ];
    for (const reminder of reminders) {
      let scheduledFor;
      if (reminder.type === 'confirmation') {
        scheduledFor = now;
      } else {
        scheduledFor = new Date(
          appointmentDateTime.getTime() - reminder.hoursBefore * 60 * 60 * 1000
        );
      }

      // Validate that scheduledFor is a valid date
      if (isNaN(scheduledFor.getTime())) {
        console.error(`❌ Cannot schedule ${reminder.type} reminder: invalid scheduled time`, {
          appointmentDateTime: appointmentDateTime.toISOString(),
          hoursBefore: reminder.hoursBefore,
          calculatedTime: scheduledFor,
        });
        continue; // Skip this reminder
      }

      await this.db.createReminderSchedule({
        appointment_id: normalizedAppointment.appointmentId,
        tenant_id: normalizedAppointment.tenantId,
        customer_email: normalizedAppointment.customerEmail,
        customer_phone: normalizedAppointment.customerPhone,
        reminder_type: reminder.type as 'confirmation' | '72h' | '24h' | '2h',
        scheduled_for: scheduledFor.toISOString(),
        status: 'scheduled',
      });
    }
    return;
  }

  /**
   * Process a scheduled reminder
   */
  async processReminder(reminderId: string): Promise<void> {
    try {
      const reminder = await this.db.getReminderSchedule(reminderId);
      if (!reminder) {
        await this.db.updateReminderSchedule(reminderId, {
          status: 'failed',
          error: 'Reminder not found',
        });
        return;
      }

      // 'sending' is the CLAIMED state, and it is the state every reminder the
      // worker asks us to process is actually in — processBatch() flips the row
      // to 'sending' in the same statement that selects it, precisely so a
      // second worker (or the next tick after a slow one) cannot pick it up.
      //
      // This gate read `!== 'scheduled'` and would therefore have silently
      // no-op'd EVERY claimed reminder the moment the claim itself started
      // working: read the row, see 'sending', return, and leave it stranded in
      // 'sending' where the claim query — which only ever selects 'scheduled' —
      // can never see it again. A reminder lost with no error, no metric, and a
      // worker reporting it as processed. The claim never got that far because
      // the CHECK constraint rejected 'sending' outright (migration
      // 20260819000000), so this was a second bug hiding behind the first.
      //
      // Anything else — sent, failed, cancelled — is genuinely terminal and
      // still returns.
      if (reminder.status !== 'scheduled' && reminder.status !== 'sending') {
        return;
      }

      // Normalize reminder fields to camelCase
      const normalizedReminder = {
        ...reminder,
        reminderType: reminder.reminder_type,
        tenantId: reminder.tenant_id,
        appointmentId: reminder.appointment_id,
        customerEmail: reminder.customer_email,
        customerPhone: reminder.customer_phone,
        scheduledFor: reminder.scheduled_for,
        // The lead the caller chose. Without this, a 'custom' reminder reaches
        // sendReminder with no way to know how far ahead it is.
        leadMinutes: reminder.lead_minutes,
      };

      // Tenant id comes from the reminder row itself. Without it the read runs
      // with no RLS context and `appointments` — FORCE RLS, no admin-bypass
      // policy — returns nothing, so a live appointment reads as "not found"
      // and the reminder is marked 'failed'. Observed on prod 2026-08-20.
      const appointment = await this.db.getAppointmentById(
        normalizedReminder.appointmentId,
        normalizedReminder.tenantId
      );
      if (!appointment) {
        // Counted, at last. `reminders_skipped_total` has ALWAYS documented an
        // `appointment_not_found` reason — in metrics.ts, in docs/ALERTS.md, and
        // in the tests of the parallel implementation deleted alongside this
        // change — and the LIVE path never incremented it. On 2026-08-20 this
        // exact branch fired 8 times in one minute in production (the appointment
        // read was running without RLS tenant context, so live appointments read
        // as missing) and the only trace was 8 rows quietly marked 'failed'.
        remindersSkippedTotal.inc({ reason: 'appointment_not_found' });
        await this.updateReminderStatus(reminderId, 'failed', 'Appointment not found');
        return;
      }

      // Check if reminder is still relevant (appointment not cancelled and time hasn't passed)
      const appointmentDateTime = new Date(appointment.dateTime);
      const now = new Date();

      // TWO TABLES, TWO SPELLINGS, AND THIS LINE HAD THE WRONG ONE.
      //
      // `appointments.status` is written `'canceled'` (one L) by EVERY cancel
      // path in the product — `appointments.ts` /cancel, `selfService.ts`'s SMS
      // link, and the voice agent's `agentTools/scheduling.ts`. Verified against
      // production 2026-08-19: the only non-scheduled/completed value present is
      // `'canceled'`.
      //
      // `reminder_schedules.status`, set two lines below, genuinely IS
      // `'cancelled'` (two Ls) — that spelling is in its CHECK constraint. So
      // the two columns really do differ, which is exactly how a comparison
      // against a value nothing writes survived review.
      //
      // Consequence, which is not cosmetic: this guard has NEVER fired in
      // production. A cancelled appointment still in the FUTURE falls past it,
      // fails the `appointmentDateTime <= now` check too, and proceeds to the
      // send path — reminding a customer about an appointment they cancelled.
      // It stayed invisible because the whole reminder pipeline was dead from
      // 2026-08-06 (migration 20260819000000) and SMS is off platform-wide.
      // Found while re-enabling that pipeline.
      //
      // Accepting both spellings rather than picking one: the DB has no CHECK
      // constraint on `appointments.status`, so a historical row could carry
      // either, and a reminder wrongly sent is worse than one wrongly skipped.
      if (isCancelledAppointmentStatus(appointment.status)) {
        remindersSkippedTotal.inc({ reason: 'appointment_cancelled' });
        await this.updateReminderStatus(reminderId, 'cancelled', 'Appointment cancelled');
        return;
      }

      if (appointmentDateTime <= now) {
        remindersSkippedTotal.inc({ reason: 'appointment_passed' });
        await this.updateReminderStatus(
          reminderId,
          'cancelled',
          'Appointment cancelled or time passed'
        );
        return;
      }

      // Check communication consent
      const hasConsent = await this.checkCommunicationConsent(normalizedReminder, appointment);
      if (!hasConsent) {
        // THE SILENT ONE. This branch cancelled the reminder with no log and no
        // metric, and it is the likeliest branch to fire: consent_records rows
        // are written ONLY by the agent's record_sms_consent tool, so if the LLM
        // ever skips the permission question, EVERY confirmation and reminder is
        // dropped here, invisibly, forever. The caller was told on a live call
        // "I'll text you" and nothing was ever sent — and no dashboard, log or
        // metric would show it. Suppression is legally correct; silence is not.
        remindersSkippedTotal.inc({ reason: 'no_consent' });
        console.warn(
          JSON.stringify({
            event: 'reminder_skipped_no_consent',
            reason:
              'no consent_records row for this customer/channel — the reminder was cancelled, not sent',
            next: 'agent must call record_sms_consent after asking permission with the SMS disclosures',
            reminder_schedule_id: reminderId,
            reminder_type: normalizedReminder.reminderType,
            tenant_id: normalizedReminder.tenantId,
            appointment_id: normalizedReminder.appointmentId,
          })
        );
        await this.updateReminderStatus(reminderId, 'cancelled', 'No consent for communication');
        return;
      }

      // SMS kill switch. A customer reachable ONLY by text cannot be reminded
      // while ENABLE_SMS is off: SMSService refuses the send, and without this
      // branch that refusal read as a FAILURE — the worker would retry it
      // 5m/30m/2h and finally mark it 'failed', dressing a deliberate
      // platform-wide off switch up as a delivery fault. Skip it, and say why.
      const reachEmail = appointment.customerEmail || appointment.customer_email;
      const reachPhone = appointment.customerPhone || appointment.customer_phone;
      if (!reachEmail && reachPhone && smsDeliveryDisabled()) {
        remindersSkippedTotal.inc({ reason: 'sms_disabled' });
        console.warn(
          JSON.stringify({
            event: 'reminder_skipped_sms_disabled',
            reason:
              'customer is reachable only by SMS and ENABLE_SMS is off (10DLC not registered)',
            reminder_schedule_id: reminderId,
            reminder_type: normalizedReminder.reminderType,
            tenant_id: normalizedReminder.tenantId,
            appointment_id: normalizedReminder.appointmentId,
          })
        );
        await this.updateReminderStatus(reminderId, 'cancelled', 'SMS disabled (ENABLE_SMS off)');
        return;
      }

      // Send the reminder
      const sent = await this.sendReminder(normalizedReminder, appointment);
      if (sent) {
        remindersSentTotal.inc({ type: normalizedReminder.reminderType, outcome: 'success' });
        await this.updateReminderStatus(reminderId, 'sent');
        return;
      }

      // A send that returned false is a FAILURE, and the caller — the worker —
      // owns what happens next. See the catch below for why we must not decide
      // that here.
      remindersSentTotal.inc({ type: normalizedReminder.reminderType, outcome: 'failure' });
      throw new ReminderSendError('Communication failed', reminderId);
    } catch (error) {
      // THE UNREACHABLE-RETRY BUG. This catch used to mark the row 'failed' and
      // return normally — so the worker's catch block, which owns decideRetry(),
      // retry_count, next_retry_at and the 5m/30m/2h backoff, could NEVER
      // execute. One transient Telnyx 5xx permanently killed a reminder and the
      // customer simply never heard from us. retryPolicy.ts and its migration
      // were decoration; prod confirms it — max(retry_count) is NULL, no row has
      // ever retried.
      //
      // So: rethrow. The worker classifies (transient → back off and retry;
      // terminal → 'failed'). A method that swallows the error its caller is
      // built to handle is not being defensive, it is lying about what happened.
      if (!(error instanceof ReminderSendError)) {
        remindersSentTotal.inc({ type: 'unknown', outcome: 'failure' });
      }
      throw error;
    }
  }

  /**
   * Manually trigger a reminder
   */
  async triggerReminder(reminderId: string): Promise<boolean> {
    const reminder = await this.db.getReminderSchedule(reminderId);
    if (!reminder) {
      return false;
    }
    // Unlike processReminder above, this one MUST keep refusing 'sending'. This
    // is the human "send it now" path, and a row in 'sending' is one a worker is
    // holding right this second — triggering it here is precisely the double-text
    // the atomic claim exists to prevent. Do not "fix" this to match the gate in
    // processReminder; they guard opposite directions on purpose.
    if (reminder.status !== 'scheduled') {
      return false;
    }
    try {
      await this.processReminder(reminderId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cancel all reminders for an appointment
   */
  async cancelAppointmentReminders(appointmentId: string, tenantId: string): Promise<void> {
    const reminders = await this.db.getReminderSchedulesByAppointment(appointmentId, tenantId);
    if (reminders && reminders.length) {
      for (const reminder of reminders) {
        await this.db.updateReminderSchedule(reminder.reminder_schedule_id.toString(), {
          status: 'cancelled',
        });
      }
    }
    return;
  }

  /**
   * Reschedule reminders for an appointment
   */
  async rescheduleAppointmentReminders(
    appointmentId: string,
    tenantId: string,
    newDateTime: string
  ): Promise<void> {
    await this.cancelAppointmentReminders(appointmentId, tenantId);

    // Get the appointment using db mock
    const appointment = await this.db.getAppointmentById(appointmentId, tenantId);
    if (!appointment) {
      return;
    }

    // Update appointment dateTime
    appointment.dateTime = newDateTime;

    // Schedule new reminders using db mock
    await this.scheduleAppointmentReminders(appointment);
  }

  /**
   * Get all scheduled reminders for a tenant
   */
  async getScheduledReminders(tenantId: string): Promise<ReminderSchedule[]> {
    return this.db.getReminderSchedulesByTenant(tenantId, 'scheduled');
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    // Clear timeouts from the service's map (for backward compatibility)
    for (const timeout of this.scheduledReminders.values()) {
      clearTimeout(timeout);
    }
    this.scheduledReminders.clear();
  }

  // Backward compatibility methods for tests

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- back-compat shim, mirrors scheduleAppointmentReminders
  async checkCommunicationConsent(reminder: any, appointment: any): Promise<boolean> {
    // Normalize appointment fields to handle both camelCase and snake_case
    const normalizedAppointment = {
      ...appointment,
      tenantId: appointment.tenantId || appointment.tenant_id,
      customerEmail: appointment.customerEmail || appointment.customer_email,
      customerPhone: appointment.customerPhone || appointment.customer_phone,
    };

    // Only call consentService.checkConsent once per type, matching test expectations
    if (normalizedAppointment.customerEmail && normalizedAppointment.customerPhone) {
      const emailConsent = await this.consentService.checkConsent(
        normalizedAppointment.tenantId,
        normalizedAppointment.customerEmail,
        undefined,
        'email'
      );
      const smsConsent = await this.consentService.checkConsent(
        normalizedAppointment.tenantId,
        undefined,
        normalizedAppointment.customerPhone,
        'sms'
      );
      // OR, not AND. This gate answers "can we reach them on ANY channel?" — it
      // is not the per-channel authority. EmailService and SMSService each
      // re-check consent at the wire (emailService.ts:78, smsService.ts:88) and
      // refuse their own send, so a customer who consented to SMS but not email
      // gets the text and no email. The old AND meant a caller who verbally said
      // "yes, text me" got NOTHING the moment they had an email address on file
      // — the email channel they never opted into vetoed the SMS they did.
      return emailConsent || smsConsent;
    } else if (normalizedAppointment.customerEmail) {
      return await this.consentService.checkConsent(
        normalizedAppointment.tenantId,
        normalizedAppointment.customerEmail,
        undefined,
        'email'
      );
    } else if (normalizedAppointment.customerPhone) {
      return await this.consentService.checkConsent(
        normalizedAppointment.tenantId,
        undefined,
        normalizedAppointment.customerPhone,
        'sms'
      );
    }
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- back-compat shim, mirrors scheduleAppointmentReminders
  async sendReminder(reminder: any, appointment: any): Promise<boolean> {
    // Normalize appointment fields to handle both camelCase and snake_case
    const normalizedAppointment = {
      ...appointment,
      tenantId: appointment.tenantId || appointment.tenant_id,
      customerEmail: appointment.customerEmail || appointment.customer_email,
      customerPhone: appointment.customerPhone || appointment.customer_phone,
      customerName: appointment.customerName || appointment.customer_name,
      serviceName: appointment.serviceName || appointment.service_name,
      staffName: appointment.staffName || appointment.staff_name,
      dateTime: appointment.dateTime || appointment.date_time,
      duration: appointment.duration,
      notes: appointment.notes,
    };

    // Check communication consent first
    const hasConsent = await this.checkCommunicationConsent(reminder, normalizedAppointment);
    if (!hasConsent) {
      return false;
    }

    // Confirmation reminder
    if (reminder.reminderType === 'confirmation') {
      const result = await this.communicationService.sendAppointmentConfirmation(
        normalizedAppointment.tenantId.toString(),
        normalizedAppointment.customerEmail,
        normalizedAppointment.customerPhone,
        {
          customerName: normalizedAppointment.customerName,
          serviceName: normalizedAppointment.serviceName,
          staffName: normalizedAppointment.staffName,
          dateTime: normalizedAppointment.dateTime,
          duration: normalizedAppointment.duration,
          notes: normalizedAppointment.notes,
          appointmentId: reminder.appointment_id?.toString() || reminder.appointmentId?.toString(),
        }
      );
      return anyChannelSucceeded(result);
    }

    // Advance reminders: the legacy fixed types plus 'custom', the caller-chosen
    // lead the voice agent offers at booking ("text me 30 minutes before").
    if (['72h', '24h', '2h', 'custom'].includes(reminder.reminderType)) {
      // lead_minutes is the source of truth (migration 20260712010000). The
      // type-name fallback is only for rows written before that column existed
      // (and for unit tests that construct a reminder by hand) — 'custom' has no
      // fallback by definition, which is exactly why the column had to exist.
      const leadMinutes = resolveLeadMinutes(reminder);
      if (leadMinutes === null) return false;
      const hours = leadMinutes / 60;
      const result = await this.communicationService.sendAppointmentReminder(
        normalizedAppointment.tenantId.toString(),
        normalizedAppointment.customerEmail,
        normalizedAppointment.customerPhone,
        {
          customerName: normalizedAppointment.customerName,
          serviceName: normalizedAppointment.serviceName,
          staffName: normalizedAppointment.staffName,
          dateTime: normalizedAppointment.dateTime,
          duration: normalizedAppointment.duration,
          appointmentId: reminder.appointment_id?.toString() || reminder.appointmentId?.toString(),
        },
        hours
      );
      return anyChannelSucceeded(result);
    }

    // Unknown reminder type
    return false;
  }

  async updateReminderStatus(
    reminderId: string,
    status: ReminderSchedule['status'],
    error?: string
  ): Promise<void> {
    // For test compatibility, update status using db mock
    await this.db.updateReminderSchedule(reminderId, { status, error });
  }
}
