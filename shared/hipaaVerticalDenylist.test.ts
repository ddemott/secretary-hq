import { describe, it, expect } from 'vitest';
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
  ])('flags %j as a HIPAA vertical', (businessType) => {
    expect(isHipaaVertical(businessType)).toBe(true);
  });

  it.each(['salon', 'mobile-tire', 'auto-shop', 'plumber', 'owner-for-hire', 'law-firm'])(
    'does not flag the real supported vertical %j',
    (businessType) => {
      expect(isHipaaVertical(businessType)).toBe(false);
    }
  );
});
