/**
 * useStaticData — customers opt-out coverage.
 *
 * Origin: audit finding 2026-09-16. `useStaticData()` always called
 * `Api.customers.list(tenantId)` alongside resources/employees/services/
 * skills, even for screens (EmployeeManagementView, ShiftManagementView,
 * ResourceManagerView) that never render customer data. Combined with the
 * super-admin sentinel tenant's previously-unscoped `GET /customers`
 * response, opening Setup → Staff/Shifts/Resources as a super-admin with no
 * managed tenant selected fired a cross-tenant customer PII fetch as a pure
 * side effect.
 *
 * `useStaticData(tenantId, { customers: false })` must skip the customers
 * fetch entirely; the default (no options, or `{ customers: true }`) must
 * keep fetching it exactly as before.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    customers: { list: vi.fn() },
    resources: { list: vi.fn() },
    employees: { list: vi.fn() },
    services: { list: vi.fn() },
    skills: { list: vi.fn() },
  },
}));

vi.mock('./api', () => ({ Api: mockApi }));
vi.mock('@/lib/SessionContext', () => ({
  useActiveTenantId: () => 'tenant-under-test',
}));

import { useStaticData } from './hooks';

beforeEach(() => {
  mockApi.customers.list.mockReset().mockResolvedValue([{ customer_id: 'c-1' }]);
  mockApi.resources.list.mockReset().mockResolvedValue([]);
  mockApi.employees.list.mockReset().mockResolvedValue([]);
  mockApi.services.list.mockReset().mockResolvedValue([]);
  mockApi.skills.list.mockReset().mockResolvedValue([]);
});

describe('useStaticData — customers opt-out', () => {
  test('HAPPY: default behavior still fetches customers', async () => {
    const { result } = renderHook(() => useStaticData('tenant-a'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockApi.customers.list).toHaveBeenCalledWith('tenant-a');
    expect(result.current.customers).toEqual([{ customer_id: 'c-1' }]);
  });

  test('HAPPY: { customers: false } skips the customers fetch entirely', async () => {
    // WHO: EmployeeManagementView / ShiftManagementView / ResourceManagerView
    // WHAT: Api.customers.list must never be called — not "called and its
    //       result discarded", but never invoked, so a super-admin with no
    //       managed tenant selected never triggers the cross-tenant fetch
    //       as a side effect of loading staff/shift/resource state
    const { result } = renderHook(() => useStaticData('tenant-a', { customers: false }));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockApi.customers.list).not.toHaveBeenCalled();
    expect(result.current.customers).toEqual([]);
    // The other four fetches still run normally.
    expect(mockApi.resources.list).toHaveBeenCalledWith('tenant-a');
    expect(mockApi.employees.list).toHaveBeenCalledWith('tenant-a');
    expect(mockApi.services.list).toHaveBeenCalledWith('tenant-a');
    expect(mockApi.skills.list).toHaveBeenCalledWith('tenant-a');
  });
});
