/**
 * Route-handler tests for src/routes/resources.ts — owner-role gate.
 *
 * WHO:   an owner managing bookable resources (bays/chairs/lines) the AI
 *        agent assigns appointments to.
 * WHAT:  POST /resources/create, POST /resources/:id/update, DELETE
 *        /resources/:id/delete all require `req.auth.role === 'owner'`
 *        (2026-09-16 role-check audit, docs/planning/TODO.md — same
 *        staffing-CRUD gap tracked in PR #508).
 * WHERE: src/routes/resources.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerResourceRoutes } from '../../src/routes/resources';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RESOURCE_ID = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';

let handle: RouteTestAppHandle;
let app: FastifyInstance;

beforeAll(async () => {
  handle = buildRouteTestApp((a, pool, withTenantClient) => {
    registerResourceRoutes(a, pool, withTenantClient);
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

describe('POST /resources/create', () => {
  it('HAPPY: an owner creates a resource', async () => {
    handle.queryResponses.push({
      rows: [{ resource_id: RESOURCE_ID, tenant_id: TENANT_ID, name: 'Bay 1' }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/resources/create',
      payload: { tenant_id: TENANT_ID, name: 'Bay 1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('SECURITY: a front-desk user is rejected 403 before any query runs', async () => {
    setAuth('front_desk');

    const res = await app.inject({
      method: 'POST',
      url: '/resources/create',
      payload: { tenant_id: TENANT_ID, name: 'Bay 1' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);
    expect(dataQueries()).toHaveLength(0);
  });

  it('SECURITY: an unauthenticated request is rejected 401', async () => {
    handle.auth.current = null;

    const res = await app.inject({
      method: 'POST',
      url: '/resources/create',
      payload: { tenant_id: TENANT_ID, name: 'Bay 1' },
    });

    expect(res.statusCode).toBe(401);
    expect(dataQueries()).toHaveLength(0);
  });
});

describe('POST /resources/:id/update', () => {
  it('HAPPY: an owner updates a resource', async () => {
    handle.queryResponses.push({ rows: [{ resource_id: RESOURCE_ID }] });

    const res = await app.inject({
      method: 'POST',
      url: `/resources/${RESOURCE_ID}/update`,
      payload: { name: 'Bay 2' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('SECURITY: a front-desk user is rejected 403 before any query runs', async () => {
    setAuth('front_desk');

    const res = await app.inject({
      method: 'POST',
      url: `/resources/${RESOURCE_ID}/update`,
      payload: { name: 'Bay 2' },
    });

    expect(res.statusCode).toBe(403);
    expect(dataQueries()).toHaveLength(0);
  });
});

describe('DELETE /resources/:id/delete', () => {
  it('HAPPY: an owner deletes a resource', async () => {
    handle.queryResponses.push({ rows: [{ resource_id: RESOURCE_ID }] });

    const res = await app.inject({ method: 'DELETE', url: `/resources/${RESOURCE_ID}/delete` });

    expect(res.statusCode).toBe(200);
  });

  it('SECURITY: a front-desk user is rejected 403 before any query runs', async () => {
    setAuth('front_desk');

    const res = await app.inject({ method: 'DELETE', url: `/resources/${RESOURCE_ID}/delete` });

    expect(res.statusCode).toBe(403);
    expect(dataQueries()).toHaveLength(0);
  });

  it('SECURITY: an unauthenticated request is rejected 401', async () => {
    handle.auth.current = null;

    const res = await app.inject({ method: 'DELETE', url: `/resources/${RESOURCE_ID}/delete` });

    expect(res.statusCode).toBe(401);
    expect(dataQueries()).toHaveLength(0);
  });
});
