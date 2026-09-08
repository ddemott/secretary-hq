import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock the API module: API_BASE_URL is read by the page's direct fetch, and
// Api.templates.list populates the business-type picker.
const { mockApi } = vi.hoisted(() => ({
  mockApi: { templates: { list: vi.fn() } },
}));
vi.mock('@/lib/api', () => ({
  API_BASE_URL: 'http://test.local',
  Api: mockApi,
}));

import RegisterPage from './page';

// jsdom doesn't implement navigation; replace window.location with a writable
// stub so the page's success redirect (`window.location.href = '/dashboard'`)
// is observable instead of throwing.
let originalLocation: Location;
beforeEach(() => {
  originalLocation = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: '' },
  });
  localStorage.clear();
  mockApi.templates.list.mockReset().mockResolvedValue([
    { business_type: 'salon', display_name: 'Salon' },
    { business_type: 'auto-shop', display_name: 'Auto Shop' },
  ]);
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.unstubAllGlobals();
});

function fillForm() {
  fireEvent.change(screen.getByLabelText('Business name'), { target: { value: 'DynaTire' } });
  // Business type no longer auto-picks the first option (2026-05-28 UX fix —
  // the blank default placeholder forces a deliberate selection). Must be
  // explicitly chosen in tests that assert the submitted body.
  fireEvent.change(screen.getByLabelText('Business type'), { target: { value: 'salon' } });
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Dale Demott' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dale@dynatire.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
  fireEvent.click(
    screen.getByRole('checkbox', { name: /I am authorized to set up Secretary HQ/i })
  );
}

describe('RegisterPage — self-serve signup', () => {
  test('Start free trial stays disabled until the legal checkbox is ticked', async () => {
    render(<RegisterPage />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Salon' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Business name'), { target: { value: 'DynaTire' } });
    fireEvent.change(screen.getByLabelText('Business type'), { target: { value: 'salon' } });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Dale Demott' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dale@dynatire.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    expect(screen.getByRole('button', { name: /start free trial/i })).toBeDisabled();
    expect(screen.getByRole('link', { name: /Terms of Service/i })).toHaveAttribute(
      'href',
      '/terms'
    );
    expect(screen.getByRole('link', { name: /Privacy Policy/i })).toHaveAttribute(
      'href',
      '/privacy'
    );
    expect(screen.getByRole('link', { name: /Data Protection Addendum/i })).toHaveAttribute(
      'href',
      '/dpa'
    );
  });

  test('loads business types from the public templates endpoint into the picker', async () => {
    // WHO: a prospect opening signup | WHAT: the business-type <select> is populated from /templates | WHEN: page mounts | WHERE: RegisterPage useEffect → Api.templates.list | WHY: the values must match what the backend stores, so the picker is sourced from the same public endpoint TenantCreateForm uses — a hardcoded list would drift from the templates table
    render(<RegisterPage />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Salon' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Auto Shop' })).toBeInTheDocument();
  });

  test('successful signup POSTs to /register, stores auth, and redirects to the dashboard', async () => {
    // WHO: a new business owner | WHAT: valid form → POST /register → token stored → land signed-in | WHEN: submit succeeds (201) | WHERE: RegisterPage handleSubmit happy path | WHY: this is the whole feature — the backend endpoint existed for months with no UI; the contract is "fill the form and you're in", so the test pins the request shape, the localStorage keys the dashboard authenticates off, and the redirect
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        success: true,
        tenant_id: 'tenant-9',
        user_id: 'user-9',
        user_name: 'Dale Demott',
        role: 'owner',
        token: 'jwt-abc',
      }),
    });

    render(<RegisterPage />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Salon' })).toBeInTheDocument());
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /start free trial/i }));

    await waitFor(() => expect(window.location.href).toBe('/dashboard'));

    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://test.local/register');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toMatchObject({
      business_name: 'DynaTire',
      business_type: 'salon', // default = first in the fetched templates list
      owner_name: 'Dale Demott',
      email: 'dale@dynatire.com',
      password: 'hunter2',
    });
    expect(localStorage.getItem('authToken')).toBe('jwt-abc');
    expect(localStorage.getItem('tenantId')).toBe('tenant-9');
    expect(localStorage.getItem('userName')).toBe('Dale Demott');
  });

  test('duplicate-email (409) shows an inline error, does NOT store auth or redirect', async () => {
    // WHO: someone who already signed up | WHAT: backend returns 409, UI surfaces it and blocks the redirect | WHEN: email already in the users table | WHERE: RegisterPage handleSubmit 409 branch | WHY: a phantom redirect with no stored token would dump them on the dashboard auth-gate; the failure must keep them on the form with a clear message and never write a half-session to localStorage
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ success: false, error: 'An account with that email already exists.' }),
    });

    render(<RegisterPage />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Salon' })).toBeInTheDocument());
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /start free trial/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('already exists'));
    expect(localStorage.getItem('authToken')).toBeNull();
    expect(window.location.href).toBe('');
  });

  test('connection failure shows a retry message and does not redirect', async () => {
    // WHO: a user on a flaky connection | WHAT: fetch rejects → friendly retry copy, no navigation | WHEN: the network throws | WHERE: RegisterPage handleSubmit catch | WHY: an unhandled rejection would leave the button stuck in "Creating account..."; the catch must reset state and tell the user to retry rather than fail silently
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));

    render(<RegisterPage />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Salon' })).toBeInTheDocument());
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /start free trial/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/connect/i));
    expect(window.location.href).toBe('');
  });

  test('a11y: the password field announces its length requirement (aria-describedby)', async () => {
    // WHO: a screen-reader user creating an account | WHAT: the "at least 6
    // characters" rule is exposed as the field's accessible description, not just
    // a placeholder (which AT does not reliably announce) | WHERE: RegisterPage
    // password input + #reg-password-hint | WHY: an unannounced rule means a
    // confusing rejection on submit.
    render(<RegisterPage />);
    const pw = await screen.findByLabelText('Password');
    expect(pw).toHaveAccessibleDescription(/at least 6 characters/i);
  });
});
