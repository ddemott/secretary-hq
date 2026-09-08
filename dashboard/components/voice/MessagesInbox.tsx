/**
 * Messages inbox — everything a caller left behind, in one place.
 *
 * It used to be messages ONLY, and that was the bug: on 2026-07-27 a recruiter
 * call captured a complete job inquiry (agency, client, role, rate, location),
 * the call's outcome said "message", and this inbox was EMPTY — the lead lived
 * in its own table with no route, no client method and no screen
 * (CALL_IMPROVEMENTS.md #1). The owner would have had to know to go looking
 * somewhere that did not exist. A lead nobody can find is a lead nobody called
 * back, so job inquiries render here, in the same list, marked for what they are.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { Mail, MailOpen, RefreshCw, CheckCircle, Briefcase, AlertTriangle } from 'lucide-react';
import { type CustomerMessage, type JobInquiry } from '@/lib/types';
import { Api } from '../../lib/api';
import { formatPhone } from '../../lib/phone';
import { formatPayRangeDisplay } from '../../../shared/payRange';
import { showToast } from '../ui/Toast';

/** One row of the inbox: a message the caller dictated, or a job lead the
 *  agent captured. Both are "someone left this for you". */
type InboxItem = ({ kind: 'message' } & CustomerMessage) | ({ kind: 'job' } & JobInquiry);

const itemId = (i: InboxItem): string => (i.kind === 'message' ? i.message_id : i.job_inquiry_id);

/** The one-line preview a job lead shows in the list — role first, because that
 *  is what tells the owner whether to call back. */
function jobPreview(j: JobInquiry): string {
  const where =
    j.represents_company === false && j.client_company
      ? `${j.client_company}${j.caller_company ? ` via ${j.caller_company}` : ''}`
      : (j.caller_company ?? '');
  return [j.role_description, where, j.rate_range].filter(Boolean).join(' — ') || 'Job inquiry';
}

export function MessagesInbox({ tenantId }: { tenantId: string | null }) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<InboxItem | null>(null);
  const [filter, setFilter] = useState<'all' | 'new' | 'read' | 'actioned'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Both lists, in parallel. A job inquiry has no read/unread state, so it
      // only appears under "all" — filtering by message status and then showing
      // rows that cannot have one would be its own small lie.
      const [rows, jobs] = await Promise.all([
        Api.voice.listMessages(tenantId, {
          status: filter === 'all' ? undefined : filter,
        }),
        filter === 'all' ? Api.voice.listJobInquiries(tenantId) : Promise.resolve([]),
      ]);
      const merged: InboxItem[] = [
        ...(rows ?? []).map((m) => ({ kind: 'message' as const, ...m })),
        ...(jobs ?? []).map((j) => ({ kind: 'job' as const, ...j })),
      ].sort((a, b) => b.created_at.localeCompare(a.created_at));
      setItems(merged);
    } catch {
      // apiFetch throws on non-2xx — surface it instead of an unhandled
      // rejection + console spam, and leave the list in a known (empty) state.
      showToast('Could not load messages. Please try again.', 'error');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [tenantId, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function markStatus(msg: CustomerMessage, status: 'read' | 'actioned') {
    // updateMessageStatus resolves {success:false} on an HTTP error (throws only
    // on network) — don't optimistically flip the UI if the backend rejected it.
    const res = await Api.voice
      .updateMessageStatus(msg.message_id, status)
      .catch(() => ({ success: false }));
    if (!res.success) {
      showToast('Could not update the message. Please try again.', 'error');
      return;
    }
    setItems((prev) =>
      prev.map((i) =>
        i.kind === 'message' && i.message_id === msg.message_id ? { ...i, status } : i
      )
    );
    if (selected?.kind === 'message' && selected.message_id === msg.message_id) {
      setSelected({ kind: 'message', ...msg, status });
    }
  }

  async function handleSelect(item: InboxItem) {
    setSelected(item);
    // A job inquiry has no read/unread state to advance — it is a record, not
    // an errand. Opening it must not pretend otherwise.
    if (item.kind === 'message' && item.status === 'new') {
      const { kind: _kind, ...msg } = item;
      await markStatus(msg, 'read');
    }
  }

  const newCount = items.filter((i) => i.kind === 'message' && i.status === 'new').length;

  return (
    <div className="flex h-full">
      {/* List */}
      <div
        className="w-80 border-r flex flex-col"
        style={{ borderColor: 'var(--border-soft)', backgroundColor: 'var(--bg-surface)' }}
      >
        <div className="p-4 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center justify-between mb-3">
            <h2
              className="text-lg font-semibold flex items-center gap-2"
              style={{ color: 'var(--text-primary)' }}
            >
              <Mail className="w-5 h-5" />
              Messages
              {newCount > 0 && (
                <span
                  className="text-xs font-bold px-1.5 py-0.5 rounded-full"
                  style={{ backgroundColor: 'var(--accent)', color: 'var(--primary-text)' }}
                >
                  {newCount}
                </span>
              )}
            </h2>
            <button
              onClick={() => void load()}
              className="p-2 rounded-lg"
              style={{ color: 'var(--text-secondary)' }}
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
          <div className="flex gap-1">
            {(['all', 'new', 'read', 'actioned'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="text-xs px-2 py-1 rounded capitalize"
                style={
                  filter === f
                    ? { backgroundColor: 'var(--accent)', color: 'var(--primary-text)' }
                    : { backgroundColor: 'var(--bg-raised)', color: 'var(--text-secondary)' }
                }
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-[var(--border-soft)]">
          {loading && (
            <div className="p-4 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
              Loading…
            </div>
          )}
          {!loading && items.length === 0 && (
            <div className="p-8 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
              Nothing here yet. Messages and job leads from calls appear here.
            </div>
          )}
          {items.map((item) => {
            const msg = item.kind === 'message' ? item : null;
            const job = item.kind === 'job' ? item : null;
            return (
              <div
                key={itemId(item)}
                role="button"
                tabIndex={0}
                aria-pressed={selected != null && itemId(selected) === itemId(item)}
                className="p-3 cursor-pointer hover:brightness-110 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
                style={
                  selected != null && itemId(selected) === itemId(item)
                    ? {
                        backgroundColor: 'var(--accent-muted)',
                        borderLeft: '2px solid var(--accent)',
                      }
                    : undefined
                }
                onClick={() => void handleSelect(item)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void handleSelect(item);
                  }
                }}
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    className="font-medium text-sm flex items-center gap-1.5"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {job ? (
                      <Briefcase className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
                    ) : msg!.status === 'new' ? (
                      <Mail className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
                    ) : (
                      <MailOpen
                        className="w-3.5 h-3.5"
                        style={{ color: 'var(--text-secondary)' }}
                      />
                    )}
                    {item.caller_name ?? 'Unknown'}
                    {/* The caller's own escalation, not our guess at one. */}
                    {msg?.is_urgent && (
                      <span
                        className="text-[10px] font-bold px-1 py-0.5 rounded inline-flex items-center gap-0.5"
                        style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}
                      >
                        <AlertTriangle className="w-3 h-3" />
                        URGENT
                      </span>
                    )}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {new Date(item.created_at).toLocaleDateString()}
                  </span>
                </div>
                {job && (
                  <div
                    className="text-[10px] uppercase tracking-wide mb-0.5"
                    style={{ color: 'var(--accent)' }}
                  >
                    Job lead
                  </div>
                )}
                <p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                  {job ? jobPreview(job) : msg!.message}
                </p>
                {item.callback_phone && (
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                    {formatPhone(item.callback_phone)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail */}
      <div
        className="flex-1 flex flex-col overflow-hidden"
        style={{ backgroundColor: 'var(--bg-base)' }}
      >
        {!selected ? (
          <div
            className="flex-1 flex items-center justify-center text-sm"
            style={{ color: 'var(--text-secondary)' }}
          >
            Select a message or job lead to read it
          </div>
        ) : selected.kind === 'job' ? (
          /* A JOB LEAD. Every field the call captured, laid out so the owner can
             decide whether to ring back without opening anything else — the
             whole failure in #1 was that this record existed and was invisible. */
          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-xl">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {selected.caller_name ?? 'Unknown caller'}
                  </h3>
                  <div className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                    {new Date(selected.created_at).toLocaleString()}
                  </div>
                </div>
                <span
                  className="text-xs px-2 py-1 rounded flex items-center gap-1"
                  style={{ backgroundColor: 'var(--accent)', color: 'var(--primary-text)' }}
                >
                  <Briefcase className="w-3 h-3" />
                  Job lead
                </span>
              </div>

              {selected.callback_phone && (
                <div
                  className="mb-4 p-3 rounded-lg text-sm"
                  style={{ backgroundColor: 'var(--bg-surface)' }}
                >
                  <div className="font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Contact
                  </div>
                  <div style={{ color: 'var(--text-primary)' }}>
                    Callback: {formatPhone(selected.callback_phone)}
                  </div>
                </div>
              )}

              <dl
                className="p-4 rounded-lg text-sm space-y-2"
                style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
              >
                {[
                  ['Role', selected.role_description],
                  /* TWO companies, kept apart exactly as the intake keeps them:
                     who rang, and where the work actually is. */
                  ['Client (where the work is)', selected.client_company],
                  ['Caller works for', selected.caller_company],
                  ['Employment type', selected.employment_type],
                  ['Rate', selected.rate_range ? formatPayRangeDisplay(selected.rate_range) : null],
                  ['Duration', selected.duration],
                  ['Location', selected.location_type],
                  ['Address', selected.address],
                  ['Timezone', selected.timezone],
                ]
                  .filter(([, v]) => v)
                  .map(([label, value]) => (
                    <div key={label as string} className="flex gap-2">
                      <dt className="w-44 shrink-0" style={{ color: 'var(--text-secondary)' }}>
                        {label}
                      </dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-xl">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3
                    className="text-lg font-semibold flex items-center gap-2"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {selected.caller_name ?? 'Unknown caller'}
                    {selected.is_urgent && (
                      <span
                        className="text-xs font-bold px-1.5 py-0.5 rounded inline-flex items-center gap-1"
                        style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}
                      >
                        <AlertTriangle className="w-3 h-3" />
                        URGENT
                      </span>
                    )}
                  </h3>
                  <div className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                    {new Date(selected.created_at).toLocaleString()}
                  </div>
                </div>
                <span
                  className="text-xs px-2 py-1 rounded capitalize"
                  style={
                    selected.status === 'new'
                      ? { backgroundColor: 'var(--accent)', color: 'var(--primary-text)' }
                      : selected.status === 'actioned'
                        ? { backgroundColor: 'var(--success)', color: 'var(--primary-text)' }
                        : { backgroundColor: 'var(--bg-raised)', color: 'var(--text-secondary)' }
                  }
                >
                  {selected.status}
                </span>
              </div>

              {(selected.callback_phone || selected.caller_phone) && (
                <div
                  className="mb-4 p-3 rounded-lg text-sm"
                  style={{ backgroundColor: 'var(--bg-surface)' }}
                >
                  <div className="font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
                    Contact
                  </div>
                  {selected.callback_phone && (
                    <div style={{ color: 'var(--text-primary)' }}>
                      Callback: {formatPhone(selected.callback_phone)}
                    </div>
                  )}
                  {selected.caller_phone && selected.caller_phone !== selected.callback_phone && (
                    <div style={{ color: 'var(--text-secondary)' }}>
                      Caller-ID: {formatPhone(selected.caller_phone)}
                    </div>
                  )}
                </div>
              )}

              <div
                className="p-4 rounded-lg text-sm leading-relaxed"
                style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
              >
                {selected.message}
              </div>

              {selected.status !== 'actioned' && (
                <div className="mt-4 flex gap-2">
                  {selected.status === 'new' && (
                    <button
                      onClick={() => {
                        const { kind: _k, ...m } = selected;
                        void markStatus(m, 'read');
                      }}
                      className="text-sm px-3 py-1.5 rounded"
                      style={{
                        backgroundColor: 'var(--bg-raised)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      Mark read
                    </button>
                  )}
                  <button
                    onClick={() => {
                      const { kind: _k, ...m } = selected;
                      void markStatus(m, 'actioned');
                    }}
                    className="text-sm px-3 py-1.5 rounded flex items-center gap-1.5"
                    style={{ backgroundColor: 'var(--success)', color: 'var(--primary-text)' }}
                  >
                    <CheckCircle className="w-3.5 h-3.5" />
                    Mark actioned
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
