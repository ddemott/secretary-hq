'use client';

import React, { useEffect, useState } from 'react';
import { Card } from '../ui/Card';
import { Api } from '../../lib/api';
import type { TaxSummary } from '../../lib/types';

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

/**
 * Where paying customers use the service, by state, with Chicago called out. Sales tax follows
 * where the customer uses the service. Chicago taxes SaaS as a lease once sales into the city reach
 * $100,000, and Stripe's own threshold monitor does not watch that one — so we do.
 *
 * Super-admin only (the backend route refuses anyone else). Estimates from list price.
 */
export function TaxLocationsPanel() {
  const [summary, setSummary] = useState<TaxSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => Api.tenants.taxSummary())
      .then((s) => {
        if (cancelled) return;
        // A response that is not a summary (an error body, an old backend) is a failed load,
        // never a render crash.
        if (s && typeof s === 'object' && s.totals && s.chicago && Array.isArray(s.states)) {
          setSummary(s);
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return (
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        Could not load the tax locations report.
      </p>
    );
  }
  if (!summary) return null;

  const { totals, states, chicago, possible_chicago, missing_address } = summary;

  return (
    <Card
      className="p-6 w-full max-w-2xl text-left"
      style={{ backgroundColor: 'var(--bg-raised)' }}
    >
      <h3 className="text-base font-semibold mb-1">Tax locations</h3>
      <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
        Where paying customers use the service. Estimates from list price; Stripe Tax&apos;s reports
        are the source of truth for filing.
      </p>

      <p className="text-sm mb-4">
        {totals.paying} paying · {totals.with_address} of {totals.tenants} businesses have an
        address
      </p>

      {missing_address.length > 0 && (
        <div
          role="alert"
          className="rounded-md px-4 py-3 text-sm mb-4"
          style={{
            backgroundColor: 'rgba(245, 158, 11, 0.12)',
            color: 'var(--warning)',
            border: '1px solid rgba(245, 158, 11, 0.35)',
          }}
        >
          {missing_address.length} paying{' '}
          {missing_address.length === 1 ? 'business has' : 'businesses have'} no address, so Stripe
          cannot place {missing_address.length === 1 ? 'it' : 'them'} for tax:{' '}
          {missing_address.map((m) => m.name).join(', ')}.
        </div>
      )}

      <div className="mb-4">
        <h4 className="text-sm font-semibold">Chicago (lease tax)</h4>
        <p className="text-sm" data-testid="chicago-line">
          {chicago.paying} paying · {usd(chicago.est_annual_usd)} a year at this rate ·{' '}
          {chicago.percent_of_threshold}% of the {usd(chicago.threshold_usd)} threshold
        </p>
        {possible_chicago.length > 0 && (
          <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            Check by hand (Chicago zip, not labelled Chicago):{' '}
            {possible_chicago.map((p) => `${p.name} (${p.city ?? 'no city'} ${p.zip})`).join(', ')}
          </p>
        )}
      </div>

      {states.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No addresses on file yet.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-secondary)' }}>
              <th className="py-1 font-semibold">State</th>
              <th className="py-1 font-semibold">Businesses</th>
              <th className="py-1 font-semibold">Paying</th>
              <th className="py-1 font-semibold text-right">Est. per month</th>
            </tr>
          </thead>
          <tbody>
            {states.map((s) => (
              <tr key={s.state}>
                <td className="py-1">{s.state}</td>
                <td className="py-1">{s.tenants}</td>
                <td className="py-1">{s.paying}</td>
                <td className="py-1 text-right">{usd(s.est_monthly_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
