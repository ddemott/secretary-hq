import { llm } from '@livekit/agents';
import type { ToolMap } from './types.js';
import type { ToolBuildDeps } from './deps.js';
import {
  extractAppointmentId,
  firstPhone,
  formatBookingResponse,
  formatResponse,
} from './helpers.js';

export function schedulingTools(d: ToolBuildDeps): ToolMap {
  const { ctx, client, outcome, speakFiller, transferOrMessage, routeTo } = d;
  return {
    start_booking: llm.tool({
      description:
        "The caller wants to make a NEW appointment. Call this FIRST, before asking them for a day or a time — it is what gives you the scheduling tools, and you have NO way to see the calendar until you do. You do not need their service, day, time, name or number first; call it as soon as you know they want to book, then gather the rest. Do NOT tell the caller you are 'checking' or 'looking something up' — just call this. NOT for canceling, moving, or checking an appointment they ALREADY have — that is manage_appointment.",
      parameters: { type: 'object', properties: {} },
      execute: async () =>
        routeTo(
          'booking',
          'Scheduling tools are now available. NOTHING IS BOOKED YET — do not say "booked", "you\'re booked in", or "all set" until book_with_scheduling returns success. Use get_available_slots (they have a day in mind) or get_scheduling_options (they do not) to find real openings. Never state or refuse a time you have not seen in a tool result.'
        ),
    }),
    manage_appointment: llm.tool({
      description:
        'The caller wants to check, MOVE, or CANCEL an appointment they ALREADY have. Call this FIRST, before promising anything — it is what gives you the tools to look their booking up, and you cannot see a single existing appointment until you do. Do not use this for a NEW appointment (that is start_booking).',
      parameters: { type: 'object', properties: {} },
      execute: async () =>
        routeTo(
          'manage',
          'Appointment-management tools are now available. Call get_my_appointments to see what they actually have before changing anything.'
        ),
    }),
    get_service_catalog: llm.tool({
      description:
        "List every service this business offers with duration and price. Use when the caller asks 'what do you offer' or you need service names/IDs.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        const res = await client.call(
          '/agent-tools/service-catalog',
          {
            tenant_id: ctx.tenantId,
          },
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),
    get_available_slots: llm.tool({
      description:
        "Return a spoken description of open time slots for a specific service on a specific date. Use when the caller asks 'when can I come in for X' and has a day in mind. This returns spoken times ONLY — it does NOT return a bookable resource_id. To book one of these times, call book_with_scheduling with a tight window around the time the caller chose; do NOT call book_appointment or check_availability afterward (they need a resource_id this tool never yields).",
      parameters: {
        type: 'object',
        properties: {
          service_type: {
            type: 'string',
            description:
              'SAY WHAT THE CALLER SAID — not a catalog name you picked. Pass their own words for what they want: "a meeting to talk about a contract role", "have the owner call me back", "look at my project". The backend matches that to the right service SEMANTICALLY (it reads the catalog descriptions, which you cannot see in full). Do NOT try to pick the service yourself: on 2026-07-14 you decided a caller wanting a meeting about a six-month contract wanted a "Personal Callback" — a 15-minute call-me-back — and booked him into it. Report the intent; let the catalog choose. If the caller genuinely names a service, pass that name.',
          },
          date: {
            type: 'string',
            description: 'Date in YYYY-MM-DD format in the tenant timezone.',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          },
          requested_time: {
            type: 'string',
            description:
              'The exact time the CALLER asked for, if they named one ("2:30 PM", "9am"). Pass it whenever they have a time in mind: the result then tells you whether THAT time works and, if not, WHY (their own appointment is on it, someone else has it, nobody is on shift, it has already passed). Without it you get only a list — and a list alone is why a caller who asked for 2:30 was told "we can only book on the quarter hour", which was not true and not the reason.',
          },
        },
        required: ['service_type', 'date'],
        additionalProperties: false,
      },
      execute: async (args: { service_type: string; date: string; requested_time?: string }) => {
        speakFiller?.('Let me check what we have open...');
        const res = await client.call(
          '/agent-tools/available-slots',
          {
            tenant_id: ctx.tenantId,
            service_type: args.service_type,
            date: args.date,
            requested_time: args.requested_time,
            // Server-injected, never model-supplied: lets the backend say "you
            // already have that time" instead of the anonymous "it's taken".
            caller_phone: firstPhone(ctx.callerPhone, ctx.spokenPhone),
            // Attribute a pure availability inquiry to this call so a caller
            // who never books still counts toward abandonment-by-service.
            call_id: ctx.callId || undefined,
          },
          // Still retry-safe: the backend's requested_service_id capture is a
          // best-effort, COALESCE-guarded, deterministic UPDATE — replaying it
          // sets the same service_id, so an auto-retry can't corrupt state.
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),
    get_scheduling_options: llm.tool({
      description:
        'Compute valid (resource, employee) combinations for a service within a time window. Use for open-ended scheduling questions or to pre-check feasibility before booking.',
      parameters: {
        type: 'object',
        properties: {
          service_type: {
            type: 'string',
            description:
              'SAY WHAT THE CALLER SAID — not a catalog name you picked. Pass their own words for what they want: "a meeting to talk about a contract role", "have the owner call me back", "look at my project". The backend matches that to the right service SEMANTICALLY (it reads the catalog descriptions, which you cannot see in full). Do NOT try to pick the service yourself: on 2026-07-14 you decided a caller wanting a meeting about a six-month contract wanted a "Personal Callback" — a 15-minute call-me-back — and booked him into it. Report the intent; let the catalog choose. If the caller genuinely names a service, pass that name.',
          },
          required_resource_capabilities: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Optional capability tags the resource must have, e.g., ['lift', 'alignment'].",
          },
          required_employee_skills: {
            type: 'array',
            items: { type: 'string' },
            description: "Optional skill tags the employee must have, e.g., ['oil_change'].",
          },
          window_from: {
            type: 'string',
            description: 'ISO datetime start of the search window.',
          },
          window_to: {
            type: 'string',
            description: 'ISO datetime end of the search window.',
          },
        },
        required: ['service_type', 'window_from', 'window_to'],
        additionalProperties: false,
      },
      execute: async (args: {
        service_type: string;
        required_resource_capabilities?: string[];
        required_employee_skills?: string[];
        window_from: string;
        window_to: string;
      }) => {
        const res = await client.call(
          '/agent-tools/scheduling-options',
          {
            tenant_id: ctx.tenantId,
            requirements: {
              serviceType: args.service_type,
              requiredResourceCapabilities: args.required_resource_capabilities,
              requiredEmployeeSkills: args.required_employee_skills,
            },
            window: { from: args.window_from, to: args.window_to },
            // Attribute a pure availability inquiry to this call (see above).
            call_id: ctx.callId || undefined,
          },
          // Retry-safe — the capture UPDATE is idempotent (see available-slots).
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),
    check_availability: llm.tool({
      description:
        'Check whether a specific resource is available at a specific time. Use ONLY when you already have a resource_id from get_scheduling_options. get_available_slots does NOT return a resource_id — if you only have a time the caller picked, use book_with_scheduling instead of this tool. (SLOW lookup — 2-4s; a short filler like "one sec while I check that" is spoken automatically before the result.)',
      parameters: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              'A resource_id from get_scheduling_options output (not from get_available_slots).',
          },
          start_time: { type: 'string', description: 'ISO datetime.' },
          end_time: { type: 'string', description: 'ISO datetime.' },
        },
        required: ['resource_id', 'start_time', 'end_time'],
        additionalProperties: false,
      },
      execute: async (args: { resource_id: string; start_time: string; end_time: string }) => {
        // Guardrail (prod bug #3): check_availability needs a resource_id that
        // ONLY get_scheduling_options returns. get_available_slots yields spoken
        // times with no resource_id, so the LLM sometimes reaches here empty-
        // handed. Fail loudly with a redirect instead of 400ing the backend or
        // letting the LLM invent an id.
        if (!args.resource_id || !args.resource_id.trim()) {
          return JSON.stringify({
            error:
              'check_availability needs a resource_id from get_scheduling_options. If you only have a time the caller chose, call book_with_scheduling with a tight window around that time instead.',
            error_code: 'RESOURCE_ID_REQUIRED',
          });
        }
        const res = await client.call(
          '/agent-tools/check-availability',
          {
            tenant_id: ctx.tenantId,
            resource_id: args.resource_id,
            start_time: args.start_time,
            end_time: args.end_time,
          },
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),
    book_appointment: llm.tool({
      description:
        "Book an appointment at a specific slot when you ALREADY have a resource_id from get_scheduling_options. The resource_id MUST come from get_scheduling_options — get_available_slots does NOT return one, so if you only have a date/time the caller chose, call book_with_scheduling instead of this tool. Requires a good phone number (caller-ID or one the caller gives you). If the response contains 'I'll need a good phone number', collect and confirm a number from the caller per the phone-handling guidance in the instructions, then retry.",
      parameters: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              'A resource_id from get_scheduling_options output (not from get_available_slots).',
          },
          start_time: { type: 'string' },
          end_time: { type: 'string' },
          phone: {
            type: 'string',
            description:
              'Caller phone (E.164 preferred). Pass the caller-ID phone unless the caller gave you a different one verbally.',
          },
          name: { type: 'string', description: "Caller's name if known." },
          employee_id: { type: 'string', description: 'Optional — bind to a specific employee.' },
          description: {
            type: 'string',
            description: "Short description of what the caller wants, e.g., 'oil change'.",
          },
        },
        required: ['resource_id', 'start_time', 'end_time', 'phone'],
        additionalProperties: false,
      },
      execute: async (args: {
        resource_id: string;
        start_time: string;
        end_time: string;
        phone: string;
        name?: string;
        employee_id?: string;
        description?: string;
      }) => {
        // Guardrail (prod bug #3): book_appointment needs a resource_id that
        // ONLY get_scheduling_options returns. get_available_slots yields spoken
        // times with no resource_id, so the LLM sometimes reaches here empty-
        // handed and dead-ends. Fail loudly with a redirect to the one-call
        // path instead of 400ing the backend or letting the LLM invent an id.
        if (!args.resource_id || !args.resource_id.trim()) {
          return JSON.stringify({
            error:
              'book_appointment needs a resource_id from get_scheduling_options. If you only have a date and time the caller chose, call book_with_scheduling with a tight window around that time instead.',
            error_code: 'RESOURCE_ID_REQUIRED',
          });
        }
        speakFiller?.('One moment while I get that booked...');
        const bookRes = await client.call('/agent-tools/book-appointment', {
          tenant_id: ctx.tenantId,
          resource_id: args.resource_id,
          start_time: args.start_time,
          end_time: args.end_time,
          phone: args.phone,
          name: args.name,
          employee_id: args.employee_id,
          description: args.description ?? 'Booking via SecretaryHQ',
          call_id: ctx.callId ?? '',
        });
        const bookedId = extractAppointmentId(bookRes);
        if (bookedId) outcome?.recordBooking(bookedId);
        return formatResponse(bookRes);
      },
    }),
    book_with_scheduling: llm.tool({
      description:
        "Find a slot AND book it in one call using a time window and requirements. The default booking tool — use it after get_available_slots and when the caller says 'book the next available'. It books the EARLIEST open slot at or after window_from, so when the caller picked a SPECIFIC time, set window_from to exactly that time (a window that starts earlier will book them earlier than they asked). When the caller named a specific time, ALSO pass requested_start so the response can flag if the booked slot ended up different. The response returns the ACTUAL booked time (booked_time) — confirm THAT to the caller, not the time they requested.",
      parameters: {
        type: 'object',
        properties: {
          service_type: {
            type: 'string',
            description:
              'SAY WHAT THE CALLER SAID — not a catalog name you picked. Pass their own words for what they want: "a meeting to talk about a contract role", "have the owner call me back", "look at my project". The backend matches that to the right service SEMANTICALLY (it reads the catalog descriptions, which you cannot see in full). Do NOT try to pick the service yourself: on 2026-07-14 you decided a caller wanting a meeting about a six-month contract wanted a "Personal Callback" — a 15-minute call-me-back — and booked him into it. Report the intent; let the catalog choose. If the caller genuinely names a service, pass that name.',
          },
          required_resource_capabilities: { type: 'array', items: { type: 'string' } },
          required_employee_skills: { type: 'array', items: { type: 'string' } },
          preferred_resource_id: { type: 'string' },
          window_from: { type: 'string' },
          window_to: { type: 'string' },
          requested_start: {
            type: 'string',
            description:
              'The exact start time the caller specifically asked for, local-naive ISO (e.g. 2026-07-15T16:30:00). Set ONLY when the caller named a specific time; OMIT for "next available" / open-ended requests. Lets the response tell the caller if the booked slot differs from their request.',
          },
          with_person: {
            type: 'string',
            description:
              "WHO the caller asked to see, in the caller's own words — whatever name they said. Set ONLY when they named a person; OMIT otherwise. The backend CHECKS the name against the real staff list and refuses the booking if nobody by that name works there — so passing it is how you avoid confirming a meeting with someone who does not exist. Do not translate it to an id; pass what you heard.",
          },
          phone: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          reminder_lead_minutes: {
            type: 'number',
            description: d.smsEnabled
              ? 'How many minutes BEFORE the appointment to text a reminder. Set ONLY when the caller agreed to a text reminder (after the SMS-consent disclosures — see "Text reminders"). Use 30 when they say yes without naming a time; use their number when they name one ("an hour before" → 60, "the day before" → 1440). OMIT entirely if they declined or were not asked.'
              : 'DO NOT SET THIS AND DO NOT MENTION TEXT REMINDERS. This deployment cannot send a text message at all — the number is not registered with the carriers, so anything "sent" is silently dropped. There is no consent to collect and no reminder to promise. If the caller asks for a text, say plainly that you cannot text them, and that the time is on the calendar.',
          },
          allow_duplicate: {
            type: 'boolean',
            description:
              'Set true ONLY after this tool refused with EXISTING_SAME_DAY, you told the caller about the appointment they already have that day, and they said they want a SECOND separate one anyway. Never set it pre-emptively: it exists to stop a caller ending up with two live bookings for the same thing, which happened on a real call.',
          },
        },
        required: ['service_type', 'window_from', 'window_to', 'phone'],
        additionalProperties: false,
      },
      execute: async (args: {
        service_type: string;
        required_resource_capabilities?: string[];
        required_employee_skills?: string[];
        preferred_resource_id?: string;
        window_from: string;
        window_to: string;
        requested_start?: string;
        with_person?: string;
        phone: string;
        name?: string;
        description?: string;
        reminder_lead_minutes?: number;
        allow_duplicate?: boolean;
      }) => {
        speakFiller?.('One moment while I find and book a slot...');
        const res = await client.call('/agent-tools/book-with-scheduling', {
          tenant_id: ctx.tenantId,
          phone: args.phone,
          name: args.name,
          description: args.description ?? 'Booking via SecretaryHQ',
          call_id: ctx.callId ?? '',
          requirements: {
            serviceType: args.service_type,
            requiredResourceCapabilities: args.required_resource_capabilities,
            requiredEmployeeSkills: args.required_employee_skills,
            preferredResourceId: args.preferred_resource_id,
          },
          window: { from: args.window_from, to: args.window_to },
          // Checked by the backend against the live roster, never trusted.
          with_person: args.with_person || undefined,
          // Absent → backend falls back to the caller's stored lead preference,
          // then to the standard bundle. Never invent a value here.
          reminder_lead_minutes: args.reminder_lead_minutes ?? null,
          // Only ever true after the caller was told about their existing
          // same-day booking and asked for a second one anyway.
          allow_duplicate: args.allow_duplicate === true,
        });
        const bookedId = extractAppointmentId(res);
        if (bookedId) outcome?.recordBooking(bookedId);
        return formatBookingResponse(res, args.requested_start);
      },
    }),
    attach_meeting_notes: llm.tool({
      description:
        "Attach a short note from the caller to the meeting that was booked on THIS call, so the owner sees it on the calendar entry (context, requests, anything they want known before the meeting). Only works after a booking has happened on this call — the system knows which meeting; you pass only the note. Do NOT use this for standalone messages or callback requests when no meeting was booked — that's take_message.",
      parameters: {
        type: 'object',
        properties: {
          notes: {
            type: 'string',
            description:
              'What the caller wants the owner to know ahead of the meeting, in their words. Be specific — capture what they actually said.',
          },
        },
        required: ['notes'],
        additionalProperties: false,
      },
      execute: async (args: { notes: string }) => {
        // THE FULFILLMENT GATE (2026-07-18, Dale's off-script call). The caller
        // said "he'll need my address"; the model attached exactly that — a
        // POINTER to an address, containing none — and the owner would have
        // opened the calendar with nowhere to go. The instructions now tell the
        // model to ask for the thing itself, but that judgment FLAPS (sim:
        // 2/2, then 1/2). This gate is the deterministic layer: a note that
        // NAMES an address / phone number / code and contains no digit almost
        // certainly mentions the thing without containing it — bounce it with
        // the action the model can take (rule: every error names a satisfiable
        // next step). A real address, number, or code carries digits ("1060
        // West Addison", "312-630-1234", "gate code 4417"), so genuine notes
        // pass untouched.
        const namesAThing = /\b(address|phone|number|code)\b/i.test(args.notes);
        const containsDigits = /\d/.test(args.notes);
        if (namesAThing && !containsDigits) {
          return JSON.stringify({
            error:
              'This note mentions an address, number, or code but does not CONTAIN one — a note saying the information is needed gives the owner nothing to use. Ask the caller for the thing itself ("Sure — what\'s the address?"), then call attach_meeting_notes again with what they say.',
          });
        }
        // The appointment id comes from the outcome tracker — the model never holds a
        // UUID. No booking on this call yet → nothing to attach to; say so honestly
        // instead of 400ing at the backend.
        const appointmentId = outcome?.result().appointmentId;
        if (!appointmentId) {
          return JSON.stringify({
            error:
              'No meeting has been booked on this call, so there is nothing to attach a note to. If the caller wants something passed along, record it as a message instead.',
          });
        }
        const res = await client.call('/agent-tools/attach-meeting-notes', {
          tenant_id: ctx.tenantId,
          appointment_id: appointmentId,
          notes: args.notes,
          call_id: ctx.callId || undefined,
        });
        return formatResponse(res);
      },
    }),
    get_my_appointments: llm.tool({
      description:
        "Fetch THE CALLER'S OWN upcoming scheduled appointments — the times THEY have booked, not the business's calendar and not anyone else's. Call this when the caller says they want to cancel or reschedule, so you can show them what they actually have before acting. Does not require any input from the caller; phone is from caller-ID.\n\nThese appointments belong to the PERSON ON THE PHONE. Never describe one as the owner's or a colleague's: on 2026-09-09 (SCL_A9GtJeZF7EwF) the result held the caller's own 2:30 booking from six minutes earlier, and it was relayed as though it were the OWNER'S calendar (\"he already has an appointment Thursday at 2:30\") — then used to push her onto a different DAY, while 1:30, 3:00, 3:30 and 4:00 sat open. A time already booked by this caller does NOT close the day: call get_available_slots and offer the other open times on the SAME day first. Whether they may hold two on one day is the booking tool's decision, not yours.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        // Caller-ID if the carrier gave it; otherwise the number the caller confirmed in
        // the identity step (ctx.spokenPhone). On a forwarded/blocked-ID line caller-ID is
        // null by design, and without the spoken fallback a caller literally could not
        // manage their own appointment — booking already trusts the same spoken number.
        const managePhone = firstPhone(ctx.callerPhone, ctx.spokenPhone);
        if (!managePhone) {
          return JSON.stringify({
            error: `I can't look up appointments until I have your number. If you'd like help canceling or rescheduling, I can ${transferOrMessage}.`,
          });
        }
        const res = await client.call(
          '/agent-tools/my-appointments',
          { tenant_id: ctx.tenantId, phone: managePhone },
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),
    cancel_appointment: llm.tool({
      description:
        "Cancel one of the caller's upcoming appointments. ALWAYS call get_my_appointments first and read the result back so the caller can confirm which appointment they want to cancel. Ask them to confirm BEFORE calling this. For rescheduling use reschedule_appointment instead.",
      parameters: {
        type: 'object',
        properties: {
          appointment_id: {
            type: 'string',
            description:
              'UUID of the appointment to cancel, exactly as returned by get_my_appointments.',
          },
        },
        required: ['appointment_id'],
        additionalProperties: false,
      },
      execute: async (args: { appointment_id: string }) => {
        const managePhone = firstPhone(ctx.callerPhone, ctx.spokenPhone);
        if (!managePhone) {
          return JSON.stringify({
            error: `I can't cancel until I have your number to find the appointment. Offer to ${transferOrMessage}.`,
          });
        }
        const res = await client.call('/agent-tools/cancel-appointment', {
          tenant_id: ctx.tenantId,
          phone: managePhone,
          appointment_id: args.appointment_id,
        });
        return formatResponse(res);
      },
    }),
    reschedule_appointment: llm.tool({
      description:
        "Move an existing appointment to a new date and time. ALWAYS call get_my_appointments first so the caller can confirm which appointment to move. Confirm the new time verbally before calling this. Use book_with_scheduling to find an available slot if the caller doesn't have one yet.",
      parameters: {
        type: 'object',
        properties: {
          appointment_id: {
            type: 'string',
            description:
              'UUID of the appointment to reschedule, exactly as returned by get_my_appointments.',
          },
          new_start_time: {
            type: 'string',
            description: 'New start time in ISO 8601 format (e.g. 2026-07-15T10:00:00).',
          },
          new_end_time: {
            type: 'string',
            description: 'New end time in ISO 8601 format (e.g. 2026-07-15T11:00:00).',
          },
        },
        required: ['appointment_id', 'new_start_time', 'new_end_time'],
        additionalProperties: false,
      },
      execute: async (args: {
        appointment_id: string;
        new_start_time: string;
        new_end_time: string;
      }) => {
        const managePhone = firstPhone(ctx.callerPhone, ctx.spokenPhone);
        if (!managePhone) {
          return JSON.stringify({
            error: `I can't reschedule until I have your number to find the appointment. Offer to ${transferOrMessage}.`,
          });
        }
        speakFiller?.('One moment while I move that for you...');
        const res = await client.call('/agent-tools/reschedule-appointment', {
          tenant_id: ctx.tenantId,
          phone: managePhone,
          appointment_id: args.appointment_id,
          new_start_time: args.new_start_time,
          new_end_time: args.new_end_time,
        });
        return formatResponse(res);
      },
    }),
  };
}
