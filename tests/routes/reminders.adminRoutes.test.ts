/**
 * WHO:   POST /reminders/process, GET /reminders/status
 * WHAT:  platform-operator-only controls for the reminder scheduler
 * WHEN:  an operator manually kicks the due-reminder batch or reads scheduler state
 * WHERE: src/routes/reminders.ts
 * WHY:   both routes were documented "admin only" but checked nothing — any
 *        authenticated tenant login (incl. front_desk) could run the batch that
 *        sends reminders for EVERY tenant. The dashboard never calls either.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/workers/reminderScheduler.js', () => ({
  processRemindersNow: vi.fn(async () => 7),
  getSchedulerStatus: vi.fn(() => ({ running: true })),
}));

import { registerReminderRoutes } from '../../src/routes/reminders';
import { processRemindersNow } from '../../src/workers/reminderScheduler.js';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SUPER_ADMIN_TENANT_ID = '00000000-0000-0000-0000-000000000000';

let handle: RouteTestAppHandle;
let app: FastifyInstance;

beforeAll(async () => {
  handle = buildRouteTestApp((a, pool, withTenantClient) => {
    registerReminderRoutes(a, pool, withTenantClient);
  });
  app = handle.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.mocked(processRemindersNow).mockClear();
});

const tenantAuth = (role: 'owner' | 'front_desk') => ({
  tenant_id: TENANT_ID,
  user_id: 'u-1',
  email: 'user@test.local',
  role,
});

describe.each([
  ['POST', '/reminders/process'],
  ['GET', '/reminders/status'],
] as const)('%s %s', (method, url) => {
  it('HAPPY: super-admin is allowed', async () => {
    handle.auth.current = {
      tenant_id: SUPER_ADMIN_TENANT_ID,
      user_id: 'sa',
      email: 'admin@test.local',
      role: 'owner',
    };
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(200);
  });

  it('SAD: a tenant owner is refused 403', async () => {
    handle.auth.current = tenantAuth('owner');
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(403);
  });

  it('SAD: a front_desk login is refused 403', async () => {
    handle.auth.current = tenantAuth('front_desk');
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(403);
  });

  it('SAD: an unauthenticated request is refused 401', async () => {
    handle.auth.current = null;
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /reminders/process side effect', () => {
  it('SAD: a refused caller never runs the cross-tenant batch', async () => {
    handle.auth.current = tenantAuth('front_desk');
    await app.inject({ method: 'POST', url: '/reminders/process' });
    expect(processRemindersNow).not.toHaveBeenCalled();
  });

  it('HAPPY: super-admin run reports the processed count', async () => {
    handle.auth.current = {
      tenant_id: SUPER_ADMIN_TENANT_ID,
      user_id: 'sa',
      email: 'admin@test.local',
      role: 'owner',
    };
    const res = await app.inject({ method: 'POST', url: '/reminders/process' });
    expect(res.json()).toMatchObject({ success: true, processed: 7 });
    expect(processRemindersNow).toHaveBeenCalledTimes(1);
  });
});
