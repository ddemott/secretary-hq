import { describe, test, expect } from 'vitest';
import {
  buildGreeting,
  speakableName,
  buildOpener,
  buildDisclosure,
  resolveDisclosure,
  CLOSER_NO_TRANSFER,
  CLOSER_WITH_TRANSFER,
} from './greeting.js';
import type { TenantDisplayConfig } from './tenantConfig.js';

/** Minimal tenant; each test overrides only the field it exercises. */
function tenant(over: Partial<TenantDisplayConfig> = {}): TenantDisplayConfig {
  return {
    name: "Bella's Hair Studio",
    personaName: null,
    firstMessage: null,
    forwardPhone: null,
    callDisclosure: null,
    ...over,
  } as TenantDisplayConfig;
}

describe('buildGreeting — the disclosure is unconditional', () => {
  // WHO: every consumer who calls any tenant | WHAT: the AI-identity + transcription disclosure is
  // spoken on every call regardless of tenant config | WHEN: all four config permutations
  // | WHERE: buildGreeting composition | WHY: this is the whole point of the module — the platform
  // promises callers are told. A config permutation that drops it is a legal exposure, not a UX bug.
  test.each([
    ['bare default', {}],
    ['persona name set', { personaName: 'Beth' }],
    ['transfer configured', { forwardPhone: '+16308229086' }],
    ['custom first message', { firstMessage: 'Yo!' }],
    ['everything set at once', { personaName: 'Beth', forwardPhone: '+1630', firstMessage: 'Yo!' }],
  ])('discloses AI + transcription: %s', (_label, over) => {
    const g = buildGreeting(tenant(over));
    expect(g).toContain('AI assistant');
    expect(g).toContain('transcribed for quality and service');
  });

  // WHO: a tenant owner who writes their own "First Message" | WHAT: their custom text cannot delete
  // the disclosure | WHEN: firstMessage is set to anything, including text that mimics a greeting
  // | WHERE: buildOpener → buildGreeting | WHY: THE regression this module exists to prevent. Before
  // 2026-07-10 firstMessage was spoken verbatim as the entire greeting, so any owner who typed a
  // greeting silently removed the disclosure. A compliance line a customer can delete is not one.
  test('a custom First Message cannot suppress the disclosure', () => {
    const g = buildGreeting(tenant({ firstMessage: 'Thanks for calling, how can I help?' }));
    expect(g).toContain("I'm an AI assistant for Bella's Hair Studio");
    expect(g.startsWith('Thanks for calling, how can I help?')).toBe(true);
  });

  // WHO: a caller reaching a tenant whose owner never named their business in a custom greeting
  // | WHAT: the business name is still spoken | WHEN: firstMessage omits the name entirely
  // | WHERE: buildDisclosure, which owns the name | WHY: the name lives in the disclosure precisely
  // so a tenant-controlled opener cannot leave the caller unsure which business answered.
  test('business name survives a custom First Message that omits it', () => {
    const g = buildGreeting(tenant({ firstMessage: 'Hey!' }));
    expect(g).toContain("Bella's Hair Studio");
  });

  // WHO: a caller | WHAT: the disclosure appears exactly once | WHEN: any config | WHERE: composition
  // | WHY: a doubled disclosure ("I'm an AI assistant... I'm an AI assistant...") reads as a bug and
  // burns the caller's patience in the most latency-sensitive seconds of the call.
  test('the disclosure is not duplicated', () => {
    const g = buildGreeting(tenant({ personaName: 'Beth' }));
    expect(g.match(/AI assistant/g)).toHaveLength(1);
  });
});

describe('buildGreeting — closer depends on real transfer capability', () => {
  // WHO: a caller who wants a human | WHAT: the "say representative" opt-out is offered only when a
  // transfer number exists | WHEN: forwardPhone is non-null and non-blank | WHERE: closer selection
  // | WHY: legaldocs line 31 — an opt-out strengthens consent "but only promise it if it exists."
  // Offering a transfer the tenant never configured strands the caller and is worse than silence.
  test('offers a human only when forwardPhone is set', () => {
    expect(buildGreeting(tenant({ forwardPhone: '+163****9086' }))).toContain(CLOSER_WITH_TRANSFER);
    expect(buildGreeting(tenant())).toContain(CLOSER_NO_TRANSFER);
    expect(buildGreeting(tenant())).not.toContain('representative');
  });

  // WHO: production tenant where backend sets transfer_available=false (loop protection:
  // forward_phone equals the line that forwards IN) | WHAT: no representative offer even
  // though forwardPhone column is non-null | WHEN: transferAvailable is explicitly false
  // | WHERE: transferReady gate | WHY: promising a transfer that rings straight back into
  // the assistant is the loop canTransfer exists to prevent; greeting and toolset must agree.
  test('transferAvailable=false suppresses the human opt-out even with forwardPhone set', () => {
    expect(
      buildGreeting(tenant({ forwardPhone: '+163****9086', transferAvailable: false }))
    ).not.toContain('representative');
    expect(
      buildGreeting(tenant({ forwardPhone: '+163****9086', transferAvailable: true }))
    ).toContain(CLOSER_WITH_TRANSFER);
  });

  // WHO: a tenant whose forward_phone column holds whitespace rather than NULL | WHAT: treated as
  // unset | WHEN: the column is '' or '   ' | WHERE: forwardPhone?.trim() guard | WHY: a blank string
  // is not a dialable number; promising a transfer against it strands the caller on a dead REFER.
  test('blank forwardPhone is treated as no transfer', () => {
    expect(buildGreeting(tenant({ forwardPhone: '   ' }))).not.toContain('representative');
    expect(buildGreeting(tenant({ forwardPhone: '' }))).not.toContain('representative');
  });
});

describe('buildOpener — tenant-controlled, name-free defaults', () => {
  // WHO: a tenant that has set neither field | WHAT: a plain opener that does NOT repeat the business
  // name | WHEN: firstMessage and personaName both null | WHERE: buildOpener fallback | WHY: the very
  // next clause names the business; saying it twice inside six seconds sounds broken to a caller.
  test('bare default omits the business name (the disclosure says it)', () => {
    expect(buildOpener(tenant())).toBe('Thanks for calling.');
    expect(buildOpener(tenant())).not.toContain("Bella's");
  });

  // WHO: a tenant that renamed its assistant | WHAT: the persona name is read at call time
  // | WHEN: personaName set, firstMessage unset | WHERE: buildOpener | WHY: computing it per-call
  // rather than baking it into a saved greeting means a rename never leaves a stale name on the line.
  test('persona name is used and not stale-baked', () => {
    expect(buildOpener(tenant({ personaName: 'Beth' }))).toBe('Hi, this is Beth.');
  });

  // WHO: a tenant whose persona_name / first_message columns hold whitespace | WHAT: fall through to
  // the next priority | WHEN: '   ' | WHERE: the ?.trim() guards | WHY: a whitespace persona would
  // otherwise render "Hi, this is ." — a louder failure to a caller than the plain fallback.
  test('whitespace-only fields fall through', () => {
    expect(buildOpener(tenant({ personaName: '   ' }))).toBe('Thanks for calling.');
    expect(buildOpener(tenant({ firstMessage: '  ', personaName: 'Beth' }))).toBe(
      'Hi, this is Beth.'
    );
  });
});

describe('the greeting introduces NAME + ROLE + COMPANY (2026-07-17, Dale)', () => {
  // WHO: the 2026-07-17 16:02 UTC live caller. WHAT: Thinking Hammer's persona
  // ("Chris") was configured and NEVER SPOKEN — the tenant has a custom First
  // Message, so the persona-aware default opener never runs, and the disclosure
  // said only "I'm an AI assistant". The caller met a nameless robot. WHY: the
  // greeting must introduce the assistant's name and role for the company —
  // while keeping the AI identity disclosed verbatim (a bare "Hi, this is
  // Chris" implying a human is the CIPA exposure the wording rules forbid).

  test('THE LIVE-CALL CONFIG: custom First Message naming the business + persona → name, role, company all spoken', () => {
    const g = buildGreeting(
      tenant({
        name: 'Thinking Hammer LLC',
        personaName: 'Chris',
        firstMessage: 'Hi, thank you for calling {{business_name}}!',
      })
    );
    expect(g).toContain("I'm Chris, an AI assistant");
    expect(g).toContain('Thinking Hammer'); // company (via the opener)
    expect(g).toContain('transcribed for quality and service');
    // The business is named by the opener, so the SHORT disclosure is chosen —
    // no "for Thinking Hammer" repeat.
    expect(g.split('Thinking Hammer').length - 1).toBe(1);
  });

  test('default opener + persona → persona spoken ONCE (opener introduces, disclosure keeps only the role)', () => {
    const g = buildGreeting(tenant({ personaName: 'Beth' }));
    expect(g).toContain('Hi, this is Beth.');
    expect(g.match(/Beth/g)).toHaveLength(1);
    expect(g).toContain("I'm an AI assistant for Bella's Hair Studio");
  });

  test('First Message with {{persona_name}} → persona spoken once, not re-introduced by the disclosure', () => {
    const g = buildGreeting(
      tenant({ personaName: 'Chris', firstMessage: 'Hi, this is {{persona_name}}!' })
    );
    expect(g.match(/Chris/gi)).toHaveLength(1);
    expect(g).toContain('AI assistant');
  });

  test('no persona configured → wording unchanged (nothing to introduce)', () => {
    const g = buildGreeting(tenant({ firstMessage: 'Hey!' }));
    expect(g).toContain("I'm an AI assistant for Bella's Hair Studio");
    expect(g).not.toContain("I'm ,");
  });

  test('persona dedupe is case-insensitive', () => {
    const g = buildGreeting(tenant({ personaName: 'Chris', firstMessage: 'CHRIS here!' }));
    expect(g.match(/chris/gi)).toHaveLength(1);
  });
});

describe('composition hygiene', () => {
  // WHO: a caller | WHAT: no double spaces from a tenant's trailing punctuation | WHEN: firstMessage
  // ends in spaces | WHERE: the whitespace collapse in buildGreeting | WHY: TTS renders a double space
  // as an audible stutter/pause; it is cheap to normalize and jarring not to.
  test('collapses whitespace introduced by tenant text', () => {
    const g = buildGreeting(tenant({ firstMessage: 'Hi!   ' }));
    expect(g).not.toMatch(/\s{2,}/);
    expect(g.startsWith('Hi! ')).toBe(true);
  });

  // WHO: legal review | WHAT: the exact approved DEFAULT wording is pinned | WHEN: anyone edits the
  // default string | WHERE: buildDisclosure | WHY: the default is what every un-customized tenant
  // speaks. "recorded" (we retain no audio) and "training" (concedes the Javier/Ambriz capability
  // test) must never appear in the DEFAULT. A tenant's custom text is their own attested
  // responsibility and is deliberately NOT pinned here. A failing test is the signal to go back to
  // counsel, not to update the expectation.
  test('the DEFAULT wording is pinned: never "recorded", never "training"', () => {
    const d = buildDisclosure('Acme');
    expect(d).toBe(
      "I'm an AI assistant for Acme, and this call is transcribed for quality and service."
    );
    expect(d).not.toMatch(/record/i);
    expect(d).not.toMatch(/train/i);
    expect(buildGreeting(tenant())).not.toMatch(/record|train/i);
  });
});

describe('resolveDisclosure — tenant override with safe fallback', () => {
  // WHO: a non-English tenant, or one with a brand voice / counsel-approved script | WHAT: their
  // custom disclosure is spoken verbatim | WHEN: callDisclosure is set and non-blank | WHERE:
  // resolveDisclosure → buildGreeting | WHY: the whole point of the editable field — the tenant owns
  // the wording (and the legal duty per the signup attestation); the platform only supplies a default.
  test('a custom disclosure replaces the default', () => {
    const spanish = 'Soy un asistente de IA, y esta llamada se transcribe para calidad y servicio.';
    expect(resolveDisclosure(tenant({ callDisclosure: spanish }))).toBe(spanish);
    expect(buildGreeting(tenant({ callDisclosure: spanish }))).toContain(spanish);
  });

  // WHO: an owner who clears the disclosure field | WHAT: falls back to the compliant default rather
  // than speaking nothing | WHEN: callDisclosure is null, '', or whitespace | WHERE: the ?.trim() ||
  // guard | WHY: the disclosure must NEVER be simply absent. Clearing the box returns to the default,
  // it does not silence the notice.
  test('null / blank / whitespace disclosure falls back to the default', () => {
    const def = buildDisclosure("Bella's Hair Studio");
    expect(resolveDisclosure(tenant({ callDisclosure: null }))).toBe(def);
    expect(resolveDisclosure(tenant({ callDisclosure: '' }))).toBe(def);
    expect(resolveDisclosure(tenant({ callDisclosure: '   ' }))).toBe(def);
  });

  // WHO: any caller reaching a customized tenant | WHAT: the custom disclosure still sits BETWEEN the
  // tenant opener and the closer | WHEN: callDisclosure set | WHERE: buildGreeting composition | WHY:
  // customization changes the words, not the structure — the disclosure stays in its place, once.
  test('a custom disclosure keeps its position and is not duplicated', () => {
    const g = buildGreeting(
      tenant({ callDisclosure: 'Heads up: AI here, call is transcribed.', personaName: 'Beth' })
    );
    expect(g).toBe(
      'Hi, this is Beth. Heads up: AI here, call is transcribed. How can I help you today?'
    );
    expect(g.match(/transcribed/g)).toHaveLength(1);
  });
});

/**
 * REGRESSION — the 2026-07-13 call. The owner's verdict was "sounded very broken",
 * and he was right: the first thing every caller heard was the assistant saying
 * the words "curly brace business name", followed by the same question twice.
 */
describe('REGRESSION: the greeting must not speak template syntax, or repeat itself', () => {
  test('SAD: an unsubstituted {{business_name}} is NEVER spoken', () => {
    // WHO: every caller to Thinking Hammer.
    // WHAT: the saved First Message was
    //       "Hi, thank you for calling {{business_name}}! How can I help you today?"
    //       and buildOpener returned it VERBATIM.
    // WHY: the placeholders come from the seeded business templates, where the
    //      syntax is real — the comms templates (email/SMS) render through
    //      Handlebars. The spoken greeting does not, and nobody noticed the two
    //      had different contracts. prompt.ts had substitutePlaceholders the
    //      whole time; greeting.ts never got it.
    const greeting = buildGreeting(
      tenant({
        name: 'Thinking Hammer LLC',
        firstMessage: 'Hi, thank you for calling {{business_name}}! How can I help you today?',
      })
    );

    expect(greeting).not.toContain('{{');
    expect(greeting).not.toContain('}}');
    // The SPOKEN name — the legal suffix is stripped for speech (see speakableName).
    // Nobody answers a phone with "Thank you for calling Thinking Hammer L-L-C".
    expect(greeting).toContain('Thinking Hammer');
    expect(greeting).not.toMatch(/\bLLC\b/);
  });

  test('SAD: the same question is not asked twice', () => {
    // WHY: the owner's First Message already ends with "How can I help you today?"
    //      and the closer appends it AGAIN — so the assistant asked, disclosed,
    //      and asked again. The module header claims the opener "no longer carries"
    //      that question, but that was only ever true of the DEFAULT opener; a
    //      custom First Message was free to end with it and nothing checked.
    const greeting = buildGreeting(
      tenant({
        name: 'Thinking Hammer LLC',
        firstMessage: 'Hi, thank you for calling {{business_name}}! How can I help you today?',
      })
    );

    const asks = greeting.toLowerCase().split('how can i help you').length - 1;
    expect(asks).toBe(1);
  });

  test('HAPPY: the disclosure still lands BETWEEN the opener and the question', () => {
    // WHY: the disclosure is the legal clause. Dropping the duplicate question
    //      must not reorder the greeting so that the disclosure becomes the last
    //      thing before the caller starts talking — so we strip the question from
    //      the OPENER and keep the closer, not the reverse.
    const greeting = buildGreeting(
      tenant({
        name: 'Thinking Hammer LLC',
        firstMessage: 'Hi, thank you for calling {{business_name}}! How can I help you today?',
      })
    );

    const disclosureAt = greeting.toLowerCase().indexOf('ai assistant');
    const questionAt = greeting.toLowerCase().indexOf('how can i help you');
    expect(disclosureAt).toBeGreaterThan(-1);
    expect(questionAt).toBeGreaterThan(disclosureAt);
  });

  test('SAD: an UNKNOWN placeholder is stripped, never spoken', () => {
    // WHY: a missing name is survivable; reading punctuation aloud is not. Fail
    //      silently — the caller hears a slightly plainer sentence, not a bug.
    const greeting = buildGreeting(
      tenant({
        name: 'Thinking Hammer LLC',
        firstMessage: 'Welcome to {{nonexistent_thing}}, friend.',
      })
    );

    expect(greeting).not.toContain('{{');
    expect(greeting).not.toContain('nonexistent_thing');
  });
});

describe('REGRESSION: the business name is spoken ONCE, not twice', () => {
  test('SAD: an opener that names the business does not get it repeated in the disclosure', () => {
    // WHO: every caller. WHAT: the 2026-07-13 evening greeting was
    //      "Hi, thank you for calling Thinking Hammer LLC! I'm an AI assistant for
    //       Thinking Hammer LLC, and this call is transcribed..."
    // WHY: this module's own header predicted it — "saying it twice in six seconds
    //      sounds like a bug to a caller" — and then waved it through as the owner's
    //      choice that "only costs a repeat". It doesn't cost a repeat; it costs the
    //      first impression. The DISCLOSURE keeps the name when the opener doesn't,
    //      because that is the sentence that legally needs it.
    const greeting = buildGreeting(
      tenant({
        name: 'Thinking Hammer LLC',
        firstMessage: 'Hi, thank you for calling {{business_name}}! How can I help you today?',
      })
    );

    const mentions = greeting.split('Thinking Hammer').length - 1;
    expect(mentions).toBe(1);
    expect(greeting).not.toMatch(/\bLLC\b/);
    // The AI disclosure must survive — it is the legal clause.
    expect(greeting).toMatch(/AI assistant/i);
  });

  test('HAPPY: when the opener does NOT name the business, the disclosure still does', () => {
    // WHY: the disclosure is the legal identification. Deduping must never mean
    //      dropping the business name entirely.
    const greeting = buildGreeting(
      tenant({ name: 'Thinking Hammer LLC', firstMessage: 'Hi, this is Clara.' })
    );

    // The disclosure names the business — using the SPOKEN name. It is the legal
    // identification clause, so it must still say WHO the AI represents; it just does
    // not read the registration suffix aloud.
    expect(greeting).toContain('Thinking Hammer');
    expect(greeting).toMatch(/AI assistant for Thinking Hammer/i);
    expect(greeting).not.toMatch(/\bLLC\b/);
  });
});

/**
 * REGRESSION — nobody says the legal suffix out loud.
 *
 * The 2026-07-14 call opened with "Thank you for calling Thinking Hammer LLC" and the
 * owner asked what the word was. That is the clearest possible evidence it should not
 * be there: he could not even parse it, and it is his own company.
 *
 * A receptionist says "Thank you for calling Thinking Hammer". The suffix is a
 * registration detail, not part of the name the business is KNOWN by — and TTS engines
 * either spell it out letter by letter or slur it into a non-word.
 *
 * SPOKEN ONLY. tenants.name keeps the legal name and everything WRITTEN still shows it
 * in full.
 */
describe('REGRESSION: the legal suffix is never spoken', () => {
  test('SAD: "LLC" is stripped from the spoken name', () => {
    expect(speakableName('Thinking Hammer LLC')).toBe('Thinking Hammer');
  });

  test('the common suffixes all go', () => {
    expect(speakableName('Acme Inc.')).toBe('Acme');
    expect(speakableName('Acme Incorporated')).toBe('Acme');
    expect(speakableName('Acme Ltd')).toBe('Acme');
    expect(speakableName('Acme Corp.')).toBe('Acme');
    expect(speakableName('Acme, LLC')).toBe('Acme');
    expect(speakableName('Acme L.L.C.')).toBe('Acme');
    // "L.L.C" WITHOUT a trailing dot — a common spelling the first (regex) version
    // missed entirely. Dots are spelling, not meaning: LLC / L.L.C / L.L.C. are the
    // same word, so the token is normalised before it is compared.
    expect(speakableName('Acme L.L.C')).toBe('Acme');
    expect(speakableName('Acme I.N.C.')).toBe('Acme');
    expect(speakableName('Acme PLLC')).toBe('Acme');
    expect(speakableName('Acme Company')).toBe('Acme');
  });

  test('HAPPY: a suffix-like word INSIDE the name is kept — it is part of the name', () => {
    // WHY: the failure mode that would be worse than the bug. Stripping a word that is
    //      genuinely part of a business's identity is a bigger insult than saying "LLC"
    //      once. Only a suffix at the END, with a word boundary before it, goes.
    expect(speakableName('Hammer & Co Ironworks')).toBe('Hammer & Co Ironworks');
    expect(speakableName('Incorporated Designs')).toBe('Incorporated Designs');
    expect(speakableName('Limited Edition Cuts')).toBe('Limited Edition Cuts');
  });

  test('SAD: a business literally named "LLC" does not vanish from its own greeting', () => {
    // WHY: never return empty. Something odd beats nothing.
    expect(speakableName('LLC')).toBe('LLC');
  });

  test('the greeting says the short name, and says it ONCE', () => {
    const greeting = buildGreeting(
      tenant({
        name: 'Thinking Hammer LLC',
        firstMessage: 'Hi, thank you for calling {{business_name}}! How can I help you today?',
      })
    );

    expect(greeting).not.toMatch(/\bLLC\b/);
    expect(greeting).toContain('Thinking Hammer');
    expect(greeting.split('Thinking Hammer').length - 1).toBe(1);
  });
});

describe('the services menu (greeting_menu, 2026-07-21)', () => {
  // WHO: every caller to a tenant that set a menu | WHAT: the owner's "what I
  // can help with" line is spoken between the disclosure and the closing
  // question | WHEN: greetingMenu is set | WHERE: buildGreeting composition
  // | WHY: Dale — "people do not know the services, especially that I am
  // selling the AI secretary as a service." A caller can't ask for a lane they
  // don't know exists.
  const MENU =
    'I can help with a job opportunity, a drop-off computer repair, or setting your ' +
    'business up with an AI secretary like me — and I can always take a message.';

  test('spoken AFTER the disclosure and BEFORE the closing question', () => {
    const g = buildGreeting(tenant({ greetingMenu: MENU }));
    const disclosureAt = g.indexOf('transcribed for quality and service');
    const menuAt = g.indexOf('job opportunity');
    const closerAt = g.indexOf(CLOSER_NO_TRANSFER);
    expect(disclosureAt).toBeGreaterThanOrEqual(0);
    expect(menuAt).toBeGreaterThan(disclosureAt); // legal first, then the menu
    expect(closerAt).toBeGreaterThan(menuAt); // menu flows into the question
  });

  test('NULL / blank menu leaves the greeting exactly as it always was', () => {
    const withoutField = buildGreeting(tenant());
    const withNull = buildGreeting(tenant({ greetingMenu: null }));
    const withBlank = buildGreeting(tenant({ greetingMenu: '   ' }));
    expect(withNull).toBe(withoutField);
    expect(withBlank).toBe(withoutField);
  });
});

describe('the configurable closing question (greeting_closer, 2026-07-23)', () => {
  // WHO: every caller | WHAT: the tenant can replace the generic "How can I help
  // you today?" with a guiding question that names the services | WHY: Dale — a
  // lost caller freezes on a generic "how can I help" and hangs up; concrete
  // choices ("hiring Dale, a computer fix, or a message") rescue them.
  const CLOSER =
    'What do you need help with: hiring Dale, a computer fix, or maybe just leaving a message?';

  test('a custom closer replaces the default AND ends the greeting', () => {
    const g = buildGreeting(tenant({ greetingCloser: CLOSER }));
    expect(g).toContain(CLOSER);
    expect(g).not.toContain(CLOSER_NO_TRANSFER); // the generic default is gone
    expect(g.trimEnd().endsWith(CLOSER)).toBe(true); // it's the last thing said
  });

  test('NULL / blank closer keeps the default "How can I help you today?"', () => {
    expect(buildGreeting(tenant({ greetingCloser: null }))).toContain(CLOSER_NO_TRANSFER);
    expect(buildGreeting(tenant({ greetingCloser: '   ' }))).toContain(CLOSER_NO_TRANSFER);
  });

  test('the disclosure is STILL present with a custom closer (legal not dropped)', () => {
    const g = buildGreeting(tenant({ greetingCloser: CLOSER }));
    expect(g).toContain('AI assistant');
    expect(g).toContain('transcribed for quality and service');
  });

  test('with a transfer number, the representative opt-out is prepended to the custom closer', () => {
    const g = buildGreeting(tenant({ greetingCloser: CLOSER, forwardPhone: '+16308229086' }));
    expect(g).toMatch(/say "representative/i);
    expect(g).toContain('Otherwise, what do you need help with'); // custom closer, lowercased after "Otherwise,"
  });
});
