import {
  deriveChecklistRuntimeConfig,
  type ChecklistPresetId,
} from '../../shared/checklistPresetDerivation';
import {
  OPTIONAL_NODE_ALLOWLIST,
  REQUIRED_NODE_ALLOWLIST,
  WORDING_NODE_ALLOWLIST,
} from '../../shared/checklistOverrides';

export const CHECKLIST_PRESET_IDS = [
  'auto_shop_front_desk',
  'salon_front_desk',
  'local_service_front_desk',
  'owner_for_hire_front_desk',
  'law_firm_front_desk',
  // The 28 additional vertical front-desk presets (see
  // shared/checklistPresetDerivation.ts and agent/src/checklist/verticalIntakeTrees.ts).
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
] as const satisfies readonly ChecklistPresetId[];

export const CHECKLIST_PRESET_LABELS: Record<ChecklistPresetId, string> = {
  auto_shop_front_desk: 'Auto shop front desk',
  salon_front_desk: 'Salon front desk',
  local_service_front_desk: 'Local service front desk',
  owner_for_hire_front_desk: 'Owner for hire (takes work offers)',
  law_firm_front_desk: 'Law firm front desk (case intake)',
  mobile_tire_front_desk: 'Mobile tire front desk',
  car_detailing_front_desk: 'Car detailing front desk',
  body_shop_front_desk: 'Body shop front desk',
  oil_change_front_desk: 'Oil change front desk',
  car_wash_front_desk: 'Car wash front desk',
  barbershop_front_desk: 'Barbershop front desk',
  nail_salon_front_desk: 'Nail salon front desk',
  spa_front_desk: 'Spa front desk',
  lash_studio_front_desk: 'Lash studio front desk',
  plumber_front_desk: 'Plumber front desk',
  electrician_front_desk: 'Electrician front desk',
  hvac_front_desk: 'HVAC front desk',
  pest_control_front_desk: 'Pest control front desk',
  cleaning_front_desk: 'Cleaning service front desk',
  landscaping_front_desk: 'Landscaping front desk',
  garage_door_front_desk: 'Garage door front desk',
  locksmith_front_desk: 'Locksmith front desk',
  personal_trainer_front_desk: 'Personal trainer front desk',
  yoga_studio_front_desk: 'Yoga studio front desk',
  tax_prep_front_desk: 'Tax prep front desk',
  tutoring_front_desk: 'Tutoring front desk',
  photography_front_desk: 'Photography front desk',
  real_estate_front_desk: 'Real estate front desk',
  insurance_front_desk: 'Insurance front desk',
  answering_service_front_desk: 'Answering service front desk',
  bakery_front_desk: 'Bakery front desk',
  catering_front_desk: 'Catering front desk',
};

export const CONVERSATION_BLOCK_LABELS: Record<string, string> = {
  identity: 'Who is calling',
  booking: 'Book a time',
  message: 'Take a message',
  qa: 'Answer questions',
  schedule_change: 'Cancel or move an appointment',
  generic_subject: 'Uncategorized subject',
  buy_service: 'Qualify a buyer / demo',
  job: 'Job inquiry',
  fix_computer: 'Computer repair intake',
  case_intake: 'Legal case intake',
};

export function checklistPresetLabel(presetId: string | null | undefined): string {
  if (!presetId) return 'Unknown checklist';
  return CHECKLIST_PRESET_LABELS[presetId as ChecklistPresetId] ?? presetId;
}

export const OPTIONAL_NODE_LABELS: Record<string, string> = {
  qa_summary: 'Question summary (after they are answered)',
  current_cost: 'What they pay an answering service',
  best_email: 'Best email for details',
  call_volume: 'How many calls a day',
  current_setup: 'What happens to calls today',
  wants_handled: 'What they want handled',
  business_type: 'What kind of business they run',
  demo_offer: 'Whether they want a demo',
};

export const OPTIONAL_NODE_IDS = OPTIONAL_NODE_ALLOWLIST;
export const REQUIRED_NODE_IDS = REQUIRED_NODE_ALLOWLIST;
export const WORDING_NODE_IDS = WORDING_NODE_ALLOWLIST;

export const REQUIRED_NODE_LABELS: Record<string, string> = {
  caller_name: 'Caller name',
  caller_phone: 'Callback number',
  ...OPTIONAL_NODE_LABELS,
};

export function conversationBlockLabel(blockId: string): string {
  return CONVERSATION_BLOCK_LABELS[blockId] ?? blockId.replace(/_/g, ' ');
}

export function runtimeForTenant(opts: {
  business_type?: string | null;
  checklist_preset_id?: string | null;
  checklist_runtime_config?: { preset_id: string; enabled_conversation_blocks: string[] } | null;
}): { preset_id: string; enabled_conversation_blocks: string[] } {
  if (opts.checklist_runtime_config?.preset_id) {
    return opts.checklist_runtime_config;
  }
  return deriveChecklistRuntimeConfig(opts.business_type, opts.checklist_preset_id);
}
