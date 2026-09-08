'use client';

import React from 'react';
import { Phone } from 'lucide-react';
import { EmptyState } from '../ui/EmptyState';

interface CallSummary {
  call_summary_id: string;
  customer_id: string;
  summary: string;
  call_timestamp?: string;
  created_at?: string;
  has_transcript?: boolean;
}

interface CustomerCallHistoryProps {
  summaries: CallSummary[];
}

export function CustomerCallHistory({ summaries }: CustomerCallHistoryProps) {
  return (
    <div id="customer-calls" className="space-y-4">
      <h3 className="font-bold flex items-center text-lg" style={{ color: 'var(--text-primary)' }}>
        <Phone className="w-5 h-5 mr-2" style={{ color: 'var(--text-muted)' }} />
        AI Call History
      </h3>
      <div className="space-y-4">
        {summaries.length > 0 ? (
          summaries.map((s) => (
            <div
              key={s.call_summary_id}
              className="p-5 rounded-xl shadow-sm"
              style={{
                border: '1px solid var(--border-soft)',
                backgroundColor: 'var(--bg-surface)',
              }}
            >
              <div
                className="flex justify-between text-xs mb-2"
                style={{ color: 'var(--text-muted)' }}
              >
                <span className="font-bold uppercase" style={{ color: 'var(--accent-soft)' }}>
                  AI Summary
                </span>
                <span>{new Date(s.call_timestamp || s.created_at || '').toLocaleDateString()}</span>
              </div>
              <p
                className="text-sm leading-relaxed italic"
                style={{ color: 'var(--text-secondary)' }}
              >
                &quot;{s.summary}&quot;
              </p>
              {s.has_transcript && (
                <p className="text-xs text-green-600 dark:text-green-400 mt-2">
                  Transcript available
                </p>
              )}
            </div>
          ))
        ) : (
          <EmptyState icon={Phone} title="No call history" variant="compact" />
        )}
      </div>
    </div>
  );
}

export type { CallSummary };
