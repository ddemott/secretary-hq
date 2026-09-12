/**
 * THE CONVERSATION LAYER'S TOOLSET — question-tree phase 3
 * (docs/QUESTION_TREE_ARCHITECTURE.md §3.3).
 *
 * This is the seam where the model meets the ChecklistTracker. Every tool here
 * follows one contract: THE TOOL RESULT CARRIES THE STATE. The rendered
 * checklist (or the corrective error) rides back in the result — the one piece
 * of context the model reliably re-reads all call (the standing_fact lesson,
 * 2026-07-21 double-booking) — so the model never has to remember what is open;
 * it just reads it.
 *
 * Built as an injectable factory (no LiveKit session, effects passed in) so the
 * whole layer is unit-testable by calling the executes directly — the same
 * reason the tracker is pure.
 *
 * Guarantees enforced HERE, not hoped for in the prompt:
 *  - an action tool refuses while its node is blocked (and says what is first)
 *  - a DONE action refuses a repeat — the anti-double-book gate
 *  - two consecutive real failures of one action → advice to stop retrying and
 *    take a message (the HARD-DOWN rule 15 shape: {error, error_code})
 *  - finish_call cannot close the call while the checklist is open
 *  - identify_caller fires from HOST CODE the moment name + phone are both in
 *    (PR #266: message-leaving callers used to never reach the phone book)
 */
import { llm } from '@livekit/agents';
import { getLogger } from '../logger.js';
import { sanitizeVolunteered } from '../tasks/sanitize.js';
import { normalizeSpelledName, splitNameAndCompany } from '../nameCleanup.js';
import {
  type ChecklistTracker,
  RecordError,
  UnknownNodeError,
  UnknownTreeError,
} from './tracker.js';
import type { ActionNodeDef, NodeId, QuestionTreeDef } from './types.js';
import { CALLER_NAME, CALLER_PHONE } from './trees.js';
import { BLOCK_LIBRARY } from './blockLibrary.js';
import type { ToolMap } from '../tools.js';

/**
 * TREE-LEVEL CONFLICTS, COMPILED FROM THE BLOCK CONTRACT.
 *
 * `set_purpose` speaks in TREE ids; the contract is declared in BLOCK ids. This
 * flattens one into the other once, at module load, so the gate below reads a
 * declaration instead of naming a pair in code. Adding the next confusable pair
 * is then one line in `blockLibrary.ts` and no change here — which matters
 * because the pair we know about was found by a caller, not by review.
 */
const TREE_CONFLICTS: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const block of Object.values(BLOCK_LIBRARY)) {
    for (const treeId of block.tree_refs ?? []) {
      const against = new Set<string>();
      for (const otherId of block.conflicts_with ?? []) {
        for (const otherTree of BLOCK_LIBRARY[otherId]?.tree_refs ?? []) against.add(otherTree);
      }
      if (against.size > 0) map.set(treeId, against);
    }
  }
  return map;
})();

/**
 * The clarifying QUESTION a conflict should produce, keyed by the sorted pair.
 *
 * A refusal that only says "these contradict" leaves the model to invent its
 * own way out, and on a live call it invents badly. Every refusal in this file
 * names the satisfiable next step; for a conflict, that step is one question
 * put to the caller. Pairs without an entry get a generic form built from the
 * two blocks' own descriptions — usable, but worth replacing with real wording
 * the first time a call proves what the caller actually needs to be asked.
 */
const CONFLICT_CLARIFIERS: Record<string, string> = {
  'buy_service|job':
    'Ask which it is ("Are you looking to hire him, or interested in the AI receptionist for your ' +
    'own business?"), then select ONE of them.',
};

/**
 * The first declared conflict among a proposed tree selection, or null.
 * Exported so the compile-from-declaration step is testable without standing up
 * a session — the property worth guarding is that this reads BLOCK_LIBRARY and
 * not a pair written into the gate.
 */
export function conflictingTreePair(trees: string[]): [string, string] | null {
  for (const treeId of trees) {
    const against = TREE_CONFLICTS.get(treeId);
    if (!against) continue;
    const clash = trees.find((other) => against.has(other));
    if (clash) return [treeId, clash];
  }
  return null;
}

function conflictRefusal(a: string, b: string): string {
  const pair = [a, b].sort();
  const clarifier =
    CONFLICT_CLARIFIERS[pair.join('|')] ??
    `Ask the caller which one they are here for — ${BLOCK_LIBRARY[pair[0]]?.description ?? pair[0]} ` +
      `versus ${BLOCK_LIBRARY[pair[1]]?.description ?? pair[1]} — then select ONE of them.`;
  return (
    `REFUSED: ${pair[0]} and ${pair[1]} contradict each other — one caller cannot be both on the ` +
    `same call. ${clarifier}`
  );
}

/** The JSON field whose presence in a tool's result proves the write LANDED. */
const ACTION_ID_FIELDS: Record<string, string> = {
  book_with_scheduling: 'appointment_id',
  take_message: 'message_id',
  capture_job_inquiry: 'job_inquiry_id',
  capture_case_inquiry: 'submission_id',
  cancel_appointment: 'appointment_id',
  reschedule_appointment: 'appointment_id',
};

/**
 * Actions whose write can be REDONE when an answer it consumed is corrected.
 *
 * 2026-07-27 (SCL_ReG7kLRiY94c, CALL_IMPROVEMENTS.md #2): the caller's name was
 * heard as "Jamil", take_message wrote the row, and thirty seconds later she
 * corrected it — "Camille, C-A-M-I-L-L-E". The tracker updated. The row did
 * not. It still says Jamil in production. Host-owned state that a landed write
 * ignores is the same state theater as the dropped location_type, one layer
 * later: we fixed what the write READS and never fixed what happens when the
 * reading CHANGES.
 *
 * Only tools that are idempotent per call belong here — take_message upserts on
 * (tenant_id, call_id) since migration 20260801000000, so re-firing rewrites its
 * own row. capture_job_inquiry is deliberately ABSENT despite being idempotent:
 * its route returns the existing row unchanged on conflict (DO NOTHING), so a
 * re-fire would be a lie dressed as a fix. Booking actions are absent for a
 * blunter reason — a corrected name must never silently move an appointment.
 */
const REWRITABLE_ON_CORRECTION: Record<string, readonly NodeId[]> = {
  take_message: [CALLER_NAME, CALLER_PHONE, 'message_body'],
};

/** Read tools a tree needs alongside its action (the calendar for a booking). */
export const TREE_PASSTHROUGH_TOOLS: Record<string, string[]> = {
  booking: ['get_available_slots', 'get_service_catalog'],
  schedule_change: ['get_my_appointments', 'get_available_slots'],
  // A sales call's write is the DEMO BOOKING, so buy_service has no action node of
  // its own (an action that cannot complete would hold the goodbye gate open — see
  // BUY_SERVICE_TREE). attach_meeting_notes rides along so the qualifying answers can
  // reach the owner ON the meeting; unwrapped, so it never gates anything and is
  // simply unavailable-by-error when no booking happened.
  buy_service: ['attach_meeting_notes'],
  // Recognizing a returning caller and proving a SPOKEN number both live behind
  // the identity tree — every goal-bearing call selects it (its own description:
  // "Select for EVERY call whose goals need a contact"). Before this, these three
  // tools were fully built end-to-end on the backend (the disclosure gate in
  // callerMayHearCustomerData, the call-bound phone_verifications row, ctx.callerPhone
  // adoption on verify_phone_code success) and completely unreachable on a live
  // call: selectedTools() never offered them, so a forwarded-line caller could
  // never be recognized or proven, no matter what the backend was ready to do.
  identity: ['get_customer_context', 'send_verification_code', 'verify_phone_code'],
};

/**
 * HOST-SIDE ARG BACKFILL (2026-07-21, first live tree call): the tracker HOLDS
 * every recorded answer, but wrapAction forwarded only what the model RETYPED
 * into the action's args — and on the first live call it silently dropped
 * location_type (the caller crisply answered "On-site"; the checklist showed
 * work_mode ✓) and rate_range. Host-owned state that the write ignores is
 * state theater. So: any arg the model omits is filled from the tracker's
 * answer for the mapped node(s); the model's own args win when present
 * (it may legitimately normalize phrasing). Declined/empty answers never fill.
 */
type ArgFill = {
  arg: string;
  from: readonly string[];
  map?: (v: string) => unknown;
  /**
   * Take EVERY recorded node in `from` and fold them into one value, instead of
   * the default "first non-empty wins". An appointment description is the case
   * that needs it: the topic and whatever the caller volunteered about the
   * meeting are both true at once, and picking one would drop the other.
   */
  combine?: (values: string[]) => unknown;
};
// Exported for the capture-completeness test: every collected tree node must map
// to a tool param here (or be an explicitly-declared control node) — the guard
// that turns a silently-dropped field (role_description, found 2026-07-30) into
// a CI failure instead of a prod discovery.
export const ACTION_ARG_BACKFILL: Record<string, readonly ArgFill[]> = {
  capture_job_inquiry: [
    { arg: 'caller_name', from: ['caller_name'] },
    { arg: 'callback_phone', from: ['caller_phone'] },
    { arg: 'caller_company', from: ['callers_company'] },
    { arg: 'client_company', from: ['client_company'] },
    { arg: 'represents_company', from: ['hiring_for'], map: (v) => v === 'own_company' },
    {
      arg: 'employment_type',
      from: ['employment_type'],
      // contract_to_hire is first-class end to end since 2026-07-21 — this map
      // used to collapse it into 'contract' because the backend enum lacked it,
      // and when the MODEL passed the honest value instead, the backend bounced
      // the whole capture mid-call. Known values pass through untouched.
      map: (v) => (['contract', 'full_time', 'contract_to_hire'].includes(v) ? v : 'contract'),
    },
    // The field the pipeline used to LOSE (verified on prod call SCL_nRKo3KEVw8Yh,
    // 2026-07-30): the tree collected the role, the checklist showed ✓, and the
    // write had no param — the paragraph survived only in the transcript.
    { arg: 'role_description', from: ['role_description'] },
    { arg: 'rate_range', from: ['rate_range', 'salary_range'] },
    { arg: 'duration', from: ['contract_length', 'conversion_terms'] },
    {
      arg: 'location_type',
      from: ['work_mode'],
      map: (v) => (['onsite', 'remote', 'hybrid'].includes(v) ? v : undefined),
    },
    { arg: 'address', from: ['position_address'] },
    { arg: 'timezone', from: ['team_timezone'] },
  ],
  // The appointment's OWN words. 2026-08-13, SCL_KLvqZ2JkaQFU: meeting_topic
  // was recorded ("a position") at t=40.8s, the caller volunteered a location at
  // 0:42, and the booked appointment's description reads "Booking via
  // SecretaryHQ" — the RPC's fallback. Dale opens Aug 31 and sees a name, 15
  // minutes, and a template string. Both facts were in the tracker the whole
  // time; nothing carried them to the write.
  book_with_scheduling: [
    { arg: 'phone', from: ['caller_phone'] },
    // The tool asks for the CALLER'S OWN WORDS for what they want, and that is
    // exactly what `meeting_topic` holds — so requiring the model to retype it
    // was pure state theater, and an omission was fatal rather than cosmetic:
    // `service_type` is a REQUIRED param, so a model that forgets it (2026-08-15
    // sim: it sent `{"start_time":"…"}` and nothing else) cannot book at all.
    { arg: 'service_type', from: ['meeting_topic', 'message_body'] },
    // Same reasoning for the name — an appointment with no name on it is the
    // junk-"Caller"-row shape, and the checklist has known the name for minutes.
    { arg: 'name', from: [CALLER_NAME] },
    {
      arg: 'description',
      from: ['meeting_topic', 'meeting_context'],
      combine: (values) => {
        const [topic, context] = values;
        const parts: string[] = [];
        if (topic) parts.push(`About: ${topic}`);
        if (context) parts.push(context);
        return parts.length > 0 ? parts.join(' — ') : undefined;
      },
    },
  ],
  // take_message had NO backfill at all: every value came from the model
  // retyping it, which is the same state-theater exposure that lost
  // location_type and role_description on other tools — and it is what made a
  // CORRECTION re-fire arrive empty (found by the batch-D test, 2026-08-01).
  // The checklist holds all three facts; the write should read them from there.
  take_message: [
    { arg: 'caller_name', from: [CALLER_NAME] },
    { arg: 'callback_phone', from: [CALLER_PHONE] },
    { arg: 'message', from: ['message_body'] },
  ],
  // A case intake collects more fields than any other tree, which makes it the
  // most exposed to the state-theater bug that ate location_type and then
  // role_description: the caller answers, the checklist ticks, and the write
  // never hears it. Every collected node is wired here, and
  // captureCompleteness.test.ts fails CI if a future node is not.
  capture_case_inquiry: [
    { arg: 'caller_name', from: [CALLER_NAME] },
    { arg: 'callback_phone', from: [CALLER_PHONE] },
    { arg: 'matter_type', from: ['matter_type'] },
    { arg: 'incident_date', from: ['incident_date'] },
    { arg: 'incident_state', from: ['incident_state'] },
    {
      arg: 'has_existing_counsel',
      from: ['existing_counsel'],
      map: (v) => v === 'has_counsel',
    },
    { arg: 'counsel_situation', from: ['counsel_situation'] },
    { arg: 'opposing_parties', from: ['opposing_parties'] },
    // Whichever branch ran, the caller's own account is the narrative the
    // attorney reads. Combined rather than first-wins: an injury call fills
    // injury_circumstances and an insurance call fills matter_description, and
    // a caller who describes both should lose neither.
    {
      arg: 'matter_description',
      from: ['injury_circumstances', 'matter_description'],
      combine: (values) => {
        const joined = values.filter((v) => v && v.trim()).join('\n\n');
        return joined || undefined;
      },
    },
    { arg: 'insurer_name', from: ['insurer_name'] },
    { arg: 'policy_type', from: ['policy_type'] },
    { arg: 'claim_outcome', from: ['claim_outcome'] },
    { arg: 'stated_reason', from: ['stated_reason'] },
    { arg: 'amount_in_dispute', from: ['amount_in_dispute'] },
    { arg: 'appeal_status', from: ['appeal_status'] },
    { arg: 'injuries_sustained', from: ['injuries_sustained'] },
    { arg: 'medical_treatment', from: ['medical_treatment'] },
    { arg: 'at_fault_party', from: ['at_fault_party'] },
    { arg: 'gave_recorded_statement', from: ['gave_statement'] },
    { arg: 'lost_income', from: ['lost_income'] },
    { arg: 'police_report', from: ['police_report'] },
    { arg: 'deadline_pressure', from: ['deadline_pressure'] },
    { arg: 'documents_available', from: ['documents_available'] },
    { arg: 'desired_outcome', from: ['desired_outcome'] },
  ],
};

/** Subject trees whose co-selection with `booking` ANSWERS the meeting-topic
 *  question, and whose co-selection with `generic_subject` ANSWERS its
 *  subject_details question — the caller who asked to "talk to Dale about a
 *  job" has already said what the meeting/call is about. generic_subject
 *  itself is absent from this map: it is THE ELSE, so it has no canned topic
 *  of its own — only the trees below can supply one for it. */
const TREE_TOPIC: Record<string, string> = {
  job: 'a job opportunity',
  fix_computer: 'a computer repair',
};

/**
 * Does this meeting-topic utterance name a ROLE the owner would be paid for?
 *
 * 2026-08-14, sim-call-1786693849702: caller answered "What is the meeting
 * about?" with "This is about a job position". The model recorded
 * meeting_topic and booked 15 minutes. Zero job_inquiries row. Prompt text
 * on the node said "call set_purpose again" — it did not.
 *
 * Bare "job" / "a job" is a SERVICE request in this product ("I have a job
 * for you" = fix my computer). Do not match it. "position" / "role" /
 * "job position" are the role words.
 *
 * NO REAL NAME BELONGS IN HERE (2026-08-14). The hire/hiring branch first
 * shipped as `(him|her|them|<the owner's first name>|the owner)`, which
 * `tests/noHardcodedNames.test.ts` correctly rejected: this function runs for
 * EVERY tenant, so one business's owner name is dead weight in every other
 * business's call and would need editing the moment a second tenant exists.
 * There is no owner-name column on `tenants` to substitute either — only
 * `persona_name`, which names the ASSISTANT, not the person being hired. So
 * the branch matches pronouns and the role word only.
 *
 * Residual gap, stated rather than papered over: a caller who says exactly
 * "hiring <Name>" and nothing else is no longer matched here. Widening this to
 * "hire/hiring + any token" would swallow "hiring a plumber", which in this
 * product is a SERVICE request — the same confusion bare "job" is excluded
 * for. Those calls still reach the job tree through the role words above, or
 * through the model's own set_purpose.
 */
export function meetingTopicNamesOwnerRole(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (!t) return false;
  // PLURALS COUNT. 2026-08-15 sim (JAYA REPLAY — a scenario literally named
  // "talk with Dale about job opportunities"): the caller said "About the job
  // opportunities — he shared the resume", and this matcher looked only for the
  // SINGULAR "job opportunity". It missed, the job tree was never added, and a
  // recruiter's entire role intake was lost behind a 15-minute meeting. Plural
  // is the more natural phrasing of the two, and it was the one that failed.
  if (/\b(positions?|roles?|recruiters?|recruiting|staffing)\b/.test(t)) return true;
  if (/\bjobs?\s+(positions?|opportunit(?:y|ies)|offers?|openings?|inquir(?:y|ies))\b/.test(t)) {
    return true;
  }
  if (/\b(contract[- ]to[- ]hire|contract\s+role)\b/.test(t)) return true;
  if (/\bhir(?:e|ing)\s+(him|her|them|the owner)\b/.test(t)) return true;
  return false;
}

/**
 * Does the caller's own message say this is urgent? Found 2026-09-11 in
 * `sim-questiontree` URGENT CALLER (graded FAIL): the caller said "urgently"
 * in her opener and "It's really urgent" again, `record_answer("is_urgent")`
 * was refused (not a checklist node), and `take_message` fired WITHOUT
 * `is_urgent: true` — the agent then told her "I've saved your urgent
 * message", which was false. Migration 20260801020000 says the flag "is set
 * from the caller's own words," but only the MODEL was ever asked to do it —
 * a prompt request, not a guarantee. This is the host-code guarantee:
 * `buildActionArgs` runs it against the final message text and can only ever
 * RAISE `is_urgent` to true, matching the DB column's own raise-only
 * contract — a caller who never said an urgent word gets whatever the model
 * passed, untouched.
 */
export function messageSoundsUrgent(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (!t) return false;
  // A caller saying something is NOT urgent is giving the OPPOSITE signal —
  // "not urgent", "isn't an emergency", "nothing urgent", "not right away"
  // must never raise the flag (Copilot review, PR #414). Negation is scoped
  // to the CLAUSE it appears in (split on punctuation and "but"), not the
  // whole message, so dismissing one word never suppresses a genuine signal
  // in the next clause ("it's not urgent, but please call me back ASAP").
  const negation = /\b(?:not|isn't|is not|no|nothing|never)\b/;
  const keyword =
    /\burgent(?:ly)?\b|\bemergenc(?:y|ies)\b|\bas soon as possible\b|\basap\b|\bright away\b/g;
  for (const clause of t.split(/[,.;!?]|\bbut\b/)) {
    let m: RegExpExecArray | null;
    keyword.lastIndex = 0;
    while ((m = keyword.exec(clause))) {
      if (!negation.test(clause.slice(0, m.index))) return true;
    }
  }
  return false;
}

/** How many times set_purpose may fire before the call is told to wrap up. */
const DEFAULT_MAX_PURPOSE_ROUNDS = 5;

/** After this many consecutive failures an action is told to stop retrying. */
const ACTION_FAILURE_LIMIT = 2;

/**
 * After this many consecutive REFUSALS the unconfirmed-booking guard stands
 * down and lets the write through.
 *
 * A refusal is not a failure — it returns before the real tool runs — so it
 * never touched `failCounts`, and `slotsAwaitingChoice` was cleared in exactly
 * ONE place: a successful booking. A booking the guard itself refuses therefore
 * could not clear the condition that refuses it, and the goodbye gate will not
 * let the call end while the booking node is unresolved. Measured 2026-08-15 on
 * the `sim-questiontree` DALE'S CALL scenario: 12 refused bookings, 4 refused
 * finish_calls, the caller said goodbye twice, and the run ended only because
 * the harness caps at 48 rounds. A phone line has no such cap.
 *
 * Two refusals is the whole value of the guard: it stops the FIRST blind write,
 * which is the one that would have booked a time nobody chose. Refusing forever
 * does not buy a better booking — it trades a possibly-wrong time for a
 * certainly-dead call.
 */
const BOOKING_GUARD_REFUSAL_LIMIT = 2;

/**
 * After this many consecutive refusals the goodbye gate releases the call.
 *
 * The gate is the structural guarantee that a stated goal cannot be forgotten,
 * and it stays exactly that for the first few attempts. But a caller who has
 * said goodbye and is being answered with "one moment, I'm still finalizing"
 * has already lost the thing the gate protects; holding the line adds nothing
 * but tokens and a worse hang-up. The release is logged at WARN with the unmet
 * nodes so it can never pass for a normal close.
 */
const FINISH_REFUSAL_LIMIT = 5;

/** Params `book_with_scheduling` cannot run without, in the tool's own names. */
const BOOKING_REQUIRED_ARGS = ['service_type', 'window_from', 'window_to', 'phone'] as const;

/**
 * Trees that can be served without knowing who called.
 *
 * Everything else produces a RECORD someone has to act on later — a message, a
 * booking, a lead — and a record with no way to reach the caller is a record
 * nobody can use. Selecting `identity` alongside them was a prompt rule
 * ("include identity whenever a goal needs a contact") until 2026-08-15, when
 * the `sim-questiontree` WEDDING MESSAGE scenario selected `message +
 * generic_subject` without it: the caller said "I'd love for him to call me
 * back", the message was taken, the call closed, and **no number was ever
 * asked for**. The scenario PASSED — no grader asserts a callback number.
 *
 * `qa` is the deliberate exception in the other direction: someone asking what
 * time you close must not be interrogated for their phone number to get an
 * answer.
 */
const CONTACTLESS_TREES = new Set(['qa']);

/** Nodes that name a BUSINESS — never a person. See the guard in record_answer. */
const COMPANY_NODES = new Set(['callers_company', 'client_company']);

/**
 * "Do you want a meeting?" nodes, and the answer a BOOKING ATTEMPT gives them.
 *
 * Every tree that ends in a booking has one of these, and each is answered by
 * an ACTION rather than an utterance — which is why they kept being left open
 * and then asked, insultingly, of someone already booked. Keyed by node id so
 * the next vertical's version is one line, not another postmortem.
 */
const BOOKING_CLOSES_OFFER: Record<string, string> = {
  meeting_offer: 'wants_meeting',
  demo_offer: 'wants_demo',
};

/**
 * Words that sit exactly on the buy-vs-job axis and resolve to neither.
 *
 * Deliberately tiny. "Opportunity" is the word that produced the confusion in
 * both directions (2026-07-28 sim, 2026-08-15 sim); "partnership" and "work
 * together" are its neighbours. Anything more would fire on ordinary messages,
 * and a nudge that fires on everything is noise the model learns to skip.
 */
const AMBIGUOUS_OPPORTUNITY =
  /\b(business\s+opportunit(?:y|ies)|opportunit(?:y|ies)\s+for\s+(?:your|the)\s+business|partnership|work\s+together)\b/i;

/** Action tools whose required `appointment_id` the host fills when unambiguous. */
const APPOINTMENT_ID_TOOLS = new Set(['cancel_appointment', 'reschedule_appointment']);

/** Result fields a caller's own appointment list can arrive under. */
const APPOINTMENT_LIST_FIELDS = ['appointments', 'upcoming', 'results'] as const;

/**
 * The ONE appointment id in a lookup result, or null when there is any doubt.
 *
 * Null for zero (nothing to act on) and null for two or more (the caller must
 * say which — the host guessing there is how you cancel the wrong booking).
 */
export function soleAppointmentIdIn(raw: unknown): string | null {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const bag = parsed as Record<string, unknown>;
  const source = (bag.result ?? bag) as Record<string, unknown>;
  for (const field of APPOINTMENT_LIST_FIELDS) {
    const list = source[field];
    if (!Array.isArray(list) || list.length !== 1) continue;
    const only = list[0] as Record<string, unknown> | null;
    const id = only?.['appointment_id'];
    if (typeof id === 'string' && id.trim()) return id;
  }
  return null;
}

/**
 * Result fields a slot reader uses to hand the model a list of open times.
 * Counting them is how the host knows an OFFER is outstanding.
 */
const OFFERED_SLOT_FIELDS = ['open_times', 'slots', 'available_times', 'times'] as const;

/**
 * The distinctive opening of the backend's RAG no-answer line, verbatim from
 * `policyFallback` in `src/routes/agentTools/knowledge.ts`.
 *
 * PINNED ON BOTH SIDES. `tests/routes/agentTools/policyFallbackContract.test.ts`
 * asserts the route still returns exactly this, so a reword there is a red CI
 * rather than a guarantee that silently stops firing. Matching prose is not
 * lovely; the alternative was changing the route's result shape, which the
 * ladder path and several tests also read.
 */
export const RAG_NO_ANSWER_MARKER = "I don't have specific information on that topic";

/** True when the knowledge base returned its no-answer fallback. */
export function ragCouldNotAnswer(text: string): boolean {
  return text.includes(RAG_NO_ANSWER_MARKER);
}

/** A present, non-blank string argument — anything else counts as omitted. */
function toNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** Args that name ONE instant, i.e. a time the caller actually chose. */
function namesOneInstant(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false;
  const a = args as Record<string, unknown>;
  if (typeof a.requested_start === 'string' && a.requested_start.trim()) return true;
  // The successful CALL2 attempt used a zero-width window instead — same claim,
  // different spelling, and refusing it would block a booking that IS confirmed.
  return (
    typeof a.window_from === 'string' &&
    typeof a.window_to === 'string' &&
    a.window_from.trim() !== '' &&
    a.window_from === a.window_to
  );
}

/**
 * Placeholders a model reaches for when it has no name — the generic noun for
 * the person on the line, not anything they said. Matched whole, after
 * stripping a leading article, so a real "Caller" surname is still impossible
 * to distinguish and is deliberately treated as a placeholder: the cost of
 * re-asking a genuine Mr. Caller is one polite question; the cost of accepting
 * the placeholder is a permanent junk row that reads as a real customer.
 */
const PLACEHOLDER_NAMES = new Set([
  'caller',
  'customer',
  'client',
  'unknown',
  'anonymous',
  'user',
  'guest',
  'you',
  'yourself',
  'n/a',
  'na',
  'none',
  'no name',
  'not given',
  'not provided',
  'unnamed',
]);

/** Why a recorded caller name is unusable — or null when it is a real name. */
export function placeholderNameReason(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^(the|a)\s+/, '')
    .replace(/[.,!?]+$/, '');
  if (!PLACEHOLDER_NAMES.has(cleaned)) return null;
  return (
    `"${raw.trim()}" is not a name — it is the generic word for the person on the line, and ` +
    `saving it puts a row called "${raw.trim()}" in the owner's phone book. NOT recorded. If ` +
    `they have said their name, record THAT; if they have not, ask ("Who am I speaking with?"). ` +
    `If they refuse to give one, record caller_name as declined instead of inventing a filler.`
  );
}

/**
 * A "topic" that names only WHO the caller wants, never WHAT about.
 *
 * The `meeting_topic` node's own text has said *"WHO is not WHAT: 'I want to
 * talk with [the owner]' names a person and carries NO topic — never record it
 * here"* since the 2026-07-27 postmortem, with the live call attached. It is
 * still prompt text, and on the 2026-08-15 sim it was violated on roughly half
 * of the JAYA REPLAY runs: "I want to talk with Dale" was recorded verbatim as
 * the topic, so the topic never named a role, `meetingTopicNamesOwnerRole()`
 * never fired, the job tree was never added — and a recruiter's call produced a
 * fifteen-minute meeting the owner opens with no idea what it is about.
 *
 * Matched on SHAPE, not on a roster: the whole value is a verb of meeting plus
 * a person, with no "about". That is decidable without knowing any names, and
 * it is what makes it safe — "talk about the contract" keeps its "about" and
 * passes, "speak with someone" is just as topicless as "talk with Dale".
 */
export function topicNamesOnlyAPerson(raw: string): boolean {
  const t = raw
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '');
  if (/\babout\b|\bregarding\b|\bre:/.test(t)) return false;
  return /^(?:to\s+|just\s+)*(?:talk|speak|meet|chat|connect)(?:ing|s)?(?:\s+(?:to|with))?\s+[\w'-]+(?:\s+[\w'-]+)?$/.test(
    t
  );
}

/** Digits in a dictated value, ignoring spaces, dashes, parens and words. */
export function countPhoneDigits(raw: string): number {
  return raw.replace(/\D/g, '').length;
}

/**
 * Why a dictated number cannot be used — or null when it can.
 *
 * The return value IS what the model reads: the tool result is the one channel
 * it reliably acts on, so the reason and the instruction travel together.
 *
 * US line, so a usable number is ten digits (or eleven with a leading 1). This
 * is deliberately the same rule `identify_caller` and the booking gate enforce
 * server-side — the point of checking here is that the caller is still ON THE
 * LINE and can simply say it again, whereas the server's rejection lands
 * whenever a write happens to be attempted, which on 2026-08-15 was half a
 * minute later and in the middle of a different question.
 */
export function unusablePhoneReason(raw: string): string | null {
  const digits = countPhoneDigits(raw);
  if (digits === 10) return null;
  if (digits === 11 && raw.replace(/\D/g, '').startsWith('1')) return null;
  const heard =
    digits === 0
      ? 'no digits at all'
      : `only ${digits} digit${digits === 1 ? '' : 's'} — a usable number has 10`;
  return (
    `NOT RECORDED: that number is not dialable — I heard ${heard}. ` +
    `Say you did not catch the whole number and ask them to say it again, ` +
    `slowly, one digit at a time. Do not read back or confirm what you have; ` +
    `it is incomplete. Do not move on to another question, and do not attempt ` +
    `to book — the booking will be refused for the same reason.`
  );
}

/** How many open times a slot reader just put in front of the caller. */
export function countOfferedSlots(raw: unknown): number {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return 0;
    }
  }
  if (!parsed || typeof parsed !== 'object') return 0;
  const obj = parsed as Record<string, unknown>;
  const nested = obj.result;
  const source = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : obj;
  for (const field of OFFERED_SLOT_FIELDS) {
    const value = source[field];
    if (Array.isArray(value)) return value.length;
  }
  return 0;
}

/** The uniform way to reach a real tool's internals (rung.ts precedent). */
interface RealToolShape {
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown, toolCtx: unknown) => Promise<unknown>;
}
const shape = (t: ToolMap[string]): RealToolShape => t as unknown as RealToolShape;

export interface ChecklistToolDeps {
  tracker: ChecklistTracker;
  library: QuestionTreeDef[];
  /** Tree ids this tenant is allowed to select right now. Defaults to all library tree ids. */
  selectableTreeIds?: string[];
  /** The full ToolContext from buildTools() — real tools, untouched. */
  realTools: ToolMap;
  /** Carrier-attested caller number (null on forwarded lines) — auto-fills the
   *  caller_phone node on selection so the question never exists on that call. */
  callerPhone?: string | null;
  /** Name of an already-recognized returning caller (null when unknown) —
   *  auto-fills the caller_name node for the same reason callerPhone does. */
  knownCallerName?: string | null;
  maxPurposeRounds?: number;
  /** The agent reschedules its toolset (macrotask-deferred updateTools). */
  onSelectionChanged: () => void;
  /** Speak the fixed goodbye and close the session. */
  closeCall: (goodbye: string) => Promise<void>;
}

export interface ChecklistToolkit {
  /** Base + wrapped actions + read passthroughs for the CURRENT selection. */
  selectedTools: () => ToolMap;
}

interface ActionSite {
  treeId: string;
  def: ActionNodeDef;
}

/** Every action node in the library, found once, wherever it nests. */
function collectActions(library: QuestionTreeDef[]): Map<string, ActionSite> {
  const out = new Map<string, ActionSite>();
  const walk = (nodes: QuestionTreeDef['nodes'], treeId: string): void => {
    for (const def of nodes) {
      if (def.type === 'action' && !out.has(def.node_id)) out.set(def.node_id, { treeId, def });
      if (def.type === 'choice') {
        for (const children of Object.values(def.options)) walk(children, treeId);
      }
    }
  };
  for (const tree of library) walk(tree.nodes, tree.tree_id);
  return out;
}

/** Pull the success id out of a real tool's JSON-string result, or null. */
function extractSuccessId(raw: unknown, idField: string): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const id = (parsed as Record<string, unknown>)[idField];
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export function createChecklistTools(deps: ChecklistToolDeps): ChecklistToolkit {
  const { tracker, realTools } = deps;
  const maxRounds = deps.maxPurposeRounds ?? DEFAULT_MAX_PURPOSE_ROUNDS;
  const actionSites = collectActions(deps.library);
  const treeIds = deps.selectableTreeIds ?? deps.library.map((t) => t.tree_id);
  const selectableTreeSet = new Set(treeIds);
  // Every tree the PLATFORM ships, regardless of this tenant's preset. The gap
  // between this and selectableTreeSet is a configuration decision, and telling
  // the two apart is the whole point — see the refusal branch in runSetPurpose.
  const libraryTreeSet = new Set(deps.library.map((t) => t.tree_id));

  let purposeRounds = 0;
  /**
   * SLOTS OFFERED BUT NOT YET CHOSEN — the unconfirmed-booking guard.
   *
   * 2026-08-13, SCL_KLvqZ2JkaQFU: get_available_slots returned Monday 1:00 /
   * 1:15 / 1:30 at t=41.6s, the agent read all three aloud and asked which
   * worked — and at t=43.5s, 1.9 seconds later and 30 seconds before the caller
   * said another word, it called book_with_scheduling with a five-day window and
   * no requested_start. The tool books the EARLIEST slot at or after
   * window_from, so it was one parse away from booking her into 1:00 PM while
   * she was still listening to the question. What saved it was a typo: the model
   * wrote `2026-08-17T01:00:00` — 1 AM — for the 1 PM slot it had just offered.
   *
   * A write the caller never agreed to is the worst failure available on this
   * path, and nothing but luck prevented it. So the host holds the offer open
   * until an arg names ONE instant. This is not a prompt rule for the same
   * reason the work-direction gate is not: the model already had one.
   */
  let slotsAwaitingChoice = 0;
  // What identify_caller was last told, so a CORRECTION can be re-sent. It used
  // to be a plain "sent once" latch, which meant the first (name, phone) pair
  // the call produced was the only one the phone book ever heard: "Jamil" was
  // saved, "Camille" was recorded in the tracker, and the CRM kept Jamil
  // (CALL_IMPROVEMENTS.md #2).
  let identifiedAs: { name: string; phone: string } | null = null;
  let closing = false;
  const failCounts = new Map<string, number>();
  // Refusals are counted separately from failures: a refusal returns BEFORE the
  // real tool runs, so it can never reach `failCounts` and never trips
  // ACTION_FAILURE_LIMIT. Both counters exist to bound a loop the model cannot
  // get itself out of.
  let bookingGuardRefusals = 0;
  let finishRefusals = 0;
  // Set once book_with_scheduling is attempted this call. BOOKING_CLOSES_OFFER
  // is applied at that moment too, but recordIfOpen is a no-op against a node
  // that is not yet 'open'/'latent' — e.g. meeting_offer sits at the END of the
  // job tree, so when a caller opens with both booking AND job intent in one
  // breath, booking lands first and meeting_offer is still gated behind
  // employment_type/work_mode/etc. The one-shot close silently missed it, and
  // the model asked "would you like a meeting?" of someone already booked
  // (live call 2026-08-16, sim-call-1786921082547). Retrying on every
  // record_answer call until the node opens makes the close self-healing
  // instead of a single point-in-time guess.
  let bookingMadeThisCall = false;
  // The caller's own appointment id, when the lookup found exactly one. See
  // soleAppointmentIdIn — this is what keeps a UUID out of the model's mouth.
  let soleAppointmentId: string | null = null;

  // Every state block ends with an explicit NEXT pointer — the first frontier
  // item in walk order. Without it the model treats a ready [ACTION NOW] as
  // scenery and keeps asking questions: on the E2E replay of the 2026-07-21
  // call it ran the entire job intake past a ready book action (the exact
  // "you just blew right past that" failure the walk order exists to prevent).
  // The walk order is host truth; this line makes it an instruction, not a hint.
  const stateBlock = (): string => {
    const next = tracker.frontier()[0];
    const pointer = !next
      ? ''
      : next.kind === 'action'
        ? `\nNEXT: ${next.node_id} — an ACTION, not a question. Do it now, before asking anything else. Do NOT ask another question until this action is handled or explicitly blocked.`
        : `\nNEXT: ask ${next.node_id}. This is the ONLY question you may ask next.`;
    return `CHECKLIST STATE:\n${tracker.renderState()}${pointer}`;
  };

  const repeatGuardDirective = (resolvedNodeId: string): string => {
    const next = tracker.frontier()[0];
    const noRepeat = `\n\n${resolvedNodeId} is already resolved. Do NOT ask ${resolvedNodeId} again.`;
    if (!next) return noRepeat;
    return next.kind === 'action'
      ? `${noRepeat} ${next.node_id} is an ACTION now — do that before asking anything else.`
      : `${noRepeat} The ONLY question you may ask next is ${next.node_id}.`;
  };

  /** Host-code phone-book save the moment both identity facts are in — never
   *  the model's job, never skipped when the caller only leaves a message. */
  const maybeIdentify = (): void => {
    const name = tracker.value(CALLER_NAME);
    const phone = tracker.value(CALLER_PHONE);
    const identify = realTools['identify_caller'];
    if (!name || !phone || !identify) return;
    // Unchanged since the last send → nothing to do. CHANGED → send again: the
    // caller corrected something, and the phone book must hear the correction.
    if (identifiedAs && identifiedAs.name === name && identifiedAs.phone === phone) return;
    const isCorrection = identifiedAs !== null;
    identifiedAs = { name, phone };
    void shape(identify)
      .execute(
        {
          name,
          phone,
          // Scoped on purpose: this permits overwriting a name THIS CALL wrote.
          // It is never a licence to rename an established customer from a
          // later call — anyone can dial a number and claim a name, and that
          // is the claim-based trust the OTP call-binding exists to destroy.
          ...(isCorrection ? { is_correction: true } : {}),
        },
        undefined
      )
      .catch((err: unknown) => {
        getLogger().warn(
          { event: 'checklist_identify_failed', is_correction: isCorrection, err: String(err) },
          'host-code identify_caller failed — caller not saved to phone book'
        );
      });
  };

  const recordIfOpen = (nodeId: string, value: string | undefined): void => {
    if (!value) return;
    const status = tracker.status(nodeId);
    if (status !== 'open' && status !== 'latent') return;
    try {
      tracker.record(nodeId, { value });
    } catch {
      /* volunteered extras never break a selection */
    }
  };

  const set_purpose = llm.tool({
    description:
      'Set (or extend) what this call is about. Call the MOMENT you know why they called, ' +
      'and again any time a NEW goal surfaces. Pass every tree that matches; pass ' +
      'wrong_trees to remove a tree selected by mistake. If the caller already volunteered ' +
      'their name or number, pass those along exactly as spoken.',
    parameters: {
      type: 'object',
      properties: {
        work_direction: {
          type: 'string',
          enum: ['caller_pays_us', 'caller_offers_owner_work', 'neither_or_unclear'],
          description:
            'WHICH WAY THE WORK FLOWS — answer this BEFORE picking trees. caller_pays_us: ' +
            'they want to BUY something from this business (the AI service, a repair, a ' +
            'visit). caller_offers_owner_work: they bring a job, role, position, contract, ' +
            'or project the OWNER would be paid for. neither_or_unclear: a message, a question, a ' +
            'schedule change — or you genuinely cannot tell yet.',
        },
        trees: {
          type: 'array',
          items: { type: 'string', enum: treeIds },
          description: 'The tree ids matching what the caller wants (see the menu).',
        },
        wrong_trees: {
          type: 'array',
          items: { type: 'string', enum: treeIds },
          description: 'Trees selected earlier by MISTAKE — removed, their questions dropped.',
        },
        caller_name: {
          type: 'string',
          description: 'ONLY if the caller stated their own name this call — exactly as said.',
        },
        caller_phone: {
          type: 'string',
          description: 'ONLY if the caller spoke a number for themselves — digits as said.',
        },
      },
      required: ['work_direction', 'trees'],
    },
    execute: (args: {
      work_direction?: string;
      trees: string[];
      wrong_trees?: string[];
      caller_name?: string;
      caller_phone?: string;
    }): Promise<string> => Promise.resolve(runSetPurpose(args)),
  });

  function runSetPurpose(args: {
    work_direction?: string;
    trees: string[];
    wrong_trees?: string[];
    caller_name?: string;
    caller_phone?: string;
  }): string {
    // `trees` is "required" only in a plain JSON schema, and LiveKit validates
    // Zod schemas alone — so a model that omits it reaches this function anyway
    // (2026-09-11 sim JOB-DIRECT: `.includes` on undefined threw, the model got
    // an opaque tool error, and the purpose was never set). A wrong_trees-only
    // call is a legitimate removal; neither field is a refusal that names the fix.
    const { trees: requestedTrees, wrong_trees: wrongTrees } = args;
    const trees = Array.isArray(requestedTrees) ? requestedTrees : [];
    if (trees.length === 0 && !(Array.isArray(wrongTrees) && wrongTrees.length > 0)) {
      return (
        'NOT SET: set_purpose needs `trees` — the tree ids from the menu that match what ' +
        'the caller wants. Call it again with them.'
      );
    }
    {
      // THE WORK-DIRECTION GATE (2026-07-28 sim: a buyer opening with "a business
      // opportunity" got the JOB tree alongside buy_service, whose blocked capture
      // held the goodbye gate open — the agent repeated one sentence nine times on
      // a call that could not end). buy_service and job are the one confusable
      // pair with EVIDENCE of confusion, and they sit on opposite ends of a single
      // axis: who pays whom. Making the model DECLARE the axis, then checking the
      // declaration against the selection IN HOST CODE, turns a prompt hope into a
      // deterministic bounce. Every refusal names the satisfiable next step.
      // Deliberately narrow — only the pair that actually failed; a full
      // intent-tree compatibility matrix is speculation until a call pays for it.
      const dir = args.work_direction;
      const picksJob = trees.includes('job');
      const picksBuy = trees.includes('buy_service');
      // Contract-driven, not pair-driven: any two blocks that declare each
      // other in `conflicts_with` bounce here. `blockContract.test.ts` enforces
      // that the declaration is symmetric, so it does not matter which of the
      // two the model listed first.
      const clash = conflictingTreePair(trees);
      if (clash) return conflictRefusal(clash[0], clash[1]);
      if (dir === 'caller_pays_us' && picksJob) {
        return (
          'REFUSED: you said the caller is PAYING US, but selected the job tree — that ' +
          'tree is for work the OWNER gets paid for. If they want to buy the AI service, ' +
          'select buy_service; if you are unsure which way the work flows, ask them first.'
        );
      }
      if (dir === 'caller_offers_owner_work' && picksBuy) {
        return (
          'REFUSED: you said the caller is OFFERING THE OWNER WORK, but selected ' +
          'buy_service — that tree is for callers buying the AI receptionist for their own ' +
          'business. If they have a role or contract for the owner, select job; if you are ' +
          'unsure, ask them first.'
        );
      }
      if (dir === 'neither_or_unclear' && (picksJob || picksBuy)) {
        return (
          'REFUSED: you marked the work direction UNCLEAR but selected ' +
          (picksJob ? 'job' : 'buy_service') +
          ' — the two trees on that axis look alike from a vague opener, and a wrong pick ' +
          'interrogates the caller down the wrong track. Ask ONE clarifying question ' +
          '("Are you looking to hire him, or interested in the AI receptionist for your ' +
          'own business?") and select once they answer. Other trees (message, qa, booking, ' +
          'schedule_change) may be selected now.'
        );
      }
      purposeRounds += 1;
      if (purposeRounds > maxRounds) {
        return (
          'The purpose has changed enough times this call. Do NOT select again — finish ' +
          `what is open, then finish_call. ${stateBlock()}`
        );
      }
      for (const id of args.wrong_trees ?? []) tracker.deselect(id);
      const unavailable = trees.filter((id) => !selectableTreeSet.has(id));
      if (unavailable.length > 0) {
        const blocked = unavailable[0];
        // TWO DIFFERENT FAILURES WORE THE SAME SENTENCE (2026-08-13,
        // SCL_3a8SkDKzxN4B). `No tree called "job"` was returned for a tree that
        // very much exists — the model had read the caller correctly, declared
        // work_direction 'caller_offers_owner_work', and re-issued set_purpose to
        // add `job` 16ms after taking the message. `job` was simply not enabled
        // on that tenant's preset, and no override could enable it. The refusal
        // went back as an ordinary tool result nobody logged, capture_job_inquiry
        // never entered the toolset, and the call closed with zero job_inquiries
        // rows. A correct model request denied by CONFIGURATION must not look
        // like a model typo, and must not be silent.
        if (libraryTreeSet.has(blocked)) {
          getLogger().warn(
            {
              event: 'checklist_tree_not_enabled',
              tree_id: blocked,
              requested: trees,
              enabled: treeIds,
            },
            `set_purpose asked for the "${blocked}" tree, which exists but is not enabled for this business`
          );
          // Tell the model the truth: the tree is real, this business does not
          // run it, and here is the lane that still serves the caller. The old
          // wording invited it to re-pick a name, which is not the problem.
          return (
            `The "${blocked}" intake is not enabled for this business, so its questions are ` +
            `not available on this call. Do NOT ask for it again. Serve the caller through ` +
            `what IS enabled — take a COMPLETE message in their own words covering what ` +
            `they wanted, so nothing is lost. Enabled: ${treeIds.join(', ')}.`
          );
        }
        getLogger().warn(
          { event: 'checklist_tree_unknown', tree_id: blocked, enabled: treeIds },
          `set_purpose asked for "${blocked}", which is not a tree in the platform library`
        );
        return `No tree called "${blocked}". Available: ${treeIds.join(', ')}.`;
      }
      try {
        tracker.select(trees);
      } catch (err) {
        if (err instanceof UnknownTreeError) return err.message;
        throw err;
      }
      // See CONTACTLESS_TREES — a goal-bearing call gets identity whether the
      // model remembered to ask for it or not. Host code, because the prompt
      // rule alone lost a callback number on a message that asked for a callback.
      const selected = tracker.selectedTrees();
      if (
        !selected.includes('identity') &&
        selectableTreeSet.has('identity') &&
        selected.some((id) => !CONTACTLESS_TREES.has(id))
      ) {
        tracker.select(['identity']);
        getLogger().info(
          { event: 'checklist_identity_auto_selected', requested: trees },
          'identity added by the host — a goal-bearing call needs a way to reach the caller'
        );
      }
      // Same placeholder guard as record_answer — this is the door "caller"
      // actually came through on the 2026-08-15 sim, in set_purpose's own
      // caller_name arg, before a single question had been asked.
      const volunteeredName = sanitizeVolunteered(args.caller_name, 80);
      recordIfOpen(
        CALLER_NAME,
        volunteeredName && placeholderNameReason(volunteeredName) ? undefined : volunteeredName
      );
      recordIfOpen(CALLER_PHONE, sanitizeVolunteered(args.caller_phone, 30));
      // The subject tree IS the meeting topic (2026-07-21, the third re-ask on a
      // live call): when booking rides along with a known-subject tree, the
      // caller already said what the meeting is about — asking "What is the
      // meeting about, in your own words?" after "talk to Dale about a job"
      // tells them nobody listened. Host-recorded because the prompt-tier rule
      // failed three calls running (the promotion ladder).
      if (tracker.selectedTrees().includes('booking')) {
        for (const [treeId, topic] of Object.entries(TREE_TOPIC)) {
          if (tracker.selectedTrees().includes(treeId)) recordIfOpen('meeting_topic', topic);
        }
      }
      // generic_subject is THE ELSE — "a topic no specific tree covers." A
      // TREE_TOPIC tree selected alongside it is proof the topic was NOT the
      // else case: the caller already said what the call concerns (a job, a
      // repair), so generic_subject's one question ("what does this concern?")
      // is asking for the second time what job/fix_computer already answered.
      // Live test call, 2026-08-19: model picked job + generic_subject
      // together and asked the caller what the call was about after the job
      // intake had already recorded it. Same backfill shape as meeting_topic
      // above, not a selection guard — generic_subject alone (no topic-tree
      // riding along) still needs the caller's own words, unchanged.
      if (tracker.selectedTrees().includes('generic_subject')) {
        for (const [treeId, topic] of Object.entries(TREE_TOPIC)) {
          if (tracker.selectedTrees().includes(treeId)) recordIfOpen('subject_details', topic);
        }
      }
      // Caller-ID seeding: on an attested line the phone question never exists.
      let callerIdNote = '';
      if (deps.callerPhone && tracker.status(CALLER_PHONE) === 'open') {
        tracker.record(CALLER_PHONE, { value: deps.callerPhone });
        callerIdNote =
          " The caller's number is on file from caller ID — never ask for it and never " +
          'recite it back at them. ';
      }
      // Known-caller seeding, same principle: we already looked her up. Runs
      // AFTER the model's own caller_name arg (recordIfOpen above), so a name
      // the caller actually spoke this call still wins — she may be calling on
      // someone else's behalf, or correcting what we have on file.
      const knownName = sanitizeVolunteered(deps.knownCallerName ?? undefined, 80);
      if (knownName && tracker.status(CALLER_NAME) === 'open') {
        tracker.record(CALLER_NAME, { value: knownName });
        callerIdNote +=
          ` This is a returning caller: their name is ${knownName} and it is already on the ` +
          'checklist. Do NOT ask who is calling — greet them by first name. ';
      }
      maybeIdentify();
      deps.onSelectionChanged();
      // THE UNDER-SELECTION NUDGE (2026-07-27 live call, 17:57 UTC): the caller
      // said "talk with Jane about the job opportunities, he shared the resume" —
      // the model selected booking ONLY, booked 1:00, asked zero role questions,
      // and closed. The meeting landed; the role details never did. The gate
      // above blocks CONTRADICTIONS; this covers the OMISSION: direction says
      // the owner is being offered paid work, but no job tree is selected. A
      // NUDGE, not a refusal — a recruiter returning the owner's call about an
      // existing arrangement legitimately selects message without job — carried
      // in the tool result, the one channel the model reliably re-reads.
      //
      // Two shapes, because "ADD job" is unfollowable advice on a tenant that
      // does not run the job tree — and that is not hypothetical. On 2026-08-13
      // (SCL_3a8SkDKzxN4B) the model took this nudge, called set_purpose again
      // to add `job`, and was told `No tree called "job"` because every preset
      // forbade it. Advice the model cannot act on is worse than none: it burns
      // a purpose round and leaves the caller served by a fragment. When the
      // tree is genuinely unavailable, the honest instruction is to put the role
      // details in the MESSAGE, since that is the only place they can land.
      const jobNudge =
        dir === 'caller_offers_owner_work' && !tracker.selectedTrees().includes('job')
          ? selectableTreeSet.has('job')
            ? '\n\nNOTE: you declared the caller is OFFERING THE OWNER WORK, but the job ' +
              'tree is not selected — so nothing on this checklist will collect the role. ' +
              'If there is a role, position, or contract to record, call set_purpose again ' +
              'and ADD job: the role questions are what actually reaches the owner. Skip ' +
              'this only if they are not describing a role (e.g. returning his call about ' +
              'an existing arrangement).'
            : '\n\nNOTE: you declared the caller is OFFERING THE OWNER WORK, and this ' +
              'business does not run a job intake — there is no role questionnaire to add, ' +
              'so do NOT try to select one. The MESSAGE has to carry it instead: record what ' +
              "the work is, who it is with, and how to reach them, in the caller's own " +
              'words. A message that says only "it\'s for programming" tells the owner nothing.'
          : '';
      // A number VOLUNTEERED through this door still needs its read-back — only
      // if it actually landed as this node's value (not blocked by caller ID).
      const volunteered = sanitizeVolunteered(args.caller_phone, 30);
      const dictated =
        volunteered && tracker.value(CALLER_PHONE) === volunteered ? volunteered : undefined;
      return `Purpose set: ${tracker.selectedTrees().join(' + ')}.${callerIdNote}\n${stateBlock()}${jobNudge}${readbackDirective(dictated)}`;
    }
  }

  // A dictated value that IS a ten-digit US phone number → the exact spoken
  // read-back string ("2 6 2, 4 9 7, 9 0 3 9"): digits spaced individually,
  // 3-3-4 groups, leading 1 dropped. Anything else (prices, partial numbers,
  // words) returns null and gets no directive.
  function phoneReadback(raw: string): string | null {
    const digits = raw.replace(/\D/g, '');
    const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    if (ten.length !== 10) return null;
    const spaced = (s: string) => s.split('').join(' ');
    return `${spaced(ten.slice(0, 3))}, ${spaced(ten.slice(3, 6))}, ${spaced(ten.slice(6))}`;
  }

  // The read-back directive for a DICTATED number — appended to whichever tool
  // result recorded it. A dictated number has TWO doors into the tracker
  // (record_answer, and set_purpose's volunteered caller_phone); the 2026-07-21
  // eval caught the read-back silently skipped whenever the caller volunteered
  // the number in their opener, because only one door carried the directive.
  // Imperative with a narrow skip clause: fully conditional phrasing let the
  // model skip the read-back on 2 of 3 runs; fully unconditional produced a
  // double when it had pre-read. The pre-read is forbidden at the node, so this
  // is the read-back's ONE source. Caller-ID numbers never pass through either
  // door and are never read back.
  /**
   * Numbers whose read-back directive has already been issued.
   *
   * WHY THE HOST OWNS THIS NOW (2026-08-15, sim call 1786783128149). The
   * directive used to end with "only if you ALREADY read this exact number back
   * and heard their yes, do not repeat it" — a rule the MODEL had to remember
   * across turns. It did not. The number was re-recorded mid-intake, the
   * directive fired a second time, and the caller heard the identical read-back
   * twice:
   *
   *   1:16  "I heard six zero eight, two one seven, eight eight three five. Is
   *          that right? And which company are you calling from?"
   *   1:23  Caller: "You didn't let me confirm."
   *   1:36  "...I heard six zero eight, two one seven, eight eight three five.
   *          Is that right? Are you hiring for your own company...?"
   *   1:44  Caller: "You already confirmed my phone number. You didn't have to
   *          do it again."
   *
   * The caller complained twice in twenty seconds. This is the goodbye gate's
   * lesson in miniature: anything the call must not do belongs in the host, not
   * in a sentence addressed to the model.
   *
   * Keyed by the READ-BACK STRING, not the raw input, so "6082178835" and
   * "(608) 217-8835" are correctly recognised as the same number — and a
   * genuine CORRECTION produces a different string and is read back once, which
   * is the behaviour the caller actually wants.
   */
  const readbacksIssued = new Set<string>();

  function readbackDirective(value: string | undefined): string {
    const readback = value ? phoneReadback(value) : null;
    if (!readback) return '';
    // Already spoken for this number — say nothing rather than ask again. A
    // second directive is not a harmless nudge: the model treats it as an
    // instruction and repeats a question the caller has already answered.
    if (readbacksIssued.has(readback)) return '';
    readbacksIssued.add(readback);
    return (
      `\n\nREAD THE NUMBER BACK NOW, digit by digit, AS YOUR WHOLE TURN — say ` +
      `exactly: "${readback}" — then STOP and wait for their yes. Do not add ` +
      `another question to this turn: bundling the read-back with the next ` +
      `question leaves the caller no room to confirm, and they will answer the ` +
      `question instead. If they correct the number, record_answer again with ` +
      `the corrected one.`
    );
  }

  const record_answer = llm.tool({
    description:
      'Record something the caller said for a checklist item — an answer (value) or that ' +
      'they declined / do not know (declined:true). Call it for EVERYTHING you hear, in any ' +
      'order, several times per turn if they volunteered several things. Record only what ' +
      'they actually said — never an inference.',
    parameters: {
      type: 'object',
      properties: {
        node_id: { type: 'string', description: 'The checklist item id, exactly as shown.' },
        value: { type: 'string', description: "The caller's answer, in their words." },
        declined: {
          type: 'boolean',
          description: 'True when they were asked and cannot or will not say.',
        },
      },
      required: ['node_id'],
    },
    execute: (args: { node_id: string; value?: string; declined?: boolean }): Promise<string> =>
      Promise.resolve(runRecordAnswer(args)),
  });

  /**
   * Clean up the two shapes a caller's NAME arrives in that the record cannot
   * use as-is. Both were live defects, both stored verbatim:
   *
   *   "C-A-M-I-L-L-E"              — a correction, SPELLED. Stored letter by
   *                                  letter, so the fix for a wrong name was a
   *                                  differently wrong name (#2).
   *   "Jaya from Connolly Systems" — a person AND their company in one breath.
   *                                  splitName filed "from Connolly System" as
   *                                  a SURNAME (#10).
   *
   * The company half is recorded onto whichever company node this call has
   * open, so the fact is kept rather than discarded — and never guessed at when
   * there is nowhere for it to go.
   */
  const cleanNameValue = (raw: string | undefined): string | undefined => {
    if (!raw) return raw;
    const { name, company } = splitNameAndCompany(raw);
    if (company) {
      for (const nodeId of ['callers_company', 'client_company']) {
        if (tracker.status(nodeId) === 'open' || tracker.status(nodeId) === 'latent') {
          recordIfOpen(nodeId, company);
          break;
        }
      }
    }
    return normalizeSpelledName(name);
  };

  function runRecordAnswer(args: { node_id: string; value?: string; declined?: boolean }): string {
    if (args.node_id === CALLER_NAME && args.value && !args.declined) {
      args = { ...args, value: cleanNameValue(args.value) };
    }
    // A NUMBER NOBODY CAN DIAL IS NOT AN ANSWER.
    //
    // Live call 2026-08-15 (sim-call-1786818806598): the caller said his number,
    // STT delivered NINE digits, record_answer stored it, and the checklist
    // showed caller_phone ✓. `identify_caller` came straight back with "Invalid
    // phone number — cannot create contact" and that result was swallowed. The
    // caller then asked for a 1 PM meeting; the booking route refused for want
    // of a usable number, and the model turned that into "The number I have
    // seems not to work for confirming the appointment" — thirty seconds after
    // the mistake, in place of an answer about the time he had just asked for.
    //
    // The tracker showing ✓ for a value the rest of the system rejects is the
    // same state theater as an arg the write ignores. Refuse the record, say
    // what was actually heard, and let the checklist ask again NOW — while the
    // caller still has the number in mind.
    // The same refusal for a name that is not a name. 2026-08-15
    // `sim-questiontree`: the model recorded caller_name = **"caller"**, the
    // checklist showed ✓, and the graded transcript shows it never once
    // addressed him — because there was nothing to say. A row in the phone book
    // called "caller" is the junk-"Caller"-row shape arriving through a working
    // mechanism, and it is worse than a blank: a blank asks again.
    if (args.node_id === CALLER_NAME && args.value && !args.declined) {
      const problem = placeholderNameReason(args.value);
      if (problem) {
        getLogger().info(
          { event: 'checklist_name_rejected', heard: args.value.slice(0, 40) },
          'a placeholder was recorded as the caller name — not recorded, asking again'
        );
        return problem;
      }
    }
    // WHO IS NOT WHAT — see topicNamesOnlyAPerson. Refused rather than stored,
    // because a topic that names only a person is the input that silently costs
    // the whole role intake, and the caller is right there to answer.
    if (args.node_id === 'meeting_topic' && args.value && !args.declined) {
      if (topicNamesOnlyAPerson(args.value)) {
        getLogger().info(
          { event: 'checklist_topic_names_only_a_person', heard: args.value.slice(0, 60) },
          'a meeting topic named WHO, not WHAT — not recorded, asking again'
        );
        return (
          `"${args.value.trim()}" names WHO they want, not WHAT the meeting is about — it is ` +
          `not a topic, and it is NOT recorded. Ask what it is about ("Sure — what's it ` +
          `regarding?") and record their answer. Their answer also picks the matching tree: ` +
          `a role or position ADDS the job intake, a purchase ADDS buy_service.`
        );
      }
    }
    // A PERSON IS NOT A COMPANY. 2026-08-15 sim, DALE'S CALL: the caller said
    // "I'm calling from Bell Labs" and `callers_company` was recorded as
    // **"Marcus Webb"** — his own name, already sitting in caller_name. The
    // owner then opens a lead whose employer is a person. The two company nodes
    // carry a whole comment about not collapsing the caller's company into the
    // client's; this is the same collapse one field further left, and it is
    // decidable in host code: a company that is character-for-character the
    // caller's name is never right.
    if (COMPANY_NODES.has(args.node_id) && args.value && !args.declined) {
      const known = tracker.value(CALLER_NAME)?.trim().toLowerCase();
      if (known && known === args.value.trim().toLowerCase()) {
        getLogger().info(
          { event: 'checklist_company_is_caller_name', node_id: args.node_id },
          'a company field was given the caller name — not recorded, asking again'
        );
        return (
          `"${args.value.trim()}" is the CALLER'S NAME, already recorded as caller_name — it ` +
          `cannot also be the company. NOT recorded. Ask which company they are calling from ` +
          `("And which company are you with?") and record what they answer.`
        );
      }
    }
    if (args.node_id === CALLER_PHONE && args.value && !args.declined) {
      const problem = unusablePhoneReason(args.value);
      if (problem) {
        getLogger().info(
          { event: 'checklist_phone_rejected', digits: countPhoneDigits(args.value) },
          'a dictated phone number was not dialable — not recorded, asking again'
        );
        return problem;
      }
    }
    try {
      tracker.record(args.node_id, { value: args.value, declined: args.declined });
    } catch (err) {
      // The error text IS the corrective instruction — hand it straight back.
      if (err instanceof RecordError || err instanceof UnknownNodeError) return err.message;
      throw err;
    }
    maybeIdentify();
    // Self-healing retry of BOOKING_CLOSES_OFFER — see bookingMadeThisCall.
    // A one-shot close at the moment of booking can miss an offer node that
    // was not yet 'open'/'latent' (blocked behind other job-tree questions);
    // this keeps trying on every subsequent answer until it lands.
    if (bookingMadeThisCall) {
      for (const [nodeId, value] of Object.entries(BOOKING_CLOSES_OFFER)) {
        recordIfOpen(nodeId, value);
      }
    }
    // If this answer CORRECTS something a completed write already consumed,
    // rewrite that row — the tracker being right is not the same as the record
    // being right (#2, "Jamil").
    rewriteCorrectedWrites(args.node_id);
    // HOST-ENFORCED READ-BACK (2026-07-21): the prompt rule "read a dictated number
    // back exactly once" was skipped on two consecutive live calls — a prompt-tier
    // rule the model ignores twice gets promoted to the runtime. When the recorded
    // value IS a ten-digit phone number, the tool result hands back the exact 3-3-4
    // string to speak, so the read-back is one instruction away instead of one
    // remembered style rule away. (Caller-ID-prefilled numbers never pass through
    // record_answer, so this fires only on genuinely dictated numbers.)
    let directive = repeatGuardDirective(args.node_id) + readbackDirective(args.value);
    if (
      args.node_id === 'meeting_topic' &&
      args.value &&
      !args.declined &&
      meetingTopicNamesOwnerRole(args.value) &&
      selectableTreeSet.has('job') &&
      !tracker.selectedTrees().includes('job') &&
      !tracker.selectedTrees().includes('buy_service')
    ) {
      // Inverse of meeting_offer → booking: the topic named a role, so the
      // job tree is a fact, not a suggestion. Going through set_purpose
      // would bounce — this call's work_direction was neither_or_unclear
      // because purpose locked on "schedule a meeting" BEFORE the topic.
      tracker.select(['job']);
      if (tracker.selectedTrees().includes('booking')) {
        recordIfOpen('meeting_offer', 'wants_meeting');
      }
      deps.onSelectionChanged();
      directive +=
        '\n\nThe meeting is about a role for the owner — the job intake is now ON YOUR ' +
        'CHECKLIST. Collect the role (who is calling, whose client, what the work is, ' +
        'contract vs full time). Do not ask whether they want a meeting; they already ' +
        'asked for one. Nothing reaches the owner until capture_job_inquiry returns ' +
        'success.';
    }
    // AN AMBIGUOUS OPENER MUST NOT BE FILED AS A PLAIN MESSAGE.
    //
    // The work-direction gate already refuses job+buy_service together, and the
    // prompt already says to ask ONE clarifying question ("are you looking to
    // hire him, or interested in the AI receptionist for your own business?").
    // Both only fire when the model actually SELECTS one of the two. 2026-08-15
    // sim (BUY vs JOB): Neil opened with "I wanted to talk to someone about a
    // business opportunity", the model asked nothing, selected `message`, and
    // wrote "Neil Ashford called about a business opportunity." He is a dental
    // clinic owner who wanted to BUY the product — the single warmest lead in
    // the suite — and none of the qualification happened. The omission case had
    // no cover, exactly as the job omission had none before its nudge.
    //
    // A NUDGE, not a refusal: a genuine message caller who happens to use these
    // words must still be able to leave one. The answer is recorded either way.
    if (
      args.node_id === 'message_body' &&
      args.value &&
      !args.declined &&
      AMBIGUOUS_OPPORTUNITY.test(args.value) &&
      selectableTreeSet.has('buy_service') &&
      !tracker.selectedTrees().includes('buy_service') &&
      !tracker.selectedTrees().includes('job')
    ) {
      getLogger().info(
        { event: 'checklist_ambiguous_opportunity_message' },
        'an opportunity-shaped message was taken without the buy-vs-job question being asked'
      );
      directive +=
        '\n\nSTOP before you send this. "Opportunity" is the one word that means two ' +
        'opposite things on this line, and you have not asked which. Ask ONE question now ' +
        '("Are you looking to hire the owner for something, or are you interested in the AI ' +
        'receptionist for your own business?") and then set_purpose accordingly — ' +
        'buy_service if they want to BUY it, job if they are offering the owner work. Only ' +
        'if they truly just want a note passed along does this stay a plain message.';
    }
    if (args.node_id === 'meeting_offer' && args.value === 'wants_meeting') {
      // The offer's YES is a booking ask — and the HOST does the selecting, not
      // the model. First shipped as a directive ("call set_purpose NOW adding
      // booking"); on the very next sim run the model recorded the yes and never
      // made the call — the same shape as the ladder's 2026-07-27 eval failure
      // (offered, took a time, said "you're booked", never called the tool). A
      // tool-result instruction the model can skip is a hope; a selection the
      // host has already made is a fact. Same promotion as the read-back above.
      tracker.select(['identity', 'booking']);
      // A meeting accepted off the job intake already has its topic — the same
      // auto-fill set_purpose does when booking rides along with job.
      if (tracker.selectedTrees().includes('job')) {
        recordIfOpen('meeting_topic', TREE_TOPIC['job']);
      }
      deps.onSelectionChanged();
      directive +=
        '\n\nThey want the meeting — booking is now ON YOUR CHECKLIST. Offer real times ' +
        'next (get_available_slots). Nothing is booked until book_with_scheduling ' +
        'returns success — never say "booked" before it.';
    }
    if (args.node_id === 'meeting_offer' && args.value === 'details_only') {
      // Inverse of the wants_meeting escalation above. Found 2026-09-11
      // (sim-questiontree JOB-DIRECT): "talk to someone about a job
      // opportunity for Dale" selected identity + job + booking up front;
      // the caller then answered the offer "just pass the details along"
      // (details_only), booking stayed selected with nothing on it ever
      // answered, and the goodbye gate refused finish_call forever — one run
      // looped "You're welcome! ... Take care!" with no finish_call at all.
      // The caller's own "no meeting" is the clearest signal there is; the
      // gate must never hold a caller who has said no. Guarded on the
      // booking action NOT already being done — a meeting already booked
      // earlier in the same call (by whatever route) is real progress and
      // must never be un-booked by a later answer to an unrelated question.
      if (tracker.selectedTrees().includes('booking') && tracker.status('book') !== 'done') {
        tracker.deselect('booking');
        deps.onSelectionChanged();
        directive +=
          "\n\nNo meeting — booking is now OFF your checklist. Don't offer times or ask " +
          'booking questions; just finish what is still open and close the call.';
      }
    }
    if (args.node_id === CALLER_NAME && args.value && !args.declined) {
      // 2026-07-21 live call: the caller gave his name and never heard it again
      // until the goodbye. A receptionist who learns a name USES it — nudge at
      // the exact moment it lands, when the acknowledgement is being composed.
      // First name only: "Thanks, Dale." — never "Thanks, Dale DeMott."
      const first = args.value.trim().split(/\s+/)[0];
      directive +=
        `\n\nUse their first name in your acknowledgement right now ("Thanks, ${first}.") ` +
        `and again at natural moments later — confirming the booking, wrapping up. ` +
        `Not every sentence; that reads as salesy.`;
    }
    return stateBlock() + directive;
  }

  const finish_call = llm.tool({
    description:
      "Call when the caller has nothing further ('no thanks', 'that's all'). Speaks the " +
      'goodbye and ends the call. Refuses while the checklist still has open items.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (): Promise<string> => {
      // The gate: a selected-but-unresolved checklist holds the door shut. A
      // call with NO selection may close (wrong number, instant hang-up ask).
      // A selected-but-empty checklist deliberately REFUSES here — a message the
      // caller wanted to leave must not be dropped half-taken. The wrong-business
      // caller escapes not by weakening this gate but by never selecting a tree
      // (or deselecting one) in the first place — see the prompt's WRONG BUSINESS
      // branch and the wrong_trees exit.
      if (tracker.hasSelection() && !tracker.isResolved()) {
        finishRefusals += 1;
        if (finishRefusals < FINISH_REFUSAL_LIMIT) {
          // From the second refusal on, say the thing the model needs to hear
          // but keeps getting wrong: nothing has landed, so nothing may be
          // claimed. On 2026-08-15 it answered this refusal with "I'm still
          // finalizing your meeting" four times over, to a caller who had
          // already said goodbye — a meeting that did not exist.
          const stall =
            finishRefusals > 1
              ? ' Re-trying the same call has not worked. Nothing on this checklist has landed ' +
                'yet, so do NOT tell the caller it is done — say plainly what is still needed, ' +
                'or offer to take a message instead (add the message tree with set_purpose).'
              : '';
          return `Not yet — the checklist is not complete. Finish these first.${stall} ${stateBlock()}`;
        }
        // RELEASE. See FINISH_REFUSAL_LIMIT — the gate has had its attempts and
        // the call is now costing the caller more than it is protecting.
        getLogger().warn(
          {
            event: 'goodbye_gate_released',
            refusals: finishRefusals,
            unresolved: tracker.unresolvedNodeIds(),
          },
          'goodbye gate released an UNRESOLVED checklist — the call ended with work outstanding'
        );
      }
      // ONE goodbye. closeCall defers session.close() to a macrotask, so a second
      // finish_call can land in the gap and speak a SECOND farewell over the first
      // (2026-07-27 live call SCL_nRKo3KEVw8Yh ended "Nothing else needed… Thanks
      // for calling." / "You're all set… have a great day!" back to back). The
      // first call through this gate owns the goodbye; any repeat is a no-op.
      if (closing) return 'The call is already ending — say nothing further.';
      closing = true;
      // First name only — "You're all set, Dale", never "…, Dale DeMott".
      const name = tracker.value(CALLER_NAME)?.trim().split(/\s+/)[0];
      const goodbye = name
        ? `You're all set, ${name}. Thanks for calling, and have a great day!`
        : `You're all set. Thanks for calling, and have a great day!`;
      await deps.closeCall(goodbye);
      return 'Call complete.';
    },
  });

  const baseTools: ToolMap = { set_purpose, record_answer, finish_call };

  // get_my_appointments — in the toolset EVERY turn, not just when
  // schedule_change is selected (2026-07-30, CALL_IMPROVEMENTS.md #8): a caller
  // claimed her live 2:30 booking and the model — which had NO tool that could
  // check — asserted "you don't have a booked time on file" from silence. The
  // prompt's tool-gated-facts rule needs the tool to actually be there. Plain
  // read-only passthrough: server-side phone-gated (caller-ID / verified spoken
  // number), completes no checklist node, holds no gate.
  const realMyAppointments = realTools['get_my_appointments'];
  if (realMyAppointments) {
    // Transparent to the model — same description, same params, same result.
    // The host just NOTICES when the answer is unambiguous, so cancel and
    // reschedule stop depending on the model retyping a UUID (see
    // buildActionArgs / APPOINTMENT_ID_TOOLS).
    baseTools['get_my_appointments'] = llm.tool({
      description: shape(realMyAppointments).description,
      parameters: shape(realMyAppointments).parameters,
      execute: async (args: unknown, toolCtx: unknown): Promise<unknown> => {
        const raw = await shape(realMyAppointments).execute(args, toolCtx);
        soleAppointmentId = soleAppointmentIdIn(raw);
        return raw;
      },
    });
  }

  // RAG — in the toolset EVERY turn (questions arrive anywhere); the result
  // points the model back at the frontier so a digression cannot lose the call.
  const realAnswer = realTools['get_company_policy_answer'];
  if (realAnswer) {
    baseTools['answer_question'] = llm.tool({
      description:
        "Answer the caller's question about the business from the knowledge base — hours, " +
        'pricing, services, policies, background. Usable at ANY moment, mid-anything. Answer ' +
        'in one or two spoken sentences from the result ONLY; if it has no answer, say so ' +
        'honestly and offer to take a message or set up a time with the owner.',
      parameters: shape(realAnswer).parameters,
      execute: async (args: unknown, toolCtx: unknown): Promise<string> => {
        const raw = await shape(realAnswer).execute(args, toolCtx);
        const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
        // AN UNANSWERED QUESTION IS NOT A FINISHED CALL. 2026-08-15 sim (THE
        // ELSE): Rosa Delgado asked whether the owner would MC a wedding, the
        // knowledge base had nothing, and the agent read the fallback aloud,
        // recorded a qa_summary and hung up. She had given her name in her first
        // sentence; it was discarded (identity is not selected on a qa call),
        // no number was taken, no message was left — nobody at the business
        // will ever learn she rang. The route ALREADY knows it could not answer
        // and says so in `policyFallback`; that knowledge just never reached
        // host state. Selecting the lane in host code is what makes the offer a
        // guarantee instead of a suggestion the model took as permission to
        // close (the goodbye gate then holds the door until the message lands).
        if (ragCouldNotAnswer(text) && selectableTreeSet.has('message')) {
          const before = tracker.selectedTrees().length;
          tracker.select(['message', 'identity']);
          if (tracker.selectedTrees().length !== before) {
            getLogger().info(
              { event: 'checklist_unanswered_question_takes_message' },
              'the knowledge base could not answer — message tree selected so the caller is not lost'
            );
            deps.onSelectionChanged();
            return (
              `${text}\n\nThe knowledge base could NOT answer that, so this call must not end ` +
              `here: tell them honestly you do not have that and OFFER TO TAKE A MESSAGE so ` +
              `the owner can get back to them. Taking the message is now on your checklist. ` +
              `${stateBlock()}`
            );
          }
        }
        const open = tracker.frontier();
        const back = open.length
          ? `\n\n(Answer briefly, then return to the checklist — next open: ${open[0].node_id}.)`
          : '';
        return `${text}${back}`;
      },
    });
  }

  /**
   * Merge the model's args with the tracker's recorded answers. Model-provided
   * values always win; everything else is filled from host-owned state (the
   * 2026-07-21 lesson: a write that ignores what the checklist holds is state
   * theater). Extracted so a CORRECTION re-fire builds its args exactly the way
   * the original write did — a second code path here would be a second set of
   * bugs.
   */
  const buildActionArgs = (toolName: string, args: unknown): Record<string, unknown> => {
    const provided: Record<string, unknown> = {
      ...((args as Record<string, unknown> | null) ?? {}),
    };
    // THE MODEL NEVER HOLDS A UUID — the rule the job-inquiry link already
    // follows. cancel_appointment and reschedule_appointment both REQUIRE
    // `appointment_id`, which the model can only get by copying a UUID out of a
    // get_my_appointments result and retyping it, mid-voice-call. Found by
    // actionArgCoverage.test.ts, 2026-08-15 — no sim had reached it. When the
    // lookup returned exactly ONE appointment there is nothing to choose
    // between, so the host supplies it. With two or more this stays the model's
    // call, because picking for the caller is the mistake the unconfirmed-
    // booking guard exists to prevent, and cancelling the wrong appointment is
    // the same mistake with a worse ending.
    if (APPOINTMENT_ID_TOOLS.has(toolName) && soleAppointmentId) {
      const cur = provided['appointment_id'];
      if (cur === undefined || cur === null || cur === '') {
        provided['appointment_id'] = soleAppointmentId;
      }
    }
    for (const f of ACTION_ARG_BACKFILL[toolName] ?? []) {
      const cur = provided[f.arg];
      if (cur !== undefined && cur !== null && cur !== '') continue;
      delete provided[f.arg];
      if (f.combine) {
        // Positional: values[i] is f.from[i]'s answer, '' when unrecorded, so a
        // combiner can tell "no topic" from "no context" and phrase accordingly.
        const combined = f.combine(f.from.map((nodeId) => tracker.value(nodeId)?.trim() ?? ''));
        if (combined !== undefined) provided[f.arg] = combined;
        continue;
      }
      for (const nodeId of f.from) {
        const v = tracker.value(nodeId);
        if (v === undefined || v === '') continue;
        const mapped = f.map ? f.map(v) : v;
        if (mapped !== undefined) {
          provided[f.arg] = mapped;
          break;
        }
      }
    }
    // RAISE-ONLY URGENCY (2026-09-11): the caller's own words decide, not the
    // model's discretion — see messageSoundsUrgent(). Checked against the
    // FINAL message text (post-backfill, so it catches the tracker's
    // message_body even when the model never retyped it) and can only ever
    // flip is_urgent to true; a caller who said nothing urgent keeps whatever
    // the model passed, untouched.
    if (
      toolName === 'take_message' &&
      messageSoundsUrgent(toNonEmptyString(provided['message']) ?? '')
    ) {
      provided['is_urgent'] = true;
    }
    return provided;
  };

  /**
   * A CORRECTION REACHES THE ROW THAT WAS ALREADY WRITTEN.
   *
   * "You got my name wrong… Camille, C-A-M-I-L-L-E" arrived thirty seconds
   * after take_message had saved the row as Jamil. record_answer updated the
   * tracker, the agent said thank you, and the row never changed — it still
   * says Jamil in prod (CALL_IMPROVEMENTS.md #2). Re-fire the landed write with
   * the corrected values; take_message upserts on (tenant_id, call_id), so this
   * rewrites its own row rather than appending a contradiction.
   *
   * On a MACROTASK, and fire-and-forget: this runs inside record_answer's own
   * execute, and a correction must never make the model wait on a backend
   * round-trip — nor fail the answer it just recorded if that round-trip dies.
   */
  const rewriteCorrectedWrites = (nodeId: NodeId): void => {
    for (const site of actionSites.values()) {
      const sources = REWRITABLE_ON_CORRECTION[site.def.tool];
      if (!sources?.includes(nodeId)) continue;
      if (tracker.status(site.def.node_id) !== 'done') continue;
      const real = realTools[site.def.tool];
      if (!real) continue;
      const toolName = site.def.tool;
      setTimeout(() => {
        void (async () => {
          try {
            await shape(real).execute(buildActionArgs(toolName, {}), undefined);
            getLogger().info(
              { event: 'checklist_correction_rewrite', tool: toolName, node_id: nodeId },
              'corrected answer re-applied to the write it had already landed in'
            );
          } catch (err: unknown) {
            getLogger().warn(
              {
                event: 'checklist_correction_rewrite_failed',
                tool: toolName,
                node_id: nodeId,
                err: String(err),
              },
              'correction could NOT be re-applied — the stored row still holds the old value'
            );
          }
        })();
      }, 0);
    }
  };

  const wrapAction = (site: ActionSite): ToolMap[string] => {
    const { def } = site;
    const real = realTools[def.tool];
    const idField = ACTION_ID_FIELDS[def.tool] ?? 'id';
    return llm.tool({
      description: shape(real).description,
      parameters: shape(real).parameters,
      execute: async (args: unknown, toolCtx: unknown): Promise<string> => {
        const status = tracker.status(def.node_id);
        if (status === 'done') {
          // The anti-double-book gate (2026-07-21 live call: booked, forgot,
          // denied it, booked again). A landed write refuses a repeat.
          return (
            `ALREADY DONE this call — ${def.description} succeeded earlier. Do NOT repeat ` +
            `it, and never say it has not happened. ${stateBlock()}`
          );
        }
        if (status === 'blocked') {
          return `Not yet — first resolve: ${tracker.unmet(def.node_id).join(', ')}. ${stateBlock()}`;
        }
        if (status === 'not_applicable' || status === 'latent' || status === 'unselected') {
          return `That action is not applicable right now. ${stateBlock()}`;
        }
        // THE UNCONFIRMED-BOOKING GUARD — see slotsAwaitingChoice. Times were
        // just offered and nothing in these args names which one, so this write
        // would be guessing on the caller's behalf.
        if (
          def.tool === 'book_with_scheduling' &&
          slotsAwaitingChoice > 0 &&
          !namesOneInstant(args)
        ) {
          bookingGuardRefusals += 1;
          // What the model actually left out. The old refusal said only "the
          // caller has not picked one", which on 2026-08-15 was FALSE — the
          // caller had said "I'll take the 1:15 slot" and the model had put that
          // time in `start_time`, a field this tool does not have, while omitting
          // every required param. A refusal that misnames the fault sends the
          // model back to a question already answered, and it re-tried the same
          // malformed call twelve times.
          // Measured AFTER backfill: `phone` and `service_type` come from the
          // tracker, so naming them here would send the model chasing values
          // the host already supplies.
          const afterBackfill = buildActionArgs(def.tool, args);
          const missing = BOOKING_REQUIRED_ARGS.filter((k) => !toNonEmptyString(afterBackfill[k]));
          if (bookingGuardRefusals >= BOOKING_GUARD_REFUSAL_LIMIT) {
            getLogger().warn(
              {
                event: 'booking_guard_stood_down',
                refusals: bookingGuardRefusals,
                offered: slotsAwaitingChoice,
                missing_args: missing,
              },
              'unconfirmed-booking guard stood down after repeated refusals — letting the write through'
            );
            slotsAwaitingChoice = 0;
            // Fall through to the write. The guard has already stopped the one
            // blind booking it exists to stop.
          } else {
            getLogger().warn(
              {
                event: 'booking_before_caller_chose',
                offered: slotsAwaitingChoice,
                missing_args: missing,
              },
              'refused book_with_scheduling — no argument names the chosen time'
            );
            const missingNote = missing.length
              ? ` You also omitted required argument(s): ${missing.join(', ')}. `
              : ' ';
            return (
              `Not yet — you offered ${String(slotsAwaitingChoice)} time(s) and NOTHING in your ` +
              `arguments names which one, so this write would choose FOR them.${missingNote}` +
              `Call this again with requested_start set to exactly the time the caller said, as ` +
              `local-naive ISO (e.g. 2026-07-22T13:15:00) — "start_time" is not a parameter of ` +
              `this tool — plus window_from/window_to around it. If they said "the earliest" or ` +
              `"whichever", use the first time you offered. NOTHING IS BOOKED: do not tell the ` +
              `caller the meeting is set. ${stateBlock()}`
            );
          }
        }
        // ASKING FOR A MEETING IS ATTEMPTING TO BOOK ONE.
        //
        // `meeting_offer` asks whether the caller wants time on the owner's
        // calendar or just wants the details passed along. On 2026-08-15 the
        // caller said "Can we do it after lunch? Like, maybe at one?", the model
        // tried to book 1:00 PM — and then, two minutes later, with the booking
        // still unmade, ASKED him whether he wanted a meeting at all. He
        // answered "No. I I think we talked about it. I wanted to set up a
        // meeting at one. Right? Didn't I say that?".
        //
        // The node was still `open` because the answer arrives as an ACTION, not
        // as an utterance anyone thought to record. Close it on the attempt, not
        // on the success: a booking that fails its phone gate has still told us
        // what the caller wants, and re-asking after a failure is the same
        // insult delayed.
        //
        // `demo_offer` is the SAME node one vertical over, and it was missed
        // when meeting_offer was fixed. 2026-08-15 sim (BUY THE SERVICE): Dana
        // said "Yes, I'd be happy to book a demo any time you have available",
        // the demo WAS booked (appt_sim_1) — and because demo_offer stayed open
        // the goodbye gate refused to close, so the model went hunting for the
        // missing item and asked "would you like me to send you the details by
        // email now, or leave it for when you're ready?" of a woman who was
        // already booked. She said email, and the host wrote `demo_offer:
        // not_now`: the record now says a prospect DECLINED the demo she is
        // booked into. Wrong data, and the lead reads as cold.
        if (def.tool === 'book_with_scheduling') {
          bookingMadeThisCall = true;
          for (const [nodeId, value] of Object.entries(BOOKING_CLOSES_OFFER)) {
            recordIfOpen(nodeId, value);
          }
        }
        // Backfill omitted args from the tracker's recorded answers (see
        // ACTION_ARG_BACKFILL) — model-provided values always win.
        const provided = buildActionArgs(def.tool, args);
        const raw = await shape(real).execute(provided, toolCtx);
        const id = extractSuccessId(raw, idField);
        const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw);
        if (id) {
          tracker.completeAction(def.node_id, id);
          failCounts.delete(def.node_id);
          slotsAwaitingChoice = 0;
          return `${rawText}\n\n${stateBlock()}`;
        }
        // A miss stays open (safe direction) — but a hard-down backend must not
        // become an infinite re-offer loop (rule 15): after 2 straight failures
        // the advice changes to "stop and take a message".
        const failures = (failCounts.get(def.node_id) ?? 0) + 1;
        failCounts.set(def.node_id, failures);
        const advice =
          failures >= ACTION_FAILURE_LIMIT
            ? `\n\nThis has failed ${failures} times in a row — STOP retrying it. Offer to ` +
              'take a message instead (add the message tree with set_purpose if needed).'
            : '';
        return `${rawText}${advice}`;
      },
    });
  };

  /** Transparent passthrough that records how many times were just offered. */
  const wrapSlotReader = (real: ToolMap[string]): ToolMap[string] =>
    llm.tool({
      description: shape(real).description,
      parameters: shape(real).parameters,
      execute: async (args: unknown, toolCtx: unknown): Promise<unknown> => {
        const raw = await shape(real).execute(args, toolCtx);
        slotsAwaitingChoice = countOfferedSlots(raw);
        // A FRESH offer is a fresh choice, so the guard gets its full budget
        // back. Without this the stand-down would be permanent for the rest of
        // the call: one exhausted round would let every later blind write
        // through, which is the opposite of what standing down is for.
        bookingGuardRefusals = 0;
        return raw;
      },
    });

  const selectedTools = (): ToolMap => {
    const tools: ToolMap = { ...baseTools };
    for (const treeId of tracker.selectedTrees()) {
      for (const site of actionSites.values()) {
        if (site.treeId === treeId && realTools[site.def.tool] && !tools[site.def.tool]) {
          tools[site.def.tool] = wrapAction(site);
        }
      }
      for (const name of TREE_PASSTHROUGH_TOOLS[treeId] ?? []) {
        if (!realTools[name] || tools[name]) continue;
        // get_available_slots is still a plain read — the wrapper changes NOTHING
        // the model sees. It only lets the host notice that an offer is now
        // outstanding, which is what the unconfirmed-booking guard reads.
        tools[name] =
          name === 'get_available_slots' ? wrapSlotReader(realTools[name]) : realTools[name];
      }
    }
    return tools;
  };

  return { selectedTools };
}
