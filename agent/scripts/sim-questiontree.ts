/**
 * QUESTION-TREE MOCK CALLS — a LIVE LLM plays the caller against the REAL
 * conversation layer. Question-tree phase 4, step 1
 * (docs/QUESTION_TREE_ARCHITECTURE.md §4.4).
 *
 * What is REAL: the ChecklistAgent prompt (buildChecklistPrompt), the real
 * toolset (createChecklistTools over the real ChecklistTracker + the real
 * platform trees), and both LLMs — the agent model converses and records, a
 * second LLM improvises as the caller with a persona, differently every run.
 *
 * What is FAKED: the backend tools (book/take_message/capture/RAG return
 * canned success JSON). That is the point of this tier — it grades whether the
 * MODEL can drive the checklist through a real conversation, and it grades on
 * the TRACKER'S FINAL SNAPSHOT (structured ground truth), not transcript
 * pattern-matching. The full-backend + DB-verified tier is the sim-taskgroup
 * pattern and comes when this tier is clean.
 *
 * Run:  cd agent && npx tsx scripts/sim-questiontree.ts
 *   env: OPENAI_API_KEY (repo-root .env is loaded)
 *   SIM_CASE=<substr>      run only matching scenarios
 *   SIM_BUSINESS=a,b,c     VERTICAL MODE (T-008): instead of the scripted
 *                          scenarios, generate one intake call per business_type
 *                          and grade that the vertical's OWN intake tree fired.
 *                          The SELECTABLE tree ids are compiled from that
 *                          business_type's preset exactly as production does
 *                          (the library handed to the agent stays the full
 *                          platform set), so a tree the preset withholds is
 *                          unreachable here too.
 *   SIM_RUNS=N             runs per scenario (default 1)
 *   SIM_TRACE=1            print every line + tool call
 *   SIM_QT_MODEL=…         agent model (default gpt-4.1-mini — the prod voice LLM)
 *   SIM_CALLER_MODEL=…     caller model (default gpt-4o-mini)
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: new URL('../../.env', import.meta.url).pathname });
loadEnv(); // agent-local .env, if any, wins for agent-specific vars

import type { llm } from '@livekit/agents';
import { ChecklistTracker } from '../src/checklist/tracker.js';
import { createChecklistTools } from '../src/checklist/checklistTools.js';
import { buildChecklistPrompt, resolveSelectableTreeIds } from '../src/checklist/checklistAgent.js';
import type { KnownCustomer } from '../src/customerContext.js';
import { PLATFORM_TREE_LIBRARY } from '../src/checklist/trees.js';
import { compileRuntimeConfig } from '../src/checklist/blockCompiler.js';
import type { NodeStatus, QuestionTreeDef } from '../src/checklist/types.js';
import type { TenantRuntimeConfig } from '../src/checklist/blockTypes.js';
import {
  defaultChecklistPresetIdForBusinessType,
  deriveChecklistRuntimeConfig,
} from '../../shared/checklistPresetDerivation.js';

const API_KEY = process.env.OPENAI_API_KEY;
const AGENT_MODEL = process.env.SIM_QT_MODEL || 'gpt-4.1-mini';
const CALLER_MODEL = process.env.SIM_CALLER_MODEL || 'gpt-4o-mini';

// PROVIDER BAKE-OFF (2026-07-21): the AGENT (the thing under test) can point at
// any OpenAI-compatible endpoint — DeepSeek, Groq, Together, a local model —
// while the simulated CALLER stays on OpenAI (only the variable under test may
// change). Set all three to test a provider:
//   SIM_QT_BASE_URL=https://api.deepseek.com/v1 SIM_QT_API_KEY=$DEEPSEEK_API_KEY SIM_QT_MODEL=deepseek-chat
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const AGENT_BASE = (process.env.SIM_QT_BASE_URL || '').replace(/\/+$/, '');
const AGENT_URL = AGENT_BASE ? `${AGENT_BASE}/chat/completions` : OPENAI_URL;
const AGENT_KEY = process.env.SIM_QT_API_KEY || API_KEY;
// The CALLER can move too, for when the OpenAI account is unavailable — set
// SIM_CALLER_BASE_URL + SIM_CALLER_API_KEY. Results then measure a different
// caller, so say so when reporting them.
const CALLER_BASE = (process.env.SIM_CALLER_BASE_URL || '').replace(/\/+$/, '');
const CALLER_URL = CALLER_BASE ? `${CALLER_BASE}/chat/completions` : OPENAI_URL;
const CALLER_KEY = process.env.SIM_CALLER_API_KEY || API_KEY;
const CASE_FILTER = process.env.SIM_CASE || '';
const BUSINESS_TYPES = (process.env.SIM_BUSINESS || '')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean);
const RUNS = Number(process.env.SIM_RUNS || 1);
const TRACE = !!process.env.SIM_TRACE;

const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

if (!API_KEY) throw new Error('OPENAI_API_KEY not set');

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
  // The AGENT model (passed AGENT_MODEL) uses the configurable endpoint; every
  // other call (the caller model) uses the caller endpoint, OpenAI by default.
  // Route by which model this is.
  const isAgent = model === AGENT_MODEL;
  const url = isAgent ? AGENT_URL : CALLER_URL;
  const key = isAgent ? AGENT_KEY : CALLER_KEY;
  const base = isAgent ? AGENT_BASE : CALLER_BASE;
  const who = base ? `${isAgent ? 'agent' : 'caller'}-provider(${new URL(url).host})` : 'OpenAI';
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
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
      throw new Error(`${who} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    await sleep(Math.min(1500 * 2 ** (attempt - 1), 15_000));
  }
  throw new Error(`${who} unreachable after retries`);
}

function toolSchemas(ctx: llm.ToolContext): { type: 'function'; function: unknown }[] {
  return Object.entries(ctx).map(([name, t]) => {
    const s = t as unknown as { description: string; parameters: Record<string, unknown> };
    return {
      type: 'function' as const,
      function: { name, description: s.description, parameters: s.parameters },
    };
  });
}

// ── Faked backend tools (canned success; call-counted for grading) ────────────

interface Fake {
  description: string;
  parameters: Record<string, unknown>;
  execute: (a: unknown, o: unknown) => Promise<string>;
  calls: unknown[];
}
/**
 * `optional` names params the model may omit. Everything else stays required —
 * the default that makes scenarios deterministic. Added 2026-07-31 (review
 * catch on #311): marking get_available_slots' requested_time required would
 * FORCE the model to supply a time on every call, including scenarios where
 * the caller never named one — inventing input the grader then measures, which
 * is how a harness quietly stops catching regressions.
 */
const fake = (
  description: string,
  params: Record<string, unknown>,
  result: string,
  optional: string[] = []
): Fake => {
  const f: Fake = {
    description,
    parameters: {
      type: 'object',
      properties: params,
      required: Object.keys(params).filter((k) => !optional.includes(k)),
    },
    calls: [],
    execute: async (a: unknown) => {
      f.calls.push(a);
      return result;
    },
  };
  return f;
};

function makeFakeBackend(): Record<string, Fake> {
  const str = { type: 'string' } as const;
  return {
    book_with_scheduling: fake(
      'Book the appointment at a settled time. Pass start_time (spoken time) and any known details.',
      { start_time: str },
      JSON.stringify({
        success: true,
        appointment_id: 'appt_sim_1',
        booked_time: 'Wednesday, July 22 at 1:15 PM',
        instruction: 'Booked for Wednesday, July 22 at 1:15 PM. Confirm THIS exact time.',
      })
    ),
    get_available_slots: fake(
      'Get real bookable open times for a requested day. Pass requested_time ONLY when the caller named a specific time.',
      { day: str, requested_time: str },
      JSON.stringify({
        success: true,
        open_times: ['Wednesday, July 22 at 1:15 PM', '2:45 PM', '4:30 PM'],
      }),
      ['requested_time']
    ),
    get_service_catalog: fake(
      'List the services offered.',
      {},
      JSON.stringify({ success: true, services: [{ name: 'Programming Consultation' }] })
    ),
    take_message: fake(
      'Save a message for the owner. Pass the message text, and is_urgent when the caller said it cannot wait.',
      { message: str, is_urgent: { type: 'boolean' } },
      JSON.stringify({ success: true, message_id: 'msg_sim_1' }),
      ['is_urgent']
    ),
    capture_job_inquiry: fake(
      'Record a job/role inquiry for the owner. Pass whatever role details were collected.',
      { role: str },
      JSON.stringify({ success: true, job_inquiry_id: 'ji_sim_1' })
    ),
    identify_caller: fake(
      'Save the caller to the address book.',
      { name: str, phone: str },
      JSON.stringify({ success: true, customer_id: 'cust_sim_1' })
    ),
    get_company_policy_answer: fake(
      'Answer a question about the business from the knowledge base.',
      { question: str },
      JSON.stringify({
        success: true,
        answer:
          'Dale has 25 years of software experience, mostly embedded systems and more ' +
          'recently AI platforms. Consultations run Monday to Friday, 1 to 5 PM.',
      })
    ),
    // Empty by default; scenarios exercising the claimed-booking path override
    // via the runCall myAppointments option (batch A, CALL_IMPROVEMENTS.md #8).
    get_my_appointments: fake(
      "Look up the caller's own upcoming appointments (phone-matched server-side).",
      {},
      JSON.stringify({ success: true, appointments: [] })
    ),
    cancel_appointment: fake(
      'Cancel an existing appointment.',
      {},
      JSON.stringify({ success: true, appointment_id: 'appt_sim_9' })
    ),
    reschedule_appointment: fake(
      'Move an existing appointment to a new time.',
      {},
      JSON.stringify({ success: true, appointment_id: 'appt_sim_9' })
    ),
    // (A second `get_my_appointments` sat here — same key, so it silently
    // replaced the empty default above and handed EVERY scenario's caller a
    // "Thursday 2 PM" booking they never made. Removed 2026-09-11; a scenario
    // that needs existing bookings passes them via the myAppointments option.)
  };
}

// ── The caller ────────────────────────────────────────────────────────────────

interface Persona {
  opener: string;
  facts: string;
  behaviour: string;
  /**
   * VERTICAL MODE only. The scripted scenarios pin exact facts because their
   * graders measure recorded VALUES, so an invented fact would be measured as
   * truth. A vertical probe measures something different — whether the intake
   * tree's questions get ASKED at all — and it has no fact sheet for 30 trades.
   * Letting the caller improvise concrete answers is the only way to walk an
   * unseen tree; the graders here never assert a specific value.
   */
  improvise?: boolean;
}

function personaSystem(p: Persona): string {
  return `You are a real person on a PHONE CALL to a small business called Thinking Hammer.
You called them; a receptionist answers. Speak ONE short natural spoken line per turn — no
stage directions, no lists, no quotes around your words.

WHY you called (open with this, in your own words): ${p.opener}

${
  p.improvise
    ? `FACTS YOU HOLD (give them when asked — or as your behaviour says; if asked something
not listed, INVENT one plausible, concrete, ordinary answer and stick to it for the rest
of the call — never say "I don't know" to a routine question):`
    : `FACTS YOU HOLD (give them when asked — or as your behaviour says; NEVER invent facts not
listed; if asked something not here, say you don't know or would rather not say):`
}
${p.facts}

BEHAVIOUR: ${p.behaviour}

When the receptionist asks "anything else?", say no thanks. If they read a number or
detail back correctly, confirm it. End politely.`;
}

async function callerReply(personaSys: string, shared: ChatMessage[]): Promise<string> {
  const view: ChatMessage[] = [{ role: 'system', content: personaSys }];
  for (const m of shared) {
    if (m.role === 'assistant' && m.content) view.push({ role: 'user', content: m.content });
    else if (m.role === 'user' && m.content) view.push({ role: 'assistant', content: m.content });
  }
  const { content } = await openai(CALLER_MODEL, 0.9, view);
  return (content ?? 'Okay.').trim();
}

// ── The call loop ─────────────────────────────────────────────────────────────

interface RunOutcome {
  tracker: ChecklistTracker;
  fakes: Record<string, Fake>;
  /** Backend tool names in the order they fired — for ordering graders. */
  toolOrder: string[];
  transcript: { who: 'agent' | 'caller'; text: string }[];
  closed: boolean;
  goodbye: string;
}

async function runCall(
  p: Persona,
  callerPhone?: string,
  extras: {
    /** Rendered into the prompt's `# Known caller` header (batch A). */
    knownCustomer?: KnownCustomer;
    /** Override the get_my_appointments fake's JSON result. */
    myAppointments?: string;
    /** Staff first names for the prompt's roster line (batch B). */
    staffFirstNames?: string[];
    /** Override book_with_scheduling's result (duplicate refusal, mechanics). */
    bookResults?: string[];
    /** Override get_available_slots' result (batch C reason codes). */
    slotsResult?: string;
    /**
     * VERTICAL MODE: the tenant's tree LIBRARY — what EXISTS. Production seeds
     * every vertical with the WHOLE platform library and lets the preset decide
     * what is SELECTABLE; those are two different jobs. Collapsing them (seeding
     * only the preset's trees) crashes tracker construction, because
     * `booking.book` carries a cross-tree `requires` on `drop_off_ok`, which
     * lives in `fix_computer` — a tree no preset enables. That was found on
     * 2026-08-14 and is why scripts/seed-question-tree-templates.ts seeds the
     * full library. This sim mirrors production; it does not re-make the bug.
     */
    library?: QuestionTreeDef[];
    /**
     * VERTICAL MODE: the tenant's derived preset. Restricts what the model may
     * SELECT (via resolveSelectableTreeIds) and drives the prompt's call policy.
     * A tree the preset withholds is unreachable no matter what the caller asks.
     */
    runtimeConfig?: TenantRuntimeConfig;
  } = {}
): Promise<RunOutcome> {
  const library = extras.library ?? PLATFORM_TREE_LIBRARY;
  const tracker = new ChecklistTracker(library);
  const fakes = makeFakeBackend();
  if (extras.myAppointments) {
    const orig = fakes.get_my_appointments;
    fakes.get_my_appointments = { ...orig, execute: async () => extras.myAppointments! };
  }
  if (extras.slotsResult) {
    const orig = fakes.get_available_slots;
    fakes.get_available_slots = { ...orig, execute: async () => extras.slotsResult! };
  }
  if (extras.bookResults?.length) {
    // Scripted sequence: call N returns bookResults[N], last value repeats —
    // lets a scenario refuse the first booking (EXISTING_SAME_DAY) and accept
    // the retry, exactly as the live route does.
    const seq = [...extras.bookResults];
    let n = 0;
    const orig = fakes.book_with_scheduling;
    fakes.book_with_scheduling = {
      ...orig,
      execute: async () => seq[Math.min(n++, seq.length - 1)],
    };
  }
  const toolOrder: string[] = [];
  for (const [name, f] of Object.entries(fakes)) {
    const orig = f.execute;
    f.execute = async (a, o) => {
      toolOrder.push(name);
      return orig(a, o);
    };
  }
  let closed = false;
  let goodbye = '';
  const toolkit = createChecklistTools({
    tracker,
    library,
    selectableTreeIds: extras.runtimeConfig
      ? resolveSelectableTreeIds({ library, runtimeConfig: extras.runtimeConfig })
      : undefined,
    realTools: fakes as unknown as llm.ToolContext,
    callerPhone,
    onSelectionChanged: () => {}, // schemas are rebuilt fresh every round below
    closeCall: async (g: string) => {
      closed = true;
      goodbye = g;
    },
  });

  const system = buildChecklistPrompt({
    persona: 'You are Chris, the AI receptionist for Thinking Hammer.',
    runtime: {
      // 2026-07-21 IS a Tuesday. This said "Monday" for weeks and nothing
      // cared — until the Known-caller header rendered a REAL date through
      // Intl ("Tuesday, July 21 at 2:30 PM") and handed the model a prompt
      // that contradicted itself about what day it was; it resolved the
      // contradiction by inventing a third answer ("Thursday at 2 PM").
      currentDate: 'Tuesday, July 21, 2026',
      // Required on CallRuntime since the clock fix (a9816df). This script is
      // not typechecked, so it was missing and the model read the prompt's
      // "RIGHT NOW it is undefined" aloud (KNOWN CALLER HEADER, 2026-09-11).
      // Morning, so the afternoon slots the fakes offer are genuinely ahead.
      currentTime: '10:00 AM',
      timezone: 'America/Chicago',
      businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
      bookableThrough: 'Friday, August 15, 2026',
    },
    library,
    runtimeConfig: extras.runtimeConfig,
    callerPhone,
    knownCustomer: extras.knownCustomer ?? null,
    staffFirstNames: extras.staffFirstNames,
  });

  const personaSys = personaSystem(p);
  const transcript: RunOutcome['transcript'] = [];
  const shared: ChatMessage[] = [];
  const messages: ChatMessage[] = [{ role: 'system', content: system }];

  const greeting = 'Thank you for calling Thinking Hammer — this is Chris. How can I help you?';
  transcript.push({ who: 'agent', text: greeting });
  messages.push({ role: 'assistant', content: greeting });
  const opener = await callerReply(personaSys, [{ role: 'assistant', content: greeting }]);
  transcript.push({ who: 'caller', text: opener });
  shared.push({ role: 'assistant', content: greeting });
  shared.push({ role: 'user', content: opener });
  messages.push({ role: 'user', content: opener });
  if (TRACE) process.stderr.write(`   agent: ${greeting}\n   caller: ${opener}\n`);

  for (let round = 0; round < 48 && !closed; round++) {
    const tools = toolkit.selectedTools(); // fresh every round — selection may have changed
    const { content, toolCalls } = await openai(AGENT_MODEL, 0, messages, toolSchemas(tools));

    if (toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: content ?? null, tool_calls: toolCalls });
      if (content?.trim()) {
        transcript.push({ who: 'agent', text: content });
        shared.push({ role: 'assistant', content });
        if (TRACE) process.stderr.write(`   agent: ${content}\n`);
      }
      for (const tc of toolCalls) {
        const tool = tools[tc.function.name] as
          { execute: (a: unknown, o: unknown) => Promise<unknown> } | undefined;
        let res: unknown = `unknown tool ${tc.function.name}`;
        if (tool) {
          let args: unknown = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            /* {} */
          }
          res = await (
            tool as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }
          ).execute(args, { toolCallId: tc.id });
        }
        const rs = typeof res === 'string' ? res : JSON.stringify(res);
        if (TRACE)
          process.stderr.write(
            `      [tool] ${tc.function.name}(${(tc.function.arguments || '').slice(0, 100)}) -> ${rs.slice(0, 160)}\n`
          );
        messages.push({ role: 'tool', tool_call_id: tc.id, content: rs });
      }
      continue;
    }

    const agentLine = (content ?? '').trim();
    messages.push({ role: 'assistant', content: agentLine });
    if (agentLine) {
      transcript.push({ who: 'agent', text: agentLine });
      shared.push({ role: 'assistant', content: agentLine });
      if (TRACE) process.stderr.write(`   agent: ${agentLine}\n`);
    }
    if (closed) break;

    const reply = await callerReply(personaSys, shared);
    transcript.push({ who: 'caller', text: reply });
    shared.push({ role: 'user', content: reply });
    messages.push({ role: 'user', content: reply });
    if (TRACE) process.stderr.write(`   caller: ${reply}\n`);
  }

  return { tracker, fakes, toolOrder, transcript, closed, goodbye };
}

// ── Scenarios + graders (snapshot-first, transcript only for forbids) ─────────

interface Scenario {
  title: string;
  persona: Persona;
  callerPhone?: string;
  knownCustomer?: KnownCustomer;
  myAppointments?: string;
  staffFirstNames?: string[];
  bookResults?: string[];
  slotsResult?: string;
  library?: QuestionTreeDef[];
  runtimeConfig?: TenantRuntimeConfig;
  grade: (o: RunOutcome) => string[]; // list of failures; empty = pass
}

const has = (o: RunOutcome, node: string, statuses: NodeStatus[]): string[] =>
  statuses.includes(o.tracker.status(node))
    ? []
    : [`${node} is '${o.tracker.status(node)}' — wanted ${statuses.join('/')}`];
const valueMatch = (o: RunOutcome, node: string, re: RegExp): string[] =>
  re.test(o.tracker.value(node) ?? '')
    ? []
    : [`${node} = '${o.tracker.value(node) ?? '(unset)'}' !~ ${re}`];
const agentSaid = (o: RunOutcome, re: RegExp): boolean =>
  o.transcript.some((t) => t.who === 'agent' && re.test(t.text));
const mustClose = (o: RunOutcome): string[] => (o.closed ? [] : ['call never closed']);
const mustResolve = (o: RunOutcome): string[] =>
  o.tracker.isResolved() ? [] : ['checklist never resolved'];

const SCENARIOS: Scenario[] = [
  {
    // A replay of the 2026-07-20/21 live test calls — the call that broke four ways.
    // Every grader below is a defect Dale reported on a real call:
    //   - only the job tree selected, no meeting ever offered (call 2)
    //   - intake questions before the meeting was booked ("you just blew right
    //     past that", call 3) → get_available_slots must fire before capture
    //   - dictated number never read back (calls 3 AND 4)
    //   - "what would you like to discuss?" after the opener named the topic (call 4)
    //   - caller's name never used between hello and goodbye (call 5 report)
    title: "DALE'S CALL — meeting about a job: book FIRST, read back, use the name",
    persona: {
      opener: "Hi, I'd like to set up a meeting with Dale to talk about a job opportunity.",
      facts: `Your name: Marcus Webb. Your callback number: 262-497-9039 — give it naturally
("262 497 9039"), and confirm when it is read back correctly.
Your company: Bell Labs — you are hiring for your OWN company.
The role: full-time senior software engineer, 120 to 150 thousand salary, fully remote,
team on Central time. You WANT the meeting — accept the first offered time.`,
      behaviour:
        'Friendly and direct. Answer one thing at a time. If asked what you want to ' +
        'discuss, point out you already said — a job opportunity.',
    },
    grade: (o) => {
      const slotsAt = o.toolOrder.indexOf('get_available_slots');
      const captureAt = o.toolOrder.indexOf('capture_job_inquiry');
      return [
        ...has(o, 'book', ['done']),
        ...has(o, 'capture', ['done']),
        ...(slotsAt >= 0 && captureAt >= 0 && slotsAt < captureAt
          ? []
          : [
              `booking must come BEFORE intake — toolOrder: ${o.toolOrder.join(' → ') || '(none)'}`,
            ]),
        // EXACTLY once — zero is the unconfirmed-number bug (calls 3+4), two is
        // the double read-back the unconditional host directive caused (call 7).
        ...(() => {
          const readbacks = o.transcript.filter(
            (t) => t.who === 'agent' && /2\s*6\s*2\D{0,3}4\s*9\s*7\D{0,3}9\s*0\s*3\s*9/.test(t.text)
          ).length;
          return readbacks === 1
            ? []
            : [`dictated number read back ${readbacks} times — must be exactly once`];
        })(),
        ...(agentSaid(o, /\bMarcus\b/) ? [] : ["the caller's name was never used in conversation"]),
        ...(agentSaid(o, /what would you like to (discuss|talk about)/i)
          ? ['asked for the topic the opener already gave']
          : []),
        ...valueMatch(o, 'callers_company', /bell/i),
        ...valueMatch(o, 'hiring_for', /own_company/),
        ...valueMatch(o, 'employment_type', /full_time/),
        ...valueMatch(o, 'work_mode', /remote/),
        ...has(o, 'caller_phone', ['answered']),
        ...mustResolve(o),
        ...mustClose(o),
      ];
    },
  },
  {
    title: 'JOB-DIRECT — recruiter placing with a client, asked step by step',
    persona: {
      opener: "I'd like to talk to someone about a job opportunity for Dale.",
      facts: `Your name: Mike Reilly. Your number: 262-497-9039.
Your company (who YOU work for): Apex Staffing.
You are placing the role WITH A CLIENT: Northern Trust.
It is a CONTRACT role, senior Java developer, 65 to 82 dollars an hour, six months.
Fully remote; the team is on Central time. You do NOT want a meeting — just pass it along.`,
      behaviour: 'Cooperative but brief; answer what is asked, one thing at a time.',
    },
    grade: (o) => [
      ...has(o, 'capture', ['done']),
      ...valueMatch(o, 'callers_company', /apex/i),
      ...valueMatch(o, 'client_company', /northern/i),
      ...valueMatch(o, 'hiring_for', /placing_with_client/),
      ...valueMatch(o, 'work_mode', /remote/),
      ...has(o, 'team_timezone', ['answered']),
      ...has(o, 'salary_range', ['not_applicable']),
      ...mustResolve(o),
      ...mustClose(o),
    ],
  },
  {
    title: 'ONE-BREATH — everything volunteered in the opener, nothing re-asked',
    persona: {
      opener:
        "Hi, this is Sarah Kim from TalentBridge, 262-497-9039 — we've got a full-time " +
        'senior QA role at our own company, paying 120 to 140 thousand, hybrid out of our ' +
        'Milwaukee office at 400 Water Street. Can you pass that to Dale?',
      facts: `Everything is in your opener. Your name: Sarah Kim. Number: 262-497-9039.
Company: TalentBridge (hiring for your OWN company). Full time, 120-140k, hybrid,
office at 400 Water Street, Milwaukee.`,
      behaviour:
        'You already said everything — if asked for something you already said, repeat it ' +
        'with mild impatience ("like I said, …").',
    },
    grade: (o) => [
      ...has(o, 'capture', ['done']),
      ...valueMatch(o, 'callers_company', /talentbridge/i),
      ...valueMatch(o, 'hiring_for', /own_company/),
      ...valueMatch(o, 'employment_type', /full_time/),
      ...has(o, 'salary_range', ['answered']),
      ...has(o, 'position_address', ['answered']),
      ...(agentSaid(o, /(can i (get|have)|what(’|')?s) your name/i)
        ? ['agent asked for a name that was volunteered in the opener']
        : []),
      ...mustResolve(o),
      ...mustClose(o),
    ],
  },
  {
    title: 'WEDDING MESSAGE — a topic with no tree lands in message + generic subject',
    persona: {
      opener: "I'd like to leave a message for Dale about a wedding.",
      facts: `Your name: Grace Okafor. Number: 262-497-9039.
The message: you are getting married September 12th and want to know if Dale's band —
he plays in one — is available to play the reception. You want him to call you back.`,
      behaviour: 'Warm and chatty; happy to give details when asked.',
    },
    grade: (o) => [
      ...(o.tracker.selectedTrees().includes('message') ? [] : ['message tree never selected']),
      ...has(o, 'take_message_action', ['done']),
      ...has(o, 'caller_name', ['answered']),
      ...mustResolve(o),
      ...mustClose(o),
    ],
  },
  {
    title: 'MIND-CHANGE — contract becomes full time mid-call; no ghost data',
    persona: {
      opener: 'I have a position I want to run past Dale.',
      facts: `Your name: Tom Barrett. Number: 262-497-9039. Company: Barrett Recruiting,
hiring for your OWN company. You FIRST say it is a contract role at 70 an hour — but a
moment later (after they ask anything else about it) you CORRECT yourself: actually it was
approved as FULL TIME salaried at 130 thousand. On-site at 800 Main Street, Chicago.
The role: DevOps engineer.`,
      behaviour:
        'Slightly scattered. You get the contract/full-time detail wrong at first and ' +
        'correct yourself unprompted a turn or two later ("wait, sorry — that one is…").',
    },
    grade: (o) => [
      ...has(o, 'capture', ['done']),
      ...valueMatch(o, 'employment_type', /full_time/),
      ...has(o, 'salary_range', ['answered']),
      ...has(o, 'rate_range', ['not_applicable']), // the withdrawn branch left no ghost
      ...mustResolve(o),
      ...mustClose(o),
    ],
  },
  {
    title: 'JAYA REPLAY — "talk with Dale about job opportunities" books AND intakes',
    persona: {
      opener: 'I want to talk with Dale.',
      facts: `Your name: Jaya from Connolly Systems, a staffing agency — you are a
recruiter with a ROLE for Dale. When asked what the meeting is about, say: "About the
job opportunities — he shared the resume." The
role: a Java developer contract in Illinois, 6 months, 75 to 85 an hour, onsite in
Naperville at 120 Water Street. You are hiring for a CLIENT called Midwest Grain
Systems. Your number: 262-497-9039. You want to meet as soon as possible today — take
the first time offered. Answer role questions briskly when asked.`,
      behaviour:
        'Direct, slightly hurried, English is a second language — short sentences. You ' +
        'never volunteer the role details unprompted; they must be drawn out.',
    },
    grade: (o) => [
      // The 2026-07-27 live miss: the meeting was booked and the role never was.
      // BOTH must land — the booking AND the capture.
      ...has(o, 'book', ['done']),
      ...has(o, 'capture', ['done']),
      ...valueMatch(o, 'client_company', /midwest|grain/i),
      ...has(o, 'rate_range', ['answered', 'declined']),
      ...mustResolve(o),
      ...mustClose(o),
    ],
  },
  {
    title: 'AVAILABILITY-ASK — "Is Dale available for contract work?" is a job call, not qa',
    persona: {
      opener: 'Hi, quick question — is Dale available for contract work at the moment?',
      facts: `Your name: Priya Raman. Number: 262-497-9039. You are a recruiter at Northgate
Talent, placing a contractor with a client called Fermilab Systems. The role: senior
TypeScript engineer, six-month contract, 85 to 95 an hour, fully remote, team is in
Central time. You expect a yes/no answer at first, but you are happy to leave the details
when told it is the owner's decision. If offered a meeting, you would rather just leave
the details this time.`,
      behaviour:
        'Brisk, friendly recruiter. You open with the availability question and only ' +
        'unpack the role when the agent asks for details.',
    },
    grade: (o) => [
      // The whole point: an availability question about PAID WORK is the job tree.
      ...has(o, 'capture', ['done']),
      ...valueMatch(o, 'employment_type', /contract/),
      ...has(o, 'client_company', ['answered']),
      // The agent must never answer the availability question itself — that is the
      // owner's decision, not a knowledge-base fact.
      ...(agentSaid(o, /(yes|no).{0,30}available|he (is|isn't|is not) available/i)
        ? ['the agent answered the availability question for the owner']
        : []),
      ...mustResolve(o),
      ...mustClose(o),
    ],
  },
  {
    title: 'BUY THE SERVICE — a prospect qualifies, then books the demo',
    persona: {
      opener:
        'Hi — I heard your phone is answered by an AI? I want something like that for my shop.',
      facts: `Your name: Dana Whitfield. Number: 262-497-9039. Email: dana@whitfieldauto.com.
You run an independent auto repair shop, two bays. You take maybe twenty-five calls a day.
What you want handled is APPOINTMENT BOOKING and nothing else — messages and questions
you are fine handling yourself. You keep missing booking calls while under a car.
Right now calls go to an answering service that costs you about 300 a month and gets
messages wrong. You are happy to book a demo when offered, any time they have.`,
      behaviour:
        'Interested but practical. You answer what you are asked and do not volunteer ' +
        'the whole story at once. You are NOT offering anyone a job — if the agent starts ' +
        'asking about rates or contract length for a ROLE, say "no, no — I want to BUY this ' +
        'for my shop".',
    },
    grade: (o) => [
      // The boundary that matters most: a buyer is not a recruiter.
      ...has(o, 'capture', ['unselected', 'not_applicable', 'blocked']),
      ...has(o, 'business_type', ['answered']),
      // 'declined' is a legitimate resolved answer, not a defect — a caller who will
      // not estimate their volume must not be pushed (the sim's caller LLM declines
      // this one occasionally, and the product behaviour on a decline is correct).
      ...has(o, 'call_volume', ['answered', 'declined']),
      ...valueMatch(o, 'wants_handled', /booking|everything/),
      ...valueMatch(o, 'demo_offer', /wants_demo/),
      ...valueMatch(o, 'current_setup', /answering_service/),
      ...has(o, 'current_cost', ['answered', 'declined']),
      ...has(o, 'best_email', ['answered']),
      // The sales call's WRITE is the demo booking — this tree has no action of its own.
      ...has(o, 'book', ['done']),
      ...mustResolve(o),
      ...mustClose(o),
    ],
  },
  {
    title: 'BUY vs JOB — "business opportunity" opener must not become a role intake',
    persona: {
      opener: 'I wanted to talk to someone about a business opportunity.',
      facts: `Your name: Neil Ashford. Number: 262-497-9039. Email: neil@ashforddental.com.
You are VAGUE at first on purpose. When asked what it is about, you explain you run a
small clinic front desk and you want to BUY an AI receptionist like the one answering.
You take about forty calls a day, you want messages and questions handled, and today
calls just go to voicemail. You do NOT want to hire anybody and you are NOT offering work.`,
      behaviour:
        'Vague opener, then clear once asked. If the agent treats you as a recruiter with ' +
        'a role to fill, correct it plainly: "no — I want to buy your service."',
    },
    grade: (o) => [
      // The job tree must never capture a lead here — wrong record, wrong email to the owner.
      ...(o.fakes.capture_job_inquiry.calls.length === 0
        ? []
        : ['a BUYER was recorded as a job inquiry']),
      ...has(o, 'business_type', ['answered']),
      ...valueMatch(o, 'current_setup', /voicemail/),
      // Voicemail has no monthly bill — the follow-up must be ruled out, never asked.
      ...has(o, 'current_cost', ['not_applicable']),
      ...mustClose(o),
    ],
  },
  {
    title: 'QA-ONLY — questions answered from RAG, no identity shakedown',
    persona: {
      opener: "I'm curious what kind of experience Dale has — can you tell me about him?",
      facts: `You have no other business. You want to hear about Dale's background, maybe
one follow-up question about what kind of work he does, then you're done. You will NOT
give your name or number — if asked, say you're just curious.`,
      behaviour: 'Curious, casual. Two questions max, then wrap up.',
    },
    grade: (o) => [
      ...(o.fakes.get_company_policy_answer.calls.length >= 1
        ? []
        : ['answer_question never hit the knowledge base']),
      ...(agentSaid(o, /25 years/i) ? [] : ['the KB fact (25 years) never reached the caller']),
      ...(agentSaid(o, /(can i (get|have)|what(’|')?s) your name/i)
        ? ['questions-only caller was asked for a name']
        : []),
      ...mustClose(o),
    ],
  },
  {
    title: 'CALLER-ID BOOKING — attested number never asked for, repair intake + booking',
    persona: {
      opener: "My laptop won't boot after an update — can someone take a look at it?",
      facts: `Your name: Pat Nguyen. You are calling from your own phone (they may already
have the number — do NOT recite it unless asked). Dropping the laptop off is fine if
they say that's how it works; Wednesday afternoon works. Any offered Wednesday time is
fine — take the first one. Your data is backed up to OneDrive, nothing irreplaceable
on the machine.`,
      behaviour: 'Easygoing; picks the first offered time.',
    },
    callerPhone: '2624979039',
    grade: (o) => [
      ...has(o, 'book', ['done']),
      ...has(o, 'caller_phone', ['answered']),
      ...has(o, 'issue_description', ['answered']),
      ...has(o, 'drop_off_ok', ['answered']),
      // STATED, not asked (Dale): the agent must say drop-off is how it works —
      // never pose it as a choice of service modes.
      ...(agentSaid(o, /drop[- ]?off/i) ? [] : ['drop-off policy was never stated to the caller']),
      ...has(o, 'data_backup', ['answered']),
      ...(agentSaid(o, /best (number|phone)|number to reach/i)
        ? ['agent asked for a number it already had from caller ID']
        : []),
      ...mustResolve(o),
      ...mustClose(o),
    ],
  },
  {
    title: 'THE ELSE — a need no tree covers still ends in a saved message, never a dead end',
    persona: {
      opener:
        "This is an odd one — my nephew's getting married and I want to know if Dale " +
        'would MC the reception. Is that something he does?',
      facts: `Your name: Rosa Delgado. Number: 262-497-9039.
You know this is unusual. If they can't answer, you'd like Dale to call you back about
it — leave whatever message gets him to call. The date is October 3rd.`,
      behaviour: 'Good-humored about the odd request; happy to leave a message.',
    },
    grade: (o) => [
      ...(o.tracker.selectedTrees().includes('message') ? [] : ['message tree never selected']),
      ...has(o, 'take_message_action', ['done']),
      ...has(o, 'caller_name', ['answered']),
      ...(agentSaid(o, /can'?t help (you )?with that/i)
        ? ['said "can\'t help with that" — the ELSE forbids a dead end']
        : []),
      ...mustResolve(o),
      ...mustClose(o),
    ],
  },
  {
    // SCL_nRKo3KEVw8Yh replay (2026-07-27): an AI recruiter bot that mirrors
    // "would you like me to leave a message?" back at every turn. The live call
    // spent 5 minutes on it, the agent promised a message twice (none exists —
    // the write was capture_job_inquiry), and the call ended on a double
    // goodbye. The graders pin the fixes: the capture lands WITH the role
    // description, and the agent never promises a message artifact.
    title: 'SAGE BOT-MIRROR — an AI caller that deflects; capture lands, no message promised',
    persona: {
      opener:
        "I'm Sage from eTeam, reaching out to Dale regarding the Azure and M365 developer " +
        'position. Is this a good time to chat? Would you prefer I leave a message?',
      facts: `You are an AI recruiting assistant — polite, verbose, and deflecting. Your
name: Sage. Your company: eTeam, a staffing agency placing the role with a CLIENT:
Capgemini. The role: Azure/M365 developer — designing and supporting cloud-native
solutions on Azure and Power Platform. Contract to hire, conversion depends on project
needs. Hybrid, at Hanover, New Hampshire. Rate: "competitive" — you have no numbers and
say so if pressed. Your number: 262-497-9039. You do NOT want a meeting — decline any
offer of one. END EVERY TURN by asking "Would you like me to leave a message for Dale?"
— mirror the question back even when you were just asked something.`,
      behaviour:
        'Courteous corporate bot. You answer what is asked, then ALWAYS tack on your ' +
        'message question. Never volunteer everything at once.',
    },
    grade: (o) => [
      ...has(o, 'capture', ['done']),
      // The 2026-07-30 prod loss: the role must reach the write, not just the transcript.
      ...has(o, 'role_description', ['answered']),
      ...valueMatch(o, 'callers_company', /eteam/i),
      ...valueMatch(o, 'client_company', /capgemini/i),
      ...valueMatch(o, 'employment_type', /contract_to_hire/),
      // The false-promise guard: the agent never claims it will leave a message —
      // the job-call write is a recorded inquiry, and it must say so.
      ...(agentSaid(o, /\bI(?:'| wi)ll (?:leave|take) (?:a|the|your) message\b|voicemail/i)
        ? ['promised a message artifact that take_message never writes on a job call']
        : []),
      ...(o.fakes.take_message.calls.length === 0
        ? []
        : ['take_message fired on a pure job call — the inquiry IS the record']),
      ...mustResolve(o),
      ...mustClose(o),
    ],
  },
  {
    // The live-path OFFER_MEETING port (the ladder's 2026-07-27 eval failure:
    // offered, took a time, said "you're booked", never called the tool). A
    // recruiter who did NOT ask for a meeting accepts the one offer — the yes
    // must route through set_purpose → booking → a real book_with_scheduling
    // success, and the intake must still complete.
    title: 'OFFER ACCEPTED — recruiter says yes to the one offer; booking goes through the tool',
    persona: {
      opener: "Hi, I have a contract role I'd like to run past Dale.",
      facts: `Your name: Elena Voss. Number: 262-497-9039. Your company: Voss Talent,
placing the role with a CLIENT: Lakeshore Logistics. The role: backend engineer,
contract, six months, 70 to 80 an hour, fully remote, team on Eastern time. You do NOT
ask for a meeting yourself — but if they OFFER you time with Dale, accept it and take
the first time they suggest.`,
      behaviour:
        'Professional and concise. Answer one thing at a time. Accept the meeting only ' +
        'if offered — never request it unprompted.',
    },
    grade: (o) => [
      ...valueMatch(o, 'meeting_offer', /wants_meeting/),
      // "Booked" must be earned by the tool, and the intake still completes.
      ...has(o, 'book', ['done']),
      ...has(o, 'capture', ['done']),
      ...valueMatch(o, 'client_company', /lakeshore/i),
      ...(o.toolOrder.includes('book_with_scheduling')
        ? []
        : ['the accepted offer never reached book_with_scheduling']),
      ...mustResolve(o),
      ...mustClose(o),
    ],
  },
  {
    // Batch B — the sentence that cost four calls (#9). A caller who books a
    // phone meeting asks the obvious question, and the answer must come from
    // the tenant's own words, never from the model's imagination.
    title: 'CALL MECHANICS — "so do I call him?" is answered from the tool, verbatim',
    bookResults: [
      JSON.stringify({
        success: true,
        appointment_id: 'appt_sim_mech',
        // Matches the shared fake availability (Wednesday, July 22 at 1:15 PM).
        // It said Tuesday, July 21 — a day the caller was never offered — and
        // the agent confirmed a date it had not proposed.
        booked_time: 'Wednesday, July 22 at 1:15 PM',
        what_happens_next: 'Dale will call you at this number at the booked time.',
        instruction:
          'Booked for Wednesday, July 22 at 1:15 PM. Confirm THIS exact time. Then say this ' +
          'VERBATIM: "Dale will call you at this number at the booked time."',
      }),
    ],
    persona: {
      opener: "I'd like to set up a phone call with Dale about a contract role.",
      facts: `Your name: Priya Raman. Number: 262-497-9039. Company: Northgate Talent,
placing a contractor with a client called Fermilab Systems. Six-month contract, 85 to 95
an hour, fully remote, team on Central time. Take the FIRST time offered. Once a time is
agreed, ASK PLAINLY: "So do I call him at that time, or does he call me?" — you need to
know before you hang up.`,
      behaviour: 'Practical and brisk. You always ask who is calling whom before you finish.',
    },
    grade: (o) => [
      ...has(o, 'book', ['done']),
      // The tenant's fact, spoken. Not "you call him", not "the same number".
      ...(agentSaid(o, /will call you at this number/i)
        ? []
        : ['never told the caller what actually happens at the booked time']),
      ...(agentSaid(o, /you (can |should |could )?(just )?call (him|dale|back)/i)
        ? ['told the caller to call in — the invented answer that caused the cascade']
        : []),
      ...mustClose(o),
    ],
  },
  {
    // Batch B — #10. The caller names someone who does not work there.
    title: 'WRONG NAME — "Jane" is questioned against the roster, never echoed as real',
    staffFirstNames: ['Dale'],
    persona: {
      opener: 'Hi, can I book a time with Jane please?',
      facts: `Your name: Marcus Webb. Number: 262-497-9039. You want a 30-minute
consultation, and you are happy with the first time offered. You THINK the person is
called Jane, but you are not certain — if the receptionist offers a different name, accept
it ("oh, Dale, that's the one"). What you want to discuss: a website project.`,
      behaviour: 'Friendly, a bit vague on the name. Accept a correction gracefully.',
    },
    grade: (o) => [
      ...has(o, 'book', ['done']),
      // It must ASK about the name rather than adopt it.
      ...(agentSaid(o, /\bDale\b/) ? [] : ['never offered the real employee name']),
      ...(o.transcript.some(
        (t) => t.who === 'agent' && /\bwith Jane\b|booked .{0,20}Jane/i.test(t.text)
      )
        ? ['confirmed a booking WITH "Jane" — a person who does not work here']
        : []),
      ...mustClose(o),
    ],
  },
  {
    // Batch B — #9/#10. The route refuses the second same-day booking; the
    // agent must relay what they already have instead of retrying blindly.
    title: 'DUPLICATE REFUSED — the caller is told what they already have today',
    bookResults: [
      JSON.stringify({
        success: false,
        error:
          'This caller ALREADY has an appointment today at 1:00 PM (Programming ' +
          'Consultation). Do NOT book a second one silently — tell them what they already ' +
          'have and ask whether they want to KEEP it, MOVE it to the new time ' +
          '(reschedule_appointment), or genuinely book a SECOND separate appointment. Only ' +
          'if they clearly want both, call this again with allow_duplicate true. IF THEY KEEP ' +
          'THE ONE THEY HAVE: their goal is already met — record the booking step as declined ' +
          '(record_answer, declined true) so the call can close. Do not keep asking "anything ' +
          'else?" against a booking that is never coming.',
        error_code: 'EXISTING_SAME_DAY',
        existing_appointment: { start_time: '1:00 PM', service: 'Programming Consultation' },
        next_available: [],
      }),
    ],
    persona: {
      opener: 'I want to book a call with Dale this afternoon.',
      facts: `Your name: Jaya. Number: 773-448-7716. You want to talk about a Java contract
role. You do NOT remember booking anything earlier today. If you are told you already have
a 1:00 PM appointment, say "oh — then let's just keep that one" and do not ask for
another.`,
      behaviour: 'Hurried; English is a second language — short sentences.',
    },
    grade: (o) => [
      // The whole point: the caller HEARS about the appointment they already have.
      ...(agentSaid(o, /1:?00|one o'?clock/i)
        ? []
        : ['never told the caller about the appointment they already had']),
      // And nothing gets force-booked past the refusal.
      ...(o.tracker.status('book') === 'done'
        ? ['booked a duplicate anyway — the refusal was ignored']
        : []),
      ...mustClose(o),
    ],
  },
  {
    // Batch E — SCL_dpp8qN8ogCtF (#7). "I want to talk with him URGENTLY" was
    // answered with a list of appointment slots; the caller hung up
    // mid-sentence. There is no live transfer on this flow, so the honest move
    // is an urgent-flagged message — offered as such, not disguised as a
    // handoff that cannot happen.
    title: 'URGENT CALLER — gets an urgent message taken, not a slot menu',
    callerPhone: '7734487716',
    persona: {
      opener: 'I need to speak with Dale urgently — it is about the call we have set up.',
      facts: `Your name: Jaya. Number: 773-448-7716 (they have it). It is genuinely urgent:
you need him to know you may have to move today's call. You do NOT want to book another
appointment — if you are offered a list of times, say "no, I need to reach him now".
Accept a message being passed along urgently.`,
      behaviour: 'Insistent and hurried. Short sentences. You repeat that it is urgent.',
    },
    grade: (o) => [
      ...has(o, 'take_message_action', ['done']),
      // The flag the owner's inbox sorts on — the caller said it, so it must ride.
      ...(o.fakes.take_message.calls.some((c) => (c as { is_urgent?: boolean }).is_urgent === true)
        ? []
        : ['took the message but never marked it urgent — the caller said it plainly']),
      // And it must NOT promise a handoff that cannot happen on this flow.
      ...(agentSaid(o, /put you through|transfer(ring)? you|connect(ing)? you (to|with)/i)
        ? ['promised to put the caller through — no live transfer exists on this flow']
        : []),
      ...mustResolve(o),
      ...mustClose(o),
    ],
  },
  {
    // Batch D — SCL_ReG7kLRiY94c (#2). The name is heard wrong, the message is
    // saved, and the caller corrects it. The correction must reach the ROW,
    // not just the tracker — and the agent must not re-ask everything.
    title: 'NAME CORRECTED — the fix reaches the record, spelled letters and all',
    callerPhone: '2624979039',
    persona: {
      opener: "Hi, I'm returning Dale's call — can you take a message for him?",
      facts: `Your name is Camille. The agent will very likely MISHEAR it as "Jamil" —
when it says the wrong name back, correct it firmly and SPELL it: "No, it's Camille.
C-A-M-I-L-L-E." The message: you are returning his call and he can reach you on this
number. Nothing else.`,
      behaviour:
        'Polite but insistent about your name. You correct it the moment you hear it wrong, ' +
        'and you spell it out.',
    },
    grade: (o) => [
      ...has(o, 'take_message_action', ['done']),
      // The tracker must end on the corrected name — not the misheard one.
      ...valueMatch(o, 'caller_name', /^camille$/i),
      // And the agent must acknowledge rather than argue or re-ask everything.
      ...(agentSaid(o, /camille/i) ? [] : ['never said the corrected name back']),
      ...mustResolve(o),
      ...mustClose(o),
    ],
  },
  {
    // Batch C — SCL_VcKTTgo4kS2v (#8). The caller asks for 2:30; her OWN
    // appointment is on it. The tool now says so; the agent must RELAY that,
    // not invent "we only book on the quarter hour" (2:30 IS a quarter hour).
    title: 'OCCUPIED BY CALLER — the true reason is relayed, never manufactured',
    callerPhone: '7734487716',
    slotsResult: JSON.stringify({
      success: true,
      requested: {
        time: '2:30 PM',
        available: false,
        reason: 'occupied_by_caller',
        conflict_start: '2:30 PM',
        spoken_reason: 'You already have an appointment at 2:30 PM.',
        note:
          "The caller's OWN appointment occupies that time. Say so plainly, and ask whether " +
          'they want to keep it, move it, or book something else — never book a second one ' +
          'silently, and never imply the time is unavailable for some other reason.',
      },
      open_times: ['1:15 PM', '3:00 PM', '3:30 PM'],
      offer_times: ['1:15 PM', '3:00 PM'],
      date: '2026-07-21',
      spoken:
        'You already have an appointment at 2:30 PM. On Tuesday, July 21 I have 1:15 PM or ' +
        '3:00 PM. Would any of those work?',
    }),
    persona: {
      opener: 'Hi, I want to book a call with Dale at 2:30 today.',
      facts: `Your name: Jaya. Number: 773-448-7716 (they have it). You want 2:30 PM today
to talk about a Java contract role. If you are told you ALREADY have something at 2:30,
say "oh, that's the one I made this morning — I'll keep it" and do not book anything else.`,
      behaviour: 'Hurried, direct. Short sentences.',
    },
    grade: (o) => [
      // The true reason, spoken.
      ...(agentSaid(o, /already have an appointment at 2:?30|already have.{0,20}2:?30/i)
        ? []
        : ['never told the caller the 2:30 was their OWN existing appointment']),
      // The invented reason must never appear.
      ...(agentSaid(o, /quarter hour|only book on the/i)
        ? ['manufactured a reason (the "quarter hour" lie) instead of relaying the tool\'s']
        : []),
      ...mustClose(o),
    ],
  },
  {
    // SCL_VcKTTgo4kS2v replay (batch A). The live call: caller with a live 2:30
    // appointment, phone-matched in the DB, told "you don't have a booked time
    // on file". Here the prefetched Known-caller header carries the booking —
    // the model must speak FROM it, never contradict it.
    title: 'KNOWN CALLER HEADER — an existing 2:30 booking is never denied',
    callerPhone: '7734487716',
    knownCustomer: {
      name: 'Jaya',
      history: 'Booked a meeting about a Java contract role',
      preferences: {},
      upcomingAppointments: [
        // 19:30 UTC = 2:30 PM America/Chicago on the sim's runtime date.
        { start_time: '2026-07-21T19:30:00.000Z', service: 'Programming Consultation' },
      ],
    },
    persona: {
      opener: 'Hi — I already scheduled a call with Dale today. Can you tell me what time it is?',
      facts: `Your name: Jaya. Your number: 773-448-7716 (they have it — do not recite it).
You booked a meeting with Dale earlier today and believe it is at 2:30 in the afternoon.
You just want the time confirmed, and you'd like him to know you may run five minutes
late. Nothing else.`,
      behaviour:
        'Slightly anxious about the time; English is a second language — short sentences. ' +
        'If told you have NO appointment, protest: "No, I booked it this morning!"',
    },
    grade: (o) => [
      // The defining failure: denial of a booking the system holds. Narrowed to
      // denial PHRASES (not any "no…appointment" within 40 chars — "no problem,
      // your appointment…" was a false trip).
      ...(agentSaid(
        o,
        /(don'?t|do not) (have|see|show).{0,30}(booking|booked|appointment)|no (booking|booked time|appointment) on file/i
      )
        ? ['DENIED an existing booking the Known-caller header carries']
        : []),
      ...(agentSaid(o, /2:?30|two.?thirty/i) ? [] : ['the 2:30 time was never spoken']),
      // The wobble found on the first runs: a DIFFERENT time confidently stated
      // ("Thursday at 2 PM" for a listed Tuesday 2:30). Any spoken clock time
      // that is not 2:30 (or the runtime's own hours mention) fails.
      ...(o.transcript.some(
        (t) =>
          t.who === 'agent' &&
          /\b(?:[01]?\d)(?::[0-5]\d)?\s?(?:AM|PM)\b/i.test(t.text) &&
          !/2:?30/.test(t.text) &&
          !/1:00|5:00/.test(t.text) // business-hours mention is fine
      )
        ? ['spoke a WRONG time for the appointment — must read the header verbatim']
        : []),
      ...mustClose(o),
    ],
  },
  {
    // The other half of #8: NOTHING in the header (unknown/new session state),
    // the caller CLAIMS a booking — the model must CHECK (get_my_appointments
    // is in the base toolset now) before confirming or denying anything.
    title: 'CLAIMED BOOKING — no header, so the agent must CHECK before it answers',
    callerPhone: '7734487716',
    myAppointments: JSON.stringify({
      success: true,
      appointments: [{ time: 'Monday, July 21 at 2:30 PM', service: 'Programming Consultation' }],
    }),
    persona: {
      opener: "I already have a call scheduled with Dale — I need to check what time it's at.",
      facts: `Your name: Jaya. Number: 773-448-7716 (they have it). You are sure you booked
a call with Dale; you think it is 2:30 but want it confirmed. If it is confirmed, that is
all you need.`,
      behaviour: 'Brisk. You expect them to just look it up.',
    },
    grade: (o) => [
      ...(o.toolOrder.includes('get_my_appointments')
        ? []
        : ['never called get_my_appointments — asserted about a booking from silence']),
      ...(agentSaid(o, /(don'?t|do not|no).{0,40}(booking|booked|appointment|time on file)/i)
        ? ['denied a booking without (or against) the lookup']
        : []),
      ...(agentSaid(o, /2:?30|two.?thirty/i) ? [] : ['the 2:30 time was never spoken']),
      ...mustClose(o),
    ],
  },
];

// ── VERTICAL MODE (T-008) ─────────────────────────────────────────────────────
//
// The scripted scenarios above are hand-written replays of real defects. This
// mode answers a different question, and one no unit test can: for a given
// business_type, does the vertical's OWN intake tree actually get selected and
// asked on a live conversation?
//
// The SELECTABLE tree ids are COMPILED FROM THE PRESET. The `library` itself is
// still the full platform set — production works the same way, and `runCall`'s
// note on `extras.library` says why the two must not be the same list: the
// library is what EXISTS, the selectable ids are what this tenant may pick.
// Restricting selection is the whole point: a tree a tenant's preset withholds
// is unreachable on their calls no matter what the caller asks for, because
// ChecklistOverrides can only SUBTRACT blocks. Letting the model select any tree
// would prove nothing about what a real tenant's call can do.

/** Build the tree list + runtime config a tenant of this business_type would run. */
function verticalSetup(businessType: string): {
  runtimeConfig: TenantRuntimeConfig;
  library: QuestionTreeDef[];
  selectable: string[];
  intakeTree: QuestionTreeDef | undefined;
} {
  const runtimeConfig = deriveChecklistRuntimeConfig(
    businessType,
    defaultChecklistPresetIdForBusinessType(businessType),
    {}
  ) as unknown as TenantRuntimeConfig;
  // The preset's own trees — what this tenant may SELECT. compileRuntimeConfig
  // throws, loudly and by name, on an unknown block or an unresolvable tree_ref,
  // so this doubles as the "no tree not found" check.
  const selectable = compileRuntimeConfig(runtimeConfig).map((tree) => tree.tree_id);
  // The LIBRARY is the full platform set — what EXISTS. See the note on
  // `extras.library` in runCall for why these must not be the same list.
  const library = PLATFORM_TREE_LIBRARY;
  const slug = businessType.replace(/-/g, '_');
  const intakeTree = selectable.includes(`${slug}_intake`)
    ? library.find((tree) => tree.tree_id === `${slug}_intake`)
    : undefined;
  return { runtimeConfig, library, selectable, intakeTree };
}

/**
 * A caller persona derived from the intake tree itself.
 *
 * The tree's `description` is written FOR THE PURPOSE SELECTOR and states what
 * the caller wants; its nodes' `ask` text states what the business needs to
 * know. Together that is enough to brief a caller for any of the 30 verticals
 * without hand-writing 30 fact sheets — and hand-writing them would be worse,
 * because the fixture would then encode what we EXPECT to be asked rather than
 * what the tree actually asks.
 */
function verticalPersona(businessType: string, intakeTree: QuestionTreeDef): Persona {
  const asks = intakeTree.nodes
    .map((node) => ('ask' in node && node.ask ? `- ${node.ask}` : ''))
    .filter(Boolean)
    .join('\n');
  return {
    opener: `you need what a ${businessType.replace(/-/g, ' ')} business does. ${intakeTree.description}`,
    facts: `You are an ordinary customer of a ${businessType.replace(/-/g, ' ')} business.
Your name is Jordan Avery and your number is 630-555-0142.
You are flexible on timing and happy to book. The receptionist may ask you about:
${asks}
Answer each with one plausible, ordinary, concrete detail and keep it consistent.`,
    behaviour:
      'Volunteer only your reason for calling at first; answer the rest as asked, one short ' +
      'line per turn. Accept the first time you are offered. Do not steer the call.',
    improvise: true,
  };
}

function verticalScenarios(businessTypes: string[]): Scenario[] {
  return businessTypes.map((businessType) => {
    const { runtimeConfig, library, selectable, intakeTree } = verticalSetup(businessType);
    const slug = businessType.replace(/-/g, '_');
    if (!intakeTree) {
      // Not a crash: some presets legitimately have no <slug>_intake (the
      // local-service catch-all, owner-for-hire, law firm). Say so as a graded
      // failure so a typo'd business_type can't masquerade as a pass.
      return {
        title: `vertical ${businessType} — no ${slug}_intake tree in the compiled preset`,
        persona: { opener: 'n/a', facts: 'n/a', behaviour: 'n/a' },
        library,
        runtimeConfig,
        grade: () => [
          `preset '${runtimeConfig.preset_id}' offers [${selectable.join(', ')}] — no ` +
            `'${slug}_intake', so this vertical's questions are unreachable`,
        ],
      };
    }
    return {
      title: `vertical ${businessType} — ${slug}_intake fires on a real call`,
      persona: verticalPersona(businessType, intakeTree),
      callerPhone: '+16305550142',
      library,
      runtimeConfig,
      grade: (o) => {
        const ids = intakeTree.nodes.map((n) => n.node_id);
        const asked = ids.filter((id) => o.tracker.status(id) === 'answered');
        const touched = ids.filter((id) => o.tracker.status(id) !== 'unselected');
        return [
          // The DoD: at least one intake node fired. Not "all of them" — most
          // nodes in these trees are `listen: true` on purpose and are only
          // recorded if the caller volunteers them.
          ...(asked.length > 0
            ? []
            : [
                `no ${slug}_intake node was answered (statuses: ${ids
                  .map((id) => `${id}=${o.tracker.status(id)}`)
                  .join(', ')})`,
              ]),
          ...(touched.length > 0 ? [] : [`${slug}_intake was never selected at all`]),
          ...mustClose(o),
        ];
      },
    };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const all = BUSINESS_TYPES.length ? verticalScenarios(BUSINESS_TYPES) : SCENARIOS;
  const picked = all.filter(
    (s) => !CASE_FILTER || s.title.toLowerCase().includes(CASE_FILTER.toLowerCase())
  );
  console.log(
    `${C.b}sim-questiontree${C.x} — ${picked.length} scenario(s) × ${RUNS} run(s), agent=${AGENT_MODEL}, caller=${CALLER_MODEL}\n`
  );
  let pass = 0;
  let fail = 0;
  let errored = 0;
  for (const s of picked) {
    for (let run = 1; run <= RUNS; run++) {
      const label = RUNS > 1 ? `${s.title} [run ${run}]` : s.title;
      process.stdout.write(`${C.y}▶${C.x} ${label}\n`);
      try {
        const outcome = await runCall(s.persona, s.callerPhone, {
          knownCustomer: s.knownCustomer,
          myAppointments: s.myAppointments,
          staffFirstNames: s.staffFirstNames,
          bookResults: s.bookResults,
          slotsResult: s.slotsResult,
          library: s.library,
          runtimeConfig: s.runtimeConfig,
        });
        const failures = s.grade(outcome);
        if (failures.length === 0) {
          pass++;
          console.log(`${C.g}  ✓ PASS${C.x}  (${outcome.transcript.length} lines)`);
        } else {
          fail++;
          console.log(`${C.r}  ✗ FAIL${C.x}`);
          for (const f of failures) console.log(`${C.r}    - ${f}${C.x}`);
          console.log(`${C.d}    snapshot: ${JSON.stringify(outcome.tracker.snapshot())}${C.x}`);
          for (const t of outcome.transcript.slice(-14))
            console.log(`${C.d}    ${t.who}: ${t.text}${C.x}`);
        }
      } catch (err) {
        // NOT a failure — the scenario never ran. Counting an API outage as a
        // behavioural fail is what made the 2026-08-15 run read "16/22" when
        // one of the six was a real defect and five were rate limits. Same fix
        // as sim-offscript: grade what was asked, and exit 2 for the rest.
        errored++;
        console.log(`${C.r}  ✗ ERROR ${String(err)}${C.x}`);
      }
    }
  }
  const graded = pass + fail;
  console.log(`\n${C.b}RESULT: ${pass}/${graded} graded scenario(s) passed${C.x}`);
  if (errored > 0) {
    console.log(
      `${C.y}${errored} scenario(s) never reached the model (API error after retries) — NOT ` +
        `graded, and NOT counted as failures. Re-run them when the API is available.${C.x}`
    );
    process.exit(2);
  }
  process.exit(fail === 0 ? 0 : 1);
}

void main();
