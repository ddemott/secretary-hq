/**
 * ProfileView Tests
 * Tests user profile display, theme selection, and admin status rendering.
 * Each section has happy + sad paths with 5W diagnostic context.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

// Mock the contexts
const mockSetTheme = vi.fn();
let mockTheme = 'dark';
let mockUserName: string | null = 'Dale Cooper';
let mockUserEmail: string | null = 'dale@secretaryhq.com';
let mockIsAdmin = false;

// Session-revoke collaborators — the api call, the hard-logout, and the toast.
const mockRevokeMySessions = vi.fn();
const mockForceLogout = vi.fn();
const mockShowToast = vi.fn();

vi.mock('../../lib/api', () => ({
  Api: { users: { revokeMySessions: () => mockRevokeMySessions() } },
  forceLogout: () => mockForceLogout(),
}));

vi.mock('../ui/Toast', () => ({
  showToast: (...args: unknown[]) => mockShowToast(...args),
}));

vi.mock('../../lib/SessionContext', () => ({
  useSessionContext: () => ({
    userName: mockUserName,
    userEmail: mockUserEmail,
    isAdmin: mockIsAdmin,
  }),
}));

vi.mock('@/lib/ThemeContext', () => ({
  useTheme: () => ({
    theme: mockTheme,
    setTheme: mockSetTheme,
  }),
  THEMES: [
    { id: 'dark', name: 'Dark', description: 'Dark mode', preview: { accent: '#3b82f6' } },
    { id: 'light', name: 'Light', description: 'Light mode', preview: { accent: '#2563eb' } },
    { id: 'midnight', name: 'Midnight', description: 'Deep blue', preview: { accent: '#6366f1' } },
    { id: 'nord', name: 'Nord', description: 'Arctic inspired', preview: { accent: '#88c0d0' } },
    { id: 'sunset', name: 'Sunset', description: 'Warm tones', preview: { accent: '#f97316' } },
    { id: 'forest', name: 'Forest', description: 'Nature green', preview: { accent: '#22c55e' } },
    {
      id: 'high-contrast',
      name: 'High Contrast',
      description: 'Accessibility',
      preview: { accent: '#ffffff' },
    },
    { id: 'solarized', name: 'Solarized', description: 'Classic', preview: { accent: '#b58900' } },
  ],
}));

// Import after mocks
import ProfileView from './ProfileView';

describe('ProfileView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTheme = 'dark';
    mockUserName = 'Dale Cooper';
    mockUserEmail = 'dale@secretaryhq.com';
    mockIsAdmin = false;
  });

  describe('Happy Paths', () => {
    test('renders profile header with title and description', () => {
      render(<ProfileView />);
      expect(screen.getByText('My Profile')).toBeInTheDocument();
      expect(screen.getByText('Your account details and preferences')).toBeInTheDocument();
      // WHO: all users | WHAT: profile page header
      // WHEN: navigating to profile | WHERE: ProfileView header
      // WHY: users need to identify they're on profile page
    });

    test('displays user name and email correctly', () => {
      render(<ProfileView />);
      expect(screen.getByText('Dale Cooper')).toBeInTheDocument();
      expect(screen.getByText('dale@secretaryhq.com')).toBeInTheDocument();
      // WHO: authenticated user | WHAT: account info display
      // WHEN: viewing profile | WHERE: Account section
      // WHY: users need to verify their account details
    });

    test('shows user initial avatar when name is provided', () => {
      render(<ProfileView />);
      expect(screen.getByText('D')).toBeInTheDocument();
      // WHO: all users | WHAT: avatar initial
      // WHEN: rendering profile | WHERE: avatar circle
      // WHY: visual identity without uploaded photo
    });

    test('displays all 8 theme options', () => {
      render(<ProfileView />);
      expect(screen.getByText('Dark')).toBeInTheDocument();
      expect(screen.getByText('Light')).toBeInTheDocument();
      expect(screen.getByText('Midnight')).toBeInTheDocument();
      expect(screen.getByText('Nord')).toBeInTheDocument();
      expect(screen.getByText('Sunset')).toBeInTheDocument();
      expect(screen.getByText('Forest')).toBeInTheDocument();
      expect(screen.getByText('High Contrast')).toBeInTheDocument();
      expect(screen.getByText('Solarized')).toBeInTheDocument();
      // WHO: all users | WHAT: theme picker options
      // WHEN: viewing appearance section | WHERE: Appearance card
      // WHY: users can customize dashboard appearance
    });

    test('calls setTheme when theme button is clicked', () => {
      render(<ProfileView />);
      fireEvent.click(screen.getByText('Light'));
      expect(mockSetTheme).toHaveBeenCalledWith('light');
      // WHO: user | WHAT: theme selection
      // WHEN: clicking theme option | WHERE: Appearance section
      // WHY: persist user's visual preference
    });

    test('shows admin badge when user is admin', () => {
      mockIsAdmin = true;
      render(<ProfileView />);
      expect(screen.getByText('Admin')).toBeInTheDocument();
      // WHO: admin users | WHAT: admin badge indicator
      // WHEN: admin views profile | WHERE: Account section
      // WHY: admins need to see their elevated role
    });

    test('shows factual security info instead of placeholder', () => {
      // WHO: any user viewing profile | WHAT: security card shows real account
      //      facts (session expiry, password change path) instead of "coming soon"
      // WHEN: viewing profile | WHERE: Security card
      // WHY: "coming soon" was a dead placeholder — replaced with durable facts
      //      (session expiry + password-change instruction) that stay accurate
      render(<ProfileView />);
      expect(screen.getByText(/sessions expire after 8 hours/i)).toBeInTheDocument();
    });
  });

  describe('Sad Paths', () => {
    test('displays fallback text when userName is null', () => {
      mockUserName = null;
      render(<ProfileView />);
      expect(screen.getAllByText('Not set').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('U')).toBeInTheDocument(); // Avatar initial
      // WHO: user with missing name data | WHAT: graceful fallback
      // WHEN: name not in session | WHERE: Account section
      // WHY: prevent blank display if session data incomplete
    });

    test('displays fallback text when userEmail is null', () => {
      mockUserEmail = null;
      render(<ProfileView />);
      expect(screen.getAllByText('Not set').length).toBeGreaterThanOrEqual(1);
      // WHO: user with missing email data | WHAT: graceful fallback
      // WHEN: email not in session | WHERE: Account section
      // WHY: prevent blank display if session data incomplete
    });

    test('does not show admin badge when user is not admin', () => {
      mockIsAdmin = false;
      render(<ProfileView />);
      expect(screen.queryByText('Admin')).not.toBeInTheDocument();
      // WHO: regular users | WHAT: no admin badge
      // WHEN: non-admin views profile | WHERE: Account section
      // WHY: admins badge should only appear for elevated users
    });

    test('handles empty string userName', () => {
      mockUserName = '';
      render(<ProfileView />);
      expect(screen.getAllByText('Not set').length).toBeGreaterThanOrEqual(1);
      // WHO: user with empty name | WHAT: empty string handling
      // WHEN: empty string in session | WHERE: Account section
      // WHY: empty string is falsy, should fall back
    });
  });

  describe('Revoke all sessions', () => {
    test('SAD: a thrown api error resets the button and toasts (no forceLogout)', async () => {
      // WHO: a user clicking "Log out of all sessions" when the request throws
      //      (network drop / api rethrow) rather than returning {success:false}.
      // WHAT: the onConfirm handler must catch the throw, show an error toast,
      //       reset `revoking` in finally so the button stops spinning, and must
      //       NOT call forceLogout (we only leave the page on a real success).
      // WHEN: Api.users.revokeMySessions() rejects.
      // WHERE: handleRevokeAllSessions try/catch/finally in ProfileView.
      // WHY: before the fix the throw skipped setRevoking(false), leaving the
      //      danger button permanently disabled with zero feedback.
      mockRevokeMySessions.mockRejectedValueOnce(new Error('boom'));
      render(<ProfileView />);

      fireEvent.click(screen.getByRole('button', { name: /log out of all sessions/i }));
      // Confirm in the modal (danger confirmLabel).
      fireEvent.click(await screen.findByRole('button', { name: /log out everywhere/i }));

      await waitFor(() => {
        expect(mockShowToast).toHaveBeenCalledWith(expect.stringMatching(/boom/i), 'error');
      });
      // Success-only side effect must NOT fire on the throw path.
      expect(mockForceLogout).not.toHaveBeenCalled();
      // The button is released from its loading state.
      const button = screen.getByRole('button', { name: /log out of all sessions/i });
      await waitFor(() => expect(button).not.toBeDisabled());
    });

    test('HAPPY: a successful revoke calls forceLogout (page unmounts)', async () => {
      // WHO: a user confirming the self-revoke successfully.
      // WHAT: on {success:true} the handler calls forceLogout() to clear the
      //       now-invalid token and hard-navigate to login.
      // WHERE: handleRevokeAllSessions success branch in ProfileView.
      // WHY: pins that the finally-reset refactor kept the success behavior.
      mockRevokeMySessions.mockResolvedValueOnce({ success: true });
      render(<ProfileView />);

      fireEvent.click(screen.getByRole('button', { name: /log out of all sessions/i }));
      fireEvent.click(await screen.findByRole('button', { name: /log out everywhere/i }));

      await waitFor(() => expect(mockForceLogout).toHaveBeenCalledTimes(1));
      expect(mockShowToast).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    test('handles single character name', () => {
      mockUserName = 'X';
      render(<ProfileView />);
      // Single char displays as both name and avatar - expect 2 instances
      const elements = screen.getAllByText('X');
      expect(elements.length).toBeGreaterThanOrEqual(1);
    });

    test('handles lowercase first character in avatar', () => {
      mockUserName = 'dale';
      render(<ProfileView />);
      expect(screen.getByText('D')).toBeInTheDocument();
      // Avatar should uppercase first letter
    });

    test('multiple theme clicks update correctly', () => {
      render(<ProfileView />);
      fireEvent.click(screen.getByText('Light'));
      fireEvent.click(screen.getByText('Midnight'));
      fireEvent.click(screen.getByText('Nord'));
      expect(mockSetTheme).toHaveBeenCalledTimes(3);
      expect(mockSetTheme).toHaveBeenLastCalledWith('nord');
    });

    test('renders section headers correctly', () => {
      render(<ProfileView />);
      expect(screen.getByText('Account')).toBeInTheDocument();
      expect(screen.getByText('Appearance')).toBeInTheDocument();
    });

    test('the active theme button exposes its selected state via aria-pressed', () => {
      // WHO: a keyboard/screen-reader user choosing a theme. WHAT: the current
      // theme (mockTheme='dark') must announce as pressed; others as not — the
      // selection was previously conveyed by color only. WHERE: ProfileView theme
      // buttons aria-pressed. WHY: color-only state is invisible to assistive tech.
      render(<ProfileView />);
      // The button's accessible name is its name + description ("Dark Dark mode").
      expect(screen.getByRole('button', { name: /Dark mode/ })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      expect(screen.getByRole('button', { name: /Light mode/ })).toHaveAttribute(
        'aria-pressed',
        'false'
      );
    });
  });

  describe('UX review 2026-09-15 (owner-judgment pass)', () => {
    test('HAPPY: the Appearance section says the theme choice is browser-local, not account-wide', () => {
      // WHO: an owner who picks a theme here, then opens the dashboard on a
      //      second device or browser.
      // WHAT: the page header calls this page "Your account details and
      //      preferences", but setTheme() (ThemeContext.tsx) only ever writes
      //      to localStorage — there is no backend column and nothing syncs
      //      it, verified by grep (zero "theme" references in dashboard/lib/
      //      api.ts or src/routes/users.ts). Without a caption, the "account
      //      preferences" framing implies persistence this control doesn't
      //      have, and the owner lands back on Navy elsewhere with no
      //      explanation.
      // WHERE: ProfileView "Appearance" fieldset.
      // WHY: honest scope beats a silent surprise — same "don't overclaim"
      //      rule the Speaking-pace caption follows on AIConfigView (#492).
      render(<ProfileView />);
      expect(screen.getByText(/saved to this browser only.*won.t follow you/i)).toBeInTheDocument();
    });

    test('HAPPY: the Change password link explains what clicking it does', () => {
      // WHO: an owner in the Security card deciding whether to click "Change
      //      password", which navigates away from the dashboard entirely.
      // WHAT: the other two rows in this fieldset each explain themselves
      //      (the session-expiry fact; the log-out-everywhere caption below
      //      the danger button) — this link was the one control with zero
      //      indication of what happens next before leaving the page.
      // WHERE: ProfileView "Security" fieldset, the Change password row.
      // WHY: a control with no explanation next to two that have one reads
      //      as inconsistent and leaves the owner guessing whether they're
      //      about to be signed out, asked for their current password, or
      //      something else entirely.
      render(<ProfileView />);
      expect(
        screen.getByText(/emails a reset link to your account address.*30 minutes/i)
      ).toBeInTheDocument();
      // The caption sits with the link, not buried in the log-out paragraph.
      const link = screen.getByRole('link', { name: /change password/i });
      expect(link).toHaveAttribute('href', '/forgot-password');
    });

    test('SAD: the Appearance caption stays put across a theme switch (no reappearing/duplicating copy)', () => {
      // WHO: an owner clicking through multiple themes in one sitting.
      // WHAT: the new caption is static guidance, not state-dependent — it
      //      must render exactly once regardless of which theme is active,
      //      unlike the aria-pressed state which does change per-button.
      // WHERE: ProfileView "Appearance" fieldset.
      // WHY: guards against a future edit accidentally duplicating the
      //      caption per theme button instead of once for the section.
      render(<ProfileView />);
      fireEvent.click(screen.getByText('Light'));
      expect(screen.getAllByText(/saved to this browser only/i)).toHaveLength(1);
    });
  });
});
