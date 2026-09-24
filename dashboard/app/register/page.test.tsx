import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
let registerFetch: ReturnType<typeof vi.fn<(url: string, opts?: RequestInit) => Promise<unknown>>>;
let signupStatus: { success: boolean; open: boolean };
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
  // The page makes two kinds of fetch: GET /signup-status on mount (answered
  // "open" here unless a test overrides signupStatus) and POST /register
  // (scripted per test through registerFetch).
  registerFetch = vi.fn();
  signupStatus = { success: true, open: true };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, opts?: RequestInit) =>
      url.endsWith('/signup-status')
        ? Promise.resolve({ ok: true, status: 200, json: async () => signupStatus })
        : registerFetch(url, opts)
    )
  );
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
    registerFetch.mockResolvedValue({
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

    const [url, opts] = registerFetch.mock.calls[0];
    expect(url).toBe('http://test.local/register');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toMatchObject({
      business_name: 'DynaTire',
      business_type: 'salon', // default = first in the fetched templates list
      owner_name: 'Dale Demott',
      email: 'dale@dynatire.com',
      password: 'hunter2',
      // The backend requires this to be the literal boolean `true`
      // (RegisterSchema) — a client-side-only checkbox was bypassable via
      // a direct API call, so the wire body must actually carry it.
      consent_attested: true,
    });
    expect(localStorage.getItem('authToken')).toBe('jwt-abc');
    expect(localStorage.getItem('tenantId')).toBe('tenant-9');
    expect(localStorage.getItem('userName')).toBe('Dale Demott');
    // A verification link was just emailed — Billing prompts until it's clicked.
    expect(localStorage.getItem('emailVerified')).toBe('false');
  });

  test('duplicate-email (409) shows an inline error, does NOT store auth or redirect', async () => {
    // WHO: someone who already signed up | WHAT: backend returns 409, UI surfaces it and blocks the redirect | WHEN: email already in the users table | WHERE: RegisterPage handleSubmit 409 branch | WHY: a phantom redirect with no stored token would dump them on the dashboard auth-gate; the failure must keep them on the form with a clear message and never write a half-session to localStorage
    registerFetch.mockResolvedValue({
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

  test('duplicate email: says they already have an account and links to Sign in and Forgot password', async () => {
    // WHO: someone signing up with an email that already has an account
    // WHAT: the backend's "You already have an account" message, plus two links
    // WHERE: RegisterPage 409 branch
    // WHY: owner decision 2026-09-24 — one account per email; tell them plainly
    //      and give them the way back in rather than a dead end
    registerFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        error:
          "You already have an account with this email. Sign in instead — or use 'Forgot password' if you don't remember it.",
      }),
    });

    render(<RegisterPage />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Salon' })).toBeInTheDocument());
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /start free trial/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/you already have an account/i);
    // The page already has a footer "Sign in" link; these two live inside the alert.
    expect(within(alert).getByRole('link', { name: /^sign in$/i })).toHaveAttribute(
      'href',
      '/dashboard'
    );
    expect(within(alert).getByRole('link', { name: /forgot password/i })).toHaveAttribute(
      'href',
      '/forgot-password'
    );
  });

  test('a non-409 error shows no Sign in / Forgot password links', async () => {
    registerFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ success: false, error: 'Validation failed' }),
    });

    render(<RegisterPage />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Salon' })).toBeInTheDocument());
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /start free trial/i }));

    await screen.findByRole('alert');
    expect(screen.queryByRole('link', { name: /forgot password/i })).not.toBeInTheDocument();
  });

  test('connection failure shows a retry message and does not redirect', async () => {
    // WHO: a user on a flaky connection | WHAT: fetch rejects → friendly retry copy, no navigation | WHEN: the network throws | WHERE: RegisterPage handleSubmit catch | WHY: an unhandled rejection would leave the button stuck in "Creating account..."; the catch must reset state and tell the user to retry rather than fail silently
    registerFetch.mockRejectedValue(new Error('network down'));

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

describe('RegisterPage — signup switch', () => {
  test('SAD: when signups are closed, the page says so and shows no form', async () => {
    // WHO: a visitor clicking "Start free trial" before launch
    // WHAT: GET /signup-status says closed → "Sign-ups aren't open yet" with demo
    //       and sign-in links; no form, no POST /register
    // WHY: owner decision 2026-09-24 — signup is not open to the public yet
    signupStatus = { success: true, open: false };
    render(<RegisterPage />);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/sign-ups aren't open yet/i);
    expect(within(status).getByRole('link', { name: /try the live demo/i })).toHaveAttribute(
      'href',
      '/demo'
    );
    expect(within(status).getByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      '/dashboard'
    );
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(registerFetch).not.toHaveBeenCalled();
  });

  test('SAD: a 403 signup_closed from /register (switch flipped mid-visit) swaps to the closed screen', async () => {
    registerFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        error_code: 'signup_closed',
        error: "Sign-ups aren't open yet.",
      }),
    });
    render(<RegisterPage />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Salon' })).toBeInTheDocument());
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: /start free trial/i }));

    expect(await screen.findByText(/sign-ups aren't open yet/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(localStorage.getItem('authToken')).toBeNull();
  });

  test('HAPPY: if the status check fails, the form still shows (the backend still enforces)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.endsWith('/signup-status') ? Promise.reject(new Error('down')) : registerFetch(url)
      )
    );
    render(<RegisterPage />);
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
  });
});
