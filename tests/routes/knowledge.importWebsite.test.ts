/**
 * WHO:   POST /knowledge/import-website
 * WHAT:  website scan → LLM policy extraction → staged knowledge_suggestion rows
 * WHEN:  owner pastes their site URL during the setup wizard
 * WHERE: src/routes/knowledge.ts
 * WHY:   the extractor must receive a NON-EMPTY question list (shared bank +
 *        owner custom questions). A prior bug fed [] via a brittle cross-package
 *        import, silently extracting nothing. This test guards that path: it
 *        asserts the OpenAI request actually carries the bank + the tenant's
 *        custom question.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerKnowledgeRoutes } from '../../src/routes/knowledge';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';
import { scanRateLimiter } from '../../src/services/scanRateLimit';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (_hostname: string, options?: { all?: boolean }) => {
    const rec = { address: '93.184.216.34', family: 4 as const };
    return options?.all ? [rec] : rec;
  }),
}));

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const mockGetEmbedding = vi.fn().mockResolvedValue(Array(1536).fill(0));
const mockNormalize = vi.fn(async (text: string) => text);

let handle: RouteTestAppHandle;
let app: FastifyInstance;

beforeAll(async () => {
  handle = buildRouteTestApp((a, pool, withTenantClient) => {
    registerKnowledgeRoutes(a, pool, mockGetEmbedding, withTenantClient, mockNormalize);
  });
  app = handle.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const AUTH = { 'x-tenant-id': TENANT_ID, authorization: 'Bearer test-token' };

// Capture every OpenAI extraction prompt the handler sends.
let openAiPrompts: string[] = [];
// Preserve the ambient key so we don't leak 'test-key' into other test files
// that assert the missing-key behavior.
let savedOpenAiKey: string | undefined;

beforeEach(() => {
  handle.queries.length = 0;
  handle.queryResponses.length = 0;
  mockGetEmbedding.mockClear();
  openAiPrompts = [];
  // Per-test isolation for the shared in-process scan limiter so one test's
  // scans don't drain another's bucket (default capacity is only 3).
  scanRateLimiter.reset();
  savedOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  // Mock fetch for BOTH the site scrape and the OpenAI extraction call.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { body?: string }) => {
      const u = url.toString();
      if (u.includes('api.openai.com')) {
        const body = JSON.parse(init?.body || '{}');
        openAiPrompts.push(body.messages?.[0]?.content || '');
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answers: [
                      {
                        questionId: 'hours-of-operation',
                        question: 'What are your hours of operation?',
                        answer: 'Mon-Fri 9 to 5.',
                        sourceUrl: u,
                        confidence: 0.9,
                      },
                    ],
                    discovered: [],
                  }),
                },
              },
            ],
          }),
        } as unknown as Response;
      }
      // Site scrape — return enough readable text to pass the >200 char gate,
      // with no internal links so the crawler stops after one page.
      return {
        ok: true,
        text: async () =>
          `<html><body>${'We are open Monday to Friday. '.repeat(20)}</body></html>`,
      } as unknown as Response;
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenAiKey;
});

describe('POST /knowledge/import-website', () => {
  it('HAPPY: feeds the static bank + the tenant custom question to the LLM', async () => {
    // WHO: owner with one custom question ("Do you deliver?") running a scan
    // WHAT: the extractor prompt must contain bank questions AND the custom one
    // WHY: regression guard — questions must never resolve to an empty list
    handle.queryResponses.push({ rows: [{ title: 'Do you deliver?' }], rowCount: 1 }); // custom SELECT
    handle.queryResponses.push({ rows: [], rowCount: 0 }); // supersede prior open suggestions
    handle.queryResponses.push({ rows: [], rowCount: 1 }); // INSERT of the one confirmed answer
    handle.queryResponses.push({ rows: [], rowCount: 1 }); // stamp website_scan_url / last_scanned

    const res = await app.inject({
      method: 'POST',
      url: '/knowledge/import-website',
      headers: AUTH,
      payload: { url: 'https://example-shop.com' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.confirmed).toBe(1);

    // The prompt that reached OpenAI carried a real, non-empty question list.
    expect(openAiPrompts.length).toBe(1);
    const prompt = openAiPrompts[0];
    expect(prompt).toContain('What are your hours of operation?'); // a static bank question
    expect(prompt).toContain('[hours-of-operation]'); // bank id label
    expect(prompt).toContain('Do you deliver?'); // the owner custom question
  });

  it('HAPPY: works for a tenant with zero custom questions (bank still non-empty)', async () => {
    // WHAT: empty custom SELECT → resolver returns the static bank only
    // WHY: the common case must still extract; bank must not collapse to []
    handle.queryResponses.push({ rows: [], rowCount: 0 }); // no custom questions
    handle.queryResponses.push({ rows: [], rowCount: 0 }); // supersede prior open suggestions
    handle.queryResponses.push({ rows: [], rowCount: 1 }); // INSERT
    handle.queryResponses.push({ rows: [], rowCount: 1 }); // stamp website_scan_url / last_scanned

    const res = await app.inject({
      method: 'POST',
      url: '/knowledge/import-website',
      headers: AUTH,
      payload: { url: 'https://example-shop.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(openAiPrompts.length).toBe(1);
    expect(openAiPrompts[0]).toContain('What are your hours of operation?');
  });

  it('SAD: rejects a non-URL at the schema layer before any scan', async () => {
    // WHAT: invalid URL → 400, no fetch, no LLM call
    // WHY: don't spend a scrape + an OpenAI call on garbage input
    const res = await app.inject({
      method: 'POST',
      url: '/knowledge/import-website',
      headers: AUTH,
      payload: { url: 'not-a-url' },
    });

    expect(res.statusCode).toBe(400);
    expect(openAiPrompts.length).toBe(0);
  });

  it('SAD: refuses a link-local metadata URL before any scrape or LLM call', async () => {
    // WHAT: 169.254.169.254 is a valid URL to Zod and used to reach fetch
    // WHY: an owner must not scan the host metadata endpoint through our backend
    const res = await app.inject({
      method: 'POST',
      url: '/knowledge/import-website',
      headers: AUTH,
      payload: { url: 'http://169.254.169.254/latest/meta-data/' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/not allowed/i);
    expect(openAiPrompts.length).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('SAD: an OpenAI non-2xx (e.g. 429) surfaces as an error, not empty success', async () => {
    // WHO: a scan that hits an OpenAI rate-limit / bad key / 5xx
    // WHAT: handler returns 500 error instead of a "successful" empty extraction
    // WHY: guard the silent-empty bug — a 429 must not look like "found nothing"
    handle.queryResponses.push({ rows: [], rowCount: 0 }); // custom SELECT
    // Re-stub fetch: site scrape OK, but OpenAI returns 429
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = url.toString();
        if (u.includes('api.openai.com')) {
          return { ok: false, status: 429, json: async () => ({}) } as unknown as Response;
        }
        return {
          ok: true,
          text: async () =>
            `<html><body>${'We are open Monday to Friday. '.repeat(20)}</body></html>`,
        } as unknown as Response;
      })
    );

    const res = await app.inject({
      method: 'POST',
      url: '/knowledge/import-website',
      headers: AUTH,
      payload: { url: 'https://example-shop.com' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().success).toBe(false);
  });

  it('SAD: rate-limits a tenant after the burst capacity, returns 429', async () => {
    // WHO: a tenant (or a bad actor) hammering the scan endpoint
    // WHAT: the first 3 scans (default bucket capacity) succeed; the 4th in the
    //        same window is rejected with 429 and never touches OpenAI
    // WHY: the scan is the most expensive request a tenant can make (external
    //        multi-page fetch + LLM extract). A per-tenant token bucket caps the
    //        burn so one tenant can't run up OpenAI cost or proxy abuse.
    // Prime DB responses for 3 successful scans (custom SELECT + INSERT + stamp each).
    for (let i = 0; i < 3; i++) {
      handle.queryResponses.push({ rows: [], rowCount: 0 }); // custom-question SELECT
      handle.queryResponses.push({ rows: [], rowCount: 1 }); // INSERT
      handle.queryResponses.push({ rows: [], rowCount: 1 }); // stamp last_scanned
    }

    for (let i = 0; i < 3; i++) {
      const ok = await app.inject({
        method: 'POST',
        url: '/knowledge/import-website',
        headers: AUTH,
        payload: { url: 'https://example-shop.com' },
      });
      expect(ok.statusCode).toBe(200);
    }

    const promptsAfterBurst = openAiPrompts.length;

    const limited = await app.inject({
      method: 'POST',
      url: '/knowledge/import-website',
      headers: AUTH,
      payload: { url: 'https://example-shop.com' },
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.json().success).toBe(false);
    expect(limited.json().error).toContain('scan limit');
    // WHY: the rejected request must short-circuit BEFORE the LLM call — no
    //       extra OpenAI prompt was sent.
    expect(openAiPrompts.length).toBe(promptsAfterBurst);
  });
});
