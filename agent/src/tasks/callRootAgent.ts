/**
 * THE RUNNER — where the whole architecture actually runs as one call.
 *
 * Everything else in tasks/ is a piece. This is the assembly: a root Agent that greets,
 * works out what the caller wants, and then hands the call to the TaskGroup — which pops
 * every rung and cannot reach its end with a goal unmet.
 *
 * WHY A ROOT AGENT AND NOT JUST A GROUP. The research was specific: build the group AFTER
 * an intent step returns the caller's goals, because the group's task stack is snapshotted
 * when it starts. So the root agent IS the intent step. It has exactly one tool,
 * begin_call — the model calls it once it understands the ask, with booleans for each
 * goal. Inside that tool (a valid context for AgentTask.run()) we build the plan from
 * those goals and run the group. When the group returns, every rung is done, and the root
 * agent closes.
 *
 * The model's ONLY job at the top of the call is to classify: does this person want a
 * meeting? do they have a role to brief us on? That is a narrow judgement it is reliably
 * good at — reading one sentence and ticking boxes — as opposed to the thing it is bad at
 * and we have watched it fail all week: sequencing a five-step call over four minutes
 * without dropping a step. The sequencing is now the loop's job, in host code.
 *
 * Nothing here is wired into index.ts yet by default — it runs only under
 * ENABLE_TASK_GROUP, alongside the existing agent, so a real call can be made through it
 * without disturbing the one that answers the phone today.
 */
import { llm, voice } from '@livekit/agents';
import { sanitizeStream } from '../speechSanitizer.js';
import { getLogger } from '../logger.js';
import type { SessionContext } from '../sessionContext.js';
import {
  planCallTasks,
  buildCallTaskGroup,
  type CallDeps,
  type CallRuntime,
  type CallState,
} from './callPlan.js';
import { sanitizeVolunteered } from './sanitize.js';
import type { IdentityResult } from './identityTask.js';
import type { BookMeetingResult } from './bookMeetingTask.js';
import type { JobIntakeResult } from './jobIntakeTask.js';
import type { TakeMessageResult } from './takeMessageTask.js';
import type { ScheduleChangeResult } from './schedulingTask.js';
import type { ToolMap } from '../tools.js';

export interface CallRootOptions {
  ctx: SessionContext;
  /** The full ToolContext from buildTools() — the rungs take the slices they need. */
  tools: ToolMap;
  /** The tenant's persona line, so the greeting/identity sound like the business. */
  persona: string;
  /** Date + hours the rungs must not guess. */
  runtime: CallRuntime;
  onIdentified?: (r: IdentityResult) => Promise<void> | void;
  onBooked?: (r: BookMeetingResult) => Promise<void> | void;
  onCaptured?: (r: JobIntakeResult) => Promise<void> | void;
  onMessageTaken?: (r: TakeMessageResult) => Promise<void> | void;
  onScheduleChanged?: (r: ScheduleChangeResult) => Promise<void> | void;
}

export class CallRootAgent extends voice.Agent {
  #opts: CallRootOptions;
  // THE LOOP-BACK (roadmap step 3, commissioned by Dale 2026-07-18). begin_call
  // may fire more than once: each firing plans a group for the NEW goals, with
  // identity carried over in #state (planCallTasks skips the identity rung when
  // the state already holds a confirmed name + number). Capped so a confused
  // model cannot ask "anything else?" forever.
  #rounds = 0;
  static readonly #MAX_ROUNDS = 3;
  // Shared across rounds ON PURPOSE: the identity rung writes it in round 1 and
  // every later round's rungs (and the goodbye) read it.
  #state: CallState = {};

  constructor(opts: CallRootOptions) {
    super({
      instructions: `${opts.persona}

You are at the very start of a call. Your ONE job is to work out what the caller wants and hand off by calling begin_call. After you hand off, the system automatically takes their name and number and then handles whatever they rang for — the booking, the message, the job details, the schedule change. ALL of it happens after the hand-off; NONE of it is yours to do.

The moment the caller tells you why they called, your very next action is to CALL begin_call — a tool call, not a reply. Do not answer their request with a question; the ONLY correct response to "I'd like to book / leave a message / cancel" is the begin_call tool call. (If they have not said why they are calling yet, ask "how can I help?" and listen; the instant they answer, call begin_call.)

This applies to a MESSAGE exactly as much as a booking: you never take the message yourself — begin_call with wants_to_leave_message=true is how the message gets taken. If you catch yourself asking for their name, their number, or what the message is, you have skipped the hand-off: call begin_call instead.

As soon as you know what they are calling about, call begin_call with:
- wants_meeting: true if they want to make a NEW appointment, meeting, call, viewing or demo — even mentioned in passing.
- has_job_inquiry: true ONLY if they are bringing a job, role, contract position, or hiring opportunity TO the owner — a recruiter, staffing agency, or someone pitching work for the owner to take or a position to fill. A caller asking the BUSINESS to come do work for THEM (fix, repair, build, install, look at something) is a service request — that is wants_meeting, NOT has_job_inquiry, even if they call it "a job".
- wants_schedule_change: true if they want to CANCEL or RESCHEDULE an appointment they ALREADY have.
- wants_to_leave_message: true if they want to leave a message, have the owner call them back, or pass something along that is not a booking or a role.
- has_questions: true if they are asking about the business — hours, pricing, services, policies, location, or anything else factual.
- requested_service: their OWN WORDS for what they want ("a meeting about a contract role", "a call with the owner"). Leave blank if unclear.
- caller_name / caller_phone: ONLY if the caller has already stated their own name or number this call, pass them along exactly as spoken — a caller who says "I'm Sam" and is then asked "can I get your name?" has just learned nobody was listening. Do not ask for either; just relay what was volunteered.

When in doubt, say YES to a goal — it is far better to ask an extra question later than to miss what they rang for. If a caller says "I'd like a meeting to talk about a job", that is BOTH: wants_meeting=true AND has_job_inquiry=true. "I need to move my appointment" is wants_schedule_change=true. Booking a NEW time is wants_meeting; changing an EXISTING one is wants_schedule_change — a reschedule is the latter. "I'd like to leave a message" or "tell the owner…" is wants_to_leave_message=true — even if the message mentions a job or a callback, leaving a message is the goal, so set wants_to_leave_message (not has_job_inquiry) unless they also clearly want the role briefed for a meeting. "What are your hours?" or "how much do you charge?" is has_questions=true — and a caller who ONLY has questions gets answers immediately, without being asked for a name or number first, so classify it and hand off just as fast. The doubt rule does not manufacture job inquiries: "can someone come fix my computer" is wants_meeting=true and has_job_inquiry=false — the "job" there is the work they want done, not a role for the owner.

Do not try to book, or take details, or collect their name yet. Just understand the ask and call begin_call. Everything after that is handled for you.

# After the work is done
When begin_call's result tells you everything the caller asked for is DONE, your job CHANGES — nothing from the start of the call is yours to redo. Invite once in a falling tone: "Tell me if you need anything else." Then:
- They raise something NEW → your very next action is to CALL begin_call again with the new goals. Their name and number are already on file — NEVER ask for either again.
- They say no / that's all / thank you → your very next action is to CALL finish_call. finish_call speaks the goodbye — do not say goodbye yourself, and do not ask anything further.`,
      tools: {
        begin_call: llm.tool({
          description:
            'Call this ONCE you understand what the caller wants. It starts handling their request. Pass a boolean for each kind of goal and their own words for the service.',
          parameters: {
            type: 'object',
            properties: {
              wants_meeting: {
                type: 'boolean',
                description: 'They want an appointment/meeting/call/viewing/demo.',
              },
              has_job_inquiry: {
                type: 'boolean',
                description:
                  'They are bringing a job/role/position TO the owner (recruiting, staffing, hiring). False for a caller asking the business to do work for them — that is a service request (wants_meeting).',
              },
              wants_schedule_change: {
                type: 'boolean',
                description:
                  'They want to CANCEL or RESCHEDULE an appointment they already have (not book a new one).',
              },
              wants_to_leave_message: {
                type: 'boolean',
                description:
                  'They want to leave a message for the owner, have the owner call them back, or pass something along that is not a booking or a role.',
              },
              has_questions: {
                type: 'boolean',
                description:
                  'They are asking about the business: hours, pricing, services, policies, location, or anything factual.',
              },
              requested_service: {
                type: 'string',
                description: "The caller's own words for what they want, for the service matcher.",
              },
              caller_name: {
                type: 'string',
                description:
                  'ONLY if the caller stated their own name this call ("I\'m Sam", "this is Sue Smith") — pass it exactly as they said it. Never guess, never fill from anything but their words.',
              },
              caller_phone: {
                type: 'string',
                description:
                  'ONLY if the caller spoke a phone number for themselves this call — pass the digits exactly as they said them. Never guess.',
              },
            },
            required: ['wants_meeting', 'has_job_inquiry'],
          },
          execute: async (args: {
            wants_meeting: boolean;
            has_job_inquiry: boolean;
            wants_schedule_change?: boolean;
            wants_to_leave_message?: boolean;
            has_questions?: boolean;
            requested_service?: string;
            caller_name?: string;
            caller_phone?: string;
          }): Promise<string> => this.#runGroup(args),
        }),
        finish_call: llm.tool({
          description:
            "Call when the caller has nothing further ('no thanks', 'that's all'). Speaks the goodbye and ends the call. Only valid AFTER begin_call reported the work done.",
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          execute: async (): Promise<string> => this.#finishCall(),
        }),
      },
    });
    this.#opts = opts;
  }

  // No onEnter greeting on purpose: index.ts speaks the tenant's PRE-GENERATED greeting
  // (zero TTS latency, the right voice), then the caller answers, and begin_call fires on
  // that first turn. Greeting here too would double it.

  async #runGroup(goals: {
    wants_meeting: boolean;
    has_job_inquiry: boolean;
    wants_schedule_change?: boolean;
    wants_to_leave_message?: boolean;
    has_questions?: boolean;
    requested_service?: string;
    caller_name?: string;
    caller_phone?: string;
  }): Promise<string> {
    // Rounds are capped, not forbidden (this used to hard-refuse a second
    // begin_call — the "snapshotted stack" limit, retired 2026-07-18 by the
    // loop-back). At the cap, end the call instead of looping forever.
    this.#rounds += 1;
    if (this.#rounds > CallRootAgent.#MAX_ROUNDS) {
      getLogger().warn(
        { event: 'task_group_round_cap' },
        `begin_call fired more than ${CallRootAgent.#MAX_ROUNDS} times — closing the call`
      );
      return this.#finishCall();
    }

    const state = this.#state; // round 1 fills it; later rounds reuse it
    // Volunteered identity facts survive the hand-off: each rung is its own agent, so a
    // name spoken in the opener is invisible to the identity rung unless carried here.
    // Confirmed values always win; volunteered ones only fill gaps.
    // Sanitized at the choke point: these strings are caller-derived and get
    // interpolated into rung PROMPTS downstream — flatten and cap before they
    // enter shared state (review on #289).
    const volunteeredName = sanitizeVolunteered(goals.caller_name, 80);
    const volunteeredPhone = sanitizeVolunteered(goals.caller_phone, 30);
    if (volunteeredName && !state.callerName) {
      state.volunteeredName = volunteeredName;
    }
    if (volunteeredPhone && !state.callerPhone) {
      state.volunteeredPhone = volunteeredPhone;
    }
    const deps: CallDeps = {
      ctx: this.#opts.ctx,
      runtime: this.#opts.runtime,
      state,
      tools: this.#opts.tools,
      onIdentified: this.#opts.onIdentified,
      onBooked: this.#opts.onBooked,
      onCaptured: this.#opts.onCaptured,
      onMessageTaken: this.#opts.onMessageTaken,
      onScheduleChanged: this.#opts.onScheduleChanged,
    };
    const specs = planCallTasks(
      {
        wantsMeeting: goals.wants_meeting,
        hasJobInquiry: goals.has_job_inquiry,
        wantsScheduleChange: goals.wants_schedule_change ?? false,
        wantsToLeaveMessage: goals.wants_to_leave_message ?? false,
        hasQuestions: goals.has_questions ?? false,
        requestedService: goals.requested_service,
      },
      deps
    );

    getLogger().info(
      { event: 'task_group_start', rungs: specs.map((s) => s.id) },
      `task group starting — ${specs.length} rungs: ${specs.map((s) => s.id).join(' → ')}`
    );

    const group = buildCallTaskGroup(specs);
    // THE HANDOFF. run() blocks until the loop pops every rung. It is awaited inside this
    // tool's execute — a valid AgentTask context — so the sub-tasks can take over the
    // session in turn. When it resolves, every goal the caller stated is DONE, with a
    // tool result to prove each one.
    const result = await group.run();

    getLogger().info(
      { event: 'task_group_done', completed: Object.keys(result.taskResults) },
      `task group complete — every rung done: ${Object.keys(result.taskResults).join(', ')}`
    );

    // THE LOOP-BACK (2026-07-18, Dale: "it should have asked, is there anything
    // else"). Control now returns to the root agent ON PURPOSE — but through
    // the narrow door gotcha H demands: this tool result IS the phase change.
    // The model is told the work is done, told the one question to ask, and
    // told its only two next actions are tools (begin_call again, or
    // finish_call — which owns the fixed goodbye). Identity persists in #state,
    // so a second round's plan SKIPS the identity rung and re-collection —
    // gotcha H's original failure — is structurally off the table.
    const doneName = (state as { callerName?: string }).callerName;
    return [
      `EVERYTHING THE CALLER ASKED FOR IS DONE (completed: ${Object.keys(result.taskResults).join(', ')}).`,
      doneName ? `The caller is ${doneName}; their number is on file.` : '',
      `Your job has CHANGED (see "# After the work is done"). Tell the caller: "Tell me if you need anything else." and WAIT for their answer.`,
      `A NEW request → CALL begin_call with the new goals (never re-ask their name or number).`,
      `"No" / "that's all" / thanks → CALL finish_call. Do not say goodbye yourself — finish_call says it.`,
    ]
      .filter(Boolean)
      .join(' ');
  }

  /** The fixed, definitive goodbye + close — no LLM generation, no question
   *  that invites more. Owned by a TOOL so "nothing else, thanks" has an
   *  ACTION to complete the call with, exactly like every other rung exit. */
  async #finishCall(): Promise<string> {
    const name = this.#state.callerName;
    const goodbye = name
      ? `You're all set, ${name}. Thanks for calling.`
      : `You're all set. Thanks for calling.`;
    try {
      await this.session.say(goodbye, { allowInterruptions: false }).waitForPlayout();
    } catch {
      /* if say fails, still close — a silent hangup beats a re-collection loop */
    }
    await this.session.close();
    return 'Call complete.';
  }

  // MARKDOWN MUST NEVER REACH THE VOICE — the same guarantee SpeakingAgent gives the main
  // path. The task-group path is plain voice.Agent, so without this a model that answers
  // with a bulleted summary ("- Caller Company: ABC") gets its dashes and newlines read
  // straight to Deepgram, which collapses them into one flat run with no pauses. That is
  // the "it ran the lines together" report from the first successful voice call.
  override async ttsNode(
    text: ReadableStream<string>,
    modelSettings: Parameters<typeof voice.Agent.default.ttsNode>[2]
  ): ReturnType<typeof voice.Agent.default.ttsNode> {
    return voice.Agent.default.ttsNode(this, sanitizeStream(text), modelSettings);
  }
}
