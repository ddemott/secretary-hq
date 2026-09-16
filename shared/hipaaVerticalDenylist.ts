/**
 * HIPAA-vertical denylist — the one enforcement point independent of the
 * dashboard's business-type picker.
 *
 * Root CLAUDE.md Build Principles: "HIPAA verticals are permanently
 * excluded. Medical, dental, chiropractic, optometry, veterinary. Anything
 * that surfaces them gets deleted on sight." The picker UI normally
 * constrains `business_type` via a `<select>`, but falls back to free text
 * on a `GET /templates` failure, and a direct API call (`POST /register`,
 * `POST /tenants/create`) bypasses the picker entirely — `business_type` was
 * `z.string().min(1).max(50)` with no server-side check against this list
 * (found 2026-09-16 roady audit, docs/planning/TODO.md).
 *
 * Case-insensitive SUBSTRING match on purpose: catches "Dental Office",
 * "veterinary-clinic", "Family Medical Group", etc. without requiring an
 * exact enum value.
 */
const HIPAA_VERTICAL_PATTERN = /hipaa|dental|veterinary|chiropractic|optometry|medical/i;

export function isHipaaVertical(businessType: string): boolean {
  return HIPAA_VERTICAL_PATTERN.test(businessType);
}
