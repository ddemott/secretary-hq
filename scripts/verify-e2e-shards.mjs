#!/usr/bin/env node
/**
 * Proves a sharded Playwright run lost nothing: every test in the FULL list ran in exactly one
 * shard. CI runs this after the E2E shards (see the `e2e` aggregator job in .github/workflows/ci.yml).
 *
 *   node scripts/verify-e2e-shards.mjs <artifacts-dir> <shard-count>
 *
 * Expects <artifacts-dir>/e2e-shard-<n>/{list.json,results.json} for n = 1..shard-count, where
 *   list.json    = `playwright test --list --reporter=json`          (the FULL, unsharded list)
 *   results.json = `playwright test --shard=n/N --reporter=list,json` (what that shard ran)
 *
 * The `setup` project (login) is deliberately present in EVERY shard, so it is excluded from the
 * accounting; every other test must appear in exactly one shard's results.
 *
 * Pure logic is exported so it can be unit-tested (scripts/verify-e2e-shards.test.ts).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETUP_PROJECT = 'setup';

/** Flatten a Playwright JSON report into `{ project, id }` per test. Ids include the describe path. */
export function collectTests(report) {
  const out = [];
  const walk = (suite, titles) => {
    // A file-level suite's title is the file name; nested suites are `describe` blocks.
    const here = suite.title ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const project = test.projectName ?? '';
        out.push({
          project,
          id: `${project} | ${spec.file}:${spec.line} | ${[...here, spec.title].join(' > ')}`,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  return out;
}

const realIds = (report) =>
  collectTests(report)
    .filter((t) => t.project !== SETUP_PROJECT)
    .map((t) => t.id);

/**
 * @param {{ fulls: object[], shards: object[], expectedShards: number }} input
 *   fulls  = each shard's own copy of the full list (they must all agree)
 *   shards = each shard's results report
 */
export function verifyShards({ fulls, shards, expectedShards }) {
  const problems = [];

  if (shards.length !== expectedShards || fulls.length !== expectedShards) {
    problems.push(
      `expected ${expectedShards} shards but found ${shards.length} results and ${fulls.length} lists`
    );
  }

  const fullSets = fulls.map((f) => [...new Set(realIds(f))].sort());
  if (fullSets.length === 0 || fullSets.some((s) => s.join('\n') !== fullSets[0].join('\n'))) {
    problems.push('the shards did not all list the same set of tests (the full list differs)');
  }
  const full = new Set(fullSets[0] ?? []);
  if (full.size === 0) problems.push('the full test list is empty — nothing would be verified');

  const seenIn = new Map(); // id -> shard numbers that ran it
  const perShard = [];
  shards.forEach((report, index) => {
    const ids = realIds(report);
    perShard.push(ids.length);
    for (const id of new Set(ids)) {
      seenIn.set(id, [...(seenIn.get(id) ?? []), index + 1]);
    }
    if (new Set(ids).size !== ids.length) {
      problems.push(`shard ${index + 1} lists the same test more than once`);
    }
  });

  for (const id of full) {
    if (!seenIn.has(id)) problems.push(`LOST (ran in no shard): ${id}`);
  }
  for (const [id, where] of seenIn) {
    if (!full.has(id)) problems.push(`UNEXPECTED (not in the full list): ${id}`);
    if (where.length > 1) problems.push(`DUPLICATED (ran in shards ${where.join(', ')}): ${id}`);
  }

  return { ok: problems.length === 0, problems, total: full.size, perShard };
}

function readJson(path) {
  if (!existsSync(path)) throw new Error(`missing file: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main(argv) {
  const [dir, countArg] = argv;
  const expectedShards = Number(countArg);
  if (!dir || !Number.isInteger(expectedShards) || expectedShards < 1) {
    console.error('usage: node scripts/verify-e2e-shards.mjs <artifacts-dir> <shard-count>');
    return 2;
  }
  const fulls = [];
  const shards = [];
  try {
    for (let n = 1; n <= expectedShards; n++) {
      fulls.push(readJson(join(dir, `e2e-shard-${n}`, 'list.json')));
      shards.push(readJson(join(dir, `e2e-shard-${n}`, 'results.json')));
    }
  } catch (err) {
    console.error(`[verify-e2e-shards] FAIL — ${err.message}`);
    return 1;
  }
  const result = verifyShards({ fulls, shards, expectedShards });
  if (!result.ok) {
    console.error(`[verify-e2e-shards] FAIL — ${result.problems.length} problem(s):`);
    for (const p of result.problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(
    `[verify-e2e-shards] OK — ${result.total} tests, each ran exactly once across ` +
      `${expectedShards} shards (${result.perShard.join(' / ')}); none lost, none duplicated`
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
