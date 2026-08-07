/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method, @typescript-eslint/no-explicit-any */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */
/**
 * Zod schemas and related constants for /agent-tools/* routes.
 * Extracted from agentTools.ts to keep each concern in its own file.
 */
import { z } from 'zod';

// ── SMS OTP config — decided 2026-04-23, revised 2026-07-13 ────────────
// 4-digit code, 10-min TTL (don't rush callers who are slow with their phones),
// max 3 verify attempts per code, rate-limit 3 sends per phone per hour + 100
// per tenant per day.
//
// WHY 4 AND NOT 6 (2026-07-13): the code is read back ALOUD, mid-call, by someone
// who just heard it on a phone. Six digits is a memory tax on the caller for a
// threat model that doesn't warrant it — this gate protects "don't tell a stranger
// Camille's stylist", not a bank balance. Four digits is a PIN, and people are very
// good at PINs.
//
// The math, honestly: 4 digits = 10,000 combinations. At 3 attempts per code and 3
// codes per phone per hour, a guesser gets 9 tries an hour → 0.09%. Sustained brute
// force would take hundreds of phone calls AND would text the victim's real handset
// on every single attempt — they would be buried in codes and would report it long
// before it worked. Attempts were tightened 5 → 3 to buy back what the shorter code
// gives away.
//
// THAT MATH WAS A LIE UNTIL 2026-07-13, in two ways (both now fixed):
//
//   1. MAX_VERIFY_ATTEMPTS was enforced PER ROW, and verify always read the most
//      recent unverified row. So a wrong-guesser simply asked for a NEW code — a
//      fresh row with attempt_count = 0 — and got 3 more tries. "3 attempts" was
//      really "3 attempts per code, unlimited codes", with no lockout anywhere.
//      The cap is now counted per (tenant, phone) across a rolling hour, so
//      requesting another code buys you nothing.
//
//   2. Issuing a new code never invalidated the old ones. Several codes were live
//      at once, so each guess was checked against a growing set of valid answers —
//      the effective keyspace SHRANK with every resend, the exact opposite of what
//      the rate limit was supposed to buy. A new code now expires the previous
//      pending ones: one live code per phone, always.
//
// Only with BOTH of those does "9 tries an hour against 10,000" describe reality.
export const CODE_DIGITS = 4;
export const CODE_TTL_MINUTES = 10;
/** Per-code cap (a single code dies after this many wrong guesses). */
export const MAX_VERIFY_ATTEMPTS = 3;
/**
 * Per-PHONE cap across every code issued in the last hour. This is the one that
 * actually bounds a brute-force attempt; the per-code cap alone was trivially
 * reset by asking for another code. Deliberately >= MAX_VERIFY_ATTEMPTS so a
 * caller who genuinely fumbles one code can still be issued a second and try
 * again — it stops a grinder, not a person having a bad phone call.
 */
export const MAX_VERIFY_ATTEMPTS_PER_PHONE_PER_HOUR = 6;
export const RATE_LIMIT_PER_PHONE_PER_HOUR = 3;
export const RATE_LIMIT_PER_TENANT_PER_DAY = 100;

// ── AI cost pricing constants ─────────────────────────────────────────
export const COST_PER_INPUT_TOKEN: Record<string, number> = {
  'gpt-4o-mini': 0.15e-6,
  'text-embedding-3-small': 0.02e-6,
};
export const COST_PER_OUTPUT_TOKEN: Record<string, number> = {
  'gpt-4o-mini': 0.6e-6,
};
export const DEEPGRAM_COST_PER_MS = 0.0043 / 60000; // $0.0043/min

// ── Zod schemas (ported from supabase/functions/vapi-tools/index.ts) ──

export const GetContextSchema = z.object({
  phone: z.string().min(5),
  tenant_id: z.string().uuid(),
  // Same disclosure gate as identify_caller — this route hands back the SAME
  // name + preferences. Defaults to 'spoken' (the cautious value) so a caller
  // that omits it gets the gate, not a bypass. See callerMayHearCustomerData.
  phone_source: z.enum(['caller_id', 'spoken']).optional().default('spoken'),
  call_id: z.string().optional(),
});

export const FindByNameSchema = z.object({
  name: z.string().min(1),
  tenant_id: z.string().uuid(),
});

export const CheckAvailabilitySchema = z.object({
  tenant_id: z.string().uuid(),
  resource_id: z.string().uuid(),
  start_time: z.string(),
  end_time: z.string(),
});

export const BookAppointmentSchema = z.object({
  tenant_id: z.string().uuid(),
  resource_id: z.string().uuid(),
  phone: z.string().default(''),
  name: z.string().optional(),
  start_time: z.string(),
  end_time: z.string(),
  description: z.string().default('Booking via SecretaryHQ'),
  call_id: z.string().default(''),
  location: z.string().optional(),
  employee_id: z
    .string()
    .or(z.number())
    .optional()
    .transform((v) => v?.toString()),
});

export const GetPolicyAnswerSchema = z.object({
  tenant_id: z.string().uuid(),
  question: z.string().min(1),
});

export const GetSchedulingOptionsSchema = z.object({
  tenant_id: z.string().uuid(),
  requirements: z.object({
    serviceType: z.string().min(1),
    requiredResourceCapabilities: z.array(z.string()).optional(),
    requiredEmployeeSkills: z.array(z.string()).optional(),
  }),
  window: z.object({ from: z.string(), to: z.string() }),
  // Optional — lets a pure availability inquiry (no booking attempt) still be
  // attributed to its voice_session for abandonment-by-service analytics.
  call_id: z.string().min(1).optional(),
});

export const BookWithSchedulingSchema = z.object({
  tenant_id: z.string().uuid(),
  phone: z.string().default(''),
  name: z.string().optional(),
  description: z.string().default('Booking via SecretaryHQ'),
  call_id: z.string().default(''),
  location: z.string().optional(),
  requirements: z.object({
    serviceType: z.string().min(1),
    requiredResourceCapabilities: z.array(z.string()).optional(),
    requiredEmployeeSkills: z.array(z.string()).optional(),
    durationMinutes: z.number().int().positive().optional(),
    preferredResourceId: z.string().optional(),
  }),
  window: z.object({ from: z.string(), to: z.string() }),
  // The caller's answer to "would you like a text reminder, and how far ahead?"
  // Absent/null = they weren't asked or declined → no custom reminder is seeded
  // (the seeder falls back to their stored preference, then to the standard
  // bundle). Bounded to match the DB CHECK (0 < lead <= 90 days); an int, since
  // "remind me in 22.5 minutes" is not a thing a person says.
  // 2026-07-12.
  reminder_lead_minutes: z.number().int().positive().max(129600).optional().nullable(),
  // Set only after the caller has been TOLD about their existing same-day
  // appointment and said they want a second one anyway. The cross-call
  // duplicate guard (2026-07-31) refuses otherwise — see the route. Default
  // false is what makes the guard the default; a model that never learns this
  // flag simply cannot double-book across calls.
  allow_duplicate: z.boolean().optional().default(false),
});

export const GetServiceCatalogSchema = z.object({
  tenant_id: z.string().uuid(),
});

export const GetTenantConfigSchema = z.object({
  tenant_id: z.string().uuid(),
});

// save_customer_preference — the AI persists a durable fact about the caller
// (preferred stylist, last service, likes/dislikes, upsell flags) as a
// key/value pair into the customer_preferences table (one row per customer+key;
// was a jsonb blob on customers.metadata until 2026-07-12). Read back on the
// next call by get_customer_context_for_call. Key is normalized to a short
// stable slug; value is free text the AI heard. Only writes for an existing
// customer (a phone the CRM already knows) — we don't conjure a customer row
// just to hang a preference on, and the agent should have already called
// get_customer_context (or booked) before it has anything worth saving.
export const SaveCustomerPreferenceSchema = z.object({
  tenant_id: z.string().uuid(),
  phone: z.string().min(5),
  key: z.string().min(1).max(60),
  // The column is unbounded TEXT; this cap is a guard, not a storage limit. The
  // value is LLM-authored, so an unbounded field lets a looping/rambling model
  // write arbitrary text into the DB mid-call. 4000 is far past any real
  // preference ("Maria", "no fragrance, allergic to lavender") while still
  // bounding the blast radius. Raised from 500 on 2026-07-12.
  value: z.string().min(1).max(4000),
});

export const IdentifyCallerSchema = z.object({
  tenant_id: z.string().uuid(),
  phone: z.string().min(5),
  name: z.string().min(1).max(200).optional(),
  // THE CALLER CORRECTED A NAME **WE** GOT WRONG ON THIS CALL.
  //
  // The upsert only overwrites a PLACEHOLDER name, which is right for the
  // ordinary case: a later call must not be able to rename an established
  // customer, because anyone can dial a number and claim to be someone. But it
  // also made a mishearing permanent — "Jamil" was saved, the caller said "no,
  // Camille, C-A-M-I-L-L-E" thirty seconds later, and the record kept Jamil
  // (CALL_IMPROVEMENTS.md #2).
  //
  // Set ONLY by the agent's host code, and only when THIS CALL already wrote a
  // name and the caller then changed it. Never model-supplied.
  is_correction: z.boolean().optional().default(false),
  // WHO IS ASSERTING THIS NUMBER? (2026-07-13 — closes a data leak.)
  //
  //   'caller_id' → the CARRIER attested it. The phone network vouches that the
  //                 call originated from this handset. Trustworthy.
  //   'spoken'    → the CALLER said it out loud, because we had no caller ID
  //                 (forwarded line, or blocked). It is a CLAIM, not a fact.
  //
  // The route reveals a returning customer's NAME, PREFERENCES and HISTORY. For a
  // 'spoken' number that is a data leak: anyone who guesses (or knows) Camille's
  // phone number could ring the forwarded line, claim it, and be told her name,
  // her stylist, and what she last had done. So a 'spoken' number reveals NOTHING
  // until it has passed OTP verification — the contact is still saved (writing is
  // not leaking), but returning_customer comes back false and no personal data
  // rides along.
  //
  // Defaults to 'spoken' — the SAFE assumption. A caller that forgets to say where
  // the number came from gets the cautious treatment, never the leaky one.
  phone_source: z.enum(['caller_id', 'spoken']).optional().default('spoken'),
  // When present, link the captured number + customer onto this call's
  // voice_sessions row so the Calls tab shows the verbally-collected number
  // (forwarded-line calls start with caller_phone null).
  call_id: z.string().min(1).optional(),
});

export const GetAvailableSlotsSchema = z.object({
  tenant_id: z.string().uuid(),
  service_type: z.string().min(1),
  // OPTIONAL since 2026-07-17 (Dale's lead-with-times opener): omitted = "the
  // SOONEST openings from now" — the route returns the next three real times
  // (cross-day, duration-stepped, with a lead buffer) so the agent can OPEN
  // with concrete options instead of asking "what day works for you?" against
  // a calendar the caller cannot see. With a date = that day's slots, as ever.
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
    .optional(),
  // The specific time the caller ASKED FOR ("2:30 PM", "14:30"). When it isn't
  // bookable the response says WHY (occupied_by_caller / occupied /
  // outside_shift / past / no_room / closed) instead of leaving the model to
  // invent a reason — it invented "we can only book on the quarter hour" for a
  // 2:30 that the caller's OWN appointment was sitting on (2026-07-27, #8).
  // Only meaningful alongside `date`.
  requested_time: z.string().max(20).optional(),
  // Server-injected by the agent runtime (never the model) so a blocking
  // appointment can be attributed to the person on the phone — "you already
  // have 2:30 booked" is a different answer from "2:30 is taken".
  caller_phone: z.string().max(50).optional(),
  // Optional — see GetSchedulingOptionsSchema.call_id (pure-inquiry attribution).
  call_id: z.string().min(1).optional(),
});

// Verbal SMS-consent capture — the caller said yes to appointment reminders on
// the call. Informational/transactional only (never marketing).
export const RecordSmsConsentSchema = z.object({
  tenant_id: z.string().uuid(),
  // min(1) only — completeness is judged by normalizePhone/isValidPhone in the
  // handler so an incomplete number gets the friendly soft-failure, not a
  // generic schema "Validation failed".
  phone: z.string().min(1),
  call_id: z.string().min(1).optional(),
});

export const SendVerificationCodeSchema = z.object({
  tenant_id: z.string().uuid(),
  phone: z.string().min(5),
  // The call this code is issued on. Stored on the row, and the disclosure gate
  // requires the verified row to match the LIVE call — a code proves possession
  // at a moment, not ownership of the number for the next 24 hours. Optional in
  // the schema (non-voice callers exist) but a verification with no call_id can
  // never open the gate: an unattributable proof is not a proof.
  call_id: z.string().min(1).optional(),
});

export const VerifyPhoneCodeSchema = z.object({
  tenant_id: z.string().uuid(),
  phone: z.string().min(5),
  code: z.string().regex(/^\d+$/, 'Code must be numeric').length(CODE_DIGITS),
  // Scopes the lookup to a code issued on THIS call, so a code overheard from an
  // earlier call cannot be replayed on a new one.
  call_id: z.string().min(1).optional(),
});

// take-message — record a caller message + SMS-notify the owner.
// "Take a message" was previously pure LLM theater — the agent would say it
// but nothing was stored. Now it lands in customer_messages and the owner's
// forward_phone gets a text so no message is silently lost.
export const TakeMessageSchema = z.object({
  tenant_id: z.string().uuid(),
  caller_name: z.string().min(1).max(200),
  callback_phone: z.string().optional(),
  caller_phone: z.string().optional(),
  message: z.string().min(1).max(2000),
  call_id: z.string().optional(),
  // THE CALLER SAID IT CANNOT WAIT. Set from their own words ("urgent", "as
  // soon as possible", "emergency"), never inferred from the topic — a message
  // about money is not urgent because it is about money. On 2026-07-27 a caller
  // said "I want to talk with him urgently" and received a list of appointment
  // slots (CALL_IMPROVEMENTS.md #7); there is no live-transfer path on this
  // call flow, so the honest move is to take the message and MARK it.
  is_urgent: z.boolean().optional().default(false),
});

// page-owner — urgent mid-call SMS page to the business owner. Distinct from
// take-message (no full message intake needed): the agent fires it the moment
// a caller reports something escalation-worthy. Persists a customer_messages
// row (message prefixed "[URGENT PAGE]" — no new table/migration needed) ONLY
// when the owner is actually pageable, so a failed page cleanly falls back to
// take_message without double-recording.
export const PageOwnerSchema = z.object({
  tenant_id: z.string().uuid(),
  caller_name: z.string().min(1).max(200),
  callback_phone: z.string().max(50).optional(),
  caller_phone: z.string().optional(),
  reason: z.string().min(1).max(500),
  call_id: z.string().min(1).optional(),
});

// customer-history — deeper caller history than customer-context: last ~10
// appointments (any status, with service/employee/date/status), saved
// preferences, and the last ~3 post-call summaries from voice_sessions.
// Phone is server-injected by the agent from session context (same trust
// model as my-appointments) — the LLM never supplies it.
export const CustomerHistorySchema = z.object({
  tenant_id: z.string().uuid(),
  phone: z.string().min(5),
  // Call history is identity data too. Gated exactly like identify_caller and
  // customer-context; 'spoken' is the safe default.
  phone_source: z.enum(['caller_id', 'spoken']).optional().default('spoken'),
  call_id: z.string().optional(),
});

// send-self-service-link — text the caller a secure cancel/reschedule link for
// one of their own upcoming appointments (default: the next one). Reuses the
// selfServiceToken machinery via appointmentService's exported link builders.
// Ownership is phone-gated exactly like cancel/reschedule; the SMS goes through
// the consent-gated SMSService (opt-outs respected).
export const SendSelfServiceLinkSchema = z.object({
  tenant_id: z.string().uuid(),
  phone: z.string().min(5),
  appointment_id: z.string().uuid().optional(),
});

// capture-job-inquiry — structured intake when a recruiter asks whether the
// owner is available for work. Persists a job_inquiries row + emails the owner.
// All position fields optional: the contract vs full-time branches collect
// different subsets and a caller may bail mid-intake — a partial inquiry is
// still worth saving + notifying on. caller_name is the only required field.
export const CaptureJobInquirySchema = z.object({
  tenant_id: z.string().uuid(),
  caller_name: z.string().min(1).max(200),
  callback_phone: z.string().max(50).optional(),
  // TWO companies. The agency that CALLED, and the client where the work happens.
  // They are different facts and both matter — see migration 20260714130000.
  caller_company: z.string().max(300).optional(),
  client_company: z.string().max(300).optional(),
  represents_company: z.boolean().optional(),
  // contract_to_hire added 2026-07-21: a live caller answered "contract to hire",
  // the tree accepted it, and THIS enum bounced the whole capture — the agent had
  // to ask the caller to re-answer and then mislabeled the role "contract".
  employment_type: z.enum(['contract', 'full_time', 'contract_to_hire']).optional(),
  // The role itself, in the caller's own words — title, tech, responsibilities.
  // Generous cap: callers dictate whole paragraphs, and the paragraph is the lead.
  role_description: z.string().max(2000).optional(),
  rate_range: z.string().max(200).optional(),
  duration: z.string().max(200).optional(),
  location_type: z.enum(['onsite', 'remote', 'hybrid']).optional(),
  address: z.string().max(500).optional(),
  timezone: z.string().max(100).optional(),
  call_id: z.string().min(1).optional(),
  // The meeting this inquiry was booked around, when the call produced one. Injected by
  // the AGENT RUNTIME from the call-outcome tracker (the model never holds a UUID) — see
  // agent/src/tools.ts capture_job_inquiry. Links the inquiry row to the appointment and
  // stamps a readable summary into the appointment's description.
  appointment_id: z.string().uuid().optional(),
});

// attach-meeting-notes — append the caller's own context to a booked appointment. The
// meeting-goals rung asks one light wrap-up question ("anything you'd like the owner to
// know before the meeting?"); this is where the answer lands. appointment_id is injected
// by the agent runtime from the call-outcome tracker — the model passes only the notes.
export const AttachMeetingNotesSchema = z.object({
  tenant_id: z.string().uuid(),
  appointment_id: z.string().uuid(),
  notes: z.string().min(1).max(2000),
  call_id: z.string().min(1).optional(),
});

// voice-session-start / -end — the LiveKit agent logs a call so the dashboard
// Calls tab + customer call history populate. These mirror the JWT-gated
// /voice/session/{start,end} routes but use the agent-secret + body-tenant_id
// auth model every other agent-tools call uses (the agent has no JWT). Both
// reuse the existing start_voice_session / end_voice_session DB functions.
export const VoiceSessionStartSchema = z.object({
  tenant_id: z.string().uuid(),
  call_id: z.string().min(1),
  caller_phone: z.string().min(1).nullable().optional(),
});

// The agent posts this when a dispatch produced NO SIP participant and it is
// leaving without opening a session (ghost/duplicate dispatch, 2026-07-23).
// Observability only — bumps errors_total{event="dispatch_no_participant"}.
export const ReportDispatchNoParticipantSchema = z.object({
  tenant_id: z.string().uuid(),
  room: z.string().min(1).max(200),
});

export const VoiceSessionEndSchema = z.object({
  tenant_id: z.string().uuid(),
  call_id: z.string().min(1),
  duration_seconds: z.number().int().nonnegative().nullable().optional(),
  outcome: z.string().max(50).nullable().optional(),
  // Rendered plain-text transcript (Caller:/Assistant: lines). Bound mirrors the
  // agent's MAX_TRANSCRIPT_CHARS so a pathological call can't write a huge row.
  transcript: z.string().max(100_000).nullable().optional(),
  // Post-call LLM summary (1–2 sentences). Bounded so a model can't write a huge row.
  summary: z.string().max(2000).nullable().optional(),
  // The appointment booked during the call, if any. UUID-validated so a malformed
  // id can't reach (and 500) the RPC's ::uuid cast — it just stays null.
  appointment_id: z.string().uuid().nullable().optional(),
  // Persisted per-call tool trace → voice_sessions.metadata.tool_calls (2026-07-30,
  // CALL_IMPROVEMENTS.md: the Railway log copy rotated away before the 07-27 calls
  // could be analyzed; call #8's postmortem died at three candidate causes). Args
  // arrive PII-redacted from the agent (redactToolArgs). Bounds mirror the agent's
  // MAX_TOOL_LOG_ENTRIES cap; the total-size refine keeps a hostile/buggy payload
  // from writing a multi-MB jsonb.
  tool_calls: z
    .object({
      entries: z
        .array(
          z.object({
            t: z.number().int().nonnegative(),
            tool: z.string().max(100),
            args: z.unknown().optional(),
            ok: z.boolean().nullable(),
            ms: z.number().int().nonnegative().nullable(),
          })
        )
        .max(200),
      dropped: z.number().int().nonnegative(),
    })
    .nullable()
    .optional()
    .refine((v) => v == null || JSON.stringify(v).length <= 120_000, {
      message: 'tool_calls payload too large',
    }),
});

// Incremental transcript save — the agent posts the transcript-so-far after each
// turn so a call that hangs/never finalizes still has its conversation persisted.
export const VoiceSessionTranscriptSchema = z.object({
  tenant_id: z.string().uuid(),
  call_id: z.string().min(1),
  // min(1): never accept an empty transcript — it would blank an active row's
  // existing transcript (accidental data loss). The agent only ever sends a
  // non-empty render(), so this is a boundary guard.
  transcript: z.string().min(1).max(100_000),
});

export const MyAppointmentsSchema = z.object({
  tenant_id: z.string().uuid(),
  phone: z.string().min(5),
});

export const CancelAppointmentSchema = z.object({
  tenant_id: z.string().uuid(),
  phone: z.string().min(5),
  appointment_id: z.string().uuid(),
});

export const RescheduleAppointmentSchema = z.object({
  tenant_id: z.string().uuid(),
  phone: z.string().min(5),
  appointment_id: z.string().uuid(),
  new_start_time: z.string().min(1),
  new_end_time: z.string().min(1),
});

// ── AI cost schemas ───────────────────────────────────────────────────
export const ModelUsageItemSchema = z.object({
  type: z.enum(['llm_usage', 'tts_usage', 'stt_usage', 'interruption_usage']),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().int().default(0),
  outputTokens: z.number().int().default(0),
  charactersCount: z.number().int().default(0),
  audioDurationMs: z.number().default(0),
});

export const RecordAiCostSchema = z.object({
  tenant_id: z.string().uuid(),
  call_id: z.string().optional(),
  source: z.enum(['voice_call', 'kb_ingestion', 'kb_query', 'call_summary']),
  model_usage: z.array(ModelUsageItemSchema),
});
