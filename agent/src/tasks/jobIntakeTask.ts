/**
 * RUNG 3 — THE JOB INTAKE. THE RUNG THAT KEEPS GETTING SKIPPED.
 *
 * This is the whole reason the spike exists. In the prompt-based ladder this rung was a
 * paragraph, and the model skipped it — booked the meeting and hung up without ever
 * asking what the job was, twice, on real calls. As a task it CANNOT be skipped: the
 * TaskGroup loop registered it, the loop is host code, and the loop does not reach its
 * end until this task's complete() fires.
 *
 * Same shape as BookMeetingTask: the RECORDING is the transition. There is no "finish
 * intake" tool for the model to skip or fake. capture_job_inquiry is reused untouched —
 * two-companies logic, the refuse-without-name-or-number gate, the real email to the
 * owner — and wrapped only to notice success: when it returns a job_inquiry_id, the task
 * completes.
 *
 * The refuse gate matters here and works WITH the loop, not against it: if the caller has
 * not given a name and number, capture_job_inquiry refuses, this task stays open, and the
 * model is told to go get what is missing. Since identity always runs FIRST (see
 * callPlan), that should already be in hand — but the belt-and-braces is real: a lead the
 * owner cannot answer never gets recorded as "done".
 */
import { type voice } from '@livekit/agents';
import { makeRung, idExtractor } from './rung.js';
import type { ToolMap } from '../tools.js';

export interface JobIntakeResult {
  /** 'captured' when a real job_inquiries row landed; 'not_a_job' when the
   *  intent step over-counted and the caller has no role to discuss (the
   *  escape hatch); 'message' when the caller preferred to leave a message
   *  mid-intake and one was really recorded (the same honest fallback the
   *  booking and notes rungs carry). */
  outcome: 'captured' | 'not_a_job' | 'message';
  /** Present when outcome is 'captured'. */
  jobInquiryId?: string;
  /** Present when outcome is 'message'. */
  messageId?: string;
  raw?: unknown;
}

export interface JobIntakeTaskOptions {
  /** The messaging tools from buildTools() — must include capture_job_inquiry. */
  messagingTools: ToolMap;
  /** The caller identity from the identity rung — capture_job_inquiry refuses without a
   *  name and number, and both were already collected. */
  knownCaller?: string;
  /** Was a meeting booked before this rung? Controls the opener — on a JOB-ONLY call there
   *  is no booking, so "you're booked in" would be a lie (the E2E caught it). */
  meetingBooked?: boolean;
  /** take_message — the mid-intake fallback (2026-07-18, Dale: "can someone ask
   *  just to leave a message instead?"). A caller who would rather leave a
   *  message than answer the role questions gets a REAL write, not a refusal —
   *  the same honest fallback the booking and notes rungs already carry. */
  takeMessage?: ToolMap[string];
  onCaptured?: (r: JobIntakeResult) => Promise<void> | void;
  onMessageTaken?: (r: { messageId: string; raw: unknown }) => Promise<void> | void;
}

/**
 * The intake questions. These MIRROR the intake_job_inquiry script block
 * (src/services/scripts/blocks.ts) — the block is the source of truth for the prompt
 * ladder, and this string is its task-shaped twin. If the spike wins, one of them
 * becomes generated from the other; for now they are kept deliberately identical so the
 * two paths ask the same questions in the same order.
 */
export const JOB_INTAKE_INTRO_BOOKED = `You have booked the meeting. NOW take the details of the role, so the owner can come to it prepared. Open with something like: "Great — you're booked in. While I have you, let me grab a few details about the role."`;
export const JOB_INTAKE_INTRO_NO_BOOKING = `The caller wants to pass a role to the owner (no meeting was booked). Take the details so the owner has them. Open with something like: "Sure — let me grab a few details about the role so I can pass them along."`;

export const JOB_INTAKE_INSTRUCTIONS = `FIRST, one check that outranks everything below: if the caller says — or has already said — that this is NOT about a job, a role, or hiring ("no, this is for fixing my computer", "I'm not calling about a job"), your VERY NEXT action is to CALL not_a_job. Never insist on the role questions, never explain that you "only handle job inquiries", never refuse what they actually asked for. The routing step deliberately over-counts jobs; this exit is how a mistaken route costs one sentence instead of the whole call. (A live caller who wanted a computer repair was interrogated about companies and rates, asked to leave a message, was told "I can't take messages", and hung up — every one of those sentences was the absence of this exit.)

If at ANY point they would rather just leave a message than answer the questions ("just have him call me", "can you pass it along instead", "I don't have time for this") — your VERY NEXT action is to CALL take_message with their name and what they want passed on. Never refuse a message, and never say you can't take one: calling take_message IS taking one, and it finishes this step.

Otherwise: take the details of the role so the owner can come prepared. You already have the caller's name and number — do NOT ask again.

Then work these questions ONE AT A TIME. Skip any they have already answered. Acknowledge each answer before the next.

THERE ARE TWO SEPARATE COMPANIES and you must keep them apart. Never ask a bare "what company?".
- caller_company = the company the CALLER works for — their own employer or staffing agency. ALWAYS ask "And which company are you calling from?" and record their answer as caller_company. Ask this EVEN IF they have already named a client, because the client is a DIFFERENT company. The client's name NEVER goes in caller_company — if the only company you have heard so far is the one the work is for, you still need to ask who THEY work for.
- "I can note this as hiring for your own company, or as placing someone with a client. Tell me which."
  - Placing with a client → "Which company would the work actually be for?" → that answer is client_company, and it is a different company from caller_company. represents_company = false.
  - Their own company → the work is at their own company, so client_company is the SAME as caller_company. represents_company = true. Do NOT ask which company the work is for — they told you.
- "Is this a contract position or full time?"
  - Contract → "What rate range?" and "What length of contract?"
  - Full time → "What salary range?"
- "Is this onsite, remote, or hybrid?"
  - Onsite/hybrid → "What is the address of the position?"
  - Remote → "What timezone, so they know the office hours?"

The instant you have the answers, your VERY NEXT action is to CALL capture_job_inquiry — call it BEFORE you say anything back to the caller. Pass employment_type as "contract" or "full_time"; location_type as "onsite", "remote", or "hybrid". Omit anything you did not get. CALLING the tool is the only thing that records the role and finishes this step; a spoken "I've noted that" or "I'll pass that along" records NOTHING and is true only AFTER the tool has run — so run it first, then say it. If capture_job_inquiry refuses because a name or number is missing, ask for it and call it again.

Only after capture_job_inquiry returns do you confirm out loud, as ONE short natural sentence ("So that's a six-month hybrid contract with Northern Trust, sixty-five to eighty-two an hour — got it, I'll pass that to the owner."). This is a PHONE CALL: no bulleted list, no field-by-field "Caller Company: X, Client Company: Y" summary (it reads aloud as one flat run-on), no dashes, no field labels, no markdown of any kind.`;

/**
 * Rung 3 as an ACTION rung (see rung.ts): the whole point is the capture_job_inquiry
 * write, so the rung ends the instant it returns a job_inquiry_id. The recording IS the
 * transition — there is no "finish intake" tool to skip or fake, which is the exact fix
 * for the rung the prompt ladder kept skipping. capture_job_inquiry's own refuse gate
 * (no name/number) keeps a lead the owner cannot answer from ever recording as "done".
 */
export function makeJobIntakeRung(opts: JobIntakeTaskOptions): voice.AgentTask<JobIntakeResult> {
  const { messagingTools, onCaptured } = opts;

  const realCapture = messagingTools['capture_job_inquiry'];
  if (!realCapture) {
    throw new Error('makeJobIntakeRung requires capture_job_inquiry in messagingTools');
  }

  const intro = opts.meetingBooked ? JOB_INTAKE_INTRO_BOOKED : JOB_INTAKE_INTRO_NO_BOOKING;
  const { capture_job_inquiry: _drop, ...passthrough } = messagingTools;
  void _drop;

  return makeRung<JobIntakeResult>({
    instructions: [opts.knownCaller, intro, JOB_INTAKE_INSTRUCTIONS].filter(Boolean).join('\n\n'),
    tools: passthrough,
    completion: [
      {
        kind: 'action',
        toolName: 'capture_job_inquiry',
        realTool: realCapture,
        extract: idExtractor('job_inquiry_id', (id, raw) => ({
          outcome: 'captured' as const,
          jobInquiryId: id,
          raw,
        })),
        onDone: onCaptured,
      },
      ...(opts.takeMessage
        ? [
            {
              kind: 'action' as const,
              toolName: 'take_message',
              realTool: opts.takeMessage,
              extract: idExtractor('message_id', (id, raw) => ({
                outcome: 'message' as const,
                messageId: id,
                raw,
              })),
              onDone: opts.onMessageTaken
                ? (r: JobIntakeResult) =>
                    opts.onMessageTaken?.({ messageId: r.messageId ?? '', raw: r.raw })
                : undefined,
            },
          ]
        : []),
      {
        // THE ESCAPE HATCH (2026-07-18 live call). An unskippable rung is the
        // architecture's whole point — but a MISPLANNED rung is unskippable
        // too: intent flapped "fix my computer" into has_job_inquiry=true and
        // the caller was trapped in a job interrogation with no way out (and,
        // holding no take_message tool, the model truthfully said "I can't
        // take messages"). Same pattern as the scheduling rung's
        // no_appointment_change and the phase routers' escape doors:
        // narrowing must never remove an exit. With the loop-back live, the
        // recovery is complete: not_a_job pops the rung, the group finishes,
        // "anything else?" fires, and a message request re-enters begin_call.
        kind: 'collect',
        toolName: 'not_a_job',
        description:
          'Call the INSTANT it is clear the caller does NOT have a job or role to discuss — the call was routed here by mistake. Completes this step immediately so the call can move on to what they actually want.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        build: () => ({ outcome: 'not_a_job' as const }),
        ack: 'Understood — moving on.',
      },
    ],
  });
}
