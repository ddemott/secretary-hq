# SecretaryHQ — Beta Customer Onboarding Guide

> First-day-through-first-week walkthrough for a new beta tenant. Closes
> the gap that until this doc existed, a beta customer needed a
> screen-share with the founder to get from "I'd like to try this" to
> "my voice AI is taking real calls." Tracked closed in
> `docs/planning/TODO.md`. Author/owner: founder + dashboard team.

This guide assumes a brand-new tenant. If your account was pre-seeded
with demo data (e.g., DynaTire/Bella's during the demo period), skip to
the "Extending past the demo" section.

---

## What you should have ready before Day 1

You will move faster if you collect these before you log in. None are
strictly required at signup — you can fill them in piece by piece — but
the setup wizard asks for them in this order.

| Item | Why we need it |
|---|---|
| **Business name** | Shown to callers in the AI's first greeting. |
| **Time zone** | Drives every booking time, reminder schedule, and call-log timestamp. Get this right on Day 1 — changing it later requires re-converting historical timestamps. |
| **Employee list** with names + phone numbers | The technicians/stylists/staff who will appear on the schedule and who will appear on the schedule (team path). Solo path creates you as the owner automatically. |
| **Service list** with duration + price | The bookable offerings the AI proposes to callers. Picking a business type pre-seeds starter services you can edit.
| **Resource list** (trucks/bays/chairs) | Whatever can host one appointment at a time. Team path seeds one default resource; solo creates one on finalize. The booking RPC blocks overlapping bookings on the same resource.
| **Weekly business hours** | One opening time + closing time per day-of-week, used to populate the first 4 weeks of `employee_schedule`. |
| **Who does which services** (team path) | Which employees (and resources) each service uses. In the live wizard this is a manual toggle step — not an automatic "matching skill" default. |
| **A handful of policy answers** | Cancellation policy, refund policy, what to bring to an appointment, payment methods accepted. The AI reads these aloud when callers ask. |

---

## Day 1 — Getting in and looking around (~20 minutes)

### 1. First login

You should have received an invite email with a magic link. Click it
and set your password. From then on you log in at
`https://<your-dashboard-url>/dashboard` with your email + password.

Tip: your browser will probably remember the login. The session lasts
8 hours; after that you re-enter your password.

### 2. The four main tabs

Across the top of the dashboard you have four primary tabs:

| Tab | What it's for |
|---|---|
| **Home** | Today at a glance — a "Next 3 Days" appointment view, upcoming-appointment stats, any owner-action items. The "morning coffee" view. |
| **Schedule** | The full calendar. Four sub-views: Technicians (rows = staff, columns = hours), Resources (rows = trucks/bays), List (chronological), Calendar (month/week). |
| **Customers** | Your CRM — list + per-customer detail panel with appointment history. |
| **Calls** | Recordings + transcripts of every call the AI handled. Used for reviewing what the AI said and didn't say. |

If you're an owner or admin, you also see two more top-level tabs for the
things you set once and rarely touch:

| Tab | What it controls |
|---|---|
| **Setup** | Sub-tabs for Services, resources, your staff, Working Days (weekly shifts), Who Can Do What, Team Access (staff logins + invites), Business Settings, Billing, Audit Log, and Answer Debugger. Also holds the **Setup Assistant** button that re-opens the wizard. |
| **Phone Assistant** | **AI Persona** (voice, greeting, forwarding to a person) and **Knowledge Base** (Teach Your AI, Upload Documents, Review Everything, Suggestions). |

---

## Day 1 — Setup wizard (~30 minutes)

The setup wizard auto-runs on first login. If you closed it, find it
again from **Setup → Setup Assistant**.

Live UI (`dashboard/components/SetupWizard/`): you always start with a
short prelude, then an explicit **solo vs team** choice — not a question
buried inside step 1.

### Prelude (same for everyone)

1. **Welcome** (`WizardWelcome`) — short intro; continue into setup.
2. **How is your business set up?** (`WizardModeChooser`)
   - **Just me** → solo path (you handle all appointments).
   - **I have a team** → team path (employees provide services).
3. **What kind of business?** (`BusinessTypePicker`) — pick the closest
   industry template. That choice:
   - Sets vocabulary (e.g., "Stylist" vs "Technician") and AI tone.
   - **Seeds starter services** from the template's `example_services`
     (you can edit/add/remove them in the next screens).
   - On the **team** path, also seeds **one default resource** (rename or
     add more later).
   - Does **not** invent a full skill/role matrix. Team service↔employee
     mapping is a later manual step.

You can go back to change business type; auto-seeded starter rows are
cleared so the new template can reseed cleanly.

### Solo path — 4 steps (~10 minutes)

| # | Step | What you do |
|---|---|---|
| 1 | **What you offer** | Review/edit the seeded services (name, duration, price). Need at least one service to continue. |
| 2 | **When you work** | Set your weekly hours. The wizard ensures an owner employee exists for you. |
| 3 | **Teach Your AI** | Answer caller/policy questions the AI should know. |
| 4 | **Look it over / go live** | Review, then finalize. On finalize the wizard **auto-assigns every service to you (the owner) and a default resource** — there is **no** separate mapping screen on the solo path. Phone activation follows. |

### Team path — 9 steps (~25 minutes)

| # | Step | What you do |
|---|---|---|
| 1 | **What you offer** | Services CRUD on the draft catalog (starter services already seeded). |
| 2 | **Where it happens** | Resources CRUD (one default resource already seeded). |
| 3 | **Who works here** | Add employees (name / email / phone). The wizard does **not** collect skill tags here. |
| 4 | **When they work** | Per-employee weekly hours (local draft until commit). |
| 5 | **Who does what** | Manual toggles (`StepAssignments`): for each service, choose which employees can perform it and which resources it uses. Mappings **start empty** — there is **no** "every employee with a matching skill" auto-default in the live UI. |
| 6 | **Look it over** | Coverage / review before commit. |
| 7 | **Import from website** (optional) | Paste your URL; the AI scans public pages and pre-fills what it can. Skip if you prefer. |
| 8 | **Teach Your AI** | Caller/policy questions (review anything the website import pre-filled). |
| 9 | **You're live** | Entity graph commits as you enter go-live; activate the phone. The AI is reachable on the provisioned number within about a minute. |

After go-live you have a working booking system. You can start
testing calls immediately.

**Website import detail.** The optional import (team step 7; also
reachable from knowledge setup) pre-fills policy answers and may stage
extra suggestions for review. Pre-filled answers are editable before
anything is treated as final. You can skip the scan and answer by hand.
(See "Knowledge base setup" below.)

### Common wizard mistakes (and how to avoid them)

- **Skipping hours / shifts**: every booking the AI tries to make needs
  coverage for the requested time (your hours on solo; employee shifts on
  team). Skip this and callers hear that nothing is available.
- **Leaving "Who does what" empty (team step 5)**: services with no
  employee or resource toggled on cannot be booked. Assign at least one
  employee (and resource, when required) per service before go-live.
- **Time zone wrong**: appointments show up in everyone's local time
  except yours. The owner-facing Setup tabs have no time-zone field; it is set by a platform admin (Tenant edit panel), so ask support to change it.


## Day 1 — First test call (~10 minutes)

Once the wizard's "Go live" step completes, you have a Telnyx number
shown in the go-live panel (the Go Live panel in **Phone Assistant → AI Persona**). Call it from your own
phone.

The AI's first message is configurable per template (e.g., *"Thanks for
calling DynaTire — how can I help today?"*). Walk through these flows
in order:

| Test | What the AI should do |
|---|---|
| **Book an appointment** | Ask for your name, service, preferred day/time. It looks for an available `(employee, resource)` pair, proposes a time, you confirm. Open the dashboard's Schedule tab — the booking should appear within ~5 seconds. |
| **Ask a policy question** | Try "What's your cancellation policy?" — if you haven't filled in any policy answers yet, the AI responds with "Let me have someone get back to you" and creates an entry to backfill — filter **Teach Your AI** to unanswered questions (**Phone Assistant → Knowledge Base**). |
| **Try an unavailable time** | Ask for 3am on a weekday. The AI should refuse and offer the next available slot. |
| **Try a service you don't offer** | Ask for "an MRI" or whatever's far outside your business. The AI declines and stays in scope. |

If anything in the call feels off, open **Calls → [your test call] →
Transcript** and review what the AI heard vs what it said. The system
prompt and tone are tunable from **Phone Assistant → AI Persona**.

---

## Day 1 — Knowledge base setup (~20 minutes)

This is the highest-leverage thing you can do for caller experience.
Every policy you fill in here is one less call that needs you
personally.

Go to **Phone Assistant → Knowledge Base → Teach Your AI**. You'll see 9 categories with
suggested questions (41 in the standard bank; you can add your own). Fill in the ones your customers actually ask:

| Category | Questions to fill first |
|---|---|
| **Business Hours & Location** | Hours? Open on holidays? Where are you (or your service area)? Parking? Walk-ins? |
| **Services & Pricing** | What services? Typical cost? Free estimates? How long does a typical appointment take? |
| **Scheduling & Appointments** | How do I schedule? Earliest availability? Will I get a confirmation? Can I wait / drop off early? |
| **Cancellation & Rescheduling** | What's the cancellation policy? How do I reschedule? Running late? No-show fee? |
| **Payment & Billing** | Payment methods? When is payment due? Financing? Deposits? Receipts? |
| **Your Guarantee** | Warranty? What if I'm not satisfied? How do I make a claim? |
| **Before Your Visit** | What should I bring? Anything to do before/after the appointment? |
| **Discounts & Promotions** | Current promotions? Loyalty program? Senior/military discounts? |
| **Emergency & After-Hours** | Emergency or same-day service? How to reach you after hours? Mobile service? |

You can also upload existing policy documents (PDFs, Word docs, text
files) under **Phone Assistant → Knowledge Base → Upload Documents**. The AI extracts the text,
indexes it, and references it when callers ask.

**Fastest start — scan your website.** If you ran the wizard's optional
"Import from website" step, many of these answers are already filled in. A
scan does two things:

1. **Pre-fills the policy questions** it found direct answers for — these
   show up already answered in **Phone Assistant → Knowledge Base → Teach Your AI** (a green
   "Answered" marker distinguishes already-answered questions from
   still-blank ones). Review and edit them like any other answer.
2. **Stages extra topics it discovered** (things outside the standard
   questions) for your review under **Phone Assistant → Knowledge Base → Suggestions**. Each one has
   an **Add** (send to the live knowledge base) or **Discard** button —
   nothing reaches callers until you approve it.

The scan is bounded (a handful of pages, with request timeouts) so it
stays fast and low-cost; re-run it any time your website changes.

---

## Daily workflow — the 5-minute morning check

Most days, your only dashboard interaction is:

1. **Open Home** — see today's appointments + any overnight calls
2. **Click into any flagged calls** — the AI flags calls it couldn't
   resolve (unanswered policy questions, booking conflicts it punted
   on). These need your attention; everything else handled itself.
3. **Mark anyone off who's not coming in today** — Schedule →
   Technicians → click the staff name → "Mark off today." Frees their
   slots; the AI will route around them.

That's it. The rest is handled by the AI.

---

## Extending coverage forward

Your schedule lives in `employee_schedule` as date-rows, NOT as a
weekly pattern. This is intentional — it makes "Carlos took next
Tuesday off" a one-row update, not a pattern-plus-override mental model.

The wizard seeds the first 4 weeks for you. After that, a background job
(`scheduleExtender`, daily) tops every employee's calendar up to a rolling
horizon (180 days by default) by projecting the weekly hours you saved in the
setup wizard. You no longer need a weekly chore to keep
the calendar filled.

To change a specific stretch by hand: **Setup → Working Days**, pick the
employee and week, adjust the days (holidays, training, planned vacation), or use
**Copy Week Forward** to copy that week's shifts onto the next week (it
overwrites that next week).

If callers hear "I don't see any availability" for ordinary working days far
out, the employee's calendar has stopped extending — usually a tenant that
predates the saved-weekly-hours rule. Re-saving the weekly hours (the wizard's hours step) fixes it
(operators: `docs/operations/RUNBOOK.md` §6b).

---

## Common admin tasks

| Task | Where to do it |
|---|---|
| Add a new employee mid-flight | Setup → (your staff sub-tab, e.g. Employees) → "Add employee." Then map them to the services they perform (same idea as wizard step 5 — who does what). |
| Add a new service | Setup → Services → "Add service." Fill duration/price, then assign which employees and resources can handle it. |
| Update business hours | Setup → Working Days (per-employee shifts; there is no separate business-hours setting). New shifts apply going forward; the past stays historical. |
| Mark someone unavailable today | Schedule → Technicians → click the person → "Mark off today." Frees their slots immediately. |
| Cancel an appointment | Schedule → click the block → hover → trash icon (or popover Cancel button). Soft-cancel — the row stays, slot frees up. |
| Move/reschedule an appointment | Schedule → click and drag the block on the Technicians or Resources view. Snaps to 15-min grid. |
| Invite a front-desk login | Setup → Team Access → "Invite." They get an emailed link to set their password. Front-desk role sees the four primary tabs only, not Setup or Phone Assistant. |

---

## Troubleshooting

### "The phone number rings but the AI never picks up"

Causes (in order of likelihood):
1. **Telnyx-side carrier hold** — happens occasionally on newly-ported
   numbers. Wait 1-4 hours and try again.
2. **LiveKit agent worker offline** — check the support page in the
   dashboard for "Voice service status." Should say "Worker online."
   If not, contact support.
3. **No `DASHBOARD_URL` env on backend** — only affects Stripe/OAuth
   redirects, not voice, but worth flagging.

### "The AI booked someone for a time my staff isn't there"

Almost always a `employee_schedule` gap. Check Schedule → Technicians
on the date in question — there should be a shift bar for the
employee at that time. If there isn't, the booking RPC has a bug we
need to know about (the RPC explicitly checks employee shifts and
should refuse this).

### "Customer says they got a reminder for the wrong time"

Reminders use the appointment's `start_time` in the tenant's
timezone, rendered into the customer's local time. If the customer is
in a different timezone, they may see a different clock time but it
points to the same absolute moment. If the appointment time itself is
wrong, check the appointment in the Schedule and edit it.

### "I don't see my call in the Calls tab"

Calls show up after they end. There's a ~30-second post-call delay
while the transcript is finalized. If a call is still missing after
2 minutes, it's possible the call never reached our backend — check
the Telnyx portal's call detail records for the raw carrier side.

### "The AI gave a price that's wrong"

The AI reads prices from the Services list (Setup → Services). If a price is stale there, fix it in the Services list and
the next call will use the new price. Past calls had the old price.

### "Dashboard shows 'Something went wrong'"

Refresh the page (Cmd/Ctrl+Shift+R to bust cache). If it persists,
take a screenshot of the URL + error and send to support. The
dashboard's error boundary catches most React errors gracefully.

---

## Escalation

For anything not covered here:
- **Support email**: filled in per-tenant during setup
- **Status page**: dashboard's footer link
- **Urgent (voice down, can't book)**: see Back Office → Help → Urgent
  contact

Founder's direct line is available in the welcome email for the first
30 days of beta.

---

## A note about HIPAA verticals

SecretaryHQ deliberately does NOT support medical, dental,
chiropractic, optometry, or veterinary businesses. If your customer
base intersects with any of these, please flag it during onboarding —
we'll either help find an alternative or, in some cases, build an
appropriate vertical-specific tier.

---

## What's next

After your first week of live calls, we'll review the call log
together and tune:

- **System prompt** — your AI's tone and phrasing
- **Knowledge base** — fill gaps surfaced by unanswered questions
- **Service catalog** — add anything callers ask for that you don't
  yet list

Then we open the floodgates.
