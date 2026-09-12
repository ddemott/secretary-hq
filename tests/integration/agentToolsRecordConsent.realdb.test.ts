/**
 * Real-DB companion for the verbal SMS-consent capture agent tool.
 *
 * The voice agent, after a booking, may ask the caller for permission to text
 * appointment reminders (informational only). On a yes it calls
 * POST /agent-tools/record-consent → INSERT INTO consent_records. A mocked pg
 * client proves the marshalling, not that the columns exist or that the row a
 * verbal yes writes is the SAME row reminderProcessor's checkConsent later
 * reads (phone normalization + consent_type/method must line up). This suite
 * drives the real route → real Postgres and reads the stored row back.
 *
 * 5W for sad-path failures:
 *   WHO  — the voice agent capturing "yes, text me reminders" on a call
 *   WHAT — POST /agent-tools/record-consent
 *   WHEN — right after a confirmed booking, once the caller agrees
 *   WHERE — agentTools.ts INSERT INTO consent_records (method='verbal')
 *   WHY  — a consent that doesn't land (or lands under a differently-formatted
 *          phone) means reminders get skipped for "no_consent" and the caller
 *          silently never gets their reminder despite saying yes
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { type Client, Pool } from 'pg';
import { API_DB_URL, getRootClient, createTenant, skipIfDbDown } from '../utils';
import { createWithTenantClient } from '../../src/database';
import { registerAgentToolRoutes } from '../../src/routes/agentTools';
import { normalizePhone } from '../../shared/phone';
import { errorsTotal } from '../../src/services/metrics';

function errorsTotalFor(event: string): number {
  return errorsTotal.snapshot().find((s) => s.labels.event === event)?.value ?? 0;
}

const AGENT_SECRET = 'test-consent-secret';
const stubEmbedding = (): Promise<number[]> => Promise.resolve(new Array(1536).fill(0));
const stubNormalizer = async (text: string): Promise<string> => text;

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
let tenantId: string;
let prevAgentSecret: string | undefined;
const tenantsToClean: string[] = [];

function post(path: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'x-agent-secret': AGENT_SECRET },
    payload,
  });
}

async function consentRows(phone: string) {
  const res = await setup.query(
    `SELECT consent_type, consent_given, consent_method, consent_source, customer_phone
       FROM consent_records WHERE tenant_id = $1 AND customer_phone = $2`,
    [tenantId, phone]
  );
  return res.rows;
}

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });
    prevAgentSecret = process.env.AGENT_SECRET;
    process.env.AGENT_SECRET = AGENT_SECRET;

    app = Fastify({ logger: false });
    const withTenantClient = createWithTenantClient(pool);
    registerAgentToolRoutes(app, pool, withTenantClient, stubEmbedding, stubNormalizer);
    await app.ready();

    tenantId = await createTenant(setup, 'Consent Realdb Tenant', 'salon');
    tenantsToClean.push(tenantId);

    dbAvailable = true;
  } catch (err) {
     
    console.warn('[agentToolsRecordConsent.realdb.test] DB not available, skipping', err);
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
  if (prevAgentSecret === undefined) delete process.env.AGENT_SECRET;
  else process.env.AGENT_SECRET = prevAgentSecret;
});

beforeEach((ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
});

describe('POST /agent-tools/record-consent — verbal SMS consent → consent_records', () => {
  it('HAPPY: a verbal yes writes an sms/verbal/given row keyed on the normalized phone', async () => {
    // The agent passes the number as the caller spoke it; the route normalizes
    // it, and the stored row must match that normalized form (what checkConsent
    // looks up at reminder time).
    const spoken = '(555) 777-0001';
    const normalized = normalizePhone(spoken);

    const res = await post('/agent-tools/record-consent', {
      tenant_id: tenantId,
      phone: spoken,
      call_id: 'consent-call-1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().result).toMatchObject({ recorded: true, channel: 'sms', phone: normalized });

    const rows = await consentRows(normalized);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      consent_type: 'sms',
      consent_given: true,
      consent_method: 'verbal',
      consent_source: 'voice_call:consent-call-1',
      customer_phone: normalized,
    });
  });

  it('HAPPY: omitting call_id records a generic voice_call source', async () => {
    const normalized = normalizePhone('555-777-0002');
    const res = await post('/agent-tools/record-consent', {
      tenant_id: tenantId,
      phone: '555-777-0002',
    });
    expect(res.statusCode).toBe(200);
    const rows = await consentRows(normalized);
    expect(rows).toHaveLength(1);
    expect(rows[0].consent_source).toBe('voice_call');
  });

  it('SAD: an incomplete phone number records nothing and returns a soft failure', async () => {
    // Best-effort shape (success:false at HTTP 200) so a bad value never
    // derails the live call — and crucially, no bogus consent row is written.
    const res = await post('/agent-tools/record-consent', {
      tenant_id: tenantId,
      phone: '123',
      call_id: 'consent-call-bad',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(false);

    const rows = await setup.query(
      `SELECT count(*)::int AS n FROM consent_records
        WHERE tenant_id = $1 AND consent_source = 'voice_call:consent-call-bad'`,
      [tenantId]
    );
    expect(rows.rows[0].n).toBe(0);
  });
});

// No real DB needed below — withTenantClient is a plain function parameter
// on registerAgentToolRoutes, so a throwing stub exercises the catch block
// directly without a pool at all. Runs even when the real-DB suite above is
// skipped (no DATABASE_URL in this environment).
describe('POST /agent-tools/record-consent — DB failure is instrumented, not silent', () => {
  it('SAD: a DB error still returns a soft failure but bumps errors_total', async () => {
    // WHO: platform operator watching /metrics, not the caller
    // WHAT: withTenantClient rejects (simulating a DB hiccup); the route must
    //       still answer with the best-effort soft-failure shape (never a
    //       500 mid-call) AND count the failure — see sad-path-instrumentation
    // WHY: an uncounted, systematically-failing consent write is invisible
    //      until a customer complains reminders never mentioned consent
    const prevSecret = process.env.AGENT_SECRET;
    process.env.AGENT_SECRET = 'test-consent-failure-secret';

    const failingApp = Fastify({ logger: false });
    const throwingWithTenantClient = async () => {
      throw new Error('connection reset');
    };
    registerAgentToolRoutes(
      failingApp,
      {} as Pool,
      throwingWithTenantClient,
      async () => new Array(1536).fill(0),
      async (text: string) => text
    );
    await failingApp.ready();

    try {
      const before = errorsTotalFor('record_consent_insert_failed');
      const res = await failingApp.inject({
        method: 'POST',
        url: '/agent-tools/record-consent',
        headers: { 'x-agent-secret': 'test-consent-failure-secret' },
        payload: {
          tenant_id: '11111111-1111-1111-8111-111111111111',
          phone: '555-777-0009',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(false);
      expect(errorsTotalFor('record_consent_insert_failed')).toBe(before + 1);
    } finally {
      await failingApp.close();
      if (prevSecret === undefined) delete process.env.AGENT_SECRET;
      else process.env.AGENT_SECRET = prevSecret;
    }
  });
});
