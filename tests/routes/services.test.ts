/**
 * Route-handler tests for src/routes/services.ts — owner-role gate.
 *
 * WHO:   an owner managing the service catalog the AI agent books from.
 * WHAT:  POST /services/create, POST /services/:id/update, DELETE
 *        /services/:id/delete all require `req.auth.role === 'owner'`
 *        (2026-09-16 role-check audit, docs/planning/TODO.md) — previously
 *        these routes checked only `requireTenantId`, so a front-desk JWT
 *        could edit the catalog the voice agent offers to every caller.
 * WHERE: src/routes/services.ts.
 * WHY:   service catalog changes are business-configuration, not a
 *        front-desk operation — same root cause as the already-tracked
 *        staffing-CRUD gap (PR #508) and /customers/import's existing gate.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerServiceRoutes } from '../../src/routes/services';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SERVICE_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

let handle: RouteTestAppHandle;
let app: FastifyInstance;

beforeAll(async () => {
  handle = buildRouteTestApp((a, pool, withTenantClient) => {
    registerServiceRoutes(a, pool, withTenantClient);
  });
  app = handle.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function setAuth(role: 'owner' | 'front_desk') {
  handle.auth.current = {
    user_id: '00000000-0000-0000-0000-000000000001',
    tenant_id: TENANT_ID,
    email: `${role}@test.local`,
    role,
  };
}

beforeEach(() => {
  handle.queries.length = 0;
  handle.queryResponses.length = 0;
  handle.tenantIdOverride.current = null;
  setAuth('owner');
});

function dataQueries() {
  return handle.queries.filter(
    (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
  );
}

describe('POST /services/create', () => {
  it('HAPPY: an owner creates a service', async () => {
    handle.queryResponses.push({
      rows: [{ service_id: SERVICE_ID, tenant_id: TENANT_ID, name: 'Oil Change' }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/services/create',
      payload: { tenant_id: TENANT_ID, name: 'Oil Change', duration_minutes: 30 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(dataQueries().some((q) => q.text.includes('INSERT INTO services'))).toBe(true);
  });

  it('SECURITY: a front-desk user is rejected 403 before any query runs', async () => {
    setAuth('front_desk');

    const res = await app.inject({
      method: 'POST',
      url: '/services/create',
      payload: { tenant_id: TENANT_ID, name: 'Oil Change', duration_minutes: 30 },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);
    expect(dataQueries()).toHaveLength(0);
  });

  it('SECURITY: an unauthenticated request is rejected 401', async () => {
    handle.auth.current = null;

    const res = await app.inject({
      method: 'POST',
      url: '/services/create',
      payload: { tenant_id: TENANT_ID, name: 'Oil Change', duration_minutes: 30 },
    });

    expect(res.statusCode).toBe(401);
    expect(dataQueries()).toHaveLength(0);
  });
});

describe('POST /services/:id/update', () => {
  it('HAPPY: an owner updates a service', async () => {
    handle.queryResponses.push({ rows: [{ service_id: SERVICE_ID, name: 'New Name' }] });

    const res = await app.inject({
      method: 'POST',
      url: `/services/${SERVICE_ID}/update`,
      payload: { name: 'New Name' },
    });

    expect(res.statusCode).toBe(200);
    expect(dataQueries().some((q) => q.text.includes('UPDATE services SET'))).toBe(true);
  });

  it('SECURITY: a front-desk user is rejected 403 before any query runs', async () => {
    setAuth('front_desk');

    const res = await app.inject({
      method: 'POST',
      url: `/services/${SERVICE_ID}/update`,
      payload: { name: 'New Name' },
    });

    expect(res.statusCode).toBe(403);
    expect(dataQueries()).toHaveLength(0);
  });
});

describe('DELETE /services/:id/delete', () => {
  it('HAPPY: an owner deletes a service', async () => {
    handle.queryResponses.push({ rows: [] }); // BEGIN
    handle.queryResponses.push({ rows: [] }); // DELETE service_employee
    handle.queryResponses.push({ rows: [] }); // DELETE service_resource
    handle.queryResponses.push({ rows: [{ service_id: SERVICE_ID }] }); // DELETE services
    handle.queryResponses.push({ rows: [] }); // COMMIT

    const res = await app.inject({ method: 'DELETE', url: `/services/${SERVICE_ID}/delete` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
  });

  it('SECURITY: a front-desk user is rejected 403 before any query runs', async () => {
    setAuth('front_desk');

    const res = await app.inject({ method: 'DELETE', url: `/services/${SERVICE_ID}/delete` });

    expect(res.statusCode).toBe(403);
    expect(dataQueries()).toHaveLength(0);
  });

  it('SECURITY: an unauthenticated request is rejected 401', async () => {
    handle.auth.current = null;

    const res = await app.inject({ method: 'DELETE', url: `/services/${SERVICE_ID}/delete` });

    expect(res.statusCode).toBe(401);
    expect(dataQueries()).toHaveLength(0);
  });
});
