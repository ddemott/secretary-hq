/**
 * Usage metering + monthly billing statements, computed from voice_sessions.
 *
 * THE MODEL (decided 2026-07-20, recorded in docs/TODO.md §2 Billing):
 *   - The billing unit is the ANSWERED call: the session completed, the CALLER
 *     actually spoke, and the call lasted at least BILLABLE_MIN_SECONDS.
 *     Silent rooms, instant hang-ups, spam and robocalls are FREE — both
 *     honest and a differentiator ("spam never bills").
 *   - Flat plan tiers include a quota of answered calls. Overage is billed as
 *     auto-applied fixed-price CALL PACKS (the surviving telecom model:
 *     postpaid auto-blocks, never a running per-unit meter, never bill shock).
 *   - Service is NEVER cut on quota — "that's like a punch in the gut": a
 *     capped line punishes the tenant's CUSTOMERS for the tenant's success.
 *     Overage bills; the owner adjusts the plan the following month. Only
 *     ordinary dunning (non-payment) ever stops the line.
 *
 * "Caller spoke" is detected from the transcript the agent already records:
 * TranscriptRecorder renders caller turns as lines starting "Caller:". A
 * transcript with no such line is a greeting into dead air.
 *
 * Month boundaries are UTC for now — a known simplification, noted in the
 * statement payload so the UI can label it. Per-tenant-timezone statements can
 * come with real billing integration.
 *
 * This module COMPUTES statements; it does not charge anyone. Stripe pack
 * charging (invoice items on the existing subscription) is the follow-up step
 * in docs/TODO.md, gated on final tier pricing.
 */
import type { Pool } from 'pg';

/** A call shorter than this is not billable, whatever else happened. */
export const BILLABLE_MIN_SECONDS = 15;

export interface PlanQuota {
  /** Answered calls included in the flat monthly price. */
  includedCalls: number;
  /** Calls per auto-applied overage pack. */
  packCalls: number;
  /** Price of one pack, USD. */
  packPriceUsd: number;
}

/**
 * Quotas keyed by tenants.subscription_plan. Placeholder dollar amounts match
 * the landing page ($129/$279) and the pack shape from the 2026-07-20 pricing
 * discussion; final numbers are Dale's call (docs/TODO.md P0 §2) and live in
 * exactly this one place.
 */
export const PLAN_QUOTAS: Record<string, PlanQuota> = {
  solo: { includedCalls: 150, packCalls: 30, packPriceUsd: 25 },
  growth: { includedCalls: 500, packCalls: 30, packPriceUsd: 25 },
};

export interface MonthlyStatement {
  /** 'YYYY-MM', UTC month. */
  month: string;
  /** Every session the agent opened, billable or not. */
  totalCalls: number;
  /** The billable subset: completed + caller spoke + >= BILLABLE_MIN_SECONDS. */
  answeredCalls: number;
  /** totalCalls - answeredCalls — shown to the owner as "free" (spam/silent/short). */
  freeCalls: number;
  /** Quota fields are null when the tenant has no recognized plan. */
  includedCalls: number | null;
  overageCalls: number | null;
  packsApplied: number | null;
  packChargeUsd: number | null;
  /** True for the month still in progress — numbers are running, not final. */
  inProgress: boolean;
}

export interface UsageStatementResult {
  plan: string | null;
  quota: PlanQuota | null;
  billableMinSeconds: number;
  monthBoundaries: 'utc';
  statements: MonthlyStatement[];
}

export async function computeUsageStatements(
  pool: Pool,
  tenantId: string,
  monthsBack: number
): Promise<UsageStatementResult> {
  const months = Math.min(Math.max(monthsBack, 1), 24);

  const tenantRes = await pool.query<{ subscription_plan: string | null }>(
    'SELECT subscription_plan FROM tenants WHERE tenant_id = $1',
    [tenantId]
  );
  if (tenantRes.rows.length === 0) throw new Error('Tenant not found');
  const plan = tenantRes.rows[0].subscription_plan;
  const quota = plan ? (PLAN_QUOTAS[plan] ?? null) : null;

  const usage = await pool.query<{ month: string; total: number; answered: number }>(
    `SELECT to_char(date_trunc('month', started_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (
              WHERE status = 'completed'
                AND COALESCE(duration_seconds, 0) >= $3
                AND transcript LIKE '%Caller:%'
            )::int AS answered
       FROM voice_sessions
      WHERE tenant_id = $1
        AND started_at >= date_trunc('month', now() AT TIME ZONE 'UTC') - ($2 - 1) * interval '1 month'
      GROUP BY 1
      ORDER BY 1 DESC`,
    [tenantId, months, BILLABLE_MIN_SECONDS]
  );

  const currentMonth = new Date().toISOString().slice(0, 7);
  const statements: MonthlyStatement[] = usage.rows.map((r) => {
    const overage = quota ? Math.max(0, r.answered - quota.includedCalls) : null;
    const packs = quota && overage !== null ? Math.ceil(overage / quota.packCalls) : null;
    return {
      month: r.month,
      totalCalls: r.total,
      answeredCalls: r.answered,
      freeCalls: r.total - r.answered,
      includedCalls: quota ? quota.includedCalls : null,
      overageCalls: overage,
      packsApplied: packs,
      packChargeUsd: quota && packs !== null ? packs * quota.packPriceUsd : null,
      inProgress: r.month === currentMonth,
    };
  });

  return {
    plan,
    quota,
    billableMinSeconds: BILLABLE_MIN_SECONDS,
    monthBoundaries: 'utc',
    statements,
  };
}
