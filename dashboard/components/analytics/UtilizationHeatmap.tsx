'use client';

import React, { useState, useEffect } from 'react';
import { LayoutGrid } from 'lucide-react';
import { Api } from '../../lib/api';
import type { UtilizationCell } from '../../lib/types';
import { useActiveTenantId } from '../../lib/SessionContext';
import { formatHour } from '../../lib/utils';
import { EmptyState } from '../ui/EmptyState';

/**
 * Utilization heatmap (GAPS §6) — weekday × hour grid of how much staffed
 * time is booked, from GET /analytics/utilization.
 *
 * Rows are the 7 weekdays, columns are the tenant-local hours where anyone is
 * ever on shift in the window (hours nobody works are omitted entirely, so a
 * 9-5 shop shows an 8-column grid, not a 24-column one). Cell shading is a
 * SINGLE-HUE sequential blue ramp — magnitude only, deliberately no
 * red/amber "alarm" colors and no grading language: whether Tuesday 2pm
 * being 20% booked is a problem is the owner's judgment, not the
 * dashboard's (neutral-language rule from the UX audits).
 *
 * The ramp is anchored on the theme accent (var(--accent)) via color-mix, so
 * the single hue tracks whatever accent the active theme defines (blue on
 * navy, pink on rose, etc.) instead of a hardcoded hex that can't adapt. It
 * runs light → dark: a pale tint (accent lightened toward white) at the open
 * end darkens to a deep shade (accent toward black) at the booked end, so
 * "lighter = more open, darker = more booked" holds true (the white/black are
 * only lightness anchors, NOT brand colors — the hue is always the accent).
 * The lightest step is still a clearly-visible pale tint so an hour that is
 * staffed but 0% booked reads as "open capacity", distinct from the neutral
 * var(--bg-raised) of unstaffed cells.
 *
 * Accessibility: every cell carries a title + aria-label like
 * "Tuesday 2pm — 75% booked (45 of 60 staffed minutes)", so the grid is
 * readable without color; a legend explains the shading direction.
 *
 * Self-fetching (same pattern as ReminderDeliveryStats) but honors the
 * parent AnalyticsView's From/To window via the `range` prop; absent bounds
 * default to the last 28 days on the backend.
 */

const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Single-hue sequential ramp, light → dark, anchored on the theme accent via
// color-mix: the accent lightened toward white at the open end, deepened
// toward black at the booked end. Luminance decreases monotonically open →
// booked (matching the "lighter = open, darker = booked" legend) while the hue
// stays var(--accent) so it adapts to every theme. white/black are lightness
// anchors only — never brand colors.
const ACCENT_RAMP = [
  'color-mix(in srgb, var(--accent) 18%, white)',
  'color-mix(in srgb, var(--accent) 55%, white)',
  'var(--accent)',
  'color-mix(in srgb, var(--accent) 78%, black)',
  'color-mix(in srgb, var(--accent) 55%, black)',
];

/** Ramp step for a booked/staffed ratio; over-booked (>100%) clamps to the darkest step. */
function rampColor(utilization: number): string {
  const clamped = Math.max(0, Math.min(1, utilization));
  return ACCENT_RAMP[Math.min(ACCENT_RAMP.length - 1, Math.floor(clamped * ACCENT_RAMP.length))];
}

interface UtilizationHeatmapProps {
  /** Optional From/To window (YYYY-MM-DD) — the AnalyticsView date filter. */
  range?: { start_date?: string; end_date?: string };
}

export default function UtilizationHeatmap({ range }: UtilizationHeatmapProps) {
  const tenantId = useActiveTenantId();
  const [cells, setCells] = useState<UtilizationCell[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const startDate = range?.start_date;
  const endDate = range?.end_date;

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Api.analytics
      .getUtilization(tenantId, { start_date: startDate, end_date: endDate })
      .then((data) => {
        if (!cancelled) setCells(data?.cells ?? []);
      })
      .catch((err) => {
        console.error('Failed to load utilization', err);
        if (!cancelled) {
          setCells(null);
          setError('Could not load utilization data.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, startDate, endDate]);

  const hasDateFilter = Boolean(startDate || endDate);

  return (
    <div
      className="p-4 rounded-xl"
      style={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-soft)' }}
    >
      <div className="flex items-center gap-2 mb-1">
        <LayoutGrid className="w-4 h-4" style={{ color: 'var(--accent-soft)' }} />
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Utilization
        </span>
      </div>
      <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
        {hasDateFilter
          ? 'Staffed vs booked time by weekday and hour, in your selected date range'
          : 'Staffed vs booked time by weekday and hour — last 28 days'}
      </p>

      {loading ? (
        <div
          className="h-24 rounded-lg animate-pulse"
          style={{ backgroundColor: 'var(--bg-raised)' }}
        />
      ) : error ? (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {error}
        </p>
      ) : !cells || cells.length === 0 ? (
        <EmptyState
          variant="compact"
          title="No staffed hours in this period"
          description="The utilization grid appears once your team has shifts on the schedule."
        />
      ) : (
        <HeatmapGrid cells={cells} />
      )}
    </div>
  );
}

function HeatmapGrid({ cells }: { cells: UtilizationCell[] }) {
  // Columns: the contiguous hour span that has ANY staffed capacity, so the
  // grid stays compact (a 9-5 shop renders 9am..4pm, not midnight..11pm).
  const minHour = Math.min(...cells.map((c) => c.hour));
  const maxHour = Math.max(...cells.map((c) => c.hour));
  const hours = Array.from({ length: maxHour - minHour + 1 }, (_, i) => minHour + i);

  const byKey = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c]));
  // Label every column when the span is narrow; every other one when wide,
  // so a 24-hour tenant doesn't get a collision wall of tiny labels.
  const labelEvery = hours.length > 12 ? 2 : 1;

  return (
    <div className="overflow-x-auto">
      <div
        className="grid gap-[2px]"
        style={{
          gridTemplateColumns: `2.25rem repeat(${hours.length}, minmax(1.1rem, 1fr))`,
          minWidth: `${2.25 + hours.length * 1.2}rem`,
        }}
      >
        {/* Header row: hour labels */}
        <div />
        {hours.map((h, i) => (
          <div
            key={h}
            className="text-[9px] text-center pb-1"
            style={{ color: 'var(--text-muted)' }}
            aria-hidden="true"
          >
            {i % labelEvery === 0 ? formatHour(h) : ''}
          </div>
        ))}

        {/* One row per weekday, Sunday → Saturday (Postgres DOW order) */}
        {DAY_FULL.map((dayFull, dow) => (
          <React.Fragment key={dayFull}>
            <div
              className="text-[10px] pr-2 flex items-center justify-end"
              style={{ color: 'var(--text-muted)' }}
              aria-hidden="true"
            >
              {DAY_SHORT[dow]}
            </div>
            {hours.map((hour) => {
              const cell = byKey.get(`${dow}:${hour}`);
              if (!cell) {
                return (
                  <div
                    key={hour}
                    role="img"
                    aria-label={`${dayFull} ${formatHour(hour)} — no staffed time`}
                    title={`${dayFull} ${formatHour(hour)} — no staffed time`}
                    className="h-5 rounded-sm"
                    style={{ backgroundColor: 'var(--bg-raised)' }}
                  />
                );
              }
              const pct = cell.utilization === null ? 0 : Math.round(cell.utilization * 100);
              const label = `${dayFull} ${formatHour(hour)} — ${pct}% booked (${cell.booked_minutes} of ${cell.staffed_minutes} staffed minutes)`;
              return (
                <div
                  key={hour}
                  role="img"
                  aria-label={label}
                  title={label}
                  className="h-5 rounded-sm"
                  style={{ backgroundColor: rampColor(cell.utilization ?? 0) }}
                />
              );
            })}
          </React.Fragment>
        ))}
      </div>

      {/* Legend — shading direction only; no grades, no thresholds */}
      <div className="flex items-center gap-2 mt-3">
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Lighter = more open time
        </span>
        <div className="flex gap-[2px]" aria-hidden="true">
          {ACCENT_RAMP.map((color) => (
            <div key={color} className="w-4 h-3 rounded-sm" style={{ backgroundColor: color }} />
          ))}
        </div>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          Darker = more booked
        </span>
        <span className="text-[10px] ml-2" style={{ color: 'var(--text-muted)' }}>
          Gray = no one on shift
        </span>
      </div>
    </div>
  );
}
