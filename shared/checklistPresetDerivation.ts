import { applyChecklistOverrides, type ChecklistOverrides } from './checklistOverrides';

/**
 * Tenant-facing runtime snapshot derived from business_type / checklist_preset_id.
 * Block lists must stay aligned with `agent/src/checklist/presets.ts` — that file
 * is the product catalog (descriptions, forbidden_trees, defaults). This module
 * only materializes the wire shape the backend already ships.
 */
export interface DerivedChecklistRuntimeConfig {
  preset_id: string;
  enabled_conversation_blocks: string[];
  enabled_policy_blocks: string[];
  enabled_knowledge_blocks: string[];
  enabled_outcome_blocks: string[];
  overrides: Record<string, unknown>;
  version: 1;
}

/**
 * Every shipped preset id, as a RUNTIME value and not only a type.
 *
 * The type alone could not be checked against anything outside TypeScript, and
 * the thing it most needed checking against is SQL: `tenants.checklist_preset_id`
 * carries a CHECK constraint enumerating these ids, and it silently fell a
 * preset behind — `owner_for_hire_front_desk` shipped in code on 2026-08-13 and
 * the constraint still listed only the original three, so the ops script that
 * pins it aborts with a constraint violation against prod. A list that exists
 * only as a union type is a list no test can read.
 */
export const CHECKLIST_PRESET_IDS = [
  'auto_shop_front_desk',
  'salon_front_desk',
  'local_service_front_desk',
  'owner_for_hire_front_desk',
  'law_firm_front_desk',
  // The 28 additional vertical front-desk presets added alongside the per-vertical
  // intake trees (agent/src/checklist/verticalIntakeTrees.ts). auto_shop and salon
  // already appear above. `answering_service_front_desk` ships as a reachable
  // catalog entry, but NO business_type resolves to it: 'answering-service' is
  // Thinking Hammer's own business_type and stays mapped to
  // owner_for_hire_front_desk (see the 2026-08-13 regression note below), so the
  // owner-for-hire lane and its `job` tree are preserved.
  'mobile_tire_front_desk',
  'car_detailing_front_desk',
  'body_shop_front_desk',
  'oil_change_front_desk',
  'car_wash_front_desk',
  'barbershop_front_desk',
  'nail_salon_front_desk',
  'spa_front_desk',
  'lash_studio_front_desk',
  'plumber_front_desk',
  'electrician_front_desk',
  'hvac_front_desk',
  'pest_control_front_desk',
  'cleaning_front_desk',
  'landscaping_front_desk',
  'garage_door_front_desk',
  'locksmith_front_desk',
  'personal_trainer_front_desk',
  'yoga_studio_front_desk',
  'tax_prep_front_desk',
  'tutoring_front_desk',
  'photography_front_desk',
  'real_estate_front_desk',
  'insurance_front_desk',
  'answering_service_front_desk',
  'bakery_front_desk',
  'catering_front_desk',
] as const;

export type ChecklistPresetId = (typeof CHECKLIST_PRESET_IDS)[number];

const AUTO_SHOP_RUNTIME: DerivedChecklistRuntimeConfig = {
  preset_id: 'auto_shop_front_desk',
  // auto_shop_intake mirrors AUTO_SHOP_PRESET in agent/src/checklist/presets.ts.
  enabled_conversation_blocks: [
    'identity',
    'auto_shop_intake',
    'booking',
    'message',
    'qa',
    'schedule_change',
  ],
  enabled_policy_blocks: [],
  enabled_knowledge_blocks: [],
  enabled_outcome_blocks: [],
  overrides: {},
  version: 1,
};

const SALON_RUNTIME: DerivedChecklistRuntimeConfig = {
  preset_id: 'salon_front_desk',
  // salon_intake mirrors SALON_PRESET in agent/src/checklist/presets.ts.
  enabled_conversation_blocks: [
    'identity',
    'salon_intake',
    'booking',
    'message',
    'qa',
    'schedule_change',
  ],
  enabled_policy_blocks: [],
  enabled_knowledge_blocks: [],
  enabled_outcome_blocks: [],
  overrides: {},
  version: 1,
};

const LOCAL_SERVICE_RUNTIME: DerivedChecklistRuntimeConfig = {
  preset_id: 'local_service_front_desk',
  enabled_conversation_blocks: [
    'identity',
    'booking',
    'message',
    'generic_subject',
    'qa',
    'buy_service',
    'schedule_change',
  ],
  enabled_policy_blocks: [],
  enabled_knowledge_blocks: [],
  enabled_outcome_blocks: [],
  overrides: {},
  version: 1,
};

// Mirrors OWNER_FOR_HIRE_PRESET in agent/src/checklist/presets.ts — see that
// file for why `job` is enabled here and forbidden on the shop/salon presets.
const OWNER_FOR_HIRE_RUNTIME: DerivedChecklistRuntimeConfig = {
  preset_id: 'owner_for_hire_front_desk',
  enabled_conversation_blocks: [
    'identity',
    'booking',
    'message',
    'generic_subject',
    'qa',
    'job',
    'buy_service',
    'schedule_change',
  ],
  enabled_policy_blocks: [],
  enabled_knowledge_blocks: [],
  enabled_outcome_blocks: [],
  overrides: {},
  version: 1,
};

// Mirrors LAW_FIRM_PRESET in agent/src/checklist/presets.ts. `case_intake` is
// the reason this preset exists: it is the only one whose primary intake ends
// in a human take-or-decline decision rather than a booking, so the tree must
// be enabled here or a law-firm tenant cannot capture a matter at all.
const LAW_FIRM_RUNTIME: DerivedChecklistRuntimeConfig = {
  preset_id: 'law_firm_front_desk',
  enabled_conversation_blocks: [
    'identity',
    'booking',
    'message',
    'generic_subject',
    'qa',
    'case_intake',
    'schedule_change',
  ],
  enabled_policy_blocks: [],
  enabled_knowledge_blocks: [],
  enabled_outcome_blocks: [],
  overrides: {},
  version: 1,
};

/**
 * The 30 per-vertical intake verticals, in canonical order. Each ships a
 * front-desk preset whose blocks are `identity + <slug>_intake + booking +
 * message + qa + schedule_change` — the shared front-desk set with the
 * vertical's own intake tree wired in right after identity. auto_shop and salon
 * are defined explicitly above (they predate this batch); the rest are derived
 * from this list so the runtime mirror cannot drift from the block shape.
 *
 * Kept as data, not 28 more hand-written literals, for the same reason
 * CHECKLIST_PRESET_IDS is a runtime value: a per-vertical config that exists
 * only implicitly is one a test cannot read.
 */
const VERTICAL_INTAKE_SLUGS = [
  'auto_shop',
  'mobile_tire',
  'car_detailing',
  'body_shop',
  'oil_change',
  'car_wash',
  'salon',
  'barbershop',
  'nail_salon',
  'spa',
  'lash_studio',
  'plumber',
  'electrician',
  'hvac',
  'pest_control',
  'cleaning',
  'landscaping',
  'garage_door',
  'locksmith',
  'personal_trainer',
  'yoga_studio',
  'tax_prep',
  'tutoring',
  'photography',
  'real_estate',
  'insurance',
  'answering_service',
  'bakery',
  'catering',
] as const;

function intakeRuntime(slug: string): DerivedChecklistRuntimeConfig {
  return {
    preset_id: `${slug}_front_desk`,
    enabled_conversation_blocks: [
      'identity',
      `${slug}_intake`,
      'booking',
      'message',
      'qa',
      'schedule_change',
    ],
    enabled_policy_blocks: [],
    enabled_knowledge_blocks: [],
    enabled_outcome_blocks: [],
    overrides: {},
    version: 1,
  };
}

/**
 * Every preset id → its runtime config. The five hand-written presets keep their
 * explicit literals (auto_shop and salon are the intake-bearing versions above);
 * the 28 vertical presets are generated from VERTICAL_INTAKE_SLUGS.
 */
const RUNTIME_BY_PRESET: Record<ChecklistPresetId, DerivedChecklistRuntimeConfig> = (() => {
  const map = {
    auto_shop_front_desk: AUTO_SHOP_RUNTIME,
    salon_front_desk: SALON_RUNTIME,
    local_service_front_desk: LOCAL_SERVICE_RUNTIME,
    owner_for_hire_front_desk: OWNER_FOR_HIRE_RUNTIME,
    law_firm_front_desk: LAW_FIRM_RUNTIME,
  } as Record<ChecklistPresetId, DerivedChecklistRuntimeConfig>;
  for (const slug of VERTICAL_INTAKE_SLUGS) {
    const presetId = `${slug}_front_desk` as ChecklistPresetId;
    if (!map[presetId]) map[presetId] = intakeRuntime(slug);
  }
  return map;
})();

/**
 * business_type (normalized, hyphenated) → preset id, for the vertical presets.
 *
 * `answering_service` is DELIBERATELY excluded: 'answering-service' is Thinking
 * Hammer's own business_type and stays mapped to owner_for_hire_front_desk (see
 * defaultChecklistPresetIdForBusinessType and the 2026-08-13 regression). Its
 * preset/tree still ship and are reachable via the catalog — just not selected
 * by this business_type default.
 */
const PRESET_BY_BUSINESS_TYPE: Record<string, ChecklistPresetId> = (() => {
  const map: Record<string, ChecklistPresetId> = {};
  for (const slug of VERTICAL_INTAKE_SLUGS) {
    if (slug === 'answering_service') continue;
    map[slug.replace(/_/g, '-')] = `${slug}_front_desk` as ChecklistPresetId;
  }
  return map;
})();

function normalizeBusinessType(businessType: string | null | undefined): string {
  return (businessType ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

function normalizeChecklistPresetId(presetId: string | null | undefined): ChecklistPresetId | null {
  const normalized = (presetId ?? '').trim().toLowerCase();
  // Driven off CHECKLIST_PRESET_IDS rather than a hand-maintained if-ladder: the
  // ladder is where a new preset gets forgotten, and a forgotten id here does not
  // error — it returns null and falls back to the business_type default, which is
  // exactly the silent no-op that made the job-tree outage invisible.
  return (CHECKLIST_PRESET_IDS as readonly string[]).includes(normalized)
    ? (normalized as ChecklistPresetId)
    : null;
}

export function defaultChecklistPresetIdForBusinessType(
  businessType: string | null | undefined
): ChecklistPresetId {
  const normalized = normalizeBusinessType(businessType);
  // 'answering-service' is Thinking Hammer's own business_type and it fell
  // through to local_service — the preset with no `job` tree — which is how two
  // recruiter calls on a line advertising the owner for hire produced zero
  // job_inquiries rows (2026-08-13, CALL1.md/CALL2.md). A business whose
  // business_type says it answers the phone FOR the owner is the owner-for-hire
  // vertical; the default now says so instead of leaving it to a preset id
  // nobody had set.
  // A law firm routed to local_service would get no case_intake tree — the same
  // shape of outage as the job tree in 2026-08-13, and worse in consequence: a
  // prospective client's matter would be taken as a plain message with none of
  // the facts (statute date, jurisdiction, existing counsel, opposing names)
  // that decide whether the firm can act. Every spelling an owner might type.
  if (
    normalized === 'law-firm' ||
    normalized === 'law-office' ||
    normalized === 'lawyer' ||
    normalized === 'attorney' ||
    normalized === 'legal' ||
    normalized === 'legal-services'
  ) {
    return 'law_firm_front_desk';
  }
  if (normalized === 'owner-for-hire' || normalized === 'answering-service') {
    return 'owner_for_hire_front_desk';
  }
  // The 29 remaining vertical presets (all intake verticals except
  // answering_service, which is handled above). Checked AFTER the law-firm and
  // owner-for-hire lanes so those keep precedence.
  const verticalPreset = PRESET_BY_BUSINESS_TYPE[normalized];
  if (verticalPreset) return verticalPreset;
  return 'local_service_front_desk';
}

/**
 * The VERTICAL a business_type belongs to — the key question_tree_templates is
 * partitioned by, and therefore what provisioning copies from.
 *
 * Derived from the preset rather than kept as a second mapping: a business_type
 * that resolves to the law-firm preset must get the law-firm questions, and two
 * independent lookups would eventually disagree about which. One source, one
 * answer.
 */
export function verticalForBusinessType(businessType: string | null | undefined): string {
  // The vertical is the preset id minus its `_front_desk` suffix — one derivation
  // that stays correct for all 33 presets (auto_shop, salon, owner_for_hire,
  // law_firm, local_service, and every intake vertical) without a per-id ladder
  // that a new preset could be forgotten from.
  const presetId = defaultChecklistPresetIdForBusinessType(businessType);
  return presetId.replace(/_front_desk$/, '');
}

export function resolveChecklistPresetId(
  businessType: string | null | undefined,
  presetId: string | null | undefined
): ChecklistPresetId {
  return (
    normalizeChecklistPresetId(presetId) ?? defaultChecklistPresetIdForBusinessType(businessType)
  );
}

export function deriveChecklistRuntimeConfig(
  businessType: string | null | undefined,
  presetId?: string | null,
  overrides?: ChecklistOverrides | null
): DerivedChecklistRuntimeConfig {
  const resolvedPresetId = resolveChecklistPresetId(businessType, presetId);
  // One lookup over every shipped preset, falling back to local_service for the
  // impossible case of an id with no runtime (resolveChecklistPresetId only ever
  // returns a CHECKLIST_PRESET_IDS member, so the fallback is belt-and-braces).
  const base = RUNTIME_BY_PRESET[resolvedPresetId] ?? LOCAL_SERVICE_RUNTIME;
  const applied = applyChecklistOverrides(base, overrides);
  return applied.ok ? applied.config : { ...base };
}
