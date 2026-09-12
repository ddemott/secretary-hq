/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
/**
 * no-unsafe-* rules disabled: this file handles OAuth token refresh flows
 * with external providers. Responses from token endpoints and DB rows are
 * dynamic by nature.
 *
 * Part of ESLint debt reduction (historical REFACTORING_TODO.md item 10; see RESOLVED.md).
 */

/**
 * Shared token management for all OAuth-based integrations.
 *
 * Eliminates duplication across the CRM sync modules (squareSync today;
 * jobber/hubspot/servicetitan removed 2026-06-12) and calendarSync — all of which implemented identical
 * getTokensWithRefresh() logic.
 *
 * Pattern: SELECT FOR UPDATE → check expiry → refresh → update DB → handle failure
 */

import type { Pool } from 'pg';

import { withTenantContext } from '../database/index';
import { errorsTotal } from './metrics';

/** Minimal logger interface used by all sync services */
export interface SyncLogger {
  warn: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
}

/** Default logger that writes to console (used when no logger is provided) */
export const defaultSyncLogger: SyncLogger = {
  warn: console.warn,
  error: console.error,
  info: console.info,
};

/** Token expiry buffer constants */
export const TOKEN_BUFFER_MS = {
  /** Standard 5-minute buffer for most integrations (Calendar, and any future CRM) */
  STANDARD: 5 * 60 * 1000,
  /** 24-hour buffer for Square (tokens expire in ~30 days) */
  SQUARE: 24 * 60 * 60 * 1000,
} as const;

/** Function that refreshes an access token given a refresh token */
type RefreshFn = (refreshToken: string) => Promise<{ access_token: string; expiry_date: number }>;

/** Base token result shared by all integrations */
export interface TokenResult {
  accessToken: string;
  refreshToken: string;
}

/**
 * Builds a standard sync log prefix: [provider-sync] tenant=UUID
 * Replaces the 5 identical ctx() functions across sync services.
 */
export function syncCtx(
  provider: string,
  tenantId: string,
  entityType?: string,
  action?: string
): string {
  let prefix = `[${provider}-sync] tenant=${tenantId}`;
  if (entityType) prefix += ` entity=${entityType}`;
  if (action) prefix += ` action=${action}`;
  return prefix;
}

/**
 * Generic token refresh logic for integration settings (tenant_integration_settings table).
 *
 * Handles: row locking (FOR UPDATE), expiry check, token refresh, DB update, failure handling.
 *
 * @param pool - Database connection pool
 * @param tenantId - Tenant UUID
 * @param provider - Integration provider name (e.g. 'square')
 * @param refreshFn - Provider-specific token refresh function
 * @param bufferMs - How far before expiry to trigger refresh (default: 5 minutes)
 * @param logger - Optional structured logger
 * @param extraColumns - Additional columns to SELECT (e.g., a provider-specific 'settings' column)
 */
export async function getIntegrationTokens(
  pool: Pool,
  tenantId: string,
  provider: string,
  refreshFn: RefreshFn,
  bufferMs: number = TOKEN_BUFFER_MS.STANDARD,
  logger?: SyncLogger,
  extraColumns?: string
): Promise<{
  accessToken: string;
  refreshToken: string;
  settings: Record<string, unknown> | null;
} | null> {
  const log = logger || defaultSyncLogger;
  const prefix = syncCtx(provider, tenantId);
  const client = await pool.connect();

  // RLS CONTEXT REQUIRED. tenant_integration_settings is tenant-scoped with an
  // isolation policy and no admin bypass, so under a non-bypassing role every
  // read AND the refresh UPDATE below silently match zero rows without it —
  // which reads as "no integration configured" and quietly stops all syncing.
  // See withTenantContext in src/database/index.ts (2026-07-27).
  try {
    return await withTenantContext(client, tenantId, async () => {
      const cols = extraColumns
        ? `access_token, refresh_token, token_expires_at, is_active, ${extraColumns}`
        : 'access_token, refresh_token, token_expires_at, is_active';

      // FOR UPDATE locks the row to prevent concurrent token refresh races
      const res = await client.query(
        `SELECT ${cols} FROM tenant_integration_settings
       WHERE tenant_id = $1 AND provider = $2 FOR UPDATE`,
        [tenantId, provider]
      );

      const row = res.rows[0];
      if (!row) return null;

      if (!row.is_active) {
        log.warn(`${prefix} — skipped: integration inactive (user needs to reconnect)`);
        return null;
      }
      if (!row.access_token || !row.refresh_token) {
        log.warn(`${prefix} — skipped: missing tokens`);
        return null;
      }

      let accessToken = row.access_token;
      const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;

      // Refresh if within buffer period
      if (Date.now() > expiresAt - bufferMs) {
        try {
          const refreshed = await refreshFn(row.refresh_token);
          accessToken = refreshed.access_token;
          await client.query(
            `UPDATE tenant_integration_settings SET access_token = $1, token_expires_at = $2, updated_at = NOW()
           WHERE tenant_id = $3 AND provider = $4`,
            [
              refreshed.access_token,
              new Date(refreshed.expiry_date).toISOString(),
              tenantId,
              provider,
            ]
          );
          log.info(`${prefix} — token refreshed`);
        } catch (err) {
          // Count the failure BEFORE the cleanup UPDATE below — if that
          // UPDATE itself throws (DB outage, permissions, connection drop)
          // the refresh failure must still be counted, or the one moment
          // alerting exists for is exactly the moment it goes silent.
          errorsTotal.inc({ event: 'integration_token_refresh_failed' });
          // Mark inactive so user sees "Reconnect" in dashboard
          await client.query(
            `UPDATE tenant_integration_settings SET is_active = false, updated_at = NOW()
           WHERE tenant_id = $1 AND provider = $2`,
            [tenantId, provider]
          );
          log.error(
            `${prefix} — token refresh FAILED, integration marked inactive (WHO: tenant=${tenantId} | WHAT: refreshAccessToken rejected | WHY: ${provider} OAuth grant likely revoked | HOW: user will see "Reconnect" in dashboard | ERROR: ${String(err)})`
          );
          return null;
        }
      }

      return {
        accessToken,
        refreshToken: row.refresh_token,
        settings: row.settings || null,
      };
    });
  } finally {
    client.release();
  }
}

/**
 * Valid change sources for version tracking.
 * These values are stored in record_versions.change_source
 */
export type ChangeSource =
  'local' | 'square' | 'voice_call' | 'system' | 'google_calendar' | 'outlook_calendar';

/**
 * Sets PostgreSQL session variables for version tracking.
 *
 * The auto_version_trigger in the database reads these values:
 * - app.change_source: identifies the CRM/system making the change
 * - app.changed_by: identifies the user or process (e.g., "sync-square")
 *
 * This function must be called on each connection before making changes
 * that should be tracked with a specific source.
 *
 * @param client - Database client (from pool.connect())
 * @param changeSource - The source of the change (e.g., 'square')
 * @param changedBy - Optional identifier for who/what made the change
 *
 * @example
 * ```typescript
 * const client = await pool.connect();
 * try {
 *   await setSyncContext(client, 'square', 'sync-square');
 *   // All subsequent changes will have change_source='square'
 *   await client.query('UPDATE customers SET name = $1 WHERE customer_id = $2', [name, id]);
 * } finally {
 *   await clearSyncContext(client);
 *   client.release();
 * }
 * ```
 */
export async function setSyncContext(
  client: { query: (sql: string) => Promise<unknown> },
  changeSource: ChangeSource,
  changedBy?: string
): Promise<void> {
  await client.query(`SET LOCAL app.change_source = '${changeSource}'`);
  if (changedBy) {
    await client.query(`SET LOCAL app.changed_by = '${changedBy}'`);
  }
}

/**
 * Clears the sync context session variables.
 * Should be called when done with sync operations (before releasing connection).
 */
export async function clearSyncContext(client: {
  query: (sql: string) => Promise<unknown>;
}): Promise<void> {
  await client.query(`RESET app.change_source`);
  await client.query(`RESET app.changed_by`);
}

/**
 * Wraps a sync operation with proper version tracking context.
 * Automatically sets and clears the context around the operation.
 *
 * @param client - Database client
 * @param changeSource - The source of the change
 * @param changedBy - Optional identifier for who made the change
 * @param operation - Async function to execute with the context set
 *
 * @example
 * ```typescript
 * await withSyncContext(client, 'square', 'sync-square', async () => {
 *   await client.query('INSERT INTO customers ...');
 * });
 * ```
 */
export async function withSyncContext<T>(
  client: { query: (sql: string) => Promise<unknown> },
  changeSource: ChangeSource,
  changedBy: string | undefined,
  operation: () => Promise<T>
): Promise<T> {
  await setSyncContext(client, changeSource, changedBy);
  try {
    return await operation();
  } finally {
    await clearSyncContext(client);
  }
}

/**
 * Refresh-function map keyed by calendar provider name. Lets
 * `getCalendarTokens` pick the right provider's refresh after it reads
 * the row — the caller can't know which provider applies until then,
 * so a single `refreshFn` parameter (the old shape) couldn't actually
 * serve both providers from one call site.
 */
export interface CalendarRefreshMap {
  google: RefreshFn;
  outlook: RefreshFn;
}

/**
 * Token refresh for calendar settings (tenant_calendar_settings table).
 * Separate from integration settings because calendars use a different table.
 *
 * The caller passes refresh functions for both supported providers; this
 * helper reads the row, decides which one to invoke based on the stored
 * provider, and returns a discriminated result. Marks the calendar
 * inactive on refresh failure so the dashboard can surface "Reconnect".
 */
export async function getCalendarTokens(
  pool: Pool,
  tenantId: string,
  refreshMap: CalendarRefreshMap,
  logger?: SyncLogger
): Promise<{
  accessToken: string;
  refreshToken: string;
  calendarId: string;
  provider: 'google' | 'outlook';
} | null> {
  const log = logger || defaultSyncLogger;
  const prefix = `[calendar-sync] tenant=${tenantId}`;
  const client = await pool.connect();

  // RLS CONTEXT REQUIRED — same reasoning as getIntegrationTokens above:
  // tenant_calendar_settings is isolation-only, so without context the SELECT
  // finds nothing and the refresh UPDATE writes nothing, presenting as "no
  // calendar connected" rather than as an error.
  try {
    return await withTenantContext(client, tenantId, async () => {
      // FOR UPDATE locks the row to prevent concurrent token refresh races
      const settingsRes = await client.query(
        `SELECT provider, external_calendar_id, access_token, refresh_token, token_expires_at, is_active
       FROM tenant_calendar_settings WHERE tenant_id = $1
       FOR UPDATE`,
        [tenantId]
      );

      const settings = settingsRes.rows[0];
      if (!settings) return null;
      if (!settings.is_active) {
        log.warn(`${prefix} — skipped: calendar marked inactive`);
        return null;
      }
      if (settings.provider !== 'google' && settings.provider !== 'outlook') {
        log.warn(`${prefix} — skipped: provider="${settings.provider}" not supported`);
        return null;
      }
      if (!settings.access_token || !settings.refresh_token) {
        log.warn(`${prefix} — skipped: missing tokens`);
        return null;
      }

      const provider = settings.provider as 'google' | 'outlook';
      const providerName = provider === 'google' ? 'Google' : 'Outlook';
      const refreshFn = refreshMap[provider];

      let accessToken = settings.access_token;
      const expiresAt = settings.token_expires_at
        ? new Date(settings.token_expires_at).getTime()
        : 0;

      if (Date.now() > expiresAt - TOKEN_BUFFER_MS.STANDARD) {
        try {
          const refreshed = await refreshFn(settings.refresh_token);
          accessToken = refreshed.access_token;
          await client.query(
            `UPDATE tenant_calendar_settings SET access_token = $1, token_expires_at = $2, updated_at = NOW()
           WHERE tenant_id = $3`,
            [refreshed.access_token, new Date(refreshed.expiry_date).toISOString(), tenantId]
          );
          log.info(`${prefix} — ${providerName} token refreshed`);
        } catch (err) {
          // Count first — see the matching comment in getIntegrationTokens above.
          errorsTotal.inc({ event: 'calendar_token_refresh_failed' });
          await client.query(
            `UPDATE tenant_calendar_settings SET is_active = false, updated_at = NOW() WHERE tenant_id = $1`,
            [tenantId]
          );
          log.error(
            `${prefix} — ${providerName} token refresh FAILED, calendar marked inactive (WHO: tenant=${tenantId} | WHAT: refreshAccessToken rejected | WHY: ${providerName} OAuth grant likely revoked | HOW: is_active set to false | ERROR: ${String(err)})`
          );
          return null;
        }
      }

      return {
        accessToken,
        refreshToken: settings.refresh_token,
        calendarId: settings.external_calendar_id,
        provider,
      };
    });
  } finally {
    client.release();
  }
}
