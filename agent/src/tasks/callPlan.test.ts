/**
 * WHERE COMPLETENESS ACTUALLY LIVES.
 *
 * The TaskGroup loop guarantees every REGISTERED task runs before the call can end. But
 * that guarantee is only as strong as the registration: a goal that never becomes a task
 * is a goal the loop never knows to enforce. So the failure we have chased all week — the
 * caller who books a meeting and hangs up with the job inquiry never taken — is, in this
 * architecture, prevented HERE, in the plan. If the plan is right, the loop makes it
 * impossible to skip. If the plan drops a goal, no loop can save it.
 *
 * planCallTasks is pure, so this is where the completeness is tested — no live call, no
 * LLM, no session. Goals in, the checklist out.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { llm, initializeLogger } from '@livekit/agents';
import { planCallTasks, buildCallTaskGroup, type CallDeps, type CallerGoals } from './callPlan.js';
import { getTaskToolNames } from './testToolCtx.js';
import type { SessionContext } from '../sessionContext.js';

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

function makeDeps(): CallDeps {
  const ctx: SessionContext = {
    tenantId: 't',
    callerPhone: null,
    callId: 'c',
    roomName: 'r',
    participantIdentity: 'p',
  };
  const tool = llm.tool({
    description: 'x',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
  });
  return {
    ctx,
    state: {},
    runtime: {
      currentDate: 'Wednesday, July 15, 2026',
      currentTime: '3:00 PM',
      timezone: 'America/Chicago',
      businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
      bookableThrough: '2027-01-08',
    },
    tools: {
      identify_caller: tool,
      book_with_scheduling: tool,
      get_available_slots: tool,
      get_service_catalog: tool,
      get_scheduling_options: tool, // the MESSY tool — must NOT reach the booking task
      book_appointment: tool, // bug #3 trap — must NOT reach the booking task
      check_availability: tool, // bug #3 trap
      capture_job_inquiry: tool,
      take_message: tool,
      get_company_policy_answer: tool,
      get_my_appointments: tool,
      cancel_appointment: tool,
      reschedule_appointment: tool,
      attach_meeting_notes: tool,
    },
  };
}

const ids = (goals: CallerGoals) => planCallTasks(goals, makeDeps()).map((s) => s.id);

describe('planCallTasks — the checklist the loop enforces', () => {
  it('SAD: a caller who wants a meeting AND has a job gets BOTH rungs — the bug that keeps biting', () => {
    // The 2026-07-14 call, made structural. "A meeting to talk about a job" is two goals;
    // in the ladder it was two rungs the model could skip, and did. Here it is two entries
    // on the stack, and the loop cannot reach its end with either one unpopped.
    const plan = ids({ wantsMeeting: true, hasJobInquiry: true });
    expect(plan).toContain('book_meeting');
    expect(plan).toContain('meeting_context'); // the job template rides rung 3
    expect(plan[0]).toBe('identity');
  });

  it('SAD: the ORDER is fixed — identity first, then the meeting, then its context', () => {
    // You cannot book on a caller you cannot name or reach, and the meeting is what they
    // rang for. A tenant does not get to reorder this, exactly as with the composed script
    // blocks: it is what the bad calls taught us, not a preference. Every booked meeting
    // now also gets the meeting-context rung (default template: one light notes question).
    const plan = ids({ wantsMeeting: true, hasJobInquiry: false });
    expect(plan).toEqual(['identity', 'book_meeting', 'meeting_context']);
  });

  it('HAPPY: identity is ALWAYS present, even with no stated goal', () => {
    // Identity is the floor under every goal, not a goal itself. A caller who wants
    // nothing bookable still has to be someone we can name.
    expect(ids({ wantsMeeting: false, hasJobInquiry: false })).toEqual(['identity']);
  });

  it('HAPPY: no meeting → no booking rung (we do not manufacture goals)', () => {
    const plan = ids({ wantsMeeting: false, hasJobInquiry: true });
    expect(plan).not.toContain('book_meeting');
  });

  it('SAD: every spec carries the id + description the loop and the out-of-scope tool need', () => {
    // A spec with a blank id or description would break the TaskGroup's bookkeeping
    // silently. Pin the shape.
    for (const spec of planCallTasks({ wantsMeeting: true, hasJobInquiry: true }, makeDeps())) {
      expect(spec.id, 'id must be non-empty').toBeTruthy();
      expect(spec.description.length, `${spec.id} needs a description`).toBeGreaterThan(5);
      expect(typeof spec.factory).toBe('function');
    }
  });

  it('SAD: the factory is LAZY — no agent is built until the loop pops the rung', () => {
    // WHY: building all tasks up front would attach every task's tools at once, which is
    //      the wide-toolset problem the phasing exists to avoid. The factory defers
    //      construction to the moment the rung runs.
    const spy = vi.fn();
    const deps = makeDeps();
    deps.onIdentified = spy;
    const plan = planCallTasks({ wantsMeeting: true, hasJobInquiry: false }, deps);
    // Planning built nothing.
    expect(spy).not.toHaveBeenCalled();
    // The specs are data; the agents do not exist yet.
    expect(plan.every((s) => typeof s.factory === 'function')).toBe(true);
  });

  it('SAD: BookMeetingTask gets ONLY the clean grid tools — not the messy one, not the traps', () => {
    // THE FIRST-CALL BUG. The whole point of tasks is narrow tools per rung, and I broke
    // it by passing the full toolbox: the model reached past get_available_slots (clean
    // 15-minute grid) for get_scheduling_options (raw "soonest-from-now" times — 1:41 PM,
    // drifting minute to minute, wandering to October). And book_appointment /
    // check_availability are the bug-#3 traps (need a resource_id get_available_slots
    // never returns). None of them may reach this task.
    const specs = planCallTasks({ wantsMeeting: true, hasJobInquiry: false }, makeDeps());
    const book = specs.find((s) => s.id === 'book_meeting')!;
    const names = getTaskToolNames(book.factory());
    expect(names).toContain('get_available_slots');
    expect(names).toContain('book_with_scheduling');
    expect(names).not.toContain('get_scheduling_options'); // the messy times
    expect(names).not.toContain('book_appointment'); // bug #3 trap
    expect(names).not.toContain('check_availability'); // bug #3 trap
  });

  it('SAD: the booking rung KNOWS what today is — it must not guess a month', () => {
    // THE FIRST LIVE-CALL BUG, from the logs not the transcript: a task with no date
    // context queried get_available_slots for OCTOBER, hit the "nothing that day" fallback
    // (raw soonest-from-now times like 1:41 PM), and every book_with_scheduling failed
    // EMPLOYEE_NOT_SCHEDULED. Each task REPLACES the system prompt — where the date and
    // hours live — with its own, so the runtime facts must be threaded in explicitly.
    const specs = planCallTasks({ wantsMeeting: true, hasJobInquiry: false }, makeDeps());
    const book = specs.find((s) => s.id === 'book_meeting')!;
    const instr = (book.factory() as unknown as { instructions: string }).instructions;
    expect(instr).toContain('July 15, 2026'); // today
    expect(instr).toMatch(/1:00 PM to 5:00 PM/); // hours
    expect(instr).toMatch(/resolve it against TODAY/i);
  });

  it('SAD: the job template gets only its LOAD-BEARING tools — nothing to wander into', () => {
    const specs = planCallTasks({ wantsMeeting: false, hasJobInquiry: true }, makeDeps());
    const intake = specs.find((s) => s.id === 'meeting_context')!;
    const names = getTaskToolNames(intake.factory());
    expect(names).toContain('capture_job_inquiry');
    // take_message joined 2026-07-18 as a COMPLETION (the mid-intake "just take a
    // message instead" fallback, mirroring the booking rung's) — load-bearing, so
    // rule 8 still holds: every tool here can END the rung.
    expect(names).toContain('take_message');
    expect(names).not.toContain('book_with_scheduling');
    expect(names).not.toContain('attach_meeting_notes'); // the job SUMMARY is stamped by the backend, not a second tool
  });

  it('HAPPY: a plain booked meeting gets the DEFAULT template — attach notes, or bow out silently', () => {
    // Rung 3 is MEETING GOALS, not "the job rung": with no role to brief, the template is
    // one light wrap-up question whose answer lands on the appointment. The factory runs
    // AFTER booking, so a booked meeting must exist in state for the real rung to build.
    const deps = makeDeps();
    const specs = planCallTasks({ wantsMeeting: true, hasJobInquiry: false }, deps);
    deps.state.appointmentId = 'appt-1'; // the booking rung's onBooked wrote this
    const notes = specs.find((s) => s.id === 'meeting_context')!;
    const names = getTaskToolNames(notes.factory());
    expect(names).toContain('attach_meeting_notes'); // the write
    expect(names).toContain('no_notes'); // the honest "nothing to add" exit
    expect(names).toContain('take_message'); // the fallback when attach cannot happen
    expect(names).not.toContain('capture_job_inquiry'); // wrong template
  });

  it('SAD: no meeting actually landed → the notes rung SKIPS in host code, before any turn', () => {
    // The booking rung fell back to a message: there is no appointment to note against,
    // and the caller must never be asked about a meeting that does not exist. The factory
    // reads state at pop time and returns a rung that completes on entry — no LLM, no audio.
    const deps = makeDeps();
    const specs = planCallTasks({ wantsMeeting: true, hasJobInquiry: false }, deps);
    // deps.state.appointmentId deliberately NOT set — nothing was booked.
    const notes = specs.find((s) => s.id === 'meeting_context')!;
    const rung = notes.factory();
    expect(rung.done).toBe(false);
    void (rung as unknown as { onEnter: () => Promise<void> }).onEnter();
    expect(rung.done).toBe(true);
  });

  it('SAD: the job opener tells the TRUTH about the booking — state decides, not the stated goal', () => {
    // A "meeting about a job" call whose booking fell back to a message books NOTHING —
    // the intake must not open with "you're booked in". The factory reads what actually
    // happened (state.appointmentId), not what was asked for (goals.wantsMeeting).
    const deps = makeDeps();
    const specs = planCallTasks({ wantsMeeting: true, hasJobInquiry: true }, deps);
    const intake = specs.find((s) => s.id === 'meeting_context')!;
    // No appointmentId in state → the no-booking opener.
    const unbooked = (intake.factory() as unknown as { instructions: string }).instructions;
    expect(unbooked).toContain('no meeting was booked');
    expect(unbooked).not.toContain('You have booked the meeting');
    // Booking landed → the booked opener.
    deps.state.appointmentId = 'appt-1';
    const booked = (intake.factory() as unknown as { instructions: string }).instructions;
    expect(booked).toContain('You have booked the meeting');
  });

  it('HAPPY: a caller who wants to cancel/reschedule gets the schedule_change rung', () => {
    // The manage goal becomes a registered rung, so the loop enforces it like any other.
    const plan = ids({ wantsMeeting: false, hasJobInquiry: false, wantsScheduleChange: true });
    expect(plan).toEqual(['identity', 'schedule_change']);
  });

  it('HAPPY: no schedule-change goal → no schedule_change rung', () => {
    // We never manufacture a manage step; a plain booking call must not get one.
    expect(ids({ wantsMeeting: true, hasJobInquiry: false })).not.toContain('schedule_change');
  });

  it('SAD: schedule_change gets the read + both mutations + the slot finder — and its escape hatch', () => {
    // A lookup-then-act rung: it must be able to SEE the appointments (get_my_appointments),
    // find a new time (get_available_slots), and MUTATE (cancel/reschedule). The third exit
    // no_appointment_change exists so a caller with nothing upcoming cannot hang the loop.
    const specs = planCallTasks(
      { wantsMeeting: false, hasJobInquiry: false, wantsScheduleChange: true },
      makeDeps()
    );
    const manage = specs.find((s) => s.id === 'schedule_change')!;
    const names = getTaskToolNames(manage.factory());
    expect(names).toContain('get_my_appointments');
    expect(names).toContain('get_available_slots');
    expect(names).toContain('cancel_appointment');
    expect(names).toContain('reschedule_appointment');
    expect(names).toContain('no_appointment_change'); // the "nothing to change" exit
    // and NOT a way to book a brand-new meeting — that is a different rung.
    expect(names).not.toContain('book_with_scheduling');
  });

  it('HAPPY: volunteered identity facts thread from state into the identity rung', () => {
    // The carrier is CallState (rule: rungs are separate agents; nothing spoken
    // before a rung exists reaches it except through state). begin_call writes
    // volunteeredName/Phone; the plan must hand them to the rung factory.
    const deps = makeDeps();
    deps.state.volunteeredName = 'Dale';
    deps.state.volunteeredPhone = '608-217-5303';
    const specs = planCallTasks({ wantsMeeting: true, hasJobInquiry: false }, deps);
    const identity = specs.find((s) => s.id === 'identity')!;
    const instr = (identity.factory() as unknown as { instructions: string }).instructions;
    expect(instr).toContain('ALREADY introduced themselves as Dale');
    expect(instr).toContain('ALREADY said their number: 608-217-5303');
  });

  it('HAPPY: a caller who wants to leave a message gets the take_message rung', () => {
    // The universal catch-all becomes a registered rung, so the loop enforces the
    // take_message WRITE — the exact fix for the ladder narrating "I've passed that along"
    // without ever calling the tool.
    const plan = ids({ wantsMeeting: false, hasJobInquiry: false, wantsToLeaveMessage: true });
    expect(plan).toEqual(['identity', 'take_message']);
  });

  it('HAPPY: no message goal → no take_message rung (we never manufacture it)', () => {
    expect(ids({ wantsMeeting: true, hasJobInquiry: false })).not.toContain('take_message');
  });

  it('SAD: take_message rung gets ONLY take_message — nothing to wander into', () => {
    // gotcha #3 / rule 8: a rung sees only its load-bearing tool. take_message IS the
    // completion, so the rung carries exactly that — no booking, no job intake to grab.
    const specs = planCallTasks(
      { wantsMeeting: false, hasJobInquiry: false, wantsToLeaveMessage: true },
      makeDeps()
    );
    const msg = specs.find((s) => s.id === 'take_message')!;
    const names = getTaskToolNames(msg.factory());
    expect(names).toContain('take_message');
    expect(names).not.toContain('book_with_scheduling');
    expect(names).not.toContain('capture_job_inquiry');
  });

  it('SAD: the FULL order is fixed — identity → book → meeting_context → take_message → schedule_change', () => {
    // Order is not a preference (BUILDING_SCRIPT_NOTES checklist #6). take_message is the
    // ELSE catch-all, so it sits after the vertical intake and before an existing-appointment
    // change — mirroring the composed-script block order.
    const plan = ids({
      wantsMeeting: true,
      hasJobInquiry: true,
      wantsToLeaveMessage: true,
      wantsScheduleChange: true,
    });
    expect(plan).toEqual([
      'identity',
      'book_meeting',
      'meeting_context',
      'take_message',
      'schedule_change',
    ]);
  });

  it('HAPPY: a questions-ONLY call gets policy_qa and SKIPS identity — the one exception', () => {
    // Decided 2026-07-16: a caller asking "when are you open?" must not be
    // interrogated for a name and number before getting an answer. Identity is the
    // floor under contact-needing goals; pure curiosity has none.
    const plan = ids({ wantsMeeting: false, hasJobInquiry: false, hasQuestions: true });
    expect(plan).toEqual(['policy_qa']);
  });

  it('SAD: questions + ANY contact-needing goal still runs identity, questions before booking', () => {
    // Mixed call: "what do you charge? and I'd like to book." Their questions come
    // before the booking (they cannot pick a time before hearing the price), and the
    // loop still cannot end with the meeting unbooked.
    const plan = ids({ wantsMeeting: true, hasJobInquiry: false, hasQuestions: true });
    expect(plan).toEqual(['identity', 'policy_qa', 'book_meeting', 'meeting_context']);
  });

  it('SAD: the Q&A rung gets retrieval + the message fallback — nothing else', () => {
    const specs = planCallTasks(
      { wantsMeeting: false, hasJobInquiry: false, hasQuestions: true },
      makeDeps()
    );
    const qa = specs.find((s) => s.id === 'policy_qa')!;
    const names = getTaskToolNames(qa.factory());
    expect(names).toEqual(['get_company_policy_answer', 'questions_answered', 'take_message']);
  });

  it('HAPPY: no questions goal → no policy_qa rung', () => {
    expect(ids({ wantsMeeting: true, hasJobInquiry: false })).not.toContain('policy_qa');
  });

  it('HAPPY: buildCallTaskGroup registers the plan onto a real TaskGroup', () => {
    // The loop is LiveKit's; this only checks the assembly does not throw and returns a
    // group. The guarantee (pops every task, completes only when empty) is LiveKit's own
    // host-code onEnter — verified by reading its source, not re-implemented here.
    const specs = planCallTasks({ wantsMeeting: true, hasJobInquiry: false }, makeDeps());
    const group = buildCallTaskGroup(specs);
    expect(group).toBeDefined();
    expect(typeof group.run).toBe('function');
  });
});

describe('LOOP-BACK rounds — identity is done ONCE (2026-07-18)', () => {
  it('HAPPY: a plan built with a filled state SKIPS the identity rung', () => {
    // WHO: round 2 of a call — the caller already gave and confirmed name +
    //       number in round 1; the shared CallState carries them.
    // WHAT: planCallTasks must not re-collect identity — that is gotcha H's
    //        original failure ("I'll need your name and the best phone
    //        number..." after everything was booked), now structurally
    //        impossible: no identity rung is even planned.
    // WHY: the anything-else loop-back (Dale, 2026-07-18) re-enters
    //       begin_call; the plan must respect what earlier rounds learned.
    const deps = makeDeps();
    deps.state.callerName = 'Chris Jensen';
    deps.state.callerPhone = '3126301234';
    const specs = planCallTasks(
      { wantsMeeting: false, hasJobInquiry: false, wantsToLeaveMessage: true },
      deps
    );
    expect(specs.map((s) => s.id)).not.toContain('identity');
    expect(specs.map((s) => s.id)).toContain('take_message');
  });

  it('SAD: a HALF-known caller (name but no number) still runs identity', () => {
    // A name without a confirmed number is not identity — the floor under a
    // contact-needing goal is BOTH.
    const deps = makeDeps();
    deps.state.callerName = 'Chris Jensen';
    const specs = planCallTasks({ wantsMeeting: true, hasJobInquiry: false }, deps);
    expect(specs.map((s) => s.id)).toContain('identity');
  });
});
