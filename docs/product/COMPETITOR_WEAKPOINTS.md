# Competitor Weak Points — Attack Map

> Where the incumbents are weak, and how SecretaryHQ attacks each. Grounded in
> real 2026 user reviews/complaints (sources at bottom), not speculation. This
> is a **product + pricing + positioning weapon** — each weakness maps to
> something we build, price, or say. Started 2026-06-12. Pairs with
> `docs/product/STRATEGY.md` (positioning) — this doc is the offense.

## Two classes of competitor

1. **Platform-bundlers** — Jobber, ServiceTitan, Housecall Pro. Field-service
   platforms that bolted an AI receptionist onto a heavy ops suite. They make
   money on the *platform* (seats + add-ons); the receptionist is upsell bait.
2. **Pure-play AI receptionists** — Smith.ai, Goodcall, AgentZap, etc. Just a
   phone-answering layer. No booking engine, no CRM/schedule backbone — they
   relay/forward or do shallow booking into someone else's tool.

SecretaryHQ sits in the gap between them: a **real receptionist + a real
booking/customer backbone**, with **none of the platform tax**.

---

## Cross-cutting weaknesses → our attack (the patterns that matter most)

These repeat across multiple competitors. Each is a wedge.

| Their weakness | Evidence | Our attack |
|---|---|---|
| **Seat-fee tax punishes growth** | Jobber +$29/user/mo (20-crew = $145/mo in seat fees before add-ons); HCP +$35/user on MAX; ServiceTitan $200–500/user/mo | **Value-aligned volume pricing — metered on bookings/calls, NEVER seats.** Scales with their success, not their headcount. Adding staff never raises the bill. (See `STRATEGY.md` → Pricing model.) |
| **Add-on nickel-and-diming** | Jobber: AI behind $599 Plus or $99 add-on, marketing +$29/mo; HCP add-on creep = #1 complaint; ServiceTitan undisclosed add-ons ($3K→$10K/mo) | **Receptionist + booking included, not an upsell.** What you sign up for is what you pay. |
| **Platform-purchase tax** — must buy + learn the whole suite to get the receptionist | ServiceTitan 10-tech shop = $48–84K/yr, "we only use 30% of features"; Jobber receptionist only inside Jobber | **Buy just the receptionist.** No platform required underneath (cross-platform / no-platform). |
| **Brutal onboarding** | ServiceTitan 4–8 wks min, 3–6 mo to comfort, "NEVER BEEN ONBOARDED" (BBB) | **Minutes to live** — website-scan onboarding (auto-fill the KB from their site) + post-scan gap-fill. Onboarding speed is a weapon. |
| **Lock-in** | ServiceTitan 2–3 yr contracts + early-termination fees; HCP "difficulty canceling" | **No contract, easy export, your data is yours.** Sell the opposite of lock-in. |
| **Receptionist is rigid / half-baked** | Jobber "a form with a voice," "not very flexible," doesn't ask what the job is about; HCP CSR AI 6/10, "half-baked," "checkbox features" | **The receptionist is our CORE product, not a side feature** — genuinely conversational, captures service intent, customizable persona. We out-build them on the one thing because it's the *only* thing. |
| **Reporting tells WHAT, not WHY** | Jobber "basic reporting" (no first-time-fix-rate, no CLV); HCP "no custom report builder," no custom fields; ServiceTitan reporting limited; owner asks "why are bookings down?" → gets a chart, not an answer | **Reporting that answers WHY** — we own the call-level data they don't (transcripts, outcomes, abandonment points, what the caller wanted), so we can say "bookings down 20% — 14 callers wanted Saturday slots you don't offer." Competitors *can't* — their receptionist never captured the WHY (Jobber books "with no idea what it's for"). Delivered flexibly via the owner copilot (ask anything; no report-builder needed). **Depends on rich outcome classification.** |
| **Bad / unreachable support** | HCP "support cannot call you," wait-by-computer for chat; ServiceTitan tickets drag weeks | **Responsive, founder-led support** (solo agility as an asset). |
| **Built for trades only** | All three are HVAC/plumbing/electrical-first | **Non-trades verticals** — salons, auto, tire, fitness, food (they run on Square/Toast/Vagaro, not these platforms). |
| **Per-minute bill shock (pure-plays)** | $0.65–$11.00/min or per-call overage; Smith.ai human tier $9.75/call | **Predictable volume bands (never per-minute), + visible meter/caps/alerts** + a booking/CRM backbone they lack (not just call relay). |

---

## Per-competitor teardown

### Jobber — "a form with a voice"
*Strong core (G2/Capterra 4.6), so don't attack the core — attack the receptionist's rigidity, the seat-fee/add-on tax, and the lock-in.*
- **Receptionist is inflexible.** Users: "not very flexible," "a form with a voice," want more free-text/customization in the trainer. **Critically, it doesn't ask what the job is** — books with personal info but "no idea what it's for"; no mandatory service questions. → **Our build requirement: the booking flow ALWAYS captures service intent + supports owner-defined required questions.** (We partly have this; make it a headline.)
- **Receptionist locked to Jobber.** US/CA/UK numbers only. Doesn't help anyone on another stack.
- **AI gated/expensive:** $99/mo add-on or $599 Plus, on top of the platform.
- **Growth-punishing seats** (+$29/user) + marketing as a separate add-on; Reddit "hidden fees," "nickel-and-dimed."
- **Other gaps:** weak reporting (no first-time-fix-rate/CLV), no native photo docs, no customer self-quoting, QuickBooks sync issues, weaker mobile app, auto-invoicing requires a saved card (one user lost 2/3 of recurring invoicing).

### ServiceTitan — enterprise bloat, structurally can't serve small
*Don't compete feature-for-feature; make their size the liability.*
- **Price:** $200–500/user/mo; 10-tech shop $4–7K/mo ($48–84K/yr). Undisclosed add-ons ($3K→$10K/mo).
- **Overkill:** "we only use 30% of features"; too complex for <10–20 techs.
- **Onboarding nightmare:** 4–8 wks min, 3–6 mo to comfort; a paying customer "NEVER BEEN ONBOARDED."
- **Lock-in:** 2–3 yr contracts, steep exit fees. **Slow support.**
- → **Attack: speed, simplicity, no contract, flat price.** Everything they are not. We win the small/non-trades shops they price out and overwhelm.

### Housecall Pro — half-baked AI, support + billing pain
- **CSR AI 6/10, "half-baked," "checkbox features," "doesn't justify switching."** → **direct attack: we are the receptionist company; ours is the product, not a checkbox.**
- **Add-on cost creep = #1 complaint;** per-user $35 on MAX; payment-processing failures, unauthorized recurring charges, "difficulty canceling."
- **Support won't call you;** Trustpilot 2.9 / BBB 2.07 despite G2 4.7 (the gap = recent-adopter pain).
- → **Attack: a receptionist that actually works + clean predictable billing + reachable support.**

### Pure-play AI receptionists (Smith.ai, Goodcall, AgentZap…)
*Closest to us in form, weakest in substance.*
- **No operational backbone.** They answer + relay/forward or do shallow booking. **No real schedule, no CRM, no system-of-record.** → **our moat: we own the booking + customer layer, so we're sticky and they're a commodity phone line.**
- **Per-minute/per-call bill shock:** $0.65–$11/min overage; Smith.ai human tier $9.75/call. Unpredictable.
- **Smith.ai:** expensive ($95–300/mo + per-call), weeks to onboard.
- **Goodcall:** cheap but capped — lower tiers 1 form / 1 logic flow (limits appointment types), ~100 customers/mo.
- → **Attack: flat pricing + a real booking/CRM backbone they structurally lack + fast self-serve onboarding.**

---

## What this means for what we BUILD (Dale: "build some of the same features, beat them on the weak points")

Concrete, weakness-driven build/pricing/positioning calls:

1. **Booking flow must always capture service intent** + owner-defined required questions. (Directly beats Jobber's #1 receptionist complaint.) Likely partly built — verify + make it a headline.
2. **Website-scan onboarding + gap-fill** (`docs/product/STRATEGY.md`). Onboarding speed is the wedge against ServiceTitan's 3–6 months and everyone's form-filling. "Live in minutes" is the pitch. _(Status 2026-09-18: website scan + owner-review gap-fill is built — `src/services/knowledge/websiteImport.ts`, wizard step 7 — but suggestions are staged for owner approval, never auto-published.)_
3. **Value-aligned volume pricing — metered on bookings/calls in predictable bands, receptionist included, NEVER per-seat or per-minute** (see `STRATEGY.md` → Pricing model; finalize after the base product). Scales revenue with the customer's success while attacking the most-cited weakness across *all four* competitors.
4. **No-contract, easy-export.** Sell the opposite of ServiceTitan/HCP lock-in.
5. **Receptionist flexibility + customization** (persona, required questions, free-text training) — out-build the "form with a voice."
6. **Own the operational backbone** (schedule + customers + history) — the moat the pure-plays lack and the reason add-ons later become sticky.
7. **Reporting that answers WHY, not just WHAT** — surface causation from call outcomes/transcripts ("bookings down because N callers wanted X"), delivered conversationally via the owner copilot. **Requires rich outcome classification** (booked / abandoned-at-price / no-availability / wrong-service / after-hours). This is the gap #2 analytics build, leveled up. Moat: competitors can't — their receptionist never captures the WHY.
8. **Non-trades verticals first** — salons/auto/fitness/food, where none of these three even compete.
8. **Responsive support** as a differentiator while small.

Guard rails (from `docs/product/STRATEGY.md` + build principles): build per real demand, partner the regulated/heavy parts (payments→Square, payroll→Gusto), don't chase feature-parity — beat them on the *weak points*, not by becoming them.

---

## Sources
- Jobber reviews/pricing: [Capterra](https://www.capterra.com/p/127994/Jobber/reviews/) · [G2](https://www.g2.com/products/jobber/reviews) · [fieldcamp.ai](https://fieldcamp.ai/reviews/jobber/) · [servicebusinessacademy.org](https://servicebusinessacademy.org/jobber-review-2026/)
- Jobber AI receptionist limits: [reliablereceptionist.com](https://reliablereceptionist.com/jobber-ai-receptionist-hvac-integration-gap/) · [Jobber community](https://community.getjobber.com/discussions/operations-forum/i-love-the-ai-receptionist-even-though-it-isnt-quite-what-i-really-need-yet-/7720)
- ServiceTitan: [fieldcamp.ai](https://fieldcamp.ai/reviews/servicetitan/) · [getonecrew.com](https://www.getonecrew.com/post/servicetitan-reviews) · [Capterra](https://www.capterra.com/p/150053/ServiceTitan/reviews/)
- Housecall Pro: [fieldcamp.ai](https://fieldcamp.ai/reviews/housecall-pro/) · [Trustpilot](https://www.trustpilot.com/review/housecallpro.com) · [projul.com pricing](https://projul.com/blog/housecall-pro-pricing-analysis-2026/)
- Pure-play receptionists pricing: [AgentZap cost guide](https://agentzap.ai/blog/ai-receptionist-pricing-complete-cost-guide-2025) · [NextPhone](https://www.getnextphone.com/blog/best-ai-answering-services)
