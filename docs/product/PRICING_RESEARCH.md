# Pricing Research — Competitors + Measured Cost per Call

> 2026-09-24. Two inputs for the open tier-pricing decision (`docs/planning/TODO.md`
> P0 §2 "Decide final tier pricing"): how the market prices, and what one call
> actually costs us. Pairs with `COMPETITOR_WEAKPOINTS.md` (attack map) and
> `STRATEGY.md` (positioning). The research below predates the decision and is kept
> as-is for context; the tiers it explores (Solo $129/150, Growth $279/500,
> Professional $449/2,000) are **not** what shipped.

## Decided (2026-09-24/25)

Landed in code #565–#570; not what "Options (not decisions)" (§4 below) proposed —
Dale picked lower entry prices and smaller included-call bands than either option
sketched:

| Tier         | Price / month | Included calls | Overage / call |
| ------------ | ------------- | -------------- | -------------- |
| Solo         | $29.95        | 30             | $1.00          |
| Growth       | $59.95        | 100            | $0.75          |
| Professional | $149.95       | 300            | $0.60          |

- **Monthly only — no annual plan, no annual discount.** The landing page's annual
  toggle was removed (#568), not merely left unbuilt.
- **No per-tier staff/station limits.** The plan cards no longer show a seat/station
  cap on any tier (#569) — SecretaryHQ prices on calls, not seats, settling the
  Option B seat-pricing question in Option A's direction.
- **Call transfer to a person is included on every plan** (#570), not gated to a
  higher tier — it already worked everywhere once a transfer number was set; the
  pricing page previously implied otherwise.
- **A paid plan past its included calls keeps answering.** Overage is billed per
  call at the rate above rather than the line going quiet or refusing new calls
  (#565); only the free/no-plan tier still blocks. Stripe itself has no products,
  prices, or webhook registered yet, so overage is computed and stored, not
  actually charged to a card today.
- Card-required 14-day trial (#566) and email-verification-before-checkout (#567)
  shipped alongside the pricing change but are separate decisions — see
  `docs/planning/RESOLVED.md` (2026-09-24/25 entry) and `docs/operations/SECURITY.md`.

Below this line is the original research and the (unpicked) options — kept for the
cost-per-call math and competitor data, not as a live proposal.

## 1. How competitors price

**Volume-led hybrid.** Of 15 vendors checked, ~12 set price mainly by volume
(minutes, calls, unique callers, conversations) with a light feature ladder on
top. Outliers: NextPhone (flat unlimited), Slang (per location), Allo / Emitrr
(per seat), Retell / Bland (raw per-minute developer platforms, not SMB products).

| Vendor          | Price / month               | Volume unit             | Notes                                                 |
| --------------- | --------------------------- | ----------------------- | ----------------------------------------------------- |
| Rosie           | $49 / $149 / $299           | 250 / 1,000 / 2,000 min | Booking + transfer gated to $149                      |
| Goodcall        | $79 / $129 / $249 per agent | unique callers          | $0.50 overage                                         |
| Dialzara        | $29 – $349                  | 60 – 1,000 min          | Near-full features every tier; $0.35–0.48/min overage |
| Upfirst         | $24.95 – $299               | 30 – 600 calls          | $0.70–1.50/call overage; 14-day no-card trial         |
| Frontdesk       | $99                         | 200 min                 |                                                       |
| SignpostAI      | up to $399+                 | —                       | Scheduling only at $399; $199 setup fee               |
| NextPhone       | $199 – $599+                | unlimited               | Flat                                                  |
| Slang           | $399+                       | per location            | Restaurants                                           |
| Jobber (add-on) | +$29                        | 30 conversations        | Platform bundler                                      |
| Smith.ai        | ~$95 – $800                 | calls                   | Sources conflict — unverified                         |
| Ruby (human)    | $250 – $1,725               | minutes                 | Human receptionists, reference point                  |

Figures from vendor pricing pages as retrieved 2026-09-24; they drift — re-check
before quoting any of them publicly.

**Patterns**

- Entry tier: 30–250 min or 30–150 calls. Mid tier: 300–1,000 min or 250–500 calls.
- Mid-tier effective rate: ~$0.15–0.40/min or ~$0.50–0.85/call.
- Past the cap: soft overage is the norm, not a hard cutoff.
- Sweet spot for a single-location plan: **$129–199**.
- Booking splits the market (premium tier at Rosie/Signpost, included at others).
  **Nobody advertises skill- and resource-aware booking** — our differentiator.
- Trials: 7 days is normal for AI-only products; Jobber, Housecall Pro and Upfirst
  give 14 days with no card.

## 2. Measured cost per call (prod, 2026-09-24)

### AI leg — from `ai_cost_events`

Source: prod `ai_cost_events` (`source='voice_call'`) joined to
`voice_sessions.duration_seconds`, last 60 days. **Only 9 calls exist** (prod
caller data is purged between work items), all test calls, 2026-09-09 → 09-21.
Treat as a first reading, not a baseline.

| Component             | Total (8–9 calls)                      | Share |
| --------------------- | -------------------------------------- | ----- |
| LLM `gpt-4.1-mini`    | $1.060 (2.63M input tokens, 5k output) | ~87%  |
| TTS Aura              | $0.134                                 | ~11%  |
| STT Nova-3            | $0.026                                 | ~2%   |
| Summary `gpt-4o-mini` | $0.001                                 | ~0%   |

- The six full-length calls (135–314 s, 22.1 min total) cost **$1.198 → ~$0.054/min**.
- Average session length across 11 sessions: **136 s** (median 135 s, max 314 s).
- Per call: **$0.08–0.25**, rising with length.

**The LLM input is the cost.** ~330k input tokens per call against ~640 output
tokens: the checklist and tool schemas are re-sent every turn, so input grows with
turn count. Two consequences:

1. The ledger costs every input token at the full $0.40/M. OpenAI bills repeated
   prompt prefixes (≥1,024 tokens) at the cached rate ($0.10/M for 4.1-mini), and
   the agent does not record cached-token counts — so **the real LLM bill may be
   lower than the ledger says**. Unverified; compare against the OpenAI usage
   dashboard for the same days before relying on either number.
2. It is the lever: prompt caching, a trimmed per-turn checklist, or `gpt-4.1-nano`
   ($0.10/M input, already priced in `src/services/aiCost.ts`) each cut the dominant term.

This supersedes the 2026-07-07 TODO model, which put the LLM at ~$0.001/call —
off by ~100×.

### Telephony + infrastructure — published rates (retrieved 2026-09-24)

| Item                               | Rate                                     |
| ---------------------------------- | ---------------------------------------- |
| Telnyx inbound local (Elastic SIP) | $0.0032/min                              |
| LiveKit Cloud agent session        | $0.01/min                                |
| LiveKit SIP                        | $0.004/min (1k–50k min included by plan) |
| LiveKit WebRTC participant         | $0.0005/min                              |
| Telnyx local number                | $1.00/number/month                       |
| LiveKit Ship plan base             | $50/month (platform, not per tenant)     |
| 10DLC low-volume campaign / tenant | ~$1.50/month + ~$20–60 one-time          |
| SMS per outbound text (Telnyx)     | ~$0.004 + ~$0.003–0.005 carrier fee      |

Per-minute telephony + LiveKit: **~$0.018/min**.

### All-in variable cost

**~$0.072/min → ~$0.16/call at the measured 2.3-min average.** Budget
**~$0.18/call** to cover longer real-world calls. Fixed per tenant: ~$1/month
(number); once SMS is on, ~$1.50/month (low-volume 10DLC campaign) plus ~$0.008
per text, plus a one-time ~$20–60 registration. Not included: Railway / Supabase
platform cost, OpenAI embeddings for KB ingestion (fractions of a cent), Stripe
fees (~2.9% + $0.30 per charge).

### SMS / 10DLC cost (corrected 2026-09-24)

An earlier figure of **~$12–13/tenant/month** (root `CLAUDE.md`, and the first
version of this doc) is the **standard** campaign price. 10DLC fees are set by
The Campaign Registry and the carriers and passed through at nearly the same
price by every provider, so switching provider does not change them — the
campaign **type** does:

| Campaign type    | One-time | Monthly | Fits                                        |
| ---------------- | -------- | ------- | ------------------------------------------- |
| Standard         | ~$20–60  | ~$10    | High-volume senders                         |
| Low-volume mixed | ~$20–60  | ~$1.50  | Small business confirmations and reminders  |
| Sole proprietor  | ~$4      | ~$2     | One person with no EIN, lower sending limit |

Some providers add a $0–20 per-campaign fee; Verizon's per-message carrier fee
rises from $0.0045 to $0.005 on 2026-10-01. The tenant's existing Telnyx voice
number sends the texts, so no second number is needed. Twilio as an SMS-only
provider was priced and is dearer (~$0.0083/segment + $1.15/month number, ~$3.40
vs ~$2.00/month for 60 texts). **Confirm against Telnyx's own 10DLC fee article
before billing on these.** Sources: support.telnyx.com/en/articles/5634625,
tychron.com/the-campaign-registry, readysms.io/blog/10dlc-registration-cost,
twilio.com/en-us/sms/pricing/us.

### Margin on today's placeholders (SMS on: $0.18/call + 2 texts/call + $2.50/tenant; before Stripe)

| Tier         | Price | Calls | Cost at full use | Gross margin |
| ------------ | ----- | ----- | ---------------- | ------------ |
| Solo         | $129  | 150   | ~$32             | ~75%         |
| Growth       | $279  | 500   | ~$101            | ~64%         |
| Professional | $449  | 2,000 | ~$395            | **~12%**     |

Professional is underpriced for its cap unless the LLM cost comes down.

## 3. Our landing page vs the market

- Solo ($129 / 150 calls ≈ $0.86/call) is on the high side for entry; Growth is at
  market; Professional ($449 / 2,000 ≈ $0.22/call) is cheap.
- "No per-call charges. Ever." — every tier has a call cap, and the page never
  says what happens past it.
- FAQ library (document Q&A) and Google Calendar are gated to Growth, contradicting
  TODO §2's "include at all tiers" and putting the differentiators behind $279.
- 14-day no-card trial is generous for the category, and not built (TODO,
  Landing-page / pricing accuracy).

## 4. Options (not decisions)

**A. Volume bands, full product on every tier.** E.g. $99 / 100 calls,
$199 / 350, $349 / 800; overage ~$0.60/call, or a hard cap that falls back to
taking a message. Easy to compare against Rosie/Goodcall; "the full receptionist
from day one". Margins with SMS on: ~78% / ~64% / ~54%. Differentiators no
longer drive upgrades.

**B. Priced by business size (staff + resources), fair-use calls.** E.g. Solo $129
(1 staff, 1 resource), Team $249 (≤5 staff, 3 resources), Shop $449 (unlimited);
fair-use 300 / 1,000 / 2,500 calls. Charges for what makes the booking engine
valuable and keeps "no per-call charges" honest. Needs the LLM cost reduced first:
2,500 calls × $0.18 = $450 is the whole Shop price. Note `COMPETITOR_WEAKPOINTS.md`
argues against seat pricing — staff count here is a size band, not a per-seat fee,
but the distinction must be clear in the copy.

Either way, re-measure after ~50 real (non-test) calls, and check the OpenAI
dashboard against the ledger to settle the cached-token question.
