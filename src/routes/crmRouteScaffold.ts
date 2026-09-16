/**
 * Shared route scaffold for CRM OAuth providers.
 *
 * Each CRM provider (Square today; Jobber/HubSpot/ServiceTitan were removed
 * 2026-06-12 as competitors — see docs/STRATEGY.md) exposes the same
 * six HTTP endpoints:
 *   GET  /<provider>/auth               — initiate OAuth
 *   GET  /<provider>/auth/callback      — OAuth callback
 *   GET  /<provider>/settings           — fetch settings (no tokens)
 *   POST /<provider>/settings/disconnect — disconnect + clear sync map
 *   POST /<provider>/sync               — trigger full sync
 *   GET  /<provider>/sync/status        — aggregate sync counts
 *
 * Provider-specific webhooks stay in each provider's route file — they
 * have different header names, signature algorithms, tenant-lookup
 * strategies, and event shapes that make a shared abstraction harmful.
 *
 * Usage:
 *   registerCrmScaffoldRoutes(app, pool, withTenantClient, {
 *     provider: 'square',
 *     displayName: 'Square',
 *     isEnabled: squareClient.isSquareEnabled,
 *     getAuthUrl: squareClient.getAuthUrl,
 *     verifyState: squareClient.verifyState,
 *     exchangeCodeForTokens: squareClient.exchangeCodeForTokens,
 *     fullSync: (pool, tenantId) => squareSync.fullSync(pool, tenantId),
 *   });
 */

import type { Pool, PoolClient } from 'pg';
import type { AppFastifyInstance } from '../types/fastify';
import {
  withHandler,
  logEvent,
  requireTenantId,
  requireOwnerRole,
  type AppRequest,
} from '../middleware/fastify-middleware';
import { createOAuthCallbackHandler } from '../services/oauthCallbackFactory';
import { getCrmSyncStatus } from '../services/crmSyncStatus';
import { disconnectCrmIntegration, type CrmProvider } from '../services/crmDisconnect';

export interface CrmRouteConfig {
  /** Short provider key used in DB + URL prefix (e.g. 'square') */
  provider: CrmProvider;
  /** Human-readable label for error messages (e.g. 'Square') */
  displayName: string;
  /** Returns false when required env vars are absent */
  isEnabled: () => boolean;
  /** Returns OAuth initiation URL, or null when not configured */
  getAuthUrl: (tenantId: string) => string | null;
  /** Verify OAuth state JWT; returns tenantId string or null */
  verifyState: (state: string) => string | null;
  /** Exchange auth code for tokens (code only — tenantId comes from verifyState) */
  exchangeCodeForTokens: (
    code: string
  ) => Promise<{ access_token: string; refresh_token: string; expiry_date: number }>;
  /** Run a full bidirectional sync; returns metadata spread into the response body */
  fullSync: (pool: Pool, tenantId: string) => Promise<Record<string, unknown>>;
  /** Optional extra query params to store in integration settings JSONB (a provider-specific id captured at connect time) */
  buildExtraSettings?: (query: Record<string, string>) => Record<string, unknown> | null;
}

export function registerCrmScaffoldRoutes(
  app: AppFastifyInstance,
  pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>,
  config: CrmRouteConfig
): void {
  const { provider, displayName } = config;

  // GET /<provider>/auth — initiate OAuth
  app.get(
    `/${provider}/auth`,
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      // Owner-only (mirrors billing.ts's checkout/portal and
      // provisioning.ts's activate/deactivate): connecting a real external
      // OAuth account is a business-configuration decision, not front-desk.
      if (!requireOwnerRole(req, reply)) return;

      if (!config.isEnabled()) {
        return reply.status(503).send({
          success: false,
          error: `${displayName} integration is not configured.`,
        });
      }

      const url = config.getAuthUrl(tenantId);
      if (!url) {
        return reply
          .status(500)
          .send({ success: false, error: `Failed to generate ${displayName} auth URL` });
      }

      logEvent(req, `${provider}_oauth_initiated`, {});
      return reply.send({ success: true, authUrl: url });
    }, `Failed to initiate ${displayName} auth`)
  );

  // GET /<provider>/auth/callback — OAuth callback
  app.get(
    `/${provider}/auth/callback`,
    createOAuthCallbackHandler(pool, app, {
      provider,
      verifyState: config.verifyState,
      exchangeCodeForTokens: config.exchangeCodeForTokens,
      ...(config.buildExtraSettings ? { buildExtraSettings: config.buildExtraSettings } : {}),
    })
  );

  // GET /<provider>/settings — fetch settings row (no token columns)
  app.get(
    `/${provider}/settings`,
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `SELECT tenant_id, provider, is_active, last_sync_at, created_at, updated_at
           FROM tenant_integration_settings WHERE tenant_id = $1 AND provider = $2`,
          [tenantId, provider]
        );
      });
      return reply.send(res.rows[0] || null);
    }, `Failed to fetch ${displayName} settings`)
  );

  // POST /<provider>/settings/disconnect — clear tokens + sync map
  app.post(
    `/${provider}/settings/disconnect`,
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      // Owner-only: disconnecting a real external OAuth account.
      if (!requireOwnerRole(req, reply)) return;

      await withTenantClient(tenantId, (client) =>
        disconnectCrmIntegration(client, tenantId, provider)
      );

      logEvent(req, `${provider}_disconnected`, {});
      return reply.send({ success: true });
    }, `Failed to disconnect ${displayName}`)
  );

  // POST /<provider>/sync — trigger full sync
  app.post(
    `/${provider}/sync`,
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      // Owner-only: triggers a full bidirectional sync with a real external system.
      if (!requireOwnerRole(req, reply)) return;

      const result = await config.fullSync(pool, tenantId);
      return reply.send({ success: true, ...result });
    }, `Failed to trigger ${displayName} sync`)
  );

  // GET /<provider>/sync/status — aggregate counts
  app.get(
    `/${provider}/sync/status`,
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, (client) =>
        getCrmSyncStatus(client, tenantId, provider)
      );
      return reply.send(res);
    }, `Failed to get ${displayName} sync status`)
  );
}
