/**
 * WHO:   stampWebsiteScan / importWebsiteKnowledge success path + failure bookkeeping
 * WHAT:  successful import writes website_scan_url + website_last_scanned_at + resets fails;
 *        failure increments fail_count without touching last_scanned
 * WHEN:  after stageSuggestions on a successful scrape/extract
 * WHERE: src/services/knowledge/websiteImport.ts
 * WHY:   without the stamp the re-scan scheduler has no candidate set; without
 *        failure bookkeeping dead URLs monopolize the oldest-stale batch
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  stampWebsiteScan,
  importWebsiteKnowledge,
  recordWebsiteScanFailure,
} from '../../../src/services/knowledge/websiteImport';

describe('stampWebsiteScan', () => {
  it('HAPPY: UPDATEs tenants with url + resets fail_count under tenant context', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const withTenantClient = vi.fn(async (_tenantId: string, fn: (c: { query: typeof query }) => Promise<unknown>) =>
      fn({ query })
    );

    await stampWebsiteScan(withTenantClient as never, 'tenant-1', 'https://shop.example');

    expect(withTenantClient).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE tenants/i);
    expect(sql).toMatch(/website_scan_url/i);
    expect(sql).toMatch(/website_last_scanned_at/i);
    expect(sql).toMatch(/website_scan_fail_count = 0/i);
    expect(sql).toMatch(/website_scan_last_attempt_at/i);
    expect(params).toEqual(['https://shop.example', 'tenant-1']);
  });
});

describe('recordWebsiteScanFailure', () => {
  it('HAPPY: increments fail_count and reports quarantine at threshold', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ website_scan_fail_count: 5 }],
      rowCount: 1,
    });
    const withTenantClient = vi.fn(async (_id: string, fn: (c: { query: typeof query }) => Promise<unknown>) =>
      fn({ query })
    );

    const rec = await recordWebsiteScanFailure(withTenantClient as never, 'tenant-1', 5);

    expect(rec).toEqual({ failCount: 5, quarantined: true });
    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/website_scan_fail_count = website_scan_fail_count \+ 1/i);
    expect(sql).toMatch(/website_scan_last_attempt_at = NOW\(\)/i);
    expect(sql).not.toMatch(/website_last_scanned_at/i);
  });
});

describe('importWebsiteKnowledge — stamp on success', () => {
  const savedStub = process.env.KNOWLEDGE_IMPORT_E2E_STUB;

  beforeEach(() => {
    process.env.KNOWLEDGE_IMPORT_E2E_STUB = '1';
  });

  afterEach(() => {
    if (savedStub === undefined) delete process.env.KNOWLEDGE_IMPORT_E2E_STUB;
    else process.env.KNOWLEDGE_IMPORT_E2E_STUB = savedStub;
  });

  it('HAPPY: stub path supersedes + stages then stamps in one tenant client call', async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      if (/SELECT title FROM tenant_docs/i.test(sql)) {
        calls.push('resolve');
        return { rows: [], rowCount: 0 };
      }
      if (/status = 'superseded'/i.test(sql)) {
        calls.push('supersede');
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO knowledge_suggestion/i.test(sql)) {
        calls.push('stage');
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE tenants/i.test(sql) && /website_scan_url/i.test(sql)) {
        calls.push('stamp');
        return { rows: [], rowCount: 1 };
      }
      calls.push('other');
      return { rows: [], rowCount: 0 };
    });
    // resolve uses its own withTenantClient call; stage+stamp share one
    let txnCalls = 0;
    const withTenantClient = vi.fn(async (_id: string, fn: (c: { query: typeof query }) => Promise<unknown>) => {
      txnCalls++;
      return fn({ query });
    });

    const result = await importWebsiteKnowledge(
      withTenantClient as never,
      'tenant-1',
      'https://shop.example'
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confirmed).toBeGreaterThan(0);
    }
    // resolve is its own tenant client; stage+stamp share the second
    expect(txnCalls).toBe(2);
    expect(calls[0]).toBe('resolve');
    expect(calls).toContain('supersede');
    expect(calls.filter((c) => c === 'stage').length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]).toBe('stamp');
    // supersede before any insert, stamp last
    const supersedeAt = calls.indexOf('supersede');
    const firstStage = calls.indexOf('stage');
    const stampAt = calls.lastIndexOf('stamp');
    expect(supersedeAt).toBeGreaterThan(-1);
    expect(firstStage).toBeGreaterThan(supersedeAt);
    expect(stampAt).toBeGreaterThan(firstStage);
  });
});
