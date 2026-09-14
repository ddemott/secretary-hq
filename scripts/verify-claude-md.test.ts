/**
 * Tests for the CLAUDE.md drift detector (historical major refactor; originally tracked as NEEDS-REFACTORING #13; see RESOLVED.md for details).
 * Each pure check tested in isolation with happy + sad paths and 5W comments.
 *
 * Filesystem and git are injected so these tests don't read CLAUDE.md or shell
 * out — they exercise only the regex + decision logic.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  checkCount,
  checkPathsExist,
  checkCommitsReachable,
  collectExpectedUnreachable,
  extractSection,
  stripHistoricalSections,
  resolveBranchRef,
} from './verify-claude-md';

describe('checkCount', () => {
  it('HAPPY: claim matches actual count → no drift', () => {
    // WHO: maintainer who just added a 5th industry template + updated CLAUDE.md
    // WHAT: doc says "5 industry YAML bundles" and disk has 5 → script stays silent
    // WHY: CI gate must not fire false positives, or maintainers will start ignoring it
    const drifts = checkCount({
      content: 'We ship 5 industry YAML bundles in this release.',
      pattern: /(\d+) industry YAML bundles?/g,
      actualCount: 5,
      label: 'industry YAML bundles',
      checkName: 'template-count',
    });
    expect(drifts).toEqual([]);
  });

  it('HAPPY: pattern absent → no drift (silently skip)', () => {
    // WHO: maintainer who deliberately removed a count from the doc
    // WHAT: pattern matches nothing in content → returns []
    // WHEN: claim was removed because it rotted too often
    // WHY: historical major refactor (originally tracked as NEEDS-REFACTORING #13; see RESOLVED.md) Option B says trimming claims is also valid;
    //      the script must not punish you for taking that path
    const drifts = checkCount({
      content: 'No mention of templates here.',
      pattern: /(\d+) industry YAML bundles?/g,
      actualCount: 5,
      label: 'industry YAML bundles',
      checkName: 'template-count',
    });
    expect(drifts).toEqual([]);
  });

  it('SAD: claim "20" but actual 25 → one drift with diagnostic message', () => {
    // WHO: BUG-017 historical narrative said the monolith was split into 20
    //      route modules — true at the time, but routes have grown since
    // WHAT: doc says 20, disk has 25 → drift surfaces with both numbers
    // WHEN: someone added route #21..25 without updating the count
    // WHERE: drift's `message` field carries enough detail to fix in one edit
    // WHY: this is the original drift class that motivated #13
    const drifts = checkCount({
      content: 'Fastify monolith broken into 20 route modules.',
      pattern: /(\d+) route modules?/g,
      actualCount: 25,
      label: 'route modules',
      checkName: 'route-count',
    });
    expect(drifts).toHaveLength(1);
    expect(drifts[0].check).toBe('route-count');
    expect(drifts[0].message).toContain('"20 route modules"');
    expect(drifts[0].message).toContain('25 on disk');
  });

  it('HAPPY: same number repeated dedupes to one report when wrong', () => {
    // WHO: the doc legitimately mentions a count in 4 places (today: "25 route
    //      modules" appears 4× in CLAUDE.md)
    // WHAT: if all 4 mentions agree on a wrong number, surface ONE drift not 4
    // WHY: 4 identical drift lines is signal pollution; 1 line says the same
    //      thing and prevents alarm fatigue
    const drifts = checkCount({
      content: 'has 7 widgets. Also 7 widgets! And 7 widgets again.',
      pattern: /(\d+) widgets?/g,
      actualCount: 5,
      label: 'widgets',
      checkName: 'widget-count',
    });
    expect(drifts).toHaveLength(1);
    expect(drifts[0].message).toContain('"7 widgets"');
  });

  it('SAD: differing numbers in different places → one drift per distinct wrong value', () => {
    // WHO: doc that has been partially updated (some places say 5, others say 7)
    // WHAT: the right value is 5, so "5" passes and "7" drifts — one drift, not two
    // WHEN: a maintainer updated some mentions but missed others
    // WHY: report each unique wrong claim so the maintainer knows there's still
    //      an inconsistency, but don't double-fire on identical wrong numbers
    const drifts = checkCount({
      content: 'has 5 widgets here, but 7 widgets there, and 5 widgets again.',
      pattern: /(\d+) widgets?/g,
      actualCount: 5,
      label: 'widgets',
      checkName: 'widget-count',
    });
    expect(drifts).toHaveLength(1);
    expect(drifts[0].message).toContain('"7 widgets"');
  });

  it('SAD (regression, PR #454/#455): the real route-count pattern must match "top-level"', () => {
    // WHO: no one — the check silently never fired. CLAUDE.md said "32
    //      top-level route modules" in four places while `src/routes/`
    //      actually held 29; the live pattern was `/(\d+) route modules?/g`,
    //      which requires the digit immediately before "route module(s)" with
    //      nothing between them, so "32 top-level route modules" never
    //      matched at all — checkCount's own "skip silently if no claim
    //      found" behavior (tested above) made the miss indistinguishable
    //      from "no claim to check," and `verify:claude-md` reported clean
    //      for weeks.
    // WHAT: pins the FIXED pattern (`runAllChecks`'s route-count call site)
    //       against the exact real-world phrasing, both wrong and right.
    const wrongCount = checkCount({
      content: 'Fastify (32 top-level route modules under `src/routes/`).',
      pattern: /(\d+) (?:top-level )?route modules?/g,
      actualCount: 29,
      label: 'route modules',
      checkName: 'route-count',
    });
    expect(wrongCount).toHaveLength(1);
    expect(wrongCount[0].message).toContain('"32 route modules"');

    const rightCount = checkCount({
      content: 'Fastify (29 top-level route modules under `src/routes/`).',
      pattern: /(\d+) (?:top-level )?route modules?/g,
      actualCount: 29,
      label: 'route modules',
      checkName: 'route-count',
    });
    expect(rightCount).toEqual([]);
  });
});

describe('extractSection', () => {
  it('HAPPY: returns the slice between `## header` and the next `## `', () => {
    // WHO: checkPathsExist scoping its scan to one section of the doc
    // WHAT: header found, slice ends at the next H2 header
    // WHY: prevents false positives from list items in unrelated sections
    const md = '# Title\n## Section A\nfirst body\n- `/path-a`\n## Section B\nthe other body\n';
    expect(extractSection(md, '## Section A')).toBe('\nfirst body\n- `/path-a`\n');
  });

  it('HAPPY: returns to end-of-doc when no following H2 exists', () => {
    // WHO: section that's the last one in the file
    // WHAT: slice extends to end-of-string, not silently dropped
    const md = '# Title\n## Final Section\ntail content\n';
    expect(extractSection(md, '## Final Section')).toBe('\ntail content\n');
  });

  it('SAD: returns null when the header is missing', () => {
    // WHO: caller pointed at a section that no longer exists
    // WHAT: null signal lets caller decide whether to error or skip
    // WHY: matches the "skip silently if claim removed" behavior of checkCount
    expect(extractSection('# Title\nbody\n', '## Missing')).toBeNull();
  });
});

describe('checkPathsExist', () => {
  const fakeContent = `## Key Directories
- \`/src\` - backend
- \`/src/routes\` - route modules
- \`/src/templates\` - YAML bundles
- \`/dashboard\` - frontend
## Other Section
- \`/this-should-not-be-checked\` - irrelevant
`;

  it('HAPPY: every listed path resolves → no drift', () => {
    // WHO: maintainer keeping the Key Directories list in sync as code moves
    // WHAT: each backticked path resolves via the injected resolvePath
    // WHY: covers the most common Key Directories drift class — listing a dir
    //      that got renamed or deleted
    const drifts = checkPathsExist({
      content: fakeContent,
      sectionHeader: '## Key Directories',
      resolvePath: () => true,
      checkName: 'directory-existence',
    });
    expect(drifts).toEqual([]);
  });

  it('SAD: one missing path → one drift naming the path', () => {
    // WHO: maintainer who deleted a directory but forgot to remove its bullet
    // WHAT: resolvePath returns false for /src/templates → drift surfaces
    // WHEN: directory rename / delete without doc update
    // WHERE: drift `message` quotes the listed path so a grep-and-fix is fast
    const drifts = checkPathsExist({
      content: fakeContent,
      sectionHeader: '## Key Directories',
      resolvePath: (rel) => rel !== 'src/templates',
      checkName: 'directory-existence',
    });
    expect(drifts).toHaveLength(1);
    expect(drifts[0].message).toContain('"/src/templates"');
  });

  it('HAPPY: paths in OTHER sections are not checked', () => {
    // WHO: doc with multiple sections that each have list items
    // WHAT: only paths within the named section are validated
    // WHY: scoping is the whole point of `extractSection` + `sectionHeader`
    const drifts = checkPathsExist({
      content: fakeContent,
      sectionHeader: '## Key Directories',
      resolvePath: (rel) => rel !== 'this-should-not-be-checked',
      checkName: 'directory-existence',
    });
    expect(drifts).toEqual([]);
  });

  it('HAPPY: missing section → returns [] silently', () => {
    // WHO: doc that intentionally dropped the section
    // WHAT: no section means nothing to check — same skip-silently semantics
    //       as checkCount when the pattern is absent
    const drifts = checkPathsExist({
      content: '# Title\nbody only\n',
      sectionHeader: '## Key Directories',
      resolvePath: () => false,
      checkName: 'directory-existence',
    });
    expect(drifts).toEqual([]);
  });
});

describe('checkCommitsReachable', () => {
  it('HAPPY: every cited commit reachable from main → no drift', () => {
    // WHO: doc whose narrative cites commit hashes that all landed on main
    // WHAT: isReachable returns true for each → silent
    const content = 'See commit `abc1234` and also `deadbeef`.';
    const drifts = checkCommitsReachable({
      content,
      isReachable: () => true,
      checkName: 'commit-reachability',
    });
    expect(drifts).toEqual([]);
  });

  it('SAD: cited commit unreachable → drift with the hash in message', () => {
    // WHO: the original 2026-05-03 incident — commit `e92b3bf` claimed shipped
    //      on 2026-05-01 but actually on a never-merged branch
    // WHAT: isReachable returns false → drift surfaces with the hash named
    // WHEN: a maintainer wrote "shipped in commit X" without verifying X is on main
    // WHERE: the drift message instructs the reader to check existence + branch
    // WHY: this is the highest-value check — would have caught the e92b3bf lie
    const content = 'Shipped in commit `e92b3bf` on Tuesday.';
    const drifts = checkCommitsReachable({
      content,
      isReachable: () => false,
      checkName: 'commit-reachability',
    });
    expect(drifts).toHaveLength(1);
    expect(drifts[0].message).toContain('e92b3bf');
    expect(drifts[0].message).toContain('not reachable from main');
  });

  it('HAPPY: migration timestamps in backticks are NOT treated as commit hashes', () => {
    // WHO: the bare-backtick form is high-precision but our doc has dozens of
    //      migration filenames like `20260501000000` that are also pure-numeric
    // WHAT: 14-digit pure-numeric strings exceed the 12-char hash window AND
    //      have no [a-f] letter, so they're filtered out
    // WHY: false positives on migration timestamps would block every CI run
    const content = 'See migration `20260501000000` (atomic-booking).';
    const seen: string[] = [];
    const drifts = checkCommitsReachable({
      content,
      isReachable: (sha) => {
        seen.push(sha);
        return false;
      },
      checkName: 'commit-reachability',
    });
    expect(drifts).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('HAPPY: explicit `commit \\`<hash>\\`` form passes regardless of letter content', () => {
    // WHO: a (rare) commit hash that's all digits but is preceded by `commit `
    // WHAT: the explicit form has no letter requirement — `commit ` prefix is
    //       enough signal that this is meant as a hash
    // WHY: don't lose precision on the rare all-digit hash
    const content = 'See commit `1234567` for the fix.';
    const seen: string[] = [];
    checkCommitsReachable({
      content,
      isReachable: (sha) => {
        seen.push(sha);
        return true;
      },
      checkName: 'commit-reachability',
    });
    expect(seen).toContain('1234567');
  });

  it('HAPPY: bare backtick form requires at least one a-f letter', () => {
    // WHO: bare-backtick reference like `\`abcd123\`` (has letter) vs `\`9999999\``
    //      (pure digit) — the first is a hash, the second is probably a number
    // WHAT: only the letter-bearing one gets checked
    // WHY: filters out IDs and numbers that happen to be 7-12 chars
    const content = 'Hashes `abcd123` and `1234567` and `9999999`.';
    const seen: string[] = [];
    checkCommitsReachable({
      content,
      isReachable: (sha) => {
        seen.push(sha);
        return true;
      },
      checkName: 'commit-reachability',
    });
    expect(seen).toContain('abcd123');
    expect(seen).not.toContain('1234567');
    expect(seen).not.toContain('9999999');
  });

  it('HAPPY: `<!-- verify-claude-md: unmerged -->` annotation skips reachability check', () => {
    // WHO: the doc legitimately references commit `e92b3bf` to explain the
    //      2026-05-03 doc-vs-reality incident — the commit IS unreachable on
    //      purpose, and the doc says so
    // WHAT: an HTML comment marker right after the backtick reference opts the
    //      hash out of the reachability check
    // WHEN: the reference is intentional ("here's an example of a lie that
    //      slipped past us") rather than a fresh claim
    // WHERE: the `<!-- ... -->` form renders as nothing in Markdown so the
    //       prose stays readable
    // WHY: without the opt-out, every CI run would flag this hash forever and
    //       maintainers would learn to ignore the script
    const content = 'See commit `e92b3bf` <!-- verify-claude-md: unmerged --> for context.';
    const drifts = checkCommitsReachable({
      content,
      isReachable: () => false,
      checkName: 'commit-reachability',
    });
    expect(drifts).toEqual([]);
  });

  it('SAD: hash with a NON-matching comment is NOT skipped (only the unmerged marker opts out)', () => {
    // WHO: future maintainer who tries to suppress drifts with random comments
    // WHAT: only the precise `verify-claude-md: unmerged` marker counts as opt-out
    // WHY: prevents the script from being silenced by accidental or unrelated
    //      HTML comments (e.g., a `<!-- TODO -->` comment near a commit ref)
    const content = 'See commit `deadbeef` <!-- TODO: write up --> for context.';
    const drifts = checkCommitsReachable({
      content,
      isReachable: () => false,
      checkName: 'commit-reachability',
    });
    expect(drifts).toHaveLength(1);
    expect(drifts[0].message).toContain('deadbeef');
  });

  it('HAPPY: dedupes when the same hash is mentioned in both forms', () => {
    // WHO: doc that says `commit \`661d21d\`` once and bare `\`661d21d\`` later
    // WHAT: the helper sees the same hash twice but only checks/reports once
    // WHY: same dedup principle as checkCount — one issue per unique hash
    const content = 'commit `661d21d` did the migration. Later, `661d21d` is referenced again.';
    let calls = 0;
    checkCommitsReachable({
      content,
      isReachable: () => {
        calls++;
        return true;
      },
      checkName: 'commit-reachability',
    });
    expect(calls).toBe(1);
  });
});

describe('collectExpectedUnreachable', () => {
  it('HAPPY: collects hashes whose backticks are followed by the unmerged marker', () => {
    // WHY: helper exists for testability — confirms the regex shape works on
    //      whitespace variations + case-insensitive matching
    const content = 'See `abc1234` <!--verify-claude-md: unmerged--> here.';
    const got = collectExpectedUnreachable(content);
    expect(got.has('abc1234')).toBe(true);
  });

  it('HAPPY: tolerates whitespace and case variations in the marker', () => {
    // WHY: HTML comments aren't normalized; people will write them differently
    const content =
      'See `abc1234` <!-- VERIFY-CLAUDE-MD:  UNMERGED  --> and `def5678` <!--verify-claude-md:unmerged-->.';
    const got = collectExpectedUnreachable(content);
    expect(got.has('abc1234')).toBe(true);
    expect(got.has('def5678')).toBe(true);
  });

  it('SAD: marker without preceding backtick reference matches nothing', () => {
    // WHY: a stray marker shouldn't accidentally allow some other nearby hash
    const content = 'A loose <!-- verify-claude-md: unmerged --> marker.';
    expect(collectExpectedUnreachable(content).size).toBe(0);
  });
});

describe('stripHistoricalSections', () => {
  it('HAPPY: truncates at `## Resolved Issues`', () => {
    // WHO: numeric-count checks that need to ignore historical post-mortems
    // WHAT: the slice ends at `## Resolved Issues` (exclusive) so any counts
    //       inside historical entries (e.g. "split into 20 route modules" from
    //       BUG-017 in March 2026) don't get re-validated against today's tree
    // WHY: this is exactly the false positive that fired on the first run
    //       against live CLAUDE.md — historical narratives need to keep their
    //       date-locked numbers
    const md =
      '## Architecture\nWe have 25 route modules.\n\n## Resolved Issues\nIn March we had 20 route modules.\n';
    expect(stripHistoricalSections(md)).toBe('## Architecture\nWe have 25 route modules.\n\n');
  });

  it('HAPPY: returns content unchanged when the historical section is absent', () => {
    // WHY: docs that don't have a Resolved Issues section yet should still
    //      flow through the same pipeline — no special-casing
    const md = '## Architecture\nWe have 25 route modules.\n';
    expect(stripHistoricalSections(md)).toBe(md);
  });
});

/**
 * When this suite itself runs as a descendant of a real git hook invocation
 * (e.g. `git push` → husky's pre-push → `npm test` → vitest → this file),
 * git has already set `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` etc. in
 * the ambient environment so hooks know which repo invoked them. `execSync`
 * inherits that env wholesale by default, so `git init`/`git commit` against
 * the THROWAWAY tmpdir below were silently operating on the REAL enclosing
 * repo instead — `cwd` alone does not protect against this, an explicit
 * `GIT_DIR` wins. Same fix, same root cause, as `cleanGitEnv()` in
 * `scripts/git-hooks/pre-push.test.ts` — that file's header documents the
 * original discovery (a real repo's `.git/config` found corrupted with this
 * test's own fake identity after a nested run); this file had the identical
 * unguarded pattern and was never given the same fix.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

describe('resolveBranchRef', () => {
  // Real git, deliberately — this is the one exception to the file header's
  // "no shelling out" rule. The bug this guards (PR #453, 2026-09-13) is a
  // property of an ACTUAL git checkout shape (a local branch missing while
  // its remote-tracking ref exists), which mocking `execSync` can't
  // reproduce: a fake "throws on `main`, succeeds on `origin/main`" mock
  // would pass even if the real git command line were malformed.
  it('HAPPY: returns the branch name unchanged when a local ref exists', () => {
    // WHO: a normal local clone / a push-to-main CI run, where `main` is a
    //      real local branch. Built in its own temp repo, deliberately NOT
    //      asserted against the ambient repo running this test suite —
    //      that's exactly the assumption that broke this test in CI on its
    //      first version (the CI checkout has no local `main`, which is the
    //      bug being guarded against, not a property this test may lean on).
    const dir = mkdtempSync(join(tmpdir(), 'verify-claude-md-branchref-'));
    const originalCwd = process.cwd();
    const gitEnv = cleanGitEnv();
    try {
      execSync('git init -q -b main .', { cwd: dir, env: gitEnv });
      execSync('git config user.email test@example.com', { cwd: dir, env: gitEnv });
      execSync('git config user.name test', { cwd: dir, env: gitEnv });
      execSync('git commit -q --allow-empty -m init', { cwd: dir, env: gitEnv });

      process.chdir(dir);
      expect(resolveBranchRef('main')).toBe('main');
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SAD: falls back to origin/<branch> when no local ref exists', () => {
    // WHY: a pull_request CI checkout (`actions/checkout`, fetch-depth: 0)
    //      fetches every branch's history but only checks out the PR's own
    //      ref locally — `main` itself never becomes a local branch, only
    //      `origin/main` does. Reproduced here with a real repo: checked out
    //      on a branch named "feature", with a `refs/remotes/origin/main`
    //      ref but no local `main` branch — the exact shape `actions/checkout`
    //      leaves behind, without needing a second real remote repo.
    const dir = mkdtempSync(join(tmpdir(), 'verify-claude-md-branchref-'));
    const originalCwd = process.cwd();
    const gitEnv = cleanGitEnv();
    try {
      execSync('git init -q -b feature .', { cwd: dir, env: gitEnv });
      execSync('git config user.email test@example.com', { cwd: dir, env: gitEnv });
      execSync('git config user.name test', { cwd: dir, env: gitEnv });
      execSync('git commit -q --allow-empty -m init', { cwd: dir, env: gitEnv });
      const sha = execSync('git rev-parse HEAD', { cwd: dir, env: gitEnv }).toString().trim();
      execSync(`git update-ref refs/remotes/origin/main ${sha}`, { cwd: dir, env: gitEnv });

      process.chdir(dir);
      expect(resolveBranchRef('main')).toBe('origin/main');
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
