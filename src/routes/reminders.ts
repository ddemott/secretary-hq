/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

/**
 * Reminders API Routes
 *
 * Endpoints for managing appointment reminders.
 * Routes:
 *   GET  /reminders           - List scheduled reminders for tenant
 *   POST /reminders/:id/trigger - Manually trigger a reminder
 *   DELETE /reminders/:id     - Cancel a reminder
 *   GET  /reminders/status    - Get scheduler status (super-admin only)
 *   POST /reminders/process   - Run the due-reminder batch now (super-admin only)
 */

import type { AppFastifyInstance } from '../types/fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  withHandler,
  requireTenantId,
  requireSuperAdmin,
  type AppRequest,
} from '../middleware/fastify-middleware';
import { createDatabaseService } from '../database/index.js';
import { ReminderService } from '../services/reminders/index.js';
import { createTenantConfigService } from '../services/tenants/index.js';
import { getSchedulerStatus, processRemindersNow } from '../workers/reminderScheduler.js';

// ── Validation Schemas ───────────────────────────────────────────────

const ReminderIdSchema = z.object({
  id: z.string().min(1),
});

const ReminderQuerySchema = z.object({
  status: z.enum(['scheduled', 'sent', 'failed', 'cancelled']).optional(),
  limit: z.coerce.number().min(1).max(100).optional().default(50),
  offset: z.coerce.number().min(0).optional().default(0),
});

// ── Route Registration ───────────────────────────────────────────────

export function registerReminderRoutes(
  app: AppFastifyInstance,
  pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  const db = createDatabaseService(pool);
  const configService = createTenantConfigService(pool);
  const reminderService = new ReminderService(db, configService);

  /**
   * GET /reminders - List scheduled reminders for tenant
   */
  app.get(
    '/reminders',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = ReminderQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid query parameters',
          details: parsed.error.issues,
        });
      }

      const { status, limit, offset } = parsed.data;

      const reminders = await withTenantClient(tenantId, async (client) => {
        let query = `
        SELECT rs.*, a.start_time as appointment_time, a.description as appointment_description
        FROM reminder_schedules rs
        LEFT JOIN appointments a ON rs.appointment_id = a.appointment_id
        WHERE rs.tenant_id = $1
      `;
        const params: unknown[] = [tenantId];

        if (status) {
          query += ` AND rs.status = $${params.length + 1}`;
          params.push(status);
        }

        query += ` ORDER BY rs.scheduled_for DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const result = await client.query(query, params);
        return result.rows;
      });

      // Get total count
      const total = await withTenantClient(tenantId, async (client) => {
        let query = 'SELECT COUNT(*) FROM reminder_schedules WHERE tenant_id = $1';
        const params: unknown[] = [tenantId];

        if (status) {
          query += ' AND status = $2';
          params.push(status);
        }

        const result = await client.query(query, params);
        return parseInt(result.rows[0].count, 10);
      });

      return reply.send({
        success: true,
        reminders,
        total,
        limit,
        offset,
      });
    }, 'Failed to list reminders')
  );

  /**
   * POST /reminders/:id/trigger - Manually trigger a reminder
   */
  app.post(
    '/reminders/:id/trigger',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = ReminderIdSchema.safeParse(req.params);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid reminder ID',
        });
      }

      const { id } = parsed.data;

      // Verify reminder belongs to tenant
      const reminder = await withTenantClient(tenantId, async (client) => {
        const result = await client.query(
          'SELECT * FROM reminder_schedules WHERE reminder_schedule_id = $1 AND tenant_id = $2',
          [id, tenantId]
        );
        return result.rows[0];
      });

      if (!reminder) {
        return reply.status(404).send({
          success: false,
          error: 'Reminder not found',
        });
      }

      if (reminder.status !== 'scheduled') {
        return reply.status(400).send({
          success: false,
          error: `Cannot trigger reminder with status '${reminder.status}'`,
        });
      }

      // Trigger the reminder
      const triggered = await reminderService.triggerReminder(id);

      if (triggered) {
        return reply.send({
          success: true,
          message: 'Reminder triggered successfully',
        });
      } else {
        return reply.status(500).send({
          success: false,
          error: 'Failed to trigger reminder',
        });
      }
    }, 'Failed to trigger reminder')
  );

  /**
   * DELETE /reminders/:id - Cancel a reminder
   */
  app.delete(
    '/reminders/:id',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = ReminderIdSchema.safeParse(req.params);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid reminder ID',
        });
      }

      const { id } = parsed.data;

      // Verify reminder belongs to tenant and cancel it
      const result = await withTenantClient(tenantId, async (client) => {
        const check = await client.query(
          'SELECT * FROM reminder_schedules WHERE reminder_schedule_id = $1 AND tenant_id = $2',
          [id, tenantId]
        );

        if (check.rows.length === 0) {
          return { found: false };
        }

        if (check.rows[0].status !== 'scheduled') {
          return { found: true, alreadyProcessed: true, status: check.rows[0].status };
        }

        await client.query(
          `UPDATE reminder_schedules
         SET status = 'cancelled', updated_at = NOW()
         WHERE reminder_schedule_id = $1`,
          [id]
        );

        return { found: true, cancelled: true };
      });

      if (!result.found) {
        return reply.status(404).send({
          success: false,
          error: 'Reminder not found',
        });
      }

      if (result.alreadyProcessed) {
        return reply.status(400).send({
          success: false,
          error: `Cannot cancel reminder with status '${result.status}'`,
        });
      }

      return reply.send({
        success: true,
        message: 'Reminder cancelled',
      });
    }, 'Failed to cancel reminder')
  );

  /**
   * GET /reminders/delivery-stats - Owner-facing delivery monitoring stats (sent/failed/scheduled/cancelled counts by status + recency buckets).
   * Uses table aggregates (tenant-isolated) rather than global in-memory metrics so owners see *their* numbers.
   * Powers the reminder delivery monitoring view.
   */
  app.get(
    '/reminders/delivery-stats',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const stats = await withTenantClient(tenantId, async (client) => {
        const result = await client.query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_total,
             COUNT(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '7 days')::int AS sent_7d,
             COUNT(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '30 days')::int AS sent_30d,
             COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_total,
             COUNT(*) FILTER (WHERE status = 'failed' AND updated_at > now() - interval '7 days')::int AS failed_7d,
             COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
             COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
           FROM reminder_schedules
           WHERE tenant_id = $1`,
          [tenantId]
        );
        return (
          result.rows[0] || {
            sent_total: 0,
            sent_7d: 0,
            sent_30d: 0,
            failed_total: 0,
            failed_7d: 0,
            scheduled: 0,
            cancelled: 0,
          }
        );
      });

      return reply.send(stats);
    }, 'Failed to load reminder delivery stats')
  );

  /**
   * GET /reminders/status - Get scheduler status (admin only)
   */
  app.get(
    '/reminders/status',
    withHandler(async (req: AppRequest, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      const status = getSchedulerStatus();

      return reply.send({
        success: true,
        scheduler: status,
      });
    }, 'Failed to get scheduler status')
  );

  /**
   * POST /reminders/process - Manually process due reminders (admin only)
   */
  app.post(
    '/reminders/process',
    withHandler(async (req: AppRequest, reply) => {
      // Runs the due-reminder batch across EVERY tenant, not just the caller's.
      if (!requireSuperAdmin(req, reply)) return;
      const processed = await processRemindersNow();

      return reply.send({
        success: true,
        processed,
      });
    }, 'Failed to process reminders')
  );
}
