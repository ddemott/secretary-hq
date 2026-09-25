/**
 * WHO:   the schedule-extender background worker (daily + once at boot)
 * WHAT:  tops every live tenant's staff calendar up to the rolling horizon
 * WHEN:  startScheduleExtender() at boot, then every 24h; extendSchedulesNow() on demand
 * WHERE: src/workers/scheduleExtender.ts (the SQL itself is covered by
 *        tests/services/extendSchedules.realdb.test.ts — this file covers the worker)
 * WHY:   the worker's own logic had 0% coverage (TEST_COVERAGE.md). Its failure modes
 *        are silent-but-lethal: a skipped or crashed run means a business quietly
 *        becomes unbookable weeks later, with the AI telling callers "no one is scheduled".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.fn();
const mockExtend = vi.fn();
const tenantCalls: string[] = [];

vi.mock('../../src/database/index.js', () => ({
  getPool: () => ({ query: mockQuery }),
  // Records which tenant context each unit of work ran under.
  createWithTenantClient:
    () =>
    async <T>(tenantId: string, fn: (client: unknown) => Promise<T>): Promise<T> => {
      tenantCalls.push(tenantId);
      return fn({ tenantId });
    },
}));
vi.mock('../../src/services/extendSchedules.js', () => ({
  DEFAULT_HORIZON_DAYS: 180,
  extendSchedules: (...args: unknown[]) => mockExtend(...args),
}));

import {
  extendSchedulesNow,
  startScheduleExtender,
  stopScheduleExtender,
} from '../../src/workers/scheduleExtender';
import { errorsTotal, registry } from '../../src/services/metrics';

const T1 = 'a1111111-1111-4111-8111-111111111111';
const T2 = 'b2222222-2222-4222-8222-222222222222';
const T3 = 'c3333333-3333-4333-8333-333333333333';

function errorCount(event: string): number {
  return (
    errorsTotal.snapshot().find((s) => (s.labels as Record<string, string>).event === event)
      ?.value ?? 0
  );
}

beforeEach(() => {
  mockQuery.mockReset();
  mockExtend.mockReset();
  tenantCalls.length = 0;
  registry.clearAll();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  stopScheduleExtender();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('extendSchedulesNow', () => {
  it('HAPPY: extends every live tenant inside its own tenant context and sums the rows', async () => {
    // WHY tenant context: `employees` has RLS with NO admin bypass — a context-free
    //     sweep sees zero employees and "succeeds" having extended nothing.
    mockQuery.mockResolvedValue({ rows: [{ tenant_id: T1 }, { tenant_id: T2 }] });
    mockExtend
      .mockResolvedValueOnce({ rowsInserted: 5 })
      .mockResolvedValueOnce({ rowsInserted: 2 });

    const result = await extendSchedulesNow(90);

    expect(result).toEqual({ rowsInserted: 7, tenantsFailed: 0 });
    expect(tenantCalls).toEqual([T1, T2]);
    expect(mockExtend).toHaveBeenCalledTimes(2);
    expect(mockExtend.mock.calls[0][1]).toEqual({ horizonDays: 90 });
  });

  it('HAPPY: only live tenants are read — soft-deleted businesses are excluded in SQL', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await extendSchedulesNow();

    expect(result).toEqual({ rowsInserted: 0, tenantsFailed: 0 });
    expect(mockQuery.mock.calls[0][0]).toMatch(/is_deleted\s*=\s*false/);
    // Template businesses are read-only (a write would be refused) and have no hours.
    expect(mockQuery.mock.calls[0][0]).toMatch(/is_template\s*=\s*false/);
    expect(mockExtend).not.toHaveBeenCalled();
  });

  it('SAD: one tenant failing does not stop the others (and is counted)', async () => {
    // WHY: a single bad tenant must not mean every other business quietly stops
    //      being bookable.
    mockQuery.mockResolvedValue({
      rows: [{ tenant_id: T1 }, { tenant_id: T2 }, { tenant_id: T3 }],
    });
    mockExtend
      .mockResolvedValueOnce({ rowsInserted: 4 })
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce({ rowsInserted: 3 });

    const result = await extendSchedulesNow();

    expect(result).toEqual({ rowsInserted: 7, tenantsFailed: 1 });
    expect(tenantCalls).toEqual([T1, T2, T3]);
  });
});

describe('startScheduleExtender / stopScheduleExtender', () => {
  it('HAPPY: runs once immediately at boot, then on every interval', async () => {
    // WHY at boot: a lapsed schedule is repaired on deploy, not a day later.
    vi.useFakeTimers();
    mockQuery.mockResolvedValue({ rows: [{ tenant_id: T1 }] });
    mockExtend.mockResolvedValue({ rowsInserted: 1 });

    startScheduleExtender(1000, 180);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockExtend).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockExtend).toHaveBeenCalledTimes(2);
  });

  it('SAD: a second start is a no-op (no duplicate interval)', async () => {
    vi.useFakeTimers();
    mockQuery.mockResolvedValue({ rows: [{ tenant_id: T1 }] });
    mockExtend.mockResolvedValue({ rowsInserted: 0 });

    startScheduleExtender(1000, 180);
    startScheduleExtender(1000, 180);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockExtend).toHaveBeenCalledTimes(2); // boot + one interval, not doubled
  });

  it('HAPPY: stop halts further runs', async () => {
    vi.useFakeTimers();
    mockQuery.mockResolvedValue({ rows: [{ tenant_id: T1 }] });
    mockExtend.mockResolvedValue({ rowsInserted: 0 });

    startScheduleExtender(1000, 180);
    await vi.advanceTimersByTimeAsync(0);
    stopScheduleExtender();
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockExtend).toHaveBeenCalledTimes(1);
  });

  it('SAD: an overlapping tick is skipped while the previous one is still running', async () => {
    vi.useFakeTimers();
    mockQuery.mockResolvedValue({ rows: [{ tenant_id: T1 }] });
    let release: (v: { rowsInserted: number }) => void = () => {};
    mockExtend.mockImplementationOnce(
      () => new Promise<{ rowsInserted: number }>((r) => (release = r))
    );

    startScheduleExtender(1000, 180);
    await vi.advanceTimersByTimeAsync(0); // boot tick starts, hangs
    await vi.advanceTimersByTimeAsync(1000); // interval fires while the boot tick is running
    expect(mockExtend).toHaveBeenCalledTimes(1);

    release({ rowsInserted: 0 });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('SAD: a tenant failure bumps errors_total{event=schedule_extender_tenant_failed}', async () => {
    // WHY: survives log truncation and can be alerted on.
    vi.useFakeTimers();
    mockQuery.mockResolvedValue({ rows: [{ tenant_id: T1 }] });
    mockExtend.mockRejectedValue(new Error('boom'));

    startScheduleExtender(60_000, 180);
    await vi.advanceTimersByTimeAsync(0);

    expect(errorCount('schedule_extender_tenant_failed')).toBe(1);
    expect(errorCount('schedule_extender_failed')).toBe(0);
  });

  it('SAD: a whole-run failure (tenant list unreadable) bumps errors_total{event=schedule_extender_failed}', async () => {
    vi.useFakeTimers();
    mockQuery.mockRejectedValue(new Error('connection terminated'));

    startScheduleExtender(60_000, 180);
    await vi.advanceTimersByTimeAsync(0);

    expect(errorCount('schedule_extender_failed')).toBe(1);
    expect(mockExtend).not.toHaveBeenCalled();
  });
});
