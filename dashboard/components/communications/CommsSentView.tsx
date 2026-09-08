'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Mail,
  MessageSquare,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import { Api } from '../../lib/api';

type ChannelFilter = 'all' | 'sms' | 'email';

interface CommRow {
  communications_history_id: number;
  channel: 'sms' | 'email';
  recipient: string;
  subject: string | null;
  body: string;
  status: string;
  /** Provider failure detail recorded at send time; set on failed rows. */
  error: string | null;
  created_at: string;
}

const PAGE_SIZE = 25;

export function CommsSentView({ tenantId }: { tenantId: string | null }) {
  const [rows, setRows] = useState<CommRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<ChannelFilter>('all');
  // Delivery-status drill-down: when on, only failed deliveries are shown
  // (with their per-row error detail). Composes with the channel filter.
  const [failedOnly, setFailedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (f: ChannelFilter, p: number, failed: boolean) => {
      if (!tenantId) {
        setRows([]);
        setTotal(0);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await Api.communications.history(tenantId, {
          type: f,
          status: failed ? 'failed' : undefined,
          limit: PAGE_SIZE,
          offset: p * PAGE_SIZE,
        });
        if (res?.success) {
          setRows(res.history ?? []);
          setTotal(res.total ?? 0);
        } else {
          setError('Failed to load sent messages.');
        }
      } catch {
        setError('Failed to load sent messages.');
      } finally {
        setLoading(false);
      }
    },
    [tenantId]
  );

  useEffect(() => {
    setPage(0);
    void load(filter, 0, failedOnly);
  }, [filter, failedOnly, load]);

  function handleFilterChange(f: ChannelFilter) {
    setFilter(f);
  }

  function handlePrev() {
    const next = Math.max(0, page - 1);
    setPage(next);
    void load(filter, next, failedOnly);
  }

  function handleNext() {
    const maxPage = Math.ceil(total / PAGE_SIZE) - 1;
    const next = Math.min(maxPage, page + 1);
    setPage(next);
    void load(filter, next, failedOnly);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b shrink-0"
        style={{ borderColor: 'var(--border-soft)', backgroundColor: 'var(--bg-surface)' }}
      >
        <div className="flex items-center gap-3">
          <div className="flex gap-1" role="group" aria-label="Filter by channel">
            {(['all', 'sms', 'email'] as ChannelFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => handleFilterChange(f)}
                className="px-3 py-1 rounded text-xs font-medium transition-colors"
                style={
                  filter === f
                    ? { backgroundColor: 'var(--accent)', color: 'var(--accent-text)' }
                    : { color: 'var(--text-secondary)' }
                }
              >
                {f === 'all' ? 'All' : f === 'sms' ? 'SMS' : 'Email'}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-pressed={failedOnly}
            onClick={() => setFailedOnly((v) => !v)}
            className="px-3 py-1 rounded text-xs font-medium transition-colors"
            style={
              failedOnly
                ? { backgroundColor: 'var(--accent)', color: 'var(--accent-text)' }
                : { color: 'var(--text-secondary)' }
            }
          >
            Failed only
          </button>
        </div>
        <button
          type="button"
          onClick={() => void load(filter, page, failedOnly)}
          className="p-1.5 rounded transition-colors"
          style={{ color: 'var(--text-secondary)' }}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div
            className="flex items-center justify-center py-12"
            style={{ color: 'var(--text-secondary)' }}
          >
            <RefreshCw className="w-5 h-5 animate-spin mr-2" />
            Loading…
          </div>
        )}

        {!loading && error && (
          <div
            className="flex items-center gap-2 px-4 py-4 text-sm"
            style={{ color: 'var(--danger)' }}
          >
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center px-6">
            <Mail className="w-10 h-10 mb-3" style={{ color: 'var(--text-muted)' }} />
            <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>
              {failedOnly ? 'No failed deliveries' : 'No sent messages'}
            </p>
            <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
              {failedOnly
                ? 'Messages that could not be delivered appear here.'
                : 'Outbound SMS and email confirmations appear here.'}
            </p>
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr
                className="text-xs font-medium uppercase tracking-wide border-b"
                style={{
                  color: 'var(--text-secondary)',
                  borderColor: 'var(--border-soft)',
                  backgroundColor: 'var(--bg-raised)',
                }}
              >
                <th className="px-4 py-2 text-left w-20">Channel</th>
                <th className="px-4 py-2 text-left">Recipient</th>
                <th className="px-4 py-2 text-left">Message</th>
                <th className="px-4 py-2 text-left w-24">Status</th>
                <th className="px-4 py-2 text-left w-36">Sent</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.communications_history_id}
                  className="border-b hover:brightness-105 transition-colors"
                  style={{ borderColor: 'var(--border-soft)' }}
                >
                  <td className="px-4 py-2.5">
                    <span
                      className="flex items-center gap-1 text-xs font-medium"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {row.channel === 'sms' ? (
                        <MessageSquare className="w-3.5 h-3.5" />
                      ) : (
                        <Mail className="w-3.5 h-3.5" />
                      )}
                      {row.channel.toUpperCase()}
                    </span>
                  </td>
                  <td
                    className="px-4 py-2.5 font-mono text-xs"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {row.recipient}
                  </td>
                  <td className="px-4 py-2.5 max-w-xs" style={{ color: 'var(--text-primary)' }}>
                    {row.subject && <p className="font-medium truncate">{row.subject}</p>}
                    <p className="truncate text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {row.body}
                    </p>
                    {row.status === 'failed' && row.error && (
                      <p
                        className="text-xs mt-0.5"
                        style={{ color: 'var(--text-secondary)' }}
                        title={row.error}
                      >
                        Delivery error: {row.error}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {new Date(row.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div
          className="flex items-center justify-between px-4 py-2 border-t text-xs shrink-0"
          style={{ borderColor: 'var(--border-soft)', color: 'var(--text-secondary)' }}
        >
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              aria-label="Previous page"
              onClick={handlePrev}
              disabled={page === 0}
              className="p-1 rounded disabled:opacity-40"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              aria-label="Next page"
              onClick={handleNext}
              disabled={page >= totalPages - 1}
              className="p-1 rounded disabled:opacity-40"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const style =
    status === 'sent' || status === 'delivered'
      ? { backgroundColor: 'var(--success-bg)', color: 'var(--success)' }
      : status === 'failed'
        ? { backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }
        : { backgroundColor: 'var(--bg-raised)', color: 'var(--text-secondary)' };

  return (
    <span className="px-1.5 py-0.5 rounded text-xs font-medium" style={style}>
      {status}
    </span>
  );
}
