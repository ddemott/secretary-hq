/**
 * VoiceCallsView Tests
 * Tests voice call history display, active calls, call details, and customer context.
 * Each section has happy + sad paths with 5W diagnostic context.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

// Mutable role for owner-gating tests (hoisted so the vi.mock factory can read it).
const { roleRef } = vi.hoisted(() => {
  const roleRef: { current: 'owner' | 'front_desk' } = { current: 'owner' };
  return { roleRef };
});

// Mock tenant context
vi.mock('../../lib/SessionContext', () => ({
  useActiveTenantId: () => 'test-tenant-123',
  useSessionContext: () => ({ role: roleRef.current }),
}));

// Toast is fired on delete success/failure.
const mockToast = vi.fn();
vi.mock('../ui/Toast', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }));

// Mock phone formatting
vi.mock('../../lib/phone', () => ({
  formatPhone: (phone: string) => phone || 'Unknown',
}));

// Mock API responses
const mockActiveCalls = vi.fn();
const mockCallHistory = vi.fn();
const mockGetSession = vi.fn();
const mockCommsHistory = vi.fn();
const mockDeleteCall = vi.fn();
const mockDeleteOldCalls = vi.fn();

vi.mock('../../lib/api', () => ({
  Api: {
    voice: {
      getActiveCalls: (...args: unknown[]) => mockActiveCalls(...args),
      getHistory: (...args: unknown[]) => mockCallHistory(...args),
      getSession: (...args: unknown[]) => mockGetSession(...args),
      deleteCall: (...args: unknown[]) => mockDeleteCall(...args),
      deleteOldCalls: (...args: unknown[]) => mockDeleteOldCalls(...args),
    },
    communications: {
      history: (...args: unknown[]) => mockCommsHistory(...args),
    },
  },
}));

import VoiceCallsView from './VoiceCallsView';

const mockCall = {
  id: 'call-1',
  call_id: 'vapi-123',
  tenant_id: 'test-tenant-123',
  caller_phone: '+15551234567',
  customer_name: 'John Smith',
  started_at: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
  ended_at: new Date().toISOString(),
  status: 'completed',
  duration_seconds: 120,
  outcome: 'booked',
  transcript: 'Hello, I would like to book an appointment.',
  summary: 'Customer booked a 30-minute service appointment.',
  customer_context: {
    customer: { id: 'cust-1', name: 'John Smith', email: 'john@example.com' },
    is_known_customer: true,
    member_since: '2024-01-15T00:00:00Z',
    appointment_history: {
      total: 5,
      completed: 4,
      cancelled: 1,
      no_shows: 0,
      upcoming_appointments: [
        { appointment_id: 'apt-1', start_time: '2026-04-15T10:00:00Z', description: 'Haircut' },
      ],
    },
    notes: [
      {
        id: 'note-1',
        text: 'Prefers morning appointments',
        type: 'preference',
        created_at: '2024-03-01T00:00:00Z',
      },
    ],
    tags: ['VIP', 'Regular'],
  },
};

const mockActiveCall = {
  id: 'active-1',
  call_id: 'vapi-active',
  caller_phone: '+15559876543',
  customer_name: 'Jane Doe',
  started_at: new Date(Date.now() - 30000).toISOString(),
  is_known_customer: true,
};

describe('VoiceCallsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Default happy path responses
    mockActiveCalls.mockResolvedValue({ calls: [] });
    mockCallHistory.mockResolvedValue({
      calls: [mockCall],
      total: 1,
      has_more: false,
    });
    mockGetSession.mockResolvedValue(mockCall);
    mockCommsHistory.mockResolvedValue({ success: true, history: [], total: 0 });
    mockDeleteCall.mockResolvedValue({ success: true });
    mockDeleteOldCalls.mockResolvedValue({ success: true, result: { deleted: 3 } });
    roleRef.current = 'owner';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Happy Paths', () => {
    test('renders voice calls header with refresh button', async () => {
      render(<VoiceCallsView />);
      expect(screen.getByText('Voice Calls')).toBeInTheDocument();
      expect(screen.getByTitle('Refresh')).toBeInTheDocument();
      // WHO: all users | WHAT: page header display
      // WHEN: navigating to calls | WHERE: VoiceCallsView header
      // WHY: users need to identify the page and have refresh access
    });

    test('displays call history with call details', async () => {
      render(<VoiceCallsView />);
      await waitFor(() => {
        // John Smith appears in both list and detail panel
        expect(screen.getAllByText('John Smith').length).toBeGreaterThanOrEqual(1);
      });
      expect(screen.getByText('Call History (1)')).toBeInTheDocument();
      // WHO: users viewing history | WHAT: call list display
      // WHEN: history loads | WHERE: left panel
      // WHY: users need to see past calls and counts
    });

    test('a11y: call history rows are keyboard-operable buttons with an accessible name', async () => {
      // WHO: a keyboard/screen-reader user | WHAT: each call row is a role="button"
      //   with an accessible name and aria-pressed, not a click-only <div> | WHERE:
      //   HistoryCallRow | WHY: the list was previously mouse-only — unreachable by
      //   keyboard and announced as plain text.
      render(<VoiceCallsView />);
      const row = await screen.findByRole('button', { name: /View call from John Smith/i });
      // The single history call auto-selects on load.
      expect(row).toHaveAttribute('aria-pressed', 'true');
    });

    test('displays call duration formatted correctly', async () => {
      render(<VoiceCallsView />);
      await waitFor(() => {
        // Duration appears in list and detail panel
        expect(screen.getAllByText('2:00').length).toBeGreaterThanOrEqual(1); // 120 seconds = 2:00
      });
      // WHO: users | WHAT: duration formatting
      // WHEN: viewing call | WHERE: call list item
      // WHY: mm:ss format is human-readable
    });

    test('displays outcome badge with correct styling', async () => {
      render(<VoiceCallsView />);
      await waitFor(() => {
        // Outcome badge appears in list and detail panel
        expect(screen.getAllByText('Booked').length).toBeGreaterThanOrEqual(1);
      });
      // WHO: users | WHAT: outcome badge
      // WHEN: viewing call | WHERE: call list and details
      // WHY: quick visual indicator of call result
    });

    test('shows active calls section when calls are in progress', async () => {
      mockActiveCalls.mockResolvedValue({ calls: [mockActiveCall] });
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getByText('Active Calls (1)')).toBeInTheDocument();
        expect(screen.getByText('Jane Doe')).toBeInTheDocument();
      });
      // WHO: users monitoring calls | WHAT: active calls display
      // WHEN: calls in progress | WHERE: active calls section
      // WHY: real-time visibility into ongoing calls
    });

    test('displays customer context for known customers', async () => {
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getByText('Customer Context')).toBeInTheDocument();
        expect(screen.getByText('5')).toBeInTheDocument(); // Total appointments
        expect(screen.getByText('4')).toBeInTheDocument(); // Completed
        expect(screen.getByText('1')).toBeInTheDocument(); // Cancelled
      });
      // WHO: users viewing call details | WHAT: customer history
      // WHEN: selecting a call | WHERE: right panel
      // WHY: context helps understand customer relationship
    });

    test('displays transcript when available', async () => {
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getByText('Transcript')).toBeInTheDocument();
        expect(screen.getByText('Hello, I would like to book an appointment.')).toBeInTheDocument();
      });
      // WHO: users reviewing calls | WHAT: call transcript
      // WHEN: viewing completed call | WHERE: details panel
      // WHY: verify what was discussed
    });

    test('displays call summary when available', async () => {
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getByText('Call Summary')).toBeInTheDocument();
        expect(
          screen.getByText('Customer booked a 30-minute service appointment.')
        ).toBeInTheDocument();
      });
      // WHO: users | WHAT: AI-generated summary
      // WHEN: call completed | WHERE: details panel
      // WHY: quick overview without reading transcript
    });

    test('displays customer notes and tags', async () => {
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getByText('Notes')).toBeInTheDocument();
        expect(screen.getByText('Prefers morning appointments')).toBeInTheDocument();
        expect(screen.getByText('VIP')).toBeInTheDocument();
        expect(screen.getByText('Regular')).toBeInTheDocument();
      });
      // WHO: users | WHAT: customer notes and tags
      // WHEN: viewing known customer | WHERE: customer context
      // WHY: helps personalize service
    });

    test('clicking refresh fetches new data', async () => {
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(mockCallHistory).toHaveBeenCalled();
      });

      fireEvent.click(screen.getByTitle('Refresh'));

      await waitFor(() => {
        expect(mockActiveCalls).toHaveBeenCalledTimes(2);
        expect(mockCallHistory).toHaveBeenCalledTimes(2);
      });
      // WHO: user | WHAT: manual refresh
      // WHEN: clicking refresh | WHERE: header
      // WHY: get latest data on demand
    });
  });

  describe('Sad Paths', () => {
    test('displays empty state when no call history', async () => {
      mockCallHistory.mockResolvedValue({ calls: [], total: 0, has_more: false });
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getByText('No call history yet')).toBeInTheDocument();
      });
      // WHO: new tenants | WHAT: empty state display
      // WHEN: no calls recorded | WHERE: call list
      // WHY: clear indication there's no data yet
    });

    test('displays prompt when no call is selected', async () => {
      mockCallHistory.mockResolvedValue({ calls: [], total: 0, has_more: false });
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getByText('Select a call to view details')).toBeInTheDocument();
      });
      // WHO: users | WHAT: selection prompt
      // WHEN: no call selected | WHERE: details panel
      // WHY: guide user to select a call
    });

    test('handles API error for active calls gracefully', async () => {
      mockActiveCalls.mockRejectedValue(new Error('Network error'));
      render(<VoiceCallsView />);
      await waitFor(() => {
        // Should not crash, just show empty active calls
        expect(screen.queryByText('Active Calls')).not.toBeInTheDocument();
      });
      // WHO: users | WHAT: error handling
      // WHEN: API fails | WHERE: active calls section
      // WHY: graceful degradation on network issues
    });

    test('handles API error for call history gracefully', async () => {
      mockCallHistory.mockRejectedValue(new Error('Server error'));
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.queryByText('No call history')).not.toBeInTheDocument();
      });
      // WHO: users | WHAT: error handling for history
      // WHEN: history API fails | WHERE: call list
      // WHY: prevent crash on API errors
    });

    test('displays new caller message for unknown customers', async () => {
      const unknownCustomerCall = {
        ...mockCall,
        customer_context: {
          ...mockCall.customer_context,
          is_known_customer: false,
        },
      };
      mockCallHistory.mockResolvedValue({
        calls: [unknownCustomerCall],
        total: 1,
        has_more: false,
      });
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getByText('New caller - no previous history')).toBeInTheDocument();
      });
      // WHO: users | WHAT: new caller indicator
      // WHEN: caller not in system | WHERE: customer context
      // WHY: indicates this is a new customer
    });

    test('falls back to phone number when customer name is missing', async () => {
      const noNameCall = {
        ...mockCall,
        customer_name: null,
        customer_context: null,
      };
      mockCallHistory.mockResolvedValue({ calls: [noNameCall], total: 1, has_more: false });
      render(<VoiceCallsView />);
      await waitFor(() => {
        // Phone number appears in list and detail panel
        expect(screen.getAllByText('+15551234567').length).toBeGreaterThanOrEqual(1);
      });
      // WHO: users | WHAT: phone number fallback
      // WHEN: name unavailable | WHERE: call list and header
      // WHY: always have some identifier for the call
    });
  });

  describe('Edge Cases', () => {
    test('formats duration of 0 seconds correctly', async () => {
      const zeroDurationCall = { ...mockCall, duration_seconds: 0 };
      mockCallHistory.mockResolvedValue({ calls: [zeroDurationCall], total: 1, has_more: false });
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getAllByText('0:00').length).toBeGreaterThanOrEqual(1);
      });
    });

    test('formats duration of null correctly', async () => {
      const nullDurationCall = { ...mockCall, duration_seconds: null };
      mockCallHistory.mockResolvedValue({ calls: [nullDurationCall], total: 1, has_more: false });
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getAllByText('0:00').length).toBeGreaterThanOrEqual(1);
      });
    });

    test('shows load more button when has_more is true', async () => {
      mockCallHistory.mockResolvedValue({ calls: [mockCall], total: 25, has_more: true });
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getByText(/Load more/)).toBeInTheDocument();
      });
    });

    test('load more appends to existing history', async () => {
      const secondCall = { ...mockCall, id: 'call-2', customer_name: 'Alice Brown' };
      mockCallHistory
        .mockResolvedValueOnce({ calls: [mockCall], total: 2, has_more: true })
        .mockResolvedValueOnce({ calls: [secondCall], total: 2, has_more: false });

      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getAllByText('John Smith').length).toBeGreaterThanOrEqual(1);
      });

      fireEvent.click(screen.getByText(/Load more/));

      await waitFor(() => {
        expect(screen.getAllByText('Alice Brown').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('John Smith').length).toBeGreaterThanOrEqual(1);
      });
    });

    test('a call deleted after paginating does not reappear on the 10s poll', async () => {
      // WHO: an owner who clicked "Load more" then deleted a first-page call.
      // WHAT: the background 10s poll re-merges the fresh first page into the
      //       paginated list. WHEN/WHERE: fetchCallHistory silent merge in
      //       VoiceCallsView. WHY: regression — the old merge kept every prev
      //       row (`?? c`), so a deleted call reappeared on the next poll and
      //       read as "delete not working" (reported 2026-06-30).
      const now = Date.now();
      const callA = {
        ...mockCall,
        voice_session_id: 'vs-a',
        id: 'vs-a',
        customer_name: 'Alice Newest',
        started_at: new Date(now).toISOString(),
      };
      const callB = {
        ...mockCall,
        voice_session_id: 'vs-b',
        id: 'vs-b',
        customer_name: 'Bob Middle',
        started_at: new Date(now - 60_000).toISOString(),
      };
      const callC = {
        ...mockCall,
        voice_session_id: 'vs-c',
        id: 'vs-c',
        customer_name: 'Carol Oldest',
        started_at: new Date(now - 120_000).toISOString(),
      };

      mockCallHistory
        // initial first page (A, B) with a second page available
        .mockResolvedValueOnce({ calls: [callA, callB], total: 3, has_more: true })
        // "Load more" → page 2 (C); list is now [A, B, C]
        .mockResolvedValueOnce({ calls: [callC], total: 3, has_more: false })
        // every later fetch (incl. the silent poll) reflects B being deleted
        .mockResolvedValue({ calls: [callA, callC], total: 2, has_more: false });

      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getAllByText('Bob Middle').length).toBeGreaterThanOrEqual(1);
      });

      fireEvent.click(screen.getByText(/Load more/));
      await waitFor(() => {
        expect(screen.getAllByText('Carol Oldest').length).toBeGreaterThanOrEqual(1);
      });

      // The 10s background poll fires with B gone from the fresh first page.
      await vi.advanceTimersByTimeAsync(10_000);

      await waitFor(() => {
        expect(screen.queryByText('Bob Middle')).not.toBeInTheDocument();
      });
      // The other calls survive: A (first page) + C (older paginated row).
      expect(screen.getAllByText('Alice Newest').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Carol Oldest').length).toBeGreaterThanOrEqual(1);
    });

    test('handles all outcome types correctly', async () => {
      // These are the ONLY outcome strings the agent writes (callOutcome.ts +
      // callClassify.ts CATEGORIES). The dashboard's label map must match them
      // exactly — the prior phantom set ('appointment_booked'/'voicemail'/…) was
      // never emitted, so booked calls rendered a grey raw "booked" badge.
      const outcomes = [
        'booked',
        'transferred',
        'message',
        'no_availability',
        'wrong_service',
        'price',
        'info',
      ];
      const labels = [
        'Booked',
        'Transferred',
        'Left a message',
        'No availability',
        'Wrong service',
        'Price concern',
        'Question only',
      ];

      for (let i = 0; i < outcomes.length; i++) {
        const callWithOutcome = { ...mockCall, id: `call-${i}`, outcome: outcomes[i] };
        mockCallHistory.mockResolvedValue({ calls: [callWithOutcome], total: 1, has_more: false });
        const { unmount } = render(<VoiceCallsView />);
        await waitFor(() => {
          // Outcome label appears in list and detail panel
          expect(screen.getAllByText(labels[i]).length).toBeGreaterThanOrEqual(1);
        });
        unmount();
      }
    });

    test('renders legacy-vocabulary outcomes with the right label (backward-compat)', async () => {
      // WHO: a tenant whose stored/historical rows carry the LEGACY outcome
      //        vocabulary (shared VoiceSessionOutcome / the /voice/session/end
      //        Zod enum) rather than the agent's live strings.
      // WHAT: a legacy 'appointment_booked' must still render "Booked", not a
      //        grey humanized "appointment booked" — the map carries aliases.
      // WHERE: OUTCOME_LABELS + getOutcomeStyle backward-compat entries.
      // WHY: Copilot flagged that dropping the legacy keys would regress those
      //        rows to a neutral badge; this pins the alias so it can't.
      const legacyCall = { ...mockCall, outcome: 'appointment_booked' };
      mockCallHistory.mockResolvedValue({ calls: [legacyCall], total: 1, has_more: false });
      render(<VoiceCallsView />);
      await waitFor(() => expect(screen.getAllByText('Booked').length).toBeGreaterThanOrEqual(1));
      expect(screen.queryByText('appointment booked')).not.toBeInTheDocument();
    });

    test('handles unknown outcome gracefully', async () => {
      const unknownOutcomeCall = { ...mockCall, outcome: 'unknown_type' };
      mockCallHistory.mockResolvedValue({ calls: [unknownOutcomeCall], total: 1, has_more: false });
      render(<VoiceCallsView />);
      await waitFor(() => {
        // An unmapped outcome is humanized (underscores → spaces) rather than
        // shown raw, so it stays readable in list + detail panel.
        expect(screen.getAllByText('unknown type').length).toBeGreaterThanOrEqual(1);
      });
    });

    test('clicking active call fetches full session details', async () => {
      mockActiveCalls.mockResolvedValue({ calls: [mockActiveCall] });
      render(<VoiceCallsView />);

      await waitFor(() => {
        expect(screen.getByText('Jane Doe')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Jane Doe'));

      await waitFor(() => {
        expect(mockGetSession).toHaveBeenCalledWith('test-tenant-123', 'vapi-active');
      });
    });

    test('shows returning customer badge in active calls', async () => {
      mockActiveCalls.mockResolvedValue({ calls: [mockActiveCall] });
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getByText('Returning customer')).toBeInTheDocument();
      });
    });

    test('displays appointment count in history for known customers', async () => {
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getByText('5 appointments')).toBeInTheDocument();
      });
    });
  });

  describe('Sent tab', () => {
    test('clicking Sent tab mounts CommsSentView with channel filter buttons', async () => {
      // WHO: owner reviewing outbound SMS/email | WHAT: Sent tab is reachable + renders filter UI
      // WHEN: clicking the Sent sub-tab | WHERE: VoiceCallsView FolderTabBar
      // WHY: prevents regression where a bad import or missing tab wiring causes a blank/crash
      render(<VoiceCallsView />);

      fireEvent.click(screen.getByText('Sent'));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'SMS' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Email' })).toBeInTheDocument();
      });
    });

    test('Sent tab shows empty state when history is empty', async () => {
      // WHO: owner on fresh tenant | WHAT: empty-state copy visible via Sent tab
      // WHEN: history returns zero rows | WHERE: CommsSentView via VoiceCallsView
      // WHY: full render path test — tab switch → CommsSentView mount → API call → empty state
      mockCommsHistory.mockResolvedValue({ success: true, history: [], total: 0 });

      render(<VoiceCallsView />);
      fireEvent.click(screen.getByText('Sent'));

      await waitFor(() => {
        expect(screen.getByText('No sent messages')).toBeInTheDocument();
      });
    });
  });

  describe('Status Display', () => {
    test('shows Active status badge for in-progress calls', async () => {
      const activeStatusCall = { ...mockCall, status: 'active' };
      mockCallHistory.mockResolvedValue({ calls: [activeStatusCall], total: 1, has_more: false });
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getByText('Active')).toBeInTheDocument();
      });
    });

    test('shows Completed status badge for finished calls', async () => {
      render(<VoiceCallsView />);
      await waitFor(() => {
        // Status may appear multiple times
        expect(screen.getAllByText('Completed').length).toBeGreaterThanOrEqual(1);
      });
    });

    test('shows error status for failed calls', async () => {
      const failedCall = { ...mockCall, status: 'failed' };
      mockCallHistory.mockResolvedValue({ calls: [failedCall], total: 1, has_more: false });
      render(<VoiceCallsView />);
      await waitFor(() => {
        expect(screen.getByText('failed')).toBeInTheDocument();
      });
    });
  });

  describe('Soft-delete controls (owner-gated)', () => {
    test('HAPPY: owner sees the bulk "delete old calls" control', async () => {
      // WHO: an owner on the Calls tab.
      // WHAT: the bulk delete-old icon button is shown (with its day-window select).
      // WHEN: role === 'owner'.
      // WHERE: the Call History header.
      // WHY: owners can prune old call records to reduce retained caller PII.
      render(<VoiceCallsView />);
      await waitFor(() => expect(mockCallHistory).toHaveBeenCalled());
      expect(screen.getByLabelText(/delete calls older than/i)).toBeInTheDocument();
    });

    test('SAD: front-desk does NOT see the bulk delete control', async () => {
      // WHO: a front-desk login on the Calls tab.
      // WHAT: the delete-old control is hidden.
      // WHEN: role === 'front_desk'.
      // WHERE: isOwner gate in the Call History header.
      // WHY: deleting call records (caller PII) is owner-only; front-desk can view.
      roleRef.current = 'front_desk';
      render(<VoiceCallsView />);
      await waitFor(() => expect(mockCallHistory).toHaveBeenCalled());
      expect(screen.queryByLabelText(/delete calls older than/i)).not.toBeInTheDocument();
    });

    test('HAPPY: bulk delete confirms, then calls the Api with the chosen window', async () => {
      // WHO: an owner clearing calls older than the default 90-day window.
      // WHAT: clicking the control opens a confirm; confirming calls
      //       deleteOldCalls(tenantId, 90) and toasts the deleted count.
      // WHEN: owner clicks delete-old then confirms.
      // WHERE: handleDeleteOld + ConfirmModal.
      // WHY: a destructive bulk action must be guarded by an explicit confirm.
      render(<VoiceCallsView />);
      await waitFor(() => expect(mockCallHistory).toHaveBeenCalled());

      fireEvent.click(screen.getByLabelText(/delete calls older than/i));
      const confirmBtn = await screen.findByRole('button', { name: 'Delete old calls' });
      fireEvent.click(confirmBtn);

      await waitFor(() => expect(mockDeleteOldCalls).toHaveBeenCalledWith('test-tenant-123', 90));
      await waitFor(() =>
        expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('3'), 'success')
      );
      // The confirm dialog must dismiss after confirming (regression 2026-07-01:
      // it lingered because the handler never closed it).
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Delete old calls' })).not.toBeInTheDocument()
      );
    });

    test('HAPPY: confirming a single-call delete dismisses the confirm dialog', async () => {
      // WHO: an owner deleting one call. WHAT: confirming calls deleteCall and
      // closes the dialog. WHERE: handleDeleteCall + ConfirmModal. WHY: the
      // dialog lingered after clicking Delete (reported 2026-07-01).
      const callWithId = { ...mockCall, voice_session_id: 'vs-del', id: 'vs-del' };
      mockCallHistory.mockResolvedValue({ calls: [callWithId], total: 1, has_more: false });

      render(<VoiceCallsView />);
      await waitFor(() => expect(screen.getAllByText('John Smith').length).toBeGreaterThan(0));

      // Open the detail pane's delete → confirm dialog.
      fireEvent.click(screen.getByRole('button', { name: 'Delete this call' }));
      const confirmBtn = await screen.findByRole('button', { name: 'Delete call' });
      fireEvent.click(confirmBtn);

      await waitFor(() => expect(mockDeleteCall).toHaveBeenCalledWith('test-tenant-123', 'vs-del'));
      await waitFor(() => expect(screen.queryByText('Delete this call?')).not.toBeInTheDocument());
    });
  });

  describe('Outcome filter (UX review — real vocabulary)', () => {
    // The agent only ever writes: booked, transferred, message, no_availability,
    // wrong_service, price, info, or null. The filter must match those — the old
    // options ('appointment_booked'/'voicemail'/'abandoned') matched nothing.
    // customer_context is nulled so each call's name shows ONLY in its list row
    // (the detail pane falls back to the phone) — otherwise the auto-selected
    // call's context name would leak into the detail <h2> and collide with the
    // list-membership assertions.
    const booked = {
      ...mockCall,
      voice_session_id: 'vs-b',
      id: 'vs-b',
      caller_phone: '+15550000001',
      customer_name: 'Bea Booked',
      customer_context: null,
      outcome: 'booked',
    };
    const priced = {
      ...mockCall,
      voice_session_id: 'vs-p',
      id: 'vs-p',
      caller_phone: '+15550000002',
      customer_name: 'Pat Price',
      customer_context: null,
      outcome: 'price',
    };
    const noOutcome = {
      ...mockCall,
      voice_session_id: 'vs-n',
      id: 'vs-n',
      caller_phone: '+15550000003',
      customer_name: 'Nil Caller',
      customer_context: null,
      outcome: null,
    };

    test('HAPPY: filtering to a real outcome keeps matching calls and drops the rest', async () => {
      // WHO: an owner triaging by outcome. WHAT: selecting "Price concern" shows
      // only price-outcome calls. WHEN: after history loads. WHERE: outcome
      // <select> + client-side predicate. WHY: the old filter values never
      // matched stored outcomes, so every non-transfer filter was dead.
      mockCallHistory.mockResolvedValue({
        calls: [booked, priced],
        total: 2,
        has_more: false,
      });
      render(<VoiceCallsView />);
      await waitFor(() => expect(screen.getByText('Pat Price')).toBeInTheDocument());

      fireEvent.change(screen.getByRole('combobox', { name: 'Filter calls by outcome' }), {
        target: { value: 'price' },
      });

      await waitFor(() => expect(screen.getByText('Pat Price')).toBeInTheDocument());
      // The booked call (John Smith) is filtered out of the list.
      expect(screen.queryByText('Bea Booked')).not.toBeInTheDocument();
    });

    test('HAPPY: the "No clear outcome" filter matches null-outcome (abandoned) calls', async () => {
      // WHO: an owner reviewing abandoned calls. WHAT: null outcome = the
      // no-clear-outcome bucket; that filter must surface it, not sit dead.
      // WHERE: outcomeFilter === 'no_outcome' → !c.outcome predicate.
      // WHY: "abandoned" is a derived null-outcome, not a stored literal — the
      //      old 'abandoned' option matched zero rows.
      mockCallHistory.mockResolvedValue({
        calls: [booked, noOutcome],
        total: 2,
        has_more: false,
      });
      render(<VoiceCallsView />);
      await waitFor(() => expect(screen.getByText('Nil Caller')).toBeInTheDocument());

      fireEvent.change(screen.getByRole('combobox', { name: 'Filter calls by outcome' }), {
        target: { value: 'no_outcome' },
      });

      await waitFor(() => expect(screen.getByText('Nil Caller')).toBeInTheDocument());
      expect(screen.queryByText('Bea Booked')).not.toBeInTheDocument();
    });
  });
});
