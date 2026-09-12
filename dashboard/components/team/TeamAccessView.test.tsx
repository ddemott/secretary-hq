/**
 * TeamAccessView tests — the Logins sub-tab under Back Office.
 *
 * The view is the only place an owner can: see who has a login, change
 * a teammate's role, and invite a new login. It also enforces a UI-side
 * guardrail: an owner cannot edit their own role (the API rejects it
 * too, but the UI should never even let them try). These tests pin both
 * the happy paths and the self-edit guard.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

const TENANT_ID = 'f234e471-0e60-4163-86c9-93cfd9338e3a';

vi.mock('@/lib/SessionContext', () => ({
  useActiveTenantId: () => TENANT_ID,
}));

// Toast is not under test — stub it so we don't render the portal.
vi.mock('../ui/Toast', () => ({
  showToast: vi.fn(),
}));

import TeamAccessView from './TeamAccessView';
import { showToast } from '../ui/Toast';

const ownerRow = {
  user_id: 'owner-1',
  email: 'owner@biz.com',
  full_name: 'Owner Boss',
  role: 'owner' as const,
  created_at: '2026-01-01',
  is_self: true,
};
const deskRow = {
  user_id: 'desk-1',
  email: 'desk@biz.com',
  full_name: 'Desk Staff',
  role: 'front_desk' as const,
  created_at: '2026-02-01',
  is_self: false,
};

function mockListResponse(users: (typeof ownerRow | typeof deskRow)[]) {
  return {
    ok: true,
    json: async () => ({ success: true, users }),
  } as unknown as Response;
}

function mockMutateResponse(body: Record<string, unknown> = {}) {
  return {
    ok: true,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('tenantId', TENANT_ID);
  (global.fetch as unknown as ReturnType<typeof vi.fn>) = vi.fn();
});

describe('TeamAccessView — list rendering', () => {
  test('HAPPY: renders one row per teammate with role label + self badge', async () => {
    // WHO: tenant owner opening Back Office → Logins
    // WHAT: GET /users response is rendered as a list with the owner's
    //       own row tagged "You" and each row showing email + role
    // WHY: this is the reassurance step — owners should see at a glance
    //      who has access, in what role, and can spot anomalies (a
    //      teammate accidentally promoted to owner, an old account
    //      that should be removed, etc.)
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockListResponse([ownerRow, deskRow])
    );

    render(<TeamAccessView />);

    await waitFor(() => {
      expect(screen.getByText('Owner Boss')).toBeInTheDocument();
      expect(screen.getByText('Desk Staff')).toBeInTheDocument();
    });
    // The current user's row gets a "You" badge
    expect(screen.getByText('You')).toBeInTheDocument();
    // Both rows render their email
    expect(screen.getByText('owner@biz.com')).toBeInTheDocument();
    expect(screen.getByText('desk@biz.com')).toBeInTheDocument();
  });

  test('HAPPY: empty state renders when no users come back', async () => {
    // WHO: owner of a brand-new tenant who hasn't invited anyone yet
    //      (note: this state is rare in practice — the tenant always
    //      has at least the owner's own login — but the view should
    //      handle the "empty list" branch without crashing)
    // WHAT: list is empty → friendly "Invite your first teammate" copy
    // WHY: avoids a blank rectangle that looks like a bug
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockListResponse([]));

    render(<TeamAccessView />);

    await waitFor(() => {
      expect(screen.getByText(/no team logins yet/i)).toBeInTheDocument();
    });
  });
});

describe('TeamAccessView — self-edit guard', () => {
  test('SAD: own-row role dropdown is disabled — UI-side foot-gun guard', async () => {
    // WHO: owner mousing toward their own role dropdown
    // WHAT: select element rendered with `disabled` attribute
    // WHEN: every render where the row's is_self flag is true
    // WHERE: <select disabled={u.is_self || ...}> in TeamAccessView
    // WHY: an owner who demotes themselves to front_desk loses Back
    //      Office on next refresh AND loses the Logins sub-tab where
    //      they could undo the change — a hard lockout requiring SQL.
    //      The API rejects this with 400 too, but the UI should never
    //      let it be attempted.
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockListResponse([ownerRow, deskRow])
    );

    render(<TeamAccessView />);

    await waitFor(() => {
      expect(screen.getByText('Owner Boss')).toBeInTheDocument();
    });
    const ownSelect = screen.getByLabelText<HTMLSelectElement>('Role for owner@biz.com');
    const otherSelect = screen.getByLabelText<HTMLSelectElement>('Role for desk@biz.com');
    expect(ownSelect).toBeDisabled();
    expect(otherSelect).not.toBeDisabled();
  });
});

describe('TeamAccessView — revoke sessions', () => {
  test('SAD: a thrown network error clears the row loading state and toasts', async () => {
    // WHO: an owner clicking "Log out sessions" on a teammate's row when the
    //      network drops mid-request.
    // WHAT: apiMutate rethrows fetch/network failures. The onConfirm handler
    //       must catch the throw, surface an error toast, and — critically —
    //       clear pendingRevokeId in a finally so the row's button doesn't stay
    //       stuck spinning (disabled + aria-busy) forever.
    // WHEN: fetch on the /revoke-sessions POST rejects.
    // WHERE: handleRevokeSessions try/catch/finally in TeamAccessView.
    // WHY: before the fix the throw skipped setPendingRevokeId(null), leaving
    //      the teammate's button permanently disabled with no feedback.
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (url: string, init?: RequestInit) => {
        if (url.includes('/revoke-sessions') && init?.method === 'POST') {
          // Plain Error (not a TypeError 'Failed to fetch') so the api layer's
          // localhost cert-redirect branch stays dormant — we only exercise the
          // rethrow path the component must guard.
          return Promise.reject(new Error('network down'));
        }
        return Promise.resolve(mockListResponse([ownerRow, deskRow]));
      }
    );

    render(<TeamAccessView />);
    await waitFor(() => screen.getByText('Desk Staff'));

    // Open the confirm modal for the (non-self) desk teammate, then confirm.
    fireEvent.click(screen.getByRole('button', { name: /log out desk@biz\.com's sessions/i }));
    fireEvent.click(await screen.findByRole('button', { name: /log out their sessions/i }));

    // The error toast fires…
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/network down/i), 'error');
    });
    // …and the row button is no longer stuck in its loading (disabled) state.
    const rowButton = screen.getByRole('button', {
      name: /log out desk@biz\.com's sessions/i,
    });
    await waitFor(() => expect(rowButton).not.toBeDisabled());
    expect(rowButton).not.toHaveAttribute('aria-busy', 'true');
  });
});

describe('TeamAccessView — invite flow', () => {
  test('HAPPY: clicking Invite opens the modal with role + name + email fields', async () => {
    // WHO: owner clicking the Invite button
    // WHAT: modal renders with form fields and a default role of
    //       Front Desk (the safer default — promoting later is one
    //       click; demoting an accidental owner is one click too,
    //       but defaulting to Front Desk avoids privilege drift)
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockListResponse([ownerRow]));

    render(<TeamAccessView />);
    await waitFor(() => screen.getByText('Owner Boss'));
    fireEvent.click(screen.getByRole('button', { name: /invite/i }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    // Default role is front_desk → that radio is checked
    const frontDeskRadio = screen.getByRole<HTMLInputElement>('radio', { name: /front desk/i });
    expect(frontDeskRadio.checked).toBe(true);
  });

  test('HAPPY: submitting the invite form POSTs to /users/invite and closes the modal', async () => {
    // WHO: owner submitting a valid invite
    // WHAT: fetch is called against /users/invite with the form
    //       payload (email lowercased by the backend, but the UI
    //       sends what the user typed); on success the modal closes
    //       and the list reloads
    // WHY: the round-trip is the contract — if the form silently
    //      drops a field or hits the wrong URL, an owner thinks the
    //      invite went out when it didn't
    let listCalls = 0;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (url: string, init?: RequestInit) => {
        if (url.includes('/users/invite') && init?.method === 'POST') {
          return Promise.resolve(mockMutateResponse({ success: true, user_id: 'new-1' }));
        }
        // GET /users — return only owner on first load, then both rows after invite
        listCalls += 1;
        const list = listCalls === 1 ? [ownerRow] : [ownerRow, deskRow];
        return Promise.resolve(mockListResponse(list));
      }
    );

    render(<TeamAccessView />);
    await waitFor(() => screen.getByText('Owner Boss'));
    fireEvent.click(screen.getByRole('button', { name: /invite/i }));

    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'New Hire' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@biz.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // Verify the invite POST happened with the right payload shape
    const inviteCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('/users/invite')
    );
    expect(inviteCall).toBeDefined();
    const body = JSON.parse((inviteCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      tenant_id: TENANT_ID,
      email: 'new@biz.com',
      full_name: 'New Hire',
      role: 'front_desk',
    });
  });
});
