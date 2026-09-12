import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

// IA merge Phase 2b (2026-06-03): SettingsView is now super-admin ONLY (the
// multi-business onboarding console). The previous owner-mode (calendar/CRM/
// resources) was removed — it duplicated the Setup tab — so the old
// calendar/resource tests went with it. These tests cover the two surfaces
// that remain: the owner-facing "moved to Setup" pointer, and the super-admin
// onboarding form. (Super-admin onboarding behavior is further covered in
// settings.test.tsx.)
let mockIsAdmin = false;

vi.mock('@/lib/SessionContext', () => ({
  useSessionContext: () => ({ isAdmin: mockIsAdmin }),
  useActiveTenantId: () => 'f234e471-0e60-4163-86c9-93cfd9338e3a',
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import SettingsView from './SettingsView';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAdmin = false;
  // Templates fetch (super-admin path) returns an empty list by default.
  (global.fetch as unknown as ReturnType<typeof vi.fn>) = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => [] });
});

describe('SettingsView — super-admin only after IA merge', () => {
  test('non-super-admin sees a pointer to Setup, not a config surface', async () => {
    // WHO: an owner who hit a stale ?tab=settings link.
    // WHAT: SettingsView no longer renders owner config — it points to Setup.
    // WHEN: any non-super-admin render. WHERE: SettingsView early return.
    // WHY: owner calendar/CRM/resource config moved to the Setup tab; a second
    //      copy here would diverge. Guards against the duplicate coming back.
    mockIsAdmin = false;
    render(<SettingsView />);
    await waitFor(() => {
      expect(screen.getByText(/Settings moved/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/now\s+lives under the/i)).toBeInTheDocument();
    // The onboarding console must NOT render for a non-super-admin.
    expect(screen.queryByText(/Business Onboarding/i)).not.toBeInTheDocument();
  });

  test('super-admin sees the Business Onboarding console', async () => {
    // WHO: platform super-admin. WHAT: the multi-business onboarding form.
    // WHEN: isAdmin true. WHERE: SettingsView super-admin return.
    // WHY: this is SettingsView's sole remaining purpose post-merge.
    mockIsAdmin = true;
    render(<SettingsView />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Business Onboarding/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/Company Name/i)).toBeInTheDocument();
    expect(screen.getByText(/Owner Account/i)).toBeInTheDocument();
    // The removed owner-mode calendar surface must not appear.
    expect(screen.queryByText(/Calendar Synchronization/i)).not.toBeInTheDocument();
  });

  test('onboarding form fields are programmatically labeled (accessible name)', async () => {
    // WHO: a screen-reader / keyboard super-admin. WHAT: each field must resolve
    //      by its label — the hand-rolled <label>s had no htmlFor/id, so the
    //      inputs were unlabeled. Switching to the Input/Select `label` prop
    //      restores the htmlFor↔id association. WHERE: SettingsView onboarding
    //      form. WHY: getByLabelText only resolves when the association exists.
    mockIsAdmin = true;
    render(<SettingsView />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Business Onboarding/i })).toBeInTheDocument()
    );
    expect(screen.getByLabelText('Company Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Business Template')).toBeInTheDocument();
    expect(screen.getByLabelText('First Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Last Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });
});
