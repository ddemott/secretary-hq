/**
 * WHO:   POST /communications/sms
 * WHAT:  refuses (503, nothing sent) unless ENABLE_SMS === 'true'
 * WHEN:  any authenticated caller hits the route while SMS is globally off
 * WHERE: src/routes/communications.ts
 * WHY:   no text this product has sent has ever reached a handset (10DLC not
 *        registered; Telnyx accepts the send and reports success anyway, error
 *        40010 at the carrier). This route had no ENABLE_SMS gate, so it answered
 *        { success: true, messageId } for a text that dies at the carrier — the
 *        false-promise class the flag exists to prevent. The agent tools and
 *        POST /appointments/:id/send-self-service-links were already gated.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const sendSMS = vi.fn(async () => ({ success: true, messageId: 'msg-1' }));

vi.mock('../../src/services/communications/index.js', () => ({
  CommunicationService: class {
    sendSMS = sendSMS;
  },
}));

import { registerCommunicationRoutes } from '../../src/routes/communications';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ORIGINAL_ENABLE_SMS = process.env.ENABLE_SMS;
const BODY = { to: '+16305551234', body: 'hello' };

let handle: RouteTestAppHandle;
let app: FastifyInstance;

beforeAll(async () => {
  handle = buildRouteTestApp((a, pool, withTenantClient) => {
    registerCommunicationRoutes(a, pool, withTenantClient);
  });
  app = handle.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (ORIGINAL_ENABLE_SMS === undefined) delete process.env.ENABLE_SMS;
  else process.env.ENABLE_SMS = ORIGINAL_ENABLE_SMS;
});

beforeEach(() => {
  sendSMS.mockClear();
  handle.auth.current = {
    user_id: '00000000-0000-0000-0000-000000000001',
    tenant_id: TENANT_ID,
    email: 'owner@test.local',
    role: 'owner',
  };
  delete process.env.ENABLE_SMS;
});

const post = (payload: unknown = BODY) =>
  app.inject({ method: 'POST', url: '/communications/sms', payload: payload as object });

describe('POST /communications/sms ENABLE_SMS gate', () => {
  it('SAD: unset (the default) → 503 and nothing is sent', async () => {
    const res = await post();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ success: false });
    expect(res.json().error).toMatch(/10DLC/);
    expect(sendSMS).not.toHaveBeenCalled();
  });

  it.each(['false', 'TRUE', '1', 'yes', ''])(
    'SAD: ENABLE_SMS=%j is not the literal "true" → 503, nothing sent',
    async (value) => {
      process.env.ENABLE_SMS = value;
      const res = await post();
      expect(res.statusCode).toBe(503);
      expect(sendSMS).not.toHaveBeenCalled();
    }
  );

  it('SAD: unauthenticated is still 401 before the gate is reached', async () => {
    handle.auth.current = null;
    const res = await post();
    expect(res.statusCode).toBe(401);
    expect(sendSMS).not.toHaveBeenCalled();
  });

  it('HAPPY: ENABLE_SMS=true → sends and returns the message id', async () => {
    process.env.ENABLE_SMS = 'true';
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, messageId: 'msg-1' });
    expect(sendSMS).toHaveBeenCalledTimes(1);
  });

  it('SAD: ENABLE_SMS=true still validates the body (400, nothing sent)', async () => {
    process.env.ENABLE_SMS = 'true';
    const res = await post({ to: '123', body: '' });
    expect(res.statusCode).toBe(400);
    expect(sendSMS).not.toHaveBeenCalled();
  });
});
