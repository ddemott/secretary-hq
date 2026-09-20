/**
 * SECURITY: owner-role gate on the 8 mutating /knowledge/* routes
 * (2026-09-16 role-check audit, docs/planning/TODO.md).
 *
 * WHO:   a front-desk login trying to delete/overwrite the policy answers
 *        the live voice agent reads from on every call.
 * WHAT:  DELETE /knowledge/:id, POST /knowledge/ingest, POST /knowledge/add,
 *        PUT /knowledge/:id, PATCH /knowledge/unanswered/:id/resolve,
 *        POST /knowledge/import-website, POST /knowledge/import-document,
 *        PATCH /knowledge/suggestions/:id all require
 *        `req.auth.role === 'owner'` — previously these 8 routes checked
 *        only `requireTenantId`. `POST /knowledge/explain` is deliberately
 *        NOT covered here — it already had the correct gate.
 * WHERE: src/routes/knowledge.ts.
 * WHY:   the role gate must fire before any multipart parsing / DB query,
 *        so these tests use a plain JSON body even for the two multipart
 *        routes (ingest, import-document) — the 403 must land before
 *        `req.file()` is ever awaited.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerKnowledgeRoutes } from '../../src/routes/knowledge';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DOC_ID = '11111111-2222-4333-8444-555555555555';

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

function setAuth(role: 'owner' | 'front_desk' | null) {
  handle.auth.current =
    role === null
      ? null
      : {
          user_id: '00000000-0000-0000-0000-000000000001',
          tenant_id: TENANT_ID,
          email: `${role}@test.local`,
          role,
        };
}

beforeEach(() => {
  handle.queries.length = 0;
  handle.queryResponses.length = 0;
  handle.tenantIdOverride.current = null;
  mockGetEmbedding.mockClear();
  setAuth('owner');
});

function dataQueries() {
  return handle.queries.filter(
    (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
  );
}

const mutatingRoutes: Array<[string, string, string, Record<string, unknown>]> = [
  ['DELETE /knowledge/:id', 'DELETE', `/knowledge/${DOC_ID}`, {}],
  ['POST /knowledge/ingest', 'POST', '/knowledge/ingest', { tenant_id: TENANT_ID }],
  [
    'POST /knowledge/add',
    'POST',
    '/knowledge/add',
    { question: 'What are your hours?', answer: 'Nine to five, Monday through Friday.' },
  ],
  [
    'PUT /knowledge/:id',
    'PUT',
    `/knowledge/${DOC_ID}`,
    { question: 'What are your hours?', answer: 'Nine to five, Monday through Friday.' },
  ],
  ['PATCH /knowledge/unanswered/:id/resolve', 'PATCH', `/knowledge/unanswered/${DOC_ID}/resolve`, {}],
  ['POST /knowledge/import-website', 'POST', '/knowledge/import-website', { url: 'https://example.com' }],
  ['POST /knowledge/import-document', 'POST', '/knowledge/import-document', { tenant_id: TENANT_ID }],
  [
    'PATCH /knowledge/suggestions/:id',
    'PATCH',
    `/knowledge/suggestions/${DOC_ID}`,
    { status: 'confirmed' },
  ],
];

describe('/knowledge/* mutating routes — owner-role gate', () => {
  it.each(mutatingRoutes)(
    'SECURITY: %s is rejected 403 for a front-desk user before any query runs',
    async (_name, method, path, payload) => {
      setAuth('front_desk');

      const res = await app.inject({
        method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        url: path,
        payload,
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().success).toBe(false);
      expect(dataQueries()).toHaveLength(0);
    }
  );

  it.each(mutatingRoutes)(
    'SECURITY: %s is rejected 401 when unauthenticated',
    async (_name, method, path, payload) => {
      setAuth(null);

      const res = await app.inject({
        method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        url: path,
        payload,
      });

      expect(res.statusCode).toBe(401);
      expect(dataQueries()).toHaveLength(0);
    }
  );
});
