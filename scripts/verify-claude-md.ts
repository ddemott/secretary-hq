#!/usr/bin/env npx tsx
/**
 * Drift detector for CLAUDE.md (historical major refactor; originally tracked as NEEDS-REFACTORING #13; see RESOLVED.md for details).
 *
 * Verifies that hand-maintained claims in CLAUDE.md still match reality:
 *  - Numeric counts (route modules, SQL migrations, industry templates)
 *  - File/directory paths in the "Key Directories" section
 *  - Commit hash references — every hash mentioned must be reachable from `main`
 *
 * Run: `npx tsx scripts/verify-claude-md.ts` from repo root.
 * Exits 0 if every claim agrees with reality; 1 with a per-drift report otherwise.
 *
 * Origin: 2026-05-03 voice-fallback validation surfaced two doc-vs-reality
 * lies — the runFallback OpenAI-TTS claim, and commit `e92b3bf` claimed
 * shipped on 2026-05-01 but actually living on a never-merged branch. The
 * commit-reachability check below would have caught the second one.
 *
 * Pure check functions are exported for unit-testing. The thin `main()`
 * wires them to the filesystem + git.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

export interface Drift {
  /** Stable identifier for the check that produced this drift, e.g. `route-count`. */
  check: string;
  /** Human-readable description of what disagreed with reality. */
  message: string;
}

/**
 * Strip the `## Resolved Issues` archive (and anything after it) from the
 * content. Numeric counts inside historical post-mortems are date-locked
 * facts about the past — they should NOT be re-validated against today's
 * filesystem. Commit-reachability checks still scan the full document
 * because historical "I shipped X in commit Y" claims are exactly the kind
 * that can lie (the 2026-05-03 incident).
 */
export function stripHistoricalSections(content: string): string {
  const idx = content.indexOf('## Resolved Issues');
  return idx === -1 ? content : content.slice(0, idx);
}

/**
 * Verify a numeric claim of the form `<n> <label>` against an actual count.
 * Skips silently if no claim found (the claim may have been removed deliberately).
 * If the claim appears multiple times, all distinct values must agree with `actualCount`.
 */
export function checkCount(args: {
  content: string;
  /** Regex with a `(\d+)` capture group. Use the global flag so all mentions are scanned. */
  pattern: RegExp;
  actualCount: number;
  label: string;
  checkName: string;
}): Drift[] {
  const drifts: Drift[] = [];
  const seen = new Set<number>();
  for (const m of args.content.matchAll(args.pattern)) {
    const claimed = parseInt(m[1], 10);
    if (seen.has(claimed)) continue;
    seen.add(claimed);
    if (claimed !== args.actualCount) {
      drifts.push({
        check: args.checkName,
        message: `claims "${claimed} ${args.label}" but found ${args.actualCount} on disk`,
      });
    }
  }
  return drifts;
}

/**
 * Slice the content of a `## <header>` section out of a Markdown document.
 * The slice runs from just after the header line to (but not including) the
 * next `## ` line. Returns null if the header is absent.
 */
export function extractSection(content: string, header: string): string | null {
  const start = content.indexOf(header);
  if (start === -1) return null;
  const after = content.slice(start + header.length);
  const next = after.search(/^## /m);
  return next === -1 ? after : after.slice(0, next);
}

/**
 * Verify every leading-backtick path in a section exists on disk.
 * Pattern: `- \`/src/...\` - description` — the slash-prefixed bit gets checked.
 *
 * `resolvePath` is injected so the pure function can be unit-tested without I/O.
 * Production wiring passes `(rel) => existsSync(join(repoRoot, rel))`.
 */
export function checkPathsExist(args: {
  content: string;
  sectionHeader: string;
  resolvePath: (relPath: string) => boolean;
  checkName: string;
}): Drift[] {
  const section = extractSection(args.content, args.sectionHeader);
  if (!section) return [];
  const drifts: Drift[] = [];
  // Match list items whose first backticked token is a slash-rooted path.
  for (const m of section.matchAll(/^- `(\/[^`]+)`/gm)) {
    const claimed = m[1]; // e.g. /src/routes
    const rel = claimed.replace(/^\//, ''); // strip leading slash for filesystem join
    if (!args.resolvePath(rel)) {
      drifts.push({
        check: args.checkName,
        message: `path "${claimed}" listed but does not exist on disk`,
      });
    }
  }
  return drifts;
}

/**
 * Verify every commit hash mentioned in CLAUDE.md is reachable from `main`.
 *
 * Two recognized forms:
 *   1. `commit \`<7-40 hex>\`` — the explicit form is high-confidence; we
 *      accept any hex regardless of letter content.
 *   2. Bare `\`<7-12 hex>\`` — the bare form requires at least one a-f letter
 *      to filter migration timestamps (e.g. `20260501000000`) and external
 *      IDs (e.g. the Telnyx SIP connection ID `2945038451784812111`).
 *
 * `isReachable` is injected so the pure function can be unit-tested without git.
 */
export function checkCommitsReachable(args: {
  content: string;
  isReachable: (sha: string) => boolean;
  checkName: string;
}): Drift[] {
  const drifts: Drift[] = [];
  const seen = new Set<string>();
  const expectedUnreachable = collectExpectedUnreachable(args.content);

  // High-confidence: explicit `commit \`<hash>\`` form (case-insensitive prefix).
  for (const m of args.content.matchAll(/commit `([a-f0-9]{7,40})`/gi)) {
    seen.add(m[1].toLowerCase());
  }
  // Bare backtick refs that look like hashes — require at least one letter [a-f].
  for (const m of args.content.matchAll(/`([0-9a-f]{7,12})`/g)) {
    const hash = m[1].toLowerCase();
    if (/[a-f]/.test(hash)) seen.add(hash);
  }

  for (const hash of seen) {
    if (expectedUnreachable.has(hash)) continue;
    if (!args.isReachable(hash)) {
      drifts.push({
        check: args.checkName,
        message: `commit \`${hash}\` not reachable from main (does it exist? was its branch merged?)`,
      });
    }
  }
  return drifts;
}

/**
 * Collect commit hashes that are intentionally referenced as unreachable
 * (e.g. a commit that lived on an abandoned branch). The author opts a
 * hash out by following the backtick reference with an HTML comment of
 * the form `<!-- verify-claude-md: unmerged -->` (the comment renders as
 * nothing in Markdown, so the prose stays clean).
 *
 * Origin: 2026-05-03 voice-fallback validation found commit `e92b3bf` was
 * on the never-merged hold-tenant-config branch. The doc legitimately
 * references it to explain the doc-vs-reality lie that was caught — but
 * the reachability check would otherwise re-flag it on every run.
 */
export function collectExpectedUnreachable(content: string): Set<string> {
  const out = new Set<string>();
  const re = /`([a-f0-9]{7,40})`\s*<!--\s*verify-claude-md:\s*unmerged\s*-->/gi;
  for (const m of content.matchAll(re)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

// ─── Production wiring ─────────────────────────────────────────────────────

/**
 * Strip every `GIT_*` env var before shelling out. When this script itself
 * runs as a descendant of a real git hook (`git push` → husky's pre-push →
 * `npm test`/`npm run verify:claude-md`), git has already set `GIT_DIR` /
 * `GIT_WORK_TREE` / `GIT_INDEX_FILE` in the ambient environment so hooks
 * know which repo invoked them. `execSync` inherits that env wholesale by
 * default, so a `cwd` override alone does NOT protect against it — an
 * explicit `GIT_DIR` wins over cwd-based repo discovery every time.
 *
 * Found 2026-09-14: `resolveBranchRef`'s own `execSync` had this exact gap —
 * `verify-claude-md.test.ts`'s throwaway-repo tests clean their OWN setup
 * calls (`git init`, `git commit`, ...) but `resolveBranchRef` itself, the
 * function under test, still shelled out with the raw ambient env. Running
 * the suite from inside this repo's own pre-push hook (i.e. exactly the
 * scenario this whole class of bug is about) made a throwaway repo with no
 * local `main` incorrectly resolve `main` anyway, because the ambient
 * `GIT_DIR` pointed at the real secretary-hq checkout, which does have one.
 * Same root cause as `cleanGitEnv()` in `scripts/git-hooks/pre-push.test.ts`
 * and in this file's own test suite — three independent copies of the same
 * fix before this one was finally applied to the actual production path.
 */
export function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

/**
 * Resolve `branch` to a ref that actually exists in this checkout. A
 * pull_request CI run (`actions/checkout` with `fetch-depth: 0`) fetches
 * every branch's history but only checks out the PR's own ref as a local
 * branch — `main` itself never gets a local ref, only `origin/main` does.
 * `git merge-base --is-ancestor <sha> main` then fails with "not a valid
 * object name", which this script reported as "not reachable from main"
 * even for a commit that plainly is (verified 2026-09-13, PR #453: local
 * clones have `main`, CI checkouts of a PR branch do not).
 */
export function resolveBranchRef(branch: string): string {
  try {
    execSync(`git rev-parse --verify ${branch}`, { stdio: 'ignore', env: cleanGitEnv() });
    return branch;
  } catch {
    return `origin/${branch}`;
  }
}

/** Returns true if `sha` resolves to a commit AND is an ancestor of `main`. */
function gitIsCommitReachable(sha: string, branch: string = 'main'): boolean {
  const ref = resolveBranchRef(branch);
  try {
    execSync(`git merge-base --is-ancestor ${sha} ${ref}`, {
      stdio: 'ignore',
      env: cleanGitEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

/** Live count of `.ts` route modules under `src/routes/` (excluding tests + helpers). */
function countRoutes(repoRoot: string): number {
  const dir = join(repoRoot, 'src/routes');
  if (!existsSync(dir)) return 0;
  // Exclude tests, *Helpers.ts (routeHelpers.ts, versionHistoryHelpers.ts, …),
  // and *Scaffold.ts (crmRouteScaffold.ts — a shared route scaffold used by
  // other route files, not registered directly in index.ts).
  return readdirSync(dir).filter(
    (f) =>
      f.endsWith('.ts') &&
      !f.endsWith('.test.ts') &&
      !f.endsWith('Helpers.ts') &&
      !f.endsWith('Scaffold.ts')
  ).length;
}

function countFiles(dir: string, predicate: (filename: string) => boolean): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(predicate).length;
}

/** Run every check against the live filesystem + git, return aggregated drifts. */
export function runAllChecks(content: string, repoRoot: string): Drift[] {
  const routeCount = countRoutes(repoRoot);
  const migrationCount = countFiles(join(repoRoot, 'supabase/migrations'), (f) =>
    f.endsWith('.sql')
  );
  const templateCount = countFiles(
    join(repoRoot, 'src/templates'),
    (f) => f.endsWith('.yaml') || f.endsWith('.yml')
  );

  // Numeric counts are date-locked facts in the Resolved Issues archive — only
  // verify them against the live current-state portion of the doc.
  const currentState = stripHistoricalSections(content);

  return [
    ...checkCount({
      content: currentState,
      pattern: /(\d+) (?:top-level )?route modules?/g,
      actualCount: routeCount,
      label: 'route modules',
      checkName: 'route-count',
    }),
    ...checkCount({
      content: currentState,
      pattern: /(\d+) SQL migrations?/g,
      actualCount: migrationCount,
      label: 'SQL migrations',
      checkName: 'migration-count',
    }),
    ...checkCount({
      content: currentState,
      pattern: /(\d+) industry YAML bundles?/g,
      actualCount: templateCount,
      label: 'industry YAML bundles',
      checkName: 'template-count',
    }),
    ...checkPathsExist({
      content: currentState,
      sectionHeader: '## Key Directories',
      resolvePath: (rel) => existsSync(join(repoRoot, rel)),
      checkName: 'directory-existence',
    }),
    // Commit reachability scans the FULL document — historical "shipped in
    // commit X" claims are exactly the kind that can lie.
    ...checkCommitsReachable({
      content,
      isReachable: (sha) => gitIsCommitReachable(sha),
      checkName: 'commit-reachability',
    }),
  ];
}

function main(): number {
  const repoRoot = process.cwd();
  const claudeMdPath = join(repoRoot, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    console.error(`✗ CLAUDE.md not found at ${claudeMdPath}`);
    return 1;
  }
  const content = readFileSync(claudeMdPath, 'utf8');
  const drifts = runAllChecks(content, repoRoot);

  if (drifts.length === 0) {
    console.log('✓ CLAUDE.md verified — no drift detected');
    return 0;
  }

  const noun = drifts.length === 1 ? 'issue' : 'issues';
  console.error(`✗ CLAUDE.md drift detected (${drifts.length} ${noun}):`);
  for (const d of drifts) {
    console.error(`  [${d.check}] ${d.message}`);
  }
  return 1;
}

// Run only when invoked directly, not when imported by tests.
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  process.exit(main());
}
