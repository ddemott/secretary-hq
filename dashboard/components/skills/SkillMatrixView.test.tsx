/**
 * SkillMatrixView — UX-review a11y pass for the un-audited surface.
 *
 * The matrix was unusable with a screen reader: every cell was an icon-only
 * Check/X button with no accessible name, the filter tabs conveyed their active
 * state only via color, and the search box was placeholder-only. This pins the
 * fixes: each cell announces "Add/Remove <service> for <entity>" + aria-pressed,
 * the filter tabs expose aria-pressed, and the search input has a label.
 *
 * 5W for failures: WHO a screen-reader owner mapping staff→services; WHAT the
 * matrix cells + filter tabs + search; WHERE SkillMatrixView; WHY an unlabeled
 * grid of Check/X buttons is meaningless to assistive tech.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('../../lib/SessionContext', () => ({ useActiveTenantId: () => 'tenant-123' }));
vi.mock('@/lib/VocabularyContext', () => ({
  useVocabulary: () => ({
    employee_plural: 'Technicians',
    employee_label: 'Technician',
    resource_plural: 'Bays',
    resource_label: 'Bay',
  }),
}));

const { staticRef } = vi.hoisted(() => ({
  staticRef: {
    current: {
      employees: [] as unknown[],
      resources: [] as unknown[],
      services: [] as unknown[],
      loading: false,
    },
  },
}));
vi.mock('../../lib/hooks', () => ({ useStaticData: () => staticRef.current }));
vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    mappings: {
      listServiceEmployee: vi.fn(),
      listServiceResource: vi.fn(),
      assignServiceEmployee: vi.fn(),
      unassignServiceEmployee: vi.fn(),
      assignServiceResource: vi.fn(),
      unassignServiceResource: vi.fn(),
    },
  },
}));
vi.mock('../../lib/api', () => ({ Api: mockApi }));

import SkillMatrixView from './SkillMatrixView';

beforeEach(() => {
  vi.clearAllMocks();
  staticRef.current = {
    employees: [{ employee_id: 'e1', name: 'Ada Tech', type: 'employee' }],
    resources: [],
    services: [{ service_id: 's1', name: 'Oil Change' }],
    loading: false,
  };
  mockApi.mappings.listServiceEmployee.mockResolvedValue([]);
  mockApi.mappings.listServiceResource.mockResolvedValue([]);
});

describe('SkillMatrixView a11y', () => {
  test('each matrix cell has an accessible name and aria-pressed', async () => {
    render(<SkillMatrixView />);
    const cell = await screen.findByRole('button', { name: /Add Oil Change for Ada Tech/i });
    expect(cell).toHaveAttribute('aria-pressed', 'false');
  });

  test('filter tabs expose aria-pressed and the search input is labelled', async () => {
    render(<SkillMatrixView />);
    expect(await screen.findByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'People' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText(/Search technicians or bays/i)).toBeInTheDocument();
  });
});
