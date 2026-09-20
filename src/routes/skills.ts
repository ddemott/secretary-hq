/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

import type { AppFastifyInstance } from '../types/fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  withHandler,
  logEvent,
  requireTenantId,
  requireOwnerRole,
  type AppRequest,
} from '../middleware/fastify-middleware';
import { slugify } from '../../shared/name';

const CreateSkillSchema = z.object({
  tenant_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
});

export function registerSkillRoutes(
  app: AppFastifyInstance,
  _pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  app.get(
    '/skills',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query('SELECT * FROM tenant_skills WHERE tenant_id = $1 ORDER BY name', [
          tenantId,
        ]);
      });
      return reply.send(res.rows);
    }, 'Failed to fetch master skills')
  );

  app.post(
    '/skills/create',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): staffing/skill setup.
      if (!requireOwnerRole(req, reply)) return;
      const parsed = CreateSkillSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const body = parsed.data;

      const res = await withTenantClient(body.tenant_id, async (client) => {
        return client.query(
          'INSERT INTO tenant_skills (tenant_id, name, description) VALUES ($1, $2, $3) RETURNING *',
          [body.tenant_id, slugify(body.name), body.description]
        );
      });

      logEvent(req, 'skill_created', { tenantId: body.tenant_id, name: res.rows[0].name });
      return reply.send({ success: true, skill: res.rows[0] });
    }, 'Failed to create skill')
  );

  // 2026-05-18 composite-key retrofit pilot #2: route param is the skill
  // slug (the stored `name` column) instead of the dropped surrogate
  // UUID. Names are normalized to lowercase + dashes at INSERT time so
  // they're URL-safe by construction.
  app.delete(
    '/skills/:name',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): staffing/skill setup.
      if (!requireOwnerRole(req, reply)) return;
      const { name } = req.params as { name: string };
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          'DELETE FROM tenant_skills WHERE tenant_id = $1 AND name = $2 RETURNING name',
          [tenantId, name]
        );
      });

      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Skill not found' });
      }

      logEvent(req, 'skill_deleted', { tenantId, name });
      return reply.send({ success: true });
    }, 'Failed to delete skill')
  );
}
