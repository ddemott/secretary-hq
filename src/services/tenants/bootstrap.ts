/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

/**
 * Tenant + owner bootstrap.
 *
 * Public self-service registration (`POST /register`) and admin tenant
 * creation (`POST /tenants/create`) used to maintain near-identical
 * transactional flows: BEGIN, duplicate check, INSERT INTO tenants,
 * bcrypt hash, INSERT INTO users, COMMIT (with ROLLBACK on error).
 * Both lived to serve different policy decisions:
 *
 *   - Different duplicate keys (email globally vs tenant name)
 *   - Different conflict messages
 *   - Different user columns (admin sets first_name/last_name)
 *
 * This module owns the transactional shape; callers express policy via
 * a small parameter object and get back a discriminated-union result.
 *
 * NOTE: This helper opens its own connection from `pool` and manages
 * its own transaction. Do not call it inside an existing transaction
 * on a shared client.
 */

import type { Pool } from 'pg';
import { verticalForBusinessType } from '../../../shared/checklistPresetDerivation';
import { isHipaaVertical } from '../../../shared/hipaaVerticalDenylist';

/**
 * Shown when someone signs up with an email that already has an account.
 * Owner decision 2026-09-24: say so plainly and point them at sign-in, rather
 * than a vague "conflict". (/register is rate-limited 5 per 5 minutes, which
 * bounds using this as an email-existence probe.)
 */
export const ALREADY_HAVE_ACCOUNT_MESSAGE =
  "You already have an account with this email. Sign in instead — or use 'Forgot password' if you don't remember it.";
export interface CreateTenantWithOwnerParams {
  tenantName: string;
  businessType: string;
  ownerEmail: string;
  ownerPassword: string;
  ownerFullName: string;
  ownerFirstName?: string | null;
  ownerLastName?: string | null;
  /**
   * Which duplicate key blocks creation:
   *   - 'email':       fail if this email already exists on any user
   *                    (public self-serve register flow — one account per
   *                    email globally).
   *   - 'tenant_name': fail if this tenant name already exists,
   *                    case-insensitively (admin create flow — owners
   *                    expect distinct business names in the picker).
   */
  duplicateCheck: 'email' | 'tenant_name';
  /**
   * The self-serve /register flow's legal-consent checkbox attestation —
   * present ONLY when the caller (the /register route) verified
   * `consent_attested: true` on the request. Omitted/undefined for the
   * admin create flow (POST /tenants/create): an admin creating a tenant
   * on someone else's behalf isn't the business owner attesting anything,
   * so those tenants intentionally get NULL consent columns.
   *
   * `ip`/`userAgent` are best-effort and may be null — they never block
   * registration, they just narrow the audit trail when present.
   */
  legalConsent?: {
    ip: string | null;
    userAgent: string | null;
  };
}

export type CreateTenantWithOwnerResult =
  | { ok: true; tenantId: string; userId: string; consentGateRequired: boolean }
  | { ok: false; conflictMessage: string };

export async function createTenantWithOwner(
  pool: Pool,
  params: CreateTenantWithOwnerParams
): Promise<CreateTenantWithOwnerResult> {
  // HIPAA verticals are permanently excluded (root CLAUDE.md Build
  // Principles). RegisterSchema checks this too for the self-serve
  // path, but the admin create flow (POST /tenants/create) has no
  // equivalent Zod schema, so this is the one check both paths share —
  // "independent of the dashboard picker" per docs/planning/TODO.md.
  if (isHipaaVertical(params.businessType)) {
    return {
      ok: false,
      conflictMessage: 'This business type is not supported on this platform.',
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // One account per email, platform-wide (owner decision 2026-09-24),
    // case-insensitive. Checked on EVERY path — self-serve and admin-created
    // alike — not just when duplicateCheck is 'email'.
    const existingEmail = await client.query(
      'SELECT user_id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [params.ownerEmail]
    );
    if (existingEmail.rows.length > 0) {
      await client.query('ROLLBACK');
      return { ok: false, conflictMessage: ALREADY_HAVE_ACCOUNT_MESSAGE };
    }

    if (params.duplicateCheck === 'tenant_name') {
      const existing = await client.query(
        'SELECT tenant_id FROM tenants WHERE LOWER(name) = LOWER($1)',
        [params.tenantName]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          conflictMessage: `A business named "${params.tenantName}" already exists.`,
        };
      }
    }

    // ADMIN-PROVISIONED TENANTS GET A CONSENT GATE, SELF-SERVE TENANTS DON'T.
    //
    // legalConsent present (self-serve /register, already attested via the
    // page's checkbox + RegisterSchema's consent_attested: true) -> false,
    // never gated. legalConsent absent (admin POST /tenants/create, nobody
    // has attested anything yet) -> true, gated until the owner clicks
    // through the emailed consent-invite link (POST /consent/confirm).
    //
    // This column defaults false at the schema level, so it is written here
    // as an explicit third INSERT column rather than a follow-up UPDATE —
    // every row this function ever creates states its own gate requirement
    // up front, inside the same transaction. Pre-existing rows (seed data,
    // tenants created before this migration) are untouched and stay false
    // forever — see tests/regression/tenantConsentGateRetroactivity.realdb.test.ts.
    const consentGateRequired = !params.legalConsent;

    const tenantRes = await client.query(
      'INSERT INTO tenants (name, business_type, consent_gate_required) VALUES ($1, $2, $3) RETURNING tenant_id',
      [params.tenantName, params.businessType, consentGateRequired]
    );
    const tenantId = tenantRes.rows[0].tenant_id;

    const bcrypt = await import('bcrypt');
    const passwordHash = await bcrypt.hash(params.ownerPassword, 10);

    const userRes = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING user_id`,
      [
        tenantId,
        params.ownerEmail,
        passwordHash,
        params.ownerFullName,
        params.ownerFirstName ?? null,
        params.ownerLastName ?? null,
      ]
    );
    const userId = userRes.rows[0].user_id;

    // RECORD THE LEGAL-CONSENT ATTESTATION, IF ANY.
    //
    // Only present for the self-serve /register flow (RegisterSchema
    // requires consent_attested: true before this helper is ever called
    // with it set) — an admin creating a tenant via POST /tenants/create
    // never passes this, so those rows stay NULL. Deliberately NOT
    // best-effort: unlike the question-tree copy below, a registration
    // whose consent record fails to write must roll back the whole
    // transaction — a tenant that exists with no proof consent was ever
    // given is exactly the gap this migration closes.
    if (params.legalConsent) {
      await client.query(
        `UPDATE tenants
            SET legal_consent_attested_at = NOW(),
                legal_consent_attested_by = $1,
                legal_consent_ip = $2,
                legal_consent_user_agent = $3
          WHERE tenant_id = $4`,
        [userId, params.legalConsent.ip, params.legalConsent.userAgent, tenantId]
      );
    }

    // GIVE THE NEW BUSINESS ITS OWN COPY OF THE VERTICAL'S QUESTIONS.
    //
    // The generic template for their vertical is copied into their own rows
    // here, inside the same transaction that creates the business — so a tenant
    // never exists in a state where it has a business_type but no questions.
    // From this moment their intake is theirs: editing it changes their calls
    // and nobody else's, and a later platform template edit cannot reach back
    // and silently alter what their callers are asked.
    //
    // Best-effort by design: a business that fails to get its template copy is
    // still a valid business — the agent falls back to the platform TS library,
    // which is exactly today's behaviour. Failing tenant creation over a
    // template copy would trade a working signup for a cosmetic one.
    try {
      await client.query('SELECT copy_question_tree_templates_to_tenant($1, $2)', [
        tenantId,
        [verticalForBusinessType(params.businessType)],
      ]);
    } catch (err) {
      // Not fatal, but never silent: a tenant on the fallback library cannot be
      // configured per-client until someone notices and copies the templates in.
      console.warn(
        `[bootstrap] question-tree template copy failed for tenant ${tenantId} ` +
          `(business_type=${params.businessType}); tenant will run the platform ` +
          `fallback library until templates are copied:`,
        err
      );
    }

    await client.query('COMMIT');
    return { ok: true, tenantId, userId, consentGateRequired };
  } catch (err) {
    await client.query('ROLLBACK');
    // Race: another request registered the same email between our SELECT and
    // our INSERT. The platform-wide unique index (users_email_lower_unique,
    // 2026-09-24) catches it — answer the same "already have an account" the
    // SELECT would have, not a 500.
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === 'users_email_lower_unique') {
      return { ok: false, conflictMessage: ALREADY_HAVE_ACCOUNT_MESSAGE };
    }
    throw err;
  } finally {
    client.release();
  }
}
