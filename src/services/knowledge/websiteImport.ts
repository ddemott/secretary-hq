/**
 * Shared website → knowledge import.
 *
 * Both the owner-driven route (`POST /knowledge/import-website`) and the
 * background re-scan scheduler run the same pipeline: resolve questions →
 * scrape → LLM extract → stage suggestions for owner review → stamp the
 * tenant's scan URL + last_scanned timestamp.
 *
 * WHY one function. The route used to own the whole body. A scheduler that
 * reimplemented scrape/extract/stage would drift on the one product rule that
 * must never fork: nothing reaches the live KB without owner review. Staging
 * here is deliberate — a scheduled re-scan produces suggestions, not silent
 * overwrites of approved answers.
 *
 * The stamp (`website_scan_url` / `website_last_scanned_at`) is what makes
 * re-scan possible at all: without a durable URL + freshness marker the
 * worker has no candidate set and no notion of "stale".
 */

import type { PoolClient } from 'pg';
import { fetchAndExtractSiteText, extractAnswersWithLLM } from './siteScrape.js';
import {
  isImportStubbed,
  recordExtractionCost,
  resolveTenantQuestions,
  stageSuggestions,
  stubbedQuestionPicks,
  withUsableAnswer,
} from './importStaging.js';

type WithTenantClient = <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>;

export type WebsiteImportExtract = {
  answers: Array<{
    questionId: string | null;
    question: string;
    answer: string | null;
    sourceUrl?: string;
    confidence?: number;
  }>;
  discovered: Array<{
    question: string;
    answer: string;
    sourceUrl?: string;
    confidence?: number;
  }>;
};

export type WebsiteImportSuccess = {
  ok: true;
  extract: WebsiteImportExtract;
  confirmed: number;
  suggestions: number;
};

export type WebsiteImportFailure = {
  ok: false;
  /** HTTP-ish status the route can forward; worker logs it. */
  status: 400 | 500;
  error: string;
};

export type WebsiteImportResult = WebsiteImportSuccess | WebsiteImportFailure;

/**
 * Run one website knowledge import for a tenant.
 *
 * On success: stages suggestions AND stamps tenants.website_scan_url +
 * website_last_scanned_at. On failure: leaves the stamp alone so a bad
 * re-scan does not push the next attempt 30 days out.
 *
 * Does NOT rate-limit — the route owns the per-tenant bucket for owner
 * clicks; the scheduler owns its own batch/stale caps. Mixing them would
 * let a scheduled pass burn the owner's onboarding burst.
 */
export async function importWebsiteKnowledge(
  withTenantClient: WithTenantClient,
  tenantId: string,
  url: string,
  openAiKey: string = process.env.OPENAI_API_KEY || ''
): Promise<WebsiteImportResult> {
  const questions = await resolveTenantQuestions(withTenantClient, tenantId);

  let extract: WebsiteImportExtract;
  if (isImportStubbed()) {
    extract = {
      answers: stubbedQuestionPicks(questions).map((q) => ({
        questionId: q.id,
        question: q.question,
        answer: `Stubbed answer for: ${q.question}`,
        sourceUrl: url,
        confidence: 0.9,
      })),
      discovered: [
        {
          question: 'Stubbed discovered topic?',
          answer: 'Stubbed discovered answer.',
          sourceUrl: url,
          confidence: 0.5,
        },
      ],
    };
  } else {
    const siteText = await fetchAndExtractSiteText(url);
    if (!siteText.success) {
      return { ok: false, status: 400, error: siteText.error };
    }
    const llm = await extractAnswersWithLLM(siteText.text, questions, url, openAiKey);
    if (!llm.success) {
      return { ok: false, status: 500, error: llm.error };
    }
    extract = { answers: llm.answers, discovered: llm.discovered };
    recordExtractionCost(withTenantClient, tenantId, llm.usage);
  }

  const matchedItems = withUsableAnswer(extract.answers).map((a) => ({
    question_id: a.questionId || null,
    question: a.question || '',
    answer: a.answer,
    source_url: a.sourceUrl || url,
    confidence: a.confidence ?? null,
  }));
  const suggestedItems = (extract.discovered || []).map((d) => ({
    question_id: null,
    question: d.question || '',
    answer: d.answer || '',
    source_url: d.sourceUrl || url,
    confidence: d.confidence ?? null,
  }));

  await stageSuggestions(withTenantClient, tenantId, [...matchedItems, ...suggestedItems]);
  await stampWebsiteScan(withTenantClient, tenantId, url);

  return {
    ok: true,
    extract,
    confirmed: matchedItems.length,
    suggestions: suggestedItems.length,
  };
}

/**
 * Persist the scan URL + freshness marker after a successful import.
 * Exported for tests that assert the stamp without running a full scrape.
 */
export async function stampWebsiteScan(
  withTenantClient: WithTenantClient,
  tenantId: string,
  url: string
): Promise<void> {
  await withTenantClient(tenantId, (client) =>
    client.query(
      `UPDATE tenants
          SET website_scan_url = $1,
              website_last_scanned_at = NOW()
        WHERE tenant_id = $2`,
      [url, tenantId]
    )
  );
}
