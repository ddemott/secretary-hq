import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_TRANSCRIPT_CHARS, TranscriptRecorder, renderedHasCallerTurn } from './transcript.js';

// WHO: the agent's conversation_item_added listener (index.ts) feeding spoken
//      turns to the recorder, drained by the shutdown callback.
// WHAT: TranscriptRecorder accumulates user/assistant turns and renders a
//      plain-text `Caller [m:ss]:`/`Assistant [m:ss]:` transcript for
//      end_voice_session. Offsets added 2026-07-30 (CALL_IMPROVEMENTS.md): the
//      silent calls and the 5-minute bot-mirror loop were undiagnosable from
//      an unstamped transcript — "where did the dead air sit" had no answer.
// WHERE: agent/src/transcript.ts.
// WHY: the Calls tab transcript section reads exactly this text; bad rendering
//      (blank lines, leaked system prompt, empty-string instead of NULL) would
//      surface to owners.
describe('TranscriptRecorder', () => {
  beforeEach(() => {
    // Fixed clock → deterministic [m:ss] stamps.
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('HAPPY: renders caller + assistant turns as labeled, TIMESTAMPED lines in order', () => {
    // WHEN: a normal two-way conversation with real gaps between turns.
    const rec = new TranscriptRecorder();
    rec.add('assistant', 'Thanks for calling Bella’s. How can I help?');
    vi.advanceTimersByTime(12_000);
    rec.add('user', 'I want to book a haircut.');
    vi.advanceTimersByTime(63_000); // a 1m03s think — the kind of gap the stamps exist to expose
    rec.add('assistant', 'Sure — what day works?');
    expect(rec.size).toBe(3);
    expect(rec.render()).toBe(
      'Assistant [0:00]: Thanks for calling Bella’s. How can I help?\n' +
        'Caller [0:12]: I want to book a haircut.\n' +
        'Assistant [1:15]: Sure — what day works?'
    );
  });

  it('HAPPY: empty recorder renders null (SQL NULL, not "")', () => {
    // WHEN: a silent hang-up — nothing was ever spoken.
    // WHY: the RPC must store NULL so the Calls tab hides the transcript
    //      section instead of showing a blank panel.
    const rec = new TranscriptRecorder();
    expect(rec.size).toBe(0);
    expect(rec.render()).toBeNull();
  });

  it('SAD: drops non-user/assistant roles (system / tool never leak in)', () => {
    // WHY: conversation_item_added is typed to ChatMessage, but a future SDK
    //      change or a system message must never put prompt text in a
    //      human-readable transcript.
    const rec = new TranscriptRecorder();
    rec.add('system', 'You are Clara, a receptionist…');
    rec.add('tool', '{"slots":[]}');
    rec.add('function', 'noise');
    rec.add('user', 'Hello?');
    expect(rec.size).toBe(1);
    expect(rec.render()).toBe('Caller [0:00]: Hello?');
  });

  it('SAD: skips empty / whitespace-only text (no blank transcript lines)', () => {
    // WHEN: STT emits an empty final, or a turn is whitespace only.
    const rec = new TranscriptRecorder();
    rec.add('user', '');
    rec.add('assistant', '   \n\t ');
    rec.add('user', null);
    rec.add('assistant', undefined);
    rec.add('user', '  trimmed me  ');
    expect(rec.size).toBe(1);
    // leading/trailing whitespace is trimmed on store.
    expect(rec.render()).toBe('Caller [0:00]: trimmed me');
  });

  it('SAD: truncates an over-cap transcript and marks it, keeping the start', () => {
    // WHEN: a pathological multi-hour call.
    // WHY: voice_sessions.transcript is unbounded TEXT; the recorder caps the
    //      rendered output so the agent never sends (and the schema never
    //      rejects) a multi-MB payload.
    const rec = new TranscriptRecorder();
    // 50k chars of 'a' across one assistant turn, repeated until well over cap.
    for (let i = 0; i < 6; i++) rec.add('assistant', 'a'.repeat(20_000));
    const out = rec.render();
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
    expect(out!.startsWith('Assistant [0:00]: aaaa')).toBe(true);
    expect(out!.endsWith('[transcript truncated]')).toBe(true);
  });

  it('SAD: a clock that jumps backwards never renders a negative offset', () => {
    // Date.now() is not monotonic (NTP correction mid-call). Clamped at 0.
    const rec = new TranscriptRecorder();
    vi.setSystemTime(999_000); // 1s BEFORE the recorder's start
    rec.add('user', 'Hello?');
    expect(rec.render()).toBe('Caller [0:00]: Hello?');
  });
});

// hasCallerTurn() gates the post-call summary. A real call (2026-07-23,
// +1 650-770-0302) hung up after the greeting; the summary model, handed only
// the greeting — which lists "hiring Dale … or leaving a message" — fabricated
// "The caller inquired about hiring Dale and left a message." No message
// existed. Summarizing a call with no caller turn can only invent, so index.ts
// (and summarizeCall/classifyCallOutcome) skip enrichment when the caller never
// spoke. These cases walk the ways a real call ends.
const GREETING =
  "Thanks for calling! I'm Piper, Dale's AI Assistant. This call is transcribed for quality and service. I can help with hiring Dale, getting a computer fixed, or leaving a message. Tell me which.";

describe('TranscriptRecorder.hasCallerTurn — how real calls end', () => {
  it('SAD: immediate hang-up — greeting plays, caller drops', () => {
    // The 2026-07-23 call. Greeting only; nothing to summarize.
    const rec = new TranscriptRecorder();
    rec.add('assistant', GREETING);
    expect(rec.hasCallerTurn()).toBe(false);
    expect(rec.render()).not.toContain('Caller');
  });

  it('SAD: long silent pause then hang-up — duration does NOT imply speech', () => {
    // A 36-second call where the caller sat silent then dropped renders the
    // SAME greeting-only transcript as a 5-second hang-up. The guard keys on
    // whether the caller SPOKE, never on how long the line was open — so a long
    // empty call must still read as no-caller-turn.
    const rec = new TranscriptRecorder();
    rec.add('assistant', GREETING);
    // No caller turn is ever added — STT produced nothing across 36s.
    expect(rec.hasCallerTurn()).toBe(false);
  });

  it('SAD: only STT noise for the caller (empty/whitespace finals) is not speech', () => {
    // Background noise / a muffled line can make STT emit empty finals. add()
    // drops them, so the caller must still read as not-yet-spoken.
    const rec = new TranscriptRecorder();
    rec.add('assistant', GREETING);
    rec.add('user', '');
    rec.add('user', '   \n ');
    expect(rec.hasCallerTurn()).toBe(false);
  });

  it('HAPPY: caller says only "hello? anyone there?" then hangs — that IS speech', () => {
    // Short and inconclusive, but the caller spoke. This one legitimately gets
    // summarized (the model can honestly say the caller asked if anyone was
    // there and got no further) — the guard must NOT suppress it.
    const rec = new TranscriptRecorder();
    rec.add('assistant', GREETING);
    rec.add('user', 'Hello? Anyone there?');
    expect(rec.hasCallerTurn()).toBe(true);
  });

  it('HAPPY: caller mumbles filler then rings off', () => {
    const rec = new TranscriptRecorder();
    rec.add('assistant', GREETING);
    rec.add('user', 'Uh, yeah, hi, um…');
    expect(rec.hasCallerTurn()).toBe(true);
  });

  it('HAPPY: caller leaves a real message', () => {
    const rec = new TranscriptRecorder();
    rec.add('assistant', GREETING);
    rec.add('user', 'Tell Dale that Sam from Apex called about the invoice, 555-0102.');
    rec.add('assistant', "Got it — I'll pass that along.");
    expect(rec.hasCallerTurn()).toBe(true);
  });

  it('empty transcript (never connected) has no caller turn', () => {
    expect(new TranscriptRecorder().hasCallerTurn()).toBe(false);
  });
});

describe('renderedHasCallerTurn — the string-level twin used by the enrichers', () => {
  it('matches only a caller line at the START of a line', () => {
    // "Caller:" buried inside the assistant's own words must not count.
    expect(renderedHasCallerTurn('Assistant [0:00]: I can note "Caller:" style labels.')).toBe(
      false
    );
    expect(renderedHasCallerTurn(`Assistant [0:00]: ${GREETING}`)).toBe(false);
    expect(renderedHasCallerTurn(`Assistant [0:00]: ${GREETING}\nCaller [0:09]: Hi there.`)).toBe(
      true
    );
  });

  it('still matches the PRE-timestamp format — historical rows run through this too', () => {
    // Transcripts stored before 2026-07-30 have bare "Caller: " lines, and the
    // enrichers can be pointed at a stored transcript (re-summarize tooling).
    expect(renderedHasCallerTurn('Assistant: hello\nCaller: Hi there.')).toBe(true);
    expect(renderedHasCallerTurn('Assistant: mentions Caller: inline')).toBe(false);
  });

  it('null / empty is not a caller turn', () => {
    expect(renderedHasCallerTurn(null)).toBe(false);
    expect(renderedHasCallerTurn('')).toBe(false);
  });
});

describe('markLastAssistantUnheard', () => {
  it('HAPPY: marks the last assistant line and renders the warning in its label', () => {
    // WHO: a caller on sim-call-1786817155950, 2026-08-15.
    // WHAT: TTS accepted the turn and emitted zero audio frames, so the text
    //       reached the transcript and never reached the caller.
    // WHEN: the silent-turn recovery fires.
    // WHERE: agent/src/transcript.ts, called from index.ts.
    // WHY: the record said the agent read the phone number back; the caller's
    //      next words were "You just didn't say anything." A call record that
    //      shows speech nobody heard sends the owner looking for the wrong bug.
    const t = new TranscriptRecorder(Date.now());
    t.add('assistant', 'What is the best number to reach you at?');
    t.add('user', '608 111 8652');
    t.add('assistant', "That's 6 0 8, 1 1 1, 8 6 5 2, correct?");

    expect(t.markLastAssistantUnheard()).toBe(true);

    const rendered = t.render() ?? '';
    expect(rendered).toContain('Assistant (NOT HEARD — no audio reached the caller)');
    expect(rendered).toContain("That's 6 0 8, 1 1 1, 8 6 5 2, correct?");
    // The EARLIER assistant line was heard and must stay unmarked.
    expect(rendered).toContain('Assistant [0:00]: What is the best number');
  });

  it('walks back past the caller’s turns — they were real, the agent’s was not', () => {
    // The caller usually speaks into the silence ("Hello? Are you there?")
    // before the recovery fires, so the LAST line is often theirs.
    const t = new TranscriptRecorder(Date.now());
    t.add('assistant', 'Thanks, Bob.');
    t.add('user', 'Hello? Are you there?');

    expect(t.markLastAssistantUnheard()).toBe(true);

    const rendered = t.render() ?? '';
    expect(rendered).toContain('Assistant (NOT HEARD');
    expect(rendered).toContain('Caller [0:00]: Hello? Are you there?');
    expect(rendered).not.toContain('Caller (NOT HEARD');
  });

  it('SAD: returns false when there is no assistant turn to mark, and when already marked', () => {
    // WHY: "marked it" and "there was nothing to mark" are different facts, and
    //      a caller that cannot tell them apart will log the wrong one.
    const empty = new TranscriptRecorder(Date.now());
    expect(empty.markLastAssistantUnheard()).toBe(false);

    const callerOnly = new TranscriptRecorder(Date.now());
    callerOnly.add('user', 'Hello?');
    expect(callerOnly.markLastAssistantUnheard()).toBe(false);

    const once = new TranscriptRecorder(Date.now());
    once.add('assistant', 'Thanks, Bob.');
    expect(once.markLastAssistantUnheard()).toBe(true);
    expect(once.markLastAssistantUnheard()).toBe(false);
  });
});
