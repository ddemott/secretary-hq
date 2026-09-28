/**
 * Sync orchestrator: coordinates fire-and-forget sync across all providers.
 * Replaces scattered sync calls in routes with a single entry point.
 * Uses structured logging (req.log) instead of console.error.
 */

import type { Pool } from 'pg';
import { syncAppointmentToCalendar } from './calendarSync';
import { syncAppointmentToSquare, syncCustomerToSquare } from './crm/squareSync';
import { syncDispatchesTotal } from './metrics';

interface SyncLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

function logSyncError(
  logger: SyncLogger | null,
  provider: string,
  entity: string,
  action: string,
  entityId: string,
  err: unknown
) {
  const msg = err instanceof Error ? err.message : String(err);
  if (logger) {
    logger.error(
      { provider, entity, action, entityId, error: msg },
      `Sync failed: ${provider} ${entity} ${action}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test-only dispatch recorder
// ─────────────────────────────────────────────────────────────────────
// The orchestrator is fire-and-forget so a black-box e2e test can't
// observe whether each provider was actually invoked. When
// SYNC_TEST_RECORDER=1 is set at boot, every dispatch appends a
// SyncEvent to an in-memory ring buffer; an /agent-tools/_test/
// sync-events route then exposes it for assertion. The recorder is a
// no-op outside test mode, so prod code paths are unaffected.
export type SyncEvent = {
  ts: string;
  provider: string;
  entity: 'appointment' | 'customer';
  action: 'create' | 'update' | 'delete';
  tenantId: string;
  entityId: string;
};

const recorder: SyncEvent[] = [];
const RECORDER_MAX = 500;

function recordingEnabled(): boolean {
  return process.env.SYNC_TEST_RECORDER === '1';
}

function record(
  provider: string,
  entity: 'appointment' | 'customer',
  action: 'create' | 'update' | 'delete',
  tenantId: string,
  entityId: string
) {
  if (!recordingEnabled()) return;
  recorder.push({ ts: new Date().toISOString(), provider, entity, action, tenantId, entityId });
  if (recorder.length > RECORDER_MAX) recorder.splice(0, recorder.length - RECORDER_MAX);
}

/**
 * Bump the sync dispatch counter regardless of recorder mode. Lives
 * alongside record() so the dispatch loop only walks the providers
 * once. Labels are bounded (5 providers × 2 entities × 3 actions = 30
 * series max) so cardinality is safe.
 */
function meter(
  provider: string,
  entity: 'appointment' | 'customer',
  action: 'create' | 'update' | 'delete'
) {
  syncDispatchesTotal.inc({ provider, entity, action });
}

export function getSyncRecorder(): readonly SyncEvent[] {
  return recorder;
}

export function clearSyncRecorder(): void {
  recorder.length = 0;
}

/**
 * Returns true if the tenant has is_tutorial=true.
 * Defaults to false on any DB error so a broken pool doesn't block real syncs.
 */
async function isTutorialTenant(pool: Pool, tenantId: string): Promise<boolean> {
  try {
    const res = await pool.query<{ is_tutorial: boolean }>(
      'SELECT is_tutorial FROM tenants WHERE tenant_id = $1',
      [tenantId]
    );
    return res.rows[0]?.is_tutorial === true;
  } catch {
    return false; // fail open — real tenants should not lose sync on a transient lookup error
  }
}

/**
 * Sync an appointment to all connected providers (calendars + CRMs).
 * Fire-and-forget — never throws, never blocks the caller.
 *
 * record() + meter() are called synchronously so the SYNC_TEST_RECORDER
 * capture is available immediately (used by Playwright e2e assertions).
 * Actual provider calls are gated on an async is_tutorial lookup so tutorial
 * tenants never reach real external endpoints.
 */
export function syncAppointmentToAll(
  pool: Pool,
  tenantId: string,
  appointmentId: string,
  action: 'create' | 'update' | 'delete',
  logger: SyncLogger | null = null
): void {
  const providers = [
    { name: 'calendar', fn: syncAppointmentToCalendar },
    { name: 'square', fn: syncAppointmentToSquare },
  ];

  for (const { name } of providers) {
    record(name, 'appointment', action, tenantId, appointmentId);
    meter(name, 'appointment', action);
  }

  isTutorialTenant(pool, tenantId)
    .then((isTutorial) => {
      if (isTutorial) return; // tutorial tenants must not touch real external endpoints
      for (const { name, fn } of providers) {
        fn(pool, tenantId, appointmentId, action).catch((e) =>
          logSyncError(logger, name, 'appointment', action, appointmentId, e)
        );
      }
    })
    .catch((e) => logSyncError(logger, 'orchestrator', 'appointment', action, appointmentId, e));
}

/**
 * Sync a customer to all connected CRM providers.
 * Fire-and-forget — never throws, never blocks the caller.
 * Same record-first, gate-later pattern as syncAppointmentToAll.
 */
export function syncCustomerToAll(
  pool: Pool,
  tenantId: string,
  customerId: string,
  action: 'create' | 'update' | 'delete',
  logger: SyncLogger | null = null
): void {
  const providers = [{ name: 'square', fn: syncCustomerToSquare }];

  for (const { name } of providers) {
    record(name, 'customer', action, tenantId, customerId);
    meter(name, 'customer', action);
  }

  isTutorialTenant(pool, tenantId)
    .then((isTutorial) => {
      if (isTutorial) return;
      for (const { name, fn } of providers) {
        fn(pool, tenantId, customerId, action).catch((e) =>
          logSyncError(logger, name, 'customer', action, customerId, e)
        );
      }
    })
    .catch((e) => logSyncError(logger, 'orchestrator', 'customer', action, customerId, e));
}
