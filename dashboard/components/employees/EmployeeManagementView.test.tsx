/**
 * EmployeeManagementView — UX-review pass for the un-audited surface.
 *
 * Pins the code-doable fixes: the add-employee form inputs now expose accessible
 * names (were placeholder-only), and create/update failures are surfaced via a
 * toast instead of being silently swallowed — critical now that /employees/create
 * returns a 409 on a duplicate name (apiMutate returns { success:false }, it does
 * not throw, so the old `if (res.success)` with no else showed the owner nothing).
 *
 * 5W for failures: WHO an owner adding/editing staff; WHAT the add form + service
 * toggles; WHERE EmployeeManagementView; WHY a swallowed 409 looks like the app
 * did nothing, and unlabeled inputs lock out screen-reader users.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('../../lib/SessionContext', () => ({
  useActiveTenantId: () => 'tenant-123',
}));

vi.mock('@/lib/VocabularyContext', () => ({
  useVocabulary: () => ({
    employee_plural: 'Technicians',
    employee_label: 'Technician',
  }),
}));

const { staticRef } = vi.hoisted(() => ({
  staticRef: {
    current: {
      employees: [] as unknown[],
      services: [] as unknown[],
      loading: false,
      error: null as string | null,
      refresh: vi.fn(),
    },
  },
}));
vi.mock('../../lib/hooks', () => ({
  useStaticData: () => staticRef.current,
}));

const mockToast = vi.fn();
vi.mock('../ui/Toast', () => ({ showToast: (...a: unknown[]) => mockToast(...a) }));

vi.mock('../../lib/phone', () => ({ formatPhone: (p: string) => p || '' }));

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    employees: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    mappings: {
      listServiceEmployee: vi.fn(),
      assignServiceEmployee: vi.fn(),
      unassignServiceEmployee: vi.fn(),
    },
  },
}));
vi.mock('../../lib/api', () => ({ Api: mockApi }));

import EmployeeManagementView from './EmployeeManagementView';

beforeEach(() => {
  vi.clearAllMocks();
  staticRef.current = {
    employees: [],
    services: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  };
  mockApi.mappings.listServiceEmployee.mockResolvedValue([]);
});

describe('EmployeeManagementView', () => {
  test('add-employee form inputs expose accessible names', async () => {
    render(<EmployeeManagementView />);
    expect(await screen.findByLabelText(/New technician first name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/New technician last name/i)).toBeInTheDocument();
  });

  test('a failed create (e.g. duplicate-name 409) surfaces the backend error as a toast', async () => {
    mockApi.employees.create.mockResolvedValue({
      success: false,
      error: 'An active employee named "Dale D." already exists for this business.',
    });
    render(<EmployeeManagementView />);

    fireEvent.change(await screen.findByLabelText(/first name/i), { target: { value: 'Dale' } });
    fireEvent.change(screen.getByLabelText(/last name/i), { target: { value: 'D.' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Technician/i }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('already exists'), 'error')
    );
  });

  test('service toggles in the edit modal expose aria-pressed', async () => {
    staticRef.current = {
      employees: [{ employee_id: 'e1', name: 'Ada Tech', is_active: true, type: 'employee' }],
      services: [{ service_id: 's1', name: 'Oil Change' }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    render(<EmployeeManagementView />);

    fireEvent.click(await screen.findByText('Ada Tech'));
    const toggle = await screen.findByRole('button', { name: /Add Oil Change/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });
});
