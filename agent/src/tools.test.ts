/**
 * Tests for the tool registry. Mocks ToolsClient at the constructor level
 * so tests exercise argument marshalling, context injection, and response
 * formatting without standing up a real HTTP client.
 *
 * These tests enforce the wire contract between the LLM and the backend —
 * if the backend expects `tenant_id` and we fail to inject it from
 * context, every tool call 400s at runtime. Critical coverage.
 */
import { describe, it, expect, vi } from 'vitest';
import { llm } from '@livekit/agents';
import { buildTools } from './tools.js';
import { CallOutcomeTracker } from './callOutcome.js';
import type { ToolsClient, ToolResponse } from './toolsClient.js';
import type { SessionContext } from './sessionContext.js';

const TENANT_ID = 'f234e471-0e60-4163-86c9-93cfd9338e3a';
const RESOURCE_ID = 'a1b2c3d4-e5f6-4789-ab12-cdef34567890';
const CALL_ID = 'sip-call-123';
const CALLER_PHONE = '+15551234567';

function makeClient(responses: Array<ToolResponse>) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const queue = [...responses];
  const client = {
    call: vi.fn(async (path: string, body: Record<string, unknown>) => {
      calls.push({ path, body });
      const next = queue.shift();
      if (!next) throw new Error('makeClient: no more responses queued');
      return next;
    }),
  } as unknown as ToolsClient;
  return { client, calls };
}

function makeCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    tenantId: TENANT_ID,
    callerPhone: CALLER_PHONE,
    callId: CALL_ID,
    roomName: 'sip-room-1',
    participantIdentity: 'sip_participant_1',
    ...overrides,
  };
}

// LiveKit's FunctionTool wraps the user-supplied execute in internal
// plumbing. To call .execute directly from tests we cast through the
// minimal runtime shape it expects.
async function exec(tool: unknown, args: unknown): Promise<string> {
  const fnTool = tool as {
    execute: (args: unknown, opts: unknown) => Promise<string>;
  };
  return fnTool.execute(args, { ctx: {}, toolCallId: 'test' });
}

describe('buildTools', () => {
  it('HAPPY: exposes exactly the 26 expected tool names', () => {
    // WHY: The system prompt in prompt.ts lists every tool by name. If
    //       these drift the LLM calls a name the router doesn't have
    //       and the call breaks. Pin the set.
    //
    // NOTE this is the FULL set the session is capable of — NOT what the model
    // sees on any given turn. Since 2026-07-14 the model only ever sees one
    // phase of it (toolPhases.ts): ~14 at intake, ~9 while booking. Handing it
    // all 25 at once is what made it hallucinate tool results. This assertion is
    // the inventory; toolPhases.test.ts asserts what is actually exposed.
    const tools = buildTools(makeCtx(), makeClient([]).client);
    expect(Object.keys(tools).sort()).toEqual(
      [
        'start_booking',
        'manage_appointment',
        'book_appointment',
        'book_with_scheduling',
        'cancel_appointment',
        'capture_job_inquiry',
        'check_availability',
        'find_caller_by_name',
        'get_available_slots',
        'get_company_policy_answer',
        'get_customer_context',
        'get_detailed_customer_history',
        'get_my_appointments',
        'get_scheduling_options',
        'get_service_catalog',
        'identify_caller',
        'page_owner_via_sms',
        'record_sms_consent',
        'reschedule_appointment',
        'save_customer_preference',
        'send_self_service_link',
        'send_verification_code',
        'take_message',
        'transfer_call',
        'verify_phone_code',
        // In NO toolPhases list on purpose: only the meeting-goals rung (task-group
        // path) holds it — the ladder has no wrap-up-notes step.
        'attach_meeting_notes',
      ].sort()
    );
  });

  it('HAPPY: capabilities filter returns only the selected groups (composability for other agents)', () => {
    // WHO: a customer agent (e.g. a message-only line) composing a subset.
    // WHAT: buildTools({capabilities}) returns only tools in those groups, so a
    //        simpler agent can reuse just RAG + message-taking.
    // WHY: the reuse contract — pick capabilities, not copy-paste the whole set.
    const tools = buildTools(makeCtx(), makeClient([]).client, undefined, undefined, undefined, {
      capabilities: ['knowledge', 'messaging'],
    });
    expect(Object.keys(tools).sort()).toEqual(
      [
        'capture_job_inquiry',
        'get_company_policy_answer',
        'page_owner_via_sms',
        'take_message',
      ].sort()
    );
  });

  it('SAD: without the sms capability, BOTH texting-the-caller tools are absent', () => {
    // WHO: every prod session today (ENABLE_SMS=false until 10DLC).
    // WHAT: send_self_service_link moved from 'scheduling' to 'sms'
    //        (2026-07-17) — filed under scheduling it ESCAPED the SMS gate, so
    //        a live agent could call it, get Telnyx's false "sent", and
    //        truthfully relay a text that would never arrive. It must vanish
    //        with record_sms_consent when sms is off.
    // WHY: "it cannot promise what it has no means to do" — the gate is only a
    //       gate if every tool that texts the CALLER is behind it.
    const tools = buildTools(makeCtx(), makeClient([]).client, undefined, undefined, undefined, {
      capabilities: ['identity', 'scheduling', 'messaging', 'knowledge', 'verification'],
    });
    expect(tools).not.toHaveProperty('send_self_service_link');
    expect(tools).not.toHaveProperty('record_sms_consent');
    // The live cancel/reschedule path survives.
    expect(tools).toHaveProperty('cancel_appointment');
    expect(tools).toHaveProperty('reschedule_appointment');
  });

  it('HAPPY: with the sms capability, send_self_service_link is present', () => {
    const tools = buildTools(makeCtx(), makeClient([]).client, undefined, undefined, undefined, {
      capabilities: ['scheduling', 'sms'],
    });
    expect(tools).toHaveProperty('send_self_service_link');
  });

  it('HAPPY: every tool has a non-empty description and is recognized as a FunctionTool', () => {
    // WHY: Empty descriptions ship tools the LLM won't know when to use.
    //       isFunctionTool guards against accidentally returning a
    //       non-tool value from buildTools (e.g., a plain object).
    const tools = buildTools(makeCtx(), makeClient([]).client);
    for (const [name, tool] of Object.entries(tools)) {
      expect(llm.isFunctionTool(tool), `${name} must be a FunctionTool`).toBe(true);
      const t = tool as unknown as { description: string };
      expect(t.description.length, `${name} description empty`).toBeGreaterThan(20);
    }
  });
});

describe('no-caller-ID fallback: transfer offer is capability-gated', () => {
  // WHO: a caller with blocked caller-ID asks to cancel/reschedule; the agent
  //       can't verify ownership so it falls back to "transfer or take a message".
  // WHAT: that fallback must only PROMISE a transfer when a live transfer can
  //        actually happen — the 'transfer' capability active AND a forward number
  //        configured. Otherwise it promises just a message.
  // WHERE: agent/src/tools.ts buildTools `canOfferTransfer` → the 3 fallbacks.
  // WHY: promising "I can transfer you" when transfer is unwired is a dead-end —
  //       transfer_call returns not_configured and the caller hears a broken offer.
  const noPhone = () => makeCtx({ callerPhone: null });
  const withForward = { forwardPhone: '+16085551234', execute: vi.fn() };
  const noForward = { forwardPhone: null, execute: vi.fn() };

  it('HAPPY: offers transfer when the transfer capability is active AND a forward number is set', async () => {
    const tools = buildTools(noPhone(), makeClient([]).client, withForward);
    const out = await exec(tools.get_my_appointments, {});
    expect(out).toContain('transfer or take a message');
  });

  it('SAD: offers ONLY a message when no forward number is configured', async () => {
    const tools = buildTools(noPhone(), makeClient([]).client, noForward);
    const out = await exec(tools.cancel_appointment, { appointment_id: 'x' });
    expect(out).toContain('take a message');
    expect(out).not.toContain('transfer');
  });

  it('SAD: offers ONLY a message when this call has no transfer wiring (execute is null)', async () => {
    // WHO: a call where createTransferExecutor returned null — the SIP participant
    //       never joined / no LiveKit context — so transfer_call can't run even
    //       though a forward number is configured.
    // WHY: promising a transfer here is a dead-end (transfer_call → "not available").
    const noExecutor = { forwardPhone: '+16085551234', execute: null };
    const tools = buildTools(noPhone(), makeClient([]).client, noExecutor);
    const out = await exec(tools.get_my_appointments, {});
    expect(out).toContain('take a message');
    expect(out).not.toContain('transfer');
  });

  it("SAD: offers ONLY a message when the 'transfer' capability is not in the active subset", async () => {
    // scheduling is active (so cancel/reschedule/get_my_appointments exist) but
    // transfer is not — the fallback must not promise a transfer.
    const tools = buildTools(noPhone(), makeClient([]).client, withForward, undefined, undefined, {
      capabilities: ['scheduling'],
    });
    const out = await exec(tools.reschedule_appointment, {
      appointment_id: 'x',
      new_start: '2026-07-15T16:00:00',
    });
    expect(out).toContain('take a message');
    expect(out).not.toContain('transfer');
  });
});

describe('formatResponse (never-empty guard)', () => {
  it('SAD: an ok response with an undefined result yields a non-empty string, never silence', async () => {
    // WHO: a tool whose backend returned { success:true } with no result field.
    // WHAT: formatResponse must not hand the LLM JSON.stringify(undefined) (the JS
    //        value `undefined`) — that gives the model nothing to relay → a silent
    //        turn. It returns a non-empty fallback instead.
    // WHERE: agent/src/tools.ts formatResponse, via any tool's execute().
    // WHY: never-silent contract — a success-with-no-payload must still speak.
    const { client } = makeClient([{ ok: true, result: undefined }]);
    const tools = buildTools(makeCtx(), client);
    const out = await exec(tools.get_service_catalog, {});
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('get_customer_context', () => {
  it('HAPPY: uses context caller phone (LLM never supplies it)', async () => {
    // WHO: Returning customer calls in, caller-ID intact
    // WHAT: Tool pulls phone from SessionContext, doesn't take it as
    //        an LLM-facing parameter. The backend expects `phone`.
    // WHY: The LLM doesn't know the phone; putting it in context
    //        removes an entire category of hallucination bugs
    const { client, calls } = makeClient([
      { ok: true, result: { name: 'Alice', history: 'Booked oil change' } },
    ]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.get_customer_context, {});

    expect(calls[0].path).toBe('/agent-tools/customer-context');
    expect(calls[0].body).toEqual({
      tenant_id: TENANT_ID,
      phone: CALLER_PHONE,
      // The number came from the CARRIER, so the server's disclosure gate has
      // nothing to prove. Derived from the NUMBER, not the session — see the
      // spoken case below, which is the same session with a different number.
      phone_source: 'caller_id',
      call_id: CALL_ID,
    });
  });

  it('HAPPY: looks up by the LLM-supplied spoken phone when provided', async () => {
    // WHO: Returning caller on a forwarded line — caller ID is the forwarding cell
    // WHAT: When the LLM passes a phone (the number the caller said), the lookup
    //        uses THAT number, not ctx.callerPhone, so repeat callers are
    //        recognized by their real number
    // WHY: Caller ID on a forwarded line is not the caller; the spoken number is
    const { client, calls } = makeClient([
      { ok: true, result: { name: 'Bob', history: 'Spoke last week' } },
    ]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.get_customer_context, { phone: '+16125559999' });

    expect(calls[0].body).toEqual({
      tenant_id: TENANT_ID,
      phone: '+16125559999',
      // 'spoken', NOT 'caller_id' — even though this session HAS a caller-ID.
      // The model handed us a DIFFERENT number, so the carrier never vouched for
      // it and the caller must prove possession before we disclose anything.
      // Trust is a property of the number, not of the call.
      phone_source: 'spoken',
      call_id: CALL_ID,
    });
  });

  it('HAPPY: anonymous caller, no spoken phone → short-circuits, no backend call', async () => {
    // WHO: Caller-ID blocked → context.callerPhone is null, no number collected yet
    // WHAT: Skip the backend call entirely and return the "new caller"
    //        string so the LLM moves on instead of waiting for an
    //        HTTP round trip that will also return "new caller"
    const { client, calls } = makeClient([]);
    const tools = buildTools(makeCtx({ callerPhone: null }), client);

    const result = await exec(tools.get_customer_context, {});

    expect(result).toContain('New caller');
    expect(calls).toHaveLength(0);
  });
});

describe('attach_meeting_notes — the FULFILLMENT GATE (2026-07-18 address curveball)', () => {
  // WHO: Dale's off-script live caller — "he needs to know my address". The
  //       model attached exactly that: a POINTER containing no address.
  // WHAT: a note that NAMES an address/number/code but carries no digit is
  //        bounced with the action the model can take (ask for the thing,
  //        attach the answer). Genuine values carry digits and pass.
  // WHY: the instruction-level judgment flaps (sim 2/2 then 1/2); this gate is
  //       the deterministic layer under it.
  const trackerWith = () => {
    const t = new CallOutcomeTracker();
    t.recordBooking('11111111-1111-4111-8111-111111111111');
    return t;
  };

  it('SAD: a pointer note ("he will need my address") is bounced, not attached', async () => {
    const { client, calls } = makeClient([]);
    const tools = buildTools(makeCtx(), client, undefined, trackerWith());
    const result = await exec(tools.attach_meeting_notes, {
      notes: "He'll need my address, since he's coming out to fix the computer.",
    });
    expect(result).toContain('does not CONTAIN one');
    expect(result).toContain('Ask the caller for the thing itself');
    expect(calls).toHaveLength(0); // nothing reached the backend
  });

  it('HAPPY: a note CONTAINING the address passes straight through', async () => {
    const { client, calls } = makeClient([
      { ok: true, result: { appointment_id: '11111111-1111-4111-8111-111111111111' } },
    ]);
    const tools = buildTools(makeCtx(), client, undefined, trackerWith());
    const result = await exec(tools.attach_meeting_notes, {
      notes: 'The address is 1060 West Addison Street in Chicago.',
    });
    expect(calls).toHaveLength(1);
    expect(String(result)).toContain('appointment_id');
  });

  it('HAPPY: a note with no address/number/code vocabulary is untouched by the gate', async () => {
    const { client, calls } = makeClient([
      { ok: true, result: { appointment_id: '11111111-1111-4111-8111-111111111111' } },
    ]);
    const tools = buildTools(makeCtx(), client, undefined, trackerWith());
    await exec(tools.attach_meeting_notes, {
      notes: 'Please use the back entrance; the dog is friendly.',
    });
    expect(calls).toHaveLength(1);
  });
});

describe('unsatisfiable-advice gates (2026-07-17 silent-call post-mortem)', () => {
  // WHO: the 2026-07-17 browser caller ("Ryan Seacrest", spoken number, no
  //       carrier caller-ID — the same shape as every forwarded-line call).
  // WHAT: two tool results handed the model advice it could not act on —
  //       "identify the caller first" when identify_caller had ALREADY
  //       succeeded, and "use send_verification_code" when the session held no
  //       such tool. The model retried the lookups until the per-turn tool-step
  //       cap ended the turn with no speech; the caller said "Hello?" twice and
  //       hung up.
  // WHY: an error message the model cannot act on is a loop generator. Every
  //       message must name a step that is possible on THIS call.

  it('SAD: history with no caller-ID but identity ESTABLISHED → points forward, never back at identify', async () => {
    const { client, calls } = makeClient([]);
    const tools = buildTools(makeCtx({ callerPhone: null, spokenPhone: '5551111212' }), client);

    const result = await exec(tools.get_detailed_customer_history, {});

    // Satisfiable, action-directing: proceed with what the caller said, and
    // stop re-calling the tool that cannot succeed on this line.
    expect(result).toContain('continue with their request');
    expect(result).toContain('do not call this tool again');
    expect(result).not.toContain('identify the caller first');
    expect(calls).toHaveLength(0);
  });

  it('SAD: history with no caller-ID and NOT yet identified → still directs to identify (satisfiable now)', async () => {
    const { client } = makeClient([]);
    const tools = buildTools(makeCtx({ callerPhone: null }), client);

    const result = await exec(tools.get_detailed_customer_history, {});

    // Before identify_caller has run, "identify first" is real, actionable
    // advice — only AFTER identity is established does it become a trap.
    expect(result).toContain('identify the caller first');
  });

  it('SAD: get_customer_context requires_verification advice is REWRITTEN when the session has no OTP tools', async () => {
    const { client } = makeClient([
      {
        ok: true,
        result: {
          requires_verification: true,
          message:
            'This number was given verbally and has not been verified on this call. Use send_verification_code, have the caller read the code back, then verify_phone_code before looking them up.',
        },
      },
    ]);
    const tools = buildTools(makeCtx(), client, undefined, undefined, undefined, {
      capabilities: ['identity', 'scheduling', 'messaging'],
    });

    const result = await exec(tools.get_customer_context, { phone: '+16125559999' });

    // GH #113: nothing may point at a tool the session does not hold — a tool
    // RESULT is a pointer just as much as a description is.
    expect(result).not.toContain('send_verification_code');
    expect(result).not.toContain('verify_phone_code');
    expect(result).toContain('treat the caller as NEW');
    // The flag survives so the description's "sms_consent is omitted when
    // requires_verification" contract still reads true.
    expect(JSON.parse(result).requires_verification).toBe(true);
  });

  it('HAPPY: requires_verification advice passes through UNCHANGED when the OTP tools exist', async () => {
    const backendMessage =
      'Use send_verification_code, have the caller read the code back, then verify_phone_code before looking them up.';
    const { client } = makeClient([
      { ok: true, result: { requires_verification: true, message: backendMessage } },
    ]);
    const tools = buildTools(makeCtx(), client, undefined, undefined, undefined, {
      capabilities: ['identity', 'verification'],
    });

    const result = await exec(tools.get_customer_context, { phone: '+16125559999' });

    // With the tools present the advice is satisfiable — relay it as-is.
    expect(result).toContain('send_verification_code');
  });

  it('SAD: identify_caller\'s "I\'ll text a 4-digit code" promise is rewritten when the session cannot text one', async () => {
    const { client } = makeClient([
      {
        ok: true,
        result: {
          saved: true,
          returning_customer: false,
          requires_verification: true,
          message:
            "Before I can pull up an account for that number, I need to verify it's yours — I'll text a 4-digit code for you to read back.",
        },
      },
    ]);
    const tools = buildTools(
      makeCtx({ callerPhone: null }),
      client,
      undefined,
      undefined,
      undefined,
      {
        capabilities: ['identity', 'scheduling'],
      }
    );

    const result = await exec(tools.identify_caller, {
      name: 'Ryan Seacrest',
      phone: '5551111212',
    });

    // The model relays messages verbatim — a promise to text must never reach
    // it on a session that cannot send one.
    expect(result).not.toContain('4-digit code');
    expect(result).toContain('treat the caller as NEW');
  });
});

describe('find_caller_by_name', () => {
  it('HAPPY: posts tenant_id + name, returns matches for confirmation', async () => {
    // WHO: Caller on the forwarded line who gives their name first
    // WHAT: Tool posts tenant_id (context) + name (LLM) to find-customer-by-name
    //        and surfaces the matches so __PERSONA_NAME__ can confirm the number on file
    // WHEN: Right after the caller states their name — caller ID is the
    //        forwarding cell, so name is the only trustworthy first identifier
    // WHERE: agent/src/tools.ts find_caller_by_name → /agent-tools/find-customer-by-name
    // WHY: Name-first identification is the whole point of this tool
    const { client, calls } = makeClient([
      { ok: true, result: { matches: [{ name: 'Jane Doe', phone: '+16125551234' }] } },
    ]);
    const tools = buildTools(makeCtx(), client);

    const result = await exec(tools.find_caller_by_name, { name: 'Jane Doe' });

    expect(calls[0].path).toBe('/agent-tools/find-customer-by-name');
    expect(calls[0].body).toEqual({ tenant_id: TENANT_ID, name: 'Jane Doe' });
    expect(result).toContain('Jane Doe');
  });

  it('HAPPY: empty match list relays cleanly so the LLM treats them as new', async () => {
    // WHO: First-time caller whose name is not in the CRM
    // WHAT: Backend returns an empty matches array; tool relays it
    // WHY: An empty list is the signal to create a new entry, not an error
    const { client, calls } = makeClient([{ ok: true, result: { matches: [] } }]);
    const tools = buildTools(makeCtx(), client);

    const result = await exec(tools.find_caller_by_name, { name: 'Nobody Known' });

    expect(calls).toHaveLength(1);
    expect(result).toContain('matches');
  });
});

describe('book_appointment', () => {
  it('HAPPY: injects tenant_id and call_id from context, forwards LLM args', async () => {
    // WHO: LLM found a slot and wants to book it
    // WHAT: tenant_id and call_id are from context, everything else is
    //        from the LLM arguments. This split is the ONLY thing
    //        separating us from "LLM hallucinates tenant_id" bugs.
    const { client, calls } = makeClient([
      { ok: true, result: { success: true, appointment_id: 'appt-1' } },
    ]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.book_appointment, {
      resource_id: RESOURCE_ID,
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
      phone: '+15559998888', // note: different from ctx.callerPhone — LLM may have an OTP-verified number
      name: 'Bob',
      description: 'Oil change',
    });

    expect(calls[0].body).toEqual({
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
      phone: '+15559998888',
      name: 'Bob',
      employee_id: undefined,
      description: 'Oil change',
      call_id: CALL_ID,
    });
  });

  it('HAPPY: default description when LLM omits one', async () => {
    // WHY: The backend requires a description field. If the LLM forgets
    //        it the tool must supply a sensible default rather than
    //        erroring out mid-call.
    const { client, calls } = makeClient([
      { ok: true, result: { success: true, appointment_id: 'appt-2' } },
    ]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.book_appointment, {
      resource_id: RESOURCE_ID,
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
      phone: '+15559998888',
    });

    expect(calls[0].body.description).toBe('Booking via SecretaryHQ');
  });

  it('GUARD: empty resource_id → redirects to book_with_scheduling, no backend call (prod bug #3)', async () => {
    // WHO: LLM ran get_available_slots (spoken times, NO resource_id), the
    //       caller picked one, and the LLM tries to book it here.
    // WHAT: book_appointment requires a resource_id that only
    //       get_scheduling_options returns. With an empty resource_id the tool
    //       must NOT hit the backend (would 400 / risk an invented id) — it
    //       returns a RESOURCE_ID_REQUIRED redirect so the LLM re-routes to
    //       book_with_scheduling. This is the exact prod dead-end (bug #3).
    const { client, calls } = makeClient([]); // no responses queued — asserting no call
    const tools = buildTools(makeCtx(), client);

    const result = await exec(tools.book_appointment, {
      resource_id: '   ',
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
      phone: '+15559998888',
    });

    expect(calls).toHaveLength(0);
    const parsed = JSON.parse(result);
    expect(parsed.error_code).toBe('RESOURCE_ID_REQUIRED');
    expect(parsed.error).toContain('book_with_scheduling');
  });

  it('SAD: backend error with error_code → tool returns JSON including the code', async () => {
    // WHY: The prompt has a translation table for error codes
    //        (TIMESLOT_OCCUPIED → "that time just got taken"). If the
    //        code doesn't surface in the tool's return value, the LLM
    //        can't translate.
    const { client } = makeClient([
      {
        ok: false,
        error: 'That time slot is already booked.',
        errorCode: 'TIMESLOT_OCCUPIED',
      },
    ]);
    const tools = buildTools(makeCtx(), client);

    const result = await exec(tools.book_appointment, {
      resource_id: RESOURCE_ID,
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
      phone: '+15559998888',
    });

    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('That time slot is already booked.');
    expect(parsed.error_code).toBe('TIMESLOT_OCCUPIED');
  });
});

describe('check_availability', () => {
  it('HAPPY: forwards tenant_id + args when a real resource_id is present', async () => {
    const { client, calls } = makeClient([{ ok: true, result: 'That resource is free.' }]);
    const tools = buildTools(makeCtx(), client);
    await exec(tools.check_availability, {
      resource_id: RESOURCE_ID,
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
    });
    expect(calls[0].path).toBe('/agent-tools/check-availability');
    expect(calls[0].body).toEqual({
      tenant_id: TENANT_ID,
      resource_id: RESOURCE_ID,
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
    });
  });

  it('GUARD: empty resource_id → redirects to book_with_scheduling, no backend call (prod bug #3)', async () => {
    // Same dead-end as book_appointment: check_availability needs a resource_id
    // that only get_scheduling_options returns. An empty one must short-circuit
    // to a RESOURCE_ID_REQUIRED redirect, never touching the backend.
    const { client, calls } = makeClient([]);
    const tools = buildTools(makeCtx(), client);
    const result = await exec(tools.check_availability, {
      resource_id: '',
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
    });
    expect(calls).toHaveLength(0);
    const parsed = JSON.parse(result);
    expect(parsed.error_code).toBe('RESOURCE_ID_REQUIRED');
    expect(parsed.error).toContain('book_with_scheduling');
  });
});

describe('CallOutcomeTracker wiring (call -> appointment link + outcome)', () => {
  // WHO: the booking/transfer tools recording what happened for session-end.
  // WHAT: a successful booking records outcome='booked' + the appointment_id;
  //        a successful transfer records 'transferred'; failures record nothing.
  // WHEN: during the call, read by the shutdown hook.
  // WHERE: buildTools 4th param -> tools.ts extractAppointmentId/recordBooking.
  // WHY: this is the exact link that was hardcoded null before — the harness
  //        (HTTP-only) can't prove the AGENT sends it, so it's pinned here.
  it('book_appointment success records outcome=booked + appointment_id', async () => {
    const tracker = new CallOutcomeTracker();
    const { client } = makeClient([
      { ok: true, result: { success: true, appointment_id: 'appt-xyz' } },
    ]);
    const tools = buildTools(makeCtx(), client, undefined, tracker);
    await exec(tools.book_appointment, {
      resource_id: RESOURCE_ID,
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
      phone: '+15559998888',
    });
    expect(tracker.result()).toEqual({ outcome: 'booked', appointmentId: 'appt-xyz' });
  });

  it('book_with_scheduling success records the appointment_id', async () => {
    const tracker = new CallOutcomeTracker();
    const { client } = makeClient([
      { ok: true, result: { success: true, appointment_id: 'appt-sched' } },
    ]);
    const tools = buildTools(makeCtx(), client, undefined, tracker);
    await exec(tools.book_with_scheduling, {
      service_type: 'Oil Change',
      window_from: '2026-05-01T13:00:00Z',
      window_to: '2026-05-08T13:00:00Z',
      phone: '+15559998888',
    });
    expect(tracker.result().appointmentId).toBe('appt-sched');
  });

  it('a failed booking records NOTHING (no appointment_id present)', async () => {
    const tracker = new CallOutcomeTracker();
    const { client } = makeClient([{ ok: false, error: 'taken', errorCode: 'TIMESLOT_OCCUPIED' }]);
    const tools = buildTools(makeCtx(), client, undefined, tracker);
    await exec(tools.book_appointment, {
      resource_id: RESOURCE_ID,
      start_time: '2026-05-01T14:00:00',
      end_time: '2026-05-01T15:00:00',
      phone: '+15559998888',
    });
    expect(tracker.result()).toEqual({ outcome: null, appointmentId: null });
  });

  it('a successful transfer records outcome=transferred', async () => {
    const tracker = new CallOutcomeTracker();
    const { client } = makeClient([]);
    const tools = buildTools(
      makeCtx(),
      client,
      { forwardPhone: '+16085551212', execute: async () => ({ ok: true }) },
      tracker
    );
    await exec(tools.transfer_call, {});
    expect(tracker.result()).toEqual({ outcome: 'transferred', appointmentId: null });
  });
});

describe('book_with_scheduling', () => {
  it('HAPPY: flattens LLM args into nested requirements + window shape', async () => {
    // WHY: The backend expects a nested body shape:
    //        `{ requirements: { serviceType, ... }, window: { from, to } }`
    //        but the LLM-facing arg schema is flat. This test pins the
    //        flatten-to-nest transformation.
    const { client, calls } = makeClient([
      { ok: true, result: { success: true, appointment_id: 'appt-3' } },
    ]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.book_with_scheduling, {
      service_type: 'Oil Change',
      required_employee_skills: ['oil_change'],
      required_resource_capabilities: ['oil'],
      window_from: '2026-05-01T14:00:00Z',
      window_to: '2026-05-01T16:00:00Z',
      phone: '+15559998888',
      name: 'Bob',
    });

    expect(calls[0].body).toMatchObject({
      tenant_id: TENANT_ID,
      phone: '+15559998888',
      name: 'Bob',
      requirements: {
        serviceType: 'Oil Change',
        requiredEmployeeSkills: ['oil_change'],
        requiredResourceCapabilities: ['oil'],
      },
      window: { from: '2026-05-01T14:00:00Z', to: '2026-05-01T16:00:00Z' },
    });
  });
});

describe('book_with_scheduling — confirm the ACTUAL booked time', () => {
  // WHO/WHY: prod bug — caller asked for 4:30, agent booked 4:00 (RPC takes the
  //   earliest open slot >= window_from) yet CONFIRMED "4:30" back, because the
  //   old formatter dumped raw JSON with no directive to read booked_start.
  //   These pin the formatBookingResponse contract: name the real slot, and flag
  //   a mismatch ONLY when the caller named a specific time (requested_start).

  const bookedResult = (overrides: Record<string, unknown> = {}) => ({
    ok: true as const,
    result: {
      success: true,
      appointment_id: 'appt-confirm',
      employee_name: 'Carlos',
      booked_start: '2026-07-15T16:00:00',
      booked_end: '2026-07-15T16:30:00',
      error_message: null,
      ...overrides,
    },
  });

  it('SPECIFIC time booked exactly as requested → confirms the real slot, no mismatch flag', async () => {
    const { client } = makeClient([
      bookedResult({ booked_start: '2026-07-15T16:30:00', booked_end: '2026-07-15T17:00:00' }),
    ]);
    const tools = buildTools(makeCtx(), client);
    const out = await exec(tools.book_with_scheduling, {
      service_type: 'Oil Change',
      window_from: '2026-07-15T16:30:00',
      window_to: '2026-07-15T17:00:00',
      requested_start: '2026-07-15T16:30:00',
      phone: '+15559998888',
    });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.booked_time).toBe('4:30 PM');
    expect(parsed.employee).toBe('Carlos');
    expect(parsed.time_changed).toBeUndefined();
    expect(String(parsed.instruction)).toContain('4:30 PM');
  });

  it('SUCCESS carries the STANDING FACT — the anti-double-booking anchor (2026-07-21 live regression)', async () => {
    // WHO: the model N turns after its own booking, deep in a long intake.
    // WHAT: every successful booking result must carry a standing_fact that
    //   (1) states an appointment now EXISTS, with its time and id,
    //   (2) forbids re-offering times / booking again,
    //   (3) forbids claiming nothing is booked,
    //   (4) carves out the one legitimate exception — the caller explicitly
    //       asking for an ADDITIONAL appointment.
    // WHEN: 2026-07-21 live call — booked 3:00 PM, ran intake, then told the
    //   caller "I haven't booked any meeting for you yet" (false), re-offered
    //   slots, and created a duplicate at 3:30 over her protest. The spoken
    //   confirmation had scrolled N turns back; nothing re-anchored the model.
    // WHERE: formatBookingResponse success payload — the tool result is the
    //   one line of context the model re-reads for the rest of the call.
    // WHY: a fact pinned in the tool result cannot be forgotten or argued with.
    const { client } = makeClient([
      bookedResult({ booked_start: '2026-07-15T16:30:00', booked_end: '2026-07-15T17:00:00' }),
    ]);
    const tools = buildTools(makeCtx(), client);
    const out = await exec(tools.book_with_scheduling, {
      service_type: 'Oil Change',
      window_from: '2026-07-15T16:30:00',
      window_to: '2026-07-15T17:00:00',
      requested_start: '2026-07-15T16:30:00',
      phone: '+15559998888',
    });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const fact = String(parsed.standing_fact);
    expect(fact).toContain('BOOKED APPOINTMENT');
    expect(fact).toContain('4:30 PM'); // the booked time, restated in the anchor
    expect(fact).toContain('appt-confirm'); // the id — provable, not vibes
    expect(fact).toMatch(/do NOT re-offer times/i);
    expect(fact).toMatch(/NEVER say nothing is booked/i);
    expect(fact).toMatch(/ADDITIONAL one/i); // the only sanctioned second booking
  });

  it('STANDING FACT survives the time-changed branch too', async () => {
    // The mismatch path rewrites `instruction` — the anchor must not be lost
    // with it (a changed-time booking is still a booking that must not double).
    const { client } = makeClient([bookedResult()]); // booked 4:00, asked 4:30
    const tools = buildTools(makeCtx(), client);
    const out = await exec(tools.book_with_scheduling, {
      service_type: 'Oil Change',
      window_from: '2026-07-15T16:30:00',
      window_to: '2026-07-15T17:00:00',
      requested_start: '2026-07-15T16:30:00',
      phone: '+15559998888',
    });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.time_changed).toBe(true);
    expect(String(parsed.standing_fact)).toContain('4:00 PM'); // anchored to the REAL slot
    expect(String(parsed.standing_fact)).toMatch(/NEVER say nothing is booked/i);
  });

  it('SPECIFIC time but booked EARLIER → flags the change + names the real time (prod bug)', async () => {
    // Caller asked 4:30; the only opening was 4:00. Must NOT parrot 4:30.
    const { client } = makeClient([bookedResult()]); // booked_start 4:00
    const tools = buildTools(makeCtx(), client);
    const out = await exec(tools.book_with_scheduling, {
      service_type: 'Oil Change',
      window_from: '2026-07-15T16:30:00',
      window_to: '2026-07-15T17:00:00',
      requested_start: '2026-07-15T16:30:00',
      phone: '+15559998888',
    });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.time_changed).toBe(true);
    expect(parsed.booked_time).toBe('4:00 PM');
    expect(parsed.requested_time).toBe('4:30 PM');
    expect(parsed.appointment_id).toBe('appt-confirm'); // preserved, not dropped
    const instruction = String(parsed.instruction);
    expect(instruction).toContain('4:00 PM'); // the actual slot
    expect(instruction).toContain('4:30 PM'); // what they asked
    expect(instruction).toMatch(/not open|wasn't open|NOT open/i);
  });

  it('NEXT-AVAILABLE (no requested_start) → NO mismatch flag even when slot != window bound', async () => {
    // REGRESSION GUARD: window_from is a wide SEARCH BOUND here, not a request.
    //   booked_start (4:00) differs from window_from (9:00) by design — firing a
    //   "your 9:00 wasn't open" note would be wrong/confusing.
    const { client } = makeClient([bookedResult()]); // booked 4:00
    const tools = buildTools(makeCtx(), client);
    const out = await exec(tools.book_with_scheduling, {
      service_type: 'Oil Change',
      window_from: '2026-07-15T09:00:00',
      window_to: '2026-07-15T17:00:00',
      phone: '+15559998888',
      // requested_start intentionally omitted (open-ended "next available")
    });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.time_changed).toBeUndefined();
    expect(parsed.requested_time).toBeUndefined();
    expect(parsed.booked_time).toBe('4:00 PM');
  });

  it('LEGACY shape (no booked_start) → falls back to the generic formatter, never throws', async () => {
    const { client } = makeClient([
      { ok: true, result: { success: true, appointment_id: 'appt-legacy' } },
    ]);
    const tools = buildTools(makeCtx(), client);
    const out = await exec(tools.book_with_scheduling, {
      service_type: 'Oil Change',
      window_from: '2026-07-15T16:30:00',
      window_to: '2026-07-15T17:00:00',
      requested_start: '2026-07-15T16:30:00',
      phone: '+15559998888',
    });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    // Generic formatter passthrough: raw result JSON, no booked_time/instruction.
    expect(parsed.appointment_id).toBe('appt-legacy');
    expect(parsed.booked_time).toBeUndefined();
  });
});

describe('send_verification_code + verify_phone_code', () => {
  it('HAPPY: send uses LLM-provided phone (NOT context phone)', async () => {
    // WHO: Caller gave a phone verbally that differs from caller-ID
    //       (or caller-ID was blocked and ctx.callerPhone is null)
    // WHAT: Tool uses the LLM-provided phone verbatim; tenant_id still
    //        comes from context
    // WHY: The whole point of this tool is to verify a phone the LLM
    //        just collected. Using context.callerPhone would defeat it.
    const { client, calls } = makeClient([
      {
        ok: true,
        result: { sent: true, phone: '+15551234567', message: 'I just sent you a text...' },
      },
    ]);
    const tools = buildTools(makeCtx({ callerPhone: null }), client);

    await exec(tools.send_verification_code, { phone: '5551234567' });

    expect(calls[0].path).toBe('/agent-tools/send-verification-code');
    expect(calls[0].body).toEqual({
      tenant_id: TENANT_ID,
      phone: '5551234567',
      // Binds the code to THIS call. The disclosure gate only accepts a
      // verification whose call_id matches the live call — a code proves
      // possession at a moment, not ownership of the number for a day.
      call_id: CALL_ID,
    });
  });

  it('HAPPY: verify forwards both phone and code', async () => {
    const { client, calls } = makeClient([
      { ok: true, result: { verified: true, phone: '+15551234567' } },
    ]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.verify_phone_code, { phone: '+15551234567', code: '123456' });

    expect(calls[0].path).toBe('/agent-tools/verify-phone-code');
    expect(calls[0].body).toEqual({
      tenant_id: TENANT_ID,
      phone: '+15551234567',
      code: '123456',
      call_id: CALL_ID,
    });
  });

  it('HAPPY: a successful verification ADOPTS the proven number as the caller phone', async () => {
    // WHO: a returning customer on a FORWARDED line — no caller-ID, so
    //      ctx.callerPhone starts null.
    // WHAT: after they read the texted code back, ctx.callerPhone must become
    //       the proven number.
    // WHY: every downstream tool guards on `if (!ctx.callerPhone)` —
    //      get_my_appointments, send_self_service_link, cancel_appointment,
    //      reschedule_appointment. Before this, the OTP proved the number and
    //      then THREW THE PROOF AWAY: the caller verified successfully and the
    //      agent still answered "I can't do that without caller-ID", forever.
    //      Thinking Hammer's live line IS the forwarded one, so that was every
    //      returning customer on every call.
    const ctx = makeCtx({ callerPhone: null });
    const { client } = makeClient([
      { ok: true, result: { verified: true, phone: '+15551234567' } },
    ]);
    const tools = buildTools(ctx, client);

    expect(ctx.callerPhone).toBeNull();
    await exec(tools.verify_phone_code, { phone: '5551234567', code: '1234' });

    // The SERVER's normalized E.164 form, not the raw string the LLM heard —
    // downstream lookups are exact phone matches.
    expect(ctx.callerPhone).toBe('+15551234567');
  });

  it('SAD: a FAILED verification does not adopt the number', async () => {
    // WHY: the guard must open only on proof. A wrong code that still promoted
    //      the spoken number to "verified caller phone" would hand an impostor
    //      exactly what the whole gate exists to withhold.
    const ctx = makeCtx({ callerPhone: null });
    const { client } = makeClient([{ ok: false, error: 'That code is not right.' }]);
    const tools = buildTools(ctx, client);

    await exec(tools.verify_phone_code, { phone: '5551234567', code: '9999' });

    expect(ctx.callerPhone).toBeNull();
  });
});

describe('response formatting', () => {
  it('HAPPY: string result passes through verbatim (avoids JSON.stringify quoting)', async () => {
    // WHY: /available-slots returns a spoken string ("Oil change takes
    //        about 30 minutes..."). If we JSON.stringified it, the LLM
    //        would see \"quoted\" text and sometimes speak the quotes.
    const { client } = makeClient([
      { ok: true, result: 'Oil change takes about 30 minutes. Openings at 2 PM.' },
    ]);
    const tools = buildTools(makeCtx(), client);

    const result = await exec(tools.get_available_slots, {
      service_type: 'oil change',
      date: '2030-01-01',
    });

    expect(result).toBe('Oil change takes about 30 minutes. Openings at 2 PM.');
  });

  it('HAPPY: object result is JSON-stringified for structured tool output', async () => {
    // WHY: scheduling-options returns { options, diagnostics } — the
    //        LLM handles JSON fine, and this preserves structure the
    //        system prompt knows about
    const { client } = makeClient([
      { ok: true, result: { options: [{ resourceId: 'bay-1' }], diagnostics: { reason: 'ok' } } },
    ]);
    const tools = buildTools(makeCtx(), client);

    const result = await exec(tools.get_scheduling_options, {
      service_type: 'oil change',
      window_from: '2026-05-01T14:00:00Z',
      window_to: '2026-05-01T16:00:00Z',
    });

    const parsed = JSON.parse(result);
    expect(parsed.options[0].resourceId).toBe('bay-1');
    expect(parsed.diagnostics.reason).toBe('ok');
  });

  it('SAD: error without code → JSON with just error field', async () => {
    // WHY: Network errors / 5xx have no error_code; we still need to
    //        surface the message so the LLM can say something sensible
    const { client } = makeClient([{ ok: false, error: 'Backend returned 500' }]);
    const tools = buildTools(makeCtx(), client);

    const result = await exec(tools.get_service_catalog, {});

    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('Backend returned 500');
    expect(parsed.error_code).toBeUndefined();
  });
});

describe('save_customer_preference', () => {
  it('HAPPY: forwards tenant_id + phone + key + value to the route', async () => {
    // WHO: the agent learned a durable fact mid-call and saves it.
    // WHAT: the tool posts to /agent-tools/save-customer-preference with the
    //        injected tenant_id plus the LLM-supplied phone/key/value.
    // WHY: tenant_id must come from context (never the LLM); the rest is the
    //        preference the LLM heard. A drift here means saves silently miss.
    const { client, calls } = makeClient([
      { ok: true, result: { saved: true, key: 'preferred_stylist' } },
    ]);
    const tools = buildTools(makeCtx(), client);

    const result = await exec(tools.save_customer_preference, {
      phone: '+15551112222',
      key: 'preferred_stylist',
      value: 'Maria',
    });

    expect(calls[0].path).toBe('/agent-tools/save-customer-preference');
    expect(calls[0].body).toEqual({
      tenant_id: TENANT_ID,
      phone: '+15551112222',
      key: 'preferred_stylist',
      value: 'Maria',
    });
    expect(JSON.parse(result).saved).toBe(true);
  });
});

describe('transfer_call', () => {
  // WHO: caller asks for a human / personal call for the owner
  // WHAT: the tool invokes the SIP-REFER executor and maps its result to an
  //        LLM-facing string. No backend HTTP call — transfer is LiveKit-side.
  // WHEN: every time the LLM decides to connect the caller to a person
  // WHERE: agent/src/tools.ts transfer_call → transferClient executor
  // WHY: a transfer that silently fails would drop the caller into dead air;
  //        each failure mode must steer the LLM to take a message instead.

  it('HAPPY: successful transfer tells the LLM the call is leaving', async () => {
    const execute = vi.fn(async () => ({ ok: true }) as const);
    const tools = buildTools(makeCtx(), makeClient([]).client, {
      forwardPhone: '+16082175303',
      execute,
    });
    const result = await exec(tools.transfer_call, {});
    expect(execute).toHaveBeenCalledWith('+16082175303');
    expect(result).toContain('Transfer started');
  });

  it('SAD: no executor (missing room/participant) → take a message', async () => {
    // execute null = the call lacked room/participant context to REFER
    const tools = buildTools(makeCtx(), makeClient([]).client, {
      forwardPhone: '+16082175303',
      execute: null,
    });
    const result = await exec(tools.transfer_call, {});
    expect(JSON.parse(result).error).toMatch(/not available/i);
  });

  it('SAD: no transfer capability passed at all → take a message', async () => {
    // buildTools called without the 3rd arg (e.g. transfer wiring absent)
    const tools = buildTools(makeCtx(), makeClient([]).client);
    const result = await exec(tools.transfer_call, {});
    expect(JSON.parse(result).error).toMatch(/not available/i);
  });

  it('SAD: forward number unconfigured → tells LLM no number is set', async () => {
    const execute = vi.fn(async () => ({ ok: false, reason: 'not_configured' }) as const);
    const tools = buildTools(makeCtx(), makeClient([]).client, {
      forwardPhone: null,
      execute,
    });
    const result = await exec(tools.transfer_call, {});
    expect(execute).toHaveBeenCalledWith(null);
    expect(JSON.parse(result).error).toMatch(/no transfer number/i);
  });

  it('SAD: REFER throws/fails → apologize and take a message', async () => {
    const execute = vi.fn(async () => ({ ok: false, reason: 'transfer_failed' }) as const);
    const tools = buildTools(makeCtx(), makeClient([]).client, {
      forwardPhone: '+16082175303',
      execute,
    });
    const result = await exec(tools.transfer_call, {});
    expect(JSON.parse(result).error).toMatch(/did not go through/i);
  });
});

describe('reschedule_appointment', () => {
  const APPT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
  const NEW_START = '2026-07-15T10:00:00';
  const NEW_END = '2026-07-15T11:00:00';

  it('HAPPY: injects phone from context and forwards appointment + times to backend', async () => {
    // WHO: Caller with caller-ID wanting to move their appointment
    // WHAT: Tool sends phone from SessionContext (never from LLM) + appointment_id + new times
    // WHY: Phone ownership guard on the backend requires the server-injected
    //      phone to match the appointment's customer — LLM must never supply it
    const { client, calls } = makeClient([{ ok: true, result: { rescheduled: true } }]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.reschedule_appointment, {
      appointment_id: APPT_ID,
      new_start_time: NEW_START,
      new_end_time: NEW_END,
    });

    expect(calls[0].path).toBe('/agent-tools/reschedule-appointment');
    expect(calls[0].body).toEqual({
      tenant_id: TENANT_ID,
      phone: CALLER_PHONE,
      appointment_id: APPT_ID,
      new_start_time: NEW_START,
      new_end_time: NEW_END,
    });
  });

  it('SAD: no caller-ID → short-circuits, no backend call', async () => {
    // WHO: Caller with blocked caller-ID
    // WHAT: Tool returns error string without hitting backend
    // WHY: Backend ownership guard requires a real phone; null would
    //      fail validation and waste an HTTP round-trip mid-call
    const { client, calls } = makeClient([]);
    const tools = buildTools(makeCtx({ callerPhone: null }), client);

    const result = await exec(tools.reschedule_appointment, {
      appointment_id: APPT_ID,
      new_start_time: NEW_START,
      new_end_time: NEW_END,
    });

    expect(JSON.parse(result).error).toMatch(/your number/i);
    expect(calls).toHaveLength(0);
  });
});

describe('get_my_appointments', () => {
  it('HAPPY: injects tenant_id + phone from context, returns appointments', async () => {
    // WHO: Returning caller who wants to see or cancel/reschedule their appointments
    // WHAT: Tool sends tenant_id + callerPhone (never LLM-supplied) to backend
    // WHEN: Caller says "can I see my appointments" or "I want to reschedule"
    // WHERE: agent/src/tools.ts get_my_appointments → /agent-tools/my-appointments
    // WHY: Phone must come from caller-ID so a caller can only see their own appointments
    const mockAppts = [
      {
        appointment_id: 'aaaaaaaa-0000-4000-8000-000000000001',
        start_time: '2099-07-01T14:00:00Z',
        service_name: 'Oil Change',
        employee_name: 'Mike',
      },
    ];
    const { client, calls } = makeClient([{ ok: true, result: { appointments: mockAppts } }]);
    const tools = buildTools(makeCtx(), client);

    const result = await exec(tools.get_my_appointments, {});

    expect(calls[0].path).toBe('/agent-tools/my-appointments');
    expect(calls[0].body).toEqual({ tenant_id: TENANT_ID, phone: CALLER_PHONE });
    expect(JSON.parse(result).appointments).toHaveLength(1);
    expect(JSON.parse(result).appointments[0].service_name).toBe('Oil Change');
  });

  it('SAD: anonymous caller → short-circuits, no backend call', async () => {
    // WHO: Caller with blocked caller-ID
    // WHAT: Tool returns error without hitting backend — no phone to lookup with
    // WHY: Backend would return empty results for null phone; better to tell the
    //       caller we can't identify them before wasting the round-trip
    const { client, calls } = makeClient([]);
    const tools = buildTools(makeCtx({ callerPhone: null }), client);

    const result = await exec(tools.get_my_appointments, {});

    expect(JSON.parse(result).error).toMatch(/your number/i);
    expect(calls).toHaveLength(0);
  });
});

describe('cancel_appointment', () => {
  const APPT_ID = 'cccccccc-0000-4000-8000-000000000003';

  it('HAPPY: injects phone from context and forwards appointment_id to backend', async () => {
    // WHO: Caller who confirmed they want to cancel their appointment
    // WHAT: Tool posts to cancel-appointment with server-injected phone (not LLM's)
    // WHEN: LLM supplies appointment_id from a prior get_my_appointments call
    // WHERE: agent/src/tools.ts cancel_appointment → /agent-tools/cancel-appointment
    // WHY: Phone ownership gate on the backend requires the correct caller phone;
    //       LLM must never supply it — prevents canceling another caller's appointment
    const { client, calls } = makeClient([
      { ok: true, result: { cancelled: true, appointment_id: APPT_ID } },
    ]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.cancel_appointment, { appointment_id: APPT_ID });

    expect(calls[0].path).toBe('/agent-tools/cancel-appointment');
    expect(calls[0].body).toEqual({
      tenant_id: TENANT_ID,
      phone: CALLER_PHONE,
      appointment_id: APPT_ID,
    });
  });

  it('SAD: no caller-ID → short-circuits, no backend call', async () => {
    // WHO: Caller with blocked caller-ID trying to cancel
    // WHAT: Tool returns error without hitting backend
    // WHY: Backend phone ownership gate would reject an empty/null phone anyway;
    //       short-circuit avoids the wasted roundtrip mid-call
    const { client, calls } = makeClient([]);
    const tools = buildTools(makeCtx({ callerPhone: null }), client);

    const result = await exec(tools.cancel_appointment, { appointment_id: APPT_ID });

    expect(JSON.parse(result).error).toMatch(/your number/i);
    expect(calls).toHaveLength(0);
  });
});

describe('take_message', () => {
  it('HAPPY: forwards name, message, and optional callback_phone to backend', async () => {
    // WHO: Caller the agent could not immediately help (owner unavailable, after-hours, etc.)
    // WHAT: Tool collects name + message + optional callback number and persists to DB
    // WHEN: transfer_call returns no_number, or owner is unavailable
    // WHERE: agent/src/tools.ts take_message → /agent-tools/take-message
    // WHY: Ensures the caller's need is recorded even when voice booking can't resolve it
    const { client, calls } = makeClient([{ ok: true, result: { saved: true } }]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.take_message, {
      caller_name: 'Alice Smith',
      message: 'Need a quote for four tires',
      callback_phone: '+15559990000',
    });

    expect(calls[0].path).toBe('/agent-tools/take-message');
    expect(calls[0].body).toMatchObject({
      tenant_id: TENANT_ID,
      caller_name: 'Alice Smith',
      message: 'Need a quote for four tires',
      callback_phone: '+15559990000',
    });
  });

  it('HAPPY: callback_phone is optional — the SYSTEM fills it from the caller-ID', async () => {
    // WHO: a caller who didn't state a separate callback number.
    // WHAT: the model omits callback_phone — and the tool fills it in.
    // WHY THIS CHANGED (2026-07-13): it used to send `undefined` and leave the model
    //      to remember the number. On a forwarded line (callerPhone null) the model
    //      was then the ONLY thing holding a number the caller had already given and
    //      confirmed — and it forgot, and asked him for it a THIRD time. The number
    //      the caller gave is now filled from the session, in order of trust
    //      (caller-ID → the number they spoke), so a model that forgets cannot make
    //      the caller repeat themselves.
    const { client, calls } = makeClient([{ ok: true, result: { saved: true } }]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.take_message, {
      caller_name: 'Bob',
      message: 'Looking for weekend availability',
    });

    expect(calls[0].path).toBe('/agent-tools/take-message');
    expect(calls[0].body.callback_phone).toBe(CALLER_PHONE);
  });

  it('SAD: with NO number anywhere, callback_phone stays undefined (nothing invented)', async () => {
    // WHY: filling from the system must never mean fabricating. An anonymous caller
    //      who gave no number has no callback number, and the tool must say so rather
    //      than inventing one — the owner would call a number that isn't theirs.
    const { client, calls } = makeClient([{ ok: true, result: { saved: true } }]);
    const tools = buildTools(makeCtx({ callerPhone: null }), client);

    await exec(tools.take_message, { caller_name: 'Bob', message: 'Call me back.' });

    expect(calls[0].body.callback_phone).toBeUndefined();
  });
});

describe('identify_caller', () => {
  it('HAPPY: injects tenant_id + phone from context, forwards LLM-supplied name', async () => {
    // WHO: Caller who gives their name mid-call before or instead of booking
    // WHAT: Tool posts tenant_id + callerPhone (from context) + name (from LLM) to identify-caller
    // WHEN: Agent hears the caller say their name and calls identify_caller immediately
    // WHERE: agent/src/tools.ts identify_caller → /agent-tools/identify-caller
    // WHY: Phone and tenant must come from context; name is the only LLM-supplied arg
    const { client, calls } = makeClient([{ ok: true, result: { identified: true } }]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.identify_caller, { name: 'Dale DeMott' });

    expect(calls[0].path).toBe('/agent-tools/identify-caller');
    expect(calls[0].body).toEqual({
      tenant_id: TENANT_ID,
      phone: CALLER_PHONE,
      name: 'Dale DeMott',
      // The session HAS a caller-ID, so the number is CARRIER-ATTESTED. The backend
      // will load this caller's preferences without demanding OTP — the caller
      // supplied nothing and cannot lie about it. (2026-07-13)
      phone_source: 'caller_id',
      call_id: CALL_ID,
    });
  });

  it('HAPPY: prefers the LLM-supplied spoken phone over caller ID', async () => {
    // WHO: Forwarded-line caller whose caller ID is NOT their own number
    // WHAT: When the LLM passes a phone (the number the caller said out loud),
    //        the tool saves the contact under THAT number, not ctx.callerPhone
    // WHEN: __PERSONA_NAME__ asks for the number, reads it back, then calls identify_caller(name, phone)
    // WHERE: agent/src/tools.ts identify_caller → /agent-tools/identify-caller
    // WHY: On a forwarded line the caller ID is the forwarding cell; the spoken
    //        number is the caller's true number and must be what lands in the CRM
    const { client, calls } = makeClient([{ ok: true, result: { identified: true } }]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.identify_caller, { name: 'Jane Doe', phone: '+16125551234' });

    expect(calls[0].body).toEqual({
      tenant_id: TENANT_ID,
      phone: '+16125551234',
      name: 'Jane Doe',
      // SPOKEN, not caller_id — even though this session HAS a caller-ID. The caller
      // gave us a DIFFERENT number, and a number a caller speaks is a claim we cannot
      // verify. Tagging it 'caller_id' because the session happened to have one would
      // let anyone unlock any account by simply reciting its phone number.
      phone_source: 'spoken',
      call_id: CALL_ID,
    });
  });

  it('SAD: no spoken phone and no caller ID → asks for a number, no backend call', async () => {
    // WHO: Caller with blocked caller-ID who has not yet given a number
    // WHAT: Tool returns a plain string (not JSON) and skips the backend
    // WHY: Backend requires a real phone to upsert; null phone would fail validation
    const { client, calls } = makeClient([]);
    const tools = buildTools(makeCtx({ callerPhone: null }), client);

    const result = await exec(tools.identify_caller, { name: 'Jane Doe' });

    expect(result).toContain('ask the caller for their number');
    expect(calls).toHaveLength(0);
  });
});

describe('page_owner_via_sms', () => {
  it('HAPPY: injects tenant_id, caller-ID phone, and call_id; forwards LLM args', async () => {
    // WHO: caller reporting something urgent (emergency at the property).
    // WHAT: tool posts tenant_id + ctx.callerPhone + ctx.callId (context-
    //        injected) plus caller_name/callback_phone/reason from the LLM.
    // WHEN: mid-call, the moment the agent judges the matter escalation-worthy.
    // WHERE: agent/src/tools.ts page_owner_via_sms → /agent-tools/page-owner
    // WHY: tenant/caller/call correlation must come from context — the LLM can
    //       never mis-scope a page onto another tenant or call.
    const { client, calls } = makeClient([{ ok: true, result: { paged: true } }]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.page_owner_via_sms, {
      caller_name: 'Alice Smith',
      callback_phone: '+15559990000',
      reason: 'water leak flooding the shop',
    });

    expect(calls[0].path).toBe('/agent-tools/page-owner');
    expect(calls[0].body).toMatchObject({
      tenant_id: TENANT_ID,
      caller_name: 'Alice Smith',
      callback_phone: '+15559990000',
      caller_phone: CALLER_PHONE,
      reason: 'water leak flooding the shop',
      call_id: CALL_ID,
    });
  });

  it('GUARD: second page on the same call short-circuits — no backend call (one page per call)', async () => {
    // WHO: an over-eager model trying to page the owner twice on one call.
    // WHAT: after one SUCCESSFUL page, the ctx.ownerPaged flag blocks any
    //        further page — the tool returns a redirect string and never hits
    //        the backend again.
    // WHEN: any turn after the first successful page.
    // WHERE: the ctx.ownerPaged guard at the top of execute().
    // WHY: repeated pages spam the owner's phone; the guard makes "at most one
    //       page per call" a structural property, not a prompt hope.
    const { client, calls } = makeClient([{ ok: true, result: { paged: true } }]);
    const ctx = makeCtx();
    const tools = buildTools(ctx, client);

    await exec(tools.page_owner_via_sms, { caller_name: 'Alice', reason: 'urgent leak' });
    expect(ctx.ownerPaged).toBe(true);

    const second = await exec(tools.page_owner_via_sms, {
      caller_name: 'Alice',
      reason: 'still leaking',
    });

    expect(second).toContain('already been paged');
    expect(calls).toHaveLength(1); // only the first attempt reached the backend
  });

  it('SAD: a FAILED page does not set the guard — one clean retry stays possible', async () => {
    // WHO: caller paging while the owner has no SMS-capable number configured.
    // WHAT: backend returns success:false → tool relays the graceful error and
    //        leaves ctx.ownerPaged unset (the owner was NOT actually paged).
    // WHY: the guard exists to stop repeat SUCCESSFUL pages; locking it on a
    //       transient failure would strand a genuinely urgent caller.
    const { client, calls } = makeClient([
      {
        ok: false,
        error: "The owner doesn't have a text-capable number set up, so I can't page them.",
      },
    ]);
    const ctx = makeCtx();
    const tools = buildTools(ctx, client);

    const result = await exec(tools.page_owner_via_sms, {
      caller_name: 'Bob',
      reason: 'angry customer about to leave',
    });

    expect(result).toContain('text-capable number');
    expect(ctx.ownerPaged).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe('get_detailed_customer_history', () => {
  it('HAPPY: injects tenant_id + caller-ID phone from context (LLM supplies nothing)', async () => {
    // WHO: returning caller asking "when was I last in?".
    // WHAT: tool posts tenant_id + ctx.callerPhone with NO LLM-supplied args
    //        and relays the structured history payload.
    // WHERE: agent/src/tools.ts get_detailed_customer_history →
    //        /agent-tools/customer-history
    // WHY: server-injected phone (same trust model as get_my_appointments) —
    //       the LLM must never be able to pull another caller's history.
    const { client, calls } = makeClient([
      {
        ok: true,
        result: {
          name: 'Jane Doe',
          preferences: { preferred_stylist: 'Maria' },
          appointments: [{ start_time: '2026-06-01T15:00:00Z', status: 'completed' }],
          recent_call_summaries: [{ summary: 'Booked a haircut.', started_at: '2026-06-01' }],
        },
      },
    ]);
    const tools = buildTools(makeCtx(), client);

    const result = await exec(tools.get_detailed_customer_history, {});

    expect(calls[0].path).toBe('/agent-tools/customer-history');
    expect(calls[0].body).toEqual({
      tenant_id: TENANT_ID,
      phone: CALLER_PHONE,
      // This tool has no `phone` parameter, so the LLM cannot substitute a
      // number — it only ever sends the carrier's. The server no longer takes
      // that on faith (it gates every disclosure route), but the claim we send
      // is true.
      phone_source: 'caller_id',
      call_id: CALL_ID,
    });
    expect(result).toContain('Jane Doe');
    expect(result).toContain('preferred_stylist');
  });

  it('SAD: no verified caller phone → tells the agent to identify the caller first, no backend call', async () => {
    // WHO: anonymous/forwarded-line caller not yet identified.
    // WHAT: tool short-circuits with an "identify the caller first" error and
    //        never reaches the backend.
    // WHY: the task contract — without a verified phone there is no safe key
    //       to look history up under; the agent must run identification first.
    const { client, calls } = makeClient([]);
    const tools = buildTools(makeCtx({ callerPhone: null }), client);

    const result = await exec(tools.get_detailed_customer_history, {});

    expect(result).toContain('identify the caller first');
    expect(calls).toHaveLength(0);
  });
});

describe('send_self_service_link', () => {
  it('HAPPY: forwards a specific appointment_id with context-injected tenant + phone', async () => {
    // WHO: caller who picked one of several upcoming appointments to move.
    // WHAT: tool posts tenant_id + ctx.callerPhone + the LLM-chosen
    //        appointment_id (from get_my_appointments) to the backend.
    // WHERE: agent/src/tools.ts send_self_service_link →
    //        /agent-tools/send-self-service-link
    // WHY: phone comes from context so ownership gating server-side is always
    //       keyed to the actual caller, never an LLM-invented number.
    const { client, calls } = makeClient([{ ok: true, result: { sent: true } }]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.send_self_service_link, { appointment_id: RESOURCE_ID });

    expect(calls[0].path).toBe('/agent-tools/send-self-service-link');
    expect(calls[0].body).toEqual({
      tenant_id: TENANT_ID,
      phone: CALLER_PHONE,
      appointment_id: RESOURCE_ID,
    });
  });

  it("HAPPY: appointment_id omitted → backend targets the caller's next upcoming appointment", async () => {
    // WHO: caller with a single upcoming appointment ("text me the link").
    // WHAT: no appointment_id in the body — the backend defaults to the next
    //        upcoming appointment under the caller's phone.
    const { client, calls } = makeClient([{ ok: true, result: { sent: true } }]);
    const tools = buildTools(makeCtx(), client);

    await exec(tools.send_self_service_link, {});

    expect(calls[0].body.appointment_id).toBeUndefined();
    expect(calls[0].body).toMatchObject({ tenant_id: TENANT_ID, phone: CALLER_PHONE });
  });

  it('SAD: no caller-ID → short-circuits with a handle-it-live redirect, no backend call', async () => {
    // WHO: anonymous caller asking for a self-service text.
    // WHAT: without a verified phone there is no ownership key — the tool
    //        redirects the agent to handle the change live and never hits
    //        the backend.
    // WHY: same ownership gate as cancel/reschedule; a link sent without a
    //       verified phone could target someone else's appointment.
    const { client, calls } = makeClient([]);
    const tools = buildTools(makeCtx({ callerPhone: null }), client);

    const result = await exec(tools.send_self_service_link, {});

    expect(result).toContain('Handle the cancel or reschedule on the call');
    expect(calls).toHaveLength(0);
  });

  it('SAD: consent-refused backend error relays verbatim so the agent pivots to live handling', async () => {
    // WHO: caller whose number opted out (STOP) or never consented to texts.
    // WHAT: backend fails with the consent message; the tool passes the exact
    //        conversational error through for the LLM to relay.
    const { client } = makeClient([
      {
        ok: false,
        error: "This number hasn't agreed to receive texts from us, so I can't send the link.",
      },
    ]);
    const tools = buildTools(makeCtx(), client);

    const result = await exec(tools.send_self_service_link, {});

    expect(result).toContain("hasn't agreed to receive texts");
  });
});

/**
 * REGRESSION — the caller gave his number twice and was asked a third time.
 *
 * On the 2026-07-13 call, on a FORWARDED line (so ctx.callerPhone is null by
 * design), the caller spoke his number, the agent read it back, he confirmed it.
 * The booking then fell through, the agent pivoted to taking a message — and asked
 * him for a callback number AGAIN.
 *
 * The prompt already forbids this, in a section literally titled "never re-ask name
 * or phone", which even names this exact pivot: "a booking attempt didn't work out
 * and you switch to taking a message — carry the name and number straight over."
 * The model ignored it.
 *
 * So the system remembers instead of the model. identify_caller records the
 * confirmed number on the session; take_message fills the callback number from
 * there. A number the caller already gave cannot be forgotten by a model that never
 * has to hold it.
 */
describe('REGRESSION: a number the caller already gave is never asked for twice', () => {
  it('identify_caller REMEMBERS a spoken number on the session', async () => {
    // WHO: a caller on a forwarded line — no caller-ID, so they must speak it.
    const ctx = makeCtx({ callerPhone: null });
    const { client } = makeClient([{ ok: true, result: { saved: true } }]);
    const tools = buildTools(ctx, client);

    await exec(tools.identify_caller, { name: 'Bob Smith', phone: '6082175303' });

    expect(ctx.spokenPhone).toBe('6082175303');
  });

  it('take_message REUSES it — the model never has to supply it again', async () => {
    // WHAT: this is the exact pivot that failed. The booking fell through; the
    //       agent takes a message. It must NOT ask for the number again.
    const ctx = makeCtx({ callerPhone: null });
    ctx.spokenPhone = '6082175303'; // already given + confirmed earlier in the call
    const { client, calls } = makeClient([{ ok: true, result: { saved: true } }]);
    const tools = buildTools(ctx, client);

    // The model omits callback_phone — as the tool description now tells it to.
    await exec(tools.take_message, {
      caller_name: 'Bob Smith',
      message: 'Give me a callback today.',
    });

    expect(calls[0].body).toMatchObject({ callback_phone: '6082175303' });
  });

  it('a carrier-attested caller-ID still wins over a spoken one', async () => {
    // WHY: order of trust. The carrier's number is attested; a spoken one is only
    //      claimed. If we have both, use the one that cannot be lied about.
    const ctx = makeCtx(); // has callerPhone
    ctx.spokenPhone = '6085550000';
    const { client, calls } = makeClient([{ ok: true, result: { saved: true } }]);
    const tools = buildTools(ctx, client);

    await exec(tools.take_message, { caller_name: 'Bob', message: 'Call me.' });

    expect(calls[0].body).toMatchObject({ callback_phone: CALLER_PHONE });
  });

  it('a NEW number the caller gives for the callback still overrides both', async () => {
    // WHY: the caller is always allowed to say "actually, reach me on this other
    //      number". Remembering must not become ignoring them.
    const ctx = makeCtx({ callerPhone: null });
    ctx.spokenPhone = '6082175303';
    const { client, calls } = makeClient([{ ok: true, result: { saved: true } }]);
    const tools = buildTools(ctx, client);

    await exec(tools.take_message, {
      caller_name: 'Bob',
      callback_phone: '3125550199',
      message: 'Call my office instead.',
    });

    expect(calls[0].body).toMatchObject({ callback_phone: '3125550199' });
  });
});

/**
 * REGRESSION — an empty string is not a phone number.
 *
 * Raised in review on #253, and it would have silently defeated the fix it was in.
 * `args.callback_phone ?? ctx.callerPhone` only falls through on null/undefined — an
 * EMPTY STRING is not nullish. So a model sending `callback_phone: ""` would have
 * that empty string sent to the backend AND block the fallback to the number the
 * caller already gave. The "never re-ask" guarantee would evaporate exactly when the
 * model was being sloppy, which is the only time it was needed.
 *
 * LLMs emit "" for optional fields constantly. Nullish coalescing is the wrong tool
 * for any value an LLM fills in.
 */
describe('REGRESSION: a blank string is ABSENT, not a value', () => {
  it('SAD: callback_phone:"" falls back to the remembered number instead of being sent', async () => {
    // WHO: a caller on a forwarded line who already gave his number.
    // WHAT: the model sends an empty callback_phone.
    // WHEN: the pivot from a failed booking to taking a message.
    // WHERE: tools.ts take_message → firstPhone().
    // WHY: "" is not nullish, so `??` would have sent it and blocked the fallback —
    //      the owner would get a message with NO callback number, for a caller who
    //      had given it twice.
    const ctx = makeCtx({ callerPhone: null });
    ctx.spokenPhone = '6082175303';
    const { client, calls } = makeClient([{ ok: true, result: { saved: true } }]);
    const tools = buildTools(ctx, client);

    await exec(tools.take_message, {
      caller_name: 'Bob',
      callback_phone: '',
      message: 'Call me.',
    });

    expect(calls[0].body).toMatchObject({ callback_phone: '6082175303' });
  });

  it('SAD: whitespace-only is also absent', async () => {
    const ctx = makeCtx({ callerPhone: null });
    ctx.spokenPhone = '6082175303';
    const { client, calls } = makeClient([{ ok: true, result: { saved: true } }]);
    const tools = buildTools(ctx, client);

    await exec(tools.take_message, {
      caller_name: 'Bob',
      callback_phone: '   ',
      message: 'Call me.',
    });

    expect(calls[0].body).toMatchObject({ callback_phone: '6082175303' });
  });

  it('SAD: a BLANK phone on identify_caller is not classified as "spoken"', async () => {
    // WHY: phone_source is the field the server's disclosure gate keys on. A
    //      whitespace string was truthy, so it was called 'spoken' AND sent as the
    //      phone — misclassifying the gate on garbage input.
    const ctx = makeCtx(); // has a real caller-ID
    const { client, calls } = makeClient([{ ok: true, result: { saved: true } }]);
    const tools = buildTools(ctx, client);

    await exec(tools.identify_caller, { name: 'Bob', phone: '   ' });

    expect(calls[0].body).toMatchObject({
      phone: CALLER_PHONE, // the carrier's number, not whitespace
      phone_source: 'caller_id',
    });
    expect(ctx.spokenPhone).toBeUndefined(); // nothing blank was remembered
  });
});
