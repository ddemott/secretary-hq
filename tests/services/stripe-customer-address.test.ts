import { describe, it, expect } from 'vitest';
import { stripeCustomerAddress } from '../../src/services/stripe/customerAddress';

const row = {
  service_street: '1 N State St',
  service_city: 'Chicago',
  service_state: 'IL',
  service_zip: '60602',
  service_country: 'US',
};

describe('stripeCustomerAddress', () => {
  it('HAPPY: maps a full service address to Stripe fields', () => {
    expect(stripeCustomerAddress(row)).toEqual({
      line1: '1 N State St',
      city: 'Chicago',
      state: 'IL',
      postal_code: '60602',
      country: 'US',
    });
  });

  it('HAPPY: a missing country defaults to US', () => {
    expect(stripeCustomerAddress({ ...row, service_country: null })?.country).toBe('US');
  });

  it.each(['service_street', 'service_city', 'service_state', 'service_zip'])(
    'SAD: no %s means no address (a partial address cannot place a customer)',
    (field) => {
      expect(stripeCustomerAddress({ ...row, [field]: null })).toBeNull();
      expect(stripeCustomerAddress({ ...row, [field]: '' })).toBeNull();
    }
  );

  it('SAD: an empty row is no address', () => {
    expect(stripeCustomerAddress({})).toBeNull();
  });
});
