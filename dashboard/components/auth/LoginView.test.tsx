/**
 * LoginView tests — copy, affordances, and a11y.
 *
 * These tests assert on behavior a user would notice, not implementation
 * details. They catch the kind of regression where someone swaps in
 * placeholder copy during a refactor ("Portal", "Multi-Tenant Management
 * Console") or removes an affordance (show-password, trial link).
 *
 * Each test has happy + sad paths with 5W comments.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import LoginView from './LoginView';

// Mock fetch for submit tests — tests never hit a real network.
const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn();
  // Clear localStorage between tests so auth-success doesn't leak state
  window.localStorage.clear();
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('LoginView copy', () => {
  test('HAPPY: shows customer-facing product name, not internal portal jargon', () => {
    // WHO: Prospective tire-shop / salon / trades owner landing on the login page
    // WHAT: Sees "Secretary HQ" + "Your AI Receptionist" — product-framed copy
    // WHY: Previous "Multi-Tenant Management Console" subtitle violated Nielsen
    //       H2 (match between system and real world) — made the page read like
    //       an internal admin tool
    render(<LoginView onLoginSuccess={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /secretary hq/i })).toBeInTheDocument();
    expect(screen.getByText(/your AI receptionist/i)).toBeInTheDocument();
    expect(screen.queryByText(/multi-tenant/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/portal/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ready for live integration/i)).not.toBeInTheDocument();
  });

  test('HAPPY: submit button says "Sign in", not "Sign In to Dashboard"', () => {
    // WHAT: Button label is short and task-oriented — UX writing principle
    //        of front-loading meaning and avoiding redundancy
    render(<LoginView onLoginSuccess={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /^sign in$/i });
    expect(btn).toBeInTheDocument();
  });

  test('HAPPY: loading label is "Signing in...", not "Verifying..."', async () => {
    // WHAT: "Signing in..." is task-oriented; "Verifying..." was technical
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        })
    );
    render(<LoginView onLoginSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/signing in/i)).toBeInTheDocument();
    expect(screen.queryByText(/verifying/i)).not.toBeInTheDocument();
  });

  test('HAPPY: surfaces customer-friendly connection error, not dev-speak', async () => {
    // WHO: Customer with flaky wifi hitting the login page
    // WHAT: Error message is actionable and non-technical
    // WHY: "Is the backend server running?" (old copy) was developer-speak
    //        the end user can do nothing about
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network'));
    render(<LoginView onLoginSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't connect/i);
    expect(alert).not.toHaveTextContent(/backend server/i);
  });

  test("SAD: a rate-limited login shows the plugin's actual wait time, not the bare HTTP reason phrase", async () => {
    // WHO: An owner who mistyped their password a few times in a row
    // WHAT: /login is rate-limited (5 attempts / 5 min); Fastify's
    //        @fastify/rate-limit plugin answers 429 with its OWN error shape —
    //        `error: "Too Many Requests"` (a generic HTTP reason phrase) and
    //        `message: "Rate limit exceeded, retry in 1 minute"` (the actually
    //        useful part). The old code read only `data.error`, so a locked-out
    //        owner saw "Too Many Requests" with no idea how long to wait —
    //        a control (the form) in a temporarily-blocked state with no
    //        explanation of what to do next.
    // WHY: don't show a dead-end message when the response carries a better one
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 429,
      json: () =>
        Promise.resolve({
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'Rate limit exceeded, retry in 1 minute',
        }),
    });
    render(<LoginView onLoginSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/retry in 1 minute/i);
    expect(alert).not.toHaveTextContent(/^too many requests$/i);
  });
});

describe('LoginView affordances', () => {
  test('HAPPY: signup link gives credential-less prospects a real exit', () => {
    // WHO: Prospect who bookmarked /dashboard directly or followed a
    //       stale link without ever seeing the landing page
    // WHAT: A visible "Create an account" CTA routes them to self-serve signup
    // WHY: The "Start your free trial" link once pointed at /?trial=true
    //       with no signup flow behind it (dead end → marketing copy); UX
    //       audit #8 (2026-05-18) swapped it for a mailto placeholder until
    //       signup landed. Self-serve signup now exists at /register, so the
    //       CTA points there. Test pins both the new text AND the /register
    //       href so a regression back to a dead route/mailto fails loudly.
    render(<LoginView onLoginSuccess={vi.fn()} />);
    const link = screen.getByRole('link', { name: /create an account/i });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('/register');
  });

  test('HAPPY: forgot-password link is preserved', () => {
    // WHY: Easy to accidentally drop during a refactor — pin it explicitly
    render(<LoginView onLoginSuccess={vi.fn()} />);
    expect(screen.getByRole('link', { name: /forgot password/i })).toHaveAttribute(
      'href',
      '/forgot-password'
    );
  });

  test('HAPPY: show/hide password toggle works and updates aria-pressed', () => {
    // WHO: Caller with a hard-to-type password trying to debug typos
    // WHAT: Eye icon toggles input type between password and text;
    //        aria-pressed tracks state for assistive tech
    // WHY: A common friction point — without this, password typos become
    //        "your password is wrong" mysteries
    render(<LoginView onLoginSuccess={vi.fn()} />);
    const password = screen.getByLabelText<HTMLInputElement>(/^password$/i);
    expect(password.type).toBe('password');

    const toggle = screen.getByRole('button', { name: /show password/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);
    expect(password.type).toBe('text');
    expect(screen.getByRole('button', { name: /hide password/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  test('HAPPY: email input has autoComplete="username" so password managers can fill', () => {
    // WHY: Without this, 1Password / Bitwarden / browser autofill don't
    //        populate the login — measurable friction for returning users
    render(<LoginView onLoginSuccess={vi.fn()} />);
    expect(screen.getByLabelText(/email/i)).toHaveAttribute('autoComplete', 'username');
  });
});

describe('LoginView accessibility', () => {
  test('HAPPY: labels are associated with inputs via htmlFor/id', () => {
    // WHY: Screen readers need the label-input association to announce
    //        the input purpose. getByLabelText succeeds only when the
    //        association is correctly wired.
    render(<LoginView onLoginSuccess={vi.fn()} />);
    const email = screen.getByLabelText(/email/i);
    const password = screen.getByLabelText(/^password$/i);
    expect(email.id).toBe('login-email');
    expect(password.id).toBe('login-password');
  });

  test('HAPPY: error messages announce via role=alert', () => {
    // WHY: Screen readers read the alert region automatically on change —
    //        without role=alert, a blind user wouldn't know the login failed
    render(<LoginView onLoginSuccess={vi.fn()} />);
    // Before error: no alert in DOM
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // (Error appearance is covered by the "connection error" test above)
  });

  test('HAPPY: submit button carries aria-busy while a login request is in flight', async () => {
    // WHO: Screen-reader user submitting the form
    // WHAT: aria-busy flips true while loading, so assistive tech can announce
    //        the busy state even though the button's own label already changed
    // WHY: a plain visual-only "Signing in..." label change is not guaranteed
    //        to be announced by every screen reader/browser combination —
    //        aria-busy is the explicit, standards-backed signal
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        })
    );
    render(<LoginView onLoginSuccess={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /sign in/i });
    expect(btn).toHaveAttribute('aria-busy', 'false');

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'pw' } });
    fireEvent.click(btn);

    expect(await screen.findByText(/signing in/i)).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });
});
