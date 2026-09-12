/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

import type { FastifyReply } from 'fastify';
import type { AppFastifyInstance } from '../types/fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  withHandler,
  logEvent,
  requireTenantId,
  type AppRequest,
} from '../middleware/fastify-middleware';
import * as gcal from '../services/googleCalendar';
import * as outlook from '../services/outlookCalendar';
import { errorsTotal } from '../services/metrics';

const CalendarSettingsSchema = z.object({
  tenant_id: z.string().uuid().optional(),
  provider: z.string().min(1).max(50),
  external_calendar_id: z.string().min(1).max(500),
});

export function registerCalendarRoutes(
  app: AppFastifyInstance,
  pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  // --- Google OAuth: Initiate ---
  app.get(
    '/calendar/auth/google',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      if (!gcal.isGoogleCalendarEnabled()) {
        return reply.status(503).send({
          success: false,
          error:
            'Google Calendar integration is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CALLBACK_URL.',
        });
      }

      const url = gcal.getAuthUrl(tenantId);
      if (!url) {
        return reply.status(500).send({ success: false, error: 'Failed to generate auth URL' });
      }

      logEvent(req, 'calendar_oauth_initiated', { provider: 'google' });
      return reply.send({ url });
    }, 'Failed to initiate Google Calendar auth')
  );

  // --- Google OAuth: Callback (Google redirects here) ---
  // This route is public (no JWT) — auth is via the signed state param
  app.get('/calendar/auth/google/callback', async (req: AppRequest, reply: FastifyReply) => {
    const { code, state, error: oauthError } = req.query as Record<string, string>;

    const dashboardUrl = process.env.DASHBOARD_URL || 'https://localhost:4000';

    if (oauthError) {
      return reply.redirect(
        `${dashboardUrl}/dashboard?calendarError=${encodeURIComponent(oauthError)}`
      );
    }

    if (!code || !state) {
      return reply.redirect(`${dashboardUrl}/dashboard?calendarError=missing_params`);
    }

    // Verify state (CSRF protection)
    const tenantId = gcal.verifyState(state);
    if (!tenantId) {
      return reply.redirect(`${dashboardUrl}/dashboard?calendarError=invalid_state`);
    }

    try {
      // Exchange code for tokens
      const tokens = await gcal.exchangeCodeForTokens(code);

      // Store tokens in DB (direct pool query — no RLS context needed for service-level write)
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO tenant_calendar_settings
             (tenant_id, provider, external_calendar_id, access_token, refresh_token, token_expires_at, is_active)
           VALUES ($1, 'google', 'primary', $2, $3, $4, true)
           ON CONFLICT (tenant_id) DO UPDATE SET
             provider = 'google',
             external_calendar_id = 'primary',
             access_token = $2,
             refresh_token = $3,
             token_expires_at = $4,
             is_active = true,
             updated_at = NOW()`,
          [
            tenantId,
            tokens.access_token,
            tokens.refresh_token,
            new Date(tokens.expiry_date).toISOString(),
          ]
        );
      } finally {
        client.release();
      }

      app.log.info(
        { event: 'calendar_oauth_complete', tenantId, provider: 'google' },
        'Google Calendar connected'
      );
      return reply.redirect(`${dashboardUrl}/dashboard?calendarConnected=true`);
    } catch (err) {
      errorsTotal.inc({ event: 'calendar_oauth_failed' });
      app.log.error(
        { event: 'calendar_oauth_failed', tenantId, error: (err as Error).message },
        'Google Calendar OAuth failed'
      );
      return reply.redirect(`${dashboardUrl}/dashboard?calendarError=token_exchange_failed`);
    }
  });

  // --- Outlook OAuth: Initiate ---
  app.get(
    '/calendar/auth/outlook',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      if (!outlook.isOutlookCalendarEnabled()) {
        return reply.status(503).send({
          success: false,
          error:
            'Outlook Calendar integration is not configured. Set OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, and OUTLOOK_CALLBACK_URL.',
        });
      }

      const url = outlook.getAuthUrl(tenantId);
      if (!url) {
        return reply.status(500).send({ success: false, error: 'Failed to generate auth URL' });
      }

      logEvent(req, 'calendar_oauth_initiated', { provider: 'outlook' });
      return reply.send({ url });
    }, 'Failed to initiate Outlook Calendar auth')
  );

  // --- Outlook OAuth: Callback (Microsoft redirects here) ---
  // This route is public (no JWT) — auth is via the signed state param
  app.get('/calendar/auth/outlook/callback', async (req: AppRequest, reply: FastifyReply) => {
    const { code, state, error: oauthError } = req.query as Record<string, string>;

    const dashboardUrl = process.env.DASHBOARD_URL || 'https://localhost:4000';

    if (oauthError) {
      return reply.redirect(
        `${dashboardUrl}/dashboard?calendarError=${encodeURIComponent(oauthError)}`
      );
    }

    if (!code || !state) {
      return reply.redirect(`${dashboardUrl}/dashboard?calendarError=missing_params`);
    }

    // Verify state (CSRF protection)
    const tenantId = outlook.verifyState(state);
    if (!tenantId) {
      return reply.redirect(`${dashboardUrl}/dashboard?calendarError=invalid_state`);
    }

    try {
      // Exchange code for tokens
      const tokens = await outlook.exchangeCodeForTokens(code);

      // Store tokens in DB (direct pool query — no RLS context needed for service-level write)
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO tenant_calendar_settings
             (tenant_id, provider, external_calendar_id, access_token, refresh_token, token_expires_at, is_active)
           VALUES ($1, 'outlook', 'primary', $2, $3, $4, true)
           ON CONFLICT (tenant_id) DO UPDATE SET
             provider = 'outlook',
             external_calendar_id = 'primary',
             access_token = $2,
             refresh_token = $3,
             token_expires_at = $4,
             is_active = true,
             updated_at = NOW()`,
          [
            tenantId,
            tokens.access_token,
            tokens.refresh_token,
            new Date(tokens.expiry_date).toISOString(),
          ]
        );
      } finally {
        client.release();
      }

      app.log.info(
        { event: 'calendar_oauth_complete', tenantId, provider: 'outlook' },
        'Outlook Calendar connected'
      );
      return reply.redirect(`${dashboardUrl}/dashboard?calendarConnected=true`);
    } catch (err) {
      errorsTotal.inc({ event: 'calendar_oauth_failed' });
      app.log.error(
        { event: 'calendar_oauth_failed', tenantId, error: (err as Error).message },
        'Outlook Calendar OAuth failed'
      );
      return reply.redirect(`${dashboardUrl}/dashboard?calendarError=token_exchange_failed`);
    }
  });

  // --- Calendar sync webhook (n8n or internal trigger) ---
  app.post(
    '/calendar/sync',
    withHandler(async (req: AppRequest, reply) => {
      const body = req.body as { provider?: string } | undefined;
      return reply.status(202).send({ status: 'accepted', source: body?.provider || 'unknown' });
    }, 'Failed to sync calendar')
  );

  // --- Get calendar settings (strip tokens!) ---
  app.get(
    '/calendar/settings',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `SELECT tenant_id, provider, external_calendar_id, is_active, token_expires_at, created_at, updated_at
         FROM tenant_calendar_settings WHERE tenant_id = $1`,
          [tenantId]
        );
      });
      return reply.send(res.rows[0] || null);
    }, 'Failed to fetch calendar settings')
  );

  // --- Save calendar settings (manual, non-OAuth) ---
  app.post(
    '/calendar/settings',
    withHandler(async (req: AppRequest, reply) => {
      const parsed = CalendarSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const body = parsed.data;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `INSERT INTO tenant_calendar_settings (tenant_id, provider, external_calendar_id, is_active)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (tenant_id)
         DO UPDATE SET provider = $2, external_calendar_id = $3, is_active = true, updated_at = NOW()
         RETURNING tenant_id, provider, external_calendar_id, is_active, created_at, updated_at`,
          [tenantId, body.provider, body.external_calendar_id]
        );
      });

      logEvent(req, 'calendar_settings_updated', { provider: body.provider });
      return reply.send({ success: true, settings: res.rows[0] });
    }, 'Failed to update calendar settings')
  );

  // --- Disconnect calendar ---
  app.post(
    '/calendar/settings/disconnect',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      // Best-effort token revocation before deleting
      const settingsRes = await withTenantClient(tenantId, async (client) => {
        return client.query(
          'SELECT access_token, provider FROM tenant_calendar_settings WHERE tenant_id = $1',
          [tenantId]
        );
      });
      const existing = settingsRes.rows[0];
      if (existing?.access_token) {
        if (existing.provider === 'google') {
          await gcal.revokeToken(existing.access_token);
        } else if (existing.provider === 'outlook') {
          await outlook.revokeToken(existing.access_token);
        }
      }

      await withTenantClient(tenantId, async (client) => {
        await client.query('DELETE FROM tenant_calendar_settings WHERE tenant_id = $1', [tenantId]);
      });

      logEvent(req, 'calendar_disconnected', {});
      return reply.send({ success: true });
    }, 'Failed to disconnect calendar')
  );
}
