/**
 * Tests for CustomerSidebar's list-state affordances (UX review, 2026-09-16).
 *
 * Before this pass the sidebar rendered nothing but the spinning refresh
 * icon during the initial fetch (no aria-visible loading indicator — a
 * screen-reader user hears silence and has no way to know the list is
 * still loading vs. genuinely empty), and a failed fetch fell through to
 * the exact same "No customers yet / Add one manually" empty state a real
 * zero-customer tenant sees — inviting an owner to add a customer by hand
 * when the actual problem is the backend didn't answer. Same defect class
 * already fixed on AnalyticsView/AiCostPanel (#511).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';

import { CustomerSidebar } from './CustomerSidebar';
import type { Customer } from '@/lib/types';

vi.mock('../../lib/api', () => ({
  Api: {
    exportData: { csv: vi.fn() },
    customers: { importCsv: vi.fn() },
  },
}));
vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/useConfirm', () => ({
  useConfirm: () => ({ state: { isOpen: false }, confirm: vi.fn(), close: vi.fn() }),
}));
vi.mock('../ui/ConfirmModal', () => ({ ConfirmModal: () => null }));

const CUSTOMER: Customer = {
  customer_id: 'cust-1',
  tenant_id: 'tenant-1',
  name: 'Jamie Rivera',
  phone: '+16305551234',
} as unknown as Customer;

function renderSidebar(overrides: Partial<React.ComponentProps<typeof CustomerSidebar>> = {}) {
  const defaultProps: React.ComponentProps<typeof CustomerSidebar> = {
    customers: [],
    selectedCustomer: null,
    loading: false,
    isOwner: false,
    tenantId: 'tenant-1',
    showDetailOnMobile: false,
    onSelectCustomer: vi.fn(),
    onAddCustomer: vi.fn(),
    onRefresh: vi.fn(),
    onImportDone: vi.fn(),
  };
  return render(<CustomerSidebar {...defaultProps} {...overrides} />);
}

describe('CustomerSidebar — loading, error, and empty states are distinct', () => {
  it('HAPPY: a normal fetch renders the customer list with formatted phone numbers', () => {
    // WHO: any operator opening the CRM tab. WHAT: a resolved customer list
    //       renders each row with a formatted phone number. WHEN: loading is
    //       false and customers is non-empty. WHERE: filteredCustomers map.
    // WHY: pins the baseline render this file's other cases are contrasted against.
    renderSidebar({ customers: [CUSTOMER] });
    expect(screen.getByText('Jamie Rivera')).toBeInTheDocument();
    expect(screen.getByText('+1 (630) 555-1234')).toBeInTheDocument();
  });

  it('SAD: the initial fetch (loading, zero customers yet) shows an accessible loading skeleton, not a blank list', () => {
    // WHO: a screen-reader user opening the CRM tab for the first time.
    // WHAT: a labeled, aria-busy loading region must render — previously
    //       nothing rendered here at all during the initial fetch, which
    //       reads as a broken/blank tab to assistive tech.
    // WHEN: loading=true and customers=[] (first paint, before any fetch resolves).
    // WHERE: CustomerSidebar's list region, loading-skeleton branch.
    // WHY: matches the AppointmentListSidebar / AnalyticsSkeleton convention
    //       already used elsewhere in this dashboard for the same moment.
    renderSidebar({ loading: true, customers: [] });
    const skeleton = screen.getByLabelText('Loading customers');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('No customers yet')).not.toBeInTheDocument();
  });

  it("SAD: a failed fetch shows a distinct error state, not the same copy as a real 'no customers yet' tenant", () => {
    // WHO: an owner whose /customers request failed (network blip, 500).
    // WHAT: the sidebar must say the load failed and offer a retry — NOT the
    //       "No customers yet... add one manually" copy a genuinely empty
    //       tenant sees, which would tell a real customer's owner to start
    //       manually re-typing a list that actually exists on the server.
    // WHEN: loadError=true, loading=false, customers=[].
    // WHERE: CustomerSidebar's list region, loadError branch (role="alert").
    // WHY: same "error rendered identically to empty" defect class fixed in
    //       AiCostPanel (#511) — clicking through it here misleads instead of retrying.
    const onRefresh = vi.fn();
    renderSidebar({ loading: false, customers: [], loadError: true, onRefresh });

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load customers");
    expect(screen.queryByText('No customers yet')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('HAPPY: a genuinely empty tenant (no error) still gets the "No customers yet" copy with an Add customer CTA', () => {
    // WHO: a brand-new tenant with zero customers and no fetch failure.
    // WHAT: the ordinary empty-state copy + CTA must still render — the new
    //       error branch must not swallow the honest empty case.
    // WHEN: loadError=false (default), loading=false, customers=[].
    // WHERE: CustomerSidebar's list region, default empty branch.
    // WHY: guards against the error-vs-empty split accidentally hiding the
    //       real "add your first customer" affordance.
    const onAddCustomer = vi.fn();
    renderSidebar({ loading: false, customers: [], loadError: false, onAddCustomer });

    expect(screen.getByText('No customers yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add customer' }));
    expect(onAddCustomer).toHaveBeenCalledTimes(1);
  });
});
