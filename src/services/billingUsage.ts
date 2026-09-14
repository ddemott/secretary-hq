/**
 * Usage metering + monthly billing statements, computed from voice_sessions.
 *
 * Billing model: answered call only. A call bills when it completed, the caller
 * actually spoke, and it lasted at least BILLABLE_MIN_SECONDS. Silent rooms,
 * instant hang-ups, spam, and still-active calls are free. Overage is flat
 * call packs when soft-cap enforcement is off. Soft-cap mode (default) warns at
 * 80% and blocks new voice-session starts at the plan limit — see
 * evaluateUsageCap() + voice-session-start.
 *
 * Cap numbers are Dale-owned placeholders: override via PLAN_CAP_SOLO /
 * PLAN_CAP_GROWTH / PLAN_CAP_PROFESSIONAL without a deploy of magic numbers.
 */
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export const BILLABLE_MIN_SECONDS = 15;
const CALLER_LINE_RE = '(?:^|\\n)Caller(?: \\[\\d+:\\d{2}\\])?: ';

export interface PlanQuota {
  /** null = unlimited (Professional default). */
  includedCalls: number | null;
  packCalls: number;
  packPriceUsd: number;
}

/** Static defaults — env overrides applied by resolvePlanQuota(). */
export const PLAN_QUOTAS: Record<string, PlanQuota> = {
  solo: { includedCalls: 350, packCalls: 30, packPriceUsd: 25 },
  growth: { includedCalls: 1000, packCalls: 30, packPriceUsd: 25 },
  professional: { includedCalls: null, packCalls: 30, packPriceUsd: 25 },
};

export type UsageCapLevel = 'ok' | 'warn' | 'blocked' | 'unlimited';

export interface UsageCapEvaluation {
  plan: string | null;
  used: number;
  limit: number | null;
  percent: number | null;
  status: UsageCapLevel;
  softCapEnforced: boolean;
  warnRatio: number;
  /** True when a new voice session must be refused. */
  blocked: boolean;
}

export interface MonthlyStatement {
  month: string;
  totalCalls: number;
  answeredCalls: number;
  freeCalls: number;
  includedCalls: number | null;
  overageCalls: number | null;
  packsApplied: number | null;
  packChargeUsd: number | null;
  inProgress: boolean;
}

export interface UsageStatementResult {
  plan: string | null;
  quota: PlanQuota | null;
  billableMinSeconds: number;
  monthBoundaries: 'utc';
  statements: MonthlyStatement[];
  /** Current UTC-month soft-cap evaluation (for meter + banner). */
  cap: UsageCapEvaluation;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

/**
 * Env override for a plan's included-call cap.
 * Returns undefined = keep default; null = unlimited; number = hard cap.
 */
function envPlanCap(plan: string): number | null | undefined {
  const key = `PLAN_CAP_${plan.toUpperCase()}`;
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const lowered = raw.trim().toLowerCase();
  if (lowered === 'unlimited' || lowered === 'none' || lowered === 'inf') return null;
  const n = parsePositiveInt(raw);
  if (n === undefined) return undefined;
  if (n === 0) return null;
  return n;
}

export function resolvePlanQuota(plan: string | null | undefined): PlanQuota | null {
  if (!plan) return null;
  const base = PLAN_QUOTAS[plan];
  if (!base) return null;
  const override = envPlanCap(plan);
  if (override === undefined) return { ...base };
  return { ...base, includedCalls: override };
}

/** Included-call limit for a plan, or null when unlimited / unknown. */
export function planCallLimit(plan: string | null | undefined): number | null {
  const q = resolvePlanQuota(plan);
  if (!q) return null;
  return q.includedCalls;
}

export function getWarnRatio(): number {
  const n = Number.parseFloat(process.env.USAGE_WARN_RATIO ?? '');
  if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  return 0.8;
}

/** Default warn threshold (0.8). Read live so tests can override env. */
export const USAGE_WARN_RATIO = 0.8;

export function isSoftCapEnforced(): boolean {
  const raw = (process.env.USAGE_SOFT_CAP_ENFORCE ?? 'true').trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
}

/**
 * Map used/limit into ok | warn | blocked | unlimited.
 * warn fires at warnRatio * limit (inclusive); blocked at limit (inclusive).
 */
export function usageCapStatus(
  used: number,
  limit: number | null,
  warnRatio: number = getWarnRatio()
): UsageCapLevel {
  if (limit === null || limit <= 0) return 'unlimited';
  if (used >= limit) return 'blocked';
  if (used >= limit * warnRatio) return 'warn';
  return 'ok';
}

/** Billable (answered) call count for the current UTC month. */
export async function countAnsweredCallsThisMonth(
  pool: Queryable,
  tenantId: string
): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM voice_sessions
      WHERE tenant_id = $1
        AND started_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
        AND (is_deleted IS NULL OR is_deleted = false)
        AND status = 'completed'
        AND COALESCE(duration_seconds, 0) >= $2
        AND transcript ~ $3`,
    [tenantId, BILLABLE_MIN_SECONDS, CALLER_LINE_RE]
  );
  return res.rows[0]?.n ?? 0;
}

export async function evaluateUsageCap(
  pool: Queryable,
  tenantId: string
): Promise<UsageCapEvaluation> {
  const tenantRes = await pool.query<{ subscription_plan: string | null }>(
    'SELECT subscription_plan FROM tenants WHERE tenant_id = $1',
    [tenantId]
  );
  if (tenantRes.rows.length === 0) throw new Error('Tenant not found');

  const plan = tenantRes.rows[0].subscription_plan;
  const limit = planCallLimit(plan);
  const used = await countAnsweredCallsThisMonth(pool, tenantId);
  const warnRatio = getWarnRatio();
  const status = usageCapStatus(used, limit, warnRatio);
  const softCapEnforced = isSoftCapEnforced();
  const percent =
    limit !== null && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null;

  return {
    plan,
    used,
    limit,
    percent,
    status,
    softCapEnforced,
    warnRatio,
    blocked: softCapEnforced && status === 'blocked',
  };
}

export async function computeUsageStatements(
  pool: Queryable,
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
  const quota = resolvePlanQuota(plan);

  const usage = await pool.query<{ month: string; total: number; answered: number }>(
    `SELECT to_char(date_trunc('month', started_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (
              WHERE status = 'completed'
                AND COALESCE(duration_seconds, 0) >= $3
                AND transcript ~ $4
            )::int AS answered
       FROM voice_sessions
      WHERE tenant_id = $1
        AND started_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
            - ($2 - 1) * interval '1 month'
        AND (is_deleted IS NULL OR is_deleted = false)
      GROUP BY 1
      ORDER BY 1 DESC`,
    [tenantId, months, BILLABLE_MIN_SECONDS, CALLER_LINE_RE]
  );

  const currentMonth = new Date().toISOString().slice(0, 7);
  const included = quota?.includedCalls ?? null;
  const statements: MonthlyStatement[] = usage.rows.map((row) => {
    const overageCalls =
      included !== null ? Math.max(0, row.answered - included) : null;
    const packsApplied =
      quota && overageCalls !== null && included !== null
        ? Math.ceil(overageCalls / quota.packCalls)
        : null;
    return {
      month: row.month,
      totalCalls: row.total,
      answeredCalls: row.answered,
      freeCalls: row.total - row.answered,
      includedCalls: included,
      overageCalls,
      packsApplied,
      packChargeUsd:
        quota && packsApplied !== null ? packsApplied * quota.packPriceUsd : null,
      inProgress: row.month === currentMonth,
    };
  });

  // Cap evaluation reuses the same answered-call definition for the live month.
  const current = statements.find((s) => s.inProgress);
  const used = current?.answeredCalls ?? 0;
  const limit = included;
  const warnRatio = getWarnRatio();
  const status = usageCapStatus(used, limit, warnRatio);
  const softCapEnforced = isSoftCapEnforced();
  const percent =
    limit !== null && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null;

  return {
    plan,
    quota,
    billableMinSeconds: BILLABLE_MIN_SECONDS,
    monthBoundaries: 'utc',
    statements,
    cap: {
      plan,
      used,
      limit,
      percent,
      status,
      softCapEnforced,
      warnRatio,
      blocked: softCapEnforced && status === 'blocked',
    },
  };
}
