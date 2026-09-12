/**
 * DeletedRecordsPanel — a11y-focused tests for the un-audited-surface UX pass.
 *
 * The panel had icon-only controls with no accessible names, a placeholder-only
 * search input, and a copy dialog with no dialog semantics / Escape handling.
 * These tests pin the fixes so a screen-reader user can operate the panel and a
 * keyboard user can dismiss the copy dialog.
 *
 * 5W for failures: WHO a screen-reader/keyboard owner reviewing deleted records;
 * WHAT the panel's icon buttons + search + copy dialog; WHERE DeletedRecordsPanel;
 * WHY inaccessible controls lock these users out of restore/history/copy.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

const mockGetDeleted = vi.fn();
const mockRestoreDeleted = vi.fn();
const mockCopyFields = vi.fn();
const mockCustomersList = vi.fn();

vi.mock('../../lib/api', () => ({
  Api: {
    versionHistory: {
      getDeleted: (...a: unknown[]) => mockGetDeleted(...a),
      restoreDeleted: (...a: unknown[]) => mockRestoreDeleted(...a),
      copyFields: (...a: unknown[]) => mockCopyFields(...a),
    },
    customers: { list: (...a: unknown[]) => mockCustomersList(...a) },
  },
}));

import { DeletedRecordsPanel } from './DeletedRecordsPanel';

const oneRecord = {
  total: 1,
  records: [
    {
      record_id: 'rec-1',
      table_name: 'customers',
      name: 'Ada Lovelace',
      phone: '+15551230000',
      email: 'ada@example.com',
      deleted_at: '2026-07-01T10:00:00Z',
      deleted_by: 'owner@shop.test',
      last_data: { name: 'Ada Lovelace', phone: '+15551230000' },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDeleted.mockResolvedValue(oneRecord);
  mockCustomersList.mockResolvedValue([
    { customer_id: 'cust-9', name: 'Grace Hopper', phone: '+15559990000' },
  ]);
});

function renderPanel() {
  return render(<DeletedRecordsPanel table="customers" tenantId="t-1" />);
}

describe('DeletedRecordsPanel a11y', () => {
  test('search input and per-record icon buttons expose accessible names', async () => {
    renderPanel();
    await screen.findByText('Ada Lovelace');

    expect(screen.getByLabelText('Search deleted records')).toBeInTheDocument();
    // Icon-only actions are now reachable by an accessible name.
    expect(
      screen.getByRole('button', { name: /View history for Ada Lovelace/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Copy fields from Ada Lovelace/i })
    ).toBeInTheDocument();
  });

  test('expand toggle reports aria-expanded state', async () => {
    renderPanel();
    await screen.findByText('Ada Lovelace');
    const toggle = screen.getByRole('button', { name: /Show last known data for Ada Lovelace/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(
      screen.getByRole('button', { name: /Hide last known data for Ada Lovelace/i })
    ).toHaveAttribute('aria-expanded', 'true');
  });

  test('copy dialog has dialog semantics and closes on Escape', async () => {
    renderPanel();
    await screen.findByText('Ada Lovelace');

    fireEvent.click(screen.getByRole('button', { name: /Copy fields from Ada Lovelace/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByLabelText('Close copy fields dialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
