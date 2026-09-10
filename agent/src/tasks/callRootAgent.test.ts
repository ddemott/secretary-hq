/**
 * The ROOT AGENT's one judgement is the intent hand-off, and the flags' DEFINITIONS
 * are that judgement's whole substance — the model reads them fresh on every call.
 * These tests pin the definitions themselves (deterministic, CI-run); whether the
 * MODEL honors them is sim-begincall's job (live eval, on-demand).
 *
 * Origin: two live calls on 2026-07-18 flapped "can someone come to my house and fix
 * my computer" into has_job_inquiry=true, because the flag was defined as "mentioned
 * a job, role, contract, project, or hiring" — and a repair IS "a job" in everyday
 * speech. The caller booked a repair visit and was then asked "which company are you
 * calling from?". The definition now draws the boundary: a role brought TO the owner
 * vs work requested FROM the business.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { llm, initializeLogger, type voice } from '@livekit/agents';
import { CallRootAgent } from './callRootAgent.js';
import type { SessionContext } from '../sessionContext.js';
import { getAgentTool } from './testToolCtx.js';

beforeAll(() => {
  initializeLogger({ pretty: false, level: 'silent' });
});

function makeAgent(): voice.Agent {
  const ctx: SessionContext = {
    tenantId: 't',
    callerPhone: null,
    callId: 'test',
    roomName: 'r',
    participantIdentity: 'p',
  };
  const stubTool = llm.tool({
    description: 'stub',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'ok',
  });
  return new CallRootAgent({
    ctx,
    tools: { identify_caller: stubTool, take_message: stubTool, book_with_scheduling: stubTool },
    persona: 'You are Chris, the AI receptionist for Thinking Hammer.',
    runtime: {
      currentDate: 'Wednesday, July 16, 2026',
      currentTime: '3:00 PM',
      timezone: 'America/Chicago',
      businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
      bookableThrough: '2027-01-08',
    },
  });
}

function beginCallSchema(agent: voice.Agent): {
  description: string;
  parameters: {
    properties: Record<string, { description?: string }>;
    required?: string[];
  };
} {
  return getAgentTool(agent, 'begin_call') as ReturnType<typeof beginCallSchema>;
}

describe('has_job_inquiry draws the boundary: a role TO the owner, never work FROM the business', () => {
  // WHO: the 2026-07-18 repair callers. WHAT: both places the model sees the flag
  // must carry the boundary — instructions AND schema; the model may weight either.
  // WHY pinned as text: this is a prompt-only fix, so the only regression surface
  // IS the text. A refactor that "simplifies" either definition back to
  // "mentioned a job" re-ships the live bug with green types.

  it('HAPPY: the instruction bullet teaches the boundary and the service-request exclusion', () => {
    const instr = (makeAgent() as unknown as { instructions: string }).instructions;
    expect(instr).toMatch(/has_job_inquiry:.*TO the owner/s);
    expect(instr).toMatch(/recruiter|staffing|hiring/i);
    // The exclusion must name the failure verbatim enough to bind: asking the
    // BUSINESS to do work (fix/repair/...) is wants_meeting, not a job inquiry.
    expect(instr).toMatch(/fix, repair, build, install/);
    expect(instr).toMatch(/wants_meeting, NOT has_job_inquiry/);
    expect(instr).toMatch(/even if they call it "a job"/);
  });

  it('HAPPY: the schema description carries the same boundary (the model may read only the schema)', () => {
    const schema = beginCallSchema(makeAgent());
    const desc = schema.parameters.properties['has_job_inquiry']?.description ?? '';
    expect(desc).toMatch(/TO the owner/);
    expect(desc).toMatch(/recruiting|staffing|hiring/i);
    expect(desc).toMatch(/False for a caller asking the business to do work/);
  });

  it('SAD: the when-in-doubt rule carries the carve-out — doubt must not manufacture job inquiries', () => {
    // The doubt rule ("when in doubt, say YES to a goal") is what turned fuzzy
    // repair phrasings into job flags. The carve-out has to live IN that rule's
    // reach, naming the repair phrasing, or doubt wins again.
    const instr = (makeAgent() as unknown as { instructions: string }).instructions;
    expect(instr).toMatch(/doubt rule does not manufacture job inquiries/);
    expect(instr).toMatch(/can someone come fix my computer/);
  });

  it('HAPPY: begin_call can carry a volunteered name and number — and never requires them', () => {
    // WHO: the 2026-07-18 caller who opened with "I'm Dale" and was asked "Can I
    // get your name, please?". The root agent is the only agent that HEARS the
    // opener; if begin_call cannot carry the name, it evaporates before the
    // identity rung exists. Optional on purpose: most callers do not front-load,
    // and a required field would make the model INVENT one.
    const schema = beginCallSchema(makeAgent());
    const props = schema.parameters.properties;
    expect(props['caller_name']?.description).toMatch(/ONLY if the caller stated/);
    expect(props['caller_phone']?.description).toMatch(/ONLY if the caller spoke/);
    expect(schema.parameters.required).not.toContain('caller_name');
    expect(schema.parameters.required).not.toContain('caller_phone');
    // And the instructions teach the relay, in reach of the flag definitions.
    const instr = (makeAgent() as unknown as { instructions: string }).instructions;
    expect(instr).toMatch(/pass them along exactly as spoken/);
  });

  it("SAD: has_job_inquiry stays REQUIRED in the schema — sim-begincall's strict check depends on it", () => {
    // The eval fails a case when a required flag is omitted (review on #288: a
    // missing flag must not read as an explicit false). That strictness is only
    // sound while the flag is required; if someone relaxes the schema, the eval
    // silently loses its teeth — so the requirement is pinned here, in CI.
    const schema = beginCallSchema(makeAgent());
    expect(schema.parameters.required).toContain('has_job_inquiry');
    expect(schema.parameters.required).toContain('wants_meeting');
  });
});
