/**
 * Knowledge upload + policy-answer end-to-end coverage.
 *
 * Closes TODO.md P2 gap: "Upload PDF → embedding generated → ask question
 * → policy-answer route returns relevant chunk. Untested end-to-end."
 *
 * Strategy: real Fastify app with both knowledge + agent-tool routes wired
 * against test_db (api_user pool so RLS actually applies). A deterministic
 * keyword-based embedding stub (defined below) lets the test control which
 * chunks should be retrieved for which queries without going through real
 * OpenAI — the stub is calibrated so two texts that share at least one of
 * the test KEYWORDS produce vectors whose cosine similarity clears the
 * route's 0.3 threshold. This pins:
 *
 *   1. /knowledge/add writes content + embedding to tenant_docs correctly.
 *   2. /agent-tools/policy-answer reads via search_tenant_docs_normalized
 *      and returns the matched content in the conversational response.
 *   3. The fallback path (zero similarity matches) returns the
 *      take-a-message string AND logs to unanswered_questions for the
 *      owner to see.
 *
 * Why not Playwright: real OpenAI calls would make the suite slow,
 * flaky, and dependent on OPENAI_API_KEY at runtime. The pgvector +
 * search RPC + route wiring is the integration risk worth pinning; the
 * embedding QUALITY is OpenAI's responsibility, not ours.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { type Client, Pool } from 'pg';
import { API_DB_URL, getRootClient, createTenant, createUser, skipIfDbDown } from '../utils';
import { registerJwtAuthHook, tenantMiddleware, generateToken } from '../../src/middleware/fastify-middleware';
import { createWithTenantClient } from '../../src/database';
import { registerKnowledgeRoutes } from '../../src/routes/knowledge';
import { registerAgentToolRoutes } from '../../src/routes/agentTools';

// Keywords the stub embedding recognizes. Each maps to a dimension; if a
// text contains that keyword, the corresponding slot in the returned
// vector is set to 1.0. Two texts that share keywords will have non-zero
// cosine similarity; texts with zero overlap will have similarity 0.
const KEYWORDS = ['hours', 'pricing', 'parking', 'cancellation', 'discount'] as const;

function stubEmbedding(text: string): Promise<number[]> {
  const v = new Array(1536).fill(0);
  const lower = text.toLowerCase();
  for (let i = 0; i < KEYWORDS.length; i++) {
    if (lower.includes(KEYWORDS[i])) v[i] = 1.0;
  }
  return Promise.resolve(v);
}

const stubNormalizer = async (text: string): Promise<string> => text;

const AGENT_SECRET = 'test-knowledge-policy-secret';

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));
let tenantId: string;
let ownerToken: string;
const tenantsToClean: string[] = [];

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');

    pool = new Pool({ connectionString: API_DB_URL, max: 5 });

    process.env.AGENT_SECRET = AGENT_SECRET;

    app = Fastify({ logger: false });
    // Multipart support for /knowledge/ingest (request body uses
    // multipart/form-data when a file is uploaded). Without it, the
    // ingest route's req.file() throws "Did not get any data".
    await app.register(multipart);
    registerJwtAuthHook(app, pool);
    tenantMiddleware(app);
    const withTenantClient = createWithTenantClient(pool);
    registerKnowledgeRoutes(app, pool, stubEmbedding, withTenantClient, stubNormalizer);
    registerAgentToolRoutes(app, pool, withTenantClient, stubEmbedding, stubNormalizer);
    await app.ready();

    tenantId = await createTenant(setup, 'PolicyAnswerTest', 'automotive');
    tenantsToClean.push(tenantId);
    const userId = await createUser(
      setup,
      tenantId,
      'policy-owner@test.example',
      'pw',
      'Policy Owner'
    );
    ownerToken = generateToken({
      tenant_id: tenantId,
      user_id: userId,
      email: 'policy-owner@test.example',
      role: 'owner',
    });

    dbAvailable = true;
  } catch (err) {
     
    console.warn('[knowledge-policy-answer.test] DB not available, skipping', err);
  }
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (setup) {
    for (const id of tenantsToClean) {
      await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
    }
    await setup.end();
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  // Clear the docs + unanswered table between tests so each one owns
  // its starting state. The tenant itself stays; only its docs are
  // wiped — fastest path to test isolation here.
  await setup.query('DELETE FROM tenant_docs WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM unanswered_questions WHERE tenant_id = $1', [tenantId]);
});

describe('Knowledge upload → policy-answer retrieval (real DB + pgvector)', () => {
  it('HAPPY: doc added via /knowledge/add is retrieved by a keyword-matching question', async () => {
    // WHO: voice agent + future dashboard knowledge UI.
    // WHAT: POST /knowledge/add inserts a row in tenant_docs with the
    //       stub embedding for the doc text. POST /agent-tools/policy-answer
    //       runs the same embedding on the question, the SQL search
    //       function returns the matched row, and the route surfaces
    //       its content as the conversational response.
    // WHEN: every caller who asks a question whose embedding clears
    //       the 0.3 similarity threshold against at least one stored
    //       doc — the load-bearing happy path.
    // WHERE: /knowledge/add (knowledge.ts) + /agent-tools/policy-answer
    //        (agentTools.ts) + search_tenant_docs_normalized RPC.
    // WHY: pins the upload-and-retrieve contract end to end. A
    //      regression in the SQL function, the route handler, the
    //      vector type cast, or the search threshold breaks this test
    //      with a concrete failure (specific content missing from the
    //      response), not a silent 200-with-empty-body.
    if (!dbAvailable) return;

    const addRes = await app.inject({
      method: 'POST',
      url: '/knowledge/add',
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        question: 'What are your business hours?',
        answer: 'Our hours are 9am to 5pm Monday through Friday. Closed weekends.',
        category: 'general',
        source: 'policy-questionnaire',
      },
    });
    expect(addRes.statusCode).toBe(200);
    expect(addRes.json().success).toBe(true);

    const askRes = await app.inject({
      method: 'POST',
      url: '/agent-tools/policy-answer',
      headers: { 'x-agent-secret': AGENT_SECRET },
      payload: { tenant_id: tenantId, question: 'When are your hours?' },
    });

    expect(askRes.statusCode).toBe(200);
    const body = askRes.json();
    expect(body.success).toBe(true);
    // The route returns the matched chunk(s) verbatim — assert on the
    // distinctive content phrase from the doc (matches "5pm").
    expect(body.result).toContain('5pm');
    expect(body.result).toContain('Monday through Friday');
    // Caller-facing source citation: the chunk is attributed to its source-doc
    // title. This runs against the REAL DB, so it pins the tenant_doc_id = ANY()
    // title lookup against actual Postgres (the mocked agentTools test can't —
    // it would pass even if the uuid[]/text[] cast were wrong and the lookup
    // silently failed).
    expect(body.result).toContain('[From "What are your business hours?"]');
  });

  it('HAPPY: doc uploaded via /knowledge/ingest is retrieved the same way', async () => {
    // WHO: dashboard PDF/text-upload flow.
    // WHAT: POST /knowledge/ingest with a multipart text file inserts
    //       one row per double-newline-separated chunk; a subsequent
    //       policy-answer call retrieves the right chunk.
    // WHEN: every customer who uploads a policy document and then
    //       expects the agent to be able to answer questions about it.
    // WHERE: /knowledge/ingest's chunk loop + tenant_docs INSERT.
    // WHY: the ingest path is the most common upload route in the UI
    //      and shares only the embedding+insert tail with /add — the
    //      file parsing + chunking layer is its own failure surface.
    if (!dbAvailable) return;

    const bodyText = [
      'Our hours are 9 to 5 on weekdays.',
      'Pricing starts at $99 for a basic tune-up.',
      'Free parking is available behind the building.',
    ].join('\n\n');

    const boundary = '----TestBoundary' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`, 'utf8'),
      Buffer.from(
        `Content-Disposition: form-data; name="tenant_id"\r\n\r\n${tenantId}\r\n`,
        'utf8'
      ),
      Buffer.from(`--${boundary}\r\n`, 'utf8'),
      Buffer.from(
        `Content-Disposition: form-data; name="file"; filename="policy.txt"\r\nContent-Type: text/plain\r\n\r\n`,
        'utf8'
      ),
      Buffer.from(bodyText, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);

    const ingestRes = await app.inject({
      method: 'POST',
      url: '/knowledge/ingest',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
    expect(ingestRes.statusCode).toBe(200);
    expect(ingestRes.json().success).toBe(true);
    expect(ingestRes.json().chunksIngested).toBe(3);

    // Ask about parking — only the third chunk contains the keyword
    // "parking", so the result should reference parking specifically,
    // not the unrelated hours or pricing chunks. The question MUST
    // include the keyword literally — the stub embedding matches on
    // exact substring (`"park" → no, "parking" → yes`), which is the
    // calibration that makes the cosine similarity test
    // deterministic.
    const askRes = await app.inject({
      method: 'POST',
      url: '/agent-tools/policy-answer',
      headers: { 'x-agent-secret': AGENT_SECRET },
      payload: { tenant_id: tenantId, question: 'Where can I find parking?' },
    });
    expect(askRes.statusCode).toBe(200);
    const body2 = askRes.json();
    expect(body2.success).toBe(true);
    expect(body2.result).toContain('parking');
    // The hours chunk shares no keyword overlap with the parking
    // question — vector similarity is 0, threshold is 0.3, so it
    // must not appear in the response.
    expect(body2.result).not.toContain('Our hours are');
    expect(body2.result).not.toContain('Pricing');
  });

  it('SAD: question with no matching docs returns fallback + logs unanswered_question', async () => {
    // WHO: a caller asking about something the business hasn't put
    //      into the knowledge base yet.
    // WHAT: similarity threshold is not cleared by ANY doc → route
    //       returns the take-a-message fallback string AND writes a
    //       row to unanswered_questions so the owner can see the gap.
    // WHEN: any first-time question on a topic the business hasn't
    //       documented — happens immediately on launch for any new
    //       tenant.
    // WHERE: the `if (matches.rows.length === 0)` branch in
    //        /agent-tools/policy-answer + the unanswered_questions
    //        INSERT immediately after.
    // WHY: the fallback message is the agent's last-line-of-defense
    //      against fabricating answers. The unanswered_questions row
    //      is the owner's only view into what their callers want.
    //      Both are load-bearing for safe-by-default behavior.
    if (!dbAvailable) return;

    // Seed one doc about "hours" so the table isn't empty — but the
    // question is about "discount", a different keyword, so the
    // embedding has zero overlap and the cosine similarity is 0.
    await app.inject({
      method: 'POST',
      url: '/knowledge/add',
      headers: { Authorization: `Bearer ${ownerToken}` },
      payload: {
        question: 'What are your hours?',
        answer: 'Our hours are 9 to 5 Mon-Fri.',
      },
    });

    const askRes = await app.inject({
      method: 'POST',
      url: '/agent-tools/policy-answer',
      headers: { 'x-agent-secret': AGENT_SECRET },
      payload: { tenant_id: tenantId, question: 'Do you offer a discount?' },
    });
    expect(askRes.statusCode).toBe(200);
    const body = askRes.json();
    expect(body.success).toBe(true);
    // The fallback string is conversational, not empty — its presence
    // proves the agent prompt has SOMETHING safe to say.
    expect(body.result).toMatch(/take a message|don't have specific information/i);

    // The unanswered_questions write is fire-and-forget. Poll up to
    // 2 seconds for the row to appear — a single setImmediate tick
    // is not enough for a real-DB roundtrip through withTenantClient
    // (BEGIN → SET LOCAL → INSERT → COMMIT).
    let logged: { rows: { question: string }[] } = { rows: [] };
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      logged = await setup.query<{ question: string }>(
        'SELECT question FROM unanswered_questions WHERE tenant_id = $1',
        [tenantId]
      );
      if (logged.rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(logged.rows.length).toBe(1);
    expect(logged.rows[0].question).toBe('Do you offer a discount?');
  });

  it('SAD: the logged gap carries the call_id it was asked on', async () => {
    // WHO: an owner clearing their Calls screen who still saw the nav badge
    //      counting one unanswered question (2026-09-09).
    // WHAT: policy-answer accepts an optional call_id and persists it on the
    //       unanswered_questions row.
    // WHEN: every zero-hit question asked on a real call.
    // WHERE: the INSERT INTO unanswered_questions in
    //        src/routes/agentTools/knowledge.ts.
    // WHY: DELETE /voice/session/:id resolves gaps by call_id. The column
    //      existed since 2026-04 and NO writer ever set it, so the cascade
    //      would have matched nothing — a no-op that looks like it worked.
    if (!dbAvailable) return;

    const askRes = await app.inject({
      method: 'POST',
      url: '/agent-tools/policy-answer',
      headers: { 'x-agent-secret': AGENT_SECRET },
      payload: {
        tenant_id: tenantId,
        question: 'Do you validate parking downtown?',
        call_id: 'sip-call-gap-1',
      },
    });
    expect(askRes.statusCode).toBe(200);

    // Same fire-and-forget poll as the test above.
    let logged: { rows: { call_id: string | null }[] } = { rows: [] };
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      logged = await setup.query<{ call_id: string | null }>(
        'SELECT call_id FROM unanswered_questions WHERE tenant_id = $1',
        [tenantId]
      );
      if (logged.rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(logged.rows.length).toBe(1);
    expect(logged.rows[0].call_id).toBe('sip-call-gap-1');
  });

  it('SAD: /agent-tools/policy-answer without the agent secret returns 401', async () => {
    // WHO: an unauthenticated client (web crawler, attacker, mis-wired
    //      worker that lost its secret).
    // WHAT: the agent-tools preHandler hook rejects the request at
    //       401 before any DB work or embedding generation.
    // WHEN: any agent-tools request from an unauthorized caller.
    // WHERE: the preHandler hook at the top of
    //        registerAgentToolRoutes (constant-time secret comparison).
    // WHY: belt-and-suspenders. The route would otherwise expose
    //      every tenant's knowledge base to anyone who guesses or
    //      enumerates tenant_id UUIDs.
    if (!dbAvailable) return;

    const noSecret = await app.inject({
      method: 'POST',
      url: '/agent-tools/policy-answer',
      payload: { tenant_id: tenantId, question: 'anything' },
    });
    expect(noSecret.statusCode).toBe(401);

    const wrongSecret = await app.inject({
      method: 'POST',
      url: '/agent-tools/policy-answer',
      headers: { 'x-agent-secret': 'wrong-secret-value' },
      payload: { tenant_id: tenantId, question: 'anything' },
    });
    expect(wrongSecret.statusCode).toBe(401);
  });
});
