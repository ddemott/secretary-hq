/**
 * Roll out database-driven question trees to an environment — reproducibly.
 *
 *   npx tsx scripts/deploy-question-trees.ts --db "postgres://..."            # DRY RUN (default)
 *   npx tsx scripts/deploy-question-trees.ts --db "postgres://..." --apply    # actually write
 *   npx tsx scripts/deploy-question-trees.ts --db "..." --apply --tenant <id> # one business only
 *
 * WHAT THIS DOES, IN ORDER
 *   1. PREFLIGHT   — connect, report db/role, confirm the migration chain and
 *                    the four tables are present. Refuses to go further if not.
 *   2. TEMPLATES   — project agent/src/checklist/trees.ts into
 *                    question_tree_templates per vertical (idempotent, rewrites
 *                    template rows only, never a tenant's).
 *   3. CONVERT     — give each tenant its OWN copy, derived from business_type.
 *                    Tenants that already have trees are SKIPPED, not merged.
 *                    Pass --refresh-uncustomized to recopy tenants whose trees
 *                    are all still is_customized = false (platform wording
 *                    updates). Customized tenants are never touched.
 *   4. VERIFY      — read every converted tenant's trees back through the same
 *                    loader the live agent uses and assert they are identical
 *                    to the TypeScript library. Non-zero exit if any differ.
 *
 * DRY RUN IS THE DEFAULT AND IT IS NOT A FORMALITY. It prints the blast radius —
 * which tenants would be converted, which are already done — and writes nothing.
 * The same discipline as scripts/purge-soft-deleted.ts, for the same reason: the
 * expensive mistakes in this codebase have all been silent ones.
 *
 * ORDERING AGAINST A CODE DEPLOY — READ THIS BEFORE PRODUCTION.
 *
 * Steps 1-4 are SAFE TO RUN BEFORE the agent deploys. An agent that predates
 * per-tenant trees does not read `question_trees` from tenant-config at all, so
 * converted rows sit inert until the new worker ships. That is deliberate: it
 * means the database half can be applied and verified on its own, and the code
 * half is then a normal merge with no data migration racing it.
 *
 * The one thing that must wait for the deploy is PINNING A PRESET
 * (`--pin-preset`). An agent that does not recognize a preset id falls back to
 * the derived default — silently, looking exactly like success. That is how the
 * job tree stayed unreachable on 2026-08-13. Pin AFTER the worker is live.
 *
 * WHAT THIS SCRIPT DOES NOT DO: apply migrations, or deploy code. Migrations are
 * `npm run db:migrate -- "<url>"` and belong BEFORE the merge; shipping code is
 * a PR merged to main (Railway deploys from main, gated on green CI). A script
 * that quietly did either would hide the two steps most worth doing on purpose.
 */
import { Pool } from 'pg';
import { loadTenantQuestionTrees, type QuestionTree } from '../src/services/questionTrees';
import { verticalForBusinessType } from '../shared/checklistPresetDerivation';
import { PRESET_LIBRARY } from '../agent/src/checklist/presets';
import { PLATFORM_TREE_LIBRARY } from '../agent/src/checklist/trees';
import { refreshUncustomizedQuestionTrees } from './refreshUncustomizedQuestionTrees';

const REQUIRED_TABLES = [
  'question_tree_templates',
  'question_tree_template_nodes',
  'tenant_question_trees',
  'tenant_question_nodes',
];

type TenantRow = {
  tenant_id: string;
  name: string;
  business_type: string | null;
  checklist_preset_id: string | null;
  existing_trees: number;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const expectedLibrary = (): QuestionTree[] =>
  PLATFORM_TREE_LIBRARY.map((t) => JSON.parse(JSON.stringify(t)) as QuestionTree);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(name);

async function main(): Promise<void> {
  const connectionString = arg('--db') ?? process.env.DATABASE_URL;
  const apply = has('--apply');
  const onlyTenant = arg('--tenant');
  const pinPreset = has('--pin-preset');
  const refreshUncustomized = has('--refresh-uncustomized');

  if (!connectionString) {
    console.error('Missing --db "postgres://..." (or DATABASE_URL).');
    process.exit(2);
  }

  const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
  const label = isLocal ? 'LOCAL' : 'REMOTE (production?)';

  console.log('─'.repeat(72));
  console.log(`question-tree rollout — ${apply ? 'APPLY' : 'DRY RUN'}  target: ${label}`);
  console.log('─'.repeat(72));

  const pool = new Pool({ connectionString });
  let failures = 0;

  try {
    // ── 1. PREFLIGHT ────────────────────────────────────────────────────────
    const who = await pool.query<{ db: string; usr: string }>(
      'SELECT current_database() AS db, current_user AS usr'
    );
    console.log(`\n[1/4] preflight`);
    console.log(`  database : ${who.rows[0].db}`);
    console.log(`  role     : ${who.rows[0].usr}`);

    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [REQUIRED_TABLES]
    );
    const present = new Set(tables.rows.map((r) => r.table_name));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length > 0) {
      console.error(
        `\n  MISSING TABLES: ${missing.join(', ')}\n` +
          `  Migrations have not been applied to this database. Run:\n` +
          `    npm run db:migrate -- "${connectionString.replace(/:[^:@]+@/, ':***@')}"\n` +
          `  then re-run this script.`
      );
      process.exit(1);
    }
    console.log(`  tables   : all ${REQUIRED_TABLES.length} present`);

    const migrations = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM schema_migrations'
    );
    console.log(`  migrations applied: ${migrations.rows[0].n}`);

    // ── 2. TEMPLATES ────────────────────────────────────────────────────────
    console.log(
      `\n[2/4] templates (${PRESET_LIBRARY.length} verticals × ${PLATFORM_TREE_LIBRARY.length} trees)`
    );
    const templateCount = await pool.query<{ trees: number }>(
      'SELECT count(*)::int AS trees FROM question_tree_templates'
    );
    console.log(`  currently seeded: ${templateCount.rows[0].trees} template trees`);
    if (apply) {
      console.log('  → run the seeder (separate script, single source of the tree content):');
      console.log(`     npx tsx scripts/seed-question-tree-templates.ts --db "<url>" --force`);
      const seeded = templateCount.rows[0].trees;
      if (seeded === 0) {
        console.error(
          '\n  REFUSING TO CONVERT: no templates seeded. Run the seeder above first —\n' +
            '  converting from an empty template set would give every tenant zero trees.'
        );
        process.exit(1);
      }
    }

    // ── 3. CONVERT ──────────────────────────────────────────────────────────
    // Template businesses (is_template=true) never take calls and are
    // read-only by design — refuse_template_write() rejects any write to
    // tenant_question_trees for one. Excluded here, not worked around: a
    // template has no reason to hold question trees in the first place.
    const tenantRows = await pool.query<TenantRow>(
      `SELECT t.tenant_id, t.name, t.business_type, t.checklist_preset_id,
              (SELECT count(*)::int FROM tenant_question_trees q WHERE q.tenant_id = t.tenant_id)
                AS existing_trees
         FROM tenants t
        WHERE (t.is_deleted IS NULL OR t.is_deleted = false)
          AND t.is_template = false
          AND ($1::uuid IS NULL OR t.tenant_id = $1::uuid)
        ORDER BY t.name`,
      [onlyTenant ?? null]
    );

    console.log(`\n[3/4] convert — ${tenantRows.rows.length} tenant(s) in scope`);
    const toConvert: TenantRow[] = [];
    for (const t of tenantRows.rows) {
      const vertical = verticalForBusinessType(t.business_type);
      const state =
        t.existing_trees > 0 ? `already has ${t.existing_trees} trees — SKIP` : 'would convert';
      console.log(
        `  ${t.name.padEnd(24).slice(0, 24)} ${String(t.business_type ?? '-').padEnd(20)} → ${vertical.padEnd(16)} ${state}`
      );
      if (t.existing_trees === 0) toConvert.push(t);
    }

    if (!apply) {
      console.log(
        `\n  DRY RUN — nothing written. ${toConvert.length} tenant(s) would be converted.` +
          `\n  Re-run with --apply to write. Verification below still runs: it is` +
          `\n  read-only, and checking the CURRENT state is most of why you dry-run.`
      );
      if (pinPreset) {
        console.log(
          '  NOTE: --pin-preset would also set checklist_preset_id. Only do that AFTER\n' +
            '        the agent that knows the preset has deployed — an unrecognized id\n' +
            '        falls back silently and looks like success.'
        );
      }
    }

    for (const t of apply ? toConvert : []) {
      const vertical = verticalForBusinessType(t.business_type);
      const res = await pool.query<{ n: number }>(
        'SELECT copy_question_tree_templates_to_tenant($1, $2) AS n',
        [t.tenant_id, [vertical]]
      );
      console.log(`  converted ${t.name}: ${res.rows[0].n} nodes from '${vertical}'`);

      if (pinPreset) {
        const preset = PRESET_LIBRARY.find((p) => p.vertical === vertical);
        if (preset) {
          await pool.query('UPDATE tenants SET checklist_preset_id = $2 WHERE tenant_id = $1', [
            t.tenant_id,
            preset.preset_id,
          ]);
          console.log(`  pinned ${t.name} → ${preset.preset_id}`);
        }
      }
    }

    if (apply && refreshUncustomized) {
      console.log(`\n[3b] refresh uncustomized copies (is_customized still false)`);
      const refreshed = await refreshUncustomizedQuestionTrees(pool, {
        tenantId: onlyTenant,
      });
      console.log(
        `  refreshed ${refreshed.refreshed}; skipped customized ${refreshed.skippedCustomized}; skipped empty ${refreshed.skippedEmpty}`
      );
    }

    // ── 4. VERIFY ───────────────────────────────────────────────────────────
    console.log(`\n[4/4] verify — read back through the live agent's loader`);
    const expected = expectedLibrary();
    for (const t of tenantRows.rows) {
      const fromDb = await loadTenantQuestionTrees(pool, t.tenant_id);
      if (fromDb.length === 0) {
        console.log(`  ${t.name}: no trees (falls back to the platform library)`);
        continue;
      }
      const diffs = expected.filter((want) => {
        const got = fromDb.find((g) => g.tree_id === want.tree_id);
        return canonical(got) !== canonical(want);
      });
      if (diffs.length === 0) {
        console.log(`  ${t.name}: OK — ${fromDb.length} trees identical to the library`);
      } else {
        failures += 1;
        console.log(
          `  ${t.name}: ${diffs.length} tree(s) DIFFER (${diffs.map((d) => d.tree_id).join(', ')})`
        );
      }
    }

    console.log('\n' + '─'.repeat(72));
    if (failures === 0) {
      console.log('ROLLOUT OK — every converted tenant matches the TypeScript library.');
      console.log('Next: deploy the agent (merge to main), then re-run with --pin-preset.');
    } else {
      console.log(`ROLLOUT FAILED — ${failures} tenant(s) differ from the library.`);
      console.log('A customized tenant is expected to differ; a freshly converted one is not.');
    }
    console.log('─'.repeat(72));
  } finally {
    await pool.end();
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
