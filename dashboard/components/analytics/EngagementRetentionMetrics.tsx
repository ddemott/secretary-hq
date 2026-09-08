'use client';

import React from 'react';
import { ListChecks, Repeat, UserX } from 'lucide-react';
import type { AnalyticsCalls, AnalyticsCohorts } from '../../lib/types';
import type { AppointmentSummary } from './types';
import { MetricCard } from './MetricCard';
import { DAY_NAMES, labelForOutcome } from './callOutcomeLabels';

interface EngagementRetentionMetricsProps {
  hasCalls: boolean;
  totalCalls: number;
  byOutcome: AnalyticsCalls['by_outcome'];
  summary: AppointmentSummary | null;
  cohorts: AnalyticsCohorts | null;
}

export function EngagementRetentionMetrics({
  hasCalls,
  totalCalls,
  byOutcome,
  summary,
  cohorts,
}: EngagementRetentionMetricsProps) {
  return (
    <>
      {/* 5. Why callers reached out — outcome breakdown (the WHY cut) */}
      <MetricCard
        icon={ListChecks}
        title="Why Callers Reached Out"
        subtitle="What each call resulted in"
      >
        {hasCalls && byOutcome.length > 0 ? (
          <div className="space-y-2">
            {byOutcome.slice(0, 5).map((o) => {
              const pct = totalCalls > 0 ? Math.round((o.count / totalCalls) * 100) : 0;
              return (
                <div key={o.outcome}>
                  <div className="flex justify-between text-xs mb-1">
                    <span style={{ color: 'var(--text-secondary)' }} className="truncate mr-2">
                      {labelForOutcome(o.outcome)}
                    </span>
                    <span style={{ color: 'var(--text-primary)' }} className="font-medium shrink-0">
                      {o.count} ({pct}%)
                    </span>
                  </div>
                  <div
                    className="h-1 rounded-full"
                    style={{ backgroundColor: 'var(--border-soft)' }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: 'var(--accent-soft)',
                        opacity: 0.7,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            No calls logged yet
          </p>
        )}
      </MetricCard>

      {/* 6. Return Rate by First Service — from appointments */}
      <MetricCard
        icon={Repeat}
        title="Return Rate by First Service"
        subtitle="Of first-time customers, how many came back?"
      >
        {summary && Object.keys(summary.returnRate).length > 0 ? (
          <div className="space-y-2">
            {Object.entries(summary.returnRate)
              .sort(([, a], [, b]) => b.first - a.first)
              .slice(0, 5)
              .map(([svc, data]) => {
                const rate = data.first > 0 ? Math.round((data.returned / data.first) * 100) : 0;
                return (
                  <div key={svc}>
                    <div className="flex justify-between text-xs mb-1">
                      <span style={{ color: 'var(--text-secondary)' }} className="truncate mr-2">
                        {svc}
                      </span>
                      <span
                        style={{ color: 'var(--text-primary)' }}
                        className="font-medium shrink-0"
                      >
                        {rate}% ({data.returned}/{data.first})
                      </span>
                    </div>
                    <div
                      className="h-1 rounded-full"
                      style={{ backgroundColor: 'var(--border-soft)' }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${rate}%`,
                          backgroundColor: 'var(--accent-soft)',
                          opacity: 0.7,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            No repeat customer data yet
          </p>
        )}
      </MetricCard>

      {/* 7. Cancellation Pattern — from appointments (status === 'canceled') */}
      <MetricCard
        icon={UserX}
        title="Cancellation Pattern"
        subtitle="Canceled appointments by day of week"
      >
        {summary ? (
          <div>
            <div className="flex gap-2 mt-1">
              {DAY_NAMES.map((day) => {
                const count = summary.noShowsByDay[day] || 0;
                return (
                  <div key={day} className="flex-1 text-center">
                    <div
                      className="text-xs font-bold rounded-md py-1 mb-1"
                      style={{
                        backgroundColor: 'var(--bg-raised)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {count}
                    </div>
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {day}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            No data yet
          </p>
        )}
      </MetricCard>

      {/* 8. Repeat callers — who reaches out more than once + how often they book */}
      <MetricCard
        icon={Repeat}
        title="Repeat Callers"
        subtitle="Callers who reached out more than once"
      >
        {cohorts && cohorts.summary.repeat_callers > 0 ? (
          <div className="space-y-2">
            <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
              {cohorts.summary.repeat_callers}
              <span className="text-sm font-normal" style={{ color: 'var(--text-muted)' }}>
                {' '}
                of {cohorts.summary.distinct_callers} callers
              </span>
            </div>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {cohorts.summary.total_calls > 0
                ? Math.round(
                    (cohorts.summary.repeat_call_volume / cohorts.summary.total_calls) * 100
                  )
                : 0}
              % of all calls come from repeat callers
            </p>
            <div className="space-y-1 pt-1">
              {cohorts.repeat_callers.slice(0, 5).map((c) => (
                <div key={c.phone} className="flex justify-between text-xs">
                  <span style={{ color: 'var(--text-secondary)' }}>{c.phone}</span>
                  <span style={{ color: 'var(--text-primary)' }} className="font-medium">
                    {c.call_count} calls · {c.booked_count} booked
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            No repeat callers yet
          </p>
        )}
      </MetricCard>
    </>
  );
}
