/**
 * WHO:   GET /self/cancel
 * WHAT:  token-gated appointment cancellation — no session auth required
 * WHEN:  customer taps the cancel link in an appointment-confirmation SMS
 * WHERE: src/routes/selfService.ts
 * WHY:   token IS the auth; route must gate on signature + scope to tenant;
 *        must be idempotent (already-canceled → 200, not 400);
 *        uses withTenantClient so FORCE RLS on appointments table passes.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

// sendSms is a chokepoint that never rejects (see telnyxSms.ts) — mocked here
// to prove the reschedule route's fire-and-forget owner SMS checks
// result.ok and logs locally on failure, since a .catch() on this call can
// never fire.
const mockSendSms = vi.fn();
vi.mock('../../src/services/telnyxSms.js', () => ({
  sendSms: (...args: unknown[]) => mockSendSms(...args),
}));

import { registerSelfServiceRoutes } from '../../src/routes/selfService.js';
import { generateSelfServiceToken } from '../../src/services/selfServiceToken.js';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';

const APPT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TENANT_ID = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';

// Note: selfServiceToken.ts reads JWT_SECRET at module-load time.
// In the test environment NODE_ENV=test, the module falls back to
// 'dev-jwt-secret-change-in-production'. generateSelfServiceToken and
// verifySelfServiceToken both use that same constant, so tokens round-trip
// correctly without any per-test environment overrides.

let handle: RouteTestAppHandle;
let app: FastifyInstance;

beforeAll(async () => {
  handle = buildRouteTestApp((a, _pool, withTenantClient) => {
    registerSelfServiceRoutes(a, withTenantClient);
  });
  app = handle.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  handle.queries.length = 0;
  handle.queryResponses.length = 0;
  mockSendSms.mockReset();
  mockSendSms.mockResolvedValue({ ok: true, status: 200 });
});

describe('GET /self/cancel', () => {
  describe('Happy Paths', () => {
    it('cancels appointment and returns 200 with success message', async () => {
      // WHO: customer with a valid 24-hour cancel token
      // WHAT: appointment status set to canceled
      // WHY:  token-only auth gates the update; no session JWT needed
      handle.queryResponses.push({ rows: [{ appointment_id: APPT_ID }], rowCount: 1 });

      const token = generateSelfServiceToken(APPT_ID, TENANT_ID, 'cancel')!;
      const res = await app.inject({ method: 'GET', url: `/self/cancel?token=${token}` });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toMatch(/canceled/i);
    });

    it('returns 200 for already-canceled appointment (idempotent)', async () => {
      // WHO: customer tapping cancel link a second time
      // WHAT: second call is a no-op — returns success without DB error
      // WHY:  SMS links can be tapped accidentally more than once; idempotency prevents
      //       confusing error responses for a legitimate action
      handle.queryResponses.push({ rows: [], rowCount: 0 });
      // Second query: existence check
      handle.queryResponses.push({ rows: [{ status: 'canceled' }], rowCount: 1 });

      const token = generateSelfServiceToken(APPT_ID, TENANT_ID, 'cancel')!;
      const res = await app.inject({ method: 'GET', url: `/self/cancel?token=${token}` });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toMatch(/already been canceled/i);
    });
  });

  describe('Sad Paths', () => {
    it('returns 400 when token is missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/self/cancel' });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { success: boolean };
      expect(body.success).toBe(false);
    });

    it('returns 400 for invalid/tampered token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/self/cancel?token=not.a.valid.jwt',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/expired or is invalid/i);
    });

    it('returns 404 when appointment not found for this tenant', async () => {
      // WHO: customer with a valid token but appointment was deleted
      // WHAT: no rows from UPDATE, no rows from existence check
      handle.queryResponses.push({ rows: [], rowCount: 0 });
      handle.queryResponses.push({ rows: [], rowCount: 0 });

      const token = generateSelfServiceToken(APPT_ID, TENANT_ID, 'cancel')!;
      const res = await app.inject({ method: 'GET', url: `/self/cancel?token=${token}` });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as { success: boolean };
      expect(body.success).toBe(false);
    });
  });
});

describe('GET /self/reschedule', () => {
  describe('Happy Paths', () => {
    it('returns 200 and attempts owner SMS when appointment found', async () => {
      // WHO: customer tapping reschedule link in confirmation SMS
      // WHAT: owner notified; appointment NOT mutated
      // WHY: owner must confirm a new slot before any change lands;
      //      SMS is fire-and-forget — route succeeds even if SMS fails
      // appt + customer query
      handle.queryResponses.push({
        rows: [
          {
            start_time: '2026-07-10T14:00:00Z',
            description: 'Haircut',
            customer_name: 'Alice',
            customer_phone: '+16305550199',
          },
        ],
        rowCount: 1,
      });
      // tenant phones query — null phones so sendSms branch is skipped in tests
      handle.queryResponses.push({
        rows: [{ forward_phone: null, inbound_phone: null }],
        rowCount: 1,
      });

      const token = generateSelfServiceToken(APPT_ID, TENANT_ID, 'reschedule')!;
      const res = await app.inject({ method: 'GET', url: `/self/reschedule?token=${token}` });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toMatch(/contact you shortly/i);
    });

  });

  describe('Sad Paths', () => {
    it('owner SMS fails — route still succeeds, and the failure is logged locally', async () => {
      // WHO: platform operator, not the customer — the customer's request
      //      still succeeded from their point of view
      // WHAT: sendSms resolves ok:false (never rejects — see telnyxSms.ts);
      //       before this fix, a bare .catch() here could never fire, so a
      //       failed owner-nudge produced no local log line at all
      const logErrorSpy = vi.spyOn(app.log, 'error');
      mockSendSms.mockResolvedValue({ ok: false, error: 'http_500', status: 500 });

      handle.queryResponses.push({
        rows: [
          {
            start_time: '2026-07-10T14:00:00Z',
            description: 'Haircut',
            customer_name: 'Alice',
            customer_phone: '+16305550199',
          },
        ],
        rowCount: 1,
      });
      handle.queryResponses.push({
        rows: [{ forward_phone: '+16305550100', inbound_phone: '+16305550101' }],
        rowCount: 1,
      });

      const token = generateSelfServiceToken(APPT_ID, TENANT_ID, 'reschedule')!;
      const res = await app.inject({ method: 'GET', url: `/self/reschedule?token=${token}` });

      expect(res.statusCode).toBe(200);
      expect((JSON.parse(res.body) as { success: boolean }).success).toBe(true);

      // Fire-and-forget: give the unhandled .then() a tick to run.
      await new Promise((r) => setTimeout(r, 0));

      expect(mockSendSms).toHaveBeenCalledTimes(1);
      expect(logErrorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'http_500', status: 500 }),
        'Failed to send reschedule-request SMS to owner'
      );
    });

    it('returns 400 when token is missing', async () => {
      // WHO: bot/browser with no token
      // WHAT: rejected before any DB query
      const res = await app.inject({ method: 'GET', url: '/self/reschedule' });
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as { success: boolean }).success).toBe(false);
    });

    it('returns 400 for invalid/tampered token', async () => {
      // WHO: customer with a corrupted or expired link
      // WHAT: JWT verification fails before any DB call
      const res = await app.inject({
        method: 'GET',
        url: '/self/reschedule?token=not.a.valid.jwt',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/expired or is invalid/i);
    });

    it('returns 400 when a cancel token is used on reschedule route', async () => {
      // WHO: customer with mismatched token action claim
      // WHAT: verifySelfServiceToken('reschedule') rejects a 'cancel' token
      // WHY: action-scoped tokens prevent a cancel token from triggering a reschedule notification
      const cancelToken = generateSelfServiceToken(APPT_ID, TENANT_ID, 'cancel')!;
      const res = await app.inject({
        method: 'GET',
        url: `/self/reschedule?token=${cancelToken}`,
      });
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.body) as { success: boolean }).success).toBe(false);
    });

    it('returns 404 when appointment is not found or already completed', async () => {
      // WHO: customer with a valid token but appointment was deleted or already finished
      // WHAT: DB returns no rows for the scheduled appointment lookup
      handle.queryResponses.push({ rows: [], rowCount: 0 }); // appt query
      handle.queryResponses.push({
        rows: [{ forward_phone: null, inbound_phone: null }],
        rowCount: 1,
      }); // tenant query (always runs)

      const token = generateSelfServiceToken(APPT_ID, TENANT_ID, 'reschedule')!;
      const res = await app.inject({ method: 'GET', url: `/self/reschedule?token=${token}` });

      expect(res.statusCode).toBe(404);
      expect((JSON.parse(res.body) as { success: boolean }).success).toBe(false);
    });
  });
});
