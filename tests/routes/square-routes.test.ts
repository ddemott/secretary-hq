import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createMockClient, createMockPool, createMockWithTenantClient } from '../mock';

// --- Mock squareClient and squareSync modules before importing routes ---
vi.mock('../../src/services/crm/squareClient', () => ({
  isSquareEnabled: vi.fn(),
  getAuthUrl: vi.fn(),
  verifyState: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  verifyWebhookSignature: vi.fn(),
  getCustomer: vi.fn(),
}));

vi.mock('../../src/services/crm/squareSync', () => ({
  fullSync: vi.fn(),
  getTokensWithRefresh: vi.fn(),
  pullSquareCustomer: vi.fn(),
}));

import { registerSquareRoutes } from '../../src/routes/square';
import * as squareClient from '../../src/services/crm/squareClient';
import * as squareSync from '../../src/services/crm/squareSync';

// --- Constants ---
const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DASHBOARD_URL = 'https://localhost:4400';

// --- App builder ---

let app: FastifyInstance;
let mockClient: ReturnType<typeof createMockClient>['mockClient'];
let queryResponses: ReturnType<typeof createMockClient>['queryResponses'];
let mockPool: Pool;

// Test-only request shape: the preHandler injects tenantId + auth for the
// route to read.
type TenantRequest = FastifyRequest & {
  tenantId?: string;
  auth?: { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
};

function buildApp() {
  const created = createMockClient();
  mockClient = created.mockClient;
  queryResponses = created.queryResponses;

  mockPool = createMockPool(mockClient);
  const mockWithTenantClient = createMockWithTenantClient(mockClient);

  const fastify = Fastify({ logger: false });

  // Mirror src/index.ts content-type parser — preserves req.rawBody so the
  // webhook signature path can verify against original bytes (added 2026-05-09
  // when the route switched from JSON.stringify(req.body) to req.rawBody).
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    async (req: unknown, rawBody: Buffer) => {
      (req as { rawBody?: Buffer }).rawBody = rawBody;
      try {
        return JSON.parse(rawBody.toString('utf8'));
      } catch {
        throw new Error('Invalid JSON');
      }
    }
  );

  // Simulate tenant middleware: inject tenantId from query param or header.
  // Owner by default — GET /square/auth, POST /square/settings/disconnect,
  // and POST /square/sync are all owner-gated (requireOwnerRole, 2026-09-16
  // role-check audit); the dedicated role-gate coverage lives in
  // square-role-gate.test.ts, this file stays focused on route behavior.
  fastify.addHook('preHandler', async (request: TenantRequest) => {
    const tenantId =
      (request.query as Record<string, string>)?.tenant_id ||
      (request.headers['x-tenant-id'] as string);
    if (tenantId) {
      request.tenantId = tenantId;
      request.auth = {
        tenant_id: tenantId,
        user_id: '00000000-0000-0000-0000-000000000001',
        email: 'owner@test.local',
        role: 'owner',
      };
    }
  });

  registerSquareRoutes(fastify, mockPool, mockWithTenantClient);

  return fastify;
}

// --- Setup / teardown ---

beforeAll(async () => {
  process.env.DASHBOARD_URL = DASHBOARD_URL;
  process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'test-square-webhook-key';
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Reset queryResponses array
  queryResponses.length = 0;
});

// =============================================
// HAPPY PATHS
// =============================================

describe('Square Routes — Happy Paths', () => {
  it('1. GET /square/auth returns OAuth URL when configured', async () => {
    // WHO: Dashboard integration card — user clicks "Connect Square" button
    // WHAT: Square env vars are set (SQUARE_APP_ID, SQUARE_APP_SECRET), request includes tenant_id
    // WHEN: GET /square/auth?tenant_id=...
    // WHERE: src/routes/square.ts registerSquareRoutes — GET /square/auth handler
    // WHY: Without this, clicking "Connect Square" would fail silently — user cannot link their Square account for customer/booking sync
    vi.mocked(squareClient.isSquareEnabled).mockReturnValue(true);
    vi.mocked(squareClient.getAuthUrl).mockReturnValue(
      'https://connect.squareup.com/oauth2/authorize?client_id=test'
    );

    const res = await app.inject({
      method: 'GET',
      url: `/square/auth?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.authUrl).toBe('https://connect.squareup.com/oauth2/authorize?client_id=test');
    expect(squareClient.getAuthUrl).toHaveBeenCalledWith(TENANT_ID);
  });

  it('2. GET /square/auth/callback exchanges code, redirects with ?squareConnected=true', async () => {
    // WHO: Square OAuth server — redirects user back after granting access
    // WHAT: Callback URL contains valid code + JWT state param, token exchange succeeds, tokens stored in tenant_integration_settings
    // WHEN: GET /square/auth/callback?code=...&state=... (OAuth redirect)
    // WHERE: src/routes/square.ts registerSquareRoutes — GET /square/auth/callback handler via oauthCallbackFactory
    // WHY: Without this, the OAuth flow completes on Square's side but tokens never persist — user appears connected but all Square API calls fail with 401
    vi.mocked(squareClient.verifyState).mockReturnValue(TENANT_ID);
    vi.mocked(squareClient.exchangeCodeForTokens).mockResolvedValue({
      access_token: 'access-123',
      refresh_token: 'refresh-456',
      expiry_date: Date.now() + 30 * 24 * 3600 * 1000,
    });

    // Pool.connect for INSERT
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: '/square/auth/callback?code=auth-code-xyz&state=valid-jwt-state',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${DASHBOARD_URL}/dashboard?squareConnected=true`);
    expect(squareClient.verifyState).toHaveBeenCalledWith('valid-jwt-state');
    expect(squareClient.exchangeCodeForTokens).toHaveBeenCalledWith('auth-code-xyz');
    expect(mockClient.query).toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('3. GET /square/settings returns settings', async () => {
    // WHO: Dashboard integration card — polls connection status on CRM settings page load
    // WHAT: tenant_integration_settings row exists, response strips access_token/refresh_token before returning
    // WHEN: GET /square/settings?tenant_id=...
    // WHERE: src/routes/square.ts registerSquareRoutes — GET /square/settings handler
    // WHY: Without token stripping, OAuth tokens leak to the browser — a XSS attack could steal them and impersonate the tenant on Square's API
    const settingsRow = {
      tenant_id: TENANT_ID,
      provider: 'square',
      is_active: true,
      last_sync_at: '2026-03-25T10:00:00Z',
      created_at: '2026-03-20T08:00:00Z',
      updated_at: '2026-03-25T10:00:00Z',
    };
    queryResponses.push({ rows: [settingsRow] });

    const res = await app.inject({
      method: 'GET',
      url: `/square/settings?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenant_id).toBe(TENANT_ID);
    expect(body.provider).toBe('square');
    expect(body.is_active).toBe(true);
    // Should NOT contain token fields
    expect(body.access_token).toBeUndefined();
    expect(body.refresh_token).toBeUndefined();
  });

  it('4. POST /square/settings/disconnect deletes settings + sync map', async () => {
    // WHO: Dashboard user — clicks "Disconnect Square" button on CRM integration card
    // WHAT: Deletes tenant_integration_settings row AND all entity_sync_map rows for this tenant+provider
    // WHEN: POST /square/settings/disconnect?tenant_id=...
    // WHERE: src/routes/square.ts registerSquareRoutes — POST /square/settings/disconnect handler
    // WHY: Without deleting sync map entries, reconnecting Square later would cause duplicate customers — stale external_id mappings conflict with fresh Square data
    // DELETE from tenant_integration_settings
    queryResponses.push({ rows: [], rowCount: 1 });
    // DELETE from entity_sync_map
    queryResponses.push({ rows: [], rowCount: 3 });

    const res = await app.inject({
      method: 'POST',
      url: `/square/settings/disconnect?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);

    // Verify both DELETE queries were issued
    expect(mockClient.query).toHaveBeenCalledTimes(2);
    const firstCall = mockClient.query.mock.calls[0][0] as string;
    const secondCall = mockClient.query.mock.calls[1][0] as string;
    expect(firstCall).toContain('DELETE FROM tenant_integration_settings');
    expect(secondCall).toContain('DELETE FROM entity_sync_map');
  });

  it('5. POST /square/webhook processes valid event', async () => {
    // WHO: Square webhook server — fires customer.created event when a customer is created in Square
    // WHAT: Valid HMAC signature, tenant lookup by merchant_id succeeds, customer fetched and synced to local DB
    // WHEN: POST /square/webhook with x-square-hmacsha256-signature header and customer.created payload
    // WHERE: src/routes/square.ts registerSquareRoutes — POST /square/webhook handler
    // WHY: Without this, new customers created in Square would never appear in SecretaryHQ — bidirectional sync breaks and the voice AI has stale customer data
    const webhookBody = {
      type: 'customer.created',
      merchant_id: 'M123',
      data: { id: 'sq-cust-001' },
    };

    vi.mocked(squareClient.verifyWebhookSignature).mockReturnValue(true);

    // Tenant lookup by merchantId (uses pool.query)
    queryResponses.push({ rows: [{ tenant_id: TENANT_ID }] });

    vi.mocked(squareSync.getTokensWithRefresh).mockResolvedValue({
      accessToken: 'access-token-123',
      refreshToken: 'refresh-token-456',
    });

    vi.mocked(squareClient.getCustomer).mockResolvedValue({
      customer: {
        id: 'sq-cust-001',
        given_name: 'John',
        family_name: 'Doe',
        phone_number: '555-1234',
      },
    });

    vi.mocked(squareSync.pullSquareCustomer).mockResolvedValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/square/webhook',
      headers: {
        'x-square-hmacsha256-signature': 'valid-sig',
      },
      payload: webhookBody,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe('Webhook received');
  });

  it('6. POST /square/sync triggers fullSync', async () => {
    // WHO: Dashboard user — clicks "Sync Now" button on Square integration card
    // WHAT: fullSync pulls all customers and bookings from Square REST v2 API, returns count of synced entities
    // WHEN: POST /square/sync?tenant_id=...
    // WHERE: src/routes/square.ts registerSquareRoutes — POST /square/sync handler calling squareSync.fullSync
    // WHY: Without this, users have no way to trigger a full data pull — initial setup after connecting Square would show zero synced records
    vi.mocked(squareSync.fullSync).mockResolvedValue({
      customersSynced: 15,
      appointmentsSynced: 8,
      errors: 0,
    });

    const res = await app.inject({
      method: 'POST',
      url: `/square/sync?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.customersSynced).toBe(15);
    expect(body.appointmentsSynced).toBe(8);
    expect(squareSync.fullSync).toHaveBeenCalledWith(expect.anything(), TENANT_ID);
  });

  it('7. GET /square/sync/status returns counts', async () => {
    // WHO: Dashboard integration card — polls sync status to show progress badges (synced/pending/error counts)
    // WHAT: Aggregates entity_sync_map rows by entity_type and sync_status, joins with last_sync_at from settings
    // WHEN: GET /square/sync/status?tenant_id=...
    // WHERE: src/routes/square.ts registerSquareRoutes — GET /square/sync/status handler
    // WHY: Without this, the Square integration card shows no sync progress — user cannot tell if sync worked, how many records failed, or when last sync ran
    // settings query
    queryResponses.push({ rows: [{ last_sync_at: '2026-03-25T12:00:00Z' }] });
    // counts query
    queryResponses.push({
      rows: [
        { entity_type: 'customer', sync_status: 'synced', count: 20 },
        { entity_type: 'customer', sync_status: 'pending', count: 2 },
        { entity_type: 'appointment', sync_status: 'synced', count: 10 },
        { entity_type: 'appointment', sync_status: 'error', count: 1 },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/square/sync/status?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.last_sync_at).toBe('2026-03-25T12:00:00Z');
    expect(body.pending_count).toBe(2);
    expect(body.error_count).toBe(1);
    expect(body.total_mapped.customers).toBe(22);
    expect(body.total_mapped.appointments).toBe(11);
  });
});

// =============================================
// SAD PATHS
// =============================================

describe('Square Routes — Sad Paths', () => {
  it('8. GET /square/auth returns 503 when not configured', async () => {
    // WHO: Dashboard integration card — user clicks "Connect Square" but server lacks SQUARE_APP_ID/SECRET env vars
    // WHAT: isSquareEnabled returns false because required env vars are missing in production
    // WHEN: GET /square/auth?tenant_id=... when Square env vars not set
    // WHERE: src/routes/square.ts registerSquareRoutes — GET /square/auth guard check
    // WHY: Without a clear 503, the dashboard would show a cryptic error instead of "Square integration not configured" — admin wouldn't know to set env vars
    vi.mocked(squareClient.isSquareEnabled).mockReturnValue(false);

    const res = await app.inject({
      method: 'GET',
      url: `/square/auth?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('not configured');
  });

  it('9. GET /square/auth/callback redirects with error on missing params', async () => {
    // WHO: Malformed OAuth redirect or direct browser navigation to callback URL without params
    // WHAT: Callback URL has neither code nor state nor error query params
    // WHEN: GET /square/auth/callback (no query params)
    // WHERE: src/routes/square.ts registerSquareRoutes — GET /square/auth/callback missing params guard
    // WHY: Without this guard, the handler would crash on undefined code/state — user sees a 500 error page instead of being redirected to dashboard with an error toast
    const res = await app.inject({
      method: 'GET',
      url: '/square/auth/callback',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${DASHBOARD_URL}/dashboard?squareError=missing_params`);
  });

  it('10. GET /square/auth/callback redirects with error on bad state', async () => {
    // WHO: Attacker or expired session — callback arrives with tampered/expired JWT state
    // WHAT: verifyState returns null because the state JWT is invalid, expired, or forged
    // WHEN: GET /square/auth/callback?code=...&state=bad-jwt
    // WHERE: src/routes/square.ts registerSquareRoutes — GET /square/auth/callback state verification
    // WHY: Without this, a CSRF attack could link an attacker's Square account to a victim's tenant — state validation prevents OAuth session fixation
    vi.mocked(squareClient.verifyState).mockReturnValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/square/auth/callback?code=auth-code&state=bad-jwt',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${DASHBOARD_URL}/dashboard?squareError=invalid_state`);
  });

  it('11. GET /square/auth/callback redirects on token exchange failure', async () => {
    // WHO: Square OAuth server — token exchange fails (expired code, Square API outage, network error)
    // WHAT: verifyState succeeds but exchangeCodeForTokens throws — Square rejected the authorization code
    // WHEN: GET /square/auth/callback?code=...&state=... when Square's token endpoint is down
    // WHERE: src/routes/square.ts registerSquareRoutes — GET /square/auth/callback token exchange try/catch
    // WHY: Without catching this, a Square outage during OAuth would show a raw 500 error — user sees broken page instead of "connection failed, try again"
    vi.mocked(squareClient.verifyState).mockReturnValue(TENANT_ID);
    vi.mocked(squareClient.exchangeCodeForTokens).mockRejectedValue(
      new Error('OAuth exchange failed')
    );

    const res = await app.inject({
      method: 'GET',
      url: '/square/auth/callback?code=auth-code&state=valid-jwt',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `${DASHBOARD_URL}/dashboard?squareError=token_exchange_failed`
    );
  });

  it('12. POST /square/webhook 400 on missing signature', async () => {
    // WHO: Unknown caller — sends POST to webhook endpoint without HMAC signature header
    // WHAT: Request has no x-square-hmacsha256-signature header, fails before any verification
    // WHEN: POST /square/webhook without signature header
    // WHERE: src/routes/square.ts registerSquareRoutes — POST /square/webhook signature presence check
    // WHY: Without rejecting unsigned requests, an attacker could inject fake customer/booking events — corrupting any tenant's customer database
    const res = await app.inject({
      method: 'POST',
      url: '/square/webhook',
      payload: { type: 'customer.created', merchant_id: 'M123' },
      // No x-square-hmacsha256-signature header
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Missing signature');
  });

  it('13. POST /square/webhook 401 on invalid signature', async () => {
    // WHO: Attacker or corrupted request — sends webhook with wrong/forged HMAC signature
    // WHAT: Signature header present but verifyWebhookSignature returns false — HMAC doesn't match
    // WHEN: POST /square/webhook with x-square-hmacsha256-signature that doesn't match computed HMAC
    // WHERE: src/routes/square.ts registerSquareRoutes — POST /square/webhook HMAC verification
    // WHY: Without HMAC validation, anyone who knows the webhook URL could inject fake events — corrupting the tenant's customer and booking data
    vi.mocked(squareClient.verifyWebhookSignature).mockReturnValue(false);

    const res = await app.inject({
      method: 'POST',
      url: '/square/webhook',
      headers: {
        'x-square-hmacsha256-signature': 'bad-signature',
      },
      payload: { type: 'customer.created', merchant_id: 'M123' },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Invalid webhook signature');
  });

  it('14. POST /square/webhook 500 when signature key not configured', async () => {
    // WHO: Square webhook server — fires event but SQUARE_WEBHOOK_SIGNATURE_KEY env var is missing from production
    // WHAT: Signature header present but server cannot verify because the shared secret env var is not set
    // WHEN: POST /square/webhook when SQUARE_WEBHOOK_SIGNATURE_KEY is undefined in process.env
    // WHERE: src/routes/square.ts registerSquareRoutes — POST /square/webhook signature key check
    // WHY: Without this check, verifyWebhookSignature would use undefined as the key — either always passing (security hole) or always failing (all webhooks rejected silently)
    const savedKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    delete process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

    const res = await app.inject({
      method: 'POST',
      url: '/square/webhook',
      headers: {
        'x-square-hmacsha256-signature': 'some-sig',
      },
      payload: { type: 'customer.created', merchant_id: 'M123' },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('signature key not configured');

    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = savedKey;
  });
});
