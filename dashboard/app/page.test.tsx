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

import LandingPage from './page';

async function renderLanding() {
  const utils = render(<LandingPage />);
  // The landing only renders after the auth check flips `checked` — wait for
  // a stable landmark from LANDING_HTML.
  await waitFor(() => {
    expect(document.getElementById('billing-annual')).toBeTruthy();
  });
  return utils;
}

function priceNums(): string[] {
  return Array.from(document.querySelectorAll('.price-num[data-monthly]')).map(
    (el) => el.textContent ?? ''
  );
}

describe('LandingPage pricing toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('switches every plan price to the annual rate and back (the dead-toggle bug)', async () => {
    // WHY: window.setBilling was undefined in prod (inline <script> in
    // dangerouslySetInnerHTML never runs) — clicking Annual did nothing.
    await renderLanding();
    expect(priceNums()).toEqual(['129', '279', '449']);

    fireEvent.click(document.getElementById('billing-annual')!);
    expect(priceNums()).toEqual(['103', '223', '359']);
    expect(document.getElementById('billing-annual')).toHaveClass('active');
    expect(document.getElementById('billing-monthly')).not.toHaveClass('active');

    fireEvent.click(document.getElementById('billing-monthly')!);
    expect(priceNums()).toEqual(['129', '279', '449']);
    expect(document.getElementById('billing-monthly')).toHaveClass('active');
  });

  it('shows the annual-billing note only in annual mode', async () => {
    await renderLanding();
    const note = document.getElementById('price-annual-note')!;
    expect(note.style.display).not.toBe('block');
    fireEvent.click(document.getElementById('billing-annual')!);
    expect(note.style.display).toBe('block');
    fireEvent.click(document.getElementById('billing-monthly')!);
    expect(note.style.display).toBe('none');
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
    expect(document.getElementById('billing-annual')).toBeNull();
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
