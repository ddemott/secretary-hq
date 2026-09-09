import { llm } from '@livekit/agents';
import type { ToolMap } from './types.js';
import type { ToolBuildDeps } from './deps.js';
import { firstPhone, formatResponse } from './helpers.js';
import { markMessageTaken } from '../session/toolActivity.js';

export function messagingTools(d: ToolBuildDeps): ToolMap {
  const { ctx, client, outcome, speakFiller } = d;
  return {
    page_owner_via_sms: llm.tool({
      description:
        "URGENTLY page the business owner by text, mid-call, with the caller's name, callback number, and a one-line reason. Use ONLY for genuinely urgent or escalation-worthy matters the owner should see immediately (an emergency at the property, an angry customer threatening to leave, a time-critical business issue) — for ordinary requests use take_message instead. You may page the owner AT MOST ONCE per call. If it reports it can't page, offer to take a message instead.",
      parameters: {
        type: 'object',
        properties: {
          caller_name: {
            type: 'string',
            description: "The caller's name as they gave it.",
          },
          callback_phone: {
            type: 'string',
            description:
              "Number the owner should call back. Omit if the caller didn't give one (caller-ID is used).",
          },
          reason: {
            type: 'string',
            description:
              "ONE short line saying why this is urgent, e.g. 'water leak flooding the shop'. Be specific.",
          },
        },
        required: ['caller_name', 'reason'],
        additionalProperties: false,
      },
      execute: async (args: { caller_name: string; callback_phone?: string; reason: string }) => {
        // Per-call guard: one successful page maximum. The flag lives on the
        // session context so it survives across turns for the whole call.
        if (ctx.ownerPaged) {
          return JSON.stringify({
            error:
              'The owner has already been paged once on this call — do not page again. Offer to take a message with any additional details instead.',
          });
        }
        const res = await client.call('/agent-tools/page-owner', {
          tenant_id: ctx.tenantId,
          caller_name: args.caller_name,
          // Fill from what the SYSTEM knows, in order of trust, before falling back
          // to whatever the model happened to keep hold of. On a forwarded line
          // ctx.callerPhone is null — so without ctx.spokenPhone the model was the
          // ONLY thing remembering a number the caller had already given twice, and
          // it forgot, and it asked again.
          callback_phone: firstPhone(args.callback_phone, ctx.callerPhone, ctx.spokenPhone),
          caller_phone: firstPhone(ctx.callerPhone, ctx.spokenPhone),
          reason: args.reason,
          // Truthy check (not ??) so an empty-string callId is omitted — the
          // backend call_id is min(1) and would 400 on ''.
          call_id: ctx.callId || undefined,
        });
        if (res.ok) {
          ctx.ownerPaged = true;
          // A page IS a message for the owner (it writes a customer_messages row
          // flagged [URGENT PAGE]). Recording it here means the call's outcome is
          // a FACT from the tool, not the post-call classifier's guess about why
          // the caller rang. See callOutcome.ts.
          outcome?.recordMessage();
          // A page writes a customer_messages row too, so the same rule applies.
          markMessageTaken();
        }
        return formatResponse(res);
      },
    }),
    take_message: llm.tool({
      description:
        "Record a message from the caller for the business owner and send the owner an SMS alert. Use when the caller has a question you can't answer, wants a callback, or asks to leave a message. Collect a name and the message content before calling this.\n\nDO NOT ASK FOR A CALLBACK NUMBER if the caller already gave you one earlier in this call — the system reuses it automatically. Omit callback_phone entirely and it will be filled in. Only ask if you genuinely never got a number at all.",
      parameters: {
        type: 'object',
        properties: {
          caller_name: {
            type: 'string',
            description: "The caller's name as they gave it.",
          },
          callback_phone: {
            type: 'string',
            description:
              'ONLY set this if the caller gives a NEW number specifically for the callback. Otherwise OMIT it — the number they already gave (or their caller-ID) is filled in automatically. Never ask them to repeat a number they have already given you.',
          },
          is_urgent: {
            type: 'boolean',
            description:
              'Set true ONLY when the caller says it cannot wait — "urgent", "emergency", "as soon as possible", "right away". Their words, not your judgement: a message about money or a deadline is not urgent because of its topic. It flags the message at the top of the owner\'s inbox; it does NOT reach anyone mid-call, so never tell the caller you are putting them through or that someone will pick up.',
          },
          message: {
            type: 'string',
            description:
              'The substance of what the caller wants the owner to know or do. Be specific — capture exactly what they said.',
          },
        },
        required: ['caller_name', 'message'],
        additionalProperties: false,
      },
      execute: async (args: {
        caller_name: string;
        callback_phone?: string;
        message: string;
        is_urgent?: boolean;
      }) => {
        speakFiller?.('One moment while I pass that along...');
        const res = await client.call('/agent-tools/take-message', {
          tenant_id: ctx.tenantId,
          caller_name: args.caller_name,
          // THE PIVOT THAT FAILED (2026-07-13). On a forwarded line ctx.callerPhone
          // is null by design. The caller gave his number, the agent read it back, he
          // confirmed it — then the booking fell through, the agent switched to taking
          // a message, and asked him for a callback number AGAIN.
          //
          // The prompt forbids exactly this, in a section titled "never re-ask name or
          // phone" which even names this pivot. The model ignored it. So the SYSTEM
          // remembers: identify_caller records the confirmed number on the session and
          // it is filled in here, in order of trust — a new number the caller
          // deliberately gives for the callback still wins, because remembering must
          // never become ignoring them.
          callback_phone: firstPhone(args.callback_phone, ctx.callerPhone, ctx.spokenPhone),
          caller_phone: firstPhone(ctx.callerPhone, ctx.spokenPhone),
          message: args.message,
          call_id: ctx.callId ?? undefined,
          // The caller's own escalation, flagged for the owner's inbox. No
          // transfer exists on this call flow — see the param description.
          is_urgent: args.is_urgent === true,
        });
        // The message row is written → the outcome of this call IS 'message'.
        // Camille (2026-07-25) left one and the call was filed `wrong_service`,
        // because the LLM classifier was answering a different question. A tool
        // that succeeded outranks a guess. See callOutcome.ts.
        if (res.ok) {
          outcome?.recordMessage();
          // Tell the RUNTIME, not just the outcome tracker: once a message
          // exists, the watchdog's recovery line must stop offering to take one
          // (2026-09-09 call SCL_A5wnBexPbwCC — it offered, and the caller had
          // to refuse a thing he had just done). See session/toolActivity.ts.
          markMessageTaken();
        }
        return formatResponse(res);
      },
    }),
    capture_job_inquiry: llm.tool({
      description:
        "Record a work/job inquiry for the business owner and email it to them. Use when a caller asks whether the owner is available for work or about a specific position, AFTER you have walked through the intake questions.\n\nTHERE ARE TWO COMPANIES AND THEY ARE NOT THE SAME. `caller_company` is the agency the CALLER works for — the people you are actually talking to, and who the owner will negotiate the rate with. `client_company` is where the WORK would happen — the name on the badge. A recruiter from Insight Global placing someone at Blue Cross has caller_company='Insight Global' and client_company='Blue Cross'. Only when they are an IN-HOUSE recruiter (represents_company=true) are the two the same. Ask for both; do not guess one from the other.\n\nREQUIRES the caller's real name AND a callback number — it will REFUSE without them, and it is right to: a lead the owner cannot answer is not a lead. If it refuses, go and ask for what's missing, then call it again. You MUST call this tool once you have the answers — do not tell the caller you'll pass it along without calling it. Other fields you didn't get may be omitted.",
      parameters: {
        type: 'object',
        properties: {
          caller_name: { type: 'string', description: "The caller's name as they gave it." },
          callback_phone: {
            type: 'string',
            description: 'Phone number the owner should call back, if given.',
          },
          caller_company: {
            type: 'string',
            description:
              'The company the CALLER works for — the staffing agency that rang. NOT where the work is, unless they are an in-house recruiter.',
          },
          client_company: {
            type: 'string',
            description:
              'The company where the WORK would actually happen — the end client the owner would be placed at.',
          },
          represents_company: {
            type: 'boolean',
            description:
              'True if the caller works for the hiring company (vs. a recruiter/agency).',
          },
          employment_type: {
            type: 'string',
            enum: ['contract', 'full_time', 'contract_to_hire'],
            description: 'Whether the position is contract, full time, or contract-to-hire.',
          },
          role_description: {
            type: 'string',
            description:
              "The role itself, in the caller's own words — title, tech, responsibilities, whatever they led with. This is the field that tells the owner WHAT JOB it is; capture what they actually said.",
          },
          rate_range: {
            type: 'string',
            description: 'The rate range (contract) or salary range (full time) offered.',
          },
          duration: {
            type: 'string',
            description: 'Length of the contract. Omit for full-time roles.',
          },
          location_type: {
            type: 'string',
            enum: ['onsite', 'remote', 'hybrid'],
            description: 'Whether the position is onsite, remote, or hybrid.',
          },
          address: {
            type: 'string',
            description: 'Address of the position. Collect for onsite or hybrid roles.',
          },
          timezone: {
            type: 'string',
            description:
              'Timezone of the position. Collect for remote roles (so the owner knows office hours).',
          },
        },
        required: ['caller_name'],
        additionalProperties: false,
      },
      execute: async (args: {
        caller_name: string;
        callback_phone?: string;
        caller_company?: string;
        client_company?: string;
        represents_company?: boolean;
        employment_type?: 'contract' | 'full_time' | 'contract_to_hire';
        role_description?: string;
        rate_range?: string;
        duration?: string;
        location_type?: 'onsite' | 'remote' | 'hybrid';
        address?: string;
        timezone?: string;
      }) => {
        // No name. speakFiller is currently a no-op, but this said "pass that along
        // to Dale" — so the day anyone re-enables it, every tenant's caller hears the
        // platform owner's first name. A dormant string is still a string.
        speakFiller?.('One moment while I pass that along...');
        const res = await client.call('/agent-tools/capture-job-inquiry', {
          tenant_id: ctx.tenantId,
          caller_name: args.caller_name,
          // firstPhone, NOT `??` — and it now also falls back to the number the
          // caller SPOKE (ctx.spokenPhone), which is the only number we have on a
          // forwarded line. This line used to be
          //   args.callback_phone ?? ctx.callerPhone ?? undefined
          // which is the exact nullish-coalescing trap documented on blank(): a model
          // sending callback_phone:"" would send the empty string AND block the
          // fallback. And it never consulted spokenPhone at all.
          //
          // The result, on a real call: a perfect job lead — six-month hybrid contract
          // at Blue Cross, $65-72/hr — captured with NO PHONE NUMBER. An inquiry you
          // cannot answer is not an inquiry. It is a story about one that got away.
          callback_phone: firstPhone(args.callback_phone, ctx.callerPhone, ctx.spokenPhone),
          caller_company: args.caller_company,
          client_company: args.client_company,
          represents_company: args.represents_company,
          employment_type: args.employment_type,
          role_description: args.role_description,
          rate_range: args.rate_range,
          duration: args.duration,
          location_type: args.location_type,
          address: args.address,
          timezone: args.timezone,
          // Truthy check (not ??) so an empty-string callId is omitted — the
          // backend call_id is min(1) and would 400 on ''.
          call_id: ctx.callId || undefined,
          // THE SYSTEM REMEMBERS THE MEETING, not the model. If this call already
          // booked an appointment, the outcome tracker holds its id — inject it so
          // the inquiry row links to the meeting it was booked around and the
          // backend stamps a job summary onto the calendar entry. The model never
          // sees or handles the UUID (same trust model as spokenPhone).
          appointment_id: outcome?.result().appointmentId ?? undefined,
        });
        // Label the call from the tool that DID the thing, never the classifier's
        // guess. Call SCL_nRKo3KEVw8Yh (2026-07-27): this tool captured the lead,
        // no outcome was recorded, the null fell to the post-call classifier —
        // which read the transcript's "I'll leave a message for Dale" and labelled
        // the call 'message'. Messages inbox: empty. The row, the summary, and the
        // dashboard all repeated a promise no tool had executed.
        if (res.ok) outcome?.recordJobInquiry();
        return formatResponse(res);
      },
    }),
    capture_case_inquiry: llm.tool({
      description:
        "Record a prospective client's legal matter and send it to the attorney for review. Use AFTER you have walked through the case intake questions.\n\nYOU ARE NOT A LAWYER AND THIS TOOL IS NOT AN ACCEPTANCE. Recording a matter does not mean the firm is taking the case — an attorney decides that after reading it. Never tell the caller they have a case, what it might be worth, or whether a deadline has passed, even if they ask you directly and even if it seems obvious. The only honest answer to all three is that the attorney will review the details and get back to them.\n\nFOUR FACTS DECIDE WHETHER THE FIRM CAN ACT AT ALL, and a matter missing them cannot be assessed: when it happened (`incident_date` — the filing clock runs from it), which state (`incident_state` — the firm is only licensed in some), whether another lawyer already represents them (`has_existing_counsel` — an ethics wall, ask it early), and the names on the other side (`opposing_parties` — the firm runs a conflict check on names). Collect these before calling this tool.\n\nREQUIRES the caller's real name AND a callback number — it will REFUSE without them, and it is right to: a matter the firm cannot answer is a person who thinks a lawyer has their case and stops looking for one. If it refuses, ask for what's missing and call it again. Other fields you did not get may be omitted.",
      parameters: {
        type: 'object',
        properties: {
          caller_name: { type: 'string', description: "The caller's name as they gave it." },
          callback_phone: {
            type: 'string',
            description: 'Phone number the firm should call back.',
          },
          matter_type: {
            type: 'string',
            description:
              'The kind of matter in the caller\'s terms: "insurance_claim", "injury", or "other_matter".',
          },
          incident_date: {
            type: 'string',
            description:
              'When it happened, exactly as the caller said it ("March 2024", "about two years ago"). Do not convert or interpret it — record their words.',
          },
          incident_state: {
            type: 'string',
            description: 'The US state the incident or policy is in.',
          },
          has_existing_counsel: {
            type: 'boolean',
            description: 'True if another lawyer already represents them on this matter.',
          },
          counsel_situation: {
            type: 'string',
            description:
              'If they already have a lawyer: what they want anyway (second opinion, switching firms, their lawyer withdrew).',
          },
          opposing_parties: {
            type: 'string',
            description:
              'Names on the other side — person, business, insurer, plus any adjuster or opposing lawyer. Names, for the conflict check.',
          },
          matter_description: {
            type: 'string',
            description:
              "The caller's own account of what happened, at length. This paragraph is the most useful thing the attorney will read — capture what they actually said, do not summarize it into a sentence.",
          },
          insurer_name: { type: 'string', description: 'The insurance company involved.' },
          policy_type: {
            type: 'string',
            description: 'Kind of policy or coverage (auto, homeowners, health, disability, life).',
          },
          claim_outcome: {
            type: 'string',
            description: 'What the insurer did: "denied", "underpaid", or "delayed".',
          },
          stated_reason: {
            type: 'string',
            description:
              "The reason the INSURER gave, in the insurer's words as the caller heard them.",
          },
          amount_in_dispute: {
            type: 'string',
            description: 'Roughly how much is in dispute. An estimate is fine.',
          },
          appeal_status: {
            type: 'string',
            description: 'Whether they already appealed or asked the insurer to reconsider.',
          },
          injuries_sustained: {
            type: 'string',
            description: 'The injuries, as they describe them.',
          },
          medical_treatment: {
            type: 'string',
            description: 'Whether and where they have been treated. Record only — never advise.',
          },
          at_fault_party: {
            type: 'string',
            description: 'Who the caller says is responsible.',
          },
          gave_recorded_statement: {
            type: 'string',
            description:
              'Whether they gave the other side\'s insurer a recorded statement or signed anything: "gave_statement", "no_statement", or "unsure".',
          },
          lost_income: { type: 'string', description: 'Missed work or lost income, if mentioned.' },
          police_report: {
            type: 'string',
            description: 'Whether a police or incident report exists, and its number if given.',
          },
          deadline_pressure: {
            type: 'string',
            description:
              'Any date already hanging over them — court date, hearing, appeal window, a dated letter. Record verbatim.',
          },
          documents_available: {
            type: 'string',
            description: 'Paperwork they already have (policy, denial letter, records, photos).',
          },
          desired_outcome: {
            type: 'string',
            description: 'What they want out of it, if they said.',
          },
        },
        required: ['caller_name'],
        additionalProperties: false,
      },
      execute: async (args: {
        caller_name: string;
        callback_phone?: string;
        matter_type?: string;
        incident_date?: string;
        incident_state?: string;
        has_existing_counsel?: boolean;
        counsel_situation?: string;
        opposing_parties?: string;
        matter_description?: string;
        insurer_name?: string;
        policy_type?: string;
        claim_outcome?: string;
        stated_reason?: string;
        amount_in_dispute?: string;
        appeal_status?: string;
        injuries_sustained?: string;
        medical_treatment?: string;
        at_fault_party?: string;
        gave_recorded_statement?: string;
        lost_income?: string;
        police_report?: string;
        deadline_pressure?: string;
        documents_available?: string;
        desired_outcome?: string;
      }) => {
        speakFiller?.('One moment while I record those details...');
        const res = await client.call('/agent-tools/capture-case-inquiry', {
          tenant_id: ctx.tenantId,
          caller_name: args.caller_name,
          // firstPhone, never `??` — see capture_job_inquiry: a model sending
          // callback_phone:"" would otherwise send the empty string AND block
          // every fallback, and on a forwarded line ctx.spokenPhone is the only
          // number that exists.
          callback_phone: firstPhone(args.callback_phone, ctx.callerPhone, ctx.spokenPhone),
          matter_type: args.matter_type,
          incident_date: args.incident_date,
          incident_state: args.incident_state,
          has_existing_counsel: args.has_existing_counsel,
          counsel_situation: args.counsel_situation,
          opposing_parties: args.opposing_parties,
          matter_description: args.matter_description,
          insurer_name: args.insurer_name,
          policy_type: args.policy_type,
          claim_outcome: args.claim_outcome,
          stated_reason: args.stated_reason,
          amount_in_dispute: args.amount_in_dispute,
          appeal_status: args.appeal_status,
          injuries_sustained: args.injuries_sustained,
          medical_treatment: args.medical_treatment,
          at_fault_party: args.at_fault_party,
          gave_recorded_statement: args.gave_recorded_statement,
          lost_income: args.lost_income,
          police_report: args.police_report,
          deadline_pressure: args.deadline_pressure,
          documents_available: args.documents_available,
          desired_outcome: args.desired_outcome,
          call_id: ctx.callId || undefined,
          // The consultation this intake was booked around, if the call produced
          // one. The system holds the UUID; the model never sees it.
          appointment_id: outcome?.result().appointmentId ?? undefined,
        });
        return formatResponse(res);
      },
    }),
  };
}
