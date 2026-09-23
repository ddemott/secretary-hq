#!/usr/bin/env python3
"""Write one memory to .claude/memory/<name>.md and rebuild MEMORY.md.

  remember.py --type feedback --tier long --name no-mocks --description "one line" --body "text"
  echo "text" | remember.py --type project --tier short --name x --description "..."   (body from stdin)
  remember.py --touch NAME     renew a short/medium memory (it was useful again)
  remember.py --prune          delete expired memories and rebuild the index (run at session start)

Memory dir: $MEMORY_DIR, else ~/memory/memory (private repo, auto pull/commit/push), else .claude/memory.
Tiers: short = forgotten in SHORT_DAYS (3), medium = MEDIUM_DAYS (60), long = permanent.
Same name = update in place (restarts the clock). The repo is PUBLIC, so anything that looks like a secret
or a home address is refused (exit 2) rather than written.
"""
import argparse
import datetime
import os
import re
import subprocess
import sys
from pathlib import Path

TYPES = ("user", "feedback", "project", "reference")
TIERS = ("short", "medium", "long")
DAYS = {"short": int(os.environ.get("SHORT_DAYS", 3)), "medium": int(os.environ.get("MEDIUM_DAYS", 60))}


def today():
    return datetime.date.fromisoformat(os.environ["REMEMBER_TODAY"]) if os.environ.get("REMEMBER_TODAY") else datetime.date.today()


def expiry(tier, start):
    return "never" if tier == "long" else (start + datetime.timedelta(days=DAYS[tier])).isoformat()
REFUSE = [
    (r"postgres(?:ql)?://[^:\s/]+:[^@\s]+@", "database URL with a password"),
    (r"\b(?:sk|xai|gsk|ghp|gho|pk|rk)[-_][A-Za-z0-9_\-]{16,}", "API key"),
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "private key"),
    (r"(?i)\b(?:password|passwd|secret|api[_-]?key|token)\s*(?:[:=]|\bis\b)\s*\S{4,}", "credential"),
    (r"\b\d{1,6}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?\s+(?:Street|St|Ave|Avenue|Rd|Road|Blvd|Drive|Dr|Lane|Ln|Court|Ct)\b", "street address"),
]


def memory_dir():
    """env MEMORY_DIR > shared private repo (~/memory/memory) > this repo's .claude/memory (cloud fallback)."""
    if os.environ.get("MEMORY_DIR"):
        return Path(os.environ["MEMORY_DIR"])
    shared = Path.home() / "memory" / "memory"
    return shared if shared.is_dir() else repo_root() / ".claude" / "memory"


def sync_root(mem):
    """The memory repo root, only when mem lives in it (marker file .memory-repo); else None."""
    try:
        top = Path(subprocess.check_output(["git", "-C", str(mem), "rev-parse", "--show-toplevel"], text=True, stderr=subprocess.DEVNULL).strip())
    except Exception:
        return None
    return top if (top / ".memory-repo").exists() else None


def git(top, *args):
    return subprocess.run(["git", "-C", str(top), *args], capture_output=True, text=True, timeout=25)


def sync_pull(mem):
    top = sync_root(mem)
    if top and git(top, "remote").stdout.strip():
        try:
            git(top, "pull", "--rebase", "--autostash", "-q")
        except Exception:
            pass


def sync_push(mem, msg):
    top = sync_root(mem)
    if not top or not git(top, "remote").stdout.strip():
        return
    try:
        git(top, "add", "-A")
        if git(top, "diff", "--cached", "--quiet").returncode != 0:
            git(top, "commit", "-q", "-m", msg)
            r = git(top, "push", "-q")
            if r.returncode != 0:
                print("memory saved locally; push failed (will retry next save)", file=sys.stderr)
    except Exception:
        print("memory saved locally; sync failed", file=sys.stderr)


def repo_root():
    try:
        return Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
    except Exception:
        return Path.cwd()


def read_meta(path):
    text = path.read_text()
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    fm = m.group(1) if m else ""
    def get(k, d=""):
        r = re.search(rf"^\s*{k}:\s*(.+)$", fm, re.M)
        return r.group(1).strip() if r else d
    return {"name": get("name", path.stem), "description": get("description"), "type": get("type"),
            "tier": get("tier", "long"), "created": get("created"), "expires": get("expires", "never")}


def is_expired(meta):
    return meta["expires"] != "never" and datetime.date.fromisoformat(meta["expires"]) < today()


def prune_and_index(mem):
    removed = []
    keep = []
    for p in sorted(mem.glob("*.md")):
        if p.name == "MEMORY.md":
            continue
        meta = read_meta(p)
        if is_expired(meta):
            p.unlink()
            removed.append(meta["name"])
        else:
            keep.append((p, meta))
    out = ["# Memory index", "", "Tiers: long = permanent, medium = expires after ~60 days unless renewed, short = expires after ~3 days.", ""]
    for tier, title in (("long", "Long (permanent)"), ("medium", "Medium"), ("short", "Short")):
        rows = [(p, m) for p, m in keep if m["tier"] == tier]
        if not rows:
            continue
        out.append(f"## {title}")
        for p, m in rows:
            exp = "" if tier == "long" else f" (expires {m['expires']})"
            out.append(f"- [{m['name']}]({p.name}) — {m['description']}{exp}")
        out.append("")
    (mem / "MEMORY.md").write_text("\n".join(out))
    return removed


def write_memory(path, name, typ, tier, description, body):
    now = today()
    path.write_text(f"---\nname: {name}\ndescription: {description}\nmetadata:\n  type: {typ}\n  tier: {tier}\n"
                    f"  created: {now.isoformat()}\n  expires: {expiry(tier, now)}\n---\n\n{body}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--type", choices=TYPES)
    ap.add_argument("--tier", choices=TIERS, default="medium")
    ap.add_argument("--name")
    ap.add_argument("--description")
    ap.add_argument("--body")
    ap.add_argument("--touch", metavar="NAME")
    ap.add_argument("--prune", action="store_true")
    a = ap.parse_args()
    mem = memory_dir()
    mem.mkdir(parents=True, exist_ok=True)
    if a.prune:
        sync_pull(mem)
        removed = prune_and_index(mem)
        sync_push(mem, "memory: prune")
        print("pruned: " + (", ".join(removed) if removed else "nothing"))
        return
    sync_pull(mem)
    if a.touch:
        path = mem / f"{a.touch}.md"
        if not path.exists():
            sys.exit(f"no memory named {a.touch}")
        meta = read_meta(path)
        if meta["tier"] == "long":
            sys.exit(f"{a.touch} is long-term (permanent); nothing to renew")
        text = path.read_text()
        now = today()
        text = re.sub(r"(?m)^(\s*created:).*$", rf"\g<1> {now.isoformat()}", text)
        text = re.sub(r"(?m)^(\s*expires:).*$", rf"\g<1> {expiry(meta['tier'], now)}", text)
        path.write_text(text)
        prune_and_index(mem)
        sync_push(mem, f"memory: renew {a.touch}")
        print(f"renewed {path} until {expiry(meta['tier'], now)}")
        return
    if not (a.type and a.name and a.description):
        sys.exit("need --type, --name and --description (or --touch / --prune)")
    body = (a.body if a.body is not None else sys.stdin.read()).strip()
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", a.name):
        sys.exit("name must be kebab-case, e.g. no-mocked-db")
    if not body or "\n" in a.description:
        sys.exit("need a non-empty body and a one-line description")
    for label, text in (("name", a.name), ("description", a.description), ("body", body)):
        for pat, what in REFUSE:
            if re.search(pat, text):
                print(f"REFUSED: {label} contains a {what}. This repo is public — keep it out of memory.", file=sys.stderr)
                sys.exit(2)
    path = mem / f"{a.name}.md"
    verb = "updated" if path.exists() else "created"
    write_memory(path, a.name, a.type, a.tier, a.description, body)
    prune_and_index(mem)
    sync_push(mem, f"memory: {verb} {a.name} [{a.tier}]")
    print(f"{verb} {path} [{a.tier}, expires {expiry(a.tier, today())}]")


if __name__ == "__main__":
    main()
