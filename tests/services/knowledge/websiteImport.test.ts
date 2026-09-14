/**
 * WHO:   stampWebsiteScan / importWebsiteKnowledge success path
 * WHAT:  successful import writes website_scan_url + website_last_scanned_at
 * WHEN:  after stageSuggestions on a successful scrape/extract
 * WHERE: src/services/knowledge/websiteImport.ts
 * WHY:   without the stamp the re-scan scheduler has no candidate set
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stampWebsiteScan, importWebsiteKnowledge } from '../../../src/services/knowledge/websiteImport';

describe('stampWebsiteScan', () => {
  it('HAPPY: UPDATEs tenants with url under tenant context', async () => {
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
    expect(params).toEqual(['https://shop.example', 'tenant-1']);
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

  it('HAPPY: stub path stages then stamps (order matters for freshness)', async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      if (/SELECT title FROM tenant_docs/i.test(sql)) {
        calls.push('resolve');
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
    const withTenantClient = vi.fn(async (_id: string, fn: (c: { query: typeof query }) => Promise<unknown>) =>
      fn({ query })
    );

    const result = await importWebsiteKnowledge(
      withTenantClient as never,
      'tenant-1',
      'https://shop.example'
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confirmed).toBeGreaterThan(0);
    }
    // resolve → stage (one or more) → stamp last
    expect(calls[0]).toBe('resolve');
    expect(calls.filter((c) => c === 'stage').length).toBeGreaterThan(0);
    expect(calls[calls.length - 1]).toBe('stamp');
  });
});
