/**
 * ServiceAssignmentView — UX-review pass for the un-audited surface.
 *
 * Pins the code-doable fixes: create/update failures now surface a toast (they
 * set actionError, whose banner renders on the page BEHIND the open wizard/edit
 * modal — invisible); the wizard Description textarea is label-associated; and
 * the resource/employee mapping toggles expose aria-pressed.
 *
 * 5W for failures: WHO an owner defining a service; WHAT the create wizard + edit
 * modal + mapping toggles; WHERE ServiceAssignmentView; WHY a save error hidden
 * behind the modal reads as a silent no-op, and unlabeled/undescribed toggles
 * lock out screen-reader users.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('../../lib/SessionContext', () => ({ useActiveTenantId: () => 'tenant-123' }));
vi.mock('@/lib/VocabularyContext', () => ({
  useVocabulary: () => ({
    resource_plural: 'Bays',
    resource_label: 'Bay',
    employee_plural: 'Technicians',
    employee_label: 'Technician',
  }),
}));

const { staticRef } = vi.hoisted(() => ({
  staticRef: {
    current: {
      services: [] as unknown[],
      resources: [] as unknown[],
      employees: [] as unknown[],
      loading: false,
      error: null as string | null,
      refresh: vi.fn(),
    },
  },
}));
vi.mock('../../lib/hooks', () => ({ useStaticData: () => staticRef.current }));

const mockToast = vi.fn();
vi.mock('../ui/Toast', () => ({ showToast: (...a: unknown[]) => mockToast(...a) }));

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    services: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    mappings: {
      listServiceResource: vi.fn(),
      listServiceEmployee: vi.fn(),
      assignServiceResource: vi.fn(),
      unassignServiceResource: vi.fn(),
      assignServiceEmployee: vi.fn(),
      unassignServiceEmployee: vi.fn(),
    },
    tenants: { getConfig: vi.fn(), updateConfig: vi.fn() },
  },
}));
vi.mock('../../lib/api', () => ({ Api: mockApi }));

import ServiceAssignmentView from './ServiceAssignmentView';

beforeEach(() => {
  vi.clearAllMocks();
  staticRef.current = {
    services: [
      {
        service_id: 'svc1',
        name: 'Oil Change',
        description: 'Standard',
        duration_minutes: 30,
        price: 40,
      },
    ],
    resources: [{ resource_id: 'r1', name: 'Bay 1' }],
    employees: [{ employee_id: 'e1', name: 'Ada Tech', type: 'employee' }],
    loading: false,
    error: null,
    refresh: vi.fn(),
  };
  mockApi.mappings.listServiceResource.mockResolvedValue([]);
  mockApi.mappings.listServiceEmployee.mockResolvedValue([]);
  mockApi.tenants.getConfig.mockResolvedValue({ default_service_id: null });
});

describe('ServiceAssignmentView', () => {
  test('the create wizard Description textarea is reachable by its label', async () => {
    render(<ServiceAssignmentView />);
    fireEvent.click((await screen.findAllByRole('button', { name: /New Service Wizard/i }))[0]);
    expect(await screen.findByLabelText('Description')).toBeInTheDocument();
  });

  test('edit modal: mapping toggles expose aria-pressed and an update failure toasts', async () => {
    mockApi.services.update.mockResolvedValue({ success: false, error: 'Name already in use' });
    render(<ServiceAssignmentView />);

    fireEvent.click(await screen.findByText('Oil Change'));

    // Resource + employee mapping toggles convey their state to assistive tech.
    expect(await screen.findByRole('button', { name: /Add Bay 1/i })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: /Add Ada Tech/i })).toHaveAttribute(
      'aria-pressed',
      'false'
    );

    fireEvent.click(screen.getByRole('button', { name: /Save Changes|Save/i }));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('already in use'), 'error')
    );
  });
});
