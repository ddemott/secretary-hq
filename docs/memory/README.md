# Agent memory (Claude, Grok, Hermes)

Durable memory for AI coding agents working on this repo. It has three tiers and needs no API key.

| Tier   | Lifetime                               |
| ------ | -------------------------------------- |
| short  | forgotten after 3 days                 |
| medium | forgotten after 60 days unless renewed |
| long   | permanent                              |

## Where memories live

- **On the maintainer's machine** — a separate **private** repo cloned at `~/memory` is the single shared store. Claude Code, the
  Grok Build CLI and Hermes all read and write it, and the `remember` script pulls, commits and pushes by itself.
  Nothing private is ever stored in this repo.
- **In a cloud session or a fresh clone** (no `~/memory`) — memory falls back to `.claude/memory/` **in this repo**. This repo is
  public, so nothing sensitive may be saved there; `remember.py` refuses database URLs with passwords, API keys, private keys,
  `password: …` patterns and street addresses. Fallback memories reach `main` only through a normal PR.

Consequence: memories saved in a cloud session and memories saved locally are separate stores until someone copies the cloud ones
into `~/memory`. A cloud session cannot read the private store.

## What is in this repo

| Path                           | Purpose                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `.claude/skills/remember/`     | The `remember` skill and `remember.py` (create / update / `--touch` / `--prune`)                |
| `.claude/hooks/memory_pass.py` | Stop hook: asks the model for a silent memory pass on durable-fact cues, or every 5th turn      |
| `.claude/settings.json`        | Registers the hook. It is skipped when `~/memory/memory` exists, so it never runs twice locally |
| `.claude/memory/`              | Fallback memory store (see above)                                                               |

`.gitignore` ignores `.claude/*` except these four so cloud sessions receive them.

## How to use

```bash
python3 .claude/skills/remember/remember.py --prune                    # session start: drop expired, rebuild index
python3 .claude/skills/remember/remember.py --type feedback --tier long \
  --name kebab-slug --description "one line" --body "fact  **Why:** …  **How to apply:** …"
python3 .claude/skills/remember/remember.py --touch some-memory         # renew a short/medium memory
```

Pick the tier by importance: unsure → the lower one; corrections and "always/never" rules are long.

## Compatibility

|                            | Claude Code | Claude Code (cloud)                                 | Grok Build CLI                                              | Hermes                                     |
| -------------------------- | ----------- | --------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| Skill loads                | yes         | project skill; not verified in a real cloud session | yes (as `/local:remember`; Grok has a built-in `/remember`) | via a copy in `~/.hermes/skills/`          |
| Automatic save (Stop hook) | yes         | fallback path, not verified in a real cloud session | yes (Grok reads `.claude/` hooks and skills)                | no hook; saves only when it uses the skill |

Grok loads project skills and hooks only from folders it trusts (`/hooks-trust`). The full matrix, quirks and open items live
with the private store; this file is the public summary.
