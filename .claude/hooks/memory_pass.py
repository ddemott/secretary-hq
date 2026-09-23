#!/usr/bin/env python3
"""Stop hook: make Claude do a silent memory pass, so memories get saved without being asked.

The hook only decides WHEN to reflect; Claude decides WHAT is worth keeping and which tier
(short / medium / long) — the same session, so it runs on the subscription, no API key.

Reflect when (a) the user's last message has a durable-fact cue ("always", "never",
"remember", "from now on", "I prefer", a correction...) or (b) every REFLECT_EVERY turns.
A block is issued at most once per turn (stop_hook_active guard) and never fails the session.
"""
import json
import os
import re
import sys
import tempfile
from pathlib import Path

REFLECT_EVERY = int(os.environ.get("REFLECT_EVERY", 5))
CUES = re.compile(
    r"\b(always|never|from now on|remember|don'?t forget|i prefer|i like|i hate|i want you to|"
    r"stop (doing|using)|that'?s wrong|not what i (asked|meant)|my (wife|husband|sister|brother|"
    r"mom|dad|dog|cat|business|company|name)|i am |i'?m a )\b",
    re.I,
)

REASON = """MEMORY PASS (automatic, do not mention it to the user). Look back over the exchange so far.
If it revealed anything durable — a stated preference, a correction of your approach, a rule
("always/never"), a fact about Dale, his business or the project that the code and git history do not
record — save it with the remember skill, otherwise save nothing:

  python3 .claude/skills/remember/remember.py --type user|feedback|project|reference \\
    --tier short|medium|long --name kebab-slug --description "one line" --body "fact (+ **Why:**)"

Tier: long = permanent (standing rules, corrections, who Dale is, hard constraints); medium = somewhat
important, useful for weeks (current goals, in-flight decisions); short = minor, fine to forget in days.
When unsure pick the LOWER tier. Corrections and "always/never" are long.
First read .claude/memory/MEMORY.md and UPDATE an existing memory (same --name) instead of duplicating.
Never save secrets, credentials, addresses or caller PII — the repo is public. Save at most 3.
When done (or if nothing qualifies) end your turn with no message at all."""


def last_user_text(path):
    text = ""
    try:
        with open(path) as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                m = e.get("message") or {}
                if e.get("type") == "user" and m.get("role") == "user" and not e.get("isMeta"):
                    c = m.get("content", "")
                    t = c if isinstance(c, str) else " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
                    t = re.sub(r"<system-reminder>.*?</system-reminder>", "", t, flags=re.S).strip()
                    if t:
                        text = t
    except OSError:
        pass
    return text


def main():
    try:
        p = json.load(sys.stdin)
        if p.get("stop_hook_active"):
            return
        sid = re.sub(r"[^A-Za-z0-9_-]", "", p.get("session_id") or "x")
        state = Path(tempfile.gettempdir()) / f"memory-pass-{sid}"
        turns = int(state.read_text()) + 1 if state.exists() else 1
        cue = bool(CUES.search(last_user_text(p.get("transcript_path", ""))))
        if cue or turns >= REFLECT_EVERY:
            state.write_text("0")
            print(json.dumps({"decision": "block", "reason": REASON}))
        else:
            state.write_text(str(turns))
    except Exception:
        pass


if __name__ == "__main__":
    main()
