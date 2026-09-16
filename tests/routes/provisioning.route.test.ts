/**
 * Route-handler tests for src/routes/provisioning.ts.
 *
 * Why a separate file from src/provisioning.test.ts:
 *   The existing file tests TelnyxNumbersClient HTTP behaviour + DB schema.
 *   This file tests the Fastify route layer: validation guards, conflict states,
 *   partial-cleanup warning path.
 *
 * Coverage targets:
 *   - POST /provisioning/activate — telnyx=null → 503
 *   - POST /provisioning/activate — invalid UUID payload → 400
 *   - POST /provisioning/activate — phone already active → 409
 *   - POST /provisioning/activate — phone already provisioning → 409
 *   - POST /provisioning/deactivate — Telnyx release fails → 200 + warnings array
 *   - GET  /provisioning/status    — tenant not found → 404
 *   - GET  /provisioning/status    — happy path → phone fields
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerProvisioningRoutes, type TelnyxProvisioningConfig } from '../../src/routes/provisioning';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// Mock TelnyxNumbersClient — only the methods the route calls
function buildMockTelnyx(
  overrides: Partial<TelnyxProvisioningConfig['client']> = {}
): TelnyxProvisioningConfig {
  return {
    sipConnectionId: 'sip-conn-123',
    client: {
      searchAvailable: vi.fn(async () => ({
        phone_number: '+16305551234',
        id: 'pn-abc',
      })),
      orderNumber: vi.fn(async () => ({
        id: 'pn-abc',
        phone_number: '+16305551234',
      })),
      assignToConnection: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      ...overrides,
    },
  };
}

// ── App with telnyx configured ────────────────────────────────────────────────

let handle: RouteTestAppHandle;
let app: FastifyInstance;
let mockTelnyx: TelnyxProvisioningConfig;

// ── App with telnyx=null (503 path) ──────────────────────────────────────────

let nullHandle: RouteTestAppHandle;
let nullApp: FastifyInstance;

beforeAll(async () => {
  mockTelnyx = buildMockTelnyx();

  handle = buildRouteTestApp((app, pool) => {
    registerProvisioningRoutes(app, pool, mockTelnyx);
  });
  app = handle.app;
  await app.ready();

  nullHandle = buildRouteTestApp((app, pool) => {
    registerProvisioningRoutes(app, pool, null);
  });
  nullApp = nullHandle.app;
  await nullApp.ready();
});

afterAll(async () => {
  await Promise.all([app.close(), nullApp.close()]);
});

beforeEach(() => {
  vi.clearAllMocks();
  handle.queries.length = 0;
  handle.queryResponses.length = 0;
  handle.tenantIdOverride.current = null;
  handle.auth.current = {
    user_id: '00000000-0000-0000-0000-000000000001',
    tenant_id: TENANT_ID,
    email: 'owner@test.local',
    role: 'owner',
  };
  nullHandle.queries.length = 0;
  nullHandle.queryResponses.length = 0;
});

// ────────────────────────────────────────────────────────────────────
// POST /provisioning/activate
// ────────────────────────────────────────────────────────────────────

describe('POST /provisioning/activate — telnyx=null', () => {
  it('SAD: returns 503 when provisioning is not configured', async () => {
    // WHO: a super-admin clicking "Provision phone" when Telnyx env vars are missing
    // WHAT: route checks `if (!telnyx)` before anything else → 503
    // WHEN: activate request with no TelnyxProvisioningConfig registered
    // WHERE: first guard in /provisioning/activate handler
    // WHY: without this, the handler would crash on telnyx.client.searchAvailable(…)
    const res = await nullApp.inject({
      method: 'POST',
      url: '/provisioning/activate',
      payload: { tenant_id: TENANT_ID },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      success: false,
      error: expect.stringContaining('not configured'),
    });
  });
});

describe('POST /provisioning/activate — configured', () => {
  it('SAD: returns 400 when tenant_id is not a valid UUID', async () => {
    // WHO: super-admin typing a malformed tenant_id in the provisioning form
    // WHAT: ActivateSchema.safeParse rejects non-UUID → 400 before any DB query
    // WHEN: activate request with tenant_id = "not-a-uuid"
    // WHERE: ActivateSchema (z.string().uuid()) validation
    // WHY: a non-UUID tenant_id would cause Postgres to throw a cast error (500)
    //      instead of a clear validation failure
    const res = await app.inject({
      method: 'POST',
      url: '/provisioning/activate',
      payload: { tenant_id: 'not-a-uuid' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: 'Validation failed' });
    expect(handle.queries).toHaveLength(0);
  });

  it('SAD: returns 409 when phone is already active', async () => {
    // WHO: super-admin re-provisioning a tenant that already has a live number
    // WHAT: tenant SELECT returns phone_status='active' → 409 conflict
    // WHEN: activate on a tenant whose phone_status is 'active'
    // WHERE: `if (tenant.phone_status === 'active')` guard
    // WHY: without the guard, provisioning would try to buy a second number
    //      without releasing the first — wasting Telnyx budget
    handle.queryResponses.push({
      rows: [{ tenant_id: TENANT_ID, name: 'Test Biz', phone_status: 'active' }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/provisioning/activate',
      payload: { tenant_id: TENANT_ID },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'Phone is already active for this tenant',
      current_status: 'active',
    });
  });

  it('SAD: returns 409 when provisioning is already in progress', async () => {
    // WHO: super-admin double-clicking the provision button
    // WHAT: phone_status='provisioning' → second 409 conflict branch
    // WHEN: activate while a prior activate is mid-flight (status stuck at 'provisioning')
    // WHERE: `if (tenant.phone_status === 'provisioning')` guard
    // WHY: two concurrent provisions would race for the same SIP connection slot
    //      and potentially leave the tenant with two purchased numbers
    handle.queryResponses.push({
      rows: [{ tenant_id: TENANT_ID, name: 'Test Biz', phone_status: 'provisioning' }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/provisioning/activate',
      payload: { tenant_id: TENANT_ID },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'Phone provisioning is already in progress',
      current_status: 'provisioning',
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// POST /provisioning/deactivate
// ────────────────────────────────────────────────────────────────────

describe('POST /provisioning/deactivate', () => {
  it('SAD: Telnyx release fails → 200 with warnings array (partial cleanup)', async () => {
    // WHO: super-admin deactivating a number when the Telnyx API is temporarily down
    // WHAT: client.release() throws → warning captured → DB columns cleared anyway
    // WHEN: deactivate where Telnyx returns an error for the release call
    // WHERE: `catch (err)` inside the telnyx.client.release() block in deactivate handler
    // WHY: the tenant's DB columns must be cleared even if Telnyx cleanup fails —
    //      the operator is informed via warnings[] so they can manually tidy the
    //      Telnyx portal; failing-closed here would leave the UI stuck on "active"
    const releaseError = buildMockTelnyx({
      release: vi.fn(async () => {
        throw new Error('Telnyx API timeout');
      }),
    });
    const errorHandle = buildRouteTestApp((app, pool) => {
      registerProvisioningRoutes(app, pool, releaseError);
    });
    await errorHandle.app.ready();

    // SELECT returns a row with a telnyx_phone_number_id
    errorHandle.queryResponses.push({
      rows: [{ telnyx_phone_number_id: 'pn-abc' }],
    });
    // UPDATE clears the columns
    errorHandle.queryResponses.push({ rows: [], rowCount: 1 });

    const res = await errorHandle.app.inject({
      method: 'POST',
      url: '/provisioning/deactivate',
      payload: { tenant_id: TENANT_ID },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.warnings).toBeDefined();
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain('pn-abc');

    await errorHandle.app.close();
  });
});

// ────────────────────────────────────────────────────────────────────
// GET /provisioning/status
// ────────────────────────────────────────────────────────────────────

describe('GET /provisioning/status', () => {
  it('HAPPY: returns phone fields for a known tenant', async () => {
    // WHO: dashboard polling provisioning state on the Phone Assistant tab
    // WHAT: pool.connect → client.query returns a row with phone columns
    // WHEN: GET /provisioning/status?tenant_id=<uuid>
    // WHERE: /provisioning/status handler
    // WHY: the Phone Assistant tab uses this to decide whether to show
    //      "Provision a number" or the active number details
    handle.queryResponses.push({
      rows: [
        {
          phone_status: 'active',
          inbound_phone: '+16305551234',
          telnyx_phone_number_id: 'pn-abc',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/provisioning/status?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      phone_status: 'active',
      inbound_phone: '+16305551234',
    });
  });

  it('SAD: returns 404 when tenant not found', async () => {
    // WHO: a status poll for a tenant_id that no longer exists
    // WHAT: client.query returns 0 rows → handler sends 404
    // WHEN: GET /provisioning/status for an unknown tenant_id
    // WHERE: `if (res.rows.length === 0)` guard
    // WHY: without the guard, destructuring undefined rows would throw 500
    handle.queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/provisioning/status?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false, error: 'Tenant not found' });
  });

  it('HAPPY: includes forwarded_from_phone for GoLivePanel Stage C', async () => {
    // WHO: GoLivePanel's Stage C forwarding card, deciding whether to show
    //      "already configured" or the empty prompt.
    // WHAT: the SELECT now includes forwarded_from_phone alongside the
    //      existing provisioning columns.
    handle.queryResponses.push({
      rows: [
        {
          phone_status: 'active',
          inbound_phone: '+16305551234',
          telnyx_phone_number_id: 'pn-abc',
          forwarded_from_phone: '+16082175303',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/provisioning/status?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ forwarded_from_phone: '+16082175303' });
  });

  it('SOFT-DELETE: lookup query filters out is_deleted tenants', async () => {
    // WHO: a status poll against an already soft-deleted tenant
    // WHAT: the SELECT must scope out is_deleted rows, matching the
    //       soft-delete choke point every other tenant-scoped route enforces
    // WHY: audit finding 2026-09-16 — this query bypassed createWithTenantClient
    handle.queryResponses.push({ rows: [] });

    await app.inject({
      method: 'GET',
      url: `/provisioning/status?tenant_id=${TENANT_ID}`,
    });

    const selectQuery = handle.queries.find((q) => q.text.trim().toUpperCase().startsWith('SELECT'));
    expect(selectQuery?.text).toContain('is_deleted = false');
  });
});

// ────────────────────────────────────────────────────────────────────
// POST /provisioning/port-inquiry
// ────────────────────────────────────────────────────────────────────

describe('POST /provisioning/port-inquiry', () => {
  it('SAD: returns 400 on an invalid payload', async () => {
    // WHO: a malformed request (missing phone_number)
    // WHAT: PortInquirySchema.safeParse rejects → 400 before any DB query
    const res = await app.inject({
      method: 'POST',
      url: '/provisioning/port-inquiry',
      payload: { tenant_id: TENANT_ID },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: 'Validation failed' });
    expect(handle.queries).toHaveLength(0);
  });

  it('SAD: returns 404 when tenant not found', async () => {
    handle.queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'POST',
      url: '/provisioning/port-inquiry',
      payload: { tenant_id: TENANT_ID, phone_number: '+16305551234' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false, error: 'Tenant not found' });
  });

  it('HAPPY: returns success — no porting API is invoked, no table written', async () => {
    // WHO: an owner asking to port their real number instead of forwarding.
    // WHAT: tenant lookup succeeds → best-effort email to the platform admin
    //      → 200. No port_requests-style table exists to write to (see
    //      design doc §3 — that table was deliberately cut).
    handle.queryResponses.push({ rows: [{ name: 'Test Biz' }] });

    const res = await app.inject({
      method: 'POST',
      url: '/provisioning/port-inquiry',
      payload: {
        tenant_id: TENANT_ID,
        phone_number: '+16305551234',
        notes: 'Currently with Verizon',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true });
  });

  it('SAFETY: neither PLATFORM_ADMIN_EMAIL nor EMAIL_USER configured — still 200, no crash', async () => {
    // WHO: a deployment missing both email env vars (a real misconfiguration,
    //      not a hypothetical — EMAIL_USER is optional platform-wide).
    // WHAT: sendPortRequestEmail would otherwise be called with an empty
    //      `to`, throwing on every single request. The route must detect
    //      this explicitly (logs it) rather than let every call 500 or
    //      spam identical error logs from inside the mailer.
    const prevAdmin = process.env.PLATFORM_ADMIN_EMAIL;
    const prevEmailUser = process.env.EMAIL_USER;
    delete process.env.PLATFORM_ADMIN_EMAIL;
    delete process.env.EMAIL_USER;
    try {
      handle.queryResponses.push({ rows: [{ name: 'Test Biz' }] });

      const res = await app.inject({
        method: 'POST',
        url: '/provisioning/port-inquiry',
        payload: { tenant_id: TENANT_ID, phone_number: '+16305551234' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ success: true });
    } finally {
      if (prevAdmin !== undefined) process.env.PLATFORM_ADMIN_EMAIL = prevAdmin;
      if (prevEmailUser !== undefined) process.env.EMAIL_USER = prevEmailUser;
    }
  });
});
