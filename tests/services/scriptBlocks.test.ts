/**
 * The point of composing scripts from blocks is that the LESSONS cannot be lost.
 *
 * Every universal rung here was paid for by a real call that went wrong: the read-back
 * that has to end the turn, the phone number that arrives in pieces, the booking that
 * must happen BEFORE the questions, the "is there anything else?" that closes a call
 * with the caller's actual request still undone.
 *
 * A second business must inherit all of that for free. So these tests are less about
 * the composer working and more about the invariants it exists to protect — the ones a
 * copy-pasted script would quietly lose.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  BLOCKS,
  CANONICAL_ORDER,
  composeScript,
  INTAKE_JOB_INQUIRY,
  OFFER_MEETING,
  type ScriptComposition,
} from '../../src/services/scripts/blocks';

const PERSONA = 'You are the receptionist for Acme.';

describe('script composition — the invariants a copy-pasted script would lose', () => {
  it('SAD: intake can NEVER come before the booking', () => {
    // WHY: the single worst failure of the week, twice over. A caller asked for a
    //      meeting, answered nine questions about the job, and hung up with NOTHING IN
    //      THE DIARY. The notes were flawless. The call was a failure.
    //
    //      A tenant chooses their INTAKE questions. They do not get to choose whether
    //      the meeting is booked first — that is not a preference, it is what those
    //      calls taught us. The composer places blocks in CANONICAL_ORDER, so this
    //      cannot be got wrong by a config, only by editing this file on purpose.
    const script = composeScript({ persona: PERSONA, intake: ['intake_job_inquiry'] });

    const bookAt = script.indexOf('RUNG 2 —');
    const intakeAt = script.indexOf('What company are you calling from?');
    expect(bookAt).toBeGreaterThan(-1);
    expect(intakeAt).toBeGreaterThan(-1);
    expect(bookAt, 'the booking rung must come before any intake question').toBeLessThan(intakeAt);
  });

  it('SAD: every script confirms the phone number and WAITS', () => {
    // WHY: "You never let me answer if it was right or not. You just went on
    //      immediately." — a real caller, mid-call, 2026-07-14. The agent read his
    //      number back and acted on it before he could say yes.
    //      A new business must not have to rediscover that.
    for (const intake of [['intake_job_inquiry'], []]) {
      const script = composeScript({ persona: PERSONA, intake });
      expect(script).toContain('STOP TALKING');
      expect(script).toMatch(/read it back/i);
      // Positive framing (gotcha G): "a number counts as ready ONLY once they have said
      // yes to it" — the do-X form of the old "never proceed on an unconfirmed number".
      expect(script).toMatch(/counts as ready ONLY once they have said yes/i);
    }
  });

  it('SAD: every script forbids closing on an unfinished ask', () => {
    // WHY: "Is there anything else I can help you with?" is how the agent ended a call
    //      with the caller's own request undone. It sounds like service. It is an exit.
    for (const intake of [['intake_job_inquiry']]) {
      const script = composeScript({ persona: PERSONA, intake });
      expect(script).toMatch(/Tell me if you need anything else/i);
      // Positive framing (gotcha G): the do-X form keeps "anything else?" for the caller's
      // own extras, rather than forbidding it as "not a way out".
      expect(script).toMatch(/for THEIR extras/i);
    }
  });

  it('HAPPY: two different intakes share every universal rung and differ ONLY in the middle', () => {
    // WHY: this IS the feature. Two businesses are the same call with different questions
    //      in the middle. If they diverge anywhere else, the abstraction has failed and we
    //      are back to maintaining N scripts by hand. (Proven with the live staffing block
    //      vs an inline custom intake — the two ways a tenant gets an intake.)
    const CUSTOM = '### RUNG 3 — ASK ABOUT THE VAN\n\nIF they mentioned a van → what make?';
    const staffing = composeScript({ persona: PERSONA, intake: ['intake_job_inquiry'] });
    const custom = composeScript({ persona: PERSONA, customIntake: CUSTOM });

    for (const universal of [
      'ladder_header',
      'identity',
      'book_meeting',
      'take_message',
      'complete_all_goals',
      'close',
    ]) {
      expect(staffing).toContain(BLOCKS[universal].text);
      expect(custom).toContain(BLOCKS[universal].text);
    }

    // ...and the only difference is the middle.
    expect(staffing).toContain(INTAKE_JOB_INQUIRY.text);
    expect(staffing).not.toContain('ASK ABOUT THE VAN');
    expect(custom).toContain('ASK ABOUT THE VAN');
    expect(custom).not.toContain(INTAKE_JOB_INQUIRY.text);
  });

  it('HAPPY: a business that fits no existing block can supply its own intake inline', () => {
    // WHY: "I may have multiple real estates with slightly different structures." The
    //      long tail must not require a code change — otherwise the next business waits
    //      on a deploy, and someone pastes a script into the database by hand instead,
    //      which is exactly what this module exists to stop.
    const script = composeScript({
      persona: PERSONA,
      customIntake: '### RUNG 3 — ASK ABOUT THE DOG\n\nIF they have a dog → what breed?',
    });
    expect(script).toContain('ASK ABOUT THE DOG');
    // Still wrapped in every universal rung, in order.
    expect(script.indexOf('RUNG 2 —')).toBeLessThan(script.indexOf('ASK ABOUT THE DOG'));
    expect(script.indexOf('ASK ABOUT THE DOG')).toBeLessThan(script.indexOf('IS EVERY GOAL'));
  });

  it('HAPPY: a script with NO intake is still a complete, valid call', () => {
    // WHY: a salon does not interview anybody. It books, and that is the whole call.
    const script = composeScript({ persona: PERSONA });
    expect(script).toContain('RUNG 2 —');
    expect(script).toContain('IS EVERY GOAL');
    expect(script.startsWith(PERSONA)).toBe(true);
  });

  it('SAD: an unknown intake id fails LOUDLY, at compose time', () => {
    // WHY: a typo'd block id must not silently produce a script with a hole in it. The
    //      agent would run a call missing an entire rung and nothing would look wrong.
    expect(() => composeScript({ persona: PERSONA, intake: ['intake_dentistry'] })).toThrow(
      /Unknown intake block/
    );
  });

  it('HAPPY: every block in CANONICAL_ORDER actually exists', () => {
    for (const id of CANONICAL_ORDER) {
      expect(BLOCKS[id], `CANONICAL_ORDER names a block that does not exist: ${id}`).toBeDefined();
    }
  });

  it('SAD: the meeting offer is OFF unless a tenant asks for it', () => {
    // WHY: RUNG 2b tells the model to offer a meeting unprompted, which is right for a
    //      business selling the owner's time and WRONG for a salon — there, a caller who
    //      did not ask for an appointment does not want one, and an offered-then-booked
    //      slot is the unasked-for diary entry RUNG 2 was hardened against (2026-07-22).
    //      Opt-in means a new ordinary tenant cannot inherit it by accident.
    const script = composeScript({ persona: PERSONA, intake: ['intake_job_inquiry'] });
    expect(script).not.toContain('RUNG 2b');
    expect(script).not.toContain(OFFER_MEETING.text);
  });

  it('HAPPY: offerMeeting puts RUNG 2b directly behind RUNG 2, before any intake', () => {
    // WHY: position is the whole point. The two rungs disagree on the surface — RUNG 2
    //      says mention the diary only if they push, RUNG 2b says offer it unprompted —
    //      and a model that reads them ADJACENT resolves that correctly, because 2b opens
    //      by naming what it overrides. Put an intake block between them and the override
    //      is separated from the rule it overrides by a page of role questions.
    const script = composeScript({
      persona: PERSONA,
      intake: ['intake_job_inquiry'],
      offerMeeting: true,
    });

    const rung2 = script.indexOf('RUNG 2 —');
    const rung2b = script.indexOf('RUNG 2b —');
    const intake = script.indexOf('What company are you calling from?');
    expect(rung2).toBeGreaterThan(-1);
    expect(rung2b).toBeGreaterThan(rung2);
    expect(rung2b, 'RUNG 2b must precede intake, not trail it').toBeLessThan(intake);
  });

  it('SAD: the offer block never weakens a booking guard', () => {
    // WHY: this is the block most likely to be "simplified" later by someone who reads it
    //      as permission to book more freely. It is not. Offering is not booking, and the
    //      three rules below are the ones a refused-booking call actually turns on — they
    //      must survive inside the block that sits next to them, or the override reads as
    //      a blanket one. (2026-07-22: caller said "No. No. No." and the meeting stayed.)
    const script = composeScript({ persona: PERSONA, offerMeeting: true });
    expect(script, 'consent before the diary').toMatch(/ONLY after they have said yes/i);
    expect(script, 'no success claim without the tool').toMatch(
      /Nothing is booked until book_with_scheduling returns success/i
    );
    expect(script, 'a refused booking must be undone').toMatch(/cancel_appointment/);
    expect(script, 'an offer is made once, not sold').toMatch(/OFFER ONCE/);
  });
});

/**
 * The shipped regular-tenant template — the default script a NEW ordinary
 * business is installed with. These guard the two properties that make it
 * "regular", either of which a careless edit could silently break:
 *   1. it interviews nobody (no intake block — that is staffing-only), and
 *   2. its persona does not contradict the message-by-default rungs.
 */
describe('regular-tenant.template.json — the default script for an ordinary business', () => {
  const template = JSON.parse(
    readFileSync(join(__dirname, '../../scripts/scripts/regular-tenant.template.json'), 'utf8')
  ) as ScriptComposition & { tenant?: string };
  const script = composeScript(template);

  it('carries every universal rung but NO intake', () => {
    // WHY: a salon/shop/trades caller is booked or messaged, never interviewed.
    //      intake_job_inquiry is the staffing vertical's block and must not ride
    //      along on the generic template.
    expect(script).not.toContain(INTAKE_JOB_INQUIRY.text);
    for (const id of ['identity', 'book_meeting', 'take_message', 'close']) {
      expect(script, `regular template missing universal rung ${id}`).toContain(BLOCKS[id].text);
    }
  });

  it('is message-by-default and its persona does not tell the model to book', () => {
    // WHY: the persona is prepended AHEAD of the rungs. A persona that says
    //      "book them a meeting" would fight RUNG 2's message-default and keep
    //      the old book-on-any-mention behavior alive (exactly the Thinking
    //      Hammer contradiction, 2026-07-23). Guard both halves.
    expect(script).toContain('DEFAULT OUTCOME OF A CALL IS A MESSAGE');
    expect(template.persona.toLowerCase()).not.toContain('book them a meeting');
    expect(template.persona).toMatch(/only when the caller asks/i);
  });

  it('omits a hard-coded tenant so it can be reused across tenants', () => {
    // WHY: the whole point of a template is that one file installs onto many
    //      tenants via --tenant. A pinned tenant here would silently target the
    //      wrong business.
    expect(template.tenant).toBeUndefined();
  });
});

/**
 * Thinking Hammer's own composition — the one live tenant, and the ONLY one that
 * offers the meeting unprompted. Its greeting says "Dale is available for hire" out
 * loud, so its script has to be able to act on that; these guard the pairing.
 */
describe("thinking-hammer.tenant.json — the script behind a line that sells the owner's time", () => {
  const composition = JSON.parse(
    readFileSync(join(__dirname, '../../scripts/scripts/thinking-hammer.tenant.json'), 'utf8')
  ) as ScriptComposition & { tenant?: string };
  const script = composeScript(composition);

  it('offers the meeting, and its persona agrees with the rung that does it', () => {
    // WHY: this file spent 2026-07-23 to 2026-07-27 contradicting itself. The persona
    //      said "book a meeting only when the caller asks for one; otherwise a message
    //      is the right outcome" while the greeting told callers "I can schedule some
    //      time with him" — so the line ADVERTISED a meeting the script then steered
    //      away from. A recruiter who described a role without using the word "meeting"
    //      got a voicemail slot. Guard both halves, the way the regular template does.
    expect(composition.offerMeeting).toBe(true);
    expect(script).toContain('RUNG 2b');
    expect(composition.persona).not.toMatch(/only when the caller asks/i);
    expect(composition.persona, 'the persona must not re-impose message-by-default').not.toMatch(
      /a message requesting a return call is the right outcome/i
    );
  });

  it('still runs the staffing intake, and still after the booking', () => {
    // WHY: offering the meeting changed the ORDER nothing. The role questions are
    //      preparation for a meeting that is already in the diary — the failure this
    //      whole module exists to prevent is nine perfect answers and an empty diary.
    expect(composition.intake).toEqual(['intake_job_inquiry']);
    expect(script.indexOf('RUNG 2 —')).toBeLessThan(
      script.indexOf('What company are you calling from?')
    );
  });

  it('stays pinned to its own tenant', () => {
    // WHY: the .tenant.json suffix promises this file targets ONE business. It carries a
    //      recruiting persona and a staffing intake; installed onto a salon by a stray
    //      --file, it would interview that salon's customers about contract rates.
    expect(composition.tenant).toBe('d5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0');
  });
});
