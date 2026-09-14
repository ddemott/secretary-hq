/**
 * Usage metering + monthly billing statements, computed from voice_sessions.
 *
 * Billing model: answered call only. A call bills when it completed, the caller
 * actually spoke, and it lasted at least BILLABLE_MIN_SECONDS. Silent rooms,
 * instant hang-ups, and spam are free. Soft-cap mode (default) warns at 80% and
 * blocks new voice-session starts at the plan limit — see evaluateUsageCap() +
 * voice-session-start.
 *
 * Integrity rules (margin protection):
 * - Null/unknown plan under soft-cap → explicit free-tier finite cap (never
 *   silent unlimited). Professional stays unlimited via PLAN_QUOTAS.
 * - Soft-delete does NOT wipe the meter: billable counts ignore is_deleted.
 * - In-flight sessions reserve capacity: active rows in the UTC month count
 *   toward the cap alongside completed billable calls (closes TOCTOU overshoot).
 *
 * Cap numbers are Dale-owned placeholders: override via PLAN_CAP_SOLO /
 * PLAN_CAP_GROWTH / PLAN_CAP_PROFESSIONAL / PLAN_CAP_FREE without a deploy of
 * magic numbers.
 */
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export const BILLABLE_MIN_SECONDS = 15;
const CALLER_LINE_RE = '(?:^|\\n)Caller(?: \\[\\d+:\\d{2}\\])?: ';

/** Default free-tier included calls when plan is null/unknown under soft-cap. */
export const FREE_TIER_INCLUDED_CALLS = 50;

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
  /** True when limit came from free-tier fallback (null/unknown plan). */
  freeTierApplied: boolean;
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

/** Normalize plan keys (trim + lower). Empty → null. */
export function normalizePlanKey(plan: string | null | undefined): string | null {
  if (plan == null) return null;
  const key = plan.trim().toLowerCase();
  return key.length > 0 ? key : null;
}

/**
 * Free-tier finite cap for null/unknown plans under soft-cap.
 * PLAN_CAP_FREE env override; 0/invalid falls back to FREE_TIER_INCLUDED_CALLS
 * (never unlimited — that would re-open the null-plan hole).
 */
export function freeTierCallLimit(): number {
  const n = parsePositiveInt(process.env.PLAN_CAP_FREE);
  if (n === undefined || n === 0) return FREE_TIER_INCLUDED_CALLS;
  return n;
}

export function resolvePlanQuota(plan: string | null | undefined): PlanQuota | null {
  const key = normalizePlanKey(plan);
  if (!key) return null;
  const base = PLAN_QUOTAS[key];
  if (!base) return null;
  const override = envPlanCap(key);
  if (override === undefined) return { ...base };
  return { ...base, includedCalls: override };
}

/**
 * Included-call limit for a plan, or null when unlimited.
 *
 * Under soft-cap enforcement, null/unknown plan → free-tier finite cap
 * (never silent unlimited). Recognized Professional stays unlimited.
 * When soft-cap is off, null/unknown stays null (pack/overage path).
 */
export function planCallLimit(plan: string | null | undefined): number | null {
  const q = resolvePlanQuota(plan);
  if (q) return q.includedCalls;
  if (isSoftCapEnforced()) return freeTierCallLimit();
  return null;
}

/** Whether planCallLimit applied free-tier fallback for this plan. */
export function isFreeTierPlan(plan: string | null | undefined): boolean {
  return resolvePlanQuota(plan) == null && isSoftCapEnforced();
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

/**
 * SQL predicate: completed billable (answered) call.
 * Soft-delete is intentionally ignored — owner delete must not wipe the meter.
 */
const BILLABLE_COMPLETED_SQL = `status = 'completed'
        AND COALESCE(duration_seconds, 0) >= $2
        AND transcript ~ $3`;

/**
 * Cap occupancy for the current UTC month:
 * - completed billable answered calls (incl. soft-deleted)
 * - active in-flight sessions (reservation against concurrent overshoot)
 */
export async function countCapOccupancyThisMonth(
  pool: Queryable,
  tenantId: string
): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM voice_sessions
      WHERE tenant_id = $1
        AND started_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
        AND (
          status = 'active'
          OR (${BILLABLE_COMPLETED_SQL})
        )`,
    [tenantId, BILLABLE_MIN_SECONDS, CALLER_LINE_RE]
  );
  return res.rows[0]?.n ?? 0;
}

/**
 * Billable (answered) call count for the current UTC month.
 * Includes soft-deleted rows so owner delete cannot reset the meter.
 * Does not count active/in-flight (those are free until completed billable).
 * Prefer countCapOccupancyThisMonth for the soft-cap gate.
 */
export async function countAnsweredCallsThisMonth(
  pool: Queryable,
  tenantId: string
): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM voice_sessions
      WHERE tenant_id = $1
        AND started_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
        AND (${BILLABLE_COMPLETED_SQL})`,
    [tenantId, BILLABLE_MIN_SECONDS, CALLER_LINE_RE]
  );
  return res.rows[0]?.n ?? 0;
}

function buildCapEvaluation(
  plan: string | null,
  used: number,
  limit: number | null,
  freeTierApplied: boolean
): UsageCapEvaluation {
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
    freeTierApplied,
  };
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
  const freeTierApplied = isFreeTierPlan(plan);
  const limit = planCallLimit(plan);
  // Gate uses occupancy (completed billable + active) so concurrent starts cannot
  // all pass at limit-1 and overshoot when they complete.
  const used = await countCapOccupancyThisMonth(pool, tenantId);
  return buildCapEvaluation(plan, used, limit, freeTierApplied);
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
  const recognizedQuota = resolvePlanQuota(plan);
  const freeTierApplied = isFreeTierPlan(plan);
  // Soft-cap free-tier: synthesize a quota so the dashboard meter has a limit.
  // Pack math only applies to recognized paid plans (not free-tier fallback).
  const quota: PlanQuota | null = recognizedQuota
    ? recognizedQuota
    : freeTierApplied
      ? {
          includedCalls: freeTierCallLimit(),
          packCalls: PLAN_QUOTAS.solo.packCalls,
          packPriceUsd: PLAN_QUOTAS.solo.packPriceUsd,
        }
      : null;

  // Metering ignores is_deleted (C2). UI lists still filter deleted separately.
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
      GROUP BY 1
      ORDER BY 1 DESC`,
    [tenantId, months, BILLABLE_MIN_SECONDS, CALLER_LINE_RE]
  );

  const currentMonth = new Date().toISOString().slice(0, 7);
  const included = quota?.includedCalls ?? null;
  const statements: MonthlyStatement[] = usage.rows.map((row) => {
    // Pack overage only for recognized paid plans when soft-cap is off path;
    // free-tier under soft-cap is hard-capped, not pack-billed.
    const packEligible = recognizedQuota != null;
    const overageCalls =
      packEligible && included !== null ? Math.max(0, row.answered - included) : null;
    const packsApplied =
      packEligible && quota && overageCalls !== null && included !== null
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
      packChargeUsd: quota && packsApplied !== null ? packsApplied * quota.packPriceUsd : null,
      inProgress: row.month === currentMonth,
    };
  });

  // Cap uses occupancy (answered + active) for the live month — same as gate.
  const occupancy = await countCapOccupancyThisMonth(pool, tenantId);
  const limit = included;
  const cap = buildCapEvaluation(plan, occupancy, limit, freeTierApplied);

  return {
    plan,
    quota,
    billableMinSeconds: BILLABLE_MIN_SECONDS,
    monthBoundaries: 'utc',
    statements,
    cap,
  };
}
