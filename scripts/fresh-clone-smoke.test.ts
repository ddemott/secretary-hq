/**
 * Tests for scripts/fresh-clone-smoke.sh — the periodic fresh-clone
 * rehearsal that catches CI rot before it bites a real PR.
 *
 * Two layers are testable cheaply (sub-second):
 *   1. Argument parsing — --help, --keep-dir, --remote, unknown args
 *   2. Remote resolution — explicit --remote vs. inheriting from origin
 *
 * The third layer — actually cloning + running `npm run bootstrap` — takes
 * minutes (deps install + migrations + full backend + dashboard tests) and
 * is verified once before commit by running the script in the foreground.
 * Putting that path in vitest would burn ~5 min per CI run for marginal
 * extra coverage; instead we pin the contract surrounding it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, 'fresh-clone-smoke.sh');

/**
 * `process.env` with every `GIT_*` variable stripped.
 *
 * When this suite runs as a descendant of a real git hook (git push ->
 * husky pre-push -> npm test -> vitest -> this file), git has already set
 * GIT_DIR/GIT_WORK_TREE in the ambient environment. Without this, the
 * "non-git location" test below would find the REAL repo's remote via the
 * leaked GIT_DIR instead of the empty-remote condition it exists to test,
 * fall through into a real `git clone` of this repo, and time out — same
 * root cause as the fix in scripts/git-hooks/pre-push.test.ts.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function runScript(
  args: string[],
  opts: { timeoutMs?: number } = {}
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: cleanGitEnv(),
    timeout: opts.timeoutMs ?? 10_000,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe('fresh-clone-smoke.sh — script existence + permissions', () => {
  it('HAPPY: the script file exists at the expected path', () => {
    // WHO: anyone (developer / cron / CI) trying to invoke the rehearsal
    // WHAT: scripts/fresh-clone-smoke.sh exists on disk at the documented location
    // WHEN: the docs/TODO.md "CI rot prevention" entry promises this path; if the
    //       file is renamed without updating the docs, the rehearsal becomes invisible
    // WHERE: scripts/fresh-clone-smoke.sh — the absolute path used in TODO + CRON examples
    // WHY: a script that "ships" but isn't where the docs say it is may as well not ship —
    //      cron jobs fail silently and developers run a stale path
    expect(existsSync(SCRIPT)).toBe(true);
  });
});

describe('fresh-clone-smoke.sh — argument parsing', () => {
  it('HAPPY: --help exits 0 and prints the header docs', () => {
    // WHO: a developer running the script for the first time
    // WHAT: `--help` exits 0 and includes the canonical "WHO/WHAT/WHEN/WHERE/WHY" header
    //       so the user can self-serve without reading the source
    // WHEN: every first-time invocation; also when a cron operator wants to confirm
    //       which version of the script is on disk
    // WHERE: stdout of the script
    // WHY: a script that errors on --help (or prints nothing) creates a UX cliff —
    //      operators learn faster from a discoverable header than from grepping source
    const { stdout, status } = runScript(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('fresh-clone-smoke.sh');
    expect(stdout).toContain('WHO');
    expect(stdout).toContain('WHAT');
    expect(stdout).toContain('WHY');
  });

  it('SAD: unknown flag exits 2 with a usable error', () => {
    // WHO: a developer mistyping a flag (e.g., --keep-dirs instead of --keep-dir)
    // WHAT: unknown flag triggers exit 2 + a stderr message pointing at --help
    // WHEN: regression check — `set -e` + the `*)` arm of the case statement must
    //       both fire; if either is broken, garbage args silently succeed
    // WHERE: stderr of the script
    // WHY: exit code 2 (per POSIX convention for "usage error") is what cron + CI
    //      rely on to distinguish "your invocation was wrong" from "the smoke test
    //      actually failed (exit 1 from underlying npm)". Different exit codes ⇒
    //      different alerting rules
    const { stderr, status } = runScript(['--garbage']);
    expect(status).toBe(2);
    expect(stderr).toContain('unknown argument');
    expect(stderr).toContain('--help');
  });

  it('SAD: --remote without a value exits 2', () => {
    // WHO: a cron operator who set up the job but forgot to supply the URL
    // WHAT: `--remote` with no following argument exits 2 and explains the requirement
    //       (rather than silently treating the next-non-flag-thing or "" as a URL)
    // WHEN: every misconfigured cron entry; without this check, the script would proceed
    //       to `git clone ""` which produces a confusing "destination path '' already
    //       exists" error several seconds later
    // WHERE: stderr; before any git/network activity
    // WHY: fail-fast at the arg layer keeps misconfigurations distinct from network/clone
    //      failures, which matters for alerting (you don't want to page oncall because
    //      cron syntax was wrong)
    const { stderr, status } = runScript(['--remote']);
    expect(status).toBe(2);
    expect(stderr).toContain('--remote requires a URL');
  });

  it('HAPPY: --keep-dir parses without erroring (no clone happens since invocation is cut short)', () => {
    // WHO: a developer running with --keep-dir to inspect the temp clone after a failure
    // WHAT: the flag is accepted; combined with --help, --keep-dir does not block the help path
    // WHEN: documentation-discovery flow where the user wants to read --help before --keep-dir'ing
    // WHERE: the arg-parser loop's --keep-dir arm
    // WHY: feature flags should be order-independent; --keep-dir --help and --help --keep-dir
    //      should both surface help text. Pinning the loop's correctness with a combo
    const { status } = runScript(['--keep-dir', '--help']);
    expect(status).toBe(0);
  });
});

describe('fresh-clone-smoke.sh — remote-URL resolution', () => {
  it('SAD: invoked from a non-git location with no --remote → exits 1 with a usable error', () => {
    // WHO: a developer who copied just the script to a non-git directory and ran it bare
    //      (or a cron job pointing at a snapshot of the script outside any working tree)
    // WHAT: with no `remote.origin.url` reachable AND no `--remote` flag, the script
    //       exits 1 and prints both the diagnostic AND the --remote escape hatch
    // WHEN: defensive check on the URL-resolution block — we never want to fall through
    //       into `git clone ""` which produces a less actionable error several seconds later
    // WHERE: the REMOTE_URL resolution block, before the cleanup trap is installed
    // WHY: the script must self-diagnose this exact failure mode. We trigger it by copying
    //      the script alone into a non-git tempdir; SCRIPT_DIR/.. then has no git config,
    //      so the `git -C $REPO_DIR config --get remote.origin.url` call returns empty
    //      (its `|| true` swallows the failure), REMOTE_URL stays empty, and the explicit
    //      check fires
    const isolatedDir = mkdtempSync(join(tmpdir(), 'fresh-clone-smoke-test-'));
    try {
      const isolatedScript = join(isolatedDir, 'fresh-clone-smoke.sh');
      copyFileSync(SCRIPT, isolatedScript);
      chmodSync(isolatedScript, 0o755);
      // Run the copy explicitly — bash uses $0 to resolve SCRIPT_DIR, so SCRIPT_DIR/..
      // becomes tmpdir (a non-git location)
      const result = spawnSync('bash', [isolatedScript], {
        cwd: isolatedDir,
        encoding: 'utf8',
        env: cleanGitEnv(),
        timeout: 5_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('could not resolve remote URL');
      expect(result.stderr).toContain('--remote');
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  it('HAPPY: --remote accepts a URL and passes arg-parse into the clone step', () => {
    // WHO: a cron operator pinning the clone source explicitly (e.g., a private mirror)
    // WHAT: `--remote <url>` passes arg-parse and gets to the `git clone` invocation
    //       — proven by the "cloning <url>" stdout line printed immediately before clone
    // WHEN: the typical cron invocation: `bash scripts/fresh-clone-smoke.sh --remote https://...`
    // WHERE: the arg-parser's --remote arm + the REMOTE_OVERRIDE handoff
    // WHY: regression check that `--remote` consumes the URL AND that the resolver
    //      respects it (doesn't silently overwrite with origin.url). Using an unrouteable
    //      URL on port 1 means `git clone` fails fast and we don't waste CI time on a
    //      real network round-trip
    const result = spawnSync('bash', [SCRIPT, '--remote', 'https://127.0.0.1:1/never-exists.git'], {
      encoding: 'utf8',
      env: cleanGitEnv(),
      timeout: 10_000,
    });
    // Arg-parse + URL-resolution succeeded ⇒ NOT exit 2 (usage error)
    expect(result.status).not.toBe(2);
    // Proof the script reached the clone step (rather than failing earlier)
    expect(result.stdout).toContain('cloning https://127.0.0.1:1/never-exists.git');
  });
});
