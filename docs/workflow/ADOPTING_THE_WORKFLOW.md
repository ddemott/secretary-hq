# Adopting This Development Workflow

**Point other projects here.**

If you want another team or project to adopt the same development, branching, testing, documentation, and commit processes, send them this document + the `portable-workflow-kit/` folder.

Everything they need is contained in this file and the kit.

The goal is to give you a battle-tested, lightweight-but-rigorous system for:

- Consistent branching
- Automated quality gates
- Documentation hygiene
- Reliable commit and PR processes

## Quick Start (5–10 minutes)

### Easiest Way (Recommended)

In the source project, run:

```bash
npm run generate-kit -- --zip
```

This will create a clean, ready-to-distribute copy in `dist/portable-workflow-kit/` plus a zip file.

**Advanced options for releases:**

```bash
# Bump version + create git tag + zip
npm run generate-kit -- --zip --tag --bump patch

# Use a custom tag prefix
npm run generate-kit -- --zip --tag --bump minor --tag-prefix "my-workflow/v"
```

Supported bump types: `patch`, `minor`, `major`.

Then give the recipient the zip (or the folder) + point them to this document.

### Manual Way

1. Copy the entire `portable-workflow-kit/` folder into your repository.
2. Read and customize `workflow.config.json` (inside the kit).
3. Follow the step-by-step instructions in this document.

## What You Get

- Automated branch creation with quality gates
- Local Git hooks (pre-commit + pre-push) managed via Husky
- Powerful `prepare-commit` automation
- Clear checklists and PR templates
- Strong emphasis on testing + documentation
- A repeatable process that works for solo developers and small teams

## Step-by-Step Adoption Guide

### 1. Copy the Adoption Kit

Copy the entire `portable-workflow-kit/` directory into your project.

Recommended location: project root.

### 2. Understand Project Types (Critical for Easy Transfer)

**This is the single most important field for making the rules travel cleanly.**

In `workflow.config.json` (the one inside the kit you just copied), set:

```json
"projectType": "python"     // or "node-fullstack", "generic"
```

The automation scripts (`prepare-commit`, the Husky pre-commit/pre-push hooks, etc.) **read this value** plus the `commands` block and the `projectTypeProfiles` library.

**What this buys you**:

- A Python recipient running `npm run prepare-commit` (or the direct script) will **only** execute `ruff`, `black`, `pytest`, etc. — never `eslint`, `tsc`, or `vitest`.
- The pre-commit hook will not try to run TypeScript tooling on `.py` files.
- The focused-test scan (`commands.focusedTestScan`) uses language-appropriate patterns.
- You hand them one folder + this document and the governance "just works" for their stack.

**Supported starter profiles** (see `projectTypeProfiles` in the config):

- `node-fullstack` — TypeScript SaaS (Next.js + backend). The original full-fat profile.
- `python` — ruff + black + pytest (FastAPI, Django, CLIs, data projects, etc.).
- `generic` — Empty placeholders. You fill in the `commands` block yourself.

**How to adopt for a Python project (concrete example)**:

1. Generate (or copy) the kit with `--project-type python` (recommended):

   ```bash
   npm run generate-kit -- --project-type python --zip
   ```

   The emitted `workflow.config.json` will already have `projectType: "python"` and the `commands` block pre-filled with sensible ruff/pytest strings.

2. Or manually: open the kit's `workflow.config.json`, set `"projectType": "python"`, then copy the entire `python` object from `projectTypeProfiles` into the top-level `commands` key and tweak the exact flags/paths for your repo.

3. The scripts now do the right thing automatically. No further editing of `prepare-commit.sh` or hooks is required.

The same pattern works for Go, Rust, or a mixed monorepo. The config is the contract; the scripts are now interpreters of that contract.

### 3. Customize `workflow.config.json` (The Only File Most People Touch)

This is the **single source of truth**. Everything else (scripts, hooks, docs) reads it.

Typical flow for any project:

1. Set `projectType` (see previous section).
2. Copy the matching block out of `projectTypeProfiles` into the top-level `commands` object.
3. Edit the 6–8 command strings to match your exact binaries, monorepo layout, or CI nuances.
4. Update `documentation.filesThatMustBeUpdated` to the real list of files that must stay current in your repo.
5. (Optional) tweak `branching`, `testing`, `hooks` policy, etc.

Example diff for a Python team that uses ruff + pytest + mypy:

```json
"commands": {
  "checks": "ruff check . && black --check . && mypy .",
  "unitTests": "pytest -q --tb=line",
  "build": "python -m py_compile $(git ls-files '*.py') 2>/dev/null || true",
  "lint": "ruff check .",
  "formatCheck": "black --check .",
  "docDriftCheck": "python scripts/check_doc_drift.py || true",
  ...
}
```

The `prepare-commit` script, pre-commit hook, and pre-push hook will now execute **exactly** those strings (or skip them gracefully if you left an `echo "..."` placeholder).

You almost never need to edit the `.sh` files themselves after the first adoption.

### 3. Install Supporting Scripts

Copy the scripts from the kit into your `scripts/` folder (create it if needed):

- `config-reader.sh` (the helper every other script sources to read `workflow.config.json`)
- `create-feature-branch.sh`
- `prepare-commit.sh`
- `setup-hooks.sh`
- `remove-hooks.sh`
- The example hook scripts

Make them executable:

```bash
chmod +x scripts/*.sh
```

### 4. Add npm / Task Runner Scripts (Optional but Recommended)

If your project uses npm (or pnpm, yarn, etc.), wire the workflow into `package.json`:

```json
"scripts": {
  "create-branch": "bash scripts/create-feature-branch.sh",
  "prepare-commit": "bash scripts/prepare-commit.sh",
  "setup-hooks": "bash scripts/setup-hooks.sh",
  "remove-hooks": "bash scripts/remove-hooks.sh",
  "checks": "bash -c 'source scripts/config-reader.sh && eval \"$(get_command checks)\"'",
  "pre-pr": "npm run checks && npm run prepare-commit"
}
```

**For pure Python / Go / Rust projects** (no package.json or you prefer direct calls):

- You can invoke the scripts directly:
  ```bash
  bash scripts/create-feature-branch.sh feat/my-change
  bash scripts/prepare-commit.sh
  ```
- **One active PR at a time**: Before starting a new feature branch, the previous one must be pushed → merged to main → deleted (local + remote). This is enforced in both `prepare-commit` and the `BRANCH_CHECKLIST.md`.
- The scripts are completely self-contained once `workflow.config.json` is correct.
- Many teams still add a `pyproject.toml` `[tool.poe.tasks]` or a `Makefile` with the same names for muscle-memory consistency across the company.

The important contract is: `prepare-commit` and the hooks must ultimately call the values from the config. The portable scripts already do this.

### 5. Set Up Git Hooks (Automatic)

The kit uses **Husky** for automatic hook management.

1. Install Husky:

   ```bash
   npm install --save-dev husky
   ```

2. Add this to your `package.json` scripts:

   ```json
   "prepare": "husky"
   ```

3. Create `.husky/pre-commit` and `.husky/pre-push` in your project (the kit does not ship a `.husky/` folder). Each is a one-liner that calls the matching example script, e.g. `bash scripts/example-pre-commit-hook.sh` and `bash scripts/example-pre-push-hook.sh` — this is how the source repo wires them.

After running `npm install`, the hooks will be installed automatically.

### 6. Copy Supporting Files

Copy these into your project (recommended locations):

- `docs/BRANCH_CHECKLIST.md` → `docs/BRANCH_CHECKLIST.md` (recommended location in your project; the kit itself ships it at the repo root — see `portable-workflow-kit/BRANCH_CHECKLIST.md`)
- `.github/pull_request_template.md`
- `.github/BRANCH_PROTECTION.md`
- `.github/ISSUE_TEMPLATE/` (feature.md and bug.md)

### 7. Set Up Branch Protection (Recommended)

Follow the recommendations in `.github/BRANCH_PROTECTION.md`.

This is one of the highest-leverage things you can do to enforce the workflow.

### 8. Update Your Main Documentation

Add a section to your `README.md` or `CONTRIBUTING.md`:

```markdown
## Development Workflow

We use a structured development workflow. See `ADOPTING_THE_WORKFLOW.md` (or the portable guide in this repo) for details.
```

Point people to `PORTABLE_DEVELOPMENT_WORKFLOW.md` + `workflow.config.json` if you want them to understand the full system.

## Customizing Further

The `workflow.config.json` file is designed to be the single place you change when adapting the system.

Common customizations:

- Change test commands
- Add or remove required documentation files
- Adjust hook behavior (e.g., make pre-commit stricter or more lenient)
- Change branch naming rules

## Philosophy

This system is deliberately:

- **Lightweight enough for solo developers**
- **Strong enough to protect future-you**
- **Opinionated but adaptable**

It automates what can reasonably be automated and leaves human judgment where it belongs (commit messages, scope decisions, final review).

## Questions?

The best reference implementations are in the original project that developed this system.

Look at:

- `PORTABLE_DEVELOPMENT_WORKFLOW.md`
- `workflow.config.json`
- The scripts in the kit

You can point any project at this document and say:

> “Read `ADOPTING_THE_WORKFLOW.md`. Copy the `portable-workflow-kit/` folder. Customize `workflow.config.json`. You now have the same process we use.”

---

**Welcome to a more disciplined way of building software.**
