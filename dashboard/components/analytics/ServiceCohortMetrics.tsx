'use client';

import React from 'react';
import { ListChecks, TrendingUp, PhoneOff, CheckCircle2 } from 'lucide-react';
import type { AnalyticsCohorts } from '../../lib/types';
import { MetricCard } from './MetricCard';

interface ServiceCohortMetricsProps {
  cohorts: AnalyticsCohorts | null;
}

export function ServiceCohortMetrics({ cohorts }: ServiceCohortMetricsProps) {
  return (
    <>
      {/* 9. Bookings by service — which services the booked calls actually booked */}
      <MetricCard
        icon={ListChecks}
        title="Bookings by Service"
        subtitle="What booked calls scheduled"
      >
        {cohorts && cohorts.by_service.length > 0 ? (
          (() => {
            const maxBooked = Math.max(...cohorts.by_service.map((s) => s.booked_count), 1);
            return (
              <div className="space-y-2">
                {cohorts.by_service.slice(0, 6).map((s) => (
                  <div key={s.service}>
                    <div className="flex justify-between text-xs mb-1">
                      <span style={{ color: 'var(--text-secondary)' }} className="truncate mr-2">
                        {s.service}
                      </span>
                      <span
                        style={{ color: 'var(--text-primary)' }}
                        className="font-medium shrink-0"
                      >
                        {s.booked_count}
                      </span>
                    </div>
                    <div
                      className="h-1 rounded-full"
                      style={{ backgroundColor: 'var(--border-soft)' }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.round((s.booked_count / maxBooked) * 100)}%`,
                          backgroundColor: 'var(--accent-soft)',
                          opacity: 0.7,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            );
          })()
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            No bookings yet
          </p>
        )}
      </MetricCard>

      {/* 10. Top customers (CLV) — lifetime booked revenue per customer */}
      <MetricCard icon={TrendingUp} title="Top Customers" subtitle="By lifetime booked revenue">
        {cohorts && cohorts.top_customers.length > 0 ? (
          <div className="space-y-1">
            {cohorts.top_customers.slice(0, 6).map((c) => (
              <div key={c.customer_id} className="flex justify-between text-xs">
                <span style={{ color: 'var(--text-secondary)' }} className="truncate mr-2">
                  {c.name}
                </span>
                <span style={{ color: 'var(--text-primary)' }} className="font-medium shrink-0">
                  ${c.revenue.toFixed(0)} · {c.visits} visit{c.visits === 1 ? '' : 's'}
                </span>
              </div>
            ))}
            <p className="text-xs pt-1" style={{ color: 'var(--text-muted)' }}>
              Revenue uses each service&apos;s price — set prices under My Business for accuracy.
            </p>
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            No bookings yet
          </p>
        )}
      </MetricCard>

      {/* 11. Abandoned by service — callers who tried to book a service but didn't */}
      <MetricCard
        icon={PhoneOff}
        title="Abandoned by Service"
        subtitle="Callers who tried to book but didn't"
      >
        {cohorts && cohorts.abandonment_by_service.length > 0 ? (
          (() => {
            const maxAb = Math.max(
              ...cohorts.abandonment_by_service.map((s) => s.abandoned_count),
              1
            );
            return (
              <div className="space-y-2">
                {cohorts.abandonment_by_service.slice(0, 6).map((s) => (
                  <div key={s.service}>
                    <div className="flex justify-between text-xs mb-1">
                      <span style={{ color: 'var(--text-secondary)' }} className="truncate mr-2">
                        {s.service}
                      </span>
                      <span
                        style={{ color: 'var(--text-primary)' }}
                        className="font-medium shrink-0"
                      >
                        {s.abandoned_count}
                      </span>
                    </div>
                    <div
                      className="h-1 rounded-full"
                      style={{ backgroundColor: 'var(--border-soft)' }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.round((s.abandoned_count / maxAb) * 100)}%`,
                          backgroundColor: 'var(--danger-soft, #ef4444)',
                          opacity: 0.6,
                        }}
                      />
                    </div>
                  </div>
                ))}
                <p className="text-xs pt-1" style={{ color: 'var(--text-muted)' }}>
                  Callers who attempted to book these services but left without an appointment.
                </p>
              </div>
            );
          })()
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            No abandoned bookings recorded yet
          </p>
        )}
      </MetricCard>

      {/* 12. First-time fix — callers resolved on first contact. Optional
          access on first_time_fix so an older backend (field absent)
          degrades to the empty state instead of crashing the grid. */}
      <MetricCard
        icon={CheckCircle2}
        title="First-Time Fix"
        subtitle="Callers whose first call ended in a booking"
      >
        {cohorts?.first_time_fix && cohorts.first_time_fix.rate !== null ? (
          <div>
            <div className="font-display text-3xl" style={{ color: 'var(--text-primary)' }}>
              {Math.round(cohorts.first_time_fix.rate * 100)}%
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
              {cohorts.first_time_fix.first_call_booked} of{' '}
              {cohorts.first_time_fix.distinct_callers} caller
              {cohorts.first_time_fix.distinct_callers === 1 ? '' : 's'} booked on their first call
            </p>
            <div
              className="h-1.5 rounded-full mt-3"
              style={{ backgroundColor: 'var(--border-soft)' }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.round(cohorts.first_time_fix.rate * 100)}%`,
                  backgroundColor: 'var(--accent)',
                  opacity: 0.8,
                }}
              />
            </div>
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            No callers logged yet
          </p>
        )}
      </MetricCard>
    </>
  );
}
