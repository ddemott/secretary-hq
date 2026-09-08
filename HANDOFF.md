# HANDOFF

Read this first after session reset.

_Updated 2026-09-04 — newest section is the branch-merge queue below; older handoffs follow._

## 2026-09-04 — The branch-merge queue is CLOSED

Every PR that was open at the start of this work is merged, re-tested against
`main`, and purged from local AND remote. `git ls-remote --heads origin` shows
`main` plus one branch, `copilot/fix-dashboard-typecheck-tests` (#387), which is
Dale's call — see below.

### Merged and fully purged

| PR   | Squash    | What it was                                                    |
| ---- | --------- | -------------------------------------------------------------- |
| #394 | `d0c31ac` | T-006 / T-010 / T-011                                          |
| #391 | `2ab4363` | T-007 E2E flakiness                                            |
| #396 | `636b567` | clock ordering                                                 |
| #397 | `75b5e44` | GoLivePanel status-poll clobber                                |
| #392 | `bfd5045` | T-008 validate intake trees                                    |
| #395 | `d8f4e72` | T-012 deploy checklist + T-103 KB round-trip + T-106           |
| #393 | `19437bf` | T-015 wizard starter services (31 verticals)                   |
| #398 | `95692b0` | rebuild-db.sh restores api_user (opened + closed this session) |

Prod deploys verified after the merges by watching `/health`'s `started_at`
move (07:29:22Z, then 08:35:24Z) rather than assuming the trigger fired.

### The two remote branches that would not delete — fixed at the cause

`fix/T-007-followup-test-timeout` and `fix/golive-stale-status-clobbers-error`
are gone, confirmed with `git ls-remote` and not with a push exit code.

The reason they had survived two attempts is fixed: `scripts/example-pre-push-hook.sh`
ran the FULL backend suite on a branch DELETION, so a suite that went red for an
unrelated reason BLOCKED the purge outright. Git signals a deletion with an
all-zero LOCAL sha; the hook now exits 0 on a deletion-only push. Measured: a
deletion skips in 11 ms, a deletion mixed with a real ref still runs the checks.

### #387 — still Dale's call, but the evidence is now conclusive

`git merge-tree --write-tree origin/main copilot/fix-dashboard-typecheck-tests`
returns **the exact tree hash of `main`** (`b214128`). Merging it would change
nothing; its 13,509-line diff is entirely `main`'s newer work that it lacks. By
`docs/TODO_ITEM_LIFECYCLE.md` it is an empty leftover: close the PR, purge the
branch. Not done here because it is someone else's open PR.

### What the reviews turned up — these were not rubber stamps

Copilot findings on #392, #393 and #398 were substantive and all were fixed:

- **#393 was losing data.** `POST /templates/create` passed
  `JSON.stringify(body.example_services ?? [])` — the string `[]`, never SQL
  NULL — so the upsert's `COALESCE(EXCLUDED..., business_templates...)` guard
  could never fire. Any template edit that did not resend the list (a rename, a
  voice change) replaced that vertical's starter services with an empty array,
  returned 200, and logged nothing. That is the exact blank-wizard state T-015
  exists to end. The column is NOT NULL, so the fix coalesces `$14` to `[]` for
  the INSERT and reads `$14` RAW in the ON CONFLICT branch. The route had NO
  test; it has 12 now, including a real-DB one, mutation-proven.
- **#392's proof did not prove.** The catalog loop derived a preset from a
  business_type and compiled THAT, so `answering_service_front_desk` — which
  deliberately derives elsewhere — was never compiled at all, under a failure
  message naming it. And `treeIds.some(id => id.startsWith(slug))` passed for a
  salon whose `salon_intake` had been repointed at `salon_nails_addon`. Both
  measured, both now fail on the broken wiring.
- **#398** was granting the right privileges without re-asserting
  `NOSUPERUSER`/`NOBYPASSRLS`, which is half a guarantee — an elevated role
  holds the correct verbs and bypasses every policy.

### The DB trap that cost the most time, now fixed

`scripts/rebuild-db.sh` restored `app_user` and NOT `api_user`. The realdb test
rig connects as `api_user` (`tests/utils.ts` `API_DB_URL`), and `baseline.sql`
is dumped `--no-privileges`, so a rebuild left it with ZERO grants: **332 tests
across 49 files** failed with `permission denied for table tenants` — the exact
message the script's own comment predicts.

The first fix was WRONG and the tests caught it: re-running
`20260228000003_api_user.sql` grants ALL PRIVILEGES, handing back the TRUNCATE
BUG-008 revoked. Re-running `20260316100000_fix_high_bugs.sql` instead would
have been worse — the same file recreates `book_appointment_atomic` against
`employee_shifts` (dropped 2026-04-30). So the restore is now a declarative
`scripts/sql/restore-role-grants.sql`, and the script ABORTS on a zero grant
count or an elevated role rather than announcing success.

**KNOWN LIMIT, documented not fixed:** baseline mode cannot produce a
CI-equivalent DB. `baseline.sql` carries no data and `setup-db.sh --baseline`
only MARKS migrations applied, so `business_templates.system_prompt_template`
and `.example_services` stay empty — `seed.sql` says so itself and leaves them
to the insert migrations. `auth.test.ts` and `vocabulary.test.ts` need that
data. For a DB that matches CI:

```bash
U="postgres://postgres:postgres@localhost:5433/test_db"
psql "$U" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
bash scripts/setup-db.sh "$U" && DATABASE_URL="$U" npm run db:seed
```

`test_db` is currently in exactly that state: 192 migrations, no drift.

### Open loose ends, stated rather than buried

- **One unexplained test failure.** A full backend run showed
  `1 failed | 252 passed` and the output was not captured before two
  consecutive re-runs came back fully green. The failing test was never identified. The obvious suspects
  were checked and ruled out: `vocabulary.test.ts` filters by an explicit type
  list and `starterServices.test.ts` parses `seed.sql` text, so neither can see
  the throwaway `business_templates` row the new realdb test inserts. Recorded
  as unexplained, not as solved — same class as the 30-failure run noted in the
  previous handoff.
- **T-008 and T-012 still read 🟡 on the roadmap** even though #392 and #395
  merged. Left exactly as `main` asserts them: both are `Mixed`/human-owner
  tasks with open human halves, and promoting them is Dale's call, not a merge
  resolution's.
- The `activationOutcomeForTenant` guard from #397 is still not unit-covered,
  and the mechanism producing the same-tenant re-poll in the wizard is still
  unknown. Unchanged from the previous handoff.

### Environment notes that still apply

1. Run the backend suite in the FOREGROUND (the background runner kills it
   claiming low memory when there is none) and run pushes via
   `setsid nohup … &` — the pre-push hook takes ~7 min.
2. One heavy thing at a time; concurrent runs corrupt the shared test DB.
3. The Docker DB does not survive a reboot: `docker start secretary-hq-db`, and
   it takes ~90 s before it accepts connections. Every realdb test fails with
   `ECONNREFUSED 127.0.0.1:5433` until it does, which reads like 332 broken
   tests and is one stopped container.

---

## 2026-09-01 — Vertical Intake Question Trees for 30 verticals (branch `feat/vertical-intake-trees`)

> Complete handoff. Everything the author knew, did, is doing, and planned to do next is
> written down here. If you are picking this up cold, read this file top to bottom first —
> you should not need to reconstruct anything from memory or chat history.

**Branch:** `feat/vertical-intake-trees` (branched from `main` @ `c1cc794`)
**Local commit:** `feat(checklist): add slot-filling intake question trees for 30 verticals`
**Status:** Feature complete. Full test suite green locally (agent, root, root `test:ci`,
shared, dashboard). Typecheck + prettier + eslint clean. **Not yet pushed** — the only
outstanding step is opening the PR, which was blocked by a GitHub App permission limit
(details in "What is left" → §1). A `.patch` and a git `.bundle` of the commit were exported
as a fallback so nothing is lost (see §"Artifacts / fallback").

---

## 1. Why this exists (task origin & motivation)

The AI secretary resolves a **checklist preset** per tenant from their `business_type`. Before
this change, only 5 presets existed (`auto_shop_front_desk`, `salon_front_desk`,
`local_service_front_desk`, `owner_for_hire_front_desk`, `law_firm_front_desk`). Every vertical
that wasn't auto-shop / salon / law-firm / owner-for-hire fell through to
`local_service_front_desk`, whose intake asks only generic questions. So a plumber, a caterer,
a real-estate office, etc. all took calls with the same shapeless "what do you need?" flow and
captured none of the trade-specific facts that make a booking or message actionable.

**The task:** give each of the product's **30 non-HIPAA business verticals** its own
slot-filling **intake question tree**, wire it through the block/preset/derivation layers, keep
the database CHECK constraint and the dashboard UI in sync, and prove it all with a green test
suite.

### Guiding principle carried throughout (important)

> "The code tests the test and the tests test the code. Tests hold the business logic in
> place."

Tests were treated as the source of truth for business logic. They were **not** gutted to make
things pass. Where a test failed, the fix was either (a) the code was wrong — fix the code, or
(b) the feature legitimately changed an invariant the test enumerates — update only that
enumeration and preserve the test's protective intent. Every single test edit is itemized with
justification in §5. If you change this feature, hold that same line.

### Vertical scope & the HIPAA exclusion

The 30 verticals are exactly the product's business-template catalog (seeded into the
`business_templates` table by `supabase/migrations/2026*_*business_templates*.sql` +
`20260321000001_template_categories.sql` + `20260407000000_answering_service_template.sql`),
**minus** the three HIPAA-gated verticals removed by
`20260321000000_remove_hipaa_templates.sql`: `dentist`, `chiropractor`, `vet-clinic`. Those are
excluded until the product has a formal HIPAA/BAA compliance program. (Note: `vet-clinic` is
arguably HIPAA-safe and could be re-enabled later, but it's out of scope here to stay
conservative.) Do **not** add intake trees for those three without a compliance decision.

### The 30 vertical slugs (canonical order — keep this order everywhere)

```
auto_shop, mobile_tire, car_detailing, body_shop, oil_change, car_wash,
salon, barbershop, nail_salon, spa, med_spa, lash_studio,
plumber, electrician, hvac, pest_control, cleaning, landscaping,
garage_door, locksmith, personal_trainer, yoga_studio, tax_prep, tutoring,
photography, real_estate, insurance, answering_service, bakery, catering
```

Business-type slugs in the DB use hyphens (`mobile-tire`); preset/tree/vertical ids use
underscores (`mobile_tire`). The derivation layer normalizes hyphen→underscore.

---

## 2. Architecture — how a call actually uses this (data flow)

Understanding this chain is the fastest way to grok the change:

```
tenant.business_type  (e.g. "plumber", stored with hyphens for multiword)
   │
   ▼  shared/checklistPresetDerivation.ts
defaultChecklistPresetIdForBusinessType(businessType)
   │   1. normalize (hyphen→underscore, lowercase)
   │   2. law-firm lane  → law_firm_front_desk
   │   3. owner-for-hire / answering-service lane → owner_for_hire_front_desk
   │   4. PRESET_BY_BUSINESS_TYPE[normalized]  → <slug>_front_desk   ← NEW
   │   5. fallback → local_service_front_desk
   ▼
resolveChecklistPresetId(businessType, presetOverride)  (explicit override wins)
   ▼
deriveChecklistRuntimeConfig(...) → RUNTIME_BY_PRESET[presetId]  ← NEW per-preset map
   │   yields { preset_id, enabled_conversation_blocks, enabled_policy/knowledge/outcome_blocks,
   │            overrides, version }
   ▼
agent/src/checklist/presets.ts  PRESET_LIBRARY[presetId]  → VerticalPresetDef
   │   .conversation_blocks = ['identity','<slug>_intake','booking','message','qa','schedule_change']
   ▼
agent/src/checklist/blockLibrary.ts  BLOCK_LIBRARY['<slug>_intake']
   │   kind:'conversation', sink:'composed', tree_refs:['<slug>_intake'], pairs_with:[...]
   ▼
agent/src/checklist/trees.ts  PLATFORM_TREE_LIBRARY['<slug>_intake']  → QuestionTreeDef
   │   the actual slot-filling questions the caller is asked
   ▼
(blockCompiler assembles the enabled blocks' trees into the live tracker for the call)
```

Two parallel consumers also read the preset id list:

- **Dashboard UI:** `dashboard/lib/checklistPresets.ts` (`CHECKLIST_PRESET_IDS` + labels) →
  `BusinessTypePicker.tsx` shows which checklist a business type uses.
- **Database:** the `tenants.checklist_preset_id` column has a CHECK constraint
  (`tenants_checklist_preset_id_valid`) enumerating every valid preset id. A test
  (`tests/presetCatalogConstraint.test.ts`) asserts the constraint's id list exactly equals
  `CHECKLIST_PRESET_IDS`. So the migration, the shared list, and the dashboard list must all
  agree — there are now **33** ids (the original 5 + 28 new intake presets; auto_shop & salon
  were already in the 5).

**Provisioning:** `src/services/tenants/bootstrap.ts` calls
`verticalForBusinessType(businessType)` → `copy_question_tree_templates_to_tenant(tenantId,
[vertical])`. Because `verticalForBusinessType` now derives the vertical from the resolved
preset (`presetId.replace(/_front_desk$/, '')`), a new plumber tenant provisions the `plumber`
vertical's trees, not the generic `local_service` set. This is why the bootstrap test's
mobile-tire expectation changed from `['local_service']` to `['mobile_tire']` (§5).

---

## 3. Exactly what was built

Each vertical gets, end to end:

1. **Intake tree** — `<slug>_intake` (e.g. `plumber_intake`): a `QuestionTreeDef` of
   text/choice nodes, **no action nodes**. Has a `description` (>40 chars) used by the purpose
   selector. Node ids are **vertical-prefixed** to avoid cross-tree tracker collisions.
   Emergency-capable trades (plumber, electrician, hvac, garage_door, locksmith, pest_control)
   include an `urgency` choice node (`emergency` / `scheduled`); the description notes the
   emergency branch routes to an immediate callback.
2. **Conversation block** — `<slug>_intake`: `kind:'conversation'`, `sink:'composed'`,
   `tree_refs:['<slug>_intake']`, `pairs_with:['identity','booking','message']`.
3. **Front-desk preset** — `<slug>_front_desk`:
   `conversation_blocks:['identity','<slug>_intake','booking','message','qa','schedule_change']`,
   `forbidden_trees:['job','buy_service']`, `defaults:{ booking_mode, primary_intake:'<slug>_intake' }`.

`auto_shop` and `salon` already shipped as first-class presets — they were **extended in
place** (added their `*_intake` block + `primary_intake`), not duplicated. Hence the generated
`VERTICAL_INTAKE_PRESETS` contains **28** presets (30 − auto_shop − salon), while
`VERTICAL_INTAKE_TREES` and `VERTICAL_INTAKE_BLOCKS` each contain all **30**.

### Files

**New**

- `agent/src/checklist/verticalIntakeTrees.ts` — generated source of truth. Exports:
  30 `*_INTAKE_TREE` consts; `VERTICAL_INTAKE_TREES` (array of 30); `VERTICAL_INTAKE_BLOCKS`
  (Record of 30 blocks); `VERTICAL_INTAKE_PRESETS` (array of 28).
- `supabase/migrations/20260901000000_vertical_intake_preset_ids.sql` — idempotent `DO` block
  that drops & re-adds the `tenants_checklist_preset_id_valid` CHECK with all **33** ids.
  Dated `20260901000000` so it sorts **last** (see §6 gotcha about the constraint test).

**Modified**

- `agent/src/checklist/trees.ts` — import + spread `...VERTICAL_INTAKE_TREES` at the end of
  `PLATFORM_TREE_LIBRARY`.
- `agent/src/checklist/blockLibrary.ts` — import + spread `...VERTICAL_INTAKE_BLOCKS` at the
  end of `BLOCK_LIBRARY`.
- `agent/src/checklist/presets.ts` — extended `AUTO_SHOP_PRESET` (`auto_shop_intake` +
  `primary_intake`) and `SALON_PRESET` (`salon_intake` + `primary_intake`); import + spread
  `...VERTICAL_INTAKE_PRESETS` into `PRESET_LIBRARY`.
- `shared/checklistPresetDerivation.ts` — `CHECKLIST_PRESET_IDS` → 33; added
  `VERTICAL_INTAKE_SLUGS` (30), `intakeRuntime()` helper, `RUNTIME_BY_PRESET` map
  (5 hand-written runtimes + 28 generated), `PRESET_BY_BUSINESS_TYPE` map (excludes
  answering_service — see §6); `defaultChecklistPresetIdForBusinessType` consults the map
  after the law-firm and owner-for-hire lanes; `verticalForBusinessType` now returns
  `presetId.replace(/_front_desk$/, '')`; `deriveChecklistRuntimeConfig` now uses
  `RUNTIME_BY_PRESET[resolvedPresetId] ?? LOCAL_SERVICE_RUNTIME`.
- `dashboard/lib/checklistPresets.ts` — `CHECKLIST_PRESET_IDS` + `CHECKLIST_PRESET_LABELS`
  extended to 33 exhaustive entries.

**Tests modified** — see §5 for the full itemized table.

---

## 4. The generator (`gen_intake.py`)

`verticalIntakeTrees.ts` was produced by a one-shot Python generator kept **outside** the repo
at `/home/ubuntu/gen_intake.py` (it is a build-time author tool, not a runtime dependency, so
it was intentionally not committed). It holds a per-vertical spec (question set, choice options,
which verticals are emergency-capable) and emits the TypeScript file.

- It is a **one-shot** generator — the build does **not** run it. The committed `.ts` is the
  artifact.
- **Hand-editing `verticalIntakeTrees.ts` directly is completely fine** and is the expected way
  to tune wording going forward. Nothing re-derives it.
- If you _do_ regenerate from the Python: afterward run `cd agent && npm run format` (prettier
  reflows the generated output — the generator's raw output is not prettier-clean) and then the
  full test suite.
- If you want the generator preserved in-repo for the next person, copy it in (e.g. under
  `scripts/`), but note it currently assumes it writes to the repo path.

---

## 5. Tests — every change, with justification

Tests encode business logic; they were preserved, not gutted. Only enumerations/expected values
that the feature _legitimately_ changes were updated.

| Test file / case                                                                                          | Change                                                                                                                                                                                              | Why it's justified (not a gutting)                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/src/checklist/presetCatalog.test.ts` — "contains the five real vertical presets"                   | renamed "contains the shipped vertical presets"; id list 5 → 33                                                                                                                                     | the catalog genuinely ships 33 presets now; still asserts the exact full set                                                                                            |
| `agent/src/checklist/presetCatalog.test.ts` — auto shop compile                                           | expects `auto_shop_intake` in the compiled blocks                                                                                                                                                   | auto_shop now carries its intake block by design                                                                                                                        |
| `agent/src/checklist/presetCatalog.test.ts` — salon compile                                               | expects `salon_intake` in the compiled blocks                                                                                                                                                       | salon now carries its intake block by design                                                                                                                            |
| `agent/src/checklist/presetCatalog.test.ts` — "auto shop and salon share the same front-desk trees"       | rewritten to "share the front-desk backbone but each carry their own intake": asserts distinct intake blocks + shared backbone via `.filter(b => !b.endsWith('_intake'))` + equal `forbidden_trees` | the shared-backbone invariant the test protected still holds; the per-vertical intake is now the deliberate, asserted difference                                        |
| `shared/checklistPresetDerivation.test.ts` — salon runtime `toEqual`                                      | includes `salon_intake` in `enabled_conversation_blocks`                                                                                                                                            | derived runtime must reflect the new block                                                                                                                              |
| `shared/checklistPresetDerivation.test.ts` — auto-shop runtime `toEqual`                                  | includes `auto_shop_intake`                                                                                                                                                                         | same                                                                                                                                                                    |
| `shared/checklistPresetDerivation.test.ts` — "maps unmatched business types to the local-service default" | example changed `'plumber'` → `'florist'`                                                                                                                                                           | `plumber` is now a _mapped_ vertical, so it's no longer a valid "unmatched" example; `florist` is genuinely unmapped and still exercises the fallback the test protects |
| `tests/routes/tenant-routes.test.ts` — GET config derives salon runtime                                   | expected `enabled_conversation_blocks` includes `salon_intake`                                                                                                                                      | the route returns the new derived runtime                                                                                                                               |
| `tests/routes/agentTools/agentTools.test.ts` — agent tenant-config derives salon runtime                  | expected blocks include `salon_intake`                                                                                                                                                              | same invariant on the agent path                                                                                                                                        |
| `tests/services/tenants/bootstrap.test.ts` — mobile-tire provisioning                                     | `copy_question_tree_templates_to_tenant` param `['local_service']` → `['mobile_tire']`                                                                                                              | mobile-tire now resolves to its own vertical, so a new mobile-tire tenant provisions the `mobile_tire` trees instead of the generic fallback                            |

**The touchstone test that did NOT need changing:** `tests/questionTreeRoundTrip.test.ts` seeds
every vertical's trees into Postgres, copies them to a tenant, reads them back, and asserts
deep-equality with the TypeScript library. It passed with all 30 new trees unchanged — meaning
the DB round-trip (serialization of every listen flag, empty branch, choice option) is proven
for the new trees transitively. If you ever see this test fail after editing a tree, something
in the tree isn't surviving the DB round-trip (a dropped flag/branch) — fix the tree, not the
test.

### Local results (all green)

| Suite                                | Command                          | Result          |
| ------------------------------------ | -------------------------------- | --------------- |
| Agent                                | `cd agent && npm test`           | **969 passed**  |
| Root (tests/ + scripts/)             | `npm test`                       | **2908 passed** |
| Root CI (src/ + scripts/, DB-backed) | `npm run test:ci`                | **65 passed**   |
| Shared                               | `npx vitest run shared/`         | **61 passed**   |
| Dashboard                            | `cd dashboard && npx vitest run` | **1051 passed** |

Typecheck clean (`tsc --noEmit`) for agent, root, dashboard. Prettier + eslint clean (enforced
by the repo's pre-commit hook, which ran on commit).

### Reproducing the DB-backed tests

The DB tests need Postgres on `localhost:5433` with a migrated `test_db` and an `app_user` role
that has `NOBYPASSRLS`. What was done locally (Postgres 18 + pgvector):

```bash
initdb -D <datadir> -U postgres --auth=trust
# socket dir must be writable by you; /var/run/postgresql is not
pg_ctl -D <datadir> -o "-p 5433 -c unix_socket_directories='<writable dir>'" -l /tmp/pg.log start
psql postgres://postgres@localhost:5433/postgres -c "ALTER USER postgres WITH PASSWORD 'postgres';"

# creates test_db + runs migrations up to the setup script's cutoff, asserts app_user NOBYPASSRLS
DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres npx tsx scripts/setup-test-db.ts

# the setup script stops at 20260813000000; apply the remaining migrations (incl. this branch's
# 20260901000000) against test_db so question_tree_templates etc. exist, then:
psql postgres://postgres:postgres@localhost:5433/test_db -c "ALTER USER app_user WITH PASSWORD 'app_user';"

DATABASE_URL=postgres://postgres:postgres@localhost:5433/test_db \
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/test_db \
TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5433/test_db \
  npm test        # and: npm run test:ci
```

Without a DB, the DB-backed files (`questionTreeRoundTrip`, `seedLocalBusiness`,
`tenantLiveCallJourneys`, `rlsIsolation`, `rlsAppWritePaths.realdb`) self-skip or fail on
connect — that's environmental, not a regression.

---

## 6. Design decisions & gotchas (read before editing)

- **`answering_service` is deliberately special — do not "fix" it casually.** The
  `answering-service` _business_type_ still maps to `owner_for_hire_front_desk`, NOT to
  `answering_service_front_desk`. Reason: a protected 2026-08-13 regression test in
  `shared/checklistPresetDerivation.test.ts` requires answering-service to keep the `job` tree
  (it references specific `SCL_3a8SkDKzxN4B` / `SCL_KLvqZ2JkaQFU` tenants). The
  `answering_service_front_desk` preset and `answering_service_intake` tree/block DO ship and
  ARE reachable (via the preset, present in `PRESET_LIBRARY` and in the constraint) — but no
  business_type resolves to them yet, so `answering_service` is **excluded from
  `PRESET_BY_BUSINESS_TYPE`**. If you want answering-service to use its intake tree, you must
  first reconcile that regression test.
- **Within-tree duplicate node ids are intentional.** e.g. `real_estate_intake` reuses a
  `budget` node under both the buying and renting branches, and `timeline` under buying and
  selling. This mirrors the established job-tree pattern (`rate_range` under multiple
  employment-type branches); the tracker supports the same node appearing under multiple
  branches. All ids are vertical-prefixed so there are no _cross-tree_ collisions.
- **Intake trees have no action nodes** → their blocks are `sink:'composed'` with non-empty
  `pairs_with`. That's exactly what `agent/src/checklist/blockContract.test.ts` requires
  (no-action ⇒ composed; pairs_with non-empty; all pair targets exist). If you add an action
  node to an intake tree, its block's `sink` must change accordingly or that test will fail.
- **The migration must sort last.** `tests/presetCatalogConstraint.test.ts` reads the
  highest-sorting migration filename containing `ADD CONSTRAINT
tenants_checklist_preset_id_valid`, parses its `checklist_preset_id IN (...)` quoted ids, and
  requires an exact match (both directions) with `CHECKLIST_PRESET_IDS`. **When you add or
  remove any preset, you must update all three id lists together** —
  `shared/checklistPresetDerivation.ts`, `dashboard/lib/checklistPresets.ts`, and a **new,
  later-dated** migration re-asserting the full list — or this test fails.
- **`conversationBlockLabel` has a fallback** (`blockId.replace(/_/g,' ')`), so the new intake
  blocks display as e.g. "plumber intake" without explicit `CONVERSATION_BLOCK_LABELS` entries.
  Adding nicer labels is an optional polish, not required.
- **Trees need `description` > 40 chars** (the purpose-selector validation). All generated
  descriptions satisfy this; keep it in mind if you hand-edit.

---

## 7. Git state & artifacts / fallback

- Branch `feat/vertical-intake-trees` off `main` @ `c1cc794`, one commit on top.
- `.abacus.donotdelete` in the working tree is an environment artifact — it is intentionally
  **not** committed. Stage files explicitly.
- Because the PR push was blocked at handoff (see §8), the commit was exported as a portable
  fallback so the work is reproducible on any clone:
  - `vertical-intake-trees.patch` — `git format-patch main --stdout` (apply with
    `git am < vertical-intake-trees.patch` or `git apply`).
  - `vertical-intake-trees.bundle` — `git bundle` of `main..feat/vertical-intake-trees`
    (fetch with `git fetch vertical-intake-trees.bundle feat/vertical-intake-trees`).
    These live in the delivery output folder, not in the repo. If you have push access, prefer
    just pushing the branch — the patch/bundle are only a safety net.

---

## 8. What is left (in priority order)

1. **Push the branch & open the PR (base `main`).** At handoff this was blocked **only** by a
   GitHub App permission limit: the `abacusai` GitHub App installation had read-only access to
   `ddemott/secretary-hq`, so `git push`, the create-branch API, and the create-PR API all
   returned `403 "Resource not accessible by integration"`. This is an App-installation scope
   limit, independent of the user's own `push=true` role, so retrying/alternate write methods
   won't help. **Fix:** grant the [abacusai GitHub App](https://github.com/apps/abacusai/installations/select_target)
   **Read and write** access to **Contents** and **Pull requests** on this repo, then push and
   open the PR. (If you have direct developer push access, you can also just
   `git push origin feat/vertical-intake-trees` and open the PR in the GitHub UI.)
2. **Review the generated conversation copy** in `verticalIntakeTrees.ts`. The questions are
   sensible defaults, but a domain owner may want to tune wording/order/options per trade.
   Hand-editing the `.ts` is the intended workflow (see §4).
3. **Optional follow-ups (not required for this feature):**
   - Decide whether `answering-service` should switch to its own intake preset (see §6 — needs
     the 2026-08-13 regression reconciled first).
   - Add per-block `CONVERSATION_BLOCK_LABELS` for prettier display names.
   - Seed the new trees to _existing_ tenants via the `trees:seed` / `trees:rollout` scripts if
     you want live tenants converted. New tenants already provision their vertical's trees on
     creation (§2).
   - Consider re-enabling `vet-clinic` if a HIPAA decision is made.

---

## 9. Suggested PR description (copy/paste when opening the PR)

> **feat(checklist): add slot-filling intake question trees for 30 verticals**
>
> Adds dedicated intake question trees, conversation blocks, and front-desk presets for 30
> business verticals so each captures the facts its bookings/messages actually need instead of
> falling back to the generic `local_service` tree.
>
> - `agent/src/checklist/verticalIntakeTrees.ts`: 30 intake trees + `VERTICAL_INTAKE_TREES`,
>   `VERTICAL_INTAKE_BLOCKS`, and 28 `VERTICAL_INTAKE_PRESETS` (auto_shop & salon already
>   shipped as first-class presets and were extended in place).
> - Wired into `PLATFORM_TREE_LIBRARY`, `BLOCK_LIBRARY`, `PRESET_LIBRARY`.
> - `shared/checklistPresetDerivation.ts`: preset ids → 33; per-preset runtime map;
>   business_type → preset map (answering-service intentionally still maps to
>   `owner_for_hire_front_desk`; see HANDOFF.md §6).
> - `dashboard/lib/checklistPresets.ts`: ids + labels → 33.
> - `supabase/migrations/20260901000000_vertical_intake_preset_ids.sql`: idempotent re-add of
>   the preset CHECK with 33 ids.
> - Tests updated to reflect the new (intentional) invariants, each preserving its protective
>   intent — see HANDOFF.md §5 for the itemized list.
>
> Full suite green locally: agent 969, root 2908, root CI 65, shared 61, dashboard 1051.
> See `HANDOFF.md` for the complete rationale, architecture, gotchas, and remaining steps.

## 2026-08-19 — main merged, prod moved, old blocker dead

Verdict: `main` is merged, production has moved, and the old agent `ToolContext<unknown>` blocker is gone. Current work is follow-through docs/coverage/backlog cleanup, not rescue surgery.

### Verified this session

- Branch base: `main` tracking `origin/main`
- Root/backend tests: `226 passed (226)` · `2750 passed (2750)`
- Dashboard unit tests: `97 passed (97)` · `1044 passed (1044)`
- Agent tests: `56 passed (56)` · `943 passed (943)`
- Agent build/typecheck: `cd /home/dale/projects/secretary-hq/agent && npm run build` → exit `0`
- Prod backend freshness: `GET https://secretary-hq-production.up.railway.app/health` → `{"status":"ok","started_at":"2026-08-19T08:22:19.112Z"}`
- Prod smoke route: `POST https://secretary-hq-production.up.railway.app/demo/start` → `{"success":true,...}`
- Root V8 coverage: `npx vitest run --coverage` → `2805 passed (2805)` · `74.17%` statements · `66.35%` branches · `72.64%` functions · `76.08%` lines
- Dashboard V8 coverage: `cd /home/dale/projects/secretary-hq/dashboard && npx vitest run --coverage` → `1044 passed (1044)` · `61.99%` statements · `58.17%` branches · `57.60%` functions · `63.97%` lines

### Important corrected facts

- The 2026-08-18 handoff is stale on the key point: agent build is no longer red.
- Production no longer lags local `main`; deploy freshness moved at `2026-08-19T08:22:19.112Z`.
- Working tree was clean before the doc sweep except for `docs/planning/TODO.md`; any current dirt after this point is markdown sync, not runtime drift.

### Highest-value next move

1. Re-run Playwright when you want a fresh e2e count instead of the 2026-08-18 snapshot.
2. Then tackle the still-live backlog: test DB / RLS setup, voice naturalness on simulator, real `TELNYX_PUBLIC_KEY`.
3. If you need production confidence beyond smoke, run a live simulator / call-path check against the deployed stack.

### If resetting now

Resume from verified `main` + verified prod. Do **not** restart from the old `ToolContext<unknown>` thread unless a fresh command makes it real again.

## 2026-08-18 — reset-safe handoff: functional green, agent typecheck red

Verdict: the repo is now safe to reset **with this handoff**, but it is **not** in a
fully clean/merge-ready state yet. App behavior is largely verified; the remaining
blocker is agent package typecheck/build.

### Verified this session

- Root/backend tests: `225 passed (225)` · `2747 passed (2747)`
- Dashboard unit tests: `97 passed (97)` · `1044 passed (1044)`
- Agent tests: `56 passed (56)` · `943 passed (943)`
- Full Playwright: `162 passed`, `15 skipped`, exit `0`
- Backend build: `cd /home/dale/projects/secretary-hq && npm run build` → exit `0`
- Dashboard production build: `cd /home/dale/projects/secretary-hq/dashboard && npx next build --webpack` → exit `0`

### Still red — this is the blocker

- Agent build/typecheck: `cd /home/dale/projects/secretary-hq/agent && npm run build` → exit `2`
- Failure class: widespread `ToolContext<unknown>` typing drift after LiveKit tool API
  shape changes. Runtime/tests are mostly behaving; TypeScript still rejects the old
  map-vs-wrapper typing pattern across `agent/src/checklist/*.ts`, `agent/src/tasks/*.ts`,
  `agent/src/tools.ts`, `agent/src/index.ts`, and related tests.

### Important corrected facts

- Earlier session work got functional behavior green enough to trust again:
  - caller pickup E2E fixed
  - voice styles E2E fixed
  - stale backend path assertions after `src/middleware.ts` rename fixed
  - dashboard async test races fixed
- But that does **NOT** mean the branch is clean. The exact remaining gate is the agent
  package build above. Do not claim "ready" or merge-ready until that command exits `0`.

### Working tree / branch at handoff time

- Branch: `fix/e2e-sweep-voice-coverage`
- Working tree still dirty. At the time of this handoff `git status --short` showed
  modified files across `agent/`, `dashboard/`, `public/`, root `tests/`, plus new
  `agent/src/tasks/testToolCtx.ts` and `src/middleware/`.

### Highest-value next move

Fix the agent `ToolContext` typing drift cleanly instead of papering it over with blind
casts. LiveKit's current typing expects plain tool maps / `ToolContextLike` init where
parts of this code still type those objects as `ToolContext` wrapper instances.

### Resume commands

1. `cd /home/dale/projects/secretary-hq && git status --short --branch`
2. `cd /home/dale/projects/secretary-hq/agent && npm run build`
3. Fix the `ToolContext<unknown>` typing errors
4. Re-run, in this order:
   - `cd /home/dale/projects/secretary-hq/agent && npm run build`
   - `cd /home/dale/projects/secretary-hq/agent && npm test`
   - `cd /home/dale/projects/secretary-hq && npm test`
   - `cd /home/dale/projects/secretary-hq/dashboard && npx playwright test`

### If resetting now

This handoff is the truth: behavior mostly verified, agent build still red. Resume from
the agent typecheck blocker, not from old markdown counts or older "all green" claims.

_Written 2026-08-14. Updated 2026-08-15 (local-call session) and 2026-08-15/16 (E2E
observation sweep — read that section first; it is the most recent work)._

## 2026-08-15/16 — E2E observation sweep: 20 defects, four of them livelocks

Goal: run the E2E lanes and **read the output**, not just the pass/fail — long pauses,
data repeated back that was already given, wrong paths, anything the asserts do not
cover. Then fix what turns up. Full write-up with per-finding evidence:
`docs/planning/TODO.md` § "🔬 E2E observation sweep". **Nothing committed.**

**Headline: `sim-questiontree` went 22/22.** The first run of the day deadlocked on
scenario 1 and never reached scenario 9.

**Four separate livelocks, four different mechanisms.** This is the part worth
remembering — each fix exposed the next one, because each gate covered a different
slice of "the call cannot end":

1. **The booking guard could never release.** `slotsAwaitingChoice` was cleared in
   exactly one place — a _successful_ booking — so a booking the guard itself refused
   could not clear the condition that refused it. And the guard `return`s before
   `failCounts`, so `ACTION_FAILURE_LIMIT` (the existing "stop retrying" hatch) never
   engaged. Observed: 12 refused bookings + 4 refused `finish_call` in one call, the
   caller saying goodbye twice, ending only on the harness's 48-round cap. A phone
   line has no cap. → `BOOKING_GUARD_REFUSAL_LIMIT`, budget restored on a fresh offer.
2. **The goodbye gate had no bound.** → `FINISH_REFUSAL_LIMIT`: escalates on the second
   refusal, releases on the fifth, logs `goodbye_gate_released` with the unmet nodes.
3. **The model said goodbye instead of calling `finish_call`.** Checklist COMPLETE,
   demo booked — and it traded farewells for twenty turns. → a repeating resolved-branch
   nudge in `onUserTurnCompleted` (`GOODBYE_STALL_LIMIT`) that names the missing fact:
   saying goodbye does not end a call, only `finish_call` does.
4. **The model stopped calling tools entirely.** `book` still `ready` for a caller who
   wanted a _message_; neither new hatch could see it (one needs a COMPLETE checklist,
   the other needs `finish_call` to keep being called). → the unresolved-stall nudge
   no longer latches after one firing; it re-fires, names the blocking node, and spells
   out the exit the model never finds alone: **`set_purpose` with `wrong_trees`**.

**The worst single finding:** with zero successful writes the agent told a caller _"The
meeting is set for tomorrow, Tuesday, July 22 at 1:15 PM"_, then four turns later _"I'm
still finalizing your meeting."_ Same class as the Telnyx false "sent" — the caller
hangs up believing a thing exists that does not. The refusal now ends "NOTHING IS
BOOKED: do not tell the caller the meeting is set."

**Data-integrity guards, each one something the graders let through:**

- `caller_name` was recorded as the literal string **"caller"** → `placeholderNameReason()`
- `callers_company` was recorded as **the caller's own name** → `COMPANY_NODES` guard
- a message asking for a callback was taken with **no phone number** (identity was never
  selected) → `CONTACTLESS_TREES`; the host adds `identity` to any goal-bearing selection
- `meeting_topic` recorded as **"talk with Dale"** — the value its own node text forbids
  → `topicNamesOnlyAPerson()`
- a prospect who **booked a demo** was recorded as having declined one, because
  `demo_offer` stayed open and the model went hunting → `BOOKING_CLOSES_OFFER`, keyed by
  node id so the next vertical is one line, not another postmortem
- the role matcher knew `job opportunity` but **not the plural** `job opportunities`, in
  a scenario literally named "talk with Dale about job opportunities"
- a dental-clinic owner who wanted to **buy the product** was filed as a generic message
  ("called about a business opportunity") — the work-direction gate only fires when the
  model _selects_ job or buy_service; selecting **neither** had no cover

**Two lessons that generalize past this codebase:**

- **A rule in the prompt cannot outrank an example in a tool result.** The prompt says
  "never speak these internal tokens". The tracker's own rejection message listed them
  as bare words — and the model's next sentence to the caller was "would you say your
  calls go to an **answering_service**?", underscore aloud. The refusal now prints each
  id with its spoken form and says not to say them.
- **The eval harnesses were lying, in both directions.** `sim-offscript` and
  `sim-questiontree` counted OpenAI 429s as behavioural failures — printing "3/12 (25%)"
  and "16/22" for runs where the model was largely never asked. Both now retry
  (honouring `Retry-After`), grade only what reached the model, and exit **2** for
  infrastructure rather than 1 for regression. `sim-toolselect` was grading
  **gpt-4o-mini**, which prod dropped on 2026-07-20 — and its own comment claimed it was
  "the same model the agent runs". Pointing it at `gpt-4.1-mini` took it from 77%,
  exit 1, to 85%, exit 0 — with no other change.

**Two new CI guards, both of which failed on their first run — that is the point:**

- `agent/src/checklist/actionArgCoverage.test.ts` — every required param of every action
  tool a tree can fire must be backfilled, host-supplied at runtime, or **declared
  model-only with a reason**. It immediately caught `cancel_appointment` and
  `reschedule_appointment`: both require `appointment_id`, a **UUID the model could only
  get by copying it out of a tool result and retyping it mid-call**, against this
  project's own "the model never holds a UUID" rule. Fixed rather than waived —
  `get_my_appointments` is wrapped and the host fills the id when the lookup returned
  **exactly one**. Two or more stays the model's choice: guessing which booking to
  cancel is the unconfirmed-booking mistake with a worse ending.
- `tests/routes/agentTools/policyFallbackContract.test.ts` — pins the backend's RAG
  no-answer sentence on both sides of a package boundary that has no shared import,
  because `answer_question` now keys a real guarantee off it (see below).

**Three flaky-under-load tests, same class, all fixed.** `toolsClient.test.ts` asserted
an abort finished in `<500ms` and measured 770ms while the sims were running;
`scheduling-atomic.test.ts` asserted `avg < 50ms` and `newAvg < 100ms` against **real
Postgres round trips** — almost certainly the 2 red backend tests seen mid-session that
went green on a quiet box. Wall-clock thresholds are now fake timers / opt-in
(`PERF_ASSERT=1`) behind a loose ceiling. Bonus: the test named _"compare: old 4-query
approach timing"_ never compared anything — it now asserts the ratio it always claimed.

**`qa` was a dead end.** A caller asked something the knowledge base could not answer;
the agent read the fallback aloud, asked _her_ to summarize her own question (it read
`qa_summary`'s `[ASK]` marker and turned its note-taking into an interrogation),
recorded it and hung up — name discarded, no number, no message. Both halves fixed:
the ask text says whose job it is, and `answer_question` now selects the message +
identity trees **in host code** when the KB could not answer, so the goodbye gate holds
the door until a message actually lands.

**The gap that let the drift accumulate is closed:** root `npm run checks` never ran the
agent package's format/lint/typecheck. New `checks:agent` step, wired in; agent
formatted (that is most of the file count in the diff).

**Left open ON PURPOSE, both written up in `docs/planning/TODO.md`:**

1. `sim-toolselect` grades the **LADDER**, which prod does not run — its standing
   failures are statements about dead code. Rewriting its cases onto the checklist path
   is a decision, not a bug-sweep side effect. Its pass/fail set also moves between runs.
2. **`trees.ts` changed** (`qa_summary` wording), and that file is template content in
   the DB since migration `20260814130000`. Run `npm run trees:local` locally and the
   prod tree rollout on deploy, or provisioned tenants keep the old wording.

## 2026-08-15 — local calls: the pause and the errors are gone

Goal for the session: a local call with no pause and no errors, nothing pushed to prod. **Nothing was committed and nothing was merged** — the working tree carries this session's changes on top of the batch already there.

**The pause was DNS, not TTS.** A sim call greeted at `ms_since_participant: 11944` with `pregenerated: true` — cached frame, ready, and twelve seconds of silence anyway. `dns.lookup('api.deepgram.com')` takes **11,069 ms** on this WSL host: getaddrinfo waits for A _and_ AAAA, and the Windows-side resolver (`nameserver 10.255.255.254`) takes 11 s on AAAA (`dig AAAA … @1.1.1.1`: 46 ms). Socket timeline: `{lookup: 11085, tcp: 11086, tls: 11195, done: 11607}` first request, `{done: 358}` second. **After the fix: `ms_since_participant` = 940 ms**, same cached frame.

What changed (all in the working tree):

- `agent/src/session/dnsWarm.ts` (new, + tests) — resolves the call-path hosts in **prewarm**, logs anything over 1 s at WARN, bounded at 8 s so a hung resolver can never hold a worker.
- `agent/src/session/dnsIpv4.ts` (new, + tests) — `DNS_FORCE_IPV4=true`, **default OFF**, installs an A-only lookup on `http/https.globalAgent.options.lookup`. **Not** on `dns.lookup`: `node:net` captures its default lookup by reference at module load, so patching the dns module measured 18 ms and changed nothing (first `collect()` stayed 11.7 s; via the agents it dropped to 1.7 s).
- `agent/src/index.ts` — prewarm calls the warm; `NUM_IDLE_PROCESSES` env override on `WorkerOptions` (the SDK keeps `min(cpus,4)` idle processes in production and **0** in dev, so locally the caller paid process spawn + VAD load); `tenant_config_fetched` now logs `question_tree_source` (`tenant_db` / `platform_fallback`) + `question_tree_count`.
- `agent/package.json` — **`npm run dev:local`** is now the way to run a local worker: dev agent name (the default name races the Railway worker for every dispatch), `NODE_EXTRA_CA_CERTS` (the agent's fetches to the self-signed local backend were failing TLS — that was `voice_session_start_failed` and a tenant config degraded to the name "this business"), one idle process, IPv4 lookup.
- `package.json` — `npm run trees:local` (seed templates + convert every local tenant in one command).
- `scripts/seed-question-tree-templates.ts` — the projection is now an exported `seedQuestionTreeTemplates(client)`; the CLI wrapper only runs when invoked directly.
- `tests/questionTreeRoundTrip.test.ts` — **seeds its own fixture every run.** It previously read whatever a developer had seeded by hand: a one-clause reword of `case_intake/matter_description` in `trees.ts` produced 7 failures that read like a broken conversion, and **nothing seeds templates in CI at all**, so its own guard would have thrown there on first run.
- `tests/services/browserCallerSession.test.ts` — pinned the literal banner string `Waiting up to 3 minutes`, which the (uncommitted) `SIM_CALL_JOIN_WAIT_MS` change had made a template. Now pins the default and the ordering, not the wording.
- Docs: `docs/LESSONS_LEARNED.md` (the DNS lesson), root `DEVELOPMENT_WORKFLOW.md` (local voice-call rig + the resolver fix), `CLAUDE.md`.

**Local DB state:** `test_db` was 2 migrations behind and is now at 184. The local dev DB has templates seeded and all 3 tenants converted — `/agent-tools/tenant-config` returns 10 `question_trees` and preset `owner_for_hire_front_desk` for Thinking Hammer. Playwright's globalSetup rebuilds that DB, so re-run `npm run trees:local` after an e2e run.

**Still needs root, so it is Dale's to do (optional — `DNS_FORCE_IPV4` works around it):** point the WSL resolver at 1.1.1.1 (`/etc/wsl.conf` `generateResolvConf = false` + `/etc/resolv.conf`, then `wsl --shutdown`). Commands are in root `DEVELOPMENT_WORKFLOW.md`.

**Not verified by any of this:** a real PSTN call. The browser sim proves the agent publishes audio and how fast; it sends a fake tone, not speech, so `no_caller_audio` in the log after a sim call is expected and not a fault.

### Round two — a real mic call (`sim-call-1786817155950`, 13:06 CDT) found three more

The greeting was fast (1.4 s) and the job capture worked end to end, but every SPOKEN TURN was still slow and two turns made no sound at all. Fixed:

1. **The DNS fix had only covered one seam.** `ws` sets its own `createConnection` and calls `tls.connect(options)` directly, so the global agents are never consulted. WS open **11,300 ms → 237 ms**, Aura TTS time-to-first-frame **11,445 ms → 318 ms**, once `tls.connect`/`net.connect` were patched too. The greeting (HTTP collect) had looked like proof the fix worked; the streaming path is every word after it.
2. **`silent_turn_recovered` fired twice, and its own message was wrong.** Not the tool-step cap, not an empty generation: TTS produced zero frames and LiveKit's `ttsReadIdleTimeout` (default **10 s**) ended the turn — measured at 10.003 s and 10.000 s. Three fixes: the event now reports what it observed plus `ms_since_thinking`; the watchdog's `reply_already_queued` branch arms the escalation instead of standing down (a queued reply is a promise of audio, not audio); and the cap is an explicit 4 s via `TTS_READ_IDLE_TIMEOUT_MS`.
3. **The transcript recorded a sentence the caller never heard.** The framework records assistant turns off the token stream, not off playout — so the call record showed the agent reading the phone number back, immediately followed by the caller saying "You just didn't say anything." Those lines now render as `Assistant (NOT HEARD — no audio reached the caller)`, marked from the silent-turn path.

### Round three — the booking landed, and found four more

Call `sim-call-1786818806598` (13:33 CDT) **booked** (1:00 PM Mon 17th, appointment linked to a complete `job_inquiries` row), greeting 841 ms, turns ~2–3 s, zero silent turns. What went wrong, all fixed:

1. **A 9-digit number was recorded as ✓.** `identify_caller` rejected it and the error was swallowed (it returns 200 with an `error` field; `maybeIdentify` only logs on a throw). `record_answer` now refuses an undialable `caller_phone`, names what it heard, and leaves the node open.
2. **The booking refusal dropped the caller's requested time.** He asked for 1 PM; the gate answered only about phone numbers, and he had to ask again two minutes later. `phoneGateMessage()` now leads with "I can hold 1:00 PM for you".
3. **It asked for a number "to text or call", then said it could not text.** Wording fixed, and the OTP capability is now derived — `ENABLE_PHONE_VERIFICATION && ENABLE_SMS` — so `send_verification_code` is absent while SMS is off, instead of depending on an ops note nobody had set.
4. **It asked "would you like a meeting?" after already trying to book one.** A booking ATTEMPT now records `meeting_offer: wants_meeting` in host code.

**Open, and yours:** the greeting names neither the owner nor the assistant — the caller opened with "Who's AI assistant are you? He never told me." `tenants.persona_name`, `greeting_menu`, `greeting_closer` and `call_disclosure` are all NULL for Thinking Hammer. Editable on Phone Assistant → AI Persona.

Plus: **local was not bookable** (`npm run local:business`, new `scripts/seed-local-business.ts` — localhost-only, no `--force`, idempotent). The failure was success-shaped — `{"success":true,"result":"I'm not able to pull up our booking options right now…"}` — so nothing counted it as an error and the call slid into message-taking.

## Current state

- Repo: `/home/dale/projects/secretary-hq`
- Branch: `main` (tracks `origin/main`), HEAD = `d4f64c2`
- Latest merge: PR #343 — `fix(runtime): make the job tree reachable, and stop the silent losses around it`
- Prod backend `/health` `started_at` = `2026-08-14T04:24:31.392Z` (so #343 did deploy — check this moved before believing any later merge shipped)

## What just landed

- **#340** docs sync to the shipped presets
- **#341** Step 9 wording + dry-run
- **#342** Step 10 call-path journeys
- **#343** **the job tree was unreachable by every tenant.** `job` sat in `forbidden_trees` on all three original presets, and `ChecklistOverrides` can only SUBTRACT — so no tenant configuration could select it. Two recruiter calls on 2026-08-13 wrote zero `job_inquiries` rows (`CALL1.md` / `CALL2.md`). Fix: `owner_for_hire_front_desk` preset, an unselectable-tree refusal that no longer looks like an invented-tree refusal, persisted tool RESULTS in `ToolCallLog`, and host-side refusal of an unconfirmed booking.

Live path: `tenants.checklist_preset_id` + `checklist_overrides` → `deriveChecklistRuntimeConfig` → `/agent-tools/tenant-config` → `ChecklistAgent({ runtimeConfig })`. Owners edit it on Business Settings → Call checklist.

## ROADMAP (`docs/ROADMAP.md`)

Steps 1–10 closed in CI.

## THE WORKING TREE IS NOT CLEAN (but all suites are green)

**116 changed/untracked paths, none committed** (84 tracked files, +4797/−469). Three
sessions of in-flight work stacked on `d4f64c2`, not scratch. Roughly: the batch that
was already there on 2026-08-14, the local-call/DNS session, and the E2E sweep. A large
slice of the file count is the one-off `agent/` Prettier pass — see `checks:agent`.

- **`agent/src/greetingPickup.ts` (new) + `agent/src/index.ts`** — tenant config + greeting TTS warm now run BEFORE `waitForParticipant()`, i.e. while the phone is still ringing, because `waitForParticipant` IS pickup. `GREETING_POST_PICKUP_WAIT_MS = 0`: the old cap had been raised to 12s so a slow local warm could finish, and the caller sat in dead air after join and hung up. Also: **Aura's WebSocket `speak` returned ZERO audio bytes from this dev host** while HTTP `collect` returned audio on the same key and voice — hence the collected greeting frame and the `AURA_TTS_STREAMING=false` escape hatch. Prod keeps the streaming default and has NOT been shown to have this fault; one host is not a platform outage.
- **`agent/src/checklist/checklistTools.ts` + `trees.ts`** — `meetingTopicNamesOwnerRole()` selects the `job` tree in HOST CODE when the meeting topic names a role. The node's prompt already asked the model to re-declare purpose and it did not, and by then purpose had locked anyway.
- **Legal pages** — `/privacy`, `/terms`, `/dpa` + `components/legal/LegalDocLayout.tsx`, linked from the landing footer and a required consent checkbox on `/register`. Bonterms base, not lawyer-reviewed.
- `public/caller-simulator.html` + `src/routes/callerSimulator.ts` + `dashboard/e2e/caller-pickup.spec.ts`.

**Was red, now fixed (2026-08-14):** `tests/noHardcodedNames.test.ts` caught `meetingTopicNamesOwnerRole()` hardcoding the owner's first name in its `hire|hiring` branch. That function runs for every tenant, so one business's owner name is dead weight in every other. **There is no owner-name column on `tenants`** — only `persona_name`, which names the ASSISTANT, not the person being hired — so the branch now matches pronouns and `the owner` only. The residual gap (a bare "hiring &lt;Name&gt;" no longer matches) is written into the function's comment instead of papered over: widening to "hire/hiring + any token" would swallow "hiring a plumber", a SERVICE request in this product. A name-agnostic pin test was added — that is the +1 on the agent suite below.

**Trap if this guard ever fires again:** its failure message computes line numbers AFTER stripping comments, so the line it prints does not match the file (it said `:138` for a regex on line 206). Search for the offending string; do not trust the number.

## Verified facts (measured, not copied — suite totals + evals re-run 2026-08-16, the rest 2026-08-15)

- backend route modules under `src/routes/`: **29** (plus `agentTools/`)
- `/agent-tools/*` routes: **29** (plus `_test/sync-events`, which the agent never calls)
- SQL migrations on disk: **184** · local dev DB and `test_db` both at `20260814130000`
- Playwright spec files under `dashboard/e2e/`: **40** (`caller-pickup.spec.ts` still uncommitted)
- trees in `PLATFORM_TREE_LIBRARY`: **10** · presets: **5**
- defined agent tools in `agent/src/tools.ts`: **26**
- suite totals, all three re-run against real `test_db` on **2026-08-16**: backend
  **2,744** (225 files) · dashboard **1,044** (97 files) · agent **1,704** (103 files) —
  all green. (Earlier in this doc: 2,732 / 1,044 / 1,655 as of 2026-08-15.)
- `npm run checks` exits 0 — it now also runs the **agent** package's format + lint +
  typecheck via the new `checks:agent` step; `npm run verify:claude-md` clean
- on-demand evals, 2026-08-16: `sim-questiontree` **22/22** · `sim-offscript` **12/12** ·
  `sim-toolselect` 11/13 (85%, exit 0 — grades the dead ladder path, see the sweep
  section) · `simulate.sh tools --env local` 16/16, 0 gaps
- local pickup latency, browser sim: `greeting_spoken pregenerated:true ms_since_participant` **652 ms** (tenant-DB trees) / **830 ms** (cold DB, platform fallback), zero `level:50` lines in the call
- NB `cd dashboard && npx eslint .` reports **14 pre-existing errors** (unused vars, an unescaped apostrophe) in files untouched by this session. No CI job runs eslint at all, so nothing gates on it.

## Open ops action

`scripts/pin-owner-for-hire-preset.sql` pins Thinking Hammer to the new preset. **Dale runs it, and only AFTER the agent deploys** — an unrecognized `checklist_preset_id` falls back to the derived default, so running it early is a silent no-op that looks like it worked.

## Good next checks

1. `git status --short --branch`
2. `curl -sS https://secretary-hq-production.up.railway.app/health` — `started_at` must be ≥ 2026-08-14T04:24:31Z
3. `npm test` — expect all green (**2,744**); `cd agent && npx vitest run` → **1,704**
4. Local call rig: backend + dashboard up, then `cd agent && npm run dev:local`, then `cd dashboard && npx playwright test e2e/caller-pickup.spec.ts`. Read `ms_since_participant` in the worker log.
5. Conversation quality, on demand and worth the minutes:
   `cd agent && SIM_TRACE=1 npx tsx scripts/sim-questiontree.ts` — expect **22/22**, and
   **read the transcripts**, not just the tally. Every one of the 20 defects in the
   sweep above was visible in output that a grader either passed or blamed on something
   else. Run it serially — running it alongside another OpenAI job burns the TPM ceiling
   and the scenarios come back ungraded (they now say so instead of counting as failures).

## Style reminder

Stay terse. Verify with tools. Don't trust stale markdown when the filesystem can answer it exactly.
