/**
 * Tests for the output watchdog state machine. We drive a fake AgentSession by
 * emitting agent_state_changed transitions and use fake timers to cross the
 * deadlines — no real audio/TTS. (The acoustic behavior on a live call is a
 * separate, manual validation item per the never-silent spec.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  toolStarted,
  toolFinished,
  markMessageTaken,
  resetCallActivity,
  _resetToolActivityForTest,
} from './toolActivity.js';
import { voice } from '@livekit/agents';
import {
  attachOutputWatchdog,
  attachSilentTurnRecovery,
  attachCallerSilenceWatch,
  NUDGE_INSTRUCTIONS,
} from './watchdog.js';
import { _resetFillerCacheForTest } from './fillerCache.js';

const STATE_EV = voice.AgentSessionEventTypes.AgentStateChanged;
const noopLog = { info: () => {}, warn: () => {} };
const FILLER = 'One moment while I check that for you.';
const RECOVERY = 'Sorry, this is taking me a moment.';
const RECOVERY_AFTER_MESSAGE = "Sorry — still writing that up. One more moment and I'll have it.";

interface FakeHandle {
  id: string;
  addDoneCallback: (cb: () => void) => void;
  fireDone: () => void;
  interrupted: boolean;
  interrupt: () => void;
}

function makeFakeSession() {
  const handlers: Record<string, Array<(ev: unknown) => void>> = {};
  let agentState = 'listening';
  let userState = 'listening';
  const sayCalls: Array<{ text: string; opts: unknown }> = [];
  const generateReplyCalls: Array<Record<string, unknown>> = [];
  const handles: FakeHandle[] = [];
  let n = 0;

  const session = {
    get agentState() {
      return agentState;
    },
    get userState() {
      return userState;
    },
    generateReply(opts: Record<string, unknown>) {
      generateReplyCalls.push(opts);
      return { addDoneCallback: () => {} };
    },
    on(ev: string, cb: (ev: unknown) => void) {
      (handlers[ev] ??= []).push(cb);
    },
    off(ev: string, cb: (ev: unknown) => void) {
      handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== cb);
    },
    say(text: string, opts: unknown) {
      sayCalls.push({ text, opts });
      const cbs: Array<() => void> = [];
      const handle: FakeHandle = {
        id: `h${n++}`,
        addDoneCallback: (cb) => cbs.push(cb),
        fireDone: () => cbs.forEach((c) => c()),
        interrupted: false,
        interrupt: () => {
          handle.interrupted = true;
        },
      };
      handles.push(handle);
      return handle;
    },
    // The internal activity the watchdog probes for an already-queued reply.
    // Absent by default (pre-guard behavior); tests set it via setActivity.
    activity: undefined as unknown,
  };

  const emitUserState = (newState: string) => {
    const oldState = userState;
    userState = newState;
    (handlers[voice.AgentSessionEventTypes.UserStateChanged] ?? []).forEach((cb) =>
      cb({ type: voice.AgentSessionEventTypes.UserStateChanged, oldState, newState, createdAt: 0 })
    );
  };

  const emit = (newState: string) => {
    const oldState = agentState;
    agentState = newState;
    (handlers[STATE_EV] ?? []).forEach((cb) =>
      cb({ type: STATE_EV, oldState, newState, createdAt: 0 })
    );
  };

  return {
    session: session as unknown as voice.AgentSession,
    sayCalls,
    generateReplyCalls,
    handles,
    emit,
    emitUserState,
    setUserState: (s: string) => {
      userState = s;
    },
    setActivity: (a: unknown) => {
      (session as { activity: unknown }).activity = a;
    },
  };
}

describe('attachOutputWatchdog', () => {
  beforeEach(() => {
    _resetFillerCacheForTest();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const attach = (s: ReturnType<typeof makeFakeSession>) =>
    attachOutputWatchdog(s.session, {
      voice: 'eve',
      thinkingText: 'Just a moment.',
      fillerText: FILLER,
      recoveryText: RECOVERY,
      recoveryTextAfterMessage: RECOVERY_AFTER_MESSAGE,
      log: noopLog,
    });

  it("SAD: stuck 'thinking' past deadline 1 WITH A TOOL RUNNING → names the lookup", async () => {
    // WHO: a caller waiting on a genuinely slow tool (availability, policy RAG — 2-4s).
    // WHAT: after deadline1 of 'thinking' with no 'speaking', the watchdog holds the line
    //       and it is ALLOWED to say what it is doing, because it really is doing it.
    _resetToolActivityForTest();
    toolStarted();
    const f = makeFakeSession();
    attach(f);
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500);
    expect(f.sayCalls).toHaveLength(1);
    expect(f.sayCalls[0].text).toBe(FILLER);
    toolFinished();
  });

  it('SAD: stuck thinking with NO tool running → asks for a moment, and CLAIMS NOTHING', async () => {
    // WHO: every caller, on nearly every turn — the STT→gpt-4o-mini→TTS pipeline
    //      routinely takes longer than the deadline to produce a first word.
    // WHAT: the hold line must NOT say "let me check that for you" when nothing is
    //      being checked.
    // WHY:  on the 2026-07-14 call it said exactly that SEVEN TIMES, and every tool on
    //      that call returned in under 15ms. Nothing was ever being looked up. The
    //      caller could tell, and said so, mid-call: "what are you checking?" and
    //      "what am I waiting for?"
    //
    //      This is the same defect as the prompt line we deleted for letting the MODEL
    //      claim work it had not done — except here the RUNTIME was doing the lying, on
    //      a timer. A machine lying on a schedule is still lying. The watchdog stays
    //      cause-AGNOSTIC about when it fires (dead air is dead air) and becomes
    //      cause-HONEST about what it says.
    _resetToolActivityForTest();
    const f = makeFakeSession();
    attach(f);
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500);
    expect(f.sayCalls).toHaveLength(1);
    expect(f.sayCalls[0].text).toBe('Just a moment.');
    expect(f.sayCalls[0].text).not.toMatch(/check|look|find/i);
  });

  it('HAPPY: real audio before deadline 1 → no filler ever plays', async () => {
    // WHO: a normal fast turn. WHAT: 'speaking' arrives before the deadline → disarm.
    const f = makeFakeSession();
    attach(f);
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(1000);
    f.emit('speaking'); // real reply audio, no filler outstanding → disarm
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.sayCalls).toHaveLength(0);
  });

  it('measures turn latency: fast turn logs turn_latency_ms at info, no WARN', async () => {
    const logs: Array<{ level: 'info' | 'warn'; obj: Record<string, unknown> }> = [];
    const log = {
      info: (obj: Record<string, unknown>) => logs.push({ level: 'info', obj }),
      warn: (obj: Record<string, unknown>) => logs.push({ level: 'warn', obj }),
    };
    const f = makeFakeSession();
    attachOutputWatchdog(f.session, {
      voice: 'eve',
      thinkingText: 'Just a moment.',
      fillerText: FILLER,
      recoveryText: RECOVERY,
      log,
    });
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(400);
    f.emit('speaking'); // real reply, well under the filler deadline
    const latencyLogs = logs.filter((l) => l.obj.event === 'turn_latency_ms');
    expect(latencyLogs).toHaveLength(1);
    expect(latencyLogs[0].level).toBe('info');
    expect(latencyLogs[0].obj.latency_ms).toBe(400);
    expect(latencyLogs[0].obj.hold_played).toBe(false);
  });

  it('measures turn latency: reply queued behind the filler (settle-beat path) logs turn_latency_ms at WARN', async () => {
    // Same shape as "SAD, live: reply queued BEHIND the filler" above — the
    // reply plays seamlessly inside one continuous 'speaking' span, so the
    // settle-beat setTimeout (not a second explicit 'speaking' event) is what
    // confirms real audio. Must log from there too, or this whole class of
    // turn is invisible to the latency instrumentation.
    _resetToolActivityForTest();
    const logs: Array<{ level: 'info' | 'warn'; obj: Record<string, unknown> }> = [];
    const log = {
      info: (obj: Record<string, unknown>) => logs.push({ level: 'info', obj }),
      warn: (obj: Record<string, unknown>) => logs.push({ level: 'warn', obj }),
    };
    const f = makeFakeSession();
    attachOutputWatchdog(f.session, {
      voice: 'eve',
      thinkingText: 'Just a moment.',
      fillerText: FILLER,
      recoveryText: RECOVERY,
      log,
    });
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500); // fires the filler
    f.emit('speaking'); // the filler's own audio — one transition, never another
    f.handles[0].fireDone(); // filler playout completes; agent STILL 'speaking' = the real reply
    await vi.advanceTimersByTimeAsync(300); // the settle beat → disarm + latency log
    const latencyLogs = logs.filter((l) => l.obj.event === 'turn_latency_ms');
    expect(latencyLogs).toHaveLength(1);
    expect(latencyLogs[0].level).toBe('warn');
    expect(latencyLogs[0].obj.latency_ms).toBe(2800);
    expect(latencyLogs[0].obj.hold_played).toBe(true);
  });

  it('SAD: still no audio past deadline 2 → escalates to the recovery line', async () => {
    // A tool IS running here — otherwise deadline 1 speaks the neutral line and this
    // test would be asserting the wrong first utterance.
    _resetToolActivityForTest();
    toolStarted();
    const f = makeFakeSession();
    attach(f);
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500); // filler
    await vi.advanceTimersByTimeAsync(4000); // recovery
    expect(f.sayCalls.map((c) => c.text)).toEqual([FILLER, RECOVERY]);
  });

  it('SAD: a message was already taken → the recovery line stops offering to take one', async () => {
    // WHO: John Smith, prod call SCL_A5wnBexPbwCC, 2026-09-09 11:12 CT, at 4:14.
    // WHAT: the full job intake was done and take_message had returned when the
    //       watchdog said "Sorry, this is taking me a moment. If you'd like, I can
    //       take a message and have someone get right back to you." He replied
    //       "No. No message. Just pass this on."
    // WHERE: fireRecovery's line selection in watchdog.ts.
    // WHEN: any deadline-2 stall after a message has been recorded on the call.
    // WHY: the dead air was real, so firing was right — the OFFER was the lie. A
    //      runtime line has to be true at the moment it plays, and offering the
    //      caller a thing he has already done makes him refuse it.
    _resetToolActivityForTest();
    toolStarted();
    markMessageTaken();
    const f = makeFakeSession();
    attach(f);
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500); // filler
    await vi.advanceTimersByTimeAsync(4000); // recovery
    expect(f.sayCalls.map((c) => c.text)).toEqual([FILLER, RECOVERY_AFTER_MESSAGE]);
  });

  it('HAPPY: with no message taken, the recovery line still offers one', async () => {
    // The fix must not cost the offer its whole reason for existing: a caller who
    // has NOT left a message is exactly who that sentence is for.
    _resetToolActivityForTest();
    toolStarted();
    const f = makeFakeSession();
    attach(f);
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.sayCalls.map((c) => c.text)).toEqual([FILLER, RECOVERY]);
  });

  it('SAD: the message flag does NOT survive into the next call', async () => {
    // WHO: the caller AFTER someone who left a message, on a reused job process.
    // WHAT: resetCallActivity() (called from entry()) clears the flag, so this
    //       caller is offered a message like anyone else.
    // WHERE: session/toolActivity.ts resetCallActivity, wired in index.ts entry().
    // WHEN: any call that lands on a process which already handled one.
    // WHY: Copilot review on PR #409. The flag is module-level and nothing reset
    //      it, so once ANY call took a message every later call on that process
    //      would get the after-message line and never be offered one — the fix
    //      inverted into a worse defect than the one it cured.
    markMessageTaken();
    resetCallActivity(); // ← what entry() does at the top of the next call
    toolStarted();
    const f = makeFakeSession();
    attach(f);
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.sayCalls.map((c) => c.text)).toEqual([FILLER, RECOVERY]);
  });

  it('SAD: a tool left in flight by a dropped call does not poison the next one', async () => {
    // Same shape, older exposure: inFlight is module-level too. A call that dies
    // mid-tool leaves the count above zero, and the hold line would go back to
    // claiming a lookup that is not running — the 2026-07-14 lie, resurrected by
    // a stale counter instead of by a bad prompt.
    toolStarted(); // never balanced — the call dropped
    resetCallActivity();
    const f = makeFakeSession();
    attach(f);
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500);
    expect(f.sayCalls.map((c) => c.text)).toEqual(['Just a moment.']);
  });

  it("the filler's OWN 'speaking' doesn't disarm; once it's done + real audio plays, no recovery", async () => {
    // WHO: filler plays, then the real reply follows (serialized after it).
    // WHAT: 'speaking' while the filler is still playing must NOT be mistaken for
    //        real audio; only after the filler is done does a 'speaking' disarm.
    const f = makeFakeSession();
    attach(f);
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500); // filler plays (handle h0)
    expect(f.sayCalls).toHaveLength(1);
    f.emit('speaking'); // this is the FILLER speaking (h0 not done) → must not disarm
    f.handles[0].fireDone(); // filler playout completes
    f.emit('speaking'); // now the REAL reply → disarm
    await vi.advanceTimersByTimeAsync(4000); // recovery window passes
    expect(f.sayCalls).toHaveLength(1); // filler only, NO recovery
  });

  it('SAD, live: reply queued BEHIND the filler → same continuous speaking state → recovery must NOT stomp it', async () => {
    // WHO: the 2026-07-21 question-tree test caller, mid slot-offer.
    // WHAT: the filler played at 93.6s, the real reply started at 94.6s while the
    //       agent was ALREADY in 'speaking' — the state never transitioned again, so
    //       the "a later 'speaking' disarms" assumption never got its event, timer2
    //       survived, and the recovery line played at 97.6s OVER the live slot offer.
    // WHERE: the speech queue serializes filler → reply inside ONE 'speaking' span.
    // WHY: the disarm must key off the FILLER'S PLAYOUT COMPLETING while audio is
    //       still rolling (that audio IS the reply), not off a transition that only
    //       exists when the reply starts from silence.
    _resetToolActivityForTest();
    const f = makeFakeSession();
    attach(f);
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500); // filler plays (handle h0)
    f.emit('speaking'); // the filler's own audio — one transition, never another
    f.handles[0].fireDone(); // filler playout completes; agent STILL 'speaking' = the real reply
    await vi.advanceTimersByTimeAsync(300); // the settle beat → disarm
    await vi.advanceTimersByTimeAsync(4000); // recovery window passes
    expect(f.sayCalls).toHaveLength(1); // filler only — the reply is never talked over
  });

  it('SAD, still covered: filler done while agent NOT speaking (genuine dead air) → recovery still fires', async () => {
    // The settle-beat disarm must not swallow real dead air: the filler's playout
    // completes while the agent state is still 'thinking' (no reply audio ever
    // came) → the beat finds no speaking → timer2 survives → recovery.
    _resetToolActivityForTest();
    const f = makeFakeSession();
    attach(f);
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500); // filler plays; state stays 'thinking'
    f.handles[0].fireDone(); // filler playout over, still dead air
    await vi.advanceTimersByTimeAsync(300); // settle beat: NOT speaking → no disarm
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.sayCalls.map((c) => c.text)).toEqual(['Just a moment.', RECOVERY]);
  });

  it('SAD, live 2: reply already QUEUED at deadline 1 and it SPEAKS → no filler, no recovery', async () => {
    // WHO: the 2026-07-21 second stomp call. The reply's SpeechHandle joins the
    // queue ~300ms before its audio starts; the filler fired inside that window,
    // queued BEHIND the reply, and the caller heard question + "Just a moment."
    // + recovery run together ("you're running all these sentences together").
    // WHAT: with a speech scheduled or playing, the filler is clutter — skip it.
    // The escalation stays armed but the 'speaking' transition disarms it, so a
    // reply that actually arrives is never talked over.
    _resetToolActivityForTest();
    const f = makeFakeSession();
    attach(f);
    f.setActivity({ currentSpeech: {}, speechQueue: { size: () => 0 } });
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500);
    f.emit('speaking'); // the queued reply's audio starts
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.sayCalls).toHaveLength(0);
  });

  it('SAD, live 2 silent: reply QUEUED but it never makes a sound → recovery covers the dead air', async () => {
    // WHO: sim-call-1786817155950, 2026-08-15, twice in one call.
    // WHAT: TTS accepted the turn, produced ZERO audio frames, and the framework
    //       only gave up at its own `ttsReadIdleTimeout` — 10.00s, measured.
    // WHEN: deadline1 saw a queued speech and (before this) stood down entirely.
    // WHERE: fireFiller's `reply_already_queued` branch.
    // WHY: the caller sat through ten seconds of nothing and said "Hello? Are
    //      you there?" — then, after the second one, "I said it already. Didn't
    //      you hear it?". A queued reply is a PROMISE of audio, not audio; when
    //      it breaks that promise something must still be watching.
    _resetToolActivityForTest();
    const f = makeFakeSession();
    attach(f);
    f.setActivity({ currentSpeech: {}, speechQueue: { size: () => 0 } });
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500); // deadline1: hold line correctly skipped
    expect(f.sayCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4000); // deadline2: still no audio
    expect(f.sayCalls.map((c) => c.text)).toEqual([RECOVERY]);
  });

  it('SAD, live 2 race: reply slips in AFTER the filler → recovery skipped, stray filler cancelled', async () => {
    // The narrower race: the queue was empty when the filler fired, but the
    // reply got scheduled moments later — at deadline2 the agent is 'speaking'
    // (the ~1.2s filler cannot still be playing 4s on, so that audio IS the
    // reply). The recovery must NOT stack a third line onto live output, and
    // the filler still queued behind the reply must be interrupted so it never
    // plays as a stray after-thought.
    _resetToolActivityForTest();
    const f = makeFakeSession();
    attach(f);
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500); // filler fires (queue looked empty)
    expect(f.sayCalls).toHaveLength(1);
    f.emit('speaking'); // audio starts — actually the REPLY; filler never plays
    await vi.advanceTimersByTimeAsync(4000); // deadline2
    expect(f.sayCalls).toHaveLength(1); // no recovery line
    expect(f.handles[0].interrupted).toBe(true); // stray filler cancelled
  });

  it('detach() clears a pending timer (no filler after teardown)', async () => {
    const f = makeFakeSession();
    const detach = attach(f);
    f.emit('thinking');
    detach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.sayCalls).toHaveLength(0);
  });
});

describe('turn latency reporting (T-006)', () => {
  beforeEach(() => _resetFillerCacheForTest());

  it('HAPPY: attachSilentTurnRecovery reports the turn it logs', () => {
    // WHO: every prod call — this attach is unconditional.
    // WHY: turn_latency_ms was a LOG LINE only, and prod ships logs to a sink
    //      that is not configured, so a 20s dead-air turn was measurable and
    //      unalertable at the same time. The callback is the path to /metrics.
    const f = makeFakeSession();
    const seen: Array<{ ms: number; hold: boolean }> = [];
    attachSilentTurnRecovery(f.session, {
      voice: 'eve',
      recoveryText: RECOVERY,
      log: noopLog,
      onTurnLatency: (ms, hold) => seen.push({ ms, hold }),
    });
    f.emit('thinking');
    f.emit('speaking');
    expect(seen).toHaveLength(1);
    expect(seen[0].ms).toBeGreaterThanOrEqual(0);
    expect(seen[0].hold).toBe(false);
  });

  it('SAD: one turn reports ONCE, even when a later say() re-enters speaking', () => {
    // The recovery line is spoken via a direct say() that never passes through
    // 'thinking'. Without the thinkingAtMs reset, that second 'speaking' would
    // report a second latency for the same turn and double-count the sample.
    const f = makeFakeSession();
    const seen: number[] = [];
    attachSilentTurnRecovery(f.session, {
      voice: 'eve',
      recoveryText: RECOVERY,
      log: noopLog,
      onTurnLatency: (ms) => seen.push(ms),
    });
    f.emit('thinking');
    f.emit('speaking');
    f.emit('speaking');
    expect(seen).toHaveLength(1);
  });

  it('SAD: with the output watchdog active this copy reports NOTHING', () => {
    // Exactly one watchdog owns the measurement. Both reporting would put a
    // filler's time-to-audio and the real reply's into the same histogram, and
    // the p95 would then describe a mixture of two different things.
    const f = makeFakeSession();
    const seen: number[] = [];
    attachSilentTurnRecovery(f.session, {
      voice: 'eve',
      recoveryText: RECOVERY,
      log: noopLog,
      outputWatchdogActive: true,
      onTurnLatency: (ms) => seen.push(ms),
    });
    f.emit('thinking');
    f.emit('speaking');
    expect(seen).toHaveLength(0);
  });
});

describe('attachSilentTurnRecovery', () => {
  beforeEach(() => _resetFillerCacheForTest());

  const attachRecovery = (s: ReturnType<typeof makeFakeSession>) =>
    attachSilentTurnRecovery(s.session, {
      voice: 'eve',
      recoveryText: RECOVERY,
      log: noopLog,
    });

  it('SAD: turn dies thinking → listening with no audio → forces a spoken, TOOL-FREE reply', () => {
    // WHO: the 2026-07-17 live caller ("Monday at 1:30"). WHAT: the model burned
    // its maxToolSteps on lookups, LiveKit ended the turn with NO speech, and the
    // agent went thinking → listening in silence. WHERE: the exact transition the
    // hold-line watchdog treats as "resolved". WHY: the caller said "Hello?" twice
    // into the void and hung up — the runtime, not the model, must fill this.
    const f = makeFakeSession();
    attachRecovery(f);
    f.emit('thinking');
    f.emit('listening'); // turn OVER, zero audio
    expect(f.generateReplyCalls).toHaveLength(1);
    // toolChoice 'none' is what makes the forced turn un-killable by the same
    // cap — no tools, no steps, the only move is words.
    expect(f.generateReplyCalls[0].toolChoice).toBe('none');
    expect(f.generateReplyCalls[0].instructions).toBe(NUDGE_INSTRUCTIONS);
  });

  it('HAPPY: a normal turn (thinking → speaking → listening) never triggers it', () => {
    const f = makeFakeSession();
    attachRecovery(f);
    f.emit('thinking');
    f.emit('speaking'); // real reply
    f.emit('listening'); // normal turn end
    expect(f.generateReplyCalls).toHaveLength(0);
    expect(f.sayCalls).toHaveLength(0);
  });

  it('turn_latency_ms logs on every real turn — the UNCONDITIONAL copy of the instrument', () => {
    // WHY THIS EXISTS: attachOutputWatchdog's copy lives behind
    // ENABLE_OUTPUT_WATCHDOG. Prod ran that flag OFF — confirmed live 2026-08-19
    // (sim-call-1787158785189): a real call had 17s and 20s thinking→speaking
    // gaps and ZERO turn_latency_ms lines anywhere in the deployed log. This
    // copy is unconditional, so it fires when the hold-line watchdog is off.
    // When outputWatchdogActive is true, this copy is suppressed (test below).
    const logs: Array<{ level: 'info' | 'warn'; obj: Record<string, unknown> }> = [];
    const log = {
      info: (obj: Record<string, unknown>) => logs.push({ level: 'info', obj }),
      warn: (obj: Record<string, unknown>) => logs.push({ level: 'warn', obj }),
    };
    const f = makeFakeSession();
    attachSilentTurnRecovery(f.session, { voice: 'eve', recoveryText: RECOVERY, log });
    f.emit('thinking');
    f.emit('speaking');
    f.emit('listening');
    const latencyLogs = logs.filter((l) => l.obj.event === 'turn_latency_ms');
    expect(latencyLogs).toHaveLength(1);
    expect(latencyLogs[0].obj.hold_played).toBe(false); // this path never has a filler
    expect(typeof latencyLogs[0].obj.latency_ms).toBe('number');
  });

  it("a nudge's own reply logs its own fresh turn_latency_ms (thinkingAtMs resets on the retry's 'thinking')", () => {
    const logs: Array<{ level: 'info' | 'warn'; obj: Record<string, unknown> }> = [];
    const log = {
      info: (obj: Record<string, unknown>) => logs.push({ level: 'info', obj }),
      warn: (obj: Record<string, unknown>) => logs.push({ level: 'warn', obj }),
    };
    const f = makeFakeSession();
    attachSilentTurnRecovery(f.session, { voice: 'eve', recoveryText: RECOVERY, log });
    f.emit('thinking');
    f.emit('listening'); // death #1 → nudge fires (generateReply)
    f.emit('thinking'); // the nudge's own turn — resets thinkingAtMs fresh
    f.emit('speaking'); // the nudge speaks
    const latencyLogs = logs.filter((l) => l.obj.event === 'turn_latency_ms');
    expect(latencyLogs).toHaveLength(1); // only the nudge's turn produced audio
  });

  it('the canned recovery line (second escalation) does NOT log a stale turn_latency_ms', () => {
    // The canned line plays via a direct say() that never re-enters 'thinking'.
    // Without the explicit null before it, a 'speaking' the fake test harness
    // (or a real session) emits for that playback would compute latency
    // against the ORIGINAL nudge's now-ancient thinking start.
    const logs: Array<{ level: 'info' | 'warn'; obj: Record<string, unknown> }> = [];
    const log = {
      info: (obj: Record<string, unknown>) => logs.push({ level: 'info', obj }),
      warn: (obj: Record<string, unknown>) => logs.push({ level: 'warn', obj }),
    };
    const f = makeFakeSession();
    attachSilentTurnRecovery(f.session, { voice: 'eve', recoveryText: RECOVERY, log });
    f.emit('thinking');
    f.emit('listening'); // death #1 → nudge fires
    f.emit('thinking'); // nudge's own turn
    f.emit('listening'); // death #2 → nudge ALSO died silent → canned recovery plays
    f.emit('speaking'); // the canned recovery line's own audio
    const latencyLogs = logs.filter((l) => l.obj.event === 'turn_latency_ms');
    expect(latencyLogs).toHaveLength(0);
  });

  it('outputWatchdogActive:true suppresses this copy of turn_latency_ms entirely', () => {
    // Copilot review on PR #347: when attachOutputWatchdog is ALSO attached
    // (ENABLE_OUTPUT_WATCHDOG on), it distinguishes a filler's own 'speaking'
    // from the real reply's; this function cannot. Without this flag, a
    // filler's 'speaking' would get logged here as the turn's latency (wrong
    // — measures time-to-filler, not time-to-reply) and consume thinkingAtMs,
    // silently dropping the real, correct measurement attachOutputWatchdog
    // would otherwise log for the same turn.
    const logs: Array<{ level: 'info' | 'warn'; obj: Record<string, unknown> }> = [];
    const log = {
      info: (obj: Record<string, unknown>) => logs.push({ level: 'info', obj }),
      warn: (obj: Record<string, unknown>) => logs.push({ level: 'warn', obj }),
    };
    const f = makeFakeSession();
    attachSilentTurnRecovery(f.session, {
      voice: 'eve',
      recoveryText: RECOVERY,
      log,
      outputWatchdogActive: true,
    });
    f.emit('thinking');
    f.emit('speaking'); // would have logged if outputWatchdogActive were false/unset
    f.emit('listening');
    expect(logs.filter((l) => l.obj.event === 'turn_latency_ms')).toHaveLength(0);
  });

  it('SAD but deferred: caller is mid-utterance when the turn dies → stays quiet (gotcha D)', () => {
    // WHO: a caller who barged in while the agent was thinking. WHAT: their own
    // new turn IS the recovery; speaking now would talk over them. WHY: gotcha D —
    // the runtime must never fill silence by talking over a human.
    const f = makeFakeSession();
    attachRecovery(f);
    f.setUserState('speaking');
    f.emit('thinking');
    f.emit('listening');
    expect(f.generateReplyCalls).toHaveLength(0);
    expect(f.sayCalls).toHaveLength(0);
  });

  it('SAD, twice: the forced reply ALSO dies silent → escalates ONCE to the canned recovery line', () => {
    // WHAT: if the nudged turn somehow produces no audio either, we must not
    // nudge forever (an unbounded generate loop is its own bug) — one canned
    // line, then stop.
    const f = makeFakeSession();
    attachRecovery(f);
    f.emit('thinking');
    f.emit('listening'); // death #1 → nudge
    expect(f.generateReplyCalls).toHaveLength(1);
    f.emit('thinking');
    f.emit('listening'); // death #2, nudge still unresolved → canned line, no second nudge
    expect(f.generateReplyCalls).toHaveLength(1);
    expect(f.sayCalls.map((c) => c.text)).toEqual([RECOVERY]);
  });

  it('recovers repeatedly across the call: audio between deaths re-arms the nudge', () => {
    // WHAT: once ANY agent audio plays, the in-flight flag clears — a later,
    // unrelated silent death gets its own fresh nudge (not the escalation path).
    const f = makeFakeSession();
    attachRecovery(f);
    f.emit('thinking');
    f.emit('listening'); // death #1 → nudge
    f.emit('speaking'); // the nudged reply plays — cycle resolved
    f.emit('listening');
    f.emit('thinking');
    f.emit('listening'); // death #2, fresh cycle → nudge again
    expect(f.generateReplyCalls).toHaveLength(2);
    expect(f.sayCalls).toHaveLength(0);
  });

  it('detach() removes the listener (no nudge after teardown)', () => {
    const f = makeFakeSession();
    const detach = attachRecovery(f);
    detach();
    f.emit('thinking');
    f.emit('listening');
    expect(f.generateReplyCalls).toHaveLength(0);
  });

  it('a CLOSING session never gets nudged — the teardown flap is not a silent death', () => {
    // WHO: every clean hang-up on 2026-07-21. finish_call's goodbye plays, the
    // session tears down, and the closing state flap (thinking → listening with
    // no speech) looked exactly like the failure this recovery exists for —
    // generateReply then threw "AgentSession is closing" and logged a failure
    // on every successful call. A goodbye is not a death.
    const f = makeFakeSession();
    attachRecovery(f);
    (f.session as unknown as { closing?: boolean }).closing = true;
    f.emit('thinking');
    f.emit('listening');
    expect(f.generateReplyCalls).toHaveLength(0);
    expect(f.sayCalls).toHaveLength(0);
  });

  it('the nudge wording carries the two live-firing lessons (re-ask; end with a question)', () => {
    // WHO: the 2026-07-17 16:02 UTC caller, on the recovery's FIRST live firing.
    // WHAT: v1 said "use what you already know" → the model answered its OWN
    //       pending read-back question ("Thank you! That's correct") — the
    //       caller never confirmed the number. And it promised "one moment"
    //       from a turn that holds no tools, then sat quiet for 20s.
    // WHY: pin the two load-bearing phrases so a future rewording can't
    //       silently drop either lesson.
    expect(NUDGE_INSTRUCTIONS).toMatch(/ask that question again/i);
    expect(NUDGE_INSTRUCTIONS).toMatch(/you do not know their answer/i);
    expect(NUDGE_INSTRUCTIONS).toMatch(/end by asking the caller a question/i);
    expect(NUDGE_INSTRUCTIONS).not.toMatch(/what you already know/i);
  });
});

describe('onSpoken — watchdog speech reaches the transcript (batch H, 2026-07-30)', () => {
  beforeEach(() => {
    _resetFillerCacheForTest();
    _resetToolActivityForTest();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('hold line played → onSpoken gets the exact text (addToChatCtx stays false)', async () => {
    // WHO: the 07-27 silent calls (#5/#6) — 40s of "nothing" between greeting
    //      and hangup, with no way to tell whether dead-air handling ever fired,
    //      because every watchdog say() skips the chat context AND therefore the
    //      ConversationItemAdded-driven transcript.
    // WHAT: the say still skips chat context; onSpoken hands the same text to
    //      the TranscriptRecorder so the transcript reports what was SPOKEN.
    const spoken: string[] = [];
    const f = makeFakeSession();
    attachOutputWatchdog(f.session, {
      voice: 'eve',
      thinkingText: 'Just a moment.',
      fillerText: FILLER,
      recoveryText: RECOVERY,
      log: noopLog,
      onSpoken: (t) => spoken.push(t),
    });
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500);
    expect(f.sayCalls).toHaveLength(1);
    expect(spoken).toEqual(['Just a moment.']); // no tool running → thinking line
    // The chat-context contract is unchanged — hold lines never brief the model.
    expect((f.sayCalls[0].opts as { addToChatCtx?: boolean }).addToChatCtx).toBe(false);
  });

  it('recovery escalation line → onSpoken fires; the generateReply nudge does NOT (it transcripts itself)', () => {
    const spoken: string[] = [];
    const f = makeFakeSession();
    attachSilentTurnRecovery(f.session, {
      voice: 'eve',
      recoveryText: RECOVERY,
      log: noopLog,
      onSpoken: (t) => spoken.push(t),
    });
    // First silent death → generateReply nudge (a normal turn: transcripted via
    // ConversationItemAdded, so onSpoken must NOT double-record it).
    f.emit('thinking');
    f.emit('listening');
    expect(f.generateReplyCalls).toHaveLength(1);
    expect(spoken).toEqual([]);
    // The nudge ALSO dies silent → canned escalation line via say() — the one
    // utterance nothing else records.
    f.emit('thinking');
    f.emit('listening');
    expect(f.sayCalls.map((s) => s.text)).toEqual([RECOVERY]);
    expect(spoken).toEqual([RECOVERY]);
  });

  it('onSpoken omitted → everything still works (the callback is strictly optional)', async () => {
    const f = makeFakeSession();
    attachOutputWatchdog(f.session, {
      voice: 'eve',
      thinkingText: 'Just a moment.',
      fillerText: FILLER,
      recoveryText: RECOVERY,
      log: noopLog,
    });
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(2500);
    expect(f.sayCalls).toHaveLength(1); // no throw, hold line still plays
  });
});

describe('attachCallerSilenceWatch — the gap nobody was watching (batch F)', () => {
  beforeEach(() => {
    _resetFillerCacheForTest();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const CHECK_IN = 'Are you still there?';

  const attachSilence = (f: ReturnType<typeof makeFakeSession>, onGiveUp = () => {}) =>
    attachCallerSilenceWatch(f.session, {
      checkInText: CHECK_IN,
      onGiveUp,
      silenceMs: 10_000,
      giveUpMs: 12_000,
      log: noopLog,
    });

  it('SAD: caller goes quiet after the greeting → ONE check-in, then the call is closed out', async () => {
    // WHO: the 2026-07-27 calls that held 13-42s of dead air after the greeting
    //      and said nothing into it — one from a caller waiting for a human at
    //      the exact time she had been told to ring back (#5, #6).
    const giveUp = vi.fn();
    const f = makeFakeSession();
    attachSilence(f, giveUp);
    f.emit('listening'); // agent finished the greeting; the caller's clock starts

    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sayCalls.map((s) => s.text)).toEqual([CHECK_IN]);
    expect(giveUp).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(12_000);
    expect(giveUp).toHaveBeenCalledOnce();
    // Exactly one check-in, ever — a line repeated at a silent caller is noise.
    expect(f.sayCalls).toHaveLength(1);
  });

  it('HAPPY: a caller who speaks resets everything — and gets the full two beats again later', async () => {
    const giveUp = vi.fn();
    const f = makeFakeSession();
    attachSilence(f, giveUp);
    f.emit('listening');
    await vi.advanceTimersByTimeAsync(9_000);

    // Caller speaks: cancels the pending check-in outright.
    f.setUserState('speaking');
    f.emitUserState('speaking');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.sayCalls).toHaveLength(0);
    expect(giveUp).not.toHaveBeenCalled();

    // They fall quiet again → the SAME two beats, not an instant hang-up.
    f.setUserState('listening');
    f.emitUserState('listening');
    f.emit('listening');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sayCalls.map((s) => s.text)).toEqual([CHECK_IN]);
  });

  it('the agent speaking is never counted as the CALLER being silent', async () => {
    const giveUp = vi.fn();
    const f = makeFakeSession();
    attachSilence(f, giveUp);
    f.emit('thinking');
    await vi.advanceTimersByTimeAsync(60_000);
    f.emit('speaking');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sayCalls).toHaveLength(0);
    expect(giveUp).not.toHaveBeenCalled();
  });

  it('detaching stops the clock — a torn-down session never speaks into a dead line', async () => {
    const giveUp = vi.fn();
    const f = makeFakeSession();
    const detach = attachSilence(f, giveUp);
    f.emit('listening');
    detach();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sayCalls).toHaveLength(0);
    expect(giveUp).not.toHaveBeenCalled();
  });
});
