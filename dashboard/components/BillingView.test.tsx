/**
 * BillingView — subscription status display, plan cards, checkout, portal.
 *
 * WHO: Tenant owner viewing or changing their SaaS subscription.
 * WHAT: Loads billing status, shows current plan badge, renders 3 plan cards,
 *   handles Stripe checkout redirect and billing portal launch.
 * WHERE: components/BillingView.tsx — 0% coverage.
 * WHY: Checkout + portal redirect paths were completely untested; a broken
 *   Api.billing.checkout call would show no error and leave the user stuck.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('../lib/SessionContext', () => ({ useActiveTenantId: () => 'tenant-test' }));
vi.mock('./ui/Toast', () => ({ showToast: vi.fn() }));

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    billing: {
      status: vi.fn(),
      checkout: vi.fn(),
      portal: vi.fn(),
      usage: vi.fn(),
    },
  },
}));
vi.mock('../lib/api', () => ({ Api: mockApi }));

import BillingView from './BillingView';
import { showToast } from './ui/Toast';

const mockToast = vi.mocked(showToast);

// Capture original location so tests that stub it can restore cleanly.
const origLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: inactive free-trial tenant
  mockApi.billing.status.mockResolvedValue({
    subscription_status: 'inactive',
    subscription_plan: null,
  });
  // Default: no calls yet (the empty-usage path).
  mockApi.billing.usage.mockResolvedValue({
    plan: null,
    quota: null,
    billableMinSeconds: 15,
    monthBoundaries: 'utc',
    statements: [],
  });
});

afterEach(() => {
  // Restore window.location after any test that stubs it for redirect assertions.
  Object.defineProperty(window, 'location', {
    writable: true,
    configurable: true,
    value: origLocation,
  });
});

describe('BillingView — current plan display', () => {
  test('HAPPY: shows "Free Trial" when plan is null / inactive', async () => {
    render(<BillingView />);
    // Two "Free Trial" texts: plan name span + status badge — both must be present
    await waitFor(() => expect(screen.getAllByText('Free Trial')).toHaveLength(2));
  });

  test('HAPPY: shows active plan name when subscription is active', async () => {
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'active',
      subscription_plan: 'growth',
    });
    render(<BillingView />);
    // ANCHOR THE WAIT ON API-DEPENDENT TEXT. The static plan card renders
    // "Growth" before the mocked status resolves, so a waitFor on /^growth$/i
    // could pass immediately and the 'Active' badge assertion then raced the
    // fetch — green locally for weeks, failed on a slower CI runner (PR #274,
    // whose diff touched no dashboard file at all). 'Active' only renders from
    // the API response, so waiting on IT is waiting on the thing under test.
    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    // Plan name appears in the header span (capitalize = "growth") plus the
    // static plan card heading "Growth" — getAllByText matches both.
    expect(screen.getAllByText(/^growth$/i).length).toBeGreaterThan(0);
  });

  test('HAPPY: shows Past Due badge when status is past_due', async () => {
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'past_due',
      subscription_plan: 'solo',
    });
    render(<BillingView />);
    await waitFor(() => expect(screen.getByText('Past Due')).toBeInTheDocument());
    expect(screen.getByText(/payment failed/i)).toBeInTheDocument();
  });

  test('HAPPY: shows Canceled badge and resubscribe message', async () => {
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'canceled',
      subscription_plan: null,
    });
    render(<BillingView />);
    await waitFor(() => expect(screen.getByText('Canceled')).toBeInTheDocument());
    expect(screen.getByText(/subscription canceled/i)).toBeInTheDocument();
  });

  test('HAPPY: shows Manage Billing button when account is active', async () => {
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'active',
      subscription_plan: 'professional',
    });
    render(<BillingView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /manage billing/i })).toBeInTheDocument()
    );
  });

  test('HAPPY: no Manage Billing button when account is inactive', async () => {
    render(<BillingView />);
    await waitFor(() => expect(screen.getAllByText('Free Trial')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: /manage billing/i })).not.toBeInTheDocument();
  });

  test('SAD: billing.status error shows error toast', async () => {
    mockApi.billing.status.mockRejectedValue(new Error('Network error'));
    render(<BillingView />);
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('Failed to load billing status', 'error')
    );
  });
});

describe('BillingView — plan cards', () => {
  test('HAPPY: renders all 3 plan cards (Solo, Growth, Professional)', async () => {
    render(<BillingView />);
    await waitFor(() => expect(screen.getByText('Solo')).toBeInTheDocument());
    expect(screen.getByText('Growth')).toBeInTheDocument();
    expect(screen.getByText('Professional')).toBeInTheDocument();
  });

  test('HAPPY: shows plan prices', async () => {
    render(<BillingView />);
    await waitFor(() => expect(screen.getByText('$129')).toBeInTheDocument());
    expect(screen.getByText('$279')).toBeInTheDocument();
    expect(screen.getByText('$449')).toBeInTheDocument();
  });

  test('HAPPY: active plan shows "Current Plan" badge and disabled button', async () => {
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'active',
      subscription_plan: 'solo',
    });
    render(<BillingView />);
    await waitFor(() => expect(screen.getByText('Current')).toBeInTheDocument());
    // The current plan's button should be disabled
    const currentBtn = screen.getByRole('button', { name: /current plan/i });
    expect(currentBtn).toBeDisabled();
  });
});

describe('BillingView — checkout flow', () => {
  test('HAPPY: clicking Upgrade calls Api.billing.checkout with correct plan', async () => {
    mockApi.billing.checkout.mockResolvedValue({ url: 'https://stripe.example.com/checkout' });
    // Delete and redefine so href is writable in jsdom
    delete (window as unknown as Record<string, unknown>).location;
    (window as unknown as Record<string, unknown>).location = { href: '' };
    render(<BillingView />);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /upgrade/i })).toHaveLength(3)
    );
    fireEvent.click(screen.getAllByRole('button', { name: /upgrade/i })[0]);
    await waitFor(() =>
      expect(mockApi.billing.checkout).toHaveBeenCalledWith('tenant-test', 'solo')
    );
  });

  test('SAD: checkout failure shows error toast and re-enables button', async () => {
    mockApi.billing.checkout.mockRejectedValue(new Error('Stripe error'));
    render(<BillingView />);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /upgrade/i })).toHaveLength(3)
    );
    fireEvent.click(screen.getAllByRole('button', { name: /upgrade/i })[0]);
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('Could not start checkout — try again.', 'error')
    );
  });
});

describe('BillingView — billing portal', () => {
  beforeEach(() => {
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'active',
      subscription_plan: 'growth',
    });
    delete (window as unknown as Record<string, unknown>).location;
    (window as unknown as Record<string, unknown>).location = { href: '' };
  });

  test('HAPPY: clicking Manage Billing opens the Stripe portal', async () => {
    mockApi.billing.portal.mockResolvedValue({ url: 'https://billing.stripe.com/portal' });
    render(<BillingView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /manage billing/i })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: /manage billing/i }));
    await waitFor(() => expect(mockApi.billing.portal).toHaveBeenCalledWith('tenant-test'));
  });

  test('SAD: portal failure shows error toast', async () => {
    mockApi.billing.portal.mockRejectedValue(new Error('Portal unavailable'));
    render(<BillingView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /manage billing/i })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: /manage billing/i }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Portal unavailable', 'error'));
  });
});

describe('BillingView — Usage & Statements (2026-07-20 online billing statement)', () => {
  test('HAPPY: renders the current-month meter, overage packs, and monthly statement rows', async () => {
    // WHO: an owner on the Solo plan checking what this month will cost.
    // WHAT: the Usage & Statements card shows answered-vs-included with a
    //        meter, free (spam/short) calls labeled free, the auto-applied
    //        pack charge for an over-quota month, and one row per month.
    // WHEN: usage returns an in-progress month 12-over quota + a final month.
    // WHERE: BillingView Usage & Statements card (GET /billing/usage).
    // WHY: the statement is ONLINE-ONLY ("no paper") — this card IS the bill;
    //       if it lies or vanishes, the owner's only statement is gone.
    mockApi.billing.usage.mockResolvedValue({
      plan: 'solo',
      quota: { includedCalls: 150, packCalls: 30, packPriceUsd: 25 },
      billableMinSeconds: 15,
      monthBoundaries: 'utc',
      statements: [
        {
          month: '2026-07',
          totalCalls: 170,
          answeredCalls: 162,
          freeCalls: 8,
          includedCalls: 150,
          overageCalls: 12,
          packsApplied: 1,
          packChargeUsd: 25,
          inProgress: true,
        },
        {
          month: '2026-06',
          totalCalls: 90,
          answeredCalls: 84,
          freeCalls: 6,
          includedCalls: 150,
          overageCalls: 0,
          packsApplied: 0,
          packChargeUsd: 0,
          inProgress: false,
        },
      ],
    });

    render(<BillingView />);

    expect(await screen.findByText('Usage & Statements')).toBeInTheDocument();
    // Current-month meter: answered of included + free calls labeled free.
    expect(screen.getByText(/162 of 150 answered calls/)).toBeInTheDocument();
    expect(screen.getByText(/8 short\/spam \(free\)/)).toBeInTheDocument();
    // The overage line: packs auto-apply, the line KEEPS ANSWERING.
    expect(screen.getByText(/12 calls over your plan/)).toBeInTheDocument();
    expect(screen.getByText(/keeps answering/)).toBeInTheDocument();
    // Statement rows: over month shows the pack charge, covered month "included".
    expect(screen.getByText('2026-06')).toBeInTheDocument();
    expect(screen.getByText('included')).toBeInTheDocument();
    expect(screen.getByText(/\+\$25 packs/)).toBeInTheDocument();
    // The billable definition is stated on the statement itself.
    expect(screen.getByText(/15\+\s*seconds/)).toBeInTheDocument();
  });

  test('SAD: usage endpoint failing shows an honest error, never a fake $0 statement', async () => {
    // WHO: an owner opening Billing during a backend blip.
    // WHAT: the card must say usage could not load (and that recording
    //        continues) — NOT render an empty/zero statement that reads as
    //        "no charges this month".
    // WHEN: GET /billing/usage rejects.
    // WHERE: BillingView usageError branch.
    // WHY: a $0-looking bill that is actually an error is a trust killer at
    //       the exact spot trust matters most.
    mockApi.billing.usage.mockRejectedValue(new Error('boom'));

    render(<BillingView />);

    expect(await screen.findByText(/Couldn't load usage right now/)).toBeInTheDocument();
    expect(screen.queryByText(/answered calls/)).not.toBeInTheDocument();
  });
});
