/**
 * TASK-GROUP END-TO-END — with a LIVE LLM CALLER, so it is bulletproof to phrasing.
 *
 * The point Dale made: real callers word things differently, pause differently, front-load
 * or withhold, give half a number and correct it, answer a question you didn't ask. Scripted
 * turns test ONE phrasing — your own. So this harness does NOT script the caller. A second
 * LLM PLAYS the caller: given a persona (the facts it holds + a behavioural style), it
 * responds naturally to whatever the agent says, and DIFFERENTLY every run.
 *
 * It runs the REAL tasks (planCallTasks → Identity → Book → JobIntake) with their real
 * instructions and real tools, against the real backend + real DB. The only thing not real
 * is the caller's voice — it's an LLM instead of a phone. Each scenario runs across several
 * STYLES (terse, chatty, front-loader, self-corrector, …) to shake out phrasing bugs, and
 * every run is verified against the DATABASE, not the transcript.
 *
 * Run:  cd agent && BACKEND_URL=https://localhost:4001 npx tsx scripts/sim-taskgroup.ts
 *   env: OPENAI_API_KEY, AGENT_SECRET, DATABASE_URL, a backend, a bookable tenant.
 *   SIM_CASE=<substr>   run only matching scenarios
 *   SIM_STYLES=terse,chatty   limit which styles run (default: all)
 *   SIM_RUNS=1          runs per (scenario × style) (default 1)
 */
import { llm, initializeLogger } from '@livekit/agents';
import { Client } from 'pg';
import { ToolsClient } from '../src/toolsClient.js';
import { buildTools } from '../src/tools.js';
import { CallOutcomeTracker } from '../src/callOutcome.js';
import { planCallTasks, type CallDeps } from '../src/tasks/callPlan.js';
import type { SessionContext } from '../src/sessionContext.js';

const API_KEY = process.env.OPENAI_API_KEY;
const AGENT_MODEL = process.env.SIM_TASKGROUP_MODEL || 'gpt-4o-mini';
const CALLER_MODEL = process.env.SIM_CALLER_MODEL || 'gpt-4o-mini';
const BACKEND_URL = process.env.BACKEND_URL || 'https://localhost:4001';
const AGENT_SECRET = process.env.AGENT_SECRET || '';
const DB_URL = process.env.DATABASE_URL || '';
const TENANT = process.env.SIM_TENANT || 'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0';
const CASE_FILTER = process.env.SIM_CASE || '';
const RUNS = Number(process.env.SIM_RUNS || 1);

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

if (!API_KEY) throw new Error('OPENAI_API_KEY not set');
if (!AGENT_SECRET) throw new Error('AGENT_SECRET not set');
if (BACKEND_URL.startsWith('https://localhost')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function openai(
  model: string,
  temperature: number,
  messages: ChatMessage[],
  tools?: { type: 'function'; function: unknown }[]
): Promise<{ content: string | null; toolCalls: ToolCall[] }> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model,
        temperature,
        messages,
        ...(tools ? { tools, tool_choice: 'auto' } : {}),
      }),
    }).catch(() => null);
    if (res?.ok) {
      const j = (await res.json()) as {
        choices: { message: { content: string | null; tool_calls?: ToolCall[] } }[];
      };
      const m = j.choices[0]?.message;
      return { content: m?.content ?? null, toolCalls: m?.tool_calls ?? [] };
    }
    if (res && res.status !== 429 && res.status < 500) {
      throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    await sleep(Math.min(1500 * 2 ** (attempt - 1), 15_000));
  }
  throw new Error('OpenAI unreachable after retries');
}

function toolSchemas(ctx: llm.ToolContext): { type: 'function'; function: unknown }[] {
  return Object.entries(ctx).map(([name, t]) => {
    const shape = t as unknown as { description: string; parameters: Record<string, unknown> };
    return {
      type: 'function' as const,
      function: { name, description: shape.description, parameters: shape.parameters },
    };
  });
}

// ── THE CALLER ────────────────────────────────────────────────────────────────
// A persona = the facts the caller holds + a behavioural style. The caller LLM sees the
// running transcript and produces the next spoken line — naturally, and differently each run.

interface Persona {
  name: string;
  phone: string; // canonical; the caller states THIS number, phrased however
  goalLine: string; // how they open ("I'd like a meeting with Dale about a job")
  wantsMeeting: boolean;
  hasJobInquiry: boolean;
  requestedService: string;
  // job facts (used only if hasJobInquiry)
  callerCompany?: string;
  clientCompany?: string;
  inHouse?: boolean; // hiring for own company → client == caller
  employmentType?: 'contract' | 'full_time';
  rate?: string;
  length?: string;
  location?: 'onsite' | 'remote' | 'hybrid';
  address?: string;
  timezone?: string;
  // schedule-change (cancel / reschedule an EXISTING appointment)
  wantsScheduleChange?: boolean;
  scheduleAction?: 'cancel' | 'reschedule';
  existingService?: string; // what the seeded appointment is, so the caller can name it
  // leave-a-message (the universal catch-all)
  wantsToLeaveMessage?: boolean;
  messageBody?: string; // what they want passed to the owner, in their own words
  // something to say when the wrap-up asks "anything you'd like noted ahead of the
  // meeting?" — omit and the persona says no (the notes step must cost ONE question)
  meetingNotes?: string;
  // THE CURVEBALL (2026-07-18 live call): the caller first says only a POINTER
  // to information ("he'll need my address") and reveals the concrete fact
  // ONLY if the receptionist asks for the thing itself. The agent that
  // attaches the pointer has saved nothing the owner can use.
  meetingNotesHint?: string;
  meetingNotesFact?: string;
  // questions about the business (answered from the knowledge base)
  hasQuestions?: boolean;
  questionFacts?: string; // what they want to know, and when they're satisfied
  // hard behaviours the persona MUST exhibit (adversarial)
  refusesPhone?: boolean; // never gives a number
  // THE MISROUTE (2026-07-18): the SCENARIO plans a job rung (simulating an
  // intent flap), but this caller has NO job — if asked about roles, companies,
  // hiring, rates, they say plainly it is not about a job.
  deniesJob?: boolean;
  // THE MID-INTAKE BAIL (2026-07-18, Dale: "can someone ask just to leave a
  // message instead?"): a REAL job caller who, once the role questions start,
  // refuses the interview and asks for a plain message to be passed instead.
  bailsToMessage?: string; // the message they want passed
  // THE FRONT-LOADED NAME (2026-07-18 live call): the caller introduced themselves
  // in their opening sentence; begin_call relayed it into state.volunteeredName.
  // The harness seeds it the same way, and the scenario forbids a re-ask.
  volunteeredName?: string;
  // ── batch 1-3 (2026-07-19, Dale: "more E2E with different types of calls") ──
  // A2 MIND-CHANGE: agree to an offered time, then in the SAME breath correct the
  // day ("actually, could we do Tuesday instead?"). Value = the day to correct to.
  correctsToDay?: string;
  // A3 MID-BOOKING BAIL: after hearing the offered times, abandon the booking and
  // ask for a callback message instead. Value = what to pass on.
  bailsFromBooking?: string;
  // B1 STUBBORN: reject the first offers and push ("anything earlier?") before
  // accepting the earliest time offered in the SECOND round.
  stubborn?: boolean;
  // B2 CLOSED-DAY: insist on a Saturday first (twice), then take a weekday.
  insistsClosedDay?: boolean;
  // C2: if the receptionist says booking is not possible and offers a message or
  // callback instead, accept it.
  acceptsMessageFallback?: boolean;
}

const STYLES: Record<string, string> = {
  plain: 'Answer naturally and directly, one short spoken sentence at a time.',
  terse: 'Answer in as few words as possible — often one or two words. Do not elaborate.',
  chatty:
    'Be warm and a bit chatty. Sometimes volunteer extra detail before being asked, and add small asides. Still get to the point.',
  frontloader:
    'In your VERY FIRST reply, cram in as much as you can at once — your name, number, and what you want, all in one breath. After that, answer what is asked.',
  corrector:
    'When you give your phone number the first time, say it slightly wrong or incompletely; then when they read it back or ask, correct it to the right one.',
  rambler:
    'Ramble a little — start answering, go off on a short tangent, then come back to the point. Never refuse to answer, just take a scenic route.',
};

function personaSystem(p: Persona, style: string): string {
  const facts = [
    `Your name: ${p.name}`,
    ...(p.volunteeredName
      ? [
          `You ALREADY introduced yourself as ${p.volunteeredName} at the very start of the call — if the receptionist greets you by name, that is expected. If they ask for your name anyway, give it, but do not re-introduce yourself unprompted.`,
        ]
      : []),
    p.refusesPhone
      ? `You will NOT give your phone number, no matter how many times asked. Politely decline every time.`
      : `Your phone number: ${p.phone} (give THIS exact number when asked; you may phrase the digits naturally, but the number itself is always ${p.phone}).`,
    `Why you called: ${p.goalLine}`,
  ];
  if (p.wantsScheduleChange) {
    facts.push(
      `You ALREADY have an appointment booked — a ${p.existingService ?? 'meeting'}. You are calling to ${p.scheduleAction === 'cancel' ? 'CANCEL that appointment' : 'RESCHEDULE (move) that appointment to a different time'}.`
    );
    if (p.scheduleAction === 'reschedule') {
      facts.push(
        `When the receptionist reads back your current appointment, confirm it is the one. When they offer available new times, pick ONE of the offered times and say it clearly.`
      );
    } else {
      facts.push(
        `When the receptionist reads back your current appointment and asks you to confirm you want it canceled, say yes.`
      );
    }
  }
  if (p.wantsToLeaveMessage && p.messageBody) {
    facts.push(
      `You want to leave a MESSAGE for the owner: "${p.messageBody}". When the receptionist asks what you'd like to pass on, say this in your own words. You do NOT want to book a meeting and you are NOT briefing a role — you just want the message passed along and (if it mentions one) a callback.`
    );
  }
  if (p.correctsToDay) {
    facts.push(
      `IMPORTANT: when they offer you meeting times and you pick one, in the SAME sentence change your mind about the DAY: "That time works — actually, wait, could we do ${p.correctsToDay} at that time instead?" You want ${p.correctsToDay}, not the day first offered. If they then offer times on ${p.correctsToDay}, take one. Do this correction exactly ONCE.`
    );
  }
  if (p.bailsFromBooking) {
    facts.push(
      `IMPORTANT: when they offer you meeting times, do NOT pick one. Say none of those work and you'd rather not book anything — ask them to just have the owner call you back. The message you want passed: "${p.bailsFromBooking}". Refuse any further times they offer; you only want the callback.`
    );
  }
  if (p.stubborn) {
    facts.push(
      `IMPORTANT: reject ALL the times in their FIRST offer — say none of those work and ask "is there anything earlier?" or "what else do you have?". When they come back with more times (or explain those are the earliest), accept the earliest time they name in that SECOND exchange. Do not drag it past two rounds.`
    );
  }
  if (p.insistsClosedDay) {
    facts.push(
      `IMPORTANT: you first want a SATURDAY appointment. Ask for Saturday explicitly. If they say Saturday is not available, push once more ("nothing at all on Saturday?"). After the second no, give in and accept an offered weekday time. Never accept a fabricated Saturday: if they DO offer you a Saturday time, take it (that is their mistake to make).`
    );
  }
  if (p.acceptsMessageFallback) {
    facts.push(
      `If the receptionist says the booking cannot be completed and offers to take a message or have the owner call you back, accept that offer and give your callback request.`
    );
  }
  if (p.hasQuestions && p.questionFacts) {
    facts.push(
      `You have QUESTIONS about the business: ${p.questionFacts} Ask them ONE at a time, listen to each answer, and once you have what you came for, say that's all you needed. You are just gathering information — do not book anything and do not leave a message unless the receptionist cannot answer and offers to have the owner get back to you.`
    );
  }
  if (p.wantsMeeting) {
    facts.push(
      p.deniesJob
        ? `You are NOT calling about a job, a role, or hiring — you have no such thing. If the receptionist asks which company you are from, whether you are hiring, about rates, or anything job-related, say plainly (in your own words): "No — this isn't about a job, I just want my computer fixed." Repeat it as often as needed; never invent job details to be polite.`
        : '',
      p.meetingNotesHint && !p.meetingNotesFact
        ? (() => {
            // Fail fast (review on #286): a hint without its fact would
            // interpolate the literal string "undefined" into the caller's
            // script and hollow the two-stage test out silently.
            throw new Error(`persona "${p.name}": meetingNotesHint requires meetingNotesFact`);
          })()
        : p.meetingNotesHint
          ? `If, after your booking is confirmed, the receptionist asks whether there's anything you'd like noted or known ahead of the meeting, FIRST say only: "${p.meetingNotesHint}" (in your own words) — do NOT state the concrete details yet. ONLY if they then ask you for the specific information itself (the actual address, number, etc.), give it: "${p.meetingNotesFact}". If they never ask for it, never volunteer it.`
          : p.meetingNotes
            ? `If, after your booking is confirmed, the receptionist asks whether there's anything you'd like noted or known ahead of the meeting, tell them: "${p.meetingNotes}" (in your own words). Do not volunteer it before they ask.`
            : `If asked whether there's anything you'd like noted ahead of the meeting, say no — you've covered everything.`
    );
  }
  if (p.hasJobInquiry) {
    facts.push(`The company you work for: ${p.callerCompany}`);
    if (p.inHouse) {
      facts.push(
        `You are hiring for YOUR OWN company (${p.callerCompany}) — if asked whether you're hiring for your own company or placing with a client, say your OWN company. There is no separate client.`
      );
    } else {
      facts.push(
        `You are placing someone with a CLIENT: ${p.clientCompany}. If asked whether it's your own company or a client, say a client, and name ${p.clientCompany}.`
      );
    }
    facts.push(`Employment type: ${p.employmentType === 'full_time' ? 'full time' : 'contract'}`);
    if (p.rate) facts.push(`Pay/rate: ${p.rate}`);
    if (p.length) facts.push(`Contract length: ${p.length}`);
    if (p.location) facts.push(`Location: ${p.location}`);
    if (p.address) facts.push(`Address of the position: ${p.address}`);
    if (p.timezone) facts.push(`Timezone: ${p.timezone}`);
    if (p.bailsToMessage) {
      facts.push(
        `IMPORTANT: you do NOT want to answer a string of questions about the role. The FIRST time the receptionist asks you a detail question about the job (which company, rate, contract length, location — any of them), refuse politely and pivot, in your own words: "Actually, I don't have time to go through all that — can you just take a message and have Dale call me back?" The message you want passed: "${p.bailsToMessage}". If they keep asking role questions anyway, repeat that you just want to leave a message. Never answer the detail questions.`
      );
    }
  }
  return `You are a person calling a small business's phone receptionist. You are the CALLER, not the assistant. Speak like a real person on the phone — short spoken turns, no lists, no markdown.

STYLE: ${STYLES[style]}

FACTS ABOUT YOU (answer truthfully from these, but only when relevant/asked):
${facts.map((f) => '- ' + f).join('\n')}

RULES:
- Reply with ONLY your spoken words for your next turn. No stage directions, no quotes.
- Answer the question you were actually asked. Give facts as they come up; do not dump everything unless your STYLE says to.
- If they ask something you already answered, you may say so briefly, then answer again.
- When the receptionist has clearly finished helping you (confirmed your booking and/or said they've passed your details along, and asks if there's anything else), say you're all set / no thanks — do not invent new requests.
- Never say you are an AI. Never narrate. Just talk.`;
}

async function callerReply(personaSys: string, shared: ChatMessage[]): Promise<string> {
  // The caller sees the call from ITS side: the agent's lines (role 'assistant' in the
  // shared history) are what the caller HEARD → 'user' to the caller model; the caller's
  // own prior lines (role 'user' in shared) are its own past turns → 'assistant'.
  const view: ChatMessage[] = [{ role: 'system', content: personaSys }];
  for (const m of shared) {
    if (m.role === 'assistant' && m.content) view.push({ role: 'user', content: m.content });
    else if (m.role === 'user' && m.content) view.push({ role: 'assistant', content: m.content });
  }
  const { content } = await openai(CALLER_MODEL, 0.9, view);
  return (content ?? 'Okay.').trim();
}

// ── DRIVER: run the whole call with a live caller ──────────────────────────────

interface RunResult {
  rungsCompleted: string[];
  rungsAttempted: string[];
  transcript: { who: 'agent' | 'caller'; text: string }[];
}

async function runCall(p: Persona, style: string, deps: CallDeps): Promise<RunResult> {
  const personaSys = personaSystem(p, style);
  const specs = planCallTasks(p, deps);
  const result: RunResult = { rungsCompleted: [], rungsAttempted: [], transcript: [] };

  // Shared conversation carried across rungs (mirrors TaskGroup's merged chatCtx, minus the
  // per-rung system prompt). The caller has continuous memory of the whole call.
  const shared: ChatMessage[] = [];

  // The caller opens the call.
  const opener = await callerReply(personaSys, [
    { role: 'assistant', content: 'Thanks for calling. How can I help you today?' },
  ]);
  result.transcript.push({ who: 'agent', text: 'How can I help you today?' });
  result.transcript.push({ who: 'caller', text: opener });
  shared.push({ role: 'user', content: opener });

  let totalTurns = 0;
  for (const spec of specs) {
    result.rungsAttempted.push(spec.id);
    const task = spec.factory() as unknown as {
      instructions: string;
      toolCtx: llm.ToolContext;
      done: boolean;
      completesOnEnter?: boolean;
      onEnter?: () => Promise<void>;
    };
    // A host-code skip (e.g. the notes rung when no meeting landed) completes in
    // onEnter with no session and no turn. Only rungs that FLAG it get this call —
    // a normal rung's onEnter needs the live session and would throw here.
    if (task.completesOnEnter && task.onEnter) {
      await task.onEnter();
      result.rungsCompleted.push(spec.id);
      continue;
    }
    const schemas = toolSchemas(task.toolCtx);
    const messages: ChatMessage[] = [{ role: 'system', content: task.instructions }, ...shared];

    for (let round = 0; round < 16 && !task.done && totalTurns < 60; round++) {
      totalTurns++;
      const { content, toolCalls } = await openai(AGENT_MODEL, 0, messages, schemas);

      if (toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: content ?? null, tool_calls: toolCalls });
        if (content) {
          result.transcript.push({ who: 'agent', text: content });
          shared.push({ role: 'assistant', content });
        }
        for (const tc of toolCalls) {
          const tool = task.toolCtx[tc.function.name] as
            | { execute: (a: unknown, o: unknown) => Promise<unknown> }
            | undefined;
          let res: unknown = `unknown tool ${tc.function.name}`;
          if (tool) {
            let args: unknown = {};
            try {
              args = JSON.parse(tc.function.arguments || '{}');
            } catch {
              /* {} */
            }
            res = await tool.execute(args, { ctx: {}, toolCallId: tc.id });
          }
          const rs = typeof res === 'string' ? res : JSON.stringify(res);
          if (process.env.SIM_TRACE)
            process.stderr.write(
              `      [tool] ${tc.function.name}(${(tc.function.arguments || '').slice(0, 120)}) -> ${rs.slice(0, 200)}\n`
            );
          messages.push({ role: 'tool', tool_call_id: tc.id, content: rs });
        }
        continue;
      }

      // Plain agent reply → speak it, then let the caller respond.
      const agentLine = content ?? '';
      messages.push({ role: 'assistant', content: agentLine });
      if (agentLine.trim()) {
        result.transcript.push({ who: 'agent', text: agentLine });
        shared.push({ role: 'assistant', content: agentLine });
      }
      if (task.done) break;

      const reply = await callerReply(personaSys, shared);
      result.transcript.push({ who: 'caller', text: reply });
      shared.push({ role: 'user', content: reply });
      messages.push({ role: 'user', content: reply });
    }

    if (task.done) result.rungsCompleted.push(spec.id);
    else break; // a rung that never completed blocks the ones after it (as the real loop would)
  }
  return result;
}

// ── SCENARIOS (persona + expectations) ─────────────────────────────────────────

interface Expect {
  appointment: boolean;
  jobInquiry: boolean;
  clientCompany?: string;
  representsCompany?: boolean;
  // schedule-change outcomes, checked against the seeded appointment
  canceled?: boolean;
  rescheduled?: boolean;
  // leave-a-message outcome — a customer_messages row must land (take_message fired)
  message?: boolean;
  // the spoken transcript must contain a KB FACT (proves the answer came from
  // retrieval, not invention) / must NOT contain an identity shakedown
  transcriptMatch?: RegExp;
  transcriptForbid?: RegExp;
  // the booked appointment's description must match (proves attach_meeting_notes /
  // the job-summary stamp actually WROTE to the calendar entry, not just spoke)
  descriptionMatch?: RegExp;
  // the job inquiry row must be LINKED to the appointment booked on this call
  jobLinked?: boolean;
  // the booked appointment's TENANT-LOCAL weekday must / must not be these
  // (0=Sun … 6=Sat). B2: a closed-day demand must never produce a weekend row.
  appointmentWeekday?: number[];
  appointmentWeekdayNot?: number[];
}
/** What a seed step handed back — the appointment the scenario will act on. */
interface SeedInfo {
  appointmentId: string;
  startTime: string;
}
interface Scenario {
  title: string;
  persona: Persona;
  expect: Expect;
  styles?: string[]; // default: a spread
  /** Insert the state the scenario acts on (e.g. an existing appointment to cancel). Runs
   *  AFTER the per-run cleanup, so each run acts on a fresh row. */
  seed?: (db: Client, p: Persona) => Promise<SeedInfo | null>;
  /** FAILURE INJECTION (batch 3): wrap the real tools before the run — e.g. make
   *  book_with_scheduling fail once with TIMESLOT_OCCUPIED (a lost race, as the DB
   *  would report it) or fail every time (backend hard-down). The wrapper returns
   *  what the REAL backend returns on failure: {success:false, error:"..."} — the
   *  same shape helpers.fail() sends, so the agent sees exactly production's sad path. */
  wrapTools?: (tools: llm.ToolContext) => llm.ToolContext;
}

const SEED_SERVICE_NAME = 'Programming Consultation';

/** POST to a backend agent-tool the way the agent would (x-agent-secret). */
async function postAgent(
  path: string,
  body: Record<string, unknown>
): Promise<{
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
}> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-secret': AGENT_SECRET },
    body: JSON.stringify(body),
  });
  return (await res.json()) as {
    success: boolean;
    result?: Record<string, unknown>;
    error?: string;
  };
}

/** "1:00 PM" / "4:30 PM" → local-naive 24h "13:00:00" / "16:30:00" for a booking window. */
function to24h(spoken: string): string {
  const m = spoken.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return '13:00:00';
  let h = Number(m[1]);
  const min = m[2];
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${min}:00`;
}

/**
 * Seed the appointment a cancel/reschedule call will act on — by BOOKING A REAL MEETING
 * through the production path (book_with_scheduling), NOT a raw INSERT. This is the point
 * Dale made: the thing you cancel has to be a real appointment, created the way a real one
 * is — so it carries a real service_id, an assigned employee, shift coverage, the lot. A
 * raw INSERT reproduced the NULL-service "blank calendar" bug; booking cannot.
 *
 * Books the earliest open slot in tomorrow's business window, then reads the row back for
 * the actual start_time (so the reschedule check can prove the time moved).
 */
async function seedAppointment(db: Client, p: Persona): Promise<SeedInfo> {
  // Find a REAL open slot first, then book that exact time — mirroring how the live agent
  // books (get_available_slots → book a targeted window). Passing a wide window and hoping
  // the RPC scans forward does NOT work: with the earliest slot occupied it collides rather
  // than advancing (the RPC expects a targeted window_from, which the model always gives it
  // after get_available_slots). So scan days for the first one with an open time.
  const zone = 'America/Chicago';
  let picked: { date: string; from: string } | null = null;
  for (let d = 1; d <= 8 && !picked; d++) {
    const date = new Date(Date.now() + d * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', {
      timeZone: zone,
    });
    const slots = await postAgent('/agent-tools/available-slots', {
      tenant_id: TENANT,
      service_type: SEED_SERVICE_NAME,
      date,
    });
    const open = (slots.result?.open_times as string[] | undefined) ?? [];
    if (open.length > 0) picked = { date, from: `${date}T${to24h(open[0])}` };
  }
  if (!picked) throw new Error('seed: no open slot found in the next 8 days');
  const booked = await postAgent('/agent-tools/book-with-scheduling', {
    tenant_id: TENANT,
    phone: p.phone,
    name: p.name,
    description: 'Booking via SecretaryHQ',
    call_id: `sim-seed-${p.phone}`,
    requirements: { serviceType: SEED_SERVICE_NAME },
    // Narrow window AT the open slot — book exactly that time.
    window: { from: picked.from, to: `${picked.date}T17:00:00` },
  });
  if (!booked.success || !booked.result?.appointment_id) {
    throw new Error(`seed booking failed: ${booked.error ?? JSON.stringify(booked.result)}`);
  }
  const appointmentId = String(booked.result.appointment_id);
  const row = await db.query<{ start_time: string }>(
    `SELECT start_time FROM appointments WHERE appointment_id = $1`,
    [appointmentId]
  );
  return { appointmentId, startTime: row.rows[0]?.start_time };
}

/**
 * Seed the knowledge base the Q&A scenarios retrieve from — through the REAL ingestion
 * path (/knowledge/add computes real embeddings server-side), not a raw INSERT, for the
 * same reason seedAppointment books through the real RPC: test data created any other
 * way dodges the machinery under test. Idempotent: prior sim-qa docs are wiped first.
 */
async function seedKnowledgeBase(db: Client): Promise<SeedInfo | null> {
  await db.query(`DELETE FROM tenant_docs WHERE tenant_id = $1 AND source = 'sim-qa'`, [TENANT]);
  // Local seed credentials (documented in CLAUDE.md's Logins section), overridable so
  // the harness isn't welded to one account: SIM_LOGIN_EMAIL / SIM_LOGIN_PASSWORD.
  const login = await fetch(`${BACKEND_URL}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: process.env.SIM_LOGIN_EMAIL || 'daledemott@gmail.com',
      password: process.env.SIM_LOGIN_PASSWORD || 'p@ssw0rd',
    }),
  });
  const auth = (await login.json()) as { success: boolean; token?: string };
  if (!auth.success || !auth.token) throw new Error('seedKnowledgeBase: login failed');
  const DOCS = [
    {
      question: 'How much does a programming consultation cost?',
      answer:
        'A programming consultation is $149 for a 30-minute session, payable after the meeting.',
    },
    {
      question: 'Can consultations be done remotely?',
      answer:
        'Yes — consultations can be held remotely over video call, or in person at the office.',
    },
  ];
  for (const doc of DOCS) {
    const r = await fetch(`${BACKEND_URL}/knowledge/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ ...doc, category: 'faq', source: 'sim-qa' }),
    });
    const j = (await r.json()) as { success: boolean };
    if (!j.success) throw new Error(`seedKnowledgeBase: /knowledge/add failed (${r.status})`);
  }
  return null;
}

const DEFAULT_STYLES = ['plain', 'terse', 'chatty', 'frontloader', 'corrector', 'rambler'];

/** Wrap ONE tool so its first N calls fail with the REAL failure shape the agent's
 *  formatter emits — {"error": "...", "error_code"?} with NO success field (review on
 *  #290: injecting {success:false} proved a gate that production shapes never fire).
 *  failures=Infinity → hard-down. Counts per RUN, so scenarios stay independent. */
function failTool(
  toolName: string,
  failures: number,
  errorBody: string,
  errorCode?: string
): (tools: llm.ToolContext) => llm.ToolContext {
  return (tools) => {
    let failed = 0;
    const real = tools[toolName] as { execute: (a: unknown, o: unknown) => Promise<unknown> };
    if (!real) throw new Error(`failTool: no such tool ${toolName}`);
    return {
      ...tools,
      [toolName]: {
        ...(real as object),
        execute: async (a: unknown, o: unknown) => {
          if (failed < failures) {
            failed++;
            return JSON.stringify(
              errorCode ? { error: errorBody, error_code: errorCode } : { error: errorBody }
            );
          }
          return real.execute(a, o);
        },
      } as llm.ToolContext[string],
    };
  };
}

const SCENARIOS: Scenario[] = [
  {
    title: 'meeting + job (the two-goal baseline)',
    persona: {
      name: 'Priya Nowak',
      phone: '555-901-0001',
      goalLine: 'you want a meeting with Dale to talk about a contract role',
      wantsMeeting: true,
      hasJobInquiry: true,
      requestedService: 'a meeting about a contract role',
      callerCompany: 'Insight Global',
      clientCompany: 'Blue Cross',
      employmentType: 'contract',
      rate: '$70 to $80 an hour',
      length: 'twelve months',
      location: 'hybrid',
      address: '200 East Randolph, Chicago',
    },
    expect: {
      appointment: true,
      jobInquiry: true,
      clientCompany: 'Blue Cross',
      representsCompany: false,
      // The meeting and the role are ONE story now: the inquiry row links to the
      // appointment, and the calendar entry says what the meeting is about.
      jobLinked: true,
      descriptionMatch: /Job details:/,
    },
  },
  {
    title: 'meeting only — must NOT fabricate a job inquiry',
    persona: {
      name: 'Grace Okoro',
      phone: '555-901-0002',
      goalLine: 'you just want to book a meeting with Dale (no job talk)',
      wantsMeeting: true,
      hasJobInquiry: false,
      requestedService: 'a meeting with Dale',
    },
    expect: { appointment: true, jobInquiry: false },
    styles: ['plain', 'terse', 'frontloader'],
  },
  {
    title: 'meeting with a NOTE — the wrap-up answer lands on the calendar entry',
    persona: {
      name: 'Theo Marsh',
      phone: '555-901-0013',
      goalLine: 'you want to book a meeting with Dale about some consulting work',
      wantsMeeting: true,
      hasJobInquiry: false,
      requestedService: 'a consulting meeting',
      meetingNotes:
        'the project involves migrating an old COBOL system, so he should look at that before the meeting',
    },
    // The distinctive token proves the WRITE: "COBOL" can only reach the appointment's
    // description through attach_meeting_notes — a spoken "I'll note that" leaves no row.
    expect: {
      appointment: true,
      jobInquiry: false,
      descriptionMatch: /Caller notes:.*COBOL/is,
    },
    styles: ['plain', 'chatty'],
  },
  {
    title: 'CURVEBALL: a note that only POINTS at info — the agent must ask for the thing itself',
    persona: {
      name: 'Wade Boggs',
      phone: '555-901-0021',
      goalLine: 'you want to book a meeting for Dale to come fix your computer',
      wantsMeeting: true,
      hasJobInquiry: false,
      requestedService: 'fixing my computer',
      meetingNotesHint: "he'll need my address, since he's coming out to fix the computer",
      meetingNotesFact: 'the address is 1060 West Addison Street in Chicago',
    },
    // The live 2026-07-18 call: the caller said "he needs to know my address"
    // and the agent attached "his address is needed" — a pointer, not the
    // address. The owner opened the meeting with nowhere to go. "Addison" can
    // only reach the description if the agent ASKED for the address and
    // attached what the caller then said.
    expect: {
      appointment: true,
      jobInquiry: false,
      descriptionMatch: /Caller notes:.*(1060|Addison)/is,
    },
    styles: ['plain', 'chatty'],
  },
  {
    title: 'MISROUTE: intent flapped a repair into a job — not_a_job escapes, nobody is trapped',
    persona: {
      name: 'Jan Smith',
      phone: '555-901-0031',
      goalLine: 'you want to book a time for Dale to come fix your computer at your house',
      wantsMeeting: true,
      // TRUE ON PURPOSE: this simulates the intent step's flap (the live
      // 2026-07-18 call classified "fix my computer at my house" as a job).
      hasJobInquiry: true,
      requestedService: 'fixing my computer',
      deniesJob: true,
    },
    // The booking lands; NO job inquiry row exists (the rung escaped via
    // not_a_job instead of interrogating or fabricating); the run completes
    // instead of hanging on an unfinishable rung.
    expect: { appointment: true, jobInquiry: false },
    styles: ['plain', 'chatty'],
  },
  {
    title: 'MID-INTAKE BAIL: real job caller refuses the interview — "just take a message" is a real write',
    persona: {
      name: 'Priya Nair',
      phone: '555-901-0032',
      goalLine:
        'you have a role you want Dale to hear about, but you are in a hurry and will not sit through detail questions',
      wantsMeeting: false,
      hasJobInquiry: true,
      requestedService: 'a role for Dale',
      callerCompany: 'Insight Global',
      clientCompany: 'Allstate',
      employmentType: 'contract',
      bailsToMessage:
        'Priya from Insight Global called about a contract role at Allstate — please call her back at this number',
    },
    // The live 2026-07-18 trap in its OTHER direction: a real job call where the
    // caller pivots mid-questions. Before the fallback, the rung held no
    // take_message and the agent refused ("I'm unable to take messages"). Now
    // the pivot must land a customer_messages row; no job_inquiries row (the
    // interview never finished) and no fabricated answers.
    expect: { appointment: false, jobInquiry: false, message: true },
    styles: ['plain'],
  },
  {
    title: 'FRONT-LOADED NAME: the caller already introduced themselves — never re-asked',
    persona: {
      name: 'Marcus Webb',
      phone: '555-901-0033',
      goalLine: 'you want to book a meeting with Dale about some consulting work',
      wantsMeeting: true,
      hasJobInquiry: false,
      requestedService: 'a consulting meeting',
      volunteeredName: 'Marcus Webb',
    },
    // The live 2026-07-18 call: "I'm Dale" → "Can I get your name, please?".
    // begin_call now relays the volunteered name into state; the identity rung is
    // seeded with it and must GREET, not re-ask. The forbid catches the exact
    // phrasings of a re-ask; the booking must still land (the rung still collects
    // and confirms the number).
    expect: {
      appointment: true,
      jobInquiry: false,
      transcriptForbid: /(get|have|what'?s|catch) your name|your name, please/i,
    },
    styles: ['plain'],
  },
  {
    // ── BATCH 1 (2026-07-19): mid-call pivots ──
    title: 'MULTI-GOAL: book a NEW meeting AND cancel the existing one — both writes land',
    persona: {
      name: 'Elena Ruiz',
      phone: '555-901-0034',
      goalLine:
        'you want TWO things on this one call: book a NEW meeting with Dale about a website project, AND cancel the other appointment you already have booked',
      wantsMeeting: true,
      hasJobInquiry: false,
      wantsScheduleChange: true,
      scheduleAction: 'cancel',
      existingService: 'Programming Consultation',
      requestedService: 'a meeting about a website project',
    },
    seed: seedAppointment,
    // The plan runs book THEN schedule_change; the seeded row must end canceled AND a
    // new row must exist. verify() checks the new row is NOT the seeded one.
    expect: { appointment: true, jobInquiry: false, canceled: true },
    styles: ['plain'],
  },
  {
    title: 'MIND-CHANGE: caller agrees to a time then corrects the day in the same breath',
    persona: {
      name: 'Tom Baker',
      phone: '555-901-0035',
      goalLine: 'you want to book a consulting meeting with Dale, ideally Monday',
      wantsMeeting: true,
      hasJobInquiry: false,
      requestedService: 'a consulting meeting',
      correctsToDay: 'Tuesday',
    },
    // The agent must book what the caller MEANS (Tuesday), not what they first agreed
    // to — a booking fired on the first "that works" ignores the correction that
    // followed it. dow 2 = Tuesday in tenant-local time.
    expect: { appointment: true, jobInquiry: false, appointmentWeekday: [2] },
    styles: ['plain'],
  },
  {
    title: 'MID-BOOKING BAIL: none of the times work — callback message instead, no booking',
    persona: {
      name: 'Rita Chow',
      phone: '555-901-0036',
      goalLine: 'you wanted to see about a meeting with Dale, but no offered time will suit you',
      wantsMeeting: true,
      hasJobInquiry: false,
      requestedService: 'a meeting with Dale',
      bailsFromBooking: 'Rita called about working together — please have Dale call her back',
    },
    // The booking rung's take_message FALLBACK is the honest exit: no appointment row,
    // a real customer_messages row. "I'll have him call you" without the write is the
    // exact lie the fallback exists to prevent.
    expect: { appointment: false, jobInquiry: false, message: true },
    styles: ['plain'],
  },
  {
    // ── BATCH 2 (2026-07-19): renegotiation exhaustion ──
    title: 'STUBBORN: rejects the first offers, asks for earlier — booking still lands honestly',
    persona: {
      name: 'Hank Voss',
      phone: '555-901-0037',
      goalLine: 'you want a consulting meeting with Dale, but you are picky about the time',
      wantsMeeting: true,
      hasJobInquiry: false,
      requestedService: 'a consulting meeting',
      stubborn: true,
    },
    expect: { appointment: true, jobInquiry: false },
    styles: ['plain'],
  },
  {
    title: 'CLOSED-DAY: insists on Saturday — never booked on a weekend, lands on a weekday',
    persona: {
      name: 'Gwen Park',
      phone: '555-901-0038',
      goalLine: 'you want a consulting meeting with Dale, and Saturday is your strong preference',
      wantsMeeting: true,
      hasJobInquiry: false,
      requestedService: 'a consulting meeting',
      insistsClosedDay: true,
    },
    // The business is Mon-Fri. A Saturday row would mean the agent invented an opening
    // the grid never offered (dow 0/6 forbidden); the caller gives in after two nos.
    expect: { appointment: true, jobInquiry: false, appointmentWeekdayNot: [0, 6] },
    styles: ['plain'],
  },
  {
    // ── BATCH 3 (2026-07-19): failure injection ──
    title: 'RACE: booking fails once with TIMESLOT_OCCUPIED — agent re-offers and lands it',
    persona: {
      name: 'Omar Haddad',
      phone: '555-901-0039',
      goalLine: 'you want to book a consulting meeting with Dale; be flexible about times',
      wantsMeeting: true,
      hasJobInquiry: false,
      requestedService: 'a consulting meeting',
    },
    wrapTools: failTool(
      'book_with_scheduling',
      1,
      'That time was just taken by another booking. Offer the caller a different time.',
      'TIMESLOT_OCCUPIED'
    ),
    // Exactly what a lost race looks like in production (GiST exclusion under
    // READ COMMITTED): first attempt fails, the slot is gone. The agent must
    // recover WITHIN the call — re-offer, book again — not claim success.
    expect: { appointment: true, jobInquiry: false },
    styles: ['plain'],
  },
  {
    title: 'HARD-DOWN: booking fails every attempt — honest fallback to a message, no false "you\'re booked"',
    persona: {
      name: 'June Adler',
      phone: '555-901-0040',
      goalLine: 'you want to book a consulting meeting with Dale',
      wantsMeeting: true,
      hasJobInquiry: false,
      requestedService: 'a consulting meeting',
      acceptsMessageFallback: true,
    },
    wrapTools: failTool(
      'book_with_scheduling',
      Number.POSITIVE_INFINITY,
      'The booking system is temporarily unavailable.',
      'INTERNAL_ERROR'
    ),
    // The worst case: the write path is down. The ONLY honest exits are a real
    // message row or a truthful "I could not book it" — a spoken confirmation with
    // no row behind it is the cardinal sin. transcriptForbid pins the phrasings.
    expect: {
      appointment: false,
      jobInquiry: false,
      message: true,
      transcriptForbid: /you'?re (all set|booked)|booked you in|your appointment is (set|confirmed)/i,
    },
    styles: ['plain'],
  },
  {
    title: 'job only — records it, does NOT book a meeting',
    persona: {
      name: 'Sam Devlin',
      phone: '555-901-0003',
      goalLine: 'you just want to pass a role to Dale, no meeting needed',
      wantsMeeting: false,
      hasJobInquiry: true,
      requestedService: 'passing a role to Dale',
      callerCompany: 'TEKsystems',
      clientCompany: 'Northern Trust',
      employmentType: 'full_time',
      rate: '$150k to $180k',
      location: 'onsite',
      address: '10 South Wacker, Chicago',
    },
    expect: {
      appointment: false,
      jobInquiry: true,
      clientCompany: 'Northern Trust',
      representsCompany: false,
    },
    styles: ['plain', 'chatty', 'rambler'],
  },
  {
    title: 'in-house recruiter — must NOT double-ask the company',
    persona: {
      name: 'Dana Feld',
      phone: '555-901-0004',
      goalLine: 'you have a role at your own company and want to reach Dale',
      wantsMeeting: false,
      hasJobInquiry: true,
      requestedService: 'a role at our company',
      callerCompany: 'Globex',
      inHouse: true,
      employmentType: 'contract',
      rate: '$90 an hour',
      length: 'six months',
      location: 'remote',
      timezone: 'Central',
    },
    expect: {
      appointment: false,
      jobInquiry: true,
      clientCompany: 'Globex',
      representsCompany: true,
    },
    styles: ['plain', 'terse'],
  },
  {
    title: 'cancel an existing appointment',
    persona: {
      name: 'Owen Pratt',
      phone: '555-901-0007',
      goalLine: 'you want to cancel an appointment you already have',
      wantsMeeting: false,
      hasJobInquiry: false,
      wantsScheduleChange: true,
      scheduleAction: 'cancel',
      existingService: 'Programming Consultation',
      requestedService: 'canceling my appointment',
    },
    expect: { appointment: false, jobInquiry: false, canceled: true },
    seed: seedAppointment,
    styles: ['plain', 'chatty'],
  },
  {
    title: 'reschedule an existing appointment',
    persona: {
      name: 'Mara Quinn',
      phone: '555-901-0008',
      goalLine: 'you want to move an appointment you already have to a different time',
      wantsMeeting: false,
      hasJobInquiry: false,
      wantsScheduleChange: true,
      scheduleAction: 'reschedule',
      existingService: 'Programming Consultation',
      requestedService: 'moving my appointment',
    },
    expect: { appointment: false, jobInquiry: false, rescheduled: true },
    seed: seedAppointment,
    styles: ['plain', 'terse'],
  },
  {
    title: 'leave a message — records it with take_message',
    persona: {
      name: 'Bill Turner',
      phone: '555-901-0009',
      goalLine: 'you want to leave a message for the owner',
      wantsMeeting: false,
      hasJobInquiry: false,
      wantsToLeaveMessage: true,
      requestedService: 'leaving a message',
      messageBody: 'the shipment from the warehouse is running two days late',
    },
    expect: { appointment: false, jobInquiry: false, message: true },
    styles: ['plain', 'terse', 'chatty'],
  },
  {
    title: 'MESSAGE that mentions a job + callback — still a message, NOT a job inquiry',
    persona: {
      name: 'Jack Smith',
      phone: '555-901-0010',
      goalLine: 'you want to leave a message for the owner',
      wantsMeeting: false,
      hasJobInquiry: false,
      wantsToLeaveMessage: true,
      requestedService: 'leaving a message',
      messageBody: 'tell him I have a job for him and I would like him to give me a callback',
    },
    // The 2026-07-16 live failure, made structural: the message mentions "a job" and "a
    // callback", but the caller ASKED to leave a message — so it must record a message and
    // must NOT open a job inquiry or book a meeting.
    expect: { appointment: false, jobInquiry: false, message: true },
    styles: ['plain', 'terse', 'frontloader'],
  },
  {
    title: 'QUESTIONS ONLY: answered from the KB, no identity shakedown',
    persona: {
      name: 'Nora Fields',
      phone: '555-901-0011',
      goalLine: 'you are just calling with a couple of questions about the business',
      wantsMeeting: false,
      hasJobInquiry: false,
      hasQuestions: true,
      requestedService: 'a couple of questions',
      questionFacts:
        'you want to know (1) how much a programming consultation costs, and (2) whether consultations can be done remotely over video.',
    },
    // The $149 figure exists ONLY in the seeded KB — if it reaches the transcript,
    // the answer came from retrieval. And a questions-only caller must never be
    // asked for a phone number (the identity rung is skipped by design).
    expect: {
      appointment: false,
      jobInquiry: false,
      transcriptMatch: /149/,
      transcriptForbid: /best (phone )?number|number to reach/i,
    },
    seed: seedKnowledgeBase,
    styles: ['plain', 'terse'],
  },
  {
    title: 'QUESTIONS then BOOKING: price answered first, meeting still lands',
    persona: {
      name: 'Iris Chen',
      phone: '555-901-0012',
      goalLine:
        'you want to know what a programming consultation costs, and if the price is reasonable you want to book one',
      wantsMeeting: true,
      hasJobInquiry: false,
      hasQuestions: true,
      requestedService: 'a programming consultation',
      questionFacts:
        'you want to know how much a programming consultation costs before you commit. Any price under $500 is fine — once you hear it, go ahead and book.',
    },
    expect: { appointment: true, jobInquiry: false, transcriptMatch: /149/ },
    seed: seedKnowledgeBase,
    styles: ['plain'],
  },
  {
    title: 'STRESS: caller refuses to give a phone number',
    persona: {
      name: 'Robin Vance',
      phone: '555-901-0006',
      goalLine: 'you want a meeting but will not share a phone number',
      wantsMeeting: true,
      hasJobInquiry: false,
      requestedService: 'a meeting',
      refusesPhone: true,
    },
    // No number → identity can't complete → no booking. Documents the limit.
    expect: { appointment: false, jobInquiry: false },
    styles: ['plain'],
  },
];

async function verify(db: Client, p: Persona, e: Expect, seed?: SeedInfo): Promise<string[]> {
  const fails: string[] = [];
  const e164 = '+1' + p.phone.replace(/\D/g, '');

  // Schedule-change scenarios act on the SEEDED appointment (by id), so check that row
  // directly and skip the generic "was a new appointment booked?" checks below.
  const isScheduleChange = Boolean(e.canceled || e.rescheduled);
  if (isScheduleChange && seed) {
    // The seeded appointment must carry a real service_id — a NULL service is the
    // "blank on the owner's calendar" bug; test data must not reproduce it.
    const r = await db.query<{ service_id: string | null }>(
      `SELECT service_id FROM appointments WHERE appointment_id = $1`,
      [seed.appointmentId]
    );
    if (r.rows[0] && !r.rows[0].service_id)
      fails.push('seeded appointment has a NULL service_id (should be a real service)');
  }
  if (e.canceled) {
    const r = await db.query<{ status: string }>(
      `SELECT status FROM appointments WHERE appointment_id = $1`,
      [seed?.appointmentId]
    );
    const status = r.rows[0]?.status;
    if (status !== 'canceled') fails.push(`expected appointment CANCELED, status is "${status}"`);
  }
  if (e.rescheduled) {
    const r = await db.query<{ status: string; start_time: string }>(
      `SELECT status, start_time FROM appointments WHERE appointment_id = $1`,
      [seed?.appointmentId]
    );
    const row = r.rows[0];
    if (!row) fails.push('rescheduled appointment vanished');
    else if (row.status !== 'scheduled')
      fails.push(`expected RESCHEDULED (still scheduled), status is "${row.status}"`);
    else if (String(row.start_time) === String(seed?.startTime))
      fails.push('expected RESCHEDULED to a new time, but start_time is unchanged');
  }

  let bookedApptId: string | null = null;
  // A multi-goal call (book AND cancel, batch 1) expects BOTH: the seeded row checked
  // above, and a NEW appointment below. Pure schedule-change scenarios keep skipping
  // the generic block — the seeded row would satisfy it vacuously.
  if (!isScheduleChange || e.appointment) {
    const appt = await db.query<{
      service: string | null;
      appointment_id: string;
      description: string | null;
    }>(
      `SELECT s.name AS service, a.appointment_id, a.description FROM appointments a
         LEFT JOIN services s USING (service_id)
         JOIN customers c USING (customer_id)
        WHERE a.tenant_id = $1 AND c.phone = $2 ORDER BY a.created_at DESC LIMIT 1`,
      [TENANT, e164]
    );
    // On a multi-goal call the latest row must be a NEW booking, not the seeded one.
    const newest = appt.rows[0] && appt.rows[0].appointment_id !== seed?.appointmentId ? appt.rows[0] : undefined;
    if (e.appointment && !newest) fails.push('expected a NEW APPOINTMENT, none found');
    if (!e.appointment && newest) fails.push('APPOINTMENT booked but none expected');
    if (e.appointment && newest && !newest.service) fails.push('appointment service is NULL');
    bookedApptId = newest?.appointment_id ?? null;
    if ((e.appointmentWeekday || e.appointmentWeekdayNot) && newest) {
      const dowRow = await db.query<{ dow: number }>(
        `SELECT extract(dow from start_time AT TIME ZONE 'America/Chicago')::int AS dow
           FROM appointments WHERE appointment_id = $1`,
        [newest.appointment_id]
      );
      const dow = dowRow.rows[0]?.dow;
      if (e.appointmentWeekday && dow !== undefined && !e.appointmentWeekday.includes(dow))
        fails.push(`appointment landed on weekday ${dow}, expected one of ${e.appointmentWeekday}`);
      if (e.appointmentWeekdayNot && dow !== undefined && e.appointmentWeekdayNot.includes(dow))
        fails.push(`appointment landed on FORBIDDEN weekday ${dow} (closed day)`);
    }
    // The WRITE, not the words: the note / job summary must be ON the calendar entry.
    if (e.descriptionMatch && newest && !e.descriptionMatch.test(newest.description ?? ''))
      fails.push(
        `appointment description does not match ${e.descriptionMatch} — got "${newest.description ?? ''}"`
      );
  }

  const job = await db.query<{
    client_company: string | null;
    represents_company: boolean | null;
    appointment_id: string | null;
  }>(
    `SELECT client_company, represents_company, appointment_id FROM job_inquiries
      WHERE tenant_id = $1 AND callback_phone = $2 ORDER BY created_at DESC LIMIT 1`,
    [TENANT, e164]
  );
  if (e.jobInquiry && !job.rows[0]) fails.push('expected JOB INQUIRY, none found');
  if (!e.jobInquiry && job.rows[0]) fails.push('JOB INQUIRY recorded but none expected');
  if (e.clientCompany && job.rows[0] && job.rows[0].client_company !== e.clientCompany)
    fails.push(`client_company="${job.rows[0].client_company}", expected "${e.clientCompany}"`);
  if (
    e.representsCompany !== undefined &&
    job.rows[0] &&
    job.rows[0].represents_company !== e.representsCompany
  )
    fails.push(
      `represents_company=${job.rows[0].represents_company}, expected ${e.representsCompany}`
    );
  // A "meeting about a job" call must link the inquiry to THE meeting it booked — the
  // owner opens the calendar entry and the role context is one click away, not a hunt.
  if (e.jobLinked && job.rows[0]) {
    if (!job.rows[0].appointment_id)
      fails.push('expected job inquiry LINKED to the appointment, but appointment_id is NULL');
    else if (bookedApptId && job.rows[0].appointment_id !== bookedApptId)
      fails.push('job inquiry is linked to a DIFFERENT appointment than the one booked');
  }

  // Leave-a-message: the whole point is take_message ACTUALLY firing. Verify a
  // customer_messages row landed for this caller (not that the agent SAID it did).
  const msg = await db.query<{ message: string | null }>(
    `SELECT message FROM customer_messages
      WHERE tenant_id = $1 AND callback_phone = $2 ORDER BY created_at DESC LIMIT 1`,
    [TENANT, e164]
  );
  if (e.message && !msg.rows[0])
    fails.push('expected a MESSAGE recorded, none found (take_message never fired)');
  if (e.message && msg.rows[0] && !msg.rows[0].message?.trim())
    fails.push('message row recorded but the message body is empty');

  return fails;
}

function makeDeps(): CallDeps {
  const ctx: SessionContext = {
    tenantId: TENANT,
    callerPhone: null,
    callId: `sim-tg-${Date.now()}-${Math.floor(performance.now())}`,
    roomName: 'sim-tg',
    participantIdentity: 'sim',
  };
  const client = new ToolsClient({ backendUrl: BACKEND_URL, agentSecret: AGENT_SECRET });
  // The outcome tracker, exactly as index.ts wires it: book_with_scheduling records the
  // appointment_id on it, and capture_job_inquiry / attach_meeting_notes read it back —
  // the SYSTEM carries the meeting id, never the model. Without this the sim would test
  // a plumbing the live agent doesn't have (and vice versa).
  const tools = buildTools(ctx, client, undefined, new CallOutcomeTracker());
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Chicago',
  });
  return {
    ctx,
    state: {},
    runtime: {
      currentDate,
      timezone: 'America/Chicago',
      businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
      bookableThrough: null,
    },
    tools,
  };
}

async function main(): Promise<void> {
  initializeLogger({ pretty: false, level: 'silent' });
  const stylesEnv = (process.env.SIM_STYLES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const chosen = SCENARIOS.filter(
    (s) => !CASE_FILTER || s.title.toLowerCase().includes(CASE_FILTER.toLowerCase())
  );
  console.log(
    `${C.b}Task-group E2E — live LLM caller${C.x} ${C.d}(agent ${AGENT_MODEL}, caller ${CALLER_MODEL})${C.x}`
  );

  const db = DB_URL ? new Client({ connectionString: DB_URL }) : null;
  if (db) await db.connect();

  let runs = 0;
  let passed = 0;
  const failures: {
    title: string;
    style: string;
    fails: string[];
    transcript: RunResult['transcript'];
  }[] = [];

  try {
    for (const sc of chosen) {
      const styles = stylesEnv.length ? stylesEnv : (sc.styles ?? DEFAULT_STYLES);
      console.log(`\n${C.b}${sc.title}${C.x}`);
      for (const style of styles) {
        for (let r = 0; r < RUNS; r++) {
          // reset this caller's rows so each run is deterministic
          let seedInfo: SeedInfo | undefined;
          if (db) {
            const e164 = '+1' + sc.persona.phone.replace(/\D/g, '');
            await db.query(`DELETE FROM job_inquiries WHERE tenant_id=$1 AND callback_phone=$2`, [
              TENANT,
              e164,
            ]);
            await db.query(
              `DELETE FROM customer_messages WHERE tenant_id=$1 AND callback_phone=$2`,
              [TENANT, e164]
            );
            await db.query(
              `DELETE FROM appointments WHERE tenant_id=$1 AND customer_id IN (SELECT customer_id FROM customers WHERE tenant_id=$1 AND phone=$2)`,
              [TENANT, e164]
            );
            // Seed AFTER the wipe, so the scenario acts on a fresh appointment. A seed
            // failure (e.g. a contended calendar) must NOT crash the whole suite — record it
            // as this run's failure and move on, so one bad seed can't hide 30 good runs.
            if (sc.seed) {
              try {
                seedInfo = (await sc.seed(db, sc.persona)) ?? undefined;
              } catch (err) {
                runs++;
                failures.push({
                  title: sc.title,
                  style,
                  fails: [`SEED FAILED: ${(err as Error).message}`],
                  transcript: [],
                });
                console.log(`  ${style.padEnd(11)} ${C.r}SEED-ERR${C.x} ${(err as Error).message}`);
                continue;
              }
            }
          }
          runs++;
          const deps = makeDeps();
          if (sc.persona.volunteeredName) deps.state.volunteeredName = sc.persona.volunteeredName;
          if (sc.wrapTools) deps.tools = sc.wrapTools(deps.tools);
          let res: RunResult;
          try {
            res = await runCall(sc.persona, style, deps);
          } catch (err) {
            failures.push({
              title: sc.title,
              style,
              fails: [`THREW: ${(err as Error).message}`],
              transcript: [],
            });
            console.log(`  ${style.padEnd(11)} ${C.r}ERROR${C.x} ${(err as Error).message}`);
            continue;
          }
          const dbFails = db ? await verify(db, sc.persona, sc.expect, seedInfo) : [];
          const spoken = res.transcript.map((t) => t.text).join(' ');
          if (sc.expect.transcriptMatch && !sc.expect.transcriptMatch.test(spoken))
            dbFails.push(
              `transcript never contained ${sc.expect.transcriptMatch} — the KB fact was not spoken`
            );
          if (sc.expect.transcriptForbid && sc.expect.transcriptForbid.test(spoken))
            dbFails.push(`transcript matched forbidden ${sc.expect.transcriptForbid}`);
          const rungInfo = `${res.rungsCompleted.length}/${res.rungsAttempted.length} rungs`;
          if (dbFails.length === 0) {
            passed++;
            console.log(`  ${style.padEnd(11)} ${C.g}PASS${C.x} ${C.d}(${rungInfo})${C.x}`);
          } else {
            failures.push({ title: sc.title, style, fails: dbFails, transcript: res.transcript });
            console.log(
              `  ${style.padEnd(11)} ${C.r}FAIL${C.x} ${C.d}(${rungInfo})${C.x} — ${dbFails.join('; ')}`
            );
          }
        }
      }
    }
  } finally {
    if (db) await db.end();
  }

  console.log(`\n${passed === runs ? C.g : C.r}${passed}/${runs} runs passed${C.x}`);

  // Dump transcripts of failures so the cause is visible without re-running.
  if (failures.length) {
    console.log(`\n${C.b}── FAILURE TRANSCRIPTS ──${C.x}`);
    for (const f of failures) {
      console.log(`\n${C.r}✗ ${f.title} [${f.style}]${C.x} — ${f.fails.join('; ')}`);
      for (const t of f.transcript) {
        console.log(`   ${t.who === 'agent' ? C.b + 'AGENT ' : C.d + 'caller'}${C.x} ${t.text}`);
      }
    }
  }

  process.exit(passed === runs ? 0 : 1);
}

main().catch((err) => {
  console.error(`sim-taskgroup: ${(err as Error).stack || err}`);
  process.exit(1);
});
