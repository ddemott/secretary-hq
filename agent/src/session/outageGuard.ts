/**
 * Decide when a call is beyond saving and the caller should be told so.
 *
 * THE CALL THIS EXISTS FOR (2026-07-21 08:56). OpenAI returned
 * `insufficient_quota`. The session raised SEVEN consecutive errors. The caller
 * heard the greeting, then nothing at all — "Hello?… can you hear me?" — and
 * hung up. Every recovery path was starved by the same outage:
 *
 *   - the watchdog's queue probe saw the errored generation's doomed speech
 *     handle and concluded audio was imminent, so it skipped its hold lines;
 *   - the silent-turn nudge is itself a `generateReply`, so it 429'd too — and
 *     asynchronously, so its catch never fired;
 *   - the canned escalation needed a SECOND silent death, which got deferred
 *     because the caller was talking.
 *
 * The lesson is structural: **every fallback that runs through the LLM fails in
 * exactly the situation a fallback is for.** So this guard watches the session's
 * own error event, counts, and hands back a decision. The line it triggers is
 * played from the pre-synthesized cache — no model, no tool call, no network
 * beyond the audio already in memory.
 *
 * Kept as pure logic with no session handle so it can be tested without a
 * LiveKit runtime; index.ts owns the playback and the close.
 */

/**
 * Consecutive session errors, with no successful agent speech in between,
 * before the caller is told the call is broken.
 *
 * TWO, not one: a single transient error is genuinely survivable and the model
 * often recovers on the next turn, so tripping at one would end salvageable
 * calls. Not seven — that is what the caller actually sat through, and it is
 * far past the point where anyone stays on the line.
 */
export const OUTAGE_ERROR_LIMIT = 2;

export interface OutageGuardState {
  consecutiveErrors: number;
  tripped: boolean;
}

export function createOutageGuard(): OutageGuardState {
  return { consecutiveErrors: 0, tripped: false };
}

export interface NoteSessionErrorOptions {
  /**
   * The error cannot clear by waiting (empty provider balance, rejected key —
   * see sessionError.ts). Trip on THIS error rather than the second: the SDK
   * retries a 429 three times over ~4s, and a second error would only arrive
   * after that — while the failing generation still holds the speech queue, so
   * the outage line could not play. 2026-09-18, SCL_MFD3o5QRKQJB: the caller sat
   * through ~5s of silence and a false "I can take a message" offer waiting for
   * a verdict the first response had already delivered.
   */
  fatal?: boolean;
}

/**
 * Record a session error. Returns true when the caller should now be told the
 * call is broken — and only ever returns true ONCE per call, because the
 * outage line is followed by a close and a second one would talk over it.
 */
export function noteSessionError(
  state: OutageGuardState,
  opts: NoteSessionErrorOptions = {}
): boolean {
  if (state.tripped) return false;
  state.consecutiveErrors += 1;
  if (!opts.fatal && state.consecutiveErrors < OUTAGE_ERROR_LIMIT) return false;
  state.tripped = true;
  return true;
}

/**
 * Record that the agent successfully produced speech.
 *
 * This is what makes the count CONSECUTIVE rather than cumulative, and the
 * distinction is the difference between a guard and a nuisance: a long, healthy
 * call that hits one blip in minute two and another in minute nine is not an
 * outage, and hanging up on that caller would be a worse bug than the one this
 * fixes.
 */
export function noteAgentSpoke(state: OutageGuardState): void {
  if (state.tripped) return;
  state.consecutiveErrors = 0;
}
