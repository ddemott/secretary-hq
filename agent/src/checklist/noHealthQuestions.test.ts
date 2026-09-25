/**
 * No call intake asks a caller for health information.
 *
 * WHY: Dale 2026-09-25 — "Anything related to HIPAA is a no." Medical, dental,
 * chiropractic, optometry, veterinary and med-spa businesses are excluded
 * outright; this guards the other side: a NON-medical intake (spa, trainer…)
 * quietly collecting injuries, conditions or medications. Two were found and
 * fixed on 2026-09-25 (personal-trainer "injuries or limitations", spa
 * "comfort or safety").
 *
 * Deliberate exceptions, each decided by Dale, not by this file:
 *   - med_spa_intake: the whole vertical is being deleted (HIPAA).
 * The law firm's personal-injury intake lives in trees.ts (case_intake), not in
 * VERTICAL_INTAKE_TREES. Dale 2026-09-25: left as is for now — injury data should
 * never be stored ("we are just the phonebook"); to be decided before any law
 * firm is accepted (docs/planning/TODO.md).
 */
import { describe, it, expect } from 'vitest';
import { VERTICAL_INTAKE_TREES } from './verticalIntakeTrees.js';

const PENDING_DELETION = new Set(['med_spa_intake']);
// "condition" alone is NOT health — a car's paint condition is fine; only the
// medical senses count.
const HEALTH =
  /\b(injur\w*|limitations?|medical|medications?|(?:health|medical|pre-existing) conditions?|pregnan\w*|diagnos\w*)\b/i;

type AnyNode = { node_id?: string; ask?: string; options?: Record<string, AnyNode[]> };

function collect(nodes: AnyNode[], out: { id: string; ask: string }[] = []) {
  for (const n of nodes) {
    if (n.ask) out.push({ id: n.node_id ?? '?', ask: n.ask });
    for (const children of Object.values(n.options ?? {})) collect(children, out);
  }
  return out;
}

describe('non-medical call intakes collect no health information', () => {
  const trees = VERTICAL_INTAKE_TREES.filter((t) => !PENDING_DELETION.has(t.tree_id));

  it.each(trees.map((t) => [t.tree_id, t] as const))(
    'SAD: %s never asks for injuries, conditions or medications',
    (_id, tree) => {
      for (const { id, ask } of collect(tree.nodes)) {
        if (!HEALTH.test(ask)) continue;
        // A node may NAME a health topic only to forbid it.
        expect(ask, `${tree.tree_id}.${id}`).toMatch(/never ask about or record/i);
      }
    }
  );

  it('HAPPY: the spa asks about comfort only, and says what to do if health comes up', () => {
    const spa = VERTICAL_INTAKE_TREES.find((t) => t.tree_id === 'spa_intake')!;
    const node = collect(spa.nodes as AnyNode[]).find(
      (n) => n.id === 'spa_special_considerations'
    )!;
    expect(node.ask).toMatch(/comfort/);
    expect(node.ask).not.toMatch(/safety/);
    expect(node.ask).toMatch(
      /never ask about or record medical conditions, medications or pregnancy/i
    );
  });

  it('SAD: the personal-trainer intake has no injuries question', () => {
    const pt = VERTICAL_INTAKE_TREES.find((t) => t.tree_id === 'personal_trainer_intake')!;
    const ids = collect(pt.nodes as AnyNode[]).map((n) => n.id);
    expect(ids).not.toContain('personal_trainer_injuries_or_limitations');
  });
});
