# SecretaryHQ — Product & Competitive Strategy

> Living strategy doc. Captures positioning + integration decisions that aren't
> derivable from the code. Started 2026-06-12. Revisit when a beta customer or a
> market shift changes the inputs — these are focus decisions, not permanent
> doors.

## TL;DR

- **What we are:** the best **AI receptionist** for service businesses — phone-first, cross-platform, vertical-focused on **non-trades** (salons, auto, tire, fitness, food & beverage).
- **What we are NOT (yet):** a full field-service CRM, and not a payments processor for our customers' customers.
- **Core moats:** (1) cross-platform freedom (works with whatever the business already runs, or nothing), (2) non-trades vertical focus where no platform bundles a receptionist, (3) solo-founder agility against slow incumbents.

---

## The competitive finding (2026-06-12)

We audited our 4 CRM integrations for whether the *vendor itself* ships a native AI receptionist — i.e. whether integrating means feeding a direct competitor who can bundle us out and cut API access.

| CRM (we integrate) | Native AI receptionist? | Verdict |
|---|---|---|
| **Jobber** | ✅ "AI Receptionist" (Aug 2025) — answers calls/texts, books | **Direct competitor** |
| **ServiceTitan** | ✅ native AI Voice Agent + Contact Center Pro — answers, books, reschedules, transfers | **Direct competitor** |
| **Housecall Pro** | ✅ "CSR AI" — answers calls/chats, books 24/7, discloses AI | **Direct competitor** |
| **Square** | ⚠️ "Square Assistant" = SMS reminder bot only; **Square does not answer phone calls** | **Partner, not a voice competitor** |

**3 of our 4 CRMs ship the exact product we build.** The home-services *trades* vertical is now red-ocean: the platform owns the customer, bundles the receptionist, and any integration we build there serves customers we'll lose and depends on a competitor's goodwill.

Sources: getjobber.com/features/ai-receptionist · servicetitan.com/features/pro/voice-agent · housecallpro.com/features/ai-team/csr-ai · squareup.com (Square Assistant / App Marketplace).

---

## Heuristic: a vendor's business model predicts whether it competes with you

The 4 calls above aren't ad-hoc — they follow from how each vendor makes money. Use this test on **any** future integration (Toast, Vagaro, Booksy, a new POS) instead of re-litigating each one.

- **SaaS-seat vendors that monetize by bundling** (Jobber, ServiceTitan, Housecall Pro) grow revenue by raising ARPU — adding features per subscription. An AI receptionist is pure upsell, so they build it natively → **future competitor.** Don't integrate deep; they'll absorb the feature and can cut your API access.
- **Transaction / volume vendors** (Square — earns on payment volume, not seats) and **infrastructure vendors** (Google / Microsoft calendars — ads/cloud revenue, not seats) want *more bookings / usage* and have no reason to answer phones → **safe partner.** A receptionist that fills their calendars / drives their transactions *feeds their core metric*.

**Rule for any new integration:** ask "how does this vendor make money?" first.
- Seat-bundler → treat as a future competitor; integrate shallowly or not at all.
- Transaction / volume / infrastructure → safe to partner; integrate freely.

This is exactly what separated **Square (keep)** from the **3 trades platforms (freeze)**.

---

## Strategic position

**Don't fight the platform-bundlers head-on.** Win where they don't / can't:

1. **Cross-platform & no-platform businesses.** A business not on a field-service platform (spreadsheets, paper, Google Calendar, a generic POS) has no native receptionist option. Jobber's own marketing concedes the gap: their receptionist "only works inside Jobber's ecosystem."
2. **Non-trades verticals.** Salons, auto, tire, fitness, food — these run on Square / Toast / Vagaro / Booksy, **not** Jobber/ServiceTitan/HCP. No incumbent bundles a receptionist for them.
3. **Solo-founder agility.** The incumbents bundling receptionists *validates the demand* — the category is proven. Their size makes them slow to serve edge segments and pivot. A solo team can chase the gaps they leave faster than they can close them. (Dale, 2026-06-12: being established cuts both ways — they're entrenched but rigid; we're small but quick to adjust to the market.)

---

## Expansion path (wedge → platform, in reverse of the incumbents)

The incumbents went **heavy ops platform first → bolt on a receptionist** to upsell. We go the **reverse, stronger order**: receptionist wedge first, then expand into the money/ops side later, as opt-in add-ons, once we already own the phone + the customer list + the schedule. This is the Square/Toast pattern (card reader → payroll/banking/loans, *after* owning the merchant relationship).

So the platform is the **destination, not the starting point** — and refusing to start there is the advantage. The incumbents are slow and bloated *because* they front-loaded everything; our edge is sequencing.

**Three disciplines that keep "add-on later" a strength, not the bloat trap:**

1. **"Later" + "per demand" are load-bearing.** Build each add-on when a real customer's behavior names the need — never speculatively now. (This is the CLAUDE.md build principle applied to the roadmap.)
2. **Build vs. partner — run every add-on through the money-model heuristic above.** Not everything should be built:
   - Service payments → **partner** (Square). PCI / Stripe Connect / payout liability — line already drawn.
   - Payroll → **partner** (Gusto / ADP). Regulated, brutal, commoditized.
   - Light invoicing / reporting / customer insights → **build** — close to data we already own, low liability.
3. **Each add-on must deepen the moat, not just add a checkbox.** Prefer add-ons that increase switching cost (more of the business's operation living in us) over ones that only add feature count.

**Rough sequence (illustrative, demand-gated — not a commitment):**
receptionist + booking (now) → call analytics / owner insights → richer customer records + history → light reporting → light invoicing → *partner* for payments (Square) + payroll (Gusto). Each step earns the next; none is built ahead of a real ask.

---

## Go-to-market: lead with the painkiller

Sell the **receptionist first**, expand later. It's easier to sell, for structural reasons — this is *why* the wedge-first sequencing works, not just a preference:

- **Urgent painkiller, not a vitamin.** "I'm missing calls = losing money right now" is felt by every owner today. Invoicing/dispatch/CRM is a "get organized someday" pain — real but not urgent. Always sell the painkiller first.
- **Tiny yes.** "Keep your number, we answer it" is low-risk and fast to try. "Switch your whole back office to our platform" is a scary, high-commitment switch. Ask for the small yes first.
- **Instant, audible ROI.** The first missed-call-turned-booking is proof on day one. A CRM/invoicing tool takes weeks to show value.
- **Captures the money moment.** The inbound call is where the sale is won or lost. Own that and you own the most valuable point in the owner's day.
- **Add-ons become warm expansions.** Once their customers + schedule live in us, selling the next feature is expansion revenue to someone who already trusts us — far cheaper than new acquisition. (Don't chase feature-parity; add only what fits the segment + deepens the moat. Build the safe parts, partner the regulated ones.)

## Pricing model — value-aligned volume (captured 2026-06-12; FINALIZE + BUILD AFTER THE BASE)

**Direction locked.** _Status 2026-09-18: the metering infrastructure has since been built (`src/services/billingUsage.ts` — monthly answered-call counter, configurable `PLAN_CAP_*` caps, soft-cap refusal, `GET /billing/usage`); final band sizes and Stripe price ids are still Dale's open decision (`docs/planning/TODO.md` P0 §2)._ Original stance: finish the core product first; build pricing/metering infra later, once real usage data exists to set the bands. (Dale 2026-06-12: capture it, but base product comes first.)

**Meter on VALUE delivered — calls handled / appointments booked — NEVER on seats, NEVER on minutes.** "We scale as they scale; it goes up, but it should." This is the *good* kind of usage pricing (Stripe/Square per-transaction model — the aligned side of the money-model heuristic), and it structurally beats the most-hated thing across *every* competitor:

- **Per-seat** (Jobber/HCP/ServiceTitan) punishes the business for hiring — a growth tax decoupled from value. We never charge per seat; adding staff never raises the bill.
- **Per-minute overage** (pure-plays) = bill shock. We never meter minutes (punishes a chatty caller — not the shop's fault, not value-aligned).

**Design rules:**
1. **Strongest form: price tied to bookings.** A booking is worth $50–500 to the shop; a few dollars per booking reads as ROI, not a tax — they pay more *happily because they're earning more*. Incentives identical: we only make more when we make them more.
2. **Predictability is non-negotiable** (the pure-plays' real sin is surprise, not scaling). Tiered **volume bands** — Solo/Growth/Pro become *volume* tiers (by calls/bookings/locations), not seat tiers — + a visible meter + caps + alerts (the owner copilot warns at ~80% of plan). No surprise bills.
3. **Floor + usage:** a low flat base (covers the always-on receptionist) + value-metered usage on top. Predictable like flat, scales like usage.
4. **Per-booking or per-call-band > per-minute**, always.

## Product ideas & differentiators (captured, demand-gated)

- **Owner-facing AI copilot in the dashboard** (Railway-style side panel) — a natural-language assistant that helps the *owner* configure + operate + understand the product: "set my Saturday hours 9–2", "add an oil change for $50", "why did Tuesday's calls go to voicemail?", "what does this setting do?". Strategic fit:
  - **On-brand:** caller-facing AI (receptionist) + owner-facing AI (copilot) is a coherent identity static-form incumbent dashboards can't match.
  - **Kills onboarding friction** → directly serves the "tiny yes / instant ROI" GTM thesis (owner self-serves via chat instead of learning forms).
  - **Drives the expansion path:** surfaces insight + suggests add-ons in context ("you missed 12 after-hours calls — turn on SMS follow-up?") = automated warm upsell.
  - **Deepens the moat:** owner engages daily via chat, not just when something breaks.
  - **Cheap-ish:** LLM infra already runs for the receptionist.
  - **Build trigger:** when onboarding-friction / setup-drop-off data shows it's the bottleneck, or as a deliberate onboarding accelerant. Not before. (Origin: Dale liked Railway's in-app LLM assistant, 2026-06-12.)

- **Website-scan onboarding** — instead of the owner answering setup questions, scan their existing website to auto-populate the knowledge base / RAG (services, hours, prices, policies, FAQ) → LLM-extract → structured KB + embeddings (reuses `knowledgeIngestion` + `getEmbedding` + `search_tenant_docs`). The ultimate "tiny yes": the owner does almost nothing; the system bootstraps from what they already published. Differentiator — incumbents make you fill forms. _Status 2026-09-18: shipped (`src/services/knowledge/websiteImport.ts`, wizard website-scan step, daily re-scan worker `websiteRescanScheduler`); suggestions are staged for owner review, never auto-published. The accuracy eval it depends on exists as `./scripts/simulate.sh rag`._
  - **Post-scan gap-fill:** the scan fills what it can; the owner then reviews, corrects, and adds anything missing. Human-in-the-loop so a partial/wrong scrape never silently produces a bad KB.
  - **Hard dependency:** RAG-accuracy testing (below) — auto-populating from a scrape raises garbage-in risk, so accuracy measurement is a *guard* on this feature, not optional. The chain is scan → KB → RAG → accuracy. (Origin: Dale, 2026-06-12.)

---

- **Restaurant vertical add-on** — restaurant-specific vocabulary + reservation flow on top of the existing per-vertical template/vocabulary system (`src/templates/*`, which already remaps resource/employee/booking labels per industry). Mapping: **resource → table, employee → server/waitress, booking → reservation** (+ party size, time, table assignment). The receptionist takes "table for 4 at 7" as a reservation, not an appointment. Fits the food & beverage vertical. Competitor check before building: do OpenTable / Resy / Toast ship an AI phone receptionist? Demand-gated like the other ideas. (Origin: Dale, 2026-06-12.)

## Decisions (2026-06-12)

### Integrations
- **REMOVED Jobber, ServiceTitan, HubSpot (2026-06-12).** All three ship their own AI receptionists — direct competitors. The integration code (clients, sync services, routes, OAuth, webhooks) was deleted from the repo; only Square remains. Housecall Pro was never coded. The generic/provider-agnostic CRM layer (`tenant_integrations` tables, `crmRouteScaffold`, `oauthCallbackFactory`, `tokenManagement`, `syncOrchestrator`) was kept — it now drives Square only and is ready for any future non-competitor partner.
- **Keep + prioritize Square.** Payments/booking platform with huge non-trades reach; not a phone-answering competitor. A genuine partner.
- **Keep calendar sync (Google / Outlook).** Vendors not in the receptionist business — always safe.
- **Reversible.** Removing the three was a focus call. Re-add an integration (off the kept generic layer) when a *real beta customer who cannot use the incumbent's native receptionist* asks, or the market shifts.

### CRM scope ("build our own CRM" — sharpened)
- We are **~60% of a light CRM already**: customers, appointments, employees, resources, services, skills, a real scheduling engine (employee_schedule + atomic booking RPCs), customer history/preferences/notes, voice/call records, reminders + communications.
- **Direction: own the operational system-of-record, receptionist-first — NOT a full CRM.** Surface and extend what we already have so a small non-trades business never *needs* a second tool. Do not chase feature-parity with ServiceTitan/Jobber (invoicing, dispatch, job costing, marketing) — that's a multi-year platform war on their turf that dilutes the sharp thing.
- **Sequencing rule:** the next CRM slice is whatever ONE thing forces a beta customer to a second tool today — built as small as possible, per real demand. Not "what a CRM should have."

### Money — two flows, keep them separate
- **Stripe = OUR SaaS billing only.** We bill the *business* a monthly subscription (Solo/Growth/Pro) for using SecretaryHQ. This is our revenue. (`src/routes/billing.ts`.)
- **We do NOT process the business's customers' payments** (the caller paying for an oil change / haircut). Deliberately out of scope — PCI scope, Stripe Connect/marketplace liability, payouts, refund disputes. Payment for services stays with whatever the shop already uses (their POS / Square / cash). **Not handling this is a feature**, not a gap.

---

## Open questions (decide with a clear head / real data)

- Which non-trades vertical do we go deepest on first? (salon vs auto/tire vs fitness vs food)
- What's the first concrete "operational system-of-record" slice a beta customer actually demands?
- Square: how deep — booking sync only, or lean into it as the payments partner we point customers to?
- Do we ever revisit a trades play *around* the incumbents (serve the businesses their bundled receptionist underserves), or stay out entirely?

---

## Related

- Build principles: see `CLAUDE.md` → "Build Principles" (build for real customers, test it or delete it, working flat beats dormant abstraction). This strategy is an application of those.
- The 21 dormant CRM adapters deleted 2026-05-02 were prescient — same lesson, earlier.
