import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

/**
 * ONE PG CLIENT, ONE QUERY AT A TIME.
 *
 * WHY THIS EXISTS — `await Promise.all([client.query(a), client.query(b)])` reads
 * like concurrency and is not. node-postgres serialises statements on a single
 * client no matter how they are launched, so the array literal buys nothing; all
 * it does is START every query before the previous one has finished, which is the
 * state pg warns about and REMOVES in pg@9:
 *
 *     DeprecationWarning: Calling client.query() when the client is already
 *     executing a query is deprecated and will be removed in pg@9.
 *
 * Three sites did this (`/analytics/stats`, `/analytics/calls`, and the cohorts
 * service) and the warning printed on every green run for months — a future
 * outage sitting in plain sight, in the output everyone had learned to scroll
 * past. They now use `queryInSeries(...)` from `src/database`, which takes THUNKS
 * so nothing starts out of turn.
 *
 * This guard is a source scan, not a runtime assertion, because the failure mode
 * is a deprecation notice today and a break later — there is nothing to catch at
 * runtime until the upgrade that breaks it.
 */

const SRC = path.join(__dirname, '../../src');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

/**
 * Strip comments before scanning. Without this the guard reports the doc comment
 * on `queryInSeries` itself, which quotes the bad pattern in order to explain it —
 * a scanner that cannot tell code from prose punishes the documentation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Text of every `Promise.all( … [ … ] )` array literal in a file, brackets included.
 *
 * The opener is matched as a REGEX, not the substring `Promise.all([`, because
 * Prettier is free to break the call across lines (`Promise.all(\n  [ … ])`) and a
 * substring scan would sail straight past it — the guard would stay green while the
 * pattern it exists to stop walked back in. A `Promise.all(someArrayBuiltEarlier)`
 * is still out of reach of a scanner like this; that shape has never appeared here,
 * and catching it needs a type-aware pass rather than a smarter regex.
 */
function promiseAllBlocks(source: string): string[] {
  const blocks: string[] = [];
  const opener = /Promise\s*\.\s*all\s*\(\s*\[/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    // exec's index points at "Promise"; the bracket we balance is the last char.
    let depth = 0;
    let i = match.index + match[0].length - 1;
    for (; i < source.length; i++) {
      if (source[i] === '[') depth++;
      else if (source[i] === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(match.index, i + 1));
    opener.lastIndex = i + 1;
  }
  return blocks;
}

describe('Regression: no overlapping queries on a single pg client', () => {
  it('SAD: no Promise.all in src/ launches two client.query calls at once', () => {
    // WHO: anyone adding a multi-query read path inside withTenantClient
    // WHAT: Promise.all over client.query on ONE client
    // WHEN: any request that renders several panels from one connection
    // WHERE: src/**/*.ts
    // WHY: pg queues them anyway (so nothing is gained) and removes the pattern
    //      in pg@9 (so something is lost). Use queryInSeries(...) instead.
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      for (const block of promiseAllBlocks(stripComments(fs.readFileSync(file, 'utf8')))) {
        // A thunk (`() => client.query(...)`) is fine — it is not started early.
        const eager = block.replace(/\(\)\s*=>\s*/g, '@THUNK@');
        const count = (eager.match(/(?<!@THUNK@)\bclient\s*\.?\s*\n?\s*\.?query[<(]/g) ?? [])
          .length;
        if (count > 1) {
          offenders.push(`${path.relative(SRC, file)} (${count} eager client.query calls)`);
        }
      }
    }

    expect(
      offenders,
      `Promise.all over one pg client serialises anyway and breaks at pg@9. ` +
        `Use queryInSeries(...) from src/database. Offenders:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('HAPPY: queryInSeries exists and runs its thunks strictly in order', async () => {
    // WHO: the three analytics read paths that used to use Promise.all
    // WHAT: queryInSeries awaits each thunk before starting the next
    // WHEN: every /analytics/stats, /analytics/calls and cohorts request
    // WHERE: src/database/index.ts
    // WHY: "serialised" is the entire point — a helper that secretly parallelised
    //      would reintroduce the exact overlap this file exists to prevent.
    const { queryInSeries } = await import('../../src/database/index');

    const order: string[] = [];
    const step = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
      return name;
    };

    // The slow one goes FIRST: under Promise.all its end would land after b:start.
    const [a, b] = await queryInSeries(step('a', 20), step('b', 0));

    expect([a, b]).toEqual(['a', 'b']);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });
});
