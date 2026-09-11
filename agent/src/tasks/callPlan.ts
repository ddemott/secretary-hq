/**
 * THE PLAN: which of the caller's goals become which tasks, in what order.
 *
 * This is the piece the research flagged as the real design work — "build the group AFTER
 * an intent step returns the caller's goals, so a second goal is a second task." The
 * TaskGroup loop then guarantees every registered task runs before the call can end. But
 * that guarantee is only as good as the REGISTRATION: a goal that never becomes a task is
 * a goal the loop never knows to enforce. So the completeness of the whole system lives
 * HERE, and it must be testable on its own, without a live call.
 *
 * So `planCallTasks` is pure: goals in, an ordered list of task specs out. It builds no
 * agents and touches no session. `buildCallTaskGroup` turns that plan into a real
 * TaskGroup. The split is deliberate — the plan is the checklist, and a checklist you can
 * read is a checklist you can trust.
 *
 * ORDER IS NOT NEGOTIABLE. Identity first (you cannot book or brief without a name and
 * number). Then the meeting — it is what they RANG FOR, and everything else is
 * preparation for it. Then the intake. A tenant chooses their INTAKE questions; they do
 * not get to choose this order, exactly as with the composed script blocks, and for the
 * same reason: it is what the bad calls taught us, not a preference.
 */
import { type voice, beta } from '@livekit/agents';
import type { SessionContext } from '../sessionContext.js';
export { sanitizeVolunteered } from './sanitize.js';
import { makeIdentityRung, type IdentityResult } from './identityTask.js';
import { makeBookMeetingRung, type BookMeetingResult } from './bookMeetingTask.js';
import type { JobIntakeResult } from './jobIntakeTask.js';
import { makeMeetingContextRung, type MeetingContextTemplate } from './meetingContextTask.js';
import { makeTakeMessageRung, type TakeMessageResult } from './takeMessageTask.js';
import { makePolicyQaRung, type PolicyQaResult } from './policyQaTask.js';
import { makeSchedulingRung, type ScheduleChangeResult } from './schedulingTask.js';
import type { ToolMap } from '../tools.js';

/**
 * What the caller wants ACCOMPLISHED by the time they hang up — the output of the intent
 * step, not the words they opened with. Booleans, because a goal is present or it is not,
 * and the loop needs a yes/no per task.
 */
export interface CallerGoals {
  /** They want an appointment — a meeting, call, viewing, demo. */
  wantsMeeting: boolean;
  /** They mentioned a role, contract, project, or hiring — details to brief the owner. */
  hasJobInquiry: boolean;
  /** They want to CHANGE an existing appointment — cancel it or move it. Optional (absent =
   *  false) so the three original goals keep their existing call sites; the intent router
   *  always supplies it explicitly. */
  wantsScheduleChange?: boolean;
  /** They want to leave a message for the owner — a question, a callback request, anything a
   *  booking or a role does not cover. The universal catch-all. Optional for the same
   *  call-site-compatibility reason as wantsScheduleChange. */
  wantsToLeaveMessage?: boolean;
  /** They have QUESTIONS about the business — hours, pricing, services, policies,
   *  location. Answered from the knowledge base (RAG), never from the model's memory. */
  hasQuestions?: boolean;
  /** In their own words, for the service matcher. */
  requestedService?: string;
}

/** Everything a task needs, gathered once and threaded through the plan. */
/**
 * The runtime facts a task cannot guess and must not: what day it is, when the business
 * is open, the timezone. buildSystemPrompt injects these into the prompt on the current
 * agent — but each task REPLACES that prompt with its own, so without threading these
 * through, the model books blind. On the first live call it guessed October dates and
 * every booking failed EMPLOYEE_NOT_SCHEDULED. A task that does not know what today is
 * cannot book tomorrow.
 */
export interface CallRuntime {
  /** e.g. "Wednesday, July 15, 2026" — same format buildSystemPrompt uses. */
  currentDate: string;
  /**
   * THE CLOCK. e.g. "6:08 PM" — local to `timezone`, and load-bearing.
   *
   * It did not exist until 2026-09-09, and its absence cost a whole call. On
   * SCL_HQNeyh5cVKd9 (18:08 CT) the model was handed the DATE and no time, so it
   * invented one: it told the caller "It's currently 3 PM here", twice, and when
   * she answered "it is not 3PM, it is 6PM" it replied "thanks for clarifying
   * that it's 6 PM there in Chicago time" while still holding its own 3 PM — and
   * had already offered "availability today from 1 to 5 PM" three hours after the
   * business closed. A model with no clock will not decline to answer a question
   * about the time; it will guess, and then defend the guess.
   */
  currentTime: string;
  timezone: string;
  /** e.g. "Monday to Friday, 1:00 PM to 5:00 PM", or null if nobody is scheduled. */
  businessHours: string | null;
  /** Last date anyone is scheduled, so the model does not offer beyond it. */
  bookableThrough: string | null;
}

/** What later rungs are told about the caller identity already collected. */
export function knownCallerLine(state: CallState): string {
  if (state.callerName && state.callerPhone) {
    return `The caller is ${state.callerName}, phone ${state.callerPhone}. You ALREADY have these — use them (pass the phone to any tool that needs one) and do NOT ask for them again.`;
  }
  return '';
}

/** The preamble every task prepends, so no rung is blind to the date or the hours. */
export function runtimePreamble(rt: CallRuntime): string {
  const hours = rt.businessHours
    ? `We are open ${rt.businessHours}.${rt.bookableThrough ? ` You can book through ${rt.bookableThrough}.` : ''}`
    : `No one is currently scheduled, so do not claim to be open.`;
  return (
    `RIGHT NOW it is ${rt.currentTime} on ${rt.currentDate} (${rt.timezone}). That clock is ` +
    `the ONLY source for the current time: state it if asked, and NEVER name a different ` +
    `one — a caller who is told the wrong time will correct you, and arguing with them ` +
    `about it is worse than the original error. ${hours} A slot EARLIER TODAY than the ` +
    `time above is gone, and once the closing hour has passed today is over — do not ` +
    `offer it at all. SAY BOTH HALVES IN ONE BREATH: that you are closed now, and the ` +
    `next time you CAN see them — "we're closed for the evening, but I can get you in ` +
    `tomorrow at 1:30" — never the closure on its own, which sounds like a refusal and ` +
    `ends the call. When the caller names a day like "tomorrow" or "Friday", resolve it ` +
    `against TODAY'S date above — never guess a month or year.`
  );
}

/**
 * STATE THAT FLOWS BETWEEN RUNGS. Each task is a separate agent with its own prompt, so
 * what the identity rung learns (the caller's name and confirmed number) is invisible to
 * the booking rung unless it is carried HERE. The first real E2E caught exactly this: the
 * caller gave and confirmed a number, then the booking tool asked for it again because the
 * booking task had no idea it existed. A shared, mutable object is the carrier — identity
 * writes it, later rungs read it (their factories run AFTER identity completes, so the
 * value is there).
 */
export interface CallState {
  callerName?: string;
  callerPhone?: string;
  /** Identity facts the caller VOLUNTEERED to the root agent (begin_call captures
   *  them) before the identity rung existed. Seed the rung so it confirms instead of
   *  re-asking; cleared conceptually once callerName/callerPhone are confirmed. */
  volunteeredName?: string;
  volunteeredPhone?: string;
  /** Written by the booking rung when a meeting ACTUALLY landed (not when it fell back
   *  to a message). Read at factory time by the meeting-context rung: it decides whether
   *  there is a meeting to attach anything to, and which opener is true. */
  appointmentId?: string;
}

export interface CallDeps {
  ctx: SessionContext;
  runtime: CallRuntime;
  /** Written by the identity rung, read by every later rung. */
  state: CallState;
  /** The full ToolContext from buildTools() — tasks take the slices they need. */
  tools: ToolMap;
  onIdentified?: (r: IdentityResult) => Promise<void> | void;
  onBooked?: (r: BookMeetingResult) => Promise<void> | void;
  onCaptured?: (r: JobIntakeResult) => Promise<void> | void;
  onMessageTaken?: (r: TakeMessageResult) => Promise<void> | void;
  onAnswered?: (r: PolicyQaResult) => Promise<void> | void;
  onScheduleChanged?: (r: ScheduleChangeResult) => Promise<void> | void;
}

/**
 * One entry on the stack. `factory` is lazy (TaskGroup calls it when the rung is popped);
 * `id` and `description` are what the loop and the out-of-scope tool use. Kept as data so
 * a test can read the WHOLE plan without constructing a single agent.
 */
export interface TaskSpec {
  id: string;
  description: string;
  factory: () => voice.AgentTask;
}

/**
 * Turn the caller's goals into the ordered list of rungs the call must complete.
 *
 * Pure. This is the checklist, and the loop's guarantee is exactly as strong as this
 * list is complete: every goal here becomes a task the caller cannot leave without.
 */
/**
 * Pick a NAMED SUBSET of tools. This is the point of the whole architecture — a task sees
 * only the tools its rung needs — and it is the fix for the first real call: I handed
 * BookMeetingTask the ENTIRE toolbox (deps.tools), so the model reached past
 * get_available_slots (clean 15-minute grid) for get_scheduling_options (raw
 * "soonest-from-now" times like 1:41 PM that drift minute by minute and wander to
 * October). A tool the task does not have is a tool the model cannot misfire.
 */
function pick(tools: ToolMap, names: string[]): ToolMap {
  const out: ToolMap = {};
  for (const n of names) if (tools[n]) out[n] = tools[n];
  return out;
}

export function planCallTasks(goals: CallerGoals, deps: CallDeps): TaskSpec[] {
  const specs: TaskSpec[] = [];

  // CallRootAgent is told to send requested_service = "" when the ask is unclear, and `??`
  // would let that empty string through as the service intent (degrading the semantic match
  // and the "already asked" opener). Treat blank as ABSENT here, once, so every rung sees a
  // real value or nothing.
  const requestedService = goals.requestedService?.trim() || undefined;

  // A QUESTIONS-ONLY call is the ONE deliberate exception to identity-first (decided
  // 2026-07-16): a caller asking "when are you open?" must not be interrogated for a
  // name and number before getting an answer — that is how you lose the caller in the
  // first ten seconds. Identity is the floor under goals that need a CONTACT (a
  // booking, a message, a role, a change); pure curiosity needs none. If their
  // questions turn into a message ("have the owner get back to me"), the Q&A rung
  // gathers name+number itself and take_message's backend gate enforces it.
  const questionsOnly =
    goals.hasQuestions === true &&
    !goals.wantsMeeting &&
    !goals.hasJobInquiry &&
    !(goals.wantsScheduleChange ?? false) &&
    !(goals.wantsToLeaveMessage ?? false);

  // RUNG 1 — for every call with a contact-needing goal. You cannot book a meeting or
  // brief the owner on a caller you cannot name or reach. Identity is not a goal the
  // caller states; it is the floor under all of them (except questions-only — above).
  // LOOP-BACK ROUNDS (2026-07-18): when the shared state already holds a
  // confirmed name AND number from an earlier round, identity is DONE — a
  // second group must not re-collect it (gotcha H's original failure). The
  // knownCallerLine injection gives every later rung the same facts.
  const identityDone = Boolean(deps.state.callerName && deps.state.callerPhone);
  if (!questionsOnly && !identityDone) {
    specs.push({
      id: 'identity',
      description: "Get and confirm the caller's name and phone number.",
      factory: () =>
        makeIdentityRung({
          ctx: deps.ctx,
          identifyCaller: deps.tools['identify_caller'],
          requestedService,
          volunteeredName: deps.state.volunteeredName,
          volunteeredPhone: deps.state.volunteeredPhone,
          onIdentified: async (r) => {
            // Carry the confirmed identity forward to every later rung.
            deps.state.callerName = r.name;
            deps.state.callerPhone = r.phone;
            await deps.onIdentified?.(r);
          },
        }),
    });
  }

  // RUNG 1.5 — their questions, if they have any. BEFORE the booking, deliberately:
  // the book-first doctrine exists because callers were hanging up unbooked after
  // answering nine of OUR questions — but Q&A is THEIR questions, and a caller who
  // asked "what do you charge?" cannot reasonably be marched into picking a time
  // before hearing the answer. Once answered, the loop proceeds to the booking rung
  // automatically — the plan still cannot end with the meeting unbooked.
  if (goals.hasQuestions) {
    specs.push({
      id: 'policy_qa',
      description: "Answer the caller's questions from the knowledge base.",
      factory: () =>
        makePolicyQaRung({
          knowledgeTools: pick(deps.tools, ['get_company_policy_answer']),
          takeMessage: deps.tools['take_message'],
          knownCaller: knownCallerLine(deps.state),
          runtimePreamble: runtimePreamble(deps.runtime),
          // The rung is an island — it must KNOW a booking step follows, or it
          // truthfully denies an ability the call actually has and the caller
          // gives up (the 0/4 live-LLM run, 2026-07-16).
          bookingFollows: goals.wantsMeeting,
          onAnswered: deps.onAnswered,
        }),
    });
  }

  // RUNG 2 — the meeting, if they want one. FIRST among their actual goals, because it is
  // what they rang for; the details are preparation for it.
  if (goals.wantsMeeting) {
    specs.push({
      id: 'book_meeting',
      description: 'Book the appointment the caller asked for.',
      factory: () =>
        makeBookMeetingRung({
          schedulingTools: pick(deps.tools, [
            'get_available_slots',
            'get_service_catalog',
            'book_with_scheduling',
          ]),
          requestedService: requestedService ?? 'a meeting',
          runtimePreamble: [runtimePreamble(deps.runtime), knownCallerLine(deps.state)]
            .filter(Boolean)
            .join(' '),
          knownPhone: deps.state.callerPhone,
          knownName: deps.state.callerName,
          // Fallback so a booking that cannot happen becomes a RECORDED message, never a
          // promise with no tool behind it (the 2026-07-16 dead-end).
          takeMessage: deps.tools['take_message'],
          onBooked: async (r) => {
            // Carry the booked meeting forward — the meeting-context rung reads this at
            // factory time to know whether there IS a meeting to attach anything to.
            // Only a real booking counts; the message fallback books nothing.
            if (r.outcome === 'booked' && r.appointmentId) {
              deps.state.appointmentId = r.appointmentId;
            }
            await deps.onBooked?.(r);
          },
          onMessageTaken: deps.onMessageTaken,
        }),
    });
  }

  // RUNG 3 — MEETING GOALS: the context the meeting needs, chosen by TEMPLATE. AFTER the
  // booking, deliberately: preparation comes after the thing it prepares for. The 'job'
  // template is the intake the prompt ladder kept skipping; the 'default' template is one
  // light wrap-up question whose answer lands on the appointment as notes. Either way,
  // as a registered task the loop will not end without it.
  if (goals.hasJobInquiry || goals.wantsMeeting) {
    const template: MeetingContextTemplate = goals.hasJobInquiry ? 'job' : 'default';
    specs.push({
      id: 'meeting_context',
      description:
        template === 'job'
          ? 'Collect the role details and record them for the owner.'
          : 'Collect anything the caller wants noted ahead of the meeting.',
      factory: () =>
        makeMeetingContextRung({
          template,
          messagingTools: pick(deps.tools, ['capture_job_inquiry']),
          notesTool: deps.tools['attach_meeting_notes'],
          takeMessage: deps.tools['take_message'],
          knownCaller: knownCallerLine(deps.state),
          knownName: deps.state.callerName,
          // What ACTUALLY happened, not what was asked for: the factory runs after the
          // booking rung, so a booking that fell back to a message reads as no meeting —
          // the job opener stops claiming "you're booked in" when nothing was booked,
          // and the notes question is skipped entirely (no meeting to note against).
          meetingBooked: Boolean(deps.state.appointmentId),
          onCaptured: deps.onCaptured,
          onMessageTaken: deps.onMessageTaken,
        }),
    });
  }

  // RUNG 4 — take a message, if they want one. The universal catch-all: a need that a
  // booking or a role does not cover still gets handled, by recording a message. Placed
  // AFTER book + intake, mirroring the composed-script order (take_message is the ELSE rung
  // after the vertical intake). As a registered task the loop will not end without the
  // take_message write — the exact fix for the ladder narrating the save without doing it.
  if (goals.wantsToLeaveMessage) {
    specs.push({
      id: 'take_message',
      description: 'Record a message from the caller for the owner.',
      factory: () =>
        makeTakeMessageRung({
          messagingTools: pick(deps.tools, ['take_message']),
          knownCaller: knownCallerLine(deps.state),
          knownName: deps.state.callerName,
          onMessageTaken: deps.onMessageTaken,
        }),
    });
  }

  // RUNG 5 — change an EXISTING appointment, if they came to cancel or reschedule. It reads
  // (get_my_appointments) then mutates; a manage call has three honest endings, so the rung
  // carries three completions (see schedulingTask). Placed last: it concerns an appointment
  // that already exists, independent of anything booked or briefed on this call.
  if (goals.wantsScheduleChange) {
    specs.push({
      id: 'schedule_change',
      description: 'Cancel or reschedule an existing appointment for the caller.',
      factory: () =>
        makeSchedulingRung({
          manageTools: pick(deps.tools, [
            'get_my_appointments',
            'cancel_appointment',
            'reschedule_appointment',
            'get_available_slots',
          ]),
          knownCaller: knownCallerLine(deps.state),
          runtimePreamble: runtimePreamble(deps.runtime),
          onChanged: deps.onScheduleChanged,
        }),
    });
  }

  return specs;
}

/**
 * Assemble a real TaskGroup from a plan.
 *
 * Thin on purpose: the interesting decisions are all in planCallTasks (which is tested on
 * its own); this just registers them in order. The TaskGroup's own onEnter loop then does
 * the guaranteeing — it pops every registered task and only completes when the stack is
 * empty, in host code the model cannot reach.
 */
export function buildCallTaskGroup(specs: TaskSpec[]): beta.TaskGroup {
  const group = new beta.TaskGroup();
  for (const spec of specs) {
    group.add(spec.factory, { id: spec.id, description: spec.description });
  }
  return group;
}
