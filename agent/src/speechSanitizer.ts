/**
 * Strip markdown and stage directions from the LLM's text BEFORE it reaches TTS.
 *
 * WHY THIS EXISTS (the 2026-07-13 call — the owner's verdict was "voice was broken
 * up, did not sound natural"). This is what the model actually emitted:
 *
 *   "Let me check for available slots for a meeting at 3 PM today. Just a moment.
 *
 *    *One moment while I look that up...*
 *
 *    I see that 3 PM is taken."
 *
 * Two separate defects in one turn:
 *
 *   1. MARKDOWN REACHED THE VOICE. The asterisks are literal characters in the
 *      text handed to TTS. gpt-4o-mini-tts does not silently ignore them — they
 *      distort prosody, insert pauses, and can be vocalised. That is the "broken
 *      up, unnatural" sound.
 *
 *   2. IT SAID "one moment" TWICE. Once as speech ("Just a moment"), once as a
 *      markdown stage direction. The caller hears the assistant stalling, then
 *      stalling again, in a different voice-shape.
 *
 * The prompt ALREADY forbade both — "no markdown, no bullet points, no formatting"
 * has been in the Conversation style section the whole time. The model did it
 * anyway.
 *
 * That is the lesson worth keeping: a prompt is a REQUEST. If a class of output
 * must never reach a customer's ear, the pipeline has to make it impossible, not
 * ask nicely. This function is the guarantee.
 *
 * DESIGN CONSTRAINT — this sits on the audio hot path, on every token of every
 * spoken word. It must be cheap, and it must NEVER drop content: a sanitizer that
 * eats a word turns a formatting nit into a comprehension bug, which is far worse
 * than the thing it fixed. So: remove the formatting CHARACTERS, keep every word.
 */

/**
 * Characters that markdown uses for emphasis/structure and that TTS should never
 * see. Deliberately conservative — we strip decoration, never words.
 *
 * NOT stripped: apostrophes, hyphens, and periods (they're part of real speech —
 * "3:30", "don't", "well-known"), and parentheses (a real aside reads fine).
 */
export function sanitizeForSpeech(text: string): string {
  return (
    text
      // Emphasis / code markers: *bold*, _italic_, `code`, ~strike~
      .replace(/[*_`~]/g, '')
      // Heading and blockquote markers, only at the start of a line — a '#' or '>'
      // mid-sentence is real punctuation and stays.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s+/gm, '')
      // List bullets at the start of a line ("- item", "1. item"). The words stay;
      // only the bullet goes, so a model that lapses into a list still reads as
      // prose instead of announcing "dash".
      .replace(/^\s{0,3}[-+•]\s+/gm, '')
      .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
      // Markdown links: [text](url) → text. The URL is unspeakable; the label is
      // the only part a caller could use.
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Collapse the whitespace all of the above leaves behind. Newlines become
      // spaces: a line break is a visual device with no meaning in speech.
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Stream form, for LiveKit's `ttsNode` — the text arrives as a stream of chunks.
 *
 * IMPORTANT: sanitize per-chunk rather than buffering the whole utterance. TTS is
 * streaming; holding the full text back to clean it would add latency to every
 * reply, and dead air is a worse bug than a stray asterisk (it is the bug this
 * codebase already fought once — see fallback.ts and the watchdog).
 *
 * The cost of per-chunk work is that a marker split ACROSS chunks ("*" then "One
 * moment") can slip through. In practice the model emits punctuation attached to
 * the token that follows it, and a rare surviving asterisk is a far smaller harm
 * than a stall. Correctness here is measured in the caller's ear, not in a diff.
 */
export function sanitizeChunk(chunk: string): string {
  // MUST NOT trim or collapse leading/trailing whitespace: chunks are fragments of
  // one sentence, and the space between them IS the space between words. Trimming
  // per-chunk turns "Hello" + " world" into "Helloworld" — a sanitizer that makes
  // the speech WORSE than the markdown it removed. (I wrote that bug, then caught
  // it here. Hence this comment, and the test that pins it.)
  //
  // This must strip EVERYTHING sanitizeForSpeech does, because sanitizeStream is
  // the path that actually runs in production — the non-streaming form exists for
  // tests and one-shot text. Raised in review on #253: the first version stripped
  // only emphasis here, so a model that lapsed into a bulleted list would still
  // have had "dash, dash, dash" read aloud to a caller. A sanitizer whose real path
  // is weaker than its tested path is worse than no sanitizer, because it looks
  // covered.
  return (
    chunk
      .replace(/[*_`~]/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Line-leading markdown structure. Applied per-line within the chunk (/m), so
      // any bullet or heading that follows a newline INSIDE this chunk is caught.
      // A marker split across the chunk boundary can still slip through — the
      // accepted cost of not buffering (dead air is the worse bug), and a stray
      // dash is survivable where a stall is not.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]{0,3}>[ \t]+/gm, '')
      .replace(/^[ \t]{0,3}[-+•][ \t]+/gm, '')
      .replace(/^[ \t]{0,3}\d+[.)][ \t]+/gm, '')
      // A newline is a visual device with no meaning in speech — but it IS a word
      // boundary, so it becomes a space rather than nothing.
      .replace(/[\r\n]+/g, ' ')
  );
}

/**
 * "THE OWNER" IS SAID AS THE PERSON'S NAME.
 *
 * Dale, 2026-09-11: "I am the owner but do not refer to statements like 'I will
 * pass this on to the owner'. People don't know what that means even if I am the
 * owner." A caller ringing a one-person business has no idea who "the owner" is,
 * and a receptionist who says it sounds like a filing cabinet.
 *
 * The prompt already asks for the name (checklistAgent.ts `ownerReference`), and
 * a prompt is a request. The phrase reaches the model from places the prompt does
 * not control: question-tree wording that lives in DATABASE ROWS
 * (`tenant_question_nodes` — "a meeting on the owner's calendar"), backend tool
 * results the model relays nearly verbatim ("Message saved — the owner has been
 * alerted.", the RAG fallback's "so the owner can get back to you"), and the
 * model's own habit. This is the one place every spoken word passes, so this is
 * where the rule is made a guarantee.
 *
 * Deliberately narrow — a rewrite that mangles a real sentence is worse than the
 * word it replaces:
 *   - only "the owner" / "the business owner" (+ "'s"). "a property owner",
 *     "homeowners", "the owners" are other people and are left alone;
 *   - never "the owner of …" — "are you the owner of the vehicle?" is about the
 *     CALLER's car, not this business;
 *   - never after "are you / I'm / is / who's …" — "Dale is the owner" must not
 *     become "Dale is Dale", and "are you the business owner?" is a question
 *     about the caller.
 */
const OWNER_PHRASE =
  /(?<!\b(?:are you|you are|you['’]re|i['’]m|i am|is|was|who['’]s|he['’]s|she['’]s|not)\s+)\b(the)\s+(?:business\s+)?owner(['’]s)?\b(?!\s+of\b)/gi;

/**
 * The name to say for "the owner", or null to leave the phrase alone.
 *
 * ONE active staff member is the only case with an unambiguous person to name.
 * Several staff means we do not know which one the caller wants (guessing
 * "Carlos" at a six-chair salon is worse than the role word), and no roster means
 * there is no name to say — both leave the words as the model produced them.
 */
export function spokenOwnerName(
  staffFirstNames: readonly string[] | null | undefined
): string | null {
  const staff = (staffFirstNames ?? [])
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter((n) => n.length > 0);
  return staff.length === 1 ? staff[0] : null;
}

/**
 * Replace "the owner" with `ownerName` in `text`. `before` is text ALREADY spoken
 * (the tail of the utterance so far) — read only so the "Dale is the owner"
 * exclusion still sees a verb that arrived in an earlier stream chunk; it is
 * never rewritten and is not part of the return value.
 */
export function nameTheOwner(
  text: string,
  ownerName: string | null | undefined,
  before = ''
): string {
  const name = ownerName?.trim();
  if (!name) return text;
  const whole = before + text;
  return whole
    .replace(
      OWNER_PHRASE,
      (match: string, the: string, possessive: string | undefined, offset: number) => {
        if (offset < before.length) return match;
        const spoken = the[0] === 'T' ? name[0].toUpperCase() + name.slice(1) : name;
        return spoken + (possessive ?? '');
      }
    )
    .slice(before.length);
}

// Every complete form the rewrite has to see WHOLE before deciding, including the
// word after "owner" ("'s" joins it, "of" vetoes it). A stream tail that is a
// prefix of one of these is held back until the next chunk settles it.
const OWNER_FORMS = [
  "the owner's ",
  'the owner’s ',
  'the owner of ',
  "the business owner's ",
  'the business owner’s ',
  'the business owner of ',
];
const LONGEST_OWNER_FORM = Math.max(...OWNER_FORMS.map((f) => f.length));

/** Index where an unfinished "the owner…" begins at the END of `s`, else s.length. */
function heldTailStart(s: string): number {
  for (let i = Math.max(0, s.length - LONGEST_OWNER_FORM); i < s.length; i++) {
    // Only at a word start — the "th" at the end of "with" is not "the".
    if (i > 0 && /[\p{L}\p{N}'’]/u.test(s[i - 1])) continue;
    const tail = s.slice(i).toLowerCase();
    if (OWNER_FORMS.some((form) => form.startsWith(tail))) return i;
  }
  return s.length;
}

/**
 * Stream form of nameTheOwner, for BOTH the voice (ttsNode, via sanitizeStream)
 * and the transcript (transcriptionNode). The two are separate branches of the
 * same text inside LiveKit, and the transcript branch never sees ttsNode's output
 * — so rewriting only the voice would leave the call record saying "the owner"
 * while the caller heard "Dale", and the call record is what gets reviewed.
 *
 * Plain-string chunks: the model streams "the" and " owner" as SEPARATE tokens,
 * so hold back only a tail that could still become "the owner" — a word or two,
 * one token of delay. Everything else passes through as fast as before (dead air
 * is the worse bug — see sanitizeChunk).
 *
 * Timed chunks (`{ text, startTime, … }`, LiveKit's TimedString) carry audio
 * timing, so they are never split or merged: any held text is flushed first and
 * the chunk's own text is rewritten in place.
 */
export function nameTheOwnerStream<T extends string | { text: string }>(
  input: ReadableStream<T>,
  ownerName: string | null | undefined
): ReadableStream<T> {
  const name = ownerName?.trim() || null;
  if (!name) return input;
  let carry = '';
  let spokenTail = '';
  const rewrite = (segment: string): string => {
    const out = nameTheOwner(segment, name, spokenTail);
    spokenTail = (spokenTail + out).slice(-32);
    return out;
  };
  // Never emit an empty chunk — an empty push is meaningless to TTS and in some
  // engines terminates the utterance early.
  const enqueueText = (controller: TransformStreamDefaultController<T>, segment: string) => {
    const out = rewrite(segment);
    if (out.length > 0) controller.enqueue(out as T);
  };
  return input.pipeThrough(
    new TransformStream<T, T>({
      transform(chunk, controller) {
        // A union-typed local, because TypeScript does not narrow a GENERIC `T`
        // on typeof — and a cast here is exactly what eslint's autofix strips.
        const current: string | { text: string } = chunk;
        if (typeof current !== 'string') {
          enqueueText(controller, carry);
          carry = '';
          current.text = rewrite(current.text);
          controller.enqueue(chunk);
          return;
        }
        const pending = carry + current;
        const cut = heldTailStart(pending);
        carry = pending.slice(cut);
        enqueueText(controller, pending.slice(0, cut));
      },
      flush(controller) {
        enqueueText(controller, carry);
        carry = '';
      },
    })
  );
}

export function sanitizeStream(
  input: ReadableStream<string>,
  opts: { ownerName?: string | null } = {}
): ReadableStream<string> {
  const clean = input.pipeThrough(
    new TransformStream<string, string>({
      transform(chunk, controller) {
        const out = sanitizeChunk(chunk);
        // A chunk that was ONLY a marker ("*") correctly disappears — and is never
        // pushed as an empty chunk (see nameTheOwnerStream).
        if (out.length > 0) controller.enqueue(out);
      },
    })
  );
  return nameTheOwnerStream(clean, opts.ownerName);
}
