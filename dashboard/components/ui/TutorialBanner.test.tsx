/**
 * Tests for TutorialBanner component.
 *
 * WHO: any dashboard user whose localStorage has tutorialTenantId set
 * WHAT: banner visibility, countdown, urgent state, exit behavior
 * WHEN: component mounts with/without demo session in localStorage
 * WHERE: dashboard/components/ui/TutorialBanner.tsx
 * WHY: demo visitors must always see expiry time and a clear exit path;
 *      a broken banner leaves them stuck in a dead session
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TutorialBanner } from './TutorialBanner';

function setTutorialSession(expiresInSeconds: number) {
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  localStorage.setItem('tutorialTenantId', 'demo-tenant-uuid');
  localStorage.setItem('tutorialExpiresAt', expiresAt);
}

function clearTutorialSession() {
  localStorage.removeItem('tutorialTenantId');
  localStorage.removeItem('tutorialExpiresAt');
  localStorage.removeItem('authToken');
  localStorage.removeItem('tenantId');
  localStorage.removeItem('userName');
  localStorage.removeItem('userEmail');
  localStorage.removeItem('userRole');
}

describe('TutorialBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearTutorialSession();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearTutorialSession();
  });

  it('HAPPY: renders banner when tutorialTenantId is in localStorage', () => {
    // WHO: demo visitor who just started a session
    // WHAT: banner with "Tutorial Mode" text is visible
    // WHEN: tutorialTenantId + tutorialExpiresAt present in localStorage on mount
    // WHERE: TutorialBanner visibility guard
    // WHY: visitors must know they are in demo mode to understand data is not real
    setTutorialSession(1800); // 30 minutes
    render(<TutorialBanner />);
    expect(screen.getByTestId('tutorial-banner')).toBeInTheDocument();
    expect(screen.getByText('Tutorial Mode')).toBeInTheDocument();
  });

  it('HAPPY: renders nothing when no tutorialTenantId in localStorage', () => {
    // WHO: regular logged-in user (no demo session)
    // WHAT: banner is absent from the DOM
    // WHEN: localStorage has no tutorialTenantId key
    // WHERE: TutorialBanner isDemo() guard
    // WHY: banner must not appear for real users — it would be misleading
    render(<TutorialBanner />);
    expect(screen.queryByTestId('tutorial-banner')).not.toBeInTheDocument();
  });

  it('HAPPY: shows countdown in M:SS format', () => {
    // WHO: demo visitor watching the clock
    // WHAT: "30:00" or similar M:SS appears in the banner
    // WHEN: session has 30 minutes remaining
    // WHERE: formatCountdown in TutorialBanner
    // WHY: visitors need to know when their session will expire
    setTutorialSession(1800);
    render(<TutorialBanner />);
    // Should show roughly 30:00 (exact second depends on timing, so just check M:SS pattern)
    const banner = screen.getByTestId('tutorial-banner');
    expect(banner.textContent).toMatch(/\d+:\d{2}/);
  });

  it('HAPPY: banner turns urgent when < 5 minutes remain', () => {
    // WHO: demo visitor about to run out of time
    // WHAT: banner has data-urgent="true"
    // WHEN: remaining seconds < 300
    // WHERE: urgent flag in TutorialBanner
    // WHY: visitor needs visual warning before sudden session expiry
    setTutorialSession(240); // 4 minutes — below the 5-min threshold
    render(<TutorialBanner />);
    const banner = screen.getByTestId('tutorial-banner');
    expect(banner.getAttribute('data-urgent')).toBe('true');
  });

  it('HAPPY: non-urgent styling when >= 5 minutes remain', () => {
    // WHO: demo visitor early in their session
    // WHAT: banner has data-urgent="false"
    // WHEN: remaining seconds >= 300
    // WHERE: urgent flag false path
    // WHY: red urgency should only fire near expiry, not the whole session
    setTutorialSession(600); // 10 minutes
    render(<TutorialBanner />);
    const banner = screen.getByTestId('tutorial-banner');
    expect(banner.getAttribute('data-urgent')).toBe('false');
  });

  it('HAPPY: Exit tutorial button clears all auth localStorage keys', () => {
    // WHO: demo visitor who wants to leave
    // WHAT: clicking "Exit tutorial" removes auth + demo keys
    // WHEN: user clicks the Exit button
    // WHERE: handleExit() in TutorialBanner
    // WHY: without clearing keys the visitor stays "logged in" as a dead demo tenant

    // Pre-set auth keys as the demo/page.tsx would have done
    localStorage.setItem('authToken', 'demo-jwt');
    localStorage.setItem('tenantId', 'demo-tenant-uuid');
    localStorage.setItem('userName', 'Demo Owner');
    localStorage.setItem('userRole', 'owner');
    setTutorialSession(1800);

    // Intercept window.location.href assignment (jsdom doesn't actually navigate)
    const originalHref = window.location.href;
    delete (window as { location?: unknown }).location;
    (window as { location: unknown }).location = { href: originalHref };

    render(<TutorialBanner />);
    const exitBtn = screen.getByRole('button', { name: /exit tutorial/i });
    fireEvent.click(exitBtn);

    expect(localStorage.getItem('authToken')).toBeNull();
    expect(localStorage.getItem('tenantId')).toBeNull();
    expect(localStorage.getItem('tutorialTenantId')).toBeNull();
    expect(localStorage.getItem('tutorialExpiresAt')).toBeNull();
  });

  it('HAPPY: countdown ticks down over time', () => {
    // WHO: demo visitor watching the timer
    // WHAT: the displayed time decrements each second via setInterval
    // WHEN: 1 second passes after mount
    // WHERE: useEffect setInterval in TutorialBanner
    // WHY: a frozen timer makes visitors think the session won't expire
    setTutorialSession(600);
    render(<TutorialBanner />);

    const banner = screen.getByTestId('tutorial-banner');
    const initialText = banner.textContent ?? '';

    act(() => {
      vi.advanceTimersByTime(2000); // advance 2 seconds
    });

    const updatedText = banner.textContent ?? '';
    // Text should have changed (countdown ticked)
    expect(updatedText).not.toBe(initialText);
  });

  it('HAPPY: Reset tutorial swaps in the new session and reloads the dashboard', async () => {
    // WHO: a prospect (or Dale) whose demo data has drifted mid-walkthrough
    // WHAT: clicking "Reset tutorial" calls POST /tutorial/reset and, on success,
    //       overwrites the session keys with the new tenant and navigates
    //       to /dashboard — without ever visiting the landing page
    // WHERE: handleReset() in TutorialBanner
    // WHY: "start over" must work in place, not just via Exit + re-click
    localStorage.setItem('authToken', 'old-jwt');
    localStorage.setItem('tenantId', 'old-tenant-uuid');
    setTutorialSession(1800);
    localStorage.setItem('tutorialTenantId', 'old-tenant-uuid');

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

    render(<TutorialBanner />);
    const resetBtn = screen.getByRole('button', { name: /reset tutorial/i });

    await act(async () => {
      fireEvent.click(resetBtn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/tutorial/reset'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer old-jwt' }),
      })
    );
    expect(localStorage.getItem('authToken')).toBe('new-jwt');
    expect(localStorage.getItem('tenantId')).toBe('new-tenant-uuid');
    expect(localStorage.getItem('tutorialTenantId')).toBe('new-tenant-uuid');
    expect(localStorage.getItem('tutorialExpiresAt')).toBe(newExpiresAt);
    expect((window.location as unknown as { href: string }).href).toBe('/dashboard');

    vi.unstubAllGlobals();
  });

  it('SAD: Reset tutorial shows an error and stays put when the backend refuses', async () => {
    // WHO: a caller whose demo session already expired/reset elsewhere
    // WHAT: /tutorial/reset returns { success: false, error }
    // WHERE: handleReset()'s failure branch
    // WHY: the visitor must see why it didn't work, not a silent no-op —
    //      and their existing (still-valid) session must not be clobbered
    setTutorialSession(1800);
    localStorage.setItem('authToken', 'old-jwt');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ success: false, error: 'Not an active tutorial session.' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TutorialBanner />);
    const resetBtn = screen.getByRole('button', { name: /reset tutorial/i });

    await act(async () => {
      fireEvent.click(resetBtn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('Not an active tutorial session.')).toBeInTheDocument();
    expect(localStorage.getItem('authToken')).toBe('old-jwt');

    vi.unstubAllGlobals();
  });

  it('SAD: expired session redirects to home', () => {
    // WHO: demo visitor whose session expired while they were looking at the tab
    // WHAT: localStorage cleared, redirect to '/'
    // WHEN: remaining seconds hits 0
    // WHERE: setInterval check in TutorialBanner
    // WHY: expired JWT would cause every API call to 401; redirect is cleaner UX
    setTutorialSession(1); // 1 second remaining

    delete (window as { location?: unknown }).location;
    (window as { location: unknown }).location = { href: '' };

    render(<TutorialBanner />);

    act(() => {
      vi.advanceTimersByTime(2000); // advance past expiry
    });

    expect(localStorage.getItem('authToken')).toBeNull();
    expect(localStorage.getItem('tutorialTenantId')).toBeNull();
  });
});
