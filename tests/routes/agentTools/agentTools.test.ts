/**
 * Tests for /agent-tools/* routes — the Fastify replacement for the
 * Supabase Edge Function that backs voice AI tool calls (Phase 2 of the
 * Vapi → LiveKit migration). Covers auth, validation, and the four
 * routes implemented so far (service-catalog, customer-context,
 * check-availability, policy-answer).
 *
 * Strategy: mock withTenantClient + getEmbedding, inject HTTP requests
 * via Fastify. Happy + sad paths with 5W diagnostics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';

import { registerAgentToolRoutes } from '../../../src/routes/agentTools';
import { sendJobInquiryEmail } from '../../../src/services/communications/systemEmail';
import { registry } from '../../../src/services/metrics';

/** Read the current value of errors_total{event="..."} from the live registry. */
function errorCount(event: string): number {
  const line = registry
    .expose()
    .split('\n')
    .find((l) => l.startsWith(`errors_total{`) && l.includes(`event="${event}"`));
  if (!line) return 0;
  const n = Number(line.trim().split(/\s+/).pop());
  return Number.isFinite(n) ? n : 0;
}

/** Read any counter's value for a given label set from the live registry. */
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

// The capture-job-inquiry route emails the owner via systemEmail. Mock it so we
// can (a) assert it's called with the resolved recipient + collected fields and
// (b) simulate an SMTP failure to exercise the best-effort/instrumented sad path
// without standing up a real transporter. Everything else is real.
vi.mock('../../../src/services/communications/systemEmail', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendJobInquiryEmail: vi.fn() };
});

// Zod v4's .uuid() requires a proper version/variant nibble, so these
// are real v4 UUIDs — not pattern fillers.
const TENANT_ID = 'f234e471-0e60-4163-86c9-93cfd9338e3a';
const RESOURCE_ID = 'a1b2c3d4-e5f6-4789-ab12-cdef34567890';
const SECRET = 'test-agent-secret';

interface MockQuery {
  text: string;
  params: unknown[];
}

function buildApp(opts: {
  queryResponses: Array<{ rows: unknown[]; rowCount?: number }>;
  embedding?: number[];
  // When true, getEmbedding rejects — simulates OpenAI embeddings down/over-quota
  // so the policy-answer route's graceful-degrade path can be exercised.
  embeddingThrows?: boolean;
  normalizer?: (text: string) => Promise<string>;
  expander?: (text: string) => Promise<string>;
  // Sad-path hook: when set and it returns an Error for a given SQL text, the
  // mock query REJECTS with it (simulating a Postgres failure, e.g. a 23502
  // not_null_violation from start_voice_session). Returns null to run normally.
  queryThrows?: (text: string) => Error | null;
}): { app: FastifyInstance; queries: MockQuery[] } {
  const queries: MockQuery[] = [];
  const responses = [...opts.queryResponses];

  const mockClient = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      // Cost-ledger writes are out-of-band telemetry (fire-and-forget in the
      // routes); they must not consume a queued response or appear in the
      // asserted query log, otherwise they'd shift every other test's
      // expectations by one.
      if (typeof text === 'string' && text.includes('ai_cost_events')) {
        return { rows: [], rowCount: 1 };
      }
      queries.push({ text, params: params || [] });
      const thrown = opts.queryThrows?.(typeof text === 'string' ? text : '');
      if (thrown) throw thrown;
      return responses.shift() || { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  } as unknown as PoolClient;

  const withTenantClient = async <T>(
    _tenantId: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> => fn(mockClient);

  const getEmbedding = async () => {
    if (opts.embeddingThrows) throw new Error('OpenAI embeddings unavailable (429)');
    return opts.embedding ?? new Array(1536).fill(0);
  };

  const app = Fastify({ logger: false });
  registerAgentToolRoutes(
    app,
    {} as never,
    withTenantClient,
    getEmbedding,
    opts.normalizer,
    opts.expander
  );
  return { app, queries };
}

/**
 * Inject a POST to an agent-tool path with the standard auth header.
 * Every test hits /agent-tools/* with the same method + header combination,
 * so collapsing that into one call keeps the URL + payload explicit at the
 * call site (which is the meaningful part) without repeating boilerplate.
 *
 * Pass `secret: ''` to test auth failures (omit for happy-path auth).
 */
function post(
  app: FastifyInstance,
  path: string,
  payload: unknown,
  opts: { secret?: string } = {}
) {
  const headers: Record<string, string> =
    opts.secret === undefined
      ? { 'x-agent-secret': SECRET }
      : opts.secret === ''
        ? {}
        : { 'x-agent-secret': opts.secret };
  return app.inject({ method: 'POST', url: path, headers, payload });
}

/**
 * Assert a "validation failed before any DB call" response shape.
 * Every SAD-path test that rejects malformed input asserts the same three
 * things: 200 status (conversational), success:false, and zero DB queries.
 */
function expectValidationFailure(
  res: { statusCode: number; json: () => { success: boolean; error?: string } },
  queries: MockQuery[]
) {
  expect(res.statusCode).toBe(200);
  expect(res.json().success).toBe(false);
  expect(queries).toHaveLength(0);
}

beforeEach(() => {
  process.env.AGENT_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.AGENT_SECRET;
  vi.restoreAllMocks();
});

describe('agentTools auth', () => {
  it('SAD: missing x-agent-secret header returns 401', async () => {
    // WHO: Random HTTP client hitting the agent tools without auth
    // WHAT: Must 401 — these routes bypass tenantMiddleware, so this is
    //        the only protection against public access
    // WHY: Leak would expose booking + customer-context to the internet
    const { app } = buildApp({ queryResponses: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/agent-tools/service-catalog',
      payload: { tenant_id: TENANT_ID },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ success: false, error: 'Unauthorized' });
  });

  it('SAD: wrong x-agent-secret header returns 401 (timing-safe comparison)', async () => {
    // WHAT: Any mismatch returns 401. Comparison uses crypto.timingSafeEqual
    //        (added 2026-05-09 security-review pass 2) so a per-character
    //        timing oracle cannot probe the secret one byte at a time.
    // WHY: Prior plain `!==` short-circuited on first mismatched byte —
    //        in principle observable across enough samples. Constant-time
    //        comparison closes that channel.
    const { app } = buildApp({ queryResponses: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/agent-tools/service-catalog',
      headers: { 'x-agent-secret': 'wrong' },
      payload: { tenant_id: TENANT_ID },
    });
    expect(res.statusCode).toBe(401);
  });

  it('SAD: unset AGENT_SECRET rejects everything (fail-closed)', async () => {
    // WHO: Misconfigured production where AGENT_SECRET never got set
    // WHAT: Must still reject — empty-matches-empty would be a vuln
    // WHY: Prior code that threw on startup was safer but broke local
    //        dev without the env var; this is the fail-closed compromise
    delete process.env.AGENT_SECRET;
    const { app } = buildApp({ queryResponses: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/agent-tools/service-catalog',
      headers: { 'x-agent-secret': '' },
      payload: { tenant_id: TENANT_ID },
    });
    expect(res.statusCode).toBe(401);
  });

  it('SAD: a much shorter provided secret returns 401 cleanly (no length-mismatch crash)', async () => {
    // WHO: Adversary or misconfigured worker sending a single-character secret
    // WHAT: timingSafeEqual throws if buffers differ in length, so the
    //        wrapper guards by checking lengths first. The route returns
    //        a clean 401 instead of a 500.
    // WHEN: any request whose x-agent-secret has a different byte length
    //        than the configured AGENT_SECRET (the common case for any
    //        wrong-secret attempt)
    // WHERE: src/routes/agentTools.ts safeEquals
    // WHY: pre-fix the route used `!==` which never crashed on length
    //        mismatch but leaked timing info. Post-fix the route uses
    //        timingSafeEqual which would crash without the length guard.
    //        Pin that the guard works — a length mismatch must NOT crash.
    const { app } = buildApp({ queryResponses: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/agent-tools/service-catalog',
      headers: { 'x-agent-secret': 'x' },
      payload: { tenant_id: TENANT_ID },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ success: false, error: 'Unauthorized' });
  });

  it('HAPPY: AGENT_SECRET_OLD is accepted during a rotation window', async () => {
    // WHO: Operator rotating the agent secret. New AGENT_SECRET deployed on
    //        backend; agent worker still on the old value until its
    //        Railway redeploy completes.
    // WHAT: Setting AGENT_SECRET_OLD lets the backend accept either the
    //        new primary OR the old value during the transition. After
    //        all workers are on the new secret, AGENT_SECRET_OLD is
    //        cleared and only the primary works.
    // WHEN: any request authenticating with the previous secret while
    //        AGENT_SECRET_OLD is still set
    // WHERE: src/routes/agentTools.ts auth preHandler — `matchesOld` branch
    // WHY: pre-fix there was no rotation infrastructure. Rotating
    //        required setting the new secret on backend + worker
    //        simultaneously, which is impossible without downtime. Now
    //        rotation is hot-swappable: deploy backend with both secrets,
    //        deploy worker with new secret, drop AGENT_SECRET_OLD.
    process.env.AGENT_SECRET = 'new-primary-secret-32+chars';
    process.env.AGENT_SECRET_OLD = SECRET;
    const { app } = buildApp({
      queryResponses: [{ rows: [{ service_id: 'svc-1', name: 'Test', duration_minutes: 30 }] }],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/agent-tools/service-catalog',
      // Worker still using the OLD secret — must succeed during rotation.
      headers: { 'x-agent-secret': SECRET },
      payload: { tenant_id: TENANT_ID },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    delete process.env.AGENT_SECRET_OLD;
  });

  it('SAD: AGENT_SECRET_OLD does NOT enable a third value (only the two named ones work)', async () => {
    // WHY: pin that rotation isn't a "wildcard accepts anything that was
    //        ever a secret" — it's specifically AGENT_SECRET OR
    //        AGENT_SECRET_OLD. Any other value still 401s.
    process.env.AGENT_SECRET = 'new-primary-secret-32+chars';
    process.env.AGENT_SECRET_OLD = SECRET;
    const { app } = buildApp({ queryResponses: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/agent-tools/service-catalog',
      headers: { 'x-agent-secret': 'something-else-entirely' },
      payload: { tenant_id: TENANT_ID },
    });
    expect(res.statusCode).toBe(401);
    delete process.env.AGENT_SECRET_OLD;
  });
});

describe('agentTools /service-catalog', () => {
  it('HAPPY: returns services with expected columns', async () => {
    // WHO: LiveKit agent asked "what services do you offer?"
    // WHAT: Route should SELECT catalog columns, return them under result.services
    const { app, queries } = buildApp({
      queryResponses: [
        {
          rows: [
            { id: 'svc1', name: 'Oil Change', duration_minutes: 30, price: 45 },
            { id: 'svc2', name: 'Tire Rotation', duration_minutes: 45, price: 30 },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/service-catalog', { tenant_id: TENANT_ID });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.result.services).toHaveLength(2);
    expect(body.result.services[0].name).toBe('Oil Change');
    // WHY: Must filter is_deleted — survey the generated SQL
    expect(queries[0].text).toContain('is_deleted = false');
    expect(queries[0].params).toEqual([TENANT_ID]);
  });

  it('SAD: missing tenant_id fails validation', async () => {
    // WHAT: Route should reject with a validation error, not hit DB
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/service-catalog', {});
    expectValidationFailure(res, queries);
    expect(res.json().error).toContain('Validation failed');
  });

  it('SAD: non-UUID tenant_id fails validation', async () => {
    // WHO: Malformed tool-call argument from the LLM
    // WHAT: Fail at Zod, not at Postgres (clearer error for the agent)
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/service-catalog', { tenant_id: 'not-a-uuid' });
    expectValidationFailure(res, queries);
  });
});

describe('agentTools /tenant-config', () => {
  it('HAPPY: returns name + timezone for known tenant', async () => {
    // WHO: LiveKit agent worker on connect, before building the system prompt
    // WHAT: Route returns the tenant's display name and IANA timezone in
    //        the standard `{ success: true, result }` envelope
    // WHEN: Once per call, right after the agent has parsed dispatch metadata
    //        and decided it can run the full agent
    // WHERE: src/routes/agentTools.ts /agent-tools/tenant-config route
    // WHY: Without this, the prompt would greet with "this business" and
    //       reason about "today" in the wrong zone for any tenant other
    //       than DynaTire — multi-tenant production was theatrical until
    //       this route existed and was actually called by the agent
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ name: 'DynaTire', timezone: 'America/Chicago', system_prompt: null }] },
      ],
    });
    const res = await post(app, '/agent-tools/tenant-config', { tenant_id: TENANT_ID });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.result).toEqual({
      name: 'DynaTire',
      timezone: 'America/Chicago',
      system_prompt: null,
      // 2026-06-30 owner-editable assistant name; null = no explicit name.
      persona_name: null,
      // 2026-06-11 greeting defaults null → agent speaks its hardcoded fallback.
      first_message: null,
      // New 2026-06-06 fields default off when the row doesn't carry them.
      save_preferences_enabled: false,
      preferences_instructions: null,
      // 2026-06-10 (Grok era) TTS fields default null → agent uses env/platform defaults.
      // (XAI_* envs removed 2026-06-25; columns reused for OpenAI.)
      tts_voice: null,
      tts_speed: null,
      tts_soft: null,
      // 2026-06-14 voice style booleans default null → agent uses env defaults.
      tts_cheerful: null,
      tts_formal: null,
      tts_warm: null,
      tts_concise: null,
      // 2026-06-11 forward_phone defaults null → transfer_call takes a message.
      forward_phone: null,
      // 2026-06-29 forwarded_from_phone defaults null → no forwarded-line match.
      forwarded_from_phone: null,
      // 2026-07-23: THE resolved transfer capability. No forward_phone configured
      // here, so there is nothing to transfer to — and a loop is impossible.
      transfer_available: false,
      // 2026-07-11 call_disclosure defaults null → agent speaks the platform default.
      call_disclosure: null,
      greeting_menu: null,
      greeting_closer: null,
      // 2026-07-12: hours derived from who is actually scheduled. Null here because
      // the mock pool returns no shift rows — and null is exactly right: a shop with
      // nobody scheduled has no hours to state, and the agent must NOT invent any.
      business_hours: null,
      bookable_through: null,
      // 2026-07-31: what actually happens at the booked time, in the owner's
      // words. Null → the confirmation says nothing extra, which is the honest
      // default; the alternative is the model inventing an answer, and it
      // invented "call Dale on this same number" on a real call.
      booking_mechanics: null,
      checklist_runtime_config: {
        preset_id: 'local_service_front_desk',
        enabled_conversation_blocks: [
          'identity',
          'booking',
          'message',
          'generic_subject',
          'qa',
          'buy_service',
          'schedule_change',
        ],
        enabled_policy_blocks: [],
        enabled_knowledge_blocks: [],
        enabled_outcome_blocks: [],
        overrides: {},
        version: 1,
      },
      // The roster the agent checks a caller-named person against. The mock
      // pool returns no employee rows, so the list is empty — and an empty
      // roster must render NO roster line rather than an empty one.
      staff_first_names: [],
      // This tenant has no per-tenant question-tree rows, so the agent falls
      // back to the platform TypeScript library — the behaviour every tenant
      // had before per-tenant trees existed. An empty array here is the
      // "not converted yet" signal, not a business that asks nothing.
      question_trees: [],
    });
    expect(queries[0].text).toContain('FROM tenants');
    expect(queries[0].text).toContain('system_prompt');
    expect(queries[0].params).toEqual([TENANT_ID]);
  });

  it('HAPPY: surfaces tenants.system_prompt when the owner has customized it', async () => {
    // WHO: A tenant who edited their AI Persona prompt in the dashboard.
    // WHAT: Route returns system_prompt verbatim alongside name + timezone.
    //       Substitution happens in the agent (buildSystemPrompt), not here.
    // WHERE: src/routes/agentTools.ts /tenant-config SELECT clause.
    // WHY: Before 2026-05-18 the column was stored but the agent never
    //      received it — the LLM saw the hardcoded "You are Clara..." line
    //      regardless of what the owner typed into the dashboard.
    const customText = 'You are a friendly receptionist for {{business_name}}.';
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ name: 'DynaTire', timezone: 'America/Chicago', system_prompt: customText }] },
      ],
    });
    const res = await post(app, '/agent-tools/tenant-config', { tenant_id: TENANT_ID });
    expect(res.json().result.system_prompt).toBe(customText);
  });

  it('HAPPY: derives checklist preset runtime config from business_type for the agent', async () => {
    const { app } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              name: 'Bella Salon',
              timezone: 'America/Chicago',
              business_type: 'salon',
              checklist_preset_id: null,
              system_prompt: null,
            },
          ],
        },
      ],
    });

    const res = await post(app, '/agent-tools/tenant-config', { tenant_id: TENANT_ID });

    expect(res.statusCode).toBe(200);
    expect(res.json().result.checklist_runtime_config).toEqual({
      preset_id: 'salon_front_desk',
      enabled_conversation_blocks: [
        'identity',
        'salon_intake',
        'booking',
        'message',
        'qa',
        'schedule_change',
      ],
      enabled_policy_blocks: [],
      enabled_knowledge_blocks: [],
      enabled_outcome_blocks: [],
      overrides: {},
      version: 1,
    });
  });

  it('HAPPY: explicit checklist preset override beats business_type derivation for the agent', async () => {
    const { app } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              name: 'Bella Salon',
              timezone: 'America/Chicago',
              business_type: 'salon',
              checklist_preset_id: 'local_service_front_desk',
              system_prompt: null,
            },
          ],
        },
      ],
    });

    const res = await post(app, '/agent-tools/tenant-config', { tenant_id: TENANT_ID });

    expect(res.statusCode).toBe(200);
    expect(res.json().result.checklist_runtime_config.preset_id).toBe('local_service_front_desk');
  });

  it('HAPPY: null timezone falls back to America/Chicago', async () => {
    // WHO: A tenant row that pre-dates the timezone column having a
    //       NOT NULL default (legacy seed data)
    // WHAT: Route substitutes 'America/Chicago' so the agent always
    //        receives a usable IANA zone string
    // WHEN: Any call routed for a legacy tenant
    // WHERE: The `row.timezone || 'America/Chicago'` coalesce in the route
    // WHY: `Intl.DateTimeFormat` (used by formatDateForPrompt in the
    //       agent worker) throws on null/empty timezone — would crash the
    //       agent's prompt assembly for legacy rows and dump the call
    //       into runFallback. Coalescing here is cheaper than fixing
    //       every legacy row.
    const { app } = buildApp({
      queryResponses: [{ rows: [{ name: 'Legacy Co', timezone: null, system_prompt: null }] }],
    });
    const res = await post(app, '/agent-tools/tenant-config', { tenant_id: TENANT_ID });
    expect(res.json().result).toEqual({
      name: 'Legacy Co',
      timezone: 'America/Chicago',
      system_prompt: null,
      persona_name: null,
      first_message: null,
      save_preferences_enabled: false,
      preferences_instructions: null,
      tts_voice: null,
      tts_speed: null,
      tts_soft: null,
      tts_cheerful: null,
      tts_formal: null,
      tts_warm: null,
      tts_concise: null,
      // 2026-06-11 forward_phone defaults null → transfer_call takes a message.
      forward_phone: null,
      // 2026-06-29 forwarded_from_phone defaults null → no forwarded-line match.
      forwarded_from_phone: null,
      // 2026-07-23: THE resolved transfer capability. No forward_phone configured
      // here, so there is nothing to transfer to — and a loop is impossible.
      transfer_available: false,
      // 2026-07-11 call_disclosure defaults null → agent speaks the platform default.
      call_disclosure: null,
      greeting_menu: null,
      greeting_closer: null,
      // 2026-07-12: hours derived from who is actually scheduled. Null here because
      // the mock pool returns no shift rows — and null is exactly right: a shop with
      // nobody scheduled has no hours to state, and the agent must NOT invent any.
      business_hours: null,
      bookable_through: null,
      booking_mechanics: null,
      checklist_runtime_config: {
        preset_id: 'local_service_front_desk',
        enabled_conversation_blocks: [
          'identity',
          'booking',
          'message',
          'generic_subject',
          'qa',
          'buy_service',
          'schedule_change',
        ],
        enabled_policy_blocks: [],
        enabled_knowledge_blocks: [],
        enabled_outcome_blocks: [],
        overrides: {},
        version: 1,
      },
      staff_first_names: [],
      question_trees: [],
    });
  });

  it('SAD: unknown tenant returns success:false with explanatory error', async () => {
    // WHO: A dispatch rule misconfigured to point at a deleted tenant_id
    //       (e.g., tenant got soft-deleted but the dispatch rule was never
    //       cleaned up)
    // WHAT: Route returns `{ success: false, error: 'Tenant not found' }`
    //        with HTTP 200 (per /agent-tools/* envelope convention)
    // WHEN: A call is dispatched for an ID that doesn't exist
    // WHERE: The empty-rows guard in the route handler
    // WHY: The agent's `fetchTenantConfig` helper treats any non-success
    //       envelope as a soft failure → falls back to "this business" /
    //       America/Chicago. This keeps the call answering coherently
    //       even when dispatch state has drifted from tenant state.
    //       Hanging up on the caller because of a stale dispatch rule
    //       would be much worse than a generic greeting.
    const { app } = buildApp({ queryResponses: [{ rows: [] }] });
    const res = await post(app, '/agent-tools/tenant-config', { tenant_id: TENANT_ID });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Tenant not found');
  });

  it('SAD: non-UUID tenant_id fails Zod validation before any DB call', async () => {
    // WHO: A worker bug or LLM hallucination that puts a non-UUID into
    //       the request body (defense-in-depth — should never happen in
    //       practice because tenant_id comes from dispatch metadata, but
    //       a regression in dispatch metadata parsing could surface here)
    // WHAT: Validation rejects with the route's standard validation
    //        envelope; queries array stays empty (no DB hit attempted)
    // WHEN: Any malformed tenant_id reaching the route
    // WHERE: The Zod GetTenantConfigSchema applied by toolRoute()
    // WHY: A non-UUID would bypass the prepared statement's UUID type
    //       check at the DB layer and fail with a confusing pg error.
    //       Catching it at Zod gives the agent's helper a clean
    //       success:false envelope to fall back from.
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/tenant-config', { tenant_id: 'not-a-uuid' });
    expectValidationFailure(res, queries);
  });
});

describe('agentTools /customer-context', () => {
  it('HAPPY: existing customer returns name + joined summaries', async () => {
    // WHO: Returning customer calling back about their oil change
    // WHAT: Route should find them by normalized phone and stitch 3
    //        recent summaries together
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'cust1', name: 'Alice' }] },
        { rows: [{ summary: 'Booked oil change' }, { summary: 'Asked about winter tires' }] },
        { rows: [] }, // no upcoming appointments
      ],
    });
    const res = await post(app, '/agent-tools/customer-context', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      // Carrier-attested caller-ID → the disclosure gate has nothing to prove.
      // Without this it defaults to 'spoken' and the gate withholds the data.
      phone_source: 'caller_id',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({
      name: 'Alice',
      history: 'Booked oil change; Asked about winter tires',
      // No saved preferences for this row → empty object (not omitted).
      preferences: {},
      // No consent record → false. FAIL CLOSED: an unknown consent state must
      // send the agent down the full permission script. Texting without consent
      // is illegal; asking someone who already agreed is merely annoying.
      sms_consent: false,
      upcoming_appointments: [],
    });
    // WHY: Phone must be normalized to +1 form before the lookup
    expect(queries[0].params).toEqual([TENANT_ID, '+15551234567']);
  });

  it('HAPPY: saved preferences ride along so the LLM sees them next call', async () => {
    // WHO: a returning customer whose preferences were saved on a prior call.
    // WHAT: customer-context returns metadata.preferences alongside name +
    //        history. This is the ACTUAL recall path the agent uses — the
    //        agent's get_customer_context tool hits THIS route, not the
    //        dashboard's get_customer_context_for_call. If preferences don't
    //        surface here, save_customer_preference is write-only and the
    //        whole feature silently does nothing on the next call.
    // WHERE: src/routes/agentTools.ts /agent-tools/customer-context.
    const { app } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              customer_id: 'cust1',
              name: 'Sarah',
              preferences: { preferred_stylist: 'Maria', last_service: 'balayage' },
            },
          ],
        },
        { rows: [] }, // no call summaries
        { rows: [] }, // no upcoming appointments
        // Sarah agreed to appointment texts on a previous call. Consent is
        // durable (TCPA: prior express consent persists until revoked), so the
        // agent must NOT run the permission script at her again.
        { rows: [{ consent_given: true, revoked_at: null }] },
      ],
    });
    const res = await post(app, '/agent-tools/customer-context', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      // Carrier-attested caller-ID → the disclosure gate has nothing to prove.
      // Without this it defaults to 'spoken' and the gate withholds the data.
      phone_source: 'caller_id',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({
      name: 'Sarah',
      history: 'No history',
      preferences: { preferred_stylist: 'Maria', last_service: 'balayage' },
      // She already said yes — do not ask again.
      sms_consent: true,
      upcoming_appointments: [],
    });
  });

  it('HAPPY: upcoming appointments ride along — the fact the model must never contradict (#8)', async () => {
    // WHO: Jaya (SCL_VcKTTgo4kS2v, 2026-07-27) — live 2:30 appointment,
    //      phone-matched, told "you don't have a booked time on file". THIS
    //      payload is how the model gets told before the first word.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'cust-jaya', name: 'Jaya' }] },
        { rows: [] }, // no summaries
        {
          rows: [
            {
              start_time: new Date('2026-07-27T19:30:00.000Z'),
              service: 'Programming Consultation',
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/customer-context', {
      tenant_id: TENANT_ID,
      phone: '7734487716',
      phone_source: 'caller_id',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.upcoming_appointments).toEqual([
      { start_time: '2026-07-27T19:30:00.000Z', service: 'Programming Consultation' },
    ]);
    // Scheduled + future + not-deleted only — a cancelled appointment in this
    // list would make the agent confirm a booking that no longer exists.
    const upcomingQ = queries.find((q) => q.text.includes('FROM appointments'))!;
    expect(upcomingQ.text).toContain("status = 'scheduled'");
    expect(upcomingQ.text).toContain('start_time > NOW()');
  });

  it('HAPPY: unknown customer returns "new caller" message', async () => {
    // WHO: First-time caller
    // WHAT: Route should short-circuit before the summaries query
    const { app, queries } = buildApp({
      queryResponses: [{ rows: [] }],
    });
    const res = await post(app, '/agent-tools/customer-context', {
      tenant_id: TENANT_ID,
      phone: '5550000000',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toBe('New caller - no history found.');
    expect(queries).toHaveLength(1); // did not run summaries query
  });

  it('SAD: unnormalizable phone short-circuits to new-caller message', async () => {
    // WHO: Caller-ID was garbled — passes Zod (min 5 chars) but has
    //       fewer than 10 digits so normalizePhone returns null
    // WHAT: No DB lookup; treat as new caller immediately
    // WHY: Avoids wasted round-trip and prevents "+1"-style short numbers
    //       from matching spurious customer records
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/customer-context', {
      tenant_id: TENANT_ID,
      phone: 'abc123',
    });
    expect(res.json().result).toBe('New caller - no history found.');
    expect(queries).toHaveLength(0);
  });
});

describe('agentTools /find-customer-by-name', () => {
  it('HAPPY: returns name + masked phone for a near-exact full-name match', async () => {
    // WHO: Caller on the forwarded line who gives their full name
    // WHAT: Route searches customers by name and returns {name, phone} matches
    //        so the agent can read back the number on file to confirm
    // WHERE: src/routes/agentTools/identity.ts /agent-tools/find-customer-by-name
    // WHEN: __PERSONA_NAME__ asks the caller's name on this forwarded inbound line
    // WHY: Caller ID is the forwarding cell, not the caller — name is the only
    //        trustworthy first identifier, so name-search is the entry point
    const { app, queries } = buildApp({
      queryResponses: [{ rows: [{ name: 'Jane Doe', phone: '+16135551234' }] }],
    });
    const res = await post(app, '/agent-tools/find-customer-by-name', {
      tenant_id: TENANT_ID,
      name: 'Jane Doe',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({
      matches: [{ name: 'Jane Doe', phone: '+1•••-•••-1234' }],
    });
    // WHY: only the normalized SURNAME reaches SQL — it is the prefilter; the
    //      first name is applied in-process by nameMatchesNearExactly()
    expect(queries[0].params).toEqual([TENANT_ID, 'doe']);
  });

  it('HAPPY: an honorific and punctuation do not break a real match', async () => {
    // WHO: "Mrs. Jane Doe" — how a caller actually introduces themselves
    // WHAT: the honorific is stripped, punctuation deleted, and the remaining
    //        two parts still match the stored name near-exactly
    // WHY: the tightened match must reject fragments, not real callers
    const { app, queries } = buildApp({
      queryResponses: [{ rows: [{ name: 'Jane Doe', phone: '+16135551234' }] }],
    });
    const res = await post(app, '/agent-tools/find-customer-by-name', {
      tenant_id: TENANT_ID,
      name: 'Mrs. Jane Doe',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({
      matches: [{ name: 'Jane Doe', phone: '+1•••-•••-1234' }],
    });
    expect(queries[0].params).toEqual([TENANT_ID, 'doe']);
  });

  it('HAPPY: a middle name on either side still matches (first + last decide)', async () => {
    // WHO: stored as "Jane Quilla Doe", caller says "Jane Doe"
    // WHY: near-exact must not mean brittle — a middle name or suffix is
    //      exactly the kind of drift a stored CRM row carries
    const { app } = buildApp({
      queryResponses: [{ rows: [{ name: 'Jane Quilla Doe', phone: '+16135551234' }] }],
    });
    const res = await post(app, '/agent-tools/find-customer-by-name', {
      tenant_id: TENANT_ID,
      name: 'Jane Doe',
    });
    expect(res.json().result).toEqual({
      matches: [{ name: 'Jane Quilla Doe', phone: '+1•••-•••-1234' }],
    });
  });

  it('SECURITY: a bare surname returns nothing and never reaches SQL', async () => {
    // WHO: anyone probing the tenant's address book with a common surname
    // WHAT: one token is refused before withTenantClient is ever called
    // WHY: THE enumeration bug (docs/TODO.md P0 §4b). "Doe" used to return up
    //      to five real customers plus the last four digits of their phones,
    //      with the guessed surname as the only credential. The caller must
    //      now already know both name parts, which makes this a confirmation
    //      of an identity they supplied, not a disclosure of one they guessed.
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/find-customer-by-name', {
      tenant_id: TENANT_ID,
      name: 'Doe',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({ matches: [] });
    expect(queries).toHaveLength(0);
  });

  it('SECURITY: a bare first name is refused the same way', async () => {
    // WHY: "Michael" is as cheap a probe as "Doe"; the rule is about the
    //      NUMBER of name parts, not which part it is
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/find-customer-by-name', {
      tenant_id: TENANT_ID,
      name: 'Michael',
    });
    expect(res.json().result).toEqual({ matches: [] });
    expect(queries).toHaveLength(0);
  });

  it('SECURITY: one-letter name probes return nothing instead of sweeping the address book', async () => {
    // WHO: anyone trying a single common letter like "a"
    // WHAT: the route must refuse to turn one-character probes into broad
    //        customer enumeration across the tenant's address book
    // WHY: a one-letter search plus phone numbers is the exact over-disclosure
    //      called out in TODO.md — it is too cheap to be useful and too noisy to
    //      be safe
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/find-customer-by-name', {
      tenant_id: TENANT_ID,
      name: 'a',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({ matches: [] });
    expect(queries).toHaveLength(0);
  });

  it('SECURITY: initials-only input stays under the 4-character floor', async () => {
    // WHO: "J D" — two tokens, so it clears the part count, and still must not
    //        reach SQL
    // WHY: the 4-character floor added 2026-08-07 is kept on top of the
    //      two-part rule; neither gate alone covers this shape
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/find-customer-by-name', {
      tenant_id: TENANT_ID,
      name: 'J D',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({ matches: [] });
    expect(queries).toHaveLength(0);
  });

  it('SECURITY: a prefilter row whose FIRST name differs is dropped in-process', async () => {
    // WHO: two unrelated customers share the surname "Doe"
    // WHAT: the SQL prefilter is surname-only by design, so the precise rule
    //        runs in TypeScript; only the row whose first name also matches
    //        may be returned
    // WHY: without the in-process filter the tightened SQL would still hand
    //      back every "Doe" in the tenant — the enumeration this fix closes
    const { app } = buildApp({
      queryResponses: [
        {
          rows: [
            { name: 'John Doe', phone: '+16135550000' },
            { name: 'Jane Doe', phone: '+16135551234' },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/find-customer-by-name', {
      tenant_id: TENANT_ID,
      name: 'Jane Doe',
    });
    expect(res.json().result).toEqual({
      matches: [{ name: 'Jane Doe', phone: '+1•••-•••-1234' }],
    });
  });

  it('HAPPY: no match returns an empty list (signal to create a new entry)', async () => {
    // WHO: First-time caller whose name is not in the CRM
    // WHAT: Empty matches array, not an error — the agent treats them as new
    // WHY: An empty list is the explicit "new caller, create an entry" signal
    const { app } = buildApp({ queryResponses: [{ rows: [] }] });
    const res = await post(app, '/agent-tools/find-customer-by-name', {
      tenant_id: TENANT_ID,
      name: 'Nobody Known',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({ matches: [] });
  });
});

describe('agentTools /identify-caller', () => {
  it('is_correction lets THIS CALL fix a name it got wrong — and nothing else can', async () => {
    // WHO: the caller whose name we heard as "Jamil" and who corrected it.
    // WHAT: the upsert's CASE normally protects a real (non-placeholder) name
    //        from being overwritten — that is what stops a later caller
    //        renaming an established customer by simply claiming to be them.
    //        is_correction opens that door for exactly one case: a name THIS
    //        call wrote, which the caller then changed.
    // WHY: without it a mishearing was permanent (CALL_IMPROVEMENTS.md #2);
    //       with it unscoped, the phone book would be rewritable by anyone who
    //       dials the number — the claim-based trust the OTP binding destroys.
    const { app, queries } = buildApp({
      queryResponses: [{ rows: [{ customer_id: 'cust-1', is_new: false, name: 'Camille' }] }],
    });
    const res = await post(app, '/agent-tools/identify-caller', {
      tenant_id: TENANT_ID,
      phone: '2624979039',
      name: 'Camille',
      phone_source: 'caller_id',
      is_correction: true,
    });
    expect(res.statusCode).toBe(200);
    const upsert = queries.find((q) => q.text.includes('INSERT INTO customers'))!;
    expect(upsert.text).toContain('$5::boolean IS TRUE');
    expect(upsert.params[4]).toBe(true);
  });

  it('a correction with NO name cannot blank an existing record', async () => {
    // The flag only unlocks an overwrite when there is something to write.
    const { app, queries } = buildApp({
      queryResponses: [{ rows: [{ customer_id: 'cust-1', is_new: false, name: 'Camille' }] }],
    });
    await post(app, '/agent-tools/identify-caller', {
      tenant_id: TENANT_ID,
      phone: '2624979039',
      phone_source: 'caller_id',
      is_correction: true,
    });
    const upsert = queries.find((q) => q.text.includes('INSERT INTO customers'))!;
    expect(upsert.params[4]).toBe(false);
  });

  it('HAPPY: new phone creates a customer row', async () => {
    // WHO: First-time caller who gives their name during a non-booking call
    // WHAT: Route inserts a new customer row via ON CONFLICT upsert
    // WHERE: src/routes/agentTools.ts /agent-tools/identify-caller
    // WHEN: Agent calls identify_caller tool as soon as caller says their name
    // WHY: Previously, callers who didn't book were never saved to the address book
    const { app, queries } = buildApp({
      queryResponses: [{ rows: [] }], // INSERT (ON CONFLICT) returns nothing
    });
    const res = await post(app, '/agent-tools/identify-caller', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'Dale DeMott',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
    expect(queries).toHaveLength(1);
    expect(queries[0].text).toContain('INSERT INTO customers');
    expect(queries[0].text).toContain('ON CONFLICT');
    // $4 is the SHARED placeholder list (customerLookup.PLACEHOLDER_NAMES). It
    // must include 'Caller' — scheduling.ts writes that name on every nameless
    // booking, and until 2026-07-13 this upsert's CASE didn't know about it, so
    // the name could never be corrected afterwards.
    expect(queries[0].params).toEqual([
      TENANT_ID,
      '+15551234567',
      'Dale DeMott',
      ['Valued Customer', 'Caller', 'Unknown'],
      // $5 — the mid-call correction flag (2026-08-01). False on a first save;
      // only the agent's host code sets it, and only when THIS call already
      // wrote a name that the caller then changed.
      false,
    ]);
  });

  it('HAPPY: with call_id, links the captured number + customer onto the voice_sessions row', async () => {
    // WHO: a forwarded-line caller (voice_sessions.caller_phone started null)
    //       who gives their number verbally mid-call.
    // WHAT: identify-caller upserts the customer (RETURNING customer_id) AND
    //        backfills voice_sessions.caller_phone + customer_id for that call_id
    //        so the Calls tab row/detail show the verbally-captured number.
    // WHERE: POST /agent-tools/identify-caller → src/routes/agentTools.ts (the
    //        UPDATE voice_sessions backfill branch, gated on args.call_id).
    // WHEN: mid-call, right after __PERSONA_NAME__ collects + reads back the spoken number.
    // WHY: without this, the number was saved to customers but the call record
    //       still showed "new caller / no number" (Dale's observation).
    const { app, queries } = buildApp({
      queryResponses: [
        // is_new:true — a first-time caller, so no preference load follows.
        { rows: [{ customer_id: 'cust-1', is_new: true, name: 'Bob Jones' }] },
        { rows: [], rowCount: 1 }, // UPDATE voice_sessions
      ],
    });
    const res = await post(app, '/agent-tools/identify-caller', {
      tenant_id: TENANT_ID,
      phone: '3128651186',
      name: 'Bob Jones',
      call_id: 'SCL_abc',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
    expect(res.json().result).toMatchObject({ returning_customer: false });
    expect(queries).toHaveLength(2);
    expect(queries[1].text).toContain('UPDATE voice_sessions');
    expect(queries[1].params).toEqual([TENANT_ID, 'SCL_abc', '+13128651186', 'cust-1']);
  });

  it('SECURITY: a SPOKEN number that is already ours reveals NOTHING until OTP-verified', async () => {
    // WHO: anyone who knows (or guesses) a customer's phone number.
    // WHAT: on a forwarded/blocked call there is no caller-ID, so the number is
    //        whatever the caller SAYS. This test used to assert we hand back her
    //        name, preferences and history on that basis alone — which is a data
    //        leak dressed up as a feature (introduced 2026-07-12, closed 2026-07-13).
    // WHY: the gate must default CLOSED. Note this request omits phone_source
    //       entirely, so it falls back to 'spoken' — a forgotten parameter must not
    //       silently re-open the leak.
    const { app, queries } = buildApp({
      queryResponses: [
        // is_new:false → we DO know this number...
        { rows: [{ customer_id: 'cust-9', is_new: false, name: 'Reba' }] },
        { rows: [], rowCount: 1 }, // voice_sessions backfill
        { rows: [], rowCount: 0 }, // ...but NO verified phone_verifications row
      ],
    });
    const res = await post(app, '/agent-tools/identify-caller', {
      tenant_id: TENANT_ID,
      phone: '3128651186',
      name: 'Reba',
      call_id: 'SCL_fwd',
      // phone_source deliberately omitted → defaults to the SAFE value
    });

    expect(res.statusCode).toBe(200);
    const result = res.json().result;
    expect(result.saved).toBe(true); // contact still saved — writing is not leaking
    expect(result.returning_customer).toBe(false);
    expect(result.requires_verification).toBe(true);
    expect(result.name).toBeUndefined();
    expect(result.preferences).toBeUndefined();
    expect(result.history).toBeUndefined();
    // The "please verify" message must not name her either — that would leak the
    // very thing we are protecting.
    expect(JSON.stringify(result)).not.toMatch(/Reba/i);
    // It checked phone_verifications and stopped there: no preference/history reads.
    expect(queries[2].text).toContain('phone_verifications');
    expect(queries.some((q) => q.text.includes('customer_preferences'))).toBe(false);
  });

  it('SAD: a returning row with NOTHING saved on it reports returning_customer:false', async () => {
    // WHY: a customer row that exists but carries no preferences and no call
    //       history is, to the caller, indistinguishable from a new one. Claiming
    //       "welcome back" with nothing to back it up is worse than saying nothing
    //       — the agent would sound like it remembers them and then have zero to
    //       show for it.
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'cust-9', is_new: false, name: 'Ghost' }] },
        { rows: [{ preferences: {} }] },
        { rows: [] }, // no call summaries
      ],
    });
    const res = await post(app, '/agent-tools/identify-caller', {
      tenant_id: TENANT_ID,
      phone: '3128651186',
      name: 'Ghost',
      // Carrier-attested caller-ID: this test is about the EMPTY-RECORD case, not
      // the disclosure gate. Without this it defaults to 'spoken' and (correctly)
      // gets requires_verification back instead, which would be testing the gate
      // twice and this behavior not at all.
      phone_source: 'caller_id',
    });

    expect(res.statusCode).toBe(200);
    // returning_customer:false — nothing to SAY OUT LOUD about them.
    // sms_consent still rides along: a customer can have agreed to texts without
    // ever leaving a preference or a call summary, and re-asking them is exactly
    // the pestering this field exists to stop. Different questions.
    expect(res.json().result).toEqual({
      saved: true,
      returning_customer: false,
      sms_consent: false,
    });
  });

  it('HAPPY: existing customer with placeholder name gets name updated', async () => {
    // WHO: Returning caller who finally gives their name
    // WHAT: ON CONFLICT DO UPDATE SET name only when stored name is blank/placeholder
    // WHY: The CASE expression in the upsert leaves real names untouched
    const { app, queries } = buildApp({
      queryResponses: [{ rows: [] }], // upsert: UPDATE path, no row returned
    });
    const res = await post(app, '/agent-tools/identify-caller', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'Bob Smith',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
    // Same upsert query handles both create and name-update paths
    expect(queries[0].text).toMatch(/ON CONFLICT.*DO UPDATE/s);
    // The placeholder set is now the SHARED PLACEHOLDER_NAMES list, passed as a
    // parameter — not a hardcoded 'Valued Customer' literal in the SQL.
    //
    // That literal WAS the bug: scheduling.ts writes 'Caller' on every nameless
    // booking, this CASE only knew 'Valued Customer', so a caller who booked
    // before giving their name was stuck as "Caller" FOREVER — and the prefetch
    // greeted them that way on every future call. Asserting the literal here is
    // what let the two write paths drift apart in the first place, so assert the
    // CONTRACT instead: the guard covers every placeholder we know about,
    // including 'Caller'.
    expect(queries[0].text).toMatch(/customers\.name = ANY\(\$4::text\[\]\)/);
    expect(queries[0].params?.[3]).toContain('Caller');
    expect(queries[0].params?.[3]).toContain('Valued Customer');
  });

  it('HAPPY: phone normalized before upsert', async () => {
    // WHO: Agent passes raw 10-digit phone; must reach DB as E.164
    // WHAT: normalizePhone runs before the INSERT so "+1" prefix is added
    // WHY: Consistent format required to match existing rows (same contract as booking)
    const { app, queries } = buildApp({ queryResponses: [{ rows: [] }] });
    await post(app, '/agent-tools/identify-caller', {
      tenant_id: TENANT_ID,
      phone: '5559876543',
      name: 'Jane Doe',
    });
    expect(queries[0].params?.[1]).toBe('+15559876543');
  });

  it('SAD: invalid phone returns error without touching DB', async () => {
    // WHO: Garbled caller-ID — too short to normalize
    // WHAT: Route rejects before any DB query
    // WHY: Avoids inserting a customer row with an unusable phone number
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/identify-caller', {
      tenant_id: TENANT_ID,
      phone: 'abc',
      name: 'Bad Phone',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(false);
    expect(queries).toHaveLength(0);
  });
});

describe('agentTools /capture-job-inquiry', () => {
  // The mock is module-level; reset call history + default to a resolving
  // send before each test so one test's expectations don't leak into another.
  beforeEach(() => {
    vi.mocked(sendJobInquiryEmail).mockReset();
    vi.mocked(sendJobInquiryEmail).mockResolvedValue(undefined);
  });

  it('HAPPY: contract inquiry inserts the row and emails the resolved recipient', async () => {
    // WHO: a recruiter who gave a callback number and full contract details.
    // WHAT: route looks up customer by callback phone, INSERTs job_inquiries,
    //        resolves the recipient (job_inquiry_email), and emails it.
    // WHY: Dale must receive the structured inquiry; the call must not freeze.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [] }, // customer lookup by callback phone — none
        { rows: [{ customer_id: 'cust-new' }] }, // INSERT INTO customers (get-or-create)
        { rows: [{ submission_id: 'sub-1' }] }, // INSERT INTO intake_submissions
        { rows: [{ job_inquiry_id: 'ji-1' }] }, // INSERT ... RETURNING
        { rows: [{ email: 'DaleDeMott@thinkinghammer.com' }] }, // recipient resolve
      ],
    });
    const res = await post(app, '/agent-tools/capture-job-inquiry', {
      tenant_id: TENANT_ID,
      caller_name: 'Rhonda Recruiter',
      callback_phone: '3128651186',
      caller_company: 'Acme Corp',
      client_company: 'Globex Health',
      represents_company: false,
      employment_type: 'contract',
      role_description: 'senior Azure/M365 developer — cloud-native and integration work',
      rate_range: '$120-140/hr',
      duration: '6 months',
      location_type: 'remote',
      timezone: 'America/Chicago',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, result: { email_queued: true } });
    expect(queries[2].text).toContain('INSERT INTO intake_submissions');
    expect(String(queries[2].params[7])).toContain('senior Azure/M365 developer');
    expect(queries[3].text).toContain('INSERT INTO job_inquiries');
    // The 2026-07-30 prod loss: the role itself must land in the ROW, not just
    // the transcript — column + placeholder in the INSERT, verbatim in values.
    expect(queries[3].text).toContain('role_description');
    expect(queries[3].params).toContain(
      'senior Azure/M365 developer — cloud-native and integration work'
    );
    expect(vi.mocked(sendJobInquiryEmail)).toHaveBeenCalledWith(
      'DaleDeMott@thinkinghammer.com',
      expect.objectContaining({
        callerCompany: 'Acme Corp',
        clientCompany: 'Globex Health',
        employmentType: 'contract',
        roleDescription: 'senior Azure/M365 developer — cloud-native and integration work',
        duration: '6 months',
        locationType: 'remote',
        timezone: 'America/Chicago',
        callbackPhone: '+13128651186',
      })
    );
  });

  it('SAD: NO CALLBACK PHONE is refused outright — nothing is written', async () => {
    // CONTRACT CHANGE, 2026-07-14. This test used to be "full-time inquiry with no
    // callback phone skips the customer lookup" — it asserted that a phoneless inquiry
    // saved happily, just without a customer link. That contract is exactly what let a
    // real call save a six-month Blue Cross contract at $65-72/hr under the placeholder
    // name "Caller" with no phone number, after which the agent told the caller "I now
    // have all the information I need."
    //
    // It did not. It had a lead nobody could answer. The "skip the customer lookup"
    // path it was protecting is now unreachable by design, so the test that guarded it
    // is replaced by the one that matters: the route REFUSES, and writes NOTHING.
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/capture-job-inquiry', {
      tenant_id: TENANT_ID,
      caller_name: 'Frank FullTime',
      client_company: 'Globex',
      employment_type: 'full_time',
      rate_range: '$180k-200k',
    });
    expect(res.statusCode).toBe(200); // agent-tools speak failure at 200
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/number/i);
    expect(queries).toHaveLength(0); // no half-row left behind
    expect(vi.mocked(sendJobInquiryEmail)).not.toHaveBeenCalled();
  });

  it('HAPPY: a full-time inquiry with a number lands and emails the owner', async () => {
    // WHO: a caller about a full-time role who left no callback number.
    // WHAT: with no callback phone the customer-lookup query is skipped, so the
    //        A callback number is now REQUIRED, so the customer lookup always runs:
    //        lookup → INSERT → resolve recipient.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [] }, // customer lookup by callback phone — no match
        { rows: [{ customer_id: 'cust-new' }] }, // INSERT INTO customers (get-or-create)
        { rows: [{ submission_id: 'sub-2' }] }, // INSERT INTO intake_submissions
        { rows: [{ job_inquiry_id: 'ji-2' }] }, // INSERT
        { rows: [{ email: 'owner@example.com' }] }, // recipient (fell back to owner email)
      ],
    });
    const res = await post(app, '/agent-tools/capture-job-inquiry', {
      tenant_id: TENANT_ID,
      caller_name: 'Frank FullTime',
      callback_phone: '3125552222',
      client_company: 'Globex',
      employment_type: 'full_time',
      rate_range: '$180k-200k',
      location_type: 'onsite',
      address: '1 Globex Plaza, Chicago IL',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, result: { email_queued: true } });
    // 5 queries now: lookup MISS creates the customer, generic intake envelope lands,
    // then the specialized job_inquiries projection and recipient resolve.
    expect(queries).toHaveLength(5);
    expect(queries[2].text).toContain('INSERT INTO intake_submissions');
    expect(queries[3].text).toContain('INSERT INTO job_inquiries');
    expect(vi.mocked(sendJobInquiryEmail)).toHaveBeenCalledWith(
      'owner@example.com',
      expect.objectContaining({
        employmentType: 'full_time',
        address: '1 Globex Plaza, Chicago IL',
      })
    );
  });

  it('SAD: email send failure still saves the inquiry and returns success (fire-and-forget)', async () => {
    // WHO: a valid inquiry where SMTP / the transporter throws.
    // WHAT: the send is fire-and-forget since 2026-07-17, so the response is
    //        already gone when the rejection lands — the route reports
    //        email_queued:true (a send was STARTED; delivery is not knowable at
    //        reply time) and the async catch logs the failure without touching
    //        the reply. The call must NOT fail because the notification didn't
    //        go out.
    vi.mocked(sendJobInquiryEmail).mockRejectedValueOnce(new Error('SMTP unavailable'));
    const { app } = buildApp({
      queryResponses: [
        // The old queue here skipped the customer lookup, so every later
        // response was off by one and the recipient resolved to null — the
        // pre-2026-07-17 version of this test passed VACUOUSLY (emailed:false
        // because no email was ever attempted, not because the failure was
        // handled). Queue now matches the route's actual query order.
        { rows: [] }, // customer lookup by callback phone
        { rows: [{ customer_id: 'cust-new' }] }, // INSERT INTO customers (get-or-create)
        { rows: [{ submission_id: 'sub-3' }] }, // INSERT INTO intake_submissions
        { rows: [{ job_inquiry_id: 'ji-3' }] }, // INSERT
        { rows: [{ email: 'DaleDeMott@thinkinghammer.com' }] }, // recipient
      ],
    });
    const res = await post(app, '/agent-tools/capture-job-inquiry', {
      tenant_id: TENANT_ID,
      caller_name: 'Erin Error',
      callback_phone: '3125551111',
      client_company: 'Initech',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      result: { saved: true, email_queued: true },
    });
    // Let the rejected promise's catch handler run so the unhandled-rejection
    // detector (vitest) sees it handled.
    await new Promise((r) => setImmediate(r));
  });

  it('SAD: a HUNG email transport cannot delay the reply (2026-07-17 regression)', async () => {
    // WHO: the 2026-07-17 live caller ("Steven Bob"). WHAT: prod SMTP was
    //       unreachable (IPv6 ENETUNREACH to Gmail:465 — 60-120s per attempt)
    //       and the send was AWAITED, so every capture blew the agent's 8s tool
    //       timeout; the job-intake rung retried and wrote FOUR duplicate
    //       inquiries while the caller was told "having issues writing to the
    //       system". WHY: a voice tool's reply must return the moment the row
    //       is durable — a never-resolving send must not hold it hostage.
    vi.mocked(sendJobInquiryEmail).mockImplementationOnce(() => new Promise(() => {}));
    const { app } = buildApp({
      queryResponses: [
        { rows: [] }, // customer lookup
        { rows: [{ customer_id: 'cust-new' }] }, // INSERT INTO customers (get-or-create)
        { rows: [{ submission_id: 'sub-hang' }] }, // INSERT INTO intake_submissions
        { rows: [{ job_inquiry_id: 'ji-hang' }] }, // INSERT
        { rows: [{ email: 'DaleDeMott@thinkinghammer.com' }] }, // recipient
      ],
    });
    const started = Date.now();
    const res = await post(app, '/agent-tools/capture-job-inquiry', {
      tenant_id: TENANT_ID,
      caller_name: 'Steven Bob',
      callback_phone: '3125553333',
      client_company: 'CBO',
      caller_company: 'XYZ Consulting',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, result: { saved: true } });
    // Generous bound (review on #280: CI jitter makes tight wall-clock bounds
    // flaky): the point is "returns without awaiting a send that never
    // resolves" — any finite bound proves that; 5s stays under the agent's 8s
    // tool timeout this test exists to protect.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('HAPPY: a RETRY on the same call returns the EXISTING inquiry — no duplicate row, no second email', async () => {
    // WHO: the job-intake rung retrying after a tool timeout — its contract is
    //       to retry until it holds a job_inquiry_id, so the tool MUST be
    //       idempotent per call. On 2026-07-17 it wasn't: four retries, four
    //       identical rows, four "Job details:" stamps on one appointment.
    // WHAT: same (tenant, call_id) already has an inquiry → return its id,
    //        write nothing, email nobody, and say duplicate.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ job_inquiry_id: 'ji-first' }] }, // dedupe lookup — HIT
        { rows: [{ email: 'DaleDeMott@thinkinghammer.com', owner_name: 'Dale' }] }, // recipient (for the spoken message)
      ],
    });
    const res = await post(app, '/agent-tools/capture-job-inquiry', {
      tenant_id: TENANT_ID,
      caller_name: 'Steven Bob',
      callback_phone: '3125553333',
      client_company: 'CBO',
      call_id: 'room:sim-call-retry',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      result: { saved: true, job_inquiry_id: 'ji-first', email_queued: false },
    });
    // Nothing after the dedupe lookup + recipient resolve: no INSERT, no stamp.
    expect(queries.map((q) => q.text.trim().split(/\s+/)[0])).toEqual(['SELECT', 'SELECT']);
    expect(vi.mocked(sendJobInquiryEmail)).not.toHaveBeenCalled();
  });

  it('HAPPY: a CONCURRENT retry that loses the INSERT race still gets the winning id (ON CONFLICT path)', async () => {
    // WHO: two in-flight retries of the same call (the live failure: each
    //       request sat 60-120s behind a hung email, so retries overlapped and
    //       BOTH passed the fast-path dedupe SELECT before either INSERT).
    // WHAT: the job_inquiries_one_per_call unique index makes the second
    //        INSERT return zero rows (ON CONFLICT DO NOTHING); the route then
    //        looks up the winner and returns ITS id — no stamp, no email from
    //        the loser. Review catch on #280: a SELECT-only dedupe cannot be
    //        atomic; the index is the layer that cannot race.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [] }, // fast-path dedupe SELECT — no committed row YET
        { rows: [] }, // customer lookup
        { rows: [{ customer_id: 'cust-new' }] }, // INSERT INTO customers (get-or-create)
        { rows: [{ submission_id: 'sub-race' }] }, // INSERT INTO intake_submissions
        { rows: [] }, // INSERT ... ON CONFLICT DO NOTHING — lost the race, zero rows
        { rows: [{ job_inquiry_id: 'ji-winner' }] }, // winner lookup
        { rows: [{ email: 'DaleDeMott@thinkinghammer.com', owner_name: 'Dale' }] }, // recipient
      ],
    });
    const res = await post(app, '/agent-tools/capture-job-inquiry', {
      tenant_id: TENANT_ID,
      caller_name: 'Steven Bob',
      callback_phone: '3125553333',
      client_company: 'CBO',
      call_id: 'room:sim-call-race',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      result: { saved: true, job_inquiry_id: 'ji-winner', email_queued: false },
    });
    // The loser must not stamp the appointment or email the owner.
    expect(queries.some((q) => q.text.includes('UPDATE appointments'))).toBe(false);
    expect(vi.mocked(sendJobInquiryEmail)).not.toHaveBeenCalled();
  });

  it('SAD: no recipient configured saves the inquiry but does not email', async () => {
    // WHO: a tenant with neither job_inquiry_email nor an owner email.
    // WHAT: recipient resolves to null → route does not call the email sender,
    //        increments job_inquiry_no_recipient, and returns email_queued:false.
    const { app } = buildApp({
      queryResponses: [
        { rows: [] }, // customer lookup by callback phone (queue was off by one pre-2026-07-17)
        { rows: [{ customer_id: 'cust-new' }] }, // INSERT INTO customers (get-or-create)
        { rows: [{ submission_id: 'sub-4' }] }, // INSERT INTO intake_submissions
        { rows: [{ job_inquiry_id: 'ji-4' }] }, // INSERT
        { rows: [{ email: null }] }, // recipient resolve — none
      ],
    });
    const res = await post(app, '/agent-tools/capture-job-inquiry', {
      tenant_id: TENANT_ID,
      caller_name: 'Nora NoEmail',
      callback_phone: '3125553333',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, result: { email_queued: false } });
    expect(vi.mocked(sendJobInquiryEmail)).not.toHaveBeenCalled();
  });

  it('SAD: invalid employment_type enum is rejected before any DB write', async () => {
    // WHO: a malformed tool call (LLM emitted an out-of-enum value).
    // WHAT: Zod rejects it → success:false, no queries run, no email sent.
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/capture-job-inquiry', {
      tenant_id: TENANT_ID,
      caller_name: 'Val Validation',
      employment_type: 'permanent', // not 'contract' | 'full_time'
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('employment_type');
    expect(queries).toHaveLength(0);
    expect(vi.mocked(sendJobInquiryEmail)).not.toHaveBeenCalled();
  });

  it('HAPPY: appointment_id links the inquiry to the meeting AND stamps a job summary on it', async () => {
    // WHO: a "meeting about a job" call — the booking rung already booked, and the agent
    //       runtime injected the appointment id from the call-outcome tracker.
    // WHAT: the route verifies the appointment belongs to this tenant, INSERTs the
    //        inquiry WITH the link, and appends a readable summary to the appointment's
    //        description — so the calendar entry says what the meeting is ABOUT.
    // WHY: before this, the owner saw a meeting on the calendar and a job inquiry in
    //      another list, and had to correlate them by call.
    const APPT = 'b7e42a10-92c4-4f7a-9a2d-52e9c1a4b3d6';
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [] }, // customer lookup by callback phone — none
        { rows: [{ customer_id: 'cust-new' }] }, // INSERT INTO customers (get-or-create)
        { rows: [{ appointment_id: APPT }] }, // appointment belongs to tenant
        { rows: [{ submission_id: 'sub-5' }] }, // INSERT INTO intake_submissions
        { rows: [{ job_inquiry_id: 'ji-5' }] }, // INSERT ... RETURNING
        { rows: [], rowCount: 1 }, // description stamp UPDATE
        { rows: [{ email: 'owner@example.com' }] }, // recipient resolve
      ],
    });
    const res = await post(app, '/agent-tools/capture-job-inquiry', {
      tenant_id: TENANT_ID,
      caller_name: 'Rhonda Recruiter',
      callback_phone: '3128651186',
      caller_company: 'Insight Global',
      client_company: 'Blue Cross',
      represents_company: false,
      employment_type: 'contract',
      rate_range: '$65-82/hr',
      duration: '6 months',
      location_type: 'hybrid',
      address: '300 Randolph St',
      appointment_id: APPT,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, result: { saved: true } });
    const insert = queries.find((q) => q.text.includes('INSERT INTO job_inquiries'))!;
    expect(insert.text).toContain('appointment_id');
    // $16 since role_description joined the column list (2026-07-30).
    expect(insert.params[15], 'the link rides the INSERT as $16').toBe(APPT);
    const stamp = queries.find((q) => q.text.includes('UPDATE appointments'))!;
    expect(stamp.params[1]).toBe(APPT);
    expect(stamp.params[2]).toBe(
      'Job details: contract, $65-82/hr, 6 months, hybrid at 300 Randolph St — work at Blue Cross via Insight Global.'
    );
  });

  it('SAD: appointment vanishes between the verify SELECT and the stamp UPDATE → inquiry still saved, miss observable', async () => {
    // WHO: capture-job-inquiry racing a deletion — the SELECT proved the appointment
    //       live, nothing holds that true until the UPDATE.
    // WHAT: the stamp UPDATE filters is_deleted = false and affects zero rows; the
    //        route must still report saved (the inquiry row is the lead) — the lost
    //        stamp surfaces as a metric + warn, never a silent nothing.
    const APPT = 'b7e42a10-92c4-4f7a-9a2d-52e9c1a4b3d6';
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [] }, // customer lookup
        { rows: [{ customer_id: 'cust-new' }] }, // INSERT INTO customers (get-or-create)
        { rows: [{ appointment_id: APPT }] }, // appointment verifies live
        { rows: [{ submission_id: 'sub-7' }] }, // INSERT INTO intake_submissions
        { rows: [{ job_inquiry_id: 'ji-7' }] }, // INSERT ... RETURNING
        { rows: [], rowCount: 0 }, // stamp UPDATE — appointment gone
        { rows: [{ email: null }] }, // recipient resolve — none
      ],
    });
    const res = await post(app, '/agent-tools/capture-job-inquiry', {
      tenant_id: TENANT_ID,
      caller_name: 'Rhonda Recruiter',
      callback_phone: '3128651186',
      client_company: 'Blue Cross',
      appointment_id: APPT,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, result: { saved: true } });
    const stamp = queries.find((q) => q.text.includes('UPDATE appointments'))!;
    expect(stamp.text, 'the stamp must skip soft-deleted appointments').toContain(
      'is_deleted = false'
    );
  });

  it("SAD: an appointment_id that is not this tenant's live appointment saves the inquiry UNLINKED", async () => {
    // The id arrives from the agent runtime, so a miss is a bug — but the row is the
    // LEAD and the link is just context: save unlinked (+ metric + 5W warn), never lose
    // the inquiry, and never stamp someone else's appointment.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [] }, // customer lookup
        { rows: [{ customer_id: 'cust-new' }] }, // INSERT INTO customers (get-or-create)
        { rows: [] }, // appointment check — no match for this tenant
        { rows: [{ submission_id: 'sub-6' }] }, // INSERT INTO intake_submissions
        { rows: [{ job_inquiry_id: 'ji-6' }] }, // INSERT still lands
        { rows: [{ email: null }] }, // recipient resolve — none
      ],
    });
    const res = await post(app, '/agent-tools/capture-job-inquiry', {
      tenant_id: TENANT_ID,
      caller_name: 'Orla Orphan',
      callback_phone: '3125554444',
      client_company: 'Initech',
      appointment_id: 'b7e42a10-92c4-4f7a-9a2d-52e9c1a4b3d6',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, result: { saved: true } });
    const insert = queries.find((q) => q.text.includes('INSERT INTO job_inquiries'))!;
    expect(insert.params[14], 'no verified appointment → NULL link').toBeNull();
    expect(
      queries.find((q) => q.text.includes('UPDATE appointments')),
      'no stamp lands on an unverified appointment'
    ).toBeUndefined();
  });
});

describe('agentTools /attach-meeting-notes', () => {
  const APPT = 'b7e42a10-92c4-4f7a-9a2d-52e9c1a4b3d6';

  it("HAPPY: appends the caller's note to the appointment description", async () => {
    // WHO: the meeting-goals rung's one wrap-up question, answered.
    // WHAT: first checks for an existing meeting_notes envelope for this appointment/note,
    //        then INSERTs when absent, then appends "Caller notes: …" to description.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ appointment_id: APPT, description: '' }] },
        { rows: [] },
        { rows: [{ submission_id: 'sub-note-1' }] },
        { rows: [{ appointment_id: APPT }], rowCount: 1 },
      ],
    });
    const res = await post(app, '/agent-tools/attach-meeting-notes', {
      tenant_id: TENANT_ID,
      appointment_id: APPT,
      notes: 'bring the contract paperwork',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      result: { appointment_id: APPT },
    });
    expect(queries[1].text).toContain('SELECT submission_id FROM intake_submissions');
    expect(queries[2].text).toContain('INSERT INTO intake_submissions');
    expect(queries[2].params[2]).toBe('meeting_notes');
    expect(queries[3].text).toContain('UPDATE appointments');
    expect(queries[3].text).toContain('description');
    expect(queries[3].params[2]).toBe('Caller notes: bring the contract paperwork');
  });

  it('HAPPY: a multi-line note is flattened to one line before stamping', async () => {
    // WHO: the model answering the wrap-up question with a multi-line string.
    // WHAT: the stamp must stay ONE line — splitCallContext() parses the description
    //        line-by-line, so a newline inside the note would spill the remainder into
    //        the service headline (and the edit panel's service field).
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ appointment_id: APPT }] },
        { rows: [{ submission_id: 'sub-note-2' }] },
        { rows: [{ appointment_id: APPT }], rowCount: 1 },
      ],
    });
    const res = await post(app, '/agent-tools/attach-meeting-notes', {
      tenant_id: TENANT_ID,
      appointment_id: APPT,
      notes: 'bring the contract paperwork\nand the  rate\tsheet\n',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(queries[2].params[2]).toBe(
      'Caller notes: bring the contract paperwork and the rate sheet'
    );
  });

  it('SAD: unknown or deleted appointment → honest refusal, nothing reported saved', async () => {
    // assertRowAffected-style honesty: no live appointment means nothing lands.
    const { app } = buildApp({ queryResponses: [{ rows: [] }] });
    const res = await post(app, '/agent-tools/attach-meeting-notes', {
      tenant_id: TENANT_ID,
      appointment_id: APPT,
      notes: 'anything',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/nothing was saved/i);
  });

  it('SAD: if the appointment vanishes after the intake save, the failure stays honest', async () => {
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ appointment_id: APPT, description: '' }] },
        { rows: [{ submission_id: 'sub-note-race' }] },
        { rows: [], rowCount: 0 },
      ],
    });
    const res = await post(app, '/agent-tools/attach-meeting-notes', {
      tenant_id: TENANT_ID,
      appointment_id: APPT,
      notes: 'bring the contract paperwork',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/saved the note for the owner/i);
    expect(res.json().error).toMatch(/couldn't attach it to that meeting/i);
  });

  it('SAD: blank notes are rejected before any DB write', async () => {
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/attach-meeting-notes', {
      tenant_id: TENANT_ID,
      appointment_id: APPT,
      notes: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('notes');
    expect(queries).toHaveLength(0);
  });
});

describe('agentTools /check-availability', () => {
  it('HAPPY: RPC returns available=true with local times', async () => {
    // WHO: Agent checking if 2pm next Friday is open
    // WHAT: First query fetches tenant timezone; second calls the RPC
    //        with zone-applied timestamps
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ timezone: 'America/Chicago' }] },
        {
          rows: [
            {
              available: true,
              tenant_timezone: 'America/Chicago',
              local_start: '2026-05-01 14:00',
              local_end: '2026-05-01 15:00',
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/check-availability', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.available).toBe(true);
    // WHY: RPC must receive zone-applied timestamps (-05:00 CDT in May)
    expect(queries[1].text).toContain('check_availability_with_tz');
    expect(queries[1].params[2]).toBe('2026-05-01T14:00:00-05:00');
    expect(queries[1].params[3]).toBe('2026-05-01T15:00:00-05:00');
  });

  it('SAD: end_time before start_time fails before hitting DB', async () => {
    // WHO: LLM passed the times reversed
    // WHAT: Route validates ordering before any DB query
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/check-availability', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      start_time: '2026-05-01T15:00:00',
      end_time: '2026-05-01T14:00:00',
    });
    expectValidationFailure(res, queries);
    expect(res.json().error).toBe('End time must be after start time.');
  });

  it('SAD: unparseable date string fails before hitting DB', async () => {
    // WHAT: Date.parse NaN → conversational error, no DB call
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/check-availability', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      start_time: 'sometime next week',
      end_time: 'then plus an hour',
    });
    expectValidationFailure(res, queries);
    expect(res.json().error).toContain('Invalid date format');
  });
});

describe('agentTools /policy-answer', () => {
  it('SAD: embedding failure degrades to the graceful fallback, never a 500/JSON', async () => {
    // WHO: a caller asking a question while OpenAI embeddings are down/over-quota.
    // WHAT: getEmbedding throws; the route must catch it and return success:true
    //        with the warm "I don't have that, want to leave a message?" line —
    //        NOT propagate a 500 the agent would relay as technical JSON.
    // WHERE: POST /agent-tools/policy-answer → getEmbedding try/catch (agentTools.ts).
    // WHEN: every knowledge query when the embeddings provider is unavailable.
    // WHY: a raw 500 → '{"error":"Backend returned 500"}' is dead-air-adjacent —
    //        the caller hears a technical error, the #1 thing "never silent" forbids.
    const { app } = buildApp({ queryResponses: [], embeddingThrows: true });
    const res = await post(app, '/agent-tools/policy-answer', {
      tenant_id: TENANT_ID,
      question: 'Do you offer financing?',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().result).toContain('take a message');
  });

  it('HAPPY: matches found returns joined context string WITH source citations', async () => {
    // WHO: Caller asking about cancellation policy
    // WHAT: Embedding-based RPC returns top matches; route joins them and
    //        prefixes each with its source-doc title so the agent can cite it
    //        ("according to our Cancellation Policy…").
    const { app, queries } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              tenant_doc_id: 'd1',
              content: 'Cancellations require 24 hours notice.',
              similarity: 0.9,
            },
            { tenant_doc_id: 'd2', content: 'No-show fee is $25.', similarity: 0.8 },
          ],
        },
        // titles lookup for the matched tenant_doc_ids
        {
          rows: [
            { tenant_doc_id: 'd1', title: 'Cancellation Policy' },
            { tenant_doc_id: 'd2', title: 'Fees' },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/policy-answer', {
      tenant_id: TENANT_ID,
      question: 'What is your cancellation policy?',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toContain('24 hours notice');
    expect(res.json().result).toContain('No-show fee');
    // WHY: each chunk is attributed to its source document for caller-facing citations.
    expect(res.json().result).toContain('[From "Cancellation Policy"]');
    expect(res.json().result).toContain('[From "Fees"]');
    // WHY: RPC call receives JSON-stringified embedding vector; a second query
    //       resolves the source titles from tenant_docs.
    expect(queries[0].text).toContain('search_tenant_docs_normalized');
    expect(queries.some((q) => q.text.includes('FROM tenant_docs'))).toBe(true);
  });

  it('HAPPY: no matches returns fallback message AND logs the gap', async () => {
    // WHO: Caller asking about something the KB doesn't cover
    // WHAT: Route should return the conversational fallback AND fire-
    //        and-forget an INSERT into unanswered_questions so the owner
    //        can fill the gap
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [] }, // embedding search returns nothing
        { rows: [] }, // INSERT into unanswered_questions (fire-and-forget)
      ],
    });
    const res = await post(app, '/agent-tools/policy-answer', {
      tenant_id: TENANT_ID,
      question: 'Do you accept Dogecoin?',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toContain("don't have specific information");
    // Wait a tick for the fire-and-forget insert to enqueue
    await new Promise((r) => setImmediate(r));
    expect(queries.some((q) => q.text.includes('unanswered_questions'))).toBe(true);
  });

  it('HAPPY: expands the query (not normalizes) before embedding', async () => {
    // WHO: The 2026-06-12 RAG address-gap fix replaced the reductive query
    //       normalizer with an additive query EXPANDER on this path
    // WHAT: If the expander is passed, it transforms the question before
    //        getEmbedding runs (context = 'customer phone inquiry')
    // WHEN: A policy-answer request with an expander wired in
    // WHERE: policy-answer's pre-embedding step
    // WHY: Reducing a terse query ("what's your address" → "Address inquiry")
    //       collapsed its retrieval signal below out-of-scope questions;
    //       expansion adds synonyms to bridge the vocabulary gap instead.
    const expander = vi.fn(async (text: string) => `expanded:${text}`);
    const { app } = buildApp({
      queryResponses: [{ rows: [{ content: 'match', similarity: 0.9 }] }],
      expander,
    });
    await post(app, '/agent-tools/policy-answer', { tenant_id: TENANT_ID, question: 'hours?' });
    expect(expander).toHaveBeenCalledWith('hours?', {
      context: 'customer phone inquiry',
    });
  });

  it('HAPPY: does NOT call the normalizer on the policy-answer query path', async () => {
    // WHO: A backend still passing a normalizer positionally (signature
    //       stability) but on the post-fix code path
    // WHAT: The normalizer must NOT be invoked for query embedding anymore
    // WHEN: A policy-answer request with a normalizer (but no expander)
    // WHERE: policy-answer's pre-embedding step
    // WHY: Regression guard — the reductive normalizer is the exact thing
    //       that broke address retrieval; it must stay off this path. With
    //       no expander, the raw query is embedded directly.
    const normalizer = vi.fn(async (text: string) => `normalized:${text}`);
    const { app } = buildApp({
      queryResponses: [{ rows: [{ content: 'match', similarity: 0.9 }] }],
      normalizer,
    });
    await post(app, '/agent-tools/policy-answer', { tenant_id: TENANT_ID, question: 'hours?' });
    expect(normalizer).not.toHaveBeenCalled();
  });

  it('SAD: empty question fails validation', async () => {
    // WHAT: Zod min(1) on question; no DB call
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/policy-answer', {
      tenant_id: TENANT_ID,
      question: '',
    });
    expectValidationFailure(res, queries);
  });
});

describe('agentTools /book-appointment', () => {
  it('SAD: rejects absurd 23-hour appointments before touching the DB', async () => {
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/book-appointment', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      phone: '5551234567',
      start_time: '2026-05-01T10:00:00',
      end_time: '2026-05-02T09:00:00',
    });
    expectValidationFailure(res, queries);
    expect(res.json().error).toBe('Appointment duration cannot exceed 12 hours');
    expect(res.json().error_code).toBe('INVALID_DURATION');
  });

  it('SAD: off-grid start time → INVALID_INCREMENT, no DB call', async () => {
    // WHO: agent hallucinates a non-15-min start ("ten oh seven" → 10:07)
    // WHAT: Route returns 200 + { success:false, error_code:'INVALID_INCREMENT' }
    //        before any DB activity. Agent prompt branches on the code to
    //        re-snap to the nearest valid grid point.
    // WHEN: Slice 1.5 of booking enforcement hardening, 2026-05-09
    // WHERE: /agent-tools/book-appointment validateAppointmentTimeRange gate
    // WHY: third-layer enforcement, parity with /appointments/create. Without
    //       error_code, the agent prompt would have to string-match the
    //       message — brittle as message wording evolves.
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/book-appointment', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      phone: '5551234567',
      start_time: '2026-05-01T10:07:00',
      end_time: '2026-05-01T11:00:00',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: false,
      error_code: 'INVALID_INCREMENT',
      error: 'Start time must land on a 15-minute increment (:00, :15, :30, :45)',
    });
    expect(queries).toHaveLength(0);
  });

  it('SAD: off-grid end time → INVALID_INCREMENT, no DB call', async () => {
    // WHY: pin both halves of the predicate; a future helper-rewrite that
    //       silently drops the end-time branch would slip past Zod and rely
    //       solely on the DB CHECK (which returns a generic constraint
    //       violation, not the conversational message the agent needs).
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/book-appointment', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      phone: '5551234567',
      start_time: '2026-05-01T10:00:00',
      end_time: '2026-05-01T10:23:00',
    });
    expect(res.json()).toMatchObject({
      success: false,
      error_code: 'INVALID_INCREMENT',
      error: 'End time must land on a 15-minute increment (:00, :15, :30, :45)',
    });
    expect(queries).toHaveLength(0);
  });

  it('HAPPY: new customer is upserted then booked atomically', async () => {
    // WHO: First-time caller — agent passes a phone number it has never seen
    // WHAT: Route must SELECT for existing customer, INSERT when not found,
    //        then call book_appointment_atomic with the new customer_id
    // WHY: Two-step upsert (vs. UPSERT ON CONFLICT) lets the route keep the
    //       existing customer name if one is already on file
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [] }, // existing-customer SELECT
        { rows: [{ customer_id: 'new-customer-id' }] }, // INSERT new customer
        { rows: [{ default_buffer_minutes: 0 }] }, // getTenantBufferMinutes
        { rows: [{ timezone: 'America/Chicago' }] }, // getTenantTimezone (local → UTC conversion)
        {
          rows: [{ success: true, appointment_id: 'appt-1', error_message: null }],
        },
      ],
    });
    const res = await post(app, '/agent-tools/book-appointment', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      phone: '5551234567',
      name: 'Bob',
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      result: { success: true, appointment_id: 'appt-1' },
    });
    // WHY: Phone must be normalized (+15551234567) to match how we store
    //       customers — inconsistency would cause duplicate-customer bugs
    expect(queries[0].params).toEqual([TENANT_ID, '+15551234567']);
    expect(queries[1].params).toEqual([TENANT_ID, '+15551234567', 'Bob']);
    // WHY: RPC gets the newly-created customer_id (queries[2] is the buffer
    //       lookup, queries[3] is the getTenantTimezone lookup)
    expect(queries[4].text).toContain('book_appointment_atomic');
    expect(queries[4].params?.[2]).toBe('new-customer-id');
  });

  it('HAPPY: existing customer reuses id — no INSERT', async () => {
    // WHAT: Route must short-circuit the INSERT when SELECT returns a row
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'existing-cust' }] },
        { rows: [{ default_buffer_minutes: 0 }] }, // getTenantBufferMinutes
        { rows: [{ timezone: 'America/Chicago' }] }, // getTenantTimezone (local → UTC conversion)
        {
          rows: [{ success: true, appointment_id: 'appt-2', error_message: null }],
        },
      ],
    });
    const res = await post(app, '/agent-tools/book-appointment', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      phone: '5551234567',
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
    });
    expect(res.json().result.appointment_id).toBe('appt-2');
    // WHY: SELECT + buffer lookup + tz lookup + RPC, no INSERT (existing customer
    //      reused). book_appointment_atomic has no service resolver. At least 4
    //      queries — a fire-and-forget reminder-scheduling query may fire after the
    //      RPC on success and is not counted. RPC is queries[3] ($3 = customer_id).
    expect(queries.length).toBeGreaterThanOrEqual(4);
    expect(queries[3].params?.[2]).toBe('existing-cust');
  });

  it('TZ: a naive local start/end is converted to the tenant zone before the RPC', async () => {
    // WHO: the voice agent, which sends the caller's LOCAL wall-clock time.
    // WHAT: with the tenant in America/Chicago, a naive "2026-05-01T14:00:00"
    //       must reach book_appointment_atomic as "2026-05-01T14:00:00-05:00"
    //       (CDT), NOT bare/UTC — otherwise the booking lands 5 hours off
    //       (the 10:30-vs-3:30 prod bug, 2026-07-01).
    // WHERE: /agent-tools/book-appointment → applyTimezone(start, tenant_tz).
    // WHY: the RPC converts UTC→local for its shift check; feeding it the wrong
    //       absolute instant books the wrong time / an unassigned slot.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'cust-tz' }] }, // SELECT customer
        { rows: [{ default_buffer_minutes: 0 }] }, // getTenantBufferMinutes
        { rows: [{ timezone: 'America/Chicago' }] }, // getTenantTimezone
        { rows: [{ success: true, appointment_id: 'appt-tz', error_message: null }] }, // RPC
      ],
    });
    const res = await post(app, '/agent-tools/book-appointment', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      phone: '5551234567',
      start_time: '2026-05-01T14:00:00', // naive local (2 PM Chicago)
      end_time: '2026-05-01T15:00:00',
    });
    expect(res.json().result.appointment_id).toBe('appt-tz');
    // RPC is queries[3]; params [tenant, resource, customer, start, end, ...].
    expect(queries[3].params?.[3]).toBe('2026-05-01T14:00:00-05:00'); // start → CDT
    expect(queries[3].params?.[4]).toBe('2026-05-01T15:00:00-05:00'); // end → CDT
  });

  it('SAD: RPC failure is surfaced verbatim so the agent can relay it', async () => {
    // WHO: Caller requesting a slot that just got taken
    // WHAT: Route must return { success: false, error: <RPC message> } at 200
    // WHY: Voice flow needs a string the LLM can speak — not an HTTP 500
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'c1' }] },
        { rows: [{ default_buffer_minutes: 0 }] }, // getTenantBufferMinutes
        { rows: [{ timezone: 'America/Chicago' }] }, // getTenantTimezone (local → UTC conversion)
        {
          rows: [
            {
              success: false,
              appointment_id: null,
              error_message: 'That time slot just got booked by another customer.',
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/book-appointment', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      phone: '5551234567',
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: 'That time slot just got booked by another customer.',
    });
  });

  it('SAD: invalid UUID fails validation before any DB call', async () => {
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/book-appointment', {
      tenant_id: 'not-a-uuid',
      resource_id: RESOURCE_ID,
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
    });
    expectValidationFailure(res, queries);
  });

  it('SAD: empty phone is rejected at the gate — no DB, LLM is told to ask', async () => {
    // WHO: Caller came in anonymously and no phone has been captured yet
    // WHAT: Route rejects with an ask-for-phone message before any DB
    //        call; the LLM agent reads this and pivots to the OTP flow
    //        (ask verbally, /send-verification-code, /verify-phone-code)
    // WHERE: /agent-tools/book-appointment when args.phone is empty
    //         (was previously the "anonymous booking" happy path)
    // WHEN: Policy decided 2026-04-23 — valid phone required for bookings
    //        so we can confirm, reschedule, and reach the caller if needed
    // WHY: Prior behavior would INSERT an empty-phone customer record,
    //        which muddied downstream CRM sync and made callback impossible
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/book-appointment', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      phone: '',
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('good phone number');
    // Critical: zero DB activity. The old code would have SELECTed+INSERTed.
    expect(queries).toHaveLength(0);
  });

  it('SAD: garbled phone (passes Zod min(5) but < 10 digits) is rejected at the gate', async () => {
    // WHO: LLM hallucinated a phone like 'abc123' or caller-ID came
    //       through as '+1' from a blocked-number carrier
    // WHAT: Route rejects — same gate as empty phone — so the OTP flow
    //        kicks in and the caller is asked verbally
    // WHY: Without this, 'abc123' would reach the customer SELECT and
    //        then get INSERTed as a phone value. Data quality disaster.
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/book-appointment', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      phone: 'abc123',
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('good phone number');
    expect(queries).toHaveLength(0);
  });

  it('SAD: 7-digit phone (caller read back without area code) is rejected at the gate', async () => {
    // WHO: Caller provided a local 7-digit number verbally after the
    //       agent asked — the /verify-phone-code flow confirmed it via
    //       SMS, BUT if somehow a partial number sneaks through (agent
    //       bug, OTP flow bypassed), this gate is the last line of defense
    // WHAT: Gate must reject any phone with fewer than 10 digits no
    //        matter how it got here — bookings require a full phone
    // WHY: The OTP flow is the primary guard; this test pins the gate
    //        as a belt-AND-suspenders check that a partial number can
    //        never end up in a booking even if other layers fail
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/book-appointment', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      phone: '5551234', // 7 digits
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('good phone number');
    expect(queries).toHaveLength(0);
  });

  it('SAD: RPC overlap → response carries conflict block + TIMESLOT_OCCUPIED', async () => {
    // WHO: Caller requesting a slot the GiST exclusion constraint will reject
    // WHAT: Route detects "Resource already booked", runs findOverlappingAppointment
    //        in the same transaction, surfaces the conflicting appointment in the
    //        response so the agent (and any structured-response consumer) can read
    //        WHICH booking is blocking — not just "something is."
    // WHEN: Slice 1 of the booking enforcement hardening, 2026-05-09
    // WHERE: /agent-tools/book-appointment + src/services/conflictLookup.ts
    // WHY: Without this, the agent can only relay a generic "that time is taken"
    //       message; with the conflict block, downstream surfaces (dashboard
    //       review of agent calls, future agent prompts) can be specific.
    const { app, queries } = buildApp({
      queryResponses: [
        // Step 1 inside getOrCreateCustomerByPhone: SELECT customer
        { rows: [{ customer_id: 'existing-cust' }] },
        // Step 1b: getTenantBufferMinutes
        { rows: [{ default_buffer_minutes: 0 }] },
        // Step 1c: getTenantTimezone (local → UTC conversion)
        { rows: [{ timezone: 'America/Chicago' }] },
        // Step 2: book_appointment_atomic returns overlap error
        {
          rows: [
            {
              success: false,
              appointment_id: null,
              error_message: 'Resource already booked during this timeslot',
            },
          ],
        },
        // Step 3: findOverlappingAppointment lookup
        {
          rows: [
            {
              appointment_id: 'blocking-appt-1',
              start_time: '2026-05-01T14:15:00Z',
              end_time: '2026-05-01T14:45:00Z',
              customer_name: 'Existing Customer',
              employee_name: 'Mike',
              resource_name: 'Bay 1',
              description: 'Tire rotation',
            },
          ],
        },
      ],
    });

    const res = await post(app, '/agent-tools/book-appointment', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      phone: '5551234567',
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('TIMESLOT_OCCUPIED');
    expect(body.error).toBe('Resource already booked during this timeslot');
    expect(body.conflict).toEqual({
      appointment_id: 'blocking-appt-1',
      start_time: '2026-05-01T14:15:00Z',
      end_time: '2026-05-01T14:45:00Z',
      customer_name: 'Existing Customer',
      employee_name: 'Mike',
      resource_name: 'Bay 1',
      description: 'Tire rotation',
    });
    // Pin: the conflict lookup runs last (after SELECT customer, buffer lookup,
    // tz lookup, and the RPC), scoped to the same tenant and resource with the
    // time bounds.
    expect(queries).toHaveLength(5);
    expect(queries[4].text).toMatch(/FROM appointments a/);
    expect(queries[4].text).toMatch(/a\.start_time < \$4/);
  });

  it('SAD: non-overlap RPC error keeps plain { success:false, error } shape — no conflict lookup', async () => {
    // WHO: RPC rejected for a non-overlap reason (past time, skill mismatch, etc.)
    // WHAT: route must NOT run findOverlappingAppointment — there's nothing
    //        to point at — and the response stays the legacy plain shape so
    //        the existing agent prompt parsing keeps working.
    // WHY: isOverlapError() gates the lookup. Pin that the gate fires only
    //       on "already booked" strings.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'existing-cust' }] },
        { rows: [{ default_buffer_minutes: 0 }] }, // getTenantBufferMinutes
        { rows: [{ timezone: 'America/Chicago' }] }, // getTenantTimezone (local → UTC conversion)
        {
          rows: [
            {
              success: false,
              appointment_id: null,
              error_message: 'Cannot book in the past',
            },
          ],
        },
      ],
    });

    const res = await post(app, '/agent-tools/book-appointment', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      phone: '5551234567',
      start_time: '2020-01-01T14:00:00',
      end_time: '2020-01-01T15:00:00',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: false,
      error: 'Cannot book in the past',
    });
    // Critical: no conflict lookup ran — only SELECT, buffer lookup, tz lookup,
    // and RPC.
    expect(queries).toHaveLength(4);
  });
});

describe('agentTools /scheduling-options', () => {
  it('HAPPY: returns options + diagnostics for a satisfiable request', async () => {
    // WHO: Agent asking "what do we have Friday morning for an oil change?"
    // WHAT: Route loads resources/employees/appointments/shifts, runs the
    //        shared selector, returns option list + diagnostics
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ resource_id: 'bay-1', capabilities: ['lift', 'oil'] }] },
        { rows: [{ employee_id: 'emp-1', skills: ['oil_change'] }] },
        { rows: [] }, // no existing appointments
        {
          rows: [
            {
              employee_id: 'emp-1',
              start_time: '08:00:00',
              end_time: '17:00:00',
              is_off: false,
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/scheduling-options', {
      tenant_id: TENANT_ID,
      requirements: {
        serviceType: 'Oil Change',
        requiredResourceCapabilities: ['oil'],
        requiredEmployeeSkills: ['oil_change'],
      },
      window: { from: '2026-05-01T14:00:00Z', to: '2026-05-01T15:00:00Z' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.result.options).toEqual([{ resourceId: 'bay-1', employeeId: 'emp-1' }]);
    expect(body.result.diagnostics.reason).toBe('ok');
  });

  it('HAPPY: empty options carry a diagnostic reason', async () => {
    // WHO: Agent asking for a skill nobody has
    // WHAT: Options must be empty; diagnostics.reason must say *why*
    // WHY: The agent reads the reason aloud to steer the caller
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ resource_id: 'bay-1', capabilities: ['lift'] }] },
        { rows: [{ employee_id: 'emp-1', skills: ['oil_change'] }] }, // lacks tire_rotation
        { rows: [] },
        {
          rows: [
            {
              employee_id: 'emp-1',
              start_time: '08:00:00',
              end_time: '17:00:00',
              is_off: false,
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/scheduling-options', {
      tenant_id: TENANT_ID,
      requirements: {
        serviceType: 'Tire Rotation',
        requiredEmployeeSkills: ['tire_rotation'],
      },
      window: { from: '2026-05-01T14:00:00Z', to: '2026-05-01T15:00:00Z' },
    });
    const body = res.json();
    expect(body.result.options).toEqual([]);
    expect(body.result.diagnostics.reason).toContain('tire_rotation');
  });

  it('SAD: reversed window fails before any DB call', async () => {
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/scheduling-options', {
      tenant_id: TENANT_ID,
      requirements: { serviceType: 'Oil Change' },
      window: { from: '2026-05-01T15:00:00Z', to: '2026-05-01T14:00:00Z' },
    });
    expectValidationFailure(res, queries);
    expect(res.json().error).toBe('Window end must be after window start.');
  });

  it('HAPPY: employee with is_off=true override is excluded from options', async () => {
    // WHO: Owner marked Jane as "off" for May 1 via the dashboard's
    //       date-override UI — that row lands in employee_schedule with
    //       is_off=true and null start/end times
    // WHAT: The is_off override must propagate through the route's
    //        filter (s.is_off || (s.start_time && s.end_time)) into
    //        shiftOverrides, and selectAssignments must then exclude Jane
    // WHERE: /agent-tools/scheduling-options on the day Jane is off
    // WHEN: Any booking request for a service only Jane is skilled at
    // WHY: If this filter chain breaks, we'd tell the agent Jane is
    //        available — and the downstream book call would then 500 or
    //        worse, actually book her on her day off. High-blast-radius
    //        bug; must be pinned.
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ resource_id: 'bay-1', capabilities: ['oil'] }] },
        { rows: [{ employee_id: 'emp-1', skills: ['oil_change'] }] },
        { rows: [] }, // no existing appointments
        {
          rows: [
            {
              employee_id: 'emp-1',
              start_time: null,
              end_time: null,
              is_off: true,
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/scheduling-options', {
      tenant_id: TENANT_ID,
      requirements: {
        serviceType: 'Oil Change',
        requiredResourceCapabilities: ['oil'],
        requiredEmployeeSkills: ['oil_change'],
      },
      window: { from: '2026-05-01T14:00:00Z', to: '2026-05-01T15:00:00Z' },
    });
    const body = res.json();
    expect(body.result.options).toEqual([]);
    // WHY: Diagnostics must explain *why* — this is the signal the agent
    //       uses to ask "would another day work?" instead of guessing
    expect(body.result.diagnostics.onShiftEmployees).toBe(0);
    expect(body.result.diagnostics.skilledEmployees).toBe(1);
    expect(body.result.diagnostics.reason).toContain('off-shift');
  });

  it('SAD: override with null times AND is_off=false is treated as no coverage', async () => {
    // WHO: Defensive path — a malformed override row with is_off=false and
    //       null start/end times somehow reaches us (shouldn't happen but
    //       has shown up in prod data before)
    // WHAT: The route's filter `s.is_off || (s.start_time && s.end_time)`
    //        must drop this row from shiftOverrides; with overrides empty
    //        and shifts empty, selectAssignments considers the employee
    //        on-shift-by-default — which would be wrong
    // WHERE: /agent-tools/scheduling-options when the DB returns garbage
    // WHY: Pinning this test documents the current behavior: we fall back
    //        to "on shift by default" when there's zero scheduling data.
    //        If we ever tighten that default, this test should flip to
    //        the opposite assertion — the test becomes a canary for the
    //        policy change rather than a silent regression.
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ resource_id: 'bay-1', capabilities: ['oil'] }] },
        { rows: [{ employee_id: 'emp-1', skills: ['oil_change'] }] },
        { rows: [] },
        {
          rows: [
            {
              employee_id: 'emp-1',
              start_time: null,
              end_time: null,
              is_off: false,
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/scheduling-options', {
      tenant_id: TENANT_ID,
      requirements: {
        serviceType: 'Oil Change',
        requiredResourceCapabilities: ['oil'],
        requiredEmployeeSkills: ['oil_change'],
      },
      window: { from: '2026-05-01T14:00:00Z', to: '2026-05-01T15:00:00Z' },
    });
    const body = res.json();
    // Garbage row filtered → no overrides → no shifts → default on-shift=true
    // Current behavior: employee IS included. This documents that behavior.
    expect(body.result.options).toEqual([{ resourceId: 'bay-1', employeeId: 'emp-1' }]);
  });
});

/**
 * The mocked pool is STRICTLY POSITIONAL, and /book-with-scheduling runs a long
 * fixed sequence before it reaches the RPC. Measured 2026-09-09:
 *
 *   0 customer SELECT · 1 name backfill UPDATE · 2 roster (only when with_person
 *   is passed) · 3-8 service resolution (catalog, embedding refresh,
 *   match_service_by_intent, fallbacks) · 9 buffer · 10 timezone · 11 duplicate
 *   check · 12 book_with_scheduling_atomic
 *
 * Counting blanks by hand in each test is how a test ends up asserting against
 * `{rows: []}` and passing for the wrong reason, so build the array here.
 */
function bookingRpcResponses(opts: {
  roster?: { employee_id: string; name: string }[];
  rpc: Record<string, unknown>;
}) {
  // A REAL service row on the first catalog query keeps the path SHORT and
  // deterministic: resolveServiceForBooking stops there instead of walking the
  // embedding refresh / semantic match / fallback chain, whose length depends on
  // what each step returns. That data-dependence is why a fixed pad of blanks
  // silently drifts (it did, on the first attempt at these tests).
  const service = {
    rows: [
      { service_id: '77777777-8888-4999-8aaa-bbbbbbbbbbbb', name: 'Meeting', duration_minutes: 30 },
    ],
  };
  const rows: { rows: unknown[] }[] = [
    { rows: [{ customer_id: '11111111-2222-4333-8444-555555555555' }] }, // customer SELECT
    { rows: [] }, // name backfill UPDATE
  ];
  if (opts.roster) rows.push({ rows: opts.roster }); // roster (only with with_person)
  rows.push(service); // service catalog match
  rows.push({ rows: [{ default_buffer_minutes: 0 }] }); // tenant buffer
  rows.push({ rows: [{ timezone: 'America/Chicago' }] }); // tenant timezone
  rows.push({ rows: [] }); // same-day duplicate check → none
  rows.push({ rows: [opts.rpc] }); // book_with_scheduling_atomic
  return rows;
}

describe('agentTools /book-with-scheduling', () => {
  it('SAD: a second booking for the SAME DAY on a LATER CALL is refused, with the one they have', async () => {
    // WHO: Jaya, 2026-07-27 (CALL_IMPROVEMENTS.md #9/#10). She booked 1:00 PM
    //       on one call and 2:30 PM for the same thing six minutes later on the
    //       next. Two live appointments ninety minutes apart; the first was
    //       never cancelled and never honored.
    // WHAT: the route refuses before ANY write and hands back the existing
    //       booking so the agent can offer keep / move / both.
    // WHY: wrapAction's anti-double-book gate is per-CALL and in-memory — it
    //       cannot see the call before it. This is the layer that can.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'cust-jaya' }] }, // customer SELECT
        { rows: [] }, // name UPDATE
        {
          rows: [
            {
              service_id: 'svc-consult-01',
              name: 'Programming Consultation',
              duration_minutes: 30,
              price: 0,
              required_skills: [],
            },
          ],
        }, // resolver: matched on the first query (no embedding path)
        { rows: [{ default_buffer_minutes: 0 }] }, // buffer
        { rows: [{ timezone: 'America/Chicago', booking_mechanics: null }] }, // tz + mechanics
        { rows: [{ start_time: '2026-07-27T18:00:00.000Z', service: 'Programming Consultation' }] },
      ],
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '7734487716',
      name: 'Jaya',
      call_id: 'SCL_second_call',
      requirements: { serviceType: 'meeting' },
      window: { from: '2026-07-27T19:30:00Z', to: '2026-07-27T20:00:00Z' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('EXISTING_SAME_DAY');
    expect(body.existing_appointment.service).toBe('Programming Consultation');
    // The refusal must tell the model the alternatives, or it will just retry.
    expect(body.error).toMatch(/KEEP/);
    expect(body.error).toMatch(/allow_duplicate/);
    // NOTHING was written — the RPC never ran.
    expect(queries.some((q) => q.text.includes('book_with_scheduling_atomic'))).toBe(false);
    // Only OTHER calls count: a retry of THIS booking is idempotency, not a dup.
    const dupQ = queries.find((q) => q.text.includes('FROM appointments a'))!;
    expect(dupQ.text).toContain('call_id IS DISTINCT FROM');
    expect(dupQ.text).toContain("status = 'scheduled'");
  });

  it('HAPPY: allow_duplicate books anyway — a deliberate second appointment is legitimate', async () => {
    // WHY: two cars, two people, two errands. The guard exists to stop the
    //       ACCIDENT, never to make a real second booking impossible.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'cust-jaya' }] },
        { rows: [] },
        {
          rows: [
            {
              service_id: 'svc-consult-01',
              name: 'Programming Consultation',
              duration_minutes: 30,
              price: 0,
              required_skills: [],
            },
          ],
        }, // resolver: matched on the first query (no embedding path)
        { rows: [{ default_buffer_minutes: 0 }] },
        { rows: [{ timezone: 'America/Chicago', booking_mechanics: null }] },
        // NO duplicate query is issued at all when allow_duplicate is set.
        {
          rows: [
            {
              success: true,
              appointment_id: 'appt-second',
              resource_id: null,
              resource_name: null,
              employee_id: null,
              employee_name: 'Dale',
              booked_start: '2026-07-27T19:30:00.000Z',
              booked_end: '2026-07-27T20:00:00.000Z',
              customer_id: 'cust-jaya',
              error_message: null,
              error_code: null,
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '7734487716',
      name: 'Jaya',
      call_id: 'SCL_second_call',
      allow_duplicate: true,
      requirements: { serviceType: 'meeting' },
      window: { from: '2026-07-27T19:30:00Z', to: '2026-07-27T20:00:00Z' },
    });
    expect(res.json().success).toBe(true);
    // The GUARD query specifically (identified by its cross-call predicate) is
    // skipped entirely — not merely ignored.
    expect(queries.some((q) => q.text.includes('call_id IS DISTINCT FROM'))).toBe(false);
    expect(queries.some((q) => q.text.includes('book_with_scheduling_atomic'))).toBe(true);
  });

  it('HAPPY: booking_mechanics rides the confirmation, verbatim, with a say-it instruction', async () => {
    // WHO: the caller who asked "so I call him at two thirty?" and was told to
    //       use "the same number" — the AI's own line (2026-07-27, #9). Four
    //       more failed calls came from that one invented sentence.
    // WHY: the model had no ground truth to state. Now the owner states it once.
    const MECHANICS = 'Dale will call you at this number at the booked time.';
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'cust-1' }] },
        { rows: [] },
        {
          rows: [
            {
              service_id: 'svc-consult-01',
              name: 'Programming Consultation',
              duration_minutes: 30,
              price: 0,
              required_skills: [],
            },
          ],
        }, // resolver: matched on the first query (no embedding path)
        { rows: [{ default_buffer_minutes: 0 }] },
        { rows: [{ timezone: 'America/Chicago', booking_mechanics: MECHANICS }] },
        { rows: [] }, // duplicate guard: clear
        {
          rows: [
            {
              success: true,
              appointment_id: 'appt-mech',
              resource_id: null,
              resource_name: null,
              employee_id: null,
              employee_name: 'Dale',
              booked_start: '2026-07-31T19:30:00.000Z',
              booked_end: '2026-07-31T20:00:00.000Z',
              customer_id: 'cust-1',
              error_message: null,
              error_code: null,
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'Alex',
      requirements: { serviceType: 'consultation' },
      window: { from: '2026-07-31T14:30:00Z', to: '2026-07-31T15:00:00Z' },
    });
    const r = res.json().result;
    expect(r.what_happens_next).toBe(MECHANICS);
    // VERBATIM, because an improvised version is exactly what caused the cascade.
    expect(r.instruction).toContain('VERBATIM');
    expect(r.instruction).toContain(MECHANICS);
  });

  it('HAPPY: a tenant with NO booking_mechanics gets no extra field — silence beats a guess', async () => {
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'cust-1' }] },
        { rows: [] },
        {
          rows: [
            {
              service_id: 'svc-consult-01',
              name: 'Programming Consultation',
              duration_minutes: 30,
              price: 0,
              required_skills: [],
            },
          ],
        }, // resolver: matched on the first query (no embedding path)
        { rows: [{ default_buffer_minutes: 0 }] },
        { rows: [{ timezone: 'America/Chicago', booking_mechanics: null }] },
        { rows: [] },
        {
          rows: [
            {
              success: true,
              appointment_id: 'appt-plain',
              resource_id: null,
              resource_name: null,
              employee_id: null,
              employee_name: null,
              booked_start: '2026-07-31T19:30:00.000Z',
              booked_end: '2026-07-31T20:00:00.000Z',
              customer_id: 'cust-1',
              error_message: null,
              error_code: null,
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'Alex',
      requirements: { serviceType: 'consultation' },
      window: { from: '2026-07-31T14:30:00Z', to: '2026-07-31T15:00:00Z' },
    });
    expect(res.json().result.what_happens_next).toBeUndefined();
  });

  it('SAD: an off-grid window fails SPOKEN before any DB work — never a 500', async () => {
    // WHO: the model booking "1:19 PM" — a time the old suggester offered on a
    //       2026-07-17 live call (its slot series inherited now's minutes).
    // WHAT: the route rejects minutes not on :00/:15/:30/:45 with a spoken
    //        error + OFF_GRID_TIME before touching the customer or the RPC,
    //        so the agent can renegotiate instead of relaying "Backend
    //        returned 500" and retrying identically into the same constraint.
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'Jack Smith',
      requirements: { serviceType: 'a meeting' },
      window: { from: '2026-07-17T13:19:00', to: '2026-07-17T13:49:00' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(false);
    expect(res.json().error_code).toBe('OFF_GRID_TIME');
    expect(res.json().error).toMatch(/quarter hour/i);
    expect(queries, 'rejected before any DB statement ran').toHaveLength(0);
  });

  it('HAPPY: a one-minute window pinning a legal start is BOOKED, not refused', async () => {
    // WHO: John Smith, prod call SCL_A5wnBexPbwCC, 2026-09-09 11:12 CT.
    // WHAT: the model pinned 1:00 PM the way its own tool description invites —
    //       window [13:00, 13:01) — because book_with_scheduling takes the
    //       EARLIEST slot at or after `from`. The guard checked `to` against the
    //       quarter-hour grid, 13:01 is off-grid, and the booking died twice
    //       (12ms, 31ms — no DB statement ran). The caller was then told "I can
    //       only book times on the quarter hour. I have 1:00, 1:15, or 2:00",
    //       twenty seconds after the agent had offered him 1:00, and he left
    //       with no appointment.
    // WHERE: the grid guard in src/routes/agentTools/scheduling.ts.
    // WHEN: any booking whose window END is not on the grid — which is every
    //       exact-time booking the model makes.
    // WHY: `to` is an upper BOUND the caller never hears, and the RPC never even
    //      reads it (it books at p_window_from). Only `from` is a booking time.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: '11111111-2222-4333-8444-555555555555' }] },
        { rows: [] },
        {
          rows: [
            {
              success: true,
              appointment_id: '99999999-8888-4777-8666-555555555555',
              start_time: '2026-09-09T18:00:00.000Z',
              end_time: '2026-09-09T18:30:00.000Z',
              resource_name: 'Chair 1',
              employee_name: 'Dale',
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'John Smith',
      requirements: { serviceType: 'a meeting to talk about a contract role' },
      window: { from: '2026-09-09T13:00:00', to: '2026-09-09T13:01:00' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().error_code).not.toBe('OFF_GRID_TIME');
    expect(queries.length, 'the guard no longer short-circuits the DB work').toBeGreaterThan(0);
  });

  it('SAD: an off-grid START is still refused — the grid rule itself is intact', async () => {
    // The narrowing must not become a removal: `from` IS a booking time, and the
    // appointments_start_time_15min CHECK still rejects it at the database. A
    // spoken refusal here is what lets the model renegotiate instead of relaying
    // a 500 (2026-07-17).
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'Jack Smith',
      requirements: { serviceType: 'a meeting' },
      window: { from: '2026-09-09T13:07:00', to: '2026-09-09T13:37:00' },
    });
    expect(res.json().error_code).toBe('OFF_GRID_TIME');
    expect(queries, 'rejected before any DB statement ran').toHaveLength(0);
  });

  it('SAD: a caller asking for someone who does not work there is REFUSED, not silently reassigned', async () => {
    // WHO: Dale, 2026-09-09 — "when setting up a meeting make sure the person works
    //      at the company."
    // WHAT: with_person is resolved against live active employees BEFORE the RPC.
    //      No match → NO_SUCH_EMPLOYEE, the real roster handed back, and the
    //      booking RPC is never called.
    // WHERE: the roster check in book-with-scheduling (scheduling.ts).
    // WHEN: any booking where the caller named a person.
    // WHY: the tool had NO person parameter at all — it passed null for
    //      p_preferred_employee_id — so a caller could ask for "Jane", the agent
    //      could confirm "with Jane", and the RPC would assign whoever was free.
    //      The appointment was right and the sentence was a lie (2026-07-27:
    //      "Jane" was STT for "Dale", the only employee). The prompt already
    //      forbade this; a prompt sentence is a request, host code is a guarantee.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: '11111111-2222-4333-8444-555555555555' }] },
        { rows: [] },
        { rows: [{ employee_id: 'aaaaaaaa-1111-4222-8333-444444444444', name: 'Dale DeMott' }] },
      ],
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'Camille',
      requirements: { serviceType: 'a meeting' },
      window: { from: '2026-09-10T13:00:00', to: '2026-09-10T13:30:00' },
      with_person: 'Jane',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error_code).toBe('NO_SUCH_EMPLOYEE');
    expect(body.roster).toEqual(['Dale']);
    // The exact sentence Dale asked for, handed to the model to speak.
    expect(body.error).toContain(`Jane doesn't work here. Did you mean someone else?`);
    // And the correction it should offer instead of inventing one.
    expect(body.error).toContain('Did you mean Dale?');
    // The booking RPC must never have run.
    expect(queries.some((q) => q.text.includes('book_with_scheduling_atomic'))).toBe(false);
  });

  it('HAPPY: a caller asking for someone who DOES work there books, bound to that person', async () => {
    // First-name match, case-insensitive — what a caller actually says.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: '11111111-2222-4333-8444-555555555555' }] },
        { rows: [] },
        { rows: [{ employee_id: 'aaaaaaaa-1111-4222-8333-444444444444', name: 'Dale DeMott' }] },
        { rows: [] },
        {
          rows: [
            {
              success: true,
              appointment_id: '99999999-8888-4777-8666-555555555555',
              start_time: '2026-09-10T18:00:00.000Z',
              end_time: '2026-09-10T18:30:00.000Z',
              employee_name: 'Dale DeMott',
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'Camille',
      requirements: { serviceType: 'a meeting' },
      window: { from: '2026-09-10T13:00:00', to: '2026-09-10T13:30:00' },
      with_person: 'dale',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().error_code).not.toBe('NO_SUCH_EMPLOYEE');
    // The resolved employee id is bound as the preferred employee, so a real
    // person who is off shift fails EMPLOYEE_NOT_SCHEDULED — a truthful refusal —
    // rather than being silently swapped for whoever is free.
    const rpcCall = queries.find((q) => q.text.includes('book_with_scheduling_atomic'));
    expect(rpcCall, 'the booking RPC ran').toBeDefined();
    // p_preferred_employee_id is the 14th positional parameter.
    expect(rpcCall?.params).toContain('aaaaaaaa-1111-4222-8333-444444444444');
  });

  it('SAD: a person who WORKS there but is off shift is refused BY NAME', async () => {
    // WHO: Dale's question, 2026-09-09 — "what happens when you try to book
    //      someone who is not available but they do work there?"
    // WHAT: measured answer was: refused (good, and never substituted) with the
    //      RPC's generic "No employee available during requested time" (bad).
    // WHERE: the refusal branch of book-with-scheduling.
    // WHEN: any booking naming a person who is off shift for that window.
    // WHY: read out to a caller who asked for Ada, "no employee available" is
    //      about our search, not about Ada. The honest sentence is "Ada isn't
    //      working then" — same wrong-reason class as saying "fully booked" when
    //      the day had simply ended.
    const { app } = buildApp({
      queryResponses: bookingRpcResponses({
        roster: [{ employee_id: 'aaaaaaaa-1111-4222-8333-444444444444', name: 'Ada Works' }],
        rpc: {
          success: false,
          error_message: 'No employee available during requested time',
          error_code: 'EMPLOYEE_NOT_SCHEDULED',
        },
      }),
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'Vera Caller',
      requirements: { serviceType: 'a meeting' },
      window: { from: '2026-09-11T20:00:00', to: '2026-09-11T20:30:00' },
      with_person: 'Ada',
    });
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.requested_person).toBe('Ada');
    expect(body.error).toContain('Ada is not working at that time');
    expect(body.error).not.toContain('No employee available during requested time');
  });

  it('SAD: a person who is BUSY is refused as busy, not as "no availability"', async () => {
    // "No available resource/employee combination found" sounds like the whole
    // business is full. The caller asked for one person who has one conflict.
    const { app } = buildApp({
      queryResponses: bookingRpcResponses({
        roster: [{ employee_id: 'aaaaaaaa-1111-4222-8333-444444444444', name: 'Ada Works' }],
        rpc: {
          success: false,
          error_message: 'No available resource/employee combination found',
          error_code: 'NO_AVAILABILITY',
        },
      }),
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'Vera Caller',
      requirements: { serviceType: 'a meeting' },
      window: { from: '2026-09-11T14:00:00', to: '2026-09-11T14:30:00' },
      with_person: 'Ada',
    });
    expect(res.json().error).toContain('Ada is already booked at that time');
    expect(res.json().error).toContain('not "no availability"');
  });

  it('a refusal with NO person named keeps the original RPC message', async () => {
    // The rewrite must only fire when the caller actually named someone; a plain
    // "book me next Tuesday" failure should still read as the RPC described it.
    const { app } = buildApp({
      queryResponses: bookingRpcResponses({
        rpc: {
          success: false,
          error_message: 'No employee available during requested time',
          error_code: 'EMPLOYEE_NOT_SCHEDULED',
        },
      }),
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'Vera Caller',
      requirements: { serviceType: 'a meeting' },
      window: { from: '2026-09-11T20:00:00', to: '2026-09-11T20:30:00' },
    });
    expect(res.json().error).toContain('No employee available during requested time');
    expect(res.json().requested_person).toBeUndefined();
  });

  it('SAD: two people by the same name is refused, not guessed', async () => {
    // Picking one would rebuild the exact defect this closes: a confident
    // sentence about the wrong person.
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: '11111111-2222-4333-8444-555555555555' }] },
        { rows: [] },
        {
          rows: [
            { employee_id: 'aaaaaaaa-1111-4222-8333-444444444444', name: 'Chris Bell' },
            { employee_id: 'bbbbbbbb-1111-4222-8333-444444444444', name: 'Chris Dodd' },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'Camille',
      requirements: { serviceType: 'a meeting' },
      window: { from: '2026-09-10T13:00:00', to: '2026-09-10T13:30:00' },
      with_person: 'Chris',
    });
    expect(res.json().error_code).toBe('AMBIGUOUS_EMPLOYEE');
    expect(res.json().error).toContain('Chris Bell, Chris Dodd');
  });

  it('HAPPY: RPC returns success with resource + employee names', async () => {
    // WHO: Happy-path booking where the RPC found a matching slot
    // WHAT: Route returns the booked details for the agent to confirm aloud
    const { app, queries } = buildApp({
      queryResponses: [
        // The customerLookup helper runs first (separate transaction) — an
        // existing customer match short-circuits the INSERT branch. Because
        // 'Bob' is a real name, the helper also fires a name UPDATE in case
        // the stored name was blank/placeholder.
        { rows: [{ customer_id: 'cust-1' }] }, // SELECT
        { rows: [] }, // UPDATE name
        // resolver: service name match (runs inside the booking txn, before RPC)
        {
          rows: [
            {
              service_id: 'svc-oil-0001',
              name: 'Oil Change',
              duration_minutes: 30,
              price: 45,
              required_skills: ['oil_change'],
            },
          ],
        },
        { rows: [{ default_buffer_minutes: 0 }] }, // getTenantBufferMinutes (after resolver, before RPC)
        { rows: [{ timezone: 'America/Chicago', booking_mechanics: null }] }, // tenant tz + booking_mechanics
        { rows: [] }, // cross-call duplicate guard: no other appointment today (2026-07-31)
        {
          rows: [
            {
              success: true,
              appointment_id: 'appt-9',
              resource_id: 'bay-1',
              resource_name: 'Bay 1',
              employee_id: 'emp-1',
              employee_name: 'Jane',
              booked_start: '2026-05-01T14:00:00Z',
              booked_end: '2026-05-01T15:00:00Z',
              customer_id: 'cust-1',
              error_message: null,
              error_code: null,
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'Bob',
      requirements: { serviceType: 'Oil Change', requiredEmployeeSkills: ['oil_change'] },
      window: { from: '2026-05-01T14:00:00Z', to: '2026-05-01T15:00:00Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({
      success: true,
      appointment_id: 'appt-9',
      resource_name: 'Bay 1',
      employee_name: 'Jane',
    });
    // WHY: Normalized phone must reach the RPC so the customer upsert path
    //       inside it matches previously-stored records. Helper SELECT is
    //       queries[0]; name UPDATE is queries[1]; resolver match is
    //       queries[2]; buffer lookup is queries[3]; tz lookup is queries[4];
    //       RPC is queries[5]. Param shape: $1=tenant_id, $2=phone.
    expect(queries[5].params?.[1]).toBe('+15551234567');
  });

  it('SAD: RPC error_code is surfaced so the agent can be specific', async () => {
    // WHO: Caller requesting a slot that's already taken
    // WHAT: Route must include error_code: 'TIMESLOT_OCCUPIED' in response
    // WHY: BUG-064 — agent needs to say "that slot is taken" specifically,
    //       not the generic "no availability" fallback
    const { app } = buildApp({
      queryResponses: [
        // customerLookup helper finds an existing row before the RPC fires.
        { rows: [{ customer_id: 'cust-occupied' }] },
        // resolver: service name match (before the RPC)
        {
          rows: [
            {
              service_id: 'svc-1',
              name: 'Oil Change',
              duration_minutes: 30,
              price: null,
              required_skills: [],
            },
          ],
        },
        { rows: [{ default_buffer_minutes: 0 }] }, // getTenantBufferMinutes (pre-RPC)
        { rows: [{ timezone: 'America/Chicago', booking_mechanics: null }] }, // tenant tz + booking_mechanics
        { rows: [] }, // cross-call duplicate guard: no other appointment today (2026-07-31)
        {
          rows: [
            {
              success: false,
              appointment_id: null,
              resource_id: null,
              resource_name: null,
              employee_id: null,
              employee_name: null,
              booked_start: null,
              booked_end: null,
              customer_id: null,
              error_message: 'That time slot is already booked.',
              error_code: 'TIMESLOT_OCCUPIED',
            },
          ],
        },
        // After failure, route fetches the buffer again then calls
        // findNextAvailableSlots — buffer lookup + tenant tz lookup + slots SQL.
        { rows: [{ default_buffer_minutes: 0 }] }, // getTenantBufferMinutes (failure branch)
        { rows: [{ timezone: 'America/Chicago' }] },
        { rows: [] },
      ],
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      requirements: { serviceType: 'Oil Change' },
      window: { from: '2026-05-01T14:00:00Z', to: '2026-05-01T15:00:00Z' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      success: false,
      error: 'That time slot is already booked.',
      error_code: 'TIMESLOT_OCCUPIED',
    });
    // The next-available alternatives field is always present in failure
    // responses so the agent prompt can branch on it deterministically.
    expect(body.next_available).toEqual([]);
  });

  it('REGRESSION: next-available fallback uses requested service duration, not hardcoded 30 minutes', async () => {
    // WHO: caller asking for a 45-minute service whose requested slot is taken
    // WHAT: fallback slot search must preserve that 45-minute duration when it
    //       looks for alternatives, or the agent offers times the booking RPC
    //       cannot actually honor for the requested service
    // WHY: feat/demo-match-live had the fix; main still hardcoded 30 minutes in
    //      the failure branch, which quietly made alternative offers lie
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'cust-duration' }] },
        {
          rows: [
            {
              service_id: 'svc-45',
              name: 'Deep Consultation',
              duration_minutes: 45,
              price: null,
              required_skills: [],
            },
          ],
        },
        { rows: [{ default_buffer_minutes: 0 }] },
        { rows: [{ timezone: 'America/Chicago', booking_mechanics: null }] },
        { rows: [] },
        {
          rows: [
            {
              success: false,
              appointment_id: null,
              resource_id: null,
              resource_name: null,
              employee_id: null,
              employee_name: null,
              booked_start: null,
              booked_end: null,
              customer_id: null,
              error_message: 'That time slot is already booked.',
              error_code: 'TIMESLOT_OCCUPIED',
            },
          ],
        },
        { rows: [{ default_buffer_minutes: 0 }] },
        { rows: [{ timezone: 'America/Chicago' }] },
        { rows: [] },
      ],
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      requirements: { serviceType: 'Deep Consultation', durationMinutes: 45 },
      window: { from: '2026-05-01T14:00:00Z', to: '2026-05-01T14:45:00Z' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().error_code).toBe('TIMESLOT_OCCUPIED');
    const fallbackSlotsQuery = queries.find(
      (q) => q.text.includes('WITH grid_start AS') && q.params[2] === '45'
    );
    expect(
      fallbackSlotsQuery,
      'fallback availability search must keep 45-minute duration'
    ).toBeTruthy();
  });

  it('SAD: missing RPC row falls back to NO_AVAILABILITY', async () => {
    // WHO: RPC returned nothing (should not happen, but be defensive)
    // WHAT: Route must never crash the agent — fall back cleanly
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'cust-fallback' }] }, // customer SELECT succeeds first
        // resolver: service name match (before the RPC)
        {
          rows: [
            {
              service_id: 'svc-1',
              name: 'Oil Change',
              duration_minutes: 30,
              price: null,
              required_skills: [],
            },
          ],
        },
        { rows: [{ default_buffer_minutes: 0 }] }, // getTenantBufferMinutes (pre-RPC)
        { rows: [{ timezone: 'America/Chicago', booking_mechanics: null }] }, // tenant tz + booking_mechanics
        { rows: [] }, // cross-call duplicate guard: nothing else booked today
        { rows: [] }, // RPC returns no row
        // failure branch: buffer lookup + findNextAvailableSlots (tz + slots)
        { rows: [{ default_buffer_minutes: 0 }] },
        { rows: [{ timezone: 'America/Chicago' }] },
        { rows: [] },
      ],
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      requirements: { serviceType: 'Oil Change' },
      window: { from: '2026-05-01T14:00:00Z', to: '2026-05-01T15:00:00Z' },
    });
    expect(res.json().error_code).toBe('NO_AVAILABILITY');
  });

  it("SAD: alternatives are searched on the RESOLVED service duration + skills, not the model's guess", async () => {
    // WHO:  a caller asking for a 90-minute, skill-gated service
    // WHAT: the booking fails, and the alternatives search that runs next must
    //        use the SAME duration and required_skills the booking attempt used
    // WHEN: any failed book-with-scheduling that falls into the failure branch
    // WHERE: scheduling.ts searchParams → findNextAvailableSlots
    // WHY:  the search took args.requirements.durationMinutes (which the model
    //        often omits, defaulting to 30) and args.requirements
    //        .requiredEmployeeSkills, while the booking used
    //        resolved.duration_minutes and resolved.required_skills. So a
    //        90-minute service was offered a 30-minute gap with an unskilled
    //        employee; the caller said yes and got NO_SKILLED_EMPLOYEE. A dead
    //        end became a rejection loop — the agent kept offering, the caller
    //        kept accepting, nothing ever booked.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'cust-align' }] },
        {
          rows: [
            {
              service_id: 'svc-align',
              name: 'Four-Wheel Alignment',
              duration_minutes: 90,
              price: null,
              required_skills: ['alignment'],
            },
          ],
        },
        { rows: [{ default_buffer_minutes: 0 }] },
        { rows: [{ timezone: 'America/Chicago', booking_mechanics: null }] },
        { rows: [] },
        { rows: [] }, // RPC returns no row → failure branch
        { rows: [{ default_buffer_minutes: 0 }] },
        { rows: [{ timezone: 'America/Chicago' }] },
        { rows: [] },
      ],
    });

    await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      // Deliberately NO durationMinutes and NO requiredEmployeeSkills — this is
      // the common shape, and it is exactly when the old code fell back to 30.
      requirements: { serviceType: 'Four-Wheel Alignment' },
      window: { from: '2026-05-01T14:00:00Z', to: '2026-05-01T15:00:00Z' },
    });

    // findNextAvailableSlots passes String(durationMinutes) as $3 and the
    // required-skills array as $7 (availabilitySearch.ts).
    const slotQueries = queries.filter((q) => String(q.text).includes('slot_start'));
    expect(slotQueries.length).toBeGreaterThan(0);
    for (const q of slotQueries) {
      expect(q.params?.[2]).toBe('90');
      expect(q.params?.[6]).toEqual(['alignment']);
    }
  });

  it('SAD: invalid phone is rejected at the gate before the RPC is called', async () => {
    // WHO: Agent called book-with-scheduling with a blocked caller-ID
    //       phone (came through as '+1' after digit-strip)
    // WHAT: Route rejects with the ask-for-phone message — same gate as
    //        book-appointment, consistent policy across both routes
    // WHY: Without the gate the RPC would receive the raw unvalidated
    //        string and either fail internally or store garbage
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '+1',
      requirements: { serviceType: 'Oil Change' },
      window: { from: '2026-05-01T14:00:00Z', to: '2026-05-01T15:00:00Z' },
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('good phone number');
    expect(queries).toHaveLength(0);
  });

  it('CAPTURE: records requested_service_id on the call (for abandonment-by-service)', async () => {
    // WHO: a caller who tried to book "Oil Change" on call e2e-call-1.
    // WHAT: book-with-scheduling fires a best-effort UPDATE setting the call's
    //        voice_session.requested_service_id from the fuzzy service name —
    //        whether the booking succeeded or not — so an abandoned call still
    //        records which service the caller came for.
    // WHY:   abandoned calls have appointment_id NULL → no service to join; this
    //        capture is the only signal for abandonment-by-service analytics.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'cust-1' }] }, // customer SELECT
        { rows: [] }, // name UPDATE
        // resolver: service name match (before the RPC)
        {
          rows: [
            {
              service_id: 'svc-1',
              name: 'Oil Change',
              duration_minutes: 30,
              price: null,
              required_skills: [],
            },
          ],
        },
        // RPC fails (slot taken) → the call abandons, but the capture must still run.
        { rows: [{ success: false, error_code: 'TIMESLOT_OCCUPIED', error_message: 'taken' }] },
      ],
    });
    await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      call_id: 'e2e-call-1',
      phone: '5551234567',
      requirements: { serviceType: 'Oil Change' },
      window: { from: '2026-05-01T14:00:00Z', to: '2026-05-01T15:00:00Z' },
    });

    // Fire-and-forget — let the microtask flush.
    await new Promise((r) => setImmediate(r));

    const capture = queries.find((q) => q.text.includes('requested_service_id'));
    expect(capture, 'a requested_service_id UPDATE must fire').toBeTruthy();
    expect(capture!.text).toContain('UPDATE voice_sessions');
    expect(capture!.params).toEqual([TENANT_ID, 'Oil Change', 'e2e-call-1']);
  });
});

describe('agentTools pure-inquiry abandonment attribution', () => {
  // WHO: a caller who only asks "what's open?" and never attempts a booking.
  // WHAT: get_available_slots / get_scheduling_options carry the call_id, so
  //       the handler stamps requested_service_id on the voice_session — the
  //       same signal book-with-scheduling already writes.
  // WHY: without it, a pure availability inquiry left NO signal on the
  //       voice_session, so abandonment-by-service under-counted these calls.
  it('available-slots WITH call_id fires the requested_service_id capture', async () => {
    const { app, queries } = buildApp({ queryResponses: [] });
    await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: 'Oil Change',
      date: '2030-01-01',
      call_id: 'inquiry-call-1',
    });
    await new Promise((r) => setImmediate(r)); // flush the fire-and-forget capture
    const capture = queries.find((q) => q.text.includes('requested_service_id'));
    expect(capture, 'availability inquiry must attribute the service').toBeTruthy();
    expect(capture!.text).toContain('UPDATE voice_sessions');
    expect(capture!.params).toEqual([TENANT_ID, 'Oil Change', 'inquiry-call-1']);
  });

  it('scheduling-options WITH call_id fires the requested_service_id capture', async () => {
    const { app, queries } = buildApp({ queryResponses: [] });
    await post(app, '/agent-tools/scheduling-options', {
      tenant_id: TENANT_ID,
      requirements: { serviceType: 'Haircut' },
      window: { from: '2030-01-01T14:00:00Z', to: '2030-01-01T16:00:00Z' },
      call_id: 'inquiry-call-2',
    });
    await new Promise((r) => setImmediate(r));
    const capture = queries.find((q) => q.text.includes('requested_service_id'));
    expect(capture, 'scheduling-options inquiry must attribute the service').toBeTruthy();
    expect(capture!.params).toEqual([TENANT_ID, 'Haircut', 'inquiry-call-2']);
  });

  it('available-slots WITHOUT call_id does NOT fire the capture', async () => {
    // No call_id → nothing to attribute → the best-effort write is skipped.
    const { app, queries } = buildApp({ queryResponses: [] });
    await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: 'Oil Change',
      date: '2030-01-01',
    });
    await new Promise((r) => setImmediate(r));
    expect(queries.find((q) => q.text.includes('requested_service_id'))).toBeUndefined();
  });

  it('scheduling-options WITHOUT call_id does NOT fire the capture', async () => {
    // Same gate on the other shared caller (captureRequestedService).
    const { app, queries } = buildApp({ queryResponses: [] });
    await post(app, '/agent-tools/scheduling-options', {
      tenant_id: TENANT_ID,
      requirements: { serviceType: 'Haircut' },
      window: { from: '2030-01-01T14:00:00Z', to: '2030-01-01T16:00:00Z' },
    });
    await new Promise((r) => setImmediate(r));
    expect(queries.find((q) => q.text.includes('requested_service_id'))).toBeUndefined();
  });

  it('a whitespace-only service_type does NOT fire the capture (trimmed to empty)', async () => {
    // Guards captureRequestedService's trim — a '   ' serviceType must not
    // issue a useless ILIKE '%   %' write.
    const { app, queries } = buildApp({ queryResponses: [] });
    await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: '   ',
      date: '2030-01-01',
      call_id: 'inquiry-call-3',
    });
    await new Promise((r) => setImmediate(r));
    expect(queries.find((q) => q.text.includes('requested_service_id'))).toBeUndefined();
  });
});

describe('agentTools /available-slots', () => {
  it("THE LIVE BUG: the caller's OWN 2:30 is named as the reason, not invented as one", async () => {
    // WHO: Jaya, SCL_VcKTTgo4kS2v (2026-07-27, CALL_IMPROVEMENTS.md #8).
    // WHAT: she asked for 2:30; her own appointment occupied it; the model was
    //        handed a list with a hole and said "we can only book on the quarter
    //        hour, so 2:30 won't work" — 2:30 IS a quarter hour.
    // WHY: the truth was in the DB the whole time. Now it rides the response.
    const { app } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              service_id: 'svc-1',
              name: 'Programming Consultation',
              duration_minutes: 30,
              price: 0,
              required_skills: [],
            },
          ],
        }, // resolver
        {
          rows: [
            { source: 'shift', start_time: '13:00:00', end_time: '17:00:00', is_caller: false },
            {
              source: 'appointment',
              start_time: '14:30:00',
              end_time: '15:00:00',
              is_caller: true,
            },
          ],
        },
        { rows: [{ default_buffer_minutes: 0 }] }, // buffer
        { rows: [{ timezone: 'America/Chicago' }] }, // tz for the past-time filter
      ],
    });
    const res = await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: 'consultation',
      date: '2099-07-27',
      requested_time: '2:30 PM',
      caller_phone: '7734487716',
    });
    expect(res.statusCode).toBe(200);
    const r = res.json().result;
    expect(r.requested.available).toBe(false);
    expect(r.requested.reason).toBe('occupied_by_caller');
    expect(r.requested.spoken_reason).toBe('You already have an appointment at 2:30 PM.');
    // The spoken line LEADS with their time, then the alternatives.
    expect(r.spoken).toContain('You already have an appointment at 2:30 PM.');
    // And 2:30 really is absent from the list — reason and list agree.
    expect(r.open_times).not.toContain('2:30 PM');
  });

  it("someone ELSE's booking is 'already spoken for' — the other customer is never described", async () => {
    const { app } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              service_id: 'svc-1',
              name: 'Consultation',
              duration_minutes: 30,
              price: 0,
              required_skills: [],
            },
          ],
        },
        {
          rows: [
            { source: 'shift', start_time: '13:00:00', end_time: '17:00:00', is_caller: false },
            {
              source: 'appointment',
              start_time: '14:30:00',
              end_time: '15:00:00',
              is_caller: false,
            },
          ],
        },
        { rows: [{ default_buffer_minutes: 0 }] },
        { rows: [{ timezone: 'America/Chicago' }] },
      ],
    });
    const res = await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: 'consultation',
      date: '2099-07-27',
      requested_time: '2:30 PM',
      caller_phone: '5550001111',
    });
    const r = res.json().result;
    expect(r.requested.reason).toBe('occupied');
    expect(r.requested.spoken_reason).toBe('2:30 PM is already spoken for.');
    // The other customer's identity never appears — their schedule is their
    // business. The explanation carries a time and a verdict, nothing about who.
    expect(r.requested.customer_name).toBeUndefined();
    expect(r.requested.customer_id).toBeUndefined();
    expect(r.requested.spoken_reason).not.toMatch(/with |for [A-Z]/);
  });

  it('a time OUTSIDE the shift says so, instead of implying it is booked', async () => {
    const { app } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              service_id: 'svc-1',
              name: 'Consultation',
              duration_minutes: 30,
              price: 0,
              required_skills: [],
            },
          ],
        },
        {
          rows: [
            { source: 'shift', start_time: '13:00:00', end_time: '17:00:00', is_caller: false },
          ],
        },
        { rows: [{ default_buffer_minutes: 0 }] },
        { rows: [{ timezone: 'America/Chicago' }] },
      ],
    });
    const res = await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: 'consultation',
      date: '2099-07-27',
      requested_time: '9:00 AM',
    });
    const r = res.json().result;
    expect(r.requested.reason).toBe('outside_shift');
    expect(r.requested.spoken_reason).toMatch(/not open/i);
  });

  it('an AVAILABLE requested time is confirmed, with no reason and no alternatives pushed', async () => {
    const { app } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              service_id: 'svc-1',
              name: 'Consultation',
              duration_minutes: 30,
              price: 0,
              required_skills: [],
            },
          ],
        },
        {
          rows: [
            { source: 'shift', start_time: '13:00:00', end_time: '17:00:00', is_caller: false },
          ],
        },
        { rows: [{ default_buffer_minutes: 0 }] },
        { rows: [{ timezone: 'America/Chicago' }] },
      ],
    });
    const res = await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: 'consultation',
      date: '2099-07-27',
      requested_time: '2:30 PM',
    });
    const r = res.json().result;
    expect(r.requested.available).toBe(true);
    expect(r.requested.reason).toBe('available');
    expect(r.requested.spoken_reason).toBeUndefined();
    expect(r.requested.note).toMatch(/book it/i);
    expect(r.open_times).toContain('2:30 PM');
  });

  it('a bare "2" is read as 2 PM by the OPEN HOURS, then answered on its merits', async () => {
    // WHO: any caller who says "can I come in at 2?" — which is most of them.
    // WHAT: the day's 1-5 PM coverage settles which "2" they meant, and the
    //        verdict is about 2:00 PM. Nothing guessed, nothing refused.
    // WHY: 2026-07-31 — refusing the bare hour outright was over-correction;
    //        the shop's own hours are the fact that disambiguates it.
    const { app } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              service_id: 'svc-1',
              name: 'Consultation',
              duration_minutes: 30,
              price: 0,
              required_skills: [],
            },
          ],
        },
        {
          rows: [
            { source: 'shift', start_time: '13:00:00', end_time: '17:00:00', is_caller: false },
            {
              source: 'appointment',
              start_time: '14:00:00',
              end_time: '14:30:00',
              is_caller: true,
            },
          ],
        },
        { rows: [{ default_buffer_minutes: 0 }] },
        { rows: [{ timezone: 'America/Chicago' }] },
      ],
    });
    const res = await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: 'consultation',
      date: '2099-07-27',
      requested_time: '2',
      caller_phone: '7734487716',
    });
    const r = res.json().result;
    // Resolved to the PM reading, and answered about THAT.
    expect(r.requested.time).toBe('2:00 PM');
    expect(r.requested.reason).toBe('occupied_by_caller');
    expect(r.requested.spoken_reason).toBe('You already have an appointment at 2:00 PM.');
  });

  it('NO requested_time → no requested block at all (an unasked explanation is noise)', async () => {
    const { app } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              service_id: 'svc-1',
              name: 'Consultation',
              duration_minutes: 30,
              price: 0,
              required_skills: [],
            },
          ],
        },
        {
          rows: [
            { source: 'shift', start_time: '13:00:00', end_time: '17:00:00', is_caller: false },
          ],
        },
        { rows: [{ default_buffer_minutes: 0 }] },
        { rows: [{ timezone: 'America/Chicago' }] },
      ],
    });
    const res = await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: 'consultation',
      date: '2099-07-27',
    });
    expect(res.json().result.requested).toBeUndefined();
  });

  it('SAD: open_times ENUMERATES every bookable time — the model must never do interval arithmetic', async () => {
    // WHO: a caller asking for 3 PM on a wide-open afternoon.
    // WHEN: 2026-07-14. This route returned ONE PROSE SENTENCE — "We have openings all
    //       day from 1 PM to 5 PM" — and gpt-4o-mini, holding that exact string, told
    //       the caller:
    //
    //         "He has openings from 1 PM to 5 PM. Unfortunately, 3 PM is not in that
    //          time range. Would you like to choose a different time?"
    //
    //       Three o'clock is inside one-to-five. It had CALLED the tool. It had the
    //       right answer in front of it. It then misread the sentence, refused a slot
    //       that was wide open, and the caller settled for a time he did not want.
    // WHY: the earlier version of this bug was the model not calling the tool at all.
    //      We fixed that and found this underneath — a tool result the model cannot
    //      reliably READ is barely better than no tool. Interval reasoning over prose
    //      is exactly what a small model fumbles, and it fumbles it SILENTLY, with the
    //      confidence of something that just looked it up.
    //
    //      So it no longer computes. It looks in a list. This test is that list.
    const { app } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              service_id: 'svc-1',
              name: 'Consultation',
              duration_minutes: 30,
              price: null,
              required_skills: [],
            },
          ],
        },
        // The exact shift Dale actually works: 1 PM to 5 PM, nothing booked.
        { rows: [{ source: 'shift', start_time: '13:00:00', end_time: '17:00:00' }] },
      ],
    });
    const res = await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: 'Consultation',
      date: '2030-01-02',
    });
    expect(res.statusCode).toBe(200);
    const result = res.json().result;

    // The exact time the model talked a real caller out of.
    expect(result.open_times).toContain('3:00 PM');

    // THE CLOSING BOUNDARY IS INCLUSIVE. A meeting may END exactly when the day ends.
    //
    // 4:30 + 30 minutes = 5:00, and the shift runs to 5:00, so 4:30 is the LAST
    // bookable start and it MUST be offered. Getting this wrong by one slot silently
    // deletes the end of every working day — and it is the exact slot a caller reaches
    // for ("can you do the last one before you close?").
    expect(result.open_times).toContain('4:30 PM'); // ends at 5:00 — allowed
    expect(result.open_times[result.open_times.length - 1]).toBe('4:30 PM');

    // ...but not a minute past it. 4:45 would run to 5:15, and 5:00 to 5:30.
    expect(result.open_times).not.toContain('4:45 PM');
    expect(result.open_times).not.toContain('5:00 PM');

    // Every offered time is on the 15-minute grid the booking RPC accepts.
    expect(result.open_times[0]).toBe('1:00 PM');
    for (const t of result.open_times) {
      expect(t).toMatch(/:(00|15|30|45) (AM|PM)$/);
    }

    // ONE SOURCE OF TRUTH. `spoken` is BUILT FROM open_times, and must never contain a
    // prose RANGE — "we have openings all day from 1 PM to 5 PM" is an invitation to do
    // interval arithmetic, and the model accepts it every time. Given a range and a
    // table, it reads the range: on 2026-07-14 it refused 4:30 (in the list) and
    // offered "1:00, 2:30, or 4:00" (not in the list) while the list sat right there.
    // Every clock time it says aloud must be a time it can actually book.
    const spokenTimes = (result.spoken as string).match(/\d{1,2}:\d{2} (AM|PM)/g) ?? [];
    expect(spokenTimes.length).toBeGreaterThan(0);
    for (const t of spokenTimes) {
      expect(result.open_times, `spoken offered ${t}, which is not bookable`).toContain(t);
    }
  });

  it('HAPPY: produces spoken slot string with service + open windows', async () => {
    // WHO: Caller asking "when can you fit me in for an oil change Friday?"
    // WHAT: Single union-all returns service row + shift rows + appointment
    //        rows; route merges shifts, subtracts bookings, speaks result
    const { app, queries } = buildApp({
      queryResponses: [
        // resolver: service name match
        {
          rows: [
            {
              service_id: 'svc-oil-0001',
              name: 'Oil Change',
              duration_minutes: 30,
              price: 45,
              required_skills: [],
            },
          ],
        },
        // shifts + appointments for the day
        {
          rows: [
            { source: 'shift', start_time: '08:00:00', end_time: '17:00:00' },
            {
              source: 'appointment',
              start_time: '2030-01-01T12:00:00',
              end_time: '2030-01-01T13:00:00',
            },
          ],
        },
      ],
    });
    // Use a far-future date so "today" filtering doesn't kick in
    const res = await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: 'Oil Change',
      date: '2030-01-01',
    });
    expect(res.statusCode).toBe(200);
    const text = res.json().result.spoken as string;
    expect(text).toContain('Oil Change takes about 30 minutes');
    expect(text).toContain('$45');
    // WHY: The 12-13 appointment splits the day into 8-12 and 13-17
    // The prose RANGE is gone on purpose. It was the thing the model reasoned over —
    // given "openings all day from 1 PM to 5 PM" AND a list of bookable times, it read
    // the range and invented times that were not in the list. `spoken` is now built
    // FROM open_times, so every clock time it utters is one it can actually book.
    const offered = text.match(/\d{1,2}:\d{2} (AM|PM)/g) ?? [];
    expect(offered.length).toBeGreaterThan(0);
    const bookable = res.json().result.open_times as string[];
    for (const t of offered) expect(bookable).toContain(t);
    // The morning shift AND the afternoon one are both reachable — the sample spans
    // the day rather than reading out the first three slots and stopping.
    expect(bookable).toContain('8:00 AM');
    expect(bookable).toContain('1:00 PM');
    // The resolver name-match query runs FIRST (keyed by tenant + spoken
    // type) and must filter soft-deleted services so a removed service is
    // never priced/quoted back to the caller.
    expect(queries[0].params).toEqual([TENANT_ID, 'Oil Change']);
    expect(queries[0].text).toMatch(/FROM services[\s\S]*is_deleted/);
    // The shifts + appointments query is second, keyed by tenant + date.
    // $3 is the caller's normalized phone for attributing a blocking
    // appointment back to them (2026-07-31); null when the agent sent none.
    // $4 is the resolved service: only shifts of people the skill map links to
    // it count as openings (2026-09-11), matching what the booking RPC enforces.
    expect(queries[1].params).toEqual([TENANT_ID, '2030-01-01', null, 'svc-oil-0001']);
    expect(queries[1].text).toMatch(/service_employee[\s\S]*\$4::uuid/);
  });

  it('HAPPY: unmatched service_type falls through to the tenant default', async () => {
    // WHO: Caller says "I just want a meeting" — no exact service name.
    // WHAT: the resolver name-match misses, falls through to the tenant
    //        default service, and the flow proceeds normally.
    // WHEN: Any call where the spoken service doesn't substring-match a real
    //        service name (the common case — callers don't say exact names).
    // WHERE: resolveServiceForBooking → available-slots.
    // WHY: THE fix. Pre-fix this dead-ended on "couldn't find a service" and
    //        the agent bailed → bookings never happened.
    const { app } = buildApp({
      queryResponses: [
        { rows: [] }, // resolver: name match misses
        // The SEMANTIC step now runs between the name match and the default (see
        // serviceResolver). Here it finds nothing above the threshold — which is the
        // case this test is about — so resolution still falls through to the tenant
        // default, exactly as it always did. A semantic match that is not confident
        // must not displace a default the owner deliberately chose.
        { rows: [] }, // ensureServiceEmbeddings: nothing missing an embedding
        { rows: [] }, // match_service_by_intent: no confident match
        {
          rows: [
            {
              service_id: 'svc-pc-0001',
              name: 'Programming Consultation',
              duration_minutes: 30,
              price: null,
              required_skills: ['consultation'],
            },
          ],
        }, // resolver: tenant default
        { rows: [{ source: 'shift', start_time: '13:00:00', end_time: '17:00:00' }] }, // shifts
      ],
    });
    const res = await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: 'a meeting',
      date: '2030-01-01',
    });
    expect(res.statusCode).toBe(200);
    const text = res.json().result.spoken as string;
    expect(text).toContain('Programming Consultation takes about 30 minutes');
    const offered2 = text.match(/\d{1,2}:\d{2} (AM|PM)/g) ?? [];
    const bookable2 = res.json().result.open_times as string[];
    expect(offered2.length).toBeGreaterThan(0);
    for (const t of offered2) expect(bookable2).toContain(t);
  });

  it('HAPPY: no shifts for the day returns "no one scheduled" message', async () => {
    // WHAT: If the shift array is empty, short-circuit with a friendly
    //        message before doing interval math
    const { app } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              service_id: 'svc-oil-0001',
              name: 'Oil Change',
              duration_minutes: 30,
              price: null,
              required_skills: [],
            },
          ],
        }, // resolver match
        { rows: [] }, // no shifts / appointments
      ],
    });
    const res = await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: 'Oil Change',
      date: '2030-01-01',
    });
    const text = res.json().result.spoken as string;
    expect(text).toContain("don't have anyone scheduled");
  });

  it('SAD: tenant has no bookable service at all → graceful message', async () => {
    // WHO: A tenant with zero services (or none mapped to an employee).
    // WHAT: the resolver returns null after match + default + safety all come
    //        back empty → the route offers to take a message, never crashes.
    // WHEN: Edge case — an unconfigured / empty tenant.
    // WHERE: resolveServiceForBooking returns null → available-slots guard.
    // WHY: An unmatched service must NOT dead-end normally (that's the default
    //        fallthrough above); only a tenant with truly nothing bookable
    //        lands here, and even then we stay graceful.
    const { app } = buildApp({ queryResponses: [{ rows: [] }, { rows: [] }, { rows: [] }] });
    const res = await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: 'Unicorn Polishing',
      date: '2030-01-01',
    });
    expect(res.json().result as string).toMatch(/leave a message|not able to pull up/i);
  });

  it('SAD: malformed date fails Zod regex before DB call', async () => {
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/available-slots', {
      tenant_id: TENANT_ID,
      service_type: 'Oil Change',
      date: 'tomorrow',
    });
    expectValidationFailure(res, queries);
  });

  it('HAPPY: today + partial day elapsed → only future slots quoted', async () => {
    // WHO: Caller at 2:30 PM asking "can I come in today for an oil change?"
    // WHAT: Shift is 8 AM–5 PM with no bookings. Naive logic would offer
    //        "8 AM to 5 PM"; correct logic offers only "2:30 PM to 5 PM"
    //        because AM is already past
    // WHERE: /agent-tools/available-slots when args.date === today's date
    //         in en-CA (YYYY-MM-DD) format
    // WHEN: The date matches today — `isToday` branch activates and
    //        currentMinutes is clamped to the floor of each usable slot
    // WHY: Quoting a past slot is the single worst UX failure here — the
    //        caller could agree to "8 AM" and then the booking RPC would
    //        reject it. This test nails down the time-of-day filter
    //        against a mocked system clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    // The route reads "now" in the TENANT's timezone (the mocked tenant has no
    // timezone row, so the route's COALESCE default — America/Chicago — applies).
    // Pin the clock to an ABSOLUTE instant = 2:30 PM CDT, tz-deterministic on any
    // runner. A local-time constructor (new Date(2030,5,15,14,30)) would be 2:30
    // PM UTC in CI = 9:30 AM Chicago, and 1:00 PM would wrongly read as future.
    vi.setSystemTime(new Date('2030-06-15T19:30:00Z')); // 2:30 PM America/Chicago
    try {
      const { app } = buildApp({
        queryResponses: [
          {
            rows: [
              {
                service_id: 'svc-oil-0001',
                name: 'Oil Change',
                duration_minutes: 30,
                price: null,
                required_skills: [],
              },
            ],
          }, // resolver match
          {
            rows: [{ source: 'shift', start_time: '08:00:00', end_time: '17:00:00' }],
          }, // shifts + appointments
        ],
      });
      const res = await post(app, '/agent-tools/available-slots', {
        tenant_id: TENANT_ID,
        service_type: 'Oil Change',
        date: '2030-06-15',
      });
      const text = res.json().result.spoken as string;
      // The response has two phrases: "our hours are X to Y" (full coverage
      // for context) and "We have openings ..." (only the future slots).
      // The today filter is ONLY about the openings phrase — the context
      // hours line legitimately quotes the shift's full span.
      // Only FUTURE slots — the elapsed part of today is gone from the list itself, so
      // it cannot be spoken. (It used to be excluded from the prose and still reachable
      // by reasoning over the range.)
      const bookable3 = res.json().result.open_times as string[];
      expect(bookable3).not.toContain('1:00 PM'); // already elapsed
      expect(bookable3).toContain('2:30 PM');
      const offered3 = text.match(/\d{1,2}:\d{2} (AM|PM)/g) ?? [];
      for (const t of offered3) expect(bookable3).toContain(t);
      expect(text).not.toMatch(/openings 8 AM/);
      expect(text).not.toMatch(/openings all day from 8/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('SAD: today + whole day elapsed → "fully booked" message (not a crash)', async () => {
    // WHO: Caller at 6 PM asking "any chance today?" for a shop that
    //       closes at 5 PM
    // WHAT: All usable slots fall before currentMinutes → futureSlots is
    //        empty → route must return the "fully booked" fallback
    //        instead of crashing on an empty array index
    // WHERE: /agent-tools/available-slots, today's date
    // WHEN: Current time ≥ coverage[coverage.length-1].end
    // WHY: Before this test existed, nothing exercised the empty-
    //       futureSlots branch on the isToday path. A bug there would
    //       throw on `coverage[0].start` access and return HTTP 500 mid-
    //       call — the agent would hear a tool error and confuse the
    //       caller. This pins the graceful-fallback behavior.
    vi.useFakeTimers({ toFake: ['Date'] });
    // Absolute instant = 6 PM CDT (America/Chicago, the mocked tenant's default
    // tz); tz-deterministic on any runner. See the partial-day test above.
    vi.setSystemTime(new Date('2030-06-15T23:00:00Z')); // 6 PM America/Chicago, shop closed
    try {
      const { app } = buildApp({
        queryResponses: [
          {
            rows: [
              {
                service_id: 'svc-oil-0001',
                name: 'Oil Change',
                duration_minutes: 30,
                price: null,
                required_skills: [],
              },
            ],
          }, // resolver match
          {
            rows: [{ source: 'shift', start_time: '08:00:00', end_time: '17:00:00' }],
          }, // shifts + appointments
        ],
      });
      const res = await post(app, '/agent-tools/available-slots', {
        tenant_id: TENANT_ID,
        service_type: 'Oil Change',
        date: '2030-06-15',
      });
      expect(res.statusCode).toBe(200);
      const text = res.json().result.spoken as string;
      expect(text).toContain('fully booked');
      expect(text).toContain('try a different day');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('agentTools /send-verification-code', () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = 'test-telnyx-key';
    // Default fetch mock: Telnyx returns 200
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );
  });
  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
  });

  it('HAPPY: valid phone under rate limits → inserts row, sends SMS, returns script', async () => {
    // WHO: Caller gave a phone number verbally after caller-ID was blocked
    // WHAT: Route looks up tenant's inbound_phone, checks both rate limits
    //        are under threshold, INSERTs a phone_verifications row, and
    //        sends the Telnyx SMS with the code
    // WHY: Wire-level contract — the agent relays the returned `message`
    //        verbatim so the SMS body and the spoken prompt must stay in
    //        lockstep with the TCPA opt-out language
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ inbound_phone: '+15550001000' }] }, // tenant lookup
        { rows: [{ c: '0' }] }, // per-phone SEND count (0 sends in last hour)
        { rows: [{ c: '5' }] }, // per-tenant send count (well under 100/day)
        { rows: [{ total: '0' }] }, // per-phone failed-ATTEMPT count across all codes
        { rows: [], rowCount: 0 }, // expire any still-live code for this phone
        { rows: [{ phone_verification_id: 'verif-1' }] }, // INSERT phone_verifications
      ],
    });
    const res = await post(app, '/agent-tools/send-verification-code', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.result.sent).toBe(true);
    expect(body.result.phone).toBe('+15551234567');
    expect(body.result.message).toContain('read it back');

    // Queries: tenant lookup, the two SEND rate-limit counts, the per-phone
    // failed-ATTEMPT count, the expiry of any still-live code, then the INSERT.
    // bcrypt is not a client.query so it doesn't appear in queries[].
    //
    // The last two are the 2026-07-13 brute-force fix and are load-bearing:
    //   - the attempt count is per (tenant, phone) across EVERY code issued in
    //     the last hour, because the old per-row cap was reset simply by asking
    //     for a new code (fresh row → attempt_count 0 → three more guesses,
    //     forever, with no lockout).
    //   - expiring the previous code keeps exactly ONE live code per phone. Left
    //     alone, each resend added another valid answer to guess against, so the
    //     effective keyspace SHRANK with every resend — the exact inverse of what
    //     a rate limit is for.
    expect(queries).toHaveLength(6);
    expect(queries[3].text).toContain('SUM(attempt_count)');
    expect(queries[4].text).toContain('SET expires_at = now()');
    expect(queries[5].text).toContain('INSERT INTO phone_verifications');
    // The code is bound to THIS call — a verification with no call_id can never
    // open the disclosure gate (see migration 20260714000000).
    expect(queries[5].text).toContain('call_id');

    // SMS was sent with the correct shape
    const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchCalls).toHaveLength(1);
    const smsBody = JSON.parse((fetchCalls[0][1] as RequestInit).body as string);
    expect(smsBody.from).toBe('+15550001000');
    expect(smsBody.to).toBe('+15551234567');
    expect(smsBody.text).toMatch(
      /Your SecretaryHQ verification code is: \d{4}\. Reply STOP to opt out\./
    );
  });

  it('SAD: invalid phone (under 10 digits after strip) never touches DB or Telnyx', async () => {
    // WHO: LLM passed a garbled phone like "abc123"
    // WHAT: Route rejects before any side effect — the agent hears the
    //        "couldn't catch that number" message and re-prompts the caller
    // WHY: Defensive — if this branch didn't exist the invalid phone would
    //        reach the SMS send and either fail at Telnyx or (worse) send
    //        to whatever string the LLM hallucinated
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/send-verification-code', {
      tenant_id: TENANT_ID,
      phone: 'abc123',
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('area code');
    expect(queries).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('SAD: caller read back a 7-digit local number (no area code) — rejected', async () => {
    // WHO: Caller says "my number is five-five-five, one-two-three-four"
    //       and the LLM dutifully passes "5551234" (7 digits) to the tool
    // WHAT: Route must reject because we can't actually text a 7-digit
    //        string — SMS routing requires area code. Re-prompt with
    //        "starting with the area code" so the LLM asks the caller again.
    // WHERE: /agent-tools/send-verification-code — this is the exact moment
    //         a caller reads a phone number aloud for verification
    // WHEN: Every time caller-ID is blocked/garbled and we ask verbally
    // WHY: Policy established 2026-04-23 — a phone number must be full
    //        (10+ digits) before we'll text a code. Without this test,
    //        a 7-digit number could silently reach Telnyx and either
    //        be rejected there (dead-air UX) or sent to the wrong recipient
    //        if some carrier happened to route it.
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/send-verification-code', {
      tenant_id: TENANT_ID,
      phone: '5551234', // 7 digits — local number, caller forgot area code
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('area code');
    expect(queries).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('SAD: 9-digit number (one digit missed in transcription) — rejected', async () => {
    // WHO: STT dropped a digit — caller said 10, transcript has 9
    // WHAT: Same gate catches this as the 7-digit case; we don't send a
    //        code to a short-one number that would resolve to some other
    //        party's phone
    // WHY: Different mechanism than the 7-digit case (transcription loss
    //        vs. caller omission) but same outcome — reject, re-ask. Tests
    //        both endpoints of the < 10-digit space so the whole branch
    //        is pinned.
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/send-verification-code', {
      tenant_id: TENANT_ID,
      phone: '555123456', // 9 digits
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('area code');
    expect(queries).toHaveLength(0);
  });

  it('SAD: rate-limited per-phone → refuses, offers to take a message', async () => {
    // WHO: Same number has already received 3 codes in the last hour
    //       (possibly a retry loop, possibly abuse)
    // WHAT: Route must not send a 4th — returns a graceful message the
    //        agent can relay to pivot to "take a message" flow
    // WHY: Without this, we become a free SMS relay — cost + abuse risk
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ inbound_phone: '+15550001000' }] }, // tenant
        { rows: [{ c: '3' }] }, // already 3 sends this hour
      ],
    });
    const res = await post(app, '/agent-tools/send-verification-code', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('take a message');
    // No INSERT, no SMS
    expect(queries).toHaveLength(2); // tenant + phone count only
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('SAD: rate-limited per-tenant → refuses even if per-phone count is fine', async () => {
    // WHO: A single tenant has blown past 100 SMS sends in a day (either
    //       a busy day or a bug/abuse spiking volume)
    // WHAT: Route caps at the tenant level too — not just per-phone
    // WHY: Prevents a single tenant's bug/compromise from racking up a
    //       multi-hundred-dollar SMS bill before anyone notices
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ inbound_phone: '+15550001000' }] },
        { rows: [{ c: '0' }] }, // per-phone under limit
        { rows: [{ c: '100' }] }, // per-tenant at limit
      ],
    });
    const res = await post(app, '/agent-tools/send-verification-code', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('take a message');
    expect(queries).toHaveLength(3);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('SAD: tenant has no inbound_phone configured → cannot send from', async () => {
    // WHO: Newly-provisioned tenant whose Telnyx number activation hasn't
    //       completed yet, or an admin removed it
    // WHAT: Route must handle this cleanly — the SMS API requires a
    //        validated `from` number and will 422 without one
    const { app, queries } = buildApp({
      queryResponses: [{ rows: [{ inbound_phone: null }] }],
    });
    const res = await post(app, '/agent-tools/send-verification-code', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain("can't send a text");
    expect(queries).toHaveLength(1); // tenant only, no rate-limit or INSERT
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('SAD: Telnyx send failure surfaces a graceful message to the caller', async () => {
    // WHO: Telnyx returned 422 / 500 / etc. (carrier reject, bad number,
    //       throttling)
    // WHAT: Row was already inserted (we can't transactionally couple the
    //        SMS to the DB) — route returns the "trouble sending" message
    //        so the agent can re-prompt or pivot
    // WHY: Prior code would have crashed silently and left the caller in
    //        an awkward voice dead-air while waiting for a code that
    //        never arrives
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"bad"}', { status: 422 }))
    );
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ inbound_phone: '+15550001000' }] },
        { rows: [{ c: '0' }] },
        { rows: [{ c: '0' }] },
        { rows: [{ phone_verification_id: 'verif-1' }] }, // INSERT still happens
      ],
    });
    const res = await post(app, '/agent-tools/send-verification-code', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('trouble sending');
  });
});

describe('agentTools /verify-phone-code', () => {
  // 4-DIGIT code (2026-07-13 — shortened from 6; it is read back ALOUD on a live
  // call, and a PIN is what people are good at). Hashed with real bcrypt so the
  // verify path is exercised, not stubbed.
  const CODE = '1234';
  let CODE_HASH: string;

  beforeEach(async () => {
    // Compute once per test; 10ms at cost factor 10 is fine.
    const bcrypt = await import('bcrypt');
    CODE_HASH = await bcrypt.hash(CODE, 10);
  });

  it('HAPPY: correct code within TTL → marks verified and returns phone', async () => {
    // WHO: Caller read back the 6-digit code correctly
    // WHAT: Route compares hash, flips verified_at to now(), returns the
    //        normalized phone so the booking flow can continue with a
    //        trusted number
    // WHY: This is the single successful path for OTP — the verified
    //        phone then flows back into /book-appointment with isValidPhone
    //        already true, bypassing the gate
    const futureExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
    const { app, queries } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              id: 'verif-1',
              code_hash: CODE_HASH,
              expires_at: futureExpiry,
              attempt_count: 0,
            },
          ],
        },
        { rows: [] }, // UPDATE SET verified_at
      ],
    });
    const res = await post(app, '/agent-tools/verify-phone-code', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      code: CODE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toEqual({ verified: true, phone: '+15551234567' });
    expect(queries[1].text).toContain('verified_at = now()');
  });

  it('SAD: wrong code → increments attempt_count, surfaces remaining tries', async () => {
    // WHO: Caller misheard or misread the code (happens — "3" vs "E",
    //       "9" vs "nine" phonetic ambiguity)
    // WHAT: Route increments attempt_count and tells the agent how many
    //        tries remain so it can say "you have 1 try left" (max is now 3)
    const futureExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
    const { app, queries } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              id: 'verif-1',
              code_hash: CODE_HASH,
              expires_at: futureExpiry,
              attempt_count: 1,
            },
          ],
        },
        { rows: [] }, // UPDATE SET attempt_count
      ],
    });
    const res = await post(app, '/agent-tools/verify-phone-code', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      code: '9999',
    });
    expect(res.json().success).toBe(false);
    // attempt_count was 1, now 2, max is 5 → 3 remaining
    // MAX_VERIFY_ATTEMPTS is now 3 (was 5). Fixture starts at attempt_count=1, so this
    // failed try is the 2nd → exactly 1 left. Singular copy, deliberately.
    expect(res.json().error).toContain('1 try left');
    expect(queries[1].text).toContain('attempt_count = attempt_count + 1');
  });

  it('SAD: expired code → refuses, offers to resend', async () => {
    // WHO: Caller took longer than 10 minutes to read the code back
    //       (found their phone, got interrupted, etc.)
    // WHAT: Route refuses even if the code would have matched — expired
    //        codes must not verify, full stop
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    const { app } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              id: 'verif-1',
              code_hash: CODE_HASH,
              expires_at: pastExpiry,
              attempt_count: 0,
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/verify-phone-code', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      code: CODE,
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('expired');
  });

  it('SAD: attempt_count at max → refuses, pivots to "take a message"', async () => {
    // WHO: Caller has already guessed 5 times and still hasn't gotten it
    // WHAT: Route refuses to check the hash at all — prevents brute-force
    //        of a 6-digit code over a long call (1-in-a-million per try,
    //        5 tries is the safe cap)
    const futureExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
    const { app, queries } = buildApp({
      queryResponses: [
        {
          rows: [
            {
              id: 'verif-1',
              code_hash: CODE_HASH,
              expires_at: futureExpiry,
              attempt_count: 5,
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/verify-phone-code', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      code: CODE, // even the RIGHT code should be refused
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('take a message');
    expect(queries).toHaveLength(1); // no UPDATE — route bailed
  });

  it('SAD: no pending verification for this phone → tells agent to resend', async () => {
    // WHO: Agent called verify without first calling send (or the caller
    //       switched phones mid-call)
    // WHAT: Route can't verify a code that doesn't exist; must respond
    //        cleanly so the agent can recover by calling send
    const { app } = buildApp({ queryResponses: [{ rows: [] }] });
    const res = await post(app, '/agent-tools/verify-phone-code', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      code: CODE,
    });
    expect(res.json().success).toBe(false);
    expect(res.json().error).toContain('pending code');
  });

  it('SAD: non-numeric code fails Zod before any DB call', async () => {
    // WHO: LLM hallucinated a word-like code ("onenine..." instead of digits)
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/verify-phone-code', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      code: 'abcdef',
    });
    expectValidationFailure(res, queries);
  });
});

describe('agentTools customer persistence on booking failure', () => {
  // Feature areas covered: /agent-tools/book-appointment +
  // /agent-tools/book-with-scheduling. These tests pin the contract that
  // when a NEW caller's phone produces a customer row but the booking RPC
  // then returns failure, the customer row remains in the DB. Regression
  // protection for the 2026-05-08 refactor that pulled customer
  // get-or-create out of the booking transaction (services/customerLookup.ts).

  it('book-appointment: RPC failure does not block the customer INSERT from happening first', async () => {
    // WHO: First-time caller; the requested timeslot just got taken
    // WHAT: Route SHOULD have done SELECT(empty) → INSERT(customer) →
    //        RPC(failure). Even though RPC returns success:false, queries
    //        prove the customer write already executed.
    // WHERE: /agent-tools/book-appointment after the customerLookup refactor
    // WHEN: Voice agent collects a phone, then the slot lookup races a
    //        concurrent booking and loses
    // WHY: Without this guarantee, the agent would have to re-collect the
    //        caller's phone+name on every retry — terrible UX. With it,
    //        the next attempt re-uses the persisted customer_id.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [] }, // SELECT — no existing row
        { rows: [{ customer_id: 'newly-created' }] }, // INSERT — customer persists
        { rows: [{ default_buffer_minutes: 0 }] }, // getTenantBufferMinutes (pre-RPC)
        { rows: [{ timezone: 'America/Chicago' }] }, // getTenantTimezone (local → UTC conversion)
        {
          rows: [
            {
              success: false,
              appointment_id: null,
              error_message: 'That time slot just got booked.',
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/book-appointment', {
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      phone: '5551234567',
      name: 'Carol',
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(false);
    // Critical assertions: the customer SELECT and INSERT happened BEFORE
    // the RPC. If a future refactor put RPC first, queries would be in a
    // different order and these would fail. (queries[2] is the buffer lookup,
    // queries[3] is the getTenantTimezone lookup.)
    expect(queries).toHaveLength(5);
    expect(queries[0].text).toContain('SELECT customer_id FROM customers');
    expect(queries[1].text).toContain('INSERT INTO customers');
    expect(queries[1].params).toEqual([TENANT_ID, '+15551234567', 'Carol']);
    expect(queries[4].text).toContain('book_appointment_atomic');
  });

  it('book-with-scheduling: customer get-or-create runs before the RPC, even when RPC fails', async () => {
    // WHO: First-time caller hitting the scheduling-options branch
    // WHAT: Route SHOULD do SELECT(empty) → INSERT(customer) → RPC(failure)
    //        with NO_AVAILABILITY. Customer persists for the next attempt.
    // WHERE: /agent-tools/book-with-scheduling after the customerLookup refactor
    // WHY: Pre-refactor, customer-create lived inside book_with_scheduling_atomic's
    //        plpgsql body. RETURN-style failure paths happened to commit it via
    //        connection auto-commit, but a future refactor wrapping the call in
    //        explicit BEGIN/COMMIT would have silently rolled it back. Pulling
    //        it into a separate withTenantClient call removes that fragility.
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [] }, // SELECT — no existing row
        { rows: [{ customer_id: 'sched-customer' }] }, // INSERT — customer persists
        // resolver: service name match (runs inside the booking txn, before RPC)
        {
          rows: [
            {
              service_id: 'svc-rot',
              name: 'Tire Rotation',
              duration_minutes: 30,
              price: null,
              required_skills: ['tire'],
            },
          ],
        },
        { rows: [{ default_buffer_minutes: 0 }] }, // getTenantBufferMinutes (pre-RPC)
        { rows: [{ timezone: 'America/Chicago', booking_mechanics: null }] }, // tenant tz + booking_mechanics
        { rows: [] }, // cross-call duplicate guard: no other appointment today (2026-07-31)
        {
          rows: [
            {
              success: false,
              appointment_id: null,
              resource_id: null,
              resource_name: null,
              employee_id: null,
              employee_name: null,
              booked_start: null,
              booked_end: null,
              customer_id: null,
              error_message: 'No available scheduling options',
              error_code: 'NO_AVAILABILITY',
            },
          ],
        },
        // failure branch: buffer lookup + findNextAvailableSlots (tz + slots)
        { rows: [{ default_buffer_minutes: 0 }] },
        { rows: [{ timezone: 'America/Chicago' }] },
        { rows: [] },
      ],
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      name: 'Diane',
      description: 'Tire rotation',
      window: { from: '2026-05-01T14:00:00Z', to: '2026-05-01T18:00:00Z' },
      requirements: {
        serviceType: 'rotation',
        requiredEmployeeSkills: ['tire'],
        requiredResourceCapabilities: [],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(false);
    // Customer write happened BEFORE the RPC, regardless of failure.
    // Order: customer SELECT + customer INSERT + resolver + buffer lookup +
    // tz lookup + RPC, then the failure-branch next-available lookup. The first
    // two are the persistence contract; resolver is queries[2], buffer is
    // queries[3], tz is queries[4], and the RPC is queries[5].
    expect(queries.length).toBeGreaterThanOrEqual(6);
    expect(queries[0].text).toContain('SELECT customer_id FROM customers');
    expect(queries[1].text).toContain('INSERT INTO customers');
    expect(queries[1].params).toEqual([TENANT_ID, '+15551234567', 'Diane']);
    expect(queries[2].text).toMatch(/FROM services/); // resolver service match
    // Positional index would move with every new pre-RPC lookup (the 2026-07-31
    // duplicate guard added one); assert the RPC RAN, which is what this test means.
    expect(queries.some((q) => q.text.includes('book_with_scheduling_atomic'))).toBe(true);
  });

  it('book-with-scheduling: existing customer is reused — SELECT + resolver + RPC fire', async () => {
    // WHAT: Repeat caller — SELECT finds the row, INSERT is skipped, the service
    //        resolver runs, then the RPC fires
    // WHY: Verifies the helper short-circuits correctly in the scheduling path
    //       (mirroring the equivalent test for book-appointment above)
    const { app, queries } = buildApp({
      queryResponses: [
        { rows: [{ customer_id: 'cust-known' }] },
        // resolver: service name match (before the RPC)
        {
          rows: [
            {
              service_id: 'svc-rot',
              name: 'Tire Rotation',
              duration_minutes: 30,
              price: null,
              required_skills: ['tire'],
            },
          ],
        },
        { rows: [{ default_buffer_minutes: 0 }] }, // getTenantBufferMinutes
        { rows: [{ timezone: 'America/Chicago', booking_mechanics: null }] }, // tenant tz + booking_mechanics
        { rows: [] }, // cross-call duplicate guard: no other appointment today (2026-07-31)
        {
          rows: [
            {
              success: true,
              appointment_id: 'sched-appt',
              resource_id: 'r1',
              resource_name: 'Truck 1',
              employee_id: 'e1',
              employee_name: 'Mike',
              booked_start: '2026-05-01T14:00:00Z',
              booked_end: '2026-05-01T14:30:00Z',
              customer_id: 'cust-known',
              error_message: null,
              error_code: null,
            },
          ],
        },
      ],
    });
    const res = await post(app, '/agent-tools/book-with-scheduling', {
      tenant_id: TENANT_ID,
      phone: '5551234567',
      description: 'Tire rotation',
      window: { from: '2026-05-01T14:00:00Z', to: '2026-05-01T18:00:00Z' },
      requirements: {
        serviceType: 'rotation',
        requiredEmployeeSkills: ['tire'],
        requiredResourceCapabilities: [],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    // 5 core queries (SELECT customer + resolver service match + buffer lookup +
    // tz lookup + RPC); reminder scheduling fires additional queries fire-and-forget after.
    expect(queries.length).toBeGreaterThanOrEqual(5);
    expect(queries[0].text).toContain('SELECT customer_id FROM customers');
    expect(queries[1].text).toMatch(/FROM services/); // resolver service match
    // after buffer + tz lookup + the cross-call duplicate guard (2026-07-31)
    expect(queries.some((q) => q.text.includes('book_with_scheduling_atomic'))).toBe(true);
  });
});

describe('agentTools /voice-session-start + /voice-session-end (call logging)', () => {
  it("a SILENT call's anonymous phonebook entry is pruned at hang-up", async () => {
    // WHO: the robocall / wrong number that leaves a customer named literally
    //       "Caller" (CALL_IMPROVEMENTS.md #3).
    // WHAT: voice-session-end soft-deletes that row — but ONLY when the caller
    //        never spoke, the name is still a placeholder, the row has no
    //        appointment/message/job-inquiry, and no OTHER call is linked to it.
    // WHY: creating the row up front is a DELIBERATE 2026-07-27 fix (prod had 10
    //       calls with caller ID and ZERO linked customers). We keep that and
    //       prune at the END, when the call has told us which kind it was —
    //       rather than deciding at the start whose call is worth recording.
    const { app, queries } = buildApp({
      queryResponses: [{ rows: [{ ended: true }] }, { rows: [], rowCount: 1 }],
    });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'SCL_JqvihjHH9nqp',
      duration_seconds: 31,
      transcript: "Assistant [0:00]: Thanks for calling! I'm Piper.",
    });
    expect(res.statusCode).toBe(200);
    const prune = queries.find((q) => q.text.includes("deleted_by = 'silent_call_prune'"))!;
    expect(prune).toBeDefined();
    // SOFT delete — the phonebook is cleaned, the audit trail survives.
    expect(prune.text).toContain('is_deleted = true');
    // Every safety clause must be present, or this prunes real people.
    expect(prune.text).toContain('FROM appointments');
    expect(prune.text).toContain('FROM customer_messages');
    expect(prune.text).toContain('FROM job_inquiries');
    expect(prune.text).toContain('other.call_id <> $2');
  });

  it('a hangup with NO caller speech is COUNTED, bucketed either side of the silent-call line', async () => {
    // WHO: four calls on 2026-07-27, 13-42s, greeting and nothing else
    //      (CALL_IMPROVEMENTS.md #4, #5, #6, #11).
    // WHAT: silent_hangups_total, separate from the no_caller_audio alarm. Named
    //       for what it tests — batch F put the runtime's check-in and goodbye
    //       INTO the transcript, so "greeting only" stopped being true of these
    //       calls the same day it shipped (review catch on #314).
    // WHY: nobody could say whether that afternoon meant a long greeting, a
    //       surprised caller, or a bad day — because nothing counted them. #4
    //       says measure before shortening the greeting; this is the measurement.
    const before = counterValue('silent_hangups_total', { bucket: 'under_20s' });
    const { app } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'SCL_nqDRGYRWXbHi',
      duration_seconds: 13,
      transcript: "Assistant [0:00]: Thanks for calling! I'm Piper.",
    });
    expect(counterValue('silent_hangups_total', { bucket: 'under_20s' })).toBe(before + 1);
  });

  it("the runtime's OWN check-in and goodbye do not stop it counting", async () => {
    // Batch F made the silence watchdog speak into the transcript, so a call
    // where nobody spoke now holds three assistant lines. The metric asks "did
    // the CALLER ever speak", and must not be fooled by our own voice.
    const before = counterValue('silent_hangups_total', { bucket: 'under_20s' });
    const { app } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'SCL_silence_watch',
      duration_seconds: 18,
      transcript:
        "Assistant [0:00]: Thanks for calling! I'm Piper.\n" +
        'Assistant [0:11]: Are you still there? I can take a message or set up a time.\n' +
        "Assistant [0:23]: I'll let you go for now — do call back any time.",
    });
    expect(counterValue('silent_hangups_total', { bucket: 'under_20s' })).toBe(before + 1);
  });

  it('a call where the caller spoke is NOT a silent hangup', async () => {
    const before = counterValue('silent_hangups_total', { bucket: 'over_20s' });
    const { app } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'SCL_spoke',
      duration_seconds: 45,
      transcript: 'Assistant [0:00]: Hello.\nCaller [0:05]: Hi there.',
    });
    expect(counterValue('silent_hangups_total', { bucket: 'over_20s' })).toBe(before);
  });

  it('a MISSING transcript never prunes — a capture failure is not evidence of silence', async () => {
    // Review catch on #313, and the sharpest kind: the original condition read
    // `args.transcript ?? ''`, so a finalize that carried NO transcript (agent
    // crash, recorder never drained) looked identical to "nobody spoke" — on a
    // DELETE path. That would erase a real customer on the strength of our own
    // bug. Absence of evidence is not evidence of absence, least of all here.
    const { app, queries } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'SCL_no_transcript',
      duration_seconds: 45,
      // transcript omitted entirely
    });
    expect(res.statusCode).toBe(200);
    expect(queries.some((q) => q.text.includes("deleted_by = 'silent_call_prune'"))).toBe(false);
  });

  it('a call where the caller SPOKE never prunes — speech means a lead, not litter', async () => {
    const { app, queries } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'SCL_real',
      duration_seconds: 60,
      transcript: 'Assistant [0:00]: Hello.\nCaller [0:04]: Hi, I need an oil change.',
    });
    expect(queries.some((q) => q.text.includes("deleted_by = 'silent_call_prune'"))).toBe(false);
  });

  it('HAPPY: start creates the voice_sessions row via start_voice_session', async () => {
    // WHO: the LiveKit agent on connect, after it resolves call_id + caller.
    // WHAT: posts tenant_id/call_id/caller_phone → route calls
    //        start_voice_session($1,$2,$3) with those exact values so the
    //        dashboard Calls tab + customer history get a row.
    // WHEN: once per inbound call, fire-and-forget (never blocks the greeting).
    // WHERE: src/routes/agentTools.ts /agent-tools/voice-session-start.
    // WHY: before this the agent never logged calls — the Calls tab stayed
    //       empty because nothing in prod called start_voice_session.
    const { app, queries } = buildApp({
      queryResponses: [{ rows: [{ context: { is_known_customer: false } }] }],
    });
    const res = await post(app, '/agent-tools/voice-session-start', {
      tenant_id: TENANT_ID,
      call_id: 'call-abc-123',
      caller_phone: '+15551234567',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, result: { started: true } });
    expect(queries[0].text).toContain('start_voice_session');
    expect(queries[0].params).toEqual([TENANT_ID, 'call-abc-123', '+15551234567']);
  });

  it('HAPPY: start tolerates a null caller_phone (caller-ID withheld)', async () => {
    // WHO: a caller whose number the SIP leg never surfaced.
    // WHAT: caller_phone omitted → route passes null to start_voice_session,
    //        which still logs the call (unknown-customer context).
    // WHY: a withheld caller-ID must not stop the call from being logged.
    const { app, queries } = buildApp({ queryResponses: [{ rows: [{ context: {} }] }] });
    const res = await post(app, '/agent-tools/voice-session-start', {
      tenant_id: TENANT_ID,
      call_id: 'call-no-phone',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(queries[0].params).toEqual([TENANT_ID, 'call-no-phone', null]);
  });

  it('SAD: start with no call_id fails validation before any DB call', async () => {
    // WHO: a malformed agent request (bug) with no call_id.
    // WHAT: Zod rejects (call_id min 1) → success:false, zero queries.
    // WHY: there's nothing to key a session on without a call_id; fail loud,
    //       don't write a junk row.
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/voice-session-start', {
      tenant_id: TENANT_ID,
    });
    expectValidationFailure(res, queries);
  });

  it('SAD: start returns 500 (not silent) when start_voice_session throws', async () => {
    // WHO: a forwarded-line/anonymous caller whose caller_phone is null.
    // WHAT: start_voice_session() rejects (e.g. a NOT NULL / 23502 violation) →
    //        the route must surface a failure (500, success:false), NOT a 200
    //        success, so the agent's fire-and-forget .catch fires and the
    //        backend logs the 5W diagnostic + bumps errors_total.
    // WHEN: call connect, the exact path that left the first real __PERSONA_NAME__ call
    //        unlogged with no trace (feedback_sad_path_instrumentation).
    // WHERE: /agent-tools/voice-session-start → catch → fail(reply, …, 500).
    // WHY: a swallowed failure here = empty Calls tab + zero diagnosability;
    //       the fix makes the sad path loud.
    const pgErr = Object.assign(new Error('null value in column "caller_phone"'), {
      code: '2350',
      column: 'caller_phone',
      table: 'voice_sessions',
    });
    const { app, queries } = buildApp({
      queryResponses: [],
      queryThrows: (text) => (text.includes('start_voice_session') ? pgErr : null),
    });
    const res = await post(app, '/agent-tools/voice-session-start', {
      tenant_id: TENANT_ID,
      call_id: 'call-forwarded-1',
      caller_phone: null,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().success).toBe(false);
    // The RPC was actually attempted (not short-circuited) before failing.
    expect(queries[0].text).toContain('start_voice_session');
  });

  it('HAPPY: end records duration via end_voice_session and returns ended', async () => {
    // WHO: the agent's shutdown callback when the caller hangs up.
    // WHAT: posts call_id + duration_seconds → end_voice_session($1..$7) with
    //        duration set; transcript omitted here → null, summary/appointment
    //        still deferred (null).
    // WHEN: awaited inside addShutdownCallback so the row closes before the
    //        job process tears down.
    // WHERE: /agent-tools/voice-session-end.
    // WHY: without the end call the row would sit "active" forever with no
    //       duration — the Calls tab would show every call as never-ended.
    const { app, queries } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'call-abc-123',
      duration_seconds: 142,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, result: { ended: true } });
    expect(queries[0].text).toContain('end_voice_session');
    // duration set; outcome/transcript/summary/appointment_id absent → null.
    expect(queries[0].params).toEqual([TENANT_ID, 'call-abc-123', 142, null, null, null, null]);
  });

  it('HAPPY: end persists the call transcript into end_voice_session param 5', async () => {
    // WHO: the agent shutdown callback after a real conversation — it renders
    //        the accumulated Caller:/Assistant: turns and sends them.
    // WHAT: transcript lands in the 5th positional arg (p_transcript); summary
    //        + appointment_id (params 6,7) stay null (still deferred).
    // WHERE: /agent-tools/voice-session-end → end_voice_session($1..$7).
    // WHY: this is the write half of call-transcript capture — the Calls tab's
    //       transcript section reads exactly this column back.
    const transcript = 'Assistant: Thanks for calling.\nCaller: I need an oil change.';
    const { app, queries } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'call-abc-123',
      duration_seconds: 88,
      transcript,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, result: { ended: true } });
    // param order: tenant, call, duration, outcome, transcript, summary, appt.
    expect(queries[0].params).toEqual([
      TENANT_ID,
      'call-abc-123',
      88,
      null,
      transcript,
      null,
      null,
    ]);
  });

  it('SAD: owner outcome-follow-up SMS fails — call still ends cleanly, and the failure is logged locally', async () => {
    // WHO: platform operator, not the caller — the call itself ended fine.
    // WHAT: sendSms resolves ok:false on a real Telnyx 500 (it never rejects —
    //       see telnyxSms.ts); before this fix, a bare .catch() here could
    //       never fire, so a failed owner-nudge produced no local log line.
    // WHERE: end_voice_session's outcome-follow-up SMS branch — fires only for
    //        outcome in ('price', 'no_availability') with both phones set.
    process.env.TELNYX_API_KEY = 'test-telnyx-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('server error', { status: 500 }))
    );
    try {
      const { app } = buildApp({
        queryResponses: [
          { rows: [{ ended: true }] },
          { rows: [{ forward_phone: '+16305550100', inbound_phone: '+16305550101' }] },
        ],
      });
      const logErrorSpy = vi.spyOn(app.log, 'error');

      const res = await post(app, '/agent-tools/voice-session-end', {
        tenant_id: TENANT_ID,
        call_id: 'call-price-1',
        duration_seconds: 60,
        outcome: 'price',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      // Fire-and-forget: give the unhandled .then() a tick to run.
      await new Promise((r) => setTimeout(r, 0));

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(logErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: 500 }),
        'Failed to send outcome-follow-up SMS to owner'
      );
    } finally {
      delete process.env.TELNYX_API_KEY;
    }
  });

  it('SAD: a long call whose transcript holds no Caller line bumps errors_total{no_caller_audio}', async () => {
    // WHO: a real caller who dialed in, heard the greeting, and spoke.
    // WHAT: the finalized transcript holds ONLY the agent's greeting — not one
    //        caller turn — on a call that ran well past the greeting. The route
    //        counts it as no_caller_audio.
    // WHEN: 2026-07-24. Dale's wife called the live line twice, spoke both
    //        times, and both calls stored exactly this shape: 31 seconds,
    //        status 'completed', greeting-only transcript. Telnyx was handing
    //        LiveKit codecs it cannot decode (G729; G722 suspected), so nothing
    //        decodable ever reached the agent — Silero VAD never fired once.
    // WHERE: /agent-tools/voice-session-end, after end_voice_session returns.
    // WHY: the product said NOTHING. Three of four real calls failed this way
    //        and every one of them was recorded 'completed'. It surfaced only
    //        because she mentioned the call in conversation. A call that
    //        captures zero caller speech is a failure and must be counted.
    const before = errorCount('no_caller_audio');
    const { app } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'SCL_mjZqwTvfCjcC',
      duration_seconds: 31,
      transcript: "Assistant: Thanks for calling! I'm Piper, Dale's AI Assistant.",
    });
    expect(res.statusCode).toBe(200);
    // The call still finalizes normally — the alarm observes, it never blocks.
    expect(res.json()).toEqual({ success: true, result: { ended: true } });
    expect(errorCount('no_caller_audio')).toBe(before + 1);
  });

  it('SAD: a long call with NO transcript at all counts as no_caller_audio', async () => {
    // WHO: a call where not even the greeting was recorded.
    // WHAT: transcript omitted entirely → SQL NULL. Still zero caller speech on
    //        a 45-second call, so it counts.
    // WHERE: /agent-tools/voice-session-end.
    // WHY: null is the MORE broken case, not an exemption — guarding only on a
    //        non-null transcript would let the worst calls through silently.
    const before = errorCount('no_caller_audio');
    const { app } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'call-silent-null',
      duration_seconds: 45,
    });
    expect(res.statusCode).toBe(200);
    expect(errorCount('no_caller_audio')).toBe(before + 1);
  });

  it('HAPPY: a normal two-sided call does NOT bump errors_total{no_caller_audio}', async () => {
    // WHO: a caller who was heard.
    // WHAT: the transcript carries a real Caller line → no alarm.
    // WHERE: /agent-tools/voice-session-end.
    // WHY: the alarm is only useful if it is silent on healthy calls; a counter
    //        that ticks on every call is a counter nobody reads.
    const before = errorCount('no_caller_audio');
    const { app } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'call-healthy',
      duration_seconds: 120,
      transcript: 'Assistant: How can I help?\nCaller: I need an oil change.',
    });
    expect(res.statusCode).toBe(200);
    expect(errorCount('no_caller_audio')).toBe(before);
  });

  it('HAPPY: a TIMESTAMPED caller line ("Caller [0:12]: …") is a caller turn — no alarm', async () => {
    // WHO: an agent built after 2026-07-30, whose transcript lines carry m:ss
    //      offsets (CALL_IMPROVEMENTS.md batch H).
    // WHY: this regex once matched only the bare "Caller: " — left unchanged it
    //      would have flagged EVERY healthy call as no_caller_audio the moment
    //      the timestamped agent deployed, drowning the real codec alarm.
    const before = errorCount('no_caller_audio');
    const { app } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'call-healthy-stamped',
      duration_seconds: 120,
      transcript: 'Assistant [0:00]: How can I help?\nCaller [0:12]: I need an oil change.',
    });
    expect(res.statusCode).toBe(200);
    expect(errorCount('no_caller_audio')).toBe(before);
  });

  it('HAPPY: tool_calls payload is MERGED into voice_sessions.metadata', async () => {
    // WHO: the agent's finalize pass shipping the per-call tool trace.
    // WHAT: after end_voice_session, the route runs a metadata || merge keyed
    //        (tenant_id, call_id) with the payload under 'tool_calls'.
    // WHY: the Pino copy of this data rotates with the container — the 07-27
    //        calls lost every tool trace to a restart and call #8's postmortem
    //        ended at three undecidable causes. This makes it one SQL query.
    const toolCalls = {
      entries: [
        { t: 4200, tool: 'get_available_slots', args: { date: '2026-07-30' }, ok: true, ms: 180 },
        { t: 9100, tool: 'book_with_scheduling', args: {}, ok: false, ms: 240 },
      ],
      dropped: 0,
    };
    const { app, queries } = buildApp({
      queryResponses: [{ rows: [{ ended: true }] }, { rows: [] }],
    });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'call-traced',
      duration_seconds: 90,
      transcript: 'Assistant [0:00]: Hello.\nCaller [0:05]: Book me in.',
      tool_calls: toolCalls,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, result: { ended: true } });
    const merge = queries.find((q) => q.text.includes("jsonb_build_object('tool_calls'"))!;
    expect(merge).toBeDefined();
    expect(merge.text).toContain('metadata'); // a merge (||), never a SET-overwrite
    expect(merge.text).toContain('||');
    expect(merge.params).toEqual([TENANT_ID, 'call-traced', JSON.stringify(toolCalls)]);
  });

  it('HAPPY: an end WITHOUT tool_calls runs no metadata write — omission never erases', async () => {
    // WHY: the enrich pass re-calls this route without tool_calls; a merge on
    //      that second call with an empty value would wipe the finalize's trace.
    const { app, queries } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'call-no-trace',
      duration_seconds: 60,
      transcript: 'Assistant [0:00]: Hello.\nCaller [0:04]: Hi.',
      summary: 'Caller said hi.',
    });
    expect(res.statusCode).toBe(200);
    expect(queries.some((q) => q.text.includes('jsonb_build_object'))).toBe(false);
  });

  it('SAD: an oversized tool_calls payload is rejected by the schema, not written', async () => {
    // WHY: metadata is unbounded jsonb; the size refine is the only thing
    //      between a buggy agent loop and a multi-MB row.
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'call-huge-trace',
      duration_seconds: 60,
      tool_calls: {
        entries: Array.from({ length: 200 }, (_, i) => ({
          t: i,
          tool: 'x'.repeat(100),
          args: { blob: 'y'.repeat(700) },
          ok: true,
          ms: 1,
        })),
        dropped: 0,
      },
    });
    expect(res.statusCode).toBe(200); // agent-tools speak failure at 200
    expect(res.json().success).toBe(false);
    expect(queries).toHaveLength(0); // nothing reached the DB
  });

  it('HAPPY: a short hang-up does NOT bump errors_total{no_caller_audio}', async () => {
    // WHO: a caller who hung up during the greeting.
    // WHAT: 12 seconds, greeting-only transcript — under SILENT_CALL_MIN_SECONDS,
    //        so it is NOT counted as broken audio.
    // WHERE: /agent-tools/voice-session-end.
    // WHY: the cached greeting alone runs ~12s. A caller who never got a turn
    //        proves nothing about the audio path, and a false "your phone line
    //        is broken" alarm would train the owner to ignore the real one.
    const before = errorCount('no_caller_audio');
    const { app } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'call-quick-hangup',
      duration_seconds: 12,
      transcript: "Assistant: Thanks for calling! I'm Piper.",
    });
    expect(res.statusCode).toBe(200);
    expect(errorCount('no_caller_audio')).toBe(before);
  });

  it('SAD: "Caller:" inside the agent\'s own words does not fake a caller turn', async () => {
    // WHO: an agent turn that happens to speak the word "Caller:" mid-sentence.
    // WHAT: the match is anchored to the start of a line, so an inline
    //        occurrence still counts as no_caller_audio.
    // WHERE: /agent-tools/voice-session-end — mirrors the anchored CALLER_LINE
    //        regex in agent/src/transcript.ts.
    // WHY: an unanchored regex would silently suppress the alarm on exactly the
    //        broken calls it exists to catch.
    const before = errorCount('no_caller_audio');
    const { app } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'call-inline-label',
      duration_seconds: 40,
      transcript: 'Assistant: I will note that as Caller: unknown for now.',
    });
    expect(res.statusCode).toBe(200);
    expect(errorCount('no_caller_audio')).toBe(before + 1);
  });

  it('HAPPY: end forwards outcome, summary, and appointment_id (params 4,6,7)', async () => {
    // WHO: the agent shutdown callback after a call that booked an appointment.
    // WHAT: outcome='booked', a post-call summary, and the booked appointment_id
    //        land in end_voice_session params 4, 6, 7 — closing the call->
    //        appointment back-link the Calls tab deep-links on.
    // WHEN: once at teardown, after the booking tool recorded the id.
    // WHERE: /agent-tools/voice-session-end → end_voice_session($1..$7).
    // WHY: these three were hardcoded null before (Calls tab was duration-only);
    //       this pins that a real payload reaches the RPC in the right slots.
    const apptId = '11111111-2222-4333-8444-555555555555';
    const summary = 'Caller booked an oil change for Thursday.';
    const { app, queries } = buildApp({ queryResponses: [{ rows: [{ ended: true }] }] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'call-abc-123',
      duration_seconds: 120,
      outcome: 'booked',
      transcript: 'Caller: oil change please.',
      summary,
      appointment_id: apptId,
    });
    expect(res.statusCode).toBe(200);
    expect(queries[0].params).toEqual([
      TENANT_ID,
      'call-abc-123',
      120,
      'booked',
      'Caller: oil change please.',
      summary,
      apptId,
    ]);
  });

  it('SAD: end rejects a malformed appointment_id before any DB call', async () => {
    // WHO: a buggy/hostile caller sending a non-UUID appointment_id.
    // WHAT: appointment_id not a UUID → Zod rejects → success:false, zero queries.
    // WHY: the RPC casts param 7 to ::uuid; an invalid id would 500 the RPC and
    //       lose the whole session-end write. Validating at the edge keeps the
    //       duration/transcript write safe and the error a clean 400-shape.
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'call-abc-123',
      duration_seconds: 5,
      appointment_id: 'not-a-uuid',
    });
    expectValidationFailure(res, queries);
  });

  it('SAD: end rejects an over-length transcript before any DB call', async () => {
    // WHO: a pathological / abusive call producing a multi-MB transcript.
    // WHAT: transcript > 100k chars → Zod max(100_000) rejects → success:false,
    //        zero queries (no giant row written).
    // WHY: the column is unbounded TEXT; the schema bound is the guardrail that
    //       mirrors the agent's MAX_TRANSCRIPT_CHARS truncation.
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'call-abc-123',
      duration_seconds: 5,
      transcript: 'x'.repeat(100_001),
    });
    expectValidationFailure(res, queries);
  });

  it('HAPPY: end returns ended:false when no open session matches the call_id', async () => {
    // WHO: a duplicate/late shutdown for a call_id with no open row.
    // WHAT: end_voice_session returns false → route surfaces ended:false at
    //        200 (not an error) so the agent's swallow-on-failure stays quiet.
    // WHY: a missing row on teardown is benign, not a crash.
    const { app } = buildApp({ queryResponses: [{ rows: [{ ended: false }] }] });
    const res = await post(app, '/agent-tools/voice-session-end', {
      tenant_id: TENANT_ID,
      call_id: 'call-missing',
      duration_seconds: 5,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, result: { ended: false } });
  });

  it('HAPPY: incremental transcript update writes to the active row', async () => {
    // WHO: the agent, after each conversation turn.
    // WHAT: posts the transcript-so-far → UPDATE voice_sessions SET transcript
    //        WHERE status='active'; returns updated:true when a row matched.
    // WHEN: every turn — so a hung/never-finalized call still shows its content.
    // WHERE: /agent-tools/voice-session-transcript.
    // WHY: durability — the conversation must persist even if voice-session-end
    //       never fires (the dead-air bug left rows with no transcript).
    const { app, queries } = buildApp({ queryResponses: [{ rows: [], rowCount: 1 }] });
    const res = await post(app, '/agent-tools/voice-session-transcript', {
      tenant_id: TENANT_ID,
      call_id: 'call-live-1',
      transcript: 'Assistant: Hi, this is Chris.\nCaller: I need to reach Dale.',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, result: { updated: true } });
    expect(queries[0].text).toContain('UPDATE voice_sessions');
    expect(queries[0].text).toContain("status = 'active'");
    expect(queries[0].params?.[1]).toBe('call-live-1');
  });

  it('SAD: incremental transcript update returns updated:false when no active row', async () => {
    // WHAT: a finalized/missing row matches 0 rows → updated:false (NOT an error).
    // WHY: a late straggler after finalize must not error or overwrite the
    //       authoritative finalized transcript.
    const { app } = buildApp({ queryResponses: [{ rows: [], rowCount: 0 }] });
    const res = await post(app, '/agent-tools/voice-session-transcript', {
      tenant_id: TENANT_ID,
      call_id: 'call-already-done',
      transcript: 'Caller: late line',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, result: { updated: false } });
  });
});

// The 2026-07-23 double-dispatch observability: the agent reports a ghost
// dispatch (no participant) it left, and the backend flags a forked call (two
// sessions, same caller, within 30s). Both are metric-only.
const TID = '11111111-1111-4111-8111-111111111111';

describe('/agent-tools/report-dispatch-no-participant', () => {
  it('HAPPY: bumps errors_total{dispatch_no_participant} and writes no DB row', async () => {
    // WHO: the agent leaving a ghost/duplicate dispatch (empty room).
    // WHY: the ghost-leg RATE must be visible on /metrics; there is deliberately
    //      no voice_sessions row for a call nobody was ever on.
    const { app, queries } = buildApp({ queryResponses: [] });
    const before = errorCount('dispatch_no_participant');

    const res = await post(app, '/agent-tools/report-dispatch-no-participant', {
      tenant_id: TID,
      room: 'room:call-_6505551234_abc',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, result: { recorded: true } });
    expect(errorCount('dispatch_no_participant')).toBe(before + 1);
    expect(queries).toHaveLength(0); // no DB write for a participant-less dispatch
  });

  it('SAD: rejects a missing room before doing anything', async () => {
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/report-dispatch-no-participant', { tenant_id: TID });
    expectValidationFailure(res, queries);
  });
});

describe('/agent-tools/report-call-transfer-failed', () => {
  it('HAPPY: bumps errors_total{call_transfer_failed} and writes no DB row', async () => {
    // WHO: agent/src has no metrics endpoint of its own, so a failed live SIP
    //      transfer reports here the same way a ghost dispatch does above.
    // WHY: the transfer FAILURE RATE must be visible on /metrics; there is no
    //      DB write — the call's own log line at the transfer site is the
    //      primary record.
    const { app, queries } = buildApp({ queryResponses: [] });
    const before = errorCount('call_transfer_failed');

    const res = await post(app, '/agent-tools/report-call-transfer-failed', {
      tenant_id: TID,
      room: 'sip-room-1',
      reason: 'transfer_failed',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, result: { recorded: true } });
    expect(errorCount('call_transfer_failed')).toBe(before + 1);
    expect(queries).toHaveLength(0);
  });

  it('HAPPY: a timeout bumps errors_total{call_transfer_timeout} distinctly from a hard failure', async () => {
    const { app } = buildApp({ queryResponses: [] });
    const before = errorCount('call_transfer_timeout');

    const res = await post(app, '/agent-tools/report-call-transfer-failed', {
      tenant_id: TID,
      room: 'sip-room-1',
      reason: 'transfer_timeout',
    });

    expect(res.statusCode).toBe(200);
    expect(errorCount('call_transfer_timeout')).toBe(before + 1);
  });

  it('SAD: rejects a missing/invalid reason before doing anything', async () => {
    const { app, queries } = buildApp({ queryResponses: [] });
    const res = await post(app, '/agent-tools/report-call-transfer-failed', {
      tenant_id: TID,
      room: 'sip-room-1',
      reason: 'something_else',
    });
    expectValidationFailure(res, queries);
  });
});

describe('/agent-tools/voice-session-start — duplicate-dispatch detector', () => {
  it('SAD: a second session for the same caller within 30s bumps the counter', async () => {
    // WHO: a forked inbound call — two SIP legs, same caller_phone, seconds apart
    //      (the 1:46 PM 2026-07-23 call). WHY: surface the fork RATE without
    //      affecting call logging.
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ context: {} }] }, // start_voice_session
        // 2026-07-27: the route now get-or-creates the CALLER as a customer and
        // links the session to them, so an inbound call is recorded in the CRM.
        // Those two writes sit between start_voice_session and the detector.
        { rows: [] }, // SELECT customers → miss
        { rows: [{ customer_id: 'cust-new' }] }, // INSERT INTO customers
        { rows: [], rowCount: 1 }, // UPDATE voice_sessions SET customer_id
        { rows: [{ n: 2 }] }, // duplicate-detector count: two prior live sessions
      ],
    });
    const before = errorCount('duplicate_dispatch_detected');

    const res = await post(app, '/agent-tools/voice-session-start', {
      tenant_id: TID,
      call_id: 'SCL_secondLeg',
      caller_phone: '+16505551234',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(errorCount('duplicate_dispatch_detected')).toBe(before + 1);
  });

  it('HAPPY: a lone session for a caller does NOT bump the counter', async () => {
    const { app } = buildApp({
      queryResponses: [
        { rows: [{ context: {} }] }, // start_voice_session
        { rows: [] }, // SELECT customers → miss (see note above)
        { rows: [{ customer_id: 'cust-new' }] }, // INSERT INTO customers
        { rows: [], rowCount: 1 }, // UPDATE voice_sessions SET customer_id
        { rows: [{ n: 0 }] }, // no prior sessions
      ],
    });
    const before = errorCount('duplicate_dispatch_detected');

    await post(app, '/agent-tools/voice-session-start', {
      tenant_id: TID,
      call_id: 'SCL_only',
      caller_phone: '+16505559999',
    });

    expect(errorCount('duplicate_dispatch_detected')).toBe(before);
  });

  it('HAPPY: an anonymous caller (no phone) skips the detector query entirely', async () => {
    // No caller_phone → nothing to correlate on → the detector must not run.
    const { app, queries } = buildApp({ queryResponses: [{ rows: [{ context: {} }] }] });

    await post(app, '/agent-tools/voice-session-start', {
      tenant_id: TID,
      call_id: 'room:call-_anon',
    });

    // Exactly one query (start_voice_session); no duplicate-count SELECT.
    expect(queries.filter((q) => q.text.includes('count(*)'))).toHaveLength(0);
  });
});
