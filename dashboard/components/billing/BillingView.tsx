'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Api } from '../../lib/api';
import { useActiveTenantId } from '../../lib/SessionContext';
import { showToast } from '../ui/Toast';
import type { UsageStatementResult } from '../../lib/types';

type PlanKey = 'solo' | 'growth' | 'professional';
type SubscriptionStatus = 'inactive' | 'active' | 'past_due' | 'canceled';

interface BillingStatus {
  subscription_status: SubscriptionStatus;
  subscription_plan: PlanKey | null;
  /** `fixture` when the backend is activating plans locally, with no Stripe account. */
  billing_mode?: 'fixture' | 'stripe';
}

const PLANS: {
  key: PlanKey;
  name: string;
  price: number;
  calls: string;
  features: string[];
}[] = [
  {
    key: 'solo',
    name: 'Solo',
    price: 29.95,
    calls: '30 calls/month · $1.00 per extra call',
    features: ['AI receptionist 24/7', 'Appointment booking', 'SMS reminders', 'Knowledge base'],
  },
  {
    key: 'growth',
    name: 'Growth',
    price: 59.95,
    calls: '100 calls/month · $0.75 per extra call',
    features: [
      'Everything in Solo',
      'Call transfer to staff',
      'Analytics dashboard',
      'Priority support',
    ],
  },
  {
    key: 'professional',
    name: 'Professional',
    price: 149.95,
    calls: '300 calls/month · $0.60 per extra call',
    features: [
      'Everything in Growth',
      'Custom AI persona',
      'Calendar sync',
      'Dedicated onboarding',
    ],
  },
];

function statusBadge(status: SubscriptionStatus) {
  switch (status) {
    case 'active':
      return <Badge variant="success">Active</Badge>;
    case 'past_due':
      return <Badge variant="warning">Past Due</Badge>;
    case 'canceled':
      return <Badge variant="danger">Canceled</Badge>;
    default:
      return <Badge variant="secondary">Free Trial</Badge>;
  }
}

export default function BillingView() {
  const tenantId = useActiveTenantId();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [usage, setUsage] = useState<UsageStatementResult | null>(null);
  const [usageError, setUsageError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState<PlanKey | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);
  // Signup email not yet confirmed — checkout (so the trial and the phone line)
  // is refused until it is. Seeded from login/register, and also set when a
  // checkout attempt comes back email_not_verified.
  const [emailUnverified, setEmailUnverified] = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    try {
      setEmailUnverified(localStorage.getItem('emailVerified') === 'false');
    } catch {
      // localStorage unavailable — the checkout 403 still surfaces the notice.
    }
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    setUsageError(false);
    Api.billing
      .status(tenantId)
      .then((s) => setStatus(s as BillingStatus))
      .catch(() => showToast('Failed to load billing status', 'error'))
      .finally(() => setLoading(false));
    Api.billing
      .usage(tenantId, 6)
      .then((u) => setUsage(u))
      .catch(() => {
        setUsage(null);
        setUsageError(true);
      });
  }, [tenantId]);

  // Consume ?billing=success or ?billing=cancel from Stripe redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('billing');
    if (result === 'success' || result === 'fixture') {
      showToast(
        result === 'fixture'
          ? 'Plan activated locally. No card was charged.'
          : 'Payment successful — your subscription is now active!',
        result === 'fixture' ? 'info' : 'success'
      );
      params.delete('billing');
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
      if (tenantId) {
        Api.billing
          .status(tenantId)
          .then((s) => setStatus(s as BillingStatus))
          .catch(() =>
            showToast(
              result === 'fixture'
                ? 'Plan activated, but the status refresh failed — reload to see your new plan.'
                : 'Payment received, but the status refresh failed — reload to see your new plan.',
              'error'
            )
          );
      }
    } else if (result === 'cancel') {
      showToast('Checkout cancelled — no charge was made.', 'info');
      params.delete('billing');
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
    }
  }, [tenantId]);

  const handleUpgrade = useCallback(
    async (plan: PlanKey) => {
      if (!tenantId) return;
      setCheckingOut(plan);
      try {
        const { url } = await Api.billing.checkout(tenantId, plan);
        window.location.href = url;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.startsWith('Confirm your email')) {
          setEmailUnverified(true);
          showToast(msg, 'error');
        } else {
          showToast('Could not start checkout — try again.', 'error');
        }
        setCheckingOut(null);
      }
    },
    [tenantId]
  );

  const handleResendVerification = useCallback(async () => {
    setResending(true);
    try {
      const res = await Api.billing.resendVerification();
      if (res.already_verified) {
        setEmailUnverified(false);
        try {
          localStorage.setItem('emailVerified', 'true');
        } catch {
          // ignore — purely a UI hint
        }
        showToast('Your email is already confirmed — you can choose a plan.', 'success');
      } else {
        showToast(`We sent a new link to ${res.sent_to ?? 'your email'}.`, 'success');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not resend the email.', 'error');
    } finally {
      setResending(false);
    }
  }, []);

  const handleManageBilling = useCallback(async () => {
    if (!tenantId) return;
    setOpeningPortal(true);
    try {
      const { url } = await Api.billing.portal(tenantId);
      window.location.href = url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not open billing portal';
      showToast(msg, 'error');
      setOpeningPortal(false);
    }
  }, [tenantId]);

  const currentPlan = status?.subscription_plan ?? null;
  const currentStatus = status?.subscription_status ?? 'inactive';
  const hasActiveAccount = currentStatus === 'active' || currentStatus === 'past_due';

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {emailUnverified && (
        <div
          role="status"
          className="rounded-md px-4 py-3 text-sm flex flex-wrap items-center justify-between gap-3"
          style={{
            backgroundColor: 'rgba(245, 158, 11, 0.12)',
            color: 'var(--warning)',
            border: '1px solid rgba(245, 158, 11, 0.35)',
          }}
        >
          <span>
            Confirm your email to start your free trial. We sent a link to your inbox when you
            signed up.
          </span>
          <Button variant="secondary" onClick={handleResendVerification} disabled={resending}>
            {resending ? 'Sending…' : 'Resend email'}
          </Button>
        </div>
      )}

      {/* Current plan summary */}
      <Card className="p-6" style={{ backgroundColor: 'var(--bg-raised)' }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold mb-1">Current Plan</h2>
            {loading ? (
              <p className="text-sm text-muted">Loading…</p>
            ) : (
              <div className="flex items-center gap-3">
                <span className="text-2xl font-bold capitalize">{currentPlan ?? 'Free Trial'}</span>
                {statusBadge(currentStatus)}
              </div>
            )}
            {status?.billing_mode === 'fixture' && (
              <p className="text-sm mt-2" style={{ color: 'var(--text-muted)' }}>
                Local fixture billing is on. Choosing a plan activates it on this machine and does
                not charge a card. A Stripe account is still required before this business can take
                money.
              </p>
            )}
            {currentStatus === 'past_due' && (
              <p className="text-sm text-amber-400 mt-2">
                Payment failed — update your payment method to keep service active.
              </p>
            )}
            {currentStatus === 'canceled' && (
              <p className="text-sm text-red-400 mt-2">
                Subscription canceled — pick a plan below to resubscribe.
              </p>
            )}
          </div>
          {hasActiveAccount && (
            <Button
              variant="secondary"
              onClick={handleManageBilling}
              isLoading={openingPortal}
              disabled={openingPortal}
            >
              Manage Billing
            </Button>
          )}
        </div>
        {hasActiveAccount && (
          <p className="text-xs text-muted mt-4">
            Update payment method, view invoices, or cancel via the Stripe billing portal.
          </p>
        )}
      </Card>

      {/* Plan cards */}
      <div>
        <h3 className="text-base font-semibold mb-3">
          {currentPlan ? 'Change Plan' : 'Choose a Plan'}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {PLANS.map((plan) => {
            const isCurrent = plan.key === currentPlan && currentStatus === 'active';
            return (
              <Card
                key={plan.key}
                className="p-5 flex flex-col gap-4"
                style={{
                  backgroundColor: 'var(--bg-raised)',
                  outline: isCurrent ? '2px solid var(--accent)' : undefined,
                }}
              >
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-base">{plan.name}</span>
                    {isCurrent && <Badge variant="success">Current</Badge>}
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-2xl font-bold">${plan.price.toFixed(2)}</span>
                    <span className="text-sm text-muted">/mo</span>
                  </div>
                  <p className="text-xs text-muted mt-1">{plan.calls}</p>
                </div>
                <ul className="space-y-1.5 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="text-sm flex items-start gap-2">
                      <span className="text-green-400 mt-0.5 shrink-0">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  variant={isCurrent ? 'ghost' : 'primary'}
                  className="w-full"
                  disabled={isCurrent || checkingOut !== null}
                  isLoading={checkingOut === plan.key}
                  onClick={() => handleUpgrade(plan.key)}
                >
                  {isCurrent ? 'Current Plan' : 'Upgrade'}
                </Button>
              </Card>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted">
        Payments are processed securely by Stripe. Subscriptions renew monthly and can be canceled
        at any time.
      </p>

      <Card className="p-6" style={{ backgroundColor: 'var(--bg-raised)' }}>
        <h3 className="text-base font-semibold">Usage & Statements</h3>

        {usage === null && !usageError && <p className="text-sm text-muted mt-3">Loading usage…</p>}

        {usageError && (
          <p className="text-sm mt-3" style={{ color: 'var(--danger)' }}>
            Couldn't load usage right now — your calls are still being recorded.
          </p>
        )}

        {usage && usage.statements.length > 0 ? (
          <div className="space-y-4 mt-3">
            {usage.cap?.status === 'warn' && (
              <div
                role="status"
                className="rounded-md px-3 py-2 text-sm"
                style={{
                  backgroundColor: 'rgba(245, 158, 11, 0.12)',
                  color: 'var(--warning)',
                  border: '1px solid rgba(245, 158, 11, 0.35)',
                }}
              >
                You&apos;ve used{' '}
                {usage.cap.percent ?? Math.round((usage.cap.warnRatio || 0.8) * 100)}% of this
                month&apos;s call allowance
                {usage.cap.limit != null ? ` (${usage.cap.used} of ${usage.cap.limit})` : ''}.
                {usage.quota?.overagePerCallUsd != null
                  ? ` Past the allowance your line keeps answering, and each extra call is $${usage.quota.overagePerCallUsd.toFixed(2)}.`
                  : usage.cap.softCapEnforced
                    ? ' At 100% new calls are refused until next month — pick a plan to keep answering.'
                    : ''}
              </div>
            )}
            {usage.cap?.status === 'blocked' && (
              <div
                role="alert"
                className="rounded-md px-3 py-2 text-sm"
                style={{
                  backgroundColor: 'rgba(239, 68, 68, 0.12)',
                  color: 'var(--danger)',
                  border: '1px solid rgba(239, 68, 68, 0.35)',
                }}
              >
                Monthly call cap reached
                {usage.cap.limit != null ? ` (${usage.cap.used} of ${usage.cap.limit})` : ''}. New
                inbound calls are refused until the next billing month — pick a plan to keep
                answering.
              </div>
            )}
            {(() => {
              const current = usage.statements.find((statement) => statement.inProgress);
              if (!current) return null;

              const included = current.includedCalls;
              const percent =
                included && included > 0
                  ? Math.min(100, Math.round((current.answeredCalls / included) * 100))
                  : null;

              return (
                <div>
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <span className="text-sm font-medium">This month</span>
                    <span className="text-sm text-muted">
                      {current.answeredCalls}
                      {included ? ` of ${included}` : ''} answered calls
                      {current.freeCalls > 0 ? ` · ${current.freeCalls} short/spam (free)` : ''}
                    </span>
                  </div>

                  {percent !== null && (
                    <div
                      className="mt-2 h-2 rounded-full overflow-hidden"
                      style={{ backgroundColor: 'var(--bg-surface)' }}
                      role="progressbar"
                      aria-valuenow={current.answeredCalls}
                      aria-valuemin={0}
                      aria-valuemax={included ?? undefined}
                      aria-label="Answered calls used this month"
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${percent}%`,
                          backgroundColor:
                            percent >= 100
                              ? 'var(--danger)'
                              : percent >= Math.round((usage.cap?.warnRatio ?? 0.8) * 100)
                                ? 'var(--warning)'
                                : 'var(--accent)',
                        }}
                      />
                    </div>
                  )}

                  {current.overageCalls !== null &&
                    current.overageCalls > 0 &&
                    current.overageChargeUsd !== null && (
                      <p className="text-xs mt-2" style={{ color: 'var(--warning)' }}>
                        {current.overageCalls} extra call{current.overageCalls === 1 ? '' : 's'}{' '}
                        this month
                        {usage.quota?.overagePerCallUsd != null
                          ? ` at $${usage.quota.overagePerCallUsd.toFixed(2)} each`
                          : ''}{' '}
                        (+${current.overageChargeUsd.toFixed(2)}). Your line keeps answering.
                      </p>
                    )}
                </div>
              );
            })()}

            <div className="divide-y" style={{ borderColor: 'var(--border-soft)' }}>
              {usage.statements.map((statement) => (
                <div
                  key={statement.month}
                  className="py-2 flex items-center justify-between gap-3 text-sm"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium">{statement.month}</span>
                    {statement.inProgress && <Badge variant="secondary">in progress</Badge>}
                  </div>
                  <div className="text-right shrink-0">
                    <span>
                      {statement.answeredCalls} answered
                      {statement.freeCalls > 0 ? ` · ${statement.freeCalls} free` : ''}
                    </span>
                    <span className="ml-3 font-semibold">
                      {statement.overageChargeUsd == null
                        ? '—'
                        : statement.overageChargeUsd > 0
                          ? `+$${statement.overageChargeUsd.toFixed(2)} extra calls`
                          : 'included'}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <p className="text-xs text-muted">
              An answered call means a caller actually spoke for {usage.billableMinSeconds}+ seconds
              — short rings, silent calls, and spam are always free. Statements live right here;
              nothing is mailed.
              {usage.plan === null &&
                ' No active plan yet, so usage is informational — pick a plan below.'}
            </p>
          </div>
        ) : null}

        {usage && usage.statements.length === 0 && !usageError && (
          <p className="text-sm text-muted mt-3">No calls recorded yet — usage will appear here.</p>
        )}
      </Card>
    </div>
  );
}
