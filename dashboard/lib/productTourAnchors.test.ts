/**
 * Anchor-drift guard: every element the product tour spotlights must still
 * exist in the component source. A renamed data-tour / testid would not fail
 * any other test — the tour would silently fall back to a centered card and
 * point at nothing. This fails CI instead.
 */
import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TOUR_STEPS } from './productTour';

const COMPONENTS = join(__dirname, '..', 'components');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [full] : [];
  });
}

const source = sourceFiles(COMPONENTS)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/** Turn a step selector into the literal that must appear in the JSX. */
function jsxNeedle(selector: string): string {
  let m = selector.match(/^\[data-tour="([^"]+)"\]$/);
  if (m) return `data-tour="${m[1]}"`;
  m = selector.match(/^\[data-testid="([^"]+)"\]$/);
  if (m) return `data-testid="${m[1]}"`;
  m = selector.match(/^#([\w-]+)$/);
  if (m) return `id="${m[1]}"`;
  m = selector.match(/^\[role="tablist"\]\[aria-label="([^"]+)"\]$/);
  if (m) return `ariaLabel="${m[1]}"`;
  throw new Error(`Unrecognised tour selector shape: ${selector} — extend jsxNeedle()`);
}

describe('product tour anchors', () => {
  const targeted = TOUR_STEPS.filter((s) => s.target);

  test.each(targeted.map((s) => [s.id, s.target!]))(
    'HAPPY: step "%s" target %s exists in a component',
    (_id, selector) => {
      expect(source).toContain(jsxNeedle(selector));
    }
  );
});
