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

describe('DeletedRecordsPanel — UX review 2026-09-15 (owner-judgment pass)', () => {
  test('HAPPY: the initial load announces itself with a screen-reader-visible loading label', () => {
    // WHO: a screen-reader user opening this panel.
    // WHAT: the spinner shown while the first fetch is in flight had no
    //       accessible label at all — a sighted user sees a spinner, a
    //       screen-reader user hears nothing until content (or an error)
    //       eventually appears.
    // WHERE: DeletedRecordsPanel's `loading` branch.
    // WHY: silence during a multi-hundred-ms fetch reads as "did my click do
    //      anything," same class of gap the LoadingState primitive elsewhere
    //      in this app already solves with role=status + a visible/sr-only
    //      label.
    renderPanel();
    expect(screen.getByText('Loading deleted records…')).toBeInTheDocument();
  });

  test('HAPPY: a successful restore announces the record by name in a live status region', async () => {
    // WHO: a screen-reader user who just clicked Restore on Ada Lovelace.
    // WHAT: previously the only feedback was the row silently disappearing
    //       from the list — a DOM mutation with no announcement. Now a
    //       polite live region says who was restored.
    // WHERE: handleRestore's success path.
    // WHY: "it worked" needs to be said out loud, not just shown.
    renderPanel();
    await screen.findByText('Ada Lovelace');
    mockGetDeleted.mockResolvedValueOnce({ total: 0, records: [] });

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    expect(await screen.findByText('Ada Lovelace restored.')).toBeInTheDocument();
  });

  test('SAD: a failed restore shows an inline alert without hiding the already-loaded list', async () => {
    // WHO: an owner mid-recovery whose restore attempt hits a transient
    //       backend error.
    // WHAT: the error branch used to be checked BEFORE the records list in
    //       the render ternary, so ANY error — even one from a restore
    //       action on an already-successfully-loaded list — replaced the
    //       entire deleted-records list with just the error text. A failed
    //       restore made it look like the whole panel had also lost its
    //       data, at exactly the moment the owner most needs to see what's
    //       still there to retry.
    // WHERE: the `error && !deleted` vs `error` (inline banner) split.
    // WHY: losing your place in a list you were actively working from is a
    //      correctness bug, not just a cosmetic one.
    renderPanel();
    await screen.findByText('Ada Lovelace');
    mockRestoreDeleted.mockRejectedValueOnce(new Error('network blip'));

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('network blip');
    // The record the owner was looking at is still right there.
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  test('SAD: a failed copy closes the dialog so the error becomes visible instead of hidden behind it', async () => {
    // WHO: an owner copying fields onto another customer whose target record
    //       was deleted out from under them mid-copy.
    // WHAT: the copy-fields dialog is a full-screen overlay ABOVE this
    //       panel, and it has no error slot of its own — so when
    //       handleCopyFields failed, the parent's error text rendered
    //       underneath the still-open dialog and was never seen. The click
    //       looked like it did nothing at all.
    // WHERE: handleCopyFields's catch branch.
    // WHY: a swallowed error is worse than a visible one — the owner has no
    //      idea whether to retry, and no way to find out without a refresh.
    renderPanel();
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: /Copy fields from Ada Lovelace/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'cust-9' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /name/i }));
    mockCopyFields.mockRejectedValueOnce(new Error('duplicate customer record'));

    fireEvent.click(within(dialog).getByRole('button', { name: /^Copy 1 Field$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('alert')).toHaveTextContent('duplicate customer record');
  });

  test('HAPPY: a successful copy announces the field count and target name in the live status region', async () => {
    // WHO: a screen-reader user who just copied one field onto Grace Hopper.
    // WHAT: same silent-success gap as restore — the dialog just closes with
    //       no spoken confirmation of what happened or where it went.
    // WHERE: handleCopyFields's success path.
    // WHY: "copied to whom, how many fields" is exactly what a sighted user
    //      gets to infer from the closing dialog; a screen-reader user needs
    //      it said explicitly.
    renderPanel();
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: /Copy fields from Ada Lovelace/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'cust-9' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /name/i }));
    mockCopyFields.mockResolvedValueOnce({ success: true });

    fireEvent.click(within(dialog).getByRole('button', { name: /^Copy 1 Field$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Copied 1 field to Grace Hopper.')).toBeInTheDocument();
  });

  test('SAD: switching table/tenant clears a stale restore announcement from the previous view', async () => {
    // WHO: a screen-reader user who restores a record, then switches the
    //      table or tenant selector without closing the panel.
    // WHAT: `statusMessage` lived in this component's own state and was only
    //       ever cleared at the START of a new restore/copy action — never
    //       when `table`/`tenantId` changed. Switching views left the live
    //       region holding "Ada Lovelace restored." from the PREVIOUS view,
    //       so it never re-announces (React only speaks a live region on
    //       CHANGE) and, worse, if the new view's own action later sets the
    //       exact same string it would silently not re-announce either.
    // WHERE: the `[table, tenantId]` load effect.
    // WHY: a live region is trusted to say what's true NOW; carrying stale
    //      state across an unrelated navigation makes it lie by omission.
    const { rerender } = renderPanel();
    await screen.findByText('Ada Lovelace');
    mockGetDeleted.mockResolvedValueOnce({ total: 0, records: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Ada Lovelace restored.')).toBeInTheDocument();

    mockGetDeleted.mockResolvedValueOnce({ total: 0, records: [] });
    rerender(<DeletedRecordsPanel table="appointments" tenantId="t-1" />);

    await waitFor(() =>
      expect(screen.queryByText('Ada Lovelace restored.')).not.toBeInTheDocument()
    );
  });
});
