'use client';

/**
 * From/To date-range controls for the Analytics call + cohort cuts.
 * Empty state = all-time; "Clear dates" resets both ends.
 * Extracted from AnalyticsView.tsx (dense-view decomposition).
 */

import React from 'react';

interface DateRangePickerProps {
  startDate: string;
  endDate: string;
  onStartChange: (v: string) => void;
  onEndChange: (v: string) => void;
}

export function DateRangePicker({
  startDate,
  endDate,
  onStartChange,
  onEndChange,
}: DateRangePickerProps) {
  return (
    <div className="flex flex-wrap items-end gap-3 mb-6">
      <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
        From
        <input
          type="date"
          aria-label="From date"
          value={startDate}
          max={endDate || undefined}
          onChange={(e) => onStartChange(e.target.value)}
          className="rounded-lg px-2 py-1 text-sm border"
          style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
        To
        <input
          type="date"
          aria-label="To date"
          value={endDate}
          min={startDate || undefined}
          onChange={(e) => onEndChange(e.target.value)}
          className="rounded-lg px-2 py-1 text-sm border"
          style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
        />
      </label>
      {(startDate || endDate) && (
        <button
          type="button"
          onClick={() => {
            onStartChange('');
            onEndChange('');
          }}
          className="rounded-lg px-3 py-1 text-xs underline"
          style={{ color: 'var(--text-muted)' }}
        >
          Clear dates
        </button>
      )}
    </div>
  );
}
