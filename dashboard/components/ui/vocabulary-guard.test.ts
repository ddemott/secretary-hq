/**
 * Vocabulary regression guard.
 *
 * UX decision (2026-04-24 review, item #12): user-facing copy uses
 * "business" — internal code identifiers (tenantId, tenant_id, etc.)
 * stay unchanged. This test scans every non-test component source file
 * for user-visible copy that leaks the internal "tenant" term.
 *
 * Extended 2026-05-05 (TODO #5 vocabulary pass): also banned in user
 * copy — "Multi-Tenant", "Skill Matrix", "Service Assignment Matrix",
 * and "coverage gap" phrasings. Each was flagged by the pre-launch UX
 * audit as developer-jargon leaking into the operator surface.
 *
 * If a regression is introduced ("tenant" inside setError, a JSX text
 * node, a placeholder, etc.) this test fails with the exact file + line.
 * Keeps the audit self-documenting.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Walk a directory recursively, yielding .tsx files but not .test.tsx. */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (name.endsWith('.tsx') && !name.endsWith('.test.tsx')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Strip ${...} interpolation expressions and `.foo` property accesses
 * so we only scan the STRING content the user actually sees.
 * Preserves line count so error messages stay accurate.
 */
function stripCodeFromLine(line: string): string {
  // Remove template interpolations like ${newBusiness.tenant_name.trim()}
  let stripped = line.replace(/\$\{[^}]*\}/g, '');
  // Remove .tenant_id / .tenantId property accesses that survived above
  stripped = stripped.replace(/\.tenant(?:_?id|_?name|s|Id)?\b/gi, '');
  return stripped;
}

/**
 * Patterns that indicate USER-VISIBLE copy (vs. code identifiers or
 * internal APIs). Each regex is tested against the STRIPPED line so
 * template expressions and property accesses don't trigger false hits.
 */
const USER_VISIBLE_CONTEXTS: Array<{ pattern: RegExp; description: string }> = [
  // setError / setToast / alert("...") etc. with visible "tenant" word
  { pattern: /setError\([^)]*\btenant\b/i, description: 'setError() message contains "tenant"' },
  { pattern: /showToast\([^)]*\btenant\b/i, description: 'showToast() message contains "tenant"' },
  // placeholder="... tenant ..." visible input hint
  {
    pattern: /placeholder=["'][^"']*\btenant\b[^"']*["']/i,
    description: 'placeholder contains "tenant"',
  },
  // aria-label="... tenant ..." (user-facing label, not a code role name)
  {
    pattern: /aria-label=["'][^"']*\btenant\b[^"']*["']/i,
    description: 'aria-label contains user-facing "tenant"',
  },
  // Banned developer-jargon phrases in any quoted string OR JSX text
  // node. Each was a real leak fixed in the 2026-05-05 vocabulary pass.
  // The phrase form (with the space + capitalized words) prevents false
  // positives from valid code identifiers like SkillMatrixView.
  {
    pattern: /Multi-Tenant\b/,
    description: '"Multi-Tenant" leaking into user copy (use "Multi-Business")',
  },
  {
    pattern: /Skill Matrix\b/,
    description: '"Skill Matrix" leaking into user copy (use "Service Assignments")',
  },
  {
    pattern: /Service Assignment Matrix\b/,
    description: '"Service Assignment Matrix" leaking into user copy (use "Service Assignments")',
  },
  {
    pattern: /coverage gap/i,
    description: '"coverage gap" leaking into user copy (use "fully staffed" / "unstaffed")',
  },
];

describe('Vocabulary guard: user-facing copy should say "business", not "tenant"', () => {
  const files = collectSourceFiles(here);

  it(`scans ${files.length}+ component source files`, () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const { pattern, description } of USER_VISIBLE_CONTEXTS) {
    it(`SAD: no file contains ${description}`, () => {
      // WHO: Any developer adding a new error message / label
      // WHAT: The scan fails fast with a list of offending files + lines
      // WHY: Nielsen H2 — consistency of user-facing vocabulary. Without
      //        this guard, "tenant" creeps back in one setError at a time.
      const offenders: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, 'utf-8');
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          const scanLine = stripCodeFromLine(line);
          if (pattern.test(scanLine)) {
            offenders.push(
              `${file.slice(file.indexOf('/components/'))}:${idx + 1} — ${line.trim()}`
            );
          }
        });
      }
      expect(offenders, `Offenders:\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});
