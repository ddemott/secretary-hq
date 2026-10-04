import { describe, it, expect } from 'vitest';
import { CHECKLIST_PRESET_IDS } from './checklistPresetDerivation';
import { VERTICAL_PREFERENCES } from './preferenceCatalog';
import { isHipaaVertical } from './hipaaVerticalDenylist';

describe('isHipaaVertical', () => {
  it.each([
    'hipaa',
    'HIPAA Clinic',
    'dental',
    'Dental Office',
    'veterinary',
    'veterinary-clinic',
    'chiropractic',
    'Chiropractic Care',
    'optometry',
    'medical',
    'Family Medical Group',
    // Med spas perform medical procedures and hold health information (2026-09-25).
    'med-spa',
    'Med Spa',
    'medspa',
    'MediSpa',
  ])('flags %j as a HIPAA vertical', (businessType) => {
    expect(isHipaaVertical(businessType)).toBe(true);
  });

  it.each([
    'salon',
    'spa',
    'day-spa',
    'mobile-tire',
    'auto-shop',
    'plumber',
    'owner-for-hire',
    'law-firm',
  ])('does not flag the real supported vertical %j', (businessType) => {
    expect(isHipaaVertical(businessType)).toBe(false);
  });
});

describe('no HIPAA vertical is supported anywhere else in the platform', () => {
  // A HIPAA vertical was "removed" from signup but left a front-desk preset, an
  // intake tree and a preference list behind (med spa, found 2026-10-03). Anything
  // that surfaces one is deleted on sight, so this fails the moment one is added back.
  it('SAD: no checklist preset id is for a HIPAA vertical', () => {
    for (const id of CHECKLIST_PRESET_IDS) {
      expect(isHipaaVertical(id), id).toBe(false);
    }
  });

  it('SAD: no preference list is keyed by a HIPAA vertical', () => {
    for (const vertical of Object.keys(VERTICAL_PREFERENCES)) {
      expect(isHipaaVertical(vertical), vertical).toBe(false);
    }
  });
});
