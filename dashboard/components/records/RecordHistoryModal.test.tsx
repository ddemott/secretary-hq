/**
 * RecordHistoryModal — a11y-focused tests for the un-audited-surface UX pass.
 *
 * The modal lacked dialog semantics (role/aria-modal/labelledby), an accessible
 * name on its close button, Escape-to-close, and aria-expanded on the per-version
 * toggles. These tests pin the fixes.
 *
 * 5W for failures: WHO a screen-reader/keyboard owner reviewing version history;
 * WHAT the modal shell + close button + version toggles; WHERE RecordHistoryModal;
 * WHY a non-dialog overlay with no Escape traps keyboard users.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

const mockGetHistory = vi.fn();
const mockRestoreDeleted = vi.fn();
const mockGetRestorePreview = vi.fn();
const mockRestoreFields = vi.fn();

vi.mock('../../lib/api', () => ({
  Api: {
    versionHistory: {
      getHistory: (...a: unknown[]) => mockGetHistory(...a),
      restoreDeleted: (...a: unknown[]) => mockRestoreDeleted(...a),
      getRestorePreview: (...a: unknown[]) => mockGetRestorePreview(...a),
      restoreFields: (...a: unknown[]) => mockRestoreFields(...a),
    },
  },
}));

import { RecordHistoryModal } from './RecordHistoryModal';

const history = {
  current_version: 2,
  is_deleted: false,
  versions: [
    {
      record_version_id: 'v2',
      version_number: 2,
      change_type: 'update',
      change_source: 'local',
      changed_at: '2026-07-02T10:00:00Z',
      changed_by: 'owner@shop.test',
      data: { name: 'Ada L.' },
      changed_fields: ['name'],
    },
    {
      record_version_id: 'v1',
      version_number: 1,
      change_type: 'create',
      change_source: 'local',
      changed_at: '2026-07-01T10:00:00Z',
      changed_by: 'owner@shop.test',
      data: { name: 'Ada' },
    },
  ],
};

const deletedHistory = {
  current_version: 1,
  is_deleted: true,
  deleted_at: '2026-07-05T10:00:00Z',
  deleted_by: 'owner@shop.test',
  versions: [
    {
      record_version_id: 'v1',
      version_number: 1,
      change_type: 'delete',
      change_source: 'local',
      changed_at: '2026-07-05T10:00:00Z',
      changed_by: 'owner@shop.test',
      data: { name: 'Ada Lovelace' },
    },
  ],
};

const restorePreview = {
  fields: [
    {
      field: 'name',
      current_value: 'Ada L.',
      versions: [
        {
          version_number: 2,
          value: 'Ada L.',
          change_source: 'local',
          changed_at: '2026-07-02T10:00:00Z',
        },
        {
          version_number: 1,
          value: 'Ada',
          change_source: 'local',
          changed_at: '2026-07-01T10:00:00Z',
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetHistory.mockResolvedValue(history);
});

function renderModal(onClose = vi.fn()) {
  render(
    <RecordHistoryModal
      isOpen
      onClose={onClose}
      table="customers"
      recordId="rec-1"
      recordName="Ada Lovelace"
      tenantId="t-1"
    />
  );
  return { onClose };
}

describe('RecordHistoryModal a11y', () => {
  test('renders as a labelled dialog with an accessible close button', async () => {
    renderModal();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // Labelled by the visible title.
    expect(dialog).toHaveAccessibleName('Version History');
    expect(screen.getByLabelText('Close version history')).toBeInTheDocument();
  });

  test('Escape closes the modal', async () => {
    const { onClose } = renderModal();
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  test('version toggle exposes aria-expanded', async () => {
    renderModal();
    await screen.findByRole('dialog');
    const toggle = await screen.findByRole('button', { name: /Show details for version 2/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /Hide details for version 2/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });
});

describe('RecordHistoryModal — UX review 2026-09-15 (owner-judgment pass)', () => {
  test('HAPPY: restoring a deleted record shows a busy state and announces success', async () => {
    // WHO: an owner clicking "Restore Record" on a deleted customer.
    // WHAT: handleRestoreDeleted previously had NO busy indicator at all —
    //       unlike every other restore action in this feature (the row
    //       spinner in DeletedRecordRow, the "Restoring..." label on Apply
    //       Changes) — so a caller could click it repeatedly mid-request
    //       with zero visible feedback. It now routes through the same
    //       `loading` state as every other fetch in this modal.
    // WHERE: handleRestoreDeleted.
    // WHY: a control with no busy state invites a double-submit, and gives
    //      no confirmation that the click was even received.
    mockGetHistory.mockResolvedValue(deletedHistory);
    mockRestoreDeleted.mockResolvedValue({ success: true });
    renderModal();
    await screen.findByText('This record is deleted');
    mockGetHistory.mockResolvedValueOnce({ ...deletedHistory, is_deleted: false });

    fireEvent.click(screen.getByRole('button', { name: /Restore Record/i }));

    // Busy state visible immediately (synchronous state update before the
    // request settles).
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    await waitFor(() => expect(mockRestoreDeleted).toHaveBeenCalled());
    expect(await screen.findByText('Record restored.')).toBeInTheDocument();
  });

  test('SAD: a failed restore-deleted falls back to a friendly message when the error has none', async () => {
    // WHO: an owner whose restore fails on a rejection with no message
    //       (a bare `new Error()`, or a network layer that throws one).
    // WHAT: this catch block was the one handler in the file that set
    //       `error` to the raw `.message` with no fallback — every sibling
    //       handler (loadHistory, loadRestorePreview, handleRestore) already
    //       falls back to a friendly string. An empty message rendered as a
    //       blank, silent error box.
    // WHERE: handleRestoreDeleted's catch branch.
    // WHY: an error with no visible text is indistinguishable from no error
    //      at all to a sighted user, and an empty live region says nothing
    //      to a screen-reader user either.
    mockGetHistory.mockResolvedValue(deletedHistory);
    mockRestoreDeleted.mockRejectedValueOnce(new Error());
    renderModal();
    await screen.findByText('This record is deleted');

    fireEvent.click(screen.getByRole('button', { name: /Restore Record/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to restore record');
  });

  test('HAPPY: Apply Changes stays disabled until a field is actually changed from its current version', async () => {
    // WHO: an owner who opens "Restore Fields from History" and, out of
    //       curiosity, clicks Apply Changes without touching anything.
    // WHAT: `loadRestorePreview` seeds every field's selection to its
    //       CURRENT version, so the button was clickable from the first
    //       render yet guaranteed to hit the client-side "No fields selected
    //       for restoration" error on the very first click. It's now
    //       disabled until a selection actually differs, with the reason
    //       wired to the control via aria-describedby + title — the same
    //       pattern used for the AIConfigView forward-loop error.
    // WHERE: the `hasFieldChanges` gate on the Apply Changes button.
    // WHY: a control that's enabled but guaranteed to fail is worse than one
    //      that's honestly disabled with a visible reason.
    mockGetHistory.mockResolvedValue(history);
    mockGetRestorePreview.mockResolvedValue(restorePreview);
    renderModal();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /Restore Fields from History/i }));

    const applyButton = await screen.findByRole('button', { name: /Apply Changes/i });
    expect(applyButton).toBeDisabled();
    expect(applyButton).toHaveAttribute('aria-describedby', 'restore-fields-no-changes-hint');
    expect(
      screen.getByText(/Select an older version above to enable Apply Changes/i)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /v1/i }));

    expect(applyButton).not.toBeDisabled();
    expect(applyButton).not.toHaveAttribute('aria-describedby');
  });

  test('HAPPY: applying a field restore announces success in the live status region', async () => {
    // WHO: a screen-reader user who just applied a field-level restore.
    // WHAT: the mode silently switches back to the version timeline with no
    //       spoken confirmation of what just happened.
    // WHERE: handleRestore's success path.
    // WHY: same "say it, don't just show it" gap as the deleted-record
    //      restore path above.
    mockGetHistory.mockResolvedValue(history);
    mockGetRestorePreview.mockResolvedValue(restorePreview);
    mockRestoreFields.mockResolvedValue({ success: true });
    renderModal();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /Restore Fields from History/i }));
    await screen.findByRole('button', { name: /Apply Changes/i });
    fireEvent.click(screen.getByRole('radio', { name: /v1/i }));

    fireEvent.click(screen.getByRole('button', { name: /Apply Changes/i }));

    await waitFor(() => expect(mockRestoreFields).toHaveBeenCalled());
    expect(await screen.findByText('Selected fields restored.')).toBeInTheDocument();
  });

  test('SAD (regression): a failed Restore Record shows an inline alert without wiping the timeline', async () => {
    // WHO: an owner who clicks "Restore Record" and the request fails.
    // WHAT: before this fix, ANY error — including one from an action after
    //       a successful load — replaced the ENTIRE modal body (the version
    //       timeline) with a bare error string, identical to the bug already
    //       fixed in the sibling DeletedRecordsPanel. Because the timeline
    //       (and its "Restore Record" button) came from a load that already
    //       succeeded, wiping it made a failed action look like the modal
    //       had lost its data.
    // WHERE: the render ternary's error branch.
    // WHY: an action error after a successful load should be additive
    //      (an alert above the still-visible content), not destructive.
    mockGetHistory.mockResolvedValue(deletedHistory);
    mockRestoreDeleted.mockRejectedValueOnce(new Error('network blip'));
    renderModal();
    await screen.findByText('This record is deleted');

    fireEvent.click(screen.getByRole('button', { name: /Restore Record/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('network blip');
    // The timeline that already loaded successfully must still be visible —
    // the caller can see their data didn't vanish and can retry.
    expect(screen.getByText('This record is deleted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restore Record/i })).toBeInTheDocument();
  });

  test('SAD (regression): a failed Apply Changes shows an inline alert without wiping the field panel or the selection', async () => {
    // WHO: an owner who picks an older version for a field, clicks Apply
    //       Changes, and the request fails.
    // WHAT: before this fix, the failure replaced the entire FieldRestorePanel
    //       (and the caller's just-made selection) with a bare error string.
    //       Reopening restore mode re-fetches the preview and reseeds every
    //       field to its CURRENT version, so the selection was unrecoverable
    //       — a worse instance of the same "did this eat my work" bug fixed
    //       elsewhere in this same PR.
    // WHERE: the render ternary's error branch, restore mode.
    // WHY: a failed write should never look indistinguishable from a wiped
    //      workspace, and the panel + selection state were never reset on
    //      failure — only the (unfixed) render logic was discarding them.
    mockGetHistory.mockResolvedValue(history);
    mockGetRestorePreview.mockResolvedValue(restorePreview);
    mockRestoreFields.mockRejectedValueOnce(new Error('write failed'));
    renderModal();
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: /Restore Fields from History/i }));
    await screen.findByRole('button', { name: /Apply Changes/i });
    fireEvent.click(screen.getByRole('radio', { name: /v1/i }));

    fireEvent.click(screen.getByRole('button', { name: /Apply Changes/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('write failed');
    // The field-restore panel — and the caller's v1 selection — must still
    // be visible/selected, not replaced by the bare error.
    const applyButton = screen.getByRole('button', { name: /Apply Changes/i });
    expect(applyButton).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /v1/i })).toBeChecked();
  });
});
