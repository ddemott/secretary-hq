/**
 * WHO:   POST /agent-tools/record-ai-cost
 * WHAT:  Persists per-model AI usage from LiveKit session to ai_cost_events
 * WHEN:  Called by agent worker at end of every voice call
 * WHERE: src/routes/agentTools.ts (RecordAiCostSchema toolRoute)
 * WHY:   Owners need visibility into estimated AI spend per month without
 *        reading Stripe/OpenAI dashboards; costs computed server-side from
 *        known published rates so the agent doesn't need to know pricing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';

import { registerAgentToolRoutes } from '../../../src/routes/agentTools';

const TENANT_ID = 'aabbccdd-0000-4000-8000-000000000001';
const CALL_ID = 'livekit-call-abc123';
const SECRET = 'test-agent-secret';

interface MockQuery {
  text: string;
  params: unknown[];
}

function buildApp(opts: { queryResponses: Array<{ rows: unknown[]; rowCount?: number }> }): {
  app: FastifyInstance;
  queries: MockQuery[];
} {
  const queries: MockQuery[] = [];
  const responses = [...opts.queryResponses];

  const mockPool = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params: params || [] });
      return responses.shift() || { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(),
  };

  const mockClient = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params: params || [] });
      return responses.shift() || { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  } as unknown as PoolClient;

  const withTenantClient = async <T>(
    _tenantId: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> => fn(mockClient);

  const getEmbedding = async () => new Array(1536).fill(0);

  const app = Fastify({ logger: false });
  registerAgentToolRoutes(app, mockPool as never, withTenantClient, getEmbedding);
  return { app, queries };
}

function post(app: FastifyInstance, path: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'x-agent-secret': SECRET },
    payload,
  });
}

beforeEach(() => {
  process.env.AGENT_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.AGENT_SECRET;
  vi.restoreAllMocks();
});

describe('POST /agent-tools/record-ai-cost', () => {
  it('HAPPY: inserts LLM + STT + TTS rows and returns recorded count', async () => {
    // WHO: Agent worker POSTing session usage at end of voice call
    // WHAT: 3 model_usage entries → 3 INSERT rows, interruption_usage filtered out
    // WHEN: After session ends with real usage data from LiveKit ModelUsageCollector
    // WHERE: src/routes/agentTools.ts RecordAiCostSchema toolRoute
    // WHY: All 3 billable usage types must land in ai_cost_events for accurate cost roll-up
    const { app, queries } = buildApp({ queryResponses: [{ rows: [], rowCount: 3 }] });

    const res = await post(app, '/agent-tools/record-ai-cost', {
      tenant_id: TENANT_ID,
      call_id: CALL_ID,
      source: 'voice_call',
      model_usage: [
        {
          type: 'llm_usage',
          provider: 'openai',
          model: 'gpt-4o-mini',
          inputTokens: 1200,
          outputTokens: 300,
          charactersCount: 0,
          audioDurationMs: 0,
        },
        {
          type: 'stt_usage',
          provider: 'deepgram',
          model: 'nova-3',
          inputTokens: 0,
          outputTokens: 0,
          charactersCount: 0,
          audioDurationMs: 90000,
        },
        {
          type: 'tts_usage',
          provider: 'xai',
          model: 'grok-tts',
          inputTokens: 0,
          outputTokens: 0,
          charactersCount: 480,
          audioDurationMs: 8500,
        }, // historical xAI/Grok TTS usage row (pre full OpenAI removal 2026-06-25); estimator must still handle legacy provider values from DB
      ],
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; result: { recorded: number } }>();
    expect(body.success).toBe(true);
    expect(body.result.recorded).toBe(3);
    expect(queries).toHaveLength(1);
    expect(queries[0].text).toContain('INSERT INTO ai_cost_events');
    // 3 rows × 11 columns = 33 params
    expect(queries[0].params).toHaveLength(33);
  });

  it('HAPPY: filters out interruption_usage rows', async () => {
    // WHO: Agent sending usage including LiveKit's interruption-detection usage type
    // WHAT: interruption_usage skipped; only LLM row inserted
    // WHY: Interruption detection has no monetary cost to track
    const { app, queries } = buildApp({ queryResponses: [{ rows: [], rowCount: 1 }] });

    const res = await post(app, '/agent-tools/record-ai-cost', {
      tenant_id: TENANT_ID,
      call_id: CALL_ID,
      source: 'voice_call',
      model_usage: [
        {
          type: 'llm_usage',
          provider: 'openai',
          model: 'gpt-4o-mini',
          inputTokens: 500,
          outputTokens: 100,
          charactersCount: 0,
          audioDurationMs: 0,
        },
        {
          type: 'interruption_usage',
          provider: 'livekit',
          model: 'adaptive interruption',
          inputTokens: 0,
          outputTokens: 0,
          charactersCount: 0,
          audioDurationMs: 0,
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ result: { recorded: number } }>().result.recorded).toBe(1);
    // Only 1 row × 11 params (10 columns + turn_count)
    expect(queries[0].params).toHaveLength(11);
  });

  it('HAPPY: returns recorded:0 and skips DB when all usage is interruption type', async () => {
    // WHO: Call with only interruption-detection entries (no LLM/STT/TTS used)
    // WHAT: No INSERT executed; recorded:0 returned
    // WHY: Empty-model-usage edge case must not INSERT a zero row
    const { app, queries } = buildApp({ queryResponses: [] });

    const res = await post(app, '/agent-tools/record-ai-cost', {
      tenant_id: TENANT_ID,
      source: 'voice_call',
      model_usage: [
        {
          type: 'interruption_usage',
          provider: 'livekit',
          model: 'adaptive interruption',
          inputTokens: 0,
          outputTokens: 0,
          charactersCount: 0,
          audioDurationMs: 0,
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ result: { recorded: number } }>().result.recorded).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it('SAD: rejects missing tenant_id (Zod validation)', async () => {
    // WHO: Malformed agent request missing required tenant_id
    // WHAT: Zod rejects before any DB query
    // WHY: tenant_id is always required for RLS-correct INSERT
    const { app, queries } = buildApp({ queryResponses: [] });

    const res = await post(app, '/agent-tools/record-ai-cost', {
      source: 'voice_call',
      model_usage: [],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ success: boolean }>().success).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it('SAD: rejects invalid source value', async () => {
    // WHO: Request with unknown source type
    // WHAT: Zod enum rejects before DB call
    const { app, queries } = buildApp({ queryResponses: [] });

    const res = await post(app, '/agent-tools/record-ai-cost', {
      tenant_id: TENANT_ID,
      source: 'not_a_valid_source',
      model_usage: [],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ success: boolean }>().success).toBe(false);
    expect(queries).toHaveLength(0);
  });
});

/**
 * WHO:   the ROUTE that costs every voice call.
 * WHAT:  the real usage rows from 2026-08-13 calls SCL_3a8SkDKzxN4B and
 *        SCL_KLvqZ2JkaQFU, replayed against the pricing the route now uses.
 * WHEN:  prod recorded $0.00121 and $0.00191 for calls that really cost about
 *        $0.028 and $0.068 — 4.3% and 2.8% of actual.
 * WHERE: registerAiCostRoutes → estimateCost (src/services/aiCost.ts).
 * WHY:   pricing lived in TWO tables. tests/services/aiCost.test.ts pinned
 *        gpt-4.1-mini and Aura and passed the whole time, because it tested the
 *        table the route did NOT import. The route read a copy in schemas.ts
 *        that knew only gpt-4o-mini, so the production voice LLM and all TTS
 *        recorded $0. Testing the priced module proved nothing about the priced
 *        PATH — these go through the route.
 */
describe('record-ai-cost prices what the calls actually used (2026-08-13)', () => {
  const costsFor = async (
    usage: Array<Record<string, unknown>>
  ): Promise<number[]> => {
    const { app, queries } = buildApp({ queryResponses: [{ rows: [], rowCount: usage.length }] });
    const res = await post(app, '/agent-tools/record-ai-cost', {
      tenant_id: TENANT_ID,
      call_id: CALL_ID,
      source: 'voice_call',
      model_usage: usage,
    });
    expect(res.statusCode).toBe(200);
    // estimated_cost_usd is the 10th of 11 columns per row (turn_count is 11th).
    const params = queries[0].params;
    return usage.map((_, i) => Number(params[i * 11 + 9]));
  };

  const row = (over: Record<string, unknown>) => ({
    inputTokens: 0,
    outputTokens: 0,
    charactersCount: 0,
    audioDurationMs: 0,
    ...over,
  });

  it('prices the production voice LLM — 137,971 input tokens is not free', async () => {
    const [cost] = await costsFor([
      row({
        type: 'llm_usage',
        provider: 'api.openai.com',
        model: 'gpt-4.1-mini',
        inputTokens: 137_971,
        outputTokens: 444,
      }),
    ]);
    expect(cost).toBeGreaterThan(0.05);
    expect(cost).toBeLessThan(0.06);
  });

  it('prices Aura TTS by characters — the tts_usage branch used to record $0', async () => {
    const [cost] = await costsFor([
      row({
        type: 'tts_usage',
        provider: 'Deepgram',
        model: 'aura-asteria-en',
        charactersCount: 681,
        audioDurationMs: 38_347,
      }),
    ]);
    expect(cost).toBeCloseTo(681 * (0.015 / 1000), 8);
  });

  it("CALL2's whole ledger lands near the real bill, not 2.8% of it", async () => {
    const costs = await costsFor([
      row({
        type: 'llm_usage',
        provider: 'api.openai.com',
        model: 'gpt-4.1-mini',
        inputTokens: 137_971,
        outputTokens: 444,
      }),
      row({
        type: 'tts_usage',
        provider: 'Deepgram',
        model: 'aura-asteria-en',
        charactersCount: 681,
        audioDurationMs: 38_347,
      }),
      row({
        type: 'stt_usage',
        provider: 'Deepgram',
        model: 'nova-3',
        audioDurationMs: 25_400,
      }),
      row({
        type: 'llm_usage',
        provider: 'openai',
        model: 'gpt-4o-mini',
        inputTokens: 472,
        outputTokens: 29,
      }),
    ]);
    const total = costs.reduce((sum, c) => sum + c, 0);
    // Prod recorded $0.00191 for this call. Anything near that is the bug back.
    expect(total).toBeGreaterThan(0.06);
    expect(total).toBeLessThan(0.08);
    expect(costs.every((c) => c > 0)).toBe(true);
  });

  it('SAD: an unpriced model still records, at zero — and CI pins the model list', async () => {
    // Never throw on a live call for a pricing gap; the route logs a warning and
    // tests/services/aiCost.test.ts is where a new model must be added.
    const [cost] = await costsFor([
      row({
        type: 'llm_usage',
        provider: 'openai',
        model: 'gpt-9-imaginary',
        inputTokens: 1000,
      }),
    ]);
    expect(cost).toBe(0);
  });
});
