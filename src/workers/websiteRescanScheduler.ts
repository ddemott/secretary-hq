/**
 * Website re-scan scheduler
 *
 * Periodically re-runs the website knowledge import for tenants whose last
 * successful scan is older than a cost-aware stale window.
 *
 * WHY. Owner-driven scans only run when someone pastes a URL. Business sites
 * change (hours, services, policies) and the live KB quietly drifts. Without a
 * worker, "scan once at onboarding" is the permanent state.
 *
 * PRODUCT / COST DEFAULTS (Stark call — conservative, env-tunable + clamped):
 *   - Stale after 30 days (WEBSITE_RESCAN_STALE_DAYS, clamp 1–365).
 *   - At most 5 tenants per tick (WEBSITE_RESCAN_BATCH_SIZE, clamp 1–50).
 *   - Interval 24h (WEBSITE_RESCAN_INTERVAL_MS, clamp 1h–7d).
 *   - Skip demo tenants (is_demo).
 *   - Stages suggestions only — never auto-publishes.
 *   - Opt-out = NULL website_scan_url.
 *   - Dead-URL backoff: consecutive failures bump website_scan_fail_count and
 *     set website_scan_last_attempt_at; exponential day backoff keeps broken
 *     URLs out of the oldest-stale queue; after MAX fails the row is quarantined
 *     until a successful owner/manual scan resets the counter
 *     (metric: website_rescan_tenant_quarantined).
 *   - Multi-instance: Postgres session advisory lock serializes ticks across
 *     replicas so cost does not multiply with horizontal scale. in-process
 *     isRunning still skips overlapping ticks on one process.
 *
 * Shape mirrors scheduleExtender / reminderScheduler: start/stop/interval,
 * skip overlapping ticks, one-tenant failure does not stop the batch.
 *
 * Usage:
 *   startWebsiteRescanScheduler();
 *   stopWebsiteRescanScheduler();
 */

import type { Pool, PoolClient } from 'pg';
import { getPool, createWithTenantClient } from '../database/index.js';
import { errorsTotal } from '../services/metrics.js';
import {
  importWebsiteKnowledge,
  recordWebsiteScanFailure,
} from '../services/knowledge/websiteImport.js';

/** Daily. Stale window is measured in days; faster ticks only burn queries. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Days since last successful scan before a tenant is eligible. */
const DEFAULT_STALE_DAYS = 30;

/**
 * Max tenants processed per tick. Cost ceiling when many go stale together
 * (first enable, long outage). Oldest-stale first so backlog drains fairly.
 */
const DEFAULT_BATCH_SIZE = 5;

/** Consecutive failures before a tenant is dropped from auto re-scan. */
const DEFAULT_MAX_FAILS = 5;

/**
 * Env bounds — absurd ops values (0, 1e9, negatives) must not reach SQL/cost.
 * Exported for unit tests.
 */
export const RESCAN_ENV_BOUNDS = {
  staleDays: { min: 1, max: 365, fallback: DEFAULT_STALE_DAYS },
  batchSize: { min: 1, max: 50, fallback: DEFAULT_BATCH_SIZE },
  intervalMs: {
    min: 60 * 60 * 1000, // 1h
    max: 7 * 24 * 60 * 60 * 1000, // 7d
    fallback: DEFAULT_INTERVAL_MS,
  },
  maxFails: { min: 1, max: 20, fallback: DEFAULT_MAX_FAILS },
} as const;

/**
 * Parse a positive finite int and clamp into [min, max]. Non-numeric / ≤0 /
 * empty → fallback. Exported for unit tests.
 */
export function parseBoundedInt(
  raw: string | undefined,
  bounds: { min: number; max: number; fallback: number }
): number {
  if (raw === undefined || raw.trim() === '') return bounds.fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return bounds.fallback;
  const t = Math.trunc(n);
  // trunc(0.9) === 0 — treat non-positive trunc as missing, not "clamp to min"
  if (t <= 0) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, t));
}

export function resolveRescanConfig(env: NodeJS.ProcessEnv = process.env): {
  intervalMs: number;
  staleDays: number;
  batchSize: number;
  maxFails: number;
} {
  return {
    intervalMs: parseBoundedInt(env.WEBSITE_RESCAN_INTERVAL_MS, RESCAN_ENV_BOUNDS.intervalMs),
    staleDays: parseBoundedInt(env.WEBSITE_RESCAN_STALE_DAYS, RESCAN_ENV_BOUNDS.staleDays),
    batchSize: parseBoundedInt(env.WEBSITE_RESCAN_BATCH_SIZE, RESCAN_ENV_BOUNDS.batchSize),
    maxFails: parseBoundedInt(env.WEBSITE_RESCAN_MAX_FAILS, RESCAN_ENV_BOUNDS.maxFails),
  };
}

const CONFIG = resolveRescanConfig();
const INTERVAL_MS = CONFIG.intervalMs;
const STALE_DAYS = CONFIG.staleDays;
const BATCH_SIZE = CONFIG.batchSize;
const MAX_FAILS = CONFIG.maxFails;

/**
 * Session advisory-lock key. Stable across deploys so every replica contends
 * on the same lock. Chosen as a fixed int (not hashtext) so tests can assert it.
 */
export const WEBSITE_RESCAN_LOCK_KEY = 0x57425253; // 'WBRS'

let rescanInterval: NodeJS.Timeout | null = null;
let isRunning = false;

export type RescanCandidate = {
  tenant_id: string;
  website_scan_url: string;
};

export type RescanTickResult = {
  candidates: number;
  succeeded: number;
  failed: number;
  skippedNoKey: number;
  skippedLock: number;
  quarantined: number;
};

/**
 * Select tenants eligible for re-scan.
 *
 * - has a stored website_scan_url (the only source of truth for "what to hit")
 * - not soft-deleted, not demo
 * - last_scanned is NULL or older than staleDays
 * - not quarantined (fail_count < maxFails)
 * - past exponential backoff after consecutive failures
 *   (2^(fail_count-1) days, capped at staleDays)
 *
 * Ordered fail_count ASC then oldest-scanned so healthy backlog drains before
 * flaky URLs, and a single dead URL cannot monopolize the batch forever.
 * Exported for unit tests with a mock pool.
 */
export async function selectStaleWebsiteScanTenants(
  query: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[] }>,
  opts: { staleDays?: number; batchSize?: number; maxFails?: number } = {}
): Promise<RescanCandidate[]> {
  const staleDays = opts.staleDays ?? STALE_DAYS;
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const maxFails = opts.maxFails ?? MAX_FAILS;

  const result = await query<RescanCandidate>(
    `SELECT tenant_id, website_scan_url
       FROM tenants
      WHERE is_deleted = false
        AND is_demo = false
        AND website_scan_url IS NOT NULL
        AND btrim(website_scan_url) <> ''
        AND website_scan_fail_count < $3
        AND (
          website_last_scanned_at IS NULL
          OR website_last_scanned_at < NOW() - ($1::int * INTERVAL '1 day')
        )
        AND (
          website_scan_last_attempt_at IS NULL
          OR website_scan_fail_count = 0
          OR website_scan_last_attempt_at < NOW() - (
            LEAST(
              $1::int,
              POWER(2, LEAST(website_scan_fail_count, 5) - 1)::int
            ) * INTERVAL '1 day'
          )
        )
      ORDER BY website_scan_fail_count ASC,
               website_last_scanned_at ASC NULLS FIRST,
               tenant_id ASC
      LIMIT $2`,
    [staleDays, batchSize, maxFails]
  );
  return result.rows;
}

/**
 * Hold a session advisory lock on a dedicated pool client for the duration of
 * fn. Returns acquired:false when another replica already holds the tick lock
 * — caller should skip (cost must not multiply with replica count).
 *
 * MUST unlock on the same connection that locked; pool.query alone is unsafe.
 * Exported for tests.
 */
export async function withWebsiteRescanLock<T>(
  pool: Pick<Pool, 'connect'>,
  fn: () => Promise<T>,
  lockKey: number = WEBSITE_RESCAN_LOCK_KEY
): Promise<{ acquired: false } | { acquired: true; result: T }> {
  const client: PoolClient = await pool.connect();
  try {
    const locked = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS ok',
      [lockKey]
    );
    if (!locked.rows[0]?.ok) {
      return { acquired: false };
    }
    try {
      const result = await fn();
      return { acquired: true, result };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    }
  } finally {
    client.release();
  }
}

/**
 * One full pass: pick stale tenants, run importWebsiteKnowledge for each.
 * Exported for tests / manual trigger.
 *
 * Skips the whole tick (no candidates touched) when OPENAI_API_KEY is missing
 * and the import stub is off — a re-scan without a key can only fail, and
 * failing would leave last_scanned untouched anyway, so we'd just retry forever
 * while spamming error metrics.
 *
 * Multi-instance: takes WEBSITE_RESCAN_LOCK_KEY first (unless skipLock for tests).
 */
export async function rescanStaleWebsitesNow(
  opts: {
    staleDays?: number;
    batchSize?: number;
    maxFails?: number;
    openAiKey?: string;
    /** Inject for tests — default builds from the live pool. */
    withTenantClient?: <T>(
      tenantId: string,
      fn: (client: import('pg').PoolClient) => Promise<T>
    ) => Promise<T>;
    query?: <T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[]
    ) => Promise<{ rows: T[] }>;
    importFn?: typeof importWebsiteKnowledge;
    recordFailureFn?: typeof recordWebsiteScanFailure;
    /** Test escape hatch: skip advisory lock (unit tests without a real pool). */
    skipLock?: boolean;
    pool?: Pick<Pool, 'connect' | 'query'>;
  } = {}
): Promise<RescanTickResult> {
  const openAiKey = opts.openAiKey ?? process.env.OPENAI_API_KEY ?? '';
  const stubbed = process.env.KNOWLEDGE_IMPORT_E2E_STUB === '1';
  if (!stubbed && !openAiKey) {
    return {
      candidates: 0,
      succeeded: 0,
      failed: 0,
      skippedNoKey: 1,
      skippedLock: 0,
      quarantined: 0,
    };
  }

  const run = async (): Promise<RescanTickResult> => {
    const pool = opts.pool ?? getPool();
    const query =
      opts.query ??
      (<T extends Record<string, unknown>>(sql: string, params?: unknown[]) =>
        pool.query<T>(sql, params));
    const withTenantClient = opts.withTenantClient ?? createWithTenantClient(pool as Pool);
    const importFn = opts.importFn ?? importWebsiteKnowledge;
    const recordFailureFn = opts.recordFailureFn ?? recordWebsiteScanFailure;

    const candidates = await selectStaleWebsiteScanTenants(query, {
      staleDays: opts.staleDays,
      batchSize: opts.batchSize,
      maxFails: opts.maxFails,
    });

    let succeeded = 0;
    let failed = 0;
    let quarantined = 0;

    for (const { tenant_id, website_scan_url } of candidates) {
      try {
        const result = await importFn(withTenantClient, tenant_id, website_scan_url, openAiKey);
        if (result.ok) {
          succeeded++;
        } else {
          failed++;
          errorsTotal.inc({ event: 'website_rescan_tenant_failed' });
          console.error(
            `websiteRescan: tenant ${tenant_id} failed (${result.status}): ${result.error}`
          );
          try {
            const rec = await recordFailureFn(withTenantClient, tenant_id);
            if (rec.quarantined) {
              quarantined++;
              errorsTotal.inc({ event: 'website_rescan_tenant_quarantined' });
              console.warn(
                `websiteRescan: tenant ${tenant_id} quarantined after ${rec.failCount} consecutive failures`
              );
            }
          } catch (stampErr) {
            console.error(`websiteRescan: failed to record failure for ${tenant_id}:`, stampErr);
          }
        }
      } catch (err) {
        failed++;
        errorsTotal.inc({ event: 'website_rescan_tenant_failed' });
        console.error(`websiteRescan: tenant ${tenant_id} threw:`, err);
        try {
          const rec = await recordFailureFn(withTenantClient, tenant_id);
          if (rec.quarantined) {
            quarantined++;
            errorsTotal.inc({ event: 'website_rescan_tenant_quarantined' });
          }
        } catch (stampErr) {
          console.error(`websiteRescan: failed to record failure for ${tenant_id}:`, stampErr);
        }
      }
    }

    return {
      candidates: candidates.length,
      succeeded,
      failed,
      skippedNoKey: 0,
      skippedLock: 0,
      quarantined,
    };
  };

  if (opts.skipLock) {
    return run();
  }

  const pool = opts.pool ?? getPool();
  const locked = await withWebsiteRescanLock(pool, run);
  if (!locked.acquired) {
    return {
      candidates: 0,
      succeeded: 0,
      failed: 0,
      skippedNoKey: 0,
      skippedLock: 1,
      quarantined: 0,
    };
  }
  return locked.result;
}

async function tick(): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const result = await rescanStaleWebsitesNow();
    if (result.skippedNoKey) {
      console.warn('⚠️ websiteRescan: skipped tick — OPENAI_API_KEY not set');
      return;
    }
    if (result.skippedLock) {
      console.log('🔒 websiteRescan: skipped tick — another replica holds the advisory lock');
      return;
    }
    if (result.failed > 0) {
      console.warn(
        `⚠️ websiteRescan: ${result.failed}/${result.candidates} tenant(s) failed to re-scan` +
          (result.quarantined ? ` (${result.quarantined} quarantined)` : '')
      );
    }
    if (result.succeeded > 0) {
      console.log(
        `🌐 websiteRescan: re-scanned ${result.succeeded} tenant(s) (${result.candidates} candidate(s))`
      );
    }
  } catch (err) {
    errorsTotal.inc({ event: 'website_rescan_tick_failed' });
    console.error('websiteRescan tick failed:', err);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the scheduler. Does NOT run immediately at boot — unlike the schedule
 * extender, a re-scan costs OpenAI money, so boot should not stampede a backlog
 * of every stale tenant the moment a deploy lands. The first tick waits one
 * full interval (default 24h), which also gives ops a window to set
 * ENABLE_WEBSITE_RESCAN_SCHEDULER=false after a bad deploy.
 */
export function startWebsiteRescanScheduler(intervalMs: number = INTERVAL_MS): void {
  if (rescanInterval) {
    console.warn('⚠️ websiteRescan scheduler is already running');
    return;
  }
  const clampedInterval = Math.min(
    RESCAN_ENV_BOUNDS.intervalMs.max,
    Math.max(RESCAN_ENV_BOUNDS.intervalMs.min, intervalMs)
  );
  console.log(
    `🚀 Starting websiteRescan scheduler (interval: ${clampedInterval}ms, stale: ${STALE_DAYS}d, batch: ${BATCH_SIZE}, maxFails: ${MAX_FAILS}, lock: 0x${WEBSITE_RESCAN_LOCK_KEY.toString(16)})`
  );
  rescanInterval = setInterval(() => {
    void tick();
  }, clampedInterval);
}

/** Stop the scheduler (graceful shutdown). */
export function stopWebsiteRescanScheduler(): void {
  if (rescanInterval) {
    clearInterval(rescanInterval);
    rescanInterval = null;
    console.log('🛑 websiteRescan scheduler stopped');
  }
}

export function isWebsiteRescanSchedulerRunning(): boolean {
  return rescanInterval !== null;
}
