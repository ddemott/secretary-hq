/**
 * parsePreferenceCatalog — the agent's read of tenant-config preference_catalog.
 * WHO: every call. WHAT: only well-formed entries survive (snake_case key,
 * non-blank label + hint, first of any duplicate key). WHY: the keys become the
 * enum the model must choose from — a malformed entry must be dropped, never
 * handed to the model.
 */
import { describe, expect, it } from 'vitest';
import { parsePreferenceCatalog } from './tenantConfig.js';

describe('parsePreferenceCatalog', () => {
  it('HAPPY: keeps well-formed entries in order, trimming label and hint', () => {
    expect(
      parsePreferenceCatalog([
        { key: 'vehicle', label: ' Vehicle ', hint: ' Year, make, model. ' },
        { key: 'notes', label: 'Other notes', hint: 'Anything else.' },
      ])
    ).toEqual([
      { key: 'vehicle', label: 'Vehicle', hint: 'Year, make, model.' },
      { key: 'notes', label: 'Other notes', hint: 'Anything else.' },
    ]);
  });

  it('SAD: drops bad keys, blank labels/hints, non-objects and duplicate keys', () => {
    expect(
      parsePreferenceCatalog([
        null,
        'vehicle',
        { key: 'Bad Key', label: 'x', hint: 'y' },
        { key: 'ok_key', label: '   ', hint: 'y' },
        { key: 'ok_key2', label: 'x', hint: '' },
        { key: 'dup', label: 'First', hint: 'kept' },
        { key: 'dup', label: 'Second', hint: 'dropped' },
      ])
    ).toEqual([{ key: 'dup', label: 'First', hint: 'kept' }]);
  });

  it('SAD: anything that is not an array (older backend, bad payload) → empty list', () => {
    for (const raw of [undefined, null, {}, 'x', 42]) {
      expect(parsePreferenceCatalog(raw)).toEqual([]);
    }
  });
});
