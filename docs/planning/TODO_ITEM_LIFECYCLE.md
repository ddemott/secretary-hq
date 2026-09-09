# TODO Item Lifecycle — Start to Finish (and Purge)

End-to-end process for taking one backlog item (a `docs/planning/TODO.md` entry or a `docs/PRODUCT_ROADMAP.md` task `T-XXX`) from pick → ship → branch purge.

This doc does **not** replace `DEVELOPMENT_WORKFLOW.md` or `BRANCH_CHECKLIST.md`. It stitches them into two explicit paths:

1. **Path A — Clean close** — no other feature branches/PRs open; no conflicts expected.
2. **Path B — Parallel / conflict close** — other branches or PRs are already open (exception to the one-active-PR preference), or `main` moved under you.

**Preferred default is always Path A.** Path B is the recovery / exception playbook when parallels already exist or conflicts appear after testing.

---

## Shared rules (both paths)

1. **Never commit to `main`.** Feature branch + PR only.
2. **Status (`PRODUCT_ROADMAP.md` §0.7):**
   - Start work → set task `🟡 IN_PROGRESS` (section **and** master table).
   - `✅ DONE` only when the Acceptance Test passes **and** the change is **merged to `main`**.
   - “Code done on a branch” / “CI green on a PR” is still `🟡`.
3. **One logical change per branch** when possible. Name it `feat/T-XXX-…`, `fix/T-XXX-…`, etc.
4. **Tests prove the shipped code.** After any conflict resolution / merge-from-`main`, re-run the relevant suites before claiming green — conflict picks can break code outside the lines you meant to keep.
5. **Prove the feature twice: once on the branch, once on `main`.** The branch run proves the code. The `main` run proves the _merge_ — the conflict resolution is itself an untested change, and the tree that ships is not the tree you tested. Re-run the task's own Acceptance Test against `main` **before** purging the branch, so the branch is still there to fix from if it fails.

   **Exception — a docs-only branch skips the `main` re-run.** Nothing executes, so there is no behaviour a merge could have changed. CI still has to be green (the required checks run regardless, and `verify:claude-md` / the doc-drift + secret gate are real gates on documentation). Prove it is genuinely docs-only before claiming the exception — one command, and it is the whole basis for skipping:

   ```bash
   git diff --name-only origin/main...HEAD
   ```

   Every path must be a `.md` (or another non-executing doc asset). A branch that touches a script, a config, a fixture, or `supabase/baseline.sql` alongside its docs is **not** docs-only — re-run the acceptance test.

   This waives the **re-test** only. Rule 7 still applies in full: a docs branch is purged after merge like any other. Merged and still on disk is not finished.

6. **Ship = merge to `main` via PR.** A push to a feature branch deploys nothing (Railway tracks `main`).
7. **Close-out = purge the feature branch** (local + remote) after the PR is merged and the squash/merge commit is on `origin/main`. **No dead branches left open.** A merged PR whose branch still exists is unfinished work. Same for: empty tip vs `main`, closed-unmerged leftovers you abandoned, and remote-only stale refs. Delete them.
8. **Deploy is separate from merge.** After merge, confirm prod actually moved (`/health` `started_at`, or `npm run status -- --env prod`) when the change is runtime-facing.

Useful commands:

```bash
npm run create-branch feat/T-XXX-short-slug
cp docs/BRANCH_CHECKLIST.md .
npm run checks
npm run prepare-commit
npm run pre-pr
npm run ci:status
npm run status -- --env prod
git fetch --prune origin
```

---

## Path A — Clean close (no other open branches)

Use when: no other feature PRs open, and you will not start a second branch until this one is purged.

### A1. Pick and claim

- [ ] Pick the highest-priority unblocked item from `docs/planning/TODO.md` or `docs/PRODUCT_ROADMAP.md`.
- [ ] Set roadmap status `🟡` (section + master table) if it is a `T-XXX` task.
- [ ] Confirm no open feature PRs / leftover feature branches:

```bash
gh pr list --state open
git fetch --prune
git branch -a
```

If anything feature-related is still open → use **Path B** (or finish/purge that work first).

### A2. Start the branch

- [ ] From latest `main`:

```bash
git checkout main
git pull origin main
npm run create-branch feat/T-XXX-short-slug
```

- [ ] Copy/update `BRANCH_CHECKLIST.md` locally if you use the checkbox file.
- [ ] Optional: open/link a GitHub Issue for non-trivial work.

### A3. Implement

- [ ] Code + tests (happy + sad, 5W comments on new/changed tests).
- [ ] Docs updated in the same work (`CLAUDE.md` / `planning/TODO.md` / roadmap / feature docs as needed).
- [ ] Loop: `npm run checks` and targeted tests as you go.

### A4. Pre-push gate

- [ ] `npm run prepare-commit` (or `npm run pre-pr`).
- [ ] Fix everything it finds.
- [ ] Commit with Conventional Commits (`feat` / `fix` / `test` / `docs` / …).

### A5. Publish and verify CI

- [ ] Push branch; open PR with `.github/pull_request_template.md`.
- [ ] Paste Acceptance Test evidence in the PR when claiming a roadmap task.
- [ ] Wait for **all** required CI checks green (`npm run ci:status` / `gh pr checks`).
- [ ] Resolve review threads if any.

### A6. Merge

- [ ] Merge PR into `main` (squash/merge per repo practice).
- [ ] Confirm the merge commit is on `origin/main`:

```bash
git fetch origin
git log -1 --oneline origin/main
```

### A7. Verify on `main`, then purge

- [ ] **Before deleting anything**, re-run the task's Acceptance Test against `main`:

```bash
git checkout main && git pull origin main
# then the task's own ACCEPTANCE_TEST block from PRODUCT_ROADMAP.md, verbatim
```

If it fails, the branch still exists — fix forward on it and re-merge. Purging
first turns a fixable merge into an archaeology problem.

- [ ] Delete the feature branch **local + remote**:

```bash
git checkout main
git pull origin main
git branch -d feat/T-XXX-short-slug
git push origin --delete feat/T-XXX-short-slug
```

- [ ] Set roadmap task `✅ DONE` (section + master table + DOD checkboxes that are truly met).
- [ ] Move/check off the `docs/planning/TODO.md` item; archive narrative in `docs/planning/RESOLVED.md` when appropriate.
- [ ] If runtime-facing: verify deploy (`started_at` moved / status board).
- [ ] Worktree clean; only `main` left for feature work → ready for the next item (back to A1).

---

## Path B — Parallel / conflict close (exception playbook)

Use when: other feature branches or PRs are **already** open, or your PR became `CONFLICTING` / dirty after `main` (or a sibling PR) moved.

**This path does not make parallel PRs the preferred mode.** It is how to finish safely when you are already in that state (or `main` advanced under a single open PR).

### B1. Situational awareness

- [ ] List open PRs and mergeability:

```bash
gh pr list --state open
gh pr view <N> --json number,title,mergeStateStatus,headRefName,statusCheckRollup
```

- [ ] Know the merge order: prefer merging the **CLEAN / non-conflicting** PR first when possible.
- [ ] Keep **each** task’s roadmap status honest (`🟡` until **that** change is on `main`).

### B2. Start or continue your branch

Same as Path A for create/claim, except you may already have a branch mid-flight.

- [ ] Still branch from up-to-date `main` when **starting** new work.
- [ ] Do not mark sibling tasks `✅` just because their code exists on another open branch.

### B3. Implement and test on your branch

Same as Path A §A3–A4. Get **your** change green in isolation first.

### B4. Integrate `main` (and resolve conflicts)

When GitHub shows conflicts, or after a sibling PR merges, update **your** branch from `main` by **merging `main` into the feature branch** (default):

```bash
git fetch origin
git checkout feat/T-XXX-short-slug
git merge origin/main
# resolve conflicts
git add -A
git commit   # merge commit, unless the merge was already clean
```

**Conflict hygiene (especially `docs/PRODUCT_ROADMAP.md`):**

- Do **not** blindly keep “ours” or “theirs.”
- Status lines must match §0.7 reality: already-merged work → `✅`; still-only-on-a-branch → `🟡`.
- Re-read the master table **and** the section `STATUS:` after the merge.

Optional: `gh pr update-branch <N>` on GitHub does a similar update; still pull locally before trusting the tree.

### B5. Mandatory re-test after conflict resolution

**Hard gate — and the reason is not ceremony.** Resolving conflicts means you (or the tool) chose lines from two histories. That choice can break something you never touched: a shared helper, a roadmap status that drifts, a test fixture, an import, a route registration. Pre-conflict green only proved _your_ branch on the _old_ base. It does **not** prove the merged tree.

After any merge-from-`main` (clean or conflicted):

- [ ] Re-run quality gates: `npm run checks`
- [ ] Re-run the suites that cover touched areas (backend / agent / dashboard as applicable)
- [ ] Re-run the task’s **Acceptance Test**
- [ ] If E2E-relevant: targeted Playwright (`--grep`) or the live harness you used before
- [ ] Fix anything the new base / conflict resolution broke; commit those fixes on the **same** feature branch

Do **not** push/merge on the strength of pre-merge test results alone. “Conflicts looked obvious” is not a test.

### B6. Publish the updated branch

- [ ] Push the merge + fixes (`git push`).
- [ ] Confirm PR checks re-run on the new head and go green.
- [ ] Confirm `mergeStateStatus` is `CLEAN` (or equivalent) before merge.
- [ ] Resolve review threads.

### B7. Merge order when several PRs conflict with each other

1. Merge the PR that is already `CLEAN` (or the smallest / least entangled) first.
2. For each remaining open PR: repeat **B4 → B5 → B6** (merge `main`, re-test, push).
3. Never assume two conflicting feature branches can both merge without one absorbing `main` first.
4. Empty leftover branches (diff vs `main` is empty after another PR landed the work) → close PR and purge; do not “merge” noise.

### B8. Merge, verify on `main`, purge, status (same close-out as Path A)

- [ ] Merge **this** PR to `main`.
- [ ] **Re-run this task's Acceptance Test against `main`** (Path A §A7). B5 proved
      the merged tree on the _branch_; this proves what actually landed. On a
      squash merge they are not the same commit.
- [ ] Purge **this** feature branch local + remote (Path A §A7).
- [ ] Flip **this** task to `✅` only now.
- [ ] Leave other open tasks/PRs `🟡` until each lands.
- [ ] For every remaining open PR: schedule a B4–B5 pass (they are now behind `main` again).
- [ ] Verify deploy when runtime-facing.

---

## Close-out purge checklist (both paths)

**Definition of finished includes: zero leftover feature branches for this work.**  
Merged + still on disk/GitHub = not done.

After merge to `main`:

```bash
git fetch --prune origin
git checkout main && git pull origin main

# Prove the work is on main (merge/squash commit message or file content)
git log --oneline -5 origin/main

# Delete feature branch both places
git branch -d <feature-branch>           # -D only if you have verified merge + intentional discard
git push origin --delete <feature-branch>

# Confirm gone — local list is NOT enough; prove remote empty
git branch -a | grep <feature-branch> || echo "local clear"
git ls-remote --heads origin <feature-branch>   # must print nothing
gh pr view <N> --json state,mergedAt
```

**Never claim a remote purge finished without an empty `git ls-remote --heads origin <branch>`.** Local delete ≠ remote delete. If `git push origin --delete` hangs on husky pre-push, use a deletion path that does not run the full test suite (GitHub UI / `gh api`), then re-check `ls-remote`.

Sweep for other dead wood (do this before starting the next TODO):

```bash
gh pr list --state open
git branch -vv
git branch -r --merged origin/main | grep -v 'origin/main$'
# Delete any feature branch already merged to main (local + remote).
# Close + delete anything abandoned (empty diff vs main, superseded PR, etc.).
```

Then:

- [ ] Feature branch deleted **local and remote** (not optional)
- [ ] No open PR left for this work unless intentionally still in flight
- [ ] Roadmap `✅` + DOD checkboxes that are actually true
- [ ] `docs/planning/TODO.md` updated; `docs/planning/RESOLVED.md` if the item needs a historical note
- [ ] No dirty WIP left that belongs to the closed task
- [ ] Next work starts from Path A unless parallels remain (then stay on Path B)

---

## Quick decision guide

| Situation                                                  | Path                            |
| ---------------------------------------------------------- | ------------------------------- |
| No other feature PRs/branches; starting fresh              | **A**                           |
| Only your PR open, but GitHub says conflicting with `main` | **B** (from B4)                 |
| Multiple feature PRs already open                          | **B** (exception mode)          |
| Sibling PR just merged; yours was green yesterday          | **B4 → B5** before you merge    |
| Branch tip equals `main` (work already landed elsewhere)   | Close PR; purge; don’t re-merge |

---

## Worked example — 2026-09-03, four PRs open at once

The situation this doc's Path B is for, as it actually happened:

- `#391` T-007, `#392` T-008, `#393` T-015, `#395` T-012 all open simultaneously.
- `#394` (T-006/T-010/T-011) merged first and rewrote `docs/PRODUCT_ROADMAP.md`
  (+362/-104).
- **All three older PRs went `CONFLICTING` in the same hour, on the same file**,
  none of them for a code reason. Branch protection is `strict: true`, so every
  one of them also had to absorb `main` and re-run CI regardless.
- `#393`'s last run was `cancelled` with a real failure inside it —
  `deadlock-prevention.test.ts` blew a 5003ms wall-clock budget, the exact flake
  `#394` had just fixed on `main`. A cancelled run is not a passing run and not a
  failing one; it has to be opened and read.

Lessons folded back into the rules above: every branch left open is a future
conflict against whatever merges first, and the cost is roughly the square of the
number of open branches. Finish one, purge it, then start the next.

## Related docs

- `docs/workflow/DEVELOPMENT_WORKFLOW.md` — day-to-day standards, hooks, PR process, one-active-PR rule
- `docs/workflow/BRANCH_CHECKLIST.md` — checkbox form for a single branch
- `docs/planning/PRODUCT_ROADMAP.md` §0.7 — when status may become `DONE`
- `docs/planning/TODO.md` / `docs/planning/RESOLVED.md` — backlog vs archive
- `.github/BRANCH_PROTECTION.md` — what CI must be green to merge
- `.github/pull_request_template.md` — PR evidence checklist
