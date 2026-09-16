# TCPA SMS Opt-In Consent Copy (Draft)

## Status

**Draft — pending Dale + legal review, not lawyer-reviewed.** Same caveat as the
Bonterms-based legal pages (`dashboard/components/legal/LegalDocLayout.tsx`'s
`LegalNotice`): this is working copy designed to be internally consistent, not
a substitute for counsel. Do not ship it to a real booking flow without a
review pass — see [Decisions still owed](#decisions-still-owed-before-this-ships).

This closes the language half of `docs/planning/TODO.md`'s Legal/business item
_"Add TCPA-compliant SMS opt-in consent language at booking time — required
before any confirmation texts."_ It is **copy only, not wired into code.**

## Why this doesn't ship yet

SMS is OFF platform-wide (`ENABLE_SMS`, default `false`) pending per-tenant
10DLC brand/campaign registration (root `CLAUDE.md` → Architecture). Until a
tenant has a registered 10DLC campaign, no confirmation/reminder text this
product sends will reach a handset regardless of what consent language exists
— see the Telnyx 40010 false-success problem documented there. This doc is
copy to have **ready** for when SMS turns on per-tenant, not something to
enable today. `record_sms_consent` (the agent tool wrapping
`/agent-tools/record-consent` in `src/routes/agentTools/identity.ts`) and
`send_self_service_link` remain absent from the model's toolset while SMS is
off; nothing here changes that gate.

## What TCPA requires (the checklist this copy is built against)

1. Clear disclosure that the customer is consenting to receive
   automated/text messages from the business.
2. Consent is **not a condition** of purchasing the service or booking the
   appointment.
3. A statement of expected message frequency (or a clear description of
   what triggers a message — this product's case, since frequency is
   booking-driven, not a recurring campaign).
4. "Message and data rates may apply."
5. Clear opt-out instructions ("Reply STOP to opt out" / "Reply HELP for
   help").
6. The consent must be evidenced — who agreed, when, to what, and how
   (this repo already has the mechanism: `consent_records` rows with
   `consent_type='sms'`, `consent_method`, `consent_source`, written by
   `ConsentService.recordConsent()` — see
   [Where this attaches in the codebase](#where-this-attaches-in-the-codebase)).

## The copy

### A. Dashboard booking flow — checkbox + disclosure sentence

For wherever a phone number is collected/confirmed at booking time in the
dashboard (manual booking — `dashboard/components/appointments/`).

**Checkbox label (unchecked by default, must be explicitly checked — no
pre-ticked box):**

> ☐ Text me appointment confirmations and reminders at the number above.
> Message and data rates may apply. Message frequency varies with your
> bookings. Reply **STOP** to opt out at any time, or **HELP** for help.
> Consent is not required to book — you can still book by phone or in
> person without opting in.

**Accompanying disclosure sentence (small print under the checkbox, matches
the register-page pattern of linking out to Privacy/Terms rather than
restating them):**

> By checking this box, you agree to receive SMS messages from **[Business
> Name]** about this appointment. This isn't a condition of booking. See
> [Business Name]'s [Privacy Policy] for how your information is used.

Notes on the pattern match:

- The unchecked-by-default, explicit-tick shape mirrors the `/register`
  page's `agreedToLegal` checkbox (`dashboard/app/register/page.tsx`,
  `src/routes/auth.ts`'s `consent_attested: z.literal(true, ...)`) — TCPA
  consent needs the same "the affirmative act is captured" discipline that
  doc uses for the ToS/DPA attestation, and for the same reason the
  `call_disclosure` migration gives for recording attestations: _"an
  attestation that is not recorded is worthless as a defense."_
- "Consent is not required to book" is TCPA's no-condition-of-purchase rule
  stated in the caller-facing sentence itself, not just in a policy page
  nobody reads before clicking.
- This is the **customer's own opt-in**, distinct from the tenant-level
  attestation on `/register` ("I understand an AI assistant answers calls on
  my behalf and I am responsible for informing my callers as required by
  law"). The register-page checkbox is the business owner accepting
  responsibility for _disclosure_; this checkbox is the end customer's own
  _consent to be texted_. Both are needed — one doesn't substitute for the
  other.

### B. Voice agent — spoken opt-in during a phone booking

Scope note: this covers the spoken SCRIPT LINE only — the mechanics of when
the agent would ask it, and re-wiring `record_sms_consent` back into the
model's toolset, are follow-up work for whoever re-enables SMS, not covered
here.

**Spoken line, offered once per booking, after the appointment time is
confirmed but before goodbye (matches the existing pattern in
`agent/src/checklist/trees.ts`'s `booking` tree of asking one wrap-up
question after the core booking facts are locked, and the
`tenants.booking_mechanics` migration's "spoken verbatim after every
successful booking" placement):**

> "Would you like a text confirmation and reminder for this appointment?
> Message and data rates may apply, and you can reply STOP at any time to
> opt out. This is completely optional — I can also just tell you the
> details now."

**If the caller says yes**, the existing `record-consent` tool
(`/agent-tools/record-consent`) is the write path already built for this: it
inserts a `consent_records` row with `consent_type='sms'`,
`consent_method='verbal'`, `consent_source='voice_call:<call_id>'`. No new
column or table is needed for the voice leg — the plumbing already matches
TCPA's "how was consent evidenced" requirement (who/when/how). What's
missing today, and out of scope for this doc, is putting `record_sms_consent`
back in front of the model once SMS is re-enabled (root `CLAUDE.md` lists it
among the tools currently gated off).

**If the caller says no or doesn't answer clearly**, the agent must not
record consent and must not send a text — silence or an ambiguous answer is
not an opt-in under TCPA, and the existing `record-consent` route should
simply not be called.

### C. Opt-out confirmation (already partially implemented — included for completeness, not new copy needed)

`src/services/communications/smsService.ts`'s `consent-request` template
already speaks a STOP-based opt-out ("Reply YES to opt in, or STOP to opt
out") and `src/routes/communications.ts`'s inbound-SMS handler already
processes STOP/START keywords via `ConsentService`. No new copy is proposed
here for the opt-out leg — flagged only so a reviewer doesn't think it's
missing.

## Where this attaches in the codebase (for whoever wires this up later)

Not part of this doc's deliverable (docs-only, SMS is off) — named here so
the eventual implementer doesn't have to re-derive it:

- **Consent write path (already built):** `ConsentService.recordConsent()`
  (`src/services/consentService.ts`) → `consent_records` table,
  `consent_type='sms'`. Both the dashboard checkbox (new `consent_method`,
  e.g. `'dashboard_checkbox'`) and the voice leg (`consent_method='verbal'`,
  already wired in `identity.ts`) write to the same table.
- **Consent read/gate path (already built):**
  `ConsentService.canReceiveCommunications()` /
  `checkConsent()`, consulted by `SMSService.sendMessage()`
  (`src/services/communications/smsService.ts`) before every send — this is
  the enforcement point that makes the checkbox meaningful; a text is
  refused if consent was never given or was later revoked via STOP.
- **Dashboard booking UI:** wherever the appointment phone field lives today
  (`dashboard/components/appointments/AppointmentEditForm.tsx` and the
  booking-creation equivalent) — add the checkbox from section A there.
- **Voice agent:** the `booking` tree in `agent/src/checklist/trees.ts` would
  need a new optional node for the spoken offer in section B, and
  `record_sms_consent` re-added to `selectedTools()`'s passthrough set once
  SMS is back on (root `CLAUDE.md`'s toolset enumeration).
- **10DLC prerequisite:** none of this sends a real text until the tenant has
  a registered 10DLC brand + campaign (root `CLAUDE.md` → Architecture). This
  consent copy is a prerequisite for compliant sending, not a substitute for
  10DLC registration — both are required.

## Decisions still owed before this ships

Matching the "decisions you still owe yourself" pattern in
`docs/legaldocs/AI_Secretary_Consent_and_Privacy_Language.md` §4:

1. **Per-tenant customization or platform-fixed wording?** The spoken
   caller-disclosure precedent (`tenants.call_disclosure`, migration
   `20260711000000_tenant_call_disclosure.sql`) lets an owner override the
   default with an attestation gate. Does the SMS opt-in checkbox get the
   same per-tenant override, or does the "Reply STOP" / rate-disclosure core
   stay platform-fixed (recommended: keep the compliance-bearing sentences
   fixed, allow only the business name to vary) so a well-meaning tenant edit
   can't accidentally strip a required TCPA element?
2. **Where exactly does the dashboard checkbox live?** Named
   `AppointmentEditForm.tsx` as the closest existing component with a phone
   field at booking time; needs a decision on whether it also needs to
   appear on the customer-facing side (e.g. a self-service booking flow, if
   one exists or is added) versus only the staff-facing manual-booking form.
3. **Message frequency language** — this draft describes frequency as
   booking-driven ("varies with your bookings") rather than naming a fixed
   cadence, since there is no recurring marketing campaign, only
   transactional confirmations/reminders. Counsel should confirm this
   satisfies the "message frequency" disclosure element for a transactional
   (non-marketing) SMS use case, which sometimes gets lighter treatment than
   marketing consent under TCPA.
4. **Counsel pass** on the exact wording, same as every other legal artifact
   in this repo (`LegalNotice` in `LegalDocLayout.tsx`; the consent-language
   doc's own §4). Nothing here should be treated as final until Dale/legal
   sign off.
