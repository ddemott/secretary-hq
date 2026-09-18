# Branch Protection Recommendations

**Status (2026-06-15)**: The rule has been applied to `main` via `gh api` using the settings below (verified live). This file now serves as the source of truth and audit record.

This document describes the recommended branch protection rules for the `main` branch. Even as a solo developer, these rules provide safety and enforce the development workflow.

## Recommended Settings for `main`

Go to **Settings → Branches → Branch protection rules → Add rule** for the `main` branch.

### Required settings (strongly recommended)

- [x] **Require a pull request before merging**
  - Required approvals: 0 (or 1 if you ever want a second set of eyes)
  - Dismiss stale pull request approvals when new commits are pushed
  - Require review from Code Owners (optional, useful later)

- [x] **Require status checks to pass before merging**
  - **Required status checks** (select _all_ of these for the full CI gate):
    - `Backend (typecheck + tests + integration)` (from `.github/workflows/ci.yml`)
    - `Dashboard (typecheck + tests)`
    - `Agent (typecheck + tests)`
    - `E2E (Playwright)`
  - Require branches to be up to date before merging (recommended)

- [x] **Require branches to be up to date before merging**
  - This forces you to rebase/merge latest `main` before the PR can be merged.

- [x] **Require conversation resolution before merging**
  - Forces all review comments to be resolved.

- [ ] **Restrict who can push to matching branches**
  - NOT applied (`restrictions: null` live, checked 2026-09-18). Direct pushes are still blocked because the PR requirement above is enforced on admins too.

### Additional recommended settings

- [x] **Include administrators** (check this)
  - Applies the rules to you as well — prevents accidental direct pushes to `main`.

- [x] **Allow force pushes** → **Do not allow**
  - Keep this off for `main`.

- [x] **Allow deletions** → **Do not allow**
  - Keep this off.

- [ ] **Require signed commits** (optional but good practice; NOT enabled live, checked 2026-09-18)

### Nice-to-have (when the team or project grows)

- Require approval from at least one Code Owner for sensitive paths (`src/`, `dashboard/`, `scripts/`, etc.).
- Require linear history (no merge commits) — personal preference.
- Require successful deployment to a staging environment before merging.

## How to Set This Up

**Applied**: 2026-06-15 (via `gh api` using the payload matching the "Required settings" below). To re-apply or audit:

1. Go to the repository on GitHub.
2. **Settings** → **Branches**.
3. Under "Branch protection rules", edit the rule for `main` (or use `gh api repos/ddemott/secretary-hq/branches/main/protection` to inspect).
4. Ensure the boxes and required status checks listed above are selected.
5. Save changes.

To verify live: `gh api repos/ddemott/secretary-hq/branches/main/protection` (should show the 4 contexts + enforce_admins true). Use `./scripts/simulate.sh ci` before any merge to `main`.

## Enforcement Alignment with Our Workflow

These protection rules directly support the process defined in `docs/workflow/DEVELOPMENT_WORKFLOW.md`:

- You **cannot** push directly to `main` (enforces feature branches).
- You **must** open a PR (enforces the PR template and checklist).
- CI must pass (enforces `checks`, `pre-pr`, and relevant tests).
- The PR template checklist must be mentally satisfied before you can merge.

This combination (branch protection + PR template + `commit-code` skill + local checklist) creates multiple layers of safety.

---

**Note for solo developers**: It is tempting to turn these rules off "because it's just me." Experience shows that the friction these rules add is exactly what prevents the painful "I broke main at 2am" situations. Keep them on.
