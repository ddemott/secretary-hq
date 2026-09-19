/**
 * Caller greeting composition.
 *
 * Every inbound call opens with three segments, in order:
 *
 *   1. OPENER    — tenant-controlled. Their "First Message", or a persona/name default.
 *   2. DISCLOSURE — fixed platform text. Not tenant-editable, never omitted.
 *   3. CLOSER    — fixed. Offers a human when the tenant has a transfer number.
 *
 * The disclosure is deliberately NOT part of the opener fallback chain. An
 * earlier design put the whole greeting behind `firstMessage` and spoke it
 * verbatim, which meant any owner who typed their own greeting silently
 * deleted the disclosure. A compliance line a customer can remove from a text
 * box is not a compliance line, so it is composed around their text instead.
 *
 * Wording rules — do not "improve" these without legal review. See
 * docs/legaldocs/AI_Secretary_Consent_and_Privacy_Language.md:
 *
 *   - "transcribed", never "recorded". The product stores a text transcript
 *     (transcript.ts → voice_sessions.transcript) and retains no audio. A
 *     disclosure that misdescribes the processing is worse than none.
 *   - "quality and service", never "training". Wiretap exposure for AI vendors
 *     turns on whether the vendor may use call contents for its own benefit
 *     (the Javier/Ambriz "capability" test); saying "training" concedes it.
 *   - The AI identity is disclosed even when a persona name is set. "Hi, this
 *     is Beth" implies a human, which is what keeps a CIPA §632 "confidential
 *     communication" claim alive.
 *   - The human opt-out is offered ONLY when forwardPhone is configured.
 *     Promising a transfer that cannot happen is worse than offering none.
 */

import type { TenantDisplayConfig } from './tenantConfig.js';

/**
 * The DEFAULT disclosure. Carries three things in one sentence: who the caller
 * reached, that it is an AI, and that call contents are captured, with a stated
 * purpose.
 *
 * This is the fallback used when a tenant has NOT set a custom `callDisclosure`.
 * A tenant may reword the disclosure (brand voice, another language, a
 * counsel-approved script) via the attestation-gated dashboard field; see
 * resolveDisclosure(). When they have not, or have cleared it, this compliant
 * default is spoken instead — the disclosure is never simply absent.
 *
 * The business name lives HERE rather than in the opener because the opener is
 * tenant-controlled — an owner who writes a custom "First Message" could
 * otherwise leave their own company name unsaid. Anchoring it to the default
 * disclosure guarantees every caller on the default is told which business
 * answered.
 */
/**
 * The business name as a PERSON would say it — without the legal suffix.
 *
 * "Thank you for calling Thinking Hammer LLC" is not how anyone answers a phone. A
 * receptionist says "Thank you for calling Thinking Hammer". The suffix is a
 * registration detail, not part of the name the business is known by, and read aloud a
 * TTS engine either spells it out letter by letter or slurs it into a non-word. The
 * owner heard it on the 2026-07-14 call and asked WHAT THE WORD WAS — about his own
 * company. That is as clear as evidence gets.
 *
 * SPOKEN ONLY. tenants.name keeps the legal name, and everything WRITTEN — dashboard,
 * contracts, invoices — still shows it in full.
 *
 * IMPLEMENTATION: take the LAST token, strip its dots, and compare against a known set.
 * A regex over suffix spellings was the first attempt and it was both too strict and too
 * loose (review on #259): it missed "L.L.C" without the trailing dot, and its alternates
 * duplicated an optional dot it already allowed. Comparing a NORMALISED token to a SET
 * says what it means, and gains every dotted spelling for free.
 *
 * Only the LAST token is ever considered — which is what protects a suffix-like word
 * that is genuinely part of the name:
 *
 *     "Hammer & Co Ironworks"  → last token "Ironworks"    → kept whole
 *     "Incorporated Designs"   → last token "Designs"      → kept whole
 *     "Thinking Hammer LLC"    → last token "LLC"          → "Thinking Hammer"
 *
 * Stripping a word that is genuinely part of a business's identity is a worse error than
 * saying "LLC" once, so the rule refuses to guess.
 */
const LEGAL_SUFFIXES = new Set([
  'llc',
  'inc',
  'incorporated',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'plc',
  'llp',
  'lp',
  'pllc',
  'pc',
]);

export function speakableName(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? '';
  if (!trimmed) return trimmed;

  // Head + final token, separated by whitespace and/or a comma ("Acme, LLC").
  const m = /^(.*?)[\s,]+([A-Za-z.]+)$/.exec(trimmed);
  if (!m) return trimmed;

  const [, head, lastToken] = m;
  // Dots are spelling, not meaning: LLC / L.L.C / L.L.C. are the same word.
  const normalised = lastToken.replace(/\./g, '').toLowerCase();
  if (!LEGAL_SUFFIXES.has(normalised)) return trimmed;

  const spoken = head.replace(/[\s,]+$/, '').trim();
  // Never return empty: a business literally named "LLC" must not vanish from its own
  // greeting. Something odd beats nothing.
  return spoken || trimmed;
}

/**
 * PERSONA-AWARE since 2026-07-17 (Dale's rule: the greeting introduces the
 * assistant's NAME and ROLE for the COMPANY). On the 16:02 UTC live call the
 * tenant's persona ("Chris") was configured and never spoken — the caller met
 * "an AI assistant" with no name, because the persona only ever reached the
 * DEFAULT opener, and a tenant with a custom First Message never uses that.
 *
 * The persona name rides INSIDE the disclosure, in front of the role: "I'm
 * Chris, an AI assistant for Thinking Hammer…". This is the exact coexistence
 * the header's third wording rule anticipates — the AI identity is still
 * disclosed, verbatim, whenever a persona name is set; a bare "Hi, this is
 * Chris" implying a human is still impossible. Both variants are AUTHORED
 * strings (no fragment surgery on legal wording — the #254 rule), and the
 * legally load-bearing clauses are identical in both.
 */
export function buildDisclosure(businessName: string, personaName?: string | null): string {
  const persona = personaName?.trim();
  const business = speakableName(businessName);
  return persona
    ? `I'm ${persona}, an AI assistant for ${business}. This call is transcribed for quality and service.`
    : `I'm an AI assistant for ${business}. This call is transcribed for quality and service.`;
}

/**
 * The same disclosure, for when the OPENER has already named the business.
 *
 * A SECOND AUTHORED STRING, not a regex edit of the first. Raised in review on #254,
 * and the reviewer was right: the first version stripped "for <business>" out of the
 * disclosure with a regex. That clause is the platform's AI IDENTIFICATION — the
 * legal bit — and this file's own header says its wording must not change without
 * review. Worse, it would have mutated a TENANT'S CUSTOM callDisclosure, silently
 * rewriting compliance text somebody else wrote and is relying on.
 *
 * You do not edit legal wording with a regular expression. You write the second
 * version, deliberately, and choose between them. Both name the speaker as an AI and
 * both disclose the transcription; this one simply doesn't repeat a business name the
 * caller heard one second ago.
 *
 * A tenant's CUSTOM disclosure is never touched by either path — it is spoken
 * verbatim, which is the contract resolveDisclosure has always had.
 */
export function buildDisclosureShort(personaName?: string | null): string {
  const persona = personaName?.trim();
  return persona
    ? `I'm ${persona}, an AI assistant. This call is transcribed for quality and service.`
    : `I'm an AI assistant. This call is transcribed for quality and service.`;
}

/**
 * Resolve the disclosure actually spoken: the tenant's custom text when set and
 * non-blank, otherwise the platform default. A whitespace-only column counts as
 * unset — clearing the field returns the tenant to the safe default rather than
 * speaking an empty line.
 */
export function resolveDisclosure(config: TenantDisplayConfig): string {
  const custom = config.callDisclosure?.trim();
  return custom || buildDisclosure(config.name, config.personaName);
}

/**
 * Closer when the tenant has no transfer number.
 *
 * DELIBERATELY omits the "just stay on the line" consent trigger that
 * docs/legaldocs/AI_Secretary_Consent_and_Privacy_Language.md:31 recommends.
 * That clause costs ~3 seconds at the most latency-sensitive moment of the call
 * (see docs/VOICE_DEADAIR_RESEARCH.md and fallback.ts, which exist because
 * callers talk over a slow opener), and the greeting had already grown from 9
 * words to 34. Owner chose the shorter line 2026-07-10 accepting that implied
 * consent now rests on continued participation without being named aloud —
 * a weaker posture in all-party-consent states. Raise with counsel before
 * relying on it. Restoring the clause is a one-line change here.
 */
export const CLOSER_NO_TRANSFER = 'Tell me how I can help.';

/** Closer when a human transfer is actually available. A real opt-out strengthens consent. */
export const CLOSER_WITH_TRANSFER =
  'If you\'d rather speak with a person, say "representative." Tell me how I can help.';

/** The transfer opt-out sentence, prepended to WHATEVER closing question is in
 *  effect (default or a tenant's custom `greetingCloser`) when a transfer number
 *  is configured. Kept separate so a custom closer still gets the representative
 *  option. */
const TRANSFER_PREFIX =
  'If you\'d rather speak with a person, say "representative." ';

/**
 * Build the tenant-controlled opener.
 *
 * Priority: the owner's "First Message" → a persona-aware default that names
 * the assistant → a plain fallback. The persona default is computed at call
 * time rather than baked into a saved greeting so a renamed assistant does not
 * leave a stale name in the opener.
 *
 * The defaults deliberately omit the business name — buildDisclosure() speaks
 * it on the very next clause, and saying it twice in six seconds sounds like a
 * bug to a caller. A custom First Message may of course name the business; that
 * is the owner's choice and only costs a repeat.
 *
 * The opener also no longer carries "How can I help you today?" — that moved to
 * the closer, after the disclosure, so the caller is not invited to start
 * talking before they have been told what is happening.
 */
/**
 * Fill the Handlebars-style placeholders a tenant's First Message may contain,
 * and strip any we don't recognise.
 *
 * WHY (a real call, 2026-07-13): Thinking Hammer's saved First Message was
 *
 *     "Hi, thank you for calling {{business_name}}! How can I help you today?"
 *
 * and buildOpener returned it VERBATIM. So the very first thing every caller
 * heard was the assistant saying the words "curly brace business name". The
 * owner's reaction — "sounded very broken" — was the correct one.
 *
 * The placeholders came from the seeded business templates, where that syntax is
 * real: the comms templates (email/SMS) are rendered through Handlebars. The
 * spoken greeting is not, and nobody noticed the two had different contracts.
 *
 * Two rules, both load-bearing:
 *   1. SUBSTITUTE what we know ({{business_name}}, {{persona_name}}).
 *   2. STRIP what we don't. An unknown placeholder must never reach TTS — a
 *      missing name is survivable, reading punctuation aloud is not. Failing
 *      silently is right here: the caller hears a slightly plainer sentence
 *      instead of a bug.
 */
function fillPlaceholders(text: string, config: TenantDisplayConfig): string {
  return (
    text
      .replace(/\{\{\s*business_name\s*\}\}/gi, speakableName(config.name) || 'us')
      .replace(/\{\{\s*persona_name\s*\}\}/gi, config.personaName?.trim() || 'your assistant')
      // Anything still in braces is unknown — drop it rather than speak it.
      .replace(/\{\{[^}]*\}\}/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

export function buildOpener(config: TenantDisplayConfig): string {
  const custom = config.firstMessage?.trim();
  if (custom) return fillPlaceholders(custom, config);

  const personaName = config.personaName?.trim();
  return personaName ? `Hi, this is ${personaName}.` : 'Thanks for calling.';
}

/**
 * Compose the full opening line spoken to every caller.
 *
 * Joins the three segments with single spaces, collapsing any run of whitespace
 * a tenant's trailing punctuation might introduce. Guarantees the disclosure —
 * and with it the business name — is present exactly once, regardless of tenant
 * configuration.
 */
export function buildGreeting(config: TenantDisplayConfig): string {
  const opener = buildOpener(config);
  // The closing question is OWNER-CONFIGURABLE (2026-07-23, Dale: swap the
  // generic "How can I help you today?" for a guiding one that names the
  // services — "What do you need help with: hiring Dale, a computer fix, or a
  // message?" — so a lost caller is handed concrete choices instead of a blank
  // "how can I help"). NULL/blank = the historical default. When a transfer
  // number exists, the representative opt-out is prepended to whichever closer
  // is in effect (custom closer kept as its own sentence after the representative line).
  const customCloser = config.greetingCloser?.trim();
  const closerQuestion = customCloser || CLOSER_NO_TRANSFER;
  // Human opt-out only when a transfer can actually run. Prefer the backend-
  // resolved transferAvailable flag when present (false = loop risk or no
  // target). When the flag is absent (unit tests that only set forwardPhone),
  // fall back to a non-blank forwardPhone — same "only promise it if it exists"
  // rule, without forcing every test fixture to set transferAvailable.
  const transferReady =
    typeof config.transferAvailable === 'boolean'
      ? config.transferAvailable && Boolean(config.forwardPhone?.trim())
      : Boolean(config.forwardPhone?.trim());
  const closer = transferReady
    ? customCloser
      ? TRANSFER_PREFIX + closerQuestion
      : CLOSER_WITH_TRANSFER
    : closerQuestion;
  // The owner's spoken services menu (2026-07-21, Dale: list the CORE lanes up
  // front — job, computer repair, message, buying the AI-secretary service).
  // Placed AFTER the disclosure (legal first) and BEFORE the closing question,
  // so the menu flows straight into "How can I help you today?". Blank = the
  // greeting composes exactly as it always has.
  const menu = config.greetingMenu?.trim() ?? '';

  // Don't ask the same question twice.
  //
  // The 2026-07-13 call opened with: "Hi, thank you for calling {{business_name}}!
  // How can I help you today? I'm an AI assistant for Thinking Hammer LLC, and
  // this call is transcribed for quality and service. How can I help you today?"
  //
  // The owner's saved First Message already ends with the question, and the closer
  // appends it again — so the assistant asked it, disclosed, and asked it AGAIN.
  // The module header even documents the intent ("the opener no longer carries
  // 'How can I help you today?' — that moved to the closer"), but that was only
  // ever true of the DEFAULT opener. A custom First Message was free to end with
  // the same question and nothing checked.
  //
  // The disclosure must still land BETWEEN them (it is the legal bit, and it must
  // not be the last thing before the caller starts talking), so we drop the
  // question from the OPENER and keep the closer — rather than the reverse.
  //
  // 2026-09-18 falling-tone rewrite (found by Copilot review on #527): the
  // CURRENT closer is CLOSER_NO_TRANSFER's own text ("Tell me how I can
  // help."), and the templates migration (20260722000000) independently
  // rewrote the default first_message to end with the identical phrase —
  // this regex still only matched the OLD "How can I help you today?"
  // wording, so the new phrase sailed through undeduped: "...answer
  // questions about our services. Tell me how I can help. [disclosure]
  // Tell me how I can help." Build the pattern from CLOSER_NO_TRANSFER
  // itself so opener and closer can never drift apart like this again; the
  // legacy phrase stays matched too, for any tenant's custom First Message
  // still written in the old wording.
  const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const closingQuestionPatterns = [
    /how can i help you( today)?\s*[?!.]?\s*$/i,
    new RegExp(`${escapeRegExp(CLOSER_NO_TRANSFER.replace(/[?!.]+$/, ''))}\\s*[?!.]?\\s*$`, 'i'),
  ];
  const openerWithoutClosingQuestion = closingQuestionPatterns.some((re) => re.test(opener))
    ? closingQuestionPatterns
        .reduce((text, re) => text.replace(re, ''), opener)
        .trim()
    : opener;

  // Don't say the business name twice in six seconds.
  //
  // 2026-07-13 evening call: "Hi, thank you for calling Thinking Hammer LLC! I'm an
  // AI assistant for Thinking Hammer LLC, and this call is transcribed..."
  //
  // This module's own header predicted it — "saying it twice in six seconds sounds
  // like a bug to a caller" — and then waved it through as "the owner's choice [that]
  // only costs a repeat". It doesn't cost a repeat. It costs the first impression.
  //
  // We CHOOSE between two authored disclosures; we do NOT edit one. Rewriting the
  // legal clause with a regex (the first version of this) would mutate compliance
  // wording, and would have silently rewritten a TENANT'S OWN callDisclosure.
  //
  // A custom disclosure is therefore never deduped — it is spoken verbatim, exactly
  // as resolveDisclosure has always promised. If an owner writes their business name
  // into both their First Message and their disclosure, that is their sentence to
  // write, and we do not quietly redact it.
  const customDisclosure = config.callDisclosure?.trim();
  // Compare on the SPOKEN name, not the legal one. The opener now contains
  // "Thinking Hammer" (the suffix is stripped for speech), so matching against
  // "Thinking Hammer LLC" would never hit and the dedupe would silently stop
  // working — the caller would hear the business named twice again.
  const name = speakableName(config.name);
  const openerNamesBusiness =
    Boolean(name) && openerWithoutClosingQuestion.toLowerCase().includes(name.toLowerCase());
  // Don't say the PERSONA name twice either. The default opener with a persona
  // is "Hi, this is Chris." — following it with "I'm Chris, an AI assistant…"
  // has the same twice-in-six-seconds bug as the business name above. When the
  // opener already introduced the persona, the disclosure carries only the role;
  // when it didn't (any custom First Message without {{persona_name}}), the
  // disclosure is where the caller learns the name. Same choose-between-authored-
  // strings discipline: a custom callDisclosure is still spoken verbatim.
  const personaName = config.personaName?.trim();
  const openerNamesPersona =
    Boolean(personaName) &&
    openerWithoutClosingQuestion.toLowerCase().includes(personaName!.toLowerCase());
  const personaForDisclosure = openerNamesPersona ? null : personaName;
  const disclosure = customDisclosure
    ? customDisclosure
    : openerNamesBusiness
      ? buildDisclosureShort(personaForDisclosure)
      : buildDisclosure(config.name, personaForDisclosure);

  return [openerWithoutClosingQuestion, disclosure, menu, closer]
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
