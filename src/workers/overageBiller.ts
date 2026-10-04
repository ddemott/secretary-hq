/**
 * Overage biller: once a day, charge every active paid tenant the overage for any CLOSED month that
 * is not on the ledger yet (src/services/overageBilling.ts does the exactly-once work per tenant).
 *
 * OFF BY DEFAULT, EVERYWHERE, INCLUDING PRODUCTION. Unlike the other workers this one moves money, so
 * it only runs when ENABLE_OVERAGE_BILLING=true is set on purpose. It goes through the Stripe gateway,
 * so against the mock (STRIPE_MODE=mock) it exercises the whole path with no Stripe account, and the
 * day the real account is attached nothing here changes: set the flag once the real prices exist.
 *
 * Shape mirrors the other schedulers: start/stop, skip overlapping ticks, a Postgres advisory lock so
 * replicas do not bill the same tenant at once, and one tenant's failure never stops the batch. It
 * does NOT run at boot (a deploy must not trigger charges); the first tick waits one interval.
 */
import type { Pool } from 'pg';
import { getPool, createWithTenantClient } from '../database/index.js';
import { errorsTotal } from '../services/metrics.js';
import { billTenantOverage } from '../services/overageBilling.js';
import { getStripeGateway, type StripeGateway } from '../services/stripe/gateway.js';
// The tested session-advisory-lock helper (takes the key); reused rather than re-derived.
import { withWebsiteRescanLock } from './websiteRescanScheduler.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const OVERAGE_BILLER_BOUNDS = { min: 60 * 60 * 1000, max: 7 * DAY_MS, fallback: DAY_MS };

/** Fixed int so every replica contends on the same lock (and tests can assert it). */
export const OVERAGE_BILLER_LOCK_KEY = 0x4f564247; // 'OVBG'

let timer: NodeJS.Timeout | null = null;
let isRunning = false;

/** Money moves here, so the flag must be the literal string "true". */
export function overageBillingEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.ENABLE_OVERAGE_BILLING === 'true';
}

/** Interval from env, clamped to [1h, 7d]; anything unparseable falls back to daily. */
export function overageIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number.parseInt(env.OVERAGE_BILLER_INTERVAL_MS ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return OVERAGE_BILLER_BOUNDS.fallback;
  return Math.min(OVERAGE_BILLER_BOUNDS.max, Math.max(OVERAGE_BILLER_BOUNDS.min, raw));
}

export interface OverageTickResult {
  candidates: number;
  created: number;
  alreadyBilled: number;
  failed: number;
  skippedLock?: boolean;
  skippedNoStripe?: boolean;
}

/** Active, paid, real tenants with a Stripe customer: the only ones that can be billed overage. */
export async function selectOverageCandidates(pool: Pick<Pool, 'query'>): Promise<string[]> {
  const res = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM tenants
      WHERE is_deleted = false AND is_template = false AND is_tutorial = false
        AND subscription_status = 'active'
        AND stripe_customer_id IS NOT NULL
        AND subscription_plan IN ('solo', 'growth', 'professional')
      ORDER BY tenant_id`
  );
  return res.rows.map((r) => r.tenant_id);
}

/** One billing pass. Exported for tests and for running by hand. */
export async function billOverageNow(
  opts: { pool?: Pool; gateway?: StripeGateway | null; now?: Date; skipLock?: boolean } = {}
): Promise<OverageTickResult> {
  const pool = opts.pool ?? getPool();
  const gateway = opts.gateway === undefined ? getStripeGateway() : opts.gateway;
  const empty: OverageTickResult = { candidates: 0, created: 0, alreadyBilled: 0, failed: 0 };
  if (!gateway) return { ...empty, skippedNoStripe: true };

  const withTenant = createWithTenantClient(pool);
  const run = async (): Promise<OverageTickResult> => {
    const tenantIds = await selectOverageCandidates(pool);
    const result: OverageTickResult = { ...empty, candidates: tenantIds.length };
    for (const tenantId of tenantIds) {
      try {
        const res = await withTenant(tenantId, (db) =>
          billTenantOverage(db, gateway, tenantId, opts.now)
        );
        for (const m of res.months) {
          if (m.outcome === 'created') result.created++;
          else if (m.outcome === 'already_billed') result.alreadyBilled++;
          else if (m.outcome === 'failed') {
            result.failed++;
            console.error(`overageBiller: tenant ${tenantId} ${m.month} failed: ${m.error}`);
          }
        }
      } catch (err) {
        result.failed++;
        errorsTotal.inc({ event: 'overage_tenant_failed' });
        console.error(`overageBiller: tenant ${tenantId} threw:`, err);
      }
    }
    return result;
  };

  if (opts.skipLock) return run();
  const locked = await withWebsiteRescanLock(pool, run, OVERAGE_BILLER_LOCK_KEY);
  return locked.acquired ? locked.result : { ...empty, skippedLock: true };
}

async function tick(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const r = await billOverageNow();
    if (r.skippedNoStripe)
      console.warn('⚠️ overageBiller: skipped tick, billing is not configured');
    else if (r.skippedLock)
      console.log('🔒 overageBiller: skipped tick, another replica holds the lock');
    else if (r.created > 0 || r.failed > 0) {
      console.log(
        `💳 overageBiller: ${r.created} charge(s) created, ${r.alreadyBilled} already billed, ${r.failed} failed (${r.candidates} tenant(s))`
      );
    }
  } catch (err) {
    errorsTotal.inc({ event: 'overage_tick_failed' });
    console.error('overageBiller tick failed:', err);
  } finally {
    isRunning = false;
  }
}

export function startOverageBiller(intervalMs: number = overageIntervalMs()): void {
  if (timer) {
    console.warn('⚠️ overageBiller is already running');
    return;
  }
  console.log(`🚀 Starting overageBiller (interval: ${intervalMs}ms)`);
  timer = setInterval(() => void tick(), intervalMs);
}

export function stopOverageBiller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('🛑 overageBiller stopped');
  }
}

export function isOverageBillerRunning(): boolean {
  return timer !== null;
}
