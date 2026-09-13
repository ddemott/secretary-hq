/**
 * useSkillMapData — connect/disconnect error handling.
 *
 * WHO: an owner dragging a connection between an employee/resource and a
 *   service on the Skill Map graph (or dragging one apart).
 * WHAT: completeLinking() / disconnectConnection() call the same
 *   assign/unassign mapping endpoints ServiceAssignmentView's grid toggles
 *   use, but on failure only logged to console — no toast, nothing on
 *   screen. The grid's own toggle (ServiceAssignmentView.toggleEmployeeMapping
 *   / toggleResourceMapping) already shows 'Mapping update failed' for the
 *   identical failure; the graph silently did nothing instead.
 * WHY: a caller who drags a connection that fails to save sees the line
 *   snap back with zero explanation — indistinguishable from "it worked
 *   but the UI is just slow to refresh."
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    mappings: {
      listServiceEmployee: vi.fn(),
      listServiceResource: vi.fn(),
      assignServiceEmployee: vi.fn(),
      assignServiceResource: vi.fn(),
      unassignServiceEmployee: vi.fn(),
      unassignServiceResource: vi.fn(),
    },
  },
}));
vi.mock('../../lib/api', () => ({ Api: mockApi }));

import { useSkillMapData } from './useSkillMapData';
import { showToast } from '../ui/Toast';

const mockToast = vi.mocked(showToast);

const EMPLOYEES = [{ employee_id: 'e1', name: 'Ann' }];
const RESOURCES = [{ resource_id: 'r1', name: 'Room 1' }];
const SERVICES = [{ service_id: 's1', name: 'Haircut' }];

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.mappings.listServiceEmployee.mockResolvedValue([]);
  mockApi.mappings.listServiceResource.mockResolvedValue([]);
});

describe('useSkillMapData — completeLinking', () => {
  test('SAD: a failed connect shows an error toast, not just a console log', async () => {
    mockApi.mappings.assignServiceEmployee.mockRejectedValue(new Error('network error'));

    const { result } = renderHook(() =>
      useSkillMapData(EMPLOYEES, RESOURCES, SERVICES, 'tenant-1')
    );

    await waitFor(() => expect(mockApi.mappings.listServiceEmployee).toHaveBeenCalled());

    act(() => result.current.startLinking('emp-e1', 'employee'));
    await act(async () => {
      await result.current.completeLinking('skill-s1');
    });

    expect(mockToast).toHaveBeenCalledWith('Mapping update failed', 'error');
  });
});

describe('useSkillMapData — disconnectConnection', () => {
  test('SAD: a failed disconnect shows an error toast, not just a console log', async () => {
    mockApi.mappings.unassignServiceEmployee.mockRejectedValue(new Error('network error'));

    const { result } = renderHook(() =>
      useSkillMapData(EMPLOYEES, RESOURCES, SERVICES, 'tenant-1')
    );

    await waitFor(() => expect(mockApi.mappings.listServiceEmployee).toHaveBeenCalled());

    await act(async () => {
      await result.current.disconnectConnection('emp-e1--skill-s1');
    });

    expect(mockToast).toHaveBeenCalledWith('Mapping update failed', 'error');
  });
});
