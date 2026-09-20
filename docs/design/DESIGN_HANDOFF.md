# SecretaryHQ — Design & UX Handoff Document
**Date:** March 24, 2026  
**From:** Dale (Product Owner) + Claude (Web)  
**To:** Claude Code  
**Purpose:** Full context on every UI/UX decision made during a live design session. You were not in this conversation — this document is written so you feel like you were. Do not second-guess these decisions without explicit instruction from Dale.

> **Role of this file (vs. `UI_UX_DESIGN.md`):** this is the **frozen** snapshot of decisions reached on 2026-03-24. Treat it as historical record-of-decision: do not edit content unless Dale explicitly reopens a decision. For the **living design brief** that evolves over time, see [`UI_UX_DESIGN.md`](UI_UX_DESIGN.md).

> **Outdated references (the design decisions still hold; the named tech/tenant don't):** **DynaTire** appears throughout as the reference tenant — it was a PoC, removed 2026-06-03 (Bella's Hair Studio is the surviving demo tenant; Dale's real business is Thinking Hammer LLC). **Vapi** (§7 analytics "requires Vapi") was replaced by the LiveKit agent + `voice_sessions` in commit `661d21d` (2026-04-27); the call-data metrics shipped 2026-06-12. The §3 two-tab nav decision was itself superseded 2026-05-06 (see the §3 note). The §3 "My Business / My Team" destinations were later merged into one **Setup** tab (2026-06-03), and the default theme is now `navy` (`see `dashboard/lib/ThemeContext.tsx``). Frozen text left intact below.

---

## About This Document

Dale and I spent an extended session working through the demo, the real app, and a series of UX decisions. Every decision here was discussed, debated, and landed on deliberately. The reasoning is included because context matters — knowing *why* a decision was made prevents you from accidentally undoing it.

The working artifact from this session is `secretaryhq-demo.html` — an interactive in-browser demo with no backend, no database, all mock data in memory. It is **not** the real app. It is a design reference and prospect-facing demo. The real app (Next.js dashboard) should be reskinned to match the decisions documented here.

---

## 1. Fonts — Bebas Neue + DM Sans

**Decision:** Bebas Neue (display/headers) + DM Sans (body) everywhere. Universal. Not swappable per business template.

**Reasoning:** Bebas Neue only appears in page titles, stat numbers, the logo, and section headings. Everything else — nav items, labels, table data, form fields, body copy — is DM Sans. The concern was raised that Bebas Neue feels "masculine" and might not suit salons or spas. Dale's response: the font isn't what makes something feel masculine or feminine — the color palette does that work. A salon owner seeing their page title say SCHEDULE in Bebas Neue is not going to feel out of place. It's the SecretaryHQ brand. It stays.

**Implementation:** All CSS should reference `--font-display` and `--font-body` variables. Never hardcode font families in components.

---

## 2. Theme System — CSS Variables, Font Variables Included

**Decision:** Rebuild all 8 existing themes to include font variables (`--font-display` and `--font-body`) alongside color variables. Theme switcher controls colors only for now — fonts stay Bebas Neue + DM Sans across all themes. But the architecture supports per-theme font changes if needed later.

**Reasoning:** The existing theme system only had color variables. Adding font variables gives flexibility without committing to different fonts per theme today. Dale explicitly said he wants the ability to change fonts per theme if needed down the road — so the variable structure needs to be there even if all themes currently point to the same fonts.

**Theme switcher:** Must be a **dropdown**, not buttons. Reasons: (1) cleaner in the topbar, (2) scales to 8+ themes without breaking layout, (3) future-proofs custom theme creation — a user-created "My Brand Theme" is just another dropdown option. This was a deliberate UX decision, not a space-saving shortcut.

**Custom themes (future):** Dale wants to eventually let users create a custom theme — pick a base theme, adjust accent color to match their brand, name it, save it. The saved theme becomes another entry in the dropdown. The CSS variable architecture already supports this — you'd just write new variable values dynamically. Don't build this now but don't architect against it.

**Three themes in the demo:** Navy (dark navy + blue), Rose (dark burgundy + pink), Forest (dark green). These are demos of the concept. The real app has 8 themes — apply the same variable structure to all of them.

---

## 3. Navigation Structure — Single Primary Bar

**Decision (superseded 2026-05-06):** The earlier Front Desk / Back Office two-tab layout was retired in favor of a single primary tab bar. Daily-use destinations (Home, Schedule, Customers, Calls) are always visible; configuration destinations (My Business, My Team, Phone Assistant) are appended for owners and super-admins only. Front-desk-only logins see the Primary group only. The dark sidebar visual language from the demo still applies — only the structural split was removed.

**Reasoning:** External review flagged the two-mode toggle as cognitively expensive for non-technical users — staff had to learn a meta-concept ("which mode am I in?") before they could find the action they wanted. Flattening to a single bar makes the most-used destinations one click away and lets role-based gating (rather than mode-switching) hide the configuration surface from front-desk staff.

**Sidebar visual spec (from demo):**
- Background: `--bg-surface`
- Active item: left border `2px solid var(--accent)` + background `var(--accent-muted)`
- Section labels: `10px, font-weight 600, letter-spacing 0.12em, uppercase, color var(--text-muted)`
- Nav items: `13px, color var(--text-secondary)` default, `var(--text-primary)` active
- Icons: `14x14px, opacity 0.6` default, `opacity 1` active

**Sidebar bottom — "Go to Scheduler" link:**
The demo previously had a "Quick Book" button always visible in the sidebar. This was removed. Replaced with a simple navigation link "Go to Scheduler to book." Reason: you can't book without seeing the schedule — you'd have no way to know if you're double-booking someone. Booking must happen inside the Scheduler where availability is visible.

---

## 4. Scheduler — Complete Redesign

This is the most significant change. The scheduler was completely rethought during this session.

### 4a. Orientation — Rows = Staff, Columns = Hours

**Decision:** Flip the scheduler 90 degrees from the original implementation.
- **Rows** = staff members (one row per person, scrolls vertically)
- **Columns** = hours of the day (left to right, scrolls horizontally)

**Reasoning:** The original had time going down and staff going across. With 3 staff it looked fine. With 8–15 staff it falls apart — columns squish or break out of the container entirely. The new orientation scales naturally — add 20 staff members and the grid just grows down the page. The manager scrolls down to see more people, left/right to see more of the day. This is how real scheduling boards work.

### 4b. Fixed Staff Names Panel

**Decision:** Staff names must remain visible at all times as the user scrolls horizontally through the hours.

**Implementation:** Split into two separate scroll containers:
- **Left panel (160px wide):** Staff names only. Fixed, no horizontal scroll. Scrolls vertically in sync with the appointment rows.
- **Right panel:** Hour header + appointment rows. Scrolls both horizontally and vertically.
- **Sync:** When the right panel scrolls vertically, the left panel scrolls to match. When the right panel scrolls horizontally, the hour header scrolls to match.

This is NOT achievable with CSS `position: sticky` alone because the scroll happens on a container that breaks sticky. It requires the split panel approach with JS scroll sync.

### 4c. Full 24-Hour Day

**Decision:** Render all 24 hours (midnight to midnight), not just business hours.

**Reasoning:** If a business opens at 6am, the old 8am–5pm range doesn't work. Different businesses have wildly different hours. The full day is always rendered.

**Auto-scroll on load:** On render, automatically scroll to 1 hour before the earliest appointment (or 7am if no appointments). This means a 6am shop lands at 5am, an 8am shop lands at 7am. Nobody has to manually scroll to find their day.

### 4d. Business Hours Visual Distinction

**Decision:** Closed hours (outside business hours) are visually darker. No OPEN/CLOSE labels — the color change tells the story.

**Implementation:** Each business has `openHour` and `closeHour` defined. Hours outside that range get `background: rgba(0,0,0,0.28)` applied to both the hour header cell and the slot cells. Business hours have transparent background. The contrast is enough to immediately read "this is the active window."

**Why no labels:** "OPEN" and "CLOSE" text was tried and removed. It's redundant — if you can see the darker zone you already know. Labels added noise without adding information.

**Business hours defined:**
- DynaTire: 7am–6pm
- Bella's Hair: 9am–7pm  
- QuickFix Auto: 7am–5pm

### 4e. Zoom Control

**Decision:** Add zoom −/+ controls to the scheduler header.

**Reasoning:** At default zoom you see the full day comfortably. Zoomed out you see more hours at once for overview. Zoomed in you have more space for appointment details and easier clicking.

**Implementation:** `state.zoom` controls `COL_W` (column width in px). Default 72px = 100%. Range: 36px minimum to 140px maximum. Zoom in/out increments of 16px. Zoom label shows percentage. Calling `setZoom(delta)` re-renders the scheduler at the new zoom level while maintaining scroll position.

### 4f. Staff Quick Profile Card

**Decision:** Clicking a staff member's name row opens a compact read-only profile card.

**Reasoning:** Manager is mid-scheduling and needs to quickly answer "can this person do this service?" or "when do they leave today?" Without leaving the scheduler. The card is purely informational — no editing. Editing belongs in My Team.

**Card contents (exact layout agreed upon):**
```
  [Avatar]  Name
            Role
  ─────────────────────
  Today     X appts · Xhrs
  Shift     7am – 4pm
  ─────────────────────
  SKILLS
    Flat Repair (On-site)
    Seasonal Tire Swap
    Tire Rotation
    New Tire Install (x4)
    Balancing
```

**Skills display:** Vertical list, indented under "SKILLS" header. SKILLS is uppercase label, skills are indented beneath it as natural children. No checkmarks, no icons, no pills. Just a clean indented list. Left to right reading breaks the scan pattern — eyes go down a list naturally, not across. This was specifically discussed and decided.

**Interaction:** Anchors below the clicked name cell. Stays on screen if near bottom (positions above instead). Closes on any click outside. No buttons, no editing, read-only.

**Hover state on name cell:** Subtle background highlight `var(--accent-muted)` + cursor pointer to indicate it's clickable.

### 4g. Skills View Toggle (to be built)

**Decision:** Add a toggle to the scheduler — "Hours" | "Skills" — that changes how staff rows are displayed.

**Hours mode (current):** One bar per staff member showing their shift.

**Skills mode (to be built):** Stacked bars within each staff member's shift hours. Each skill is a separate bar, same color across all staff for that skill. Bar spans the employee's working hours. Label at the left edge of the bar.

**Example:**
```
Mike    [Oil Change      8am ————————————— 4pm]
        [Tire Rotation   8am ————————————— 4pm]
        [Balancing       8am ————————————— 4pm]

Carlos  [Oil Change      8am ———————— 3pm     ]
        [Tire Rotation   8am ———————— 3pm     ]
```

**Color logic:** Skill-based color, not person-based. Oil Change is always the same color regardless of who's doing it. This lets the manager scan a column at any hour and immediately spot which skills are available. Multiple people with the same color = multiple people covering that skill at that time.

**Label placement:** Left edge of the bar. Readable when bar is wide enough, gracefully disappears (color only) when zoomed out too far.

**Why this replaces Coverage Map:** The manager looks at this view and instantly sees what's covered and when. They decide if it's enough. We don't tell them. See Section 5.

### 4h. Drag to Reorder Staff Rows (to be built)

**Decision:** Staff rows should be draggable to reorder. Manager can pull people they want to compare next to each other.

**Pattern:** Same drag-and-drop pattern as the existing tenant reorder in the admin panel. Drag handle on the left edge of the name cell (grip icon). Row lifts slightly during drag, others shift to show drop target.

**Save behavior:**
- **Save button** appears in scheduler header when unsaved changes exist — "Save Order" and "Discard"
- **If Save clicked:** Persists. Same order next visit.
- **If Discard clicked:** Reverts immediately, no prompt.
- **If user navigates away without saving:** Silently reverts. No prompt, no nag. Default is NOT saved.
- **If user closes browser/tab:** Reverts. No prompt.

**Reasoning:** Dale was explicit — default to not saving if they leave. If they wanted to save they would have hit Save. Don't interrupt a busy manager with a "are you sure?" dialog.

---

## 5. Coverage Map — Removed

**Decision:** Remove Coverage Map from the sidebar and navigation entirely.

**Reasoning (important — read this carefully):**

The original Coverage Map showed gap analysis — "Carlos not certified," "Dana unavailable after 1pm," "50% staffed." This was us telling the manager how to run their business. We don't know what 50% means for their operation. We don't know if they need seasonal tire swaps in July (they don't). We don't know if 2 cashiers at 9pm is fine or a disaster. Only the manager knows.

The gap analysis was also vague and actionless. A bar showing "50% coverage" doesn't tell you *which* hours, *which* days, or *what* to do about it. It creates noise without signal.

**The replacement:** The Skills toggle in the scheduler (Section 4g) IS the coverage tool. It shows who is on the floor, when, and what they can do. The manager looks at it and decides if they're set. No percentages, no warnings, no system opinions. Just a neutral staffing picture.

**Philosophy that drove this decision:**
> We surface the data. They manage the business. We are a scheduling tool, not a management consultant.

This came up repeatedly throughout the session. Our job is to show information clearly. Their job is to interpret it. Any time the UI starts telling the user what's wrong or what to do, we've overstepped.

---

## 6. Detail Panel — Keep Existing Right-Side Pane

**Decision:** Do not adopt the demo's floating bottom-right detail card for the real app. Keep the existing List + Detail right-side pane pattern throughout.

**Reasoning:** The demo's floating card is fine for a demo where users are clicking around. In the real app, users need to actually edit appointments — change the time, reassign staff, update notes. The floating card is a peek surface, not an editing surface. The existing right-side pane supports inline editing and that functionality must not be lost.

**Reskin:** Apply the dark theme visual style to the existing pane. Don't restructure it.

---

## 7. Analytics — Rebuilt Around Real Business Questions

**Decision:** Completely rebuild the analytics screen. The old version was a vanity dashboard — numbers without context, no actionable insight. A business owner would look at it and say "this is useless to me."

**Philosophy:**
> We give them numbers so they can look at their own business and figure it out. We aren't answering questions — we're surfacing patterns that make them ask WHY.

**The six metrics we actually build (Phase 1):**

1. **Call Volume Over Time** — reflects marketing effectiveness. "14 calls today" is vanity. Call volume trending up 40% since you ran a Facebook ad — that's signal. Show as trend over time, not just today's number.

2. **Call to Booking Conversion** — calls in vs bookings made, by day and by hour. Where is the gap? A big gap on Saturday might mean the AI can't handle weekend call volume. A gap at 2pm every day might mean something else. We show it, they investigate.

3. **Busiest Hours** — when is the phone ringing? When are bookings actually made? These are often different times. Staffing decisions live here.

4. **Caller Abandonment Point** — at what point in the call do people hang up? If 31% abandon at "checking availability" that's a script problem or an availability problem. Highlight the worst offenders. We show where, they figure out why.

5. **Return Rate by First Service** — of customers whose first booking was a specific service, how many came back? Low return on a high-volume service is worth a closer look. We don't say "this is bad" — we just show the pattern.

6. **No-Show Pattern** — which days have the most no-shows? Color coded (green/yellow/red). Patterns here often have meaning — Saturday morning bookings at this shop consistently no-show. Owner can act on that.

**What we explicitly decided NOT to include:**
- "AI Performance Score" — meaningless without context
- Average call length — interesting but not actionable
- Staff request tracking — data lives in unstructured notes, can't be reliably parsed. Phase 2 when AI captures it as structured data.
- Upsell attachment rate — Phase 2, requires upsell feature to be built first
- Revenue per customer lifetime — requires payment data we don't have
- Real-time AI call data (calls answered today, etc.) — Phase 2, requires Vapi call logs integration

**Note on total calls:** This is NOT a vanity metric. Total calls over time reflects whether marketing is working. Dale was explicit about this — we originally called it vanity and were corrected. Show it as a trend.

---

## 8. Business Switcher — Dropdown

**Decision:** The business type switcher (DynaTire / Bella's Hair / QuickFix Auto) in the demo is a dropdown, not three buttons.

**Reasoning:** Cleaner, scales better, consistent with the theme switcher. This only applies to the demo. In the real app there is no "business switcher" — each tenant sees their own business.

---

## 9. Two Versions of the Demo

**Decision:** There will be two separate demo versions:

**Version 1 — Public Demo** (lives on the landing page at `/demo`)
- Simple, impressive, shows "wow" moments
- Live call transcript, swimlane scheduler, customer profiles
- Enough to make a prospect pick up the phone or hit Start Trial
- No deep config views — they don't need to see My Team to be sold
- This is `secretaryhq-demo.html`

**Version 2 — Customer App** (the real dashboard)
- Complete — all views, all functionality
- Skill Relationship Map, My Team, My Business, Phone Assistant, Settings, SuperAdmin
- Fully themed with all decisions in this document applied
- This is what paying customers use

Both use the same visual language, same CSS variables, same fonts.

---

## 10. The "Secretary HQ" Name

**Decision:** The logo reads "Secretary HQ" with a space. Not "SecretaryHQ."

---

## 11. General Philosophy — Applied Throughout

These principles came up repeatedly and should inform every future UI decision:

**We show data. They manage their business.**
Every time the UI starts telling users what's wrong, what to do, or grading their operation — stop. Show the information clearly. Let them interpret it. They are the expert on their own business.

**No babysitting.**
We don't need to tell a tire shop owner that nobody is scheduled for seasonal tire swaps in July. They know it's July. Showing that warning would erode trust in the system because it would constantly fire with information the owner already knows is intentional.

**Managers are still needed to manage.**
The software is a tool. It doesn't replace judgment. Jimmy being new, the bay count constraint, who works well together — we don't know any of that. The coverage view shows who can do what. The manager decides if it's enough.

**Plain language over technical terms.**
"Remembers your customers" not "CRM." "Answers questions from your own documents" not "RAG." "AI only says what's actually true" not "two-layer knowledge system with DB facts." Every label, every tooltip, every description should be written for a tire shop owner, not a developer.

**Vocabulary adapts per business type.**
Bays for tire shops. Chairs for salons. Technicians vs Stylists vs Mechanics. This is already built — preserve it in every new view.

---

## Files Referenced

- `secretaryhq-demo.html` — the interactive demo built during this session
- `ARCHITECTURE.md` — system architecture reference
- `UI_UX_DESIGN.md` — existing UI/UX documentation (apply this document's decisions on top of it)

---

## What To Build Next (Priority Order)

1. **Apply dark theme visual style to real Next.js dashboard** — sidebar, page titles, cards, all using CSS variables from this document
2. **Rebuild theme system** — add `--font-display` and `--font-body` to all 8 themes, implement dropdown switcher
3. **Flip the scheduler** — rows = staff, columns = hours, sticky names, business hours shading, zoom control
4. **Staff quick profile card** — read-only, anchored to name cell, exact layout spec above
5. **Skills toggle in scheduler** — Hours | Skills mode, skill-based coloring, labeled bars
6. **Drag to reorder staff rows** — same pattern as tenant reorder, save/discard, default no-save on exit
7. **Rebuild analytics** — six metrics, real questions, no vanity numbers
8. **Remove Coverage Map** from navigation entirely

---

*This document represents a single focused design session. Every decision was made deliberately with reasoning. When in doubt, ask Dale — don't assume.*
