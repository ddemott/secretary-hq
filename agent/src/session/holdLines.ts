/**
 * THE LINES THE RUNTIME SPEAKS SO THE CALLER IS NEVER LEFT IN SILENCE.
 *
 * These are the ONLY hold lines in the product, and they exist here — as data,
 * in one place — for two reasons.
 *
 * 1. THE MODEL MUST NOT BE THE ONE STALLING. The system prompt used to instruct
 *    the agent to "lead with 'one moment while I look that up...'" before a slow
 *    tool. It obeyed — and then never called the tool. On 2026-07-13 it said that
 *    sentence three times in one call and performed no work at all, because the
 *    sentence SATISFIED the instruction and a tool call is work. A hold line the
 *    MODEL speaks is an action it can fake. A hold line the RUNTIME speaks is a
 *    fact: it plays because a tool really is taking time, and a timer cannot lie
 *    about work it did not do.
 *
 * 2. THEY WERE DUPLICATED AS STRING LITERALS, and that is a silent failure.
 *    watchdog.ts looks the audio up in the filler cache BY THE TEXT ITSELF —
 *    getFillerFrame(voice, text) is a keyed lookup. index.ts warmed the cache with
 *    one copy of the string and the watchdog spoke another. They happened to
 *    match. Change a comma in one and nothing breaks loudly: the cache MISSES, the
 *    watchdog silently falls back to live TTS, and the very latency the
 *    pre-synthesis exists to remove comes back — on the line whose entire job is
 *    to cover latency. One definition, imported everywhere, so that cannot happen.
 *
 * Pre-synthesized (fillerCache) so the hold line itself costs ZERO TTS latency.
 * A hold line you have to wait for is not a hold line.
 */

/** Deadline 1, and a TOOL IS ACTUALLY RUNNING: name what is happening. */
export const HOLD_LINE = 'One moment while I check that for you.';

/**
 * Deadline 1, and NO tool is running — the agent is merely slow to think.
 *
 * It must not claim a lookup. On 2026-07-14 the watchdog said "one moment while I
 * check that for you" SEVEN times on a call whose tools all returned in under 15ms.
 * Nothing was being checked. The caller asked, twice, "what are you checking?" and
 * "what am I waiting for?" — because he could tell it was not true.
 *
 * This is the same defect as the prompt line I deleted for letting the MODEL claim
 * work it had not done. I replaced it with a RUNTIME that claimed work IT was not
 * doing. A machine lying on a timer is still lying. So this line asks for a beat and
 * asserts nothing.
 */
export const THINKING_LINE = 'Just a moment.';

/** Deadline 2 (~4s, still nothing): stop pretending, offer a way out. */
export const RECOVERY_LINE =
  "Sorry, this is taking me a moment. If you'd like, I can take a message and have someone get right back to you.";

/**
 * Deadline 2, but a message HAS already been taken on this call.
 *
 * 2026-09-09, call SCL_A5wnBexPbwCC at 4:14: the caller had just completed a full
 * job intake and `take_message` had returned. The line above played anyway and
 * offered to take a message. He said "No. No message. Just pass this on." The dead
 * air was genuine, so firing was right — the OFFER was the lie, because the thing
 * being offered was already done.
 *
 * A recovery line is only worth speaking if it offers the caller something they do
 * not already have. Once the message exists, all that is left to be honest about is
 * the wait itself.
 */
export const RECOVERY_LINE_AFTER_MESSAGE =
  "Sorry — still writing that up. One more moment and I'll have it.";

/**
 * Spoken when a TOOL fails outright (timeout / throw / empty) — wrapTool.ts hands
 * this to the model as the tool's result, so the caller hears a graceful offer
 * instead of a stack trace or silence. Lives here for the same cache-key reason:
 * it is pre-synthesized too, and a drifted copy would miss the cache.
 */
export const TOOL_FALLBACK_LINE =
  "Sorry, I'm having a little trouble with that right now. Would you like me to take a message and have someone get back to you?";

/**
 * Spoken when the CALLER has gone quiet — not the agent (2026-08-01).
 *
 * Four calls on 2026-07-27 held 13-42 seconds of silence after the greeting and
 * said nothing at all into it; one was a caller who had been told to ring back at
 * that exact time and was waiting for a human (CALL_IMPROVEMENTS.md #5, #6).
 *
 * It offers the two things that are always true on this line — a message and a
 * booking — because "are you still there?" on its own gives a hesitating caller
 * nothing to grab. It promises no transfer, since there is none.
 */
export const CALLER_CHECK_IN_LINE =
  'Are you still there? I can take a message or set up a time — whichever is easier.';

/** Spoken as the call ends after the caller never answered the check-in. */
export const CALLER_SILENCE_GOODBYE =
  "I'll let you go for now — do call back any time and I'll be glad to help.";

/**
 * Spoken when the call itself is broken — the LLM provider is erroring and no
 * generated speech is coming (2026-07-21 08:56: OpenAI returned
 * `insufficient_quota`, the session raised seven consecutive errors, and the
 * caller heard the greeting and then NOTHING; "Hello?… can you hear me?", then
 * a hang-up).
 *
 * THIS LINE MUST NEVER DEPEND ON THE LLM, which is the whole point: every other
 * recovery path on this call is itself a `generateReply`, so when the model is
 * the thing that is down, each of them dies the same way and the caller gets
 * silence. It is pre-synthesized with the rest of HOLD_LINES and played from the
 * cache, so it works precisely when nothing else does.
 *
 * It says what is true and nothing more. No promise to call back — the agent
 * cannot dial out — and no offer to take a message, because taking a message
 * needs a tool round-trip through the very stack that is failing. Asking the
 * caller to try again shortly is the only thing this code can actually honour.
 */
export const OUTAGE_LINE =
  "I'm having some technical trouble on my end. Please try calling back in a few minutes — I'm sorry about that.";

/**
 * Every fixed line worth pre-synthesizing per tenant voice, minus the greeting
 * (which is tenant-specific and warmed alongside these at call start).
 */
export const HOLD_LINES = [
  HOLD_LINE,
  THINKING_LINE,
  RECOVERY_LINE,
  RECOVERY_LINE_AFTER_MESSAGE,
  TOOL_FALLBACK_LINE,
  CALLER_CHECK_IN_LINE,
  CALLER_SILENCE_GOODBYE,
  OUTAGE_LINE,
] as const;
