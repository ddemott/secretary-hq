import { describe, test, expect, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import EmployeeManagementView from './EmployeeManagementView';

// Mock fetch
global.fetch = vi.fn();

describe('EmployeeManagementView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('tenantId', 'f234e471-0e60-4163-86c9-93cfd9338e3a');
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [],
    });
  });

  test('renders employee form and list', async () => {
    render(<EmployeeManagementView />);
    expect(await screen.findByRole('heading', { name: /Employees/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/First name/i)).toBeInTheDocument();
    // WHO: tenant user | WHAT: view employee management page | WHEN: navigating to employees | WHERE: EmployeeManagementView | WHY: manage staff roster and add new employees
  });
});

describe('EmployeeManagementView - Sad Paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('tenantId', 'f234e471-0e60-4163-86c9-93cfd9338e3a');
  });

  test('renders without crashing when API fetch fails', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error')
    );
    render(<EmployeeManagementView />);
    // Component should still render its heading even if the data fetch fails
    expect(await screen.findByRole('heading', { name: /Employees/i })).toBeInTheDocument();
    // WHO: tenant user | WHAT: view employee page when API is down | WHEN: network failure during load | WHERE: EmployeeManagementView | WHY: page must not crash so user can retry or navigate away
  });

  test('shows empty state when employee list is empty', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    render(<EmployeeManagementView />);
    expect(await screen.findByRole('heading', { name: /Employees/i })).toBeInTheDocument();
    // The add-employee form should still be visible even with no employees
    expect(screen.getByPlaceholderText(/First name/i)).toBeInTheDocument();
    // WHO: tenant user | WHAT: view employee page with no staff | WHEN: new tenant with zero employees | WHERE: EmployeeManagementView | WHY: user can still add first employee via the form
  });
});

import ServiceAssignmentView from '../services/ServiceAssignmentView';

// Mock SessionContext for useActiveTenantId
vi.mock('@/lib/SessionContext', () => ({
  useSessionContext: () => ({
    tenantId: 'f234e471-0e60-4163-86c9-93cfd9338e3a',
    userName: 'Test User',
    isAdmin: false,
    managedTenantId: 'f234e471-0e60-4163-86c9-93cfd9338e3a',
    managedTenantName: 'DynaTire',
    loading: false,
    login: vi.fn(),
    logout: vi.fn(),
    selectManagedTenant: vi.fn(),
    tenantsVersion: 0,
    notifyTenantsChanged: vi.fn(),
  }),
  useActiveTenantId: () => 'f234e471-0e60-4163-86c9-93cfd9338e3a',
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe('ServiceAssignmentView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('tenantId', 'f234e471-0e60-4163-86c9-93cfd9338e3a');
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [],
    });
  });

  test('renders service assignment UI', async () => {
    render(<ServiceAssignmentView />);
    expect(await screen.findByText(/Service Catalog/i)).toBeInTheDocument();
    // WHO: tenant user | WHAT: view service catalog page | WHEN: navigating to services | WHERE: ServiceAssignmentView | WHY: manage service offerings and assign employees to services
  });
});

describe('ServiceAssignmentView - Sad Paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('tenantId', 'f234e471-0e60-4163-86c9-93cfd9338e3a');
  });

  test('renders without crashing when API fetch fails', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error')
    );
    render(<ServiceAssignmentView />);
    // Component should still render its heading even if the data fetch fails
    expect(await screen.findByText(/Service Catalog/i)).toBeInTheDocument();
    // WHO: tenant user | WHAT: view service catalog when API is down | WHEN: network failure during load | WHERE: ServiceAssignmentView | WHY: page must not crash so user can retry or navigate away
  });

  test('shows empty state when service list is empty', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    render(<ServiceAssignmentView />);
    expect(await screen.findByText(/Service Catalog/i)).toBeInTheDocument();
    // WHO: tenant user | WHAT: view service catalog with no services | WHEN: new tenant with zero services | WHERE: ServiceAssignmentView | WHY: user sees the page structure and can add first service
  });
});
