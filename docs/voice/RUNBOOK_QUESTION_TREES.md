# Runbook — rolling out database-driven question trees

**What ships:** the questions a call asks move from `agent/src/checklist/trees.ts`
(TypeScript, one set for everyone) into per-tenant database rows an owner can edit
without a deploy. The TypeScript library stays as the template content and as the
runtime fallback.

**Blast radius if it goes wrong:** the questions a live caller is asked. A tenant
with no rows keeps today's behaviour exactly, so the dangerous state is not
"unconverted" — it is "converted badly and unverified."

---

## The order, and why it is this order

| #   | Step                            | Safe before the code deploy?                         |
| --- | ------------------------------- | ---------------------------------------------------- |
| 1   | Apply migrations to prod        | **Yes** — additive tables + a widened CHECK          |
| 2   | Seed templates                  | **Yes** — writes only the new template tables        |
| 3   | Convert tenants                 | **Yes** — the old agent never reads `question_trees` |
| 4   | Merge to `main` (agent deploys) | this IS the code deploy                              |
| 5   | Verify on a real call           | after 4                                              |
| 6   | `--pin-preset`                  | **No — must be after 4**                             |

Steps 1-3 are inert until step 4. That is deliberate: the database half can be
applied and proven on its own, and the code half is then an ordinary merge with
no data migration racing it.

**Step 6 is the one with a trap.** An agent that does not recognize a
`checklist_preset_id` falls back to the derived default _silently_ — it looks
exactly like success. That is how the `job` tree stayed unreachable for every
tenant on 2026-08-13. Pin only after the worker that knows the preset is live.

---

## Commands

Everything below is idempotent and safe to re-run.

### 1. Migrations

```bash
npm run db:migrate -- "$PROD_DATABASE_URL"
```

Adds `20260814120000` (preset CHECK re-sync) and `20260814130000` (the four
question-tree tables + `copy_question_tree_templates_to_tenant()`).

> `20260814120000` also fixes a live bug: `owner_for_hire_front_desk` shipped in
> code on 2026-08-13 but was never added to the CHECK constraint, so
> `scripts/pin-owner-for-hire-preset.sql` aborts with
> `violates check constraint "tenants_checklist_preset_id_valid"`. Until this
> migration runs, that ops script cannot succeed.

### 2. Seed the templates

```bash
npx tsx scripts/seed-question-tree-templates.ts --db "$PROD_DATABASE_URL" --force
```

Projects the TypeScript library into `question_tree_templates` — one vertical
per preset in `PRESET_LIBRARY` (33 as of #388; this said "5 verticals × 10 trees"
before that), each carrying the FULL `PLATFORM_TREE_LIBRARY` (40 trees) — see
`treesForVertical()` in the seed script. Rewrites template rows only; **never touches a tenant's copy**, so a
client who has customized their intake cannot be reverted by a re-seed.

`--force` is required for any non-local URL. That is the guard against pointing
a routine local command at production by muscle memory.

### 3. Dry run the rollout

```bash
npx tsx scripts/deploy-question-trees.ts --db "$PROD_DATABASE_URL"
```

Writes nothing. Prints the blast radius — every tenant, its `business_type`, the
vertical it resolves to, and whether it would be converted or skipped — then runs
the read-only verification against whatever is already there.

### 4. Apply

```bash
npx tsx scripts/deploy-question-trees.ts --db "$PROD_DATABASE_URL" --apply
```

Converts every tenant that has no trees yet. A tenant that already has trees is
**skipped whole, never merged** — re-running cannot restore a question a client
deleted or wording they rewrote.

To pick up a platform wording change (`qa_summary` 2026-08-15, anything later in
`trees.ts`) on tenants that have **not** customized:

```bash
npx tsx scripts/deploy-question-trees.ts --db "$PROD_DATABASE_URL" --apply --refresh-uncustomized
```

That recopies only tenants whose trees are all still `is_customized = false`.
One customized tree parks the whole tenant.

Scope to one business with `--tenant <uuid>` when converting a client at a time.

Exit code is the contract: **0 = every converted tenant matches the library, 1 =
at least one differs.** Wire it into anything that needs a gate.

### 5. Deploy the agent

Merge to `main` via PR. Railway deploys all three services from `main`, gated on
green CI. **Verify the deploy actually happened** — `/health`'s `started_at` must
move (`npm run status -- --env prod`); a red CI run marks the deployment SKIPPED,
and SKIPPED is terminal.

### 6. Pin presets (only now)

```bash
npx tsx scripts/deploy-question-trees.ts --db "$PROD_DATABASE_URL" --apply --pin-preset
```

---

## Verifying one business

```bash
npx tsx scripts/verify-tenant-question-trees.ts <tenant_id> <vertical>
```

Reads that tenant's trees back through `loadTenantQuestionTrees` — the same
function `/agent-tools/tenant-config` calls — and compares them to the TypeScript
library key-order-insensitively.

**The bar is equality, and that is the whole argument.** ~300 checklist tests in
the agent suite exercise `PLATFORM_TREE_LIBRARY`. If a tenant's rows reassemble
into identical data, every one of those tests covers that tenant's live path too.

A difference is only a bug **before** the owner has customized anything. After
that, divergence is the entire point of the feature — read it against what they
actually changed.

---

## What the tests cover, and the gap each one closes

| Test                                | Covers                                                  | The blind spot it exists for                        |
| ----------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| `questionTreeRoundTrip.test.ts`     | seed → copy → read-back equality per vertical; refresh restores stale uncustomized copies and skips customized ones | the mechanism, and the skip-existing hole |
| `questionTreeFieldCoverage.test.ts` | every node field, **every tree incl. unreachable ones** | a field added to a tree no preset offers            |
| `tenantLiveCallJourneys.test.ts`    | real call journeys on a tenant's own rows               | data can be perfect and the runtime still reject it |
| `presetCatalogConstraint.test.ts`   | preset ids vs the SQL CHECK                             | drift that only fails at a production UPDATE        |

The third one earned its place. Equality passed while the conversion was broken:
copying only a preset's trees crashed the tracker at session start with
`Action "book" requires unknown node "drop_off_ok"` — `booking.book` carries a
cross-tree requirement on a `fix_computer` node. Every copied tree was
byte-perfect; the loss was a tree that was never copied. **A tenant's library is
the whole platform tree set; the preset gates only what is SELECTABLE.**

---

## Local gotcha

Playwright's `globalSetup` runs `rebuild-db.sh`, which DROPs and reseeds the
**local `postgres` database** — wiping templates and every tenant copy. After any
E2E run, re-run steps 2 and 4 locally. Production is unaffected.

## Rollback

```sql
DELETE FROM tenant_question_trees WHERE tenant_id = '<tenant>';
```

Cascades to the nodes. That tenant falls straight back to the platform
TypeScript library — i.e. pre-conversion behaviour — with no deploy required.
