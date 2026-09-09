/**
 * IS A TOOL ACTUALLY RUNNING RIGHT NOW?
 *
 * The watchdog needs to know, and until now it could not. It fires whenever the
 * agent has been 'thinking' for a couple of seconds with no audio — which is
 * cause-agnostic ON PURPOSE, and right: dead air is dead air whatever produced it.
 *
 * But WHAT IT SAYS was not cause-agnostic. It said:
 *
 *     "One moment while I check that for you."
 *
 * On the 2026-07-14 call it said that SEVEN TIMES, and the tools on that call ran
 * in 3 to 15 MILLISECONDS. Nothing was ever being checked. The agent was just slow
 * to think, and the runtime announced a lookup that was not happening. The caller
 * heard it, believed it, and asked — twice — "what are you checking?" and "what am
 * I waiting for?"
 *
 * That is the same defect this whole week has been about, wearing a different coat.
 * I removed the prompt line that let the MODEL claim work it had not done, and then
 * shipped a runtime that claims work IT is not doing. A machine lying on a schedule
 * is still lying.
 *
 * So the hold line becomes honest: say "let me check" only when there is genuinely
 * something being checked, and otherwise just ask for a moment. This module is how
 * the watchdog knows the difference.
 *
 * Deliberately a module-level counter and not a class: there is exactly one agent
 * session per worker process (LiveKit forks a job process per call), so there is
 * nothing to isolate, and threading an instance through wrapTool → buildTools →
 * every tool would be plumbing for its own sake.
 */

let inFlight = 0;
let messageTaken = false;

/** A tool's execute() has started. */
export function toolStarted(): void {
  inFlight += 1;
}

/** A tool's execute() has finished — success, failure, or timeout. */
export function toolFinished(): void {
  // Never below zero: a double-decrement (a timeout racing a late resolve) would
  // otherwise poison the count for the rest of the call, and a NEGATIVE count reads
  // as "no tool running" forever after — silently returning us to the lying line.
  inFlight = Math.max(0, inFlight - 1);
}

/** True while at least one tool is actually executing. */
export function isToolRunning(): boolean {
  return inFlight > 0;
}

/**
 * THE RECOVERY LINE OFFERED A MESSAGE TO SOMEONE WHO HAD JUST LEFT ONE.
 *
 * 2026-09-09, call SCL_A5wnBexPbwCC, at 4:14: the caller had finished a full job
 * intake, `take_message` had already returned, and the watchdog's deadline-2 line
 * said "Sorry, this is taking me a moment. If you'd like, I can take a message and
 * have someone get right back to you." He answered "No. No message. Just pass this
 * on." The dead air was real — the model was slow composing its wrap-up — so firing
 * was correct. The OFFER was not: it proposed the one thing already done.
 *
 * Same rule as the hold line above it: the line the runtime speaks has to be true
 * at the moment it plays. Once a message exists, the recovery line stops offering
 * to take one and just asks for the beat it actually needs.
 */
export function markMessageTaken(): void {
  messageTaken = true;
}

/** True once this call has successfully recorded a message for the owner. */
export function wasMessageTaken(): boolean {
  return messageTaken;
}

/**
 * Clear both flags for a NEW CALL. Called from `entry()` before anything else.
 *
 * WHY THIS EXISTS (Copilot review, PR #409): this module's state is module-level
 * — deliberately, since one agent session runs per job process — but "one session
 * per process" is not the same claim as "one process per session". The SDK keeps
 * idle job processes warm (`numIdleProcesses`), and a process that outlives its
 * job carries these values into the next caller.
 *
 * What that costs if it is true: `messageTaken` never falls back to false, so
 * every later call on that process gets the after-message recovery line and is
 * NEVER offered a message — the exact fix inverted into a new defect, on a caller
 * who has left nothing. `inFlight` is the same shape and predates it: a tool still
 * in flight when a call drops leaves the count above zero forever, and the hold
 * line goes back to claiming a lookup that is not happening.
 *
 * Resetting at the start of a call is correct whether or not processes are reused,
 * costs two assignments, and removes the question entirely.
 */
export function resetCallActivity(): void {
  inFlight = 0;
  messageTaken = false;
}

/** Test seam — reset between cases. */
export function _resetToolActivityForTest(): void {
  resetCallActivity();
}
