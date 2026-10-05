import { describe, it, expect } from 'vitest';
import {
  summarizeTaxLocations,
  isChicago,
  isPaying,
  monthlyListPrice,
  CHICAGO_LEASE_TAX_THRESHOLD_USD,
  type TaxLocationRow,
} from '../../src/services/taxReport';
import { PLAN_PRICE_USD, PLAN_QUOTAS } from '../../src/services/billingUsage';

let n = 0;
function row(over: Partial<TaxLocationRow> = {}): TaxLocationRow {
  n += 1;
  return {
    tenant_id: `t-${n}`,
    name: `Biz ${n}`,
    subscription_status: 'active',
    subscription_plan: 'solo',
    service_city: 'Madison',
    service_state: 'WI',
    service_zip: '53703',
    ...over,
  };
}

describe('taxReport helpers', () => {
  it('prices every plan we sell, and only those', () => {
    expect(Object.keys(PLAN_PRICE_USD).sort()).toEqual(Object.keys(PLAN_QUOTAS).sort());
    expect(monthlyListPrice('solo')).toBe(29.95);
    expect(monthlyListPrice('growth')).toBe(59.95);
    expect(monthlyListPrice('professional')).toBe(149.95);
    expect(monthlyListPrice(null)).toBe(0);
    expect(monthlyListPrice('enterprise')).toBe(0);
  });

  it('counts active and past_due as paying; nothing else', () => {
    expect(isPaying('active')).toBe(true);
    expect(isPaying('past_due')).toBe(true);
    for (const s of ['inactive', 'canceled', null]) expect(isPaying(s)).toBe(false);
  });

  it('recognises Chicago only as Chicago, IL (case and spacing tolerant)', () => {
    expect(isChicago('Chicago', 'IL')).toBe(true);
    expect(isChicago('  chicago ', 'IL')).toBe(true);
    expect(isChicago('Chicago', 'WI')).toBe(false);
    expect(isChicago('Evanston', 'IL')).toBe(false);
    expect(isChicago(null, 'IL')).toBe(false);
  });
});

describe('summarizeTaxLocations', () => {
  it('HAPPY: groups by state with paying counts and estimated monthly list price', () => {
    const s = summarizeTaxLocations([
      row({ service_state: 'WI', subscription_plan: 'solo' }),
      row({ service_state: 'WI', subscription_plan: 'growth' }),
      row({ service_state: 'TX', service_zip: '73301', subscription_plan: 'professional' }),
    ]);
    expect(s.states).toEqual([
      { state: 'TX', tenants: 1, paying: 1, est_monthly_usd: 149.95 },
      { state: 'WI', tenants: 2, paying: 2, est_monthly_usd: 89.9 },
    ]);
    expect(s.totals).toEqual({
      tenants: 3,
      with_address: 3,
      paying: 3,
      paying_without_address: 0,
    });
  });

  it('HAPPY: a non-paying business counts as a tenant but adds no revenue', () => {
    const s = summarizeTaxLocations([
      row({ subscription_status: 'inactive', subscription_plan: null }),
      row({ subscription_status: 'canceled', subscription_plan: 'solo' }),
    ]);
    expect(s.states).toEqual([{ state: 'WI', tenants: 2, paying: 0, est_monthly_usd: 0 }]);
  });

  it('HAPPY: Chicago is called out, with the run-rate against the $100,000 threshold', () => {
    const s = summarizeTaxLocations([
      row({
        service_city: 'Chicago',
        service_state: 'IL',
        service_zip: '60602',
        subscription_plan: 'professional',
      }),
      row({ service_city: 'Chicago', service_state: 'IL', service_zip: '60614' }),
    ]);
    expect(s.chicago.tenants).toBe(2);
    expect(s.chicago.paying).toBe(2);
    expect(s.chicago.est_monthly_usd).toBe(179.9);
    expect(s.chicago.est_annual_usd).toBe(2158.8);
    expect(s.chicago.threshold_usd).toBe(CHICAGO_LEASE_TAX_THRESHOLD_USD);
    expect(s.chicago.percent_of_threshold).toBe(2.16);
    expect(s.possible_chicago).toEqual([]);
  });

  it('HAPPY: a 606 Illinois zip that is not labelled Chicago is listed to verify, not counted as Chicago', () => {
    const s = summarizeTaxLocations([
      row({
        tenant_id: 'cicero',
        name: 'Cicero Cuts',
        service_city: 'Cicero',
        service_state: 'IL',
        service_zip: '60804',
      }),
      row({
        tenant_id: 'oakpark',
        name: 'Oak Park Auto',
        service_city: 'Oak Park',
        service_state: 'IL',
        service_zip: '60607',
      }),
    ]);
    expect(s.chicago.tenants).toBe(0);
    // Only the 606xx zip is flagged; 608xx is not.
    expect(s.possible_chicago).toEqual([
      { tenant_id: 'oakpark', name: 'Oak Park Auto', city: 'Oak Park', zip: '60607' },
    ]);
  });

  it('SAD: a paying business with no address is listed as missing, not silently dropped', () => {
    const s = summarizeTaxLocations([
      row({ tenant_id: 'old', name: 'Old Biz', service_state: null, service_zip: null }),
      row({
        subscription_status: 'inactive',
        service_state: null,
        service_zip: null,
        service_city: null,
      }),
    ]);
    expect(s.missing_address).toEqual([{ tenant_id: 'old', name: 'Old Biz', paying: true }]);
    expect(s.totals.paying_without_address).toBe(1);
    expect(s.totals.with_address).toBe(0);
    expect(s.states).toEqual([]);
  });

  it('HAPPY: an empty platform is a valid, empty report', () => {
    const s = summarizeTaxLocations([]);
    expect(s.totals).toEqual({ tenants: 0, with_address: 0, paying: 0, paying_without_address: 0 });
    expect(s.states).toEqual([]);
    expect(s.chicago.percent_of_threshold).toBe(0);
  });
});
