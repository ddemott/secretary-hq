import type { AppFastifyInstance } from '../types/fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  withHandler,
  logEvent,
  requireTenantId,
  requireOwnerRole,
  type AppRequest,
} from '../middleware/fastify-middleware';
import { assertRowAffected, requireValidUUID } from './routeHelpers';
import {
  getFileExtension,
  isAllowedExtension,
  extractFileContent,
  splitIntoChunks,
  prepareQADocument,
  ALLOWED_EXTENSIONS,
} from '../services/knowledgeIngestion';
import { parseMarkerQuestions } from '../../shared/markerQuestions';
import { extractAnswersWithLLM } from '../services/knowledge/siteScrape';
import { ingestChunks } from '../services/knowledge/ingestChunks';
import { explainAnswer } from '../services/knowledge/answerExplainer';
import {
  isImportStubbed,
  recordExtractionCost,
  resolveTenantQuestions,
  stageSuggestions,
  stubbedQuestionPicks,
  withUsableAnswer,
} from '../services/knowledge/importStaging';
import { importWebsiteKnowledge } from '../services/knowledge/websiteImport';
import {
  approveSuggestion,
  rejectSuggestion,
  recordEmbeddingCost,
} from '../services/knowledge/suggestionReview';
import { scanRateLimiter } from '../services/scanRateLimit';
import { SUPER_ADMIN_TENANT_ID } from '../constants';

const knowledgeEntrySchema = z.object({
  question: z.string().min(1, 'question is required'),
  answer: z.string().min(10, 'answer must be at least 10 characters'),
  category: z.string().optional(),
  source: z.string().optional().default('policy-questionnaire'),
});

const websiteImportSchema = z.object({
  url: z.string().url('valid URL required'),
});

const explainSchema = z.object({
  question: z.string().min(1, 'question is required').max(1000),
});

export function registerKnowledgeRoutes(
  app: AppFastifyInstance,
  _pool: Pool,
  getEmbedding: (text: string) => Promise<number[]>,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>,
  normalizeForEmbedding?: (text: string, options?: { context?: string }) => Promise<string>,
  /**
   * The QUERY-side transform, distinct from normalizeForEmbedding above and not
   * interchangeable with it. Normalization is reductive and runs at INGEST;
   * expansion is additive (synonyms) and runs on the caller's question. The
   * answer debugger needs this one, because scoring a question production never
   * embedded is how a debugger lies. See services/knowledge/answerExplainer.ts.
   */
  expandQueryForEmbedding?: (text: string, options?: { context?: string }) => Promise<string>
) {
  app.get(
    '/knowledge',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `SELECT tenant_doc_id, title, content, source, created_at,
                  -- A starter copied from the business's template is not read to
                  -- callers until the owner saves it (saving embeds it).
                  (source = 'template' AND embedding IS NULL) AS is_unreviewed_starter
             FROM tenant_docs WHERE tenant_id = $1 ORDER BY created_at DESC`,
          [tenantId]
        );
      });
      return reply.send(res.rows);
    }, 'Failed to fetch knowledge base')
  );

  app.delete(
    '/knowledge/:id',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): the live voice agent reads
      // policy answers from this KB on every call.
      if (!requireOwnerRole(req, reply)) return;
      const { id } = req.params as { id: string };
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          'DELETE FROM tenant_docs WHERE tenant_doc_id = $1 AND tenant_id = $2 RETURNING tenant_doc_id',
          [id, tenantId]
        );
      });
      if (!assertRowAffected(res, reply, 'Knowledge entry')) return;

      logEvent(req, 'knowledge_entry_deleted', { entryId: id });
      return reply.send({ success: true });
    }, 'Failed to delete entry')
  );

  app.post(
    '/knowledge/ingest',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): the live voice agent reads
      // policy answers from this KB on every call.
      if (!requireOwnerRole(req, reply)) return;
      const data = await req.file();
      if (!data) return reply.status(400).send({ success: false, error: 'No file uploaded' });

      // Fastify multipart: text fields arrive on `data.fields[key]` shaped
      // as `{ value: string, type: 'field' }` (file fields have `type: 'file'`).
      // Naming the optional `value` slot is narrower than bare `any` while
      // still accepting the union shape the parser produces.
      const tenantId = (data.fields.tenant_id as { value?: string } | undefined)?.value;
      if (!tenantId)
        return reply.status(400).send({ success: false, error: 'tenant_id is required' });

      const filename = data.filename;
      const ext = getFileExtension(filename);
      if (!isAllowedExtension(ext)) {
        return reply.status(400).send({
          success: false,
          error: `Unsupported file type "${ext}". Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
        });
      }

      const buffer = await data.toBuffer();
      const extracted = await extractFileContent(buffer, filename);
      if (!extracted.success) {
        return reply.status(400).send({ success: false, error: extracted.error });
      }

      const chunked = splitIntoChunks(extracted.text);
      if (!chunked.success) {
        return reply.status(400).send({ success: false, error: chunked.error });
      }
      const chunks = chunked.chunks;

      await withTenantClient(tenantId, (client) =>
        ingestChunks(client, tenantId, chunks, filename, { getEmbedding, normalizeForEmbedding })
      );

      logEvent(req, 'knowledge_ingested', { filename, chunksIngested: chunks.length });
      return reply.send({ success: true, chunksIngested: chunks.length });
    }, 'Failed to ingest knowledge')
  );

  app.post(
    '/knowledge/add',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): the live voice agent reads
      // policy answers from this KB on every call.
      if (!requireOwnerRole(req, reply)) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = knowledgeEntrySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }

      const { question, answer, category, source } = parsed.data;
      const { combined, normalizedText, embedding } = await prepareQADocument(
        question,
        answer,
        getEmbedding,
        normalizeForEmbedding
      );

      withTenantClient(tenantId, (client) =>
        recordEmbeddingCost(client, tenantId, normalizedText)
      ).catch(() => undefined);

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query<{ tenant_doc_id: string }>(
          'INSERT INTO tenant_docs (tenant_id, title, section, content, source, normalized_text, embedding) VALUES ($1, $2, $3, $4, $5, $6, $7::vector) RETURNING tenant_doc_id',
          [
            tenantId,
            question,
            category || null,
            combined,
            source,
            normalizedText,
            JSON.stringify(embedding),
          ]
        );
      });

      const tenantDocId = res.rows[0].tenant_doc_id;
      logEvent(req, 'knowledge_entry_added', { tenant_doc_id: tenantDocId, source });
      return reply.send({ success: true, tenant_doc_id: tenantDocId });
    }, 'Failed to add knowledge entry')
  );

  app.put(
    '/knowledge/:id',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): the live voice agent reads
      // policy answers from this KB on every call.
      if (!requireOwnerRole(req, reply)) return;
      const { id } = req.params as { id: string };
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = knowledgeEntrySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }

      const { question, answer, category, source } = parsed.data;
      const { combined, normalizedText, embedding } = await prepareQADocument(
        question,
        answer,
        getEmbedding,
        normalizeForEmbedding
      );

      withTenantClient(tenantId, (client) =>
        recordEmbeddingCost(client, tenantId, normalizedText)
      ).catch(() => undefined);

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          'UPDATE tenant_docs SET title = $1, section = $2, content = $3, source = $4, normalized_text = $5, embedding = $6::vector WHERE tenant_doc_id = $7 AND tenant_id = $8 RETURNING tenant_doc_id',
          [
            question,
            category || null,
            combined,
            source,
            normalizedText,
            JSON.stringify(embedding),
            id,
            tenantId,
          ]
        );
      });
      if (!assertRowAffected(res, reply, 'Knowledge entry')) return;

      logEvent(req, 'knowledge_entry_updated', { id, source });
      return reply.send({ success: true });
    }, 'Failed to update knowledge entry')
  );

  // -----------------------------------------------------------------------
  // Unanswered Questions (KB gap tracking)
  // -----------------------------------------------------------------------

  /** GET /knowledge/unanswered — list unanswered questions for the tenant */
  app.get(
    '/knowledge/unanswered',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `SELECT unanswered_question_id, question, caller_phone, call_id, caller_message, owner_notified, resolved, created_at
         FROM unanswered_questions
         WHERE tenant_id = $1 AND resolved = false
         ORDER BY created_at DESC
         LIMIT 100`,
          [tenantId]
        );
      });

      return reply.send({ success: true, questions: res.rows });
    }, 'Failed to fetch unanswered questions')
  );

  /** PATCH /knowledge/unanswered/:id/resolve — mark a question as resolved */
  app.patch(
    '/knowledge/unanswered/:id/resolve',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): the live voice agent reads
      // policy answers from this KB on every call.
      if (!requireOwnerRole(req, reply)) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      const { id } = req.params as { id: string };

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `UPDATE unanswered_questions SET resolved = true WHERE unanswered_question_id = $1 AND tenant_id = $2 RETURNING unanswered_question_id`,
          [id, tenantId]
        );
      });
      if (!assertRowAffected(res, reply, 'Unanswered question')) return;

      logEvent(req, 'unanswered_question_resolved', { questionId: id });
      return reply.send({ success: true });
    }, 'Failed to resolve unanswered question')
  );

  // POST /knowledge/import-website — website scan + LLM extract (item 10)
  app.post(
    '/knowledge/import-website',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): the live voice agent reads
      // policy answers from this KB on every call.
      if (!requireOwnerRole(req, reply)) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = websiteImportSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Invalid URL', details: parsed.error.issues });
      }
      const { url } = parsed.data;

      // Per-tenant guardrail on the expensive scan (external multi-page fetch +
      // OpenAI extraction). Rejects with 429 once the tenant's bucket is dry so
      // one tenant can't burn OpenAI budget or hammer external sites through us.
      // Skipped in the E2E stub path (deterministic, zero external cost).
      if (!isImportStubbed() && !scanRateLimiter.tryAcquire(tenantId)) {
        logEvent(req, 'website_scan_rate_limited', { tenantId });
        return reply.status(429).send({
          success: false,
          error: 'Website scan limit reached. Please wait a bit before scanning again.',
        });
      }

      // Shared pipeline with the re-scan scheduler (scrape → extract → stage →
      // stamp last_scanned). Nothing here auto-publishes to the live KB.
      const result = await importWebsiteKnowledge(withTenantClient, tenantId, url);
      if (!result.ok) {
        return reply.status(result.status).send({ success: false, error: result.error });
      }

      // `confirmed` here is the COUNT of bank/custom-matched items (response-field
      // name kept for API/dashboard compatibility). They are staged as 'suggested'
      // like everything else — nothing is auto-confirmed into the live KB anymore.
      const { confirmed, suggestions, extract } = result;

      logEvent(req, 'website_knowledge_import', { url, confirmed, suggestions, tenantId });
      return reply.send({
        success: true,
        extracted: extract.answers,
        discovered: extract.discovered,
        confirmed,
        suggestions,
      });
    }, 'Failed to import from website')
  );
  app.post(
    '/knowledge/import-document',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): the live voice agent reads
      // policy answers from this KB on every call.
      if (!requireOwnerRole(req, reply)) return;
      const data = await req.file();
      if (!data) return reply.status(400).send({ success: false, error: 'No file uploaded' });

      // SECURITY: tenantMiddleware validates query/body tenant_id against the JWT,
      // but it does NOT inspect multipart fields. So the tenant here MUST come from
      // the authenticated session, not the uploaded form field — otherwise a caller
      // with a valid JWT for tenant A could set tenant_id=B in the body and stage
      // suggestions into tenant B (RLS would honor the passed context). A non-super
      // caller may only import into their own tenant; a mismatched field is rejected.
      const fieldTenant = (data.fields.tenant_id as { value?: string } | undefined)?.value;
      const authTenant = req.auth?.tenant_id;
      if (!authTenant) return reply.status(401).send({ success: false, error: 'Unauthorized' });
      const isSuperAdmin = authTenant === SUPER_ADMIN_TENANT_ID;
      if (!isSuperAdmin && fieldTenant && fieldTenant !== authTenant) {
        return reply
          .status(403)
          .send({ success: false, error: 'Cross-tenant import is not allowed' });
      }
      const tenantId = isSuperAdmin ? fieldTenant || authTenant : authTenant;

      const filename = data.filename;
      const ext = getFileExtension(filename);
      if (!isAllowedExtension(ext)) {
        return reply.status(400).send({
          success: false,
          error: `Unsupported file type "${ext}". Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
        });
      }

      // Per-tenant guardrail on the expensive AI pass (skipped in the deterministic
      // E2E stub). Same limiter the website scan uses.
      if (!isImportStubbed() && !scanRateLimiter.tryAcquire(tenantId)) {
        logEvent(req, 'document_import_rate_limited', { tenantId });
        return reply.status(429).send({
          success: false,
          error: 'Import limit reached. Please wait a bit before uploading again.',
        });
      }

      const buffer = await data.toBuffer();
      const extracted = await extractFileContent(buffer, filename);
      if (!extracted.success) {
        return reply.status(400).send({ success: false, error: extracted.error });
      }

      // Deterministic custom Q&A + leftover prose.
      const { custom, malformed, prose } = parseMarkerQuestions(extracted.text);
      const questions = await resolveTenantQuestions(withTenantClient, tenantId);
      const sourceTag = `document:${filename}`;

      // Standard answers from the prose. Stub → deterministic; else real OpenAI.
      // The custom (marker) questions NEVER depend on the model — they come through
      // even if the AI pass fails/degrades (spec §5 resilience win).
      let standardAnswers: Array<{
        questionId: string | null;
        question: string;
        answer: string | null;
      }> = [];
      if (isImportStubbed()) {
        standardAnswers = stubbedQuestionPicks(questions).map((q) => ({
          questionId: q.id,
          question: q.question,
          answer: `Stubbed answer for: ${q.question}`,
        }));
      } else if (prose.trim().length > 0) {
        const llm = await extractAnswersWithLLM(
          prose,
          questions,
          sourceTag,
          process.env.OPENAI_API_KEY || ''
        );
        if (llm.success) {
          standardAnswers = llm.answers.map((a) => ({
            questionId: a.questionId,
            question: a.question,
            answer: a.answer,
          }));
          recordExtractionCost(withTenantClient, tenantId, llm.usage);
        }
        // AI failure degrades gracefully: standardAnswers stays [] but custom still flows.
      }

      const standardItems = withUsableAnswer(standardAnswers).map((a) => ({
        question_id: a.questionId || null,
        question: a.question || '',
        answer: a.answer,
        source_url: sourceTag,
        confidence: null,
      }));
      const customItems = custom.map((c) => ({
        question_id: null,
        question: c.question,
        answer: c.answer,
        source_url: sourceTag,
        confidence: null,
      }));
      const allItems = [...standardItems, ...customItems];

      await stageSuggestions(withTenantClient, tenantId, allItems);

      logEvent(req, 'document_knowledge_import', {
        tenantId,
        filename,
        standard: standardItems.length,
        custom: customItems.length,
        malformed: malformed.length,
      });

      return reply.send({
        success: true,
        standard_answers: standardAnswers,
        custom_questions: custom,
        malformed,
        confirmed: allItems.length,
      });
    }, 'Failed to import from document')
  );
  app.get(
    '/knowledge/suggestions',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `SELECT id, question_id, question, answer, source_url, confidence, status, created_at
           FROM knowledge_suggestion
           WHERE tenant_id = $1 AND status = 'suggested'
           ORDER BY created_at DESC
           LIMIT 100`,
          [tenantId]
        );
      });

      return reply.send({ success: true, suggestions: res.rows });
    }, 'Failed to fetch knowledge suggestions')
  );

  /** PATCH /knowledge/suggestions/:id — approve (→ ingest) or reject */
  app.patch(
    '/knowledge/suggestions/:id',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): the live voice agent reads
      // policy answers from this KB on every call.
      if (!requireOwnerRole(req, reply)) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      const { id } = req.params as { id: string };
      if (!requireValidUUID(id, reply, 'Suggestion ID')) return;

      const parsed = z.object({ status: z.enum(['confirmed', 'rejected']) }).safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'status must be confirmed or rejected' });
      }
      const { status } = parsed.data;

      // Fetch the suggestion first (RLS-scoped, status guard prevents double-review)
      const fetchRes = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `SELECT question, answer FROM knowledge_suggestion
           WHERE id = $1 AND tenant_id = $2 AND status = 'suggested'`,
          [id, tenantId]
        );
      });
      if (fetchRes.rows.length === 0) {
        return reply
          .status(404)
          .send({ success: false, error: 'Suggestion not found or already reviewed' });
      }

      const { question, answer } = fetchRes.rows[0] as { question: string; answer: string };

      if (status === 'confirmed') {
        // Both writes happen in ONE transaction inside approveSuggestion() so a
        // partial failure can't leave a doc ingested with the suggestion still
        // 'suggested' (owner approves twice, agent answers from two copies) or
        // the reverse (owner believes the agent learned something it did not).
        const doc = await prepareQADocument(question, answer, getEmbedding, normalizeForEmbedding);

        // Ledger write is fire-and-forget and deliberately OUTSIDE the
        // transaction: bookkeeping must never be able to roll back knowledge.
        withTenantClient(tenantId, (client) =>
          recordEmbeddingCost(client, tenantId, doc.normalizedText)
        ).catch(() => undefined);

        await withTenantClient(tenantId, (client) =>
          approveSuggestion(client, { tenantId, suggestionId: id, question, doc })
        );
        logEvent(req, 'knowledge_suggestion_approved', { suggestionId: id, tenantId });
      } else {
        await withTenantClient(tenantId, (client) => rejectSuggestion(client, tenantId, id));
        logEvent(req, 'knowledge_suggestion_rejected', { suggestionId: id, tenantId });
      }

      return reply.send({ success: true });
    }, 'Failed to update knowledge suggestion')
  );

  // POST /knowledge/explain — "explain this answer" RAG debugger.
  // Runs the SAME retrieval the voice agent uses (search_tenant_docs_normalized
  // over this tenant's KB embeddings) for a given question, and returns the
  // ranked chunks + similarity scores so an owner can SEE why the AI answered a
  // certain way: which chunks matched, how strongly, and which would have been
  // fed to the model in production (top-N above the threshold).
  app.post(
    '/knowledge/explain',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      // Owner-only: this is an admin/debug surface over the whole KB.
      if (!requireOwnerRole(req, reply)) return;

      const parsed = explainSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const { question } = parsed.data;

      const explained = await explainAnswer(
        { getEmbedding, withTenantClient, prepareQuery: expandQueryForEmbedding },
        tenantId,
        question
      );

      logEvent(req, 'knowledge_answer_explained', {
        tenantId,
        candidates: explained.candidates.length,
        usedInProduction: explained.candidates.filter((c) => c.used_in_production).length,
      });

      return reply.send({ success: true, question, ...explained });
    }, 'Failed to explain answer')
  );
}
