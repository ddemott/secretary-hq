/**
 * STARTER SERVICES — the 2–4 bookable slot types a new business begins with.
 *
 * WHAT THIS IS NOT: the intake question trees. Two different things, both live:
 *   - A SERVICE is a bookable calendar slot type. `book_with_scheduling` →
 *     `resolveServiceForBooking` picks one, and the appointment records it.
 *   - An INTAKE TREE is the set of questions a call asks (symptom, event
 *     details). `ChecklistAgent` walks it. See agent/src/checklist/.
 * Seeding services does not replace intake, and intake does not book anything.
 *
 * WHY THIS FILE EXISTS
 * `business_templates.example_services` is what the setup wizard pre-fills
 * Step 1 from. On 2026-09-01 it was EMPTY for all 31 live business types, so a
 * new owner was asked "What service do you offer?" against a blank list. Three
 * separate layers had to be wrong at once for that to happen, and fixing only
 * one of them puts it straight back:
 *   1. supabase/seed.sql INSERTs '{}' for the column.
 *   2. supabase/baseline.sql is schema-only (no COPY business_templates), and
 *      scripts/rebuild-db.sh is baseline + seed with NO migrations — so the
 *      migration that populated examples never runs on a rebuild.
 *   3. That migration (20260317000004) covered 20 business types, three of them
 *      the since-deleted HIPAA verticals, and missed 11 of the 31 live ones.
 *
 * So the content is authored HERE, once, in TypeScript, and the SQL is
 * GENERATED from it (scripts/generate-starter-services-sql.ts) into both the
 * migration and seed.sql. Hand-writing the same list in three places is the
 * drift that caused this bug; this repo has been bitten by parallel lists twice
 * already (business_templates vs the preset catalog; the tree library vs the
 * preset). A test asserts the generated SQL on disk still matches this file.
 *
 * ── THE TWO SHAPES ──────────────────────────────────────────────────────────
 *
 * SKU — the caller can name it and the shop can slot it: "Oil Change",
 * "Haircut", "Manicure". The caller already knows what they want.
 *
 * LOOK-FIRST — the caller CANNOT name the work, because nobody knows it yet:
 * "there's a noise", "the light came on", "water is coming from somewhere".
 * The bookable thing is the VISIT, not the unknown fix — "Diagnostic visit",
 * "Service call", "Event consult". Booking a look-first row is honest; booking
 * "Brake Service" off "there's a noise" is a guess with a calendar slot on it.
 *
 * Look-first rows MUST carry a description. `resolveServiceForBooking`'s
 * semantic step embeds `concat_ws('. ', name, subtitle, description)`, and
 * "Diagnostic visit" alone gives "my check engine light is on" almost nothing
 * to match. The description is what does the retrieval work — nothing in the
 * NAME would ever pull a warning light onto a diagnostic.
 *
 * ── THE DEFAULT ─────────────────────────────────────────────────────────────
 *
 * Exactly one row per vertical is `is_default`. It becomes the tenant's
 * `default_service_id` — the FALLTHROUGH `resolveServiceForBooking` books when
 * the caller's words match nothing. Policy:
 *   - repair-heavy (auto-shop, plumber, HVAC, electrician, …) → the LOOK-FIRST
 *     row, because the caller who cannot say what they need is exactly the
 *     caller who falls through.
 *   - specialty SKU (oil-change, nail-salon, car-wash, …) → the main SKU.
 *
 * This is set EXPLICITLY and must stay that way. Both seed.sql and migration
 * 20260630000000 pick the default as "duration closest to 30 minutes, tie-broken
 * by name ASC" — and because the wizard hardcodes every starter to 30 minutes,
 * that tie-break is the ONLY term that ever runs. The default was therefore
 * whichever starter sorted first alphabetically. A plumber seeded
 * "Drain cleaning, Service call" would silently make *Drain cleaning* the
 * fallthrough: every caller who couldn't name their problem gets booked for a
 * drain. That is the wrong-booking failure this file exists to prevent.
 *
 * ── DURATION HONESTY, AND WHERE IT BENDS ────────────────────────────────────
 *
 * `useWizardCrud.seedServices` hardcodes `duration_minutes: 30`. So a starter
 * has to be defensible as a ~30-minute unit. That rules out seeding the long
 * job as the day-one row and is a large part of why look-first rows win in the
 * trades: a "Service call" IS about half an hour, a repair is not.
 *
 * Three rows knowingly bend it, kept because they are what callers actually say
 * and an owner edits Step 1 anyway: salon "Color", cleaning "One-time clean",
 * and yoga "Private session". They are flagged `duration_caveat` so the next
 * person changes the duration system rather than rediscovering the tension.
 *
 * ── NEVER SEED ──────────────────────────────────────────────────────────────
 * HIPAA verticals (permanently excluded) · the event itself ("Wedding
 * Reception" is not a 30-minute slot, it is the job) · memberships · "Emergency
 * fix" as a normal SKU (urgency is a property of a call, not a catalog row —
 * and the agent cannot transfer, so promising an emergency slot oversells) ·
 * "Message Taking" as a service (taking a message is a TOOL, not a booking) ·
 * resource names ("Bay 1" is a resource — see STARTER_RESOURCE_COUNT).
 */

export interface StarterService {
  /** Caller language, not a shop-writer bucket. "Brakes" / "Basic Service" are not names. */
  name: string;
  /**
   * One line, written for retrieval. REQUIRED on look-first rows: it is what an
   * embedding of "my check engine light is on" actually matches against.
   */
  description?: string;
  /** True when the row books a VISIT to find out, not a named piece of work. */
  look_first?: boolean;
  /** Exactly one per vertical. Becomes tenants.default_service_id. */
  is_default?: boolean;
  /** Marks a row that is not really ~30 minutes; see the header. */
  duration_caveat?: true;
}

/** business_type → its 2–4 starters. Keys must be live `business_templates` rows. */
export const STARTER_SERVICES: Record<string, StarterService[]> = {
  // ── Auto & Vehicle ────────────────────────────────────────────────────────
  // Repair-heavy: the caller says "it's making a noise", never "I need a
  // control-arm bushing". Diagnostic visit is the default for exactly that.
  'auto-shop': [
    {
      name: 'Diagnostic visit',
      description:
        'Look at a noise, a warning light, a leak, or anything that feels wrong, and say what the repair will take.',
      look_first: true,
      is_default: true,
    },
    { name: 'Oil Change' },
    { name: 'Tire Rotation' },
  ],
  // Collision callers ring for a PRICE before anything else, so the estimate is
  // the front door and the default.
  'body-shop': [
    {
      name: 'Damage estimate',
      description:
        'Look at collision, dent, or scrape damage and quote what the repair costs and how long it takes.',
      look_first: true,
      is_default: true,
    },
    { name: 'Dent repair' },
    { name: 'Paint touch-up' },
  ],
  // DEVIATION from a plain SKU list: a full detail is a half-day, so seeding it
  // as a 30-minute row would be a lie on the calendar. The consult is the honest
  // ~30-minute front door and the express clean is a real short SKU.
  'car-detailing': [
    {
      name: 'Detail consultation',
      description: 'Look at the vehicle and recommend the right detail package for its condition.',
      look_first: true,
      is_default: true,
    },
    { name: 'Express interior clean' },
  ],
  // Express work is named and short — no look-first row (work order rule).
  'car-wash': [{ name: 'Express wash', is_default: true }, { name: 'Hand wash' }],
  // A mobile tire caller almost always CAN name it ("I have a flat").
  'mobile-tire': [
    { name: 'Flat repair', is_default: true },
    { name: 'Tire replacement' },
    { name: 'Tire rotation' },
  ],
  // Specialty SKU shop → default is the main SKU, per policy.
  'oil-change': [{ name: 'Oil Change', is_default: true }, { name: 'Tire Rotation' }],

  // ── Beauty & Personal Care ────────────────────────────────────────────────
  barbershop: [
    { name: 'Haircut', is_default: true },
    { name: 'Beard trim' },
    { name: 'Haircut & beard' },
  ],
  // DEVIATION: a new full set is ~2 hours, so it is not a day-one 30-minute row.
  // The fill is the frequent, genuinely short booking.
  'lash-studio': [
    { name: 'Lash fill', is_default: true },
    {
      name: 'Lash consultation',
      description: 'Look at the natural lashes and recommend the right set and length.',
      look_first: true,
    },
  ],
  // med-spa removed 2026-09-25: a medical spa performs medical procedures and
  // holds health information — HIPAA territory, permanently excluded.
  'nail-salon': [
    { name: 'Manicure', is_default: true },
    { name: 'Pedicure' },
    { name: 'Gel manicure' },
  ],
  salon: [
    { name: 'Haircut', is_default: true },
    // Colour is what callers ask for by name; it is also 2+ hours. Kept for the
    // language, flagged for the duration system.
    { name: 'Color', duration_caveat: true },
    {
      name: 'New-client consult',
      description:
        'Talk through what a new client wants before booking the right service and the right amount of time.',
      look_first: true,
    },
  ],
  spa: [{ name: 'Massage', is_default: true }, { name: 'Facial' }],

  // ── Fitness & Wellness ────────────────────────────────────────────────────
  'personal-trainer': [
    { name: 'Personal training session', is_default: true },
    {
      name: 'Intro consultation',
      description: 'Talk through goals and current fitness before recommending a training plan.',
      look_first: true,
    },
  ],
  'yoga-studio': [
    { name: 'Class drop-in', is_default: true },
    { name: 'Private session', duration_caveat: true },
  ],

  // ── Food & Beverage ───────────────────────────────────────────────────────
  // Never the event itself. A bakery books the CONVERSATION about the cake.
  bakery: [
    {
      name: 'Custom order consult',
      description:
        'Talk through a custom cake or large order — the date, the size, the flavours, and what it will cost.',
      look_first: true,
      is_default: true,
    },
    { name: 'Cake tasting' },
  ],
  // "Wedding Reception" is the JOB, not a bookable 30-minute slot. The consult is.
  catering: [
    {
      name: 'Event consult',
      description:
        'Talk through the event — the date, the headcount, the venue, and the kind of meal — before quoting.',
      look_first: true,
      is_default: true,
    },
    { name: 'Tasting' },
  ],

  // ── Home Services ─────────────────────────────────────────────────────────
  // Repair-heavy across the board: default is the look-first visit, and there is
  // deliberately NO "Emergency fix" SKU anywhere here.
  cleaning: [
    {
      name: 'Walkthrough estimate',
      description:
        'Walk the home or office, see the size and condition, and quote the right clean and how long it takes.',
      look_first: true,
      is_default: true,
    },
    { name: 'One-time clean', duration_caveat: true },
  ],
  electrician: [
    {
      name: 'Service call',
      description:
        'Come out, find the electrical problem — a dead outlet, a tripping breaker, flickering lights — and say what the fix takes.',
      look_first: true,
      is_default: true,
    },
    { name: 'Outlet or switch install' },
    { name: 'Lighting install' },
  ],
  'garage-door': [
    {
      name: 'Service call',
      description:
        "Come out, find why the door won't open, close, or is making noise, and say what the fix takes.",
      look_first: true,
      is_default: true,
    },
    { name: 'Spring replacement' },
    { name: 'Opener install' },
  ],
  hvac: [
    {
      name: 'Service call',
      description:
        "Come out, find why the heat or air conditioning isn't working right, and say what the fix takes.",
      look_first: true,
      is_default: true,
    },
    { name: 'Tune-up' },
    { name: 'Thermostat install' },
  ],
  landscaping: [
    {
      name: 'Walkthrough estimate',
      description: 'Walk the property, see the work, and quote it.',
      look_first: true,
      is_default: true,
    },
    { name: 'Lawn mowing' },
  ],
  locksmith: [
    {
      name: 'Service call',
      description:
        'Come out, look at the lock, key, or door, and say what it takes to get it working.',
      look_first: true,
      is_default: true,
    },
    { name: 'Lockout' },
    { name: 'Rekey' },
  ],
  'pest-control': [
    {
      name: 'Inspection visit',
      description:
        'Come out, identify the pest and how far it has spread, and say what treatment it needs.',
      look_first: true,
      is_default: true,
    },
    { name: 'Treatment visit' },
  ],
  plumber: [
    {
      name: 'Service call',
      description: 'Come out, find the leak, blockage, or drip, and say what the fix takes.',
      look_first: true,
      is_default: true,
    },
    { name: 'Drain cleaning' },
  ],

  // ── Professional Services ─────────────────────────────────────────────────
  // NOT "Message Taking" — taking a message is a tool the agent already has, not
  // something a caller books a slot for.
  'answering-service': [{ name: 'Phone consultation', is_default: true }, { name: 'Meeting' }],
  insurance: [{ name: 'Insurance quote', is_default: true }, { name: 'Policy review' }],
  // The consultation leads, and the case_intake TREE — not a service row — is
  // what collects the matter; the firm decides whether to take it. The status
  // call is the other real inbound: an EXISTING client ringing to ask where
  // their matter has got to. It presumes nothing about whether the firm took a
  // new case, which is why it is safe to seed on day one.
  'law-firm': [
    {
      name: 'Consultation',
      description:
        'Talk through the situation, what happened and when, and whether the firm can take it on.',
      look_first: true,
      is_default: true,
    },
    { name: 'Case status call' },
  ],
  photography: [
    {
      name: 'Session consultation',
      description:
        'Talk through the shoot — what it is for, where, how many people, and how long it needs.',
      look_first: true,
      is_default: true,
    },
    { name: 'Headshot session' },
  ],
  // A showing is the main SKU and a real ~30-minute unit, so it is the default
  // even though this vertical also has a look-first row.
  'real-estate': [
    { name: 'Showing', is_default: true },
    {
      name: 'Buyer consult',
      description:
        'Talk through what the buyer is looking for, their budget, and their timeline before showing homes.',
      look_first: true,
    },
  ],
  'tax-prep': [
    {
      name: 'Tax consultation',
      description:
        'Talk through the return — what changed this year, which documents are needed, and what it will cost.',
      look_first: true,
      is_default: true,
    },
    { name: 'Individual return drop-off' },
  ],
  tutoring: [
    {
      name: 'Intro session',
      description: 'Meet the student, find where they are stuck, and set a plan for the subject.',
      look_first: true,
      is_default: true,
    },
    { name: 'Tutoring session' },
  ],
};

/**
 * How many example RESOURCES to generate per vertical, named from the
 * template's own `resource_label` ("Bay 1", "Bay 2" / "Van 1", "Van 2").
 *
 * Resources are kept deliberately separate from services and are SHAPE ONLY.
 * Mixing them is a real failure mode, not a tidiness point: "Bay 1" seeded as a
 * SERVICE becomes a bookable slot type the agent can offer a caller, so someone
 * rings up and gets booked for "Bay 1" instead of an oil change.
 */
export const STARTER_RESOURCE_COUNT = 2;

/** The starter marked `is_default` for a vertical, or null if it has none. */
export function defaultStarterFor(businessType: string): StarterService | null {
  return STARTER_SERVICES[businessType]?.find((s) => s.is_default) ?? null;
}

/** Example resource names for a vertical, derived from its `resource_label`. */
export function starterResourcesFor(resourceLabel: string): string[] {
  const label = resourceLabel.trim() || 'Resource';
  return Array.from({ length: STARTER_RESOURCE_COUNT }, (_, i) => `${label} ${i + 1}`);
}
