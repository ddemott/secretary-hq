'use client';

import React from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { PhoneInput } from '../ui/PhoneInput';
import { formatPhone } from '../../lib/phone';
import { useVocabulary } from '@/lib/VocabularyContext';
import { ConfirmModal } from '../ui/ConfirmModal';
import { useConfirm } from '../../lib/useConfirm';
import type { Step3Props, WizardEmployee } from './types';

export function Step3Employees({
  employees,
  loading,
  editingEmployee,
  editingEmployeeId,
  saving,
  error,
  onAdd,
  onEdit,
  onDelete,
  onSave,
  onCancel,
  onChange,
}: Step3Props) {
  const vocab = useVocabulary();
  const { state: confirmState, confirm, close: closeConfirm } = useConfirm();

  function handleDelete(emp: WizardEmployee) {
    confirm({
      title: `Remove ${vocab.employee_label}?`,
      message: `Remove "${emp.first_name || emp.name}"? This won't affect existing appointments.`,
      confirmLabel: 'Remove',
      onConfirm: () => {
        closeConfirm();
        onDelete(emp.employee_id);
      },
    });
  }

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          Who works here?
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Add your {vocab.employee_plural.toLowerCase()}. You&apos;ll set their schedules and assign
          them to services next.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : (
        <div className="space-y-2 mb-4">
          {employees.map((emp: WizardEmployee) => (
            <div
              key={emp.employee_id}
              className="flex items-center justify-between px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#222]"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-gray-900 dark:text-gray-100">
                  {emp.first_name || emp.name} {emp.last_name || ''}
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  {emp.email && (
                    <span className="text-xs text-gray-400 dark:text-gray-500">{emp.email}</span>
                  )}
                  {emp.phone && (
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      {formatPhone(emp.phone)}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 ml-2">
                <button
                  onClick={() => onEdit(emp)}
                  aria-label={`Edit ${emp.first_name || emp.name}`}
                  className="p-1.5 text-gray-400 transition-colors rounded-sm hover:[color:var(--accent-soft)] focus-visible:[color:var(--accent-soft)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[--accent-soft]"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(emp)}
                  aria-label={`Remove ${emp.first_name || emp.name}`}
                  className="p-1.5 text-gray-400 transition-colors rounded-sm hover:[color:var(--danger)] focus-visible:[color:var(--danger)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[--danger]"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
          {employees.length === 0 && !editingEmployee && (
            <p className="text-sm text-gray-400 dark:text-gray-500 py-4 text-center">
              No {vocab.employee_plural.toLowerCase()} yet. Add your first team member.
            </p>
          )}
        </div>
      )}

      {editingEmployee ? (
        <div
          className="rounded-xl border-2 p-4 space-y-3"
          style={{ borderColor: 'var(--accent-soft)', backgroundColor: 'var(--accent-muted)' }}
        >
          <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {editingEmployeeId ? `Edit ${vocab.employee_label}` : `New ${vocab.employee_label}`}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="First Name"
              value={editingEmployee.first_name}
              onChange={(e) => onChange({ ...editingEmployee, first_name: e.target.value })}
              placeholder="First name"
            />
            <Input
              label="Last Name"
              value={editingEmployee.last_name}
              onChange={(e) => onChange({ ...editingEmployee, last_name: e.target.value })}
              placeholder="Last name"
            />
          </div>
          <Input
            label="Email (optional)"
            type="email"
            value={editingEmployee.email}
            onChange={(e) => onChange({ ...editingEmployee, email: e.target.value })}
            placeholder="email@example.com"
          />
          <PhoneInput
            label="Phone (optional)"
            value={editingEmployee.phone}
            onChange={(val) => onChange({ ...editingEmployee, phone: val })}
          />
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex gap-2 pt-1">
            <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>
              {saving ? 'Saving...' : editingEmployeeId ? 'Update' : `Add ${vocab.employee_label}`}
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          onClick={onAdd}
          className="flex items-center gap-2 px-4 py-2.5 w-full rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 text-sm text-gray-500 dark:text-gray-400 transition-colors hover:[border-color:var(--accent-soft)] hover:[color:var(--accent-soft)] focus-visible:[border-color:var(--accent-soft)] focus-visible:[color:var(--accent-soft)] focus-visible:outline-none"
        >
          <Plus className="w-4 h-4" />
          Add an {vocab.employee_label.toLowerCase()}
        </button>
      )}
      <ConfirmModal {...confirmState} onClose={closeConfirm} />
    </div>
  );
}
