/**
 * A call the outage guard ended must SAY SO in the stored record, and must raise
 * an alertable metric — against real Postgres.
 *
 * THE CALL (2026-09-18 1:28 PM CT, SCL_MFD3o5QRKQJB): the prod OpenAI balance was
 * empty. The agent told the caller "technical trouble" and hung up 39 seconds in.
 * The stored voice_sessions row for it was `status=completed, outcome=NULL,
 * metadata={}, summary=NULL` — byte-for-byte a clean short hang-up. Nothing in
 * the database, and no metric, said an LLM outage had just cost a caller (a
 * recruiter asking to hire the owner). Working out what happened took reading the
 * Railway log by hand.
 *
 * 5W:
 *   WHO   — the owner reviewing calls / whoever watches `errors_total`
 *   WHAT  — voice-session-end persists metadata.llm_outage + bumps errors_total
 *   WHEN  — the finalize pass of a call the outage guard ended
 *   WHERE — src/routes/agentTools/session.ts over the real end_voice_session RPC
 *   WHY   — an empty wallet is the one failure only a human with a credit card can
 *           clear; it must page, not wait for someone to make a test call.
 *
 * Real DB because the row is what the owner reads, and because the enrich pass
 * (which omits llm_outage) must MERGE into metadata, not replace it — a mock has
 * no jsonb `||` to get wrong.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Client, PoolClient } from 'pg';
import { registerAgentToolRoutes } from '../../src/routes/agentTools';
import { registry } from '../../src/services/metrics';
import { getRootClient, createTenant, deleteTenantWithDeadlockRetry, skipIfDbDown } from '../utils';

const SECRET = 'test-agent-secret';

let db: Client;
let dbAvailable = false;
let tenantId: string;
let app: FastifyInstance;

function counterValue(metric: string, labels: Record<string, string>): number {
  const line = registry
    .expose()
    .split('\n')
    .find(
      (l) =>
        l.startsWith(`${metric}{`) &&
        Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`))
    );
  if (!line) return 0;
  const n = Number(line.trim().split(/\s+/).pop());
  return Number.isFinite(n) ? n : 0;
}

const post = (path: string, payload: unknown) =>
  app.inject({ method: 'POST', url: path, headers: { 'x-agent-secret': SECRET }, payload });

async function startCall(callId: string): Promise<void> {
  await db.query('SELECT start_voice_session($1, $2, $3)', [tenantId, callId, '+12624970099']);
}

async function metadataOf(callId: string): Promise<Record<string, unknown>> {
  const r = await db.query<{ metadata: Record<string, unknown> }>(
    'SELECT metadata FROM voice_sessions WHERE tenant_id = $1 AND call_id = $2',
    [tenantId, callId]
  );
  return r.rows[0].metadata;
}

beforeAll(async () => {
  try {
    db = await getRootClient();
    await db.query('SELECT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }
  process.env.AGENT_SECRET = SECRET;
  tenantId = await createTenant(db, 'Outage Co', 'automotive', 'America/Chicago');
  app = Fastify({ logger: false });
  const withTenantClient = async <T>(
    _tenantId: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> => fn(db as unknown as PoolClient);
  registerAgentToolRoutes(app, {} as never, withTenantClient, async () => new Array(1536).fill(0));
});

afterAll(async () => {
  if (!dbAvailable) return;
  delete process.env.AGENT_SECRET;
  await deleteTenantWithDeadlockRetry(db, tenantId);
  await db.end();
});

beforeEach(() => {
  registry.clearAll();
});

describe('voice-session-end llm_outage', () => {
  it('SAD: an empty-balance outage is persisted on the row and counted as llm_quota_exhausted', async (ctx) => {
    skipIfDbDown(ctx, () => dbAvailable);
    const callId = 'outage-quota-1';
    await startCall(callId);

    const res = await post('/agent-tools/voice-session-end', {
      tenant_id: tenantId,
      call_id: callId,
      duration_seconds: 39,
      transcript: 'Caller [0:24]: I would like to talk to Dale about hiring him for a job.',
      llm_outage: {
        cause: 'quota_exhausted',
        status_code: 429,
        message: '429 You have no credits remaining.',
      },
    });
    expect(res.statusCode).toBe(200);

    expect(await metadataOf(callId)).toMatchObject({
      llm_outage: {
        cause: 'quota_exhausted',
        status_code: 429,
        message: '429 You have no credits remaining.',
      },
    });
    expect(counterValue('errors_total', { event: 'llm_quota_exhausted' })).toBe(1);
    expect(counterValue('errors_total', { event: 'voice_llm_outage' })).toBe(0);
  });

  it('SAD: any other outage cause counts under voice_llm_outage, not the wallet alarm', async (ctx) => {
    skipIfDbDown(ctx, () => dbAvailable);
    const callId = 'outage-other-1';
    await startCall(callId);
    await post('/agent-tools/voice-session-end', {
      tenant_id: tenantId,
      call_id: callId,
      duration_seconds: 20,
      transcript: 'Caller [0:05]: hi',
      llm_outage: { cause: 'provider_error', status_code: 503 },
    });
    expect(counterValue('errors_total', { event: 'voice_llm_outage' })).toBe(1);
    expect(counterValue('errors_total', { event: 'llm_quota_exhausted' })).toBe(0);
  });

  it('SAD: the enrich pass (which omits llm_outage) does not erase it, and does not double-count', async (ctx) => {
    skipIfDbDown(ctx, () => dbAvailable);
    // The agent posts voice-session-end TWICE per call. The second carries no
    // llm_outage; it must MERGE-preserve the first's, and end_voice_session
    // returning ended:false on it is what keeps the alarm at one, not two.
    const callId = 'outage-twice-1';
    await startCall(callId);
    const base = {
      tenant_id: tenantId,
      call_id: callId,
      duration_seconds: 39,
      transcript: 'Caller [0:24]: hi',
    };
    await post('/agent-tools/voice-session-end', {
      ...base,
      llm_outage: { cause: 'quota_exhausted', status_code: 429 },
    });
    await post('/agent-tools/voice-session-end', {
      ...base,
      summary: 'Caller wanted to hire him.',
    });

    expect((await metadataOf(callId)).llm_outage).toMatchObject({ cause: 'quota_exhausted' });
    expect(counterValue('errors_total', { event: 'llm_quota_exhausted' })).toBe(1);
  });

  it('HAPPY: an ordinary call leaves metadata untouched and raises no outage metric', async (ctx) => {
    skipIfDbDown(ctx, () => dbAvailable);
    const callId = 'outage-none-1';
    await startCall(callId);
    await post('/agent-tools/voice-session-end', {
      tenant_id: tenantId,
      call_id: callId,
      duration_seconds: 90,
      outcome: 'message',
      transcript: 'Caller [0:05]: hi',
    });
    expect((await metadataOf(callId)).llm_outage).toBeUndefined();
    expect(counterValue('errors_total', { event: 'llm_quota_exhausted' })).toBe(0);
    expect(counterValue('errors_total', { event: 'voice_llm_outage' })).toBe(0);
  });

  it('SAD: an unknown cause is rejected at the schema, not written', async (ctx) => {
    skipIfDbDown(ctx, () => dbAvailable);
    const callId = 'outage-bad-1';
    await startCall(callId);
    const res = await post('/agent-tools/voice-session-end', {
      tenant_id: tenantId,
      call_id: callId,
      duration_seconds: 5,
      llm_outage: { cause: 'gremlins' },
    });
    // agent-tools routes report validation failure as { success:false, error }.
    expect(res.json()).toMatchObject({ success: false });
    expect(res.json().error).toContain('llm_outage.cause');
    expect((await metadataOf(callId)).llm_outage).toBeUndefined();
  });
});
