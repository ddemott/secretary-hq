'use client';

/**
 * Modal for editing a single day's shift — toggle Day Off, set start/end times.
 * Extracted from ShiftManagementView.tsx (dense-view decomposition).
 */

import React from 'react';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { TimeInput } from '../ui/TimeInput';
import type { EffectiveShift } from '../../lib/types';

interface ModalForm {
  start_time: string;
  end_time: string;
  is_off: boolean;
}

interface ShiftEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingDate: string | null;
  editingExistsAsOverride: boolean;
  currentShift: EffectiveShift | undefined;
  modalForm: ModalForm;
  onFormChange: (form: ModalForm) => void;
  onSave: () => void;
  onDelete: () => void;
}

export function ShiftEditorModal({
  isOpen,
  onClose,
  editingDate,
  editingExistsAsOverride,
  currentShift,
  modalForm,
  onFormChange,
  onSave,
  onDelete,
}: ShiftEditorModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={editingDate ? `Schedule for ${editingDate}` : 'Schedule'}
      disableBackdropClose
      footer={
        <div className="flex gap-2">
          {editingDate && currentShift && !currentShift.is_off && (
            <Button variant="ghost" onClick={onDelete} style={{ color: '#ef4444' }}>
              Delete
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onSave}>
            {editingExistsAsOverride ? 'Update' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={modalForm.is_off}
            onChange={(e) => onFormChange({ ...modalForm, is_off: e.target.checked })}
            className="rounded"
          />
          <span className="text-sm font-bold">Day Off</span>
        </label>
        {!modalForm.is_off && (
          <div className="grid grid-cols-2 gap-4">
            <TimeInput
              label="Start Time"
              value={modalForm.start_time}
              onChange={(v) => onFormChange({ ...modalForm, start_time: v })}
            />
            <TimeInput
              label="End Time"
              value={modalForm.end_time}
              onChange={(v) => onFormChange({ ...modalForm, end_time: v })}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
