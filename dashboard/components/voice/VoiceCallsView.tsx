'use client';

import React, { useEffect, useState } from 'react';
import { type VoiceSession, type VoiceSessionDisplay } from '@/lib/types';
import { Api } from '../../lib/api';
import { useActiveTenantId, useSessionContext } from '../../lib/SessionContext';
import { useConfirm } from '../../lib/useConfirm';
import { ConfirmModal } from '../ui/ConfirmModal';
import { showToast } from '../ui/Toast';
import { FolderTab, FolderTabBar } from '../ui/FolderTabs';
import AnalyticsView from '../analytics/AnalyticsView';
import { CommsSentView } from '../communications/CommsSentView';
import { MessagesInbox } from './MessagesInbox';
import { CallListPanel } from './CallListPanel';
import { CallDetailPanel } from './CallDetailPanel';

type CallsSubTab = 'calls' | 'analytics' | 'messages' | 'sent';

export default function VoiceCallsView() {
  const tenantId = useActiveTenantId();
  const [activeSubTab, setActiveSubTab] = useState<CallsSubTab>('calls');
  const [activeCalls, setActiveCalls] = useState<VoiceSessionDisplay[]>([]);
  const [callHistory, setCallHistory] = useState<VoiceSession[]>([]);
  const [selectedCall, setSelectedCall] = useState<VoiceSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // A failed "Load more" (page 2+) keeps the rows already on screen and reports
  // the failure beside the button instead — see fetchCallHistory's catch.
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [outcomeFilter, setOutcomeFilter] = useState<string>('all');
  const { role } = useSessionContext();
  const isOwner = role === 'owner';
  const { state: confirmState, confirm: confirmAction, close: closeConfirm } = useConfirm();
  const [deleteWindowDays, setDeleteWindowDays] = useState(90);

  useEffect(() => {
    if (tenantId) {
      void fetchActiveCalls();
      void fetchCallHistory();
    }
    const interval = setInterval(() => {
      if (tenantId) {
        void fetchActiveCalls();
        void fetchCallHistory(0, { silent: true });
      }
    }, 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function fetchActiveCalls() {
    try {
      const data = await Api.voice.getActiveCalls(tenantId);
      setActiveCalls(data.calls || []);
    } catch (err) {
      console.error('Failed to fetch active calls:', err);
      setActiveCalls([]);
    }
  }

  async function fetchCallHistory(offset = 0, opts: { silent?: boolean } = {}) {
    if (!opts.silent) {
      if (offset === 0) {
        setLoading(true);
        setHistoryError(null);
      } else {
        setHistoryLoading(true);
        setLoadMoreError(null);
      }
    }

    try {
      const data = await Api.voice.getHistory(tenantId, { limit: 20, offset });
      if (offset === 0) {
        const fresh = data.calls || [];
        if (opts.silent && fresh.length === 0) return;
        if (opts.silent) {
          setCallHistory((prev) => {
            if (prev.length <= fresh.length) return fresh;
            const freshIds = new Set(fresh.map((c) => c.voice_session_id));
            const oldestFreshMs = Date.parse(fresh[fresh.length - 1].started_at);
            const olderRows = prev.filter(
              (c) => !freshIds.has(c.voice_session_id) && Date.parse(c.started_at) < oldestFreshMs
            );
            return [...fresh, ...olderRows];
          });
        } else {
          setCallHistory(fresh);
        }
        setSelectedCall((prev) => {
          if (!prev) return fresh.length > 0 ? fresh[0] : null;
          return fresh.find((c) => c.voice_session_id === prev.voice_session_id) ?? prev;
        });
      } else {
        setCallHistory((prev) => [...prev, ...(data.calls || [])]);
      }
      setTotal(data.total || 0);
      setHasMore(data.has_more || false);
    } catch (err) {
      console.error('Failed to fetch call history:', err);
      // A load failure and an honestly-empty history are different facts for
      // the owner reading the list — don't let a failed request read as
      // "no calls yet". Only surfaced for a user-visible (non-silent) fetch;
      // the background poll stays quiet so a transient blip doesn't flash an
      // error banner over an already-loaded list.
      if (!opts.silent) {
        if (offset === 0) {
          setCallHistory([]);
          setHistoryError('Could not load call history. Please try again.');
        } else {
          // "Load more" failed: the first pages are still perfectly good. Wiping
          // them here used to leave an empty list under the "No call history
          // yet" copy for a tenant that has calls. Keep them, say what failed.
          setLoadMoreError('Could not load more calls. Please try again.');
        }
      }
    } finally {
      if (!opts.silent) {
        setLoading(false);
        setHistoryLoading(false);
      }
    }
  }

  function handleRefresh() {
    void fetchActiveCalls();
    void fetchCallHistory();
  }

  function handleLoadMore() {
    if (!historyLoading && hasMore) {
      void fetchCallHistory(callHistory.length);
    }
  }

  function handleDeleteCall(call: VoiceSession) {
    confirmAction({
      title: 'Delete this call?',
      message:
        'It will be removed from your call history and analytics. The record is kept hidden and can be restored by support if needed.',
      confirmLabel: 'Delete call',
      confirmVariant: 'danger',
      onConfirm: () => {
        closeConfirm();
        void (async () => {
          try {
            await Api.voice.deleteCall(tenantId, call.voice_session_id);
            showToast('Call deleted', 'success');
            setSelectedCall((prev) =>
              prev?.voice_session_id === call.voice_session_id ? null : prev
            );
            void fetchCallHistory();
            void fetchActiveCalls();
          } catch (err) {
            showToast(err instanceof Error ? err.message : 'Failed to delete call', 'error');
          }
        })();
      },
    });
  }

  function handleDeleteOld() {
    confirmAction({
      title: `Delete calls older than ${deleteWindowDays} days?`,
      message:
        'All finished calls older than this will be removed from your history and analytics (active calls are kept). Records are hidden, not erased.',
      confirmLabel: 'Delete old calls',
      confirmVariant: 'danger',
      onConfirm: () => {
        closeConfirm();
        void (async () => {
          try {
            const res = await Api.voice.deleteOldCalls(tenantId, deleteWindowDays);
            const n = res.result?.deleted ?? 0;
            showToast(
              n === 0 ? 'No calls were old enough to delete' : `Deleted ${n} old call(s)`,
              'success'
            );
            if (n > 0) setSelectedCall(null);
            void fetchCallHistory();
            void fetchActiveCalls();
          } catch (err) {
            showToast(err instanceof Error ? err.message : 'Failed to delete old calls', 'error');
          }
        })();
      },
    });
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-full">
      <FolderTabBar size="sm" ariaLabel="Calls sections">
        <FolderTab
          label="Recent Calls"
          size="sm"
          isActive={activeSubTab === 'calls'}
          onClick={() => setActiveSubTab('calls')}
        />
        <FolderTab
          label="Analytics"
          size="sm"
          isActive={activeSubTab === 'analytics'}
          onClick={() => setActiveSubTab('analytics')}
        />
        <FolderTab
          label="Messages"
          size="sm"
          isActive={activeSubTab === 'messages'}
          onClick={() => setActiveSubTab('messages')}
        />
        <FolderTab
          label="Sent"
          size="sm"
          isActive={activeSubTab === 'sent'}
          onClick={() => setActiveSubTab('sent')}
        />
      </FolderTabBar>
      {activeSubTab === 'analytics' && (
        <div className="flex-1 overflow-y-auto">
          <AnalyticsView />
        </div>
      )}
      {activeSubTab === 'messages' && (
        <div className="flex-1 overflow-hidden">
          <MessagesInbox tenantId={tenantId} />
        </div>
      )}
      {activeSubTab === 'sent' && (
        <div className="flex-1 overflow-hidden">
          <CommsSentView tenantId={tenantId} />
        </div>
      )}
      {activeSubTab === 'calls' && (
        <div className="flex h-full">
          <CallListPanel
            activeCalls={activeCalls}
            callHistory={callHistory}
            selectedCall={selectedCall}
            loading={loading}
            historyLoading={historyLoading}
            historyError={historyError}
            loadMoreError={loadMoreError}
            total={total}
            hasMore={hasMore}
            outcomeFilter={outcomeFilter}
            deleteWindowDays={deleteWindowDays}
            isOwner={isOwner}
            tenantId={tenantId}
            onRefresh={handleRefresh}
            onSelectCall={setSelectedCall}
            onDeleteOld={handleDeleteOld}
            onLoadMore={handleLoadMore}
            onFilterChange={setOutcomeFilter}
            onWindowChange={setDeleteWindowDays}
          />
          <CallDetailPanel
            selectedCall={selectedCall}
            isOwner={isOwner}
            onDeleteCall={handleDeleteCall}
          />
        </div>
      )}
      <ConfirmModal {...confirmState} onClose={closeConfirm} />
    </div>
  );
}
