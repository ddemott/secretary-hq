/**
 * Fetches the tenant's display name + IANA timezone from the backend so
 * the system prompt and greeting can use real values instead of generic
 * defaults. Called once per call, on connect.
 *
 * If the backend is unreachable, the tenant_id is unknown, or the response
 * is malformed, returns a generic-but-safe fallback rather than letting
 * the call fail. Going silent on a caller is worse than greeting them
 * with "this business" in the default zone.
 */
import { questionTreeLibrarySchema, tenantRuntimeConfigSchema } from './checklist/blockSchemas.js';
import type { TenantRuntimeConfig } from './checklist/blockTypes.js';
import type { QuestionTreeDef } from './checklist/types.js';
import type { ToolsClient } from './toolsClient.js';

/** One preference type the agent may save (see TenantConfig.preferenceCatalog). */
export interface PreferenceTypeConfig {
  key: string;
  label: string;
  hint: string;
}

const PREF_KEY = /^[a-z][a-z0-9_]*$/;

/**
 * Keep only well-formed entries (snake_case key, non-blank label and hint),
 * de-duplicated by key. The keys become a tool enum the model must choose
 * from, so a malformed entry must be dropped, not passed through.
 */
export function parsePreferenceCatalog(raw: unknown): PreferenceTypeConfig[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PreferenceTypeConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { key, label, hint } = item as Record<string, unknown>;
    if (typeof key !== 'string' || !PREF_KEY.test(key) || seen.has(key)) continue;
    if (typeof label !== 'string' || !label.trim()) continue;
    if (typeof hint !== 'string' || !hint.trim()) continue;
    seen.add(key);
    out.push({ key, label: label.trim(), hint: hint.trim() });
  }
  return out;
}

export interface TenantDisplayConfig {
  name: string;
  timezone: string;
  /**
   * Owner-authored role/identity prompt with optional Handlebars-style
   * placeholders (`{{business_name}}`, `{{current_date}}`,
   * `{{caller_phone}}`). NULL means "no override — fall back to the
   * hardcoded Clara identity in buildSystemPrompt". 2026-05-18: added
   * so the dashboard's AI Persona text actually reaches the LLM.
   */
  systemPrompt: string | null;
  /**
   * Owner-editable assistant name (dashboard "Assistant Name"). The prompt
   * injects "Your name is X" so it overrides any name baked into systemPrompt.
   * NULL = no explicit name; keep whatever the prompt/default identity says.
   */
  personaName: string | null;
  /**
   * Owner-editable greeting (dashboard "First Message"). The agent speaks this
   * as the literal opening line; NULL falls back to the hardcoded
   * "Thanks for calling <name>…" so a tenant that never set one is unaffected.
   */
  firstMessage: string | null;
  /**
   * Whether customer-preference capture is enabled. Default true — the agent
   * saves durable facts about returning callers by default. Owners can opt out
   * via the dashboard AI Persona page (sets column to false).
   */
  savePreferencesEnabled: boolean;
  /**
   * Owner-authored guidance on what preferences to save, why, when, and how to
   * use them. NULL means "use the prompt's built-in default guidance" so the
   * toggle works before the owner writes anything.
   */
  preferencesInstructions: string | null;
  /**
   * Per-tenant TTS settings. ttsVoice is the picker's legacy OpenAI-style voice id
   * (shimmer/nova/alloy/echo/onyx/fable); the agent maps it to a Deepgram Aura model
   * via toAuraVoice() in index.ts (NULL/unknown = aura-asteria-en). ttsSpeed is saved
   * but never sent to Aura (its WS answers 400 on ?speed=), so it is inert. (The old
   * Grok-only soft/cheerful prosody tags were dropped 2026-06-25.)
   */
  ttsVoice: string | null;
  ttsSpeed: number | null;
  // Persona-tone toggles below feed the SYSTEM PROMPT (prompt.ts), not TTS.
  // (soft/cheerful re-activated 2026-06-30 as prompt-tone style modifiers.)
  ttsFormal: boolean | null;
  ttsWarm: boolean | null;
  ttsConcise: boolean | null;
  ttsSoft: boolean | null;
  ttsCheerful: boolean | null;
  /**
   * E.164 PSTN number the agent cold-transfers a live call to (owner cell),
   * via SIP REFER through the inbound trunk. NULL means no forwarding is
   * configured — the transfer_call tool reports it can't transfer and the
   * agent takes a message instead. 2026-06-11.
   */
  forwardPhone: string | null;
  /**
   * E.164 line the tenant forwards INTO the assistant. When the SIP caller-ID
   * matches this, the agent treats the caller-ID as the forwarding line (not the
   * customer) and collects the caller's real number verbally. NULL = no
   * forwarded-line handling via this field (env list still applies). 2026-06-29.
   */
  forwardedFromPhone: string | null;
  /**
   * Can this call actually be transferred to a human? THE resolved capability,
   * decided by the backend (shared/phone.ts canTransfer) — never re-derived here.
   *
   * False when no transfer target is configured, AND when the configured target
   * would LOOP: a `forward_phone` equal to `forwarded_from_phone` rings the very
   * line that forwards into this assistant, and the carrier sends it straight
   * back. Note that forwarding IN does not by itself disable transfer — home
   * line in, shop line out is two different numbers and works fine. 2026-07-23.
   */
  transferAvailable: boolean;
  /**
   * Owner-editable spoken caller disclosure (the AI + transcription notice).
   * NULL or blank means "use the platform default" — buildDisclosure() in
   * greeting.ts composes the compliant fallback. A tenant can reword it (brand
   * voice, another language, counsel-approved script) but the change is gated
   * behind an attestation in the dashboard; the agent just speaks whatever the
   * column holds, or the default when it is empty. 2026-07-11.
   */
  callDisclosure: string | null;
  /**
   * The spoken services menu — the "what I can help with" line at the top of
   * every call, between the disclosure and "How can I help you today?".
   * Dale (2026-07-21): callers should hear the business's CORE lanes up front
   * (job, computer repair, message, buying this AI-secretary service). Owner
   * data, never platform code. NULL/blank = no menu line.
   */
  greetingMenu: string | null;
  /**
   * Owner-configurable CLOSING QUESTION — replaces the generic "How can I help
   * you today?" at the end of the greeting with a guiding one that names the
   * services ("What do you need help with: hiring Dale, a computer fix, or a
   * message?"). NULL/blank = the default closer. 2026-07-23.
   */
  greetingCloser: string | null;
  /**
   * The shop's opening hours, spoken ("Monday to Friday, 1:00 PM to 5:00 PM"),
   * derived from who is actually on the schedule. NULL when nobody is scheduled —
   * the agent must NOT claim to be open in that case.
   *
   * 2026-07-12: added so the agent LEADS with the hours instead of asking "what
   * day and time were you thinking?" against a calendar the caller cannot see.
   * That open-ended question is what let a real caller name two impossible dates
   * in a row and give up after seven minutes.
   */
  businessHours: string | null;
  /** Last date anyone is scheduled — how far ahead we can actually book. */
  bookableThrough: string | null;
  /**
   * Active staff FIRST names. The roster a caller-named person is checked
   * against before the agent repeats the name back as fact — 2026-07-27, a
   * caller asked for "Jane" (STT for "Dale", the only employee) and was
   * confirmed into a meeting "with Jane" that the row says is with Dale.
   * Empty when the tenant has no employees configured.
   */
  staffFirstNames: string[];
  /**
   * What counts as a caller preference for this business type (backend
   * shared/preferenceCatalog.ts, 2026-09-25): the vertical's own types plus the
   * universal set, ending with a free-text "notes". remember_preference may
   * only save these keys. Empty from an older backend — the tool is then not
   * offered, rather than falling back to invented keys.
   */
  preferenceCatalog: PreferenceTypeConfig[];
  /**
   * Compiled preset for this tenant. NULL when the backend omitted it or the
   * body failed schema (fail-soft: live ChecklistAgent then uses the full
   * platform library, which is the pre-preset behavior).
   */
  checklistRuntimeConfig: TenantRuntimeConfig | null;
  /**
   * THIS TENANT'S OWN QUESTION TREES, read from the database.
   *
   * NULL when the backend sent none — an older backend, or a tenant that has
   * not been provisioned with a copy yet. Null means "use the platform
   * TypeScript library", which is what every call did before per-tenant trees
   * existed, so a tenant without rows behaves exactly as it always has.
   *
   * Validated structurally before it is trusted: this arrives over HTTP and is
   * handed straight to the tracker, so a malformed tree would be a mid-call
   * crash rather than a config problem. Anything that fails validation is
   * discarded WHOLE — a half-accepted library would be worse than the fallback,
   * because the missing half would be invisible.
   */
  questionTrees: QuestionTreeDef[] | null;
}

export const TENANT_FALLBACK: TenantDisplayConfig = {
  name: 'this business',
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
  transferAvailable: false,
  callDisclosure: null,
  greetingMenu: null,
  greetingCloser: null,
  businessHours: null,
  bookableThrough: null,
  staffFirstNames: [],
  preferenceCatalog: [],
  checklistRuntimeConfig: null,
  // Fallback tenant: no rows, so the platform library governs — the same
  // behaviour as before per-tenant trees existed.
  questionTrees: null,
};

/** Narrow the tenant-config wire field. Bad/missing → null, never throw. */
export function parseChecklistRuntimeConfig(raw: unknown): TenantRuntimeConfig | null {
  const parsed = tenantRuntimeConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The tenant's own question trees, or null to fall back to the platform library.
 *
 * ALL-OR-NOTHING ON PURPOSE. A partially-valid library is the dangerous case:
 * the call would run with some of the tenant's questions silently missing, the
 * checklist would look complete, and the goodbye gate would happily close a call
 * that never asked what it was supposed to ask. Falling back to the platform
 * library is a KNOWN state; a half-library is an unknown one. An empty array is
 * likewise treated as "no rows yet", not "a business that asks nothing".
 */
export function parseQuestionTrees(raw: unknown): QuestionTreeDef[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parsed = questionTreeLibrarySchema.safeParse(raw);
  return parsed.success ? (parsed.data as QuestionTreeDef[]) : null;
}

export async function fetchTenantConfig(
  client: ToolsClient,
  tenantId: string
): Promise<TenantDisplayConfig> {
  // Backend returns snake_case — convert to TS-idiomatic camelCase at the
  // boundary.
  const res = await client.call<{
    name: string;
    timezone: string;
    system_prompt: string | null;
    persona_name?: string | null;
    first_message?: string | null;
    save_preferences_enabled?: boolean;
    preferences_instructions?: string | null;
    tts_voice?: string | null;
    tts_speed?: number | null;
    tts_formal?: boolean | null;
    tts_warm?: boolean | null;
    tts_concise?: boolean | null;
    tts_soft?: boolean | null;
    tts_cheerful?: boolean | null;
    forward_phone?: string | null;
    forwarded_from_phone?: string | null;
    transfer_available?: boolean | null;
    call_disclosure?: string | null;
    greeting_menu?: string | null;
    greeting_closer?: string | null;
    business_hours?: string | null;
    bookable_through?: string | null;
    staff_first_names?: string[] | null;
    preference_catalog?: unknown;
    checklist_runtime_config?: unknown;
    question_trees?: unknown;
  }>('/agent-tools/tenant-config', { tenant_id: tenantId });
  if (res.ok && res.result?.name && res.result?.timezone) {
    return {
      name: res.result.name,
      timezone: res.result.timezone,
      systemPrompt: res.result.system_prompt ?? null,
      personaName: res.result.persona_name ?? null,
      firstMessage: res.result.first_message ?? null,
      savePreferencesEnabled: res.result.save_preferences_enabled ?? true,
      preferencesInstructions: res.result.preferences_instructions ?? null,
      ttsVoice: res.result.tts_voice ?? null,
      ttsSpeed: res.result.tts_speed ?? null,
      ttsFormal: res.result.tts_formal ?? null,
      ttsWarm: res.result.tts_warm ?? null,
      ttsConcise: res.result.tts_concise ?? null,
      ttsSoft: res.result.tts_soft ?? null,
      ttsCheerful: res.result.tts_cheerful ?? null,
      forwardPhone: res.result.forward_phone ?? null,
      forwardedFromPhone: res.result.forwarded_from_phone ?? null,
      // Absent (older backend) is treated as "no transfer" rather than
      // "transfer": a false negative costs a caller one offered transfer, a
      // false positive dials a number that loops the call back into us.
      transferAvailable: res.result.transfer_available === true,
      callDisclosure: res.result.call_disclosure ?? null,
      greetingMenu: res.result.greeting_menu ?? null,
      greetingCloser: res.result.greeting_closer ?? null,
      businessHours: res.result.business_hours ?? null,
      bookableThrough: res.result.bookable_through ?? null,
      // Defensive filter: this list is rendered into a prompt the model speaks
      // from, so a stray null/blank from an older backend must not become
      // "you can ask for , or Dale".
      staffFirstNames: Array.isArray(res.result.staff_first_names)
        ? res.result.staff_first_names.filter(
            (n): n is string => typeof n === 'string' && n.trim().length > 0
          )
        : [],
      preferenceCatalog: parsePreferenceCatalog(res.result.preference_catalog),
      checklistRuntimeConfig: parseChecklistRuntimeConfig(res.result.checklist_runtime_config),
      questionTrees: parseQuestionTrees(res.result.question_trees),
    };
  }
  return TENANT_FALLBACK;
}
