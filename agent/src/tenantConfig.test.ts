/**
 * Tests for `fetchTenantConfig` — the agent worker's per-call lookup of
 * the tenant's display name + IANA timezone. Verifies the success path
 * and each fallback path so a misconfigured / unreachable backend never
 * crashes a live call.
 *
 * The contract under test is fail-soft: anything other than a clean
 * `{ success: true, result: { name, timezone } }` envelope must yield
 * the `TENANT_FALLBACK` constant. The whole point of this helper is
 * that going silent on the caller is worse than greeting with a
 * generic name.
 *
 * Per project convention, every test below carries a 5W
 * (WHO/WHAT/WHEN/WHERE/WHY) header so a sad-path failure tells the
 * debugger what behavior was expected and why.
 */
import { describe, it, expect } from 'vitest';
import { ToolsClient } from './toolsClient.js';
import { fetchTenantConfig, TENANT_FALLBACK } from './tenantConfig.js';

const BACKEND = 'http://localhost:4001';
const SECRET = 'test-secret';
const TENANT_ID = 'f234e471-0e60-4163-86c9-93cfd9338e3a';

function clientWith(response: { status: number; body: unknown }) {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify(response.body), { status: response.status });
  return new ToolsClient({ backendUrl: BACKEND, agentSecret: SECRET, fetchImpl });
}

describe('fetchTenantConfig', () => {
  it('HAPPY: returns name + timezone from a successful response', async () => {
    // WHO: Agent worker on connect for a known tenant
    // WHAT: Returns the values straight from the envelope's result
    // WHEN: Once per call, after dispatch metadata parses cleanly and
    //        the agent has decided it can run the full agent
    // WHERE: agent/src/tenantConfig.ts fetchTenantConfig() success path
    // WHY: The system prompt and greeting both depend on these — a
    //       wrong value here means the caller hears the wrong business
    //       name or "today" reasoned about in the wrong zone.
    const client = clientWith({
      status: 200,
      body: {
        success: true,
        result: { name: 'DynaTire', timezone: 'America/Chicago', system_prompt: null },
      },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    // Preference field absent from the response defaults to true (on by default).
    // TTS fields absent default to null (agent uses the platform default voice).
    expect(cfg).toEqual({
      name: 'DynaTire',
      timezone: 'America/Chicago',
      systemPrompt: null,
      personaName: null,
      firstMessage: null,
      savePreferencesEnabled: true,
      preferencesInstructions: null,
      ttsVoice: null,
      ttsSpeed: null,
      ttsFormal: null,
      ttsWarm: null,
      ttsConcise: null,
      ttsSoft: null,
      ttsCheerful: null,
      forwardPhone: null,
      forwardedFromPhone: null,
      // Absent from the response ⇒ false. A missing capability must never read
      // as "yes you can transfer" — a false positive dials a number that loops
      // the call straight back into the assistant. 2026-07-23.
      transferAvailable: false,
      callDisclosure: null,
      greetingMenu: null,
      greetingCloser: null,
      businessHours: null,
      bookableThrough: null,
      // Absent from the response ⇒ empty roster, never undefined: the prompt
      // renders this list, and "you can ask for undefined" is not a sentence a
      // receptionist says. 2026-07-31.
      staffFirstNames: [],
      // No preference_catalog in the response (older backend) → empty; the
      // remember_preference tool is then not offered.
      preferenceCatalog: [],
      checklistRuntimeConfig: null,
      // Absent from the response ⇒ null, meaning "this tenant has no per-tenant
      // question trees, use the platform library" — the pre-2026-08-14
      // behaviour, and the safe default for every tenant not yet converted.
      questionTrees: null,
    });
  });

  it('HAPPY: surfaces checklist_runtime_config so the live agent can compile the preset', async () => {
    // WHO: a salon tenant whose backend already derives the front-desk preset.
    // WHAT: snake_case checklist_runtime_config lands as a typed TenantRuntimeConfig.
    // WHEN: every connect, after tenant-config returns.
    // WHERE: fetchTenantConfig → ChecklistAgent({ runtimeConfig }).
    // WHY: until this field was plumbed, presets existed and the phone ignored them.
    const runtime = {
      preset_id: 'salon_front_desk',
      enabled_conversation_blocks: ['identity', 'booking', 'message', 'qa', 'schedule_change'],
      enabled_policy_blocks: [],
      enabled_knowledge_blocks: [],
      enabled_outcome_blocks: [],
      overrides: {},
      version: 1,
    };
    const client = clientWith({
      status: 200,
      body: {
        success: true,
        result: {
          name: 'Bella Hair',
          timezone: 'America/Chicago',
          system_prompt: null,
          checklist_runtime_config: runtime,
        },
      },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    expect(cfg.checklistRuntimeConfig).toEqual(runtime);
  });

  it('SAD: a malformed checklist_runtime_config is dropped, not a crashed greeting', async () => {
    // WHO: an older or broken backend that sends a half-built preset object.
    // WHAT: parse fails closed to null; the rest of tenant config still applies.
    // WHY: a bad preset must never take the call down — full-library fallback is honest.
    const client = clientWith({
      status: 200,
      body: {
        success: true,
        result: {
          name: 'Bella Hair',
          timezone: 'America/Chicago',
          system_prompt: null,
          checklist_runtime_config: { preset_id: 'salon_front_desk' },
        },
      },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    expect(cfg.name).toBe('Bella Hair');
    expect(cfg.checklistRuntimeConfig).toBeNull();
  });

  it('parses the staff roster, and drops blanks a stale backend might send', async () => {
    // WHO: the "Jane" caller (2026-07-27) — asked for someone who does not
    //       exist, and the agent had no roster to check the name against.
    // WHY: this list is rendered into the prompt the model speaks from, so a
    //       null or empty string in it becomes a spoken defect.
    const client = clientWith({
      status: 200,
      body: {
        success: true,
        result: {
          name: 'Thinking Hammer',
          timezone: 'America/Chicago',
          system_prompt: null,
          staff_first_names: ['Dale', '', '   ', 'Maria', null],
        },
      },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    expect(cfg.staffFirstNames).toEqual(['Dale', 'Maria']);
  });

  it('HAPPY: passes a well-formed preference_catalog through to preferenceCatalog', async () => {
    // WHY: the keys become remember_preference's enum (2026-09-25).
    const client = clientWith({
      status: 200,
      body: {
        success: true,
        result: {
          name: 'Bella',
          timezone: 'America/Chicago',
          system_prompt: null,
          preference_catalog: [
            { key: 'usual_service', label: 'Usual service', hint: 'Cut, color.' },
            { key: 'Bad Key', label: 'x', hint: 'y' },
          ],
        },
      },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    expect(cfg.preferenceCatalog).toEqual([
      { key: 'usual_service', label: 'Usual service', hint: 'Cut, color.' },
    ]);
  });

  it('maps forwarded_from_phone → forwardedFromPhone (snake → camel)', async () => {
    // WHO: a forwarded-line tenant (e.g. Dale's Thinking Hammer) whose published
    //       number forwards INTO the AI, with a separate human-transfer line.
    // WHAT: fetchTenantConfig surfaces forwarded_from_phone as camelCase
    //       forwardedFromPhone, independent of forwardPhone (the transfer target).
    // WHEN: per-call config fetch.
    // WHERE: agent/src/tenantConfig.ts mapping → consumed by index.ts caller-ID match.
    // WHY: index.ts keys the forwarded-line caller-ID match off this field; if it
    //       didn't surface, forwarded calls would be mis-treated as direct customers.
    const client = clientWith({
      status: 200,
      body: {
        success: true,
        result: {
          name: 'Thinking Hammer',
          timezone: 'America/Chicago',
          system_prompt: null,
          forward_phone: '+16305551234',
          forwarded_from_phone: '+16082175303',
        },
      },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    expect(cfg.forwardedFromPhone).toBe('+16082175303');
    expect(cfg.forwardPhone).toBe('+16305551234');
  });

  it('HAPPY: surfaces the owner greeting (first_message, snake → camel)', async () => {
    // WHO: an owner who typed a custom greeting into the dashboard AI Persona
    //       "First Message" box.
    // WHAT: first_message converts snake → camel at the boundary so the agent
    //       speaks it verbatim as the call's opening line.
    // WHEN: every call for a tenant that set a greeting.
    // WHERE: agent/src/tenantConfig.ts fetchTenantConfig success path →
    //         agent/src/index.ts session.say(greeting).
    // WHY: without this the dashboard greeting field is a silent no-op and the
    //       caller always hears the hardcoded "Thanks for calling…" fallback.
    const client = clientWith({
      status: 200,
      body: {
        success: true,
        result: {
          name: 'DynaTire',
          timezone: 'America/Chicago',
          system_prompt: null,
          first_message: "Hi, I'm Chris — business or personal?",
        },
      },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    expect(cfg.firstMessage).toBe("Hi, I'm Chris — business or personal?");
  });

  it('HAPPY: surfaces per-tenant OpenAI voice (tts_voice/speed, snake → camel)', async () => {
    // WHO: an owner who picked "Nova" and slowed her down a touch.
    // WHAT: tts_voice/tts_speed convert snake → camel at the boundary so the
    //        agent passes the tenant's voice/speed to OpenAI TTS instead of the
    //        platform default.
    // WHY: per-tenant voice is the whole feature — if these don't surface, every
    //        tenant sounds identical.
    const client = clientWith({
      status: 200,
      body: {
        success: true,
        result: {
          name: 'DynaTire',
          timezone: 'America/Chicago',
          system_prompt: null,
          tts_voice: 'nova',
          tts_speed: 0.85,
        },
      },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    expect(cfg.ttsVoice).toBe('nova');
    expect(cfg.ttsSpeed).toBe(0.85);
  });

  it('HAPPY: explicit save_preferences_enabled=false + preferences_instructions pass through (snake → camel)', async () => {
    // WHO: a tenant that explicitly opted out of preference capture in the dashboard.
    // WHAT: false passes through as-is; preferences_instructions also converts
    //        snake → camel so an owner's custom guidance reaches the prompt builder.
    // WHEN: every call for a tenant that set the toggle to off.
    // WHERE: agent/src/tenantConfig.ts fetchTenantConfig.
    // WHY: if false doesn't pass through, opt-out tenants keep capturing against their will.
    const client = clientWith({
      status: 200,
      body: {
        success: true,
        result: {
          name: 'Debbie Salon',
          timezone: 'America/Chicago',
          system_prompt: null,
          save_preferences_enabled: false,
          preferences_instructions: 'Remember the stylist and last service.',
        },
      },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    expect(cfg.savePreferencesEnabled).toBe(false);
    expect(cfg.preferencesInstructions).toBe('Remember the stylist and last service.');
  });

  it('HAPPY: surfaces tenants.system_prompt when set so the agent can use it as the role/identity section', async () => {
    // WHO: A tenant who customized their AI Persona page in the dashboard.
    // WHAT: system_prompt comes through as systemPrompt (snake → camel at
    //       the boundary). buildSystemPrompt then substitutes placeholders
    //       and uses the text as the identity section.
    // WHEN: Every call for any tenant that has set a non-null persona.
    // WHERE: agent/src/tenantConfig.ts → agent/src/prompt.ts.
    // WHY: pre-2026-05-18 this column was stored but never reached the LLM.
    const client = clientWith({
      status: 200,
      body: {
        success: true,
        result: {
          name: 'DynaTire',
          timezone: 'America/Chicago',
          system_prompt: 'You are a friendly receptionist for {{business_name}}.',
        },
      },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    expect(cfg.systemPrompt).toBe('You are a friendly receptionist for {{business_name}}.');
  });

  it('SAD: backend success:false → fallback', async () => {
    // WHO: A dispatch rule pointing at a deleted or never-existed tenant_id
    // WHAT: Backend returns { success: false, error: 'Tenant not found' };
    //        we don't crash — we use TENANT_FALLBACK so the call still
    //        proceeds with a generic greeting
    // WHEN: A call routed for a tenant that's been deleted but whose
    //        dispatch rule wasn't cleaned up
    // WHERE: The `if (res.ok && ...)` guard in fetchTenantConfig
    // WHY: Hanging up the caller because of a stale dispatch config is
    //       a much worse experience than greeting "Thanks for calling
    //       this business." Soft-fail is the right shape.
    const client = clientWith({
      status: 200,
      body: { success: false, error: 'Tenant not found' },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    expect(cfg).toEqual(TENANT_FALLBACK);
  });

  it('SAD: HTTP 500 from backend → fallback', async () => {
    // WHO: Backend mid-deploy, DB connection blip, or any 5xx
    // WHAT: Treat as a soft failure — fall back so the call still answers
    // WHEN: Backend has a transient outage during a live call
    // WHERE: Same fail-soft branch as the success:false case
    // WHY: A 5xx is always recoverable from the *worker's* perspective
    //       — we just lose the display config for this one call. The
    //       LLM-facing tools that follow may also fail loudly (which
    //       is correct for those), but this lookup specifically should
    //       never be the reason a call drops.
    const client = clientWith({
      status: 500,
      body: { error: 'Internal Server Error' },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    expect(cfg).toEqual(TENANT_FALLBACK);
  });

  it('SAD: result missing name → fallback', async () => {
    // WHO: Defensive guard against a future route refactor that drops
    //       the name field from the envelope
    // WHAT: Falls back so `undefined` never reaches the prompt builder
    // WHEN: A future backend change accidentally removes the field
    // WHERE: The truthy-check on `res.result?.name` in fetchTenantConfig
    // WHY: Without this guard, a missing field would surface in the
    //       greeting as "Thanks for calling undefined" — a louder
    //       failure than a generic greeting, but a worse one (it
    //       betrays the broken state to the caller). The fallback is
    //       quieter and more recoverable.
    const client = clientWith({
      status: 200,
      body: { success: true, result: { timezone: 'America/Chicago' } },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    expect(cfg).toEqual(TENANT_FALLBACK);
  });

  it('SAD: result missing timezone → fallback', async () => {
    // WHO: Same defensive shape as the missing-name case
    // WHAT: Falls back to TENANT_FALLBACK
    // WHEN: A future route change forgets the timezone field
    // WHERE: The truthy-check on `res.result?.timezone`
    // WHY: `Intl.DateTimeFormat(undefined)` doesn't throw but uses the
    //       *system* default zone, which on Railway is UTC — wrong for
    //       every actual tenant. Falling back to America/Chicago is at
    //       least the right zone for our current beta tenant. (If we
    //       later have non-Central tenants, that's a different fix
    //       — the route should never lose the field in the first place.)
    const client = clientWith({
      status: 200,
      body: { success: true, result: { name: 'DynaTire' } },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    expect(cfg).toEqual(TENANT_FALLBACK);
  });

  it('SAD: HTTP 401 (bad agent secret) → fallback', async () => {
    // WHO: A worker with the wrong AGENT_SECRET (Railway env var rotated
    //       upstream but not redeployed, or a config typo)
    // WHAT: Backend responds 401; ToolsClient surfaces ok:false; helper
    //        falls back so the call doesn't hang
    // WHEN: Right after deploy of a misconfigured worker
    // WHERE: Same fail-soft branch as the 5xx case
    // WHY: An auth misconfig will be caught by other tools that
    //       hard-fail anyway (book_appointment will refuse, etc.). The
    //       greeting itself shouldn't be the breakage point — it's the
    //       least information-bearing utterance and the most user-
    //       facing. Fall back here, fail loudly elsewhere.
    const client = clientWith({
      status: 401,
      body: { success: false, error: 'Unauthorized' },
    });
    const cfg = await fetchTenantConfig(client, TENANT_ID);
    expect(cfg).toEqual(TENANT_FALLBACK);
  });
});
