/**
 * WHO:   website re-scan scheduler
 * WHAT:  pick stale tenants under batch/stale caps; run import; isolate failures
 * WHEN:  daily tick (prod) or ENABLE_WEBSITE_RESCAN_SCHEDULER=true
 * WHERE: src/workers/websiteRescanScheduler.ts
 * WHY:   cost-aware defaults must hold — batch cap, skip-no-key, one bad tenant
 *        must not abort the rest; selection SQL is the product rule for "who"
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  selectStaleWebsiteScanTenants,
  rescanStaleWebsitesNow,
  startWebsiteRescanScheduler,
  stopWebsiteRescanScheduler,
  isWebsiteRescanSchedulerRunning,
} from '../../src/workers/websiteRescanScheduler';
import { errorsTotal } from '../../src/services/metrics';

function errorsTotalFor(event: string): number {
  return errorsTotal.snapshot().find((s) => s.labels.event === event)?.value ?? 0;
}

describe('selectStaleWebsiteScanTenants', () => {
  it('HAPPY: forwards staleDays + batchSize as SQL params in that order', async () => {
    // WHO: cost-aware defaults (30d, batch 5) must reach the query — a swapped
    //      param order would re-scan the wrong set or uncapped volume
    const query = vi.fn().mockResolvedValue({
      rows: [{ tenant_id: 't1', website_scan_url: 'https://a.example' }],
    });

    const rows = await selectStaleWebsiteScanTenants(query, {
      staleDays: 14,
      batchSize: 3,
    });

    expect(rows).toEqual([{ tenant_id: 't1', website_scan_url: 'https://a.example' }]);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/website_scan_url IS NOT NULL/i);
    expect(sql).toMatch(/is_demo = false/i);
    expect(sql).toMatch(/is_deleted = false/i);
    expect(sql).toMatch(/ORDER BY website_last_scanned_at ASC NULLS FIRST/i);
    expect(sql).toMatch(/LIMIT \$2/i);
    expect(params).toEqual([14, 3]);
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
    // WHY: without a key every import fails; spinning candidates would only
    //      spam website_rescan_tenant_failed forever without advancing stamps
    delete process.env.OPENAI_API_KEY;
    const query = vi.fn();
    const importFn = vi.fn();

    const result = await rescanStaleWebsitesNow({ query, importFn });

    expect(result).toEqual({
      candidates: 0,
      succeeded: 0,
      failed: 0,
      skippedNoKey: 1,
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
    });

    expect(result).toEqual({ candidates: 2, succeeded: 2, failed: 0, skippedNoKey: 0 });
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

  it('SAD: one tenant failure is counted and does not stop the rest', async () => {
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

    const before = errorsTotalFor('website_rescan_tenant_failed');
    const result = await rescanStaleWebsitesNow({
      query,
      withTenantClient: vi.fn() as never,
      importFn: importFn as never,
      openAiKey: 'k',
    });

    expect(result).toEqual({ candidates: 2, succeeded: 1, failed: 1, skippedNoKey: 0 });
    expect(importFn).toHaveBeenCalledTimes(2);
    expect(errorsTotalFor('website_rescan_tenant_failed')).toBe(before + 1);
  });

  it('SAD: a thrown import is isolated and instrumented', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ tenant_id: 'boom', website_scan_url: 'https://boom.example' }],
    });
    const importFn = vi.fn().mockRejectedValue(new Error('network down'));

    const before = errorsTotalFor('website_rescan_tenant_failed');
    const result = await rescanStaleWebsitesNow({
      query,
      withTenantClient: vi.fn() as never,
      importFn: importFn as never,
      openAiKey: 'k',
    });

    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(errorsTotalFor('website_rescan_tenant_failed')).toBe(before + 1);
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
