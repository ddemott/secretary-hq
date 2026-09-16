/**
 * useSchedulerData tests — pins the appointment-list date-range query at the
 * exact boundary that hid a real production bug for months: an appointment
 * scheduled in the local evening (US Central, UTC-5/-6) silently vanished
 * from the Scheduler List/Day view because the fetch window was built by
 * appending "Z" to a LOCAL calendar-date string, which Postgres/JS both read
 * as UTC midnight — 5-6 hours earlier than the real local midnight. Found
 * 2026-09-15 via a persistent (not flaky) e2e/appointment-cancel-ui.spec.ts
 * CI failure that only ever reproduced during the US-Central evening window.
 *
 * These tests force process.env.TZ to a UTC-behind zone so the regression
 * is actually visible in CI (GH Actions runners default to UTC, where the
 * old buggy code and the fix happen to produce byte-identical output —
 * local offset 0 makes "append Z to the local date" accidentally correct).
 *
 * Each test carries 5W context.
 */
import { describe, test, expect, vi, beforeEach, afterAll } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const ORIGINAL_TZ = process.env.TZ;

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    appointments: { list: vi.fn() },
    shifts: { schedule: { bulkForDate: vi.fn() } },
  },
}));

vi.mock('../../lib/api', () => ({ Api: mockApi }));

import { useSchedulerData } from './useSchedulerData';

beforeEach(() => {
  process.env.TZ = 'America/Chicago';
  mockApi.appointments.list.mockReset().mockResolvedValue([]);
  mockApi.shifts.schedule.bulkForDate.mockReset().mockResolvedValue([]);
});

afterAll(() => {
  // process.env stringifies every assignment, so `process.env.TZ = undefined`
  // does NOT clear it — it sets the literal string "undefined", which then
  // leaks a bogus timezone into every test file sharing this worker. Delete
  // the key outright when there was no original value to restore.
  if (ORIGINAL_TZ === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = ORIGINAL_TZ;
  }
});

describe('useSchedulerData — local-midnight date-range boundary', () => {
  test('HAPPY: mid-morning local time → range is local midnight to next local midnight', async () => {
    // WHO: operator viewing today's schedule at 10am local
    // WHAT: selectedDate is Sep 15 2026, 10:00 CDT (well inside the safe
    //       part of the day) — the query range must span local midnight
    //       Sep 15 to local midnight Sep 16, expressed as the correct UTC
    //       instants for those local moments (05:00Z / 05:00Z next day
    //       for CDT, UTC-5).
    // WHY:  this is the control case — proves the fix doesn't break the
    //       ordinary daytime path while fixing the evening one below.
    const selectedDate = new Date(2026, 8, 15, 10, 0, 0);
    renderHook(() => useSchedulerData('tenant-a', selectedDate, [], []));

    await waitFor(() => expect(mockApi.appointments.list).toHaveBeenCalled());

    const [, range] = mockApi.appointments.list.mock.calls[0];
    expect(range.startDate).toBe(new Date(2026, 8, 15).toISOString());
    expect(range.endDate).toBe(new Date(2026, 8, 16).toISOString());
  });

  test('SAD (the actual regression): 11pm local time → an appointment 15 minutes later must still fall inside the fetch range', async () => {
    // WHO: operator or the voice agent booking/viewing an appointment at
    //      23:00 local (US Central) — squarely in the historically-broken
    //      window (roughly 19:00 local onward each day).
    // WHAT: selectedDate is "today" at 23:00 CDT. An appointment starting
    //       15 minutes later has a UTC timestamp on the NEXT UTC calendar
    //       day (23:15 CDT = 04:15Z the next day). The fetch range's upper
    //       bound must be local midnight (05:00Z the next day for CDT),
    //       which is AFTER that appointment's UTC timestamp — so it's
    //       correctly included.
    // WHY:  the old code built endDate as `${nextLocalDateStr}T00:00:00Z`,
    //       i.e. 00:00Z the next UTC day — which is BEFORE 04:15Z and would
    //       have silently excluded this exact appointment. This is the
    //       precise shape of the bug that hid real evening bookings from
    //       the Scheduler List/Day view.
    const selectedDate = new Date(2026, 8, 15, 23, 0, 0);
    const apptStart = new Date(2026, 8, 15, 23, 15, 0); // still "today" locally

    renderHook(() => useSchedulerData('tenant-a', selectedDate, [], []));

    await waitFor(() => expect(mockApi.appointments.list).toHaveBeenCalled());

    const [, range] = mockApi.appointments.list.mock.calls[0];
    const rangeStartMs = new Date(range.startDate).getTime();
    const rangeEndMs = new Date(range.endDate).getTime();

    expect(apptStart.getTime()).toBeGreaterThanOrEqual(rangeStartMs);
    expect(apptStart.getTime()).toBeLessThan(rangeEndMs);

    // Pin the exact boundary values too, so a future refactor can't
    // "fix" this test by loosening the range instead of the query.
    expect(range.startDate).toBe(new Date(2026, 8, 15).toISOString());
    expect(range.endDate).toBe(new Date(2026, 8, 16).toISOString());
  });

  test('shifts.bulkForDate still receives the plain local calendar-date string, unchanged', async () => {
    // WHO: the shift-coverage lookup that powers the same view
    // WHAT: bulkForDate takes a YYYY-MM-DD local date string, not a UTC
    //       instant — this must be untouched by the fetch-range fix above.
    // WHY:  guards against a regression that "fixes" the wrong call site.
    const selectedDate = new Date(2026, 8, 15, 23, 0, 0);
    renderHook(() => useSchedulerData('tenant-a', selectedDate, [], []));

    await waitFor(() => expect(mockApi.shifts.schedule.bulkForDate).toHaveBeenCalled());
    expect(mockApi.shifts.schedule.bulkForDate).toHaveBeenCalledWith(
      'tenant-a',
      '2026-09-15',
      '2026-09-15'
    );
  });
});
