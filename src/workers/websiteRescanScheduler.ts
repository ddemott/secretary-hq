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
 * PRODUCT / COST DEFAULTS (Stark call — conservative, env-tunable):
 *   - Stale after 30 days (WEBSITE_RESCAN_STALE_DAYS). Small-business sites
 *     rarely change weekly; monthly is enough to catch real drift without
 *     burning an extraction pass per tenant per week.
 *   - At most 5 tenants per tick (WEBSITE_RESCAN_BATCH_SIZE). A daily tick +
 *     30-day stale window means a tenant is rescanned ~once/month; the batch
 *     cap bounds worst-case OpenAI spend if many tenants go stale at once
 *     (e.g. after a deploy that turns the worker on for the first time).
 *   - Skip demo tenants (is_demo). Demo KBs are disposable; scanning them is
 *     pure cost.
 *   - Still stages suggestions — never auto-publishes. A bad scrape becomes a
 *     review chore, not a silent overwrite of approved answers.
 *   - Opt-out = NULL website_scan_url. No separate flag; absence of a URL is
 *     the signal the owner never scanned (or cleared it).
 *
 * Shape mirrors scheduleExtender / reminderScheduler: start/stop/interval,
 * skip overlapping ticks, one-tenant failure does not stop the batch.
 *
 * Usage:
 *   startWebsiteRescanScheduler();
 *   stopWebsiteRescanScheduler();
 */

import { getPool, createWithTenantClient } from '../database/index.js';
import { errorsTotal } from '../services/metrics.js';
import { importWebsiteKnowledge } from '../services/knowledge/websiteImport.js';

/** Daily. Stale window is measured in days; faster ticks only burn queries. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Days since last successful scan before a tenant is eligible. */
const DEFAULT_STALE_DAYS = 30;

/**
 * Max tenants processed per tick. Cost ceiling when many go stale together
 * (first enable, long outage). Oldest-stale first so backlog drains fairly.
 */
const DEFAULT_BATCH_SIZE = 5;

const INTERVAL_MS = Number(process.env.WEBSITE_RESCAN_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
const STALE_DAYS = Number(process.env.WEBSITE_RESCAN_STALE_DAYS) || DEFAULT_STALE_DAYS;
const BATCH_SIZE = Number(process.env.WEBSITE_RESCAN_BATCH_SIZE) || DEFAULT_BATCH_SIZE;

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
};

/**
 * Select tenants eligible for re-scan.
 *
 * - has a stored website_scan_url (the only source of truth for "what to hit")
 * - not soft-deleted, not demo
 * - last_scanned is NULL or older than staleDays
 *
 * Ordered oldest-first so a backlog drains fairly under the batch cap.
 * Exported for unit tests with a mock pool.
 */
export async function selectStaleWebsiteScanTenants(
  query: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ rows: T[] }>,
  opts: { staleDays?: number; batchSize?: number } = {}
): Promise<RescanCandidate[]> {
  const staleDays = opts.staleDays ?? STALE_DAYS;
  const batchSize = opts.batchSize ?? BATCH_SIZE;

  const result = await query<RescanCandidate>(
    `SELECT tenant_id, website_scan_url
       FROM tenants
      WHERE is_deleted = false
        AND is_demo = false
        AND website_scan_url IS NOT NULL
        AND btrim(website_scan_url) <> ''
        AND (
          website_last_scanned_at IS NULL
          OR website_last_scanned_at < NOW() - ($1::int * INTERVAL '1 day')
        )
      ORDER BY website_last_scanned_at ASC NULLS FIRST, tenant_id ASC
      LIMIT $2`,
    [staleDays, batchSize]
  );
  return result.rows;
}

/**
 * One full pass: pick stale tenants, run importWebsiteKnowledge for each.
 * Exported for tests / manual trigger.
 *
 * Skips the whole tick (no candidates touched) when OPENAI_API_KEY is missing
 * and the import stub is off — a re-scan without a key can only fail, and
 * failing would leave last_scanned untouched anyway, so we'd just retry forever
 * while spamming error metrics.
 */
export async function rescanStaleWebsitesNow(
  opts: {
    staleDays?: number;
    batchSize?: number;
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
  } = {}
): Promise<RescanTickResult> {
  const openAiKey = opts.openAiKey ?? process.env.OPENAI_API_KEY ?? '';
  const stubbed = process.env.KNOWLEDGE_IMPORT_E2E_STUB === '1';
  if (!stubbed && !openAiKey) {
    return { candidates: 0, succeeded: 0, failed: 0, skippedNoKey: 1 };
  }

  const pool = getPool();
  const query =
    opts.query ??
    (<T extends Record<string, unknown>>(sql: string, params?: unknown[]) =>
      pool.query<T>(sql, params));
  const withTenantClient = opts.withTenantClient ?? createWithTenantClient(pool);
  const importFn = opts.importFn ?? importWebsiteKnowledge;

  const candidates = await selectStaleWebsiteScanTenants(query, {
    staleDays: opts.staleDays,
    batchSize: opts.batchSize,
  });

  let succeeded = 0;
  let failed = 0;

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
      }
    } catch (err) {
      failed++;
      errorsTotal.inc({ event: 'website_rescan_tenant_failed' });
      console.error(`websiteRescan: tenant ${tenant_id} threw:`, err);
    }
  }

  return { candidates: candidates.length, succeeded, failed, skippedNoKey: 0 };
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
    if (result.failed > 0) {
      console.warn(
        `⚠️ websiteRescan: ${result.failed}/${result.candidates} tenant(s) failed to re-scan`
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
  console.log(
    `🚀 Starting websiteRescan scheduler (interval: ${intervalMs}ms, stale: ${STALE_DAYS}d, batch: ${BATCH_SIZE})`
  );
  rescanInterval = setInterval(() => {
    void tick();
  }, intervalMs);
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
