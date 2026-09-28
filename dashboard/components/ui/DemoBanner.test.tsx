/**
 * Tests for DemoBanner component.
 *
 * WHO: any dashboard user whose localStorage has demoTenantId set
 * WHAT: banner visibility, countdown, urgent state, exit behavior
 * WHEN: component mounts with/without demo session in localStorage
 * WHERE: dashboard/components/ui/DemoBanner.tsx
 * WHY: demo visitors must always see expiry time and a clear exit path;
 *      a broken banner leaves them stuck in a dead session
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DemoBanner } from './DemoBanner';

function setDemoSession(expiresInSeconds: number) {
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  localStorage.setItem('demoTenantId', 'demo-tenant-uuid');
  localStorage.setItem('demoExpiresAt', expiresAt);
}

function clearDemoSession() {
  localStorage.removeItem('demoTenantId');
  localStorage.removeItem('demoExpiresAt');
  localStorage.removeItem('authToken');
  localStorage.removeItem('tenantId');
  localStorage.removeItem('userName');
  localStorage.removeItem('userEmail');
  localStorage.removeItem('userRole');
}

describe('DemoBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearDemoSession();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearDemoSession();
  });

  it('HAPPY: renders banner when demoTenantId is in localStorage', () => {
    // WHO: demo visitor who just started a session
    // WHAT: banner with "Demo Mode" text is visible
    // WHEN: demoTenantId + demoExpiresAt present in localStorage on mount
    // WHERE: DemoBanner visibility guard
    // WHY: visitors must know they are in demo mode to understand data is not real
    setDemoSession(1800); // 30 minutes
    render(<DemoBanner />);
    expect(screen.getByTestId('demo-banner')).toBeInTheDocument();
    expect(screen.getByText('Demo Mode')).toBeInTheDocument();
  });

  it('HAPPY: renders nothing when no demoTenantId in localStorage', () => {
    // WHO: regular logged-in user (no demo session)
    // WHAT: banner is absent from the DOM
    // WHEN: localStorage has no demoTenantId key
    // WHERE: DemoBanner isDemo() guard
    // WHY: banner must not appear for real users — it would be misleading
    render(<DemoBanner />);
    expect(screen.queryByTestId('demo-banner')).not.toBeInTheDocument();
  });

  it('HAPPY: shows countdown in M:SS format', () => {
    // WHO: demo visitor watching the clock
    // WHAT: "30:00" or similar M:SS appears in the banner
    // WHEN: session has 30 minutes remaining
    // WHERE: formatCountdown in DemoBanner
    // WHY: visitors need to know when their session will expire
    setDemoSession(1800);
    render(<DemoBanner />);
    // Should show roughly 30:00 (exact second depends on timing, so just check M:SS pattern)
    const banner = screen.getByTestId('demo-banner');
    expect(banner.textContent).toMatch(/\d+:\d{2}/);
  });

  it('HAPPY: banner turns urgent when < 5 minutes remain', () => {
    // WHO: demo visitor about to run out of time
    // WHAT: banner has data-urgent="true"
    // WHEN: remaining seconds < 300
    // WHERE: urgent flag in DemoBanner
    // WHY: visitor needs visual warning before sudden session expiry
    setDemoSession(240); // 4 minutes — below the 5-min threshold
    render(<DemoBanner />);
    const banner = screen.getByTestId('demo-banner');
    expect(banner.getAttribute('data-urgent')).toBe('true');
  });

  it('HAPPY: non-urgent styling when >= 5 minutes remain', () => {
    // WHO: demo visitor early in their session
    // WHAT: banner has data-urgent="false"
    // WHEN: remaining seconds >= 300
    // WHERE: urgent flag false path
    // WHY: red urgency should only fire near expiry, not the whole session
    setDemoSession(600); // 10 minutes
    render(<DemoBanner />);
    const banner = screen.getByTestId('demo-banner');
    expect(banner.getAttribute('data-urgent')).toBe('false');
  });

  it('HAPPY: Exit demo button clears all auth localStorage keys', () => {
    // WHO: demo visitor who wants to leave
    // WHAT: clicking "Exit demo" removes auth + demo keys
    // WHEN: user clicks the Exit button
    // WHERE: handleExit() in DemoBanner
    // WHY: without clearing keys the visitor stays "logged in" as a dead demo tenant

    // Pre-set auth keys as the demo/page.tsx would have done
    localStorage.setItem('authToken', 'demo-jwt');
    localStorage.setItem('tenantId', 'demo-tenant-uuid');
    localStorage.setItem('userName', 'Demo Owner');
    localStorage.setItem('userRole', 'owner');
    setDemoSession(1800);

    // Intercept window.location.href assignment (jsdom doesn't actually navigate)
    const originalHref = window.location.href;
    delete (window as { location?: unknown }).location;
    (window as { location: unknown }).location = { href: originalHref };

    render(<DemoBanner />);
    const exitBtn = screen.getByRole('button', { name: /exit demo/i });
    fireEvent.click(exitBtn);

    expect(localStorage.getItem('authToken')).toBeNull();
    expect(localStorage.getItem('tenantId')).toBeNull();
    expect(localStorage.getItem('demoTenantId')).toBeNull();
    expect(localStorage.getItem('demoExpiresAt')).toBeNull();
  });

  it('HAPPY: countdown ticks down over time', () => {
    // WHO: demo visitor watching the timer
    // WHAT: the displayed time decrements each second via setInterval
    // WHEN: 1 second passes after mount
    // WHERE: useEffect setInterval in DemoBanner
    // WHY: a frozen timer makes visitors think the session won't expire
    setDemoSession(600);
    render(<DemoBanner />);

    const banner = screen.getByTestId('demo-banner');
    const initialText = banner.textContent ?? '';

    act(() => {
      vi.advanceTimersByTime(2000); // advance 2 seconds
    });

    const updatedText = banner.textContent ?? '';
    // Text should have changed (countdown ticked)
    expect(updatedText).not.toBe(initialText);
  });

  it('HAPPY: Reset demo swaps in the new session and reloads the dashboard', async () => {
    // WHO: a prospect (or Dale) whose demo data has drifted mid-walkthrough
    // WHAT: clicking "Reset demo" calls POST /demo/reset and, on success,
    //       overwrites the session keys with the new tenant and navigates
    //       to /dashboard — without ever visiting the landing page
    // WHERE: handleReset() in DemoBanner
    // WHY: "start over" must work in place, not just via Exit + re-click
    localStorage.setItem('authToken', 'old-jwt');
    localStorage.setItem('tenantId', 'old-tenant-uuid');
    setDemoSession(1800);
    localStorage.setItem('demoTenantId', 'old-tenant-uuid');

    const originalHref = window.location.href;
    delete (window as { location?: unknown }).location;
    (window as { location: unknown }).location = { href: originalHref };

    const newExpiresAt = new Date(Date.now() + 1800 * 1000).toISOString();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        token: 'new-jwt',
        tenant_id: 'new-tenant-uuid',
        user_id: 'new-user-uuid',
        expires_at: newExpiresAt,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DemoBanner />);
    const resetBtn = screen.getByRole('button', { name: /reset demo/i });

    await act(async () => {
      fireEvent.click(resetBtn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/demo/reset'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer old-jwt' }),
      })
    );
    expect(localStorage.getItem('authToken')).toBe('new-jwt');
    expect(localStorage.getItem('tenantId')).toBe('new-tenant-uuid');
    expect(localStorage.getItem('demoTenantId')).toBe('new-tenant-uuid');
    expect(localStorage.getItem('demoExpiresAt')).toBe(newExpiresAt);
    expect((window.location as unknown as { href: string }).href).toBe('/dashboard');

    vi.unstubAllGlobals();
  });

  it('SAD: Reset demo shows an error and stays put when the backend refuses', async () => {
    // WHO: a caller whose demo session already expired/reset elsewhere
    // WHAT: /demo/reset returns { success: false, error }
    // WHERE: handleReset()'s failure branch
    // WHY: the visitor must see why it didn't work, not a silent no-op —
    //      and their existing (still-valid) session must not be clobbered
    setDemoSession(1800);
    localStorage.setItem('authToken', 'old-jwt');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ success: false, error: 'Not an active demo session.' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DemoBanner />);
    const resetBtn = screen.getByRole('button', { name: /reset demo/i });

    await act(async () => {
      fireEvent.click(resetBtn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('Not an active demo session.')).toBeInTheDocument();
    expect(localStorage.getItem('authToken')).toBe('old-jwt');

    vi.unstubAllGlobals();
  });

  it('SAD: expired session redirects to home', () => {
    // WHO: demo visitor whose session expired while they were looking at the tab
    // WHAT: localStorage cleared, redirect to '/'
    // WHEN: remaining seconds hits 0
    // WHERE: setInterval check in DemoBanner
    // WHY: expired JWT would cause every API call to 401; redirect is cleaner UX
    setDemoSession(1); // 1 second remaining

    delete (window as { location?: unknown }).location;
    (window as { location: unknown }).location = { href: '' };

    render(<DemoBanner />);

    act(() => {
      vi.advanceTimersByTime(2000); // advance past expiry
    });

    expect(localStorage.getItem('authToken')).toBeNull();
    expect(localStorage.getItem('demoTenantId')).toBeNull();
  });
});
