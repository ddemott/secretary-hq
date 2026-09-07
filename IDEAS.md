# IDEAS.md — secretary-hq Brainstorming & Research

This file captures brainstorming, research findings, and ideas being developed. Once direction is set and work begins, items move to `docs/product/` or `docs/planning/`.

---

# SECTION 1: Question Trees — Industry-Standard Intake

_Source: Original dream + research across Reddit, Garage360, AutoShop Answers, Instanexus, UCall Blog, ALLDATA, Tock, Paperform, Revasi, SalonBiz, StyleSeat, Sam Villa_

## The Principle (Top-Level Rule)

**Every question tree must plan for the vague contingency.** A preliminary visit may be the only honest answer.

Customers describe problems vaguely: "something's wrong with my car", "my AC isn't working right", "I need my hair done." None of these give enough information to book anything with confidence. The AI must assume the Required Information Set (R.I.S.) will be incomplete, and the fallback is always a diagnostic/preliminary visit.

**Every question tree follows the same universal flow:**

1. Contact information (always first)
2. Issue in customer's own words
3. Urgency / safety check
4. Address / location
5. Access details
6. Multi-issue awareness (co-occurring problems)
7. Constraint checks (can we handle this?)
8. Book the right first appointment (usually: diagnostic visit)
9. Read-back confirmation

**Always get full name, address, and phone for any service.** Billing, dispatch, callbacks — non-negotiable.

**Always ask about transport or access needs.** On-site service? Tow needed? Can we handle this vehicle/property?

---

## Universal Intake Structure

Every industry uses the same six-field core:

| Field               | Auto | HVAC | Plumbing | Salon | Fitness | Restaurant | Real Estate |
| ------------------- | ---- | ---- | -------- | ----- | ------- | ---------- | ----------- |
| Name + Phone        | ✓    | ✓    | ✓        | ✓     | ✓       | ✓          | ✓           |
| Address / Location  | ✓    | ✓    | ✓        | ✓     | ✓       | ✓          | ✓           |
| Issue in own words  | ✓    | ✓    | ✓        | ✓     | ✓       | ✓          | ✓           |
| Urgency / Safety    | ✓    | ✓    | ✓        | ✓     | ✓       | ✓          | ✓           |
| Access notes        | ✓    | ✓    | ✓        | ✓     | —       | ✓          | ✓           |
| Co-occurring issues | ✓    | ✓    | ✓        | ✓     | ✓       | —          | ✓           |

---

## Business Type: Auto Repair

### Research Basis

- Missing VIN causes ~1 in 4 repair orders to stall before a technician gets to work
- Phone intake often misses VIN and mileage — AI should attempt to fill these
- Never replace the customer's words with a guessed repair
- ASA standard: customer should leave call knowing what shop will do, what they need to do, and what cannot be decided yet

### Required Information Set (R.I.S.)

1. Customer name + best callback number
2. Vehicle year / make / model
3. Vehicle type: gas, hybrid, or electric?
4. Primary symptom (in customer's own words)
5. Secondary / co-occurring symptoms
6. Mileage
7. Vehicle location
8. Drivability / transport needs
9. Access notes (gate code, garage, parking)
10. Shop capability check (EV lift equipment, exotic cars)
11. Towing capability check (if needed)
12. Who can authorize work? (company vehicles)
13. Check engine light triage (solid vs. flashing)
14. Previous repair history (did another shop look at this?)
15. Diagnostic fee quote upfront

### The Tree

```
[BRANCH] Auto Repair Call

  ├─► [EXTRACT] Customer Info
  │     Ask: "Can I get your name and the best number to reach you?"

  ├─► [EXTRACT] Vehicle
  │     Ask: "What year, make, and model is the vehicle?"
  │     Ask: "Do you happen to know the mileage?"

  ├─► [CONSTRAINT_CHECK] EV / Specialty Vehicle
  │     Ask: "Is this a gas car, hybrid, or fully electric?"
  │     ├─► ELECTRIC → Check: Shop EV Capability?
  │     │     ├─► YES → Flag: "ev_capable"
  │     │     └─► NO → graceful referral to specialty EV shop
  │     └─► EXOTIC → Check: Shop capability + insurance?
  │           └─► NO → graceful referral

  ├─► [EXTRACT] Primary Symptom
  │     Ask: "What's the vehicle doing? What are you noticing?"
  │     Write down exactly what they say. Do not translate.

  ├─► [CONDITION] Check Engine Light?
  │     Ask: "Is there a check engine light on?"
  │     ├─► YES → Ask: "Is it solid or flashing?"
  │     │     ├─► SOLID → Book diagnostic soon, can drive
  │     │     ├─► FLASHING → TOW OR PARK — live misfire,
  │     │     │     risk of catalytic converter damage
  │     │     └─► How long? New today vs. months = different urgency
  │     └─► NO → proceed

  ├─► [EXTRACT] Secondary Symptoms
  │     Ask: "Any other lights on the dash? Any other noises or smells?"

  ├─► [EXTRACT] Prior Work
  │     Ask: "Has another shop already looked at this?"

  ├─► [EXTRACT] Vehicle Location + Drivability
  │     Ask: "Where is the vehicle right now?"
  │     Ask: "Is it currently drivable?"
  │     ├─► DRIVABLE → Can they drop off or need pickup?
  │     └─► NOT DRIVABLE → Check: Towing capability?
  │           Offer tow + diagnostic visit

  ├─► [EXTRACT] Access Notes
  │     Ask: "Gate code, garage, parking restrictions?"

  ├─► [EXTRACT] Customer Transport Preference
  │     Ask: "Will you be waiting here, or need a ride?"
  │     ├─► WAITING → Offer drop-off (shop car or Uber for luxury)
  │     └─► NEEDS RIDE → Check if shop offers rides

  ├─► [AUTHORIZATION_CHECK]
  │     Ask: "Who can authorize work on this vehicle?"
  │     (Company fleet, spouse, etc.)

  └─► [SCHEDULE] Diagnostic Visit
        Quote diagnostic fee first.
        Read back full appointment details.
```

---

## Business Type: HVAC

### Research Basis

- Always confirm address first — dispatch depends on it
- Always do safety gate first: no heat in winter, gas odor, exposed wiring
- Ask: what system type? Has anyone tried to fix it already?
- Quote diagnostic fee now, not on the invoice
- Oil heating systems: different safety profile, flag for correct tech
- Intermittent issues: hardest to diagnose, tech can't recreate on visit
- "Made the rounds" problem: 2-3 other companies already looked = flag for clean-sheet diagnosis

### Required Information Set (R.I.S.)

1. Customer name + callback number
2. Service address (digit-by-digit)
3. Property type: residential or commercial
4. Safety gate (emergency check)
5. System type: furnace, AC, heat pump, boiler, mini-split
6. Refrigerant type (R-410A vs R-454B — not all shops handle both)
7. Make and model (if known)
8. Oil heating flag (if applicable)
9. Issue in own words
10. Intermittent vs. constant
11. Prior work attempted
12. Access notes + pet situation

### The Tree

```
[BRANCH] HVAC Call

  ├─► [EXTRACT] Customer Info
  │     Ask: "Can I get your name and the best number to reach you?"

  ├─► [SAFETY_CHECK] Emergency Gate
  │     Ask: "Is anyone in immediate danger? No heat in cold weather,
  │           exposed wiring, gas odor, smoke, carbon monoxide alarm?"
  │     ├─► YES → Transfer to emergency human immediately
  │     └─► NO → proceed

  ├─► [EXTRACT] Service Address
  │     Ask: "What's the service address — street and unit number?"
  │     Read it back digit by digit.
  │     Ask: "Residential or commercial?"

  ├─► [EXTRACT] System Type
  │     Ask: "What type of system — furnace, central AC, heat pump,
  │           boiler, mini-split?"
  │     Ask: "Do you know the refrigerant type? R-410A or R-454B?"
  │     Ask: "Is this oil heating or gas?"

  ├─► [EXTRACT] Make and Model
  │     If unknown: Flag "model_unknown" — tech identifies on-site

  ├─► [EXTRACT] Symptom
  │     Ask: "What are you noticing? When did it start?"
  │     Ask: "Does it happen all the time, or only sometimes?"
  │     If intermittent: advise customer to note conditions

  ├─► [EXTRACT] Prior Work
  │     Ask: "Has anyone tried to fix this yet?"

  ├─► [CONDITION] Made the Rounds?
  │     If 2-3 other companies already looked:
  │     Flag: "clean_sheet_diagnosis" + higher initial estimate

  ├─► [EXTRACT] Access Notes
  │     Ask: "Gate code? Where is the unit?"
  │     Ask: "Please have any pets secured — dogs, cats —
  │           so our technician can work safely."

  └─► [SCHEDULE] Diagnostic Visit
        Quote diagnostic fee first.
        Technician arrives with system type, symptoms, prior attempts,
        access notes, intermittent flag if applicable.
```

---

## Business Type: Plumbing

### Research Basis

- Active water changes everything — urgency always first
- Sewage backup = biohazard, emergency-grade, not standard booking
- "Is anyone without water?" = crisis, priority escalation
- Well water vs. city water = different systems
- Water heater specifics: gas/electric/tankless changes the job entirely
- Major jobs need permit check flagged for manager review

### Required Information Set (R.I.S.)

1. Customer name + callback number
2. Service address
3. Active water / sewage / no water — emergency check
4. Specific issue in customer's own words
5. Duration and escalation
6. Building type + age
7. Well water vs. city water
8. Water heater specifics (if applicable)
9. Prior work
10. Access notes + pet situation
11. Permit implications flagged

### The Tree

```
[BRANCH] Plumbing Call

  ├─► [EXTRACT] Customer Info
  │     Ask: "Can I get your name and the best number to reach you?"

  ├─► [SAFETY_CHECK] Active Water / Sewage
  │     Ask: "Is water actively leaking, sewage backing up,
  │           or are you without water?"
  │     ├─► YES (active/sewage/no water) → Priority escalation
  │     │     Flag: "priority_active_water" → human dispatcher alerted
  │     └─► NO → proceed

  ├─► [EXTRACT] Address

  ├─► [EXTRACT] Issue
  │     Ask: "What are you noticing?"
  │     Write down exactly what they say.

  ├─► [EXTRACT] Duration
  │     Ask: "How long has this been happening? Getting worse?"

  ├─► [EXTRACT] Building Type
  │     Ask: "Single family, condo, apartment, commercial?"

  ├─► [CONDITION] Water Heater?
  │     If water heater issue:
  │     Ask: "Gas or electric? Tank or tankless? Approximate age?"

  ├─► [CONDITION] Well or City Water?
  │     Ask: "Are you on well water or city water?"
  │     (Different systems = different prep)

  ├─► [EXTRACT] Prior Work

  ├─► [CONDITION] Permit Implications?
  │     If major job (repiping, sewer, water heater):
  │     Flag: "permit_required" → manager review before timeline commitment

  ├─► [EXTRACT] Access Notes
  │     Ask: "Water shutoff location? Basement access?"
  │     Ask: "Please have any pets secured so our plumber can work safely."

  └─► [SCHEDULE] Service Appointment
```

---

## Business Type: Hair Salon

### Research Basis

- New client = full consultation. Returning client = quick confirm.
- Always ask about allergies before color services
- Cancellation policy disclosure required at booking
- Deposit required for new color clients (industry standard: 50% deposit)
- No-show cost: $15K/year per stylist per Reddit research
- "What did you last have done?" — stylist context for returning clients

### Required Information Set (R.I.S.)

1. Customer name + callback number
2. New client or returning?
3. Service requested: cut, color, cut + color, treatment
4. If color: current color, target color, last appointment, allergies
5. Hair type / texture / challenges
6. Style goals
7. Stylist preference
8. Appointment preference
9. Cancellation policy confirmation (new clients)
10. Deposit collected if required (new color clients)
11. Referral source ("how did you hear about us?")
12. Waitlist if requested time unavailable

### The Tree

```
[BRANCH] Salon Call

  ├─► [EXTRACT] Customer Info
  │     Ask: "Can I get your name and the best number to reach you?"

  ├─► [EXTRACT] New or Returning
  │     Ask: "Have you been in to see us before?"
  │     ├─► RETURNING → Pull prior visit history
  │     │     Ask: "What did you last have done with us?"
  │     └─► NEW CLIENT → Full consultation mode

  ├─► [EXTRACT] Service Requested
  │     Ask: "What are you hoping for today?"

  ├─► [CONDITION] Color Service?
  │     ├─► YES → [EXTRACT] Color History
  │     │     Ask: "Current color? Target color?"
  │     │     Ask: "Last color appointment?"
  │     │     Ask: "Any reactions to hair color or bleach?"
  │     │     [DEPOSIT_CHECK] New color client?
  │     │           If yes: "We require a deposit to secure first-time color appointments."
  │     │           Send Stripe Payment Link.
  │     │
  │     └─► NO → [EXTRACT] Style Goals
  │           Ask: "Look in mind, or want suggestions?"
  │           Ask: "How much time do you spend on hair daily?"

  ├─► [EXTRACT] Stylist Preference
  │     Ask: "Any stylist preference, or flexible?"

  ├─► [EXTRACT] Appointment Preference
  │     Ask: "What day and time works?"

  ├─► [CONDITION] Time Available?
  │     ├─► AVAILABLE → proceed to booking
  │     └─► NOT AVAILABLE → Ask: "Add to waitlist if something opens?"

  ├─► [CANCELLATION_DISCLOSURE]
  │     Confirm cancellation policy before booking.
  │     "We require 24 hours notice to cancel. Late cancels
  │      or no-shows are subject to a fee."

  └─► [SCHEDULE] Appointment
        Read back: service, stylist, date/time, deposit status.
```

---

## Business Type: Fitness / Personal Training

### Research Basis

- First appointment is a consultation, not a training session
- Medical clearance required for high-risk clients (legal liability)
- Goal specificity: "get in shape" isn't enough — need measurable outcomes
- Trial session offer reduces friction to conversion

### Required Information Set (R.I.S.)

1. Customer name + callback number + email
2. Age
3. Fitness goals in own words
4. Experience level
5. Injuries / limitations / health conditions
6. Medical clearance flag
7. Availability
8. Trainer preference
9. Trial session offer
10. Nutrition/lifestyle context (optional)

### The Tree

```
[BRANCH] Fitness Call

  ├─► [EXTRACT] Customer Info
  │     Ask: "Can I get your name, email, and number?"

  ├─► [EXTRACT] Goals
  │     Ask: "What are your fitness goals? What are you working toward?"
  │     Write down exactly what they say.

  ├─► [EXTRACT] Experience Level
  │     Ask: "Beginner, intermediate, or advanced?"

  ├─► [EXTRACT] Injuries / Limitations
  │     Ask: "Any injuries, limitations, or health conditions we should know about?"
  │     ├─► YES → Flag: "medical_clearance_required"
  │     │     "For your safety, we'd recommend doctor clearance first."
  │     └─► NO → Flag: "cleared"

  ├─► [CONDITION] Trial Offer
  │     If undecided: "We offer a free trial session — want to schedule one?"

  ├─► [EXTRACT] Availability

  ├─► [EXTRACT] Trainer Preference

  └─► [SCHEDULE] Consultation (not a training session)
        Trainer sees: goals, experience, medical flag, availability.
```

---

## Business Type: Restaurant

### Research Basis

- Party size always first (table assignment)
- Dietary restrictions at booking, not at the table
- Large party (8+) = private room / deposit / manager review
- Cancellation policy for large parties
- Weather-conditional outdoor seating — must disclose
- Prix-fixe / special event pricing — must disclose proactively
- Allergy severity: distinguish sensitivity from serious reaction
- Wait time estimates reduce angry customers

### Required Information Set (R.I.S.)

1. Guest name + callback number
2. Party size + large party flag
3. Date and time + flexibility
4. Seasonal / holiday check
5. Special occasion + birthday name
6. Dietary restrictions + allergy severity
7. Seating preference
8. Accessibility needs
9. Weather-conditional disclosure (if outdoor)
10. Cancellation policy (large parties)
11. Deposit (large parties)
12. Parking / valet info

### The Tree

```
[BRANCH] Restaurant Call

  ├─► [EXTRACT] Guest Info
  │     Ask: "Name and best number for the reservation?"

  ├─► [EXTRACT] Party Size
  │     Ask: "How many guests?"
  │     If 8+ → Flag: "large_party" → may need private room / deposit

  ├─► [EXTRACT] Date and Time
  │     Ask: "What date and time?"
  │     Ask: "Flexible on time?"

  ├─► [CONDITION] Peak Season?
  │     If booking near major holiday:
  │     Ask: "Celebrating anything specific? Holidays book fast."

  ├─► [EXTRACT] Special Occasion + Birthday
  │     Ask: "Special occasion? Birthday, anniversary, graduation?"
  │     ├─► BIRTHDAY → "Whose birthday? We'll make sure they're celebrated."
  │     ├─► ANNIVERSARY → "How many years?"
  │     └─► BUSINESS → Flag: "business_dinner"

  ├─► [EXTRACT] Dietary Restrictions
  │     Ask: "Any dietary restrictions, allergies, or preferences?"
  │     Follow-up: "Is it a sensitivity or a serious reaction
  │                 we need to flag for the kitchen?"
  │     Flag: "allergy" prominently if serious

  ├─► [CONDITION] Outdoor Seating?
  │     If patio requested:
  │     "Outdoor seating is subject to weather. If it rains,
  │      we'll do our best to accommodate you inside."

  ├─► [CONDITION] Prix-Fixe / Special Event?
  │     If applicable:
  │     Disclose special menu / pricing proactively before booking

  ├─► [EXTRACT] Seating Preference
  │     Ask: "Indoor, patio, window, booth, quiet corner?"

  ├─► [EXTRACT] Accessibility Needs
  │     Ask: "Wheelchair access, high chairs, walker space?"

  ├─► [CONDITION] Large Party?
  │     If 8+:
  │     - Confirm cancellation policy
  │     - Flag for deposit / card hold
  │     - Manager review

  └─► [SCHEDULE] Reservation
        Read back: name, party size, date, time, occasion,
        dietary note, seating preference.
```

---

## Business Type: Real Estate

### Research Basis

- Speed wins: leads contacted within 5 minutes are 10x more likely to convert
- Listing vs. buyer consultation = different flows
- Always ask: are they already working with an agent?
- Pre-qualification status matters for buyers
- If property already listed with another agent = different conversation

### Required Information Set (R.I.S.)

**Listing Appointment:**

1. Contact name + phone + email
2. Property address
3. Agent status (already working with someone?)
4. Property already listed?
5. Motivation
6. Timeline
7. Price awareness / asking price
8. Pre-qualified / pre-approved flag

**Buyer Consultation:**

1. Contact name + phone + email
2. Pre-qualification status
3. Budget range + flexibility
4. Timeline
5. Top 3 must-haves
6. Agent status

### The Tree (Listing)

```
[BRANCH] Real Estate — Seller Inquiry

  ├─► [EXTRACT] Contact Info

  ├─► [EXTRACT] Property Address

  ├─► [CONDITION] Already Listed?
  │     Ask: "Is this property already on the market?"
  │     If yes → Flag: "switch_conversation" → honest dialogue

  ├─► [EXTRACT] Agent Status
  │     Ask: "Are you currently working with an agent?"
  │     If yes → Flag: "has_agent" → warm referral

  ├─► [EXTRACT] Motivation
  │     Ask: "What brought you to thinking about selling?"

  ├─► [EXTRACT] Timeline

  ├─► [EXTRACT] Price Awareness
  │     Ask: "What are you hoping to get for it?"

  └─► [SCHEDULE] Listing Appointment
        Flag: "respond within 5 minutes" (speed rule)
```

---

## Cross-Business Node Types Needed

These new node types apply across all business types:

1. **[SAFETY_CHECK]** — Triggers on dangerous symptoms regardless of caller. Overrides normal flow.
2. **[CONSTRAINT_CHECK]** — Shop capability gate. Refers out if out of scope.
3. **[AUTHORIZATION_CHECK]** — Who can approve work/spending?
4. **[INSURANCE_FLAG]** — Is this being filed through insurance?
5. **[DEPOSIT_CHECK]** — Does this booking require a deposit?
6. **[CANCELLATION_DISCLOSURE]** — Confirm policy before finalizing.
7. **[FOLLOWUP_OWNERSHIP]** — No vague callbacks. Book a real time or flag human follow-up.
8. **[WEATHER_CONDITIONAL]** — Outdoor bookings subject to weather.
9. **[PREQUAL_STATUS]** — Real estate buyer pre-approval.
10. **[PAYMENT_CONVERSATION]** — Financing options for large jobs.

---

## Universal Mistakes to Avoid

1. **Guessing instead of recording** — Write down exactly what customer says.
2. **Asking for info customer doesn't have** — Flag unknown. Let tech identify on-site.
3. **Not quoting diagnostic fee** — Quote first. Full estimate comes after inspection.
4. **Skipping urgency check** — Customer says "not urgent" but symptom is dangerous.
5. **Forgetting access notes** — Technician arrives at gate with no code.
6. **Not reading back** — Customer says "Thursday 2." Shop books "Tuesday 2."

---

# SECTION 2: Critical Thinking — Blind Spots & Edge Cases

_Source: Reddit r/smallbusiness, r/autorepair, r/hvacadvice, r/hairstylist, r/homeowners, r/askaplumber, r/HVAC + industry research_

## The Core Problem the Research Confirms

Most service businesses lose leads because of a broken intake call, not because of bad service.

- Businesses losing $60-80K/year from unanswered/mishandled calls
- Customers calling back multiple times because first call didn't capture enough
- Technicians showing up unprepared
- Customers feeling "rushed" and going to a competitor

## Cross-Business Blind Spots

### Missing: Who is calling?

- Is this the decision-maker or a spouse/assistant calling on their behalf?
- Do both decision-makers need to be present at the appointment?
- Relevant for: real estate, home services, auto (company vehicles)

### Missing: Urgency calibration

- Customer says "it's not urgent" but symptom is dangerous
- "My AC isn't working" in August in Phoenix = urgent
- "My heat is making a weird noise" in January = potentially dangerous
- AI should gently push back on "not urgent" claims when safety is involved

### Missing: What have you already tried?

- DIY fixes that didn't work
- Products the customer already used
- Tells technician what NOT to recommend

### Missing: Payment / financing conversation

- Major jobs (HVAC replacement, auto transmission, water heater)
- AI should ask: "Is this something you'd want to discuss payment options for?"
- Opens financing conversation without assuming they need it

### Missing: Insurance involvement

- Auto: "Is this being filed through insurance? Claim number?"
- Home: "Is this related to a homeowner's insurance claim?"
- Captures early — changes entire workflow

### Missing: HOA / landlord / property manager approval

- Condos require board approval for exterior work
- Rental properties require landlord authorization
- AI should ask: "Do you own outright, or is there an HOA or property manager?"

### Missing: Accessibility for caller

- Elderly or disabled caller — AI should adapt tone and pace
- If caller sounds confused or overwhelmed, slow down and confirm understanding

### Missing: Language barrier

- If significant language difficulty detected → flag for human callback
- Not a cold transfer, a warm handoff

### Missing: After-hours routing

- What happens at 10pm? Emergency line vs. leave a message vs. book next day
- Configured per tenant, but question tree should handle it

### Missing: Spam / non-customer calls

- Vendors, recruiters, other businesses calling the main line
- AI should route non-customer calls away from intake flow

### Missing: Callback intent

- "I'll call back" is not a booking
- AI should ask: "Can I book a specific callback time now?"

### Missing: Appointment reminder opt-in

- "Can we send you a reminder the day before?"
- Reduces no-shows significantly

## Business-Specific Blind Spots

### Auto Repair

- **Check engine light triage** (solid vs. flashing = different actions)
- **Mileage** (predicts maintenance due, related component failures)
- **Who can authorize work?** (company vehicles, fleet)
- **Previous repair history** ("made the rounds" = clean-sheet diagnosis needed)
- **Price expectation management** (never guess, quote diagnostic fee)

### HVAC

- **Refrigerant type** (R-410A vs R-454B — not all shops handle both)
- **Oil heating** (different safety profile, specific certifications)
- **Intermittent issues** (hardest to diagnose, tech can't recreate)
- **"Made the rounds"** (flag for clean-sheet diagnosis, higher initial estimate)
- **What to look for before the tech arrives** (error codes, reset button)

### Plumbing

- **Sewage vs. clean water** (biohazard distinction)
- **Water heater specifics** (gas/electric/tankless changes everything)
- **"Is anyone without water?"** (crisis, priority escalation)
- **Well vs. city water** (different systems)
- **Permit implications** (major jobs need permit check)

### Salon

- **Cancellation policy** (disclose before booking, not after no-show)
- **Deposit for new color clients** (industry standard: 50%)
- **Prior visit history** (returning clients: what did they last have?)
- **Referral source** ("how did you hear about us?")
- **Waitlist handling** (convert lost leads to future bookings)

### Fitness

- **Medical clearance** (legal liability for high-risk clients)
- **Goal specificity** ("get in shape" isn't enough)
- **Trial session offer** (reduces friction to conversion)
- **Have you trained with us before?** (why they left matters)

### Restaurant

- **Cancellation policy** (large parties, Valentine's Day)
- **Deposit for large parties** (8+, card hold)
- **Weather-conditional outdoor seating** (must disclose proactively)
- **Prix-fixe / special event pricing** (must disclose before booking)
- **Wait time estimates** (surprise waits = angry customers)
- **Dietary complexity escalation** (5+ severe allergies = kitchen manager review)
- **Valet / parking info** (downtown, special events)

### Real Estate

- **Pre-qualification status** (buyers)
- **Property already listed?** (switch conversation, not fresh listing)
- **"What's your home worth?"** (price expectation management)
- **Multiple offers or deadline?** (if yes, seller needs immediate help)
- **Buyer budget rigidity** ("is that your hard ceiling?")

## Emotional Intelligence Layer

Reddit research reveals what customers actually feel during intake calls:

- **Feel rushed** when: AI asks too many questions without acknowledging what they've said
- **Feel misunderstood** when: AI translates their symptom into technical language
- **Feel pushed** when: AI asks about money before understanding the problem
- **Feel cared for** when: AI asks about their comfort, safety, and schedule
- **Feel respected** when: AI explains why it's asking something
- **Leave angry** when: Told to wait 45 minutes without warning

The AI doesn't just collect data — it creates an experience. Every question should feel like the business cares, not like a bureaucracy.

## What This Means for the Architecture

### 1. New node types needed (see above)

### 2. Dispatch note format

Technicians need clean, scannable dispatch notes formatted for field reading.

### 3. Appointment confirmation message

After booking, does the customer get text/email confirmation? Must be part of tree output.

### 4. R.I.S. per business type needs legal review

Fitness medical clearance, HVAC refrigerant handling, auto towing liability — need legal sign-off on what AI is and isn't responsible for.

---

# SECTION 3: Deposit Collection via Stripe

_Status: Being developed — moves to docs/product/ when direction is set_

## Problem

The AI needs to collect deposits and cancellation fees for certain businesses (salons, restaurants, real estate). Taking credit card numbers over the phone is a PCI compliance risk.

## Solution: Stripe Payment Links

AI never touches raw card data. Customer enters card directly on Stripe's hosted page.

### Flow 1: Deposit at Booking

```
AI: "To secure your appointment, we need a [X]% deposit.
     I'll send you a secure link right now."

AI sends Stripe Payment Link via SMS
Customer clicks → Stripe's hosted page → enters card
Stripe charges → webhook to secretary-hq → appointment confirmed
```

### Flow 2: Cancellation / No-Show Fee

```
Customer cancels late or no-shows
AI or admin charges saved Stripe Customer ID
No confrontation needed — policy disclosed at booking
```

## PCI Scope: Zero

Card data lives on Stripe's servers. We only see:

- Payment Link URL
- Stripe Customer ID
- Payment status (succeeded/failed)

## What to Build

1. Stripe SDK integration (API keys in environment)
2. Payment Link generation (one API call per booking)
3. Customer creation and storage (Stripe Customer ID only)
4. Webhook handler (payment success/failure)
5. SMS sending (Twilio or Stripe's built-in)
6. Business rules config per tenant:
   - Which services require deposits
   - Deposit amount (% or fixed)
   - Cancellation window (24h, 48h, 72h)
   - Cancellation fee (% of service)

## APIs Used

- `paymentLinks.create`
- `customers.create`
- `customers.update` (attach payment method)
- `invoices.finalizeInvoice` + `invoices.pay` (cancellation fees)
- Webhooks: `payment_intent.succeeded`, `payment_intent.payment_failed`

## Open Questions

- Which demo tenant gets this first? (Salon is natural)
- Charge cancellation fees automatically or flag for human review?
- SMS via Twilio or Stripe's own messaging?

---

# SECTION 4: Critical Thinking — New Research Findings

_Source: Reddit r/AI_Agents, r/smallbusiness, r/sales, r/autorepair, r/HVAC, r/TalesFromYourServer, r/restaurant + Ratchet and Wrench, Pete Bowen, ContractorMag, Valley Marketing Group, SkipCalls, IntellidriveOS_

_Date: 2026-09-06 — Second research pass_

---

## THE BIGGEST BLIND SPOT WE HAVE: AI Perception

**This is a product-level problem, not just a question tree problem.**

Research findings:

> _"When I get one [AI receptionist] I just hang up. Even if I was calling a business for myself if I get an AI I just hang up, I have absolutely no patience for it."_ — Reddit r/sales

> _"Did customers realize they were speaking with AI? My prospects and customers are largely annoyed by her. they know it's AI and usually hang up."_ — Reddit r/AI_Agents

> _"I worry that hitting a bot when they're already anxious will just make them hang up and call someone else."_ — Small business owner, Reddit

**This means our question trees could be perfect and it doesn't matter if callers hang up before they get to them.**

### What's the fix?

From the research, callers stay on when they feel:

1. **Someone is glad they called** — not "press 1 for this, press 2 for that"
2. **They won't have to repeat themselves** — the AI already knows why they're calling
3. **They'll get to a real person if needed** — AI isn't a dead end
4. **The AI knows their business** — not generic, not robotic
5. **They're being helped, not processed**

**The question tree isn't enough. The AI needs to sound like a human who works at this specific business.**

New question tree requirement: **Tone calibration per tenant**

- Auto shop: professional, confident, advocate for the customer
- Salon: warm, conversational, excited about the visit
- Restaurant: hospitable, anticipatory
- HVAC: calm, reassuring, safety-focused

**The greeting is the most important moment.** It sets everything. It needs to be:

- Shop name + agent name (sounds human)
- "Glad you called" energy
- Opens the reason-for-call without forcing it

---

## THE THREE CUSTOMER CALL TYPES THAT KILL AUTO SHOPS

From Pete Bowen / Liam Lezra research on auto shop phone failures:

### Type 1: The Ghost Customer

**Problem: No next step captured.**

```
Customer: "Okay, just stop by whenever you're ready."
Advisor: "Sounds good, just come on by."
→ No name. No phone number. No appointment.
→ No way to follow up. Opportunity gone forever.
```

**This is the biggest risk for secretary-hq.** A caller who says "I'll call back" or "I'll stop by" without booking is a ghost customer. Our trees must prevent this.

**New node needed: [GHOST_PREVENTION]**

```
If caller says they'll handle it themselves:
→ "I totally understand. Can I get your name and number
   just in case anything comes up on your end?
   That way we can be ready when you bring it in."
→ Capture name + number even if no booking.
→ Flag for follow-up.
```

### Type 2: The Price Shopper

**Problem: They just want a number. You can't give one honestly.**

```
Customer: "How much to fix my transmission?"
Advisor: "I can't give a price without seeing it."
Customer: *hangs up, calls next shop*
```

**New handling: Don't fight it. Redirect it.**

```
"If you've already had some quotes, I'd love to see them.
 Sometimes we find the problem is smaller than what was quoted.
 I don't want to give you a number over the phone that could be
 completely wrong — it might be $3,000... or it might be $30.
 The only way to know is to take a look. Can you bring it in today?"
```

### Type 3: The Busy Workshop

**Problem: Shop is full. Advisor turns the caller into a referral.**

```
Advisor: "We're really busy today, maybe try another shop."
→ Turns a $300+ lead into a referral for a competitor.
```

**New handling:**

```
"We're very busy today, but we can still take care of you.
 Our [sister location / next available slot] can look at it today.
 Can you bring it in this afternoon?"
```

**Our question tree must route around "we're full."**
→ Check sister shop availability
→ Check tomorrow first-thing availability
→ Never let "we're busy" = "call someone else"

---

## THE CALLBACK PROBLEM: Why Calling Back Doesn't Work

Critical data from research:

> _"75% of missed callers never call back."_
> _"85% will not leave a voicemail."_
> _"A callback converts so much worse than a live pickup — you are not returning a call; you are trying to un-book a competitor."_ — IntellidriveOS

**The urgency window compresses fast.** A caller with a no-heat situation on a Friday at 6 PM is not waiting for a Monday callback. They called three other shops. The first one that answered and sounded competent got the job.

**This is why secretary-hq must answer live, not queue for callback.**

New requirement: **Answer rate is the #1 metric.**

- If calls go unanswered, nothing else matters
- AI must answer on first ring, 24/7 including after hours
- After-hours calls are often the highest-margin work (emergency pricing)

---

## NEW: The Follow-Up Layer (Not Just the First Call)

Research from Ratchet and Wrench:

> _"Follow up. Following up with a customer after a service allows the customer to give feedback on how the service went, as well as gives the shop an opportunity to correct the problem, and schedule a future service."_

> _"Calling with updates and follow-up lets customers know that they're not forgotten about."_

> _"While you have the customer on the phone, bring up the car's next service due date and schedule a future appointment."_

**The question tree covers the inbound call. But what about:**

- The post-service follow-up call?
- The "your car is ready" call?
- The "how did everything go?" check-in?
- The "your next service is due" reminder call?

These are outbound AI calls. The question tree needs an outbound version too.

**New outbound tree types to add:**

1. [OUTBOUND] Service complete — car ready for pickup
2. [OUTBOUND] Post-service check-in — how did it go?
3. [OUTBOUND] Next service due reminder
4. [OUTBOUND] Missed appointment follow-up
5. [OUTBOUND] Appointment reminder (24h before)

---

## NEW: Being an Advocate, Not an Adversary

Research from David Avrin (customer experience consultant):

> _"The customer doesn't want to get screwed. They lack knowledge, they lack time, they lack patience. Position yourself as their advocate."_

> _"If a customer calls and their car is making a horrible noise, they're scared. They're thinking worst-case scenario. It's our job to be able to say 'I'm so sorry you're going through that. We're here to help.'"_

> _"Quality is the entry fee. It's not the differentiator. Quality gives you permission to do business in the marketplace."_

**What this means for the AI:**

- The AI should never sound defensive or bureaucratic
- The AI should sound like it's on the customer's side
- When the customer is scared (no-start, no heat, backed-up sewer), the AI should acknowledge the emotion before moving to logistics
- The AI should explain what it's doing and why — "This helps us make sure we send the right technician" — not just ask questions

**New emotional calibration:**

```
SCENARIO: Customer sounds scared/upset
→ Don't rush to logistics
→ Acknowledge first: "That sounds stressful — let me get you taken care of right away."
→ Then proceed with the tree
```

---

## THE FIRST CALL AFTER THE CAR IS IN THE SHOP

Research from Ashley Wright (Premier Auto service manager):

> _"If it's an issue with brakes, we only talk about brakes during that call. That way, a customer doesn't think we're trying to sell them all of this other stuff and that we're really focused on their concern."_

> _"If something major is wrong, we also advise them to get that fixed — their safety is our primary concern. But transparency is key."_

**New rule: The post-drop-off call**

- One issue at a time
- Don't upsell on the first call
- Digital inspection reports via text (so they can see where money is going)
- "While I have you — your next service is due in [X] miles. Want to schedule that now or wait until after this visit?"

---

## SALON: DEPOSITS MUST BE APPLIED EQUALLY

Critical research finding from salon Reddit:

> _"Paying upfront isn't automatically shady. What matters is whether the salon applied that policy fairly."_

> _"Regular customers may be allowed to pay afterward because employees already know them. Unfamiliar customers get asked first. That distinction changes the conversation."_

**New requirement:**

- Deposit policy must be applied consistently to ALL new clients
- Not based on appearance, accent, or perceived reliability
- The AI must apply it the same way every time — no discretion
- "We require a deposit for all first-time color appointments" — said warmly, as a policy, not a judgment

**New salon tree addition:**

```
├─► [EXTRACT] New Client + Deposit Check
  │     If NEW CLIENT + COLOR SERVICE:
  │     "For first-time color appointments, we require a small deposit
  │      to secure your time — it's [X]% of the service and
  │      goes toward your appointment. Is that something that works for you?"
  │     (Must be applied consistently. Not optional. Not negotiable.)
```

---

## RESTAURANT: THE CANCELLATION MATH

Research finding:

> _"A 10-top reservation that no-shows on a Saturday night doesn't just cost the table — it costs the restaurant the ability to seat another party, plus the staff scheduled for that table."_

**For large party restaurant reservations (8+):**

- Confirm cancellation policy at booking
- Consider requiring card on file
- Flag for manager review
- If same-day cancellation: follow up to rebook or at minimum get a reason

**New restaurant tree addition:**

```
├─► [CONDITION] Large Party (8+)
  │     Flag: "large_party" → manager review
  │     "For parties of [X] or more, we do require a card on file
  │      and ask for at least 48 hours notice for cancellations.
  │      Is that something that works for your group?"
  │     Capture card if required by restaurant policy.
```

---

## THE PRICING EXPECTATION PROBLEM

Research from auto repair and HVAC:

> _"Customers always ask for a price on the first call. Never guess. Quote the diagnostic fee. Explain that the full estimate comes after inspection."_

> _"The one price you can quote over the phone? A diagnosis fee."_ — Dytech Auto Group

**New rule across all service businesses:**

- Always quote the diagnostic / service call fee
- Never quote a repair estimate on the first call
- Explain: "We can't give a fair estimate without seeing it first. What I can tell you is our diagnostic fee is $X — and if you proceed with any work, that goes toward the total."
- This sets expectations and reduces sticker shock

---

## MISSED ITEMS FROM RESEARCH

### Auto Repair — additional items found:

- **"What did you already try?"** — captures DIY failures, jump starts, parts store scans
- **"Has the check engine light been on long?"** — months = stored code, low urgency; new = faster triage
- **"Do you have the OBD-II scan results?"** — if they had it scanned at a parts store, get the codes
- **Follow-up promise** — if advisor says "we'll call you back," record the exact time and who owns it

### HVAC — additional items found:

- **"Is the thermostat battery dead?"** — cheapest fix first, avoid a service call
- **"Is this a commercial or residential system?"** — different equipment, different pricing
- **"How many tons is your unit?"** — sizing matters for replacement quotes
- **Intermittent issues** — customer should be advised: don't reset, don't try to recreate, note conditions instead

### Plumbing — additional items found:

- **"Is this affecting hot water, cold water, or both?"** — narrows the problem significantly
- **"Do you have water pressure everywhere or just one fixture?"** — whole-house vs. single fixture
- **"Is there a gas smell?"** — safety flag, immediately escalate to human

### Restaurant — additional items found:

- **"Do you have a preferred seating time?"** — some guests want early or late within the window
- **"Would you like to be added to our call list for future reservations?"** — builds the database
- **"Is this your first time with us?"** — first-time guests get a different experience

### Real Estate — additional items found:

- **"Have you seen the property in person yet?"** — virtual vs. in-person tour preference
- **"What's your timeline if you find something you love?"** — distinguishes browsers from buyers
- **"Are there any properties you're working with another agent on?"** — dual agency disclosure

---

## THE DISPATCH NOTE PROBLEM

Research from auto repair (Ratchet and Wrench):

> _"One of the worst things to do is to answer in a hurry because it makes the customer feel like he or she is an inconvenience."_

> _"If it concerns policies, look it up. If it has to do with the vehicle itself, go out and ask the technician."_

**The dispatch note is not just for the technician. It's for everyone who touches this job:**

- The technician in the bay
- The service advisor who calls the customer back
- The parts counter
- The person doing quality control
- The owner if something goes wrong

**Dispatch note format requirement:**

```
[VEHICLE] 2006 Toyota Camry / 142,000 miles
[CUSTOMER] Barb Smith — 608-555-1234
[SYMPTOM] "It clicks once when I try to start it, sometimes not at all"
[CO-OCCURRING] None reported
[CHECK ENGINE] Solid light, on for ~2 weeks
[DRIVABILITY] Not currently drivable
[TRANSPORT] Tow needed — Uber courtesy offered
[ACCESS] Gate code: 4821
[PRIOR WORK] Had AutoZone scan it — P0300 code (misfire)
[APPOINTMENT] Diagnostic — [date] @ [time]
[DIAGNOSTIC FEE] Quoted: $89
[FLAGS] ev_capable, uber_courtesy, clean_sheet_diagnosis
[NOTES] Customer sounded stressed. Be reassuring on arrival.
```

---

## THE CALL QUALITY PROBLEM

Research finding:

> _"Liam recommends that the owner or manager review five calls per service advisor per week. If you identify a bad call, listen to it together with the service advisor and discuss what happened."_

> _"This accountability needs to happen regularly, because lead handling quality inevitably decays."_

**What this means for secretary-hq:**

- We need call recording (with disclosure)
- We need a way to score calls
- We need a way to review calls
- We need a way to coach when the AI drifts

**New product feature needed:**

- [FEATURE] Call scoring — did the AI follow the tree? Did it capture all R.I.S. fields?
- [FEATURE] Call review — human can listen to flagged calls
- [FEATURE] AI drift detection — when the AI starts skipping nodes or using wrong language
- [FEATURE] Coaching mode — Roady reviews calls, flags issues, updates trees

---

## UPDATED OPEN QUESTIONS FOR DALE

1. ~~Which business type gets the first full question tree implementation?~~ **RESOLVED:** Auto shops.
2. ~~Which demo tenant gets Stripe deposit collection first?~~ **RESOLVED:** Auto shops.
3. ~~Do we build the new node types as a framework, or per business type?~~ **RESOLVED:** Per business type. Each business type gets a template tree (auto, salon, HVAC, etc.). Tenant gets their own instance (copy) of the template and can customize that instance for their specific business. They are not changing the master template. We need to build a tree editor in the admin dashboard so tenants can tweak their instance.
4. ~~What does the dispatch note format look like? Who reviews it?~~ **RESOLVED:** Each business gets a dashboard where they can see their workload — appointments, dispatch notes, customer info, status. Dispatch notes go to the dashboard for the technician/service advisor to review before the appointment. That's the hub.
5. ~~How do we handle the AI perception problem?~~ **RESOLVED:** We disclose it's AI, but not with a blunt "This is AI." We frame it naturally — "I'm an AI assistant, I can book your appointment right now, and if you need anything else just let me know." The value comes first. Disclosure is warm, not a disclaimer.
6. ~~Do we record calls?~~ **RESOLVED:** Transcribe calls, not record. Disclosure enabled. Call review and quality scoring available via transcript. Recording not needed.
7. ~~Do we build outbound AI calls?~~ **RESOLVED:** No. Not in scope right now. Focus stays on inbound intake.
8. ~~How do we handle "we're busy"?~~ **RESOLVED:** We schedule them when they fit in the schedule. If they agree, great. If they don't, they're free to call elsewhere. No guilt, no retention tactics — just honest availability.
9. ~~Do we add a "ghost prevention" node?~~ **RESOLVED:** No. Do not collect information if they don't want to book. They might be shopping around or just asking questions (RAG). If they aren't satisfied, say thank you and hang up. No pressure.
10. ~~What's our answer to "how much?"~~ **RESOLVED:** This depends on the business. We give customers the ability to change pricing through the RAG. If they ask about diagnostics, the RAG should have pricing there for that. Per-tenant configurable via RAG.

---

## BACKLOG — Low Priority

_Valid ideas worth tracking. Not in current build scope._

### Sister Location Routing

Does the AI check sister location availability before letting a caller go when "we're busy"? Low priority — most shops don't have sister locations. Revisit when we have multi-location tenants.

### Voicemail → Transcribed → Dashboard

Outside business hours or system failures: voicemail gets transcribed, goes to dashboard. Tenant checks it like email. Low priority — AI should ideally handle 24/7 first.

### Post-Booking Text Confirmation + Reminders

Text confirmation after booking, optional 24h reminder, optional 2h reminder. Cuts no-shows significantly. Low priority — get the core booking flow working first.

### Multi-User Role-Based Dashboard

Technician view vs. service advisor view vs. owner view. Mobile-friendly. Low priority — single user dashboard first.

### Scheduling Integration ~~(Low priority)~~

~~Sync with Google Calendar, Outlook, ShopWare, Mitchell 1, FullBay. Low priority — secretary-hq as calendar of record first. Revisit when we have tenants with existing tools.~~
**RESOLVED (backlog item promoted):** secretary-hq has its own calendar as the system of record. We sync with Outlook and other tools both ways. Tenant keeps using their calendar, it stays in sync.

### Test Call / Sandbox for Tenants

Let tenants configure their tree and test it with a simulated call before going live. Low priority — helps onboarding quality but not a blocker.

### Metrics Dashboard

Answer rate, booking rate, completion rate, dispatch note completeness, no-show rate. Low priority — show basic call counts first. Sophisticated metrics when we have volume.

---

## New Open Questions for Dale

11. ~~What is the incomplete call handling policy? (Caller hangs up mid-tree, call drops)~~ **RESOLVED:** Partial data is kept IF the customer info is useful (name, phone, vehicle already captured). If they call back, that info pre-fills. But we do NOT save a half-booked appointment — scratch it. Start clean when they call back.
12. ~~How do we handle after-hours calls? (AI 24/7, or voicemail-to-transcript?)~~ **RESOLVED:** Normal call, 24/7. AI handles everything — info, questions, booking. That's the point. At the end of every after-hours call, remind them of business hours so they don't drive over assuming the business is open just because the AI answered.
13. ~~What does onboarding look like for a new tenant?~~ **RESOLVED:** We have an onboarding wizard. Already exists. The only addition: ability for the tenant to add or remove questions from their decision tree. That's the tree editor piece — tricky but needed.
14. ~~What does the first demo call look like for a prospect?~~ **RESOLVED:** After the onboarding wizard, tenant gets a test phone number for their own business. They can call it as many times as they want. They hear exactly what a real customer would hear. They can tweak the tree, RAG, or settings, then call again to test changes. This is the primary way they refine their voice agent before going live.
15. ~~What metrics do we track from day one?~~ **RESOLVED:** Collect all metrics internally. Only show curated metrics — things that reflect good outcomes and show how secretary-hq makes their business better. Don't show cost of LLM (internal tracking only). Don't show everything. Curate what tells a good story. TODO: Design and build metrics screen, then revisit which metrics to surface.
