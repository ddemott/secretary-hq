/**
 * RUN THE REAL CALL JOURNEYS AGAINST A TENANT'S DATABASE-DRIVEN QUESTIONS.
 *
 * WHY THIS EXISTS ON TOP OF THE EQUALITY TESTS. `questionTreeRoundTrip.test.ts`
 * proves the trees that come out of Postgres are the same DATA as the
 * TypeScript library, and the argument was that the ~300 checklist tests which
 * exercise that library therefore cover the database path too. That argument is
 * sound, and it is still an argument. This file stops arguing and runs the
 * journeys — set_purpose → record_answer → the write tool → finish_call —
 * with the tenant's OWN rows as the library, through the same
 * createChecklistTools + ChecklistTracker the live agent builds.
 *
 * Equality can only prove that nothing was lost in transit. It cannot prove the
 * runtime accepts what came back: a tree can be faithfully reproduced and still
 * fail to construct a tracker, expose the wrong toolset, or leave the goodbye
 * gate unopenable. Those are behaviours, and behaviours have to be executed.
 *
 * TWO MODES, SO THIS IS BOTH A CI TEST AND A CONVERSION CHECK:
 *   - TENANT_UNDER_TEST names a tenant that has rows → the battery runs against
 *     that REAL business (this is the check to run when converting a client).
 *   - Otherwise → a throwaway tenant is provisioned and converted here, so CI
 *     still exercises the database-driven path on every run.
 * The mode is printed, because a test that silently fell back to a synthetic
 * tenant while claiming to cover a real one would be worse than no test.
 *
 *   npx vitest run tests/tenantLiveCallJourneys.test.ts
 *   TEST_DATABASE_URL="postgres://…/postgres" \
 *     TENANT_UNDER_TEST=d5e3c6a1-… npx vitest run tests/tenantLiveCallJourneys.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { llm } from '@livekit/agents';
import { loadTenantQuestionTrees } from '../src/services/questionTrees';
import { resolveSelectableTreeIds } from '../agent/src/checklist/checklistAgent';
import { ACTION_ARG_BACKFILL, createChecklistTools } from '../agent/src/checklist/checklistTools';
import { OWNER_FOR_HIRE_PRESET } from '../agent/src/checklist/presets';
import { materializeRuntimeConfig } from '../agent/src/checklist/runtimeConfig';
import { ChecklistTracker } from '../agent/src/checklist/tracker';
import type { QuestionTreeDef } from '../agent/src/checklist/types';

const CONNECTION =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/test_db';
const TARGET_TENANT = process.env.TENANT_UNDER_TEST ?? 'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0';
const VERTICAL = 'owner_for_hire';

const pool = new Pool({ connectionString: CONNECTION });

type Exec = (args: unknown, ctx: unknown) => Promise<unknown>;
const call = async (tools: llm.ToolContext, name: string, args: unknown = {}): Promise<string> =>
  (await (tools[name] as unknown as { execute: Exec }).execute(args, undefined)) as string;

const ok = (fields: Record<string, unknown>): string =>
  JSON.stringify({ success: true, ...fields });

function fakeTool(result: Record<string, unknown>) {
  return {
    description: 'fake',
    parameters: { type: 'object', properties: {} },
    execute: vi.fn(async () => ok(result)),
  };
}

/** Stand-ins for the real /agent-tools/* bindings — this exercises the CALL
 *  SHAPE, not the backend, exactly as presetJourneys.test.ts does. */
function makeFakes() {
  return {
    book_with_scheduling: fakeTool({ appointment_id: 'appt_1', booked_time: '3:00 PM' }),
    take_message: fakeTool({ message_id: 'msg_1' }),
    capture_job_inquiry: fakeTool({ job_inquiry_id: 'ji_1' }),
    capture_case_inquiry: fakeTool({ submission_id: 'sub_1' }),
    identify_caller: fakeTool({ customer_id: 'cust_1' }),
    get_company_policy_answer: fakeTool({ answer: 'Open 1 to 5.' }),
    get_available_slots: fakeTool({ open_times: ['3:00 PM'] }),
    get_service_catalog: fakeTool({ services: [] }),
    get_my_appointments: fakeTool({ appointments: [] }),
    cancel_appointment: fakeTool({ appointment_id: 'appt_9' }),
    reschedule_appointment: fakeTool({ appointment_id: 'appt_9' }),
    attach_meeting_notes: fakeTool({ appointment_id: 'appt_1' }),
    get_customer_context: fakeTool({ name: 'Camille' }),
    send_verification_code: fakeTool({ sent: true }),
    verify_phone_code: fakeTool({ verified: true }),
  };
}

let tenantTrees: QuestionTreeDef[] = [];
let mode = '';
let provisionedTenantId: string | null = null;

function makeKit() {
  const fakes = makeFakes();
  const tracker = new ChecklistTracker(tenantTrees);
  const closeCall = vi.fn(async () => {});
  const toolkit = createChecklistTools({
    tracker,
    // THE TENANT'S OWN ROWS ARE THE LIBRARY. This is the line the whole file
    // exists for — everywhere else in the suite this is PLATFORM_TREE_LIBRARY.
    library: tenantTrees,
    selectableTreeIds: resolveSelectableTreeIds({
      library: tenantTrees,
      runtimeConfig: materializeRuntimeConfig(OWNER_FOR_HIRE_PRESET),
    }),
    realTools: fakes,
    onSelectionChanged: vi.fn(),
    closeCall,
  });
  return { toolkit, tracker, fakes, closeCall };
}

describe("live call journeys against a tenant's database-driven questions", () => {
  beforeAll(async () => {
    const existing = await loadTenantQuestionTrees(pool, TARGET_TENANT);
    if (existing.length > 0) {
      tenantTrees = existing;
      mode = `REAL tenant ${TARGET_TENANT}`;
    } else {
      provisionedTenantId = randomUUID();
      await pool.query(
        `INSERT INTO tenants (tenant_id, name, business_type, timezone)
         VALUES ($1, $2, 'answering-service', 'UTC')`,
        [provisionedTenantId, `Journey Test ${provisionedTenantId.slice(0, 8)}`]
      );
      await pool.query('SELECT copy_question_tree_templates_to_tenant($1, $2)', [
        provisionedTenantId,
        [VERTICAL],
      ]);
      tenantTrees = await loadTenantQuestionTrees(
        pool,
        provisionedTenantId
      );
      mode = `provisioned throwaway tenant (target ${TARGET_TENANT} had no rows)`;
    }
    // Printed, not hidden: which tenant these results actually describe.
    console.log(`[tenantLiveCallJourneys] running against ${mode} — ${tenantTrees.length} trees`);
    if (tenantTrees.length === 0) {
      throw new Error('no question trees available — seed templates first');
    }
  });

  afterAll(async () => {
    if (provisionedTenantId) {
      await pool.query('DELETE FROM tenants WHERE tenant_id = $1', [provisionedTenantId]);
    }
    await pool.end();
  });

  it('HAPPY: the tracker constructs from the database trees', () => {
    // TreeDefinitionError here would mean the rows reassemble into something the
    // runtime rejects — faithful data that the engine cannot load.
    expect(() => new ChecklistTracker(tenantTrees)).not.toThrow();
  });

  it('HAPPY: a job call completes — purpose, intake, capture, then a clean goodbye', async () => {
    const { toolkit, fakes, closeCall } = makeKit();

    await call(toolkit.selectedTools(), 'set_purpose', {
      work_direction: 'caller_offers_owner_work',
      trees: ['identity', 'job'],
    });

    for (const [node_id, value] of [
      ['caller_name', 'Camille'],
      ['caller_phone', '6308229086'],
      ['callers_company', 'Insight Global'],
      ['hiring_for', 'placing_with_client'],
      ['client_company', 'Blue Cross'],
      ['role_description', 'Senior TypeScript contractor'],
      ['employment_type', 'contract'],
      ['rate_range', '65 to 80'],
      ['contract_length', 'six months'],
      ['work_mode', 'hybrid'],
      ['position_address', '300 Randolph Street'],
      ['team_timezone', 'Central'],
      ['meeting_offer', 'details_only'],
    ] as const) {
      await call(toolkit.selectedTools(), 'record_answer', { node_id, value });
    }

    await call(toolkit.selectedTools(), 'capture_job_inquiry', {});
    expect(fakes.capture_job_inquiry.execute).toHaveBeenCalled();

    await call(toolkit.selectedTools(), 'finish_call', {});
    expect(closeCall, 'the goodbye gate never opened on a completed job call').toHaveBeenCalled();
  });

  it('SAD: the goodbye gate holds the call open while the intake is unresolved', async () => {
    const { toolkit, closeCall } = makeKit();

    await call(toolkit.selectedTools(), 'set_purpose', {
      work_direction: 'caller_offers_owner_work',
      trees: ['identity', 'job'],
    });
    await call(toolkit.selectedTools(), 'record_answer', {
      node_id: 'caller_name',
      value: 'Camille',
    });

    const reply = await call(toolkit.selectedTools(), 'finish_call', {});

    // THE GATE IS THE BEHAVIOUR, NOT THE WORDING. The first version of this
    // assertion matched /still|unresolved|before/ against the refusal text and
    // failed — not because the gate leaked, but because the refusal does
    // something better than explain itself: it hands back the live checklist
    // and names the single next question ("next: ask caller_phone"). Pinning
    // prose would have made this test fail every time that message improved.
    expect(closeCall, 'the call closed with the job intake still open').not.toHaveBeenCalled();
    expect(reply, 'the refusal should hand back outstanding work, not just say no').toMatch(
      /\[ask\]|next:/i
    );
    expect(reply.toLowerCase()).toContain('caller_phone');
  });

  it('HAPPY: a booking journey books through the tenant trees', async () => {
    const { toolkit, fakes } = makeKit();

    await call(toolkit.selectedTools(), 'set_purpose', {
      work_direction: 'caller_wants_something_from_business',
      trees: ['identity', 'booking'],
    });
    for (const [node_id, value] of [
      ['caller_name', 'Sam'],
      ['caller_phone', '6308229086'],
      ['meeting_topic', 'a website build'],
    ] as const) {
      await call(toolkit.selectedTools(), 'record_answer', { node_id, value });
    }

    await call(toolkit.selectedTools(), 'get_available_slots', {});
    await call(toolkit.selectedTools(), 'book_with_scheduling', { requested_start: '3:00 PM' });
    expect(fakes.book_with_scheduling.execute).toHaveBeenCalled();
  });

  it("SAD: a tree outside this tenant's set is refused, not invented", async () => {
    const { toolkit } = makeKit();
    // fix_computer is in no preset, and case_intake belongs to the law firm.
    const reply = await call(toolkit.selectedTools(), 'set_purpose', { trees: ['case_intake'] });
    expect(reply).toMatch(/not enabled|no tree|not selectable/i);
  });

  /**
   * THE RENAME GUARD, RUN ON REAL DATA.
   *
   * ACTION_ARG_BACKFILL is keyed by node_id in TypeScript, while the node ids
   * now live in editable database rows. Rename one and nothing errors — the
   * caller answers, the checklist ticks, and the write silently stops receiving
   * the value. That is the exact class that lost location_type and then
   * role_description on live calls, now reachable through a config edit.
   */
  it("PIN: every backfill source node still exists in the tenant's trees", () => {
    const present = new Set<string>();
    const walk = (nodes: QuestionTreeDef['nodes']): void => {
      for (const node of nodes) {
        present.add(node.node_id);
        if (node.type === 'choice') {
          for (const kids of Object.values(node.options)) walk(kids);
        }
      }
    };
    for (const tree of tenantTrees) walk(tree.nodes);

    const toolsInThisVertical = ['capture_job_inquiry', 'take_message', 'book_with_scheduling'];
    const missing: string[] = [];
    for (const tool of toolsInThisVertical) {
      for (const fill of ACTION_ARG_BACKFILL[tool] ?? []) {
        for (const source of fill.from) {
          if (!present.has(source)) missing.push(`${tool}.${fill.arg} ← ${source}`);
        }
      }
    }

    expect(
      missing,
      `These ACTION_ARG_BACKFILL sources name node ids that do NOT exist in this ` +
        `tenant's trees, so the value would be collected and then dropped on the ` +
        `way to the write:\n${missing.join('\n')}`
    ).toEqual([]);
  });
});
