'use client';

import React from 'react';
import { type VoiceSession, type VoiceSessionDisplay } from '@/lib/types';
import { Phone, PhoneOff, RefreshCw, Filter, Trash2, AlertCircle } from 'lucide-react';
import { ActiveCallRow, HistoryCallRow } from './CallRows';

interface CallListPanelProps {
  activeCalls: VoiceSessionDisplay[];
  callHistory: VoiceSession[];
  selectedCall: VoiceSession | null;
  loading: boolean;
  historyLoading: boolean;
  /** Set when the last non-silent history fetch failed — kept distinct from a
   *  genuinely empty history so a fetch failure never reads as "no calls yet". */
  historyError: string | null;
  total: number;
  hasMore: boolean;
  outcomeFilter: string;
  deleteWindowDays: number;
  isOwner: boolean;
  tenantId: string | null;
  onRefresh: () => void;
  onSelectCall: (call: VoiceSession) => void;
  onDeleteOld: () => void;
  onLoadMore: () => void;
  onFilterChange: (val: string) => void;
  onWindowChange: (val: number) => void;
}

export function CallListPanel({
  activeCalls,
  callHistory,
  selectedCall,
  loading,
  historyLoading,
  historyError,
  total,
  hasMore,
  outcomeFilter,
  deleteWindowDays,
  isOwner,
  tenantId,
  onRefresh,
  onSelectCall,
  onDeleteOld,
  onLoadMore,
  onFilterChange,
  onWindowChange,
}: CallListPanelProps) {
  return (
    <div
      className="w-80 border-r flex flex-col"
      style={{ borderColor: 'var(--border-soft)', backgroundColor: 'var(--bg-surface)' }}
    >
      {/* Header */}
      <div className="p-4 border-b" style={{ borderColor: 'var(--border-soft)' }}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
            Voice Calls
          </h2>
          <button
            onClick={onRefresh}
            className="p-2 rounded-lg transition-colors"
            style={{ color: 'var(--text-secondary)' }}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Active Calls */}
      {activeCalls.length > 0 && (
        <div className="border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="px-4 py-2" style={{ backgroundColor: 'rgba(34,197,94,0.1)' }}>
            <h3
              className="text-sm font-medium flex items-center gap-2"
              style={{ color: 'var(--green, #22c55e)' }}
            >
              <Phone className="w-4 h-4 animate-pulse" />
              Active Calls ({activeCalls.length})
            </h3>
          </div>
          <div className="divide-y">
            {activeCalls.map((call) => (
              <ActiveCallRow
                key={call.voice_session_id}
                call={call}
                tenantId={tenantId}
                onSelect={onSelectCall}
              />
            ))}
          </div>
        </div>
      )}

      {/* Call History */}
      <div className="flex-1 overflow-y-auto">
        <div
          className="px-4 py-2 sticky top-0 flex items-center justify-between gap-2"
          style={{ backgroundColor: 'var(--bg-raised)' }}
        >
          <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            Call History ({total})
          </h3>
          <select
            value={outcomeFilter}
            onChange={(e) => onFilterChange(e.target.value)}
            aria-label="Filter calls by outcome"
            className="text-xs border rounded px-1.5 py-1"
            style={{
              backgroundColor: 'var(--bg-surface)',
              borderColor: 'var(--border-soft)',
              color: 'var(--text-primary)',
            }}
          >
            <option value="all">All outcomes</option>
            <option value="booked">Booked</option>
            <option value="transferred">Transferred</option>
            <option value="message">Left a message</option>
            <option value="job_inquiry">Job inquiry</option>
            <option value="no_availability">No availability</option>
            <option value="wrong_service">Wrong service</option>
            <option value="price">Price concern</option>
            <option value="info">Question only</option>
            <option value="no_outcome">No clear outcome</option>
          </select>
          {isOwner && (
            <div className="flex items-center gap-1">
              <select
                value={deleteWindowDays}
                onChange={(e) => onWindowChange(Number(e.target.value))}
                aria-label="Call deletion age window"
                className="text-xs border rounded px-1.5 py-1"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  borderColor: 'var(--border-soft)',
                  color: 'var(--text-primary)',
                }}
              >
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={180}>180 days</option>
                <option value={365}>1 year</option>
              </select>
              <button
                onClick={onDeleteOld}
                title={`Delete calls older than ${deleteWindowDays} days`}
                aria-label={`Delete calls older than ${deleteWindowDays} days`}
                className="p-1 rounded transition-colors"
                style={{ color: 'var(--danger)' }}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>

        {loading ? (
          <div
            className="flex items-center justify-center py-8"
            aria-label="Loading call history"
            aria-busy="true"
          >
            <RefreshCw className="w-6 h-6 text-gray-400 animate-spin" aria-hidden="true" />
          </div>
        ) : historyError ? (
          // A fetch failure and a genuinely empty history are different facts —
          // rendering them the same tells the owner "no calls ever" when the
          // real story is "the request failed". role="alert" so it's announced.
          <div
            role="alert"
            className="flex flex-col items-center justify-center py-8 text-center px-4"
            style={{ color: 'var(--danger)' }}
          >
            <AlertCircle className="w-7 h-7 mb-2" aria-hidden="true" />
            <p className="text-sm font-medium">{historyError}</p>
          </div>
        ) : callHistory.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-gray-500">
            <PhoneOff className="w-8 h-8 mb-2" />
            <p className="text-sm font-medium">No call history yet</p>
            <p className="text-xs mt-1 text-center px-4" style={{ color: 'var(--text-muted)' }}>
              Calls appear here once your AI phone line is active
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {(() => {
              const filtered = callHistory.filter((c) => {
                if (outcomeFilter === 'all') return true;
                // A call with no recorded outcome is the "no clear outcome" bucket.
                if (outcomeFilter === 'no_outcome') return !c.outcome;
                return c.outcome === outcomeFilter;
              });
              if (filtered.length === 0) {
                return (
                  <div className="flex flex-col items-center justify-center py-8 text-gray-500">
                    <Filter className="w-7 h-7 mb-2 opacity-40" aria-hidden="true" />
                    <p className="text-sm font-medium">No calls match this filter</p>
                    <button
                      onClick={() => onFilterChange('all')}
                      className="text-xs mt-2 underline hover:no-underline"
                      style={{ color: 'var(--accent-soft)' }}
                    >
                      Clear filter
                    </button>
                  </div>
                );
              }
              return filtered.map((call) => (
                <HistoryCallRow
                  key={call.voice_session_id}
                  call={call}
                  isSelected={selectedCall?.voice_session_id === call.voice_session_id}
                  onSelect={onSelectCall}
                />
              ));
            })()}

            {hasMore && (
              <div className="p-3">
                <button
                  onClick={onLoadMore}
                  disabled={historyLoading}
                  className="w-full py-2 text-sm disabled:text-gray-400"
                  style={{ color: 'var(--accent-soft)' }}
                >
                  {historyLoading ? 'Loading...' : `Load more (${callHistory.length} of ${total})`}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
