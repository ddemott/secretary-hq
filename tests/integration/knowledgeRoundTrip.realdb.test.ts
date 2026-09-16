/**
 * T-103 — an owner-authored knowledge entry, from the dashboard's write all the
 * way to the agent's answer, against real Postgres + real pgvector.
 *
 * WHO  — a business owner adding "What are your hours?" in the Knowledge Base
 *        tab, and a caller asking it a different way an hour later.
 * WHAT — POST /knowledge/add persists a row WITH an embedding; the agent's own
 *        /agent-tools/policy-answer retrieves it through
 *        `search_tenant_docs_normalized`; an unrelated question misses and
 *        returns the graceful fallback; DELETE removes it and the answer stops
 *        coming back.
 * WHEN  — CI, on any change to the knowledge routes, the ingest shape, or the
 *         retrieval SQL.
 * WHERE — src/routes/knowledge.ts → tenant_docs (+ embedding) →
 *         src/routes/agentTools/knowledge.ts.
 * WHY  — every layer of this was already tested IN ISOLATION with mocks, and a
 *        mock cannot tell you the vector actually landed in the column, that
 *        the RPC's threshold lets a real paraphrase through, or that DELETE
 *        reaches the same row the answer came from. Those are exactly the seams
 *        where "green CI but broken in prod" lives.
 *
 * ON THE EMBEDDER: this test injects a DETERMINISTIC bag-of-words embedder
 * instead of calling OpenAI. That is deliberate and it is a limit worth stating
 * plainly — it proves the storage, retrieval SQL, threshold comparison and route
 * wiring are correct end to end; it does NOT prove OpenAI's embeddings rank a
 * given paraphrase above the threshold. Semantic quality is what
 * `./scripts/simulate.sh rag` measures with real embeddings, on demand.
 *
 * ON `kb_entries`: PRODUCT_ROADMAP's T-103 proposes a new `kb_entries` table
 * with keyword matching. It must NOT be built — see the note in that task. This
 * system already exists, is RAG-backed, and is what the agent calls today.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { type Client, Pool } from 'pg';
import { API_DB_URL, getRootClient, createTenant, skipIfDbDown } from '../utils';
import { createWithTenantClient } from '../../src/database';
import { registerKnowledgeRoutes } from '../../src/routes/knowledge';
import { registerAgentToolRoutes } from '../../src/routes/agentTools';

const AGENT_SECRET = 'test-agent-secret';
const DIM = 1536;

/**
 * A deterministic unit-length embedding: each word contributes to a fixed set
 * of dimensions, so shared vocabulary means high cosine similarity and disjoint
 * vocabulary means near-zero. Same input → same vector, always.
 */
function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) % DIM;
    v[h] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
let tenantId: string;
const tenantsToClean: string[] = [];

const addEntry = (body: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/knowledge/add',
    headers: { 'x-tenant-id': tenantId },
    payload: body,
  });

const listEntries = () =>
  app.inject({ method: 'GET', url: '/knowledge', headers: { 'x-tenant-id': tenantId } });

const deleteEntry = (id: string) =>
  app.inject({
    method: 'DELETE',
    url: `/knowledge/${id}`,
    headers: { 'x-tenant-id': tenantId },
  });

const ask = (question: string) =>
  app.inject({
    method: 'POST',
    url: '/agent-tools/policy-answer',
    headers: { 'x-agent-secret': AGENT_SECRET },
    payload: { tenant_id: tenantId, question },
  });

/** The route's own graceful "no answer" line — matched, not re-typed. */
const CANNOT_ANSWER = /don't have specific information on that topic/i;

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });
    tenantId = await createTenant(setup, 'Knowledge Round Trip Co', 'salon');
    tenantsToClean.push(tenantId);
    process.env.AGENT_SECRET = AGENT_SECRET;

    app = Fastify({ logger: false });
    type TenantRequest = FastifyRequest & {
      tenantId?: string;
      auth?: { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
    };
    app.addHook('preHandler', async (request: TenantRequest) => {
      const header = request.headers['x-tenant-id'];
      if (typeof header === 'string' && header) {
        request.tenantId = header;
        // Owner by default — /knowledge/add and DELETE /knowledge/:id are
        // owner-gated (requireOwnerRole, 2026-09-16 role-check audit).
        request.auth = {
          tenant_id: header,
          user_id: '00000000-0000-0000-0000-000000000001',
          email: 'owner@test.local',
          role: 'owner',
        };
      }
    });
    const withTenantClient = createWithTenantClient(pool);
    const embed = async (text: string) => fakeEmbedding(text);
    registerKnowledgeRoutes(app, pool, embed, withTenantClient);
    registerAgentToolRoutes(app, pool, withTenantClient, embed);
    await app.ready();
    dbAvailable = true;
  } catch (err) {
    console.warn('[knowledgeRoundTrip.realdb] DB not available, skipping', err);
  }
});

afterAll(async () => {
  delete process.env.AGENT_SECRET;
  if (app) await app.close();
  if (pool) await pool.end();
  if (setup) {
    for (const id of tenantsToClean) {
      await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
    }
    await setup.end();
  }
});

beforeEach(async (ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
  if (!dbAvailable) return;
  await setup.query('DELETE FROM tenant_docs WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM unanswered_questions WHERE tenant_id = $1', [tenantId]);
});

describe('T-103: owner writes an entry, the agent answers from it', () => {
  it('HAPPY: add → list → the agent retrieves it → delete → it is gone', async () => {
    const added = await addEntry({
      question: 'What are your hours?',
      answer: 'We are open Monday through Friday, nine to five.',
      category: 'Hours',
      source: 'owner',
    });
    expect(added.statusCode).toBe(200);
    const docId = added.json<{ tenant_doc_id: string }>().tenant_doc_id;

    // The EMBEDDING has to be in the column, not just the text. A NULL here
    // makes the row invisible to retrieval while the dashboard still lists it —
    // the entry looks saved and the agent has never heard of it.
    const stored = await setup.query<{ has_embedding: boolean; content: string }>(
      'SELECT embedding IS NOT NULL AS has_embedding, content FROM tenant_docs WHERE tenant_doc_id = $1',
      [docId]
    );
    expect(stored.rows[0].has_embedding).toBe(true);
    expect(stored.rows[0].content).toContain('nine to five');

    const listed = await listEntries();
    expect(listed.json<Array<{ tenant_doc_id: string }>>().map((r) => r.tenant_doc_id)).toContain(
      docId
    );

    const answered = await ask('what are your hours');
    expect(answered.statusCode).toBe(200);
    const body = answered.json<{ success: boolean; result: string }>();
    expect(body.success).toBe(true);
    expect(body.result).toContain('nine to five');

    expect((await deleteEntry(docId)).statusCode).toBe(200);
    expect(
      (await listEntries()).json<Array<{ tenant_doc_id: string }>>().map((r) => r.tenant_doc_id)
    ).not.toContain(docId);

    // And the answer stops coming back — a delete that leaves the vector behind
    // means the agent keeps reciting a policy the owner retracted.
    const afterDelete = await ask('what are your hours');
    expect(afterDelete.json<{ result: string }>().result).toMatch(CANNOT_ANSWER);
  });

  it('SAD: a question the knowledge base cannot answer returns the graceful fallback', async () => {
    await addEntry({
      question: 'What are your hours?',
      answer: 'We are open Monday through Friday, nine to five.',
      category: 'Hours',
      source: 'owner',
    });

    const res = await ask('do you sell used cars');

    // Never a raw 500 or JSON error — the caller hears this line, so it must be
    // a sentence a receptionist could say out loud.
    expect(res.statusCode).toBe(200);
    expect(res.json<{ result: string }>().result).toMatch(CANNOT_ANSWER);
  });

  it('SAD: the miss is RECORDED, so the owner can see what callers ask for', async () => {
    // A question nobody can answer is a content gap, and the only way it ever
    // gets filled is if somebody knows it was asked.
    //
    // The route logs this FIRE-AND-FORGET on purpose — a live caller must never
    // wait on analytics — so the row lands shortly AFTER the response. Polling
    // is the honest way to assert it; querying once immediately tests the race,
    // not the behaviour (which is exactly what the first draft of this test did,
    // and it read the PREVIOUS case's row).
    await ask('do you offer wedding packages');

    const deadline = Date.now() + 5000;
    let questions: string[] = [];
    while (Date.now() < deadline) {
      const rows = await setup.query<{ question: string }>(
        'SELECT question FROM unanswered_questions WHERE tenant_id = $1',
        [tenantId]
      );
      questions = rows.rows.map((r) => r.question);
      if (questions.includes('do you offer wedding packages')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(questions).toContain('do you offer wedding packages');
  });

  it('SECURITY: one tenant cannot retrieve another tenant knowledge', async () => {
    // The RPC takes tenant_id as a parameter, so a bug here is a cross-tenant
    // content leak that looks like a working answer.
    const otherTenant = await createTenant(setup, 'Someone Else Salon', 'salon');
    tenantsToClean.push(otherTenant);
    await addEntry({
      question: 'What is the door code?',
      answer: 'The door code is 4417.',
      category: 'Access',
      source: 'owner',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/agent-tools/policy-answer',
      headers: { 'x-agent-secret': AGENT_SECRET },
      payload: { tenant_id: otherTenant, question: 'what is the door code' },
    });

    expect(res.json<{ result: string }>().result).not.toContain('4417');
    expect(res.json<{ result: string }>().result).toMatch(CANNOT_ANSWER);
  });
});
