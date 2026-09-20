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
import { assertRowAffected } from './routeHelpers';

const CreateServiceSchema = z.object({
  tenant_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  subtitle: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  duration_minutes: z.number().int().min(5).max(480),
  required_skills: z.array(z.string()).optional(),
  required_resources: z.array(z.string()).optional(),
  // True only for rows created by the setup-wizard's auto-seed pass.
  // Lets POST /tenants/:id/update-config delete just the template
  // defaults when the owner picks a new business_type, without
  // touching anything they typed themselves. See migration
  // 20260528000000_is_auto_seeded_flag.sql.
  is_auto_seeded: z.boolean().optional(),
});

const UpdateServiceSchema = z.object({
  tenant_id: z.string().uuid().optional(),
  name: z.string().min(1).max(200).optional(),
  subtitle: z.string().max(200).optional().nullable(),
  description: z.string().max(1000).optional().nullable(),
  duration_minutes: z.number().int().min(5).max(480).optional(),
  price: z.number().min(0).optional().nullable(),
});

export function registerServiceRoutes(
  app: AppFastifyInstance,
  _pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  // GET /services/catalog?tenant_id=X — public-facing service list for AI callers (Layer 1: database facts)
  app.get(
    '/services/catalog',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `SELECT service_id, name, subtitle, description, duration_minutes, price
         FROM services WHERE tenant_id = $1 AND is_deleted = false ORDER BY name ASC`,
          [tenantId]
        );
      });
      return reply.send({ services: res.rows });
    }, 'Failed to fetch service catalog')
  );

  app.get(
    '/services',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          'SELECT * FROM services WHERE tenant_id = $1 AND is_deleted = false ORDER BY name ASC',
          [tenantId]
        );
      });
      return reply.send(res.rows);
    }, 'Failed to fetch services')
  );

  app.post(
    '/services/create',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): service catalog changes
      // affect what the AI agent offers to every caller.
      if (!requireOwnerRole(req, reply)) return;
      const parsed = CreateServiceSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const body = parsed.data;

      const res = await withTenantClient(body.tenant_id, async (client) => {
        return client.query(
          'INSERT INTO services (tenant_id, name, subtitle, description, duration_minutes, required_skills, required_resources, is_auto_seeded) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
          [
            body.tenant_id,
            body.name,
            body.subtitle || '',
            body.description || '',
            body.duration_minutes,
            body.required_skills || [],
            body.required_resources || [],
            body.is_auto_seeded === true,
          ]
        );
      });

      logEvent(req, 'service_created', { serviceId: res.rows[0].service_id, name: body.name });
      return reply.send({ success: true, service: res.rows[0] });
    }, 'Failed to create service')
  );

  app.post(
    '/services/:id/update',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): service catalog changes
      // affect what the AI agent offers to every caller.
      if (!requireOwnerRole(req, reply)) return;
      const { id } = req.params as { id: string };
      const parsed = UpdateServiceSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const body = parsed.data;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        // Any edit promotes an auto-seeded row to "owned by user" by
        // clearing is_auto_seeded. Without this, a later business_type
        // change would still wipe the row even though the owner
        // customized it (name, price, duration, etc.). 2026-05-28.
        return client.query(
          'UPDATE services SET name = COALESCE($1, name), subtitle = COALESCE($2, subtitle), description = COALESCE($3, description), duration_minutes = COALESCE($4, duration_minutes), price = COALESCE($5, price), is_auto_seeded = false, updated_at = NOW() WHERE service_id = $6 AND tenant_id = $7 RETURNING *',
          [
            body.name,
            body.subtitle,
            body.description,
            body.duration_minutes,
            body.price,
            id,
            tenantId,
          ]
        );
      });
      if (!assertRowAffected(res, reply, 'Service')) return;

      logEvent(req, 'service_updated', { serviceId: id });
      return reply.send({ success: true, service: res.rows[0] });
    }, 'Failed to update service')
  );

  app.delete(
    '/services/:id/delete',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): service catalog changes
      // affect what the AI agent offers to every caller.
      if (!requireOwnerRole(req, reply)) return;
      const { id } = req.params as { id: string };
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        // Wrap in transaction to ensure atomicity
        await client.query('BEGIN');
        try {
          // Remove mappings first, then delete the service
          await client.query('DELETE FROM service_employee WHERE service_id = $1', [id]);
          await client.query('DELETE FROM service_resource WHERE service_id = $1', [id]);
          const deleteRes = await client.query(
            'DELETE FROM services WHERE service_id = $1 AND tenant_id = $2 RETURNING service_id',
            [id, tenantId]
          );
          await client.query('COMMIT');
          return deleteRes;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      });
      if (!assertRowAffected(res, reply, 'Service')) return;

      logEvent(req, 'service_deleted', { serviceId: id });
      return reply.send({ success: true });
    }, 'Failed to delete service')
  );
}
