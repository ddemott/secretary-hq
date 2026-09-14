/**
 * WHO:   website re-scan scheduler
 * WHAT:  pick stale tenants under batch/stale caps; run import; isolate failures;
 *        env clamps; failure backoff SQL; multi-instance advisory lock
 * WHEN:  daily tick (prod) or ENABLE_WEBSITE_RESCAN_SCHEDULER=true
 * WHERE: src/workers/websiteRescanScheduler.ts
 * WHY:   cost-aware defaults must hold — batch cap, skip-no-key, one bad tenant
 *        must not abort the rest or monopolize the queue forever; absurd env
 *        values must not reach SQL; replicas must not multiply cost
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  selectStaleWebsiteScanTenants,
  rescanStaleWebsitesNow,
  startWebsiteRescanScheduler,
  stopWebsiteRescanScheduler,
  isWebsiteRescanSchedulerRunning,
  parseBoundedInt,
  resolveRescanConfig,
  RESCAN_ENV_BOUNDS,
  withWebsiteRescanLock,
  WEBSITE_RESCAN_LOCK_KEY,
} from '../../src/workers/websiteRescanScheduler';
import { errorsTotal } from '../../src/services/metrics';

function errorsTotalFor(event: string): number {
  return errorsTotal.snapshot().find((s) => s.labels.event === event)?.value ?? 0;
}

describe('parseBoundedInt / resolveRescanConfig', () => {
  it('HAPPY: falls back on missing / empty / non-numeric / non-positive', () => {
    const b = { min: 1, max: 10, fallback: 5 };
    expect(parseBoundedInt(undefined, b)).toBe(5);
    expect(parseBoundedInt('', b)).toBe(5);
    expect(parseBoundedInt('  ', b)).toBe(5);
    expect(parseBoundedInt('nope', b)).toBe(5);
    expect(parseBoundedInt('0', b)).toBe(5);
    expect(parseBoundedInt('-3', b)).toBe(5);
    expect(parseBoundedInt('NaN', b)).toBe(5);
  });

  it('HAPPY: clamps absurd highs and lows into bounds', () => {
    const b = { min: 1, max: 50, fallback: 5 };
    expect(parseBoundedInt('1', b)).toBe(1);
    expect(parseBoundedInt('50', b)).toBe(50);
    expect(parseBoundedInt('9999', b)).toBe(50);
    expect(parseBoundedInt('0.9', b)).toBe(5); // trunc→0 → non-positive → fallback
    expect(parseBoundedInt('7.9', b)).toBe(7);
  });

  it('HAPPY: resolveRescanConfig reads env and clamps each knob', () => {
    const cfg = resolveRescanConfig({
      WEBSITE_RESCAN_STALE_DAYS: '9999',
      WEBSITE_RESCAN_BATCH_SIZE: '0',
      WEBSITE_RESCAN_INTERVAL_MS: String(60 * 1000), // 1 min — below 1h min
      WEBSITE_RESCAN_MAX_FAILS: '100',
    });
    expect(cfg.staleDays).toBe(RESCAN_ENV_BOUNDS.staleDays.max);
    expect(cfg.batchSize).toBe(RESCAN_ENV_BOUNDS.batchSize.fallback); // 0 → fallback
    // 60000 is finite and >0 but below 1h min → clamp UP to min
    expect(cfg.intervalMs).toBe(RESCAN_ENV_BOUNDS.intervalMs.min);
    expect(cfg.maxFails).toBe(RESCAN_ENV_BOUNDS.maxFails.max);
  });
});

describe('selectStaleWebsiteScanTenants', () => {
  it('HAPPY: forwards staleDays + batchSize + maxFails; SQL encodes backoff + quarantine', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ tenant_id: 't1', website_scan_url: 'https://a.example' }],
    });

    const rows = await selectStaleWebsiteScanTenants(query, {
      staleDays: 14,
      batchSize: 3,
      maxFails: 5,
    });

    expect(rows).toEqual([{ tenant_id: 't1', website_scan_url: 'https://a.example' }]);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/website_scan_url IS NOT NULL/i);
    expect(sql).toMatch(/is_demo = false/i);
    expect(sql).toMatch(/is_deleted = false/i);
    expect(sql).toMatch(/website_scan_fail_count < \$3/i);
    expect(sql).toMatch(/website_scan_last_attempt_at/i);
    expect(sql).toMatch(/POWER\(2/i);
    expect(sql).toMatch(/ORDER BY website_scan_fail_count ASC/i);
    expect(sql).toMatch(/LIMIT \$2/i);
    expect(params).toEqual([14, 3, 5]);
  });
});

describe('withWebsiteRescanLock', () => {
  it('HAPPY: runs fn when pg_try_advisory_lock returns true and unlocks after', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ ok: true }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };

    const locked = await withWebsiteRescanLock(pool as never, async () => 'done');

    expect(locked).toEqual({ acquired: true, result: 'done' });
    expect(client.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1) AS ok', [
      WEBSITE_RESCAN_LOCK_KEY,
    ]);
    expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [
      WEBSITE_RESCAN_LOCK_KEY,
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('SAD: returns acquired:false when lock is held elsewhere (no fn run)', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ ok: false }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    const fn = vi.fn();

    const locked = await withWebsiteRescanLock(pool as never, fn);

    expect(locked).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('rescanStaleWebsitesNow', () => {
  const savedKey = process.env.OPENAI_API_KEY;
  const savedStub = process.env.KNOWLEDGE_IMPORT_E2E_STUB;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.KNOWLEDGE_IMPORT_E2E_STUB;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    if (savedStub === undefined) delete process.env.KNOWLEDGE_IMPORT_E2E_STUB;
    else process.env.KNOWLEDGE_IMPORT_E2E_STUB = savedStub;
  });

  it('SAD: skips the whole tick when OPENAI_API_KEY is missing (no stub)', async () => {
    delete process.env.OPENAI_API_KEY;
    const query = vi.fn();
    const importFn = vi.fn();

    const result = await rescanStaleWebsitesNow({ query, importFn, skipLock: true });

    expect(result).toEqual({
      candidates: 0,
      succeeded: 0,
      failed: 0,
      skippedNoKey: 1,
      skippedLock: 0,
      quarantined: 0,
    });
    expect(query).not.toHaveBeenCalled();
    expect(importFn).not.toHaveBeenCalled();
  });

  it('HAPPY: imports each candidate and counts successes', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { tenant_id: 't1', website_scan_url: 'https://a.example' },
        { tenant_id: 't2', website_scan_url: 'https://b.example' },
      ],
    });
    const withTenantClient = vi.fn();
    const importFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        extract: { answers: [], discovered: [] },
        confirmed: 1,
        suggestions: 0,
      })
      .mockResolvedValueOnce({
        ok: true,
        extract: { answers: [], discovered: [] },
        confirmed: 0,
        suggestions: 2,
      });

    const result = await rescanStaleWebsitesNow({
      query,
      withTenantClient: withTenantClient as never,
      importFn: importFn as never,
      openAiKey: 'k',
      skipLock: true,
    });

    expect(result).toEqual({
      candidates: 2,
      succeeded: 2,
      failed: 0,
      skippedNoKey: 0,
      skippedLock: 0,
      quarantined: 0,
    });
    expect(importFn).toHaveBeenCalledTimes(2);
    expect(importFn).toHaveBeenNthCalledWith(
      1,
      withTenantClient,
      't1',
      'https://a.example',
      'k'
    );
    expect(importFn).toHaveBeenNthCalledWith(
      2,
      withTenantClient,
      't2',
      'https://b.example',
      'k'
    );
  });

  it('SAD: one tenant failure is counted, records backoff, does not stop the rest', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { tenant_id: 'bad', website_scan_url: 'https://bad.example' },
        { tenant_id: 'good', website_scan_url: 'https://good.example' },
      ],
    });
    const importFn = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, error: 'unreachable' })
      .mockResolvedValueOnce({
        ok: true,
        extract: { answers: [], discovered: [] },
        confirmed: 1,
        suggestions: 0,
      });
    const recordFailureFn = vi.fn().mockResolvedValue({ failCount: 1, quarantined: false });

    const before = errorsTotalFor('website_rescan_tenant_failed');
    const result = await rescanStaleWebsitesNow({
      query,
      withTenantClient: vi.fn() as never,
      importFn: importFn as never,
      recordFailureFn: recordFailureFn as never,
      openAiKey: 'k',
      skipLock: true,
    });

    expect(result).toEqual({
      candidates: 2,
      succeeded: 1,
      failed: 1,
      skippedNoKey: 0,
      skippedLock: 0,
      quarantined: 0,
    });
    expect(importFn).toHaveBeenCalledTimes(2);
    expect(recordFailureFn).toHaveBeenCalledTimes(1);
    expect(recordFailureFn).toHaveBeenCalledWith(expect.anything(), 'bad');
    expect(errorsTotalFor('website_rescan_tenant_failed')).toBe(before + 1);
  });

  it('SAD: quarantine after N fails bumps website_rescan_tenant_quarantined', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ tenant_id: 'dead', website_scan_url: 'https://dead.example' }],
    });
    const importFn = vi.fn().mockResolvedValue({ ok: false, status: 400, error: 'gone' });
    const recordFailureFn = vi.fn().mockResolvedValue({ failCount: 5, quarantined: true });

    const beforeQ = errorsTotalFor('website_rescan_tenant_quarantined');
    const result = await rescanStaleWebsitesNow({
      query,
      withTenantClient: vi.fn() as never,
      importFn: importFn as never,
      recordFailureFn: recordFailureFn as never,
      openAiKey: 'k',
      skipLock: true,
    });

    expect(result.failed).toBe(1);
    expect(result.quarantined).toBe(1);
    expect(errorsTotalFor('website_rescan_tenant_quarantined')).toBe(beforeQ + 1);
  });

  it('SAD: a thrown import is isolated, instrumented, and records failure', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ tenant_id: 'boom', website_scan_url: 'https://boom.example' }],
    });
    const importFn = vi.fn().mockRejectedValue(new Error('network down'));
    const recordFailureFn = vi.fn().mockResolvedValue({ failCount: 2, quarantined: false });

    const before = errorsTotalFor('website_rescan_tenant_failed');
    const result = await rescanStaleWebsitesNow({
      query,
      withTenantClient: vi.fn() as never,
      importFn: importFn as never,
      recordFailureFn: recordFailureFn as never,
      openAiKey: 'k',
      skipLock: true,
    });

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(recordFailureFn).toHaveBeenCalledTimes(1);
    expect(errorsTotalFor('website_rescan_tenant_failed')).toBe(before + 1);
  });

  it('SAD: skipLock false + contended lock returns skippedLock without importing', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (/pg_try_advisory_lock/i.test(sql)) return { rows: [{ ok: false }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
    };
    const importFn = vi.fn();

    const result = await rescanStaleWebsitesNow({
      pool: pool as never,
      importFn: importFn as never,
      openAiKey: 'k',
      skipLock: false,
    });

    expect(result.skippedLock).toBe(1);
    expect(importFn).not.toHaveBeenCalled();
  });
});

describe('start/stopWebsiteRescanScheduler', () => {
  afterEach(() => {
    stopWebsiteRescanScheduler();
  });

  it('HAPPY: start marks running; stop clears it; double-start is a no-op', () => {
    expect(isWebsiteRescanSchedulerRunning()).toBe(false);
    startWebsiteRescanScheduler(60_000);
    expect(isWebsiteRescanSchedulerRunning()).toBe(true);
    startWebsiteRescanScheduler(60_000); // already running
    expect(isWebsiteRescanSchedulerRunning()).toBe(true);
    stopWebsiteRescanScheduler();
    expect(isWebsiteRescanSchedulerRunning()).toBe(false);
  });
});
