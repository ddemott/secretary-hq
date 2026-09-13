/**
 * Tests for the pre-push CI-green-gate hook. The hook is invoked as
 * `.git/hooks/pre-push` once a developer wires
 * `git config core.hooksPath scripts/git-hooks`. Each test exercises one
 * branch of the hook's decision tree:
 *
 *   1. SKIP_CI_PUSH_CHECK=1 bypass
 *   2. Detached HEAD → allow
 *   3. gh CLI missing → allow (graceful degradation)
 *   4. jq missing → allow (graceful degradation)
 *   5. No CI history → allow (first push)
 *   6. Latest run was a success → allow
 *   7. Latest run is in-flight (status=in_progress, conclusion empty) → allow
 *   8. Latest run failed → BLOCK with exit 1 + diagnostic
 *
 * The hook is run inside a throwaway git repo each time so the
 * `git symbolic-ref` it calls has a real branch to read. `gh` is mocked
 * via PATH manipulation — a small shim script returns canned JSON
 * for each scenario, simulating `gh run list --json` without ever
 * making a network call.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = join(__dirname, 'pre-push');

/**
 * `process.env` with every `GIT_*` variable stripped.
 *
 * When this suite itself runs as a descendant of a real git hook invocation
 * (e.g. `git push` → husky's pre-push → `npm test` → vitest → this file),
 * git has already set `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` etc. in
 * the ambient environment so hooks know which repo invoked them. Every
 * `spawnSync('git', ...)` call below used to inherit that env wholesale, so
 * `git init`/`git config`/`git commit` against the THROWAWAY tmpdir repo
 * were silently operating on the REAL enclosing repo instead — confirmed by
 * finding the real repo's `.git/config` corrupted with this test's own fake
 * identity (`user.email=test@test`, `user.name=Test`) after a nested run.
 * `cwd` alone does not protect against this: an explicit `GIT_DIR` wins.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

/**
 * Create a fresh test directory with:
 *   - an initialized git repo (with a `main` branch + an initial commit)
 *   - a bin/ directory containing fake `gh` (and optionally `jq`) shims
 *     that prepend onto PATH
 *
 * The hook is run with cwd = repo, env.PATH = bin:/usr/bin (so the real
 * git/bash still resolve, but our shim shadows the real gh/jq).
 */
function makeTestRepo(opts: {
  /** What the fake `gh` should print to stdout. If undefined, gh is omitted from PATH entirely. */
  ghOutput?: string;
  /** Whether to include jq in PATH. Default true (uses real jq). */
  includeJq?: boolean;
  /** Whether to start on a detached HEAD. Default false. */
  detached?: boolean;
}): { dir: string; binDir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-test-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  const gitEnv = cleanGitEnv();

  // Initialize a git repo with one commit so HEAD has something to point at.
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: gitEnv });
  spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: dir, env: gitEnv });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, env: gitEnv });
  spawnSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir, env: gitEnv });

  if (opts.detached) {
    // Move HEAD to the commit SHA directly — git symbolic-ref then fails.
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      env: gitEnv,
      encoding: 'utf8',
    }).stdout.trim();
    spawnSync('git', ['checkout', '-q', sha], { cwd: dir, env: gitEnv });
  }

  // Symlink the tools we want to expose to the hook. Anything NOT symlinked
  // in here is invisible to `command -v` when PATH=binDir alone — that's
  // how we simulate "gh missing" cleanly without touching /usr/bin.
  const includeJq = opts.includeJq !== false;
  const exposed: Record<string, string> = { bash: '/usr/bin/bash', git: '/usr/bin/git' };
  if (includeJq) exposed.jq = '/usr/bin/jq';
  for (const [name, src] of Object.entries(exposed)) {
    if (existsSync(src)) symlinkSync(src, join(binDir, name));
  }

  if (opts.ghOutput !== undefined) {
    // Use bash's builtin `printf` so the shim works even when PATH is
    // limited to binDir (no external `cat` available). The single-quoted
    // string keeps the JSON literal.
    const safe = opts.ghOutput.replace(/'/g, `'\\''`);
    const ghScript = `#!/usr/bin/env bash\nprintf '%s\\n' '${safe}'\n`;
    const ghPath = join(binDir, 'gh');
    writeFileSync(ghPath, ghScript);
    chmodSync(ghPath, 0o755);
  }

  return {
    dir,
    binDir,
    env: {
      ...cleanGitEnv(),
      PATH: binDir, // ONLY binDir on PATH — the real /usr/bin is invisible
      HOME: dir, // isolate from real ~/.gitconfig
      GIT_CONFIG_NOSYSTEM: '1',
    },
  };
}

function runHook(
  env: NodeJS.ProcessEnv,
  cwd: string
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('bash', [HOOK], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe('pre-push CI gate — bypass + degradation paths', () => {
  it('SKIP_CI_PUSH_CHECK=1 short-circuits and exits 0', () => {
    // WHO: developer pushing a CI-fixing commit that itself needs to land before
    //      CI can go green again (the chicken-and-egg case the hook MUST allow).
    // WHAT: env var bypass returns exit 0 + a diagnostic so the developer sees
    //       they intentionally skipped the gate.
    // WHEN: every commit explicitly tagged for force-through (e.g., a workflow
    //       fix that adjusts the CI YAML itself).
    // WHERE: the SKIP_CI_PUSH_CHECK arm at the very top of the hook.
    // WHY: a CI-green gate that has no bypass is a self-locking trap — when CI
    //      is broken because of CI itself, you can't ship the fix. Pinning the
    //      bypass means the trap stays unsprung.
    const t = makeTestRepo({ ghOutput: '[]' });
    try {
      const result = runHook({ ...t.env, SKIP_CI_PUSH_CHECK: '1' }, t.dir);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('SKIP_CI_PUSH_CHECK=1');
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('detached HEAD → exit 0 with explanation', () => {
    // WHO: developer in a detached-HEAD state (mid-rebase, viewing an old SHA).
    // WHAT: no branch to query → hook allows the push and explains why in stderr.
    // WHEN: rare but reachable; `git push HEAD:branch-name` style commands.
    // WHERE: the `BRANCH=""` check after `git symbolic-ref`.
    // WHY: gating without a branch is impossible (gh run list needs a branch
    //      name). Failing closed would be a worse UX than the current "allow,
    //      explain" — operators see WHY and can fix their state if it matters.
    const t = makeTestRepo({ ghOutput: '[]', detached: true });
    try {
      const result = runHook(t.env, t.dir);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('detached HEAD');
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('gh CLI not installed → exit 0 with install hint', () => {
    // WHO: a fresh-clone contributor who hasn't installed gh yet.
    // WHAT: hook detects gh-missing via `command -v gh` and degrades gracefully.
    // WHEN: every install-from-scratch flow before `gh auth login` has run.
    // WHERE: the `command -v gh` arm.
    // WHY: blocking on missing optional tooling makes the hook a worse UX than
    //      no hook at all — new contributors couldn't push anything. The hook
    //      is best-effort; missing tools degrades, doesn't fail closed.
    const t = makeTestRepo({}); // no ghOutput → no gh shim → gh truly missing
    try {
      const result = runHook(t.env, t.dir);
      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/gh CLI not installed/);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

describe('pre-push CI gate — CI-state interpretation', () => {
  it('no CI history (gh returns []) → exit 0', () => {
    // WHO: first push of a brand-new branch — no prior `gh run list` results.
    // WHAT: empty JSON array short-circuits to allow.
    // WHEN: every new feature branch's first push.
    // WHERE: the `RESULT == "[]"` arm.
    // WHY: gating new branches is wrong — they have no CI to be red.
    const t = makeTestRepo({ ghOutput: '[]' });
    try {
      const result = runHook(t.env, t.dir);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('no CI history');
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('last run was a success → exit 0', () => {
    // WHO: the normal post-CI-green push case — the happy path the hook exists to allow.
    // WHAT: gh returns one row with status=completed conclusion=success → allow.
    // WHEN: every successful push after CI has gone green.
    // WHERE: the `CONCLUSION == "success"` arm.
    // WHY: this is THE primary case. A regression here would block every legitimate
    //      push the hook is supposed to permit.
    const t = makeTestRepo({
      ghOutput: '[{"status":"completed","conclusion":"success"}]',
    });
    try {
      const result = runHook(t.env, t.dir);
      expect(result.status).toBe(0);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('last run is still in-flight (status=in_progress) → exit 0', () => {
    // WHO: developer pushing while a previous push's CI is still running. Common
    //      shape: push, immediately notice a typo, push again before CI completes.
    // WHAT: status=in_progress conclusion="" → allow, because the previous run
    //       might still go green.
    // WHEN: rapid-fire pushes during active dev.
    // WHERE: the case-statement matching `in_progress|queued|waiting|requested|pending`.
    // WHY: blocking on "we don't know yet" creates false negatives — the developer
    //      can't make progress while CI is mid-build. The trade is acceptable: a
    //      worst-case "previous run went red and this push compounds it" is caught
    //      by the NEXT push, after that run completes.
    const t = makeTestRepo({
      ghOutput: '[{"status":"in_progress","conclusion":""}]',
    });
    try {
      const result = runHook(t.env, t.dir);
      expect(result.status).toBe(0);
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('SAD: last run failed → exit 1 with actionable diagnostic', () => {
    // WHO: developer about to push to a branch where the last CI run failed —
    //      the LITERAL case the May 11 CI failures all matched.
    // WHAT: status=completed conclusion=failure → BLOCK with exit 1 + a stderr
    //       message naming the conclusion AND the bypass env var.
    // WHEN: the case the hook exists to catch. Without this gate, the developer
    //       would push, CI would re-fail in the same way, and the next person
    //       to pull main inherits broken state.
    // WHERE: the trailing `exit 1` after the case statement.
    // WHY: the whole point. Pin BOTH the exit code AND the diagnostic content so
    //      a refactor that silently changes the message (e.g., dropping the
    //      bypass-instruction line) doesn't degrade the UX.
    const t = makeTestRepo({
      ghOutput: '[{"status":"completed","conclusion":"failure"}]',
    });
    try {
      const result = runHook(t.env, t.dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('BLOCKED');
      expect(result.stderr).toContain('failure');
      expect(result.stderr).toContain('SKIP_CI_PUSH_CHECK=1');
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it('SAD: last run was cancelled → also exit 1 (any non-success blocks)', () => {
    // WHO: developer whose previous CI run was manually cancelled (e.g., they
    //      noticed a typo mid-build and clicked Cancel in the GitHub UI).
    // WHAT: status=completed conclusion=cancelled → BLOCK. Same shape as failure
    //       — anything non-success is treated as red, because re-pushing without
    //       knowing CI's verdict erodes the gate's purpose.
    // WHEN: post-cancel pushes; less common but real.
    // WHERE: the catch-all "anything that isn't success or in-flight" branch of
    //        the case statement.
    // WHY: a hook that only catches `failure` but not `cancelled` / `timed_out` /
    //      `action_required` would leak. Pin the broader "non-success blocks"
    //      semantic with a second sad-path test using a different conclusion value.
    const t = makeTestRepo({
      ghOutput: '[{"status":"completed","conclusion":"cancelled"}]',
    });
    try {
      const result = runHook(t.env, t.dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('BLOCKED');
      expect(result.stderr).toContain('cancelled');
    } finally {
      rmSync(t.dir, { recursive: true, force: true });
    }
  });
});

describe('pre-push CI gate — file presence', () => {
  it('hook file exists at the documented path', () => {
    // WHO: anyone running `git config core.hooksPath scripts/git-hooks`.
    // WHAT: scripts/git-hooks/pre-push exists on disk at the expected path.
    // WHEN: the docs/TODO.md "CI rot prevention" entry promises this file —
    //       if the file is renamed without updating the docs, the hook becomes
    //       invisible to new contributors following the setup instructions.
    // WHERE: scripts/git-hooks/pre-push.
    // WHY: parallels scripts/fresh-clone-smoke.test.ts's existence check — same
    //      anti-rot guard for any committed-tooling file the docs reference.
    expect(existsSync(HOOK)).toBe(true);
  });
});
