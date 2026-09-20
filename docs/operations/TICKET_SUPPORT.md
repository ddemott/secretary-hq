# Telnyx Support — Active Ticket

**Number**: `+1 630-822-9086` (live, Thinking Hammer LLC). Previous `+1 630-866-1960` dead. Test verification `+1 630-822-9086`. (Ticket history below covers the prior numbers.)

> ## ✅ STATUS NOTE 2026-09-18 — the inbound outage below is over; this file is history
>
> PSTN inbound to `+1 630-822-9086` was confirmed reaching the agent by a real call on **2026-06-30** (see root `CLAUDE.md`, Project Status). Everything below describes the June 2026 investigation and is kept as a record, not as current state. Whether the Telnyx-side ticket itself was formally closed is not recorded anywhere in the repo.

> ## 📩 UPDATE 2026-06-05 — Telnyx escalated to their internal team
>
> Support agent **Mark Morse** replied (2026-06-05 13:55 UTC, via Pylon →
> `telnyx@notifications.usepylon.com`):
>
> > "Hi Team, We have escalated these call examples to our team for investigation —
> > we will let you know as soon as we hear back."
>
> Ticket is **alive and escalated**; ball is in Telnyx's court. No fix/cause yet —
> awaiting their findings on the inbound call examples (0s CDRs / error 10007).
>
> **Account is healthy now** (prerequisite that was blocking everything): account was
> **suspended 2026-05-25** for a 30-day sustained negative balance — the real reason
> inbound died. Cleared 2026-06-03: payment success → account re-enabled → upgraded
> freemium→full → ID verification accepted → account verification approved.
> Reply directly to that email to add evidence to the thread.

> ## ⚠️ DIAGNOSIS CORRECTED 2026-06-04 — likely NOT a Telnyx config fault
>
> A full end-to-end API audit on 2026-06-04 found **every layer correctly
> configured** (see "Verified clean" below). The earlier "it's on Telnyx's side /
> they're not routing inbound" conclusion is **downgraded** — it rested on a broken
> test (Dale dialing from his own cursed/​unsynced carrier, which never reaches
> Telnyx, so `listRooms()=0` proved nothing). The real symptoms are **PSTN-layer
> number problems, which are carrier-agnostic** (any provider would behave the same):
>
> 1. **`+16308661960` is a recycled DID** with a stuck "disconnected" record cached
>    in carrier routing tables → spoken "not in service" intercept (EL402IL53).
> 2. A **brand-new** number `+16308229086` (bought 2026-06-04, different exchange)
>    gave the **same** "not in service" from Dale's phone → rules out a per-number
>    curse; points to **Dale's originating carrier not having synced the numbers**
>    (propagation lag) — NOT a Telnyx routing fault.
> 3. Telnyx **did** log 4 inbound CDRs on the old number from `+1-608-217-5303` →
>    Telnyx _can_ receive inbound; other carriers reach it. Whether those reached
>    LiveKit was never confirmed (no historical room check).
>
> **Verified clean via API (2026-06-04):**
>
> - Telnyx number `+16308229086`: status `active`, `connection_id` = `2945038451784812111`,
>   `inbound_call_screening=disabled`, no forwarding/translation. Account balance $6.16.
> - FQDN connection `2945038451784812111`: `active`, inbound `default_primary_fqdn_id`
>   → LiveKit FQDN `ai-secretary-nmlkkmgf.sip.livekit.cloud:5060`, transport UDP.
> - LiveKit inbound trunk `ST_aUM3GuCuc9wL` "telnyx-inbound": `numbers` now
>   `["+16308661960","+16308229086"]` (normalized to +E.164 from bare digits 2026-06-04),
>   `allowedAddresses ["0.0.0.0/0"]`. Dispatch rule `SDR_WEL49AwBB4NW` → agent
>   `secretary-hq-agent`. LiveKit creds WORK (the "dead creds" note is stale).
>
> **Open question (the only real one left):** does a call that reaches Telnyx land in
> LiveKit? Decisive test: call `+16308229086` from a **different carrier** (Google
> Voice / VoIP / test-call service / another network) while monitoring LiveKit
> `listRooms()`. Room appears → pipe works, just wait for carrier propagation.
> Nothing → dig into the Telnyx→LiveKit SIP handoff (UDP transport is the next suspect).
>
> **Do NOT** open a Telnyx ticket claiming "you're not routing our inbound" until the
> different-carrier test fails — current evidence says config is fine.

> **Superseded key finding (kept for history):** "Telnyx denied the call reached them;
> Dale found logs proving it did → fault on Telnyx's side." The logs (4 CDRs) do show
> calls reached Telnyx, but that does NOT prove Telnyx failed to forward — see corrected
> diagnosis above.

**Status (2026-06-03) — OPEN, inbound unreachable. Leg localized via instrumented dial: NOT LiveKit; Telnyx-domain.**
A measured dial proved the SIP INVITE never reaches our LiveKit SIP server (LiveKit
`listRooms()` stayed at 0 across the dial; no `call-*` room created). Caller hears a carrier
intercept: "The number you dialed is not in service… Message EL402IL53." This matches Telnyx
support's "the FQDN connection lacks inbound call handling." Earlier "recycled-DID propagation"
theory is superseded; LiveKit `+`/format theory is ruled out (no INVITE arrives to reject).

> **Full evidence in the archived go-live log (`docs/planning/RESOLVED.md`, 2026-07-05 entry → Step 5, 2026-06-03 ~16:00 UTC).**

**Added evidence (2026-06-03):** Telnyx's own Elastic SIP Trunking dashboard shows
**0 inbound calls / 0 minutes** for this number — inbound never reaches the trunk at
all (not a SIP-negotiation failure on our connection). API confirms only 2 connections
exist (`livekit-outbound` FQDN `2945038451784812111` — the number's connection — + an
unused "Forward Only" credential conn `2944916791014459118`), number `connection_id`
correctly = `2945038451784812111`, status active. So the number's inbound routing onto
the trunk, or its PSTN reachability, isn't active on Telnyx's side. Append to the reply:
_"Your Elastic SIP Trunking dashboard shows 0 inbound calls/minutes for +16308661960 —
inbound isn't reaching our trunk. Please confirm inbound calls are delivered to connection
2945038451784812111 and that the number is fully activated for inbound on your network."_

**Reply to send Telnyx (data-backed; keeps us on Option 1, refuses Call Control/TeXML):**

> We use **FQDN SIP trunking (your Option 1)** to an external SIP server (LiveKit Cloud) — a
> Call Control/TeXML app (options 2/3) would break our architecture, so we won't use those.
> The number `+16308661960` is on FQDN connection `2945038451784812111`, whose **inbound
> `default_primary_fqdn_id` = `2945040817925916333`**, which is our FQDN
> `ai-secretary-nmlkkmgf.sip.livekit.cloud:5060`. On an inbound call, **nothing arrives at our
> SIP server** and the caller gets a "not in service" intercept (carrier code EL402IL53).
> Question: on an inbound call to this number, are you (a) finding **no inbound route**, or
> (b) routing to our FQDN and getting a **SIP failure** back — and **what SIP cause code** do
> you see? The inbound FQDN pointer is set, so we need to know why inbound isn't being
> delivered to it.

### Also have Dale check in Mission Control

- The number's **inbound routing** (number → connection inbound, not just outbound assignment).
- Voice → the FQDN connection's **SIP call-flow / debugging** tool for the failed inbound attempt.
- Fallback if Telnyx stalls: provision a different fresh DID (`POST /provisioning/activate`).

**Last updated**: 2026-06-05 (Telnyx escalated to internal team — awaiting their findings; account suspension cleared 2026-06-03)
