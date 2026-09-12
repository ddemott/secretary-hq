/**
 * AuditLogView tests — the owner-only change-history table (GET /audit-log).
 * Pins that it renders entries with action badges, surfaces the empty + error
 * states, and passes the table_name filter + pagination through to the Api.
 *
 * Each test carries 5W diagnostic context.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('../../lib/SessionContext', () => ({
  useActiveTenantId: () => 'tenant-123',
}));

const { mockApi, mockToast } = vi.hoisted(() => ({
  mockApi: { auditLog: { list: vi.fn() } },
  mockToast: vi.fn(),
}));

vi.mock('../../lib/api', () => ({ Api: mockApi }));
vi.mock('../ui/Toast', () => ({ showToast: mockToast }));

import AuditLogView from './AuditLogView';

const ENTRY = {
  audit_log_id: 'log-1',
  tenant_id: 'tenant-123',
  table_name: 'appointments',
  record_id: 'apt-9',
  action: 'UPDATE',
  old_data: { status: 'scheduled' },
  new_data: { status: 'completed' },
  changed_by: 'tenant-123',
  created_at: '2026-06-20T10:00:00Z',
};

beforeEach(() => {
  mockApi.auditLog.list.mockReset();
  mockToast.mockReset();
});

describe('AuditLogView', () => {
  test('HAPPY: renders audit entries with an action badge', async () => {
    // WHO: an owner opening the Audit Log sub-tab.
    // WHAT: the change-history table lists each recorded INSERT/UPDATE/DELETE.
    // WHEN: the API returns one UPDATE on appointments.
    // WHERE: the table body + the action Badge.
    // WHY: owners need a readable change history for compliance/debugging.
    mockApi.auditLog.list.mockResolvedValue({
      success: true,
      entries: [ENTRY],
      count: 1,
      limit: 50,
      offset: 0,
    });

    render(<AuditLogView />);

    expect(await screen.findByText('appointments')).toBeInTheDocument();
    expect(screen.getByText('UPDATE')).toBeInTheDocument();
    expect(screen.getByText('apt-9')).toBeInTheDocument();
  });

  test('HAPPY: empty result shows the empty state', async () => {
    // WHAT: zero entries → a friendly "no changes recorded" message, not a blank table.
    mockApi.auditLog.list.mockResolvedValue({
      success: true,
      entries: [],
      count: 0,
      limit: 50,
      offset: 0,
    });

    render(<AuditLogView />);

    expect(await screen.findByText(/No changes recorded yet/i)).toBeInTheDocument();
  });

  test('SAD: an API rejection shows an error state + toasts', async () => {
    // WHO: an owner whose request failed (network / 500).
    // WHAT: the view shows an error panel instead of hanging on the spinner.
    mockApi.auditLog.list.mockRejectedValue(new Error('boom'));

    render(<AuditLogView />);

    expect(await screen.findByText(/Couldn't load the audit log/i)).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('Failed to load audit log', 'error');
  });

  test('HAPPY: changing the table filter re-queries with table_name', async () => {
    // WHY: the filter must reach the backend (validated server-side), not just
    //       filter client-side — so the query carries table_name.
    mockApi.auditLog.list.mockResolvedValue({
      success: true,
      entries: [ENTRY],
      count: 1,
      limit: 50,
      offset: 0,
    });

    render(<AuditLogView />);
    await screen.findByText('appointments');

    fireEvent.change(screen.getByLabelText('Filter by table'), {
      target: { value: 'customers' },
    });

    // The most recent call carries the chosen table_name + a reset offset.
    expect(mockApi.auditLog.list).toHaveBeenLastCalledWith(
      'tenant-123',
      expect.objectContaining({ limit: 50, offset: 0, table_name: 'customers' })
    );
  });

  test('HAPPY: setting a date range re-queries with start_date/end_date', async () => {
    // WHY: the date range must reach the backend (validated there), so an owner
    //       can scope the change history to a window.
    mockApi.auditLog.list.mockResolvedValue({
      success: true,
      entries: [ENTRY],
      count: 1,
      limit: 50,
      offset: 0,
    });

    render(<AuditLogView />);
    await screen.findByText('appointments');

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-06-30' } });

    expect(mockApi.auditLog.list).toHaveBeenLastCalledWith(
      'tenant-123',
      expect.objectContaining({ start_date: '2026-06-01', end_date: '2026-06-30' })
    );
  });

  test('HAPPY: clicking a row opens a drill-down showing the old→new field diff', async () => {
    // WHO: an owner asking "what exactly changed on this booking?"
    // WHAT: clicking a row opens a modal listing each changed field with its
    //        before + after value.
    // WHY: the table alone shows that something changed, not what — the diff
    //        is the actionable detail.
    mockApi.auditLog.list.mockResolvedValue({
      success: true,
      entries: [{ ...ENTRY, old_data: { status: 'scheduled' }, new_data: { status: 'completed' } }],
      count: 1,
      limit: 50,
      offset: 0,
    });

    render(<AuditLogView />);
    fireEvent.click(await screen.findByText('appointments'));

    expect(await screen.findByText(/UPDATE on appointments/i)).toBeInTheDocument();
    expect(screen.getByText('status')).toBeInTheDocument();
    expect(screen.getByText('scheduled')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
  });
});

describe('AuditLogView — subdirectory pin', () => {
  test('SetupView imports AuditLogView from components/records/', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const setup = fs.readFileSync(path.join(__dirname, '..', 'business', 'SetupView.tsx'), 'utf-8');
    expect(setup).toContain("import AuditLogView from '../records/AuditLogView'");
    expect(setup).not.toContain("import AuditLogView from './AuditLogView'");
  });
});
