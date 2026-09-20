/**
 * RUNG 1, AS CODE INSTEAD OF AS A PARAGRAPH.
 *
 * This is the first piece of the spike. The question it is here to answer is narrow:
 * can a rung of our ladder be an `AgentTask`, driven by a host-code loop, using the
 * tools we already have?
 *
 * WHY WE ARE DOING THIS AT ALL. Today the ladder lives in `tenants.system_prompt` as a
 * STRING. The model reads it and, demonstrably, sometimes just does not do a rung. On
 * 2026-07-14 a caller said "a call with the owner to talk about a job", got booked in
 * perfectly, and hung up without ever being asked a single thing about the job. There
 * is no code anywhere that says "rung 3 must happen" — only a paragraph asking nicely.
 *
 * LiveKit ships the fix, in the version already in our node_modules. `TaskGroup.onEnter`
 * is a `while (taskStack.length > 0)` loop in HOST CODE, and `complete()` sits AFTER the
 * loop. The model has no tool that exits the group early. It cannot narrate its way past
 * a rung, and it cannot hang up with a goal undone, because the exit is unreachable
 * until the stack is empty.
 *
 * THE SHAPE OF A TASK, and it is the whole trick:
 *
 *   - An AgentTask IS an Agent. It has its OWN instructions and its OWN tools.
 *   - It talks to the caller until something calls `this.complete(result)`.
 *   - `complete()` is called from inside a TOOL. So THE ONLY WAY OUT IS THE WORK.
 *
 * That last line is the point. "Let me check…" advances nothing. "Thank you, have a
 * great day" advances nothing. The transition IS the tool call — which is the same idea
 * Pipecat Flows arrived at (routing hangs off the function, `next_node_id`), and it
 * kills the failure we have been fighting all week: the model satisfying an instruction
 * with a SENTENCE where we wanted an ACTION.
 *
 * NOTE ON REUSE: this deliberately does NOT invent new tools. `identify_caller` already
 * exists and already works — the task just receives it, plus one small completion tool.
 * The whole spike is about moving the LADDER down a layer, not rebuilding the rungs.
 */
import { type voice } from '@livekit/agents';
import type { SessionContext } from '../sessionContext.js';
import { makeRung } from './rung.js';
import { sanitizeVolunteered } from './sanitize.js';
import type { ToolMap } from '../tools.js';

export interface IdentityResult {
  name: string;
  /** E.164. Confirmed by the caller, or taken from caller ID. */
  phone: string;
  /** True when the caller read it back and agreed — false when it came from caller ID. */
  confirmedAloud: boolean;
}

export interface IdentityTaskOptions {
  ctx: SessionContext;
  /** The real identify_caller tool from buildTools() — not a new one. */
  identifyCaller: ToolMap[string];
  /** What the caller ALREADY said they want (from the intent step). Injected so identity
   *  does not re-ask "how can I help?" after confirming — it knows, and the next rung
   *  handles it. */
  requestedService?: string;
  /** A name the caller VOLUNTEERED before this rung started (usually in their opening
   *  sentence, captured by begin_call). Each rung is a separate agent, so a name spoken
   *  to the root agent is invisible here unless threaded in — on a 2026-07-18 live call
   *  the caller opened with "I'm Dale" and the very next words were "Can I get your
   *  name, please?". A volunteered name is greeted with, never re-asked. */
  volunteeredName?: string;
  /** A number the caller volunteered before this rung started. Unlike caller ID it is
   *  NOT attested, so it still gets the read-back confirm — but it must not be asked
   *  for from scratch as if never spoken. */
  volunteeredPhone?: string;
  /** Called with the confirmed values, so the caller record is saved exactly as today. */
  onIdentified?: (r: IdentityResult) => Promise<void> | void;
}

/**
 * Every line of these instructions was paid for by a real call, and they are the SAME
 * lines as the `identity` script block — deliberately. If the spike wins, the block
 * becomes the source and this string goes away; if it loses, we have not forked the
 * wording in the meantime.
 */
export const IDENTITY_INSTRUCTIONS = `Your ONLY job right now is to get the caller's NAME and a PHONE NUMBER they confirm.

Do not book anything. Do not take any details about why they called — that comes next, and it is not your job. If they start telling you why they rang, that is fine and welcome: say you have got that, and get their name and number first.

Work out what you ALREADY have from this call and ask only for what you still need. Use ONLY what THIS caller actually told you — never a name or a number from an example; there are none here to borrow.
- A name they already gave → use it; do not ask again. One brief nod is enough — do not thank them by name on every line.
- A number they already gave → read back the exact digits THEY said to confirm it. Do not ask for it again, and do not invent digits.
- Still need their name → ask for it, and wait for the answer.
- Still need their number → ask for the best number to reach them.
- READ THE NUMBER BACK and ask if it is right. Then STOP TALKING and wait. Do not act, do not "process", do not call a tool while they are still answering.
- If they say it is wrong, ask again. Never proceed on a number they did not confirm.
- If you only caught part of it, say which digits you got and ask for the rest.

When you have BOTH the name and a number they have confirmed, call confirm_identity. That is the only way to finish here — and the ONLY tool you actually need. If you happen to look the caller up and that lookup reports any trouble, carry right on: you already have their name and number, so call confirm_identity with those and move the call forward. A lookup hiccup never blocks you from finishing here.

The moment you call confirm_identity, your job is DONE and the system moves the caller straight into what they rang for. Your last words are a short warm close — three or four words, their first name at most once if it fits — then stop. Do not stack thank-yous; the next step already knows what they want.`;

/**
 * Rung 1 as a COLLECT rung (see rung.ts): it gathers the name + a confirmed number and a
 * synthetic `confirm_identity` tool marks it done. There is no single backend write that
 * means "identity is established" — the DOING is the gathering — so this is collect, not
 * action. `identify_caller` rides along as a passthrough CRM lookup; the instructions say
 * a failure of it is survivable (rule 8), so a lookup hiccup can never block completion.
 */
export function makeIdentityRung(opts: IdentityTaskOptions): voice.AgentTask<IdentityResult> {
  const { ctx, identifyCaller, onIdentified } = opts;

  // A caller-ID number is already attested by the carrier — there is nothing to read back,
  // and asking a man to confirm a number we can already see breaks "never re-ask what you
  // already have" in its most annoying form.
  const known = ctx.callerPhone;

  const askLine = opts.requestedService?.trim()
    ? `You already know why the caller rang: "${opts.requestedService.trim()}". Your only task here is their name and number; the system will act on their request the instant you confirm their identity.`
    : '';

  // Defense in depth: the root agent sanitizes before state, but THIS is the site
  // where caller-derived text meets a prompt — so it flattens and caps again. A
  // future caller of makeIdentityRung must not be able to reintroduce injection by
  // skipping the state path (review on #289).
  const volunteeredName = sanitizeVolunteered(opts.volunteeredName, 80);
  const volunteeredPhone = sanitizeVolunteered(opts.volunteeredPhone, 30);

  return makeRung<IdentityResult>({
    instructions: [
      IDENTITY_INSTRUCTIONS,
      askLine,
      volunteeredName
        ? `The caller ALREADY introduced themselves as ${volunteeredName}. Greet them by that name and do NOT ask for their name — you have it.`
        : '',
      known
        ? `You ALREADY have their number (${known}) from caller ID. Do NOT ask for it and do NOT read it back. You need only their NAME — then call confirm_identity with the name and that number.`
        : volunteeredPhone
          ? `The caller ALREADY said their number: ${volunteeredPhone}. Do NOT ask for it again — read those exact digits back to confirm them, and only re-ask if the caller says they are wrong.`
          : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    // The existing CRM tool, untouched and non-load-bearing (rule 8): the rung completes
    // via confirm_identity, and the instructions tell the model a lookup hiccup is fine.
    tools: { identify_caller: identifyCaller },
    completion: {
      kind: 'collect',
      toolName: 'confirm_identity',
      description:
        "Call this ONCE you have the caller's name AND a phone number they have confirmed (or that came from caller ID). This finishes the identity step. Do not call it on a number they have not agreed to.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The caller's name, as they gave it." },
          phone: { type: 'string', description: 'The confirmed phone number.' },
        },
        required: ['name', 'phone'],
      },
      build: (args): IdentityResult => ({
        name: (typeof args.name === 'string' ? args.name : '').trim(),
        phone: (typeof args.phone === 'string' ? args.phone : '').trim(),
        confirmedAloud: !known,
      }),
      onDone: async (result) => {
        // Record on the shared session context, so any backend tool that falls back to
        // ctx.spokenPhone (booking, take-message) has the number even if the model omits
        // it. "Spoken", not callerPhone — the caller told us; the carrier did not attest
        // it. Good enough to call back, not to unlock an account.
        ctx.spokenPhone = result.phone;
        // HOST-CODE PHONE-BOOK SAVE. identify_caller (the CRM upsert) used to be a tool
        // the MODEL might call — and on a live message call (2026-07-16) it didn't, so
        // the caller was never saved to the address book: a message with no contact
        // behind it. Confirming identity now IS saving the contact — the code calls the
        // real tool, so the write no longer depends on the model choosing to act. Upsert
        // by phone, so a model that also called it just re-saves the same row. Non-fatal:
        // a CRM hiccup must never block the call (hardening rule 8).
        if (result.name && result.phone) {
          try {
            await (
              identifyCaller as unknown as {
                execute: (a: unknown, o: unknown) => Promise<unknown>;
              }
            ).execute(
              { name: result.name, phone: result.phone },
              { toolCallId: 'host-identity-save' }
            );
          } catch {
            /* saving the contact is best-effort; the call moves on regardless */
          }
        }
        await onIdentified?.(result);
      },
    },
  });
}
