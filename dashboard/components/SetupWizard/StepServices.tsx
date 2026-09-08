'use client';

import type { StarterService } from '../../../shared/starterServices';

import React from 'react';
import { Plus, Pencil, Trash2, Clock } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useVocabulary } from '../../lib/VocabularyContext';
import { ConfirmModal } from '../ui/ConfirmModal';
import { useConfirm } from '../../lib/useConfirm';
import type { Step1Props, WizardService } from './types';

/**
 * Build the "e.g. …" placeholder string from per-industry examples.
 * Falls back to a single generic phrase when the vocab system hasn't
 * loaded the array yet, when a unit test stubs a partial Vocabulary,
 * or for the rare path where the tenant skipped BusinessTypePicker
 * entirely — anything is better than the cross-industry "Oil Change,
 * Haircut, Tire Rotation" we had before.
 */
function servicePlaceholder(examples: readonly StarterService[] | undefined): string {
  if (!examples || examples.length === 0) return 'e.g. 30-minute consultation';
  return `e.g. ${examples
    .slice(0, 3)
    .map((s) => s.name)
    .join(', ')}`;
}

export function Step1Services({
  services,
  loading,
  editingService,
  editingServiceId,
  saving,
  error,
  onAdd,
  onEdit,
  onDelete,
  onSave,
  onCancel,
  onChange,
}: Step1Props) {
  const vocab = useVocabulary();
  const { state: confirmState, confirm, close: closeConfirm } = useConfirm();

  function handleDelete(svc: WizardService) {
    confirm({
      title: 'Remove service?',
      message: `Remove "${svc.name}"? This won't affect existing appointments.`,
      confirmLabel: 'Remove',
      onConfirm: () => {
        closeConfirm();
        onDelete(svc.service_id);
      },
    });
  }

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          What services do you offer?
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Add each service your business provides. You&apos;ll assign staff and resources to them in
          later steps.
        </p>
      </div>

      {/* Service list */}
      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : (
        <div className="space-y-2 mb-4">
          {services.map((svc: WizardService) => (
            <div
              key={svc.service_id}
              className="flex items-center justify-between px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#222]"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-gray-900 dark:text-gray-100">
                  {svc.name}
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                    <Clock className="w-3 h-3" /> {svc.duration_minutes} min
                  </span>
                  {svc.description && (
                    <span className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-[200px]">
                      {svc.description}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 ml-2 shrink-0">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(svc);
                  }}
                  aria-label={`Edit ${svc.name}`}
                  className="p-1.5 text-gray-400 transition-colors rounded-sm hover:[color:var(--accent-soft)] focus-visible:[color:var(--accent-soft)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[--accent-soft]"
                >
                  <Pencil className="w-3.5 h-3.5 pointer-events-none" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(svc);
                  }}
                  aria-label={`Remove ${svc.name}`}
                  className="p-1.5 text-gray-400 transition-colors rounded-sm hover:[color:var(--danger)] focus-visible:[color:var(--danger)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[--danger]"
                >
                  <Trash2 className="w-3.5 h-3.5 pointer-events-none" />
                </button>
              </div>
            </div>
          ))}
          {services.length === 0 && !editingService && (
            <p className="text-sm text-gray-400 dark:text-gray-500 py-4 text-center">
              No services yet. Add your first service to get started.
            </p>
          )}
        </div>
      )}

      {/* Error display */}
      {error && !editingService && (
        <p className="text-xs text-red-600 dark:text-red-400 mb-2">{error}</p>
      )}

      {/* Add/Edit form */}
      {editingService ? (
        <div
          className="rounded-xl border-2 p-4 space-y-3"
          style={{ borderColor: 'var(--accent-soft)', backgroundColor: 'var(--accent-muted)' }}
        >
          <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {editingServiceId ? 'Edit Service' : 'New Service'}
          </div>
          <Input
            label="Service Name"
            value={editingService.name}
            onChange={(e) => onChange({ ...editingService, name: e.target.value })}
            placeholder={servicePlaceholder(vocab.example_services)}
          />
          <Input
            label="Description (optional)"
            value={editingService.description}
            onChange={(e) => onChange({ ...editingService, description: e.target.value })}
            placeholder="Brief description"
          />
          <Input
            label="Duration (minutes)"
            type="number"
            step={15}
            min={15}
            // Show empty (not "0") when the value is 0, so the field can be
            // cleared and retyped. Pre-fix, `parseInt(value) || 0` forced the
            // field to "0" the instant it was emptied — you couldn't clear "3"
            // to type "30". 0 is treated as "unset" (saveService rejects it
            // anyway via the `< 1` guard), so rendering it as empty is correct.
            value={
              editingService.duration_minutes === 0 ? '' : String(editingService.duration_minutes)
            }
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              // Never propagate NaN — saveService()'s `< 1` guard treats NaN as
              // valid (NaN < 1 is false), which would let an empty field through.
              // Empty/invalid → 0, which renders as empty above and save rejects.
              onChange({ ...editingService, duration_minutes: Number.isNaN(n) ? 0 : n });
            }}
          />
          <p className="text-xs -mt-2" style={{ color: 'var(--text-muted)' }}>
            Scheduled in 15-minute slots — non-multiples are rounded up on save.
          </p>
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex gap-2 pt-1">
            <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>
              {saving ? 'Saving...' : editingServiceId ? 'Update' : 'Add Service'}
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
          Add a service
        </button>
      )}
      <ConfirmModal {...confirmState} onClose={closeConfirm} />
    </div>
  );
}
