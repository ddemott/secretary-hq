'use client';

import React, { useState, useEffect } from 'react';
import { Trash2, Search } from 'lucide-react';
import { Api } from '../../lib/api';
import type {
  DeletedRecord,
  DeletedRecordsResponse,
  VersionedTable,
  Customer,
} from '../../lib/types';
import { DeletedRecordRow } from './DeletedRecordRow';
import { CopyFieldsModal } from './CopyFieldsModal';

interface DeletedRecordsPanelProps {
  table: VersionedTable;
  tenantId: string | null;
  onRecordRestored?: () => void;
  onViewHistory?: (recordId: string, recordName: string) => void;
}

export function DeletedRecordsPanel({
  table,
  tenantId,
  onRecordRestored,
  onViewHistory,
}: DeletedRecordsPanelProps) {
  const [deleted, setDeleted] = useState<DeletedRecordsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRecords, setExpandedRecords] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [restoring, setRestoring] = useState<string | null>(null);
  const [copyModal, setCopyModal] = useState<{
    sourceId: string;
    sourceData: Record<string, unknown>;
    table: VersionedTable;
  } | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<string>('');
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    void loadDeletedRecords();
    if (table === 'customers') {
      void loadCustomers();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, tenantId]);

  async function loadDeletedRecords() {
    setLoading(true);
    setError(null);
    try {
      const data = await Api.versionHistory.getDeleted(tenantId, table, { limit: 100 });
      setDeleted(data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load deleted records');
    } finally {
      setLoading(false);
    }
  }

  async function loadCustomers() {
    try {
      const data = await Api.customers.list(tenantId);
      setCustomers(data);
    } catch (err) {
      console.error('Failed to load customers for copy target', err);
    }
  }

  async function handleRestore(recordId: string) {
    setRestoring(recordId);
    setError(null);
    try {
      await Api.versionHistory.restoreDeleted(tenantId, table, recordId);
      await loadDeletedRecords();
      onRecordRestored?.();
    } catch (err) {
      setError((err as Error).message || 'Failed to restore record');
    } finally {
      setRestoring(null);
    }
  }

  function toggleRecord(recordId: string) {
    const next = new Set(expandedRecords);
    if (next.has(recordId)) {
      next.delete(recordId);
    } else {
      next.add(recordId);
    }
    setExpandedRecords(next);
  }

  function openCopyModal(record: DeletedRecord) {
    setCopyModal({
      sourceId: record.record_id,
      sourceData: record.last_data || {},
      table: record.table_name,
    });
    setSelectedFields(new Set());
    setSelectedTarget('');
  }

  function toggleField(field: string) {
    const next = new Set(selectedFields);
    if (next.has(field)) {
      next.delete(field);
    } else {
      next.add(field);
    }
    setSelectedFields(next);
  }

  async function handleCopyFields() {
    if (!copyModal || !selectedTarget || selectedFields.size === 0) return;
    setCopying(true);
    setError(null);
    try {
      await Api.versionHistory.copyFields(tenantId, table, {
        source_record_id: copyModal.sourceId,
        target_record_id: selectedTarget,
        fields: Array.from(selectedFields),
      });
      setCopyModal(null);
      onRecordRestored?.();
    } catch (err) {
      setError((err as Error).message || 'Failed to copy fields');
    } finally {
      setCopying(false);
    }
  }

  const filteredRecords =
    deleted?.records.filter((r) => {
      if (!searchTerm) return true;
      const term = searchTerm.toLowerCase();
      return (
        r.name?.toLowerCase().includes(term) ||
        r.phone?.toLowerCase().includes(term) ||
        r.email?.toLowerCase().includes(term)
      );
    }) || [];

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700">
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Trash2 className="w-5 h-5" style={{ color: 'var(--danger)' }} />
            <h3 className="font-semibold text-gray-900 dark:text-white">Deleted Records</h3>
            {deleted && <span className="text-sm text-gray-500">({deleted.total} total)</span>}
          </div>
        </div>
        <div className="mt-4 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search deleted records..."
            aria-label="Search deleted records"
            className="w-full pl-10 pr-4 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
          />
        </div>
      </div>

      <div className="p-4">
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
        ) : filteredRecords.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <Trash2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
            {searchTerm ? (
              <>
                <p className="font-medium">No matches for &ldquo;{searchTerm}&rdquo;</p>
                <button
                  onClick={() => setSearchTerm('')}
                  className="text-xs mt-2 hover:underline"
                  style={{ color: 'var(--accent-soft)' }}
                >
                  Clear search
                </button>
              </>
            ) : (
              <p>No deleted records</p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredRecords.map((record) => (
              <DeletedRecordRow
                key={record.record_id}
                record={record}
                isExpanded={expandedRecords.has(record.record_id)}
                isRestoring={restoring === record.record_id}
                onToggle={() => toggleRecord(record.record_id)}
                onRestore={() => void handleRestore(record.record_id)}
                onCopy={() => openCopyModal(record)}
                onViewHistory={onViewHistory}
              />
            ))}
          </div>
        )}
      </div>

      <CopyFieldsModal
        copyModal={copyModal}
        customers={customers}
        selectedTarget={selectedTarget}
        selectedFields={selectedFields}
        copying={copying}
        onClose={() => setCopyModal(null)}
        onTargetChange={setSelectedTarget}
        onToggleField={toggleField}
        onCopy={() => void handleCopyFields()}
      />
    </div>
  );
}
