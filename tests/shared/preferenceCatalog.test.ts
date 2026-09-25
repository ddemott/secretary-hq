/**
 * The caller-preference catalog (owner decision 2026-09-25): which facts count
 * as a preference, per business type.
 *
 * WHO: every business on the platform. WHAT: each vertical has its own
 * preference types plus the universal set. WHY: without a fixed list the agent
 * invented a new key for the same fact on every call.
 */
import { describe, it, expect } from 'vitest';
import {
  UNIVERSAL_PREFERENCES,
  VERTICAL_PREFERENCES,
  NOTES_PREFERENCE,
  preferencesForVertical,
} from '../../shared/preferenceCatalog';
import {
  CHECKLIST_PRESET_IDS,
  verticalForBusinessType,
} from '../../shared/checklistPresetDerivation';

const SNAKE = /^[a-z][a-z0-9_]*$/;

describe('preference catalog — coverage', () => {
  it('every vertical the platform ships has its own preference list', () => {
    // Fails CI when a new preset/vertical is added without preferences.
    const verticals = CHECKLIST_PRESET_IDS.map((id) => id.replace(/_front_desk$/, ''));
    const missing = verticals.filter((v) => !VERTICAL_PREFERENCES[v]?.length);
    expect(missing).toEqual([]);
  });

  it('has no entries for verticals that do not exist (no orphan lists)', () => {
    const verticals = new Set(CHECKLIST_PRESET_IDS.map((id) => id.replace(/_front_desk$/, '')));
    expect(Object.keys(VERTICAL_PREFERENCES).filter((v) => !verticals.has(v))).toEqual([]);
  });

  it('salon and auto shop get different, trade-specific preferences', () => {
    const salon = preferencesForVertical('salon').map((p) => p.key);
    const auto = preferencesForVertical('auto_shop').map((p) => p.key);
    expect(salon).toContain('color_formula_notes');
    expect(salon).not.toContain('vehicle');
    expect(auto).toContain('vehicle');
    expect(auto).not.toContain('color_formula_notes');
  });

  it('business types resolve to a list through the same vertical mapping as the question trees', () => {
    expect(preferencesForVertical(verticalForBusinessType('salon')).map((p) => p.key)).toContain(
      'usual_service'
    );
    expect(
      preferencesForVertical(verticalForBusinessType('auto-shop')).map((p) => p.key)
    ).toContain('vehicle');
  });
});

describe('preference catalog — shape', () => {
  it('every key is snake_case, every entry has a label and a hint', () => {
    const all = [...UNIVERSAL_PREFERENCES, ...Object.values(VERTICAL_PREFERENCES).flat()];
    for (const p of all) {
      expect(p.key).toMatch(SNAKE);
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(p.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it('no vertical lists the same key twice', () => {
    for (const [vertical, list] of Object.entries(VERTICAL_PREFERENCES)) {
      const keys = list.map((p) => p.key);
      expect(new Set(keys).size, vertical).toBe(keys.length);
    }
  });

  it('every resolved list includes the universal set and ends with a notes catch-all', () => {
    for (const vertical of Object.keys(VERTICAL_PREFERENCES)) {
      const keys = preferencesForVertical(vertical).map((p) => p.key);
      for (const u of UNIVERSAL_PREFERENCES) expect(keys, vertical).toContain(u.key);
      expect(new Set(keys).size, vertical).toBe(keys.length);
      expect(keys[keys.length - 1]).toBe(NOTES_PREFERENCE.key);
    }
  });

  it('SAD: an unknown or missing vertical still gets the universal list, never an empty one', () => {
    for (const v of [null, undefined, '', 'no_such_vertical']) {
      expect(preferencesForVertical(v).map((p) => p.key)).toEqual(
        UNIVERSAL_PREFERENCES.map((p) => p.key)
      );
    }
  });

  it('med spa and law firm carry no medical or case-fact keys', () => {
    // HIPAA verticals are excluded from the platform; a law firm's case facts
    // belong in the intake, not a profile read back on every future call.
    const risky = /medical|condition|diagnos|medication|treatment_plan|case_/;
    for (const v of ['med_spa', 'law_firm']) {
      for (const p of VERTICAL_PREFERENCES[v]) expect(p.key).not.toMatch(risky);
    }
  });
});
