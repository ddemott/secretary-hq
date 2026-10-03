/**
 * THE CONVERSION TOUCHSTONE — database trees must be the SAME DATA as the
 * TypeScript trees, not merely a working substitute.
 *
 * WHY THIS TEST IS THE WHOLE ARGUMENT. Every checklist test in the agent suite
 * (~300 of them) exercises PLATFORM_TREE_LIBRARY: the goodbye gate, branch
 * liveness, answer discarding on a mind-change, arg backfill, the anti-double-
 * book refusal. Rewriting all of those against a database fixture would be
 * enormous and would prove less than this does. If the trees that come back out
 * of Postgres are DEEP-EQUAL to the trees those tests already run against, then
 * every one of them is, transitively, a test of the database path too.
 *
 * So the acceptance criterion for moving a real business onto database-driven
 * questions is exactly this: seed the vertical, copy it to the tenant, read it
 * back, and get the same object. Anything less than equality means some rule
 * encoded in the tree — a listen-only flag, an empty choice branch, an action's
 * `await_tree` — was quietly dropped in transit, and the call would behave
 * differently in a way no other test would catch.
 *
 * WHO: any developer converting a tenant to DB-driven trees | WHAT: template
 * seed → copy → read-back equality | WHEN: CI, and before flipping any real
 * tenant over | WHERE: question_tree_templates → tenant_question_* →
 * assembleTrees | WHY: a lossy conversion changes what callers are asked, and
 * the loss would be invisible until a live call.
 *
 * Requires a migrated test_db. The template fixture is seeded by this file's
 * own beforeAll, from the TypeScript library, on every run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  loadTemplateQuestionTrees,
  loadTenantQuestionTrees,
  type QuestionTree,
} from '../src/services/questionTrees';
import { PRESET_LIBRARY } from '../agent/src/checklist/presets';
import { PLATFORM_TREE_LIBRARY } from '../agent/src/checklist/trees';
import { seedQuestionTreeTemplates } from '../scripts/seed-question-tree-templates';
import { refreshUncustomizedQuestionTrees } from '../scripts/refreshUncustomizedQuestionTrees';

const CONNECTION =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/test_db';

const pool = new Pool({ connectionString: CONNECTION });

/**
 * A vertical's template is the WHOLE platform library, not the preset's subset.
 *
 * This expectation was originally the preset's trees, and that was wrong in a
 * way only a live journey exposed: `booking.book` has a CROSS-TREE requirement
 * on `drop_off_ok` (a `fix_computer` node), and the tracker's constructor
 * validates every `requires` id against the library it is handed. A tenant
 * copied with only its preset's trees threw at construction — i.e. the call
 * died at session start. Production has always built the tracker from the full
 * library and used the preset to gate SELECTION, so the copy must too.
 *
 * The JSON round-trip also strips the `as const` readonly-ness of the shared
 * caller nodes, so the comparison is plain data on both sides.
 */
function expectedTreesFor(_conversationBlocks: string[]): QuestionTree[] {
  return PLATFORM_TREE_LIBRARY.map((tree) => JSON.parse(JSON.stringify(tree)) as QuestionTree);
}

/** Tenants created by this file, torn down in afterAll (house rule: tests own
 *  their data, the DB ends as bare as it started). */
const createdTenantIds: string[] = [];

async function createTenant(businessType: string): Promise<string> {
  const tenantId = randomUUID();
  await pool.query(
    `INSERT INTO tenants (tenant_id, name, business_type, timezone)
     VALUES ($1, $2, $3, 'UTC')`,
    [tenantId, `RoundTrip Test ${tenantId.slice(0, 8)}`, businessType]
  );
  createdTenantIds.push(tenantId);
  return tenantId;
}

describe('question tree DB round-trip equals the TypeScript library', () => {
  beforeAll(async () => {
    // SEED THE FIXTURE FROM THE SOURCE OF TRUTH, EVERY RUN.
    //
    // This used to require a developer to have run the seeder by hand, and read
    // whatever rows were left behind. Both halves of that were wrong: nothing
    // seeds templates in CI at all (so the guard would have thrown there the
    // first time this file ran), and locally the rows silently aged out of date
    // — a one-clause reword of `case_intake/matter_description` in trees.ts on
    // 2026-08-15 produced SEVEN failures that named the tree and read exactly
    // like a broken conversion. The rows were just older than the library.
    //
    // Regenerating here costs ~300 ms and makes the comparison honest: what the
    // seeder writes TODAY versus what the library says TODAY.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await seedQuestionTreeTemplates(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      await pool.query('DELETE FROM tenants WHERE tenant_id = $1', [tenantId]);
    }
    await pool.end();
  });

  // One case per shipped vertical. A preset that gains a tree gains a case here
  // automatically, so a new vertical cannot be added without being proven.
  for (const preset of PRESET_LIBRARY) {
    it(`HAPPY: ${preset.vertical} template rows reassemble to the exact TS trees`, async () => {
      const fromDb = await loadTemplateQuestionTrees(pool, preset.vertical);
      const expected = expectedTreesFor(preset.conversation_blocks);

      // Compare tree-by-tree first: a mismatch names the tree instead of
      // dumping every vertical's whole library into the failure output.
      expect(fromDb.map((t) => t.tree_id)).toEqual(expected.map((t) => t.tree_id));
      for (const want of expected) {
        const got = fromDb.find((t) => t.tree_id === want.tree_id);
        expect(got, `${preset.vertical}/${want.tree_id} missing from the database`).toBeDefined();
        expect(got, `${preset.vertical}/${want.tree_id} differs from the TS library`).toEqual(want);
      }
    });
  }

  /**
   * THE ACTUAL CONVERSION PATH, end to end, on the vertical Thinking Hammer
   * runs (business_type 'answering-service' → owner_for_hire). This is the
   * check to run before flipping a real business over: provision → copy →
   * read back → identical questions.
   */
  it("HAPPY: a provisioned tenant's copied trees equal the TS library exactly", async () => {
    const tenantId = await createTenant('answering-service');

    const copied = await pool.query('SELECT copy_question_tree_templates_to_tenant($1, $2) AS n', [
      tenantId,
      ['owner_for_hire'],
    ]);
    expect(copied.rows[0].n, 'copy function reported zero nodes copied').toBeGreaterThan(0);

    const fromDb = await loadTenantQuestionTrees(pool, tenantId);
    const expected = expectedTreesFor(
      PRESET_LIBRARY.find((p) => p.vertical === 'owner_for_hire')!.conversation_blocks
    );

    expect(fromDb.map((t) => t.tree_id)).toEqual(expected.map((t) => t.tree_id));
    for (const want of expected) {
      const got = fromDb.find((t) => t.tree_id === want.tree_id);
      expect(got, `tenant copy of ${want.tree_id} differs from the TS library`).toEqual(want);
    }
  });

  it('HAPPY: the law-firm vertical round-trips, case_intake included', async () => {
    const tenantId = await createTenant('law-firm');
    await pool.query('SELECT copy_question_tree_templates_to_tenant($1, $2)', [
      tenantId,
      ['law_firm'],
    ]);

    const fromDb = await loadTenantQuestionTrees(pool, tenantId);
    const caseIntake = fromDb.find((t) => t.tree_id === 'case_intake');
    const expected = PLATFORM_TREE_LIBRARY.find((t) => t.tree_id === 'case_intake');

    expect(caseIntake, 'law firm tenant has no case_intake tree').toBeDefined();
    expect(caseIntake).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  /**
   * The repeated-node-id case that broke the first schema. job.rate_range sits
   * under BOTH the `contract` and `contract_to_hire` branches on purpose. A
   * schema keyed on (tree, node_id) rejected it; one keyed on the branch keeps
   * both. Pinned because "collapse the duplicate" is a tempting wrong fix.
   */
  it('PIN: a node id repeated across two branches survives on both', async () => {
    const trees = await loadTemplateQuestionTrees(pool, 'owner_for_hire');
    const job = trees.find((t) => t.tree_id === 'job');
    const employmentType = job?.nodes.find((n) => n.node_id === 'employment_type');

    expect(employmentType?.type).toBe('choice');
    if (employmentType?.type !== 'choice') throw new Error('employment_type is not a choice node');

    const inContract = employmentType.options.contract.map((n) => n.node_id);
    const inConversion = employmentType.options.contract_to_hire.map((n) => n.node_id);
    expect(inContract).toContain('rate_range');
    expect(inConversion).toContain('rate_range');
  });

  /**
   * A choice branch with no follow-up questions still has to EXIST — it is a
   * option the caller can pick. If the assembler dropped empty branches, the
   * caller could no longer choose them and the tree would silently narrow.
   */
  it('PIN: a choice branch with no children is still selectable', async () => {
    const trees = await loadTemplateQuestionTrees(pool, 'owner_for_hire');
    const job = trees.find((t) => t.tree_id === 'job');
    const hiringFor = job?.nodes.find((n) => n.node_id === 'hiring_for');

    expect(hiringFor?.type).toBe('choice');
    if (hiringFor?.type !== 'choice') throw new Error('hiring_for is not a choice node');
    expect(Object.keys(hiringFor.options)).toContain('own_company');
    expect(hiringFor.options.own_company).toEqual([]);
  });

  /**
   * IDEMPOTENCY IS AT TREE GRANULARITY, and it must never revert a client's
   * edits. Provisioning running twice — or an ops script re-run — cannot restore
   * a question the client deleted or wording they rewrote.
   */
  it('SAD: re-copying does not overwrite a customized tenant question', async () => {
    const tenantId = await createTenant('answering-service');
    await pool.query('SELECT copy_question_tree_templates_to_tenant($1, $2)', [
      tenantId,
      ['owner_for_hire'],
    ]);

    await pool.query(
      `UPDATE tenant_question_nodes
          SET ask = 'CUSTOMIZED BY THE CLIENT'
        WHERE tenant_id = $1 AND tree_id = 'job' AND node_id = 'role_description'`,
      [tenantId]
    );

    const copiedAgain = await pool.query(
      'SELECT copy_question_tree_templates_to_tenant($1, $2) AS n',
      [tenantId, ['owner_for_hire']]
    );
    expect(copiedAgain.rows[0].n, 'a re-copy should copy nothing').toBe(0);

    const after = await pool.query(
      `SELECT ask FROM tenant_question_nodes
        WHERE tenant_id = $1 AND tree_id = 'job' AND node_id = 'role_description'`,
      [tenantId]
    );
    expect(after.rows[0].ask).toBe('CUSTOMIZED BY THE CLIENT');
  });

  /**
   * WHO: operator running `npm run trees:local` after trees.ts changed | WHAT:
   * uncustomized tenant copies pick up the new platform wording | WHEN: the
   * copy function already skipped them because they had trees | WHERE:
   * tenant_question_nodes.ask for qa_summary | WHY: 2026-08-15 reworded
   * qa_summary so the model would stop asking the caller to summarize their
   * own question. deploy-question-trees.ts skips tenants that already have
   * trees, so `trees:local` left every existing copy on the old interrogation
   * wording. Refresh must recopy when is_customized is still false.
   */
  it('SAD: a stale uncustomized copy is replaced by a refresh', async () => {
    const tenantId = await createTenant('answering-service');
    await pool.query('SELECT copy_question_tree_templates_to_tenant($1, $2)', [
      tenantId,
      ['owner_for_hire'],
    ]);

    await pool.query(
      `UPDATE tenant_question_nodes
          SET ask = 'Could you please summarize your question about Dale for me?'
        WHERE tenant_id = $1 AND tree_id = 'qa' AND node_id = 'qa_summary'`,
      [tenantId]
    );

    const result = await refreshUncustomizedQuestionTrees(pool, { tenantId });
    expect(result.refreshed).toBe(1);
    expect(result.skippedCustomized).toBe(0);

    const fromDb = await loadTenantQuestionTrees(pool, tenantId);
    const qa = fromDb.find((t) => t.tree_id === 'qa');
    const expected = PLATFORM_TREE_LIBRARY.find((t) => t.tree_id === 'qa');
    expect(qa).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  /**
   * WHO: a tenant who actually edited intake | WHAT: refresh must not revert
   * them | WHEN: is_customized is true on any of their trees | WHERE:
   * tenant_question_trees.is_customized | WHY: the copy function's contract is
   * "never overwrite a customized intake". Refresh is the one new path that
   * deletes rows; if it ignored the flag it would be a silent data-loss bug.
   */
  it('SAD: a customized tenant is skipped by refresh', async () => {
    const tenantId = await createTenant('answering-service');
    await pool.query('SELECT copy_question_tree_templates_to_tenant($1, $2)', [
      tenantId,
      ['owner_for_hire'],
    ]);

    await pool.query(
      `UPDATE tenant_question_nodes
          SET ask = 'CUSTOMIZED BY THE CLIENT'
        WHERE tenant_id = $1 AND tree_id = 'job' AND node_id = 'role_description'`,
      [tenantId]
    );
    await pool.query(
      `UPDATE tenant_question_trees
          SET is_customized = true
        WHERE tenant_id = $1 AND tree_id = 'job'`,
      [tenantId]
    );

    const result = await refreshUncustomizedQuestionTrees(pool, { tenantId });
    expect(result.refreshed).toBe(0);
    expect(result.skippedCustomized).toBe(1);

    const after = await pool.query(
      `SELECT ask FROM tenant_question_nodes
        WHERE tenant_id = $1 AND tree_id = 'job' AND node_id = 'role_description'`,
      [tenantId]
    );
    expect(after.rows[0].ask).toBe('CUSTOMIZED BY THE CLIENT');
  });

  /**
   * WHO: `npm run trees:seed` / `trees:rollout --refresh-uncustomized` run
   * against a DB that also holds template businesses (is_template=true, since
   * #573/#574) | WHAT: a template must never be selected for conversion or
   * refresh | WHEN: 2026-09-27 — the first real run against prod after #574
   * added 30 template tenants crashed here: refuse_template_write() (migration
   * 20260925000000) rejects any INSERT into tenant_question_trees for a
   * template row, and neither this file's tenant-selection query nor
   * deploy-question-trees.ts's excluded is_template tenants, so the very first
   * one in alphabetical order aborted the whole rollout with an uncaught
   * Postgres error | WHERE: the `AND t.is_template = false` clause in
   * refreshUncustomizedQuestionTrees's SELECT (and the identical clause in
   * deploy-question-trees.ts's convert query) | WHY: a template never takes a
   * call, so it has no use for a question tree — exclusion is the fix, not a
   * try/catch around the trigger's rejection.
   */
  it('SAD: a template business is excluded from refresh, never written to', async () => {
    const templateId = randomUUID();
    const maintClient = await pool.connect();
    try {
      await maintClient.query("SELECT set_config('app.template_maintenance', 'on', false)");
      await maintClient.query(
        `INSERT INTO tenants (tenant_id, name, business_type, timezone, is_template, template_vertical)
         VALUES ($1, $2, 'answering-service', 'UTC', true, 'owner-for-hire')`,
        [templateId, `RoundTrip Template ${templateId.slice(0, 8)}`]
      );
    } finally {
      await maintClient.query("SELECT set_config('app.template_maintenance', 'off', false)");
      maintClient.release();
    }

    try {
      // Documents WHY exclusion is required: the DB itself refuses a direct
      // write to a template's question trees.
      await expect(
        pool.query('SELECT copy_question_tree_templates_to_tenant($1, $2)', [
          templateId,
          ['owner_for_hire'],
        ])
      ).rejects.toThrow(/read-only/i);

      // The JS-level query must exclude the template outright — scoping the
      // refresh to exactly this tenant id must be a no-op, not an error.
      const result = await refreshUncustomizedQuestionTrees(pool, { tenantId: templateId });
      expect(result).toEqual({ refreshed: 0, skippedCustomized: 0, skippedEmpty: 0 });
    } finally {
      const cleanupClient = await pool.connect();
      try {
        await cleanupClient.query("SELECT set_config('app.template_maintenance', 'on', false)");
        await cleanupClient.query('DELETE FROM tenants WHERE tenant_id = $1', [templateId]);
      } finally {
        await cleanupClient.query("SELECT set_config('app.template_maintenance', 'off', false)");
        cleanupClient.release();
      }
    }
  });

  /**
   * WHO: refresh wipe | WHAT: deleting tenant_question_trees must take nodes
   * with it | WHEN: the CASCADE fk is the only delete we issue | WHERE:
   * tenant_question_nodes_tree_fk | WHY: a two-statement wipe (nodes then trees)
   * can abort between them; copy then skips because trees still exist. Pin the
   * schema so a later migration that drops the CASCADE fails this test instead
   * of silently reopening the half-state hole.
   */
  it('PIN: deleting tenant_question_trees cascades the nodes', async () => {
    const tenantId = await createTenant('answering-service');
    await pool.query('SELECT copy_question_tree_templates_to_tenant($1, $2)', [
      tenantId,
      ['owner_for_hire'],
    ]);
    const before = await pool.query(
      'SELECT count(*)::int AS n FROM tenant_question_nodes WHERE tenant_id = $1',
      [tenantId]
    );
    expect(before.rows[0].n).toBeGreaterThan(0);

    await pool.query('DELETE FROM tenant_question_trees WHERE tenant_id = $1', [tenantId]);

    const afterNodes = await pool.query(
      'SELECT count(*)::int AS n FROM tenant_question_nodes WHERE tenant_id = $1',
      [tenantId]
    );
    expect(afterNodes.rows[0].n).toBe(0);
  });
});
