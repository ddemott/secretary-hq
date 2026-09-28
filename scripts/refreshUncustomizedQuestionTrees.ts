/**
 * Recopy platform question trees onto tenants that have NOT customized them.
 *
 *   The copy function is idempotent at TREE granularity: tenants that already
 *   have rows are skipped. That is the right default — it cannot revert a
 *   client's edits. It is also why `npm run trees:local` did not pick up the
 *   2026-08-15 qa_summary reword: every local tenant already had copies, so
 *   the deploy script printed SKIP and left the old interrogation wording live.
 *
 *   This path is the deliberate exception. It deletes and recopies only when
 *   every tree on the tenant still has is_customized = false. One customized
 *   tree parks the whole tenant — partial refresh would mix platform wording
 *   with an intake the owner already diverged.
 *
 *   Tenant copies with zero trees are left alone; conversion (not refresh) is
 *   the path that first-populates them.
 */
import type { Pool } from 'pg';
import { verticalForBusinessType } from '../shared/checklistPresetDerivation';

export type RefreshResult = {
  refreshed: number;
  skippedCustomized: number;
  skippedEmpty: number;
};

type TenantRow = {
  tenant_id: string;
  business_type: string | null;
  existing_trees: number;
  customized_trees: number;
};

/**
 * Delete a tenant's question-tree rows so copy_question_tree_templates_to_tenant
 * will see an empty tenant and recopy.
 *
 * ONE statement on tenant_question_trees. Nodes follow via
 * tenant_question_nodes_tree_fk ON DELETE CASCADE. Two statements (nodes then
 * trees) leave a window where trees exist and nodes do not — the copy function
 * then SKIPS because it keys off existing trees, and the tenant is stuck with
 * empty intake until someone notices.
 */
async function wipeTenantTrees(pool: Pool, tenantId: string): Promise<void> {
  await pool.query(`DELETE FROM tenant_question_trees WHERE tenant_id = $1`, [tenantId]);
}

export async function refreshUncustomizedQuestionTrees(
  pool: Pool,
  opts: { tenantId?: string } = {}
): Promise<RefreshResult> {
  // Template businesses (is_template=true) never take calls and are
  // read-only — refuse_template_write() rejects a write to
  // tenant_question_trees for one. Excluded here for the same reason as
  // deploy-question-trees.ts's convert step: a template has no use for a
  // question tree in the first place.
  const tenants = await pool.query<TenantRow>(
    `SELECT t.tenant_id, t.business_type,
            (SELECT count(*)::int FROM tenant_question_trees q
              WHERE q.tenant_id = t.tenant_id) AS existing_trees,
            (SELECT count(*)::int FROM tenant_question_trees q
              WHERE q.tenant_id = t.tenant_id AND q.is_customized = true) AS customized_trees
       FROM tenants t
      WHERE (t.is_deleted IS NULL OR t.is_deleted = false)
        AND t.is_template = false
        AND ($1::uuid IS NULL OR t.tenant_id = $1::uuid)
      ORDER BY t.name`,
    [opts.tenantId ?? null]
  );

  const result: RefreshResult = { refreshed: 0, skippedCustomized: 0, skippedEmpty: 0 };

  for (const t of tenants.rows) {
    if (t.existing_trees === 0) {
      result.skippedEmpty += 1;
      continue;
    }
    if (t.customized_trees > 0) {
      result.skippedCustomized += 1;
      continue;
    }

    const vertical = verticalForBusinessType(t.business_type);
    await wipeTenantTrees(pool, t.tenant_id);
    const copied = await pool.query<{ n: number }>(
      'SELECT copy_question_tree_templates_to_tenant($1, $2) AS n',
      [t.tenant_id, [vertical]]
    );
    if (copied.rows[0].n === 0) {
      throw new Error(
        `refresh of tenant ${t.tenant_id} copied 0 nodes from vertical '${vertical}' — templates missing?`
      );
    }
    result.refreshed += 1;
  }

  return result;
}
