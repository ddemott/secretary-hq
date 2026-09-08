'use client';

import React from 'react';
import { RotateCcw, ChevronDown, ChevronRight } from 'lucide-react';
import type { RecordHistoryResponse } from '../../lib/types';
import {
  formatDate,
  formatChangeSource,
  formatChangeType,
  getChangeTypeIcon,
  getChangeTypeStyle,
  formatValue,
} from './recordHistoryHelpers';

interface VersionTimelineProps {
  history: RecordHistoryResponse;
  expandedVersions: Set<number>;
  excludedFields: ReadonlySet<string>;
  onToggleVersion: (versionNumber: number) => void;
  onLoadRestorePreview: () => void;
  onRestoreDeleted: () => Promise<void>;
}

export function VersionTimeline({
  history,
  expandedVersions,
  excludedFields,
  onToggleVersion,
  onLoadRestorePreview,
  onRestoreDeleted,
}: VersionTimelineProps) {
  return (
    <div className="space-y-4">
      {history.is_deleted && (
        <div
          className="rounded-lg p-4 flex items-center justify-between"
          style={{ backgroundColor: 'var(--danger-bg)', border: '1px solid var(--danger)' }}
        >
          <div>
            <p className="font-medium" style={{ color: 'var(--danger)' }}>
              This record is deleted
            </p>
            <p className="text-sm" style={{ color: 'var(--danger)' }}>
              Deleted {history.deleted_at ? formatDate(history.deleted_at) : 'unknown'} by{' '}
              {history.deleted_by || 'unknown'}
            </p>
          </div>
          <button
            onClick={() => void onRestoreDeleted()}
            className="px-4 py-2 rounded-lg flex items-center gap-2 hover:brightness-110"
            style={{ backgroundColor: 'var(--danger)', color: '#ffffff' }}
          >
            <RotateCcw className="w-4 h-4" />
            Restore Record
          </button>
        </div>
      )}

      {!history.is_deleted && history.versions.length > 1 && (
        <div className="flex justify-end">
          <button
            onClick={onLoadRestorePreview}
            className="px-4 py-2 text-white rounded-lg flex items-center gap-2"
            style={{ backgroundColor: 'var(--accent)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = '0.9';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '';
            }}
          >
            <RotateCcw className="w-4 h-4" />
            Restore Fields from History
          </button>
        </div>
      )}

      <div className="space-y-3">
        {history.versions.map((version, idx) => (
          <div key={version.record_version_id} className="relative">
            {idx < history.versions.length - 1 && (
              <div className="absolute left-4 top-10 bottom-0 w-0.5 bg-gray-200 dark:bg-gray-700" />
            )}

            <div className="flex gap-4">
              <div
                className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
                style={getChangeTypeStyle(version.change_type)}
              >
                {getChangeTypeIcon(version.change_type)}
              </div>

              <div className="flex-1 bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900 dark:text-white">
                        v{version.version_number} - {formatChangeType(version.change_type)}
                      </span>
                      <span className="text-xs px-2 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-gray-600 dark:text-gray-400">
                        {formatChangeSource(version.change_source)}
                      </span>
                      {idx === 0 && (
                        <span
                          className="text-xs px-2 py-0.5 rounded"
                          style={{
                            backgroundColor: 'var(--success-bg)',
                            color: 'var(--success)',
                          }}
                        >
                          Current
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-500 mt-1">
                      {formatDate(version.changed_at)}
                      {version.changed_by && ` by ${version.changed_by}`}
                    </p>
                    {version.change_summary && (
                      <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
                        {version.change_summary}
                      </p>
                    )}
                  </div>

                  <button
                    onClick={() => onToggleVersion(version.version_number)}
                    aria-expanded={expandedVersions.has(version.version_number)}
                    aria-label={`${expandedVersions.has(version.version_number) ? 'Hide' : 'Show'} details for version ${version.version_number}`}
                    className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
                  >
                    {expandedVersions.has(version.version_number) ? (
                      <ChevronDown className="w-4 h-4" />
                    ) : (
                      <ChevronRight className="w-4 h-4" />
                    )}
                  </button>
                </div>

                {expandedVersions.has(version.version_number) && (
                  <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                    <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">
                      Record Data
                    </h4>
                    <div className="space-y-1 text-sm">
                      {Object.entries(version.data)
                        .filter(([key]) => !excludedFields.has(key))
                        .map(([key, value]) => (
                          <div key={key} className="flex">
                            <span className="w-32 text-gray-500 flex-shrink-0">{key}:</span>
                            <span
                              className={`text-gray-900 dark:text-gray-100 ${version.changed_fields?.includes(key) ? 'bg-yellow-100 dark:bg-yellow-900/30 px-1 rounded' : ''}`}
                            >
                              {formatValue(value)}
                            </span>
                          </div>
                        ))}
                    </div>

                    {version.previous_values && Object.keys(version.previous_values).length > 0 && (
                      <div className="mt-4">
                        <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">
                          Previous Values
                        </h4>
                        <div className="space-y-1 text-sm">
                          {Object.entries(version.previous_values).map(([key, value]) => (
                            <div key={key} className="flex">
                              <span className="w-32 text-gray-500 flex-shrink-0">{key}:</span>
                              <span className="line-through" style={{ color: 'var(--danger)' }}>
                                {formatValue(value)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {history.versions.length === 0 && (
        <p className="text-center text-gray-500 py-8">No version history available</p>
      )}
    </div>
  );
}
