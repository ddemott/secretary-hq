/**
 * Where our paying customers are, for sales-tax purposes.
 *
 * SaaS sales tax follows where the customer USES the service. This summarises every real business
 * by the service address it gave us (tenants.service_*), so we can see which states we sell into
 * and spot Chicago customers.
 *
 * Why Chicago is watched here and not just in Stripe: Chicago taxes SaaS as a lease (15% from
 * 2026-01-01) once a seller reaches $100,000 of sales into the city, and Stripe's own
 * threshold monitor does NOT include Chicago lease-tax transactions
 * (https://docs.stripe.com/tax/supported-countries/united-states/illinois). So this report is the
 * early warning for that one.
 *
 * Figures are ESTIMATES from list price. Stripe Tax's reports are the source of truth for filing.
 */
import type { Pool } from 'pg';
import { PLAN_PRICE_USD } from './billingUsage';

export const CHICAGO_LEASE_TAX_THRESHOLD_USD = 100_000;

export interface TaxLocationRow {
  tenant_id: string;
  name: string;
  subscription_status: string | null;
  subscription_plan: string | null;
  service_city: string | null;
  service_state: string | null;
  service_zip: string | null;
}

export interface StateSummary {
  state: string;
  tenants: number;
  paying: number;
  est_monthly_usd: number;
}

export interface TaxLocationSummary {
  totals: {
    tenants: number;
    with_address: number;
    paying: number;
    paying_without_address: number;
  };
  states: StateSummary[];
  chicago: {
    tenants: number;
    paying: number;
    est_monthly_usd: number;
    est_annual_usd: number;
    threshold_usd: number;
    percent_of_threshold: number;
  };
  /** Illinois zips starting 606 that are not labelled Chicago — Chicago zips also cover suburbs, so verify by hand. */
  possible_chicago: { tenant_id: string; name: string; city: string | null; zip: string }[];
  /** Paying businesses with no address: Stripe cannot place them for tax. */
  missing_address: { tenant_id: string; name: string; paying: boolean }[];
}

/** A subscription that bills (or is about to retry billing). */
export function isPaying(status: string | null): boolean {
  return status === 'active' || status === 'past_due';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function monthlyListPrice(plan: string | null): number {
  return (plan && PLAN_PRICE_USD[plan]) || 0;
}

export function isChicago(city: string | null, state: string | null): boolean {
  return state === 'IL' && (city ?? '').trim().toLowerCase() === 'chicago';
}

export function summarizeTaxLocations(rows: TaxLocationRow[]): TaxLocationSummary {
  const byState = new Map<string, StateSummary>();
  const chicago = { tenants: 0, paying: 0, monthly: 0 };
  const possibleChicago: TaxLocationSummary['possible_chicago'] = [];
  const missing: TaxLocationSummary['missing_address'] = [];
  let withAddress = 0;
  let paying = 0;

  for (const r of rows) {
    const pays = isPaying(r.subscription_status);
    if (pays) paying += 1;
    if (!r.service_state || !r.service_zip) {
      if (pays) missing.push({ tenant_id: r.tenant_id, name: r.name, paying: true });
      continue;
    }
    withAddress += 1;
    const price = pays ? monthlyListPrice(r.subscription_plan) : 0;
    const s = byState.get(r.service_state) ?? {
      state: r.service_state,
      tenants: 0,
      paying: 0,
      est_monthly_usd: 0,
    };
    s.tenants += 1;
    if (pays) s.paying += 1;
    s.est_monthly_usd = round2(s.est_monthly_usd + price);
    byState.set(r.service_state, s);

    if (isChicago(r.service_city, r.service_state)) {
      chicago.tenants += 1;
      if (pays) chicago.paying += 1;
      chicago.monthly += price;
    } else if (r.service_state === 'IL' && r.service_zip.startsWith('606')) {
      possibleChicago.push({
        tenant_id: r.tenant_id,
        name: r.name,
        city: r.service_city,
        zip: r.service_zip,
      });
    }
  }

  const annual = chicago.monthly * 12;
  return {
    totals: {
      tenants: rows.length,
      with_address: withAddress,
      paying,
      paying_without_address: missing.length,
    },
    states: [...byState.values()].sort(
      (a, b) => b.est_monthly_usd - a.est_monthly_usd || a.state.localeCompare(b.state)
    ),
    chicago: {
      tenants: chicago.tenants,
      paying: chicago.paying,
      est_monthly_usd: round2(chicago.monthly),
      est_annual_usd: round2(annual),
      threshold_usd: CHICAGO_LEASE_TAX_THRESHOLD_USD,
      percent_of_threshold: round2((annual / CHICAGO_LEASE_TAX_THRESHOLD_USD) * 100),
    },
    possible_chicago: possibleChicago,
    missing_address: missing,
  };
}

/** Every real business: not deleted, not a template, not the public Tutorial. */
export async function loadTaxLocationRows(pool: Pool): Promise<TaxLocationRow[]> {
  const res = await pool.query<TaxLocationRow>(
    `SELECT tenant_id, name, subscription_status, subscription_plan,
            service_city, service_state, service_zip
       FROM tenants
      WHERE is_deleted = false AND is_template = false AND is_tutorial = false`
  );
  return res.rows;
}
