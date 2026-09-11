/**
 * The PLATFORM TREE LIBRARY — question-tree phase 2
 * (docs/QUESTION_TREE_ARCHITECTURE.md §4.2).
 *
 * WHO: the real tree definitions every call will run on.
 * WHAT: the library constructs through the REAL tracker (structural validity is
 *       CI, not a mid-call discovery), the ported intent boundaries are present,
 *       and the flagship journeys work on the REAL data — not fixtures.
 * WHY: phase 1 proved the machine on fixtures; a typo in the LIVE trees would
 *      pass those tests and still break every call. This file pins the data.
 */
import { describe, expect, it } from 'vitest';
import { ChecklistTracker } from './tracker.js';
import { buildChecklistPrompt } from './checklistAgent.js';
import type { ChoiceNodeDef } from './types.js';
import {
  BOOKING_TREE,
  BUY_SERVICE_TREE,
  FIX_COMPUTER_TREE,
  IDENTITY_TREE,
  JOB_TREE,
  MESSAGE_TREE,
  PLATFORM_TREE_LIBRARY,
  QA_TREE,
} from './trees.js';

const make = (): ChecklistTracker => new ChecklistTracker(PLATFORM_TREE_LIBRARY);

describe('library integrity', () => {
  it('the whole platform library constructs through the real tracker', () => {
    // TreeDefinitionError here = a malformed LIVE tree. This one line is the
    // reason the trees are typed TS validated in CI instead of loose JSON.
    expect(() => make()).not.toThrow();
  });

  it('every tree has a selector-facing description and a non-empty node list', () => {
    for (const tree of PLATFORM_TREE_LIBRARY) {
      expect(tree.description.length, tree.tree_id).toBeGreaterThan(40);
      expect(tree.nodes.length, tree.tree_id).toBeGreaterThan(0);
    }
  });

  it('carries the PR #288 intent boundary in both directions', () => {
    // "fix my computer" must never route to the job tree — the boundary lives
    // in the descriptions the purpose selector reads.
    expect(JOB_TREE.description).toMatch(/NOT a caller asking the business to do work/i);
    expect(FIX_COMPUTER_TREE.description).toMatch(/never the job tree/i);
  });

  it('hire-intake selector copy names position and contract as job, not a plain message', () => {
    // WHO: 2026-08-13 browser call — "a position I had for him that's in Chicago"
    //      selected identity+message. Owner got a one-line note, zero job row.
    // WHAT: the purpose selector reads these descriptions, not the code comments.
    // WHY: "position" and "contract" must be first-class peers of job/role, or
    //      the model files a recruiter opener as take_message again.
    expect(JOB_TREE.description).toMatch(/job, role, position, contract/i);
    expect(JOB_TREE.description).toMatch(/\bposition\b/i);
    expect(JOB_TREE.description).toMatch(/\bcontract\b/i);
    expect(JOB_TREE.description).toMatch(/I have a position/i);
    expect(MESSAGE_TREE.description).toMatch(/role, position/i);
    expect(MESSAGE_TREE.description).toMatch(/\bcontract\b/i);
    expect(MESSAGE_TREE.description).toMatch(/I have a position \/ contract for him/i);
  });

  it('talk-to / meeting about a job is two goals: job AND booking', () => {
    // WHO: same call said "talk to y'all about a position" — no booking tree.
    // WHAT: job tree + booking tree descriptions the selector reads.
    // WHY: "meeting" / "talk to" must trip a real calendar write, not a message.
    expect(JOB_TREE.description).toMatch(/TALK TO \/ speak with \/ meet/i);
    expect(JOB_TREE.description).toMatch(/job AND\s+booking|select job AND booking/i);
    expect(BOOKING_TREE.description).toMatch(/meeting/i);
    expect(BOOKING_TREE.description).toMatch(/even mentioned in passing/i);
  });

  it('identity ask text carries the 2026-07-21 phone rules (ask plainly; record first, read back once)', () => {
    // The read-back protocol moved host-side that same day (the double-read-back
    // fix): the NODE now forbids the pre-read and defers to the recording
    // result's directive — which is where the 3-3-4 string lives now
    // (readbackDirective, pinned in checklistTools.test.ts).
    const phone = IDENTITY_TREE.nodes.find((n) => n.node_id === 'caller_phone');
    const ask = phone && 'ask' in phone ? phone.ask : '';
    expect(ask).toMatch(/NEVER tell the caller how to say it/i);
    expect(ask).toMatch(/record_answer it IMMEDIATELY/);
    expect(ask).toMatch(/do NOT read it back first/i);
    expect(ask).toMatch(/one read-back, one yes/i);
  });

  it('the prompt carries THE ELSE — nothing fits → take a message for the owner (Dale, 2026-07-21)', () => {
    // "If you can't find a tool, the ELSE statement: leave a message for the
    // owner." The question-tree heir of the ladder's universal RUNG 4: no call
    // may end empty-handed — a saved message is the floor, not a failure.
    // SCOPED 2026-07-22: THE ELSE now applies only when the caller wants
    // something FROM THIS business — a wrong-number/"is this X?" caller is the
    // exception and gets no speculative message (which used to jam the goodbye
    // gate). So the phrase is no longer the unconditional "ALWAYS a message".
    const prompt = buildChecklistPrompt({
      persona: 'You are Chris, the AI receptionist for Thinking Hammer.',
      runtime: {
        currentDate: 'Tuesday, July 21, 2026',
        currentTime: '3:00 PM',
        timezone: 'America/Chicago',
        businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
        bookableThrough: 'Friday, August 15, 2026',
      },
      library: PLATFORM_TREE_LIBRARY,
    });
    // \s+ between words — the prompt template hard-wraps lines, so a phrase can
    // split across a newline + indent.
    expect(prompt).toMatch(/THE ELSE/);
    expect(prompt).toMatch(/a\s+message\s+for\s+the\s+owner/i);
    expect(prompt).toMatch(/Never\s+end\s+a\s+call\s+empty-handed/i);
    // The scoping is load-bearing — THE ELSE fires only for a caller who wants
    // something FROM THIS business, not a wrong-number identity question.
    expect(prompt).toMatch(/wants something FROM THIS business/i);
  });

  it('every tree is selectable by id, alone and together', () => {
    const t = make();
    t.select(PLATFORM_TREE_LIBRARY.map((tree) => tree.tree_id));
    expect(t.selectedTrees()).toHaveLength(PLATFORM_TREE_LIBRARY.length);
  });
});

describe('the job call (identity + job on the real trees)', () => {
  it('runs the placing-with-a-client journey end to end', () => {
    const t = make();
    t.select(['identity', 'job']);
    // "Hi, this is Mike from Apex Staffing — we've got a contract role with a
    // client of ours, everyone's remote."  One breath, five records.
    t.record('caller_name', { value: 'Mike' });
    t.record('callers_company', { value: 'Apex Staffing' });
    t.record('hiring_for', { value: 'placing_with_client' });
    t.record('employment_type', { value: 'contract' });
    t.record('work_mode', { value: 'remote' });
    // The two-companies rule holds: the client is a SEPARATE open question…
    expect(t.status('client_company')).toBe('open');
    // …and the wrong-branch questions never exist.
    expect(t.status('salary_range')).toBe('not_applicable');
    expect(t.status('position_address')).toBe('not_applicable');
    expect(t.status('team_timezone')).toBe('open');
    t.record('client_company', { value: 'Northern Trust' });
    t.record('role_description', { value: 'senior Java developer' });
    t.record('rate_range', { value: '65 to 82 an hour' });
    t.record('contract_length', { value: 'six months' });
    t.record('team_timezone', { value: 'Central' });
    t.record('caller_phone', { value: '2624979039' });
    // The offer is part of the intake now — capture's await_tree holds until it
    // is answered (offered once, either door).
    t.record('meeting_offer', { value: 'details_only' });
    expect(t.status('capture')).toBe('ready');
    expect(t.isResolved()).toBe(false); // talking cannot finish the intake
    t.completeAction('capture', 'ji_1');
    expect(t.isResolved()).toBe(true);
  });

  it('hiring for their own company never asks which company the work is for', () => {
    const t = make();
    t.select(['identity', 'job']);
    t.record('hiring_for', { value: 'own_company' });
    // client_company must not exist anywhere the model can see.
    expect(t.status('client_company')).toBe('not_applicable');
    expect(t.renderState()).not.toContain('client_company');
  });

  it('uses plain job and calendar wording instead of team timezone / diary wording', () => {
    const workMode = JOB_TREE.nodes.find((n) => n.node_id === 'work_mode') as
      ChoiceNodeDef | undefined;
    const timezone = workMode?.options.remote.find((n) => n.node_id === 'team_timezone');
    const offer = JOB_TREE.nodes.find((n) => n.node_id === 'meeting_offer');
    const timezoneAsk = timezone && 'ask' in timezone ? timezone.ask : '';
    const offerAsk = offer && 'ask' in offer ? offer.ask : '';
    expect(timezoneAsk).toContain('what time zone is the job in?');
    expect(timezoneAsk).not.toMatch(/team/i);
    expect(offerAsk).toContain('meeting');
    expect(offerAsk).toContain('calendar');
    expect(offerAsk).not.toMatch(/diary/i);
  });

  it('an early "it pays 65 to 80" survives whichever paid branch is chosen', () => {
    const t = make();
    t.select(['identity', 'job']);
    t.record('rate_range', { value: '65 to 80' }); // volunteered pre-fork
    expect(t.status('rate_range')).toBe('pending');
    t.record('employment_type', { value: 'contract_to_hire' });
    expect(t.status('rate_range')).toBe('answered'); // shared node, promoted
    // …but a full_time answer discards it with the branch.
    t.record('employment_type', { value: 'full_time' });
    expect(t.status('rate_range')).toBe('not_applicable');
    expect(t.status('salary_range')).toBe('open');
  });

  it('three declined questions still leave the capture reachable (2026-07-21 call 3)', () => {
    const t = make();
    t.select(['identity', 'job']);
    t.record('caller_name', { value: 'Camille' });
    t.record('caller_phone', { value: '2624979039' });
    t.record('callers_company', { value: 'TalentBridge' });
    t.record('hiring_for', { value: 'own_company' });
    t.record('role_description', { value: 'IT support role' });
    t.record('employment_type', { value: 'contract' });
    t.record('rate_range', { declined: true });
    t.record('contract_length', { declined: true });
    t.record('work_mode', { declined: true });
    // A declined offer resolves it too — no answer is ever forced.
    t.record('meeting_offer', { declined: true });
    expect(t.status('capture')).toBe('ready');
    t.completeAction('capture', 'ji_2');
    expect(t.isResolved()).toBe(true);
  });
});

describe('composition (trees stacking on one call)', () => {
  it('message about a wedding = message + generic_subject, name asked once', () => {
    const t = make();
    t.select(['identity', 'message', 'generic_subject']);
    expect(t.frontier().filter((f) => f.node_id === 'caller_name')).toHaveLength(1);
    t.record('caller_name', { value: 'Sue' });
    t.record('caller_phone', { value: '2624979039' });
    t.record('subject_details', { value: 'catering for a wedding in September' });
    t.record('message_body', { value: 'call Sue back about wedding catering' });
    expect(t.status('take_message_action')).toBe('ready');
    t.completeAction('take_message_action', 'msg_1');
    expect(t.isResolved()).toBe(true);
  });

  it('a repair call composes fix_computer + booking; the book action waits on identity', () => {
    const t = make();
    t.select(['identity', 'fix_computer', 'booking']);
    t.record('issue_description', { value: "laptop won't boot after an update" });
    t.record('meeting_topic', { value: 'computer repair drop-off' });
    expect(t.status('book')).toBe('blocked'); // no name/phone yet — cross-tree requires
    t.record('caller_name', { value: 'Pat' });
    t.record('caller_phone', { value: '2624979039' });
    // Identity satisfied — but the DROP-OFF STATEMENT hasn't been made: the
    // policy is stated BEFORE the visit is booked (Dale, 2026-07-21), so
    // drop_off_ok gates book on repair calls.
    expect(t.status('book')).toBe('blocked');
    t.record('drop_off_ok', { value: 'yes, dropping it off works' });
    expect(t.status('book')).toBe('ready');
  });

  it('a NON-repair booking never waits on drop_off_ok — absent ids are satisfied', () => {
    const t = make();
    t.select(['identity', 'booking']);
    t.record('caller_name', { value: 'Sue' });
    t.record('caller_phone', { value: '2624979039' });
    t.record('meeting_topic', { value: 'a job opportunity' });
    expect(t.status('book')).toBe('ready'); // drop_off_ok isn't on this call
  });

  it('mid-call purpose addition: booking joins with identity already satisfied', () => {
    const t = make();
    t.select(['identity', 'qa']);
    t.record('caller_name', { value: 'Sam' });
    t.record('caller_phone', { value: '2624979039' });
    t.record('qa_summary', { value: 'asked about experience with AI platforms' });
    expect(t.isResolved()).toBe(true);
    // "actually — can I grab some time with him?"
    t.select(['booking']);
    expect(t.isResolved()).toBe(false);
    expect(t.frontier().map((f) => f.node_id)).toEqual(['meeting_topic']);
  });
});

describe('schedule change (actions under branches)', () => {
  it('picking cancel makes cancel the ready action and reschedule nonexistent', () => {
    const t = make();
    t.select(['identity', 'schedule_change']);
    t.record('caller_phone', { value: '2624979039' });
    t.record('change_type', { value: 'cancel' });
    expect(t.status('cancel_action')).toBe('ready');
    expect(t.status('reschedule_action')).toBe('not_applicable');
    t.completeAction('cancel_action', 'appt_9');
    t.record('caller_name', { value: 'Lee' });
    expect(t.isResolved()).toBe(true);
  });
});

describe('deselect (the wrong-door escape)', () => {
  it('a misrouted tree can be removed without losing what the call already knows', () => {
    const t = make();
    // Routed to job by mistake — the caller wanted their computer fixed.
    t.select(['identity', 'job']);
    t.record('caller_name', { value: 'Pat' });
    t.deselect('job');
    t.select(['fix_computer', 'booking']);
    expect(t.selectedTrees()).toEqual(['identity', 'fix_computer', 'booking']);
    expect(t.value('caller_name')).toBe('Pat'); // the call keeps its facts
    expect(t.status('callers_company')).toBe('unselected'); // job questions gone
    // The goodbye gate now answers to the REAL goals only.
    expect(t.renderState()).not.toContain('callers_company');
  });

  it('deselecting the last tree closes the gate (no vacuous goodbye)', () => {
    const t = make();
    t.select(['qa']);
    t.deselect('qa');
    expect(t.isResolved()).toBe(false);
  });
});

describe('booking + message trees carry their own gates', () => {
  it('the booking write waits on name, phone, and the topic in their words', () => {
    const t = make();
    t.select(['identity', 'booking']);
    t.record('meeting_topic', { value: 'talk about a contract role' });
    t.record('caller_name', { value: 'Mike' });
    expect(t.status('book')).toBe('blocked'); // phone still open
    t.record('caller_phone', { value: '2624979039' });
    expect(t.status('book')).toBe('ready');
  });

  it('qa alone involves no identity questions (questions-only callers are never interrogated)', () => {
    const t = make();
    t.select(['qa']);
    const ids = t.frontier().map((f) => f.node_id);
    expect(ids).toEqual(['qa_summary']);
    expect(QA_TREE.nodes).toHaveLength(1);
  });

  it('message tree brings caller_name via the shared id, not a duplicate', () => {
    const t = make();
    t.select(['message']);
    t.record('caller_name', { value: 'Jo' });
    expect(t.status('caller_name')).toBe('answered');
    // Same node id the identity/booking trees use — one fact, one node.
    expect(MESSAGE_TREE.nodes.some((n) => n.node_id === 'caller_name')).toBe(true);
    expect(BOOKING_TREE.nodes.some((n) => n.node_id === 'caller_name')).toBe(false);
  });
});

describe('buy_service — the caller who wants to BUY the AI receptionist', () => {
  it('is in the library and asks what the owner needs to price and prepare', () => {
    // WHY: before this tree these callers fell to generic_subject + message —
    //      one vague "what does this concern?" — and the owner rang back knowing
    //      nothing about the business he was selling to.
    expect(PLATFORM_TREE_LIBRARY).toContain(BUY_SERVICE_TREE);
    const ids = BUY_SERVICE_TREE.nodes.map((n) => n.node_id);
    expect(ids).toEqual([
      'business_type',
      'call_volume',
      'wants_handled',
      'current_setup',
      'best_email',
      'demo_offer',
    ]);
  });

  it('SAD: has NO action node — an action it could not complete would trap the caller', () => {
    // WHY: the only fitting tool is attach_meeting_notes, which ERRORS when no
    //      meeting was booked. An action node that cannot complete never leaves
    //      'ready', isResolved() stays false, and finish_call refuses forever —
    //      the caller is stuck on a call that will not end. The write for a sales
    //      call is the DEMO BOOKING (or a message); this tree only qualifies.
    expect(BUY_SERVICE_TREE.nodes.every((n) => n.type !== 'action')).toBe(true);
  });

  it('resolves on its own once answered, so it never blocks the goodbye', () => {
    // WHY: the direct consequence of having no action — a qualified caller who
    //      declines both a demo and a message must still be able to hang up.
    const t = make();
    t.select(['buy_service']);
    t.record('business_type', { value: 'a two-chair barber shop' });
    t.record('call_volume', { value: 'maybe twenty a day' });
    t.record('wants_handled', { value: 'booking' });
    t.record('current_setup', { value: 'voicemail' });
    t.record('best_email', { value: 'sam@example.com' });
    expect(t.isResolved()).toBe(false); // the demo has not been offered yet
    t.record('demo_offer', { value: 'not_now' });
    expect(t.isResolved()).toBe(true);
  });

  it('only asks the cost follow-up when they already pay an answering service', () => {
    // WHY: the comparison the owner has to beat. Asking a voicemail user what
    //      their answering service costs is asking about a thing they do not have.
    const t = make();
    t.select(['buy_service']);
    t.record('current_setup', { value: 'voicemail' });
    expect(t.status('current_cost')).toBe('not_applicable');

    const t2 = make();
    t2.select(['buy_service']);
    t2.record('current_setup', { value: 'answering_service' });
    expect(t2.status('current_cost')).toBe('open');
  });

  it('HAPPY: a sales call composes buy_service + identity + booking for the demo', () => {
    // WHY: this is the whole point — the qualifying answers exist so the DEMO is
    //      prepared, and the appointment is what actually records the lead.
    const t = make();
    t.select(['identity', 'buy_service', 'booking']);
    t.record('business_type', { value: 'mobile dog grooming' });
    t.record('call_volume', { value: 'about 30' });
    t.record('wants_handled', { value: 'everything' });
    t.record('current_setup', { value: 'nothing' });
    t.record('best_email', { value: 'kim@example.com' });
    t.record('demo_offer', { value: 'wants_demo' });
    t.record('meeting_topic', { value: 'see a demo of the AI receptionist' });
    t.record('caller_name', { value: 'Kim' });
    expect(t.status('book')).toBe('blocked'); // phone still open
    t.record('caller_phone', { value: '6305550147' });
    expect(t.status('book')).toBe('ready');
    expect(t.isResolved()).toBe(false); // the booking must still land
  });

  it('SAD: buy_service and job are different callers and must not be confused', () => {
    // WHY: both are "business" calls about work and money. One wants to HIRE the
    //      owner (job — a role FOR him); the other wants to BUY his product. The
    //      boundary lives in the selector-facing descriptions, so pin it there.
    expect(BUY_SERVICE_TREE.description).toMatch(/their own business/i);
    expect(BUY_SERVICE_TREE.description).toMatch(/job.*tree|`job`/i);
    // No node id may collide with the job tree — a shared id would merge two
    // unrelated facts into one node when both are somehow selected.
    const jobIds = new Set(JOB_TREE.nodes.map((n) => n.node_id));
    for (const n of BUY_SERVICE_TREE.nodes) {
      expect(jobIds.has(n.node_id), `${n.node_id} collides with the job tree`).toBe(false);
    }
  });
});
