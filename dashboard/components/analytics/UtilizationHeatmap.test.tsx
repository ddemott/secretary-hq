/**
 * UtilizationHeatmap tests — the weekday × hour staffed-vs-booked grid that
 * closed the GAPS §6 "no utilization heatmaps beyond the scheduler bars" item.
 *
 * Pins the three states (grid, empty via EmptyState, fetch error) plus the
 * accessibility contract: every cell must carry a human-readable aria-label
 * ("Tuesday 2pm — 75% booked (45 of 60 staffed minutes)") so the heatmap is
 * never color-alone, and the legend must describe the shading direction in
 * neutral language (no grades or warnings).
 *
 * Each test carries 5W diagnostic context.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('../../lib/SessionContext', () => ({
  useActiveTenantId: () => 'tenant-123',
}));

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    analytics: { getUtilization: vi.fn() },
  },
}));

vi.mock('../../lib/api', () => ({ Api: mockApi }));

import UtilizationHeatmap from './UtilizationHeatmap';

beforeEach(() => {
  mockApi.analytics.getUtilization.mockReset();
});

describe('UtilizationHeatmap', () => {
  test('HAPPY: renders staffed cells with accessible booked/staffed labels + the neutral legend', async () => {
    // WHO: an owner opening the Analytics tab to see when staffed time fills up.
    // WHAT: cells from GET /analytics/utilization render as grid cells whose
    //        aria-label spells out "<Day> <hour> — <pct>% booked (<booked> of
    //        <staffed> staffed minutes)"; unstaffed cells in the hour span say
    //        "no staffed time"; the legend explains shading without grading.
    // WHEN: the endpoint returns Tuesday (dow=2) cells for 2pm and 3pm.
    // WHERE: UtilizationHeatmap → HeatmapGrid cell + legend rendering.
    // WHY: the heatmap is color-only without these labels — a screen-reader
    //       user (or anyone hovering) must get the exact numbers, and the
    //       neutral-language rule forbids alarm colors/grades, so the legend
    //       wording is part of the contract.
    mockApi.analytics.getUtilization.mockResolvedValue({
      cells: [
        { dow: 2, hour: 14, staffed_minutes: 60, booked_minutes: 45, utilization: 0.75 },
        { dow: 2, hour: 15, staffed_minutes: 60, booked_minutes: 0, utilization: 0 },
      ],
    });

    render(<UtilizationHeatmap />);

    expect(await screen.findByText('Utilization')).toBeInTheDocument();

    // The exact accessible-name contract from the spec.
    expect(
      await screen.findByLabelText('Tuesday 2pm — 75% booked (45 of 60 staffed minutes)')
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Tuesday 3pm — 0% booked (0 of 60 staffed minutes)')
    ).toBeInTheDocument();

    // Hours span is 14..15, so every OTHER weekday still gets cells in those
    // columns — as explicit "no staffed time", never a fake 0%.
    expect(screen.getByLabelText('Sunday 2pm — no staffed time')).toBeInTheDocument();

    // Neutral legend: shading direction only, no grades/warnings.
    expect(screen.getByText('Lighter = more open time')).toBeInTheDocument();
    expect(screen.getByText('Darker = more booked')).toBeInTheDocument();
  });

  test('HAPPY: default (no range) subtitle says last 28 days; a set range says selected date range', async () => {
    // WHO: an owner comparing the unfiltered view with a From/To-filtered one.
    // WHAT: the subtitle must state which window the grid aggregates — the
    //        backend defaults to the last 28 days when no bounds are sent.
    // WHEN: rendered without a range prop, then with one.
    // WHERE: UtilizationHeatmap subtitle branch on hasDateFilter.
    // WHY: mislabeling the window (like the old all-time "last 30 days" call
    //       volume bug fixed 2026-06) makes the owner misread their capacity.
    mockApi.analytics.getUtilization.mockResolvedValue({ cells: [] });

    const { rerender } = render(<UtilizationHeatmap />);
    expect(
      await screen.findByText('Staffed vs booked time by weekday and hour — last 28 days')
    ).toBeInTheDocument();

    rerender(<UtilizationHeatmap range={{ start_date: '2026-06-01' }} />);
    expect(
      await screen.findByText(
        'Staffed vs booked time by weekday and hour, in your selected date range'
      )
    ).toBeInTheDocument();
    // The range must actually reach the API, not just the copy.
    expect(mockApi.analytics.getUtilization).toHaveBeenLastCalledWith('tenant-123', {
      start_date: '2026-06-01',
      end_date: undefined,
    });
  });

  test('EMPTY: no staffed cells renders the EmptyState, not a blank grid', async () => {
    // WHO: a brand-new tenant that has not put any shifts on the schedule yet.
    // WHAT: { cells: [] } must show the canonical EmptyState copy pointing at
    //        the schedule, instead of an empty/NaN grid (Math.min of an empty
    //        array is Infinity — rendering the grid would explode the columns).
    // WHEN: right after onboarding, before the setup wizard's shift step.
    // WHERE: UtilizationHeatmap empty branch (cells.length === 0).
    // WHY: the empty grid is the FIRST thing a new owner would see on this
    //       panel — it has to explain itself, per the EmptyState convention.
    mockApi.analytics.getUtilization.mockResolvedValue({ cells: [] });

    render(<UtilizationHeatmap />);

    expect(await screen.findByText('No staffed hours in this period')).toBeInTheDocument();
    expect(
      screen.getByText('The utilization grid appears once your team has shifts on the schedule.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Lighter = more open time')).not.toBeInTheDocument();
  });

  test('HAPPY: the loading pulse is announced to assistive tech, not silent', () => {
    // WHO: a screen-reader user opening the Analytics tab before the
    //        utilization fetch resolves.
    // WHAT: the loading placeholder is a bare animate-pulse div with no text
    //        content — without aria-busy/aria-label a screen reader announces
    //        nothing while the panel is mid-fetch, same defect class as the
    //        AnalyticsSkeleton fix (2026-09-16 UX pass).
    // WHERE: UtilizationHeatmap's loading branch.
    // WHY: state-dependent UI needs an aria contract or it reads as a blank
    //      panel to a non-visual user.
    mockApi.analytics.getUtilization.mockResolvedValue({ cells: [] });

    const { container } = render(<UtilizationHeatmap />);

    const pulse = container.querySelector('[aria-busy="true"]');
    expect(pulse).toBeInTheDocument();
    expect(pulse).toHaveAttribute('aria-label', 'Loading utilization data');
  });

  test('SAD: a failed fetch degrades to a quiet inline message, never a crash', async () => {
    // WHO: an owner whose session expired mid-view or whose network dropped.
    // WHAT: a rejected getUtilization sets the error branch — the panel stays
    //        mounted with a muted message; no unhandled rejection, no blank
    //        white panel, and the rest of AnalyticsView is unaffected.
    // WHEN: any API failure (401 handled upstream, 5xx, offline).
    // WHERE: UtilizationHeatmap .catch → error state.
    // WHY: this panel is embedded in AnalyticsView — an uncaught rejection
    //       here would take down the whole Analytics tab, not just one panel.
    mockApi.analytics.getUtilization.mockRejectedValue(new Error('network down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<UtilizationHeatmap />);

    expect(await screen.findByText('Could not load utilization data.')).toBeInTheDocument();
    consoleSpy.mockRestore();
  });
});
