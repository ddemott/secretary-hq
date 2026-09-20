/**
 * CalendarSyncCard — connect / disconnect the tenant's Google or Outlook calendar.
 *
 * WHO:   an owner on Business Settings
 * WHAT:  the connection status, and what happens when the status check FAILS
 * WHEN:  on mount, and again after an OAuth redirect (?calendarConnected=true)
 * WHERE: dashboard/components/settings/CalendarSyncCard.tsx
 * WHY:   a failed getSettings() used to be swallowed into console.error, so the
 *        card showed the same "Connect Google Calendar" buttons a genuinely
 *        disconnected tenant sees — a connected owner was told, wrongly, that
 *        nothing is hooked up. The UX pass surfaces a visible alert. These tests
 *        pin that the alert appears ONLY on a real failure, never on an honest
 *        "not connected", and that it clears when a later check succeeds.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { CalendarSyncCard } from './CalendarSyncCard';

const mockGetSettings = vi.fn();
const mockToast = vi.fn();

vi.mock('../../lib/api', () => ({
  Api: {
    calendar: {
      getSettings: (...a: unknown[]) => mockGetSettings(...a),
      getAuthUrl: vi.fn(),
      disconnect: vi.fn(),
    },
  },
}));
vi.mock('../ui/Toast', () => ({ showToast: (...a: unknown[]) => mockToast(...a) }));

const ERROR_TEXT = /Couldn.t check your calendar connection/;

beforeEach(() => {
  mockGetSettings.mockReset();
  mockToast.mockReset();
  window.history.replaceState({}, '', '/');
});
afterEach(() => window.history.replaceState({}, '', '/'));

describe('CalendarSyncCard status check', () => {
  test('HAPPY: a connected calendar shows the Connected badge and no error', async () => {
    mockGetSettings.mockResolvedValue({ provider: 'google', external_calendar_id: 'cal-1' });
    render(<CalendarSyncCard tenantId="t1" isSolo={false} />);
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Connect Google Calendar')).not.toBeInTheDocument();
  });

  test('HAPPY: an honestly disconnected tenant sees connect buttons and NO error', async () => {
    // WHY: the alert must not fire for the normal empty state.
    mockGetSettings.mockResolvedValue(null);
    render(<CalendarSyncCard tenantId="t1" isSolo={false} />);
    expect(await screen.findByText('Connect Google Calendar')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('SAD: a failed status check shows an alert and does not claim "Connected"', async () => {
    mockGetSettings.mockRejectedValue(new Error('network error'));
    render(<CalendarSyncCard tenantId="t1" isSolo={false} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(ERROR_TEXT);
    expect(screen.getByRole('alert')).toHaveTextContent(/Refresh the page/);
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  test('SAD: no tenant id means no request and no alert', () => {
    render(<CalendarSyncCard tenantId={null} isSolo={true} />);
    expect(mockGetSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('HAPPY: the alert clears once a later check succeeds (OAuth-redirect refetch)', async () => {
    // First call (mount) fails, second (from ?calendarConnected=true) succeeds.
    window.history.replaceState({}, '', '/?calendarConnected=true');
    mockGetSettings
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce({ provider: 'outlook', external_calendar_id: 'cal-2' });
    render(<CalendarSyncCard tenantId="t1" isSolo={false} />);
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(mockGetSettings).toHaveBeenCalledTimes(2);
  });
});
