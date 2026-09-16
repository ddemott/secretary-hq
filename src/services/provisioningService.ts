/**
 * Phone provisioning state machine.
 *
 * Extracted from src/routes/provisioning.ts so the orchestration logic
 * (tenant-fetch, status-transition, Telnyx order/assign/release, rollback)
 * is testable without HTTP overhead.
 *
 * The route layer is responsible for:
 *   - Telnyx null-check (503)
 *   - Zod schema validation (400)
 *   - Mapping result variants to HTTP status codes + bodies
 *   - All logEvent / logError calls (result carries the raw error objects
 *     and context fields the route needs to reconstruct every log call)
 */

import type { Pool } from 'pg';
import type { TelnyxProvisioningConfig } from '../routes/provisioning';

// ── Result types ─────────────────────────────────────────────────────────────

export type ActivateResult =
  | {
      status: 'ok';
      phone_number: string;
      telnyx_phone_number_id: string;
      tenant_id: string;
    }
  | { status: 'not_found'; tenant_id: string }
  | {
      status: 'conflict';
      reason: 'already_active' | 'already_provisioning';
      tenant_id: string;
      tenant_name: string;
      current_status: string;
    }
  | {
      status: 'failed';
      detail: string;
      /** Original provisioning error — pass to logError('phone_provisioning_failed') */
      error: unknown;
      tenant_id: string;
      tenant_name: string;
      number_purchased: boolean;
      rolled_back: boolean;
      purchased_id: string | null;
      /** Set when the rollback release itself threw — pass to logError('telnyx_number_cleanup_failed') */
      cleanup_error?: unknown;
    };

export type DeactivateResult =
  | {
      status: 'ok';
      tenant_id: string;
      warnings: string[];
      /** Set when telnyx.client.release threw — pass to logError('telnyx_number_release_failed') */
      release_error?: unknown;
      /** phone number id that failed release — for logError context */
      release_phone_number_id?: string;
    }
  | { status: 'not_found' };

// ── helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve the canonical /phone_numbers resource id for a freshly ordered number.
 *
 * Telnyx may not list a just-purchased number immediately, so we retry briefly.
 * Falls back to the order-line id if lookup never resolves — the post-assign
 * verification will then catch a bad id rather than marking a dead line active.
 */
async function resolvePhoneNumberId(
  telnyx: TelnyxProvisioningConfig,
  ordered: { id: string; phone_number: string }
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await telnyx.client.findPhoneNumberIdByNumber(ordered.phone_number);
    if (found) return found;
    if (attempt < 2) await sleep(1000 * (attempt + 1));
  }
  return ordered.id;
}

// ── activatePhone ─────────────────────────────────────────────────────────────

/**
 * Purchase and assign a Telnyx phone number to a tenant's SIP connection.
 *
 * State transitions:
 *   inactive / failed / deprovisioned → provisioning → active   (success)
 *   inactive / failed / deprovisioned → provisioning → failed   (error)
 *   active / provisioning → conflict (409)
 */
export async function activatePhone(
  pool: Pool,
  telnyx: TelnyxProvisioningConfig,
  tenantId: string,
  areaCode?: string
): Promise<ActivateResult> {
  const client = await pool.connect();
  try {
    const tenantRes = await client.query<{
      tenant_id: string;
      name: string;
      phone_status: string;
    }>(
      `SELECT tenant_id, name, phone_status FROM tenants WHERE tenant_id = $1 AND is_deleted = false`,
      [tenantId]
    );

    if (tenantRes.rows.length === 0) {
      return { status: 'not_found', tenant_id: tenantId };
    }

    const tenant = tenantRes.rows[0];

    if (tenant.phone_status === 'active') {
      return {
        status: 'conflict',
        reason: 'already_active',
        tenant_id: tenantId,
        tenant_name: tenant.name,
        current_status: tenant.phone_status,
      };
    }
    if (tenant.phone_status === 'provisioning') {
      return {
        status: 'conflict',
        reason: 'already_provisioning',
        tenant_id: tenantId,
        tenant_name: tenant.name,
        current_status: tenant.phone_status,
      };
    }

    await client.query('UPDATE tenants SET phone_status = $1 WHERE tenant_id = $2', [
      'provisioning',
      tenantId,
    ]);

    // PROVISIONING_E2E_STUB: strict opt-in (literal "1") that swaps the real
    // Telnyx search/order/assign HTTP calls for a canned number (unique per
    // call, not reproducible run-to-run — it's built from Date.now()), so
    // E2E can exercise the REAL state-machine + DB update path (not just the
    // route) without a live Telnyx account. Same env-gated test-hook
    // discipline as KNOWLEDGE_IMPORT_E2E_STUB. Off by default. inbound_phone
    // is UNIQUE — Date.now() keeps repeated activations across a test run
    // from colliding.
    if (process.env.PROVISIONING_E2E_STUB === '1') {
      const stubPhoneNumber = `+1${areaCode || '555'}${Date.now().toString().slice(-7)}`;
      const stubPhoneNumberId = `stub-pn-${Date.now()}`;
      await client.query(
        `UPDATE tenants SET
          telnyx_phone_number_id = $1,
          inbound_phone = $2,
          phone_status = 'active'
        WHERE tenant_id = $3`,
        [stubPhoneNumberId, stubPhoneNumber, tenantId]
      );
      return {
        status: 'ok',
        phone_number: stubPhoneNumber,
        telnyx_phone_number_id: stubPhoneNumberId,
        tenant_id: tenantId,
      };
    }

    let purchasedId: string | null = null;

    try {
      const available = await telnyx.client.searchAvailable(areaCode);
      if (!available) {
        throw new Error(
          areaCode
            ? `No available phone numbers in area code ${areaCode}`
            : 'No available phone numbers in Telnyx inventory'
        );
      }

      const ordered = await telnyx.client.orderNumber(available.phone_number);

      // Resolve the canonical phone_numbers resource id. The order-line id from
      // number_orders is not guaranteed to equal it; using the wrong id makes
      // assign/release silently no-op. Set purchasedId to the resolved id so
      // rollback releases the right resource.
      const resolvedId = await resolvePhoneNumberId(telnyx, ordered);
      purchasedId = resolvedId;

      await telnyx.client.assignToConnection(resolvedId, telnyx.sipConnectionId);

      // Verify the assignment actually took before declaring the line live.
      // Without this, a number that never routes inbound is still marked
      // 'active' (the silent-dead-line failure mode). If the connection did not
      // stick, throw → rollback releases the number and the tenant goes 'failed'.
      const detail = await telnyx.client.getPhoneNumber(resolvedId);
      if (detail.connection_id !== telnyx.sipConnectionId) {
        throw new Error(
          `Connection assignment did not take for ${ordered.phone_number}: ` +
            `expected connection_id=${telnyx.sipConnectionId}, got ${detail.connection_id ?? 'null'}`
        );
      }

      await client.query(
        `UPDATE tenants SET
          telnyx_phone_number_id = $1,
          inbound_phone = $2,
          phone_status = 'active'
        WHERE tenant_id = $3`,
        [resolvedId, ordered.phone_number, tenantId]
      );

      return {
        status: 'ok',
        phone_number: ordered.phone_number,
        telnyx_phone_number_id: resolvedId,
        tenant_id: tenantId,
      };
    } catch (err: unknown) {
      let cleanupError: unknown;

      if (purchasedId) {
        try {
          await telnyx.client.release(purchasedId);
        } catch (releaseErr) {
          cleanupError = releaseErr;
        }
      }

      await client.query('UPDATE tenants SET phone_status = $1 WHERE tenant_id = $2', [
        'failed',
        tenantId,
      ]);

      return {
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
        error: err,
        tenant_id: tenantId,
        tenant_name: tenant.name,
        number_purchased: !!purchasedId,
        rolled_back: !!purchasedId,
        purchased_id: purchasedId,
        ...(cleanupError !== undefined ? { cleanup_error: cleanupError } : {}),
      } satisfies ActivateResult & { status: 'failed' };
    }
  } finally {
    client.release();
  }
}

// ── deactivatePhone ───────────────────────────────────────────────────────────

/**
 * Release a tenant's Telnyx number and clear provisioning columns.
 *
 * The DB deactivation always completes even if the Telnyx API release fails —
 * the failure is captured in `warnings[]` and `release_error` so the caller
 * can surface it and log it, without leaving the tenant stuck in "active" state.
 */
export async function deactivatePhone(
  pool: Pool,
  telnyx: TelnyxProvisioningConfig,
  tenantId: string
): Promise<DeactivateResult> {
  const client = await pool.connect();
  try {
    const tenantRes = await client.query<{
      telnyx_phone_number_id: string | null;
      forwarded_from_phone: string | null;
    }>(
      'SELECT telnyx_phone_number_id, forwarded_from_phone FROM tenants WHERE tenant_id = $1 AND is_deleted = false',
      [tenantId]
    );

    if (tenantRes.rows.length === 0) {
      return { status: 'not_found' };
    }

    const { telnyx_phone_number_id, forwarded_from_phone } = tenantRes.rows[0];
    const warnings: string[] = [];
    let releaseError: unknown;

    // Real hazard, not just noise: if the business still forwards their real,
    // published number into this DID (forwarded_from_phone set), releasing it
    // strands every real caller the moment carrier-side forwarding delivers a
    // call to a now-dead number. Warn, don't block — the owner may be
    // deliberately tearing down (e.g. switching providers) and knows this.
    if (forwarded_from_phone) {
      warnings.push(
        `This number is still set as your Forwarded-From line (${forwarded_from_phone}). ` +
          `Callers to that number will stop reaching anyone once this DID is released — ` +
          `update or remove the forwarding on your carrier's side first.`
      );
    }

    if (telnyx_phone_number_id) {
      try {
        await telnyx.client.release(telnyx_phone_number_id);
      } catch (err) {
        releaseError = err;
        warnings.push(
          `Failed to release Telnyx number ${telnyx_phone_number_id}: ${err instanceof Error ? err.message : 'unknown error'}. It may need manual cleanup in the Telnyx portal.`
        );
      }
    }

    await client.query(
      `UPDATE tenants SET
        telnyx_phone_number_id = NULL,
        inbound_phone = NULL,
        phone_status = 'deprovisioned'
      WHERE tenant_id = $1`,
      [tenantId]
    );

    return {
      status: 'ok',
      tenant_id: tenantId,
      warnings,
      ...(releaseError !== undefined
        ? {
            release_error: releaseError,
            release_phone_number_id: telnyx_phone_number_id ?? undefined,
          }
        : {}),
    };
  } finally {
    client.release();
  }
}
