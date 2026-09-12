/**
 * WHO:   the reminder scheduler worker's per-reminder catch blocks
 * WHAT:  a single reminder's send failure, and a failure to even write that
 *        failure back to the row, must both be counted — not just logged
 * WHEN:  every tick, inside processBatch()
 * WHERE: src/workers/reminderScheduler.ts processBatch()
 * WHY:   only the OUTER batch-wide catch bumped errors_total
 *        (reminder_batch_failed); a single reminder failing inside an
 *        otherwise-successful batch was invisible except for a console.error
 *        line — same sad-path-instrumentation gap as billing (#422),
 *        record-consent (#423) and calendar OAuth (#425)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB pool + service factory before importing the worker — it grabs
// getPool()/createDatabaseService() at call time via a lazy module-level
// singleton, so the module must be mocked ahead of import (same pattern as
// tests/workers/voiceSessionReaper.test.ts).
const mockPoolQuery = vi.fn();
const mockUpdateReminderSchedule = vi.fn();
vi.mock('../../src/database/index.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
  createDatabaseService: () => ({
    updateReminderSchedule: mockUpdateReminderSchedule,
  }),
}));

vi.mock('../../src/services/tenants/index.js', () => ({
  createTenantConfigService: () => ({}),
}));

const mockProcessReminder = vi.fn();
vi.mock('../../src/services/reminders/index.js', () => {
  // Must be a real function (not arrow, not vi.fn()) so `new ReminderService()`
  // works — a constructor that returns an object makes `new` use that object.
  function MockReminderService() {
    return { processReminder: mockProcessReminder };
  }
  return { ReminderService: MockReminderService };
});

import { processRemindersNow } from '../../src/workers/reminderScheduler';
import { errorsTotal } from '../../src/services/metrics';

function errorsTotalFor(event: string): number {
  return errorsTotal.snapshot().find((s) => s.labels.event === event)?.value ?? 0;
}

const DUE_REMINDER = {
  reminder_schedule_id: 42,
  retry_count: 0,
};

describe('reminderScheduler processBatch — per-reminder failures are instrumented', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
    mockUpdateReminderSchedule.mockReset();
    mockProcessReminder.mockReset();
  });

  it('SAD: a single reminder failing to send bumps reminder_process_failed, not just a log line', async () => {
    // WHO: platform operator watching /metrics
    // WHAT: processReminder rejects (provider outage, bad data); the batch
    //       must still finish (never let one bad row kill the tick) AND
    //       count the failure
    // call 1: releaseStaleClaims() (runs first, every tick) — nothing stale
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    // call 2: the actual claim
    mockPoolQuery.mockResolvedValueOnce({ rows: [DUE_REMINDER] });
    mockProcessReminder.mockRejectedValue(new Error('send failed'));
    mockUpdateReminderSchedule.mockResolvedValue(undefined);

    const before = errorsTotalFor('reminder_process_failed');
    const processed = await processRemindersNow();

    expect(processed).toBe(0); // not counted as processed — it failed
    expect(errorsTotalFor('reminder_process_failed')).toBe(before + 1);
    // Retry path taken (generic Error has no status → retryable): the row
    // goes back to 'scheduled' with a bumped retry_count, not straight to
    // 'failed'.
    expect(mockUpdateReminderSchedule).toHaveBeenCalledWith(
      '42',
      expect.objectContaining({ status: 'scheduled', retry_count: 1 })
    );
  });

  it('SAD: failing to even WRITE the failure back bumps reminder_status_update_failed', async () => {
    // WHY: this is the worse case — the row is stuck in 'sending' with no
    //      status write to recover it. Before this fix, nothing but a
    //      console.error line marked that this happened at all.
    // call 1: releaseStaleClaims() (runs first, every tick) — nothing stale
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    // call 2: the actual claim
    mockPoolQuery.mockResolvedValueOnce({ rows: [DUE_REMINDER] });
    mockProcessReminder.mockRejectedValue(new Error('send failed'));
    mockUpdateReminderSchedule.mockRejectedValue(new Error('connection terminated'));

    const before = errorsTotalFor('reminder_status_update_failed');
    const processed = await processRemindersNow();

    expect(processed).toBe(0);
    expect(errorsTotalFor('reminder_status_update_failed')).toBe(before + 1);
  });

  it('HAPPY: a clean batch bumps neither counter', async () => {
    // call 1: releaseStaleClaims() (runs first, every tick) — nothing stale
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    // call 2: the actual claim
    mockPoolQuery.mockResolvedValueOnce({ rows: [DUE_REMINDER] });
    mockProcessReminder.mockResolvedValue(undefined);

    const beforeProcess = errorsTotalFor('reminder_process_failed');
    const beforeUpdate = errorsTotalFor('reminder_status_update_failed');
    const processed = await processRemindersNow();

    expect(processed).toBe(1);
    expect(errorsTotalFor('reminder_process_failed')).toBe(beforeProcess);
    expect(errorsTotalFor('reminder_status_update_failed')).toBe(beforeUpdate);
    expect(mockUpdateReminderSchedule).not.toHaveBeenCalled();
  });
});
