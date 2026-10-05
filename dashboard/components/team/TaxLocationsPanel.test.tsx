/**
 * TaxLocationsPanel — the super-admin's view of where paying customers use the service.
 * WHY: Stripe's threshold monitor skips Chicago lease tax, so this panel is where we see
 * the Chicago run-rate, and which paying businesses Stripe cannot place for tax.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import type { TaxSummary } from '../../lib/types';

const { mockApi } = vi.hoisted(() => ({ mockApi: { tenants: { taxSummary: vi.fn() } } }));
vi.mock('../../lib/api', () => ({ Api: mockApi }));

import { TaxLocationsPanel } from './TaxLocationsPanel';

const base: TaxSummary = {
  generated_at: '2026-10-05T12:00:00.000Z',
  totals: { tenants: 4, with_address: 3, paying: 3, paying_without_address: 0 },
  states: [
    { state: 'IL', tenants: 2, paying: 2, est_monthly_usd: 89.9 },
    { state: 'WI', tenants: 1, paying: 1, est_monthly_usd: 29.95 },
  ],
  chicago: {
    tenants: 1,
    paying: 1,
    est_monthly_usd: 59.95,
    est_annual_usd: 719.4,
    threshold_usd: 100000,
    percent_of_threshold: 0.72,
  },
  possible_chicago: [],
  missing_address: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TaxLocationsPanel', () => {
  test('HAPPY: shows each state and the Chicago run-rate against the threshold', async () => {
    mockApi.tenants.taxSummary.mockResolvedValue(base);
    render(<TaxLocationsPanel />);

    expect(await screen.findByText('IL')).toBeInTheDocument();
    expect(screen.getByText('WI')).toBeInTheDocument();
    expect(screen.getByText('$89.90')).toBeInTheDocument();
    expect(screen.getByTestId('chicago-line')).toHaveTextContent(
      '1 paying · $719.40 a year at this rate · 0.72% of the $100,000.00 threshold'
    );
    expect(screen.getByText(/3 of 4 businesses have an address/)).toBeInTheDocument();
  });

  test('SAD: a paying business with no address is called out by name', async () => {
    mockApi.tenants.taxSummary.mockResolvedValue({
      ...base,
      totals: { ...base.totals, paying_without_address: 1 },
      missing_address: [{ tenant_id: 't9', name: 'Thinking Hammer LLC', paying: true }],
    });
    render(<TaxLocationsPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '1 paying business has no address, so Stripe cannot place it for tax: Thinking Hammer LLC.'
    );
  });

  test('HAPPY: a 606 zip not labelled Chicago is listed to check by hand, not counted', async () => {
    mockApi.tenants.taxSummary.mockResolvedValue({
      ...base,
      possible_chicago: [
        { tenant_id: 't5', name: 'Oak Park Auto', city: 'Oak Park', zip: '60607' },
      ],
    });
    render(<TaxLocationsPanel />);

    expect(await screen.findByText(/Oak Park Auto \(Oak Park 60607\)/)).toBeInTheDocument();
  });

  test('HAPPY: no addresses on file says so instead of an empty table', async () => {
    mockApi.tenants.taxSummary.mockResolvedValue({ ...base, states: [] });
    render(<TaxLocationsPanel />);

    expect(await screen.findByText('No addresses on file yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('SAD: a failed load says so, and does not crash the page', async () => {
    mockApi.tenants.taxSummary.mockRejectedValue(new Error('403'));
    render(<TaxLocationsPanel />);

    await waitFor(() =>
      expect(screen.getByText('Could not load the tax locations report.')).toBeInTheDocument()
    );
  });

  test('SAD: a response that is not a summary is a failed load, not a crash', async () => {
    mockApi.tenants.taxSummary.mockResolvedValue({ success: false, error: 'nope' });
    render(<TaxLocationsPanel />);

    await waitFor(() =>
      expect(screen.getByText('Could not load the tax locations report.')).toBeInTheDocument()
    );
  });
});
