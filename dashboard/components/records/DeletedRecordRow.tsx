'use client';

import React from 'react';
import { History, Copy, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react';
import type { DeletedRecord, VersionedTable } from '../../lib/types';
import { excludedSystemFields } from '../../../shared/versionHistoryFields';

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  return '(invalid)';
}

interface DeletedRecordRowProps {
  record: DeletedRecord;
  isExpanded: boolean;
  isRestoring: boolean;
  onToggle: () => void;
  onRestore: () => void;
  onCopy: () => void;
  onViewHistory?: (recordId: string, recordName: string) => void;
}

export function DeletedRecordRow({
  record,
  isExpanded,
  isRestoring,
  onToggle,
  onRestore,
  onCopy,
  onViewHistory,
}: DeletedRecordRowProps) {
  const excluded = excludedSystemFields(record.table_name as VersionedTable);

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center gap-4 p-4 bg-gray-50 dark:bg-gray-800">
        <button
          onClick={onToggle}
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? 'Hide' : 'Show'} last known data for ${record.name || 'this record'}`}
          className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
        >
          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>

        <div className="flex-1">
          <div className="font-medium text-gray-900 dark:text-white">
            {record.name || 'Unnamed'}
          </div>
          <div className="text-sm text-gray-500">
            {record.phone && <span className="mr-4">{record.phone}</span>}
            {record.email && <span>{record.email}</span>}
          </div>
        </div>

        <div className="text-right text-sm">
          <div className="text-gray-500">Deleted {formatDate(record.deleted_at)}</div>
          <div className="text-gray-400">by {record.deleted_by || 'unknown'}</div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onViewHistory?.(record.record_id, record.name || 'Record')}
            className="p-2 text-gray-600 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg"
            title="View history"
            aria-label={`View history for ${record.name || 'this record'}`}
          >
            <History className="w-4 h-4" />
          </button>
          <button
            onClick={onCopy}
            className="p-2 rounded-lg transition-colors"
            style={{ color: 'var(--accent-soft)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--accent-muted)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = '';
            }}
            title="Copy fields to another record"
            aria-label={`Copy fields from ${record.name || 'this record'} to another record`}
          >
            <Copy className="w-4 h-4" />
          </button>
          <button
            onClick={onRestore}
            disabled={isRestoring}
            className="px-3 py-1.5 rounded-lg disabled:opacity-50 flex items-center gap-2 hover:brightness-110"
            style={{ backgroundColor: 'var(--success)', color: '#ffffff' }}
          >
            {isRestoring ? (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
            ) : (
              <RotateCcw className="w-4 h-4" />
            )}
            Restore
          </button>
        </div>
      </div>

      {isExpanded && record.last_data && (
        <div className="p-4 border-t border-gray-200 dark:border-gray-700">
          <h4 className="text-xs font-semibold text-gray-500 uppercase mb-3">Last Known Data</h4>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {Object.entries(record.last_data ?? {})
              .filter(([key]) => !excluded.has(key))
              .map(([key, value]) => (
                <div key={key} className="flex">
                  <span className="w-32 text-gray-500 flex-shrink-0">{key}:</span>
                  <span className="text-gray-900 dark:text-gray-100">
                    {formatFieldValue(value)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
