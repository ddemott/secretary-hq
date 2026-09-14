/**
 * What the website scan and the document upload SHARE.
 *
 * The two import routes look different at the edges — one fetches a URL, the
 * other reads an uploaded file; one has AI-discovered topics, the other has
 * deterministic **Q:/**A: markers — but between those edges they do the same
 * four things, and they did them in two copies. This module is the single copy.
 *
 * The duplication was not cosmetic. Every one of these carries a decision that
 * has to hold on BOTH paths or the product is inconsistent about something an
 * owner can see: which questions a scan targets, what an owner is billed, and
 * whether anything reaches the live knowledge base without review. Two copies
 * means two chances to answer those differently, and no signal when they do.
 */
import type { PoolClient } from 'pg';
import { resolveQuestions, type ResolvedQuestion } from '../../../shared/questionBank';
import { recordAiCostEvent } from '../aiCost';

type WithTenantClient = <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>;

/**
 * Cap on how many owner-authored questions feed an extraction prompt. Bounded
 * because prompt size is billed: a tenant with a long custom-question list would
 * otherwise scale the cost of every scan without ever choosing to.
 */
const MAX_CUSTOM_QUESTIONS = 50;

/**
 * The questions an import tries to answer: the shared static policy bank plus
 * THIS tenant's own custom questions, so a scan targets what the owner
 * specifically cares about and not only what the platform thought to ask.
 */
export async function resolveTenantQuestions(
  withTenantClient: WithTenantClient,
  tenantId: string
): Promise<ResolvedQuestion[]> {
  const rows = await withTenantClient(tenantId, (client) =>
    client.query<{ title: string }>(
      `SELECT title FROM tenant_docs
         WHERE tenant_id = $1 AND source = 'custom-question' AND title IS NOT NULL
         ORDER BY created_at DESC
         LIMIT ${MAX_CUSTOM_QUESTIONS}`,
      [tenantId]
    )
  );
  return resolveQuestions({ customs: rows.rows.map((r) => r.title) });
}

/**
 * The questions the E2E stub fabricates answers for: every resolved CUSTOM
 * question plus the first two from the bank.
 *
 * The customs are the point. A test asserting a stubbed import produced rows
 * proves only that the INSERT works; including the customs means the assertion
 * can follow an owner's own question all the way from the resolver into staging,
 * which is the part of the pipeline worth protecting.
 */
export function stubbedQuestionPicks(questions: ResolvedQuestion[]): ResolvedQuestion[] {
  return [
    ...questions.filter((q) => q.id === null),
    ...questions.filter((q) => q.id !== null).slice(0, 2),
  ];
}

/** True when the deterministic import stub is armed. Strict opt-in: the literal "1". */
export function isImportStubbed(): boolean {
  return process.env.KNOWLEDGE_IMPORT_E2E_STUB === '1';
}

/**
 * Bill the tenant for an extraction pass.
 *
 * Fire-and-forget on purpose: this is bookkeeping, and a failed ledger write
 * must never cost the owner the knowledge they just imported.
 *
 * No estimatedCostUsd is passed: recordAiCostEvent prices the row from the
 * authoritative PRICING table. See ./tokenEstimate for why no module here keeps
 * its own copy of a price.
 */
export function recordExtractionCost(
  withTenantClient: WithTenantClient,
  tenantId: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
): void {
  if (!usage || !tenantId) return;
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;
  withTenantClient(tenantId, (client) =>
    recordAiCostEvent(client, {
      tenantId,
      source: 'kb_ingestion',
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens,
      outputTokens,
    })
  ).catch(() => undefined);
}

export interface StagedSuggestion {
  question_id: string | null;
  question: string;
  answer: string;
  source_url: string;
  confidence: number | null;
}

/**
 * Stage extracted items for owner review.
 *
 * EVERYTHING enters as 'suggested', including items that matched a bank question
 * exactly. An import reads a website or a file the platform has never seen and
 * asks a model what it means; the owner is the only party who can say whether
 * the result is true of their business. Nothing here writes to the live KB —
 * that is the approve route's job, and keeping the two apart is what makes a bad
 * scan a review chore instead of an incident.
 *
 * Prior open (`status='suggested'`) rows for this tenant are marked `superseded`
 * first so a re-scan cannot pile up duplicate review chores. Confirmed/rejected
 * history is untouched. Website import may also call the on-client path inside
 * a wider stage+stamp transaction — keep that supersede rule in lockstep.
 */
export async function stageSuggestions(
  withTenantClient: WithTenantClient,
  tenantId: string,
  items: StagedSuggestion[]
): Promise<void> {
  await withTenantClient(tenantId, async (client) => {
    await client.query(
      `UPDATE knowledge_suggestion
          SET status = 'superseded', updated_at = now()
        WHERE tenant_id = $1 AND status = 'suggested'`,
      [tenantId]
    );
    if (items.length === 0) return;
    for (const item of items) {
      await client.query(
        `INSERT INTO knowledge_suggestion
           (tenant_id, question_id, question, answer, source_url, confidence, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'suggested')`,
        [tenantId, item.question_id, item.question, item.answer, item.source_url, item.confidence]
      );
    }
  });
}

/** Drop items the model returned with no usable answer — they carry no KB value. */
export function withUsableAnswer<T extends { answer: string | null }>(
  items: T[]
): (T & { answer: string })[] {
  return items.filter(
    (a): a is T & { answer: string } => a.answer != null && a.answer.trim().length > 0
  );
}
