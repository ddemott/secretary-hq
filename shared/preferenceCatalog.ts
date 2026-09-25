/**
 * What counts as a caller PREFERENCE, per business type (owner decision
 * 2026-09-25).
 *
 * Before this the agent invented its own keys ("stylist", "preferred_stylist",
 * "fav_stylist" …) so the same fact landed under a different name on every call
 * and nothing could show or rely on it. Now the key is chosen from this list:
 * UNIVERSAL applies to every business, and each vertical adds its own. The
 * vertical comes from shared/checklistPresetDerivation.ts
 * verticalForBusinessType(), the same mapping that picks the call's question
 * trees, so a salon gets salon preferences and an auto shop gets vehicle ones.
 *
 * Pure data, no framework deps: read by the backend (delivered to the agent as
 * preference_catalog on /agent-tools/tenant-config) and available to the
 * dashboard for labels.
 *
 * Deliberately NOT here: anything medical (HIPAA verticals are excluded from
 * the platform, and med_spa lists appearance preferences only), payment
 * details, or anything a caller would not expect a front desk to remember.
 */

export interface PreferenceType {
  /** Stable snake_case key — the customer_preferences.pref_key stored. */
  key: string;
  /** Human label for the dashboard ("Preferred stylist"). */
  label: string;
  /** One line for the model: what to listen for. */
  hint: string;
}

/** Free-text catch-all: a lasting preference that fits no listed key. */
export const NOTES_PREFERENCE: PreferenceType = {
  key: 'notes',
  label: 'Other notes',
  hint: 'A lasting preference or standing request that fits none of the other keys.',
};

/** Every business, every call. */
export const UNIVERSAL_PREFERENCES: readonly PreferenceType[] = [
  {
    key: 'preferred_staff',
    label: 'Preferred staff member',
    hint: 'A person they want to work with ("I always see Maria").',
  },
  {
    key: 'preferred_days',
    label: 'Preferred days',
    hint: 'Days that suit them ("weekends only", "never Mondays").',
  },
  {
    key: 'preferred_time_of_day',
    label: 'Preferred time of day',
    hint: 'Mornings, afternoons, evenings, "after 5", "before work".',
  },
  {
    key: 'contact_method',
    label: 'How to reach them',
    hint: 'Call, text or email, and at which number or address if they say.',
  },
  {
    key: 'language',
    label: 'Language',
    hint: 'A language they prefer to be spoken to in.',
  },
  NOTES_PREFERENCE,
];

const pt = (key: string, label: string, hint: string): PreferenceType => ({ key, label, hint });

const VEHICLE = pt('vehicle', 'Vehicle', 'Year, make and model (and trim or color if they say).');
const WAIT_OR_DROP_OFF = pt(
  'wait_or_drop_off',
  'Wait or drop off',
  'Whether they wait on site or drop the vehicle off.'
);
const PROPERTY_ACCESS = pt(
  'property_access',
  'Property access',
  'Gate codes, where the key is, parking, "call when you arrive".'
);
const PETS = pt('pets', 'Pets on site', 'Pets at the property the crew should know about.');
const USUAL_SERVICE = (hint: string): PreferenceType => pt('usual_service', 'Usual service', hint);

/**
 * Per-vertical preferences, keyed by the vertical id (preset id without
 * `_front_desk`). Every id in CHECKLIST_PRESET_IDS has an entry —
 * tests/shared/preferenceCatalog.test.ts fails CI on a missing one.
 */
export const VERTICAL_PREFERENCES: Readonly<Record<string, readonly PreferenceType[]>> = {
  // ── Automotive ────────────────────────────────────────────────────────────
  auto_shop: [
    VEHICLE,
    WAIT_OR_DROP_OFF,
    pt('needs_loaner_or_shuttle', 'Loaner or shuttle', 'Needs a loaner car or a ride.'),
    pt('parts_preference', 'Parts preference', 'OEM vs aftermarket, a brand they want.'),
    pt('approval_threshold', 'Approval before work', 'Call before any work over a set amount.'),
  ],
  mobile_tire: [
    VEHICLE,
    pt('tire_brand', 'Tire brand', 'A brand or model they want.'),
    pt('tire_size', 'Tire size', 'Their tire size if they give it.'),
    pt('service_location', 'Where to meet', 'Home, work, a parking lot — where the van comes.'),
  ],
  car_detailing: [
    VEHICLE,
    USUAL_SERVICE('Interior, exterior, full detail, ceramic coating.'),
    pt('service_location', 'Where to detail', 'At their home or work, or they bring it in.'),
    pt('product_preference', 'Product preference', 'Scent-free, a wax or product they like.'),
  ],
  body_shop: [
    VEHICLE,
    pt('insurance_carrier', 'Insurance carrier', 'Who their auto insurance is with.'),
    pt('needs_rental', 'Needs a rental', 'Wants a rental car while it is in the shop.'),
    pt('parts_preference', 'Parts preference', 'OEM vs aftermarket.'),
  ],
  oil_change: [
    VEHICLE,
    pt('oil_type', 'Oil type', 'Synthetic, blend, conventional, a weight they ask for.'),
    WAIT_OR_DROP_OFF,
  ],
  car_wash: [
    VEHICLE,
    pt('wash_package', 'Wash package', 'The package or add-ons they usually get.'),
    pt('membership_interest', 'Membership', 'Interest in, or an existing, wash membership.'),
  ],

  // ── Beauty & personal care ────────────────────────────────────────────────
  salon: [
    USUAL_SERVICE('Cut, color, balayage, blowout, treatment.'),
    pt('color_formula_notes', 'Color notes', 'Shade, formula or color history they mention.'),
    pt('product_sensitivities', 'Product sensitivities', 'Products or scents that bother them.'),
    pt('style_notes', 'Style notes', 'Length, look, or how they like it finished.'),
  ],
  barbershop: [
    USUAL_SERVICE('Cut, fade, beard trim, shave, lineup.'),
    pt('cut_style', 'Cut style', 'Guard number, length, the style they ask for.'),
    pt('beard_preference', 'Beard', 'How they keep their beard.'),
  ],
  nail_salon: [
    USUAL_SERVICE('Manicure, pedicure, gel, acrylic, dip.'),
    pt('nail_shape_length', 'Shape and length', 'Almond, square, short, long.'),
    pt('polish_preference', 'Polish', 'Colors or finishes they like.'),
    pt('product_sensitivities', 'Product sensitivities', 'Products that bother them.'),
  ],
  spa: [
    USUAL_SERVICE('Massage type, facial, package.'),
    pt('pressure_preference', 'Pressure', 'Light, medium, firm, deep.'),
    pt('therapist_gender', 'Therapist preference', 'A preference for a male or female therapist.'),
    pt('product_sensitivities', 'Product sensitivities', 'Oils, scents or products to avoid.'),
  ],
  med_spa: [
    // Appearance preferences only — no medical history, conditions or treatment
    // plans (HIPAA verticals are excluded from the platform).
    USUAL_SERVICE('The service they come in for.'),
    pt('provider_preference', 'Provider', 'A provider they want to see.'),
    pt('product_sensitivities', 'Product sensitivities', 'Products or scents to avoid.'),
  ],
  lash_studio: [
    pt('lash_style', 'Lash style', 'Classic, hybrid, volume, a look they want.'),
    pt('lash_length_curl', 'Length and curl', 'Lengths or curl they like.'),
    pt('fill_frequency', 'Fill frequency', 'How often they come in for fills.'),
    pt('product_sensitivities', 'Product sensitivities', 'Adhesives or products that bother them.'),
  ],

  // ── Home services & trades ────────────────────────────────────────────────
  plumber: [
    PROPERTY_ACCESS,
    PETS,
    pt('property_type', 'Property type', 'House, condo, rental, business.'),
    pt('equipment_notes', 'Equipment', 'Water heater, fixtures, anything they mention about it.'),
  ],
  electrician: [
    PROPERTY_ACCESS,
    PETS,
    pt('property_type', 'Property type', 'House, condo, rental, business.'),
    pt('panel_notes', 'Panel and wiring', 'Panel location or wiring details they mention.'),
  ],
  hvac: [
    PROPERTY_ACCESS,
    PETS,
    pt('system_details', 'System details', 'Furnace/AC make, age, filter size.'),
    pt('maintenance_plan', 'Maintenance plan', 'On, or interested in, a tune-up plan.'),
  ],
  pest_control: [
    PROPERTY_ACCESS,
    PETS,
    pt('treatment_preference', 'Treatment preference', 'Pet-safe, eco, no indoor spraying.'),
    pt('service_frequency', 'Service frequency', 'Monthly, quarterly, one-time.'),
  ],
  cleaning: [
    PROPERTY_ACCESS,
    PETS,
    pt('cleaning_frequency', 'Cleaning frequency', 'Weekly, every two weeks, monthly.'),
    pt('supply_preference', 'Supplies', 'Eco or scent-free products, or they supply their own.'),
    pt('focus_areas', 'Focus areas', 'Rooms or tasks they always want done.'),
  ],
  landscaping: [
    PROPERTY_ACCESS,
    PETS,
    pt('service_frequency', 'Service frequency', 'Weekly, every two weeks, seasonal.'),
    pt('yard_notes', 'Yard notes', 'Beds to avoid, height to cut, what matters to them.'),
  ],
  garage_door: [
    PROPERTY_ACCESS,
    pt('door_opener_details', 'Door and opener', 'Brand or model of the door or opener.'),
  ],
  locksmith: [
    pt('property_type', 'Property type', 'Home, business, vehicle.'),
    pt('lock_brand', 'Lock brand', 'A brand or system they use or want.'),
  ],
  local_service: [PROPERTY_ACCESS, PETS],

  // ── Fitness ───────────────────────────────────────────────────────────────
  personal_trainer: [
    pt('training_goals', 'Goals', 'Strength, weight loss, a race, mobility.'),
    pt('session_format', 'Session format', 'In person, online, at home, at the gym.'),
    pt('session_length', 'Session length', '30, 45 or 60 minutes.'),
  ],
  yoga_studio: [
    pt('class_types', 'Class types', 'Styles they like (vinyasa, yin, hot).'),
    pt('experience_level', 'Experience level', 'Beginner, intermediate, advanced.'),
    pt('membership_interest', 'Membership', 'Drop-in, class pack or membership.'),
  ],

  // ── Professional services ────────────────────────────────────────────────
  law_firm: [
    // Contact preferences only — never case facts; those belong in the intake,
    // not a profile that is read back on every future call.
    pt('best_time_to_call', 'Best time to call', 'When it is safe and convenient to reach them.'),
    pt('safe_to_leave_message', 'OK to leave a message', 'Whether a voicemail is OK.'),
  ],
  tax_prep: [
    pt('filing_type', 'Filing type', 'Individual, joint, business.'),
    pt('meeting_format', 'Meeting format', 'In person, phone, video, drop-off.'),
  ],
  insurance: [
    pt('coverage_interest', 'Coverage interest', 'Auto, home, life, business.'),
    pt('meeting_format', 'Meeting format', 'In person, phone, video.'),
  ],
  real_estate: [
    pt('buying_or_selling', 'Buying or selling', 'Buying, selling, renting.'),
    pt('preferred_area', 'Preferred area', 'Neighborhoods or towns they want.'),
    pt('price_range', 'Price range', 'A budget or price range they give.'),
    pt('home_type', 'Home type', 'House, condo, townhome, bedrooms.'),
  ],
  tutoring: [
    pt('subjects', 'Subjects', 'Subjects or tests they want help with.'),
    pt('student_grade_level', 'Grade level', 'The student’s grade or level.'),
    pt('session_format', 'Session format', 'In person or online.'),
  ],
  photography: [
    pt('shoot_type', 'Shoot type', 'Portraits, family, events, headshots.'),
    pt('style_preference', 'Style', 'Bright, moody, candid, posed.'),
    pt('shoot_location', 'Location', 'Studio, outdoors, a place they have in mind.'),
  ],
  owner_for_hire: [
    pt('engagement_type', 'Engagement type', 'Contract, full-time, project.'),
    pt('meeting_format', 'Meeting format', 'Phone, video, in person.'),
  ],
  answering_service: [pt('meeting_format', 'Meeting format', 'Phone, video, in person.')],

  // ── Food ──────────────────────────────────────────────────────────────────
  bakery: [
    pt('usual_order', 'Usual order', 'What they usually order.'),
    pt('dietary_preferences', 'Dietary preferences', 'Gluten-free, vegan, nut-free.'),
    pt('pickup_or_delivery', 'Pickup or delivery', 'How they get their order.'),
  ],
  catering: [
    pt('dietary_preferences', 'Dietary preferences', 'Vegetarian, vegan, gluten-free, allergies.'),
    pt('typical_party_size', 'Typical party size', 'How many people they usually feed.'),
    pt('service_style', 'Service style', 'Buffet, plated, drop-off.'),
  ],
};

/**
 * Every preference type for a vertical: its own list first, then the
 * universal ones, de-duplicated by key (a vertical's own definition wins).
 * An unknown vertical gets the universal list — never an empty one.
 */
export function preferencesForVertical(vertical: string | null | undefined): PreferenceType[] {
  const own = (vertical && VERTICAL_PREFERENCES[vertical]) || [];
  const seen = new Set<string>();
  const out: PreferenceType[] = [];
  for (const p of [...own, ...UNIVERSAL_PREFERENCES]) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    out.push(p);
  }
  return out;
}
