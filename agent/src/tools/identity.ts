import { llm } from '@livekit/agents';
import type { ToolMap } from './types.js';
import type { ToolBuildDeps } from './deps.js';
import { blank, formatResponse } from './helpers.js';

export function identityTools(d: ToolBuildDeps): ToolMap {
  const { ctx, client, hasVerification, gateVerificationAdvice } = d;
  return {
    get_customer_context: llm.tool({
      description:
        "Look up a caller in the CRM by phone. Returns the customer's name, a short history, any saved preferences (preferred staff, last service, likes), and sms_consent — whether they have ALREADY agreed to appointment texts (if true, never ask for that permission again). sms_consent is OMITTED when the caller is new, or when the response is requires_verification (consent status is withheld until the number is proven, exactly like the name). Treat an absent sms_consent as NO consent and ask: a missing field is never permission. Pass the phone number the caller gave you verbally when you have it; otherwise it falls back to the caller-ID phone. Use this to recognize returning callers.",
      parameters: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description:
              "The caller's phone number, preferably the one they gave you out loud. Omit only if you have not collected one yet (the caller-ID phone is used as a fallback).",
          },
        },
        additionalProperties: false,
      },
      execute: async (args: { phone?: string }) => {
        const lookupPhone = args.phone?.trim() || ctx.callerPhone;
        if (!lookupPhone) {
          return 'New caller - no history found.';
        }
        // Trust is a property of the NUMBER, not of the session. The carrier
        // attested ctx.callerPhone; anything the LLM hands us is a claim the
        // caller made out loud — even on a call that HAS caller ID, since the
        // model can pass a different number than the one that rang us.
        const usingCarrierNumber =
          Boolean(ctx.callerPhone) && (!args.phone || lookupPhone === ctx.callerPhone);
        const res = await client.call(
          '/agent-tools/customer-context',
          {
            tenant_id: ctx.tenantId,
            phone: lookupPhone,
            phone_source: usingCarrierNumber ? 'caller_id' : 'spoken',
            call_id: ctx.callId,
          },
          { isReadOnly: true }
        );
        return gateVerificationAdvice(res);
      },
    }),
    find_caller_by_name: llm.tool({
      description:
        "Look up a caller in the CRM by their FULL name. Requires first AND last name — a first name or surname on its own returns nothing, and so does a partial spelling. Ask for the full name before calling this. Returns matching contacts with a masked phone number on file so you can confirm 'is this still your number?' without reading the full number aloud. An empty list means no match — treat them as a new caller. Use this for name-first identification on this forwarded line, since caller ID is not the caller's own number.",
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'The caller\'s FULL name as they stated it — first and last, e.g. "Jane Doe". A single name part will not match.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      execute: async (args: { name: string }) => {
        const res = await client.call(
          '/agent-tools/find-customer-by-name',
          {
            tenant_id: ctx.tenantId,
            name: args.name,
          },
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),
    identify_caller: llm.tool({
      description: `Save or update the caller's contact record, and look them up. Call this as soon as you have their number — you do not need their name first. Keeps the address book current without duplicating records.\n\nIf the number is one we already have, the response may come back with returning_customer:true plus their NAME, saved preferences and recent history — USE it (greet them by name, offer their usual). You then do NOT need to ask their name: you have it. Confirm it instead ('I have you as Camille. Tell me if that sounds right.') rather than asking them to repeat it; a name you read from the record is more reliable than one heard over a phone line.\n\nIf it returns sms_consent:true, they have ALREADY agreed to appointment texts — that permission is on file and does not expire, so do NOT ask for it again and do NOT call record_sms_consent. Just say you'll text them as usual. If sms_consent is FALSE **or the field is ABSENT** (it is omitted on a requires_verification response, and for a brand-new caller), treat that as NO consent and ask for permission using the full script. A missing field is never permission.\n\nIf it returns requires_verification:true, the number was one THEY SPOKE (we had no caller ID), so we cannot trust it yet and will tell you nothing about the account. ${hasVerification ? 'Send them a code (send_verification_code) and verify it (verify_phone_code) BEFORE calling this again — never greet them by name or mention any account until it is verified.' : 'You have NO way to verify a number on this call: do NOT mention verification, codes or texts. It does NOT stop you BOOKING — treat them as a new caller, use the name and number they gave you, and book normally. A booking reveals nothing about anyone: they supply every fact in it.'}`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            // A NEUTRAL example. This description is sent to the LLM on every call for
            // every tenant, so a real person's name here is that person's PII sitting
            // in every customer's prompt — and it biases the model toward a name it
            // has seen in its instructions.
            description: 'The caller\'s full name as they stated it, e.g. "Jordan Reyes".',
          },
          phone: {
            type: 'string',
            description:
              "The caller's phone number as they gave it to you out loud. Always pass this when you have it — do not rely on caller ID.",
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      execute: async (args: { name: string; phone?: string; is_correction?: boolean }) => {
        const contactPhone = args.phone?.trim() || ctx.callerPhone;
        if (!contactPhone) {
          return 'No phone number available — ask the caller for their number, then save the contact.';
        }
        // WHERE DID THIS NUMBER COME FROM? This decides whether the backend will
        // reveal the caller's name, preferences and history — or demand OTP first.
        //
        //   ctx.callerPhone set  → the CARRIER gave us the number. Trustworthy.
        //   ctx.callerPhone null → we had no caller ID (forwarded line / blocked),
        //                          so any number here is one the CALLER SPOKE. It is
        //                          a claim, and anyone can claim anyone's number.
        //
        // Sending 'spoken' when unsure is the safe failure: worst case the caller
        // does an extra 20-second verification. Sending 'caller_id' when unsure
        // hands a stranger someone else's name and history.
        // phone_source describes THE NUMBER WE ARE SENDING — not the session's mood.
        //
        // A caller can have a perfectly good caller-ID and still give us a DIFFERENT
        // number ("actually, use my mobile"). That number is SPOKEN: they said it, we
        // cannot verify it, and it must not unlock someone else's account. Only the
        // number the CARRIER handed us is carrier-attested.
        //
        // Caught by a test that passed a spoken phone on a session that had caller-ID
        // — the first version of this line said 'caller_id' and would have trusted it.
        //
        // A BLANK phone is ABSENT, not spoken. Raised in review on #253: `!args.phone`
        // is false for "  ", so a whitespace string would have been classified
        // 'spoken' AND sent as the phone — misclassifying phone_source, which is the
        // field the server's disclosure gate keys on. LLMs emit "" for optional
        // fields constantly; a truthiness check is not enough for anything they fill.
        const spoken = blank(args.phone) ? undefined : args.phone!.trim();
        const usingCarrierNumber =
          Boolean(ctx.callerPhone) && (!spoken || spoken === ctx.callerPhone);
        const phoneSource = usingCarrierNumber ? 'caller_id' : 'spoken';
        const res = await client.call('/agent-tools/identify-caller', {
          tenant_id: ctx.tenantId,
          phone: spoken ?? ctx.callerPhone,
          name: args.name,
          phone_source: phoneSource,
          call_id: ctx.callId ?? undefined,
          // Set by the checklist's host code when the caller corrects a name
          // THIS call already saved — the one case where overwriting a real
          // (non-placeholder) name is right. Never set by the model.
          is_correction: args.is_correction === true,
        });

        // THE SYSTEM REMEMBERS THE NUMBER, SO THE MODEL DOESN'T HAVE TO.
        //
        // On a forwarded line ctx.callerPhone is null by design. The caller gives
        // their number, the agent reads it back, they confirm — and then, when the
        // booking fell through and it pivoted to taking a message, it asked for a
        // callback number AGAIN. He had already given it twice.
        //
        // The prompt forbids that, in a section literally titled "never re-ask name
        // or phone" which names this exact pivot. The model ignored it. Prompts are
        // requests; this is a guarantee. Every tool that needs a callback number now
        // fills it from here, so a number the caller already gave cannot be
        // forgotten by a model that never has to hold it.
        if (res.ok && !usingCarrierNumber && spoken) {
          ctx.spokenPhone = spoken;
        }

        // Same rewrite as get_customer_context: identify-caller's
        // requires_verification message promises "I'll text a 4-digit code" —
        // a text this session cannot send when the verification capability is
        // off. It must not reach the model (it would relay the promise to the
        // caller verbatim).
        return gateVerificationAdvice(res);
      },
    }),
    save_customer_preference: llm.tool({
      description:
        "Remember a durable fact about the caller for future calls — preferred staff member, the service they just had, a like/dislike, an allergy, a standing request. Only use when the business has asked you to track preferences and the fact will still matter next time. Saving is silent; don't announce it. No-op if the caller isn't a known customer yet.",
      parameters: {
        type: 'object',
        properties: {
          phone: {
            type: 'string',
            description:
              "The caller's phone. Pass the caller-ID phone unless they gave a different verified one.",
          },
          key: {
            type: 'string',
            description:
              'Short stable label for the preference, e.g. "preferred_stylist", "last_service", "dislikes". Reuse the same key to update an existing preference.',
          },
          value: {
            type: 'string',
            description: 'The preference itself in plain text, e.g. "Maria" or "balayage".',
          },
        },
        required: ['phone', 'key', 'value'],
        additionalProperties: false,
      },
      execute: async (args: { phone: string; key: string; value: string }) => {
        const res = await client.call('/agent-tools/save-customer-preference', {
          tenant_id: ctx.tenantId,
          phone: args.phone,
          key: args.key,
          value: args.value,
        });
        return formatResponse(res);
      },
    }),
    get_detailed_customer_history: llm.tool({
      description:
        "Pull the caller's FULL history: their last ~10 appointments (any status, with service, staff member, date, and status), all saved preferences, and summaries of their last few calls. Deeper than get_customer_context — use when the caller asks about past visits ('when was I last in?', 'what did I have done last time?') or you need real history to answer well. Uses the verified caller phone automatically — no input needed.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        // Phone is SERVER-INJECTED from session context (same trust model as
        // get_my_appointments) — the LLM never supplies it, so it can never
        // enumerate another caller's history.
        if (!ctx.callerPhone) {
          // Identity already established (identify_caller succeeded with a
          // spoken number) but this line has no carrier caller-ID — a forwarded
          // line, or a browser call. History is simply not available on this
          // call, and the message must SAY SO AND POINT FORWARD. The first
          // version said "identify the caller first" unconditionally — advice
          // the model had ALREADY satisfied and so could never act on. On a
          // live call 2026-07-17 it responded the only way it could: by
          // retrying this tool until the per-turn step cap killed the turn
          // silently. Unsatisfiable advice in a tool result is a loop
          // generator; every error message must name a step the model can
          // actually take on THIS call.
          if (ctx.spokenPhone) {
            return JSON.stringify({
              error:
                "History is not available on this call (the line has no caller-ID). That is fine — you already have the caller's name and number, so continue with their request using what they have told you, and do not call this tool again on this call.",
            });
          }
          return JSON.stringify({
            error:
              'No verified caller phone yet — identify the caller first (confirm their name and number, e.g. via find_caller_by_name or identify_caller), then I can pull their history.',
          });
        }
        const res = await client.call(
          '/agent-tools/customer-history',
          {
            tenant_id: ctx.tenantId,
            phone: ctx.callerPhone,
            // This tool only ever sends ctx.callerPhone — the number the CARRIER
            // gave us. The LLM cannot substitute one here (there is no phone
            // parameter), which is why this is 'caller_id'. The server no longer
            // takes that on faith; it just happens to be true.
            phone_source: 'caller_id',
            call_id: ctx.callId,
          },
          { isReadOnly: true }
        );
        return formatResponse(res);
      },
    }),
  };
}
