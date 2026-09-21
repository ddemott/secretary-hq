/**
 * WHO:   the CI aggregator job that guards the sharded E2E run (.github/workflows/ci.yml).
 * WHAT:  scripts/verify-e2e-shards.mjs — proves every E2E test ran in exactly one shard.
 * WHEN:  after the four E2E shards finish, on every code change.
 * WHERE: pure functions, no Playwright or DB needed.
 * WHY:   splitting the suite is only safe if nothing is silently dropped or run twice. A dropped
 *        test is a green check that no longer checks anything, so the guard itself is tested,
 *        including the failure cases it exists to catch.
 */
import { describe, it, expect } from 'vitest';
import { collectTests, verifyShards } from './verify-e2e-shards.mjs';

type Spec = { title: string; file: string; line: number; project?: string };

/** A Playwright-JSON-shaped report: one file suite per file, tests grouped under it. */
function report(specs: Spec[], describeTitle?: string) {
  const byFile = new Map<string, Spec[]>();
  for (const s of specs) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  const toSpecs = (list: Spec[]) =>
    list.map((s) => ({
      title: s.title,
      file: s.file,
      line: s.line,
      tests: [{ projectName: s.project ?? 'chromium' }],
    }));
  return {
    suites: [...byFile.entries()].map(([file, list]) => ({
      title: file,
      file,
      specs: describeTitle ? [] : toSpecs(list),
      suites: describeTitle ? [{ title: describeTitle, specs: toSpecs(list) }] : [],
    })),
  };
}

const LOGIN: Spec = { title: 'authenticate', file: 'auth.setup.ts', line: 3, project: 'setup' };
const T = (n: number): Spec => ({ title: `test ${n}`, file: `f${n % 3}.spec.ts`, line: n });
const ALL = [1, 2, 3, 4, 5, 6, 7, 8].map(T);

/** Every shard carries the login setup test, exactly as Playwright does. */
const shardOf = (specs: Spec[]) => report([LOGIN, ...specs]);
const fullList = () => report([LOGIN, ...ALL]);
const four = () => [
  shardOf([T(1), T(2)]),
  shardOf([T(3), T(4)]),
  shardOf([T(5), T(6)]),
  shardOf([T(7), T(8)]),
];
const fulls = () => [fullList(), fullList(), fullList(), fullList()];

describe('verify-e2e-shards', () => {
  it('HAPPY: every test in exactly one shard passes, ignoring the login setup test in each shard', () => {
    const result = verifyShards({ fulls: fulls(), shards: four(), expectedShards: 4 });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(8);
    expect(result.perShard).toEqual([2, 2, 2, 2]);
  });

  it('HAPPY: collectTests walks nested describe blocks and keeps the path in the id', () => {
    const tests = collectTests(report([T(1)], 'checkout flow'));
    expect(tests).toHaveLength(1);
    expect(tests[0].id).toContain('checkout flow > test 1');
  });

  it('SAD: a test that ran in no shard is reported as LOST', () => {
    const shards = four();
    shards[3] = shardOf([T(7)]); // T(8) silently dropped
    const result = verifyShards({ fulls: fulls(), shards, expectedShards: 4 });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith('LOST') && p.includes('test 8'))).toBe(true);
  });

  it('SAD: a test that ran in two shards is reported as DUPLICATED', () => {
    const shards = four();
    shards[1] = shardOf([T(3), T(4), T(1)]);
    const result = verifyShards({ fulls: fulls(), shards, expectedShards: 4 });
    expect(result.ok).toBe(false);
    expect(
      result.problems.some(
        (p) => p.startsWith('DUPLICATED (ran in shards 1, 2)') && p.includes('test 1')
      )
    ).toBe(true);
  });

  it('SAD: a test that is not in the full list is reported as UNEXPECTED', () => {
    const shards = four();
    shards[0] = shardOf([T(1), T(2), { title: 'ghost', file: 'ghost.spec.ts', line: 1 }]);
    const result = verifyShards({ fulls: fulls(), shards, expectedShards: 4 });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.startsWith('UNEXPECTED') && p.includes('ghost'))).toBe(
      true
    );
  });

  it('SAD: shards that disagree on the full list are rejected', () => {
    const lists = fulls();
    lists[2] = report([LOGIN, ...ALL.slice(0, 7)]);
    const result = verifyShards({ fulls: lists, shards: four(), expectedShards: 4 });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('full list differs'))).toBe(true);
  });

  it('SAD: fewer shard results than expected is rejected, not treated as a smaller run', () => {
    const result = verifyShards({
      fulls: fulls().slice(0, 3),
      shards: four().slice(0, 3),
      expectedShards: 4,
    });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('expected 4 shards but found 3');
  });

  it('SAD: an empty full list fails instead of passing vacuously', () => {
    const empty = report([LOGIN]);
    const result = verifyShards({
      fulls: [empty, empty, empty, empty],
      shards: [empty, empty, empty, empty],
      expectedShards: 4,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes('nothing would be verified'))).toBe(true);
  });

  it('SAD: two tests with the same title in different files are two distinct tests', () => {
    const a: Spec = { title: 'same title', file: 'a.spec.ts', line: 1 };
    const b: Spec = { title: 'same title', file: 'b.spec.ts', line: 1 };
    const full = report([LOGIN, a, b]);
    const dropped = verifyShards({
      fulls: [full, full],
      shards: [shardOf([a]), shardOf([])],
      expectedShards: 2,
    });
    expect(dropped.ok).toBe(false);
    expect(dropped.problems.some((p) => p.startsWith('LOST') && p.includes('b.spec.ts'))).toBe(
      true
    );
  });
});
