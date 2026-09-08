'use client';

import React, { useState, useEffect, useRef } from 'react';
import { X, History, RefreshCw, Check } from 'lucide-react';
import { Api } from '../../lib/api';
import { useFocusTrap } from '../../lib/useFocusTrap';
import type { RecordHistoryResponse, VersionedTable, RecordRestorePreview } from '../../lib/types';
import { excludedSystemFields } from '../../../shared/versionHistoryFields';
import { VersionTimeline } from './VersionTimeline';
import { FieldRestorePanel } from './FieldRestorePanel';

interface RecordHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  table: VersionedTable;
  recordId: string;
  recordName?: string;
  tenantId: string | null;
  onRestored?: () => void;
}

export function RecordHistoryModal({
  isOpen,
  onClose,
  table,
  recordId,
  recordName,
  tenantId,
  onRestored,
}: RecordHistoryModalProps) {
  const [history, setHistory] = useState<RecordHistoryResponse | null>(null);
  const [restorePreview, setRestorePreview] = useState<RecordRestorePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedVersions, setExpandedVersions] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<'history' | 'restore'>('history');
  const [selectedFields, setSelectedFields] = useState<Record<string, number>>({});
  const [restoring, setRestoring] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Escape-to-close + Tab focus trap + body-scroll lock, matching the other
  // centered dialogs (Cluster C). The backdrop already closes on click.
  useFocusTrap(containerRef, isOpen, onClose, true);

  useEffect(() => {
    if (isOpen && recordId) {
      void loadHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, recordId, table, tenantId]);

  async function loadHistory() {
    setLoading(true);
    setError(null);
    try {
      const data = await Api.versionHistory.getHistory(tenantId, table, recordId);
      setHistory(data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }

  async function loadRestorePreview() {
    setLoading(true);
    setError(null);
    try {
      const data = await Api.versionHistory.getRestorePreview(tenantId, table, recordId);
      setRestorePreview(data);
      setMode('restore');
      const initial: Record<string, number> = {};
      data.fields.forEach((f) => {
        if (f.versions.length > 0) {
          initial[f.field] = f.versions[0].version_number;
        }
      });
      setSelectedFields(initial);
    } catch (err) {
      setError((err as Error).message || 'Failed to load restore preview');
    } finally {
      setLoading(false);
    }
  }

  function toggleVersion(versionNumber: number) {
    const next = new Set(expandedVersions);
    if (next.has(versionNumber)) {
      next.delete(versionNumber);
    } else {
      next.add(versionNumber);
    }
    setExpandedVersions(next);
  }

  function selectFieldVersion(field: string, versionNumber: number) {
    setSelectedFields((prev) => ({ ...prev, [field]: versionNumber }));
  }

  async function handleRestore() {
    if (!history || !restorePreview) return;

    const currentVersion = history.current_version;
    const fieldsToRestore: { field: string; sourceVersion: number }[] = [];

    for (const [field, version] of Object.entries(selectedFields)) {
      if (version !== currentVersion) {
        fieldsToRestore.push({ field, sourceVersion: version });
      }
    }

    if (fieldsToRestore.length === 0) {
      setError('No fields selected for restoration');
      return;
    }

    // Group by source version — one batch request = one transaction (no partial-failure half-restores).
    const byVersion: Record<number, string[]> = {};
    fieldsToRestore.forEach(({ field, sourceVersion }) => {
      if (!byVersion[sourceVersion]) byVersion[sourceVersion] = [];
      byVersion[sourceVersion].push(field);
    });
    const restores = Object.entries(byVersion).map(([versionStr, fields]) => ({
      source_version: parseInt(versionStr),
      fields,
    }));

    setRestoring(true);
    setError(null);
    try {
      await Api.versionHistory.restoreFields(tenantId, table, recordId, { restores });
      await loadHistory();
      setMode('history');
      setRestorePreview(null);
      onRestored?.();
    } catch (err) {
      setError((err as Error).message || 'Failed to restore fields');
    } finally {
      setRestoring(false);
    }
  }

  async function handleRestoreDeleted() {
    try {
      await Api.versionHistory.restoreDeleted(tenantId, table, recordId);
      await loadHistory();
      onRestored?.();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!isOpen) return null;

  const excludedFields = excludedSystemFields(table);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-history-title"
        className="relative bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col"
      >
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <History className="w-5 h-5" style={{ color: 'var(--accent-soft)' }} />
            <div>
              <h2
                id="record-history-title"
                className="text-lg font-semibold text-gray-900 dark:text-white"
              >
                {mode === 'history' ? 'Version History' : 'Restore Fields'}
              </h2>
              <p className="text-sm text-gray-500">{recordName || recordId}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close version history"
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div
                className="animate-spin rounded-full h-8 w-8 border-b-2"
                style={{ borderColor: 'var(--accent)' }}
              />
            </div>
          ) : error ? (
            <div className="text-center py-8" style={{ color: 'var(--danger)' }}>
              {error}
            </div>
          ) : mode === 'history' && history ? (
            <VersionTimeline
              history={history}
              expandedVersions={expandedVersions}
              excludedFields={excludedFields}
              onToggleVersion={toggleVersion}
              onLoadRestorePreview={loadRestorePreview}
              onRestoreDeleted={handleRestoreDeleted}
            />
          ) : mode === 'restore' && restorePreview ? (
            <FieldRestorePanel
              restorePreview={restorePreview}
              selectedFields={selectedFields}
              onSelectFieldVersion={selectFieldVersion}
            />
          ) : null}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-between">
          {mode === 'restore' ? (
            <>
              <button
                onClick={() => {
                  setMode('history');
                  setRestorePreview(null);
                }}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"
              >
                Back to History
              </button>
              <button
                onClick={handleRestore}
                disabled={restoring}
                className="px-4 py-2 text-white rounded-lg disabled:opacity-50 flex items-center gap-2"
                style={{ backgroundColor: 'var(--accent)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.opacity = '0.9';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.opacity = '';
                }}
              >
                {restoring ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                    Restoring...
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    Apply Changes
                  </>
                )}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={loadHistory}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg flex items-center gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                Refresh
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700"
              >
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
