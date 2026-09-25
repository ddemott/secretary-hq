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
      resendVerification: vi.fn(),
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
      subscription_plan: 'growth',
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
    // Owner-decided tiers, 2026-09-24 (docs/planning/TODO.md P0 §2).
    await waitFor(() => expect(screen.getByText('$29.95')).toBeInTheDocument());
    expect(screen.getByText('$59.95')).toBeInTheDocument();
    expect(screen.getByText('$149.95')).toBeInTheDocument();
    expect(screen.getByText('30 calls/month · $1.00 per extra call')).toBeInTheDocument();
    expect(screen.getByText('100 calls/month · $0.75 per extra call')).toBeInTheDocument();
    expect(screen.getByText('300 calls/month · $0.60 per extra call')).toBeInTheDocument();
  });

  test('HAPPY: active plan shows "Current Plan" badge and disabled button', async () => {
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'active',
      subscription_plan: 'growth',
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
    mockApi.billing.checkout.mockResolvedValue({
      success: true,
      url: 'https://stripe.example.com/checkout',
    });
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

  test('SAD: a network failure (apiMutate throws) shows the generic toast', async () => {
    mockApi.billing.checkout.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<BillingView />);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /upgrade/i })).toHaveLength(3)
    );
    fireEvent.click(screen.getAllByRole('button', { name: /upgrade/i })[0]);
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('Could not start checkout — try again.', 'error')
    );
  });

  test('REGRESSION: a refused checkout (resolved success:false) toasts the server error and does NOT redirect', async () => {
    // WHO: an owner whose checkout the backend refuses (503 price not configured, etc.)
    // WHAT: apiMutate RESOLVES { success:false, error } — it does not throw. The page
    //       must read that, show the message, and stay put.
    // WHY: before this, the code destructured `url` from the resolved error object
    //      and set window.location.href = undefined (found in review of PR #567).
    mockApi.billing.checkout.mockResolvedValue({
      success: false,
      error: 'Price ID not configured for solo plan',
    });
    delete (window as unknown as Record<string, unknown>).location;
    (window as unknown as Record<string, unknown>).location = { href: '' };
    render(<BillingView />);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /upgrade/i })).toHaveLength(3)
    );
    fireEvent.click(screen.getAllByRole('button', { name: /upgrade/i })[0]);

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('Price ID not configured for solo plan', 'error')
    );
    expect(window.location.href).toBe('');
    expect(screen.getAllByRole('button', { name: /upgrade/i })[0]).not.toBeDisabled();
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
    mockApi.billing.portal.mockResolvedValue({
      success: true,
      url: 'https://billing.stripe.com/portal',
    });
    render(<BillingView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /manage billing/i })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: /manage billing/i }));
    await waitFor(() => expect(mockApi.billing.portal).toHaveBeenCalledWith('tenant-test'));
  });

  test('SAD: a refused portal request (resolved success:false) shows the server error', async () => {
    mockApi.billing.portal.mockResolvedValue({ success: false, error: 'Portal unavailable' });
    render(<BillingView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /manage billing/i })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: /manage billing/i }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Portal unavailable', 'error'));
  });
});

describe('BillingView — usage statements', () => {
  test('HAPPY: renders the current-month meter and monthly statement rows', async () => {
    // WHO: owner checking what this month will cost.
    // WHAT: Billing page should show answered vs included, free-call carveout,
    //       and the per-month statement rows. This card is the online statement.
    // WHY: if usage fails silently or looks like $0, billing trust dies first.
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'active',
      subscription_plan: 'growth',
    });
    mockApi.billing.usage.mockResolvedValue({
      plan: 'growth',
      quota: { includedCalls: 100, overagePerCallUsd: 0.75 },
      billableMinSeconds: 15,
      monthBoundaries: 'utc',
      cap: {
        plan: 'growth',
        used: 62,
        limit: 100,
        percent: 62,
        status: 'ok',
        softCapEnforced: true,
        warnRatio: 0.8,
        blocked: false,
      },
      statements: [
        {
          month: '2026-07',
          totalCalls: 70,
          answeredCalls: 62,
          freeCalls: 8,
          includedCalls: 100,
          overageCalls: 0,
          overageChargeUsd: 0,
          inProgress: true,
        },
        {
          month: '2026-06',
          totalCalls: 90,
          answeredCalls: 84,
          freeCalls: 6,
          includedCalls: 100,
          overageCalls: 0,
          overageChargeUsd: 0,
          inProgress: false,
        },
      ],
    });

    render(<BillingView />);

    expect(await screen.findByText('Usage & Statements')).toBeInTheDocument();
    expect(screen.getByText(/62 of 100 answered calls/i)).toBeInTheDocument();
    expect(screen.getByText(/8 short\/spam \(free\)/i)).toBeInTheDocument();
    expect(screen.getByText('2026-06')).toBeInTheDocument();
    expect(screen.getAllByText('included').length).toBeGreaterThan(0);
    expect(screen.getByText(/15\+ seconds/i)).toBeInTheDocument();
    expect(mockApi.billing.usage).toHaveBeenCalledWith('tenant-test', 6);
  });

  test('HAPPY: 80% warn banner appears when cap.status is warn', async () => {
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'active',
      subscription_plan: 'growth',
    });
    mockApi.billing.usage.mockResolvedValue({
      plan: 'growth',
      quota: { includedCalls: 100, overagePerCallUsd: 0.75 },
      billableMinSeconds: 15,
      monthBoundaries: 'utc',
      cap: {
        plan: 'growth',
        used: 80,
        limit: 100,
        percent: 80,
        status: 'warn',
        softCapEnforced: true,
        warnRatio: 0.8,
        blocked: false,
      },
      statements: [
        {
          month: '2026-07',
          totalCalls: 90,
          answeredCalls: 80,
          freeCalls: 10,
          includedCalls: 100,
          overageCalls: 0,
          overageChargeUsd: 0,
          inProgress: true,
        },
      ],
    });

    render(<BillingView />);
    expect(await screen.findByRole('status')).toHaveTextContent(/80% of this month/i);
  });

  test('HAPPY: blocked banner is the free tier only — no plan, calls refused at the cap', async () => {
    // WHO: a tenant with no paid plan whose free allowance is used up.
    // WHAT: alert says the cap is reached and new calls are refused until a plan is picked.
    // WHY: since 2026-09-24 only the free tier can be blocked; paid plans bill overage.
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'inactive',
      subscription_plan: null,
    });
    mockApi.billing.usage.mockResolvedValue({
      plan: null,
      quota: { includedCalls: 50, overagePerCallUsd: null },
      billableMinSeconds: 15,
      monthBoundaries: 'utc',
      cap: {
        plan: null,
        used: 50,
        limit: 50,
        percent: 100,
        status: 'blocked',
        softCapEnforced: true,
        warnRatio: 0.8,
        blocked: true,
        freeTierApplied: true,
      },
      statements: [
        {
          month: '2026-07',
          totalCalls: 55,
          answeredCalls: 50,
          freeCalls: 5,
          includedCalls: 50,
          overageCalls: null,
          overageChargeUsd: null,
          inProgress: true,
        },
      ],
    });

    render(<BillingView />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/monthly call cap reached/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/refused until the next billing month/i);
  });

  test('HAPPY: a paid plan past its allowance shows the per-call overage, and no blocked alert', async () => {
    // WHO: a tier-2 owner 12 calls past the 100-call allowance.
    // WHAT: the card says the line keeps answering and shows 12 × $0.75 = +$9.00;
    //       the statement row shows the charge; there is no "cap reached" alert.
    // WHEN: cap.status is 'overage'.
    // WHERE: BillingView current-month section and statement rows.
    // WHY: owner decision 2026-09-24 — paid plans are never refused; the owner must see
    //      what the extra calls will cost before the bill arrives.
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'active',
      subscription_plan: 'growth',
    });
    mockApi.billing.usage.mockResolvedValue({
      plan: 'growth',
      quota: { includedCalls: 100, overagePerCallUsd: 0.75 },
      billableMinSeconds: 15,
      monthBoundaries: 'utc',
      cap: {
        plan: 'growth',
        used: 112,
        limit: 100,
        percent: 100,
        status: 'overage',
        softCapEnforced: true,
        warnRatio: 0.8,
        blocked: false,
        freeTierApplied: false,
      },
      statements: [
        {
          month: '2026-07',
          totalCalls: 120,
          answeredCalls: 112,
          freeCalls: 8,
          includedCalls: 100,
          overageCalls: 12,
          overageChargeUsd: 9,
          inProgress: true,
        },
      ],
    });

    render(<BillingView />);
    expect(
      await screen.findByText(/12 extra calls this month at \$0\.75 each \(\+\$9\.00\)/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/your line keeps answering/i)).toBeInTheDocument();
    expect(screen.getByText('+$9.00 extra calls')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('SAD: usage endpoint failure shows an honest error, never fake zero usage', async () => {
    // WHO: an owner opening Billing during a usage-endpoint failure.
    // WHAT: UI shows explicit load failure, not a fake zero-usage statement.
    // WHEN: Api.billing.usage rejects.
    // WHERE: BillingView usage statement card.
    // WHY: billing outages must be honest; fake $0 is worse than an error.
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'active',
      subscription_plan: 'growth',
    });
    mockApi.billing.usage.mockRejectedValue(new Error('boom'));

    render(<BillingView />);

    expect(await screen.findByText(/couldn't load usage right now/i)).toBeInTheDocument();
    expect(screen.queryByText(/answered calls/i)).not.toBeInTheDocument();
  });
});

describe('BillingView — post-checkout status refetch', () => {
  function stubLocation(search: string) {
    Object.defineProperty(window, 'location', {
      writable: true,
      configurable: true,
      value: { ...origLocation, search, pathname: '/dashboard' },
    });
  }

  test('HAPPY: billing_mode fixture explains that no card is charged', async () => {
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'active',
      subscription_plan: 'growth',
      billing_mode: 'fixture',
    });
    render(<BillingView />);
    expect(await screen.findByText(/Local fixture billing is on/)).toBeInTheDocument();
  });

  test('HAPPY: ?billing=fixture refetches and does not claim a payment', async () => {
    stubLocation('?billing=fixture');
    mockApi.billing.status
      .mockResolvedValueOnce({ subscription_status: 'inactive', subscription_plan: null })
      .mockResolvedValueOnce({
        subscription_status: 'active',
        subscription_plan: 'growth',
        billing_mode: 'fixture',
      });

    render(<BillingView />);

    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('Plan activated locally. No card was charged.', 'info');
    expect(mockToast).not.toHaveBeenCalledWith(
      'Payment successful — your subscription is now active!',
      'success'
    );
  });

  test('HAPPY: ?billing=success refetches status and shows the new plan', async () => {
    // WHO: tenant owner returning from a successful Stripe checkout
    // WHAT: the redirect toast fires AND the status refetch lands, so the
    //   badge reflects the plan they just paid for without a manual reload
    // WHERE: BillingView's ?billing=success effect
    stubLocation('?billing=success');
    mockApi.billing.status
      .mockResolvedValueOnce({ subscription_status: 'inactive', subscription_plan: null })
      .mockResolvedValueOnce({ subscription_status: 'active', subscription_plan: 'growth' });

    render(<BillingView />);

    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith(
      'Payment successful — your subscription is now active!',
      'success'
    );
  });

  test('SAD: ?billing=success refetch fails — caller is told to reload, not left silent', async () => {
    // WHO: same tenant owner, but the post-payment refetch itself errors
    // WHAT: the ORIGINAL code swallowed this with `.catch(() => null)` — the
    //   caller just paid, sees "Payment successful", and the status badge
    //   silently stays on the OLD plan with no indication anything is wrong.
    //   The initial-mount fetch of this exact same endpoint already shows an
    //   error toast on failure (see the SAD test above); this path must too.
    // WHERE: BillingView's ?billing=success effect, refetch .catch()
    stubLocation('?billing=success');
    mockApi.billing.status
      .mockResolvedValueOnce({ subscription_status: 'inactive', subscription_plan: null })
      .mockRejectedValueOnce(new Error('Network error'));

    render(<BillingView />);

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.stringMatching(/reload to see your new plan/i),
        'error'
      )
    );
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

describe('BillingView — email verification notice', () => {
  test('SAD: a checkout refused as email_not_verified shows the notice and the server message', async () => {
    // WHO: an owner who signed up but never clicked the verification link
    // WHAT: Upgrade → backend 403 "Confirm your email first…" → notice with Resend
    // WHY: owner decision 2026-09-24 — no trial until the email is proven
    localStorage.removeItem('emailVerified');
    // The real shape: apiMutate resolves the 403 body with success:false.
    mockApi.billing.checkout.mockResolvedValue({
      success: false,
      error_code: 'email_not_verified',
      error: 'Confirm your email first — we sent a link to owner@test.com.',
    });
    render(<BillingView />);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /upgrade/i })).toHaveLength(3)
    );
    expect(screen.queryByRole('button', { name: /resend email/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: /upgrade/i })[0]);

    expect(await screen.findByRole('button', { name: /resend email/i })).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith(
      'Confirm your email first — we sent a link to owner@test.com.',
      'error'
    );
  });

  test('HAPPY: the notice shows up front when login said the email is unverified, and Resend sends a new link', async () => {
    localStorage.setItem('emailVerified', 'false');
    mockApi.billing.resendVerification.mockResolvedValue({
      success: true,
      sent_to: 'owner@test.com',
    });
    render(<BillingView />);

    fireEvent.click(await screen.findByRole('button', { name: /resend email/i }));

    await waitFor(() => expect(mockApi.billing.resendVerification).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('We sent a new link to owner@test.com.', 'success')
    );
    localStorage.removeItem('emailVerified');
  });

  test('HAPPY: if the email turns out to be verified already, the notice goes away', async () => {
    localStorage.setItem('emailVerified', 'false');
    mockApi.billing.resendVerification.mockResolvedValue({ success: true, already_verified: true });
    render(<BillingView />);

    fireEvent.click(await screen.findByRole('button', { name: /resend email/i }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /resend email/i })).not.toBeInTheDocument()
    );
    expect(localStorage.getItem('emailVerified')).toBe('true');
    localStorage.removeItem('emailVerified');
  });
});

describe('BillingView — resend failure', () => {
  test('SAD: a refused resend (e.g. rate limited) shows the error, not a false "sent"', async () => {
    localStorage.setItem('emailVerified', 'false');
    mockApi.billing.resendVerification.mockResolvedValue({
      success: false,
      error: 'Rate limit exceeded, retry in 1 hour',
    });
    render(<BillingView />);

    fireEvent.click(await screen.findByRole('button', { name: /resend email/i }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('Rate limit exceeded, retry in 1 hour', 'error')
    );
    expect(mockToast).not.toHaveBeenCalledWith(expect.stringMatching(/sent a new link/), 'success');
    localStorage.removeItem('emailVerified');
  });
});

describe('BillingView — plan features', () => {
  test('call transfer is listed on the base (Solo) plan, so every plan includes it', async () => {
    // WHO: an owner comparing plans
    // WHAT: "Transfers to a person" sits in Solo; Growth/Professional say
    //       "Everything in …", so no plan appears to lack it
    // WHY: Dale 2026-09-25 — every plan has call transfer; it used to be listed
    //      only under Growth, implying Solo could not transfer (it always could)
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'inactive',
      subscription_plan: null,
    });
    render(<BillingView />);
    // Exact copy, including the qualifier: transfer is offered only once the
    // business sets a transfer number (otherwise the AI takes a message).
    const TRANSFER = 'Transfers callers to a person on request (once you set a transfer number)';
    expect(await screen.findByText(TRANSFER)).toBeInTheDocument();
    expect(screen.getAllByText(TRANSFER)).toHaveLength(1);
    expect(screen.queryByText('Call transfer to staff')).not.toBeInTheDocument();
    expect(screen.getByText('Everything in Solo')).toBeInTheDocument();
    expect(screen.getByText('Everything in Growth')).toBeInTheDocument();
  });
});

describe('BillingView — network failures', () => {
  test('SAD: resend throwing (network down) shows the error instead of a false "sent"', async () => {
    localStorage.setItem('emailVerified', 'false');
    mockApi.billing.resendVerification.mockRejectedValue(new Error('Failed to fetch'));
    render(<BillingView />);

    fireEvent.click(await screen.findByRole('button', { name: /resend email/i }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Failed to fetch', 'error'));
    expect(screen.getByRole('button', { name: /resend email/i })).not.toBeDisabled();
    localStorage.removeItem('emailVerified');
  });

  test('SAD: portal throwing (network down) shows the error and re-enables the button', async () => {
    mockApi.billing.status.mockResolvedValue({
      subscription_status: 'active',
      subscription_plan: 'growth',
    });
    mockApi.billing.portal.mockRejectedValue(new Error('Failed to fetch'));
    render(<BillingView />);
    fireEvent.click(await screen.findByRole('button', { name: /manage billing/i }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Failed to fetch', 'error'));
    expect(screen.getByRole('button', { name: /manage billing/i })).not.toBeDisabled();
  });
});
