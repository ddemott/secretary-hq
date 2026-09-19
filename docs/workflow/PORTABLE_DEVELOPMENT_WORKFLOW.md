# Portable Development Workflow

**Goal**: Give any project (solo or team) a repeatable, high-quality process for branching, coding, testing, documenting, and committing — with as much automation as possible.

**Project-type aware** (v1.2+): Set `projectType` in `workflow.config.json` ("python", "node-fullstack", etc.). The scripts automatically run only the relevant commands (ruff + pytest for Python, eslint + tsc + vitest for TS SaaS, etc.).

The recommended hand-off artifact is now:

- `ADOPTING_THE_WORKFLOW.md`
- A generated `portable-workflow-kit/` (via `npm run generate-kit -- --project-type <type>`)

This document + `workflow.config.json` are still useful reference, but `ADOPTING_THE_WORKFLOW.md` + the kit is the easiest way to transfer the rules.

## 1. Core Philosophy

- Work always happens on short-lived feature branches.
- Automation handles what it can (lint, typecheck, tests, doc drift detection).
- Humans handle what requires judgment (commit messages, scope of E2E, final review).
- Documentation is part of the work, not an afterthought.
- Multiple layers of safety (local hooks, scripts, PR template, CI, branch protection).

## 2. Getting Started in a New Project

1. Copy these files into your repository:
   - `PORTABLE_DEVELOPMENT_WORKFLOW.md` (this file)
   - `workflow.config.json`
   - `docs/BRANCH_CHECKLIST.md` (adapt as needed)
   - `scripts/create-feature-branch.sh`
   - `scripts/prepare-commit.sh`
   - `scripts/setup-hooks.sh` and `scripts/remove-hooks.sh`
   - `.github/pull_request_template.md`
   - `.github/BRANCH_PROTECTION.md` (recommendations)
   - `.github/ISSUE_TEMPLATE/` (feature.md + bug.md)

2. Edit `workflow.config.json` for your project:
   - Update command strings under `commands`
   - Change branch prefix rules if desired
   - Point to your actual documentation files
   - Set your preferred test frameworks and commands

3. Run `npm install` (or equivalent) after adding Husky (see section 6).

4. Update your `package.json` scripts using the values from your `workflow.config.json`.

5. (Optional but recommended) Set up branch protection on your main branch using the guidance in `.github/BRANCH_PROTECTION.md`.

## 3. Branching & Starting Work

Always start new work with:

```bash
npm run create-branch feat/my-feature-name
```

This script (customized from the portable version) will:

- Pull latest main
- Create a properly named branch
- Copy your local checklist
- Automatically run initial quality gates defined in your config

**Naming convention** (customizable in config):

- `feat/`
- `fix/`
- `test/`
- `refactor/`
- `docs/`
- `chore/`

## 4. While Developing

Use these commands frequently:

- `npm run checks` — Fast local loop (format, lint, typecheck)
- `npm test` — Unit tests
- Run relevant E2E selectively (example): `npx playwright test --grep "auth|booking"`

Every new or changed test should contain 5W comments (Who/What/When/Where/Why).

Update documentation as you go (see your `workflow.config.json` → `documentation.filesThatMustBeUpdated`).

## 5. Before Committing

Run the heavy automation command:

```bash
npm run prepare-commit
```

This script executes everything that can be automated from the checklist:

- Quality checks
- Unit tests
- Documentation drift detection
- Detection of focused tests (`.only`, `.skip`)
- Basic safety scans

Review the output, fix issues, then invoke your commit process (in this project we use the `commit-code` Claude skill; in other projects you can use a similar checklist + human review + `git commit`).

## 6. Git Hooks (Early Feedback)

The system uses **Husky** for automatic hook management.

After running `npm install`, the hooks defined in `.husky/` are installed automatically (via the `prepare` script).

Current recommended hooks:

- `pre-commit`: Runs on staged files only (fast & relevant)
- `pre-push`: Runs full quality checks + unit tests before pushing

To manually manage (legacy — `setup-hooks` just points you back at Husky's `npm run prepare`; `remove-hooks` only cleans stale `.git/hooks` entries):

```bash
npm run setup-hooks
npm run remove-hooks
```

**Philosophy**: Local hooks are for speed and early feedback. Real enforcement lives in `prepare-commit`, the PR template, CI, and branch protection.

## 7. Pull Requests & Review

- Always open PRs from feature branches.
- Use the PR template (it embeds the full checklist).
- Require the automated checks (`prepare-commit` output) to be clean.
- Self-review using the checklist before requesting review.
- Merge only after all items (including documentation) are complete.

## 8. Adapting to Your Project

The `workflow.config.json` file is the single place to customize:

- Your main branch name
- Your lint/format/typecheck/test/build commands
- Which documentation files are sacred
- Your preferred hook behavior
- Whether you use Conventional Commits, etc.

**Example adaptation steps**:

1. Change `"mainBranch"` if you use `master`.
2. Replace the `commands` values with your actual tooling (e.g., `pnpm`, `jest`, `tsc` only, etc.).
3. Update the list of files that must be kept in sync.
4. Adjust the checklist in `BRANCH_CHECKLIST.md` to match your standards.

## 9. Recommended Supporting Files

- `BRANCH_CHECKLIST.md` — Living checklist copied into every feature branch.
- `PR template` — Enforces the process at merge time.
- `Branch Protection` recommendations (see `.github/BRANCH_PROTECTION.md`).
- Issue templates (feature / bug).

## 10. Optional Advanced Automation

- Use `lint-staged` on top of Husky for even smarter pre-commit behavior.
- Add file-based test selection in `prepare-commit.sh`.
- Create a meta-script `npm run new-work` that combines branch creation + checklist setup.

## 11. Enforcement Layers (Defense in Depth)

1. Local hooks (early, fast)
2. `prepare-commit` script (heavy automation)
3. PR template + checklist (human + process gate)
4. CI (automated verification)
5. Branch protection rules (GitHub enforcement)
6. Human discipline + the `commit-code` (or equivalent) process

## 12. Getting Help / Reference Implementation

See the original implementation in the SecretaryHQ project:

- `docs/workflow/DEVELOPMENT_WORKFLOW.md`
- `workflow.config.json`
- `scripts/` (especially `create-feature-branch.sh` and `prepare-commit.sh`)
- `.github/` templates and protection docs

This portable version is designed so you can point someone at this document + the config file and say:

> "Read `PORTABLE_DEVELOPMENT_WORKFLOW.md`, copy `workflow.config.json`, adapt the values, and implement the same process."

---

**This system exists to protect future-you and future collaborators.**

Automate what can be automated. Enforce the rest through multiple layers. Keep the process visible and easy to follow.
