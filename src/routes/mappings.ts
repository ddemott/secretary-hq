import type { AppFastifyInstance } from '../types/fastify';
import type { Pool, PoolClient } from 'pg';
import {
  withHandler,
  logEvent,
  requireTenantId,
  requireOwnerRole,
  type AppRequest,
} from '../middleware/fastify-middleware';
import { requireValidUUID } from './routeHelpers';

export function registerMappingRoutes(
  app: AppFastifyInstance,
  _pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  app.get(
    '/mappings/service-resource',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query('SELECT * FROM service_resource WHERE tenant_id = $1', [tenantId]);
      });
      return reply.send(res.rows);
    }, 'Failed to fetch resource mappings')
  );

  app.get(
    '/mappings/service-employee',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query('SELECT * FROM service_employee WHERE tenant_id = $1', [tenantId]);
      });
      return reply.send(res.rows);
    }, 'Failed to fetch employee mappings')
  );

  app.post(
    '/services/:serviceId/employees/:employeeId/assign',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): relinks staff/resource assignments.
      if (!requireOwnerRole(req, reply)) return;
      const { serviceId, employeeId } = req.params as { serviceId: string; employeeId: string };
      if (!requireValidUUID(serviceId, reply, 'serviceId')) return;
      if (!requireValidUUID(employeeId, reply, 'employeeId')) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      await withTenantClient(tenantId, async (client) => {
        await client.query(
          'INSERT INTO service_employee (service_id, employee_id, tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [serviceId, employeeId, tenantId]
        );
      });

      logEvent(req, 'employee_assigned_to_service', { serviceId, employeeId });
      return reply.send({ success: true });
    }, 'Failed to assign employee to service')
  );

  app.post(
    '/services/:serviceId/employees/:employeeId/unassign',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): relinks staff/resource assignments.
      if (!requireOwnerRole(req, reply)) return;
      const { serviceId, employeeId } = req.params as { serviceId: string; employeeId: string };
      if (!requireValidUUID(serviceId, reply, 'serviceId')) return;
      if (!requireValidUUID(employeeId, reply, 'employeeId')) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      await withTenantClient(tenantId, async (client) => {
        await client.query(
          'DELETE FROM service_employee WHERE service_id = $1 AND employee_id = $2 AND tenant_id = $3',
          [serviceId, employeeId, tenantId]
        );
      });

      logEvent(req, 'employee_unassigned_from_service', { serviceId, employeeId });
      return reply.send({ success: true });
    }, 'Failed to unassign employee')
  );

  app.post(
    '/services/:serviceId/resources/:resourceId/assign',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): relinks staff/resource assignments.
      if (!requireOwnerRole(req, reply)) return;
      const { serviceId, resourceId } = req.params as { serviceId: string; resourceId: string };
      if (!requireValidUUID(serviceId, reply, 'serviceId')) return;
      if (!requireValidUUID(resourceId, reply, 'resourceId')) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      await withTenantClient(tenantId, async (client) => {
        await client.query(
          'INSERT INTO service_resource (service_id, resource_id, tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [serviceId, resourceId, tenantId]
        );
      });

      logEvent(req, 'resource_assigned_to_service', { serviceId, resourceId });
      return reply.send({ success: true });
    }, 'Failed to assign resource to service')
  );

  app.post(
    '/services/:serviceId/resources/:resourceId/unassign',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): relinks staff/resource assignments.
      if (!requireOwnerRole(req, reply)) return;
      const { serviceId, resourceId } = req.params as { serviceId: string; resourceId: string };
      if (!requireValidUUID(serviceId, reply, 'serviceId')) return;
      if (!requireValidUUID(resourceId, reply, 'resourceId')) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      await withTenantClient(tenantId, async (client) => {
        await client.query(
          'DELETE FROM service_resource WHERE service_id = $1 AND resource_id = $2 AND tenant_id = $3',
          [serviceId, resourceId, tenantId]
        );
      });

      logEvent(req, 'resource_unassigned_from_service', { serviceId, resourceId });
      return reply.send({ success: true });
    }, 'Failed to unassign resource')
  );
}
