/**
 * SkillAssignmentsView tests — pins the Grid/Map toggle contract for the
 * merged sub-tab that replaced the former "Service Assignments" +
 * "Skill Map" pair (B1, 2026-05-17).
 *
 * What we test:
 *   1. Default initial view is Grid (children: SkillMatrixView).
 *   2. ?view=map on the URL initializes the Map view (SkillRelationshipMap).
 *   3. Clicking the Map toggle switches view AND writes ?view=map to the URL.
 *   4. Clicking the Grid toggle strips ?view from the URL (keeping the
 *      query string short for the default case).
 *   5. aria-pressed reflects the active toggle for screen readers.
 *
 * Children (SkillMatrixView, SkillRelationshipMap) are mocked to thin
 * markers so the toggle's wiring is the only thing under test.
 *
 * Each test carries 5W context.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock('../skills/SkillMatrixView', () => ({
  default: () => <div data-testid="grid-view-marker">grid</div>,
}));

vi.mock('./SkillRelationshipMap', () => ({
  default: () => <div data-testid="map-view-marker">map</div>,
}));

import SkillAssignmentsView from './SkillAssignmentsView';

beforeEach(() => {
  window.history.replaceState({}, '', '/dashboard?tab=my-team&subtab=skills');
});

describe('SkillAssignmentsView — initial view from URL', () => {
  test('HAPPY: no ?view param → Grid view renders by default', () => {
    // WHO: operator navigating to the merged Service Assignments tab
    //      without a deep-link
    // WHAT: the Grid (SkillMatrixView) marker is in the DOM; the Map
    //       marker is NOT.
    // WHY: Grid is the bulk-edit affordance most owners reach for first;
    //      making it the default avoids putting them in the visual Map
    //      they may never have seen before.
    render(<SkillAssignmentsView />);
    expect(screen.getByTestId('grid-view-marker')).toBeInTheDocument();
    expect(screen.queryByTestId('map-view-marker')).not.toBeInTheDocument();
  });

  test('HAPPY: ?view=map on the URL → Map view renders initially', () => {
    // WHO: user who bookmarked the legacy Skill Map tab (the legacy
    //      `?subtab=skill-map` is normalized by MyTeamView to
    //      `?subtab=skills&view=map` on mount)
    // WHAT: the Map marker is in the DOM; the Grid marker is NOT.
    // WHY: deep-link preservation is the whole reason the URL param exists.
    window.history.replaceState({}, '', '/dashboard?subtab=skills&view=map');
    render(<SkillAssignmentsView />);
    expect(screen.getByTestId('map-view-marker')).toBeInTheDocument();
    expect(screen.queryByTestId('grid-view-marker')).not.toBeInTheDocument();
  });
});

describe('SkillAssignmentsView — toggle behavior', () => {
  test('HAPPY: clicking Map switches view AND writes ?view=map to the URL', () => {
    // WHO: owner who wants to see how their team + services connect as
    //      a node graph
    // WHAT: pressing the Map button (a) hides Grid + shows Map, and
    //       (b) appends `view=map` to the URL search string so a reload
    //       keeps the choice.
    // WHY: a toggle that didn't persist would re-default to Grid on
    //      every reload, making the Map view feel hidden.
    render(<SkillAssignmentsView />);

    fireEvent.click(screen.getByRole('button', { name: /map/i }));

    expect(screen.getByTestId('map-view-marker')).toBeInTheDocument();
    expect(window.location.search).toContain('view=map');
  });

  test('HAPPY: clicking Grid strips ?view from the URL (default state)', () => {
    // WHO: same owner, switching back from Map to Grid
    // WHAT: pressing Grid (a) hides Map + shows Grid and (b) removes
    //       view=map from the URL — default state should have no
    //       leftover params so URLs stay clean.
    // WHY: keeping `?view=grid` would still be redundant; canonical URL
    //      shape for the default is no view param at all.
    window.history.replaceState({}, '', '/dashboard?subtab=skills&view=map');
    render(<SkillAssignmentsView />);

    fireEvent.click(screen.getByRole('button', { name: /grid/i }));

    expect(screen.getByTestId('grid-view-marker')).toBeInTheDocument();
    expect(window.location.search).not.toContain('view=');
  });

  test('HAPPY: aria-pressed reflects the active toggle for screen readers', () => {
    // WHO: screen-reader user navigating the toggle group
    // WHAT: the active button reports aria-pressed=true; the inactive
    //       button reports aria-pressed=false.
    // WHY: aria-pressed is the canonical signal for two-state toggle
    //      buttons. Without it the screen reader can't distinguish
    //      the active view from the inactive one.
    render(<SkillAssignmentsView />);

    const grid = screen.getByRole('button', { name: /grid/i });
    const map = screen.getByRole('button', { name: /map/i });

    expect(grid).toHaveAttribute('aria-pressed', 'true');
    expect(map).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(map);
    expect(grid).toHaveAttribute('aria-pressed', 'false');
    expect(map).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('SkillAssignmentsView — popstate navigation safety', () => {
  test('HAPPY: a browser back/forward that rewrites the URL flips the rendered view', () => {
    // WHO: operator who deep-linked to ?view=map, then hit the browser Back
    //      button (or a parent-shell URL rewrite) back to the grid default.
    // WHAT: starting on ?view=map, rewriting the URL to no ?view and firing
    //       popstate flips the rendered marker back to Grid — and forward
    //       again flips it to Map.
    // WHY: the OLD implementation snapshotted the view once from
    //      useSearchParams(), so back/forward changed the URL but NOT the
    //      rendered view — a subtle, annoying-to-debug shell bug. Driving
    //      `view` from the shared URL-state hook closes it.
    window.history.replaceState({}, '', '/dashboard?tab=my-team&subtab=skills&view=map');
    render(<SkillAssignmentsView />);
    expect(screen.getByTestId('map-view-marker')).toBeInTheDocument();

    act(() => {
      window.history.replaceState({}, '', '/dashboard?tab=my-team&subtab=skills');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByTestId('grid-view-marker')).toBeInTheDocument();
    expect(screen.queryByTestId('map-view-marker')).not.toBeInTheDocument();

    act(() => {
      window.history.replaceState({}, '', '/dashboard?tab=my-team&subtab=skills&view=map');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByTestId('map-view-marker')).toBeInTheDocument();
  });
});
