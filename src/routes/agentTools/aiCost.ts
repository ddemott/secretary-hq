/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

/**
 * AI cost recording.
 *
 * Called by the agent worker at the end of every voice call with the
 * session's model usage (LLM tokens, STT audio, TTS characters).
 * Also callable from backend KB routes for ingestion/query costs.
 * Computes estimated_cost_usd using known published rates; TTS (historical xAI rows may exist)
 * pricing is not public so that row gets 0 (chars stored for later).
 *
 * turn_count is denormalized onto every row inserted for a call (repeated
 * across its LLM/STT/TTS usage rows) rather than living only in
 * voice_sessions — a call's cost and its turn count need to answer the same
 * question ("what did an N-turn call cost?") from one table without a join,
 * and it's a single small integer, not something worth a schema migration
 * to avoid repeating. Only ever set for source='voice_call'.
 */
import { RecordAiCostSchema } from './schemas';
import { estimateCost } from '../../services/aiCost';
import { ok, toolRoute, type AgentToolDeps } from './helpers';

export function registerAiCostRoutes({ app, withTenantClient }: AgentToolDeps): void {
  toolRoute(
    app,
    '/agent-tools/record-ai-cost',
    RecordAiCostSchema,
    async (args, reply) => {
      const rows = args.model_usage.filter((u) => u.type !== 'interruption_usage');
      if (rows.length === 0) return ok(reply, { recorded: 0 });

      const values: unknown[] = [];
      const placeholders: string[] = [];
      let idx = 1;

      for (const u of rows) {
        // ONE pricing table (src/services/aiCost.ts). It keys the audio branches
        // off the MODEL name, so Aura's char-priced TTS is costed too — the old
        // `type === 'stt_usage'` check meant every TTS row recorded $0 no matter
        // how many characters it synthesised.
        const estimatedCost = estimateCost(u);
        // A model with no price recorded $0 for a month and the ledger looked
        // maintained. Usage with no cost is now a WARNING with the model named,
        // so the next unpriced model is visible the day it ships rather than at
        // the next postmortem. (CI also fails on it — see aiCost.test.ts.)
        if (estimatedCost === 0 && (u.inputTokens > 0 || u.charactersCount > 0)) {
          reply.request.log.warn(
            {
              event: 'ai_cost_model_unpriced',
              model: u.model,
              provider: u.provider,
              input_tokens: u.inputTokens,
              characters_count: u.charactersCount,
            },
            'ai_cost_model_unpriced'
          );
        }

        placeholders.push(
          `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
        );
        values.push(
          args.tenant_id,
          args.call_id ?? null,
          args.source,
          u.provider,
          u.model,
          u.inputTokens,
          u.outputTokens,
          u.charactersCount,
          Math.round(u.audioDurationMs),
          estimatedCost.toFixed(8),
          args.turn_count ?? null
        );
      }

      await withTenantClient(args.tenant_id, (client) =>
        client.query(
          `INSERT INTO ai_cost_events
             (tenant_id, call_id, source, provider, model,
              input_tokens, output_tokens, characters_count, audio_duration_ms, estimated_cost_usd,
              turn_count)
           VALUES ${placeholders.join(', ')}`,
          values
        )
      );

      return ok(reply, { recorded: rows.length });
    },
    'Failed to record AI cost'
  );
}
