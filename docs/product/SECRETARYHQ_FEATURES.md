# SecretaryHQ — What It Does

> Organized outline of SecretaryHQ's capabilities. Status legend:
> **✅ built** (works today) · **🔨 in progress** · **💡 planned** (captured in
> `docs/product/STRATEGY.md`, demand-gated). Last updated 2026-08-14; accuracy-corrected 2026-09-18, 2026-09-25.
>
> One line: **an AI receptionist that answers the phone, books the work,
> remembers the customer — and gives the owner just enough of a back office to
> run on, without buying a heavy platform.**

---

## 1. AI Voice Receptionist (the core)

- ✅ Answers business calls 24/7 (Telnyx → LiveKit Cloud → AI agent)
- ✅ Natural conversation — Deepgram Nova-3 (speech-to-text), OpenAI GPT-4.1-mini (reasoning), Deepgram Aura (voice; streaming TTS since 2026-07-14)
- ✅ Knows the business — answers hours / prices / services / policies from a per-tenant knowledge base (RAG / vector search)
- ✅ Books appointments live during the call
- ✅ Recognizes returning callers + recalls their history and preferences
- ✅ Saves customer preferences mid-call ("prefers Maria", "weekends only"), per business type (2026-09-25, #571) — a host-built `remember_preference` tool is offered whenever the owner's `save_preferences_enabled` toggle (default on) is on; the key it saves under comes from a per-vertical catalog (`shared/preferenceCatalog.ts`, all 33 verticals). It writes only to a profile the caller actually owns — the carrier caller-ID number, or a spoken number proven by `verify_phone_code`; an unproven spoken number gets nothing saved (no SMS/10DLC to confirm it). Not yet proven on a live PSTN call — verified in simulation and unit tests only.
- 🔨 Phone verification (OTP via SMS) when caller-ID is blocked, before booking — code shipped, but the tools are only offered when `ENABLE_PHONE_VERIFICATION` AND `ENABLE_SMS` are both on (`agent/src/index.ts`), so it is off until 10DLC registration lands
- 🔨 Live human transfer is **wired** on the question-tree path when a forward number is set (`transfer_call` always-on passthrough, #462). Without a forward number, production calls take a message for escalation. Live PSTN proof + residual hardening still open (see TODO live-validation / RUNBOOK §7c).
- ✅ Per-tenant persona — custom voice, greeting, and style flags (set on the AI Persona page; `tts_speed` is currently inert under Aura). The free-text system prompt ("Personality & Instructions") is only read on the legacy prompt-ladder path — under the live question-tree call architecture it is not passed to the model
- ✅ Graceful error recovery — never speaks raw errors; recovers in-character
- ✅ Customer-led booking — asks the caller's preferred time, widens the window if none fit, never imposes a slot
- ✅ **Owner-chosen call checklist (2026-08-13)** — a per-tenant preset decides what the assistant can handle. There are now 33 presets (`CHECKLIST_PRESET_IDS` in `shared/checklistPresetDerivation.ts`): five hand-written front-desk presets — `auto_shop_front_desk`, `salon_front_desk`, `local_service_front_desk`, `owner_for_hire_front_desk` (adds job/role intake for solo professionals whose line takes work offers), `law_firm_front_desk` (adds case intake) — plus 28 per-vertical presets (plumber, barbershop, catering, …) shipped in #388. Editable on Business Settings → Call checklist, with a next-call dry-run showing what will be ASKED, listened for, and required. Owners can turn parts off, make a field optional or required, and change the wording of approved questions — but the preset is the ceiling: what it does not include, no setting can add.

## 2. Scheduling & Booking Engine

- ✅ Real schedule of record — employees, shifts, resources, services, skills
- ✅ Atomic, race-safe booking (conflict checks, past-time rejection, shift-coverage enforcement)
- ✅ Service-aware — enforces required staff skills + required resources per service
- ✅ Timezone-aware availability lookup; cross-midnight night shifts
- ✅ 15-minute increment + duration validation
- ✅ Coverage-gap analysis (where the schedule has holes)
- ✅ Setup wizard collects a weekly grid → expands into the schedule

## 3. Customer Records (operational system-of-record)

- ✅ Customers, contact info, appointment history, notes
- ✅ Preferences stored + recalled on the next call (voice CRM context)
- ✅ Returning-caller recognition by phone

## 4. Call Logging & Records (Calls tab)

- ✅ Every answered call logged to `voice_sessions` (duration, caller)
- ✅ Full call transcript captured
- ✅ Call outcome (booked / transferred / …)
- ✅ Call → appointment back-link (deep-link the call to what it booked)
- ✅ Post-call AI summary (1–2 sentences, failsafe)

## 5. Analytics & Reporting

- ✅ Top-line stats — calls / appointments / customers (volume, today, week) + recent activity (`/analytics/stats`)
- ✅ Call panels — call volume over time, call→booking conversion, caller abandonment (`/analytics/calls`, from `voice_sessions`; gap #2 shipped 2026-06-12)
- ✅ Reporting that answers **WHY**, not just WHAT — the agent classifies each non-booking call (`no_availability` / `wrong_service` / `price` / `message` / `info`), and the "Why Callers Reached Out" panel surfaces the breakdown. The differentiator competitors can't match (their receptionist never captures the why). 🔨 Next: the conversational cut ("bookings down because N callers wanted Saturday") via the owner copilot.
- ✅ Coverage analysis (staffing vs demand)

## 6. Reminders & Communications

- ✅ Email reminders + confirmations, consent-gated
- 🔨 SMS reminder/confirmation code exists, but production SMS stays off until per-tenant 10DLC registration lands
- ✅ Reminder scheduler (polls + delivers on a tick)
- ✅ SMS rate-limiting + delivery retry policy in code once SMS is enabled
- 🔨 Delivery-receipt tracking (sent ≠ delivered) — SMS delivery-status callbacks are recorded (`message_delivery_status`, `src/routes/communications.ts`); a fuller reminder-monitoring view is still 💡

## 7. Integrations

- ✅ Calendar sync — Google Calendar, Outlook (booking → owner's calendar)
- ✅ CRM sync — Square only (`src/services/crm/squareSync.ts` + `squareClient.ts`, route `src/routes/square.ts`). _(Jobber, HubSpot, ServiceTitan **removed** 2026-06-12 as competitors — see `docs/product/STRATEGY.md`; the provider-agnostic sync layer was kept and drives Square.)_
- ✅ Voice + telephony stack — Telnyx (PSTN), LiveKit (media), Deepgram Nova-3 (STT) + Deepgram Aura (TTS), OpenAI GPT-4.1-mini for the live voice LLM (xAI Grok removed 2026-06-25)
- ✅ Phone provisioning — search / buy / route a phone number (Telnyx)

## 8. Owner Dashboard

- ✅ Primary tabs — Home, Schedule, Customers, Calls (all roles)
- ✅ Advanced tabs — My Business, My Team, Phone Assistant (owners/admins)
- ✅ AI Persona config — voice, greeting, system prompt, preference capture, forward number
- ✅ Guided setup wizard (+ solo-business mode)
- ✅ Knowledge-base management (the receptionist's answers)
- ✅ Role-based access — owner / front-desk (`users_role_check`), plus platform super-admin. Server-side owner gating on staffing/catalog/billing/knowledge/calendar/provisioning routes shipped 2026-09-16 (#522, #523)
- ✅ Demo mode — instant, isolated, self-expiring demo tenant with sample data

## 9. Multi-Tenancy, Auth & Security

- ✅ Row-level-security tenant isolation (every table)
- ✅ JWT auth (auto-logout), bcrypt, role gating
- ✅ Super-admin platform management across tenants
- ✅ Hardened tenant isolation (no anonymous cross-tenant access)
- ✅ RLS is genuinely enforced, not decorative — production connects as a non-superuser role that cannot bypass policies (since 2026-07-27); `GET /ready` reports it from the running process
- ✅ **Public legal pages (2026-08-14)** — `/privacy`, `/terms`, `/dpa`, linked from the landing footer and from a required consent checkbox at signup in which the signer attests they are authorized for the business and that informing callers about the AI is their legal duty. Terms adopt Bonterms Standard Online Cloud Terms v1.0 by reference; the DPA is the Bonterms DPA v2.0 cover plus a named subprocessor list. _Not lawyer-reviewed — the Bonterms base is lawyer-drafted, our Provider-Specific Terms are not._

## 10. Billing (our SaaS revenue)

- ✅ Stripe subscription billing of the business — Solo / Growth / Professional _(code built; no Stripe product/price/webhook registered yet — `sk_test` key in prod — see `docs/operations/DEPLOYMENT.md`)_
- ✅ Webhook-driven subscription activation + access gating
- ✅ **Pricing decided (2026-09-24/25):** monthly only, no annual option — Solo $29.95/mo (30 calls, $1.00/call overage), Growth $59.95/mo (100 calls, $0.75/call overage), Professional $149.95/mo (300 calls, $0.60/call overage). No per-tier staff/station limits; call transfer to a person included on every plan. A paid plan past its included calls keeps answering and is billed the overage — it does not get cut off; only the free/unrecognized tier blocks (#565). Full history: `docs/product/PRICING_RESEARCH.md`.
- ✅ **Card required for the 14-day trial (2026-09-24, #566)** — checkout collects a card up front; the trial applies only to a Stripe customer's first-ever subscription. `POST /provisioning/activate` refuses a phone line (402) without an active subscription.
- ✅ **Email verification gate (2026-09-24, #567)** — checkout is refused until the account's email is confirmed via an emailed link; one account per email platform-wide (case-insensitive). Self-serve signup is closed by default (`ENABLE_SIGNUP`) until launch.
- 🚫 We do **NOT** process the business's customers' service payments (deliberate — no PCI/payout liability; stays with their POS/Square)

## 11. Platform & Observability

- ✅ Health + readiness endpoints, Prometheus-style metrics
- ✅ Structured logging (Pino → stdout), per-request enrichment. _(Sentry / Better Stack hooks exist but are unset — paid observability was declined 2026-07-02.)_
- ✅ On-demand system simulation harness (`scripts/simulate.sh`) — `status` (health board) · `tools` (realistic end-to-end journey) · `call` (talk to the agent in a browser, no phone)

---

## 12. Roadmap / Captured Ideas (💡 not built — demand-gated)

From `docs/product/STRATEGY.md`:

- **Owner AI copilot** — in-dashboard assistant: "set my Saturday hours", "why did I miss calls Tuesday?" (the natural surface for WHY-reporting + onboarding)
- ~~**Website-scan onboarding**~~ — **shipped**: `src/services/knowledge/websiteImport.ts` stages knowledge suggestions from the owner's site for review, and a daily re-scan worker (`websiteRescanScheduler`, #482) keeps them fresh; never auto-publishes.
- ~~**RAG-accuracy testing**~~ — **shipped as an on-demand eval**: `./scripts/simulate.sh rag`
- **Restaurant vertical add-on** — table / server / reservation vocabulary + party-size flow
- **Expansion add-ons** (post-base, per demand) — light invoicing / reporting (build); payments → Square, payroll → Gusto (partner)

---

## Positioning (why these features, this shape)

- **Receptionist-first, cross-platform / no-platform** — works whether the business runs Square, a spreadsheet, or nothing. The platform incumbents (Jobber/ServiceTitan/Housecall Pro) require buying their whole suite to get a receptionist.
- **Non-trades verticals** — salons, auto/tire, fitness, food — where no incumbent bundles a receptionist.
- **Own the operational system-of-record, not a full CRM** — sell the front door; the light back office is what makes them stay.
- See `docs/product/STRATEGY.md` (positioning) + `docs/product/COMPETITOR_WEAKPOINTS.md` (attack map).
