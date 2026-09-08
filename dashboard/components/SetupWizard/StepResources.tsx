'use client';

import React from 'react';
import { Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useVocabulary } from '@/lib/VocabularyContext';
import { ConfirmModal } from '../ui/ConfirmModal';
import { useConfirm } from '../../lib/useConfirm';
import type { Step2Props, WizardResource } from './types';

export function Step2Resources({
  resources,
  loading,
  editingResource,
  editingResourceId,
  saving,
  error,
  onAdd,
  onEdit,
  onDelete,
  onSave,
  onCancel,
  onChange,
}: Step2Props) {
  const vocab = useVocabulary();
  const { state: confirmState, confirm, close: closeConfirm } = useConfirm();

  function handleDelete(res: WizardResource) {
    confirm({
      title: `Remove ${vocab.resource_label}?`,
      message: `Remove "${res.name}"? This won't affect existing appointments.`,
      confirmLabel: 'Remove',
      onConfirm: () => {
        closeConfirm();
        onDelete(res.resource_id);
      },
    });
  }

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          Where does work happen?
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Add your {vocab.resource_plural.toLowerCase()} — anywhere a service is performed.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-4 text-sm text-gray-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading…
        </div>
      ) : (
        <div className="space-y-2 mb-4">
          {resources.map((res: WizardResource) => (
            <div
              key={res.resource_id}
              className="flex items-center justify-between px-4 py-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#222]"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-gray-900 dark:text-gray-100">
                  {res.name}
                </div>
                {res.description && (
                  <div className="text-xs text-gray-400 dark:text-gray-500 mt-0.5 truncate max-w-[300px]">
                    {res.description}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 ml-2">
                <button
                  onClick={() => onEdit(res)}
                  aria-label={`Edit ${res.name}`}
                  className="p-1.5 text-gray-400 transition-colors rounded-sm hover:[color:var(--accent-soft)] focus-visible:[color:var(--accent-soft)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[--accent-soft]"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(res)}
                  aria-label={`Remove ${res.name}`}
                  className="p-1.5 text-gray-400 transition-colors rounded-sm hover:[color:var(--danger)] focus-visible:[color:var(--danger)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[--danger]"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
          {resources.length === 0 && !editingResource && (
            <p className="text-sm text-gray-400 dark:text-gray-500 py-4 text-center">
              No {vocab.resource_plural.toLowerCase()} yet. Add your first{' '}
              {vocab.resource_label.toLowerCase()}.
            </p>
          )}
        </div>
      )}

      {editingResource ? (
        <div
          className="rounded-xl border-2 p-4 space-y-3"
          style={{ borderColor: 'var(--accent-soft)', backgroundColor: 'var(--accent-muted)' }}
        >
          <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {editingResourceId ? `Edit ${vocab.resource_label}` : `New ${vocab.resource_label}`}
          </div>
          <Input
            label={`${vocab.resource_label} Name`}
            value={editingResource.name}
            onChange={(e) => onChange({ ...editingResource, name: e.target.value })}
            placeholder={
              vocab.example_resources && vocab.example_resources.length > 0
                ? `e.g. ${vocab.example_resources.slice(0, 3).join(', ')}`
                : `e.g. ${vocab.resource_label} 1`
            }
          />
          <Input
            label="Description (optional)"
            value={editingResource.description}
            onChange={(e) => onChange({ ...editingResource, description: e.target.value })}
            placeholder="Brief description"
          />
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex gap-2 pt-1">
            <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>
              {saving ? 'Saving...' : editingResourceId ? 'Update' : `Add ${vocab.resource_label}`}
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
          Add a {vocab.resource_label.toLowerCase()}
        </button>
      )}
      <ConfirmModal {...confirmState} onClose={closeConfirm} />
    </div>
  );
}
