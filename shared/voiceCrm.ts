/**
 * Shared Voice CRM types (cross-runtime).
 *
 * Single source of truth for customer context, notes, voice session shapes,
 * and the prompt-formatting helper used by the voice agent.
 *
 * Used by:
 *   - Backend (src/ via relative '../shared/voiceCrm')
 *   - Dashboard (via relative '../../../shared/voiceCrm' from lib/)
 *
 * Backend-only request/response DTOs and API response wrappers live in
 * src/types/voiceCrm.ts (which re-exports the shared core).
 */

export interface CustomerInfo {
  customer_id: string;
  name: string | null;
  phone: string;
  email: string | null;
  address: string | null;
  created_at: string;
}

export interface AppointmentSummary {
  appointment_id: string;
  start_time: string;
  end_time: string;
  status: string;
  description: string | null;
  resource_name: string | null;
  employee_name: string | null;
}

export interface AppointmentHistory {
  total: number;
  completed: number;
  cancelled: number;
  last_appointment: AppointmentSummary | null;
  upcoming_appointments: AppointmentSummary[];
}

export interface CustomerNote {
  note_id: string;
  text: string;
  type: 'general' | 'call' | 'preference' | 'important';
  call_id?: string;
  created_at: string;
}

export interface CustomerContext {
  is_known_customer: boolean;
  customer: CustomerInfo | null;
  appointment_history: AppointmentHistory;
  notes: CustomerNote[];
  preferences: Record<string, unknown>;
  tags: string[];
  member_since?: string;
  session_id?: string;
}

export type VoiceSessionStatus = 'active' | 'completed' | 'failed' | 'transferred';

// The live vocabulary is whatever the agent actually writes on
// /agent-tools/voice-session-end: `booked`/`transferred`/`job_inquiry`
// (callOutcome.ts) and the "why" classes
// `no_availability`/`wrong_service`/`price`/`message`/`info` (callClassify.ts),
// or null when unclassified. `job_inquiry` was added to callOutcome.ts
// 2026-07-30 (capture_job_inquiry) but never added here or to the
// /voice/session/end enum below — found during the 2026-09-13 vocabulary
// audit; dashboard/components/voice/outcome.tsx's OUTCOME_LABELS already
// mapped it (so the UI rendered it fine), but this type and the manual-entry
// endpoint's z.enum did not know it existed. The `appointment_*`/
// `info_provided`/`voicemail`/`abandoned`/`other` members below are the
// LEGACY vocabulary — the agent never emits them, but they're kept for
// backward-compat (older rows, the VoiceCallsView alias maps, and the
// /voice/session/end enum). Do not drop them.
export type VoiceSessionOutcome =
  // Live vocabulary (agent-emitted)
  | 'booked'
  | 'transferred'
  | 'job_inquiry'
  | 'no_availability'
  | 'wrong_service'
  | 'price'
  | 'message'
  | 'info'
  // Legacy vocabulary (backward-compat only — never written by the current agent)
  | 'appointment_booked'
  | 'appointment_rescheduled'
  | 'appointment_cancelled'
  | 'info_provided'
  | 'voicemail'
  | 'abandoned'
  | 'other';

export interface VoiceSession {
  voice_session_id: string;
  tenant_id: string;
  call_id: string;
  caller_phone: string;
  customer_id: string | null;
  customer_context: CustomerContext;
  status: VoiceSessionStatus;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  transcript: string | null;
  summary: string | null;
  outcome: VoiceSessionOutcome | null;
  appointment_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // Joined field populated by some dashboard queries (harmless optional on the shared shape)
  customer_name?: string | null;
}

export interface VoiceSessionDisplay {
  voice_session_id: string;
  call_id: string;
  caller_phone: string;
  customer_name: string | null;
  customer_id: string | null;
  status: VoiceSessionStatus;
  started_at: string;
  duration_seconds: number | null;
  outcome: VoiceSessionOutcome | null;
  is_known_customer: boolean;
}

/**
 * Format customer context as a string for AI prompts (used by the voice agent).
 * Pure function — safe to import on both runtimes.
 */
export function formatContextForAI(context: CustomerContext): string {
  if (!context.is_known_customer) {
    return 'New caller - no previous history with this business.';
  }

  const lines: string[] = [];

  // Customer info
  if (context.customer) {
    lines.push(`Returning customer: ${context.customer.name || 'Name unknown'}`);
    if (context.member_since) {
      const memberSince = new Date(context.member_since);
      const months = Math.floor((Date.now() - memberSince.getTime()) / (30 * 24 * 60 * 60 * 1000));
      lines.push(`Customer for ${months} months`);
    }
  }

  // Appointment history
  const history = context.appointment_history;
  if (history.total > 0) {
    lines.push(
      `Appointment history: ${history.total} total (${history.completed} completed, ${history.cancelled} cancelled)`
    );
  }

  // Upcoming appointments
  if (history.upcoming_appointments.length > 0) {
    const upcoming = history.upcoming_appointments[0];
    const date = new Date(upcoming.start_time);
    lines.push(
      `Next appointment: ${date.toLocaleDateString()} at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    );
    if (upcoming.description) {
      lines.push(`  Service: ${upcoming.description}`);
    }
  }

  // Notes (most recent 3)
  if (context.notes.length > 0) {
    lines.push('Recent notes:');
    const recentNotes = context.notes.slice(-3);
    for (const note of recentNotes) {
      lines.push(`  - ${note.text}`);
    }
  }

  // Preferences
  const prefs = context.preferences;
  if (Object.keys(prefs).length > 0) {
    lines.push(`Preferences: ${JSON.stringify(prefs)}`);
  }

  // Tags
  if (context.tags.length > 0) {
    lines.push(`Tags: ${context.tags.join(', ')}`);
  }

  return lines.join('\n');
}
