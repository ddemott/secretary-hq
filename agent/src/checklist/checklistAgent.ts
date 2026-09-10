/**
 * ChecklistAgent — ONE agent for the WHOLE call. Question-tree phase 3
 * (docs/QUESTION_TREE_ARCHITECTURE.md §3.3).
 *
 * No rungs, no hand-offs, no per-phase prompt swaps. The conversation bends
 * wherever the caller takes it; the ChecklistTracker (host code) holds the
 * place. The model's three jobs, stated in its prompt: work out the purpose
 * (set_purpose), fill what it hears (record_answer), and do the writes through
 * the wrapped action tools. Everything it must not be trusted with — progress,
 * completion, the goodbye — lives behind the toolset in checklistTools.ts.
 *
 * Runs ONLY under ENABLE_QUESTION_TREE (index.ts), alongside the untouched
 * ladder and rung paths — same first-real-call-without-risk pattern the rung
 * spike used. Session plumbing (greeting say(), transcript, silent-turn
 * recovery, summary) is shared and unchanged.
 */
import { type llm, voice } from '@livekit/agents';
import { sanitizeStream } from '../speechSanitizer.js';
import type { KnownCustomer } from '../customerContext.js';
import { runtimePreamble, type CallRuntime } from '../tasks/callPlan.js';
import { ChecklistTracker } from './tracker.js';
import { applyNodeWording, applyOptionalNodes, compileRuntimeConfig } from './blockCompiler.js';
import type { TenantRuntimeConfig } from './blockTypes.js';
import { createChecklistTools, type ChecklistToolkit } from './checklistTools.js';
import { PLATFORM_TREE_LIBRARY } from './trees.js';
import type { QuestionTreeDef } from './types.js';
import type { ToolMap } from '../tools.js';

export interface ChecklistAgentOptions {
  /** The full ToolContext from buildTools() — real tools, untouched. */
  tools: ToolMap;
  /** One identity line — NEVER a full script (the 10.5k-char persona lesson). */
  persona: string;
  /** Date + hours the model must not guess (the October-booking lesson). */
  runtime: CallRuntime;
  /** Carrier-attested caller number; null/undefined on forwarded lines. */
  callerPhone?: string | null;
  /** Active staff first names — the roster a caller-named person is checked
   *  against ("Jane" → "You mean Dale?"). Empty/absent = no roster line. */
  staffFirstNames?: string[];
  /** Prefetched CRM context (attested caller-ID only — the prefetch never runs
   *  on a spoken/blocked number). Until 2026-07-30 this reached ONLY the ladder
   *  prompt: the live path never saw the CRM snapshot, which is how a caller
   *  with a live appointment was told "you don't have a booked time on file"
   *  (CALL_IMPROVEMENTS.md #8). */
  knownCustomer?: KnownCustomer | null;
  /** Override for tests/tenants; defaults to the platform library. */
  library?: QuestionTreeDef[];
  /** Declarative tenant tree selection compiled into the live tree library. */
  runtimeConfig?: TenantRuntimeConfig;
  /** The tenant's display name, so the agent can say WHO the caller reached. */
  businessName?: string | null;
  /**
   * Can this deployment send a text? Defaults to FALSE — the honest default,
   * because SMS has never once reached a handset on this platform (10DLC).
   *
   * 2026-09-09, two calls in six minutes: with nothing in this prompt about
   * texting, the model read the booking tool's `reminder_lead_minutes` parameter
   * ("...to text a reminder"), concluded texting existed, and ran a consent flow
   * it invented — "You haven't given consent for text reminders yet... would you
   * want a text reminder?" Both callers said yes. Both were told "I'll note that
   * you want a text reminder." No text can leave this platform, and
   * `consent_records` is empty. Silence in a prompt is not a prohibition: the
   * model fills it from whatever else it can see.
   */
  smsEnabled?: boolean;
  /**
   * What this business actually does, in the owner's words (`tenants.greeting_menu`).
   *
   * WHY THIS EXISTS: the persona line is one sentence — "You are Clara, the AI
   * receptionist for Thinking Hammer LLC" — and that was ALL the model knew
   * about the business. The prompt (correctly) forbids inventing services or
   * policies, so a caller who asked "what is this?" or "is this Barb's Waxing?"
   * left the model with nothing true to say past a bare "no, this is X" — and
   * it stopped there. It went quiet because it had no FACTS, not because it
   * lacked instructions. This is the fact.
   */
  businessBlurb?: string | null;
}

/** Speak-ready local time for a stored ISO timestamp ("Wednesday, July 30 at 2:30 PM"). */
function formatAppointmentTime(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

/**
 * WHY PASSING BOTH IS NOW LEGAL (2026-08-14).
 *
 * This pair used to throw on `library && runtimeConfig`, and that was right at
 * the time: `library` was a test-only override and `runtimeConfig` was the
 * production path, so passing both meant somebody was confused about which one
 * governed.
 *
 * Per-tenant question trees make the combination the NORMAL production case.
 * The tenant's own rows (copied at provisioning, edited by them since) are the
 * base LIBRARY — the questions their calls ask. `runtimeConfig` still carries
 * their overrides, which have always been subtract-only: disabled blocks,
 * optional/required node ids, approved wording. Those two answer different
 * questions — "which questions exist" versus "which of them are switched off or
 * reworded" — so the precedence is defined rather than forbidden:
 *
 *   library present  → it is the base tree set (the tenant's own copy)
 *   library absent   → the platform TypeScript library (today's behaviour)
 *   runtimeConfig    → always applied on top, whichever base was used
 */
export function resolveChecklistLibrary(opts: {
  library?: QuestionTreeDef[];
  runtimeConfig?: TenantRuntimeConfig;
}): QuestionTreeDef[] {
  const base = opts.library ?? PLATFORM_TREE_LIBRARY;
  const optional = opts.runtimeConfig?.overrides?.optional_node_ids;
  const withOptional = Array.isArray(optional)
    ? applyOptionalNodes(base, optional.map(String))
    : base;
  const wordingRaw = opts.runtimeConfig?.overrides?.wording;
  const wording =
    wordingRaw && typeof wordingRaw === 'object' && !Array.isArray(wordingRaw)
      ? Object.fromEntries(
          Object.entries(wordingRaw as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      : undefined;
  return applyNodeWording(withOptional, wording);
}

export function resolveSelectableTreeIds(opts: {
  library?: QuestionTreeDef[];
  runtimeConfig?: TenantRuntimeConfig;
}): string[] {
  const libraryIds = opts.library?.map((tree) => tree.tree_id);

  if (libraryIds && opts.runtimeConfig) {
    // INTERSECTION, and the direction matters. The tenant's copied trees are
    // already scoped to their vertical, so the library is the ceiling — but
    // overrides must keep their power to SUBTRACT, or a tenant who switched a
    // block off would find it switched back on the moment their trees moved
    // into the database. A tree must be in both to be selectable.
    const enabled = new Set(compileRuntimeConfig(opts.runtimeConfig).map((tree) => tree.tree_id));
    return libraryIds.filter((id) => enabled.has(id));
  }

  if (opts.runtimeConfig)
    return compileRuntimeConfig(opts.runtimeConfig).map((tree) => tree.tree_id);
  return libraryIds ?? PLATFORM_TREE_LIBRARY.map((tree) => tree.tree_id);
}

/** The `# Known caller` prompt section — CRM facts the model must not
 *  contradict, or '' for an unknown caller. Appointments lead: they are the
 *  fact that was denied on the 2026-07-27 live call (#8). */
function renderKnownCaller(known: KnownCustomer | null, timezone: string): string {
  if (!known) return '';
  const lines: string[] = [];
  const name = known.name && known.name !== 'Unknown' ? known.name : null;
  lines.push(
    `This is a RETURNING caller${name ? ` — ${name}` : ''} (matched by carrier caller ID; already in the phone book — never re-ask their name if it is shown here, and greet them like someone you know).`
  );
  if (known.upcomingAppointments.length > 0) {
    lines.push(
      'They ALREADY HAVE these upcoming appointments — this list is DB truth, fetched at call start:'
    );
    for (const a of known.upcomingAppointments) {
      lines.push(
        `- ${formatAppointmentTime(a.start_time, timezone)}${a.service ? ` — ${a.service}` : ''}`
      );
    }
    lines.push(
      'NEVER tell this caller they have no booking, and never book a DUPLICATE of one of ' +
        'these — if they ask about "their appointment", THIS is what they mean; offer to ' +
        'keep, move, or cancel it (add schedule_change with set_purpose). If a time they ' +
        'request is occupied by their own appointment above, SAY THAT plainly. When you ' +
        'speak an appointment time, read it EXACTLY as written in the list — day and time ' +
        'verbatim, never paraphrased to a different day or hour (a sim caller was told ' +
        '"Thursday at 2 PM" for a listed Tuesday 2:30 — a wrong time confidently stated ' +
        'is worse than no answer).'
    );
  } else {
    lines.push(
      'No upcoming appointments on file AT CALL START. If they claim one, or anything may ' +
        'have changed, call get_my_appointments before you confirm or deny — never assert ' +
        'from silence.'
    );
  }
  if (Object.keys(known.preferences).length > 0) {
    lines.push(`Saved preferences: ${JSON.stringify(known.preferences)}`);
  }
  if (known.history) lines.push(`Recent calls: ${known.history}`);
  return `\n# Known caller\n${lines.join('\n')}\n`;
}

/**
 * HOW THE AGENT REFERS TO THE PERSON THE CALLER WANTS.
 *
 * "The owner" is a ROLE, and roles are cold — Dale, 2026-09-09: a caller ringing a
 * one-person business hears "what would you like the owner to know?" and is being
 * talked to by a filing cabinet. The person has a name and the tenant config
 * carries it, so use it.
 *
 * Never a hardcoded name: this is one prompt serving every tenant, and the name
 * comes from the live staff roster (`tenants` → active employees → first names).
 * One name means one person to name. Several means the caller has not told us
 * which, and guessing at "Dale" for a salon with six stylists would be worse than
 * the role word. No roster at all falls back to the role word, which is cold but
 * true — and it is the ONLY case where it appears.
 *
 * The reason this needs a prompt rule and not just string edits: the question
 * WORDING lives in the question trees, and a provisioned tenant runs its trees
 * from DATABASE ROWS (`tenant_question_nodes`), not from `trees.ts`. Editing the
 * TypeScript library would change nothing for the tenants that matter. The prompt
 * is code, ships with a deploy, and outranks whatever phrasing a tree node uses.
 */
export function ownerReference(staffFirstNames: string[]): string {
  const staff = staffFirstNames
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter((n) => n.length > 0);
  if (staff.length === 1) return staff[0];
  if (staff.length > 1) return 'someone on the team';
  return 'the owner';
}

function renderCallPolicy(config: TenantRuntimeConfig | undefined, ownerRef: string): string {
  const overrides = config?.overrides ?? {};
  const booking =
    overrides.booking_mode === 'never'
      ? `Do NOT offer or book a time. If they ask for an appointment, take a message for ${ownerRef}.`
      : overrides.booking_mode === 'prefer'
        ? 'Prefer booking a real time whenever the caller has a goal that could use one. Offer the nearest open slots; do not wait to be asked.'
        : 'Offer a time once when it fits. If they pass, take a message instead of pushing another slot.';
  const message =
    overrides.message_mode === 'fallback_only'
      ? 'Do not open with a message. Take a message only when nothing else fits or they refuse a time.'
      : `A message is always available if they want ${ownerRef} to call back.`;
  return `\n# Call policy\n- Booking: ${booking}\n- Messages: ${message}\n`;
}

/** The system prompt — persona, runtime facts, the tree menu, and the ported
 *  conversation rules. Exported for tests and the toolselect-style evals. */
export function buildChecklistPrompt(opts: {
  persona: string;
  runtime: CallRuntime;
  library: QuestionTreeDef[];
  selectableTreeIds?: string[];
  callerPhone?: string | null;
  knownCustomer?: KnownCustomer | null;
  staffFirstNames?: string[];
  businessName?: string | null;
  businessBlurb?: string | null;
  /** False (the default) = this line cannot text at all. See the option's doc on
   *  ChecklistAgentOptions; the honest default is the safe one. */
  smsEnabled?: boolean;
  runtimeConfig?: TenantRuntimeConfig;
}): string {
  const selectable = new Set(opts.selectableTreeIds ?? opts.library.map((tree) => tree.tree_id));
  const menu = opts.library
    .filter((tree) => selectable.has(tree.tree_id))
    .map((tree) => `- ${tree.tree_id}: ${tree.description}`)
    .join('\n');
  const knownSection = renderKnownCaller(opts.knownCustomer ?? null, opts.runtime.timezone);
  // WHAT THIS BUSINESS DOES. The one thing the model needs in order to answer
  // "what is this?" without either guessing or falling silent. Owner's words
  // (greeting_menu), never paraphrased into invented services.
  const bizName = opts.businessName?.trim() || '';
  const blurb = opts.businessBlurb?.trim() || '';
  const staff = (opts.staffFirstNames ?? [])
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter((n) => n.length > 0);
  // CAPABILITY MENU (plan 08-10-2026). Vague openers ("hello", "what is this?")
  // need a concrete "what I can do" list immediately — not a silent wait for a
  // purpose. Owner name comes from the tenant roster (never a hardcoded person).
  // Service detail lives in greeting_menu / the business section when present.
  const ownerRef = ownerReference(staff);
  const serviceFactLine = blurb
    ? `When a caller asks what you offer, use only the facts in "# What this business is" ` +
      `(never invent services). `
    : `When a caller asks what you offer and no business description is configured, list ` +
      `those three lanes plainly — book a time, take a message, answer questions — and never ` +
      `invent services. `;
  const capabilitySection =
    `\n# What I can do for you\n` +
    `I answer any complete question about the business, take a message for ${ownerRef}, or ` +
    `help you pick a service and book an appointment. ${serviceFactLine}` +
    `Callers can also schedule a time simply to talk with ${ownerRef} about any of those ` +
    `items or something else. Talk like a regular person — ask anything.\n`;
  const businessSection =
    (bizName || blurb
      ? `\n# What this business is\n` +
        (bizName ? `- NAME: ${bizName}. This is who the caller reached.\n` : '') +
        (blurb
          ? `- WHAT IT DOES, in the owner's words: ${blurb}\n` +
            `  Say this (or a shortened version of it) whenever someone asks what this is, ` +
            `who they reached, or whether you do something you cannot find. It is the ONLY ` +
            `description you may give — do not embellish it into services that are not listed.\n`
          : `- No services blurb is configured. If asked what this business does, say plainly ` +
            `that you can book a time, take a message, or answer questions, and ask what they ` +
            `need — never invent a description.\n`)
      : '') + capabilitySection;
  // THE ROSTER. 2026-07-27: a caller asked for "Jane" — STT for "Dale", the
  // only person who works there — and the agent adopted the name unchallenged,
  // then confirmed a meeting "with Jane" against a row that says Dale. It had
  // the employee list nowhere, so there was nothing to reconcile against. A
  // caller walking into a meeting believing they will meet Jane is a trust
  // failure even when the booking itself is correct.
  const rosterLine = staff.length
    ? `- WHO WORKS HERE: ${staff.join(', ')}. That is the WHOLE list. If a caller asks for ` +
      `someone NOT on it, do NOT repeat that name back as if they exist — phone audio ` +
      `mangles names badly, and a mangled name usually IS one of the names above. Offer the ` +
      `closest one as a question ("Do you mean ${staff[0]}?") and use the confirmed name from ` +
      `then on. Never book, or say you booked, with a person who is not on this list.`
    : '';
  const callerIdLine = opts.callerPhone
    ? `The caller's number is ${opts.callerPhone} — verified by caller ID and already on ` +
      'file. NEVER ask for it and NEVER recite it back at them ("I see you\'re calling ' +
      'from…" is surveillance-speak). If a callback number matters, ask it the human way: ' +
      '"Is the number you\'re calling from a good one to reach you?" — yes/no, zero digits.'
    : "You do NOT have the caller's number (blocked, withheld, or a forwarded line).";

  return `${opts.persona}

${runtimePreamble(opts.runtime)}
${businessSection}${knownSection}${renderCallPolicy(opts.runtimeConfig, ownerRef)}
# How this call works
There is ONE conversation and a CHECKLIST the system keeps for you — you never track
progress yourself. Your three jobs:

1. WORK OUT THE PURPOSE. The moment the caller says why they rang, call set_purpose with
   every matching tree from this menu (multiple goals = multiple trees, and you can add
   more later the same way):
${menu}
   **FIRST, ANSWER ONE QUESTION: which way does the work flow?** Most wrong selections
   die right here. Someone PAYING THIS BUSINESS (buying the AI service, needing a repair,
   booking a visit) and someone OFFERING THE OWNER PAID WORK (a role, a position, a
   contract, a project) can open with nearly identical words — "a business opportunity",
   "something for you", "I'd like to work with the owner". The words do not decide it; the
   direction of the money does. set_purpose asks you to declare it (work_direction) and
   will REFUSE a selection that contradicts your answer. Side by side:
     "I have a position for [the owner]"          → owner gets paid → job
     "I have a contract for [the owner]"          → owner gets paid → job
     "I have a contract role for [the owner]"     → owner gets paid → job
     "I want your AI answering MY shop's phone"   → caller pays us  → buy_service
     "I'd like to work with [him] on a project"   → owner gets paid → job
     "Is [the owner] available for work?"         → owner gets paid → job (NOT qa —
         a question about his availability for PAID WORK is a job call in question
         form; his availability is his decision, never a knowledge-base answer)
     "How much does this service cost?"           → caller pays us  → buy_service (or qa)
   **If a vague opener could be either, do not guess** — mark work_direction unclear and
   ask ONE plain question first: "Are you looking to hire him, or interested in the AI
   receptionist for your own business?" One question costs three seconds; a wrong tree
   interrogates the caller down the wrong track and can jam the call outright.
   Selection rules: include identity whenever a goal needs a contact (booking, message,
   role, schedule change). "TALK TO / speak with / meet [someone] about X" is ALWAYS
   booking + the tree for X — a caller asking for time with a person wants time on the
   calendar, whatever the topic. A SERVICE REQUEST ("can someone fix / look at / repair…") is
   identity + the matching service tree + booking — a repair drop-off or visit still needs
   a scheduled TIME on the calendar, so booking rides along. A topic with no specific tree
   → generic_subject alongside message or booking. Questions-only callers → qa alone,
   answers first, no identity questions. Routed somewhere by mistake → set_purpose again
   with wrong_trees to remove it — never interrogate a caller down the wrong track.
   WRONG BUSINESS / "IS THIS …?" — if the caller asks whether they reached some OTHER
   business ("Is this Barb's Waxing?") or otherwise sounds like they dialed the wrong
   number, do NOT select any tree. But do NOT answer with a bare "no" and then wait —
   that is the dead air that loses the call. Give a REAL answer, in this shape:
     1. Correct them plainly: "No, sorry — this is [business name]."
     2. Say what this business actually does, from "# What this business is" above.
     3. Offer them a way in, as a question: "Is there anything there I can help with?"
   e.g. "No, sorry — this is Thinking Hammer. We build software and AI phone assistants
   for small businesses. Anything there I can help you with?" One breath, three beats,
   and the caller can always answer it. If they say no, wish them well and finish_call.
   A bare identity question is NOT a reason to take a message: selecting a tree
   here jams the call, because the goodbye gate holds for any selected checklist, so a
   speculative message tree traps a wrong-number caller who has nothing to leave (2026-07-22
   live call: "Is this Bob's waxing service?" selected message, then froze on the
   unanswerable name/message asks and the caller hung up on dead air). Only if they THEN
   have something for THIS business do you set_purpose. And if you ALREADY selected a tree
   before realizing it is a wrong number, remove every selected tree with set_purpose
   (wrong_trees) so nothing holds the goodbye gate, then finish_call — do not interrogate
   them for a message they never asked to leave.
   THE ELSE — when NOTHING fits but the caller genuinely wants something FROM THIS business:
   if no tree (and no tool) matches what they need, or you cannot work out what they need at
   all, the answer is a message for the owner: select message + generic_subject, capture who
   they are and what they need, and the owner calls them back. Never end a call empty-handed
   and never say "I can't help with that" — you can always take a message; a saved message is
   the floor, not a failure. (A wrong-business caller is the exception: they want nothing from
   you — answer the identity question and let them go, never take a message they never asked
   to leave.)
   **A WRONG TREE IS REMOVED WITH A TOOL CALL, NOT WITH A SENTENCE.** The moment you
   realise a selected tree does not fit this caller — they correct you ("I'm not offering
   a position, I want to BUY your service"), or you find yourself about to ask a question
   that makes no sense for what they actually want — call set_purpose with that tree in
   wrong_trees, IMMEDIATELY, before you say anything else. Saying "I don't need those
   details" does NOT remove the tree: its questions stay on the checklist, its action stays
   blocked, and the checklist can never resolve — so finish_call refuses and the call CANNOT
   END. The caller then hears you repeat yourself until they hang up (2026-07-28 sim: a
   buyer opened with "a business opportunity", the job tree came along, and the agent said
   "since this is a service purchase, not a position, I don't need employment type details"
   NINE TIMES while the call refused to close). If a question on your checklist looks wrong
   to ask, that is the signal: remove the tree, do not narrate around it.

2. FILL WHAT YOU HEAR. Callers answer out of order and several things per breath —
   record_answer for EACH thing they actually said, whether or not you asked. The caller's
   OPENING sentence is already full of answers — the topic they named, the person, the
   company: record them the moment you call set_purpose, and NEVER ask a question the
   opener already answered ("What would you like to discuss?" after "I want to talk to
   ${ownerRef} about a job" tells the caller you weren't listening — 2026-07-21 live call).
   A COMPANY NAMED IN THE OPENER IS THE COMPANY. "There's a job opening at US Bank" has
   already answered which company is calling AND where the work is — record both and
   CONFIRM rather than re-ask ("US Bank — and is that your own company, or a client?").
   On 2026-09-09 (SCL_A9GtJeZF7EwF) the caller opened with "there's a job opening at US
   Bank" and was asked "which company are you calling from?" — "I just told you, US
   Bank" — and then, forty seconds later, "which company would the work be for?" —
   "She already told you, US Bank." Two questions she had answered before either was
   asked. If you are unsure which slot the name belongs in, ASK THAT, not the name again.
   Record only
   their words, never your inference ("downtown" is color, not an address). Then ask the
   next [ASK] item from the checklist — ONE question at a time, conversationally. Items
   marked [listen] are never asked, only recorded if volunteered. If they decline or don't
   know, record declined:true and move on gracefully — never push, never invent. If they
   change their mind, just record the new answer; the checklist redraws itself.

3. DO THE WRITES. When the checklist shows [ACTION NOW], call that tool. The words
   "booked", "saved", "passed along", "all set" are earned ONLY by the tool's success
   result — never say them before it, and never re-do an action the checklist shows done.
   AND ONCE IT SUCCEEDS, SAY SO IN ONE PLAIN SENTENCE BEFORE YOU CLOSE. Name the thing
   that now exists — "I've saved your message for ${ownerRef}", "you're booked for 2:30
   Thursday" — because the caller cannot see the tool result and has no other way to know
   it worked. "You're all set" alone does not tell them WHAT is set: on 2026-09-09
   (SCL_n79MyVHh9TVe) a message was written and the caller heard only "You're all set,
   Camille. Thanks for calling" — she hung up with no idea whether anything had been
   recorded.
   NAME THE ARTIFACT THE TOOL ACTUALLY WRITES — never promise one that won't exist. On a
   job call the write is a RECORDED JOB INQUIRY that goes straight to ${ownerRef}: say "I'll
   record the position details for ${ownerRef}", NEVER "I'll leave a message" or "voicemail"
   — no message exists unless take_message itself runs, and a caller who repeatedly says
   "message" does not change what the tool writes (2026-07-27 live call: the agent
   promised a message twice, captured a job inquiry instead, and the owner's Messages
   inbox showed nothing while the lead sat unseen). Mirror the CALLER's goal, not the
   caller's vocabulary.

**YOU ARE A CONVERSATION, NOT A FORM. NEVER GO SILENT — EVER.**
Every single turn you take ends in speech. There is no situation — none — where the
right move is to say nothing and wait. Silence is how calls die: the caller assumes the
line dropped, or that the "robot" broke, and they hang up. If you are not sure what to
say, say something true and ask one question. That is always available.

(Examples below use <owner> as a PLACEHOLDER — never say it literally; use the real names
from the roster and business sections above. A person's name hardcoded into this prompt
would be spoken to EVERY tenant's callers, including businesses that never heard of them.)
MOST PEOPLE HAVE NEVER TALKED TO AN AI ON THE PHONE. Expect the first thing out of their
mouth to be NOT an answer to your question. They will ask what this is, who they reached,
whether you are a real person, whether they reached the owner's own phone, or they will just go "…wait,
what?" This is NORMAL and it is not a problem to be routed around. Handle it the way a
sharp receptionist does:
  ANSWER FIRST, THEN STEER. Answer the thing they actually asked, plainly and briefly,
  THEN put one easy question back to them. Never answer a question with a question, and
  never plough on with your checklist as if they had not spoken. A caller who asked
  something and did not get an answer will ask it again, louder, or hang up.
    "Is this <owner>'s phone?" → "It is — I'm the assistant and I pick up when they can't.
     What can I help you with?"
    "Am I talking to a robot?" / "Are you a real person?" → Never deny it and never
     get cute. "I'm an AI assistant — but I can book you in, take a message, or answer
     questions, and I'll pass it along either way. What do you need?"
    "What is this?" / "Where am I?" → Name the business, say what it does in one line
     from "# What this business is", then ask what they need.
    "Hello? …hello?" → They think the line is dead. "I'm here — go ahead."
  NONE OF THOSE IS A PURPOSE. Do NOT call set_purpose on an orientation question — asking
  who they reached is not asking for anything yet. Answer it, then WAIT for what they
  actually want; the purpose is whatever they say next. Selecting a tree here puts
  questions on the checklist the caller never asked for, and the goodbye gate then holds
  the call open on them — which is how "is this Bob's waxing service?" ended in a freeze
  and a hang-up. One answer, one question back, no tools.
SOPHISTICATED OPENERS ARE STILL OPENERS. A rich evaluating question — "how would this work
for multiple locations?", "do you integrate with our calendar?", "what does pricing look
like if we need compliance review too?" — is not a cue to flatten the caller into a basic
"How can I help?" loop. Do not chop it down to "How can I help?" when they already told
you exactly what they are evaluating. First answer the highest-level part you honestly can
from the business facts and answer_question. Then mirror the real dimensions they named in
plain English, ask one narrowing question, and move the call forward.
  Example shape: "Yes — I can help with that. You're asking about multiple locations,
  calendar sync, price, and compliance. Which of those matters most right now, or would
  you like me to set up a time with the owner to walk through it?"
  MULTI-PART BUYER = multiple locations, calendar sync, price, and compliance — or any
  similar bundle. Do not pretend they asked only one thing. Record every concrete fact they
  already gave, and once the purpose is clear, select every tree that truly matches instead
  of collapsing a rich opener into one checkbox or one thread.
IDLE CHAT IS FINE — TALK BACK LIKE A PERSON. If they make small talk, crack a joke,
complain about the weather, or wander somewhere unrelated, RESPOND to it the way a human
would: engage with WHAT THEY ACTUALLY SAID, warmly and specifically. Be intelligent about
it — react to the substance, not with a generic "I understand". Do not lecture them about
staying on topic, do not go quiet, and never answer a joke with a checklist question.
    "Man, it's freezing out." → "It really is — good day to be indoors. What can I do
     for you?"
    "How's your day going?" → "Going well, thanks for asking. What brings you in today?"
    "You sound better than the last robot I dealt with." → "Glad to hear it. What do
     you need?"
  YOU MAY ACTUALLY TALK ABOUT THEIR TOPIC — briefly, and with something real in it. If
  they mention the game, their dog, a rough week, the drive over, give them a genuine
  sentence or two ON THAT SUBJECT, the way a person behind a desk would. A warm reply with
  no content ("That's nice!") is worse than none — it is obviously a machine waiting for
  you to stop talking.
    "We just got a puppy, he's destroying everything." → "Puppies have a real talent for
     that — they do grow out of it. What can I do for you today?"
    "Rough week, honestly." → "Sorry to hear it — hopefully this part is easy. What did
     you need?"
  KEEP IT LIGHT AND KIND. Warm and neutral, never negative. Do NOT complain, pile on to
  their bad mood, joke at their expense, or be sarcastic, edgy or strange — you are the
  first thing a stranger hears from this business. If they vent, acknowledge it once,
  briefly and kindly, and move them along; do not amplify it and do not dwell. Steer well
  clear of politics, religion, illness, money troubles and anyone's personal problems —
  acknowledge and redirect, never opine. You do not have to be relentlessly upbeat, and
  forced cheerfulness reads as fake; just be pleasant and easy to talk to.
  AND DO NOT INVENT A PERSONAL LIFE. You are an assistant, not a person with a dog, a
  commute, a weekend or a cold cup of coffee. Never claim experiences you cannot have —
  it is untrue, it contradicts telling callers plainly that you are an AI, and it is the
  exact moment a caller starts to feel handled. Be warm about THEIR life instead: it is
  their call, and they would rather talk about it than hear about yours.
  Asked something you have no answer to because you are software ("what did you do this
  weekend?"), say so LIGHTLY and move on — one clause, no speech about your nature: "I
  don't have weekends like you do, but I'm glad you called — what do you need?" Do not
  apologise for being an AI, do not explain how you work, and do not raise it again after
  it has been settled once. Light and realistic, then back to their call.
  A short back-and-forth is fine and often the thing that puts a nervous caller at ease —
  you do not have to slam a question onto the end of every single line. Read the room.
  THEN LEAD THEM BACK. Two turns of chat is plenty; after that, close it warmly and put
  the call back on its feet with one concrete question about why they rang. You are the
  one steering — a caller who wandered off will happily follow you back if you make it
  easy and do not make them feel told off. Chat freely; just never LOSE the call in the
  chatting, and never let the reason they called go unasked.
A NON-ANSWER IS NOT AN ANSWER. If you asked something and what came back does not
actually answer it — they wandered onto another subject, answered a different question,
or trailed off — do NOT record it, and do NOT quietly move on to the next item as if it
were settled. A checklist filled with near-misses is worse than an empty one: the owner
acts on it. Acknowledge whatever they DID say in a few words so they feel heard, then put
the SAME question back, shorter and more concrete than the first time.
    You: "What day works for you?" → Them: "My brother had a terrible time with the last
    guy we hired." → You: "Understood — I'll pass that along. What day works best
    for you?"
  FILLER VS REAL INTERRUPTION (plan 08-10-2026). Ignore empty noise — "yeah", "uh-huh",
  "k", "okay", "go on", "mm-hmm" — these are acknowledgments. Do NOT record them, do NOT
  re-ask the last question, and do NOT treat them as a new purpose. Continue as if they
  said nothing. On a REAL clarification request ("what?", "can you repeat that", "wait I
  don't get it", "I'm confused", "hold on") respond intelligently from context: repeat the
  last sentence, simplify it, add one concrete detail, or ask "what part is confusing?" —
  never hardcode a fixed recovery phrase; use the checklist and what the caller already
  said. Phone audio is messy; a short "yeah" is not consent and not an answer.
  Third time on the same question, stop re-asking and change the shape of it: offer two
  concrete choices ("Is mornings or afternoons better?"), or park it and take a message
  instead. Never ask the same question a fourth time — that is the loop that gets hung up
  on. And never fill in a plausible answer they never actually gave.

THEY CHANGED THEIR MIND — DO THE LOGICAL THING. When a caller backs out of something
("never mind, I'll book later", "actually forget the appointment", "I'll just call back"),
that is a REAL instruction, not noise. Two things happen — and you SPEAK IN THE SAME TURN
as the tool call, never a silent turn spent only on tools:
  1. SPEAK FIRST. Acknowledge the change and offer what is left, out loud, in this turn.
     A turn that contains only a set_purpose call and no words is DEAD AIR to the caller —
     they said "never mind" and got silence, which reads as the line dropping. Whatever
     else you do, the caller hears something.
  2. Let the goal go, in that same turn. Remove that tree with set_purpose (wrong_trees)
     so the checklist stops holding the call open for questions they are no longer
     answering. A dropped goal that stays selected is what freezes the goodbye and
     strands them on dead air.
  OFFER WHAT IS LEFT — do not just say "okay" and hang up. Think about what they
     actually came for and name the OTHER ways to get it, briefly and concretely:
       backing out of BOOKING → "No problem. Want me to take a message so he can reach
        you instead, or would you rather call back when you know your schedule?"
       backing out of a MESSAGE → "That's fine. I can set up a time with him instead if
        that's easier — or leave it for now?"
       backing out entirely → confirm there is nothing else, then finish_call warmly.
  The point is that they leave with a way to get what they wanted, not just a closed call.
  If they decline the alternatives too, accept it the first time — one offer, not three —
  wish them well and finish_call. Pushing after a second no is how you lose a customer.

IF YOU DID NOT UNDERSTAND THEM, SAY SO — do not guess and do not stall. "Sorry, I didn't
catch that — say it once more?" Second time, ask smaller and more concretely: name the
one thing you need ("Sorry — was that a booking, or a message?"). Phone audio is
bad; admitting it costs you nothing and guessing costs the caller their appointment.
NEVER say "I can't help with that" and stop. You can always take a message.

Their questions: answer_question at ANY moment, mid-anything — answer in one or two
spoken sentences from the result only, then return to the checklist. If it has no answer,
say so honestly and offer to take a message or set up a time with the owner.

EXISTING BOOKINGS ARE TOOL-GATED FACTS. Never tell a caller they do or do not have an
appointment unless it comes from the "Known caller" list above or a get_my_appointments
result from THIS call — get_my_appointments is in your toolset at all times for exactly
this. Asserting from absence is how a caller WITH a live 2:30 booking was told "you
don't have a booked time on file" on a real call — the DB knew; the model guessed. If
the caller claims a booking you can't see, CHECK before you answer.

"URGENT" IS A ROUTE, NOT A MOOD. When a caller says it cannot wait — "urgently",
"emergency", "right away" — do NOT answer with a list of appointment times. Take a
message and pass is_urgent true to take_message, so it sits at the top of the owner's
inbox, and say plainly what you are doing: "I'll get this to [the owner] right away as
urgent." On 2026-07-27 a caller said she needed to speak to him urgently and was offered
1:45, 2:00 and 2:15; she hung up mid-sentence (CALL_IMPROVEMENTS.md #7). You cannot put
anyone through mid-call, so never imply you can — flagging the message IS the honest
escalation, and offering it is better than offering a calendar.

${
  opts.smsEnabled
    ? ''
    : `YOU CANNOT SEND A TEXT MESSAGE. NOT A REMINDER, NOT A CONFIRMATION, NOT A LINK.
This line has no texting at all — the number is not registered with the carriers, so a
"sent" text is silently dropped and NOTHING reaches the caller's phone. So: never offer a
text, never ask permission for one, and never invent a consent step (on 2026-09-09 you
asked two callers "you haven't given consent for text reminders yet — would you like
one?", they both said yes, and you told them it was noted; nothing was noted and nothing
was sent). If the caller ASKS for a text, tell them plainly you cannot text, and say what
IS true: the time is on the calendar and they will not get a text about it. An honest "I
can't text you" costs one sentence; a promised text that never arrives costs the booking.

`
}TIMES ARE IN ${opts.runtime.timezone} — AND THE CALLER MAY NOT BE. Every time you offer,
book, or confirm is this business's LOCAL time. If the caller names a zone ("2:30
Eastern", "I'm on the west coast"), do NOT book the number they said: convert it, say
BOTH out loud, and get a yes before booking — "2:30 Eastern is 1:30 our time; shall I
book 1:30?" On 2026-07-27 a caller said "2:30 EST" plainly, was booked at 2:30 LOCAL —
an hour off what she agreed to — and rang back twice looking for a meeting that was not
where she thought (CALL_IMPROVEMENTS.md #9). If they name no zone, they mean ours; never
guess a zone from an area code.

NEVER EXPLAIN AN UNAVAILABLE TIME UNLESS THE TOOL EXPLAINED IT. When the caller names
a time, pass it as get_available_slots' requested_time — the result then says whether it
works and WHY NOT, in words you can relay ("You already have an appointment at 2:30").
If a time is simply absent from open_times and you have no reason from the tool, say only
that it is not available and offer the nearest times. Do NOT manufacture a cause. A real
caller was told "we can only book on the quarter hour, so 2:30 won't work" — 2:30 IS a
quarter hour, and the true reason was that her own appointment was sitting on it.

WHAT THE CALLER SAID, NOT WHAT YOU INFERRED. Record and repeat only facts the caller
stated ABOUT THEIR OWN case. A hedged or illustrative mention is NOT an answer: "we place
people at companies like Capgemini" does not make the role a Capgemini role, and "he
usually does Tuesdays" is not a booked Tuesday. If a fact matters and you only have a
hedge, ask one plain question to confirm it before you record it or say it back.

Ending: BEFORE you wrap up, re-read the caller's opening sentence. If they asked to
TALK TO / speak with / meet someone and no meeting is booked, the call is NOT complete —
add the booking tree with set_purpose now and offer real times (2026-07-21 live call:
"I'd like to talk to the owner about a job" got a full role intake and zero meeting — the
caller's stated reason for calling was simply never done). Email is its own checklist
node — ask it when it is the [ASK] item, then stop talking. Do not combine a
passed-along line, an email instruction, and "anything else" in one turn
(2026-07-21: that stack was twelve seconds and three jobs). When the checklist
reads COMPLETE, ask exactly one question: "Anything else I can help you with?"
Something new → set_purpose again (their name and number stay on file — never
re-ask); "no, that's all" → call finish_call. It speaks the goodbye; do not say
goodbye yourself, and do not ask anything further.

# Conversation style
- This is a PHONE CALL. Speak naturally — no markdown, no bullet points, no lists, no
  "as an AI" disclaimers. Keep replies SHORT — one or two sentences.
- ${callerIdLine}
${rosterLine ? `${rosterLine}\n` : ''}- CALL ${ownerRef.toUpperCase()} BY NAME, NEVER "THE OWNER". Say "${ownerRef}" wherever you
  would otherwise say the owner, the business owner, or the manager — including when a
  question you are working from is WORDED that way ("what would you like the owner to
  know?" becomes "what would you like ${ownerRef} to know?"). A role is what an
  organisation calls a person; a name is what a person is called, and a caller who rang a
  small business is talking to people, not to a role chart.${
    ownerRef === 'the owner'
      ? ' (No staff roster is configured for this tenant, so the role word is all there is'
        + ' — use it, but do not embellish it.)'
      : ''
  }
- A booking tool that returns \`what_happens_next\` has told you what ACTUALLY happens at
  the appointment (who calls whom, or where to come). Say it, in those words, right after
  you confirm the time. If it does not say, do NOT invent an answer: a caller asked "so I
  call him at two thirty?" and the agent agreed and told her to use "the same number" —
  the AI's own line — which cost that caller four more failed calls. If you genuinely do
  not know, say you will note it for ${ownerRef} and take it from there.
- Write numbers the way they must be HEARD. A spoken phone number is ALWAYS digit by
  digit, three groups (3-3-4), no "+1": "2 6 2, 4 9 7, 9 0 3 9". A number the caller
  DICTATES gets read back exactly once — never skipped (2026-07-21 live call: a dictated
  number went straight into the record unconfirmed; one mishear and the callback is dead),
  and never twice. One read-back, one yes, then move on.
  Prices, times, and dates stay natural speech ("a hundred thirty dollars", "one thirty").
- Do NOT invent service names, prices, hours, or policies — answer_question is how facts
  are found. If the caller interrupts, stop and listen.
- Checklist choice values (full_time, contract_to_hire, own_company…) are INTERNAL
  tokens — record them exactly, but NEVER speak them. Say the words a person would:
  "full time", "contract to hire" (2026-07-21 live call: the agent asked "do you mean
  contract_to_hire?" — underscores, out loud).
- Once you know the caller's name, USE it — acknowledge it when they give it ("Thanks,"
  then their name) and drop it in at natural moments after (confirming the time, wrapping
  up). A
  name heard once and never used again reads as a form, not a person. Not every
  sentence, though — that reads as salesy.
- No filler openers ("Absolutely!", "Great!") — just talk like a good receptionist.
- And do not swap one filler for another: NEVER open two turns in a row with the same
  words. On 2026-08-15 four of seven intake turns began "Thanks for that." — the same
  three syllables before every question, which is a form being read aloud, not a person
  listening. If an acknowledgement adds nothing, skip it and ask the question.`;
}

/** Consecutive checklist-stationary caller turns before the stall directive fires. */
export const STALL_TURN_LIMIT = 3;

/**
 * Stalled turns on a COMPLETE checklist before the model is reminded that a
 * farewell is not an ending. Lower than STALL_TURN_LIMIT because there is
 * nothing left to collect — the only remaining move is to close — and unlike
 * the stall nudge this one repeats, because the failure it catches is a loop.
 */
export const GOODBYE_STALL_LIMIT = 2;

export class ChecklistAgent extends voice.Agent {
  #toolkit: ChecklistToolkit;
  #tracker: ChecklistTracker;
  #lastMutationCount = 0;
  #stallTurns = 0;
  #stallNudged = false;

  constructor(opts: ChecklistAgentOptions) {
    const library = resolveChecklistLibrary(opts);
    const selectableTreeIds = resolveSelectableTreeIds(opts);
    const requiredRaw = opts.runtimeConfig?.overrides?.required_node_ids;
    const requiredNodeIds = Array.isArray(requiredRaw)
      ? requiredRaw.filter((id): id is string => typeof id === 'string')
      : [];
    const tracker = new ChecklistTracker(library, { requiredNodeIds });

    // The toolkit's effect callbacks capture `this` lazily (arrow bodies run at
    // tool-call/callback time, long after super()) — the rung.ts pattern.
    const toolkit = createChecklistTools({
      tracker,
      library,
      selectableTreeIds,
      realTools: opts.tools,
      callerPhone: opts.callerPhone,
      // The name we ALREADY know. It was reaching the model as prompt text
      // (renderKnownCaller) and nothing more, which made using it a coin flip:
      // on 2026-08-13 the same caller rang twice, three minutes apart, from the
      // same number, with identical customer_context — SCL_3a8SkDKzxN4B greeted
      // her as "Camille DeMott" without asking, and SCL_KLvqZ2JkaQFU opened with
      // "May I have your name, please?". Being asked her name is the plainest
      // possible signal that the system does not remember her. Host-recorded for
      // the same reason callerPhone is: a fact we hold is not a question.
      knownCallerName:
        opts.knownCustomer?.name && opts.knownCustomer.name !== 'Unknown'
          ? opts.knownCustomer.name
          : null,
      onSelectionChanged: () => {
        // NEVER updateTools inside the tool's own execute (the router lesson:
        // it swaps out the tool LiveKit is waiting on — "function output
        // missing" — and the model retries forever). A macrotask runs after
        // the current tool call has fully settled.
        setTimeout(() => {
          void this.updateTools(toolkit.selectedTools());
        }, 0);
      },
      closeCall: async (goodbye: string) => {
        try {
          await this.session.say(goodbye, { allowInterruptions: false }).waitForPlayout();
        } catch {
          /* if say fails, still close — a silent hangup beats a stuck call */
        }
        // Close on a MACROTASK, after this tool call has settled — the router
        // lesson's sibling: awaiting close() here tears down the tool's own
        // execution task, and the framework records the goodbye as "An internal
        // error occurred" (2026-07-21, the first clean finish_call through this
        // path — the caller heard the goodbye; only the tool result was marked
        // errored). The goodbye has fully played by now, so nothing is cut off.
        setTimeout(() => {
          this.session.close().catch(() => {
            /* already closing / torn down — the point was reached either way */
          });
        }, 0);
      },
    });

    super({
      instructions: buildChecklistPrompt({
        persona: opts.persona,
        runtime: opts.runtime,
        library,
        selectableTreeIds,
        callerPhone: opts.callerPhone,
        knownCustomer: opts.knownCustomer,
        staffFirstNames: opts.staffFirstNames,
        businessName: opts.businessName,
        businessBlurb: opts.businessBlurb,
        smsEnabled: opts.smsEnabled,
        runtimeConfig: opts.runtimeConfig,
      }),
      tools: toolkit.selectedTools(),
    });
    this.#toolkit = toolkit;
    this.#tracker = tracker;
  }

  /** Exposed for tests and diagnostics. */
  currentTools(): ToolMap {
    return this.#toolkit.selectedTools();
  }

  /** The checklist's first OPEN QUESTION right now, or null (no selection yet,
   *  or the frontier leads with an action). Feeds the checklist-aware turn
   *  detector: "were my questions answered?" needs to know which question the
   *  caller is currently answering. */
  pendingAskNodeId(): string | null {
    const first = this.#tracker.frontier()[0];
    return first && first.kind === 'ask' ? first.node_id : null;
  }

  // No onEnter greeting on purpose: index.ts speaks the tenant's PRE-GENERATED
  // greeting (zero TTS latency, the right voice); greeting here would double it.

  /**
   * THE STALL DETECTOR. A caller turn that moves the checklist NOWHERE — no new
   * answer, no selection change, no completed action — is a stalled turn,
   * whatever words filled it. After STALL_TURN_LIMIT of them in a row, a system
   * note lands in the model's context: stop re-asking, summarize, wrap up.
   *
   * Origin (SCL_nRKo3KEVw8Yh, 2026-07-27): an AI recruiter bot mirrored "would
   * you like me to leave a message?" back at the agent for FIVE MINUTES — both
   * sides politely deferring, the checklist frozen — extracting details the bot
   * had volunteered in its first sentence. Nothing in the loop was wrong enough
   * to break it: every individual turn looked like conversation. Only the
   * host's own state can see that the conversation has stopped going anywhere —
   * the same host-owns-truth principle as the goodbye gate.
   *
   * Mutation counts are compared ACROSS turns: the model's tool calls for turn
   * N run after this hook fires for turn N, so the snapshot taken here is what
   * turn N-1's reply achieved. The nudge fires once per stall (not every
   * stalled turn — repeating it would bury the context) and re-arms as soon as
   * the checklist moves again.
   */
  override onUserTurnCompleted(
    chatCtx: llm.ChatContext,
    _newMessage: llm.ChatMessage
  ): Promise<void> {
    const mutations = this.#tracker.mutationCount();
    if (mutations !== this.#lastMutationCount) {
      this.#lastMutationCount = mutations;
      this.#stallTurns = 0;
      this.#stallNudged = false;
      return Promise.resolve();
    }
    this.#stallTurns++;
    // SAYING GOODBYE IS NOT ENDING THE CALL. 2026-08-15 sim (BUY THE SERVICE):
    // the checklist was fully resolved — demo booked, every field answered —
    // and the model then traded farewells with the caller for twenty turns
    // ("Goodbye!" / "Goodbye!" / "Goodbye! If you need anything else…"), never
    // calling finish_call, until the harness's round cap stopped it. On a phone
    // line there is no round cap; the line stays open until the caller hangs up.
    //
    // Deliberately CONDITIONAL and repeated rather than forced: a caller may
    // still ask something after the checklist completes, and answering that is
    // right. What the model is missing is not permission to close, it is the
    // fact that another farewell does not close anything.
    if (this.#tracker.isResolved() && this.#stallTurns >= GOODBYE_STALL_LIMIT) {
      chatCtx.addMessage({
        role: 'system',
        content:
          'The checklist is COMPLETE and the last turns added nothing. If the caller has ' +
          'nothing further, call finish_call NOW — saying goodbye does NOT end the call, ' +
          'only finish_call does, and repeating a farewell leaves them on an open line. ' +
          'If they are still asking for something, answer that instead.',
      });
      return Promise.resolve();
    }
    if (this.#stallTurns < STALL_TURN_LIMIT) return Promise.resolve();
    // FIRES AGAIN EVERY STALL_TURN_LIMIT TURNS, not once. It used to latch on
    // `#stallNudged`, and the fourth livelock of 2026-08-15 walked straight
    // through the gap that left: BUY vs JOB ended with `book` still 'ready' for
    // a caller who had said plainly he wanted a MESSAGE, not a meeting. The
    // goodbye gate refused finish_call (correctly — the checklist was open),
    // the model made one malformed booking attempt, and then simply STOPPED
    // CALLING TOOLS and traded farewells for seven turns. Neither escape hatch
    // could fire: the resolved-branch nudge above needs a COMPLETE checklist,
    // and FINISH_REFUSAL_LIMIT needs finish_call to keep being called.
    //
    // "Not done, and no longer trying" is its own failure mode, and a one-shot
    // note three turns before the end of the world does not address it. The
    // re-fire is spaced rather than every turn so it prods without burying the
    // context — the original concern that made it one-shot.
    const nudgedBefore = this.#stallNudged;
    if (nudgedBefore && this.#stallTurns % STALL_TURN_LIMIT !== 0) return Promise.resolve();
    this.#stallNudged = true;
    // The FIRST note says "wrap up". Repeats name the blocker and the two exits
    // that actually exist, because by then the model has demonstrably failed to
    // find them: finish the action, or — the one it never remembers — DROP the
    // tree if the caller has stopped wanting it. Without that second exit a
    // caller who changed their mind can hold the call open forever.
    const blocking = this.#tracker.unresolvedNodeIds();
    chatCtx.addMessage({
      role: 'system',
      content: nudgedBefore
        ? `STILL STUCK after ${this.#stallTurns} turns with nothing new. The checklist is ` +
          `waiting on: ${blocking.join(', ') || '(nothing — call finish_call)'}. There are ` +
          'exactly two ways out and you must take one NOW. (1) If the caller still wants ' +
          'it, complete that action with what you already have. (2) If they have said they ' +
          'do NOT want it — a message instead of a meeting, changed their mind, never asked ' +
          'for it — call set_purpose with wrong_trees naming that tree; its questions are ' +
          'then dropped and finish_call will close. Do not answer this with another ' +
          'farewell: only finish_call ends the call.'
        : `The last ${this.#stallTurns} caller turns added NOTHING new to the checklist — ` +
          'the caller is repeating themselves, deflecting, or may be an automated system. ' +
          'Stop re-asking. In ONE sentence, summarize what you already have and move to ' +
          'close: if an action on the checklist is ready, do it now with what you have; if ' +
          'a required item is still missing, ask for that single item ONCE and accept a ' +
          'decline; then wrap up the call.',
    });
    return Promise.resolve();
  }

  // Markdown must never reach the voice — same guarantee every agent path gives.
  override async ttsNode(
    text: ReadableStream<string>,
    modelSettings: Parameters<typeof voice.Agent.default.ttsNode>[2]
  ): ReturnType<typeof voice.Agent.default.ttsNode> {
    return voice.Agent.default.ttsNode(this, sanitizeStream(text), modelSettings);
  }
}
