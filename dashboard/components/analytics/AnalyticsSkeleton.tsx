'use client';

/**
 * Pulse skeleton for the initial Analytics load — shown only on the very first
 * fetch when there is no previously-loaded data to keep on screen.
 * Extracted from AnalyticsView.tsx (dense-view decomposition).
 */

import React from 'react';

export function AnalyticsSkeleton() {
  return (
    <div
      className="flex-1 overflow-auto p-6"
      style={{ backgroundColor: 'var(--bg-base)' }}
      aria-label="Loading analytics"
      aria-busy="true"
    >
      <div className="max-w-5xl mx-auto">
        <div
          className="h-8 w-32 rounded-lg mb-1 animate-pulse"
          style={{ backgroundColor: 'var(--bg-raised)' }}
        />
        <div
          className="h-4 w-64 rounded mb-6 animate-pulse"
          style={{ backgroundColor: 'var(--bg-raised)' }}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl p-5"
              style={{
                backgroundColor: 'var(--bg-card)',
                border: '1px solid var(--border-soft)',
              }}
            >
              <div
                className="h-4 w-24 rounded mb-2 animate-pulse"
                style={{ backgroundColor: 'var(--bg-raised)' }}
              />
              <div
                className="h-3 w-40 rounded mb-3 animate-pulse"
                style={{ backgroundColor: 'var(--bg-raised)' }}
              />
              <div
                className="h-16 rounded-lg animate-pulse"
                style={{ backgroundColor: 'var(--bg-raised)' }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
