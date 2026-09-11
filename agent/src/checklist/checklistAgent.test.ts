/**
 * buildChecklistPrompt — the system prompt for the question-tree flow.
 *
 * These guard the WRONG BUSINESS branch added 2026-07-22 after a live call
 * froze and hung up: "Is this Bob's waxing service?" was routed by "THE ELSE"
 * to a speculative message tree, which locked the goodbye gate on a caller who
 * had nothing to leave. The fix lives in the prompt (the host gate is
 * deliberately strict — see checklistTools.test.ts), so a prompt that loses
 * this guidance silently reopens the deadlock. These tests fail if it does.
 */
import { describe, it, expect } from 'vitest';
import { llm } from '@livekit/agents';
import {
  buildChecklistPrompt,
  ChecklistAgent,
  ownerReference,
  STALL_TURN_LIMIT,
  GOODBYE_STALL_LIMIT,
} from './checklistAgent.js';
import { PLATFORM_TREE_LIBRARY } from './trees.js';

const prompt = buildChecklistPrompt({
  persona: 'You are Chris, the receptionist for Thinking Hammer.',
  runtime: {
    currentDate: 'Wednesday, July 22, 2026',
    currentTime: '3:00 PM',
    timezone: 'America/Chicago',
    businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
    bookableThrough: 'Friday, August 21, 2026',
  },
  library: PLATFORM_TREE_LIBRARY,
  callerPhone: '+12624979039',
});

describe('buildChecklistPrompt — wrong-business handling', () => {
  it('carries an explicit WRONG BUSINESS branch that answers in plain text and selects no tree', () => {
    // WHO: the "is this <other business>?" caller | WHERE: set_purpose guidance
    // WHY: selecting a tree here jams the goodbye gate — the exact freeze bug.
    expect(prompt).toMatch(/WRONG BUSINESS/);
    expect(prompt).toMatch(/do NOT select any tree/i);
    // The graceful answer the caller expected: restate who this business is.
    // Wording tightened 2026-08-04 — the correction now leads with an apology and
    // is followed by what the business DOES plus an offer, because the bare
    // one-sentence "no" this used to assert is what left callers on dead air.
    expect(prompt).toMatch(/No, sorry\s*—\s*this is/i);
  });

  it('gives a wrong-number EXIT — deselect via wrong_trees, then finish_call — if a tree was already selected', () => {
    // WHO: a model that speculatively selected before realizing the wrong number
    // WHY: the gate stays strict; the escape is removing the tree, not weakening
    //      the gate, so the caller is never stranded on dead air.
    expect(prompt).toMatch(/wrong_trees/);
    expect(prompt).toMatch(/finish_call/);
  });

  it('scopes THE ELSE so a bare identity question is NOT auto-routed to a message', () => {
    // WHO: THE ELSE catch-all | WHY: it used to fire message+generic_subject for
    // ANY unclassifiable input, including a wrong-number question — the trap.
    expect(prompt).toMatch(/wants something FROM THIS business/i);
  });
});

describe('buildChecklistPrompt — wrap-up is one question, not a 12s stack', () => {
  it('SAD: ending does not stack passed-along + email + anything-else in one breath', () => {
    // WHO: caller at checklist COMPLETE on 2026-07-21
    // WHAT: wrap-up is ONLY "Anything else I can help you with?" then finish_call
    // WHY: a 12s turn packed "I've passed that along" + email instruction +
    //      anything-else. Email is its own node (best_email). Passed-along is a
    //      tool result, not a wrap-up speech.
    expect(prompt).toMatch(/Anything else I can help you with\?/);
    expect(prompt).toMatch(
      /Do not combine a[\s\S]{0,40}passed-along line, an email instruction, and "anything else" in one turn/
    );
  });
});

describe('ChecklistAgent speaks "the owner" as the name (Dale, 2026-09-11)', () => {
  // WHO: every caller to a one-person business. WHAT: the live agent's ttsNode is
  // handed the roster's one name, so "I'll pass this on to the owner" is spoken as
  // "…to Dale" — whether the phrase came from the model, a DB question row, or a
  // backend tool result. WHY: "People don't know what that means even if I am the
  // owner." The rewrite itself is pinned in speechSanitizer.test.ts; this pins
  // that the production agent actually passes it a name.
  const runtime = {
    currentDate: 'Thursday, July 30, 2026',
    currentTime: '3:00 PM',
    timezone: 'America/Chicago',
    businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
    bookableThrough: 'Friday, August 28, 2026',
  };
  const make = (staffFirstNames?: string[]) =>
    new ChecklistAgent({ tools: {}, persona: 'You are Piper.', runtime, staffFirstNames });

  it('SAD: a one-person roster gives the spoken path that person’s name', () => {
    expect(make(['Dale']).spokenOwner()).toBe('Dale');
  });

  it('HAPPY: several staff or no roster leave the words alone', () => {
    expect(make(['Dale', 'Maria']).spokenOwner()).toBeNull();
    expect(make([]).spokenOwner()).toBeNull();
    expect(make().spokenOwner()).toBeNull();
  });

  it('SAD: the TRANSCRIPT branch is rewritten too — the call record matches the voice', async () => {
    // WHY: LiveKit tees the text BEFORE ttsNode; voice_sessions.transcript is built
    // from transcriptionNode's output. Without the override the record said "the
    // owner" while the caller heard "Dale".
    const input = new ReadableStream<string>({
      start(c) {
        for (const s of ['I will tell', ' the', ' owner', '.']) c.enqueue(s);
        c.close();
      },
    });
    const out = await make(['Dale']).transcriptionNode(input, {});
    expect(out).not.toBeNull();
    const reader = out!.getReader();
    const parts: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(typeof value === 'string' ? value : value.text);
    }
    expect(parts.join('')).toBe('I will tell Dale.');
  });
});

describe('the stall detector (SCL_nRKo3KEVw8Yh — five minutes of bot-mirror)', () => {
  // WHO: an AI recruiter bot mirroring "would you like me to leave a message?"
  //      at the agent for 5 minutes, the checklist frozen the whole time.
  // WHAT: onUserTurnCompleted compares the tracker's mutation count across
  //       caller turns; STALL_TURN_LIMIT stationary turns → one system note:
  //       stop re-asking, summarize, wrap up. Re-arms when the checklist moves.
  // WHY: every individual turn looked like conversation — only host state can
  //      see that the conversation is going nowhere.
  function makeAgent() {
    return new ChecklistAgent({
      tools: {},
      persona: 'You are Piper, the receptionist for Thinking Hammer.',
      runtime: {
        currentDate: 'Thursday, July 30, 2026',
        currentTime: '3:00 PM',
        timezone: 'America/Chicago',
        businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
        bookableThrough: 'Friday, August 28, 2026',
      },
    });
  }

  it('injects the wrap-up note after STALL_TURN_LIMIT stationary turns — and only once', async () => {
    const agent = makeAgent();
    const ctx = llm.ChatContext.empty();
    const fakeMsg = {} as llm.ChatMessage;
    for (let i = 0; i < STALL_TURN_LIMIT + 2; i++) {
      await agent.onUserTurnCompleted(ctx, fakeMsg);
    }
    const notes = ctx.items.filter((it) => it.type === 'message' && it.role === 'system');
    expect(notes).toHaveLength(1); // fires once per stall, never spams
    expect(JSON.stringify(notes[0])).toContain('summarize');
  });

  it('checklist movement resets the counter — a working call never sees the note', async () => {
    const agent = makeAgent();
    const ctx = llm.ChatContext.empty();
    const fakeMsg = {} as llm.ChatMessage;
    const tools = agent.currentTools();
    const exec = (name: string, args: unknown) =>
      (tools[name] as unknown as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(
        args,
        undefined
      );
    for (let i = 0; i < 6; i++) {
      // Every turn moves the checklist (a new selection or answer) — no stall.
      if (i === 0) await exec('set_purpose', { trees: ['identity'] });
      else await exec('record_answer', { node_id: 'caller_name', value: `Name${i}` });
      await agent.onUserTurnCompleted(ctx, fakeMsg);
    }
    expect(ctx.items.filter((it) => it.type === 'message' && it.role === 'system')).toHaveLength(0);
  });

  /**
   * WHO: Dana Whitfield on the 2026-08-15 `sim-questiontree` BUY THE SERVICE run.
   * WHAT: the checklist was COMPLETE — demo booked, every field answered — and
   *       the model then traded farewells for twenty turns ("Goodbye!" /
   *       "Goodbye!" / "Goodbye! If you need anything else…") without ever
   *       calling finish_call. The run ended on the harness's round cap.
   * WHERE: onUserTurnCompleted, the resolved branch.
   * WHY: the ordinary stall nudge fires ONCE and says "wrap up the call", which
   *      the model can satisfy with a sentence — and did, repeatedly. A phone
   *      line has no round cap: nothing was going to end that call but the
   *      caller hanging up. So this branch repeats, and names the actual gap:
   *      only finish_call ends a call.
   */
  /**
   * WHO: Neil Ashford on the 2026-08-15 sim (BUY vs JOB).
   * WHAT: the call ended with `book` still 'ready' for a caller who had said
   *       plainly he wanted a MESSAGE, not a meeting. finish_call was refused
   *       (correctly — the checklist was open), the model made one malformed
   *       booking attempt, then STOPPED CALLING TOOLS ENTIRELY and traded
   *       farewells for seven turns.
   * WHERE: onUserTurnCompleted's unresolved-stall branch, which latched on
   *        `#stallNudged` and therefore said its piece once, three turns in,
   *        and never again.
   * WHY: neither escape hatch could reach this. The resolved-branch nudge needs
   *      a COMPLETE checklist; FINISH_REFUSAL_LIMIT needs finish_call to keep
   *      being called. "Not done, and no longer trying" is its own failure mode.
   *      The repeat also names the exit the model never finds on its own —
   *      dropping the tree the caller no longer wants.
   */
  it('an UNRESOLVED stall re-fires, names the blocker, and offers the drop-the-tree exit', async () => {
    const agent = makeAgent();
    const ctx = llm.ChatContext.empty();
    const fakeMsg = {} as llm.ChatMessage;
    const tools = agent.currentTools();
    const exec = (name: string, args: unknown) =>
      (tools[name] as unknown as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(
        args,
        undefined
      );
    // booking selected and unanswered = an open checklist that cannot resolve.
    await exec('set_purpose', { work_direction: 'caller_pays_us', trees: ['identity', 'booking'] });

    // +1 because the turn right after set_purpose sees the mutation and resets
    // the counter — the stall only starts once the checklist stops moving.
    for (let i = 0; i < STALL_TURN_LIMIT * 2 + 1; i++) {
      await agent.onUserTurnCompleted(ctx, fakeMsg);
    }
    const notes = ctx.items.filter((it) => it.type === 'message' && it.role === 'system');
    expect(notes.length).toBeGreaterThan(1);

    const first = JSON.stringify(notes[0]);
    const repeat = JSON.stringify(notes[notes.length - 1]);
    expect(first).toContain('summarize what you already have');
    expect(repeat).toContain('STILL STUCK');
    expect(repeat).toContain('wrong_trees');
    // It must say WHICH node is holding the call open, not just that one is.
    expect(repeat).toContain('caller_name');
  });

  it('a COMPLETE checklist that stops moving is told that a farewell is not an ending', async () => {
    const agent = makeAgent();
    const ctx = llm.ChatContext.empty();
    const fakeMsg = {} as llm.ChatMessage;
    const tools = agent.currentTools();
    const exec = (name: string, args: unknown) =>
      (tools[name] as unknown as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(
        args,
        undefined
      );
    // qa's single node closed = a RESOLVED checklist, which is the state the
    // goodbye loop happens in: nothing left to do, and the model still talking.
    await exec('set_purpose', { work_direction: 'neither_or_unclear', trees: ['qa'] });
    await exec('record_answer', { node_id: 'qa_summary', value: 'asked about hours' });
    for (let i = 0; i < GOODBYE_STALL_LIMIT + 2; i++) {
      await agent.onUserTurnCompleted(ctx, fakeMsg);
    }
    const notes = ctx.items.filter((it) => it.type === 'message' && it.role === 'system');
    // REPEATS, unlike the one-shot stall nudge — the failure it catches is a loop.
    expect(notes.length).toBeGreaterThan(1);
    expect(JSON.stringify(notes[0])).toContain('finish_call');
    expect(JSON.stringify(notes[0])).toContain('saying goodbye does NOT end the call');
  });
});

describe('the Known caller section (batch A — the CRM snapshot reaches the LIVE path)', () => {
  // WHO: SCL_VcKTTgo4kS2v (2026-07-27, CALL_IMPROVEMENTS.md #8) — a caller with
  //      a live 2:30 appointment, phone-matched in the DB, told "you don't have
  //      a booked time on file". The snapshot was prefetched on every call and
  //      handed only to the ladder prompt, which prod never runs.
  const runtime = {
    currentDate: 'Thursday, July 30, 2026',
    currentTime: '3:00 PM',
    timezone: 'America/Chicago',
    businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
    bookableThrough: 'Friday, August 28, 2026',
  };

  it('renders the returning caller: appointments lead, in tenant-local words, with the never-deny rule', () => {
    const p = buildChecklistPrompt({
      persona: 'You are Piper.',
      runtime,
      library: PLATFORM_TREE_LIBRARY,
      knownCustomer: {
        name: 'Jaya',
        history: 'Booked a meeting about a Java contract',
        preferences: { preferred_contact: 'phone' },
        // 19:30 UTC = 2:30 PM America/Chicago — the live call's exact booking.
        upcomingAppointments: [
          { start_time: '2026-07-27T19:30:00.000Z', service: 'Programming Consultation' },
        ],
      },
    });
    expect(p).toContain('# Known caller');
    expect(p).toContain('Jaya');
    expect(p).toContain('2:30 PM'); // tenant-local, speakable — never raw ISO
    expect(p).toContain('Programming Consultation');
    expect(p).toContain('NEVER tell this caller they have no booking');
    expect(p).toContain('Booked a meeting about a Java contract');
  });

  it('known caller with NO appointments: directed to CHECK before denying, never assert from silence', () => {
    const p = buildChecklistPrompt({
      persona: 'You are Piper.',
      runtime,
      library: PLATFORM_TREE_LIBRARY,
      knownCustomer: { name: 'Dale', history: '', preferences: {}, upcomingAppointments: [] },
    });
    expect(p).toContain('# Known caller');
    expect(p).toContain('never assert');
    expect(p).toContain('get_my_appointments');
  });

  it('unknown caller: no Known-caller section, but the tool-gated-bookings rule still stands', () => {
    const p = buildChecklistPrompt({
      persona: 'You are Piper.',
      runtime,
      library: PLATFORM_TREE_LIBRARY,
      knownCustomer: null,
    });
    expect(p).not.toContain('# Known caller');
    expect(p).toContain('EXISTING BOOKINGS ARE TOOL-GATED FACTS');
  });
});

describe('batch B — the Jaya-cascade prompt guarantees', () => {
  const runtime = {
    currentDate: 'Tuesday, July 21, 2026',
    currentTime: '3:00 PM',
    timezone: 'America/Chicago',
    businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
    bookableThrough: 'Friday, August 28, 2026',
  };
  const build = (over: Partial<Parameters<typeof buildChecklistPrompt>[0]> = {}) =>
    buildChecklistPrompt({
      persona: 'You are Piper.',
      runtime,
      library: PLATFORM_TREE_LIBRARY,
      ...over,
    });

  it('the roster is named, and an unknown name must be QUESTIONED, never repeated as fact', () => {
    // WHO: the caller who asked for "Jane" — STT for "Dale", the only employee
    //      — and was confirmed into a meeting "with Jane" (2026-07-27, #10).
    const p = build({ staffFirstNames: ['Dale', 'Maria'] });
    expect(p).toContain('WHO WORKS HERE: Dale, Maria');
    expect(p).toContain('Do you mean Dale?');
    expect(p).toMatch(/never book, or say you booked, with a person who is not on this list/i);
  });

  it('no roster configured → no roster line at all (never an empty list read aloud)', () => {
    const p = build({ staffFirstNames: [] });
    expect(p).not.toContain('WHO WORKS HERE');
  });

  it('names the tenant zone and demands conversion when the caller states their own', () => {
    // WHO: the caller who said "2:30 EST" and was booked at 2:30 CENTRAL —
    //      an hour off what she agreed to (2026-07-27, #9).
    const p = build();
    expect(p).toContain('TIMES ARE IN America/Chicago');
    expect(p).toMatch(/2:30 Eastern is 1:30 our time/);
    expect(p).toMatch(/never\s+guess a zone from an area code/i);
  });

  it('forbids improvising what happens at the appointment, and points at what_happens_next', () => {
    // The single sentence that cost four follow-up calls: "call Dale directly…
    // you can use the same number" — the AI receptionist's own line.
    const p = build();
    expect(p).toContain('what_happens_next');
    expect(p).toMatch(/do NOT invent an answer/i);
  });

  it('records only what the caller SAID — a hedged mention is not an answer', () => {
    // "we place people at companies like Capgemini" must not become a
    // Capgemini role (the provenance gap found while auditing call #1).
    const p = build();
    expect(p).toMatch(/companies like Capgemini/);
    expect(p).toMatch(/ask one plain question to confirm it/i);
  });
});

/**
 * ORIENTATION + NEVER-GO-SILENT.
 *
 * Origin (owner, 2026-08-04): "many people are baffled" by reaching an AI. They
 * open by asking what this is, whether it is a real person, or whether they got
 * Dale's phone — anything but an answer to "how can I help you?" The failure
 * being prevented is the agent treating that as noise and going quiet, which
 * reads to the caller as a dropped line.
 *
 * The ROOT CAUSE was not missing instructions. The persona line was the only
 * thing the model knew about the business, and the prompt forbids inventing
 * services — so on "is this Barb's Waxing?" it had nothing true to say past a
 * bare "no", and stopped. These tests pin BOTH halves: the facts, and the rule.
 */
describe('buildChecklistPrompt — orientation, off-topic, and never going silent', () => {
  const withBusiness = buildChecklistPrompt({
    persona: 'You are Chris, the receptionist for Thinking Hammer.',
    runtime: {
      currentDate: 'Wednesday, July 22, 2026',
      currentTime: '3:00 PM',
      timezone: 'America/Chicago',
      businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
      bookableThrough: 'Friday, August 21, 2026',
    },
    library: PLATFORM_TREE_LIBRARY,
    businessName: 'Thinking Hammer LLC',
    businessBlurb: 'We build software and AI phone assistants for small businesses.',
  });

  // WHO: the "what is this?" caller | WHAT: the model has a true description to give |
  // WHEN: any orientation question | WHERE: "# What this business is" | WHY: this is the
  // fact whose absence caused the silence. Without it the only honest answer is "no".
  it('HAPPY: carries the business name and the owner-written blurb as FACTS', () => {
    expect(withBusiness).toContain('# What this business is');
    expect(withBusiness).toContain('Thinking Hammer LLC');
    expect(withBusiness).toContain('We build software and AI phone assistants');
  });

  // WHO: a tenant with no greeting_menu configured | WHAT: an explicit fallback |
  // WHEN: blurb is null | WHERE: business section | WHY: the absence of a blurb must
  // produce "say what you can DO", never an invented description of the business.
  it('SAD: with no blurb configured, forbids inventing one', () => {
    const noBlurb = buildChecklistPrompt({
      persona: 'You are Chris.',
      runtime: {
        currentDate: 'Wednesday, July 22, 2026',
        currentTime: '3:00 PM',
        timezone: 'America/Chicago',
        businessHours: null,
        bookableThrough: null,
      },
      library: PLATFORM_TREE_LIBRARY,
      businessName: 'Thinking Hammer LLC',
      businessBlurb: null,
    });
    expect(noBlurb).toContain('never invent a description');
  });

  // WHO: every caller | WHAT: the absolute rule | WHEN: every turn | WHERE: conversation
  // rules | WHY: the owner's instruction was explicit — "NOT JUST GO SILENT". A turn that
  // ends without speech reads as a dropped call.
  it('HAPPY: states that every turn ends in speech and silence is never correct', () => {
    expect(withBusiness).toContain('NEVER GO SILENT');
    expect(withBusiness).toMatch(/Every single turn you take ends in speech/);
  });

  // WHO: the baffled first-time caller | WHAT: answer-then-steer, in that order |
  // WHEN: they ask instead of answering | WHERE: orientation block | WHY: answering a
  // question with a question is what makes people repeat themselves and hang up.
  it('HAPPY: instructs ANSWER FIRST, then one easy question back', () => {
    expect(withBusiness).toContain('ANSWER FIRST, THEN STEER');
    expect(withBusiness).toContain('Never answer a question with a question');
    // An orientation question is not a purpose. The eval caught the model calling
    // set_purpose on "is this <owner>'s phone?", which puts unasked-for questions
    // on the checklist and lets the goodbye gate hold the call open on them.
    expect(withBusiness).toMatch(/NONE OF THOSE IS A PURPOSE/);
    expect(withBusiness).toMatch(/Do NOT call set_purpose on an orientation question/);
  });

  // WHO: "am I talking to a robot?" | WHAT: honest disclosure, no evasion | WHEN: asked
  // directly | WHERE: orientation examples | WHY: denying it is both a trust failure and,
  // in several states, a legal one. The greeting already discloses; this keeps the
  // mid-call answer consistent with it.
  it('HAPPY: answers "are you a real person" honestly and never denies being an AI', () => {
    expect(withBusiness).toContain('Never deny it');
    expect(withBusiness).toMatch(/I'm an AI assistant/);
  });

  // WHO: a caller making small talk | WHAT: a human reply, then a bridge | WHEN: off-topic
  // | WHERE: OFF-TOPIC block | WHY: the owner asked for a chatbot that talks back and then
  // steers — not one that stonewalls or that answers a joke with a checklist question.
  it('HAPPY: permits real small talk but requires every reply to bridge back', () => {
    expect(withBusiness).toContain('IDLE CHAT IS FINE');
    expect(withBusiness).toContain('TALK BACK LIKE A PERSON');
    // Engage with the substance, not a generic acknowledgement.
    expect(withBusiness).toMatch(/react to the substance/);
    // Permission to engage with the SUBJECT briefly, with real content in it —
    // a warm-but-empty "That's nice!" reads as a machine waiting for you to finish.
    expect(withBusiness).toMatch(/ACTUALLY TALK ABOUT THEIR TOPIC/);
    expect(withBusiness).toMatch(/worse than none/);
    // ...but the agent steers it home; the call must not be lost in the chatting.
    expect(withBusiness).toMatch(/THEN LEAD THEM BACK/);
    expect(withBusiness).toMatch(/never LOSE the call in the\s+chatting/);
    expect(withBusiness).toMatch(/never let the reason they called go\s+unasked/);
  });

  // WHO: any caller making small talk | WHAT: tone guardrail | WHEN: idle chat |
  // WHERE: KEEP IT LIGHT AND KIND | WHY: this is the first thing a stranger hears from
  // the business. Negativity, sarcasm or an opinion on politics/illness/money costs the
  // owner a customer, and forced cheerfulness reads as fake.
  it('HAPPY: requires warm-neutral tone and forbids negative or edgy chat', () => {
    expect(withBusiness).toMatch(/KEEP IT LIGHT AND KIND/);
    expect(withBusiness).toMatch(/never negative/);
    expect(withBusiness).toMatch(/sarcastic, edgy or strange/);
    expect(withBusiness).toMatch(/politics, religion, illness/);
    // Not the opposite failure either — relentless cheerfulness reads as fake.
    expect(withBusiness).toMatch(/forced cheerfulness reads as fake/);
  });

  // WHO: a caller chatting with an AI | WHAT: no fabricated personal life | WHEN: small
  // talk | WHERE: DO NOT INVENT A PERSONAL LIFE | WHY: an assistant that claims a dog or
  // a commute is asserting something untrue, and it directly contradicts answering "are
  // you a real person?" honestly two paragraphs earlier.
  it('HAPPY: forbids inventing personal experiences it cannot have', () => {
    expect(withBusiness).toMatch(/DO NOT INVENT A PERSONAL LIFE/);
    expect(withBusiness).toMatch(/Never claim experiences you cannot have/);
    // And the worked examples must not model the failure.
    expect(withBusiness).not.toMatch(/Ours ate a remote/);
    expect(withBusiness).not.toMatch(/my coffee went cold/);
    // The OPPOSITE failure: lecturing the caller about being an AI. Acknowledge
    // once, lightly, then get back to their call.
    expect(withBusiness).toMatch(/no speech about your nature/);
    expect(withBusiness).toMatch(/Do not\s+apologise for being an AI/);
    expect(withBusiness).toMatch(/Light and realistic/);
  });

  // WHO: a caller who wanders instead of answering | WHAT: the question is re-asked, not
  // recorded and not skipped | WHEN: a tangent lands where an answer should be | WHERE:
  // A NON-ANSWER IS NOT AN ANSWER | WHY: a checklist filled with near-misses is worse than
  // an empty one, because the owner acts on it.
  it('HAPPY: refuses to record a tangent as an answer and re-asks the same question', () => {
    expect(withBusiness).toMatch(/A NON-ANSWER IS NOT AN ANSWER/);
    expect(withBusiness).toMatch(/put\s+the\s+SAME question back/);
    expect(withBusiness).toMatch(/never fill in a plausible answer they never actually gave/);
  });

  // WHO: vague "hello / what is this?" opener | WHAT: capability menu in prompt |
  // WHEN: first turn before purpose is known | WHERE: "# What I can do for you" |
  // WHY (plan 08-10-2026): model had nothing concrete to offer after orientation beyond a
  // bare name — it went quiet or looped. The list is the thing it can say. Service detail
  // stays in the owner-written blurb (no hardcoded person names — multi-tenant).
  it('HAPPY: includes the capability menu (tenant-neutral) and defers services to the blurb', () => {
    expect(withBusiness).toContain('# What I can do for you');
    expect(withBusiness).toMatch(/take a message for the owner/);
    expect(withBusiness).toMatch(/help you pick a service and book an appointment/);
    expect(withBusiness).toMatch(/use only the facts in "# What this business is"/);
    expect(withBusiness).toMatch(/schedule a time simply to talk with the owner/);
    // No real person name may leak into the platform prompt for every tenant.
    expect(withBusiness).not.toMatch(/\bDale\b/);
  });

  // WHO: tenant with no greeting_menu | WHAT: capability still has a no-invent fallback |
  // WHEN: businessBlurb is absent | WHERE: capability section | WHY: Copilot review —
  // referencing a missing "# What this business is" section is an impossible instruction.
  it('HAPPY: without a blurb, capability lists three lanes and forbids inventing services', () => {
    const noBiz = buildChecklistPrompt({
      persona: 'You are Chris.',
      runtime: {
        currentDate: 'Wednesday, July 22, 2026',
        currentTime: '3:00 PM',
        timezone: 'America/Chicago',
        businessHours: null,
        bookableThrough: null,
      },
      library: PLATFORM_TREE_LIBRARY,
    });
    expect(noBiz).toContain('# What I can do for you');
    // No populated business section (other rules may still mention the heading by name).
    expect(noBiz).not.toMatch(/# What this business is\n/);
    expect(noBiz).toMatch(/no business description is configured/);
    expect(noBiz).toMatch(/never\s+invent services/);
  });

  // WHO: a tenant with a single staff first name | WHAT: capability uses that name |
  // WHEN: staffFirstNames is provided | WHERE: capability menu | WHY: "message for the
  // owner" is colder than "message for Jane" when we already know who works there.
  it('HAPPY: capability menu names the sole staff person when the roster has one name', () => {
    const withStaff = buildChecklistPrompt({
      persona: 'You are Chris.',
      runtime: {
        currentDate: 'Wednesday, July 22, 2026',
        currentTime: '3:00 PM',
        timezone: 'America/Chicago',
        businessHours: null,
        bookableThrough: null,
      },
      library: PLATFORM_TREE_LIBRARY,
      businessName: 'Acme Shop',
      staffFirstNames: ['Jordan'],
    });
    expect(withStaff).toMatch(/take a message for Jordan/);
    expect(withStaff).toMatch(/talk with Jordan/);
  });

  // WHO: "yeah / uh-huh" vs "what? / I don't get it" | WHAT: filler ignored, real interrupt
  // handled | WHEN: mid-checklist acknowledgments and clarification asks | WHERE: FILLER
  // VS REAL INTERRUPTION | WHY (plan 08-10-2026): empty noise must not re-ask or re-route;
  // a real "wait I don't get it" must not be treated as an answer.
  it('HAPPY: distinguishes filler noise from real clarification requests', () => {
    expect(withBusiness).toMatch(/FILLER VS REAL INTERRUPTION/);
    expect(withBusiness).toMatch(/Ignore empty noise/);
    expect(withBusiness).toMatch(/uh-huh/);
    expect(withBusiness).toMatch(/REAL clarification request/);
    expect(withBusiness).toMatch(/what part is confusing/);
  });

  // WHO: a caller re-asked too many times | WHAT: escalation, then an exit | WHEN: third
  // attempt | WHERE: same block | WHY: asking a fourth time is the loop callers hang up on.
  it('HAPPY: caps re-asking and changes shape rather than looping', () => {
    expect(withBusiness).toMatch(/Third time on the same question/);
    expect(withBusiness).toMatch(/Never ask the same question a fourth time/);
  });

  // WHO: "never mind, I'll book later" | WHAT: the tree is released AND alternatives are
  // offered | WHEN: the caller backs out | WHERE: THEY CHANGED THEIR MIND | WHY: a dropped
  // goal left selected freezes the goodbye gate — the same jam as the wrong-number freeze —
  // and "okay, bye" sends away someone who still wanted something.
  it('HAPPY: on a change of mind, releases the tree and offers the other options', () => {
    expect(withBusiness).toMatch(/THEY CHANGED THEIR MIND/);
    expect(withBusiness).toMatch(/Remove that tree with set_purpose \(wrong_trees\)/);
    expect(withBusiness).toMatch(/OFFER WHAT IS LEFT/);
    expect(withBusiness).toMatch(/do not just say "okay" and hang up/);
    // SPEAK FIRST. The eval caught the model spending its whole turn on the
    // set_purpose call and saying NOTHING — the caller says "never mind" and
    // hears silence. Ordering the instruction tool-first is what caused it.
    expect(withBusiness).toMatch(/SPEAK IN THE SAME TURN/);
    expect(withBusiness).toMatch(/SPEAK FIRST/);
    expect(withBusiness).toMatch(/only a set_purpose call and no words is DEAD AIR/);
  });

  // WHO: a caller who declines the alternative too | WHAT: one offer, not three | WHEN:
  // second refusal | WHERE: same block | WHY: pushing past a second no loses the customer.
  it('HAPPY: accepts a second refusal instead of pushing', () => {
    expect(withBusiness).toMatch(/one offer, not three/);
    expect(withBusiness).toMatch(/Pushing after a second no/);
  });

  // WHO: a caller on bad phone audio | WHAT: an explicit repair line | WHEN: STT garbles
  // them | WHERE: repair block | WHY: there was NO no-match handling anywhere in the agent
  // before this — grep for "didn't catch" returned nothing. Guessing books the wrong thing.
  it('HAPPY: gives an explicit repair line instead of guessing or stalling', () => {
    expect(withBusiness).toMatch(/didn't\s+catch that/);
    expect(withBusiness).toContain('do not guess and do not stall');
  });

  // WHO: the wrong-number caller | WHAT: a real answer, not a bare "no" | WHEN: "is this
  // Barb's Waxing?" | WHERE: WRONG BUSINESS branch | WHY: the previous rule said answer in
  // ONE plain sentence and "let them steer" — which is precisely the dead air the owner
  // reported. The answer now carries what the business does and ends in an offer.
  it('HAPPY: wrong-business answer names the business, says what it does, and offers a way in', () => {
    expect(withBusiness).toContain('do NOT answer with a bare "no"');
    expect(withBusiness).toContain('Say what this business actually does');
    expect(withBusiness).toMatch(/anything there I can help with/i);
  });

  it('HAPPY: sophisticated first turns are answered at their level before narrowing', () => {
    expect(withBusiness).toMatch(/SOPHISTICATED OPENERS ARE STILL OPENERS/);
    expect(withBusiness).toMatch(/rich evaluating question/i);
    expect(withBusiness).toMatch(/do not chop it down to "How can I help\?"/i);
    expect(withBusiness).toMatch(/answer the highest-level part you honestly can/i);
    expect(withBusiness).toMatch(/mirror the real dimensions they named/i);
    expect(withBusiness).toMatch(/ask one narrowing question/i);
  });

  it('HAPPY: multi-part buyers are not flattened into one checkbox or one thread', () => {
    expect(withBusiness).toMatch(/multi-part buyer/i);
    expect(withBusiness).toMatch(/multiple locations, calendar sync, price, and compliance/i);
    expect(withBusiness).toMatch(/do not pretend they asked only one thing/i);
    expect(withBusiness).toMatch(/record every concrete fact they\s+already gave/i);
    expect(withBusiness).toMatch(/select every tree that truly matches/i);
  });
});

/**
 * Plan 08-10-2026 — initial clarification + filler vs real interruption.
 *
 * Prompt-level guarantees for vague openers and mid-call noise. Service detail
 * is tenant data (greeting_menu / roster), never a hardcoded person. If any of
 * these pins break, callers hear silence, re-asks, or another tenant's name.
 */
describe('plan 08-10-2026 — capability menu + filler/interrupt (matrix)', () => {
  const runtime = {
    currentDate: 'Monday, August 10, 2026',
    currentTime: '3:00 PM',
    timezone: 'America/Chicago',
    businessHours: 'Monday to Friday, 9:00 AM to 5:00 PM',
    bookableThrough: 'Friday, September 11, 2026',
  } as const;

  const build = (over: Partial<Parameters<typeof buildChecklistPrompt>[0]> = {}) =>
    buildChecklistPrompt({
      persona: 'You are Piper, the AI receptionist.',
      runtime,
      library: PLATFORM_TREE_LIBRARY,
      ...over,
    });

  /** Capability section only — everything after the heading until the next `#`. */
  function capabilityBody(p: string): string {
    const m = p.match(/# What I can do for you\n([\s\S]*?)(?=\n# |\n\n# |$)/);
    expect(m, 'capability section missing').toBeTruthy();
    return m?.[1] ?? '';
  }

  // ── Always present ────────────────────────────────────────────────────────

  it.each([
    { label: 'empty tenant', opts: {} },
    { label: 'name only', opts: { businessName: 'Acme Shop' } },
    { label: 'blurb only', opts: { businessBlurb: 'We fix bikes and tune gears.' } },
    {
      label: 'name + blurb',
      opts: { businessName: 'Acme Shop', businessBlurb: 'We fix bikes and tune gears.' },
    },
    { label: 'roster only', opts: { staffFirstNames: ['Sam'] } },
    {
      label: 'full tenant',
      opts: {
        businessName: 'Acme Shop',
        businessBlurb: 'We fix bikes.',
        staffFirstNames: ['Sam', 'Alex'],
        callerPhone: '+15551234567',
      },
    },
  ])('HAPPY: capability menu always present ($label)', ({ opts }) => {
    const p = build(opts);
    expect(p).toContain('# What I can do for you');
    const body = capabilityBody(p);
    // Three core lanes — the thing a vague "hello" caller must hear.
    expect(body).toMatch(/complete question about the business/i);
    expect(body).toMatch(/take a message/i);
    expect(body).toMatch(/book an appointment/i);
    expect(body).toMatch(/Talk like a regular person/i);
  });

  // ── Blurb vs no-blurb service fact lines (mutually exclusive) ─────────────

  it('HAPPY: with blurb, defers service facts to the business section (no invent)', () => {
    const p = build({
      businessName: 'Acme',
      businessBlurb: 'We repair laptops and remove malware.',
    });
    const body = capabilityBody(p);
    expect(body).toMatch(/use only the facts in "# What this business is"/);
    expect(body).toMatch(/never invent services/);
    expect(body).not.toMatch(/no business description is configured/);
    // Blurb itself is in the business section, not re-hardcoded into capability.
    expect(p).toMatch(/# What this business is/);
    expect(p).toContain('We repair laptops and remove malware.');
  });

  it('HAPPY: without blurb, lists three plain lanes and forbids inventing', () => {
    const p = build({ businessName: 'Acme' });
    const body = capabilityBody(p);
    expect(body).toMatch(/no business description is configured/);
    expect(body).toMatch(/book a time, take a message, answer questions/);
    expect(body).toMatch(/never\s+invent services/);
    expect(body).not.toMatch(/use only the facts in "# What this business is"/);
  });

  it('HAPPY: blurb-only tenant still gets a business section + capability', () => {
    const p = build({ businessBlurb: 'Mobile oil changes at your driveway.' });
    expect(p).toMatch(/# What this business is/);
    expect(p).toContain('Mobile oil changes at your driveway.');
    expect(capabilityBody(p)).toMatch(/use only the facts in "# What this business is"/);
  });

  // ── Owner reference matrix (roster → spoken name) ─────────────────────────

  it('HAPPY: zero staff → "the owner" (never a platform founder name)', () => {
    const body = capabilityBody(build({ staffFirstNames: [] }));
    expect(body).toMatch(/take a message for the owner/);
    expect(body).toMatch(/talk with the owner/);
    expect(body).not.toMatch(/\bDale\b/);
    expect(body).not.toMatch(/\bDeMott\b/i);
  });

  it('HAPPY: one staff name → that name in message + talk lines', () => {
    const body = capabilityBody(build({ staffFirstNames: ['Jordan'] }));
    expect(body).toMatch(/take a message for Jordan/);
    expect(body).toMatch(/talk with Jordan/);
    expect(body).not.toMatch(/the owner/);
    expect(body).not.toMatch(/someone on the team/);
  });

  it('HAPPY: multiple staff → "someone on the team" (no arbitrary first pick)', () => {
    const body = capabilityBody(build({ staffFirstNames: ['Sam', 'Alex', 'Riley'] }));
    expect(body).toMatch(/take a message for someone on the team/);
    expect(body).toMatch(/talk with someone on the team/);
    // Roster still lists real names for the WHO WORKS HERE line — just not in capability.
    const p = build({ staffFirstNames: ['Sam', 'Alex', 'Riley'] });
    expect(p).toContain('WHO WORKS HERE: Sam, Alex, Riley');
    expect(body).not.toMatch(/take a message for Sam/);
  });

  it('SAD: whitespace-only / empty staff entries are dropped (not spoken as blank)', () => {
    const p = build({ staffFirstNames: ['  ', '', '\t', '  Pat  '] });
    // Trimmed sole real name → treated as single staff.
    expect(capabilityBody(p)).toMatch(/take a message for Pat/);
    // Exact roster line — no empty slots, name trimmed.
    expect(p).toMatch(/WHO WORKS HERE: Pat\./);
    expect(p).not.toMatch(/WHO WORKS HERE: ,/);
    expect(p).not.toMatch(/WHO WORKS HERE: {2}/);
  });

  it('SAD: all-whitespace roster collapses to "the owner"', () => {
    const body = capabilityBody(build({ staffFirstNames: ['  ', '\n', ''] }));
    expect(body).toMatch(/take a message for the owner/);
    expect(build({ staffFirstNames: ['  ', '\n', ''] })).not.toContain('WHO WORKS HERE');
  });

  it('SAD: capability never hardcodes a denied real-person name when roster is empty', () => {
    // Mirrors tests/noHardcodedNames.test.ts intent at the PROMPT OUTPUT layer —
    // even if source drifted, the empty-roster path must stay neutral.
    const body = capabilityBody(build());
    for (const banned of ['Dale', 'DeMott', 'ThinkingHammer', 'thinkinghammer']) {
      expect(body).not.toMatch(new RegExp(`\\b${banned}\\b`, 'i'));
    }
  });

  // ── Filler vs real interruption ───────────────────────────────────────────

  describe('filler vs real interruption rules', () => {
    const p = build({
      businessName: 'Acme',
      businessBlurb: 'We fix things.',
    });

    it('HAPPY: names the rule block so future edits cannot silently drop it', () => {
      expect(p).toMatch(/FILLER VS REAL INTERRUPTION/);
    });

    it.each(['yeah', 'uh-huh', 'k', 'okay', 'go on', 'mm-hmm'])(
      'HAPPY: filler word %j is listed as empty noise to ignore',
      (word) => {
        expect(p).toContain(word);
      }
    );

    it('HAPPY: filler must not be recorded, re-asked, or treated as purpose', () => {
      expect(p).toMatch(/Ignore empty noise/);
      expect(p).toMatch(/Do NOT record them/);
      expect(p).toMatch(/do NOT\s+re-ask the last question/i);
      expect(p).toMatch(/do NOT treat them as a new purpose/i);
      expect(p).toMatch(/Continue as if they\s+said nothing/);
      expect(p).toMatch(/a short "yeah" is not consent and not an answer/);
    });

    it.each(['what?', 'can you repeat that', "wait I\ndon't get it", "I'm confused", 'hold on'])(
      'HAPPY: real clarification cue is present: %j',
      (cue) => {
        // Prompt may wrap lines — normalize whitespace for multi-word cues.
        const compact = p.replace(/\s+/g, ' ');
        const needle = cue.replace(/\s+/g, ' ');
        expect(compact).toContain(needle);
      }
    );

    it('HAPPY: real interrupt → intelligent recovery, not a fixed script', () => {
      expect(p).toMatch(/REAL clarification request/);
      expect(p).toMatch(/repeat the\s+last sentence/i);
      expect(p).toMatch(/simplify/i);
      expect(p).toMatch(/what part is confusing/);
      expect(p).toMatch(/never hardcode a fixed recovery phrase/i);
      expect(p).toMatch(/use the checklist and what the caller already\s+said/i);
    });

    it('HAPPY: filler block sits with non-answer handling (before re-ask cap)', () => {
      // Ordering: NON-ANSWER → FILLER → Third time. If filler moves after the
      // re-ask cap, the model may re-ask before deciding the turn was noise.
      const nonAnswer = p.indexOf('A NON-ANSWER IS NOT AN ANSWER');
      const filler = p.indexOf('FILLER VS REAL INTERRUPTION');
      const third = p.indexOf('Third time on the same question');
      expect(nonAnswer).toBeGreaterThan(-1);
      expect(filler).toBeGreaterThan(nonAnswer);
      expect(third).toBeGreaterThan(filler);
    });
  });

  // ── Integration with orientation / change-of-mind (still intact) ──────────

  it('HAPPY: vague orientation still is NOT a purpose (capability does not override)', () => {
    const p = build({ businessName: 'Acme', businessBlurb: 'We fix bikes.' });
    expect(p).toMatch(/NONE OF THOSE IS A PURPOSE/);
    expect(p).toMatch(/Do NOT call set_purpose on an orientation question/);
    // Capability gives something to SAY; orientation still forbids tree select.
    expect(p).toContain('# What I can do for you');
  });

  it('HAPPY: mind-change still releases trees + speaks in the same turn', () => {
    const p = build();
    expect(p).toMatch(/THEY CHANGED THEIR MIND/);
    expect(p).toMatch(/SPEAK FIRST/);
    expect(p).toMatch(/wrong_trees/);
  });

  it('HAPPY: three lanes survive alongside known-caller and caller-ID lines', () => {
    const p = build({
      businessName: 'Acme',
      businessBlurb: 'We fix bikes.',
      staffFirstNames: ['Sam'],
      callerPhone: '+15551234567',
      knownCustomer: {
        name: 'Casey',
        history: '',
        preferences: {},
        upcomingAppointments: [],
      },
    });
    expect(p).toContain('# Known caller');
    expect(p).toMatch(/RETURNING caller/);
    expect(p).toMatch(/NEVER ask for it and NEVER recite it back/);
    expect(capabilityBody(p)).toMatch(/take a message for Sam/);
  });
});

describe('stall detector — re-arm after recovery (plan companion)', () => {
  // Extends the SCL_nRKo3KEVw8Yh suite: after a stall fires, movement must re-arm
  // so a later freeze can fire again (not permanently silenced by #stallNudged).

  function makeAgent() {
    return new ChecklistAgent({
      tools: {},
      persona: 'You are Piper.',
      runtime: {
        currentDate: 'Monday, August 10, 2026',
        currentTime: '3:00 PM',
        timezone: 'America/Chicago',
        businessHours: null,
        bookableThrough: null,
      },
    });
  }

  it('HAPPY: after stall fires, checklist movement re-arms for a later stall', async () => {
    const agent = makeAgent();
    const ctx = llm.ChatContext.empty();
    const fakeMsg = {} as llm.ChatMessage;
    const tools = agent.currentTools();
    const exec = (name: string, args: unknown) =>
      (tools[name] as unknown as { execute: (a: unknown, c: unknown) => Promise<unknown> }).execute(
        args,
        undefined
      );

    // Stall #1
    for (let i = 0; i < STALL_TURN_LIMIT; i++) {
      await agent.onUserTurnCompleted(ctx, fakeMsg);
    }
    let notes = ctx.items.filter((it) => it.type === 'message' && it.role === 'system');
    expect(notes).toHaveLength(1);

    // Movement re-arms
    await exec('set_purpose', { trees: ['identity'] });
    await agent.onUserTurnCompleted(ctx, fakeMsg);

    // Stall #2 — fresh stationary streak
    for (let i = 0; i < STALL_TURN_LIMIT; i++) {
      await agent.onUserTurnCompleted(ctx, fakeMsg);
    }
    notes = ctx.items.filter((it) => it.type === 'message' && it.role === 'system');
    expect(notes.length).toBeGreaterThanOrEqual(2);
  });

  it('SAD: fewer than STALL_TURN_LIMIT stationary turns injects nothing', async () => {
    const agent = makeAgent();
    const ctx = llm.ChatContext.empty();
    const fakeMsg = {} as llm.ChatMessage;
    for (let i = 0; i < STALL_TURN_LIMIT - 1; i++) {
      await agent.onUserTurnCompleted(ctx, fakeMsg);
    }
    expect(ctx.items.filter((it) => it.type === 'message' && it.role === 'system')).toHaveLength(0);
  });
});

describe('buildChecklistPrompt — hire / meeting purpose examples', () => {
  // WHO: 2026-08-13 sim-call — "position in Chicago" + "talk to y'all".
  // WHAT: the side-by-side examples and talk-to rule the model reads at
  //       set_purpose time. Not an LLM test — if the phrases drop, the next
  //       recruiter opener files as a message again.
  const hirePrompt = buildChecklistPrompt({
    persona: 'You are Piper, the receptionist for Thinking Hammer.',
    runtime: {
      currentDate: 'Thursday, August 13, 2026',
      currentTime: '3:00 PM',
      timezone: 'America/Chicago',
      businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
      bookableThrough: 'Friday, August 28, 2026',
    },
    library: PLATFORM_TREE_LIBRARY,
  });

  it('HAPPY: "I have a position" and "I have a contract" map to the job tree', () => {
    expect(hirePrompt).toMatch(/I have a position for \[the owner\].*→.*job/s);
    expect(hirePrompt).toMatch(/I have a contract for \[the owner\].*→.*job/s);
    expect(hirePrompt).toMatch(
      /OFFERING THE OWNER PAID WORK \(a role, a\s+position, a\s+contract/s
    );
  });

  it('HAPPY: talk-to / meet about X is always booking plus the tree for X', () => {
    expect(hirePrompt).toMatch(/TALK TO \/ speak with \/ meet \[someone\] about X/i);
    expect(hirePrompt).toMatch(/ALWAYS\s+booking \+ the tree for X/i);
  });

  it('SAD: a vague opener still must ask, not guess job vs buy', () => {
    expect(hirePrompt).toMatch(/If a vague opener could be either, do not guess/i);
    expect(hirePrompt).toMatch(/Are you looking to hire him/i);
  });

  it('SAD: a service request that uses the word "job" is not the job tree', () => {
    expect(hirePrompt).toMatch(/SERVICE REQUEST/i);
    expect(hirePrompt).toMatch(/can someone fix my computer/i);
  });
});

/**
 * WHO: Dale, 2026-09-09 — "Don't use owner. Always use Dale instead. Owner sounds cold."
 * WHAT: every caller-facing mention of the person resolves to their NAME when the
 *       tenant roster gives one, and the prompt carries an explicit rule that
 *       outranks a tree question worded "the owner".
 * WHEN: every call on a tenant with staff configured.
 * WHERE: ownerReference() + the naming rule in buildChecklistPrompt.
 * WHY: the 2026-09-09 prod call asked "What else would you like the owner to know
 *      or do about this role?" — the wording came from the question NODE, and a
 *      provisioned tenant runs its nodes from tenant_question_nodes rows, so
 *      editing trees.ts would not have changed a single real call. The prompt is
 *      code; it ships, and it is allowed to override the node's phrasing.
 */
describe('the person has a name, not a role', () => {
  const withStaff = (staffFirstNames: string[]) =>
    buildChecklistPrompt({
      persona: 'You are Piper.',
      runtime: {
        currentDate: 'Wednesday, September 9, 2026',
        currentTime: '3:00 PM',
        timezone: 'America/Chicago',
        businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
        bookableThrough: 'Friday, October 9, 2026',
      },
      library: PLATFORM_TREE_LIBRARY,
      staffFirstNames,
    });

  it('one staff member → that name is what the prompt tells it to say', () => {
    const p = withStaff(['Dale']);
    expect(p).toContain('CALL DALE BY NAME, NEVER "THE OWNER"');
    expect(p).toContain('what would you like Dale to know?');
    expect(p).toContain('take a message for Dale');
  });

  it('several staff → "someone on the team", because guessing a name would be worse', () => {
    const p = withStaff(['Ana', 'Bella', 'Cleo']);
    expect(p).toContain('take a message for someone on the team');
    expect(p).not.toContain('take a message for Ana');
  });

  it('no roster → the role word survives, and the prompt says why', () => {
    // Cold but true. This is the only case where "the owner" is still correct.
    expect(withStaff([])).toContain('No staff roster is configured');
  });

  it('ownerReference trims and ignores blank roster entries', () => {
    expect(ownerReference(['  Dale  '])).toBe('Dale');
    expect(ownerReference(['', '   '])).toBe('the owner');
    expect(ownerReference(['Dale', ''])).toBe('Dale');
  });
});

/**
 * The 2026-09-09 four-call sweep (SCL_e8AzxA5vM3ZN, SCL_n79MyVHh9TVe,
 * SCL_HQNeyh5cVKd9, SCL_A9GtJeZF7EwF). Each case below is a sentence the agent
 * actually said to a caller that was false, unhelpful, or a promise it could not
 * keep. The prompt is the only lever that reaches a tenant whose questions live in
 * DATABASE rows, so these assertions guard the prompt.
 */
describe('the 2026-09-09 call sweep', () => {
  const build = (over: Record<string, unknown> = {}) =>
    buildChecklistPrompt({
      persona: 'You are Piper.',
      runtime: {
        currentDate: 'Wednesday, September 9, 2026',
        currentTime: '6:08 PM',
        timezone: 'America/Chicago',
        businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
        bookableThrough: 'Friday, October 9, 2026',
      },
      library: PLATFORM_TREE_LIBRARY,
      staffFirstNames: ['Dale'],
      ...over,
    });

  it('carries the actual CLOCK, not just the date', () => {
    // It told a caller "it's currently 3 PM here" at 6:08 PM, twice, and then
    // argued when she corrected it. It had been given the date and no time.
    const p = build();
    expect(p).toContain('6:08 PM');
    expect(p).toContain('Wednesday, September 9, 2026');
    expect(p).toMatch(/ONLY source for the current time/i);
  });

  it('after hours: today is over, and the closure is paired with the next real time', () => {
    // Same call: "We have availability today from 1 to 5 PM" — said at 6:08 PM,
    // three hours after closing. The runtime is built at 6:08 PM here.
    const p = build();
    expect(p).toMatch(/once the closing hour has passed today is over/i);
    // Both halves together: a bare "we're closed" reads as a refusal and ends the
    // call, which is a lost booking for a caller who would happily take tomorrow.
    expect(p).toMatch(/SAY BOTH HALVES IN ONE BREATH/i);
    expect(p).toContain("we're closed for the evening, but I can get you in tomorrow at 1:30");
  });

  it('states plainly that it cannot text, when SMS is off', () => {
    // It ran an invented consent flow on two callers and told both a reminder was
    // noted. Nothing was noted; no text can leave the platform.
    const p = build({ smsEnabled: false });
    expect(p).toContain('YOU CANNOT SEND A TEXT MESSAGE');
    expect(p).toMatch(/never ask permission for one/i);
  });

  it('says nothing about texting being impossible when SMS is actually on', () => {
    expect(build({ smsEnabled: true })).not.toContain('YOU CANNOT SEND A TEXT MESSAGE');
  });

  it('requires a plain confirmation sentence after a successful write', () => {
    // A message was saved and the caller heard only "You're all set, Camille."
    const p = build();
    expect(p).toMatch(/SAY SO IN ONE PLAIN SENTENCE BEFORE YOU CLOSE/i);
    expect(p).toContain("I've saved your message for Dale");
  });

  it('treats a company named in the opener as answered, not as a question to re-ask', () => {
    // "There's a job opening at US Bank" → asked which company twice.
    const p = build();
    expect(p).toContain('A COMPANY NAMED IN THE OPENER IS THE COMPANY');
    expect(p).toMatch(/If you are unsure which slot the name belongs in, ASK THAT/i);
  });
});
