/**
 * Tool definitions for the LiveKit agent.
 *
 * Each of the 23 backend /agent-tools/* routes is exposed to the LLM as a
 * function-tool. The `tenant_id` and (where relevant) `call_id` are
 * injected from the session context — the LLM never sees or supplies them.
 * This prevents an entire class of bugs where the LLM hallucinates or
 * drops the tenant scope.
 *
 * The tool factory takes (context, client) and returns a ToolContext map
 * keyed by the tool name the LLM will invoke. Attach it to the Agent via
 * `new voice.Agent({ tools: buildTools(ctx, client) })`.
 *
 * Execute functions always return a STRING (or JSON-stringified object)
 * because LiveKit feeds the return value straight back to the LLM as the
 * tool-result message. Returning rich objects would work but strings
 * surface nicely in traces.
 */
import { llm } from '@livekit/agents';
import type { SessionContext } from './sessionContext.js';
import type { ToolResponse, ToolsClient } from './toolsClient.js';
import type { TransferResult } from './transferClient.js';
import type { CallOutcomeTracker } from './callOutcome.js';
import { wrapToolExecute } from './tools/wrapTool.js';
import { getLogger } from './logger.js';
import type { CallPhase } from './toolPhases.js';

/**
 * Capability groups. Every tool belongs to exactly one; a customer agent can
 * compose a subset via `buildTools(..., { capabilities: [...] })` (e.g. a
 * message-taking line needs only 'knowledge' + 'messaging'). Default = all.
 * The grouping also documents which tools to lift together when copying a
 * capability into another agent.
 */
export type Capability =
  | 'knowledge'
  | 'messaging'
  | 'identity'
  | 'scheduling'
  | 'verification'
  | 'transfer'
  // Texting. Its OWN capability, not part of 'scheduling', precisely so it can be
  // switched off while booking keeps working — which is the state we are in until
  // 10DLC registration lands and a text can actually reach a handset.
  | 'sms';

const CAPABILITY_OF: Record<string, Capability> = {
  // The phase routers (toolPhases.ts). 'scheduling', because that is where they
  // LEAD — so a session built without scheduling loses the doors along with the
  // rooms, rather than keeping a door that opens onto nothing.
  start_booking: 'scheduling',
  manage_appointment: 'scheduling',
  get_company_policy_answer: 'knowledge',
  take_message: 'messaging',
  capture_job_inquiry: 'messaging',
  page_owner_via_sms: 'messaging',
  get_customer_context: 'identity',
  get_detailed_customer_history: 'identity',
  // 'sms', NOT 'scheduling' (moved 2026-07-17). This tool TEXTS the caller a
  // link — and until 10DLC lands, no text this product sends reaches a handset
  // (the carrier drops it; Telnyx reports success anyway). Filed under
  // 'scheduling' it ESCAPED the ENABLE_SMS gate: on a live call the model
  // could call it, get a success result, and truthfully relay "I've texted you
  // a link" — for a text that dies at the carrier. The exact
  // promise-what-you-cannot-do lie the SMS gate exists to make impossible,
  // arriving through a mis-filed capability. Found because Dale asked, of a
  // green eval case: "But we aren't texting." With 'sms' off this tool is now
  // absent and the agent handles cancel/reschedule live, which is the honest
  // path it already knows.
  send_self_service_link: 'sms',
  find_caller_by_name: 'identity',
  identify_caller: 'identity',
  save_customer_preference: 'identity',
  record_sms_consent: 'sms',
  get_service_catalog: 'scheduling',
  get_available_slots: 'scheduling',
  get_scheduling_options: 'scheduling',
  check_availability: 'scheduling',
  book_appointment: 'scheduling',
  book_with_scheduling: 'scheduling',
  get_my_appointments: 'scheduling',
  cancel_appointment: 'scheduling',
  reschedule_appointment: 'scheduling',
  // Deliberately in NO toolPhases list: only the meeting-goals rung (task-group path)
  // holds it. The ladder path has no wrap-up-notes step, so it never sees the tool.
  attach_meeting_notes: 'scheduling',
  send_verification_code: 'verification',
  verify_phone_code: 'verification',
  transfer_call: 'transfer',
};

/**
 * Treat a blank/whitespace string as ABSENT.
 *
 * Raised in review on #253, and it would have silently defeated the fix it was in.
 * `args.callback_phone ?? ctx.callerPhone` only falls through on null/undefined —
 * an EMPTY STRING is not nullish, so a model that sends `callback_phone: ""` would
 * have that empty string sent to the backend AND block the fallback to the number
 * the caller already gave. The "never re-ask" guarantee would evaporate exactly
 * when the model was being sloppy, which is the only time it was needed.
 *
 * LLMs emit "" constantly for optional fields. Nullish coalescing is the wrong tool
 * for anything an LLM fills in.
 */
function blank(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === '';
}

/** First non-blank value, or undefined. The order of the arguments is the order of trust. */
function firstPhone(...vals: (string | null | undefined)[]): string | undefined {
  for (const v of vals) if (!blank(v)) return v!.trim();
  return undefined;
}

/** Pull a UUID appointment_id out of a successful booking response, if present. */
function extractAppointmentId(res: ToolResponse): string | null {
  if (!res.ok || typeof res.result !== 'object' || res.result === null) return null;
  const id = (res.result as { appointment_id?: unknown }).appointment_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Live-transfer capability handed to buildTools. `forwardPhone` is the
 * destination (owner cell, NULL = unconfigured); `execute` performs the SIP
 * REFER and is null when the call lacks the room/participant context needed to
 * transfer. Kept separate from SessionContext so tools.ts never imports the
 * livekit-server-sdk and stays unit-testable with a plain mock.
 */
export interface TransferCapability {
  forwardPhone: string | null;
  execute: ((forwardPhone: string | null) => Promise<TransferResult>) | null;
}

/** Format a tool response for the LLM. Keeps success + error shapes uniform. */
function formatResponse(res: ToolResponse): string {
  if (res.ok) {
    if (typeof res.result === 'string') return res.result;
    // JSON.stringify(undefined) returns the JS value `undefined` (NOT the
    // string "undefined") — handing the LLM nothing to relay → a silent turn.
    // Guard so a success-with-no-result never produces dead air.
    const encoded = JSON.stringify(res.result);
    return encoded ?? 'Done.';
  }
  // Surface error_code for the LLM so the prompt's translation table fires.
  if (res.errorCode) {
    return JSON.stringify({ error: res.error, error_code: res.errorCode });
  }
  return JSON.stringify({ error: res.error });
}

/**
 * Spoken 12-hour clock from a local-naive datetime string
 * ("2026-07-15T16:00:00" → "4:00 PM"). Returns the raw input if it can't be
 * parsed, so the LLM still gets something to relay.
 */
function spokenClock(localNaive: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(localNaive);
  if (!m) return localNaive;
  const h24 = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  // Guard out-of-range values (e.g. a malformed "T99:99") so we don't emit a
  // bogus "99:99" spoken time — fall back to the raw input as documented.
  if (h24 > 23 || min > 59) return localNaive;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${m[2]} ${ampm}`;
}

/**
 * True ONLY when both times parse cleanly AND differ to the minute (compared
 * on wall-clock: date + HH:MM). Uncertain input (unparseable) → false, so an
 * ambiguous value never fires a spurious "your time wasn't open" note.
 *
 * FRAME ASSUMPTION: both args are compared as LOCAL wall-clock digits. That is
 * correct because `requested_start` is prompted as local-naive (same as
 * window_from) and `booked_start` is backend-converted via toLocalWallClock →
 * local-naive. A trailing Z/offset on `requested_start` is stripped by the
 * regex, so a Z-suffix alone is harmless — BUT if the LLM ever sends a genuine
 * UTC *instant* (shifted digits, e.g. 21:30Z for 4:30pm local) this would false
 * "time_changed" on a correct booking. This is the live-call thing to watch.
 */
function bookedTimeDiffers(requested: string, booked: string): boolean {
  const norm = (s: string) => /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(s)?.[1] ?? null;
  const r = norm(requested);
  const b = norm(booked);
  if (r === null || b === null) return false;
  return r !== b;
}

/**
 * Format a book_with_scheduling response for the LLM. On success it names the
 * ACTUAL booked time (the backend returns it already converted to the tenant's
 * local wall-clock) so the agent confirms what was really booked — not the time
 * the caller asked for. `book_with_scheduling_atomic` takes the earliest open
 * slot at or after `window_from`, so a caller who asked for a specific time can
 * land on a different (usually earlier) slot; when `requestedStart` is supplied
 * and the booked slot differs, the returned payload carries an explicit
 * directive to tell the caller the real time + that their pick wasn't open.
 *
 * `requestedStart` MUST be the caller's specifically-requested start, NOT the
 * search-window bound — for "next available" requests the caller named no time,
 * so it's omitted and no mismatch note ever fires (the booked slot legitimately
 * differs from the window bound by design).
 *
 * Falls back to the generic formatter for errors or any legacy/no-booked_start
 * response shape (fail-safe: worst case the LLM still sees the raw result JSON).
 */
function formatBookingResponse(res: ToolResponse, requestedStart?: string): string {
  if (!res.ok || typeof res.result !== 'object' || res.result === null) {
    return formatResponse(res);
  }
  const r = res.result as {
    appointment_id?: string;
    employee_name?: string | null;
    booked_start?: string | null;
  };
  const bookedStart = typeof r.booked_start === 'string' ? r.booked_start : null;
  if (!bookedStart) return formatResponse(res);

  const spoken = spokenClock(bookedStart);
  const withWhom = r.employee_name ? ` with ${r.employee_name}` : '';
  const payload: Record<string, unknown> = {
    success: true,
    appointment_id: r.appointment_id ?? null,
    booked_time: spoken,
    employee: r.employee_name ?? null,
    instruction: `Booked${withWhom} for ${spoken}. Confirm THIS exact time (${spoken}) to the caller — it is the actual booked slot.`,
    // THE STANDING FACT (2026-07-21 live-call regression): on a real call the
    // model booked 3:00 PM, ran a long intake, and then told the caller
    // "I haven't booked any meeting for you yet" — false — re-offered slots
    // (3:00 was missing from the list BECAUSE she held it) and booked a
    // duplicate at 3:30 over her protest. The confirmation was N turns back;
    // nothing in context re-anchored the model on its own completed booking.
    // This field is that anchor: it lives in the tool result, so it stays in
    // context for the REST of the call, exactly where the model re-reads.
    standing_fact:
      `THIS CALL NOW HAS A BOOKED APPOINTMENT: ${spoken}${withWhom}` +
      (r.appointment_id ? ` (appointment_id ${r.appointment_id})` : '') +
      `. This holds for the rest of the call, however long it runs: do NOT re-offer times, do NOT book again, and NEVER say nothing is booked — if the caller asks, the answer is YES, ${spoken}. ` +
      `Book a second appointment ONLY if the caller explicitly asks for an ADDITIONAL one on top of this.`,
  };
  if (requestedStart && bookedTimeDiffers(requestedStart, bookedStart)) {
    payload.time_changed = true;
    payload.requested_time = spokenClock(requestedStart);
    payload.instruction =
      `Booked${withWhom} for ${spoken}, but the caller asked for ${spokenClock(requestedStart)}, which was NOT open. ` +
      `Tell the caller you booked the closest opening — ${spoken}${withWhom} — and ask if that works or if they'd like a different time.`;
  }
  return JSON.stringify(payload);
}

export function buildTools(
  ctx: SessionContext,
  client: ToolsClient,
  transfer?: TransferCapability,
  outcome?: CallOutcomeTracker,
  speakFiller?: (phrase: string) => void,
  opts?: {
    capabilities?: readonly Capability[];
    /**
     * Swap the model's visible toolset to a new phase. Supplied by index.ts,
     * which owns the live Agent; undefined in tests and in the eval's static
     * snapshot, where the routers are inert (they still appear, so the model's
     * choices are graded, but nothing is mutated).
     */
    onPhaseChange?: (phase: CallPhase) => void | Promise<void>;
  }
): llm.ToolContext {
  // Only offer a live transfer in the no-caller-ID fallbacks when one can
  // actually happen: the 'transfer' capability is active for this session, a
  // destination number is configured (forwardPhone), AND this call has transfer
  // wiring (transfer.execute — null when the SIP participant never joined / no
  // LiveKit context). Otherwise the agent would promise "I can transfer you" the
  // runtime can't honor (transfer_call returns not_configured / "not available"
  // → dead-end). Mirrors the prompt's capability gating (PR #114). When transfer
  // is unavailable we offer only a message.
  // Does this session HAVE the OTP tools? A tool DESCRIPTION that tells the model to
  // call send_verification_code when send_verification_code is not in the toolset is the
  // exact prompt/tool mismatch capability-gating exists to prevent (GH #113): the model
  // tries to call a tool that does not exist, errors, and the caller hears dead air.
  // Removing the tool is not enough — NOTHING MAY STILL POINT AT IT.
  const hasVerification = !opts?.capabilities || opts.capabilities.includes('verification');

  // The backend's requires_verification results tell the model to run the OTP
  // flow ("use send_verification_code, then verify_phone_code…"). When this
  // session does not HAVE those tools, that advice is unsatisfiable — and the
  // model does not shrug at unsatisfiable advice, it LOOPS on it: on a live
  // call 2026-07-17 it retried the context lookup until the per-turn tool-step
  // cap ended the turn in silence. This is GH #113's rule surfacing in a new
  // place: removing a tool is not enough — nothing may still point at it, and
  // a tool RESULT is a pointer just as much as a tool description. The backend
  // cannot know a session's capabilities, so the rewrite happens here, at the
  // one layer that does. The replacement names the step the model CAN take:
  // treat the caller as new and keep going.
  const gateVerificationAdvice = (res: ToolResponse): string => {
    if (
      !hasVerification &&
      res.ok &&
      res.result !== null &&
      typeof res.result === 'object' &&
      (res.result as Record<string, unknown>).requires_verification === true
    ) {
      return JSON.stringify({
        requires_verification: true,
        message:
          'A saved account cannot be opened on this call, and that is fine — treat the caller as NEW. Continue with the name and number they gave you (book, take a message, or answer their question), and do not retry this lookup on this call.',
      });
    }
    return formatResponse(res);
  };

  const canOfferTransfer =
    (!opts?.capabilities || opts.capabilities.includes('transfer')) &&
    !!transfer?.forwardPhone &&
    !!transfer?.execute;
  const transferOrMessage = canOfferTransfer ? 'transfer or take a message' : 'take a message';

  /**
   * The routers. Calling one swaps the model's toolset (see toolPhases.ts).
   *
   * They exist because narrowing needs a door. The scheduling tools are not
   * visible during intake, so the ONLY way the model can reach the thing the
   * caller asked for is to make a real tool call — it cannot talk its way to
   * get_available_slots. That is the whole point: the cheapest path to the
   * caller's goal now runs THROUGH a tool instead of around it.
   *
   * They are deliberately dumb. No arguments, no HTTP, no failure mode. A router
   * that could fail would be a new way to strand a caller mid-call.
   */
  const routeTo = async (phase: CallPhase, reply: string): Promise<string> => {
    // DEFER THE SWAP. Do not mutate the toolset from inside a tool's own execute().
    //
    // agent.updateTools() REPLACES the ToolContext — and start_booking is IN that
    // context, currently running. Swapping it out mid-execute pulls the rug from under
    // the very tool LiveKit is waiting on, and it cannot find the output to attach:
    //
    //     WARN  toolName: "start_booking"  msg: "function output missing"   x4
    //
    // The model then has a tool call with no result, so it calls it AGAIN, and again.
    // On the 2026-07-14 call the owner heard it looping at the end and hung up on it.
    //
    // This is the same shape as #97 (session.say() from inside execute() froze the
    // generation): the LiveKit rule is that a tool's execute() must not reach back and
    // mutate the machinery that is currently running it. Return first; mutate after.
    //
    // setTimeout(0) — a MACROTASK, not queueMicrotask. Microtasks drain before the
    // current stack unwinds, which is still "inside" the execute for this purpose. A
    // macrotask lands after LiveKit has taken the return value and attached it, and
    // well before the next inference (which is network-bound).
    setTimeout(() => {
      void (async () => {
        try {
          await opts?.onPhaseChange?.(phase);
        } catch {
          /* a failed swap must never break the call — the caller keeps the wider
             toolset, which is worse than ideal and infinitely better than a dead line */
        }
      })();
    }, 0);
    return JSON.stringify({ ok: true, next: reply });
  };

  const allTools: llm.ToolContext = {
    start_booking: llm.tool({
      description:
        "The caller wants to make a NEW appointment. Call this FIRST, before asking them for a day or a time — it is what gives you the scheduling tools, and you have NO way to see the calendar until you do. You do not need their service, day, time, name or number first; call it as soon as you know they want to book, then gather the rest. Do NOT tell the caller you are 'checking' or 'looking something up' — just call this. NOT for canceling, moving, or checking an appointment they ALREADY have — that is manage_appointment.",
      parameters: { type: 'object', properties: {} },
      execute: async () =>
        routeTo(
          'booking',
          'Scheduling tools are now available. NOTHING IS BOOKED YET — do not say "booked", "you\'re booked in", or "all set" until book_with_scheduling returns success. Use get_available_slots (they have a day in mind) or get_scheduling_options (they do not) to find real openings. Never state or refuse a time you have not seen in a tool result.'
        ),
    }),

    manage_appointment: llm.tool({
      description:
        'The caller wants to check, MOVE, or CANCEL an appointment they ALREADY have. Call this FIRST, before promising anything — it is what gives you the tools to look their booking up, and you cannot see a single existing appointment until you do. Do not use this for a NEW appointment (that is start_booking).',
      parameters: { type: 'object', properties: {} },
      execute: async () =>
        routeTo(
          'manage',
          'Appointment-management tools are now available. Call get_my_appointments to see what they actually have before changing anything.'
        ),
    }),

    get_customer_context: llm.tool({
      description:
        "Look up a caller in the CRM by phone. Returns the customer's name, a short history, any saved preferences (preferred staff, last service, likes), and sms_consent — whether they have ALREADY agreed to appointment texts (if true, never ask for that permission again). sms_consent is OMITTED when the caller is new, or when the response is requires_verification (consent status is withheld until the number is proven, exactly like the name). Treat an absent sms_consent as NO consent and ask: a missing field is never permission. Pass the phone number the caller gave you verbally when you have it; otherwise it falls back to the caller-ID phone. Use this to recognize returning callers.",
      parameters: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description:
              "The caller's phone number, preferably the one they gave you out loud. Omit only if you have not collected one yet (the caller-ID phone is used as a fallback).",
          },
        },
        additionalProperties: false,
      },
      execute: async (args: { phone?: string }) => {
        const lookupPhone = args.phone?.trim() || ctx.callerPhone;
        if (!lookupPhone) {
          return 'New caller - no history found.';
        }
        // Trust is a property of the NUMBER, not of the session. The carrier
        // attested ctx.callerPhone; anything the LLM hands us is a claim the
        // caller made out loud — even on a call that HAS caller ID, since the
        // model can pass a different number than the one that rang us.
        const usingCarrierNumber =
          Boolean(ctx.callerPhone) && (!args.phone || lookupPhone === ctx.callerPhone);
        const res = await client.call(
          '/agent-tools/customer-context',
          {
            tenant_id: ctx.tenantId,
            phone: lookupPhone,
            phone_source: usingCarrierNumber ? 'caller_id' : 'spoken',
            call_id: ctx.callId,
          },
          { isReadOnly: true }
        );
        return gateVerificationAdvice(res);
      },
    }),

    find_caller_by_name: llm.tool({
      description:
        "Look up callers by name in the CRM. Call this right after the caller gives you their name. Returns matching contacts with the phone number on file so you can confirm 'is this still your number?'. An empty list means no match — treat them as a new caller. Use this for name-first identification on this forwarded line, since caller ID is not the caller's own number.",
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The caller\'s name as they stated it, e.g. "Jane Doe".',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      execute: async (args: { name: string }) => {
        const res = await client.call(
          '/agent-tools/find-customer-by-name',
          {
            tenant_id: ctx.tenantId,
            name: args.name,
          },
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),

    get_service_catalog: llm.tool({
      description:
        "List every service this business offers with duration and price. Use when the caller asks 'what do you offer' or you need service names/IDs.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        const res = await client.call(
          '/agent-tools/service-catalog',
          {
            tenant_id: ctx.tenantId,
          },
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),

    get_available_slots: llm.tool({
      description:
        "Return a spoken description of open time slots for a specific service on a specific date. Use when the caller asks 'when can I come in for X' and has a day in mind. This returns spoken times ONLY — it does NOT return a bookable resource_id. To book one of these times, call book_with_scheduling with a tight window around the time the caller chose; do NOT call book_appointment or check_availability afterward (they need a resource_id this tool never yields).",
      parameters: {
        type: 'object',
        properties: {
          service_type: {
            type: 'string',
            description:
              'SAY WHAT THE CALLER SAID — not a catalog name you picked. Pass their own words for what they want: \"a meeting to talk about a contract role\", \"have the owner call me back\", \"look at my project\". The backend matches that to the right service SEMANTICALLY (it reads the catalog descriptions, which you cannot see in full). Do NOT try to pick the service yourself: on 2026-07-14 you decided a caller wanting a meeting about a six-month contract wanted a \"Personal Callback\" — a 15-minute call-me-back — and booked him into it. Report the intent; let the catalog choose. If the caller genuinely names a service, pass that name.',
          },
          date: {
            type: 'string',
            description: 'Date in YYYY-MM-DD format in the tenant timezone.',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
        },
        required: ['service_type', 'date'],
        additionalProperties: false,
      },
      execute: async (args: { service_type: string; date: string }) => {
        speakFiller?.('Let me check what we have open...');
        const res = await client.call(
          '/agent-tools/available-slots',
          {
            tenant_id: ctx.tenantId,
            service_type: args.service_type,
            date: args.date,
            // Attribute a pure availability inquiry to this call so a caller
            // who never books still counts toward abandonment-by-service.
            call_id: ctx.callId || undefined,
          },
          // Still retry-safe: the backend's requested_service_id capture is a
          // best-effort, COALESCE-guarded, deterministic UPDATE — replaying it
          // sets the same service_id, so an auto-retry can't corrupt state.
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),

    get_scheduling_options: llm.tool({
      description:
        'Compute valid (resource, employee) combinations for a service within a time window. Use for open-ended scheduling questions or to pre-check feasibility before booking.',
      parameters: {
        type: 'object',
        properties: {
          service_type: {
            type: 'string',
            description:
              'SAY WHAT THE CALLER SAID — not a catalog name you picked. Pass their own words for what they want: \"a meeting to talk about a contract role\", \"have the owner call me back\", \"look at my project\". The backend matches that to the right service SEMANTICALLY (it reads the catalog descriptions, which you cannot see in full). Do NOT try to pick the service yourself: on 2026-07-14 you decided a caller wanting a meeting about a six-month contract wanted a \"Personal Callback\" — a 15-minute call-me-back — and booked him into it. Report the intent; let the catalog choose. If the caller genuinely names a service, pass that name.',
          },
          required_resource_capabilities: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Optional capability tags the resource must have, e.g., ['lift', 'alignment'].",
          },
          required_employee_skills: {
            type: 'array',
            items: { type: 'string' },
            description: "Optional skill tags the employee must have, e.g., ['oil_change'].",
          },
          window_from: {
            type: 'string',
            description: 'ISO datetime start of the search window.',
          },
          window_to: {
            type: 'string',
            description: 'ISO datetime end of the search window.',
          },
        },
        required: ['service_type', 'window_from', 'window_to'],
        additionalProperties: false,
      },
      execute: async (args: {
        service_type: string;
        required_resource_capabilities?: string[];
        required_employee_skills?: string[];
        window_from: string;
        window_to: string;
      }) => {
        const res = await client.call(
          '/agent-tools/scheduling-options',
          {
            tenant_id: ctx.tenantId,
            requirements: {
              serviceType: args.service_type,
              requiredResourceCapabilities: args.required_resource_capabilities,
              requiredEmployeeSkills: args.required_employee_skills,
            },
            window: { from: args.window_from, to: args.window_to },
            // Attribute a pure availability inquiry to this call (see above).
            call_id: ctx.callId || undefined,
          },
          // Retry-safe — the capture UPDATE is idempotent (see available-slots).
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),

    check_availability: llm.tool({
      description:
        'Check whether a specific resource is available at a specific time. Use ONLY when you already have a resource_id from get_scheduling_options. get_available_slots does NOT return a resource_id — if you only have a time the caller picked, use book_with_scheduling instead of this tool. (SLOW lookup — 2-4s; a short filler like "one sec while I check that" is spoken automatically before the result.)',
      parameters: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              'A resource_id from get_scheduling_options output (not from get_available_slots).',
          },
          start_time: { type: 'string', description: 'ISO datetime.' },
          end_time: { type: 'string', description: 'ISO datetime.' },
        },
        required: ['resource_id', 'start_time', 'end_time'],
        additionalProperties: false,
      },
      execute: async (args: { resource_id: string; start_time: string; end_time: string }) => {
        // Guardrail (prod bug #3): check_availability needs a resource_id that
        // ONLY get_scheduling_options returns. get_available_slots yields spoken
        // times with no resource_id, so the LLM sometimes reaches here empty-
        // handed. Fail loudly with a redirect instead of 400ing the backend or
        // letting the LLM invent an id.
        if (!args.resource_id || !args.resource_id.trim()) {
          return JSON.stringify({
            error:
              'check_availability needs a resource_id from get_scheduling_options. If you only have a time the caller chose, call book_with_scheduling with a tight window around that time instead.',
            error_code: 'RESOURCE_ID_REQUIRED',
          });
        }
        const res = await client.call(
          '/agent-tools/check-availability',
          {
            tenant_id: ctx.tenantId,
            resource_id: args.resource_id,
            start_time: args.start_time,
            end_time: args.end_time,
          },
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),

    book_appointment: llm.tool({
      description:
        "Book an appointment at a specific slot when you ALREADY have a resource_id from get_scheduling_options. The resource_id MUST come from get_scheduling_options — get_available_slots does NOT return one, so if you only have a date/time the caller chose, call book_with_scheduling instead of this tool. Requires a good phone number (caller-ID or one the caller gives you). If the response contains 'I'll need a good phone number', collect and confirm a number from the caller per the phone-handling guidance in the instructions, then retry.",
      parameters: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              'A resource_id from get_scheduling_options output (not from get_available_slots).',
          },
          start_time: { type: 'string' },
          end_time: { type: 'string' },
          phone: {
            type: 'string',
            description:
              'Caller phone (E.164 preferred). Pass the caller-ID phone unless the caller gave you a different one verbally.',
          },
          name: { type: 'string', description: "Caller's name if known." },
          employee_id: { type: 'string', description: 'Optional — bind to a specific employee.' },
          description: {
            type: 'string',
            description: "Short description of what the caller wants, e.g., 'oil change'.",
          },
        },
        required: ['resource_id', 'start_time', 'end_time', 'phone'],
        additionalProperties: false,
      },
      execute: async (args: {
        resource_id: string;
        start_time: string;
        end_time: string;
        phone: string;
        name?: string;
        employee_id?: string;
        description?: string;
      }) => {
        // Guardrail (prod bug #3): book_appointment needs a resource_id that
        // ONLY get_scheduling_options returns. get_available_slots yields spoken
        // times with no resource_id, so the LLM sometimes reaches here empty-
        // handed and dead-ends. Fail loudly with a redirect to the one-call
        // path instead of 400ing the backend or letting the LLM invent an id.
        if (!args.resource_id || !args.resource_id.trim()) {
          return JSON.stringify({
            error:
              'book_appointment needs a resource_id from get_scheduling_options. If you only have a date and time the caller chose, call book_with_scheduling with a tight window around that time instead.',
            error_code: 'RESOURCE_ID_REQUIRED',
          });
        }
        speakFiller?.('One moment while I get that booked...');
        const bookRes = await client.call('/agent-tools/book-appointment', {
          tenant_id: ctx.tenantId,
          resource_id: args.resource_id,
          start_time: args.start_time,
          end_time: args.end_time,
          phone: args.phone,
          name: args.name,
          employee_id: args.employee_id,
          description: args.description ?? 'Booking via SecretaryHQ',
          call_id: ctx.callId ?? '',
        });
        const bookedId = extractAppointmentId(bookRes);
        if (bookedId) outcome?.recordBooking(bookedId);
        return formatResponse(bookRes);
      },
    }),

    book_with_scheduling: llm.tool({
      description:
        "Find a slot AND book it in one call using a time window and requirements. The default booking tool — use it after get_available_slots and when the caller says 'book the next available'. It books the EARLIEST open slot at or after window_from, so when the caller picked a SPECIFIC time, set window_from to exactly that time (a window that starts earlier will book them earlier than they asked). When the caller named a specific time, ALSO pass requested_start so the response can flag if the booked slot ended up different. The response returns the ACTUAL booked time (booked_time) — confirm THAT to the caller, not the time they requested.",
      parameters: {
        type: 'object',
        properties: {
          service_type: {
            type: 'string',
            description:
              'SAY WHAT THE CALLER SAID — not a catalog name you picked. Pass their own words for what they want: \"a meeting to talk about a contract role\", \"have the owner call me back\", \"look at my project\". The backend matches that to the right service SEMANTICALLY (it reads the catalog descriptions, which you cannot see in full). Do NOT try to pick the service yourself: on 2026-07-14 you decided a caller wanting a meeting about a six-month contract wanted a \"Personal Callback\" — a 15-minute call-me-back — and booked him into it. Report the intent; let the catalog choose. If the caller genuinely names a service, pass that name.',
          },
          required_resource_capabilities: { type: 'array', items: { type: 'string' } },
          required_employee_skills: { type: 'array', items: { type: 'string' } },
          preferred_resource_id: { type: 'string' },
          window_from: { type: 'string' },
          window_to: { type: 'string' },
          requested_start: {
            type: 'string',
            description:
              'The exact start time the caller specifically asked for, local-naive ISO (e.g. 2026-07-15T16:30:00). Set ONLY when the caller named a specific time; OMIT for "next available" / open-ended requests. Lets the response tell the caller if the booked slot differs from their request.',
          },
          phone: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          reminder_lead_minutes: {
            type: 'number',
            description:
              'How many minutes BEFORE the appointment to text a reminder. Set ONLY when the caller agreed to a text reminder (after the SMS-consent disclosures — see "Text reminders"). Use 30 when they say yes without naming a time; use their number when they name one ("an hour before" → 60, "the day before" → 1440). OMIT entirely if they declined or were not asked.',
          },
        },
        required: ['service_type', 'window_from', 'window_to', 'phone'],
        additionalProperties: false,
      },
      execute: async (args: {
        service_type: string;
        required_resource_capabilities?: string[];
        required_employee_skills?: string[];
        preferred_resource_id?: string;
        window_from: string;
        window_to: string;
        requested_start?: string;
        phone: string;
        name?: string;
        description?: string;
        reminder_lead_minutes?: number;
      }) => {
        speakFiller?.('One moment while I find and book a slot...');
        const res = await client.call('/agent-tools/book-with-scheduling', {
          tenant_id: ctx.tenantId,
          phone: args.phone,
          name: args.name,
          description: args.description ?? 'Booking via SecretaryHQ',
          call_id: ctx.callId ?? '',
          requirements: {
            serviceType: args.service_type,
            requiredResourceCapabilities: args.required_resource_capabilities,
            requiredEmployeeSkills: args.required_employee_skills,
            preferredResourceId: args.preferred_resource_id,
          },
          window: { from: args.window_from, to: args.window_to },
          // Absent → backend falls back to the caller's stored lead preference,
          // then to the standard bundle. Never invent a value here.
          reminder_lead_minutes: args.reminder_lead_minutes ?? null,
        });
        const bookedId = extractAppointmentId(res);
        if (bookedId) outcome?.recordBooking(bookedId);
        return formatBookingResponse(res, args.requested_start);
      },
    }),

    get_company_policy_answer: llm.tool({
      description:
        "Semantic search the knowledge base for policy/FAQ answers. Use BEFORE inventing any answer about hours, pricing, policies, warranties, etc. Returns plain text to read to the caller, or a fallback 'don't have that info' message.",
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: "The caller's question as a natural-language string.",
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
      execute: async (args: { question: string }) => {
        speakFiller?.('Let me look that up for you...');
        const res = await client.call(
          '/agent-tools/policy-answer',
          {
            tenant_id: ctx.tenantId,
            question: args.question,
          },
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),

    send_verification_code: llm.tool({
      description:
        'Send a 4-digit SMS verification code to the given phone. Use when a booking tool rejected for "I\'ll need a good phone number" and the caller has provided one verbally. Returns a message string to read VERBATIM to the caller.',
      parameters: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description:
              'The full phone number the caller gave you. Must include area code (10+ digits).',
          },
        },
        required: ['phone'],
        additionalProperties: false,
      },
      execute: async (args: { phone: string }) => {
        const res = await client.call('/agent-tools/send-verification-code', {
          tenant_id: ctx.tenantId,
          phone: args.phone,
          // Binds the code to THIS call. The server will only accept a
          // verification whose call_id matches the live call — without this the
          // code is issued unattributable and can never open the gate.
          call_id: ctx.callId,
        });
        return formatResponse(res);
      },
    }),

    verify_phone_code: llm.tool({
      description:
        'Verify a 4-digit code the caller just spoke back. On success the phone is trusted and the original booking can proceed. On failure the response tells you whether to ask again, resend, or pivot to taking a message.',
      parameters: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description: 'Must match the phone passed to send_verification_code.',
          },
          code: {
            type: 'string',
            description: 'The 4-digit code the caller read back. Digits only.',
            pattern: '^\\d+$',
          },
        },
        required: ['phone', 'code'],
        additionalProperties: false,
      },
      execute: async (args: { phone: string; code: string }) => {
        const res = await client.call('/agent-tools/verify-phone-code', {
          tenant_id: ctx.tenantId,
          phone: args.phone,
          code: args.code,
          call_id: ctx.callId,
        });

        // ADOPT THE PROVEN NUMBER.
        //
        // The caller just read back a code we texted to this handset — that is
        // strictly stronger evidence than caller-ID, which the carrier asserts
        // and nobody confirms. Yet ctx.callerPhone was set once at session start
        // and never reassigned, and on a forwarded line it is null. So every
        // tool that guards on `if (!ctx.callerPhone)` — get_my_appointments,
        // send_self_service_link, cancel_appointment, reschedule_appointment —
        // kept refusing AFTER a successful verification. The caller proved who
        // they were and the agent still said "I can't do that without caller-ID."
        //
        // The OTP flow proved the number and then threw the proof away. This is
        // the line that keeps it. (Thinking Hammer's live line IS the forwarded
        // one, so this was every returning customer, every call.)
        if (res.ok) {
          const verified = res.result as { verified?: boolean; phone?: string } | undefined;
          if (verified?.verified) {
            // Take the SERVER's normalized E.164 form, not the raw string the LLM
            // transcribed from speech — every downstream tool looks the customer
            // up by exact phone match, so "(630) 822-9086" and "+16308229086" are
            // not interchangeable here.
            ctx.callerPhone = verified.phone ?? args.phone;
          }
        }

        return formatResponse(res);
      },
    }),

    identify_caller: llm.tool({
      description: `Save or update the caller's contact record, and look them up. Call this as soon as you have their number — you do not need their name first. Keeps the address book current without duplicating records.\n\nIf the number is one we already have, the response may come back with returning_customer:true plus their NAME, saved preferences and recent history — USE it (greet them by name, offer their usual). You then do NOT need to ask their name: you have it. Confirm it instead ('I have you as Camille — still right?') rather than asking them to repeat it; a name you read from the record is more reliable than one heard over a phone line.\n\nIf it returns sms_consent:true, they have ALREADY agreed to appointment texts — that permission is on file and does not expire, so do NOT ask for it again and do NOT call record_sms_consent. Just say you'll text them as usual. If sms_consent is FALSE **or the field is ABSENT** (it is omitted on a requires_verification response, and for a brand-new caller), treat that as NO consent and ask for permission using the full script. A missing field is never permission.\n\nIf it returns requires_verification:true, the number was one THEY SPOKE (we had no caller ID), so we cannot trust it yet and will tell you nothing about the account. ${hasVerification ? 'Send them a code (send_verification_code) and verify it (verify_phone_code) BEFORE calling this again — never greet them by name or mention any account until it is verified.' : 'You have NO way to verify a number on this call: do NOT mention verification, codes or texts. It does NOT stop you BOOKING — treat them as a new caller, use the name and number they gave you, and book normally. A booking reveals nothing about anyone: they supply every fact in it.'}`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            // A NEUTRAL example. This description is sent to the LLM on every call for
            // every tenant, so a real person's name here is that person's PII sitting
            // in every customer's prompt — and it biases the model toward a name it
            // has seen in its instructions.
            description: 'The caller\'s full name as they stated it, e.g. "Jordan Reyes".',
          },
          phone: {
            type: 'string',
            description:
              "The caller's phone number as they gave it to you out loud. Always pass this when you have it — do not rely on caller ID.",
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      execute: async (args: { name: string; phone?: string }) => {
        const contactPhone = args.phone?.trim() || ctx.callerPhone;
        if (!contactPhone) {
          return 'No phone number available — ask the caller for their number, then save the contact.';
        }
        // WHERE DID THIS NUMBER COME FROM? This decides whether the backend will
        // reveal the caller's name, preferences and history — or demand OTP first.
        //
        //   ctx.callerPhone set  → the CARRIER gave us the number. Trustworthy.
        //   ctx.callerPhone null → we had no caller ID (forwarded line / blocked),
        //                          so any number here is one the CALLER SPOKE. It is
        //                          a claim, and anyone can claim anyone's number.
        //
        // Sending 'spoken' when unsure is the safe failure: worst case the caller
        // does an extra 20-second verification. Sending 'caller_id' when unsure
        // hands a stranger someone else's name and history.
        // phone_source describes THE NUMBER WE ARE SENDING — not the session's mood.
        //
        // A caller can have a perfectly good caller-ID and still give us a DIFFERENT
        // number ("actually, use my mobile"). That number is SPOKEN: they said it, we
        // cannot verify it, and it must not unlock someone else's account. Only the
        // number the CARRIER handed us is carrier-attested.
        //
        // Caught by a test that passed a spoken phone on a session that had caller-ID
        // — the first version of this line said 'caller_id' and would have trusted it.
        //
        // A BLANK phone is ABSENT, not spoken. Raised in review on #253: `!args.phone`
        // is false for "  ", so a whitespace string would have been classified
        // 'spoken' AND sent as the phone — misclassifying phone_source, which is the
        // field the server's disclosure gate keys on. LLMs emit "" for optional
        // fields constantly; a truthiness check is not enough for anything they fill.
        const spoken = blank(args.phone) ? undefined : args.phone!.trim();
        const usingCarrierNumber =
          Boolean(ctx.callerPhone) && (!spoken || spoken === ctx.callerPhone);
        const phoneSource = usingCarrierNumber ? 'caller_id' : 'spoken';
        const res = await client.call('/agent-tools/identify-caller', {
          tenant_id: ctx.tenantId,
          phone: spoken ?? ctx.callerPhone,
          name: args.name,
          phone_source: phoneSource,
          call_id: ctx.callId ?? undefined,
        });

        // THE SYSTEM REMEMBERS THE NUMBER, SO THE MODEL DOESN'T HAVE TO.
        //
        // On a forwarded line ctx.callerPhone is null by design. The caller gives
        // their number, the agent reads it back, they confirm — and then, when the
        // booking fell through and it pivoted to taking a message, it asked for a
        // callback number AGAIN. He had already given it twice.
        //
        // The prompt forbids that, in a section literally titled "never re-ask name
        // or phone" which names this exact pivot. The model ignored it. Prompts are
        // requests; this is a guarantee. Every tool that needs a callback number now
        // fills it from here, so a number the caller already gave cannot be
        // forgotten by a model that never has to hold it.
        if (res.ok && !usingCarrierNumber && spoken) {
          ctx.spokenPhone = spoken;
        }

        // Same rewrite as get_customer_context: identify-caller's
        // requires_verification message promises "I'll text a 4-digit code" —
        // a text this session cannot send when the verification capability is
        // off. It must not reach the model (it would relay the promise to the
        // caller verbatim).
        return gateVerificationAdvice(res);
      },
    }),

    save_customer_preference: llm.tool({
      description:
        "Remember a durable fact about the caller for future calls — preferred staff member, the service they just had, a like/dislike, an allergy, a standing request. Only use when the business has asked you to track preferences and the fact will still matter next time. Saving is silent; don't announce it. No-op if the caller isn't a known customer yet.",
      parameters: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description:
              "The caller's phone. Pass the caller-ID phone unless they gave a different verified one.",
          },
          key: {
            type: 'string',
            description:
              'Short stable label for the preference, e.g. "preferred_stylist", "last_service", "dislikes". Reuse the same key to update an existing preference.',
          },
          value: {
            type: 'string',
            description: 'The preference itself in plain text, e.g. "Maria" or "balayage".',
          },
        },
        required: ['phone', 'key', 'value'],
        additionalProperties: false,
      },
      execute: async (args: { phone: string; key: string; value: string }) => {
        const res = await client.call('/agent-tools/save-customer-preference', {
          tenant_id: ctx.tenantId,
          phone: args.phone,
          key: args.key,
          value: args.value,
        });
        return formatResponse(res);
      },
    }),

    record_sms_consent: llm.tool({
      description:
        'Record that the caller VERBALLY agreed to receive SMS appointment confirmations and reminders. Do NOT call this if sms_consent was already true — their permission is on file and does not expire. If sms_consent was false or absent, you DO need to ask and then call this. Call this ONLY after you have (1) asked permission, naming the business, (2) said it is for appointment messages only, (3) said "message and data rates may apply", (4) said they can reply STOP anytime — AND the caller clearly said yes. NEVER use this for marketing or promotions; appointment confirmations/reminders only. Pass the mobile number the caller confirmed for texts.',
      parameters: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description:
              'The mobile number the caller confirmed for appointment text reminders (the number they will actually be texted).',
          },
        },
        required: ['phone'],
        additionalProperties: false,
      },
      execute: async (args: { phone: string }) => {
        const res = await client.call('/agent-tools/record-consent', {
          tenant_id: ctx.tenantId,
          phone: args.phone,
          call_id: ctx.callId || undefined,
        });
        return formatResponse(res);
      },
    }),

    page_owner_via_sms: llm.tool({
      description:
        "URGENTLY page the business owner by text, mid-call, with the caller's name, callback number, and a one-line reason. Use ONLY for genuinely urgent or escalation-worthy matters the owner should see immediately (an emergency at the property, an angry customer threatening to leave, a time-critical business issue) — for ordinary requests use take_message instead. You may page the owner AT MOST ONCE per call. If it reports it can't page, offer to take a message instead.",
      parameters: {
        type: 'object',
        properties: {
          caller_name: {
            type: 'string',
            description: "The caller's name as they gave it.",
          },
          callback_phone: {
            type: 'string',
            description:
              "Number the owner should call back. Omit if the caller didn't give one (caller-ID is used).",
          },
          reason: {
            type: 'string',
            description:
              "ONE short line saying why this is urgent, e.g. 'water leak flooding the shop'. Be specific.",
          },
        },
        required: ['caller_name', 'reason'],
        additionalProperties: false,
      },
      execute: async (args: { caller_name: string; callback_phone?: string; reason: string }) => {
        // Per-call guard: one successful page maximum. The flag lives on the
        // session context so it survives across turns for the whole call.
        if (ctx.ownerPaged) {
          return JSON.stringify({
            error:
              'The owner has already been paged once on this call — do not page again. Offer to take a message with any additional details instead.',
          });
        }
        const res = await client.call('/agent-tools/page-owner', {
          tenant_id: ctx.tenantId,
          caller_name: args.caller_name,
          // Fill from what the SYSTEM knows, in order of trust, before falling back
          // to whatever the model happened to keep hold of. On a forwarded line
          // ctx.callerPhone is null — so without ctx.spokenPhone the model was the
          // ONLY thing remembering a number the caller had already given twice, and
          // it forgot, and it asked again.
          callback_phone: firstPhone(args.callback_phone, ctx.callerPhone, ctx.spokenPhone),
          caller_phone: firstPhone(ctx.callerPhone, ctx.spokenPhone),
          reason: args.reason,
          // Truthy check (not ??) so an empty-string callId is omitted — the
          // backend call_id is min(1) and would 400 on ''.
          call_id: ctx.callId || undefined,
        });
        if (res.ok) ctx.ownerPaged = true;
        return formatResponse(res);
      },
    }),

    take_message: llm.tool({
      description:
        "Record a message from the caller for the business owner and send the owner an SMS alert. Use when the caller has a question you can't answer, wants a callback, or asks to leave a message. Collect a name and the message content before calling this.\n\nDO NOT ASK FOR A CALLBACK NUMBER if the caller already gave you one earlier in this call — the system reuses it automatically. Omit callback_phone entirely and it will be filled in. Only ask if you genuinely never got a number at all.",
      parameters: {
        type: 'object',
        properties: {
          caller_name: {
            type: 'string',
            description: "The caller's name as they gave it.",
          },
          callback_phone: {
            type: 'string',
            description:
              'ONLY set this if the caller gives a NEW number specifically for the callback. Otherwise OMIT it — the number they already gave (or their caller-ID) is filled in automatically. Never ask them to repeat a number they have already given you.',
          },
          message: {
            type: 'string',
            description:
              'The substance of what the caller wants the owner to know or do. Be specific — capture exactly what they said.',
          },
        },
        required: ['caller_name', 'message'],
        additionalProperties: false,
      },
      execute: async (args: { caller_name: string; callback_phone?: string; message: string }) => {
        speakFiller?.('One moment while I pass that along...');
        const res = await client.call('/agent-tools/take-message', {
          tenant_id: ctx.tenantId,
          caller_name: args.caller_name,
          // THE PIVOT THAT FAILED (2026-07-13). On a forwarded line ctx.callerPhone
          // is null by design. The caller gave his number, the agent read it back, he
          // confirmed it — then the booking fell through, the agent switched to taking
          // a message, and asked him for a callback number AGAIN.
          //
          // The prompt forbids exactly this, in a section titled "never re-ask name or
          // phone" which even names this pivot. The model ignored it. So the SYSTEM
          // remembers: identify_caller records the confirmed number on the session and
          // it is filled in here, in order of trust — a new number the caller
          // deliberately gives for the callback still wins, because remembering must
          // never become ignoring them.
          callback_phone: firstPhone(args.callback_phone, ctx.callerPhone, ctx.spokenPhone),
          caller_phone: firstPhone(ctx.callerPhone, ctx.spokenPhone),
          message: args.message,
          call_id: ctx.callId ?? undefined,
        });
        return formatResponse(res);
      },
    }),

    capture_job_inquiry: llm.tool({
      description:
        "Record a work/job inquiry for the business owner and email it to them. Use when a caller asks whether the owner is available for work or about a specific position, AFTER you have walked through the intake questions.\n\nTHERE ARE TWO COMPANIES AND THEY ARE NOT THE SAME. `caller_company` is the agency the CALLER works for — the people you are actually talking to, and who the owner will negotiate the rate with. `client_company` is where the WORK would happen — the name on the badge. A recruiter from Insight Global placing someone at Blue Cross has caller_company='Insight Global' and client_company='Blue Cross'. Only when they are an IN-HOUSE recruiter (represents_company=true) are the two the same. Ask for both; do not guess one from the other.\n\nREQUIRES the caller's real name AND a callback number — it will REFUSE without them, and it is right to: a lead the owner cannot answer is not a lead. If it refuses, go and ask for what's missing, then call it again. You MUST call this tool once you have the answers — do not tell the caller you'll pass it along without calling it. Other fields you didn't get may be omitted.",
      parameters: {
        type: 'object',
        properties: {
          caller_name: { type: 'string', description: "The caller's name as they gave it." },
          callback_phone: {
            type: 'string',
            description: 'Phone number the owner should call back, if given.',
          },
          caller_company: {
            type: 'string',
            description:
              'The company the CALLER works for — the staffing agency that rang. NOT where the work is, unless they are an in-house recruiter.',
          },
          client_company: {
            type: 'string',
            description:
              'The company where the WORK would actually happen — the end client the owner would be placed at.',
          },
          represents_company: {
            type: 'boolean',
            description:
              'True if the caller works for the hiring company (vs. a recruiter/agency).',
          },
          employment_type: {
            type: 'string',
            enum: ['contract', 'full_time'],
            description: 'Whether the position is a contract or full time.',
          },
          rate_range: {
            type: 'string',
            description: 'The rate range (contract) or salary range (full time) offered.',
          },
          duration: {
            type: 'string',
            description: 'Length of the contract. Omit for full-time roles.',
          },
          location_type: {
            type: 'string',
            enum: ['onsite', 'remote', 'hybrid'],
            description: 'Whether the position is onsite, remote, or hybrid.',
          },
          address: {
            type: 'string',
            description: 'Address of the position. Collect for onsite or hybrid roles.',
          },
          timezone: {
            type: 'string',
            description:
              'Timezone of the position. Collect for remote roles (so the owner knows office hours).',
          },
        },
        required: ['caller_name'],
        additionalProperties: false,
      },
      execute: async (args: {
        caller_name: string;
        callback_phone?: string;
        caller_company?: string;
        client_company?: string;
        represents_company?: boolean;
        employment_type?: 'contract' | 'full_time';
        rate_range?: string;
        duration?: string;
        location_type?: 'onsite' | 'remote' | 'hybrid';
        address?: string;
        timezone?: string;
      }) => {
        // No name. speakFiller is currently a no-op, but this said "pass that along
        // to Dale" — so the day anyone re-enables it, every tenant's caller hears the
        // platform owner's first name. A dormant string is still a string.
        speakFiller?.('One moment while I pass that along...');
        const res = await client.call('/agent-tools/capture-job-inquiry', {
          tenant_id: ctx.tenantId,
          caller_name: args.caller_name,
          // firstPhone, NOT `??` — and it now also falls back to the number the
          // caller SPOKE (ctx.spokenPhone), which is the only number we have on a
          // forwarded line. This line used to be
          //   args.callback_phone ?? ctx.callerPhone ?? undefined
          // which is the exact nullish-coalescing trap documented on blank(): a model
          // sending callback_phone:"" would send the empty string AND block the
          // fallback. And it never consulted spokenPhone at all.
          //
          // The result, on a real call: a perfect job lead — six-month hybrid contract
          // at Blue Cross, $65-72/hr — captured with NO PHONE NUMBER. An inquiry you
          // cannot answer is not an inquiry. It is a story about one that got away.
          callback_phone: firstPhone(args.callback_phone, ctx.callerPhone, ctx.spokenPhone),
          caller_company: args.caller_company,
          client_company: args.client_company,
          represents_company: args.represents_company,
          employment_type: args.employment_type,
          rate_range: args.rate_range,
          duration: args.duration,
          location_type: args.location_type,
          address: args.address,
          timezone: args.timezone,
          // Truthy check (not ??) so an empty-string callId is omitted — the
          // backend call_id is min(1) and would 400 on ''.
          call_id: ctx.callId || undefined,
          // THE SYSTEM REMEMBERS THE MEETING, not the model. If this call already
          // booked an appointment, the outcome tracker holds its id — inject it so
          // the inquiry row links to the meeting it was booked around and the
          // backend stamps a job summary onto the calendar entry. The model never
          // sees or handles the UUID (same trust model as spokenPhone).
          appointment_id: outcome?.result().appointmentId ?? undefined,
        });
        return formatResponse(res);
      },
    }),

    attach_meeting_notes: llm.tool({
      description:
        "Attach a short note from the caller to the meeting that was booked on THIS call, so the owner sees it on the calendar entry (context, requests, anything they want known before the meeting). Only works after a booking has happened on this call — the system knows which meeting; you pass only the note. Do NOT use this for standalone messages or callback requests when no meeting was booked — that's take_message.",
      parameters: {
        type: 'object',
        properties: {
          notes: {
            type: 'string',
            description:
              'What the caller wants the owner to know ahead of the meeting, in their words. Be specific — capture what they actually said.',
          },
        },
        required: ['notes'],
        additionalProperties: false,
      },
      execute: async (args: { notes: string }) => {
        // THE FULFILLMENT GATE (2026-07-18, Dale's off-script call). The caller
        // said "he'll need my address"; the model attached exactly that — a
        // POINTER to an address, containing none — and the owner would have
        // opened the calendar with nowhere to go. The instructions now tell the
        // model to ask for the thing itself, but that judgment FLAPS (sim:
        // 2/2, then 1/2). This gate is the deterministic layer: a note that
        // NAMES an address / phone number / code and contains no digit almost
        // certainly mentions the thing without containing it — bounce it with
        // the action the model can take (rule: every error names a satisfiable
        // next step). A real address, number, or code carries digits ("1060
        // West Addison", "312-630-1234", "gate code 4417"), so genuine notes
        // pass untouched.
        const namesAThing = /\b(address|phone|number|code)\b/i.test(args.notes);
        const containsDigits = /\d/.test(args.notes);
        if (namesAThing && !containsDigits) {
          return JSON.stringify({
            error:
              'This note mentions an address, number, or code but does not CONTAIN one — a note saying the information is needed gives the owner nothing to use. Ask the caller for the thing itself ("Sure — what\'s the address?"), then call attach_meeting_notes again with what they say.',
          });
        }
        // The appointment id comes from the outcome tracker — the model never holds a
        // UUID. No booking on this call yet → nothing to attach to; say so honestly
        // instead of 400ing at the backend.
        const appointmentId = outcome?.result().appointmentId;
        if (!appointmentId) {
          return JSON.stringify({
            error:
              'No meeting has been booked on this call, so there is nothing to attach a note to. If the caller wants something passed along, record it as a message instead.',
          });
        }
        const res = await client.call('/agent-tools/attach-meeting-notes', {
          tenant_id: ctx.tenantId,
          appointment_id: appointmentId,
          notes: args.notes,
          call_id: ctx.callId || undefined,
        });
        return formatResponse(res);
      },
    }),

    get_detailed_customer_history: llm.tool({
      description:
        "Pull the caller's FULL history: their last ~10 appointments (any status, with service, staff member, date, and status), all saved preferences, and summaries of their last few calls. Deeper than get_customer_context — use when the caller asks about past visits ('when was I last in?', 'what did I have done last time?') or you need real history to answer well. Uses the verified caller phone automatically — no input needed.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        // Phone is SERVER-INJECTED from session context (same trust model as
        // get_my_appointments) — the LLM never supplies it, so it can never
        // enumerate another caller's history.
        if (!ctx.callerPhone) {
          // Identity already established (identify_caller succeeded with a
          // spoken number) but this line has no carrier caller-ID — a forwarded
          // line, or a browser call. History is simply not available on this
          // call, and the message must SAY SO AND POINT FORWARD. The first
          // version said "identify the caller first" unconditionally — advice
          // the model had ALREADY satisfied and so could never act on. On a
          // live call 2026-07-17 it responded the only way it could: by
          // retrying this tool until the per-turn step cap killed the turn
          // silently. Unsatisfiable advice in a tool result is a loop
          // generator; every error message must name a step the model can
          // actually take on THIS call.
          if (ctx.spokenPhone) {
            return JSON.stringify({
              error:
                "History is not available on this call (the line has no caller-ID). That is fine — you already have the caller's name and number, so continue with their request using what they have told you, and do not call this tool again on this call.",
            });
          }
          return JSON.stringify({
            error:
              'No verified caller phone yet — identify the caller first (confirm their name and number, e.g. via find_caller_by_name or identify_caller), then I can pull their history.',
          });
        }
        const res = await client.call(
          '/agent-tools/customer-history',
          {
            tenant_id: ctx.tenantId,
            phone: ctx.callerPhone,
            // This tool only ever sends ctx.callerPhone — the number the CARRIER
            // gave us. The LLM cannot substitute one here (there is no phone
            // parameter), which is why this is 'caller_id'. The server no longer
            // takes that on faith; it just happens to be true.
            phone_source: 'caller_id',
            call_id: ctx.callId,
          },
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),

    send_self_service_link: llm.tool({
      description:
        "Text the caller a secure link to cancel or reschedule one of their upcoming appointments THEMSELVES. Offer this proactively when a caller wants to cancel or reschedule — many prefer a link over doing it live. Pass the appointment_id from get_my_appointments; omit it to target the caller's next upcoming appointment. Requires the caller's verified phone (caller-ID) and their prior consent to receive texts; on failure, handle the cancel/reschedule live on the call instead.",
      parameters: {
        type: 'object',
        properties: {
          appointment_id: {
            type: 'string',
            description:
              "UUID of the appointment, exactly as returned by get_my_appointments. Omit to use the caller's next upcoming appointment.",
          },
        },
        additionalProperties: false,
      },
      execute: async (args: { appointment_id?: string }) => {
        // Ownership is phone-gated server-side, same as cancel/reschedule —
        // the phone comes from session context, never from the LLM.
        if (!ctx.callerPhone) {
          return JSON.stringify({
            error:
              "I can't text a link without caller-ID to verify the appointment is theirs. Handle the cancel or reschedule on the call instead.",
          });
        }
        const res = await client.call('/agent-tools/send-self-service-link', {
          tenant_id: ctx.tenantId,
          phone: ctx.callerPhone,
          appointment_id: args.appointment_id,
        });
        return formatResponse(res);
      },
    }),

    get_my_appointments: llm.tool({
      description:
        "Fetch the caller's upcoming scheduled appointments. Call this when the caller says they want to cancel or reschedule — show them their appointments before acting. Does not require any input from the caller; phone is from caller-ID.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        // Caller-ID if the carrier gave it; otherwise the number the caller confirmed in
        // the identity step (ctx.spokenPhone). On a forwarded/blocked-ID line caller-ID is
        // null by design, and without the spoken fallback a caller literally could not
        // manage their own appointment — booking already trusts the same spoken number.
        const managePhone = firstPhone(ctx.callerPhone, ctx.spokenPhone);
        if (!managePhone) {
          return JSON.stringify({
            error: `I can't look up appointments until I have your number. If you'd like help canceling or rescheduling, I can ${transferOrMessage}.`,
          });
        }
        const res = await client.call(
          '/agent-tools/my-appointments',
          { tenant_id: ctx.tenantId, phone: managePhone },
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),

    cancel_appointment: llm.tool({
      description:
        "Cancel one of the caller's upcoming appointments. ALWAYS call get_my_appointments first and read the result back so the caller can confirm which appointment they want to cancel. Ask them to confirm BEFORE calling this. For rescheduling use reschedule_appointment instead.",
      parameters: {
        type: 'object',
        properties: {
          appointment_id: {
            type: 'string',
            description:
              'UUID of the appointment to cancel, exactly as returned by get_my_appointments.',
          },
        },
        required: ['appointment_id'],
        additionalProperties: false,
      },
      execute: async (args: { appointment_id: string }) => {
        const managePhone = firstPhone(ctx.callerPhone, ctx.spokenPhone);
        if (!managePhone) {
          return JSON.stringify({
            error: `I can't cancel until I have your number to find the appointment. Offer to ${transferOrMessage}.`,
          });
        }
        const res = await client.call('/agent-tools/cancel-appointment', {
          tenant_id: ctx.tenantId,
          phone: managePhone,
          appointment_id: args.appointment_id,
        });
        return formatResponse(res);
      },
    }),

    reschedule_appointment: llm.tool({
      description:
        "Move an existing appointment to a new date and time. ALWAYS call get_my_appointments first so the caller can confirm which appointment to move. Confirm the new time verbally before calling this. Use book_with_scheduling to find an available slot if the caller doesn't have one yet.",
      parameters: {
        type: 'object',
        properties: {
          appointment_id: {
            type: 'string',
            description:
              'UUID of the appointment to reschedule, exactly as returned by get_my_appointments.',
          },
          new_start_time: {
            type: 'string',
            description: 'New start time in ISO 8601 format (e.g. 2026-07-15T10:00:00).',
          },
          new_end_time: {
            type: 'string',
            description: 'New end time in ISO 8601 format (e.g. 2026-07-15T11:00:00).',
          },
        },
        required: ['appointment_id', 'new_start_time', 'new_end_time'],
        additionalProperties: false,
      },
      execute: async (args: {
        appointment_id: string;
        new_start_time: string;
        new_end_time: string;
      }) => {
        const managePhone = firstPhone(ctx.callerPhone, ctx.spokenPhone);
        if (!managePhone) {
          return JSON.stringify({
            error: `I can't reschedule until I have your number to find the appointment. Offer to ${transferOrMessage}.`,
          });
        }
        speakFiller?.('One moment while I move that for you...');
        const res = await client.call('/agent-tools/reschedule-appointment', {
          tenant_id: ctx.tenantId,
          phone: managePhone,
          appointment_id: args.appointment_id,
          new_start_time: args.new_start_time,
          new_end_time: args.new_end_time,
        });
        return formatResponse(res);
      },
    }),

    transfer_call: llm.tool({
      description:
        'Transfer the live call to a real person (the business owner / staff cell). Use ONLY when the caller clearly needs a human — a personal call for the owner, an urgent issue you cannot handle, or an explicit request to be connected to someone. Before calling this, tell the caller you are connecting them (e.g. "One moment, connecting you now."). On success the call leaves this assistant; on failure or when transfer is unavailable, apologize briefly and offer to take a message.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        // No transfer wiring on this call (missing LiveKit creds or the SIP
        // participant never joined) — tell the LLM to fall back to a message.
        if (!transfer?.execute) {
          return JSON.stringify({
            error: 'Transfer is not available right now. Offer to take a message instead.',
          });
        }
        const result = await transfer.execute(transfer.forwardPhone);
        if (result.ok) {
          outcome?.recordTransfer();
          return 'Transfer started — the caller is being connected to a team member now. Do not keep talking; the call is leaving this assistant.';
        }
        if (result.reason === 'not_configured') {
          return JSON.stringify({
            error:
              'No transfer number is set up for this business, so you cannot connect the caller. Offer to take a message instead.',
          });
        }
        return JSON.stringify({
          error:
            'The transfer did not go through. Apologize briefly and offer to take a message instead.',
        });
      },
    }),
  };

  // Harden + compose. Wrap every tool's execute with the never-freeze contract
  // (timeout + catch→string + never-empty) IN PLACE, then return only the
  // selected capabilities (default: all). Wrapping at this one boundary means a
  // tool a customer adds is non-freezing BY CONSTRUCTION — it can't stall the
  // turn or hand the model an empty result.
  const wanted = opts?.capabilities;
  const result: llm.ToolContext = {};
  for (const [name, ft] of Object.entries(allTools)) {
    const cap = CAPABILITY_OF[name];
    if (wanted && (cap === undefined || !wanted.includes(cap))) continue;
    const mutable = ft as unknown as { execute: (args: never, opts: never) => Promise<unknown> };
    mutable.execute = wrapToolExecute(name, mutable.execute, {
      onError: ({ tool, reason, error }) =>
        getLogger().warn(
          {
            event: 'tool_contract_fallback',
            tool,
            reason,
            error_message: error instanceof Error ? error.message : undefined,
          },
          `tool ${tool} ${reason} — returned a graceful fallback so the caller is not left in silence`
        ),
      // EVERY call, happy path included. Grep `event:"tool_call"` with a call_id
      // to get the exact sequence of tools the model invoked on a call — and,
      // just as importantly, the ones it DIDN'T.
      //
      // On 2026-07-13 the agent told a caller "I just sent you a text with a
      // verification code" and "I see that 3 PM is taken". Neither happened: no
      // verification row existed and there were zero appointments that day. It had
      // narrated tool calls it never made — and because this wrapper only logged
      // FAILURES, a tool never invoked looked exactly like a tool that worked.
      // Both silent. The diagnosis took counting rows in six tables and reasoning
      // backwards.
      //
      // You cannot see a hallucinated tool call. You can only see the real ones
      // and notice what's missing. So log the real ones.
      onCall: ({ tool, ok, durationMs, resultPreview }) =>
        getLogger().info(
          {
            event: 'tool_call',
            tool,
            ok,
            duration_ms: durationMs,
            tenant_id: ctx.tenantId,
            call_id: ctx.callId,
            // What the model was HANDED. Compare against what it then said out
            // loud — that gap is where a hallucination lives.
            result_preview: resultPreview,
          },
          `tool_call ${tool} ${ok ? 'ok' : 'FAILED'} in ${durationMs}ms`
        ),
    });
    result[name] = ft;
  }
  return result;
}
