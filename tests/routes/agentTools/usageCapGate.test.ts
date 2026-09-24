/**
 * HTTP gate: blocked soft-cap returns error_code=usage_limit_exceeded
 * on both voice-session-start entrypoints. Only the free tier (no paid plan)
 * can be blocked; a paid plan past its allowance is 'overage' and proceeds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';

import { registerAgentToolRoutes } from '../../../src/routes/agentTools';
import { registerVoiceRoutes } from '../../../src/routes/voice';
import { registry } from '../../../src/services/metrics';
import type { UsageCapEvaluation } from '../../../src/services/billingUsage';
import type * as BillingUsageModule from '../../../src/services/billingUsage';

const TENANT_ID = 'f234e471-0e60-4163-86c9-93cfd9338e3a';
const SECRET = 'test-agent-secret';

const blockedCap: UsageCapEvaluation = {
  plan: null,
  used: 50,
  limit: 50,
  percent: 100,
  status: 'blocked',
  softCapEnforced: true,
  warnRatio: 0.8,
  blocked: true,
  freeTierApplied: true,
};

const overageCap: UsageCapEvaluation = {
  plan: 'solo',
  used: 42,
  limit: 30,
  percent: 100,
  status: 'overage',
  softCapEnforced: true,
  warnRatio: 0.8,
  blocked: false,
  freeTierApplied: false,
};

const okCap: UsageCapEvaluation = {
  plan: 'solo',
  used: 1,
  limit: 30,
  percent: 0,
  status: 'ok',
  softCapEnforced: true,
  warnRatio: 0.8,
  blocked: false,
  freeTierApplied: false,
};

vi.mock('../../../src/services/billingUsage', async (importOriginal) => {
  const actual = await importOriginal<typeof BillingUsageModule>();
  return {
    ...actual,
    evaluateUsageCap: vi.fn(),
  };
});

import { evaluateUsageCap } from '../../../src/services/billingUsage';

const evaluateUsageCapMock = vi.mocked(evaluateUsageCap);

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

function buildAgentApp(): FastifyInstance {
  const mockClient = {
    query: vi.fn(async () => ({ rows: [{ context: null }], rowCount: 1 })),
    release: vi.fn(),
  } as unknown as PoolClient;

  const withTenantClient = async <T>(
    _tenantId: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> => fn(mockClient);

  const app = Fastify({ logger: false });
  registerAgentToolRoutes(app, {} as never, withTenantClient, async () => new Array(1536).fill(0));
  return app;
}

type TenantRequest = FastifyRequest & {
  tenantId?: string;
  auth?: { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
};

function buildVoiceApp(): FastifyInstance {
  const mockClient = {
    query: vi.fn(async () => ({
      rows: [
        {
          context: {
            is_known_customer: false,
            customer: null,
            appointment_history: { total: 0, completed: 0, cancelled: 0, last_appointment: null },
          },
        },
      ],
      rowCount: 1,
    })),
    release: vi.fn(),
  } as unknown as PoolClient;

  const withTenantClient = async <T>(
    _tenantId: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> => fn(mockClient);

  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request: TenantRequest) => {
    const tenantId =
      (request.query as Record<string, string>)?.tenant_id ||
      (request.headers['x-tenant-id'] as string);
    if (tenantId) request.tenantId = tenantId;
  });
  registerVoiceRoutes(app, {} as Pool, withTenantClient);
  return app;
}

beforeEach(() => {
  process.env.AGENT_SECRET = SECRET;
  registry.clearAll();
  evaluateUsageCapMock.mockReset();
});

afterEach(() => {
  delete process.env.AGENT_SECRET;
  vi.clearAllMocks();
});

describe('HTTP soft-cap gate — error_code=usage_limit_exceeded', () => {
  it('HAPPY: /agent-tools/voice-session-start blocked returns usage_limit_exceeded', async () => {
    evaluateUsageCapMock.mockResolvedValue(blockedCap);
    const app = buildAgentApp();
    const res = await app.inject({
      method: 'POST',
      url: '/agent-tools/voice-session-start',
      headers: { 'x-agent-secret': SECRET },
      payload: {
        tenant_id: TENANT_ID,
        call_id: 'SCL_cap_block',
        caller_phone: null,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('usage_limit_exceeded');
    expect(counterValue('errors_total', { event: 'call_rejected_usage_limit_exceeded' })).toBe(1);
  });

  it('HAPPY: /voice/session/start blocked returns usage_limit_exceeded (H3 parity)', async () => {
    evaluateUsageCapMock.mockResolvedValue(blockedCap);
    const app = buildVoiceApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: `/voice/session/start?tenant_id=${TENANT_ID}`,
      payload: { call_id: 'call-cap-block', caller_phone: '+15551234567' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('usage_limit_exceeded');
    await app.close();
  });

  it('HAPPY: under-cap agent start still proceeds to DB session open', async () => {
    evaluateUsageCapMock.mockResolvedValue(okCap);
    const app = buildAgentApp();
    const res = await app.inject({
      method: 'POST',
      url: '/agent-tools/voice-session-start',
      headers: { 'x-agent-secret': SECRET },
      payload: {
        tenant_id: TENANT_ID,
        call_id: 'SCL_cap_ok',
        caller_phone: null,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.error_code).toBeUndefined();
  });

  it('HAPPY: a paid plan past its allowance (overage) is answered, not refused', async () => {
    // WHO: tier-1 tenant 12 calls past its 30-call allowance, with a caller on the line.
    // WHAT: voice-session-start opens the session; no usage_limit_exceeded.
    // WHY: owner decision 2026-09-24 — paid plans bill each extra call instead of
    //      turning the business's customer away.
    evaluateUsageCapMock.mockResolvedValue(overageCap);
    const app = buildAgentApp();
    const res = await app.inject({
      method: 'POST',
      url: '/agent-tools/voice-session-start',
      headers: { 'x-agent-secret': SECRET },
      payload: {
        tenant_id: TENANT_ID,
        call_id: 'SCL_cap_overage',
        caller_phone: null,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.error_code).toBeUndefined();
    expect(counterValue('errors_total', { event: 'call_rejected_usage_limit_exceeded' })).toBe(0);
  });
});
