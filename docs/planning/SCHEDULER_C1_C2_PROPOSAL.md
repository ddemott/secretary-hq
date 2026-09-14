# Scheduler sub-view consolidation (C1+C2) — design proposal

**Status:** DESIGN ONLY. No code in this PR. Per `docs/planning/TODO.md` P3 UX
backlog, this needs a UX pass with Dale before any build — this doc is that
pass's starting point, not a decision. Nothing here is authorized to be built
until Dale picks a direction (or rejects all of them) below.

**Author:** stark (2026-09-14), as part of the first multi-agent team batch.

**Source item:** `docs/planning/TODO.md` P3 —

> Schedule sub-view consolidation (C1+C2) — merge the 4 scheduler sub-views
> (calendar/staff/resources/list) → 2 (calendar Day/Month + Team/Resources)
> with one unified header. `dashboard/components/SchedulerView.tsx`.

---

## 1. Current state (measured against the actual code, 2026-09-14)

`dashboard/components/scheduler/SchedulerView.tsx` (253 lines) is the
container. It exposes **two top-level tabs** (`activeView`: `day` | `calendar`)
plus, only inside the `day` tab, **three day-modes** (`dayMode`: `staff` |
`resources` | `list`) — so today's shape is actually **1 calendar view + 3 day
sub-modes = 4 total surfaces**, matching the TODO item's "4 scheduler
sub-views" count:

| Tab        | Day-mode          | Component                                                                   | Lines     | What it shows                                                                       |
| ---------- | ----------------- | --------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| `calendar` | —                 | `AppointmentView` (`dashboard/components/appointments/AppointmentView.tsx`) | —         | Month/week/day calendar grid (react-big-calendar), click-to-book via `onSelectSlot` |
| `day`      | `staff` (default) | `NewSchedulerView`                                                          | **1,582** | Per-employee swim-lane timeline for one day, drag/zoom                              |
| `day`      | `resources`       | `ResourceColumnsView`                                                       | 138       | Per-resource (room/line) columns for one day                                        |
| `day`      | `list`            | `AppointmentListView`                                                       | 154       | Flat sortable list, one day                                                         |

Shared chrome: `SchedulerToolbar` (186 lines — tab switch, day-mode switch,
date nav, zoom, refresh, "+ New" quick-book) sits above all four; state
(`selectedDate`, `zoomIndex`, popover, quick-book panel, employee-focus panel)
is lifted into `SchedulerView` and threaded down. URL sync (`?subtab=` /
`?daymode=`) already exists and would need to survive any reshape.

**One finding worth flagging separately from this proposal:**
`dashboard/components/scheduler/StaffSwimLaneView.tsx` (541 lines) is dead
code — grep shows zero imports anywhere outside the file itself, and it has
no test file. It looks like an earlier iteration of what `NewSchedulerView`
now does. Not in scope to delete here (that's a one-line follow-up someone
should file, not a scheduler-redesign decision), but any consolidation work
should not accidentally treat it as a live surface.

`dashboard/components/scheduler/scheduler.test.tsx` (942 lines) and
`NewSchedulerView.test.tsx` (1,215 lines) are the coverage that any
consolidation has to keep passing or deliberately rewrite — this is not a
small-blast-radius change.

---

## 2. What the TODO item asks for, stated precisely

Target: **2 surfaces** — "calendar Day/Month" and "Team/Resources" — under
"one unified header." Reading between the lines of the existing shape:

- **Calendar Day/Month** ≈ today's `calendar` tab, but the `day`/`list` view
  folds in as a _view mode of the calendar_ (a day-grid or agenda-list mode)
  rather than a separate top-level tab.
- **Team/Resources** ≈ today's `staff` + `resources` day-modes merged into one
  surface with a toggle for "group columns by employee" vs "group columns by
  resource" — same timeline mechanic, different column dimension.

That reading is the most literal one but is **not the only defensible split**
— see options below.

---

## 3. Options (present to Dale, not a recommendation to build any of these)

### Option A — Axis split (closest literal reading of "Day/Month" + "Team/Resources")

- **Surface 1 — Calendar**: react-big-calendar-style grid with Day / Week /
  Month toggle (Week is new; today's `calendar` tab only implicitly supports
  whatever react-big-calendar defaults to — verify). Click-to-book stays.
  `AppointmentListView`'s flat-list becomes an "Agenda" mode inside this
  surface rather than vanishing.
- **Surface 2 — Team/Resources**: today's `NewSchedulerView` swim-lane
  mechanic, with a column-grouping toggle (by employee / by resource) instead
  of two separate components. This is the harder half — `NewSchedulerView`
  (1,582 lines) and `ResourceColumnsView` (138 lines) are not close in size or
  apparent complexity, so "merge them" is likely closer to "keep
  `NewSchedulerView`'s architecture and make its column source pluggable"
  than "merge two comparable files."
- **Unified header**: one toolbar for both surfaces — tab switch (Calendar /
  Team), then a _contextual_ second control (Day/Week/Month inside Calendar;
  Employee/Resource inside Team), replacing today's two-level
  tab-then-daymode toolbar with fewer total states shown at once (arguably
  clearer) but the same total state space.

**Tradeoff:** cleanest match to the TODO wording. Riskiest single piece is
folding `AppointmentListView` into the calendar surface as an "Agenda" mode —
today it's a day-mode sibling of the swim-lane view, not part of the calendar
component, so this is a real move, not a rename.

### Option B — Density split (single-day operational view vs. multi-day planning view)

- **Surface 1 — Today/Day ops view**: swim-lane (staff) + resource columns +
  list, all as toggleable _density modes_ of one single-day surface (this is
  actually closer to today's `day` tab already — modes A/B/C already coexist
  under one tab).
- **Surface 2 — Calendar**: month/week overview for planning ahead, no
  per-resource drill-down, click-through opens Surface 1 scoped to that day.

**Tradeoff:** less code motion (Surface 1 is nearly what `day` already is,
just relabeled with day-mode as the "unified header" contextual control), but
arguably doesn't reduce complexity as much as Option A — it doesn't actually
touch the 3-way staff/resources/list toggle the TODO item seems to be asking
to shrink.

### Option C — Do not touch `NewSchedulerView`; consolidate only the small views

- Keep `calendar` and `day/staff` (`NewSchedulerView`) exactly as they are —
  the two heaviest, most-tested, most load-bearing surfaces (1,582 + tests,
  and whatever `AppointmentView`'s real weight is).
- Fold `resources` and `list` (138 + 154 lines, the two lightest views) into
  filters/toggles _within_ the staff swim-lane view (e.g. "group by resource
  instead of employee" and "switch to list density" as view-mode buttons on
  `NewSchedulerView` itself) rather than building two new merged components.
- Net surface count: still 2 (Calendar, Team-which-now-subsumes-Resources-and-
  List), but the implementation is "extend the view everyone already uses
  most" rather than "build two new merged components."

**Tradeoff:** smallest behavior-preserving diff, defers the actual
`NewSchedulerView` refactor risk (that file is the dense-view-decomposition
item TODO.md separately calls out as needing to happen "with C1+C2" anyway —
see below). Might not satisfy "unified header" as crisply since the toolbar
still effectively carries 2 levels of control on the Team surface.

---

## 4. Coupling to the other open item: dense-view decomposition

TODO.md's UX backlog also lists:

> Dense-view decomposition — remaining over-300 coordination surfaces:
> `NewSchedulerView` (1582 — do with C1+C2 scheduler consolidation)

This means whichever option Dale picks, **`NewSchedulerView` itself likely
needs to be broken into subcomponents in the same effort**, not just
relabeled or given a new prop for its data source. That's a second axis of
work layered onto whichever of A/B/C above is chosen, and probably the
majority of the actual effort — the "4 views → 2" surface count is the easy
part to reason about; extracting coherent regions out of a 1,582-line swim-
lane component under active behavior requirements (drag, zoom, popover,
quick-book, employee-focus panel) is the real lift.

---

## 5. Non-goals (this pass, and for whoever eventually builds this)

- No code changes in this PR. This is a proposal doc only.
- Not deciding between A/B/C here — that's Dale's call.
- Not touching `StaffSwimLaneView.tsx` (dead code, separate one-line cleanup
  ticket, not part of this design).
- Not scoping the `NewSchedulerView` decomposition in detail — flagged as
  coupled work above, not designed here.
- Not estimating effort/size — that depends entirely on which option Dale
  picks and how much of the `NewSchedulerView` decomposition rides along.

---

## 6. Open questions for Dale

1. Which of A / B / C (or a fourth shape not listed) matches what "Day/Month"
   - "Team/Resources" was supposed to mean when this item was written?
2. Does "Agenda" (list) need to survive as a first-class mode, or was
   `AppointmentListView` mostly a debugging/QA convenience that's fine to
   fold away entirely?
3. Is the `NewSchedulerView` decomposition a hard prerequisite (must ship in
   the same PR) or can the surface-count consolidation land first with the
   decomposition as an explicit fast-follow?
4. Any owner-facing naming preference for the two final tabs (this doc used
   "Calendar" / "Team" as placeholders only)?

---

## 7. Recommendation from this pass

None offered on purpose — TODO.md is explicit that this needs Dale's design
judgment before any option gets picked, and a proposal that quietly steers
toward one option would undercut that. All three are presented as roughly
equally plausible readings of the original one-line backlog item; the
right call depends on how the scheduler is actually used day-to-day, which
is Dale's call to make, not an inference from the code.
