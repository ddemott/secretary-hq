'use client';

import React, { useRef } from 'react';
import { X, Copy } from 'lucide-react';
import { useFocusTrap } from '../../lib/useFocusTrap';
import type { Customer, VersionedTable } from '../../lib/types';
import { excludedSystemFields } from '../../../shared/versionHistoryFields';

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  return '(invalid)';
}

interface CopyFieldsModalProps {
  copyModal: {
    sourceId: string;
    sourceData: Record<string, unknown>;
    table: VersionedTable;
  } | null;
  customers: Customer[];
  selectedTarget: string;
  selectedFields: Set<string>;
  copying: boolean;
  onClose: () => void;
  onTargetChange: (target: string) => void;
  onToggleField: (field: string) => void;
  onCopy: () => void;
}

export function CopyFieldsModal({
  copyModal,
  customers,
  selectedTarget,
  selectedFields,
  copying,
  onClose,
  onTargetChange,
  onToggleField,
  onCopy,
}: CopyFieldsModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, copyModal !== null, onClose, true);

  if (!copyModal) return null;

  const excluded = excludedSystemFields(copyModal.table);
  const copyableEntries = Object.entries(copyModal.sourceData).filter(
    ([key]) => !excluded.has(key)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="copy-fields-title"
        className="relative bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col"
      >
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 id="copy-fields-title" className="font-semibold text-gray-900 dark:text-white">
            Copy Fields to Another Record
          </h3>
          <button
            onClick={onClose}
            aria-label="Close copy fields dialog"
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Copy to:
            </label>
            <select
              value={selectedTarget}
              onChange={(e) => onTargetChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800"
            >
              <option value="">Select a record...</option>
              {customers.map((c) => (
                <option key={c.customer_id} value={c.customer_id}>
                  {c.name} {c.phone && `(${c.phone})`}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Select fields to copy:
            </label>
            <div className="space-y-2 max-h-64 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg p-3">
              {copyableEntries.map(([key, value]) => (
                <label
                  key={key}
                  className="flex items-center gap-3 p-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedFields.has(key)}
                    onChange={() => onToggleField(key)}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  <div className="flex-1">
                    <div className="font-medium text-sm text-gray-900 dark:text-white">{key}</div>
                    <div className="text-xs text-gray-500">{formatFieldValue(value)}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={onCopy}
            disabled={!selectedTarget || selectedFields.size === 0 || copying}
            className="px-4 py-2 text-white rounded-lg disabled:opacity-50 flex items-center gap-2"
            style={{ backgroundColor: 'var(--accent)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = '0.9';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '';
            }}
          >
            {copying ? (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
            Copy {selectedFields.size} Field{selectedFields.size !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
