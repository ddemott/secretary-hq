# Migration chain squash plan

**Status:** PLAN ONLY — do **not** execute until Dale signs a prod gate.  
**Date:** 2026-09-14 (landed PR #459)  
**Source:** `docs/planning/TODO.md` P2 — Migration chain squash (~202 files).  
**Decision this pass:** **UNSAFE to squash now.** Document procedure; leave the 202-file chain intact.

> **Count note 2026-09-18:** the "202" figures below are the measurement as of 2026-09-14 and are left as written; `supabase/migrations/` now holds **205** files (+ `20260914000000`, `20260915000000`, `20260918014212`). The verdict is unchanged.

---

## 1. Current state (measured)

| Fact | Value |
|------|--------|
| Files in `supabase/migrations/` | **202** |
| Collapsed schema snapshot | `supabase/baseline.sql` (pg_dump schema-only; regen via `npm run db:baseline`) |
| Local fast rebuild | `scripts/rebuild-db.sh` prefers baseline, then `setup-db.sh --baseline` marks every file applied without running it |
| CI / prod migrate path | `bash scripts/setup-db.sh` — **chain only**, not baseline |
| Bookkeeping | `schema_migrations(version PK, filename, applied_at)` |
| Count guards | `verify:claude-md` asserts “N SQL migrations” in CLAUDE.md / README / ARCHITECTURE.md |
| Data-bearing migrations | ~88 files match insert/update/backfill patterns (not pure DDL) |
| Prior “squash” | 2026-05-18 introduced **baseline.sql as a rebuild shortcut**, not deletion of the chain (see RESOLVED baseline-drift entries) |

`baseline.sql` already carries the collapsed **schema**. That is **not** the same as collapsing the **migration history** prod and CI still depend on.

---

## 2. Verdict: why squash is unsafe today

### 2.1 Prod bookkeeping mismatch (hard blocker without a gate)

Production (and every long-lived env) has up to **202 rows** in `schema_migrations`, one per historical filename/version.

A naive squash that:

1. deletes the 202 files, and  
2. drops in one new `YYYYMMDD_squashed_schema.sql`,

causes `setup-db.sh` on prod to see a **new** version not in `schema_migrations` and **run** it. Against a live populated schema that almost always means `relation already exists` / type conflicts — or worse, partial apply if someone “fixes” it with `--continue-on-error`.

`--baseline` only **marks current files** applied; it does **not**:

- delete stale version rows for files no longer on disk, or  
- rewrite history so “old versions” equal “one squash version.”

There is **no** checked-in procedure that coordinates:

- file deletion,  
- prod `schema_migrations` rewrite,  
- and a single atomic cutover window.

### 2.2 Data migrations are not fully represented by baseline + seed

`rebuild-db.sh` documents a **known limit** of baseline mode: baseline is schema-only; `setup-db.sh --baseline` only marks files. Columns / catalog rows that **data migrations** populate are easy to lose unless every such statement is folded into `supabase/seed.sql` (or a post-squash seed path) and proven equivalent.

Examples of classes that must be inventoried before deletion:

- Template / catalog rewrites (`business_templates.*`, starter services, first_message core-lanes).  
- One-shot backfills (orphaned appointment cancels, `updated_at` honesty, default service/skill backfill).  
- Generated dual-write content (`20260901100000_starter_services.sql` + seed + `shared/starterServices.ts`).

CI builds **from the chain + seed**. Local baseline rebuild is already a second path with known gaps. Deleting the chain without closing those gaps makes CI the only honest rebuild — until someone breaks seed and has no chain left to compare.

### 2.3 Role + privilege path is special-cased

`baseline.sql` is dumped `--no-owner --no-privileges`; roles are cluster-scoped and not in the dump. `rebuild-db.sh` re-applies:

- `supabase/migrations/20260724000100_app_user_role.sql`  
- `scripts/sql/restore-role-grants.sql` (api_user — replaying older api_user migrations is wrong/destructive per that file’s header)

Any squash must keep an **explicit, tested** role/grant restore story for fresh DBs. Deleting the app_user migration file without relocating that SQL breaks rebuild and RLS realdb tests.

### 2.4 Repo coupling beyond “file count”

- Tests open specific migration paths (`migrationsOwnTransaction`, RLS, blackoutDates, preset catalog, starter-services generators).  
- CLAUDE.md narrative embeds many migration version ids as history (verify:claude-md cares about the **count** claim; humans care about the narrative).  
- Ops docs (`DEPLOYMENT_CHECKLIST`, LESSONS_LEARNED) teach chain + baseline interplay; a silent file wipe without a runbook is how the 2026-06 baseline drift class returns.

### 2.5 No existing “execute squash” runbook

What exists today:

| Piece | Purpose |
|-------|---------|
| `npm run db:baseline` / `generate-baseline.sh` | Regenerate schema snapshot from full chain |
| `rebuild-db.sh` baseline mode | Fast local wipe+schema |
| `setup-db.sh --baseline` | Mark files applied without running |
| Chain apply in CI | Honest empty-DB proof |

What does **not** exist: a single approved procedure to **delete** historical migrations, cut over prod bookkeeping, and keep green CI + prod migrate. Task rule: **prefer plan-only if uncertain; never rewrite prod history casually.**

---

## 3. When squash *would* be safe (entry criteria)

All must be true before any destructive PR:

1. **Dale prod gate (written).** Explicit approval to rewrite `schema_migrations` on production (and any staging DB that mirrors it), with a maintenance window and rollback owner.  
2. **Head parity proven.** Prod `schema_migrations` versions **equal** the set of filenames on `main` (no prod-only applied files missing from repo; no repo files never applied to prod that still matter). Capture:

   ```bash
   # local / CI reference
   ls supabase/migrations | sed 's/_.*//' | sort > /tmp/repo_versions.txt
   # prod (URL via env only — never npm argv)
   DATABASE_URL="$PROD" psql -tAc "SELECT version FROM schema_migrations ORDER BY 1" > /tmp/prod_versions.txt
   diff -u /tmp/repo_versions.txt /tmp/prod_versions.txt
   ```

3. **baseline.sql fresh.** `npm run db:baseline` on a clean throwaway DB; `npm run verify:schema` green; commit baseline if it drifted.  
4. **Data inventory complete.** Every non-DDL migration classified: obsolete | folded into seed | must remain as a post-squash “seed/migrate” step. Real empty-DB rebuild (chain vs proposed squash) compared on table list, critical functions, and template row counts.  
5. **Role restore script** is the single source of truth for app_user + api_user after schema apply (today split across migration + `restore-role-grants.sql`).  
6. **No open migration PRs** and no in-flight prod migrate. Squash is a solo cutover.  
7. **Doc + guard updates staged in the same PR:** CLAUDE.md / README / ARCHITECTURE counts, TODO, this plan → RESOLVED, any test path rewrites.

If any criterion fails → stay on the 202-file chain. baseline.sql remains the collapse for **schema readability and local speed**.

---

## 4. Recommended target design (when gate opens)

Prefer a **two-artifact** model (matches what the repo already half-implements):

### 4.1 Keep shipping additive migrations forever (default)

Do **nothing** destructive. 202 files is awkward but operationally honest. baseline.sql + verify-schema already mitigate local pain. **This is the default until §3 is green.**

### 4.2 True history squash (only after §3)

High-level shape (implement only under the gate):

1. **Freeze** `main` for migration PRs.  
2. Regenerate `baseline.sql` from current chain.  
3. Build **one** new init migration, e.g. `2026MMDD000000_schema_init.sql`, whose body is either:
   - the baseline dump plus idempotent guards where needed, **or**
   - `\i`-equivalent inline schema that CI applies on empty DB.  
4. Move **required data** that is not in seed into either:
   - `supabase/seed.sql` (dev/CI), and/or  
   - a clearly named `2026MMDD000001_catalog_data.sql` that is **idempotent** (`ON CONFLICT`, guarded UPDATEs).  
5. Relocate role/grant SQL to `scripts/sql/` (or keep one tiny migration) so rebuild/CI do not depend on a deleted historical file.  
6. **Prod cutover (manual, Dale):**

   ```text
   BEGIN;
   -- after deploy that contains ONLY the new files on disk:
   -- Option A (adopt): mark new versions applied without running
   --   (equivalent to setup-db.sh --baseline against the new file set)
   -- Option B: if init migration is written to no-op when schema present
   --   (IF NOT EXISTS / has_table guards) it may APPLY safely — still test on staging first
   COMMIT;
   ```

   Exact SQL must be rehearsed on a **prod snapshot** restored locally, not invented on the live primary.

7. Delete the old 202 files in the **same** PR as the new init + seed + doc count updates.  
8. CI must prove: empty database + `setup-db.sh` + `seed-db.sh` → full backend/agent/dashboard/e2e green.  
9. Local: `rebuild-db.sh` still works (baseline path + role restore).  
10. Update `verify:claude-md` expected counts; purge this plan into RESOLVED.

**Do not** force-push or rewrite git history of old migration blobs for “cleanliness.” Squash is a **forward** replace of the files on `main`, not a git filter-repo stunt.

---

## 5. Safer incremental alternatives (no prod gate)

These reduce pain **without** touching prod history:

| Action | Benefit | Risk |
|--------|---------|------|
| Keep regenerating `baseline.sql` after every schema migration | Local rebuild speed + schema-alignment guard | Already required |
| Archive a tarball of migrations under `docs/` or object storage **without** removing from `supabase/migrations` | Offline reading | None if chain stays |
| Split CLAUDE.md migration narrative (move deep history to RESOLVED) | Smaller agent context | Docs-only |
| Add a `scripts/list-data-migrations.sh` inventory | Prework for a future squash | None |

None of these require Dale’s prod gate.

---

## 6. Execution checklist (future PR — do not run now)

- [ ] Dale written approval + window  
- [ ] `diff` repo versions vs prod `schema_migrations` empty  
- [ ] Staging (or local restore of prod dump) rehearsal of cutover SQL  
- [ ] Data migration inventory signed off; seed parity test  
- [ ] Role/grant path single-sourced and asserted (grant counts + NOSUPERUSER/NOBYPASSRLS)  
- [ ] One PR: new init (+ optional data) migration, delete old files, baseline regen, doc counts, test path fixes  
- [ ] CI green on that PR (Backend, Dashboard, Agent, E2E, pre-merge checks)  
- [ ] Merge → prod adopt/baseline bookkeeping **before** or **with** first migrate, per rehearsal  
- [ ] `npm run status -- --env prod --deep` / health `started_at` as applicable  
- [ ] TODO item → RESOLVED; purge branch  

---

## 7. Explicit non-goals this pass

- Deleting or rewriting any file under `supabase/migrations/`.  
- Running `setup-db.sh --baseline` against production.  
- Changing `baseline.sql` solely for squash cosmetics.  
- Claiming the 2026-05-18 baseline work already “did” the chain squash — it did not.

---

## 8. Summary

**baseline.sql = collapsed schema for rebuild/guards.**  
**supabase/migrations/ = source of truth for CI and prod evolve-in-place.**  

Collapsing the second onto the first is a **coordinated prod + seed + CI** project, not a cleanup commit. Until §3 entry criteria clear, the correct P2 outcome is this plan and an open TODO pointer — **not** a destructive squash.
