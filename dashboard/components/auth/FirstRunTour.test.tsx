/**
 * FirstRunTour tests — pins the visibility gating + dismissal behavior of
 * the post-wizard overview modal (Phase 13 launch-blocker, 2026-05-17).
 *
 * What we test:
 *   1. Tour stays hidden when there's no pending flag in localStorage.
 *   2. Tour shows when `firstRunTour_<tenantId>` === 'pending'.
 *   3. Mounting the tour immediately flips the flag to 'shown' so a
 *      double-render (Strict Mode, parent re-render) never replays it.
 *   4. Clicking a tab card calls onNavigate AND closes the modal.
 *   5. Clicking "Got it" or the X closes the modal.
 *   6. markFirstRunTourPending sets the flag exactly when no prior state
 *      exists — re-running the wizard does NOT replay the tour.
 *
 * Each test carries 5W context.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('../../lib/SessionContext', () => ({
  useActiveTenantId: () => 'tenant-XYZ',
}));

vi.mock('@/lib/VocabularyContext', () => ({
  useVocabulary: () => ({
    resource_plural: 'Bays',
    resource_label: 'Bay',
    employee_label: 'Tech',
    employee_plural: 'Techs',
    booking_label: 'Appointment',
  }),
}));

import { FirstRunTour, markFirstRunTourPending } from './FirstRunTour';
import { TOUR_START_EVENT } from '../../lib/productTour';

const KEY = 'firstRunTour_tenant-XYZ';

beforeEach(() => {
  localStorage.clear();
});

describe('FirstRunTour — visibility gating', () => {
  test('SAD: no pending flag → tour renders nothing', () => {
    // WHO: returning tenant who already saw the tour, or a tenant whose
    //      wizard was never completed (skipped Done).
    // WHAT: with no `firstRunTour_<tenantId>` flag in localStorage, the
    //       component must render nothing at all.
    // WHY: re-showing the tour on every dashboard visit would be the
    //      exact friction this skill exists to avoid.
    const { container } = render(<FirstRunTour onNavigate={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  test('HAPPY: pending flag → tour renders with welcome heading', () => {
    // WHO: tenant who just clicked "Done" on the wizard's step 7
    // WHAT: localStorage has `firstRunTour_<tenantId>` === 'pending'
    //       → modal renders with the scope-setting headline
    //       "You're set up — here's what's where".
    // WHY: this is the entire purpose of the tour — onboarding hand-off
    //      from the wizard. Without this assertion, a regression that
    //      forgets the localStorage check or breaks the open state would
    //      silently leave new tenants stranded on Home.
    localStorage.setItem(KEY, 'pending');
    render(<FirstRunTour onNavigate={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: /set up.*here.*where/i })).toBeInTheDocument();
  });

  test('HAPPY: mounting flips pending → shown so a re-render never replays', () => {
    // WHO: any tenant; the test models a React.StrictMode double-mount
    // WHAT: after the first mount sets state, localStorage flag becomes
    //       'shown'. A second mount must therefore render nothing.
    // WHY: without this guard a quick parent re-render (StrictMode, a
    //      tenant-context flip) would replay the tour, which feels broken.
    localStorage.setItem(KEY, 'pending');
    const { unmount } = render(<FirstRunTour onNavigate={vi.fn()} />);
    expect(localStorage.getItem(KEY)).toBe('shown');
    unmount();

    const { container } = render(<FirstRunTour onNavigate={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('FirstRunTour — keyboard + backdrop (Cluster C)', () => {
  test('HAPPY: Escape key closes the tour', () => {
    // WHO: keyboard user who launched the tour and wants to dismiss
    // WHAT: pressing Escape closes the modal (queryByRole returns null after)
    // WHERE: FirstRunTour Escape handler (via useFocusTrap)
    // WHY: Escape-to-close is the universal keyboard dialog contract; without it
    //      keyboard users must tab through all tour cards to reach "Got it"
    localStorage.setItem(KEY, 'pending');
    render(<FirstRunTour onNavigate={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('HAPPY: clicking the backdrop closes the tour without navigating', () => {
    // WHO: mouse user who clicks outside the tour card to dismiss
    // WHAT: click on the dark overlay (role=dialog) closes the tour; onNavigate not called
    // WHERE: FirstRunTour backdrop onClick
    // WHY: backdrop-close is expected modal behavior; missing it leaves the tour stuck
    //      and forces users to click "Got it" or the X button
    localStorage.setItem(KEY, 'pending');
    const onNavigate = vi.fn();
    render(<FirstRunTour onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe('FirstRunTour — interactions', () => {
  test('HAPPY: clicking a tab card calls onNavigate AND closes the modal', () => {
    // WHO: tenant who reads the tour and wants to jump straight to the
    //      Schedule tab to see today's bookings.
    // WHAT: clicking the Schedule card fires onNavigate('schedule') and
    //       the modal closes.
    // WHY: the cards exist so the user can act on the tour content
    //      immediately. A regression that wired the cards without the
    //      close-on-click behavior would leave the modal stuck on top
    //      of the navigated-to tab.
    localStorage.setItem(KEY, 'pending');
    const onNavigate = vi.fn();
    render(<FirstRunTour onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('button', { name: /Schedule/i }));

    expect(onNavigate).toHaveBeenCalledWith('schedule');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('HAPPY: "Got it" closes without navigating', () => {
    // WHO: tenant who just wants to dismiss after skimming
    // WHAT: clicking "Got it" closes the modal, onNavigate is NOT called.
    // WHY: the explicit dismissal path must not silently redirect the
    //      user to a tab they didn't choose.
    localStorage.setItem(KEY, 'pending');
    const onNavigate = vi.fn();
    render(<FirstRunTour onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('button', { name: /got it/i }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  test('HAPPY: header X close button also closes', () => {
    // WHO: tenant who closes via the affordance they expect on any modal
    // WHAT: clicking the X (aria-label "Close tour") dismisses.
    // WHY: two exits ("Got it" and X) must behave identically — any
    //      drift erodes trust in the close affordance across the app.
    localStorage.setItem(KEY, 'pending');
    render(<FirstRunTour onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /close tour/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('markFirstRunTourPending', () => {
  test('HAPPY: arms the flag for a tenant with no prior state', () => {
    // WHO: the SetupWizard step-7 Done button calling into this helper
    // WHAT: with no prior localStorage entry, the flag is set to 'pending'.
    // WHY: this is the trigger that makes the tour fire when the user
    //      lands on Home. A regression that drops the localStorage
    //      write would silently disable the entire tour surface.
    markFirstRunTourPending('tenant-XYZ');
    expect(localStorage.getItem(KEY)).toBe('pending');
  });

  test('SAD: does NOT replay the tour for a tenant who already saw it', () => {
    // WHO: tenant who completed the wizard, saw the tour, and now is
    //      re-running the wizard to add another service.
    // WHAT: with `firstRunTour_<tenantId>` === 'shown', a second
    //       markFirstRunTourPending call must NOT overwrite back to
    //       'pending'.
    // WHY: re-running the wizard is a power-user action — it should not
    //      be punished with a beginner-mode tour every time.
    localStorage.setItem(KEY, 'shown');
    markFirstRunTourPending('tenant-XYZ');
    expect(localStorage.getItem(KEY)).toBe('shown');
  });

  test('SAD: no-op when tenantId is null', () => {
    // WHO: super-admin on the All-Businesses grid clicking Done somehow
    //      (defensive — shouldn't normally happen)
    // WHAT: passing null must not throw and must not pollute localStorage.
    // WHY: a localStorage write keyed on `firstRunTour_null` would be a
    //      latent bug — null-key flags collide across tenants.
    markFirstRunTourPending(null);
    expect(localStorage.getItem('firstRunTour_null')).toBeNull();
  });
});

describe('FirstRunTour — guided tour hand-off', () => {
  test('HAPPY: "Show me around" closes the card and starts the product tour', () => {
    // WHO: a new owner who just finished the setup wizard.
    // WHAT: the button closes this overview and dispatches the tour start
    //       event that <ProductTour /> listens for.
    // WHY: this card is how real owners are offered the tour — it never
    //      auto-starts for them the way it does on the Tutorial.
    localStorage.setItem(KEY, 'pending');
    const started = vi.fn();
    window.addEventListener(TOUR_START_EVENT, started);
    render(<FirstRunTour onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show me around' }));
    window.removeEventListener(TOUR_START_EVENT, started);
    expect(started).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
