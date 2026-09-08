'use client';

/**
 * Owner-only change-history view. Renders GET /audit-log — every INSERT/UPDATE/
 * DELETE the audit trigger recorded on appointments / customers / resources —
 * so an owner can answer "who changed this, and when?" without DB access.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { LoadingState } from '../ui/LoadingState';
import { EmptyState } from '../ui/EmptyState';
import { Api } from '../../lib/api';
import { useActiveTenantId } from '../../lib/SessionContext';
import { showToast } from '../ui/Toast';
import type { AuditLogEntry } from '../../lib/types';

const PAGE_SIZE = 50;

// The audit trigger fires on these tables (see fn_audit_trigger).
const TABLE_OPTIONS = [
  { label: 'All tables', value: '' },
  { label: 'Appointments', value: 'appointments' },
  { label: 'Customers', value: 'customers' },
  { label: 'Resources', value: 'resources' },
  { label: 'Services', value: 'services' },
  { label: 'Team', value: 'employees' },
];

/** Union of keys across old + new whose values differ — the changed fields. */
function changedFields(
  oldData: Record<string, unknown> | null,
  newData: Record<string, unknown> | null
): Array<{ field: string; before: unknown; after: unknown }> {
  const keys = new Set([...Object.keys(oldData ?? {}), ...Object.keys(newData ?? {})]);
  const out: Array<{ field: string; before: unknown; after: unknown }> = [];
  for (const field of [...keys].sort()) {
    const before = oldData?.[field];
    const after = newData?.[field];
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ field, before, after });
  }
  return out;
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  // numbers / booleans / objects all serialize cleanly (no [object Object]).
  return JSON.stringify(v);
}

function actionVariant(action: string): 'success' | 'warning' | 'danger' | 'secondary' {
  switch (action.toUpperCase()) {
    case 'INSERT':
      return 'success';
    case 'UPDATE':
      return 'warning';
    case 'DELETE':
      return 'danger';
    default:
      return 'secondary';
  }
}

export default function AuditLogView() {
  const tenantId = useActiveTenantId();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [tableFilter, setTableFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [selected, setSelected] = useState<AuditLogEntry | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await Api.auditLog.list(tenantId, {
        limit: PAGE_SIZE,
        offset,
        table_name: tableFilter || undefined,
        start_date: startDate || undefined,
        end_date: endDate || undefined,
      });
      if (res.success) {
        // Offset pagination can't know the total, so when the row count is an
        // exact multiple of PAGE_SIZE the "Next" button stays enabled and lands
        // on an empty page. Snap back one page instead of stranding the owner on
        // a blank table.
        if (res.entries.length === 0 && offset > 0) {
          setOffset((o) => Math.max(0, o - PAGE_SIZE));
          return;
        }
        setEntries(res.entries);
      } else {
        setError('Failed to load audit log');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load audit log';
      setError(msg);
      showToast('Failed to load audit log', 'error');
    } finally {
      setLoading(false);
    }
  }, [tenantId, offset, tableFilter, startDate, endDate]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card title="Audit Log">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Select
              label="Filter by table"
              value={tableFilter}
              options={TABLE_OPTIONS}
              onChange={(e) => {
                setOffset(0);
                setTableFilter(e.target.value);
              }}
            />
          </div>
          <div className="w-40">
            <Input
              label="From"
              type="date"
              value={startDate}
              onChange={(e) => {
                setOffset(0);
                setStartDate(e.target.value);
              }}
            />
          </div>
          <div className="w-40">
            <Input
              label="To"
              type="date"
              value={endDate}
              onChange={(e) => {
                setOffset(0);
                setEndDate(e.target.value);
              }}
            />
          </div>
        </div>

        {loading ? (
          <LoadingState message="Loading audit log…" />
        ) : error ? (
          <EmptyState title="Couldn't load the audit log" description={error} />
        ) : entries.length === 0 ? (
          <EmptyState
            title="No changes recorded yet"
            description="Edits to appointments, customers, and resources will appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="py-2 pr-4">When</th>
                  <th className="py-2 pr-4">Table</th>
                  <th className="py-2 pr-4">Action</th>
                  <th className="py-2 pr-4">Record</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={e.audit_log_id}
                    className="border-b last:border-0 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-800"
                    role="button"
                    tabIndex={0}
                    aria-label={`View what changed: ${e.action} on ${e.table_name}`}
                    onClick={() => setSelected(e)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        setSelected(e);
                      }
                    }}
                    title="View what changed"
                  >
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {new Date(e.created_at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4">{e.table_name}</td>
                    <td className="py-2 pr-4">
                      <Badge variant={actionVariant(e.action)}>{e.action}</Badge>
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-gray-600">{e.record_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={loading || offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          >
            Previous
          </Button>
          <span className="text-xs text-gray-500">
            Showing {entries.length ? offset + 1 : 0}–{offset + entries.length}
          </span>
          <Button
            variant="secondary"
            size="sm"
            // A full page came back → there may be more.
            disabled={loading || entries.length < PAGE_SIZE}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </div>

      {selected && (
        <Modal
          isOpen={true}
          onClose={() => setSelected(null)}
          title={`${selected.action} on ${selected.table_name}`}
        >
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
              <span>{new Date(selected.created_at).toLocaleString()}</span>
              <span className="font-mono">record {selected.record_id}</span>
            </div>
            {(() => {
              const diff = changedFields(selected.old_data, selected.new_data);
              if (diff.length === 0) {
                return (
                  <p className="text-gray-500">No field-level changes recorded for this entry.</p>
                );
              }
              return (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 border-b">
                      <th className="py-1 pr-3">Field</th>
                      <th className="py-1 pr-3">Before</th>
                      <th className="py-1 pr-3">After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.map((d) => (
                      <tr key={d.field} className="border-b last:border-0 align-top">
                        <td className="py-1 pr-3 font-medium">{d.field}</td>
                        <td className="py-1 pr-3 text-red-600 dark:text-red-400 break-all">
                          {fmt(d.before)}
                        </td>
                        <td className="py-1 pr-3 text-green-600 dark:text-green-400 break-all">
                          {fmt(d.after)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })()}
          </div>
        </Modal>
      )}
    </Card>
  );
}
