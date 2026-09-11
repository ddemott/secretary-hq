/**
 * The audio hot path. Every token of every spoken word goes through this, so the
 * tests care about two things in this order:
 *
 *   1. NEVER MANGLE SPEECH. A sanitizer that eats a word, or glues two together,
 *      turns a formatting nit into a comprehension bug — far worse than the thing
 *      it fixed. (I wrote exactly that bug: the first version trimmed each chunk,
 *      which would have turned "Hello" + " world" into "Helloworld". Caught before
 *      it shipped, and pinned here so it stays caught.)
 *   2. Then: no markdown reaches TTS.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeForSpeech,
  sanitizeChunk,
  sanitizeStream,
  nameTheOwner,
  nameTheOwnerStream,
  spokenOwnerName,
} from './speechSanitizer.js';

async function collectChunks(chunks: string[], ownerName?: string | null): Promise<string[]> {
  const input = new ReadableStream<string>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
  const out: string[] = [];
  const reader = sanitizeStream(input, { ownerName }).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

async function collect(chunks: string[], ownerName?: string | null): Promise<string> {
  return (await collectChunks(chunks, ownerName)).join('');
}

describe('speech sanitizer — markdown must never reach the voice', () => {
  it('SAD: the exact 2026-07-13 utterance is cleaned', () => {
    // WHO: every caller. WHAT: the model emitted markdown stage directions.
    // WHY: the owner said "voice was broken up, did not sound natural" — the
    //      asterisks are literal characters handed to TTS, which distorts prosody
    //      and inserts pauses. This is that exact string.
    const said =
      'Just a moment.\n\n*One moment while I look that up...*\n\nI see that 3 PM is taken.';
    const spoken = sanitizeForSpeech(said);

    expect(spoken).not.toContain('*');
    expect(spoken).toContain('One moment while I look that up');
    expect(spoken).toContain('3 PM');
  });

  it('strips emphasis, code and strike markers but keeps every word', () => {
    expect(sanitizeForSpeech('We have *2* or `3:30` with ~Carlos~ and _Maria_')).toBe(
      'We have 2 or 3:30 with Carlos and Maria'
    );
  });

  it('turns a lapsed list into prose instead of announcing "dash"', () => {
    expect(sanitizeForSpeech('- 2:00 PM\n- 3:30 PM')).toBe('2:00 PM 3:30 PM');
    expect(sanitizeForSpeech('1. Haircut\n2. Color')).toBe('Haircut Color');
  });

  it('speaks a link label, never a URL', () => {
    expect(sanitizeForSpeech('Use [this link](https://x.example/abc?t=9) to reschedule.')).toBe(
      'Use this link to reschedule.'
    );
  });

  it('HAPPY: real speech is left completely alone', () => {
    // WHY: the failure mode that matters most. Apostrophes, hyphens, colons and
    //      parentheses are all PART OF SPEECH — "don't", "well-known", "3:30".
    //      A sanitizer that touches them is worse than the bug it fixes.
    const real = "You're all set for 3:30 with Carlos — it's a 30-minute cut (our most popular).";
    expect(sanitizeForSpeech(real)).toBe(real);
  });
});

describe('streaming — words must not be glued together', () => {
  it('SAD: chunk boundaries preserve the space between words (the bug I nearly shipped)', async () => {
    // WHO: every caller. WHAT: TTS receives text as a STREAM of fragments.
    // WHY: my first version called the trimming sanitizer per-chunk, which would
    //      have turned "Hello" + " world" into "Helloworld" — making the voice
    //      WORSE than the markdown it was removing. This test is why that is not
    //      what shipped.
    expect(await collect(['Hello', ' world', ' — 3:30', ' works.'])).toBe(
      'Hello world — 3:30 works.'
    );
  });

  it('strips markers across a streamed utterance', async () => {
    expect(await collect(['Just a moment. ', '*One moment', ' while I look', ' that up...*'])).toBe(
      'Just a moment. One moment while I look that up...'
    );
  });

  it('a chunk that was ONLY a marker disappears without emitting an empty chunk', async () => {
    // WHY: an empty push is meaningless to TTS and in some engines ends the
    //      utterance early — which would cut the caller off mid-sentence.
    expect(await collect(['Booked', '*', ' for 3:30.'])).toBe('Booked for 3:30.');
  });

  it('newlines become spaces — a line break is a word boundary, not silence', () => {
    expect(sanitizeChunk('3:30\nor 4:00')).toBe('3:30 or 4:00');
  });
});

/**
 * The STREAMING path is the one that runs in production. Raised in review on #253:
 * sanitizeChunk stripped only emphasis, while sanitizeForSpeech (used by nothing on
 * the hot path) stripped headings and bullets too.
 *
 * A sanitizer whose REAL path is weaker than its TESTED path is worse than no
 * sanitizer, because it looks covered. These tests exercise the path that ships.
 */
describe('streaming path strips EVERYTHING the one-shot path does', () => {
  it('SAD: a lapsed bullet list is not read out as "dash, dash, dash"', async () => {
    expect(await collect(['I have:\n', '- 2:00 PM\n', '- 3:30 PM'])).toBe(
      'I have: 2:00 PM 3:30 PM'
    );
  });

  it('SAD: a numbered list loses its numbering markers', async () => {
    expect(await collect(['Options:\n1. Haircut\n', '2. Color'])).toBe('Options: Haircut Color');
  });

  it('SAD: heading and blockquote markers never reach TTS', async () => {
    expect(await collect(['## Hours\n', '> We are open 1 to 5.'])).toBe(
      'Hours We are open 1 to 5.'
    );
  });

  it('HAPPY: a hyphen INSIDE speech survives — it is a word, not a bullet', async () => {
    // WHY: the failure mode that matters. "30-minute" and "well-known" must not be
    //      mangled by a rule aimed at list bullets.
    expect(await collect(['It is a 30-minute cut', ' — very popular.'])).toBe(
      'It is a 30-minute cut — very popular.'
    );
  });
});

/**
 * Dale, 2026-09-11: "I am the owner but do not refer to statements like 'I will
 * pass this on to the owner'. People don't know what that means even if I am the
 * owner." The phrase reaches the model from DB question rows and backend tool
 * results the prompt cannot edit, so the spoken path rewrites it.
 */
describe('"the owner" is spoken as the owner\'s name', () => {
  it('SAD: the sentence Dale quoted is said with his name', () => {
    expect(nameTheOwner('I will pass this on to the owner.', 'Dale')).toBe(
      'I will pass this on to Dale.'
    );
  });

  it("SAD: the backend's take-message result and the RAG fallback read with the name", () => {
    // WHERE: src/routes/agentTools/messaging.ts and knowledge.ts — relayed nearly verbatim.
    expect(nameTheOwner('Message saved — the owner has been alerted.', 'Dale')).toBe(
      'Message saved — Dale has been alerted.'
    );
    expect(
      nameTheOwner("I'd be happy to take a message so the owner can get back to you", 'Dale')
    ).toBe("I'd be happy to take a message so Dale can get back to you");
  });

  it("SAD: possessive, sentence-start and 'business owner' forms", () => {
    // WHERE: the job tree's meeting_offer wording lives in tenant_question_nodes rows.
    expect(nameTheOwner("a meeting on the owner's calendar", 'Dale')).toBe(
      "a meeting on Dale's calendar"
    );
    expect(nameTheOwner('The owner will call you back.', 'dale')).toBe('Dale will call you back.');
    expect(nameTheOwner('I will let the business owner know.', 'Dale')).toBe(
      'I will let Dale know.'
    );
  });

  it('HAPPY: other owners and questions about the CALLER are left alone', () => {
    // WHY: a rewrite that mangles a real sentence is worse than the word it replaces.
    const untouched = [
      'Are you the owner of the vehicle?',
      'Are you the business owner?',
      "Dale is the owner, and I'm his assistant.",
      'Who is responsible — a property owner, a driver?',
      'We work with homeowners and the owners of small shops.',
    ];
    for (const s of untouched) expect(nameTheOwner(s, 'Dale')).toBe(s);
  });

  it('HAPPY: no name to say leaves the words exactly as produced', () => {
    expect(nameTheOwner('I will pass this on to the owner.', null)).toBe(
      'I will pass this on to the owner.'
    );
  });

  it('only a ONE-person roster has a name to say', () => {
    // WHY: guessing "Carlos" at a six-chair salon is worse than the role word.
    expect(spokenOwnerName(['Dale'])).toBe('Dale');
    expect(spokenOwnerName([' Dale ', ''])).toBe('Dale');
    expect(spokenOwnerName(['Carlos', 'Jane'])).toBeNull();
    expect(spokenOwnerName([])).toBeNull();
    expect(spokenOwnerName(undefined)).toBeNull();
  });

  it('SAD: STREAMED — "the" and " owner" arrive as separate tokens and are still rewritten', async () => {
    // WHY: this is how the LLM actually emits it. A per-chunk rewrite never sees the phrase.
    expect(await collect(['I will pass', ' this on to', ' the', ' owner', '.'], 'Dale')).toBe(
      'I will pass this on to Dale.'
    );
    expect(await collect(['on the', ' own', "er's", ' calendar'], 'Dale')).toBe(
      "on Dale's calendar"
    );
  });

  it('SAD: STREAMED — the phrase at the very END of the reply is rewritten on flush', async () => {
    expect(await collect(['I will let', ' the owner'], 'Dale')).toBe('I will let Dale');
  });

  it('HAPPY: STREAMED — "owner of" and "is the owner" survive across chunk boundaries', async () => {
    expect(await collect(['Are you', ' the owner', ' of the', ' car?'], 'Dale')).toBe(
      'Are you the owner of the car?'
    );
    expect(await collect(['Dale is', ' the', ' owner.'], 'Dale')).toBe('Dale is the owner.');
  });

  it('HAPPY: STREAMED — ordinary words are not held back or glued', async () => {
    // WHY: holding text back is dead air. Only a tail that could become "the owner" waits.
    const chunks = await collectChunks(
      ['Hello', ' world', ', with', ' 3:30', ' then', ' done.'],
      'Dale'
    );
    expect(chunks.join('')).toBe('Hello world, with 3:30 then done.');
    expect(chunks[0]).toBe('Hello');
  });

  it('HAPPY: STREAMED — markdown still stripped with the rewrite on', async () => {
    expect(await collect(['*Tell', ' the', ' owner*', ' now.'], 'Dale')).toBe('Tell Dale now.');
  });

  it('SAD: REAL gpt-4.1-mini token splits, recorded 2026-09-11', async () => {
    // WHERE: streamed from the prod voice model, not hand-written. The possessive
    // arrives fused (" owner's"), the sentence-start form as "The" + " owner".
    expect(
      await collect(['Let', ' me', ' check', ' the', " owner's", ' schedule', '.'], 'Dale')
    ).toBe("Let me check Dale's schedule.");
    expect(await collect(['The', ' owner', ' will', ' call', ' you', ' back', '.'], 'Dale')).toBe(
      'Dale will call you back.'
    );
    expect(
      await collect(
        [
          'No',
          ',',
          ' I',
          '’m',
          ' the',
          ' receptionist',
          '.',
          ' Something',
          ' for',
          ' the',
          ' owner',
          '?',
        ],
        'Dale'
      )
    ).toBe('No, I’m the receptionist. Something for Dale?');
  });
});

/**
 * The call record must say what the caller HEARD. LiveKit tees the model's text
 * BEFORE ttsNode: one branch to the voice, one to transcriptionNode, and the
 * transcript (voice_sessions.transcript, the dashboard, every call review) is
 * built from the second. Rewriting only the voice would leave the record saying
 * "the owner" while the caller heard "Dale".
 */
describe('the transcript is rewritten the same way (nameTheOwnerStream)', () => {
  async function run<T extends string | { text: string }>(
    chunks: T[],
    ownerName: string | null
  ): Promise<T[]> {
    const input = new ReadableStream<T>({
      start(c) {
        for (const chunk of chunks) c.enqueue(chunk);
        c.close();
      },
    });
    const out: T[] = [];
    const reader = nameTheOwnerStream(input, ownerName).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
    return out;
  }

  it('SAD: a streamed transcript names the owner, across token boundaries', async () => {
    expect((await run(['I will pass', ' this to', ' the', ' owner', '.'], 'Dale')).join('')).toBe(
      'I will pass this to Dale.'
    );
  });

  it('SAD: TIMED chunks are rewritten in place and keep their timing', async () => {
    // Timed chunks carry audio timing and are never split or merged.
    const out = await run(
      [
        { text: 'I will tell', startTime: 0.1, endTime: 0.9 },
        { text: ' the owner.', startTime: 1.0, endTime: 1.6 },
      ],
      'Dale'
    );
    expect(out).toEqual([
      { text: 'I will tell', startTime: 0.1, endTime: 0.9 },
      { text: ' Dale.', startTime: 1.0, endTime: 1.6 },
    ]);
  });

  it('HAPPY: the transcript keeps its markdown — only the owner rewrite is shared', async () => {
    // WHY: the transcript branch never stripped markdown; changing that is not this fix.
    expect((await run(['*Tell*', ' the', ' owner'], 'Dale')).join('')).toBe('*Tell* Dale');
  });

  it('HAPPY: no name — the very same stream comes back, untouched', () => {
    const input = new ReadableStream<string>();
    expect(nameTheOwnerStream(input, null)).toBe(input);
  });
});
