/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

/**
 * Knowledge-base agent tool: RAG lookup over the tenant's embedded documents,
 * with a graceful spoken fallback whenever retrieval can't answer.
 */
import { GetPolicyAnswerSchema } from './schemas';
import { ok, toolRoute, pgErrorFields, type AgentToolDeps } from './helpers';
import { recordAiCostEvent } from '../../services/aiCost';
import { PROD_MATCH_COUNT, PROD_THRESHOLD } from '../../services/knowledge/retrievalParams';
import { errorsTotal } from '../../services/metrics';

export function registerKnowledgeRoutes({
  app,
  withTenantClient,
  getEmbedding,
  expandQueryForEmbedding,
}: AgentToolDeps): void {
  // get_company_policy_answer — normalize question, embed it, cosine
  // similarity over pgvector, return joined matches. Falls back to a
  // conversational no-match message and logs the gap for the owner.
  toolRoute(
    app,
    '/agent-tools/policy-answer',
    GetPolicyAnswerSchema,
    async (args, reply) => {
      // EXPAND the caller's query before embedding (the inverse of the
      // reductive normalization used at ingest). A terse question like
      // "what's your address" shares no vocabulary with a doc that says
      // "located", so under pure cosine it scored 0.31 — below the old 0.5
      // threshold and even below true out-of-scope questions once normalized.
      // Expansion adds synonyms ("address location where located directions")
      // to bridge the gap: measured lift 0.31 → 0.41 on address cases while
      // out-of-scope stays ≤0.25 (see shared/expandQueryForEmbedding.ts).
      let queryText = args.question;
      if (expandQueryForEmbedding) {
        try {
          queryText = await expandQueryForEmbedding(args.question, {
            context: 'customer phone inquiry',
          });
        } catch {
          // fall back to the raw question
        }
      }
      // Graceful "I can't answer that" line, reused for BOTH zero RAG hits and
      // an embedding/lookup failure. A caller must never hear a raw 500/JSON.
      const policyFallback =
        "I don't have specific information on that topic right now. I'd be happy to take a message so the owner can get back to you, or if there's anything else I can help with — like booking an appointment or answering questions about our services — I'm here for you.";

      // getEmbedding hits OpenAI — if it's down/slow/over-quota it THROWS, which
      // (unguarded) becomes an HTTP 500 the agent relays as technical JSON
      // ("Backend returned 500") instead of the warm fallback. Catch it and
      // degrade to the same graceful message the zero-hits path uses.
      let embedding: number[];
      try {
        embedding = await getEmbedding(queryText);
      } catch (err) {
        errorsTotal.inc({ event: 'policy_answer_embedding_failed' });
        app.log.error(
          {
            event: 'policy_answer_embedding_failed',
            tenant_id: args.tenant_id,
            ...pgErrorFields(err),
          },
          'policy-answer: embedding failed — degraded to graceful fallback (caller not left silent)'
        );
        return ok(reply, policyFallback);
      }

      // ~4 chars/token heuristic; embedding billed per input token (price mirrors aiCost PRICING).
      const embTokens = Math.ceil(queryText.length / 4);
      const embCost = embTokens * 0.02e-6;
      withTenantClient(args.tenant_id, (client) =>
        recordAiCostEvent(client, {
          tenantId: args.tenant_id,
          source: 'kb_query',
          provider: 'openai',
          model: 'text-embedding-3-small',
          inputTokens: embTokens,
          estimatedCostUsd: embCost,
        })
      ).catch(() => undefined);

      // Threshold + match count come from services/knowledge/retrievalParams —
      // the SAME module the /knowledge/explain debugger reads, so the numbers an
      // owner is shown cannot drift from the numbers a caller is answered with.
      // Also pull tenant_doc_id (the RPC returns it) so we can attribute each
      // chunk to its source document for caller-facing citations.
      const matches = await withTenantClient(args.tenant_id, (client) =>
        client.query<{ tenant_doc_id: string; content: string; similarity: number }>(
          'SELECT tenant_doc_id, content, similarity FROM search_tenant_docs_normalized($1, $2::vector, $3, $4)',
          [args.tenant_id, JSON.stringify(embedding), PROD_THRESHOLD, PROD_MATCH_COUNT]
        )
      );

      if (matches.rows.length === 0) {
        // Log the gap so the owner can see what callers are asking about.
        // Fire-and-forget; don't fail the call on logging errors.
        withTenantClient(args.tenant_id, (client) =>
          client.query(
            `INSERT INTO unanswered_questions (tenant_id, question, call_id)
           VALUES ($1, $2, $3)`,
            [args.tenant_id, args.question, args.call_id ?? null]
          )
        ).catch(() => undefined);
        return ok(reply, policyFallback);
      }

      // Resolve the source title of each matched chunk so the agent can cite it
      // ("according to our cancellation policy…"). Best-effort: a failed/empty
      // lookup just yields un-attributed context, never a failed answer.
      const docIds = matches.rows.map((m) => m.tenant_doc_id).filter(Boolean);
      let titleById = new Map<string, string>();
      if (docIds.length > 0) {
        try {
          const titlesRes = await withTenantClient(args.tenant_id, (client) =>
            client.query<{ tenant_doc_id: string; title: string | null }>(
              // ANY($2::uuid[]) — without the cast Postgres compares uuid against
              // a text[] and errors (operator does not exist: uuid = text), which
              // the catch below would swallow → citations would silently never appear.
              'SELECT tenant_doc_id, title FROM tenant_docs WHERE tenant_id = $1 AND tenant_doc_id = ANY($2::uuid[])',
              [args.tenant_id, docIds]
            )
          );
          titleById = new Map(
            titlesRes.rows.filter((r) => r.title).map((r) => [r.tenant_doc_id, r.title as string])
          );
        } catch {
          // citation lookup is non-critical — fall back to un-attributed context
        }
      }

      // Prefix each chunk with its source so the LLM can attribute the answer.
      const context = matches.rows
        .map((m) => {
          const title = titleById.get(m.tenant_doc_id);
          return title ? `[From "${title}"]\n${m.content}` : m.content;
        })
        .join('\n\n---\n\n');
      return ok(reply, context);
    },
    'Failed to answer policy question'
  );
}
