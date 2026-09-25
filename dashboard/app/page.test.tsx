/**
 * Tests for dashboard/app/page.tsx (public landing page interactivity)
 *
 * WHO: anonymous visitor on the marketing landing page
 * WHAT: the pricing Monthly/Annual toggle and the mobile hamburger menu
 * WHEN: after mount (no auth token → landing renders instead of redirect)
 * WHERE: dashboard/app/page.tsx — LANDING_HTML is injected via
 *        dangerouslySetInnerHTML, so its inline <script> NEVER executes;
 *        all interactivity must be wired from React useEffect
 * WHY: the pricing toggle and hamburger were dead in production
 *      (docs/TODO.md bug, found 2026-07-01) — clicking "Annual" changed
 *      nothing and the mobile menu never opened. These tests pin the
 *      useEffect wiring so a regression to inline-script wiring fails CI.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
}));

// jsdom has no IntersectionObserver; the reveal-animation effect constructs
// one on mount and an unstubbed reference throws, killing every later effect
// (which is exactly what these tests wire). Minimal inert stub.
class IOStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('IntersectionObserver', IOStub);

// Same problem, same fix, for the top-fixed height-measurement effect: jsdom
// has no ResizeObserver either.
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ROStub);

import LandingPage from './page';

async function renderLanding() {
  const utils = render(<LandingPage />);
  // The landing only renders after the auth check flips `checked` — wait for
  // a stable landmark from LANDING_HTML.
  await waitFor(() => {
    expect(document.getElementById('pricing')).toBeTruthy();
  });
  return utils;
}

function priceNums(): string[] {
  return Array.from(document.querySelectorAll('.price-num[data-monthly]')).map(
    (el) => el.textContent ?? ''
  );
}

describe('LandingPage prices match the owner-decided tiers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('shows $29.95 / $59.95 / $149.95 with 30 / 100 / 300 calls and the per-call rates', async () => {
    // WHO: a prospect reading the pricing section
    // WHAT: the decided tiers (docs/planning/TODO.md P0 §2, 2026-09-24) — price,
    //       included calls and the extra-call rate on each card
    // WHY: the page advertised $129 / $279 / $449 with 150 / 500 / 2,000 calls
    //      while billing (PR #565) charged the new tiers
    await renderLanding();
    expect(priceNums()).toEqual(['29.95', '59.95', '149.95']);
    const text = document.body.textContent ?? '';
    for (const line of [
      '30 AI-handled calls/month',
      '100 AI-handled calls/month',
      '300 AI-handled calls/month',
      '$1.00 per extra call',
      '$0.75 per extra call',
      '$0.60 per extra call',
    ]) {
      expect(text).toContain(line);
    }
    for (const stale of [
      '$129',
      '$279',
      '$449',
      '150 AI-handled',
      '500 AI-handled',
      '2,000 calls',
    ]) {
      expect(text).not.toContain(stale);
    }
  });

  it('shows no staff or station limits on any plan (owner: removed 2026-09-25)', async () => {
    // WHY: the cards advertised "1 staff member / 1 station", "Up to 5 staff /
    //      3 stations" and "Unlimited" — limits nothing in the product enforces
    //      and the owner never set. Dale: remove them.
    await renderLanding();
    const pricing = document.getElementById('pricing')?.textContent ?? '';
    // Any limit phrasing, not just the old wording: "1 staff", "Up to 5 staff",
    // "3 stations", "Unlimited staff/stations", "staff member(s)".
    const limit =
      /\b(\d+|up to \d+|unlimited)\s+(staff|stations?|workspaces?|seats?|users?)\b|staff members?/i;
    expect(pricing).not.toMatch(limit);
    // The pattern itself must catch the phrasings it exists to catch.
    for (const phrase of ['1 staff member', 'Up to 5 staff', '3 stations', 'Unlimited stations']) {
      expect(phrase).toMatch(limit);
    }
  });

  it('shows monthly prices only — no Annual toggle or "Save 20%" (owner: no annual discount)', async () => {
    // WHY: the page offered Annual at 20% off, but billing has only monthly
    //      prices, so an "annual" customer would still have been charged
    //      monthly. Dale, 2026-09-24: no annual option.
    await renderLanding();
    expect(document.getElementById('billing-annual')).toBeNull();
    expect(document.getElementById('billing-monthly')).toBeNull();
    expect(document.getElementById('price-annual-note')).toBeNull();
    expect(document.querySelector('[data-annual]')).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(/Save 20%|annual payment/i);
  });
});

describe('LandingPage mobile hamburger menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('opens on hamburger click and closes on backdrop click (the dead-menu bug)', async () => {
    // WHY: the addEventListener wiring lived in the never-executed inline
    // <script>, so the mobile menu could not open at all.
    await renderLanding();
    const btn = document.getElementById('hamburger-btn')!;
    const menu = document.getElementById('mobile-menu')!;
    const backdrop = document.getElementById('mobile-backdrop')!;

    expect(menu).not.toHaveClass('open');
    fireEvent.click(btn);
    expect(menu).toHaveClass('open');
    expect(backdrop).toHaveClass('open');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(backdrop);
    expect(menu).not.toHaveClass('open');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(document.body.style.overflow).toBe('');
  });

  it('closes on Escape and on menu-link click', async () => {
    await renderLanding();
    const btn = document.getElementById('hamburger-btn')!;
    const menu = document.getElementById('mobile-menu')!;

    fireEvent.click(btn);
    expect(menu).toHaveClass('open');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menu).not.toHaveClass('open');

    fireEvent.click(btn);
    expect(menu).toHaveClass('open');
    const link = document.querySelector('.nav-mobile-menu a')!;
    fireEvent.click(link);
    expect(menu).not.toHaveClass('open');
  });
});

describe('LandingPage inline handlers (dead under dangerouslySetInnerHTML)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('SAD: the injected markup carries NO inline on* handler attributes', async () => {
    // WHY: LANDING_HTML's four mobile-menu links had onclick="closeMobileMenu()",
    // but closeMobileMenu only ever existed inside the never-executed inline
    // <script>, so it was not a global — every mobile-menu link click threw
    // "ReferenceError: closeMobileMenu is not defined" (also the jsdom warning
    // that showed up in dashboard test runs). The useEffect already wires
    // link clicks to close(); inline handlers here can only be dead or broken.
    await renderLanding();
    const offenders = Array.from(document.querySelectorAll('*')).filter((el) =>
      el.getAttributeNames().some((name) => name.toLowerCase().startsWith('on'))
    );
    expect(offenders.map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
  });

  it('SAD: clicking a mobile-menu link raises no uncaught error and still closes the menu', async () => {
    await renderLanding();
    const errors: string[] = [];
    const onError = (e: ErrorEvent) => {
      errors.push(e.message);
      e.preventDefault();
    };
    window.addEventListener('error', onError);
    try {
      const btn = document.getElementById('hamburger-btn')!;
      const menu = document.getElementById('mobile-menu')!;
      const links = Array.from(document.querySelectorAll('.nav-mobile-menu a'));
      expect(links.length).toBeGreaterThanOrEqual(4);
      for (const link of links) {
        // Each link is exercised with the menu genuinely open, and must close it.
        expect(menu).not.toHaveClass('open');
        fireEvent.click(btn);
        expect(menu).toHaveClass('open');
        fireEvent.click(link);
        expect(menu).not.toHaveClass('open');
        expect(btn).toHaveAttribute('aria-expanded', 'false');
      }
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener('error', onError);
    }
  });
});

describe('LandingPage auth redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('SAD: an authenticated visitor is redirected to /dashboard, landing never renders', async () => {
    // WHY: logged-in users must not see the marketing page; this also pins
    // that the interactivity effects tolerate the not-rendered state.
    localStorage.setItem('authToken', 'tok');
    render(<LandingPage />);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/dashboard'));
    expect(document.getElementById('pricing')).toBeNull();
  });
});

describe('LandingPage legal footer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('points Privacy, Terms, and DPA at public routes — not login', async () => {
    await renderLanding();
    expect(document.querySelector('footer a[href="/privacy"]')).toBeTruthy();
    expect(document.querySelector('footer a[href="/terms"]')).toBeTruthy();
    expect(document.querySelector('footer a[href="/dpa"]')).toBeTruthy();
  });
});
