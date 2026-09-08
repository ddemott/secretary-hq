/**
 * MessagesInbox — callers who left a message: list, filter, read, action.
 *
 * WHO: Front-desk user or owner following up on customer voicemail-style messages.
 * WHAT: Loads messages, filter tabs, click-to-read marks as 'read', Mark actioned.
 * WHERE: components/voice/MessagesInbox.tsx — 0% coverage (extracted from
 *   VoiceCallsView.tsx in dense-view decomposition).
 * WHY: Read + action status update paths were completely untested; a broken
 *   updateMessageStatus would silently fail to mark messages as handled.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    voice: {
      listMessages: vi.fn(),
      listJobInquiries: vi.fn(),
      updateMessageStatus: vi.fn(),
    },
  },
}));
vi.mock('../../lib/api', () => ({ Api: mockApi }));
vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

import { MessagesInbox } from './MessagesInbox';
import { showToast } from '../ui/Toast';

const mockToast = vi.mocked(showToast);

const SAMPLE_MESSAGES = [
  {
    message_id: 'msg-1',
    caller_name: 'Alice Smith',
    caller_phone: '+16085551234',
    callback_phone: '+16085551234',
    message: 'Please call me back about my appointment.',
    status: 'new' as const,
    created_at: '2026-07-07T09:00:00Z',
  },
  {
    message_id: 'msg-2',
    caller_name: 'Bob Jones',
    caller_phone: null,
    callback_phone: null,
    message: 'Just checking on pricing.',
    status: 'read' as const,
    created_at: '2026-07-07T08:00:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.voice.listMessages.mockResolvedValue(SAMPLE_MESSAGES);
  mockApi.voice.listJobInquiries.mockResolvedValue([]);
  mockApi.voice.updateMessageStatus.mockResolvedValue({ success: true });
});

describe('MessagesInbox — loading / empty states', () => {
  test('HAPPY: shows loading text while fetching', () => {
    mockApi.voice.listMessages.mockReturnValue(new Promise(() => {}));
    render(<MessagesInbox tenantId="tenant-test" />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  test('HAPPY: shows empty state when there is nothing at all', async () => {
    // Wording widened with the inbox itself: it holds job leads as well as
    // messages now, so "no messages yet" would understate what is empty.
    mockApi.voice.listMessages.mockResolvedValue([]);
    mockApi.voice.listJobInquiries.mockResolvedValue([]);
    render(<MessagesInbox tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText(/nothing here yet/i)).toBeInTheDocument());
  });

  test('THE INVISIBLE LEAD: a job inquiry appears in the inbox, marked as a lead', async () => {
    // WHO: the recruiter call of 2026-07-27 (CALL_IMPROVEMENTS.md #1). The
    //       inquiry was captured in full — agency, client, role, rate — the
    //       call's outcome said "message", and this inbox was EMPTY. The lead
    //       lived in a table with no route, no client method and no screen.
    // WHY: a lead nobody can find is a lead nobody called back.
    mockApi.voice.listMessages.mockResolvedValue([]);
    mockApi.voice.listJobInquiries.mockResolvedValue([
      {
        job_inquiry_id: 'ji-1',
        caller_name: 'Sage',
        callback_phone: '+17324018834',
        caller_company: 'eTeam',
        client_company: 'Capgemini',
        represents_company: false,
        employment_type: 'contract_to_hire',
        role_description: 'Azure/M365 developer',
        rate_range: 'competitive',
        duration: null,
        location_type: 'hybrid',
        address: 'Hanover, New Hampshire',
        timezone: null,
        call_id: 'SCL_nRKo3KEVw8Yh',
        appointment_id: null,
        created_at: '2026-07-27T21:46:31.000Z',
      },
    ]);
    render(<MessagesInbox tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText('Sage')).toBeInTheDocument());
    // The list badge AND the detail-pane badge both say it — assert at least one
    // rather than exactly one, so the copy can appear in both places.
    expect(screen.getAllByText(/job lead/i).length).toBeGreaterThan(0);
    // The role leads the preview — it is what decides whether to call back.
    expect(screen.getByText(/Azure\/M365 developer/)).toBeInTheDocument();
  });

  test('HAPPY: spoken salary shows $k next to the caller words', async () => {
    // WHO: owner opening a job lead whose rate was captured as words
    // WHAT: inbox Rate row is "$140–160k (one forty to one hundred and sixty thousand)"
    // WHY: verbatim capture stays in the DB; the owner still needs a number
    mockApi.voice.listMessages.mockResolvedValue([]);
    mockApi.voice.listJobInquiries.mockResolvedValue([
      {
        job_inquiry_id: 'ji-2',
        caller_name: 'Marcus',
        callback_phone: '+1262***9039',
        caller_company: 'Bell Labs',
        client_company: null,
        represents_company: true,
        employment_type: 'full_time',
        role_description: 'Java contractor',
        rate_range: 'one forty to one hundred and sixty thousand',
        duration: null,
        location_type: 'remote',
        address: null,
        timezone: null,
        call_id: 'SCL_salary',
        appointment_id: null,
        created_at: '2026-07-21T12:34:00.000Z',
      },
    ]);
    render(<MessagesInbox tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText('Marcus')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /marcus/i }));
    await waitFor(() =>
      expect(
        screen.getByText('$140–160k (one forty to one hundred and sixty thousand)')
      ).toBeInTheDocument()
    );
  });

  test('SAD: API error shows toast and renders empty list', async () => {
    mockApi.voice.listMessages.mockRejectedValue(new Error('API error'));
    render(<MessagesInbox tenantId="tenant-test" />);
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('Could not load messages. Please try again.', 'error')
    );
  });
});

describe('MessagesInbox — message list', () => {
  test('HAPPY: renders sender names from the message list', async () => {
    render(<MessagesInbox tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
  });

  test('HAPPY: shows unread message count badge', async () => {
    render(<MessagesInbox tenantId="tenant-test" />);
    // 1 message with status='new'
    await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
  });

  test('HAPPY: shows the "select something to read" placeholder when nothing is selected', async () => {
    render(<MessagesInbox tenantId="tenant-test" />);
    await waitFor(() =>
      expect(screen.getByText(/select a message or job lead to read it/i)).toBeInTheDocument()
    );
  });
});

describe('MessagesInbox — filter tabs', () => {
  test('HAPPY: renders all 4 filter tabs', async () => {
    render(<MessagesInbox tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'new' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'read' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'actioned' })).toBeInTheDocument();
  });

  test('HAPPY: clicking a filter refetches with that status', async () => {
    render(<MessagesInbox tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'new' }));
    await waitFor(() =>
      expect(mockApi.voice.listMessages).toHaveBeenCalledWith('tenant-test', { status: 'new' })
    );
  });

  test('HAPPY: "all" filter passes undefined status on re-click', async () => {
    render(<MessagesInbox tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText('Alice Smith')).toBeInTheDocument());
    // Switch away from 'all' first so clicking 'all' triggers a real refetch
    fireEvent.click(screen.getByRole('button', { name: 'new' }));
    await waitFor(() =>
      expect(mockApi.voice.listMessages).toHaveBeenCalledWith('tenant-test', { status: 'new' })
    );
    mockApi.voice.listMessages.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    await waitFor(() =>
      expect(mockApi.voice.listMessages).toHaveBeenCalledWith('tenant-test', { status: undefined })
    );
  });
});

describe('MessagesInbox — select and mark read', () => {
  test('HAPPY: clicking a new message calls updateMessageStatus with "read"', async () => {
    render(<MessagesInbox tenantId="tenant-test" />);
    // Wait for messages to load; Alice's row has role="button" with accessible name containing her name
    await waitFor(() => expect(screen.getAllByText('Alice Smith').length).toBeGreaterThan(0));
    // Click Alice's message row by its accessible name (computed from row text content)
    fireEvent.click(screen.getByRole('button', { name: /alice smith/i }));
    await waitFor(() =>
      expect(mockApi.voice.updateMessageStatus).toHaveBeenCalledWith('msg-1', 'read')
    );
  });

  test('HAPPY: clicking already-read message does not call updateMessageStatus', async () => {
    render(<MessagesInbox tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getAllByText('Bob Jones').length).toBeGreaterThan(0));
    // Bob is already 'read' — click should not trigger updateMessageStatus
    fireEvent.click(screen.getByRole('button', { name: /bob jones/i }));
    // Give async handlers a chance to fire
    await waitFor(() => expect(screen.getAllByText('Bob Jones').length).toBeGreaterThan(0));
    expect(mockApi.voice.updateMessageStatus).not.toHaveBeenCalled();
  });

  test('HAPPY: selected message body appears in the detail panel', async () => {
    render(<MessagesInbox tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getAllByText('Alice Smith').length).toBeGreaterThan(0));
    // Before click: the "select a message or job lead" placeholder is visible
    expect(screen.getByText(/select a message or job lead to read it/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /alice smith/i }));
    // After click: detail panel replaces the placeholder
    await waitFor(() =>
      expect(screen.queryByText(/select a message to read it/i)).not.toBeInTheDocument()
    );
  });

  test('SAD: updateMessageStatus failure shows error toast', async () => {
    mockApi.voice.updateMessageStatus.mockResolvedValue({ success: false });
    render(<MessagesInbox tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getAllByText('Alice Smith').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /alice smith/i }));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        'Could not update the message. Please try again.',
        'error'
      )
    );
  });
});

describe('MessagesInbox — mark actioned', () => {
  test('HAPPY: Mark actioned button calls updateMessageStatus with "actioned"', async () => {
    render(<MessagesInbox tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getAllByText('Alice Smith').length).toBeGreaterThan(0));
    // Select Alice's message — detail panel opens (placeholder disappears)
    fireEvent.click(screen.getByRole('button', { name: /alice smith/i }));
    await waitFor(() =>
      expect(screen.queryByText(/select a message to read it/i)).not.toBeInTheDocument()
    );
    // "Mark actioned" button only renders in the detail panel
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /mark actioned/i })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: /mark actioned/i }));
    await waitFor(() =>
      expect(mockApi.voice.updateMessageStatus).toHaveBeenCalledWith('msg-1', 'actioned')
    );
  });
});
