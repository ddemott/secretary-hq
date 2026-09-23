---
name: remember
description: Save a durable memory (user preference, feedback/correction, project fact, external reference) to .claude/memory/ so future sessions — including cloud sessions — can read it. Use when the user says "remember this", corrects your approach, or you learn a non-obvious fact that the code and git history do not record.
---

# remember

> **Two places memory can live.** On Dale's own machine (Claude Code, Grok, Hermes) memory is the shared private repo `~/memory`, and this skill's script writes there automatically (pull → save → commit → push). Where `~/memory` does not exist — a cloud session, a fresh clone — it falls back to `.claude/memory/` in THIS public repo (details: `docs/memory/README.md`). The Stop hook in `.claude/settings.json` is skipped when `~/memory/memory` exists, so the pass never runs twice.

Memory lives in `.claude/memory/` in this repo (one fact per file, plus a generated `MEMORY.md` index). A cloud session starts with no other memory, so this folder is the memory.

## At session start
Run `python3 .claude/skills/remember/remember.py --prune` (deletes expired memories, rebuilds the index), then read `.claude/memory/MEMORY.md` and open any file whose description looks relevant to the task.

## Pick a tier — how long the memory lives
- **short** — forgotten after 3 days. Low stakes: today's state, a one-off error, what we were just doing.
- **medium** — forgotten after 60 days unless renewed. Somewhat important: current project goals, in-flight decisions, a preference still being tried out.
- **long** — permanent. Very important, always remember: standing rules and corrections from Dale, who he is and how he works, hard constraints (safety, legal, cost), facts that would cause real harm if forgotten.
- When unsure between two tiers, take the lower one; a memory that proves useful again can be promoted by re-saving it with a higher `--tier`, or renewed with `--touch NAME` (short/medium only, restarts the clock).
- Corrections and explicit "always/never" instructions from Dale are **long**.

## Save a memory
```bash
python3 .claude/skills/remember/remember.py \
  --type feedback|user|project|reference \
  --tier short|medium|long \
  --name kebab-case-slug \
  --description "one line used to decide relevance later" \
  --body "the fact. For feedback/project add **Why:** and **How to apply:** lines."
```
- Same `--name` updates that memory in place and restarts its clock. Check `MEMORY.md` first and update rather than duplicate.
- Types: `user` (who Dale is, how he works), `feedback` (corrections and confirmed approaches — include why), `project` (goals/constraints not in the code), `reference` (where something lives outside the repo).
- Convert relative dates to absolute ones. Delete a memory that turns out to be wrong: `rm` the file, then run `remember.py --prune` to rebuild the index.

## Do NOT save
- Secrets, keys, passwords, connection strings, tokens. **The repo is public.** The script refuses the obvious patterns (exit 2) — do not try to get around it.
- Home address, customer/caller PII, anything private about a third party.
- What the code, `CLAUDE.md` or git history already says.
- Things that only matter for this one conversation.

## After saving
The file is only durable once committed. Commit it on a feature branch and open a PR like any other change — never push memory straight to `main`.
