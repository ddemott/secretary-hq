import { describe, it, expect } from 'vitest';
import { normalizeServiceAddress, US_STATE_CODES } from './serviceAddress';

const good = { street: '1 N State St', city: 'Chicago', state: 'IL', zip: '60602' };

describe('normalizeServiceAddress', () => {
  it('HAPPY: accepts a complete address', () => {
    expect(normalizeServiceAddress(good)).toEqual({ ok: true, address: good });
  });

  it('HAPPY: cleans whitespace and upper-cases the state', () => {
    const r = normalizeServiceAddress({
      street: '  1   N  State St ',
      city: ' Chicago ',
      state: ' il ',
      zip: ' 60602-1234 ',
    });
    expect(r).toEqual({ ok: true, address: { ...good, zip: '60602-1234' } });
  });

  it('HAPPY: covers all 50 states plus DC', () => {
    expect(US_STATE_CODES).toHaveLength(51);
    for (const state of US_STATE_CODES) {
      expect(normalizeServiceAddress({ ...good, state }).ok).toBe(true);
    }
  });

  it.each([null, undefined, {}])('SAD: %p has an error on every field', (input) => {
    const r = normalizeServiceAddress(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['city', 'state', 'street', 'zip']);
  });

  it.each([
    ['street', { ...good, street: '   ' }],
    ['city', { ...good, city: '' }],
    ['state', { ...good, state: 'ZZ' }],
    ['state', { ...good, state: 'Illinois' }],
    ['zip', { ...good, zip: '6060' }],
    ['zip', { ...good, zip: 'ABCDE' }],
    ['zip', { ...good, zip: '60602-12' }],
  ])('SAD: a bad %s is reported on that field only', (field, input) => {
    const r = normalizeServiceAddress(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toEqual([field]);
  });

  it('SAD: non-string values are treated as missing, not coerced', () => {
    const r = normalizeServiceAddress({ ...good, zip: 60602 as unknown as string });
    expect(r.ok).toBe(false);
  });

  it('SAD: an absurdly long street is refused', () => {
    expect(normalizeServiceAddress({ ...good, street: 'x'.repeat(201) }).ok).toBe(false);
  });
});
