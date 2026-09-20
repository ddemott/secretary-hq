import { describe, it, expect, vi, afterEach } from 'vitest';
import { summarizeCall } from './callSummary.js';
import { classifyCallOutcome } from './callClassify.js';
import { TranscriptRecorder } from './transcript.js';

// WHO: the agent shutdown hook generating a post-call summary + WHY class.
// WHAT: summarizeCall returns a short summary on success and NULL on every
//       failure mode, always within the timeout, never throwing. Plus the
//       2026-07-23 fabrication guard: a greeting-only call (no caller turn)
//       must never reach the model to be invented into an outcome.
// WHERE: agent/src/callSummary.ts, callClassify.ts.
// WHY: the summary must never drop the working session-end write, AND must
//      never claim "left a message" for a call where nobody spoke.
const KEY = 'sk-test-key';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('summarizeCall (failsafe post-call summary)', () => {
  it('returns null for an empty transcript without calling OpenAI', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect((await summarizeCall('   ', KEY)).summary).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when no API key is provided', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect((await summarizeCall('Caller: hi', '')).summary).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the model summary on a 200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '  Caller booked an oil change.  ' } }],
        }),
      }))
    );
    expect((await summarizeCall('Caller: I need an oil change.', KEY)).summary).toBe(
      'Caller booked an oil change.'
    );
  });

  it('returns null on a non-200 response (e.g. 429)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    );
    expect((await summarizeCall('Caller: hi', KEY)).summary).toBeNull();
  });

  it('returns null (never throws) when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );
    await expect(summarizeCall('Caller: hi', KEY)).resolves.toEqual({ summary: null });
  });

  it('returns null when the model returns empty content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '' } }] }),
      }))
    );
    expect((await summarizeCall('Caller: hi', KEY)).summary).toBeNull();
  });
});

/**
 * The 2026-07-23 fabrication guard, proven end to end. A greeting-only call
 * (+1 650-770-0302) was summarized as "The caller inquired about hiring Dale and
 * left a message" — customer_messages was empty. The greeting itself lists
 * "hiring Dale … or leaving a message", so the model echoed the menu back as
 * fact. A call with no CALLER line must never reach the model. We mock the
 * network so "did it call the model?" is directly observable.
 */
const GREETING =
  "Thanks for calling! I'm Piper, Dale's AI Assistant. This call is transcribed for quality and service. I can help with hiring Dale, getting a computer fixed, or leaving a message. Tell me which.";

function mockOpenAI(content: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 50, completion_tokens: 8 },
    }),
  });
}

/** Build a rendered transcript the way the agent does at call end. */
function transcript(...turns: Array<['assistant' | 'user', string]>): string {
  const rec = new TranscriptRecorder();
  rec.add('assistant', GREETING);
  for (const [role, text] of turns) rec.add(role, text);
  return rec.render() ?? '';
}

describe('summarizeCall — greeting-only calls never reach the model', () => {
  it('SAD: immediate hang-up (greeting only) -> null, model NOT called', async () => {
    const fetchSpy = mockOpenAI('The caller inquired about hiring Dale and left a message.');
    vi.stubGlobal('fetch', fetchSpy);
    const res = await summarizeCall(transcript(), KEY);
    expect(res.summary).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled(); // the fabrication call is never made
  });

  it('SAD: long silent pause then hang-up (still greeting only) -> null, no model call', async () => {
    // Duration is irrelevant; the transcript is the same greeting-only text.
    const fetchSpy = mockOpenAI('Caller asked about a computer repair.');
    vi.stubGlobal('fetch', fetchSpy);
    const res = await summarizeCall(transcript(), KEY);
    expect(res.summary).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('HAPPY: caller says "hello? anyone there?" -> model IS called and summarizes', async () => {
    const fetchSpy = mockOpenAI('Caller asked if anyone was there and did not state a reason.');
    vi.stubGlobal('fetch', fetchSpy);
    const res = await summarizeCall(transcript(['user', 'Hello? Anyone there?']), KEY);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(res.summary).toBe('Caller asked if anyone was there and did not state a reason.');
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 8 });
  });

  it('HAPPY: caller leaves a real message -> summarized normally', async () => {
    const fetchSpy = mockOpenAI(
      'Caller left a message for Dale about an invoice, callback 555-0102.'
    );
    vi.stubGlobal('fetch', fetchSpy);
    const res = await summarizeCall(
      transcript(['user', 'Tell Dale that Sam from Apex called about the invoice, 555-0102.']),
      KEY
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(res.summary).toContain('message');
  });
});

describe('classifyCallOutcome — greeting-only calls are not classified as "message"', () => {
  it('SAD: greeting only -> null, model NOT called (would otherwise return "message")', async () => {
    // The greeting names "leaving a message"; without the guard the classifier
    // would pick 'message' for a call where nobody spoke.
    const fetchSpy = mockOpenAI('message');
    vi.stubGlobal('fetch', fetchSpy);
    const res = await classifyCallOutcome(transcript(), KEY);
    expect(res.outcome).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('HAPPY: caller who actually left a message classifies as "message"', async () => {
    const fetchSpy = mockOpenAI('message');
    vi.stubGlobal('fetch', fetchSpy);
    const res = await classifyCallOutcome(
      transcript(['user', 'Can you have Dale call me back? 555-0102.']),
      KEY
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(res.outcome).toBe('message');
  });

  it('HAPPY: an unrecognized classifier word is rejected to null', async () => {
    const fetchSpy = mockOpenAI('banana');
    vi.stubGlobal('fetch', fetchSpy);
    const res = await classifyCallOutcome(transcript(['user', 'What are your hours?']), KEY);
    expect(res.outcome).toBeNull(); // only the allowed category set survives
  });
});
