/**
 * Metrics emitted by the LIVE reminder path (`ReminderService.processReminder`).
 *
 * WHY THIS FILE REPLACES `reminderProcessor-metrics.test.ts`. That suite tested
 * `ReminderProcessor`, a parallel reminder implementation with zero production
 * callers, deleted alongside this change. It was not merely redundant — it was
 * actively misleading in two ways, and both survived because it was green:
 *
 *   1. It asserted `reminders_sent_total{channel: 'email' | 'sms'}`. The live
 *      service emits `{type, outcome}` where `type` is the REMINDER type
 *      (confirmation / 72h / 24h / 2h / custom). Nothing in production has ever
 *      emitted a `channel` label, so every dashboard or alert filtering on one
 *      matched nothing. `docs/ALERTS.md` documented the dead shape too.
 *
 *   2. It asserted `reminders_skipped_total{reason: 'appointment_not_found'}`
 *      and `{reason: 'processing_error'}`. The live path emitted neither.
 *      `appointment_not_found` is now emitted (it fired 8 times in one minute in
 *      production on 2026-08-20 with no counter behind it); `processing_error`
 *      is genuinely not a live reason, because a processing failure is rethrown
 *      so the worker can classify retry-vs-fail and lands in `errors_total`.
 *
 * So the counters that were supposed to be watching production had test
 * coverage only on code production never ran. This suite covers the emitter
 * that actually runs.
 *
 * 5W for sad-path failures:
 *   WHO   — whoever is on call, reading /metrics or an ALERTS.md rule
 *   WHAT  — reminders_sent_total / reminders_skipped_total
 *   WHEN  — every reminder the live worker processes
 *   WHERE — ReminderService.processReminder
 *   WHY   — a counter with the wrong labels is worse than no counter: the query
 *           returns zero and reads as "nothing wrong" instead of "not measured"
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReminderService } from '../../../src/services/reminders/index.js';
import {
  registry,
  remindersSentTotal,
  remindersSkippedTotal,
} from '../../../src/services/metrics.js';
import { providerRegistry } from '../../../src/services/communications/ProviderRegistry.js';

// Valid v4 UUIDs — hex only. `t1111111-…` was not one, and would turn this
// suite into a false negative the day ReminderService adds uuid validation.
const TENANT = 'd1111111-1111-4111-8111-111111111111';
const APPT = 'a1111111-1111-4111-8111-111111111111';

function readCounter(name: string, labels: Record<string, string>): number {
  const snap = (
    name === 'reminders_sent_total' ? remindersSentTotal : remindersSkippedTotal
  ).snapshot();
  const key = (l: Record<string, string>) =>
    Object.entries(l)
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join('|');
  return snap.find((s) => key(s.labels as Record<string, string>) === key(labels))?.value ?? 0;
}

function buildService(opts: {
  appointment: Record<string, unknown> | null;
  consent?: boolean;
  sent?: boolean;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    getReminderSchedule: async () => ({
      reminder_schedule_id: 1,
      appointment_id: APPT,
      tenant_id: TENANT,
      customer_phone: '+15551234567',
      reminder_type: '24h',
      scheduled_for: new Date().toISOString(),
      lead_minutes: 1440,
      status: 'scheduled',
    }),
    getAppointmentById: async () => opts.appointment,
    updateReminderSchedule: async (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch);
    },
  };
  const service = new ReminderService(db as never, { getTenantConfig: async () => ({}) } as never);
  service.checkCommunicationConsent = async () => opts.consent ?? true;
  service.sendReminder = async () => opts.sent ?? true;
  return { service, updates };
}

const futureAppointment = (status = 'scheduled') => ({
  appointment_id: APPT,
  tenant_id: TENANT,
  dateTime: new Date(Date.now() + 86_400_000).toISOString(),
  status,
  customer_phone: '+15551234567',
  customerName: 'Customer',
  serviceName: 'Oil change',
  duration: 30,
});

beforeEach(() => {
  registry.clearAll();
  vi.restoreAllMocks();
});

describe('ReminderService metrics — the labels production actually emits', () => {
  it('HAPPY: a successful send increments reminders_sent_total{type,outcome=success}', async () => {
    const { service } = buildService({ appointment: futureAppointment() });
    await service.processReminder('1');

    expect(readCounter('reminders_sent_total', { type: '24h', outcome: 'success' })).toBe(1);
    // And NOT the dead shape. If this ever becomes 1, someone has reintroduced
    // a `channel` label and every ALERTS.md query needs revisiting.
    expect(readCounter('reminders_sent_total', { channel: 'email', outcome: 'success' })).toBe(0);
  });

  it('SAD: a failed send increments outcome=failure and rethrows for the worker to classify', async () => {
    // The throw is the point: the worker owns retry-vs-fail. A swallowed failure
    // was the original unreachable-retry bug.
    const { service } = buildService({ appointment: futureAppointment(), sent: false });
    await expect(service.processReminder('1')).rejects.toThrow();

    expect(readCounter('reminders_sent_total', { type: '24h', outcome: 'failure' })).toBe(1);
  });

  it('SAD: a missing appointment increments reminders_skipped_total{reason=appointment_not_found}', async () => {
    // THE ONE TONIGHT. This branch fired 8 times in a minute in production on
    // 2026-08-20 — the appointment read was running with no RLS tenant context,
    // so live appointments read as missing — and the only trace was 8 rows
    // quietly marked 'failed'. The reason had been documented in metrics.ts and
    // ALERTS.md all along; nothing incremented it.
    const { service } = buildService({ appointment: null });
    await service.processReminder('1');

    expect(readCounter('reminders_skipped_total', { reason: 'appointment_not_found' })).toBe(1);
  });

  it('SAD: a cancelled appointment increments reason=appointment_cancelled, for the spelling prod writes', async () => {
    // 'canceled', one L — what every cancel path in the product stores.
    const { service } = buildService({ appointment: futureAppointment('canceled') });
    await service.processReminder('1');

    expect(readCounter('reminders_skipped_total', { reason: 'appointment_cancelled' })).toBe(1);
    expect(readCounter('reminders_sent_total', { type: '24h', outcome: 'success' })).toBe(0);
  });

  it('SAD: a past appointment increments reason=appointment_passed', async () => {
    // Emitted by the live path but absent from the metric description until
    // 2026-08-20 — the mirror image of appointment_not_found.
    const past = {
      ...futureAppointment(),
      dateTime: new Date(Date.now() - 3_600_000).toISOString(),
    };
    const { service } = buildService({ appointment: past });
    await service.processReminder('1');

    expect(readCounter('reminders_skipped_total', { reason: 'appointment_passed' })).toBe(1);
  });

  it('SAD: missing consent increments reason=no_consent — suppression is legal, silence is not', async () => {
    const { service } = buildService({ appointment: futureAppointment(), consent: false });
    await service.processReminder('1');

    expect(readCounter('reminders_skipped_total', { reason: 'no_consent' })).toBe(1);
    expect(readCounter('reminders_sent_total', { type: '24h', outcome: 'success' })).toBe(0);
  });

  describe('SMS kill switch (ENABLE_SMS off, real carrier)', () => {
    // WHO: an SMS-only customer (phone on file, no email) with a reminder due
    // WHAT: reminders_skipped_total{reason=sms_disabled}, row cancelled with that reason, nothing sent
    // WHEN: ENABLE_SMS is not 'true' and the default provider is a real carrier
    // WHERE: ReminderService.processReminder
    // WHY: the send would be refused anyway; treating the refusal as a failure made
    //      the worker retry it and finally mark it 'failed', hiding a deliberate off switch
    const OLD = process.env.ENABLE_SMS;
    const realCarrier = () =>
      vi
        .spyOn(providerRegistry, 'getDefaultProvider')
        .mockReturnValue({ getName: () => 'telnyx' } as never);
    const restoreEnv = () => {
      if (OLD === undefined) delete process.env.ENABLE_SMS;
      else process.env.ENABLE_SMS = OLD;
    };

    it('SAD: an SMS-only reminder is skipped with reason=sms_disabled and never sent', async () => {
      realCarrier();
      delete process.env.ENABLE_SMS;
      try {
        const { service, updates } = buildService({ appointment: futureAppointment() });
        const send = vi.spyOn(service, 'sendReminder');
        await service.processReminder('1');

        expect(readCounter('reminders_skipped_total', { reason: 'sms_disabled' })).toBe(1);
        expect(send).not.toHaveBeenCalled();
        expect(updates.at(-1)).toMatchObject({ status: 'cancelled' });
      } finally {
        restoreEnv();
      }
    });

    it('HAPPY: with ENABLE_SMS=true the same reminder is sent', async () => {
      realCarrier();
      process.env.ENABLE_SMS = 'true';
      try {
        const { service } = buildService({ appointment: futureAppointment() });
        await service.processReminder('1');

        expect(readCounter('reminders_skipped_total', { reason: 'sms_disabled' })).toBe(0);
        expect(readCounter('reminders_sent_total', { type: '24h', outcome: 'success' })).toBe(1);
      } finally {
        restoreEnv();
      }
    });

    it('HAPPY: a customer with an email is not skipped — the email channel still works', async () => {
      realCarrier();
      delete process.env.ENABLE_SMS;
      try {
        const { service } = buildService({
          appointment: { ...futureAppointment(), customer_email: 'jane@example.com' },
        });
        await service.processReminder('1');

        expect(readCounter('reminders_skipped_total', { reason: 'sms_disabled' })).toBe(0);
        expect(readCounter('reminders_sent_total', { type: '24h', outcome: 'success' })).toBe(1);
      } finally {
        restoreEnv();
      }
    });
  });
});
