/**
 * ChecklistTracker — phase 1 of the QUESTION TREE architecture
 * (docs/QUESTION_TREE_ARCHITECTURE.md §4.1).
 *
 * WHO: the pure host-side checklist state machine, no LiveKit involved.
 * WHAT: every behaviour the design conversation named, as a test — out-of-order
 *       volunteering, pre-branch pending, sibling-✗ recursion, mind-change ghost
 *       discard, declined-vs-✗, action gating, the goodbye gate.
 * WHY: the rung era proved these classes of failure only surface on live calls
 *      when the state lives in the model; host-owned state makes them unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  ChecklistTracker,
  RecordError,
  TreeDefinitionError,
  UnknownNodeError,
  UnknownTreeError,
} from './tracker.js';
import type { QuestionTreeDef } from './types.js';

// ── Fixture library — the design doc's own example, verbatim shape ───────────

const IDENTITY: QuestionTreeDef = {
  tree_id: 'identity',
  description: 'Who is calling and how to reach them.',
  nodes: [
    { node_id: 'caller_name', type: 'text', ask: 'the name the caller used for themselves' },
    {
      node_id: 'caller_phone',
      type: 'text',
      ask: 'best callback number, confirmed digit by digit',
    },
  ],
};

const JOB: QuestionTreeDef = {
  tree_id: 'job',
  description: 'Caller is bringing a job/role/contract TO the owner.',
  nodes: [
    // Shared with IDENTITY on purpose — the merge/dedupe seam.
    { node_id: 'caller_name', type: 'text', ask: 'the name the caller used for themselves' },
    { node_id: 'callers_company', type: 'text', ask: 'the company the CALLER is with' },
    {
      node_id: 'job_type',
      type: 'choice',
      ask: 'contract, fulltime, or contract_to_hire',
      options: {
        contract: [
          { node_id: 'client_company', type: 'text', ask: 'the CLIENT company where the work is' },
          {
            node_id: 'work_mode',
            type: 'choice',
            ask: 'remote, hybrid, or onsite',
            options: {
              remote: [{ node_id: 'timezone', type: 'text', ask: "the team's timezone" }],
              // timezone appears under TWO branches — one question, two paths to relevance.
              hybrid: [
                { node_id: 'client_address', type: 'text', ask: "the client's address" },
                { node_id: 'timezone', type: 'text', ask: "the team's timezone" },
              ],
              onsite: [{ node_id: 'client_address', type: 'text', ask: "the client's address" }],
            },
          },
        ],
        fulltime: [{ node_id: 'start_date', type: 'text', ask: 'the target start date' }],
        contract_to_hire: [
          { node_id: 'conversion_terms', type: 'text', ask: 'the conversion timeline' },
        ],
      },
    },
    {
      node_id: 'capture',
      type: 'action',
      tool: 'capture_job_inquiry',
      description: 'record the job inquiry for the owner',
      requires: ['callers_company', 'job_type'],
    },
  ],
};

const MESSAGE: QuestionTreeDef = {
  tree_id: 'message',
  description: 'Caller wants to leave a message for the owner.',
  nodes: [
    { node_id: 'caller_name', type: 'text', ask: 'the name the caller used for themselves' },
    { node_id: 'message_body', type: 'text', ask: 'the message, in their words' },
    {
      node_id: 'take_message_action',
      type: 'action',
      tool: 'take_message',
      description: 'save the message',
      requires: ['caller_name', 'message_body'],
    },
  ],
};

const BOOKING: QuestionTreeDef = {
  tree_id: 'booking',
  description: 'Caller wants time with someone here.',
  nodes: [
    {
      node_id: 'book',
      type: 'action',
      tool: 'book_with_scheduling',
      description: 'book the meeting',
      // caller_phone lives in the IDENTITY tree — a legitimate CROSS-TREE require.
      requires: ['caller_name', 'caller_phone'],
    },
  ],
};

const LIBRARY = [IDENTITY, JOB, MESSAGE, BOOKING];
const make = (): ChecklistTracker => new ChecklistTracker(LIBRARY);

// ── Library validation (boot-time failures, never mid-call) ──────────────────

describe('library validation', () => {
  it('rejects a duplicate tree_id', () => {
    expect(() => new ChecklistTracker([IDENTITY, IDENTITY])).toThrow(TreeDefinitionError);
  });

  it('rejects a node nested under itself (would recurse forever at liveness time)', () => {
    const cyclic: QuestionTreeDef = {
      tree_id: 'cyclic',
      description: '',
      nodes: [
        {
          node_id: 'a',
          type: 'choice',
          ask: '',
          options: { yes: [{ node_id: 'a', type: 'text', ask: '' }] },
        },
      ],
    };
    expect(() => new ChecklistTracker([cyclic])).toThrow(/nested under itself/);
  });

  it('rejects a shared node id whose type disagrees across trees', () => {
    const conflicting: QuestionTreeDef = {
      tree_id: 'conflict',
      description: '',
      nodes: [{ node_id: 'caller_name', type: 'choice', ask: '', options: { x: [] } }],
    };
    expect(() => new ChecklistTracker([IDENTITY, conflicting])).toThrow(/must agree on type/);
  });

  it('rejects a shared choice whose option sets disagree across trees', () => {
    const a: QuestionTreeDef = {
      tree_id: 'a',
      description: '',
      nodes: [{ node_id: 'mode', type: 'choice', ask: '', options: { remote: [], onsite: [] } }],
    };
    const b: QuestionTreeDef = {
      tree_id: 'b',
      description: '',
      nodes: [{ node_id: 'mode', type: 'choice', ask: '', options: { remote: [] } }],
    };
    expect(() => new ChecklistTracker([a, b])).toThrow(/identical options/);
  });

  it('rejects an action requiring a node no library tree defines (typo trap — it would gate forever)', () => {
    const bad: QuestionTreeDef = {
      tree_id: 'bad',
      description: '',
      nodes: [
        { node_id: 'act', type: 'action', tool: 't', description: '', requires: ['no_such_node'] },
      ],
    };
    expect(() => new ChecklistTracker([bad])).toThrow(/unknown node "no_such_node"/);
  });
});

// ── Selection (the purpose accumulator) ──────────────────────────────────────

describe('tree selection', () => {
  it('throws on an unknown tree, naming what IS available', () => {
    const t = make();
    expect(() => t.select(['wedding'])).toThrow(UnknownTreeError);
    expect(() => t.select(['wedding'])).toThrow(/identity, job, message, booking/);
  });

  it('accumulates across calls and keeps collected state when a tree joins mid-call', () => {
    const t = make();
    t.select(['identity']);
    t.record('caller_name', { value: 'Mike' });
    // "oh, and can I also leave a message?" — message tree joins, name already ✓.
    const { added } = t.select(['message']);
    expect(added).toEqual(['message']);
    expect(t.status('caller_name')).toBe('answered');
    expect(t.frontier().map((f) => f.node_id)).not.toContain('caller_name');
  });

  it('BOOK FIRST: booking outranks other goal trees in the walk, whatever order selection came in', () => {
    // WHO: the ask order the model works top-down from renderState/frontier.
    // WHAT: identity first, booking second, intake trees after — host-enforced.
    // WHEN: 2026-07-21 live call — selection order [identity, job, booking]
    //       queued SIX role-intake questions ahead of the meeting; the caller
    //       had to protest "you never let me set up a meeting, you just blew
    //       right past that." The meeting is what they rang for.
    // WHY: no selection order the model chooses may put preparation before
    //      the thing it prepares.
    const t = make();
    t.select(['job']); // intake selected FIRST — the adversarial order
    t.select(['identity', 'booking']);
    const state = t.renderState();
    const pos = (needle: string) => state.indexOf(needle);
    // All three present…
    expect(pos('caller_name')).toBeGreaterThan(-1);
    expect(pos('book')).toBeGreaterThan(-1);
    expect(pos('callers_company')).toBeGreaterThan(-1);
    // …and ordered identity → booking → job, despite job being selected first.
    expect(pos('caller_name')).toBeLessThan(pos('book'));
    expect(pos('book')).toBeLessThan(pos('callers_company'));
  });

  it('re-selecting is a no-op that does not reset anything', () => {
    const t = make();
    t.select(['identity']);
    t.record('caller_name', { value: 'Mike' });
    expect(t.select(['identity']).added).toEqual([]);
    expect(t.value('caller_name')).toBe('Mike');
  });

  it('a node known to the library but not selected is not recordable', () => {
    const t = make();
    t.select(['job']);
    expect(() => t.record('caller_phone', { value: '5551119039' })).toThrow(UnknownNodeError);
  });
});

// ── Branching: activation and sibling-✗ ──────────────────────────────────────

describe('choice branching', () => {
  it('branch children are latent (not askable) until the choice is answered', () => {
    const t = make();
    t.select(['job']);
    expect(t.status('client_company')).toBe('latent');
    expect(t.frontier().map((f) => f.node_id)).toEqual([
      'caller_name',
      'callers_company',
      'job_type',
    ]);
  });

  it('answering a choice opens ITS branch and rules the sibling branches out — recursively', () => {
    const t = make();
    t.select(['job']);
    t.record('job_type', { value: 'contract' });
    expect(t.status('client_company')).toBe('open');
    expect(t.status('work_mode')).toBe('open');
    // Siblings and their descendants are ✗ — never asked, omitted from the prompt.
    expect(t.status('start_date')).toBe('not_applicable');
    expect(t.status('conversion_terms')).toBe('not_applicable');
    expect(t.renderState()).not.toContain('start_date');
  });

  it('a rejected value lists the legal options — the clarify mechanism', () => {
    const t = make();
    t.select(['job']);
    // Each id, each with its SPOKEN form. The bare-token list this used to
    // assert is what taught the model to say "answering_service" to a caller
    // on the 2026-08-15 sim, so the ids now travel with the words to use.
    expect(() => t.record('job_type', { value: 'kind of both' })).toThrow(
      /contract \(say "contract"\).*fulltime.*contract_to_hire \(say "contract to hire"\)/
    );
    expect(() => t.record('job_type', { value: 'kind of both' })).toThrow(
      /NEVER say one to the caller/
    );
  });

  it('the model fusing node_id onto the option (2026-08-19 live call) is accepted, not rejected', () => {
    // sim-call-1787158785189: the model recorded "hiring_for_own_company"
    // instead of "own_company" for the hiring_for choice — a caller-answered
    // question got asked TWICE because the host rejected a value the model
    // had every right to think was fine. Same shape reproduced on job_type.
    const t = make();
    t.select(['job']);
    expect(t.record('job_type', { value: 'job_type_contract' })).toBe('answered');
    expect(t.value('job_type')).toBe('contract'); // stored as the real option, not the fused form
  });

  it('a PARTIAL node_id fusion is accepted too (2026-09-09 live call)', () => {
    // SCL_A5wnBexPbwCC, 11:12 CT. Asked `hiring_for`, John Smith said "I'm hiring
    // for my own" and the model recorded "hiring_own_company" — ONE TOKEN short of
    // the `hiring_for_` prefix the 2026-08-19 repair strips, so it fell through,
    // the node stayed open, and he was asked the same question again. He answered
    // it a second time, word for word. A repair that catches only one spelling of
    // a mistake is a repair the caller still pays for.
    //
    // Same shape on this file's fixture node: job_type + "job_contract".
    const t = make();
    t.select(['job']);
    expect(t.record('job_type', { value: 'job_contract' })).toBe('answered');
    expect(t.value('job_type')).toBe('contract');
  });

  it("the leading words dropped must be the NODE_ID's own — not any words at all", () => {
    // The repair walks off leading tokens only while each one belongs to the
    // node_id. "contract" is a real option; "urgent_contract" is not a fusion of
    // anything, and accepting it would store an answer nobody gave.
    const t = make();
    t.select(['job']);
    expect(() => t.record('job_type', { value: 'urgent_contract' })).toThrow(RecordError);
  });

  it('a value that merely LOOKS prefixed but is not a real option still throws', () => {
    const t = make();
    t.select(['job']);
    expect(() => t.record('job_type', { value: 'job_type_freelance' })).toThrow(RecordError);
  });

  it('a value that shadows an Object.prototype key is rejected, not silently accepted', () => {
    // Copilot review on PR #347: `value in def.options` walks the prototype
    // chain, so "toString" in {} is true even though def.options never
    // declared it — a caller/model value of "toString" would have passed the
    // membership check and been stored as if it were a real, declared option.
    // Object.hasOwn fixes both the primary check and the prefix-strip check.
    const t = make();
    t.select(['job']);
    expect(() => t.record('job_type', { value: 'toString' })).toThrow(RecordError);
    expect(() => t.record('job_type', { value: 'job_type_toString' })).toThrow(RecordError);
    expect(() => t.record('job_type', { value: '__proto__' })).toThrow(RecordError);
  });

  it('recording a ruled-out node names the choice that ruled it out', () => {
    const t = make();
    t.select(['job']);
    t.record('job_type', { value: 'fulltime' });
    expect(() => t.record('client_company', { value: 'Apex' })).toThrow(RecordError);
    expect(() => t.record('client_company', { value: 'Apex' })).toThrow(/job_type/);
  });
});

// ── Out-of-order volunteering (the "downtown but all remote" case) ───────────

describe('out-of-order answers', () => {
  it('a volunteered answer for a not-yet-active node is HELD, then promoted when its branch opens', () => {
    const t = make();
    t.select(['job']);
    // "everyone's on Chicago time" before we even know it's a contract role
    t.record('timezone', { value: 'Central' });
    expect(t.status('timezone')).toBe('pending');
    expect(t.frontier().map((f) => f.node_id)).not.toContain('timezone');
    t.record('job_type', { value: 'contract' });
    t.record('work_mode', { value: 'remote' });
    // Promoted — answered without ever being asked.
    expect(t.status('timezone')).toBe('answered');
    expect(t.value('timezone')).toBe('Central');
  });

  it('a volunteered choice answer cascades the moment its own branch activates', () => {
    const t = make();
    t.select(['job']);
    // "we're all remote" volunteered before job_type is known
    t.record('work_mode', { value: 'remote' });
    expect(t.status('work_mode')).toBe('pending');
    t.record('job_type', { value: 'contract' });
    // work_mode promotes AND its branch logic applies immediately.
    expect(t.status('work_mode')).toBe('answered');
    expect(t.status('timezone')).toBe('open');
    expect(t.status('client_address')).toBe('not_applicable');
  });

  it('a held answer whose branch NEVER activates is discarded with the branch', () => {
    const t = make();
    t.select(['job']);
    t.record('timezone', { value: 'Central' });
    t.record('job_type', { value: 'fulltime' }); // work_mode dies → timezone dies
    expect(t.status('timezone')).toBe('not_applicable');
    expect(t.value('timezone')).toBeUndefined();
  });
});

// ── Mind-change (reopen + ghost discard) ─────────────────────────────────────

describe('mind-change', () => {
  it("re-recording a choice discards the dead branch's answers — no ghosts brief the owner", () => {
    const t = make();
    t.select(['job']);
    t.record('job_type', { value: 'contract' });
    t.record('client_company', { value: 'Initech' });
    // "actually, it's a full-time position"
    t.record('job_type', { value: 'fulltime' });
    expect(t.status('client_company')).toBe('not_applicable');
    expect(t.status('start_date')).toBe('open');
    // …and changing BACK re-asks fresh; the withdrawn answer stays gone.
    t.record('job_type', { value: 'contract' });
    expect(t.status('client_company')).toBe('open');
    expect(t.value('client_company')).toBeUndefined();
  });

  it('a node shared by the old AND new branch survives the change with its answer intact', () => {
    const t = make();
    t.select(['job']);
    t.record('job_type', { value: 'contract' });
    t.record('work_mode', { value: 'remote' });
    t.record('timezone', { value: 'Central' });
    // remote → hybrid: timezone is relevant on BOTH paths — it must not be re-asked.
    t.record('work_mode', { value: 'hybrid' });
    expect(t.status('timezone')).toBe('answered');
    expect(t.status('client_address')).toBe('open');
    // hybrid → onsite: NOW timezone is moot, and its value goes with it.
    t.record('work_mode', { value: 'onsite' });
    expect(t.status('timezone')).toBe('not_applicable');
    expect(t.value('timezone')).toBeUndefined();
  });
});

// ── Declined (asked, not available — resolved, distinct from ✗) ──────────────

describe('declined', () => {
  it('declining resolves a node without a value, and a later answer clears the decline', () => {
    const t = make();
    t.select(['identity']);
    t.record('caller_phone', { declined: true });
    expect(t.status('caller_phone')).toBe('declined');
    t.record('caller_phone', { value: '2624979039' });
    expect(t.status('caller_phone')).toBe('answered');
  });

  it('a declined CHOICE rules out every branch under it, so the call can still complete', () => {
    const t = make();
    t.select(['job']);
    t.record('caller_name', { value: 'Mike' });
    t.record('callers_company', { value: 'Apex Supply' });
    t.record('job_type', { declined: true });
    expect(t.status('client_company')).toBe('not_applicable');
    expect(t.status('start_date')).toBe('not_applicable');
    // declined SATISFIES the capture's requires (2026-07-21 call 3: three declines,
    // capture still landed) — the real tool enforces its own hard needs.
    expect(t.status('capture')).toBe('ready');
    t.completeAction('capture', 'ji_123');
    expect(t.isResolved()).toBe(true);
  });

  it('declined renders as resolved-do-not-re-ask, distinct from omission', () => {
    const t = make();
    t.select(['identity']);
    t.record('caller_phone', { declined: true });
    expect(t.renderState()).toContain('caller declined');
    expect(t.renderState()).toContain('do not re-ask');
  });
});

describe('required fields (decline does not resolve)', () => {
  const makeRequired = (): ChecklistTracker =>
    new ChecklistTracker(LIBRARY, { requiredNodeIds: ['caller_phone'] });

  it('refuses declined:true on a required node — status stays open', () => {
    const t = makeRequired();
    t.select(['identity']);
    t.record('caller_name', { value: 'Mike' });
    expect(() => t.record('caller_phone', { declined: true })).toThrow(RecordError);
    expect(() => t.record('caller_phone', { declined: true })).toThrow(/required/);
    expect(t.status('caller_phone')).toBe('open');
    expect(t.isResolved()).toBe(false);
  });

  it('an answer still resolves a required node', () => {
    const t = makeRequired();
    t.select(['identity']);
    t.record('caller_name', { value: 'Mike' });
    t.record('caller_phone', { value: '2624979039' });
    expect(t.status('caller_phone')).toBe('answered');
    expect(t.isResolved()).toBe(true);
  });

  it('nodes not marked required can still decline-close the call', () => {
    const t = makeRequired();
    t.select(['identity']);
    t.record('caller_name', { declined: true });
    t.record('caller_phone', { value: '2624979039' });
    expect(t.isResolved()).toBe(true);
  });
});

// ── Action nodes (real-tool completion only) ─────────────────────────────────

describe('action nodes', () => {
  it('blocked until requires resolve, then ready, then done ONLY via completeAction', () => {
    const t = make();
    t.select(['job']);
    expect(t.status('capture')).toBe('blocked');
    t.record('callers_company', { value: 'Apex Supply' });
    t.record('job_type', { value: 'fulltime' });
    expect(t.status('capture')).toBe('ready');
    t.completeAction('capture', 'ji_456');
    expect(t.status('capture')).toBe('done');
  });

  it('record_answer cannot complete an action — the model has no conversational path to done', () => {
    const t = make();
    t.select(['job']);
    expect(() => t.record('capture', { value: 'done' })).toThrow(/capture_job_inquiry/);
    expect(t.status('capture')).toBe('blocked');
  });

  it('an action can be declined (caller opts out), but never after its write landed', () => {
    const t = make();
    t.select(['booking', 'identity']);
    t.record('caller_name', { value: 'Mike' });
    t.record('caller_phone', { value: '2624979039' });
    t.record('book', { declined: true });
    expect(t.status('book')).toBe('declined');
    t.completeAction('book', 'appt_1'); // caller came back around; the write landed
    expect(t.status('book')).toBe('done');
    expect(() => t.record('book', { declined: true })).toThrow(/already DONE/);
  });

  it('requires pointing at nodes OUTSIDE the selected trees do not gate (the real tool enforces)', () => {
    const t = make();
    t.select(['booking']); // caller_name/caller_phone exist only in unselected identity
    expect(t.status('book')).toBe('ready');
  });
});

// ── Recording hygiene ────────────────────────────────────────────────────────

describe('recording hygiene', () => {
  it('rejects empty values — silence is not an answer', () => {
    const t = make();
    t.select(['identity']);
    expect(() => t.record('caller_name', { value: '   ' })).toThrow(RecordError);
  });

  it('caps runaway values at 500 chars', () => {
    const t = make();
    t.select(['message', 'identity']);
    t.record('message_body', { value: 'x'.repeat(600) });
    expect(t.value('message_body')).toHaveLength(500);
  });

  it('unknown node ids are rejected with a pointer back to the checklist', () => {
    const t = make();
    t.select(['identity']);
    expect(() => t.record('favourite_colour', { value: 'blue' })).toThrow(UnknownNodeError);
  });

  it('SAD→FIXED: the refusal NAMES the ids the model can actually use (2026-09-11 ONE-BREATH bug)', () => {
    // WHO: sim-questiontree ONE-BREATH — the caller volunteered company,
    //      full-time, senior QA, salary, hybrid, and an address in her FIRST
    //      sentence; the model invented plausible-looking ids for them
    //      (role_type, role_title, role_salary_range, role_location), none
    //      of which exist, the old refusal named no valid id, and the model
    //      RE-ASKED for everything the caller had already said — twice.
    // WHAT: the error message must list the checklist's current open ASK
    //       ids, so a wrong guess costs one silent retry, not the caller's
    //       patience.
    const t = make();
    t.select(['identity', 'job']);
    let message = '';
    try {
      t.record('role_type', { value: 'full_time' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('"role_type" is not on this call');
    expect(message).toContain('Open ids you may record now:');
    // caller_name is identity's first open node — a real id must appear.
    expect(message).toContain('caller_name');
  });

  it('a corrected answer overwrites — last record wins', () => {
    const t = make();
    t.select(['identity']);
    t.record('caller_phone', { value: '5551119039' });
    t.record('caller_phone', { value: '2624979039' }); // "no wait, use my cell"
    expect(t.value('caller_phone')).toBe('2624979039');
  });
});

// ── Merge / dedupe ───────────────────────────────────────────────────────────

describe('tree merging', () => {
  it('a shared node exists ONCE across selected trees — answered anywhere is answered everywhere', () => {
    const t = make();
    t.select(['identity', 'job', 'message']);
    const names = t.frontier().filter((f) => f.node_id === 'caller_name');
    expect(names).toHaveLength(1);
    t.record('caller_name', { value: 'Mike' });
    expect(Object.keys(t.snapshot()).filter((k) => k === 'caller_name')).toHaveLength(1);
    expect(t.status('caller_name')).toBe('answered');
  });
});

// ── renderState (what the model sees) ────────────────────────────────────────

describe('renderState', () => {
  it('shows ask/answered/latent-listen/held/action markers; omits ruled-out branches entirely', () => {
    const t = make();
    t.select(['job']);
    t.record('caller_name', { value: 'Mike' });
    t.record('timezone', { value: 'Central' }); // held — branch not active yet
    const s = t.renderState();
    expect(s).toContain('[✓] caller_name: Mike');
    expect(s).toContain('[ASK] callers_company');
    expect(s).toContain('[listen] client_company'); // latent: recordable, not askable
    expect(s).toContain('[held] timezone: Central');
    expect(s).toContain('[action later] capture');
    t.record('job_type', { value: 'fulltime' });
    const s2 = t.renderState();
    // The dead branch LEAVES the prompt — a question not in front of the model
    // cannot be asked (the toolPhases lesson, applied to questions).
    expect(s2).not.toContain('client_company');
    expect(s2).not.toContain('timezone');
    expect(s2).toContain('[ASK] start_date');
  });

  it('tells the model why a latent node exists without inviting the question', () => {
    const t = make();
    t.select(['job']);
    expect(t.renderState()).toMatch(/\[listen\] start_date[^\n]*only if job_type = fulltime/);
  });
});

// ── The goodbye gate ─────────────────────────────────────────────────────────

describe('isResolved (the goodbye gate)', () => {
  it('is false before any purpose is selected — finish_call cannot fire on the greeting', () => {
    expect(make().isResolved()).toBe(false);
  });

  it('holds the call open while anything is open, latent, pending, or an action is undone', () => {
    const t = make();
    t.select(['identity']);
    t.record('caller_name', { value: 'Mike' });
    expect(t.isResolved()).toBe(false); // caller_phone still open
    t.record('caller_phone', { value: '2624979039' });
    expect(t.isResolved()).toBe(true);
  });

  it('runs the whole Mike-from-Apex call end to end', () => {
    // "Hi, this is Mike from Apex Supply — we've got a contract role, everyone's remote."
    const t = make();
    t.select(['identity', 'job']);
    t.record('caller_name', { value: 'Mike' });
    t.record('callers_company', { value: 'Apex Supply' });
    t.record('job_type', { value: 'contract' });
    t.record('work_mode', { value: 'remote' });
    expect(t.isResolved()).toBe(false);
    t.record('caller_phone', { value: '2624979039' });
    t.record('client_company', { value: 'Initech' });
    t.record('timezone', { value: 'Central' });
    expect(t.status('capture')).toBe('ready');
    expect(t.isResolved()).toBe(false); // the write hasn't landed — talking can't end this
    t.completeAction('capture', 'ji_789');
    expect(t.isResolved()).toBe(true);
    expect(t.renderState()).toContain('CHECKLIST COMPLETE');
  });
});
