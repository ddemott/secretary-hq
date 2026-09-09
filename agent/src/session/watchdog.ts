/**
 * Turn-output watchdog — the categorical "never silent" guarantee.
 *
 * Cause-agnostic: it watches the OUTPUT, not the cause. After the caller's turn
 * ends (agent enters 'thinking'), it starts a deadline. If no agent audio has
 * started by deadline 1, it plays a cached filler ("one moment…"); if still no
 * audio by deadline 2, it plays a cached recovery line. This catches every
 * dead-air source — slow TTS, a stalled tool, an LLM that says nothing — because
 * it triggers on "no audio by deadline," whatever produced (or failed to
 * produce) it.
 *
 * Safety (validated against @livekit/agents 1.4.5 internals):
 * - `say()` is called from EVENT/TIMER callbacks, never inside a tool's
 *   execute() — that circular-wait pattern is what froze #97 (now guarded by
 *   SpeechHandleCircularWaitError, but we still avoid it).
 * - `mainTask` SERIALIZES the speech queue, so the filler and the real reply
 *   never overlap — the filler plays, then the reply. (That filler→reply
 *   sequence is the intended UX, not the double-speak bug, which only occurs
 *   with preemptiveGeneration — which we do not enable.)
 * - `say()` throws SchedulingPausedError while the session is draining — guarded.
 *
 * Known edge (real-call validation item, not handled here): #3418 — an
 * interruption race can leave the agent in 'speaking' with no audio and no
 * error. The common dead-air cases (TTS gap / tool stall / silent LLM) keep the
 * agent in 'thinking', which this covers; the 'speaking'-but-silent edge is a
 * follow-up once reproduced.
 */
import { voice } from '@livekit/agents';
import { getFillerFrame, frameStream } from './fillerCache.js';
import { isToolRunning, wasMessageTaken } from './toolActivity.js';

/** SpeechHandle (not re-exported by the package) — the return type of say(). */
type SpeechHandle = ReturnType<voice.AgentSession['say']>;

export interface WatchdogOptions {
  /** Tenant voice id (cache key for the pre-synthesized clips). */
  voice: string;
  /** Spoken at deadline 1 when a TOOL IS RUNNING — it may name the lookup. */
  fillerText: string;
  /**
   * Spoken at deadline 1 when NO tool is running (the agent is just slow to think).
   * It must claim nothing: saying "let me check that for you" when there is nothing
   * being checked is a lie the caller can hear, and on 2026-07-14 he called it out
   * mid-call. Both lines are pre-synthesized.
   */
  thinkingText: string;
  /**
   * Recovery line spoken at deadline 2 once a message has ALREADY been taken on
   * this call. Optional; without it the plain recovery line is used, which is
   * what shipped the 2026-09-09 defect of offering a message to a caller who had
   * just left one.
   */
  recoveryTextAfterMessage?: string;
  /** Recovery line spoken at deadline 2. */
  recoveryText: string;
  /** ms of 'thinking' with no audio before the filler plays. */
  deadline1Ms?: number;
  /** ms after the filler with still no real audio before the recovery line. */
  deadline2Ms?: number;
  /** Structured logger (callLog). */
  log: { info: LogFn; warn: LogFn };
  /**
   * Called with each line the watchdog actually plays. Every say() here is
   * addToChatCtx:false ON PURPOSE (hold lines must not pollute the model's
   * context) — but that also kept them out of ConversationItemAdded and thus
   * the TranscriptRecorder, so a call's transcript under-reported what the
   * agent spoke. The 2026-07-27 silent calls (#5/#6, 40s of "nothing" between
   * greeting and hangup) could not show whether dead-air handling ever fired.
   * index.ts wires this straight into the transcript; chat context stays clean.
   */
  onSpoken?: (text: string) => void;

  /**
   * Called once per turn with the same number the `turn_latency_ms` log line
   * carries (T-006). The log line is only greppable in a log sink; index.ts
   * wires this into a TurnLatencyCollector so the same measurement also reaches
   * the backend histogram, where an alert can actually see it.
   */
  onTurnLatency?: (latencyMs: number, holdPlayed: boolean) => void;
}

type LogFn = (obj: Record<string, unknown>, msg: string) => void;

const DEFAULT_DEADLINE_1 = 2500;
const DEFAULT_DEADLINE_2 = 4000;

/** A turn this slow is a pause a caller notices, hold line or not — WARN so it's
 *  greppable in Better Stack without scanning every turn_latency_ms line. Set
 *  to the filler deadline: by definition a turn that reaches the filler is one
 *  the caller was already sitting in silence for. */
const SLOW_TURN_WARN_MS = DEFAULT_DEADLINE_1;

/**
 * Attach the watchdog to a live AgentSession. Call once per session (index.ts
 * does); attaching twice would register duplicate listeners and double-fire.
 * Returns a detach function (clears timers + listeners) for teardown/tests.
 */
export function attachOutputWatchdog(
  session: voice.AgentSession,
  opts: WatchdogOptions
): () => void {
  const deadline1 = opts.deadline1Ms ?? DEFAULT_DEADLINE_1;
  const deadline2 = opts.deadline2Ms ?? DEFAULT_DEADLINE_2;

  let timer1: ReturnType<typeof setTimeout> | undefined;
  let timer2: ReturnType<typeof setTimeout> | undefined;
  // When THIS turn's 'thinking' began — the caller's own reference point for
  // "how long did it take him to respond," independent of whether a hold line
  // covered the gap. Measures the thing docs/TODO.md's open "voice naturalness
  // (pauses)" item asks for, per the project's own "measure before fixing"
  // rule: nobody had turn-latency numbers before guessing at a cause.
  let turnThinkingStartedAt: number | undefined;
  // The filler we injected this turn, and whether its playout has finished.
  // Used to tell our OWN filler's 'speaking' event apart from the real reply's:
  // the speech queue is serialized, so the reply only starts speaking AFTER the
  // filler is done — i.e. a 'speaking' while the filler is still playing is the
  // filler; a 'speaking' once it's done (or with no filler) is real audio.
  // SpeechHandle isn't re-exported from the package, so derive its type from
  // say()'s return rather than importing it by name.
  let fillerHandle: SpeechHandle | undefined;
  let fillerDone = false;

  const clearTimers = () => {
    if (timer1) clearTimeout(timer1);
    if (timer2) clearTimeout(timer2);
    timer1 = undefined;
    timer2 = undefined;
  };

  const disarm = () => {
    clearTimers();
    fillerHandle = undefined;
    fillerDone = false;
  };

  // Real audio has started for THIS turn — log how long it took from the
  // caller's turn ending to the first real sound, whether or not a hold line
  // covered the gap. Two different code paths reach "real audio confirmed"
  // (an explicit 'speaking' transition, and the filler-done settle-beat when
  // the reply is queued seamlessly behind the filler with no transition of its
  // own) — both call this exactly once per turn.
  const logTurnLatency = (holdPlayed: boolean) => {
    if (turnThinkingStartedAt == null) return;
    const latencyMs = Date.now() - turnThinkingStartedAt;
    turnThinkingStartedAt = undefined;
    const fields = { event: 'turn_latency_ms', latency_ms: latencyMs, hold_played: holdPlayed };
    opts.onTurnLatency?.(latencyMs, holdPlayed);
    if (latencyMs >= SLOW_TURN_WARN_MS) {
      opts.log.warn(fields, `slow turn: ${latencyMs}ms from thinking to real audio`);
    } else {
      opts.log.info(fields, `turn latency: ${latencyMs}ms from thinking to real audio`);
    }
  };

  // Speak a cached clip (zero-latency) if warmed, else fall back to live TTS via
  // a plain text say() — slower, but never silent. Returns the handle or null
  // when the session refused the say (draining).
  const speakHold = (text: string, label: string): SpeechHandle | null => {
    const frame = getFillerFrame(opts.voice, text);
    try {
      const handle = frame
        ? session.say(text, {
            audio: frameStream(frame),
            allowInterruptions: true,
            addToChatCtx: false,
          })
        : session.say(text, { allowInterruptions: true, addToChatCtx: false });
      opts.log.info(
        { event: 'watchdog_hold_played', label, cached: frame != null },
        `watchdog played a ${label} line (caller not left in silence)`
      );
      opts.onSpoken?.(text);
      return handle;
    } catch (e) {
      // SchedulingPausedError (draining) or similar — nothing to play into.
      opts.log.warn(
        {
          event: 'watchdog_hold_skipped',
          label,
          error_message: e instanceof Error ? e.message : String(e),
        },
        'watchdog hold skipped — session not accepting speech'
      );
      return null;
    }
  };

  // Is a speech already scheduled or playing? The agentState only flips to
  // 'speaking' when AUDIO starts, but the reply's SpeechHandle joins the queue
  // hundreds of ms earlier (LLM done → TTS still spinning up). A filler spoken
  // inside that window queues BEHIND the reply and plays as a stray
  // after-thought — on the 2026-07-21 call the caller heard the read-back
  // question, then "Just a moment.", then the recovery line, run together:
  // "you're running all these sentences together and not giving them any time
  // to respond". This reads the session's internal activity (not in the public
  // typings, stable in our pinned version) defensively: unknown shape → false,
  // which is the pre-guard behavior.
  const speechScheduledOrPlaying = (): boolean => {
    const activity = (
      session as unknown as {
        activity?: { currentSpeech?: unknown; speechQueue?: { size?: () => number } };
      }
    ).activity;
    if (!activity) return false;
    if (activity.currentSpeech != null) return true;
    try {
      return (activity.speechQueue?.size?.() ?? 0) > 0;
    } catch {
      return false;
    }
  };

  const fireFiller = () => {
    timer1 = undefined;
    // Re-check: the real reply may have started between the timer scheduling and
    // now. Only hold the line if the agent is still thinking (no audio yet).
    if (session.agentState !== 'thinking') return;
    // …and if the reply is already queued (audio imminent), a filler is not
    // cover, it's clutter — skip the HOLD LINE. But keep the escalation armed.
    //
    // THIS RETURN USED TO STAND DOWN ENTIRELY, and its comment said the
    // silent-turn recovery path owned the case where a queued reply dies
    // silent. It does — but only after the FRAMEWORK's `ttsReadIdleTimeout`
    // gives up, which defaults to 10 seconds. So a reply that was queued and
    // then produced no audio left the caller in ten full seconds of nothing
    // with no cover of any kind.
    //
    // Measured on a real call (2026-08-15, sim-call-1786817155950): twice, TTS
    // produced zero frames, the framework timed out at exactly 10.00s, and the
    // caller said "Hello? Are you there?" and then "I said it already. Didn't
    // you hear it?". The hold line was correctly skipped both times — and
    // nothing else was watching.
    //
    // Arming timer2 here costs nothing when the reply lands normally: the
    // `speaking` transition disarms it, and fireRecovery re-checks the state
    // and stands down if audio is rolling. What it buys is a spoken line at
    // deadline2 instead of silence until the framework notices.
    if (speechScheduledOrPlaying()) {
      opts.log.info(
        { event: 'watchdog_hold_skipped', label: 'thinking', reason: 'reply_already_queued' },
        'watchdog hold skipped — reply already scheduled, audio imminent'
      );
      timer2 = setTimeout(fireRecovery, deadline2);
      return;
    }
    fillerDone = false;
    // SAY THE TRUE THING. A tool really running earns "let me check that for you";
    // an LLM that is merely slow gets "just a moment", which promises nothing and so
    // cannot be false. The watchdog stays cause-AGNOSTIC about WHEN it fires (dead
    // air is dead air) and becomes cause-HONEST about WHAT it says.
    const running = isToolRunning();
    fillerHandle =
      speakHold(running ? opts.fillerText : opts.thinkingText, running ? 'filler' : 'thinking') ??
      undefined;
    // Mark when the filler's playout finishes so a later 'speaking' (the real
    // reply, which is serialized AFTER the filler) is recognized as real audio.
    fillerHandle?.addDoneCallback(() => {
      fillerDone = true;
      // THE STOMP FIX (2026-07-21, first live question-tree call): when the real
      // reply is queued BEHIND the still-playing filler, the agent state never
      // LEAVES 'speaking' between the two playouts — no transition, so the
      // onAgentState disarm can never fire, and timer2's recovery line then
      // played OVER the live slot offer (the caller heard the agent talk over
      // itself). After the filler's playout, give the state a beat to settle:
      // if the agent is still 'speaking', that audio IS the real reply → disarm.
      // If nothing was queued, the state drops to 'listening' within the beat
      // and that branch disarms anyway — either way the recovery only survives
      // into genuine dead air.
      setTimeout(() => {
        if (timer2 !== undefined && session.agentState === 'speaking') {
          logTurnLatency(true);
          disarm();
        }
      }, 300);
    });
    // Arm deadline 2 — if STILL no real audio, escalate to the recovery line.
    timer2 = setTimeout(fireRecovery, deadline2);
  };

  const fireRecovery = () => {
    timer2 = undefined;
    // AUDIO IS ROLLING → the caller is not in dead air. The filler is ~1.2s, so
    // 'speaking' at deadline2 (4s after the filler) cannot be the filler — it is
    // the real reply (which slipped into the queue around the filler). Speaking
    // the recovery now stacks a third line onto live output (the 2026-07-21
    // triple run-on). The only useful act is to cancel our own queued filler so
    // it doesn't play as a stray after the reply, then stand down.
    if (session.agentState === 'speaking') {
      if (fillerHandle && !fillerDone) {
        try {
          void fillerHandle.interrupt();
        } catch {
          /* not interruptible — let it play, it's short */
        }
      }
      opts.log.info(
        { event: 'watchdog_recovery_skipped', reason: 'audio_already_playing' },
        'watchdog recovery skipped — real audio is playing; queued filler cancelled'
      );
      disarm();
      return;
    }
    // Otherwise: still dead air (gating on agentState==='thinking' instead would
    // wrongly skip recovery when the filler's own playout ended mid-transition).
    // Return value (the SpeechHandle thenable) intentionally unused — fire-and-forget.
    //
    // WHICH recovery line depends on what the caller already has. Offering to take
    // a message is only useful to someone who has not left one; after that it is a
    // line the caller has to refuse (2026-09-09, SCL_A5wnBexPbwCC at 4:14).
    const recovery =
      wasMessageTaken() && opts.recoveryTextAfterMessage
        ? opts.recoveryTextAfterMessage
        : opts.recoveryText;
    void speakHold(recovery, 'recovery');
  };

  const onAgentState = (ev: voice.AgentStateChangedEvent) => {
    if (ev.newState === 'thinking') {
      // New turn to respond — (re)arm the deadline.
      clearTimers();
      fillerHandle = undefined;
      fillerDone = false;
      turnThinkingStartedAt = Date.now();
      timer1 = setTimeout(fireFiller, deadline1);
    } else if (ev.newState === 'speaking') {
      // Audio started. If our filler is still playing, this 'speaking' IS the
      // filler — ignore it. Otherwise (no filler this turn, or it already
      // finished) real audio is now playing → the caller hears something →
      // disarm. (The queue is serialized, so the reply can only speak after the
      // filler's playout completes.)
      const isFillerSpeaking = fillerHandle != null && !fillerDone;
      if (!isFillerSpeaking) {
        logTurnLatency(fillerHandle != null);
        disarm();
      }
    } else if (ev.newState === 'listening' || ev.newState === 'idle') {
      // Turn fully resolved — stand down.
      turnThinkingStartedAt = undefined;
      disarm();
    }
  };

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, onAgentState);

  return () => {
    clearTimers();
    session.off(voice.AgentSessionEventTypes.AgentStateChanged, onAgentState);
  };
}

/**
 * What the forced reply is told, when a turn dies silent (see
 * attachSilentTurnRecovery). Positive framing (gotcha G): it says what to DO —
 * re-ask the question the caller still owes an answer to, or ask for the next
 * thing it needs — never what went wrong. toolChoice:'none' rides along in the
 * generateReply call, so this turn CANNOT die the same death: with no tools to
 * chain there is no step cap to hit, and the model's only move is to produce
 * words.
 *
 * WORDING LESSONS from the first live firing (2026-07-17 16:02 UTC — the
 * recovery WORKED, the call survived to a booking, and both flaws below were
 * heard by the caller):
 *
 * 1. RE-ASK, NEVER ASSUME. The turn that died had just asked "that's
 *    608-217-5303, right?". The v1 nudge said "use what you already know" —
 *    and the model answered its OWN question ("Thank you! That's correct")
 *    without the caller ever confirming. A pending question is not something
 *    you know; it is something you are owed.
 * 2. END WITH A QUESTION, NOT A PROMISE. This turn has no tools, so "I'll go
 *    ahead and book that — one moment, please" is a promise it cannot start
 *    keeping; the v1 nudge said exactly that and then the line sat quiet for
 *    20 seconds until the caller said "Hello?". A question hands the turn to
 *    the caller, and the caller's answer starts a NEW turn — one that has its
 *    tools back. The question IS the recovery's exit.
 */
export const NUDGE_INSTRUCTIONS =
  'Reply to the caller RIGHT NOW in one or two short sentences, then stop. If you asked a question the caller has not answered yet, ask that question again, briefly — they never answered it, so you do not know their answer. Otherwise, ask for the one thing you need next. Always end by asking the caller a question, because your next turn begins only when they speak. This reply is words only — never say "one moment" or promise an action, and never mention tools, systems, steps, or errors.';

/**
 * Silent-turn-death recovery — the backstop for a turn that ENDS without audio.
 *
 * The hold-line watchdog above covers a turn that is SLOW. This covers a turn
 * that is OVER: on 2026-07-17 a live call hit LiveKit's maxToolSteps cap
 * (default 3) mid-booking — the model chained three lookups, the framework
 * ended the turn, and the agent transitioned thinking → listening having said
 * NOTHING. The caller said "Hello?" twice into the silence and hung up. Three
 * aggravators made it unrecoverable:
 *
 *  - the hold-line watchdog treats 'listening' as "turn fully resolved" and
 *    DISARMS — the never-silent backstop stands down on exactly the transition
 *    that IS the silence;
 *  - the capped turn strands its last tool call with no output in history
 *    ("function call missing the corresponding function output" on every later
 *    turn);
 *  - the caller's "Hello?" replays the same doomed tool loop from the same
 *    context — the failure is STABLE, not transient.
 *
 * So: when a turn ends thinking → listening directly (no 'speaking' ever
 * happened — not even a filler, which would have moved the state to
 * 'speaking'), the RUNTIME forces a reply: generateReply with toolChoice
 * 'none', so the model must speak and cannot re-enter the tool loop. If that
 * forced turn ALSO dies silent (it shouldn't — no tools, no cap), we escalate
 * once to the pre-synthesized recovery line and stop; an unbounded nudge loop
 * would be its own bug.
 *
 * Honesty rules (gotcha D) hold here too: we never speak while the caller is
 * mid-utterance (their new turn is already the recovery — nudging would talk
 * over them), and the nudge claims nothing about work not done.
 *
 * DELIBERATELY SEPARATE from attachOutputWatchdog and NOT behind
 * ENABLE_OUTPUT_WATCHDOG. Prod had that flag OFF on 2026-07-17; a turn that
 * ends in permanent silence is a dropped call, not a UX polish option, so
 * this stays attached even when the hold-line watchdog is also on.
 * index.ts attaches this unconditionally.
 */
export function attachSilentTurnRecovery(
  session: voice.AgentSession,
  opts: {
    /** Tenant voice id (cache key for the pre-synthesized recovery clip). */
    voice: string;
    /** Escalation line if the forced reply itself produces no audio. */
    recoveryText: string;
    log: { info: LogFn; warn: LogFn };
    /** Same contract as WatchdogOptions.onSpoken — the escalation line is
     *  addToChatCtx:false, so only this callback gets it into the transcript.
     *  (The generateReply nudge produces a normal ConversationItemAdded and
     *  needs no help.) */
    onSpoken?: (text: string) => void;
    /** Called when a turn is found to have made no sound, so the transcript can
     *  mark the assistant line the caller never heard. */
    onUnheardTurn?: () => void;
    /**
     * True when attachOutputWatchdog is ALSO attached to this session
     * (ENABLE_OUTPUT_WATCHDOG on). That function distinguishes a filler's own
     * 'speaking' from the real reply's; this one has no such signal — every
     * 'speaking' looks the same to it. Left false (the default, matching
     * prod today), THIS function is the only turn_latency_ms source and every
     * 'speaking' really is real audio. Left true and NOT set here, a filler's
     * 'speaking' would get logged as the turn's latency (wrong — measures
     * time-to-filler, and falsely reports hold_played:false), then the real
     * reply's later 'speaking' would find thinkingAtMs already consumed and
     * log NOTHING — the correct number lost in favor of a wrong one. Set true
     * to skip this function's copy entirely and let attachOutputWatchdog's
     * filler-aware copy be the only source.
     */
    outputWatchdogActive?: boolean;
    /** Same contract as WatchdogOptions.onTurnLatency. Fires only from this
     *  function's own copy of the measurement, i.e. only when
     *  outputWatchdogActive is false — so exactly one of the two watchdogs
     *  feeds the collector, never both. */
    onTurnLatency?: (latencyMs: number, holdPlayed: boolean) => void;
  }
): () => void {
  // True from the moment we fire a nudge until any agent audio plays. If a
  // second silent death arrives while this is set, the nudge itself failed —
  // escalate to the canned line instead of nudging forever.
  let nudgeInFlight = false;
  // When the turn started thinking. The gap to the silent death is the single
  // most diagnostic number available here: ~10s means the framework's TTS idle
  // timeout gave up, which is a stream that never produced a frame, not a model
  // that ran out of tool steps.
  let thinkingAtMs: number | null = null;
  const msSinceThinking = (): number | null =>
    thinkingAtMs === null ? null : Date.now() - thinkingAtMs;

  const onAgentState = (ev: voice.AgentStateChangedEvent) => {
    if (ev.newState === 'thinking') thinkingAtMs = Date.now();
    if (ev.newState === 'speaking') {
      // turn_latency_ms belongs here, not only in attachOutputWatchdog — THIS
      // function is UNCONDITIONAL, so it observes every real turn when the
      // hold-line watchdog is off. When outputWatchdogActive is true, skip
      // this copy (the watchdog's filler-aware copy owns the number).
      // Why the dual copy exists: 2026-08-19 sim-call-1787158785189 had 17s
      // and 20s gaps and zero turn_latency_ms lines — the watchdog copy lived
      // behind a then-disabled flag.
      if (thinkingAtMs != null && !opts.outputWatchdogActive) {
        const latencyMs = Date.now() - thinkingAtMs;
        const fields = { event: 'turn_latency_ms', latency_ms: latencyMs, hold_played: false };
        opts.onTurnLatency?.(latencyMs, false);
        if (latencyMs >= SLOW_TURN_WARN_MS) {
          opts.log.warn(fields, `slow turn: ${latencyMs}ms from thinking to real audio`);
        } else {
          opts.log.info(fields, `turn latency: ${latencyMs}ms from thinking to real audio`);
        }
        // Null it out so a LATER 'speaking' event this same dead-air episode
        // produces (the canned recovery line below, played via a direct say()
        // that never re-enters 'thinking') cannot reuse this stale timestamp
        // and log a second, misleading latency for the same turn.
        thinkingAtMs = null;
      }
      nudgeInFlight = false;
      return;
    }
    // thinking → listening with no 'speaking' in between: the turn produced
    // zero audio and is already over. (A slow turn passes through 'speaking'
    // for its reply — or for the watchdog's filler — before 'listening'.)
    if (ev.oldState !== 'thinking' || ev.newState !== 'listening') return;

    // The session is closing (finish_call's goodbye has played): the teardown
    // state flap looks exactly like a silent death, but there is no turn left
    // to recover — generateReply would only throw "AgentSession is closing"
    // (logged as a failure on every clean 2026-07-21 hang-up). `closing` is a
    // plain field on AgentSession (not in the typings); unknown shape → falsy
    // → the pre-guard behavior.
    if ((session as unknown as { closing?: boolean }).closing) return;

    // The caller is mid-utterance (barge-in / a new turn already forming):
    // their speech will drive the next reply. Speaking now would talk over
    // them (gotcha D) and race the incoming turn.
    if (session.userState === 'speaking') {
      opts.log.info(
        { event: 'silent_turn_death_deferred' },
        'turn ended with no audio, but the caller is speaking — their turn is the recovery'
      );
      return;
    }

    if (nudgeInFlight) {
      // The forced reply ALSO died silent. Stop generating; say the canned line.
      nudgeInFlight = false;
      opts.log.warn(
        { event: 'silent_turn_recovery_escalated' },
        'forced reply also produced no audio — playing the recovery line'
      );
      // This canned line plays via a direct say(), which never re-enters
      // 'thinking' — null the stale nudge-era timestamp so the 'speaking' it
      // produces cannot be logged as a fresh turn's latency (see the comment
      // on turn_latency_ms above).
      thinkingAtMs = null;
      const frame = getFillerFrame(opts.voice, opts.recoveryText);
      try {
        // SpeechHandle is a thenable — fire-and-forget, explicitly discarded.
        void session.say(opts.recoveryText, {
          ...(frame ? { audio: frameStream(frame) } : {}),
          allowInterruptions: true,
          addToChatCtx: false,
        });
        opts.onSpoken?.(opts.recoveryText);
      } catch {
        // Session draining/closed — nothing to play into, nothing to do.
      }
      return;
    }

    nudgeInFlight = true;
    // THE MESSAGE USED TO NAME CAUSES NOBODY HAD MEASURED — "tool-step cap or
    // empty generation". On 2026-08-15 it was neither, twice: the LLM produced
    // complete text in 1.7s with one tool call against a cap of five, and the
    // framework's TTS idle timeout expired at exactly 10.00s having received
    // zero audio frames. A log line that guesses at a cause sends the next
    // reader to the wrong file. State what is observed — the turn made no
    // sound — and let the fields say the rest.
    opts.log.warn(
      { event: 'silent_turn_recovered', ms_since_thinking: msSinceThinking() },
      'turn ended with no audio — forcing a spoken, tool-free reply'
    );
    // The last assistant line in the transcript belongs to THIS turn, and the
    // caller never heard it: the framework records assistant text from the
    // token stream, not from playout, so a stalled TTS still produces a
    // ConversationItemAdded and a tidy transcript of a silence. Marking it is
    // the difference between a record and a story.
    opts.onUnheardTurn?.();
    try {
      // SpeechHandle thenable, fire-and-forget — playout is the framework's job.
      void session.generateReply({
        instructions: NUDGE_INSTRUCTIONS,
        toolChoice: 'none',
        allowInterruptions: true,
      });
    } catch (e) {
      // Draining/closed. Do not retry — the session is going away.
      nudgeInFlight = false;
      opts.log.warn(
        {
          event: 'silent_turn_recovery_failed',
          error_message: e instanceof Error ? e.message : String(e),
        },
        'silent-turn recovery could not speak — session not accepting speech'
      );
    }
  };

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, onAgentState);
  return () => {
    session.off(voice.AgentSessionEventTypes.AgentStateChanged, onAgentState);
  };
}

/** Default quiet time before the agent checks whether the caller is still there. */
const DEFAULT_CALLER_SILENCE_MS = 10_000;
/** Further quiet after the check-in before the call is closed out. */
const DEFAULT_CALLER_GIVEUP_MS = 12_000;

/**
 * CALLER-SIDE silence — the gap neither watchdog above was ever watching.
 *
 * attachOutputWatchdog covers a turn that is SLOW; attachSilentTurnRecovery
 * covers a turn that ENDED without audio. Both arm on the AGENT's state, and
 * both stand down the moment the agent finishes speaking — which is precisely
 * when a caller's silence begins. So the one thing nobody was watching was the
 * caller.
 *
 * On 2026-07-27 four calls (13-42s) contain the greeting and NOTHING else: no
 * "are you still there?", no close, no breadcrumb — one of them from a caller
 * who had been told to ring back at that exact time and was waiting for a human
 * (CALL_IMPROVEMENTS.md #5, #6, #4, #11). Forty seconds of dead air, then a
 * hang-up, and the product's only record was a blank transcript.
 *
 * Two beats, then out:
 *   1. after `silenceMs` of quiet with the agent idle → ONE check-in, spoken.
 *   2. after `giveUpMs` more → hand back to the caller-facing close.
 *
 * The timer starts only when the agent is LISTENING (its own speech never
 * counts as the caller's silence) and is cancelled the instant the caller makes
 * a sound — Silero's `speaking` verdict, not a transcript, so a caller who
 * mumbles still counts as present.
 */
export function attachCallerSilenceWatch(
  session: voice.AgentSession,
  opts: {
    /** Spoken once, after the first stretch of quiet. */
    checkInText: string;
    /** Called when the caller stays silent after the check-in. */
    onGiveUp: () => void;
    silenceMs?: number;
    giveUpMs?: number;
    log: { info: LogFn; warn: LogFn };
    /** Same contract as WatchdogOptions.onSpoken — the check-in is
     *  addToChatCtx:false, so only this callback gets it into the transcript. */
    onSpoken?: (text: string) => void;
  }
): () => void {
  const silenceMs = opts.silenceMs ?? DEFAULT_CALLER_SILENCE_MS;
  const giveUpMs = opts.giveUpMs ?? DEFAULT_CALLER_GIVEUP_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let checkedIn = false;
  let finished = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const giveUp = () => {
    if (finished) return;
    finished = true;
    clear();
    opts.log.warn(
      { event: 'caller_silence_give_up' },
      'caller stayed silent after the check-in — closing the call rather than holding an empty line'
    );
    void opts.onGiveUp();
  };

  const checkIn = () => {
    if (finished || checkedIn) return;
    checkedIn = true;
    try {
      // addToChatCtx:false for the same reason the hold lines are: this is the
      // RUNTIME speaking, not a turn the model should reason about later.
      void session.say(opts.checkInText, { allowInterruptions: true, addToChatCtx: false });
      opts.onSpoken?.(opts.checkInText);
      opts.log.info(
        { event: 'caller_silence_check_in' },
        'caller has been quiet — asked whether they are still there'
      );
    } catch {
      // Session draining/closed — nothing to play into.
    }
    clear();
    timer = setTimeout(giveUp, giveUpMs);
  };

  const arm = () => {
    if (finished) return;
    clear();
    timer = setTimeout(checkedIn ? giveUp : checkIn, checkedIn ? giveUpMs : silenceMs);
  };

  const onAgentState = (ev: voice.AgentStateChangedEvent) => {
    // The agent has stopped talking and is waiting on the caller: the clock
    // starts here, and only here.
    if (ev.newState === 'listening') arm();
    else clear();
  };

  const onUserState = (ev: voice.UserStateChangedEvent) => {
    if (ev.newState === 'speaking') {
      // They are there. Reset EVERYTHING, including the check-in latch: a
      // caller who speaks, then goes quiet again later, deserves the same two
      // beats rather than being dropped straight out.
      checkedIn = false;
      clear();
    } else if (session.agentState === 'listening') {
      arm();
    }
  };

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, onAgentState);
  session.on(voice.AgentSessionEventTypes.UserStateChanged, onUserState);

  return () => {
    finished = true;
    clear();
    session.off(voice.AgentSessionEventTypes.AgentStateChanged, onAgentState);
    session.off(voice.AgentSessionEventTypes.UserStateChanged, onUserState);
  };
}
