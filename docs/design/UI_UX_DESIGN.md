# SecretaryHQ Dashboard — UI/UX Design Brief
**Last updated:** 2026-09-18 (nav tabs, business-type count and implementation-scope rows re-verified against `dashboard/`; core content from March 2026 design session)

> **Role of this file (vs. `DESIGN_HANDOFF.md`):** this is the **living** design brief — update it as design philosophy evolves, new components ship, or interaction patterns get established. For the **frozen** record of the original 2026-03-24 design session decisions, see [`DESIGN_HANDOFF.md`](DESIGN_HANDOFF.md).

## Purpose
This document captures the current state of the dashboard UI, its problems, and all design decisions. The goal is to make the dashboard intuitive for service business owners (tire shops, salons, auto shops, spas, trades, fitness) who are not technical users.

> **Related:** an earlier component-level UX audit (231 lines, 2026-04-20) was addressed in the commit `f9ffa8e` UX/a11y batch. The standalone audit notes (`sessions/`) and bug tracker (`BUGS.md`) were since removed — history is consolidated in `docs/planning/RESOLVED.md`.

---

## Target Users

- **Primary**: Small business owners/managers (e.g., DynaTire owner, salon manager)
- **Secondary**: Receptionists and front-desk staff
- **Tertiary**: Super-admin (platform operator managing multiple tenants)

These users care about: "Who's calling?", "What's booked?", "Who's working today?", "How's business going?" They do NOT think in terms of "Skill Matrix", "Resources", or "RLS".

**Plain language rule:** Every label, tooltip, and description must be written for a tire shop owner, not a developer. "Remembers your customers" not "CRM." "Answers questions from your own documents" not "RAG." This applies everywhere.

---

## Design Philosophy (March 2026 — Non-Negotiable)

These principles were established during a full design session and must be applied to every future UI decision:

**We show data. They manage their business.**
Every time the UI starts telling users what's wrong, what to do, or grading their operation — stop. Show the information clearly. Let them interpret it. They are the expert on their own business.

**No babysitting.**
Don't tell a tire shop owner nobody is scheduled for seasonal tire swaps in July. They know it's July. Showing that warning constantly fires with information the owner already knows is intentional — it erodes trust in the system.

**Managers are still needed to manage.**
The software is a tool. It doesn't replace judgment. Jimmy being new, the bay count constraint, who works well together — we don't know any of that. We show who can do what. They decide if it's enough.

---

## Fonts — Bebas Neue + DM Sans (Locked)

**Decision:** Bebas Neue (display/headers) + DM Sans (body) everywhere. Universal. Not swappable per business template.

Bebas Neue only appears in: page titles, stat numbers, the logo, section headings. Everything else is DM Sans. The concern was raised that Bebas Neue feels "masculine." Dale's response: the font isn't what makes something feel masculine or feminine — the color palette does that work. It's the SecretaryHQ brand. It stays.

**Implementation:** All CSS must reference `--font-display` and `--font-body` CSS variables. Never hardcode font families in components.

```css
--font-display: 'Bebas Neue', sans-serif;
--font-body: 'DM Sans', sans-serif;
```

---

## Theme System

**Decision:** Rebuild all 8 existing themes to include font variables (`--font-display` and `--font-body`) alongside color variables. Theme switcher is a **dropdown**, not buttons.

**Why dropdown:** Cleaner, scales to 8+ themes without breaking layout, future-proofs custom theme creation — a user-created "My Brand Theme" is just another dropdown option.

**Custom themes (future):** Users will eventually be able to create a custom theme — pick a base, adjust accent color to match their brand, name it, save it. Don't build now, but don't architect against it. The CSS variable structure already supports it.

Each theme defines:
```css
--bg-base, --bg-surface, --bg-raised, --bg-card
--accent, --accent-soft, --accent-muted
--text-primary, --text-secondary, --text-muted
--border, --border-soft
--font-display, --font-body  /* NEW — add to all 8 themes */
--green, --red, --yellow     /* semantic colors */
```

**Soft/feminine theme:** A rose/plum dark theme (`rose`, "Warm plum") has since shipped — the theme set today is navy [default], rose, forest, midnight, nord, sunset, high-contrast, solarized (`dashboard/lib/ThemeContext.tsx`). Same Bebas Neue + DM Sans fonts, different color palette. The color palette is what changes the feel — not the font.

---

## Navigation Structure — Single Primary Bar (superseded the two-tab layout)

> **SUPERSEDED 2026-05-06.** The Front Desk / Back Office two-tab layout below was retired for a **single primary tab bar**: Primary tabs (Home, Schedule, Customers, Calls) always visible; Advanced tabs (originally My Business, My Team, Phone Assistant — since 2026-06-03 the first two plus Business Settings are sub-tabs of one **Setup** tab, so today: Setup, Phone Assistant) shown to owners/admins only; front-desk logins see Primary only and snap back to Home on a restricted tab. The dark-sidebar visual spec still applies. See `docs/architecture/ARCHITECTURE.md` §16.2 + `docs/design/DESIGN_HANDOFF.md` §3. The original two-tab text is kept below as the design-session record.

**Original decision (superseded):** Keep the existing Front Desk / Back Office two-tab layout with all current sub-views intact. Apply the new dark sidebar visual style on top.

**Sidebar visual spec:**
- Background: `var(--bg-surface)`
- Section labels: `10px, font-weight 600, letter-spacing 0.12em, uppercase, color var(--text-muted)`
- Nav items default: `13px, color var(--text-secondary)`
- Nav items active: `color var(--text-primary)`, left border `2px solid var(--accent)`, background `var(--accent-muted)`
- Icons: `14×14px, opacity 0.6` default, `opacity 1` active

**Sidebar bottom — no Quick Book button:**
The sidebar bottom shows today's appointment count and staff count as a summary. There is NO Quick Book button in the sidebar. Replaced with a "Go to Scheduler to book" navigation link.

**Why:** You cannot book without seeing the schedule — you'd have no way to know if you're double-booking. Booking must happen inside the Scheduler where availability is visible.

---

## Current Dashboard Architecture

### Tech Stack
- **Framework**: Next.js 16 (App Router) + React 19
- **Styling**: Tailwind CSS 3.4
- **Icons**: Lucide React
- **Layout**: Outlook-inspired sidebar + content pane
- **Theme**: 8 themes via CSS custom properties
- **Responsive**: Desktop sidebar collapses to mobile bottom nav

### Navigation Structure (Front Desk / Back Office) — SUPERSEDED, see the Single Primary Bar section above

> Kept as the design-session record. Live tabs: Home, Schedule, Customers, Calls + Setup, Phone Assistant (`dashboard/components/layout/OutlookLayout.tsx`).

```
Desktop: Two primary tabs at top level
┌──────────────────────────────────────────┐
│ [Front Desk]  [Back Office]              │
├──────────────────────────────────────────┤
│                                          │
│ Front Desk: Schedule, Customers,         │
│             Staffing Map                 │
│                                          │
│ Back Office: My Team, My Business,       │
│              AI & Insights               │
│                                          │
│ Admin* (* super-admin only)              │
│ [theme dropdown] [settings] [logout]     │
└──────────────────────────────────────────┘
```

---

## Scheduler — Complete Redesign (March 2026)

### Orientation: Rows = Staff, Columns = Hours

**Decision:** Rows are staff members, columns are hours of the day. This is a complete flip from the original.

**Why:** Original had time going down, staff going across. With 3 staff it worked. With 8–15 staff it falls apart — columns squish or break. New orientation scales naturally — add 20 staff and the grid grows down the page.

### Fixed Staff Names Panel

Staff names must remain visible at all times as the user scrolls horizontally.

**Implementation:** Two separate scroll containers:
- **Left panel (160px):** Staff names only. Fixed, no horizontal scroll. Syncs vertically with appointment rows.
- **Right panel:** Hour header + appointment rows. Scrolls both horizontally and vertically.
- JS scroll sync: right panel horizontal → header syncs. Right panel vertical → left panel syncs.

Do NOT use CSS `position: sticky` — it breaks because the scroll container cuts it off. The split panel approach is required.

### Full 24-Hour Day

Render all 24 hours (midnight to midnight). On load, auto-scroll to 1 hour before the earliest appointment (or 7am if no appointments).

### Business Hours Visual Distinction

Closed hours (outside business hours) get `background: rgba(0,0,0,0.28)` on both the hour header cell and slot cells. Business hours have transparent background.

**No OPEN/CLOSE labels.** The color contrast tells the story. Labels are redundant noise.

### Zoom Control

`−/+` buttons in the scheduler header control `COL_W` (column width). Default 72px = 100%. Range: 36px–140px, increments of 16px. Shows percentage label. Persists in state during session.

### Staff Quick Profile Card

Clicking a staff member's name opens a compact read-only card. **Read-only. No editing.**

**Exact layout:**
```
[Avatar]  Name
          Role
─────────────────────
Today     X appts · X hrs
Shift     7am – 4pm
─────────────────────
SKILLS
  Flat Repair (On-site)
  Seasonal Tire Swap
  Tire Rotation
  New Tire Install (x4)
  Balancing
```

Skills are a **vertical indented list** under the SKILLS header. Not pills, not checkmarks, not left-to-right. Eyes go down a list naturally — left-to-right breaks the scan pattern and forces the brain to separate words. SKILLS is the header, indented list beneath reads as its children.

Card anchors below the clicked name cell. Repositions above if near bottom of screen. Dismisses on any outside click. Hover state on name cell: `var(--accent-muted)` background + pointer cursor.

### Skills View Toggle (To Build)

Add a toggle at the top of the scheduler: **Hours | Skills**

**Hours mode:** One bar per staff member showing their shift duration.

**Skills mode:** Stacked bars within each staff member's shift hours. Each skill is a separate horizontal bar spanning their working hours.

**Color logic:** Skill-based color, not person-based. "Oil Change" is always the same color regardless of who performs it. This lets the manager scan a column and instantly see which skills are available at any hour. Multiple people with the same color bar = multiple people covering that skill.

**Label:** Sits at the left edge of the bar. Readable when wide enough, gracefully disappears (color only) at small zoom.

**Example:**
```
Mike    [Oil Change      8am ————————————— 4pm]
        [Tire Rotation   8am ————————————— 4pm]

Carlos  [Oil Change      8am ———————— 3pm     ]
        [Tire Rotation   8am ———————— 3pm     ]
```

**This replaces Coverage Map entirely.** See below.

### Drag to Reorder Staff Rows (To Build)

Staff rows are draggable. Drag handle on the left edge of the name cell (grip icon, same as tenant reorder in admin panel).

**Save behavior:**
- Save button appears in header when unsaved changes exist ("Save Order" + "Discard")
- Save clicked → persists, same order next visit
- Discard clicked → reverts immediately, no prompt
- Navigate away without saving → silently reverts, no prompt, no nag
- Close browser/tab → reverts, no prompt
- **Default: NOT saved on exit.** Intentional. If they wanted to save they would have clicked Save.

---

## Coverage Map — Removed

**Decision:** Remove Coverage Map from navigation entirely.

**Why (important):**

The original Gap Analysis told managers: "Carlos not certified," "Dana unavailable after 1pm," "50% staffed," "CRITICAL GAP." This is the system telling managers how to run their business. We don't know what 50% means for their operation. We don't know if they need seasonal tire swaps in July (they don't — and showing that warning erodes trust). We don't know if 2 cashiers at 9pm is fine or a disaster. Only the manager knows.

The gap analysis was also vague and actionless. A bar showing "50% coverage" doesn't tell you which hours, which days, or what to do about it. It creates noise without signal.

**The replacement:** The Skills toggle in the scheduler IS the coverage tool. Who is on the floor, when, what they can do. Manager looks at it and decides if they're covered. No percentages, no warnings, no opinions from us.

**Remove from:** sidebar navigation, routing, and all references.

---

## Detail Panel — Keep Existing Right-Side Pane

**Decision:** Keep the existing List + Detail right-side pane pattern. Do NOT adopt a floating bottom-right card.

**Why:** The floating card is a peek surface. The real app needs an editing surface — change time, reassign staff, update notes. Existing pane supports inline editing. That functionality must not be lost.

Reskin to match dark theme. Do not restructure.

---

## Analytics — Rebuilt Around Real Business Questions

**Old version was wrong.** It showed: appointment count, estimated revenue, avg booking value, bar charts of services and staff. A business owner would look at it and say "this is useless to me." Numbers without context, no action implied.

**Philosophy:**
> We give them numbers so they can look at their own business and figure it out. We surface patterns that make them ask WHY. We are not answering their questions — we are holding a mirror.

**Note on total calls:** This is NOT a vanity metric. Total calls over time reflects whether marketing is working. You run a Facebook ad in March, calls spike — that's the connection. Show as a trend over time, not just today's number.

### The Six Metrics (Phase 1)

**1. Call Volume Over Time**
Trend over days/weeks. Reflects marketing effectiveness. "14 calls today" is vanity. "Calls up 40% since March" is signal.

**2. Call to Booking Conversion — by day and by hour**
Calls in vs bookings made. Where is the gap? Big gap on Saturday might mean the AI can't handle weekend volume. Gap at 2pm every day might mean something else. We show it, they investigate.

**3. Busiest Hours**
When is the phone ringing? When are bookings made? These are often different times. Staffing decisions live here.

**4. Caller Abandonment Point**
At what point in the conversation do people hang up? If 31% abandon at "checking availability" that's a script problem or an availability problem. Highlight worst offenders. We show where, they figure out why.

**5. Return Rate by First Service**
Of customers whose first booking was a specific service, how many came back? Low return on high-volume service worth a closer look. No judgment from us — just the pattern.

**6. No-Show Pattern**
Which days have the most no-shows? Color coded. Patterns here often have meaning the owner will recognize.

### What We Explicitly Do NOT Build (Phase 1)

- "AI Performance Score" — meaningless without context
- Average call length — interesting, not actionable
- Staff request tracking — lives in unstructured notes, can't be reliably parsed. Phase 2 when AI captures it as structured data during the call.
- Upsell attachment rate — Phase 2, requires upsell feature first
- Revenue per customer lifetime — requires payment data
- Real-time AI call data (calls answered today, etc.) — now sourced from `voice_sessions` (the LiveKit agent's call records, post-Vapi); shipped via the 2026-06-12 analytics work

### Staff Request Tracking (Future Note)

Staff requests ("I want Suzy") currently live in free-text notes. Can't be reliably parsed. To track properly we need:
- Structured field on booking: "Requested staff member"
- AI to recognize preference during call and capture it explicitly

This is valuable especially for salons (80% of calls asking for one stylist = business risk if they leave). Defer to Phase 2. Don't show in analytics until data is clean.

---

## Current Views (12 components)

> **Stale snapshot (March 2026).** Tab ids + the view list below predate the single-primary-bar nav and later view splits/renames. For the live component map see `docs/architecture/ARCHITECTURE.md` §16.4. Kept as the original design-session inventory.

| Tab ID | Component | What it does |
|--------|-----------|-------------|
| `all-businesses` | SuperAdminDashboard | Multi-tenant management (super-admin only) |
| `appointments` | AppointmentView | Scheduler — REDESIGN per spec above |
| `crm` | CRMView | Customer list + detail pane (contact info, appointments, call history, notes, search) |
| `staff` | EmployeeManagementView | Employee list with add/edit/delete |
| `staff-shifts` | ShiftManagementView | Employee shift scheduling |
| `service-catalog` | ServiceAssignmentView | Service definitions with duration, price, employee/resource assignments |
| `manage-resources` | ResourceManagerView | Physical resource management (bays, trucks, chairs) |
| `skill-matrix` | SkillMatrixView | Grid matching employee skills to resource capabilities |
| `knowledge-base` | KnowledgeBaseView | RAG document upload and management |
| `ai-tuning` | AIConfigView | System prompt, voice ID, first message, persona settings |
| `analytics` | AnalyticsView | REBUILD per spec above |
| `settings` | SettingsView | Calendar sync, tenant configuration |

---

## Vocabulary System

UI labels adapt per business type via 3-tier fallback:
1. Tenant override (owner changed "Bay" to "Stall")
2. Template default (auto-shop template says "Bay")
3. Hardcoded fallback ("Resource")

31 business types across 6 categories (`supabase/seed.sql`). Vocabulary changes: Bays/Technicians for tire shops, Chairs/Stylists for salons, Bays/Mechanics for auto shops, etc.

**Implementation status:** Complete. Vocabulary columns on both `business_templates` and `tenants` tables, `useVocabulary` hook + React Context, and all 21 business-facing components wired to use vocabulary labels.

---

## Implementation Scope

| # | Item | Type | Status | Notes |
|---|------|------|--------|-------|
| 1 | Restructure sidebar from 12 → 5 grouped sections | UI/UX | **Done** | |
| 2 | Update tab routing logic | Coding | **Done** | |
| 3 | MyTeamView composite (Employees + Shifts + Skills) | Both | **Done** | later merged into the `Setup` tab (2026-06-03) |
| 4 | MyBusinessView composite (Services + Resources + Knowledge) | Both | **Done** | later merged into the `Setup` tab (2026-06-03) |
| 5 | AIInsightsView composite (AI Persona + Analytics) | Both | **Done** | |
| 6 | Mobile bottom nav (5 items) | UI/UX | **Done** | |
| 7 | Public sign-up page | Both | **Done** | `dashboard/app/register/` (with a required legal-consent checkbox) |
| 8 | Public registration API | Coding | **Done** | |
| 9 | Business type picker (card grid) | UI/UX | **Done** | `SetupWizard/BusinessTypePicker.tsx` |
| 10 | Onboarding wizard (6-step) | Both | **Done** | `SetupWizard/` (grew to 7 steps + solo/team mode chooser) |
| 11 | `useVocabulary` hook + React Context | Coding | **Done** | 3-tier fallback |
| 12 | Replace hardcoded labels with vocabulary | Both | **Done** | 21 components wired |
| — | Google Calendar OAuth + sync | Both | **Done** | Real OAuth, auto-sync on mutations |
| 13 | Settings: "Customize Labels" section | Both | Missing | |
| 14 | Dashboard home / quick actions landing | UI/UX | **Done** | `home/DashboardHome.tsx` |
| 15 | Contextual navigation (CRM → Calendar links) | Both | Missing | |
| 16 | Empty states with helpful guidance | UI/UX | Missing | |
| **17** | **Apply dark sidebar visual style to real app** | **UI/UX** | **Done** | All components use CSS vars, all themes dark |
| **18** | **Rebuild theme system with font variables** | **Coding** | **Done** | `--font-display`/`--font-body` in all 8 themes |
| **19** | **Flip scheduler: rows=staff, columns=hours** | **Both** | **Done** | NewSchedulerView: 24hr, split-panel scroll sync |
| **20** | **Staff quick profile card** | **UI/UX** | **Done** | Read-only, anchored, outside-click dismiss, skills list |
| **21** | **Skills toggle in scheduler** | **Both** | **Done** | Hours (shift bar + appts) / Skills (stacked skill bars) |
| **22** | **Drag to reorder staff rows** | **Both** | **Done** | Grip handles, save/discard, persists to localStorage |
| **23** | **Rebuild analytics — 6 real metrics** | **Both** | **Done** | now driven by `voice_sessions` (LiveKit agent records); call-based panels shipped 2026-06-12 |
| **24** | **Remove Coverage Map from navigation** | **Both** | **Done** | ServiceCoverageView.tsx deleted, zero references |
| **25** | **Theme switcher → dropdown** | **UI/UX** | **Done** | dropdown (`layout/ThemeSelectorDropdown.tsx`) |

**Bold rows** = new work items from March 24, 2026 design session.

---

## Design Constraints

- **Tailwind CSS only** — no external component libraries
- **Lucide icons** — consistent icon set already in use
- **Dark mode support** — all themes must work (all are dark by default now)
- **Mobile-first** — bottom nav on mobile, sidebar on desktop
- **No new dependencies** — use what's already installed
- **Existing UI primitives** — Button, Card, Input, Select, Modal, Badge in `components/ui/`

---

## April 2026 UI/UX Audit

A comprehensive code review audit was conducted on April 9-10, 2026. 35 issues were identified and all resolved:
- 7 Critical (validation, error feedback, crash prevention)
- 13 High (accessibility, confirmations, mobile, theming)
- 15 Medium (polish, consistency, navigation)

Key new components added:
- `ConfirmModal` + `useConfirm()` hook — replaces all browser `confirm()` calls
- Toast improvements — dismissable, duration by type, stacking limit
- `TimeInput` — label association via useId(), error prop, theme-aware colorScheme

Playwright e2e testing validates all critical fixes and a 12-step functional audit across every major view.
