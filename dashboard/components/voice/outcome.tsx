/**
 * Call-outcome presentation: label + theme-token color for each
 * voice_sessions.outcome value, plus the shared badge. Extracted from
 * VoiceCallsView.tsx (dense-view decomposition) — the main view, the history
 * rows, and the detail pane all read the same mapping.
 */
import React from 'react';

// The ONLY outcome strings the agent ever writes to voice_sessions.outcome:
//   'booked' / 'transferred'                              (callOutcome.ts)
//   'no_availability' / 'wrong_service' / 'price'
//     / 'message' / 'info'                                (callClassify.ts CATEGORIES)
//   null/'' → treated as no-outcome (abandoned) server-side.
// The previous map keyed on 'appointment_booked'/'info_provided'/'voicemail'/
// 'abandoned' — a phantom vocabulary the agent never emits — so a booked call
// fell through to a grey "booked" badge and every classify outcome showed a
// raw underscore label. These keys mirror callClassify.ts exactly.
export const OUTCOME_LABELS: Record<string, string> = {
  booked: 'Booked',
  transferred: 'Transferred',
  message: 'Left a message',
  // capture_job_inquiry succeeded (callOutcome.ts recordJobInquiry, 2026-07-30).
  // Previously these calls fell to the classifier, which read the agent's spoken
  // "I'll leave a message" and labelled them 'message' — sending the owner to an
  // empty Messages inbox while the lead sat in job inquiries.
  job_inquiry: 'Job inquiry',
  no_availability: 'No availability',
  wrong_service: 'Wrong service',
  price: 'Price concern',
  info: 'Question only',
  no_outcome: 'No clear outcome',
  // Backward-compat: the shared `VoiceSessionOutcome` type (shared/voiceCrm.ts)
  // and the /voice/session/end Zod enum (src/routes/voice.ts) still accept a
  // legacy vocabulary, so historical rows or a non-agent writer may carry these.
  // Map them intentionally instead of letting them fall through to a grey badge.
  // (That shared type + backend schema were reconciled to the agent's live
  // vocabulary 2026-09-13 — 'job_inquiry' was live here but missing from both;
  // see shared/voiceCrm.ts's VoiceSessionOutcome comment.)
  appointment_booked: 'Booked',
  appointment_rescheduled: 'Rescheduled',
  appointment_cancelled: 'Cancelled',
  info_provided: 'Question only',
  voicemail: 'Voicemail',
  abandoned: 'No clear outcome',
  other: 'Other',
};

export function getOutcomeLabel(outcome: string | null): string {
  if (!outcome) return 'No clear outcome';
  return OUTCOME_LABELS[outcome] || outcome.replace(/_/g, ' ');
}

export type OutcomeStyle = { backgroundColor: string; color: string };

/**
 * Theme-token-driven outcome badge colors. Maps each outcome to the
 * semantic CSS vars defined per-theme in globals.css. Replaces the
 * earlier hardcoded `bg-green-100 text-green-800` Tailwind utilities
 * which only rendered correctly on light themes — every dark theme
 * (midnight/nord/forest/sunset/...) had unreadable badges before this.
 *
 * Mapping rationale (keys match the agent's real outcome vocabulary):
 * - booked                            → success  (won the booking)
 * - no_availability/wrong_service/price → danger  (a lost booking — the WHY)
 * - transferred / message             → warning  (procedural, needs follow-up)
 * - info / no_outcome / null          → neutral  (uses --bg-raised + --text-secondary)
 */
export function getOutcomeStyle(outcome: string | null): OutcomeStyle {
  switch (outcome) {
    // Won the booking. `appointment_booked`/`appointment_rescheduled` are the
    // legacy-vocabulary equivalents (see OUTCOME_LABELS backward-compat note).
    case 'booked':
    case 'appointment_booked':
    case 'appointment_rescheduled':
      return { backgroundColor: 'var(--success-bg)', color: 'var(--success)' };
    // Lost booking (the WHY) + legacy `appointment_cancelled`.
    case 'no_availability':
    case 'wrong_service':
    case 'price':
    case 'appointment_cancelled':
      return { backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' };
    // Procedural, needs follow-up + legacy `voicemail`.
    case 'transferred':
    case 'message':
    case 'job_inquiry':
    case 'voicemail':
      return { backgroundColor: 'var(--warning-bg)', color: 'var(--warning)' };
    default:
      return { backgroundColor: 'var(--bg-raised)', color: 'var(--text-secondary)' };
  }
}

export function OutcomeBadge({ outcome }: { outcome: string | null }) {
  return (
    <span className="px-1.5 py-0.5 rounded text-xs" style={getOutcomeStyle(outcome)}>
      {getOutcomeLabel(outcome)}
    </span>
  );
}
