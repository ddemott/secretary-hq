/**
 * The property this rung exists to prove: THE BOOKING IS THE TRANSITION.
 *
 * A caller can talk all day; the task does not end. It ends the instant
 * book_with_scheduling returns an appointment_id, and there is no other exit — no
 * "finish booking" tool the model can call by mistake, and none it can SAY it called
 * without calling. That is the research's whole point (Pipecat: "routing lives on the
 * function"; LiveKit: complete() lives inside a tool), and it is the fix for the failure
 * we have chased all week — the model advancing the call with a sentence instead of a
 * tool.
 *
 * These tests do NOT need a real LLM or a real backend: they call the wrapped tool
 * directly, the way the model would, and check what the task does.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { llm, initializeLogger } from '@livekit/agents';
import { makeBookMeetingRung, BOOK_MEETING_INSTRUCTIONS } from './bookMeetingTask.js';
import { getTaskTool, getTaskToolNames } from './testToolCtx.js';
import type { ToolMap } from '../tools.js';

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

/** A stand-in book_with_scheduling whose return value the test controls. */
function fakeBookingTool(returns: unknown) {
  return llm.tool({
    description: 'book it',
    parameters: { type: 'object', properties: {} },
    execute: async () => returns,
  });
}

function schedulingTools(booking: ToolMap[string]): ToolMap {
  return {
    get_available_slots: llm.tool({
      description: 'slots',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    }),
    get_service_catalog: llm.tool({
      description: 'catalog',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    }),
    book_with_scheduling: booking,
  };
}

async function callBooking(
  task: ReturnType<typeof makeBookMeetingRung>,
  args: unknown = {}
): Promise<unknown> {
  const tool = getTaskTool(task, 'book_with_scheduling');
  return tool!.execute(args, { ctx: {}, toolCallId: 'tc' });
}

describe('BookMeetingTask — the booking IS the transition', () => {
  it('HAPPY: a booking that returns an appointment_id ends the task', async () => {
    const onBooked = vi.fn();
    const booking = fakeBookingTool(
      JSON.stringify({ success: true, appointment_id: 'appt-123', booked_time: '3:30 PM' })
    );
    const task = makeBookMeetingRung({
      schedulingTools: schedulingTools(booking),
      requestedService: 'a meeting about a contract',
      onBooked,
    });

    expect(task.done).toBe(false);
    await callBooking(task);

    expect(task.done, 'a real appointment_id ends the rung').toBe(true);
    expect(onBooked).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: 'appt-123' }));
  });

  it('SAD: a FAILED booking does NOT end the task — the caller has no meeting', async () => {
    // WHY: the safe direction. A slot-taken error, a validation failure — none of those
    //      are a booking, and the task must stay open so the model tries again. Ending
    //      here would drop the caller with nothing in the diary, which is the exact bug
    //      the whole structure exists to prevent.
    const booking = fakeBookingTool(
      JSON.stringify({
        error: 'Requested time slot is already booked',
        error_code: 'TIMESLOT_OCCUPIED',
      })
    );
    const task = makeBookMeetingRung({
      schedulingTools: schedulingTools(booking),
      requestedService: 'a meeting',
    });

    const relayed = await callBooking(task);
    expect(task.done, 'a failed booking is not a booking').toBe(false);
    // ...and the tool's own error is handed back so the model can relay it and retry.
    expect(String(relayed)).toContain('TIMESLOT_OCCUPIED');
  });

  it('SAD: an UNPARSEABLE result does not falsely complete', async () => {
    // WHY: a missed success just keeps the task trying; a FALSE success ends the rung
    //      with no meeting. When in doubt, stay open.
    const booking = fakeBookingTool('the booking system is having trouble right now');
    const task = makeBookMeetingRung({
      schedulingTools: schedulingTools(booking),
      requestedService: 'a meeting',
    });
    await callBooking(task);
    expect(task.done).toBe(false);
  });

  it('SAD: there is NO separate "finish" tool for the model to skip or fake', async () => {
    // THE POINT. The only tools are the real scheduling ones. The transition is welded to
    // book_with_scheduling — the model cannot end this rung by talking, and cannot end it
    // by claiming it booked. It has to actually book.
    const booking = fakeBookingTool(JSON.stringify({ appointment_id: 'x' }));
    const task = makeBookMeetingRung({
      schedulingTools: schedulingTools(booking),
      requestedService: 'a meeting',
    });
    const toolNames = getTaskToolNames(task);
    expect(toolNames).toContain('book_with_scheduling');
    expect(toolNames).not.toContain('finish');
    expect(toolNames).not.toContain('confirm_booking');
    expect(toolNames).not.toContain('done');
  });

  it('HAPPY: when a booking cannot happen, take_message RECORDS the message and ends the rung', async () => {
    // The 2026-07-16 dead-end: booking failed (no open times), the caller wanted a callback,
    // and the model said "I'll pass it along" with no tool behind it — nothing saved. The
    // take_message FALLBACK makes the save real: calling it completes the rung with a message.
    const onMessageTaken = vi.fn();
    const booking = fakeBookingTool(JSON.stringify({ error: 'NO_AVAILABILITY' }));
    const takeMessage = fakeBookingTool(JSON.stringify({ saved: true, message_id: 'msg-9' }));
    const task = makeBookMeetingRung({
      schedulingTools: schedulingTools(booking),
      requestedService: 'a meeting',
      knownName: 'Scott',
      takeMessage,
      onMessageTaken,
    });
    expect(getTaskToolNames(task)).toContain('take_message');
    expect(task.done).toBe(false);
    const tool = getTaskTool(task, 'take_message');
    await tool!.execute({ message: 'have him call me back' }, { ctx: {}, toolCallId: 'tc' });
    expect(task.done, 'a real message_id ends the rung').toBe(true);
    expect(onMessageTaken).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-9' }));
  });

  it('SAD: no take_message tool given → no fallback, booking is the only exit', () => {
    const booking = fakeBookingTool(JSON.stringify({ appointment_id: 'x' }));
    const task = makeBookMeetingRung({
      schedulingTools: schedulingTools(booking),
      requestedService: 'a meeting',
    });
    expect(getTaskToolNames(task)).not.toContain('take_message');
  });

  it('SAD: the fallback is ACTION-FIRST — call take_message, do not just promise it', () => {
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(/CALL take_message/);
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(/saves NOTHING/i);
  });

  it('SAD: it reuses the real scheduling tools — it does not reinvent booking', async () => {
    const booking = fakeBookingTool(JSON.stringify({ appointment_id: 'x' }));
    const task = makeBookMeetingRung({
      schedulingTools: schedulingTools(booking),
      requestedService: 'a meeting',
    });
    // get_available_slots / get_service_catalog pass straight through, unwrapped.
    expect(getTaskToolNames(task)).toContain('get_available_slots');
    expect(getTaskToolNames(task)).toContain('get_service_catalog');
  });

  it('SAD: the hard-won booking rules survive the move', async () => {
    // Each cost a real call. open_times not a range; wait for a real choice; do not
    // re-ask name/number; one job only.
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(/ONLY the times it returns in open_times/i);
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(/WAIT for them to CHOOSE/i);
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(/never take the first or last option/i);
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(/do NOT ask for them again/i);
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(/ONE job/i);
  });

  it('HAPPY: the rung LEADS with the soonest times — never "what day works for you?"', () => {
    // WHO: every booking caller who has not named a day.
    // WHAT: the instructions mandate options-first: call get_available_slots
    //        WITHOUT a date, read offer_times as one comma-paced sentence, and
    //        close with the invitation to name their own day or time.
    // WHEN: rung entry, before any day question.
    // WHERE: BOOK_MEETING_INSTRUCTIONS + the alreadyAsked injection; the
    //        route's no-date branch computes the offers (lead buffer,
    //        duration-stepped, cross-day).
    // WHY: Dale's design 2026-07-17 — "what day works for you?" is a question
    //       about a calendar the caller cannot see (the 2026-07-12 caller
    //       guessed impossibly three times and gave up). Options first, open
    //       question last.
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(/LEAD WITH TIMES/i);
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(/WITHOUT a date/);
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(/Those times are open\. Tell me which you prefer, or name another day/i);
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(
      /Never open the booking with "what day works for you\?"/i
    );
  });

  it('SAD: on a booking ERROR the caller re-chooses — the model never substitutes a time', () => {
    // WHO: the 2026-07-17 evening caller. She said "give me the first one"
    //       (1:00); the slot had been taken (pre-fix, the availability list
    //       even offered it); book_with_scheduling refused TIMESLOT_OCCUPIED —
    //       and the model silently rebooked 2:45 and announced it as done.
    // WHAT: the instructions pin the renegotiation contract: say what
    //        happened, offer the remaining times, WAIT for a new choice. The
    //        time booked must always be one the caller said yes to.
    // WHEN: any booking-tool error mid-rung — post-#281 that is a genuine
    //        two-caller race, which a sim cannot stage deterministically, so
    //        the instruction text IS the honest test layer.
    // WHERE: BOOK_MEETING_INSTRUCTIONS (rung); prompt.ts carries the same
    //        rule in the ladder's TIMESLOT_OCCUPIED translation.
    // WHY: a caller who asked for one time and was told "you're booked" at
    //       another never agreed to the appointment on the calendar — quiet
    //       substitution is a consent bug, not a UX nit.
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(/TIMESLOT_OCCUPIED/);
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(/choosing the replacement is THEIRS/i);
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(/WAIT for them to pick again/i);
    expect(BOOK_MEETING_INSTRUCTIONS).toMatch(/one the caller said yes to/i);
  });
});

function fakeTakeMessage() {
  return llm.tool({
    description: 'take message',
    parameters: { type: 'object', properties: {} },
    execute: async () => JSON.stringify({ saved: true, message_id: 'm-1' }),
  });
}

describe('HARD-DOWN gate: persistent booking failure redirects to take_message via the tool result', () => {
  // WHO: the 2026-07-19 failure-injection sim — booking write down, availability
  //       healthy, model death-marched four days deep re-offering times.
  // WHAT: after 2 consecutive failures the tool RESULT tells the model the SYSTEM is
  //       broken and to call take_message. Code detects what instructions cannot.
  function bookToolReturning(results: string[]) {
    let i = 0;
    return llm.tool({
      description: 'book',
      parameters: { type: 'object', properties: {} },
      execute: async () => results[Math.min(i++, results.length - 1)],
    });
  }
  async function callBook(task: unknown, n: number): Promise<string[]> {
    const tool = getTaskTool(task as { toolCtx: unknown }, 'book_with_scheduling') as {
      execute: (a: unknown, o: unknown) => Promise<unknown>;
    };
    const out: string[] = [];
    for (let k = 0; k < n; k++)
      out.push(String(await tool.execute({}, { ctx: {}, toolCallId: 't' + k })));
    return out;
  }

  it('SAD: two consecutive failures flip the result to BOOKING SYSTEM DOWN (REAL shape: {error, error_code}, no success field)', async () => {
    // The formatter emits {"error", "error_code"} on failure — no success:false.
    // Review on #290: a gate that only matched success:false never fired in prod.
    const task = makeBookMeetingRung({
      schedulingTools: {
        book_with_scheduling: bookToolReturning([
          JSON.stringify({ error: 'That time was just taken.', error_code: 'TIMESLOT_OCCUPIED' }),
          JSON.stringify({ error: 'That time was just taken.', error_code: 'TIMESLOT_OCCUPIED' }),
        ]),
      },
      requestedService: 'a meeting',
      takeMessage: fakeTakeMessage(),
    });
    const [first, second] = await callBook(task, 2);
    expect(first).toContain('TIMESLOT_OCCUPIED'); // first failure passes through untouched
    expect(first).not.toContain('BOOKING SYSTEM DOWN');
    expect(second).toContain('BOOKING SYSTEM DOWN');
    expect(second).toContain('take_message');
  });

  it('SAD: the legacy {success:false} shape still counts', async () => {
    const task = makeBookMeetingRung({
      schedulingTools: {
        book_with_scheduling: bookToolReturning([
          JSON.stringify({ success: false, error: 'nope' }),
          JSON.stringify({ success: false, error: 'nope' }),
        ]),
      },
      requestedService: 'a meeting',
      takeMessage: fakeTakeMessage(),
    });
    const out = await callBook(task, 2);
    expect(out[1]).toContain('BOOKING SYSTEM DOWN');
  });

  it('HAPPY: success shapes never count — raw-string results and success:true both reset/skip', async () => {
    const task = makeBookMeetingRung({
      schedulingTools: {
        book_with_scheduling: bookToolReturning([
          'Booked with Dale for 2:30 PM.', // raw string success (legacy formatter path)
          JSON.stringify({ error: 'x', error_code: 'TIMESLOT_OCCUPIED' }),
          JSON.stringify({ success: true, appointment_id: 'a-2' }),
          JSON.stringify({ error: 'x', error_code: 'TIMESLOT_OCCUPIED' }),
        ]),
      },
      requestedService: 'a meeting',
      takeMessage: fakeTakeMessage(),
    });
    const out = await callBook(task, 4);
    expect(out[1]).not.toContain('BOOKING SYSTEM DOWN'); // failure #1 (raw string did not count)
    expect(out[3]).not.toContain('BOOKING SYSTEM DOWN'); // success:true reset the streak
  });

  it('HAPPY: a success RESETS the counter — flaky-but-recoverable never forces a message', async () => {
    const task = makeBookMeetingRung({
      schedulingTools: {
        book_with_scheduling: bookToolReturning([
          JSON.stringify({ error: 'taken', error_code: 'TIMESLOT_OCCUPIED' }),
          JSON.stringify({ success: true, result: { appointment_id: 'a-1' } }),
          JSON.stringify({ error: 'taken', error_code: 'TIMESLOT_OCCUPIED' }),
        ]),
      },
      requestedService: 'a meeting',
      takeMessage: fakeTakeMessage(),
    });
    const out = await callBook(task, 3);
    expect(out[2]).not.toContain('BOOKING SYSTEM DOWN'); // failure #1 of a NEW streak
  });
});
