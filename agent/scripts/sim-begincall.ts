// sim-begincall.ts — does the ROOT AGENT actually hand off?
//
// WHY THIS EXISTS (2026-07-16): a live call opened with "I'd like to leave a message
// for Dale" and CallRootAgent never called begin_call — it chatted, collected the name
// and number ITSELF, and was on its way to "I'll pass that along" with no tool behind
// it. Nothing caught it, because sim-taskgroup.ts feeds goals STRAIGHT to planCallTasks:
// the intent hand-off — the one judgement the root agent exists to make — was the one
// thing no harness exercised. This is that harness.
//
// It replays the REAL CallRootAgent instructions and the REAL begin_call schema (read
// off a constructed instance, not copied — an eval that drifts from production tests a
// fiction) through the same model the agent runs, one opener per case, and grades ONE
// thing: did the very first response CALL begin_call, with the right goal flags?
//
// Run: cd agent && npx tsx scripts/sim-begincall.ts   (env: OPENAI_API_KEY)
//   SIM_RUNS=N   runs per case (default 3 — the failure was intermittent-ish; volume)
import { llm, initializeLogger, voice } from '@livekit/agents';
import { CallRootAgent } from '../src/tasks/callRootAgent.js';
import { buildSystemPrompt, formatDateForPrompt } from '../src/prompt.js';
import type { SessionContext } from '../src/sessionContext.js';

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.SIM_BEGINCALL_MODEL || 'gpt-4o-mini';
const RUNS = Number(process.env.SIM_RUNS || 3);
// SIM_LADDER_PERSONA=1 reproduces the PRE-FIX production composition: the entire
// prompt-ladder system prompt passed as the root agent's persona. That composition is
// what buried the hand-off instruction and lost a live caller's message on 2026-07-16 —
// this flag exists so the eval can PROVE it fails, and so nobody re-introduces it.
const LADDER_PERSONA = process.env.SIM_LADDER_PERSONA === '1';
if (!API_KEY) {
  console.error('sim-begincall: OPENAI_API_KEY not set');
  process.exit(2);
}

initializeLogger({ pretty: false, level: 'silent' });

// The real agent, constructed the way index.ts constructs it (stub deps — we only need
// its instructions + tool schema, and reading them off the instance means this eval
// cannot drift from what production sends the model).
const ctx: SessionContext = {
  tenantId: 't',
  callerPhone: null,
  callId: 'sim-begincall',
  roomName: 'r',
  participantIdentity: 'p',
};
const stubTool = llm.tool({
  description: 'stub',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'ok',
});
// Post-fix production persona: a single identity line (index.ts). The ladder mode
// swaps in the full buildSystemPrompt output — exactly what index.ts used to pass.
// SIM_CUSTOM_PROMPT_FILE: path to the tenant's stored system_prompt (the composed RUNG
// ladder) — live production feeds it through buildSystemPrompt as customPrompt, so the
// ladder-mode reproduction must too. Its RUNG 4 text matches a message opener verbatim,
// which is exactly what pulled the live root agent into taking the message itself.
const customFile = process.env.SIM_CUSTOM_PROMPT_FILE;
const customPrompt = customFile ? (await import('node:fs')).readFileSync(customFile, 'utf8') : null;
const persona = LADDER_PERSONA
  ? buildSystemPrompt({
      tenantName: 'Thinking Hammer',
      callerPhone: null,
      currentDate: formatDateForPrompt(new Date(), 'America/Chicago'),
      timezone: 'America/Chicago',
      businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
      bookableThrough: '2027-01-08',
      personaName: 'Chris',
      customPrompt,
    })
  : 'You are Chris, the AI receptionist for Thinking Hammer.';

const agent: voice.Agent = new CallRootAgent({
  ctx,
  tools: { identify_caller: stubTool, take_message: stubTool, book_with_scheduling: stubTool },
  persona,
  runtime: {
    currentDate: 'Wednesday, July 16, 2026',
    // Required on CallRuntime since the clock fix (a9816df); scripts/ is outside
    // tsconfig's include, so its absence was never a type error — only "undefined"
    // in the prompt the model reads.
    currentTime: '10:00 AM',
    timezone: 'America/Chicago',
    businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
    bookableThrough: '2027-01-08',
  },
});
const instructions = (agent as unknown as { instructions: string }).instructions;
const beginCall = (agent.toolCtx as Record<string, unknown>)['begin_call'] as {
  description: string;
  parameters: Record<string, unknown>;
};
const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'begin_call',
      description: beginCall.description,
      parameters: beginCall.parameters,
    },
  },
];

interface Case {
  name: string;
  opener: string;
  /** Substrings that must appear in the named string args (case-insensitive). */
  expectArgSubstr?: Record<string, string>;
  expectFlags: Record<string, boolean>;
}
const CASES: Case[] = [
  {
    // THE live failure, verbatim.
    name: 'leave-a-message opener hands off (2026-07-16 live failure)',
    opener: "Hi. I'd like to leave a message for Dale.",
    expectFlags: { wants_to_leave_message: true, wants_meeting: false },
  },
  {
    name: 'message that mentions a job/callback still hands off as a message',
    opener: 'Tell Dale I have a job for him, and have him give me a callback.',
    expectFlags: { wants_to_leave_message: true },
  },
  {
    name: 'booking opener hands off (must not regress)',
    opener: "I'd like to schedule a meeting with Dale.",
    expectFlags: { wants_meeting: true },
  },
  {
    // THE FLAP (two live calls, 2026-07-18): a service request — someone asking the
    // BUSINESS to come do work — kept classifying has_job_inquiry=true, planning a
    // job rung, and interrogating a repair caller about "the role" ("which company
    // are you calling from?"). The not_a_job escape saves the call, but the router
    // should never have sent it there: has_job_inquiry is a role brought TO the
    // owner (recruiting/staffing), not work requested FROM the business.
    name: 'service request is NOT a job inquiry (2026-07-18 live flap)',
    opener: 'Hi. I was wondering if someone can come to my house and fix my computer.',
    expectFlags: { wants_meeting: true, has_job_inquiry: false },
  },
  {
    // The other direction must not regress: a recruiter pitching a role IS a job
    // inquiry even though the word "job" never appears.
    name: 'recruiter pitch stays a job inquiry (guard the other direction)',
    opener:
      "I'm calling from a staffing agency — we have a contract position we'd like Dale to consider.",
    expectFlags: { has_job_inquiry: true },
  },
  {
    // THE FRONT-LOADER (2026-07-18 live call): "I'm Dale" in the opening sentence,
    // then "Can I get your name, please?" — the name must survive the hand-off by
    // riding begin_call's caller_name.
    name: 'front-loaded name is relayed through begin_call',
    opener: "Hi Chris, I'm Dale — I'd like to have my computer fixed.",
    expectFlags: { wants_meeting: true, has_job_inquiry: false },
    expectArgSubstr: { caller_name: 'dale' },
  },
  {
    // Another service-request phrasing — no overlap with the pinned live opener,
    // so the fix generalizes past one sentence.
    name: 'broken-laptop request is a service call, not a job inquiry',
    opener: "My laptop's broken and I need somebody to take a look at it.",
    expectFlags: { wants_meeting: true, has_job_inquiry: false },
  },
  {
    // THE HARD ONE: the caller literally says "a job" about a repair. The new
    // definition names this exact trap ('even if they call it "a job"').
    name: 'a repair the caller CALLS "a job" is still a service call',
    opener:
      "I've got a job for Dale — my printer's been acting up and I need him to come sort it out.",
    expectFlags: { wants_meeting: true, has_job_inquiry: false },
  },
  {
    name: 'cancel opener hands off as a schedule change',
    opener: 'I need to cancel my appointment tomorrow.',
    expectFlags: { wants_schedule_change: true },
  },
];

async function turn(opener: string): Promise<{ called: boolean; args: Record<string, unknown> }> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: instructions },
        // The greeting has played; the caller's first sentence is the intent.
        { role: 'assistant', content: 'Hi, this is Chris. How can I help you today?' },
        { role: 'user', content: opener },
      ],
      tools,
      tool_choice: 'auto',
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const j = (await res.json()) as {
    choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
  };
  const tc = j.choices[0]?.message?.tool_calls?.find((t) => t.function.name === 'begin_call');
  if (!tc) return { called: false, args: {} };
  try {
    return { called: true, args: JSON.parse(tc.function.arguments || '{}') };
  } catch {
    return { called: true, args: {} };
  }
}

let runs = 0;
let passed = 0;
for (const c of CASES) {
  for (let r = 0; r < RUNS; r++) {
    runs++;
    const { called, args } = await turn(c.opener);
    // A REQUIRED flag (or any flag expected true) must be EXPLICIT — the old
    // Boolean(args[k]) check treated a missing argument as false, so
    // "has_job_inquiry: false" could pass vacuously when the model omitted the
    // required flag entirely (review on #288). Omitting an OPTIONAL flag
    // expected false is legitimate — optional-and-absent means false. The
    // required list is read off the REAL schema above, so it cannot drift.
    const requiredFlags = new Set(
      ((beginCall.parameters as { required?: string[] }).required ?? []).filter(Boolean)
    );
    const flagMisses = Object.entries(c.expectFlags)
      .filter(
        ([k, v]) =>
          (args[k] === undefined && (v === true || requiredFlags.has(k))) ||
          (args[k] !== undefined && Boolean(args[k]) !== v)
      )
      .map(([k, v]) =>
        args[k] === undefined
          ? `${k} MISSING (want explicit ${v})`
          : `${k}=${String(args[k])} (want ${v})`
      );
    const argMisses = Object.entries(c.expectArgSubstr ?? {})
      .filter(
        ([k, sub]) =>
          !String(args[k] ?? '')
            .toLowerCase()
            .includes(sub.toLowerCase())
      )
      .map(([k, sub]) => `${k}="${String(args[k] ?? '')}" (want substring "${sub}")`);
    flagMisses.push(...argMisses);
    if (called && flagMisses.length === 0) {
      passed++;
      console.log(`PASS  ${c.name}`);
    } else if (!called) {
      console.log(`FAIL  ${c.name} — begin_call NOT called (the model chatted instead)`);
    } else {
      console.log(`FAIL  ${c.name} — wrong flags: ${flagMisses.join(', ')}`);
    }
  }
}
console.log(`\n${passed}/${runs} runs passed`);
process.exit(passed === runs ? 0 : 1);
