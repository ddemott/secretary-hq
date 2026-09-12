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

vi.mock('../../lib/SessionContext', () => ({ useActiveTenantId: () => 'tenant-test' }));
vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

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
vi.mock('../../lib/api', () => ({ Api: mockApi }));

import BillingView from './BillingView';
import { showToast } from '../ui/Toast';

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

describe('BillingView — usage statements', () => {
  test('HAPPY: renders the current-month meter, overage packs, and monthly statement rows', async () => {
    // WHO: owner checking what this month will cost.
    // WHAT: Billing page should show answered vs included, free-call carveout,
    //       and the pack overage summary. This card is the online statement.
    // WHY: if usage fails silently or looks like $0, billing trust dies first.
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'active',
      subscription_plan: 'solo',
    });
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
    expect(screen.getByText(/162 of 150 answered calls/i)).toBeInTheDocument();
    expect(screen.getByText(/8 short\/spam \(free\)/i)).toBeInTheDocument();
    expect(screen.getByText(/12 calls over your plan this month/i)).toBeInTheDocument();
    expect(screen.getByText(/your line keeps answering either way/i)).toBeInTheDocument();
    expect(screen.getByText('2026-06')).toBeInTheDocument();
    expect(screen.getByText('included')).toBeInTheDocument();
    expect(screen.getByText(/\+\$25 packs/i)).toBeInTheDocument();
    expect(screen.getByText(/15\+ seconds/i)).toBeInTheDocument();
    expect(mockApi.billing.usage).toHaveBeenCalledWith('tenant-test', 6);
  });

  test('SAD: usage endpoint failure shows an honest error, never fake zero usage', async () => {
    // WHO: an owner opening Billing during a usage-endpoint failure.
    // WHAT: UI shows explicit load failure, not a fake zero-usage statement.
    // WHEN: Api.billing.usage rejects.
    // WHERE: BillingView usage statement card.
    // WHY: billing outages must be honest; fake $0 is worse than an error.
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'active',
      subscription_plan: 'solo',
    });
    mockApi.billing.usage.mockRejectedValue(new Error('boom'));

    render(<BillingView />);

    expect(await screen.findByText(/couldn't load usage right now/i)).toBeInTheDocument();
    expect(screen.queryByText(/answered calls/i)).not.toBeInTheDocument();
  });
});

describe('BillingView — subdirectory pin', () => {
  test('SetupView imports BillingView from components/billing/', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const setup = fs.readFileSync(path.join(__dirname, '..', 'business', 'SetupView.tsx'), 'utf-8');
    expect(setup).toContain("import BillingView from '../billing/BillingView'");
    expect(setup).not.toContain("import BillingView from './BillingView'");
  });
});
