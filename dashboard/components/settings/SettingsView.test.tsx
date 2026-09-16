import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

describe('SettingsView — UX review 2026-09-15 (owner-judgment pass)', () => {
  test('HAPPY: the Password field explains the 6-character minimum before submit', async () => {
    // WHO: a super-admin filling in the Owner Account section for the first
    //        time.
    // WHAT: CreateTenantSchema (src/routes/tenants.ts) rejects owner_pass
    //        under 6 characters, but nothing on the page said so — a short
    //        password bounced back as a bare "Validation failed" with no
    //        indication which of the six submitted fields was the problem.
    // WHERE: SettingsView Owner Account section, Password field.
    // WHY: a hidden requirement that only surfaces as a generic error after
    //      submit wastes a round trip and reads like the form is broken.
    mockIsAdmin = true;
    render(<SettingsView />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Business Onboarding/i })).toBeInTheDocument()
    );
    const passwordInput = screen.getByLabelText('Password');
    expect(screen.getByText(/at least 6 characters/i)).toBeInTheDocument();
    expect(passwordInput).toHaveAttribute('aria-describedby', 'owner-pass-hint');
    expect(passwordInput).toHaveAttribute('minLength', '6');
  });

  test('SAD: the create-business error is announced as an alert, not just visible text', async () => {
    // WHO: a screen-reader super-admin submitting the onboarding form.
    // WHAT: the error banner previously had no role/live-region wiring, so a
    //        screen reader gave no indication a submission failed unless the
    //        user happened to be focused on that part of the page. Matches
    //        the same class of fix as ForwardCallsSection's forward-loop
    //        error (PR #492).
    // WHERE: SettingsView onboarding error banner.
    // WHY: an async failure that isn't announced is invisible to anyone not
    //      looking directly at the screen at the moment it appears.
    mockIsAdmin = true;
    (global.fetch as unknown as ReturnType<typeof vi.fn>) = vi.fn().mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/templates')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ business_type: 'salon', display_name: 'Salon' }],
        });
      }
      return Promise.resolve({
        ok: false,
        status: 409,
        json: async () => ({ success: false, error: 'A business named "Acme" already exists.' }),
      });
    });
    render(<SettingsView />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Business Onboarding/i })).toBeInTheDocument()
    );

    fireEvent.change(screen.getByLabelText('Company Name'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText('Business Template'), {
      target: { value: 'salon' },
    });
    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Jo' } });
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Doe' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jo@acme.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'p@ssw0rd' } });
    fireEvent.click(screen.getByRole('button', { name: /Finalize/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/already exists/i);
    expect(alert).toHaveAttribute('aria-live', 'assertive');
  });

  test('HAPPY: the success banner is a polite live region, not silent visible-only text', async () => {
    // WHO: a super-admin who just finished onboarding a new business.
    // WHAT: the success banner previously had no role/live-region wiring —
    //        same defect class as the error banner above, opposite outcome.
    // WHERE: SettingsView onboarding success banner.
    // WHY: a screen-reader user who submits and looks away needs the
    //      confirmation announced, not just rendered.
    mockIsAdmin = true;
    (global.fetch as unknown as ReturnType<typeof vi.fn>) = vi.fn().mockImplementation((url) => {
      if (typeof url === 'string' && url.includes('/templates')) {
        return Promise.resolve({
          ok: true,
          json: async () => [{ business_type: 'salon', display_name: 'Salon' }],
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, tenant_id: 'new-tenant-id' }),
      });
    });
    render(<SettingsView />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Business Onboarding/i })).toBeInTheDocument()
    );

    fireEvent.change(screen.getByLabelText('Company Name'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText('Business Template'), {
      target: { value: 'salon' },
    });
    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Jo' } });
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Doe' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jo@acme.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'p@ssw0rd' } });
    fireEvent.click(screen.getByRole('button', { name: /Finalize/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/created successfully/i);
    expect(status).toHaveAttribute('aria-live', 'polite');
  });
});
