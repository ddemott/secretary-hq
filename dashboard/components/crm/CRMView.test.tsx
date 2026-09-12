/**
 * CRMView tests — focused on the "mock demo data must not leak into a REAL
 * tenant" contract (UX review, 2026-07-03).
 *
 * Before this fix, any backend error on the customer/history fetch dropped the
 * hardcoded MOCK_CUSTOMERS ("Bob Smith" / "Alice Johnson") + MOCK_SUMMARIES into
 * a logged-in tenant's view — fabricated people shown as if real, masking the
 * failure. The mock fallback is now gated on `!tenantId` (the intended demo
 * path); a real tenant gets an empty list + an error toast.
 *
 * Each test carries 5W diagnostic context.
 */
import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mutable tenant id so a single mock can flip between real-tenant and demo.
let mockTenantId: string | null = 'tenant-real-123';
vi.mock('../../lib/SessionContext', () => ({
  useActiveTenantId: () => mockTenantId,
  // CRMView reads role/isAdmin to gate the CSV export/import buttons; a plain
  // owner keeps the default view intact for the fetch-path tests below.
  useSessionContext: () => ({ role: 'owner', isAdmin: false }),
}));

const mockListCustomers = vi.fn();
const mockListSummaries = vi.fn();
const mockCustomerAppointments = vi.fn();
vi.mock('../../lib/api', () => ({
  Api: {
    customers: {
      list: (...a: unknown[]) => mockListCustomers(...a),
      appointments: (...a: unknown[]) => mockCustomerAppointments(...a),
      create: vi.fn(),
      update: vi.fn(),
    },
    callSummaries: { list: (...a: unknown[]) => mockListSummaries(...a) },
    appointments: { cancel: vi.fn() },
  },
}));

const mockToast = vi.fn();
vi.mock('../ui/Toast', () => ({ showToast: (...a: unknown[]) => mockToast(...a) }));

// Confirm dialog is irrelevant to the fetch paths under test.
vi.mock('../../lib/useConfirm', () => ({
  useConfirm: () => ({ state: { isOpen: false }, confirm: vi.fn(), close: vi.fn() }),
}));
vi.mock('../ui/ConfirmModal', () => ({ ConfirmModal: () => null }));

// Stub the detail pane so the test only exercises CRMView's own list + fetch
// logic (the pane has its own dedicated tests).
vi.mock('./CustomerDetailPanel', () => ({
  CustomerDetailPanel: ({ selectedCustomer }: { selectedCustomer: { name?: string } | null }) => (
    <div data-testid="detail">{selectedCustomer?.name ?? 'none'}</div>
  ),
}));

import CRMView from './CRMView';

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantId = 'tenant-real-123';
  mockListCustomers.mockResolvedValue([]);
  mockListSummaries.mockResolvedValue([]);
  mockCustomerAppointments.mockResolvedValue([]);
});

describe('CRMView — no mock-data leak into a real tenant', () => {
  test('SAD: a customer-fetch error for a REAL tenant shows no fabricated customers + an error toast', async () => {
    // WHO: a logged-in owner whose /customers request hits a 500/network blip.
    // WHAT: the catch must NOT fall back to MOCK_CUSTOMERS — "Bob Smith" is a
    //        fictional demo person; showing it masks the failure and misleads.
    // WHEN: Api.customers.list rejects while tenantId is set.
    // WHERE: fetchCustomers catch, gated on !tenantId.
    // WHY: fabricated people rendered as real is a trust-destroying data bug.
    mockListCustomers.mockRejectedValue(new Error('500'));
    render(<CRMView />);

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('Could not load customers. Please try again.', 'error')
    );
    expect(screen.queryByText('Bob Smith')).not.toBeInTheDocument();
    expect(screen.queryByText('Alice Johnson')).not.toBeInTheDocument();
  });

  test('SAD: an empty customer list for a real tenant stays empty (no mock backfill)', async () => {
    // WHO: a real tenant with no customers yet. WHAT: an empty (not errored)
    //        response must NOT be backfilled with MOCK_CUSTOMERS. WHEN: list
    //        resolves []. WHERE: fetchCustomers success branch, !tenantId gate.
    // WHY: the pre-fix success path also injected mocks when a real tenant
    //        legitimately had zero customers.
    mockListCustomers.mockResolvedValue([]);
    render(<CRMView />);

    // Let the effect + fetch settle.
    await waitFor(() => expect(mockListCustomers).toHaveBeenCalled());
    expect(screen.queryByText('Bob Smith')).not.toBeInTheDocument();
    expect(screen.queryByText('Alice Johnson')).not.toBeInTheDocument();
  });
});

describe('CRMView — subdirectory pin', () => {
  test('page.tsx imports CRMView from components/crm/', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const page = fs.readFileSync(
      path.join(__dirname, '..', '..', 'app', 'dashboard', 'page.tsx'),
      'utf-8'
    );
    expect(page).toContain("import('@/components/crm/CRMView')");
    expect(page).not.toContain("import('@/components/CRMView')");
  });

  test('BusinessSettingsView.test mocks CRMIntegrationCard at components/crm/', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const settingsTest = fs.readFileSync(
      path.join(__dirname, '..', 'business', 'BusinessSettingsView.test.tsx'),
      'utf-8'
    );
    expect(settingsTest).toContain("vi.mock('../crm/CRMIntegrationCard'");
    expect(settingsTest).not.toContain("vi.mock('./CRMIntegrationCard'");
  });
});
