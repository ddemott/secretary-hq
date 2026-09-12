/**
 * ResourceManagerView — UX-review pass for the un-audited surface.
 *
 * Pins the code-doable fixes: add-form inputs expose accessible names (were
 * placeholder-only); the edit modal's service toggles expose aria-pressed; and an
 * update failure now surfaces a toast instead of a page-level error banner that
 * renders BEHIND the open modal (so the owner saw nothing).
 *
 * 5W for failures: WHO an owner editing a resource/bay; WHAT the add form + edit
 * modal; WHERE ResourceManagerView; WHY a save error hidden behind the modal reads
 * as a silent no-op, and unlabeled inputs lock out screen-reader users.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('../../lib/SessionContext', () => ({
  useActiveTenantId: () => 'tenant-123',
}));

vi.mock('@/lib/VocabularyContext', () => ({
  useVocabulary: () => ({ resource_plural: 'Bays', resource_label: 'Bay' }),
}));

const { staticRef } = vi.hoisted(() => ({
  staticRef: {
    current: {
      resources: [] as unknown[],
      services: [] as unknown[],
      loading: false,
      refresh: vi.fn(),
    },
  },
}));
vi.mock('../../lib/hooks', () => ({ useStaticData: () => staticRef.current }));

const mockToast = vi.fn();
vi.mock('../ui/Toast', () => ({ showToast: (...a: unknown[]) => mockToast(...a) }));

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    resources: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    mappings: {
      listServiceResource: vi.fn(),
      assignServiceResource: vi.fn(),
      unassignServiceResource: vi.fn(),
    },
  },
}));
vi.mock('../../lib/api', () => ({ Api: mockApi }));

import ResourceManagerView from './ResourceManagerView';

beforeEach(() => {
  vi.clearAllMocks();
  staticRef.current = { resources: [], services: [], loading: false, refresh: vi.fn() };
  mockApi.mappings.listServiceResource.mockResolvedValue([]);
});

describe('ResourceManagerView', () => {
  test('add-resource form inputs expose accessible names', async () => {
    render(<ResourceManagerView />);
    expect(await screen.findByLabelText(/New bay name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/New bay description/i)).toBeInTheDocument();
  });

  test('edit modal: an update failure surfaces a toast (not the modal-hidden error banner)', async () => {
    staticRef.current = {
      resources: [{ resource_id: 'r1', name: 'Bay 1', is_active: true }],
      services: [{ service_id: 's1', name: 'Oil Change' }],
      loading: false,
      refresh: vi.fn(),
    };
    mockApi.resources.update.mockResolvedValue({ success: false, error: 'Name already taken' });

    render(<ResourceManagerView />);
    fireEvent.click(await screen.findByText('Bay 1'));

    // Service toggle inside the modal exposes aria-pressed.
    const toggle = await screen.findByRole('button', { name: /Add Oil Change/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: /Save Changes|Save/i }));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('already taken'), 'error')
    );
  });
});
