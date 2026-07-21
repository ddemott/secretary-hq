'use client';

/**
 * Analytics — call + booking patterns.
 *
 * Six metrics that answer real business questions:
 * 1. Call Volume Over Time — marketing effectiveness signal (from voice_sessions)
 * 2. Call to Booking Conversion — booked calls / total calls (from voice_sessions)
 * 3. Busiest Hours — when bookings are made (from appointments)
 * 4. Caller Abandonment — calls that ended with no outcome + no booking (from voice_sessions)
 * 5. Return Rate by First Service — which services drive loyalty (from appointments)
 * 6. Cancellation Pattern — which days have the most cancellations (from appointments)
 *
 * Plus a "Why callers reached out" outcome breakdown — the first WHY cut we can
 * surface from the call-level outcome data competitors don't capture. Richer WHY
 * (price / no-availability / wrong-service reasons) needs structured outcome
 * classification that isn't built yet — tracked as a follow-up.
 *
 * Call metrics come from voice_sessions via Api.analytics.getCalls; "booked" is
 * keyed on appointment_id (the hard signal), not the freeform `outcome` text.
 */

import React, { useState, useEffect } from 'react';
import { TrendingUp } from 'lucide-react';
import { Api } from '../lib/api';
import type { AnalyticsCalls, AnalyticsStats, AnalyticsCohorts } from '../lib/types';
import { useActiveTenantId } from '../lib/SessionContext';
import { EmptyState } from './ui/EmptyState';
import { CalendarCheck } from 'lucide-react';
import ReminderDeliveryStats from './ReminderDeliveryStats';
import UtilizationHeatmap from './UtilizationHeatmap';
import type { AppointmentSummary } from './analytics/types';
import { AnalyticsSkeleton } from './analytics/AnalyticsSkeleton';
import { DateRangePicker } from './analytics/DateRangePicker';
import { AnalyticsMetricsGrid } from './analytics/AnalyticsMetricsGrid';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function AnalyticsView() {
  const tenantId = useActiveTenantId();
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<AppointmentSummary | null>(null);
  const [calls, setCalls] = useState<AnalyticsCalls | null>(null);
  const [stats, setStats] = useState<AnalyticsStats | null>(null);
  const [cohorts, setCohorts] = useState<AnalyticsCohorts | null>(null);
  // Optional From/To window for the call + cohort cuts. Empty → all-time.
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    if (!tenantId) return;
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, startDate, endDate]);

  async function loadData() {
    setLoading(true);
    try {
      // The call + cohort cuts honor the From/To window; absent bounds = all-time.
      const range = { start_date: startDate || undefined, end_date: endDate || undefined };
      // Load appointments (the hour/day/return patterns) and call analytics
      // (volume/conversion/abandonment/outcome) in parallel.
      const [appointments, callStats, statsData, cohortRes] = await Promise.all([
        Api.appointments.list(tenantId),
        Api.analytics.getCalls(tenantId, range).catch(() => null),
        Api.analytics.getStats(tenantId).catch(() => null),
        Api.analytics.getCohorts(tenantId, range).catch(() => null),
      ]);

      if (callStats) setCalls(callStats);
      if (statsData) setStats(statsData);
      // Set unconditionally (null on fetch error) so switching tenants never
      // leaves the previous tenant's cohort data on screen.
      setCohorts(cohortRes);

      if (Array.isArray(appointments)) {
        const byDay: Record<string, number> = {};
        const byHour: Record<number, number> = {};
        const noShowsByDay: Record<string, number> = {};
        const allCustomerServices: Record<string, string[]> = {};

        for (const apt of appointments) {
          // By day of week
          const d = new Date(apt.start_time);
          const dayName = DAY_NAMES[d.getDay()];
          byDay[dayName] = (byDay[dayName] || 0) + 1;

          // By hour
          const hour = d.getHours();
          byHour[hour] = (byHour[hour] || 0) + 1;

          // No-shows by day
          if (apt.status === 'canceled') {
            noShowsByDay[dayName] = (noShowsByDay[dayName] || 0) + 1;
          }

          // Track services per customer for return rate
          const custId = apt.customer_id;
          if (custId) {
            if (!allCustomerServices[custId]) allCustomerServices[custId] = [];
            allCustomerServices[custId].push(apt.description || 'Unknown');
          }
        }

        // Return rate by first service
        const returnRate: Record<string, { first: number; returned: number }> = {};
        for (const services of Object.values(allCustomerServices)) {
          const firstSvc = services[0];
          if (!returnRate[firstSvc]) returnRate[firstSvc] = { first: 0, returned: 0 };
          returnRate[firstSvc].first++;
          if (services.length > 1) returnRate[firstSvc].returned++;
        }

        setSummary({ total: appointments.length, byDay, byHour, noShowsByDay, returnRate });
      }
    } catch (err) {
      console.error('Failed to load analytics', err);
    } finally {
      setLoading(false);
    }
  }

  // Full skeleton only on the very first load; a range-change refetch keeps the
  // page (and the date controls) on screen so focus isn't yanked mid-edit.
  if (loading && calls === null && cohorts === null) {
    return <AnalyticsSkeleton />;
  }

  const hasCalls = !!calls && calls.totals.total > 0;
  const hasAppointments = !!summary && summary.total > 0;

  // Bare "no data yet" only when there is no active date filter. With a filter
  // on, fall through to the main view (empty panels) so the From/To controls
  // stay reachable — otherwise an owner who filters into an empty window gets
  // stranded on a dead end with no way to clear it.
  const hasDateFilter = Boolean(startDate || endDate);
  if (!hasCalls && !hasAppointments && !hasDateFilter) {
    return (
      <div className="flex-1 flex" style={{ backgroundColor: 'var(--bg-base)' }}>
        <EmptyState
          icon={CalendarCheck}
          title="No data yet"
          description="Analytics will appear once calls come in and appointments are booked."
        />
      </div>
    );
  }

  // Find busiest hour / day from appointments
  const busiestHour: [string, number] | null =
    summary && hasAppointments
      ? Object.entries(summary.byHour).sort(([, a], [, b]) => b - a)[0]
      : null;
  const busiestDay: [string, number] | null =
    summary && hasAppointments
      ? Object.entries(summary.byDay).sort(([, a], [, b]) => b - a)[0]
      : null;

  // Call analytics derivations (all keyed on appointment_id, never the outcome string).
  const totalCalls = calls?.totals.total ?? 0;
  const bookedCalls = calls?.totals.booked ?? 0;
  const abandonedCalls = calls?.totals.abandoned ?? 0;
  const conversionPct = totalCalls > 0 ? Math.round((bookedCalls / totalCalls) * 100) : 0;
  const abandonmentPct = totalCalls > 0 ? Math.round((abandonedCalls / totalCalls) * 100) : 0;
  const byDay = calls?.by_day ?? [];
  const maxDayVolume = Math.max(...byDay.map((d) => d.total), 1);
  const byOutcome = calls?.by_outcome ?? [];

  // The Call Volume headline number is all-time when no From/To window is set
  // (the /analytics/calls totals are unbounded without a filter) — so a fixed
  // "last 30 days" subtitle mislabeled an all-time count. The sparkline below
  // still shows the last-30-day trend, described by its own inner note.
  const callVolumeSubtitle = hasDateFilter
    ? 'Calls in your selected date range'
    : 'All calls answered';

  return (
    <div className="flex-1 overflow-auto p-6" style={{ backgroundColor: 'var(--bg-base)' }}>
      <div className="max-w-5xl mx-auto">
        <h1
          className="font-display text-2xl tracking-wide mb-1"
          style={{ color: 'var(--text-primary)' }}
        >
          Analytics
        </h1>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          Patterns from your calls and bookings. You know your business — these numbers help you see
          it.
        </p>
        {stats && (
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
            Reliability snapshot: {stats.calls.total} calls / {stats.appointments.total}{' '}
            appointments tracked
          </p>
        )}

        <DateRangePicker
          startDate={startDate}
          endDate={endDate}
          onStartChange={setStartDate}
          onEndChange={setEndDate}
        />

        <AnalyticsMetricsGrid
          calls={{
            hasCalls,
            totalCalls,
            bookedCalls,
            abandonedCalls,
            conversionPct,
            abandonmentPct,
            callVolumeSubtitle,
            byDay,
            maxDayVolume,
            byOutcome,
          }}
          appointments={{
            summary,
            hasAppointments,
            busiestHour,
            busiestDay,
          }}
          cohorts={cohorts}
        />

        {/* Utilization heatmap — staffed vs booked time by weekday × hour.
            Full-width (the hour columns need room) and honors the same
            From/To window as the call + cohort cuts above. */}
        <div className="mt-6">
          <UtilizationHeatmap
            range={{ start_date: startDate || undefined, end_date: endDate || undefined }}
          />
        </div>

        {/* Reminder delivery monitoring */}
        <div className="mt-6">
          <ReminderDeliveryStats />
        </div>

        {/* AiUsageCard removed 2026-07-20 (Dale): the per-tenant AI cost is the
            platform's cost-of-goods — showing it to owners hands them the
            margin math behind call-pack pricing. ai_cost_events keeps
            recording; the number is for the operator, not the tenant. */}

        {/* Roadmap: richer WHY analysis still ahead */}
        <div
          className="mt-4 p-4 rounded-xl"
          style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-soft)' }}
        >
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-4 h-4" style={{ color: 'var(--accent-soft)' }} />
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              Coming next
            </span>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Deeper &ldquo;why&rdquo; analysis — when a caller doesn&rsquo;t book, was it price, no
            availability, or the wrong service? — needs richer outcome tagging during the call.
            That&rsquo;s on the roadmap. Today&rsquo;s panels are built from your real call and
            booking history.
          </p>
        </div>
      </div>
    </div>
  );
}
