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

const CreateEmployeeSchema = z.object({
  tenant_id: z.string().uuid(),
  name: z.string().optional(),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  skills: z.array(z.string()).optional(),
});

const UpdateEmployeeSchema = z.object({
  tenant_id: z.string().uuid().optional(),
  name: z.string().max(200).optional(),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  skills: z.array(z.string()).optional(),
  is_active: z.boolean().optional(),
});

export function registerEmployeeRoutes(
  app: AppFastifyInstance,
  _pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  app.get(
    '/employees',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `
        SELECT employee_id::text AS employee_id, name, first_name, last_name, email, phone, skills, is_active, 'employee' as type,
               is_auto_seeded
        FROM employees WHERE tenant_id = $1 AND is_deleted = false
        UNION ALL
        SELECT user_id::text as employee_id, COALESCE(full_name, email) as name, NULL as first_name, NULL as last_name, email, NULL as phone, '{}'::text[] as skills, true as is_active, 'user' as type,
               false AS is_auto_seeded
        FROM users WHERE tenant_id = $1
        ORDER BY name ASC
      `,
          [tenantId]
        );
      });
      return reply.send(res.rows);
    }, 'Failed to fetch employees')
  );

  app.post(
    '/employees/create',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): staffing CRUD, PR #508/TODO.md.
      if (!requireOwnerRole(req, reply)) return;
      const parsed = CreateEmployeeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const body = parsed.data;
      const firstName = body.first_name || body.name || '';
      const lastName = body.last_name || '';
      const displayName = [firstName, lastName].filter(Boolean).join(' ');

      // Guard against accidentally creating a second ACTIVE employee with the
      // same name in one tenant (the "duplicate Dale DeMott" prod case). We
      // match on the normalized name among non-deleted rows only, so re-adding
      // someone you previously soft-deleted is still allowed, and a soft-deleted
      // twin never blocks a legit create. Blank names skip the check (a nameless
      // employee is a form quirk, not a duplicate). NOTE: the check and the
      // INSERT below run on two SEPARATE pooled connections (two withTenantClient
      // calls), so there is a small TOCTOU window — two simultaneous creates of
      // the same name could both pass. That's acceptable for a soft guardrail
      // against accidental duplicates: a genuine two-people-same-name case is
      // rare and the owner can disambiguate the display name (e.g. "Dale D."), so
      // a soft 409 is preferred over a hard UNIQUE index (which would race-safely
      // block the duplicate but also reject legit namesakes and couldn't be
      // applied while prod still holds the existing duplicate).
      const conflict = await withTenantClient(body.tenant_id, async (client) => {
        if (displayName.trim()) {
          const dup = await client.query(
            `SELECT 1 FROM employees
             WHERE tenant_id = $1 AND is_deleted = false
               AND LOWER(TRIM(name)) = LOWER(TRIM($2))
             LIMIT 1`,
            [body.tenant_id, displayName]
          );
          if (dup.rows.length > 0) return true;
        }
        return false;
      });
      if (conflict) {
        return reply.status(409).send({
          success: false,
          error: `An active employee named "${displayName}" already exists for this business. Use a more specific name to tell them apart, or restore the existing record.`,
        });
      }

      const res = await withTenantClient(body.tenant_id, async (client) => {
        return client.query(
          'INSERT INTO employees (tenant_id, name, first_name, last_name, email, phone, skills) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
          [
            body.tenant_id,
            displayName,
            firstName,
            lastName,
            body.email || null,
            body.phone || null,
            body.skills || [],
          ]
        );
      });

      logEvent(req, 'employee_created', { employeeId: res.rows[0].employee_id, name: displayName });
      return reply.send({ success: true, employee: res.rows[0] });
    }, 'Failed to create employee')
  );

  app.delete(
    '/employees/:id/delete',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): staffing CRUD, PR #508/TODO.md.
      if (!requireOwnerRole(req, reply)) return;
      const id = (req.params as { id: string }).id;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `UPDATE employees SET is_deleted = true, deleted_at = NOW(), is_active = false, updated_at = NOW()
         WHERE employee_id = $1 AND tenant_id = $2 RETURNING employee_id`,
          [id, tenantId]
        );
      });
      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Employee not found' });
      }

      logEvent(req, 'employee_deleted', { employeeId: id });
      return reply.send({ success: true });
    }, 'Failed to delete employee')
  );

  app.post(
    '/employees/:id/update',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): staffing CRUD, PR #508/TODO.md.
      if (!requireOwnerRole(req, reply)) return;
      const id = (req.params as { id: string }).id;
      const parsed = UpdateEmployeeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const body = parsed.data;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      // Recompute display name if first/last provided
      const displayName =
        body.first_name !== undefined || body.last_name !== undefined
          ? [body.first_name, body.last_name].filter(Boolean).join(' ') || body.name
          : body.name;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `UPDATE employees SET
          name = COALESCE($1, name),
          first_name = COALESCE($2, first_name),
          last_name = COALESCE($3, last_name),
          email = COALESCE($4, email),
          phone = COALESCE($5, phone),
          skills = COALESCE($6, skills),
          is_active = COALESCE($7, is_active),
          -- An owner edit claims a template placeholder ("Technician 1" →
          -- "Maria"): it is theirs now, so a business-type switch keeps it.
          is_auto_seeded = false,
          updated_at = NOW()
        WHERE employee_id = $8 AND tenant_id = $9 RETURNING *`,
          [
            displayName,
            body.first_name,
            body.last_name,
            body.email,
            body.phone,
            body.skills,
            body.is_active,
            id,
            tenantId,
          ]
        );
      });
      if (!assertRowAffected(res, reply, 'Employee')) return;

      logEvent(req, 'employee_updated', { employeeId: id });
      return reply.send({ success: true, employee: res.rows[0] });
    }, 'Failed to update employee')
  );
}
