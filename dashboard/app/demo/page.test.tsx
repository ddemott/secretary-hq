/**
 * Tests for dashboard/app/demo/page.tsx
 *
 * WHO: anonymous visitor clicking "Try live demo" on the landing page
 * WHAT: fetch call to /demo/start, localStorage population, redirect
 * WHEN: component mounts
 * WHERE: dashboard/app/demo/page.tsx
 * WHY: this is the only entry-point to the demo; if the fetch or
 *      localStorage write fails silently, visitors land on a blank/broken
 *      dashboard with no token and no error message
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The demo page navigates with window.location.href (a HARD load), not
// router.push — SessionProvider only reads localStorage on mount, so a
// client-side push would land on /dashboard with a null session (login screen).
// Capture assignments to location.href instead of mocking next/navigation.
let hrefAssignments: string[] = [];
function stubLocation(): void {
  hrefAssignments = [];
  const loc = { ...window.location } as unknown as Location;
  Object.defineProperty(loc, 'href', {
    set: (v: string) => {
      hrefAssignments.push(v);
    },
    get: () => 'https://test.local/demo',
  });
  Object.defineProperty(window, 'location', { value: loc, writable: true, configurable: true });
}

import DemoPage from './page';

function mockFetch(response: Partial<Response>): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response));
}

function mockFetchReject(err: Error): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(err));
}

describe('DemoPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    stubLocation();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('REGRESSION: sends a body alongside the JSON content-type', async () => {
    // WHO: visitor clicking "Try live demo"
    // WHAT: the POST must carry a body, not just declare application/json
    // WHEN: 2026-07-08 — shipping the header without a body made the backend
    //       parser reject every click with 400 "Invalid JSON"
    // WHERE: the fetch() in DemoPage's useEffect
    // WHY: this suite stubs fetch, so it can never catch a backend rejection.
    //      What it CAN do is pin the request shape the backend agreed to
    //      accept. Asserting the body exists is the half of the contract that
    //      lives on this side of the mock.
    mockFetch({
      ok: true,
      json: async () => ({
        success: true,
        token: 't',
        tenant_id: 'x',
        user_id: 'y',
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        ttl_minutes: 30,
      }),
    });

    render(<DemoPage />);

    await waitFor(() => {
      expect(hrefAssignments).toContain('/dashboard');
    });

    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.body).toBeDefined();
    // Must be valid JSON — the parser on the other side calls JSON.parse on it.
    expect(() => JSON.parse(init.body as string)).not.toThrow();
  });

  it('REGRESSION: navigates with a HARD page load, never a client-side push', async () => {
    // WHO: every visitor clicking "Try live demo"
    // WHAT: /dashboard is reached via window.location.href, forcing a full load
    // WHEN: 2026-07-08 — with router.push('/dashboard') the demo landed on the
    //       LOGIN SCREEN in production, despite a valid token in localStorage
    // WHERE: SessionProvider (app/providers.tsx → root layout) reads localStorage
    //        in a mount-once useEffect(…, []). A client-side push keeps it
    //        mounted, so it never re-reads the session the demo page just wrote
    //        → tenantId stays null → app/dashboard/page.tsx renders <LoginView/>
    // WHY: this is the second half of the "Try live demo" outage. Fixing the
    //      400 got the token issued; only a hard load makes the session apply.
    mockFetch({
      ok: true,
      json: async () => ({
        success: true,
        token: 't',
        tenant_id: 'x',
        user_id: 'y',
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        ttl_minutes: 30,
      }),
    });

    render(<DemoPage />);

    await waitFor(() => {
      expect(hrefAssignments).toContain('/dashboard');
    });
    // The session must already be persisted when the hard load fires, otherwise
    // the remounted provider reads an empty localStorage.
    expect(localStorage.getItem('tenantId')).toBe('x');
    expect(localStorage.getItem('authToken')).toBe('t');
  });

  it('HAPPY: sets auth token and redirects to /dashboard on success', async () => {
    // WHO: visitor clicking "Try live demo"
    // WHAT: token + tenant_id stored in localStorage, router.push('/dashboard') called
    // WHEN: /demo/start returns 200 with success=true
    // WHERE: useEffect fetch in DemoPage
    // WHY: without these localStorage writes the dashboard renders the login screen
    mockFetch({
      ok: true,
      json: async () => ({
        success: true,
        token: 'test-demo-jwt',
        tenant_id: 'demo-uuid-1234',
        user_id: 'user-uuid-5678',
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        ttl_minutes: 30,
      }),
    });

    render(<DemoPage />);

    await waitFor(() => {
      expect(hrefAssignments).toContain('/dashboard');
    });

    expect(localStorage.getItem('authToken')).toBe('test-demo-jwt');
    expect(localStorage.getItem('tenantId')).toBe('demo-uuid-1234');
    expect(localStorage.getItem('userRole')).toBe('owner');
    expect(localStorage.getItem('demoTenantId')).toBe('demo-uuid-1234');
    expect(localStorage.getItem('demoExpiresAt')).toBeTruthy();
  });

  it('HAPPY: shows loading spinner while fetch is in-flight', async () => {
    // WHO: visitor on a slow connection
    // WHAT: spinner visible before fetch resolves
    // WHEN: immediately after mount
    // WHERE: initial render before fetch resolves
    // WHY: a blank page during setup would look broken
    let resolvePromise!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValueOnce(
        new Promise<Response>((res) => {
          resolvePromise = res;
        })
      )
    );

    render(<DemoPage />);

    // Spinner should be visible before fetch resolves
    const spinner = document.querySelector('[style*="border"]');
    expect(spinner).not.toBeNull();

    // Resolve to avoid hanging — error branch is fine here
    await act(async () => {
      resolvePromise({
        ok: false,
        json: async () => ({ success: false, error: 'Test' }),
      } as Response);
    });
  });

  it('SAD: shows error when /demo/start returns success=false', async () => {
    // WHO: visitor hitting the demo when capacity is full
    // WHAT: error message rendered instead of redirect
    // WHEN: server returns { success: false, error: 'Demo capacity is full...' }
    // WHERE: error branch in useEffect
    // WHY: a silent failure redirects to a broken dashboard; error is better UX
    mockFetch({
      ok: false,
      json: async () => ({
        success: false,
        error: 'Demo capacity is full. Please try again in a few minutes.',
      }),
    });

    render(<DemoPage />);

    await waitFor(() => {
      expect(screen.getByText(/demo unavailable/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/demo capacity is full/i)).toBeInTheDocument();
    expect(hrefAssignments).toHaveLength(0);
    expect(localStorage.getItem('authToken')).toBeNull();
  });

  it('SAD: shows error on 429 rate-limit response', async () => {
    // WHO: visitor hammering the demo button
    // WHAT: "Demo unavailable" with the rate-limit message
    // WHEN: server returns 429
    // WHERE: error branch in useEffect
    // WHY: visitors should be told to wait, not see a blank error state
    mockFetch({
      ok: false,
      json: async () => ({
        success: false,
        error: 'Too many demo sessions from this IP. Try again in 15 minutes.',
      }),
    });

    render(<DemoPage />);

    await waitFor(() => {
      expect(screen.getByText(/demo unavailable/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/too many demo sessions/i)).toBeInTheDocument();
  });

  it('SAD: shows error on network failure', async () => {
    // WHO: visitor with no internet / backend down
    // WHAT: "Demo unavailable" shown; no redirect, no auth stored
    // WHEN: fetch rejects (TypeError: Failed to fetch)
    // WHERE: catch block in useEffect
    // WHY: unhandled promise rejection would show a blank spinner forever
    mockFetchReject(new Error('Failed to fetch'));

    render(<DemoPage />);

    await waitFor(() => {
      expect(screen.getByText(/demo unavailable/i)).toBeInTheDocument();
    });

    // The catch block sets errorMsg from the Error — verify error state is shown
    // and no auth side-effects occurred.
    expect(screen.getByRole('link', { name: /back to home/i })).toBeInTheDocument();
    expect(hrefAssignments).toHaveLength(0);
    expect(localStorage.getItem('authToken')).toBeNull();
  });

  it('HAPPY: "Back to home" link is visible on error', async () => {
    // WHO: visitor seeing the error state
    // WHAT: link to navigate back to landing page
    // WHEN: any error (capacity, rate-limit, network)
    // WHERE: error render branch in DemoPage
    // WHY: visitors must have an exit path from the error screen
    mockFetch({
      ok: false,
      json: async () => ({ success: false, error: 'Something went wrong' }),
    });

    render(<DemoPage />);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /back to home/i })).toBeInTheDocument();
    });

    const link = screen.getByRole('link', { name: /back to home/i });
    expect(link).toHaveAttribute('href', '/');
  });
});
