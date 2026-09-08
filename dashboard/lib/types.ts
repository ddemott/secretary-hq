import type { StarterService } from '../../shared/starterServices';

export interface Appointment {
  appointment_id: string;
  tenant_id: string;
  resource_id: string;
  customer_id: string;
  employee_id?: string | null;
  start_time: string;
  end_time: string;
  status: 'scheduled' | 'completed' | 'canceled';
  description: string;
  location?: string;
  customers?: {
    name: string;
    first_name?: string;
    last_name?: string;
    phone: string;
    metadata?: Record<string, unknown>;
  };
  resources?: {
    name: string;
  };
  // Structured name fields
  first_name?: string;
  last_name?: string;
  // Combined display name (legacy / convenience — prefer customers.name)
  name?: string;
}

export interface Customer {
  customer_id: string;
  tenant_id: string;
  phone: string;
  name: string; // full name (legacy)
  email: string;
  address: string; // address line 1
  // Optional structured fields
  first_name?: string;
  last_name?: string;
  address_line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  timezone?: string;
  notes?: string;
  metadata: Record<string, unknown>;
}

export interface Tenant {
  tenant_id: string;
  name: string;
  business_type: string;
  checklist_preset_id?:
    'auto_shop_front_desk' | 'salon_front_desk' | 'local_service_front_desk' | null;
  checklist_overrides?: {
    disabled_conversation_blocks?: string[];
    booking_mode?: 'offer_once' | 'prefer' | 'never';
    message_mode?: 'always' | 'fallback_only';
    optional_node_ids?: string[];
    required_node_ids?: string[];
    wording?: Record<string, string>;
  } | null;
  checklist_runtime_config?: {
    preset_id: string;
    enabled_conversation_blocks: string[];
    enabled_policy_blocks: string[];
    enabled_knowledge_blocks: string[];
    enabled_outcome_blocks: string[];
    overrides: Record<string, unknown>;
    version: 1;
  };
  // Nullable in the DB schema and routinely null for newly-created tenants
  // before the AI persona is configured. Consumers must guard.
  system_prompt: string | null;
  /** Owner-editable assistant name (e.g. "Chris"). NULL = no explicit name. */
  persona_name?: string | null;
  /** Service a call books when the caller doesn't name a matchable one. */
  default_service_id?: string | null;
  voice_id: string | null;
  first_message: string | null;
  team_size?: number;
  timezone?: string;
  // Customer-preference capture (Phone Assistant config). When enabled, the AI
  // remembers durable facts about callers and uses them for personal service +
  // relevant upsells. Instructions are owner-authored guidance; null = use the
  // agent's built-in default guidance.
  save_preferences_enabled?: boolean;
  preferences_instructions?: string | null;
  // Per-tenant OpenAI TTS voice + delivery (reused columns from 2026-06-10 Grok era).
  // `tts_voice` is now an OpenAI voice id (shimmer/nova/alloy/echo/onyx/fable).
  // null = platform default `shimmer`. Legacy Grok-only prosody columns (tts_soft,
  // tts_cheerful) are inert. These replaced the earlier `voice_id` (Vapi/ElevenLabs).
  tts_voice?: string | null;
  tts_speed?: number | null;
  tts_soft?: boolean | null;
  tts_cheerful?: boolean | null;
  tts_formal?: boolean | null;
  tts_warm?: boolean | null;
  tts_concise?: boolean | null;
  // Live-transfer destination (2026-06-11). E.164 cell the AI cold-transfers a
  // caller to when they need a human. null = no forwarding; the AI takes a
  // message instead.
  forward_phone?: string | null;
  // The line the tenant forwards INTO the assistant (carrier-forwarded). When
  // the inbound caller-ID matches this, the agent collects the caller's real
  // number by voice. Must differ from forward_phone (the transfer target).
  forwarded_from_phone?: string | null;
  // SMS alert destination for the owner when a caller leaves a message.
  owner_phone?: string | null;
  // Telnyx DID assigned to this tenant — the number callers dial to reach the AI.
  inbound_phone?: string | null;
  // Minutes of gap the AI leaves between back-to-back bookings (Phone Assistant
  // config). 0 = no buffer (default). Applies to AI/customer-facing bookings
  // only; owner manual dashboard bookings are unrestricted.
  default_buffer_minutes?: number;
  // Owner-editable spoken caller disclosure (the AI + call-transcription notice).
  // NULL/blank = the platform speaks its compliant default. Setting a custom
  // value requires attestation (disclosure_attested on the update payload); the
  // stamp columns record who/when for the audit trail.
  call_disclosure?: string | null;
  call_disclosure_attested_at?: string | null;
  call_disclosure_attested_by?: string | null;
}

export interface BusinessTemplate {
  business_type: string;
  display_name: string;
  category: string;
  sort_order?: number;
  system_prompt_template: string;
  first_message: string;
  voice_id: string;
  default_resource_name: string;
  default_resource_description: string;
  resource_label?: string;
  resource_plural?: string;
  employee_label?: string;
  employee_plural?: string;
  booking_label?: string;
  example_services?: StarterService[];
}

export interface Resource {
  resource_id: string;
  tenant_id: string;
  name: string;
  description?: string | null;
  is_active: boolean;
  capabilities?: string[];
  created_at?: string;
  is_auto_seeded?: boolean;
}

export interface Employee {
  employee_id: string;
  tenant_id: string;
  name: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  skills: string[];
  is_active: boolean;
  is_deleted?: boolean;
  type?: 'employee' | 'user';
}

export interface Service {
  service_id: string;
  tenant_id: string;
  name: string;
  subtitle?: string;
  description?: string;
  duration_minutes: number;
  price?: number | null;
  required_skills?: string[];
  required_resources?: string[];
  is_auto_seeded?: boolean;
}

export interface ScheduleEntry {
  // Composite PK: (tenant_id, employee_id, shift_date). The surrogate
  // employee_schedule_id was dropped 2026-05-18 — see migration
  // 20260518130000.
  tenant_id: string;
  employee_id: string;
  shift_date: string; // YYYY-MM-DD
  start_time: string | null;
  end_time: string | null;
  is_off: boolean;
}

export interface EffectiveShift {
  shift_date: string; // YYYY-MM-DD
  day_of_week: number;
  start_time: string | null;
  end_time: string | null;
  is_override: boolean;
  is_off: boolean;
}

export interface BulkEffectiveShift extends EffectiveShift {
  employee_id: string;
}

export interface Skill {
  // Composite PK: (tenant_id, name). The surrogate tenant_skill_id was
  // dropped 2026-05-18 — see migration 20260518110000. `name` is the
  // identifier used in URLs (lowercase + dash slug) and in
  // services.required_skills / employees.skills text[] columns.
  tenant_id: string;
  name: string;
  description?: string | null;
}

export interface ServiceMapping {
  service_id: string;
  employee_id?: string;
  resource_id?: string;
  tenant_id: string;
}

export interface TenantFull extends Tenant {
  timezone?: string;
  owner_phone?: string | null;
  inbound_phone?: string | null;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  subscription_status?: string;
  subscription_plan?: string | null;
  sort_order?: number;
  telnyx_phone_number_id?: string | null;
  phone_status?: string;
  created_at?: string;
  // Read-only template defaults projected onto the tenant by the
  // SuperAdmin /tenants list query — not persisted columns on tenants
  // themselves, but available on the row for display + revert-to-default
  // UX in the admin console.
  system_prompt_template?: string;
  first_message_template?: string;
}

export interface CalendarSettings {
  tenant_id: string;
  provider: string;
  external_calendar_id: string;
  is_active: boolean;
  token_expires_at?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Sync-status shape returned by /square/sync/status. Backend builds it
 * via `getCrmSyncStatus()` in src/services/crmSyncStatus.ts.
 */
export interface CrmSyncStatus {
  last_sync_at: string | null;
  pending_count: number;
  error_count: number;
  total_mapped: { customers: number; appointments: number };
}

export interface SquareSettings {
  tenant_id: string;
  provider: 'square';
  is_active: boolean;
  last_sync_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface AnalyticsStats {
  calls: { total: number; today: number; week: number };
  appointments: { total: number; today: number; week: number; upcoming: number };
  customers: { total: number; new_this_week: number };
  recent_activity: Array<{ type: string; description: string; timestamp: string }>;
}

/**
 * Call-level analytics derived from voice_sessions. "Booked" is keyed on
 * appointment_id (the hard signal), not the freeform `outcome` text.
 * - by_outcome powers the Conversion, Abandonment, and outcome-breakdown ("why") panels.
 * - by_day powers the Call Volume sparkline + per-day conversion.
 */
export interface AnalyticsCalls {
  totals: { total: number; booked: number; abandoned: number };
  by_outcome: Array<{ outcome: string; count: number; booked: number }>;
  by_day: Array<{ day: string; total: number; booked: number }>;
}

export interface AnalyticsCohorts {
  repeat_callers: Array<{
    phone: string;
    call_count: number;
    booked_count: number;
    first_call: string;
    last_call: string;
  }>;
  by_service: Array<{ service: string; booked_count: number }>;
  top_customers: Array<{
    customer_id: string;
    name: string;
    visits: number;
    revenue: number;
  }>;
  abandonment_by_service: Array<{ service: string; abandoned_count: number }>;
  /**
   * First-time-fix: of distinct callers, the share whose FIRST call ended in
   * a booking. `rate` = first_call_booked / distinct_callers, or null when
   * there are no callers (null = "no data", distinct from a real 0%).
   */
  first_time_fix: {
    rate: number | null;
    first_call_booked: number;
    distinct_callers: number;
  };
  summary: {
    distinct_callers: number;
    repeat_callers: number;
    repeat_call_volume: number;
    total_calls: number;
  };
}

/**
 * One weekday × hour cell of the utilization heatmap (GET /analytics/utilization).
 * Only cells with staffed capacity are returned; hours nobody works are absent.
 * All hours are tenant-local (the backend converts via tenants.timezone).
 */
export interface UtilizationCell {
  /** Day of week, 0 = Sunday … 6 = Saturday (Postgres DOW convention) */
  dow: number;
  /** Hour of day, 0-23, tenant-local */
  hour: number;
  /** Staff-minutes on shift during this hour across the queried window */
  staffed_minutes: number;
  /** Appointment-minutes booked during this hour across the queried window */
  booked_minutes: number;
  /** booked/staffed ratio; null guards the (unreturned) zero-staffed case */
  utilization: number | null;
}

export interface AnalyticsUtilization {
  cells: UtilizationCell[];
}

export interface AiCostRow {
  source: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  characters_count: number;
  audio_duration_ms: number;
  estimated_cost_usd: number;
}

export interface AiCostSummary {
  breakdown: AiCostRow[];
  total_estimated_cost_usd: number;
}

/**
 * GET /analytics/ai-cost (T-011). Extends AiCostSummary with the per-call
 * figures a pricing decision actually needs.
 *
 * `avg_cost_per_call_usd` is NULL — not 0 — when no call has been costed this
 * month. "We have not measured one" and "our calls are free" are different
 * claims, and a tier priced off the second is a tier priced off nothing.
 */
export interface AiCostBreakdown extends AiCostSummary {
  call_count: number;
  voice_call_cost_usd: number;
  avg_cost_per_call_usd: number | null;
}

export interface PlanQuota {
  includedCalls: number;
  packCalls: number;
  packPriceUsd: number;
}

export interface MonthlyStatement {
  month: string;
  totalCalls: number;
  answeredCalls: number;
  freeCalls: number;
  includedCalls: number | null;
  overageCalls: number | null;
  packsApplied: number | null;
  packChargeUsd: number | null;
  inProgress: boolean;
}

export interface UsageStatementResult {
  plan: string | null;
  quota: PlanQuota | null;
  billableMinSeconds: number;
  monthBoundaries: 'utc';
  statements: MonthlyStatement[];
}

export interface Vocabulary {
  resource_label: string;
  resource_plural: string;
  employee_label: string;
  employee_plural: string;
  booking_label: string;
  /** Industry-specific STARTER services from the matched business_template;
   *  empty when no template is matched. Objects, not bare names — a look-first
   *  starter carries the description that makes the booking resolver's semantic
   *  match work. See shared/starterServices.ts. */
  example_services: StarterService[];
  /** Example RESOURCE names ("Bay 1", "Van 1"). Deliberately separate from
   *  services: a resource seeded as a service becomes a bookable slot type, so
   *  a caller can be booked for "Bay 1" instead of an oil change. */
  example_resources: string[];
}

export interface CoverageItem {
  service_id: string;
  service_name: string;
  check_date: string;
  gap_hours: number[];
  covered_hours: number[];
  total_open_hours: number;
  coverage_pct: number;
  status: string;
  details: Record<string, unknown>;
}

/**
 * Wizard Phase B draft graph — mirrors the backend's DraftGraphSchema exactly
 * (src/services/setupGraph.ts) so the same payload serializes for both
 * POST /coverage/dry-run (preview) and POST /setup/commit (persist). Every
 * entity is keyed by a client-generated tmp_id (see
 * SetupWizard/draftIds.ts `newTmpId()`) stored in the entity's normal
 * *_id field — WizardService/WizardResource/WizardEmployee need no changes.
 */
export interface WizardDraftGraph {
  // `existing_id` carries the real UUID of a row the wizard PRELOADED from an
  // already-set-up tenant. Present → the backend UPDATEs that row; absent →
  // it INSERTs a new one. Rows the owner deleted simply stop appearing in the
  // draft, and a `mode: 'sync'` commit soft-deletes them. See
  // src/services/setupGraph.ts.
  services: Array<{
    tmp_id: string;
    existing_id?: string;
    name: string;
    duration_minutes: number;
    subtitle?: string;
    description?: string;
    price?: number;
  }>;
  resources: Array<{
    tmp_id: string;
    existing_id?: string;
    name: string;
    description?: string;
  }>;
  employees: Array<{
    tmp_id: string;
    existing_id?: string;
    name: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
  }>;
  shifts: Array<{
    employee_tmp_id: string;
    day_of_week: number;
    start_time: string;
    end_time: string;
  }>;
  service_employee: Array<{ service_tmp_id: string; employee_tmp_id: string }>;
  service_resource: Array<{ service_tmp_id: string; resource_tmp_id: string }>;
  start_date?: string;
  end_date?: string;
}

export interface CallSummary {
  call_summary_id: string;
  tenant_id: string;
  customer_id: string;
  call_id: string;
  summary: string;
  created_at: string;
  call_timestamp?: string;
  has_transcript?: boolean;
}

export interface UserFeedback {
  user_feedback_id: string;
  tenant_id: string;
  user_id?: string;
  page: string;
  context?: string;
  comment: string;
  rating?: number;
  created_at: string;
  user_name?: string;
  tenant_name?: string;
}

export interface KnowledgeEntry {
  tenant_doc_id: string;
  title: string | null;
  section: string | null;
  content: string;
  source: string | null;
  created_at: string;
}

// --- VOICE CRM TYPES (single source of truth) ---
// Re-exported from shared/voiceCrm.ts (the cross-runtime canonical definitions).
// This eliminates the previous duplication between src/types/voiceCrm.ts
// and this file. formatContextForAI lives only in the shared module
// (used by the voice agent for prompt building).

export type {
  CustomerInfo,
  AppointmentSummary,
  AppointmentHistory,
  CustomerNote,
  CustomerContext,
  VoiceSessionStatus,
  VoiceSessionOutcome,
  VoiceSession,
  VoiceSessionDisplay,
} from '../../shared/voiceCrm';

// --- VERSION HISTORY TYPES ---

export type ChangeType = 'create' | 'update' | 'delete' | 'restore' | 'sync' | 'merge';

export type ChangeSource = 'local' | 'square' | 'voice_call' | 'system' | 'api';

export type VersionedTable =
  'customers' | 'appointments' | 'voice_sessions' | 'employees' | 'services' | 'resources';

export interface RecordVersion {
  record_version_id: string;
  tenant_id: string;
  table_name: VersionedTable;
  record_id: string;
  version_number: number;
  data: Record<string, unknown>;
  changed_fields: string[];
  previous_values: Record<string, unknown>;
  change_type: ChangeType;
  change_source: ChangeSource;
  changed_by: string | null;
  change_summary: string | null;
  changed_at: string;
}

export interface RecordHistoryResponse {
  record_id: string;
  table_name: VersionedTable;
  current_version: number;
  versions: RecordVersion[];
  is_deleted: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
}

// --- Audit log (GET /audit-log) ---
export interface AuditLogEntry {
  audit_log_id: string;
  tenant_id: string;
  table_name: string;
  record_id: string;
  action: string;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  changed_by: string | null;
  created_at: string;
}

export interface AuditLogResponse {
  success: boolean;
  entries: AuditLogEntry[];
  count: number;
  limit: number;
  offset: number;
}

// --- RAG answer debugger (POST /knowledge/explain) ---
export interface KnowledgeExplainCandidate {
  rank: number;
  tenant_doc_id: string;
  similarity: number;
  above_threshold: boolean;
  used_in_production: boolean;
  content: string;
}

export interface KnowledgeExplainResponse {
  success: boolean;
  question: string;
  production_threshold: number;
  production_match_count: number;
  candidates: KnowledgeExplainCandidate[];
  would_answer: boolean;
  /** The exact context string the agent would relay (cited), or null. */
  composed_answer: string | null;
}

// --- Tenant data export (GET /export/tenant-data) ---
export interface TenantDataExportResponse {
  success: boolean;
  tenant_id: string;
  generated_at: string;
  record_counts: Record<string, number>;
  total_records: number;
  tables: Record<string, unknown[]>;
}

// --- CSV customer import (POST /customers/import) ---
export interface CustomerImportRowError {
  /** 1-based CSV row number counting the header as row 1 (matches Excel/Sheets). */
  row: number;
  reason: string;
}

export interface CustomerImportResult {
  imported: number;
  skipped_duplicates: number;
  total_rows: number;
  errors: CustomerImportRowError[];
  errors_truncated?: boolean;
}

export interface DeletedRecord {
  record_id: string;
  tenant_id: string;
  table_name: VersionedTable;
  name: string | null;
  phone: string | null;
  email: string | null;
  deleted_at: string;
  deleted_by: string | null;
  version_count: number;
  last_data: Record<string, unknown>;
}

export interface DeletedRecordsResponse {
  records: DeletedRecord[];
  total: number;
}

export interface FieldRestoreOption {
  field: string;
  current_value: unknown;
  versions: Array<{
    version_number: number;
    value: unknown;
    changed_at: string;
    change_source: ChangeSource;
  }>;
}

export interface RecordRestorePreview {
  record_id: string;
  table_name: VersionedTable;
  fields: FieldRestoreOption[];
}

export interface RecentChange {
  record_version_id: string;
  tenant_id: string;
  table_name: VersionedTable;
  record_id: string;
  version_number: number;
  change_type: ChangeType;
  change_source: ChangeSource;
  changed_by: string | null;
  change_summary: string | null;
  changed_at: string;
  record_name: string | null;
  record_phone: string | null;
}

export interface RecentChangesResponse {
  changes: RecentChange[];
  total: number;
}

export interface VersionComparison {
  field_name: string;
  value_a: unknown;
  value_b: unknown;
}

// One row in the Team Logins / Access view. Mirrors the GET /users
// response: minimal user record + an `is_self` flag the server attaches
// so the UI can disable role-edit / disable-self controls.
export interface TeamUser {
  user_id: string;
  email: string;
  full_name: string | null;
  role: 'owner' | 'front_desk';
  created_at: string;
  is_self: boolean;
}

export interface CustomerMessage {
  message_id: string;
  caller_name: string | null;
  caller_phone: string | null;
  callback_phone: string | null;
  message: string;
  status: 'new' | 'read' | 'actioned';
  call_id: string | null;
  created_at: string;
  /** The caller said it could not wait (their words, never inferred). */
  is_urgent?: boolean;
}

/**
 * A recruiter's job inquiry — captured on a call, and until 2026-08-01 visible
 * NOWHERE in the dashboard: no route, no client method, no screen. The lead sat
 * in its own table while the call's outcome said "message" and the Messages
 * inbox was empty (CALL_IMPROVEMENTS.md #1).
 */
export interface JobInquiry {
  job_inquiry_id: string;
  caller_name: string | null;
  callback_phone: string | null;
  /** The agency that rang. */
  caller_company: string | null;
  /** Where the work would actually happen. */
  client_company: string | null;
  represents_company: boolean | null;
  employment_type: string | null;
  role_description: string | null;
  rate_range: string | null;
  duration: string | null;
  location_type: string | null;
  address: string | null;
  timezone: string | null;
  call_id: string | null;
  appointment_id: string | null;
  created_at: string;
}

/** Reminder delivery aggregates for the owner-facing monitoring panel
 *  (GET /reminders/delivery-stats — counts from reminder_schedules). */
export interface ReminderDeliveryStats {
  sent_total: number;
  sent_7d: number;
  sent_30d: number;
  failed_total: number;
  failed_7d: number;
  scheduled: number;
  cancelled: number;
}
