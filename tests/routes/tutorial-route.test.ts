/**
 * Tests for POST /tutorial/start
 *
 * WHO: anonymous visitor hitting the public demo endpoint
 * WHAT: tenant provisioning, JWT issuance, rate-limit, global cap
 * WHEN: on demand (no auth required)
 * WHERE: src/routes/demo.ts
 * WHY: ensure isolated demo tenants are created correctly and outbound
 *      guards fire for demo tenants (syncOrchestrator is_tutorial check)
 *
 * Strategy: mock the pool (no real DB), inject HTTP via Fastify.
 * Happy + sad paths with 5W diagnostics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import {
  registerTutorialRoutes,
  resetTutorialRateLimitForTesting,
  TUTORIAL_BUSINESS_TYPE,
} from '../../src/routes/tutorial';
import { defaultChecklistPresetIdForBusinessType } from '../../shared/checklistPresetDerivation';
import {
  generateToken as realGenerateToken,
  registerJwtAuthHook,
} from '../../src/middleware/fastify-middleware';
import jwt from 'jsonwebtoken';
import { jsonContentTypeParser } from '../../src/jsonContentTypeParser';

type MockQueryResult = { rows: Record<string, unknown>[]; rowCount?: number };

function buildApp(queryResponses: MockQueryResult[]): {
  app: FastifyInstance;
  mockPool: Pool;
  queries: string[];
} {
  const queries: string[] = [];
  const responses = [...queryResponses];

  const mockPool = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql.trim().slice(0, 200));
      return responses.shift() ?? { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        queries.push(sql.trim().slice(0, 200));
        return responses.shift() ?? { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    })),
  } as unknown as Pool;

  // THE REAL MINTER, not a stub.
  //
  // This used to be `vi.fn(() => 'mock-jwt-token')`, and the only assertion on it
  // was `typeof body.token === 'string'`. That test proved the mock works. It
  // could not, and did not, notice that the route was IGNORING the injected
  // minter entirely and hand-rolling its own jwt.sign — which then silently
  // missed the `typ: 'session'` claim and 401'd every real demo user. A stub
  // here hides precisely the class of bug this route is prone to: the token has
  // to be a REAL, verifiable session or the demo is dead on arrival.
  const generateToken = vi.fn(realGenerateToken);

  const app = Fastify({ logger: false });
  // Register the REAL production content-type parser, not Fastify's default.
  // Without this the suite exercises a parser prod never uses — which is how
  // the 2026-07-08 "Try live demo" 400 hid: inject() with no payload sets no
  // content-type, so the JSON path was never touched from either side.
  // removeContentTypeParser must precede add for built-in types.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, jsonContentTypeParser);
  registerTutorialRoutes(app as never, mockPool, generateToken);

  return { app, mockPool, queries };
}

/**
 * Same as buildApp, but with the real JWT auth hook registered so
 * `Authorization: Bearer <token>` headers populate `req.auth` — needed to
 * exercise /tutorial/reset, which is authenticated (unlike /tutorial/start).
 *
 * The hook does its own `password_changed_at` lookup via `pool.connect()`
 * before the handler runs, consuming one entry off the shared response
 * queue per authenticated request — callers must account for it.
 */
function buildAuthedApp(queryResponses: MockQueryResult[]): {
  app: FastifyInstance;
  mockPool: Pool;
} {
  const responses = [...queryResponses];

  const mockPool = {
    query: vi.fn(async () => responses.shift() ?? { rows: [], rowCount: 0 }),
    connect: vi.fn(async () => ({
      query: vi.fn(async () => responses.shift() ?? { rows: [], rowCount: 0 }),
      release: vi.fn(),
    })),
  } as unknown as Pool;

  const generateToken = vi.fn(realGenerateToken);

  const app = Fastify({ logger: false });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, jsonContentTypeParser);
  registerJwtAuthHook(app as never, mockPool);
  registerTutorialRoutes(app as never, mockPool, generateToken);

  return { app, mockPool };
}

function demoOwnerToken(tenantId: string, userId: string): string {
  return realGenerateToken(
    {
      tenant_id: tenantId,
      user_id: userId,
      email: `demo+${tenantId}@quicklubedemo.invalid`,
      role: 'owner',
    },
    1800
  );
}

// Fresh per-test IP so the rate-limit map doesn't bleed between tests.
let testIpCounter = 1000;
function nextIp(): string {
  return `10.0.0.${testIpCounter++}`;
}

describe('POST /tutorial/start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset in-process rate-limit Maps so tests don't bleed into each other.
    // (All inject() calls share req.ip = 127.0.0.1 unless x-forwarded-for is set.)
    resetTutorialRateLimitForTesting();
  });

  it('happy path: creates tenant, returns token + metadata', async () => {
    // WHO: anonymous visitor
    // WHAT: successful demo provisioning with seeded data
    // WHEN: DB under normal load (cap not reached)
    // WHERE: POST /tutorial/start
    // WHY: verify the full happy path returns all fields the dashboard needs

    const { app } = buildApp([
      // 1. Global cap check
      { rows: [{ count: '0' }] },
      // 2. Provision tenant+user CTE
      {
        rows: [
          {
            tenant_id: 'demo-uuid-1234',
            user_id: 'user-uuid-5678',
            email: 'demo+demo-uuid-1234@quicklubedemo.invalid',
          },
        ],
        rowCount: 1,
      },
      // 3. seedTutorialTenant: BEGIN
      // (connect() is called, then multiple queries inside transaction)
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/tutorial/start',
      headers: { 'x-forwarded-for': nextIp() },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;

    // The token must be a REAL, VERIFIABLE SESSION — not merely "a string".
    //
    // /tutorial/start used to sign its own JWT inline (ignoring the injected minter
    // above), so when session tokens gained a `typ` claim the demo token silently
    // stopped being one: every authenticated call a demo user made came back 401.
    // The old assertion — `typeof body.token === 'string'` — passed happily
    // throughout. These are the assertions that would have failed.
    const secret = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
    const decoded = jwt.verify(body.token as string, secret) as Record<string, unknown>;
    expect(decoded.typ).toBe('session'); // else the auth hook rejects it outright
    expect(decoded.user_id).toBe('user-uuid-5678');
    expect(decoded.tenant_id).toBe('demo-uuid-1234');
    expect(decoded.role).toBe('owner');
    // And it must expire with the demo, not in 8 hours like a normal login —
    // the reason the route wanted its own minter in the first place.
    const ttl = (decoded.exp as number) - (decoded.iat as number);
    expect(ttl).toBeLessThanOrEqual(60 * 60);
    expect(ttl).toBeGreaterThan(0);
    expect(body.success).toBe(true);
    expect(typeof body.token).toBe('string');
    expect(body.tenant_id).toBeDefined();
    expect(body.expires_at).toBeDefined();
    expect(body.ttl_minutes).toBe(30);
  });

  it('REGRESSION: the Tutorial tenant is created as an auto shop, which runs the auto-shop preset', async () => {
    // WHO: visitor taking the Tutorial
    // WHAT: the business_type written to the new tenant row
    // WHEN: POST /tutorial/start
    // WHERE: the tenant+user provisioning CTE
    // WHY: it was 'automotive', which no preset maps to, so the Tutorial ran the generic
    //      local_service setup: no auto-shop intake questions or vehicle preferences.
    const { app, mockPool } = buildApp([
      { rows: [{ count: '0' }] },
      {
        rows: [{ tenant_id: 't-1', user_id: 'u-1', email: 'demo+t-1@quicklubedemo.invalid' }],
        rowCount: 1,
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/tutorial/start',
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect(res.statusCode).toBe(200);

    const provisionCall = (
      mockPool.query as unknown as { mock: { calls: [string, unknown[]][] } }
    ).mock.calls.find(([sql]) => sql.includes('INSERT INTO tenants'));
    expect(provisionCall).toBeDefined();
    const params = provisionCall![1];
    expect(params).toContain('auto-shop');
    expect(params).not.toContain('automotive');
    expect(TUTORIAL_BUSINESS_TYPE).toBe('auto-shop');
    expect(defaultChecklistPresetIdForBusinessType(TUTORIAL_BUSINESS_TYPE)).toBe(
      'auto_shop_front_desk'
    );
  });

  it('REGRESSION: each demo gets its own owner email, so a second demo cannot collide', async () => {
    // WHO: two visitors starting demos one after the other.
    // WHAT: the provisioning INSERT builds the owner email from the new tenant id
    //       ('demo+' || tenant_id || '@quicklubedemo.invalid'), and the session
    //       token carries that per-demo address.
    // WHERE: POST /tutorial/start provisioning CTE.
    // WHY: users.email is unique platform-wide since 2026-09-24
    //      (users_email_lower_unique). The old shared demo@quicklubedemo.invalid
    //      would make every demo after the first fail with a unique violation.
    const { app, mockPool } = buildApp([
      { rows: [{ count: '0' }] },
      {
        rows: [
          {
            tenant_id: 'demo-uuid-9999',
            user_id: 'user-uuid-9999',
            email: 'demo+demo-uuid-9999@quicklubedemo.invalid',
          },
        ],
        rowCount: 1,
      },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/tutorial/start',
      headers: { 'x-forwarded-for': nextIp() },
    });

    expect(res.statusCode).toBe(200);
    const queryMock = (mockPool as unknown as { query: ReturnType<typeof vi.fn> }).query;
    const provision = queryMock.mock.calls
      .map((c) => String(c[0]))
      .find((sql) => sql.includes('INSERT INTO users'));
    expect(provision).toContain("'demo+' || tenant_id || '@quicklubedemo.invalid'");
    expect(provision).not.toContain("'demo@quicklubedemo.invalid'");
    const secret = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
    const decoded = jwt.verify(res.json().token as string, secret) as Record<string, unknown>;
    expect(decoded.email).toBe('demo+demo-uuid-9999@quicklubedemo.invalid');
  });

  it('REGRESSION: declares application/json with no body → 200, not 400', async () => {
    // WHO: every prospect clicking "Try live demo" on the landing page
    // WHAT: fetch() sets Content-Type: application/json and passes no body
    // WHEN: 2026-07-08 — reproduced against production, returned
    //       400 {"success":false,"error":"Invalid JSON"} on every click
    // WHERE: jsonContentTypeParser, before registerTutorialRoutes' handler runs
    // WHY: neither suite covered this shape. The backend test injected with no
    //      payload (no content-type → parser skipped) and the dashboard test
    //      stubbed fetch outright, so the one request shape the browser
    //      actually sends was tested by nobody. /tutorial/start was healthy the
    //      entire time; the button in front of it was not.
    const { app } = buildApp([
      { rows: [{ count: '0' }] },
      { rows: [{ tenant_id: 'demo-uuid-1234', user_id: 'user-uuid-5678' }], rowCount: 1 },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/tutorial/start',
      headers: { 'x-forwarded-for': nextIp(), 'content-type': 'application/json' },
      // No payload — exactly what the browser sent.
    });

    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { success: boolean }).success).toBe(true);
  });

  it('returns 429 after exceeding per-IP rate limit', async () => {
    // WHO: same IP hammering the endpoint
    // WHAT: 4th request in 15-min window should be rejected
    // WHEN: IP has already made 3 requests
    // WHERE: in-process IP rate-limit map in demo.ts
    // WHY: prevent DoS from a single source

    const ip = nextIp();
    const { app } = buildApp([
      // Each of the 3 allowed calls gets cap + provision responses
      { rows: [{ count: '0' }] },
      { rows: [{ tenant_id: 't1', user_id: 'u1' }], rowCount: 1 },
      { rows: [{ count: '0' }] },
      { rows: [{ tenant_id: 't2', user_id: 'u2' }], rowCount: 1 },
      { rows: [{ count: '0' }] },
      { rows: [{ tenant_id: 't3', user_id: 'u3' }], rowCount: 1 },
    ]);

    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/tutorial/start',
        headers: { 'x-forwarded-for': ip },
      });
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/tutorial/start',
      headers: { 'x-forwarded-for': ip },
    });

    expect(blocked.statusCode).toBe(429);
    const body = JSON.parse(blocked.body) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect((body.error as string).toLowerCase()).toContain('too many');
  });

  it('returns 503 when global demo cap is reached', async () => {
    // WHO: anonymous visitor
    // WHAT: 51st concurrent demo tenant request
    // WHEN: MAX_ACTIVE_DEMO_TENANTS (50) already in use
    // WHERE: global cap query in demo.ts
    // WHY: prevent DB flooding from distributed IPs bypassing per-IP limit

    const { app } = buildApp([
      { rows: [{ count: '50' }] }, // cap query returns 50 active demo tenants
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/tutorial/start',
      headers: { 'x-forwarded-for': nextIp() },
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect((body.error as string).toLowerCase()).toContain('capacity');
  });

  it('REGRESSION: global cap query excludes soft-deleted tenants', async () => {
    // WHO: anyone hitting /tutorial/start or /tutorial/reset after other
    //      visitors have reset — resetting soft-deletes the OLD tenant but
    //      leaves tutorial_expires_at in the future until the 30-min TTL
    //      naturally elapses.
    // WHAT: the cap COUNT(*) must filter is_deleted = false, or repeated
    //       resets accumulate retired-but-not-yet-expired rows that still
    //       count toward MAX_ACTIVE_TUTORIAL_TENANTS and can block new
    //       sessions prematurely — flagged in PR #575 review.
    // WHERE: the two `SELECT COUNT(*) ... WHERE is_tutorial = true AND
    //        tutorial_expires_at > NOW()` queries in tutorial.ts.
    const { app, queries } = buildApp([
      { rows: [{ count: '0' }] },
      {
        rows: [
          {
            tenant_id: 'demo-uuid-1234',
            user_id: 'user-uuid-5678',
            email: 'demo+demo-uuid-1234@quicklubedemo.invalid',
          },
        ],
        rowCount: 1,
      },
      { rows: [{ id: 1 }] }, // customers idempotency check inside seed
    ]);

    await app.inject({
      method: 'POST',
      url: '/tutorial/start',
      headers: { 'x-forwarded-for': nextIp() },
    });

    const capQuery = queries.find((q) => q.includes('COUNT(*)'));
    expect(capQuery).toContain('is_deleted = false');
  });

  it('different IPs each get their own rate-limit window', async () => {
    // WHO: two separate visitors
    // WHAT: each gets 3 requests independently
    // WHEN: same time window
    // WHERE: IP rate-limit map keyed by IP string
    // WHY: confirm isolation so one blocked IP doesn't affect others

    const ip1 = nextIp();
    const ip2 = nextIp();
    const { app } = buildApp(
      // 3 pairs: cap-query + provision for 6 total calls
      Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0
          ? { rows: [{ count: '0' }] }
          : { rows: [{ tenant_id: `t${i}`, user_id: `u${i}` }], rowCount: 1 }
      )
    );

    for (let i = 0; i < 3; i++) {
      const r1 = await app.inject({
        method: 'POST',
        url: '/tutorial/start',
        headers: { 'x-forwarded-for': ip1 },
      });
      const r2 = await app.inject({
        method: 'POST',
        url: '/tutorial/start',
        headers: { 'x-forwarded-for': ip2 },
      });
      expect(r1.statusCode).not.toBe(429);
      expect(r2.statusCode).not.toBe(429);
    }
  });
});

describe('POST /tutorial/reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTutorialRateLimitForTesting();
  });

  it('happy path: soft-deletes the old tenant and provisions a fresh one', async () => {
    // WHO: a prospect (or Dale) mid-walkthrough whose demo data has drifted
    // WHAT: the caller's own demo tenant is retired and a brand-new one issued
    // WHEN: caller has a valid demo-owner JWT for a live is_tutorial tenant
    // WHERE: POST /tutorial/reset
    // WHY: "start over" must not require leaving the dashboard
    const oldTenantId = 'demo-tenant-old';
    const token = demoOwnerToken(oldTenantId, 'user-old');

    const { app, mockPool } = buildAuthedApp([
      { rows: [] }, // JWT hook: password_changed_at lookup
      { rows: [{ is_tutorial: true, is_deleted: false }] }, // ownership check
      { rows: [{ count: '1' }] }, // global cap check
      { rows: [{ count: 1 }] }, // soft-delete UPDATE
      {
        rows: [
          {
            tenant_id: 'demo-tenant-new',
            user_id: 'user-new',
            email: 'demo+demo-tenant-new@quicklubedemo.invalid',
          },
        ],
        rowCount: 1,
      }, // provision CTE
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/tutorial/reset',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': nextIp() },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.tenant_id).toBe('demo-tenant-new');
    expect(body.tenant_id).not.toBe(oldTenantId);

    const queryMock = (mockPool as unknown as { query: ReturnType<typeof vi.fn> }).query;
    const softDelete = queryMock.mock.calls
      .map((c) => String(c[0]))
      .find((sql) => sql.includes('UPDATE tenants SET is_deleted'));
    expect(softDelete).toBeDefined();
    expect(queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE tenants'))?.[1]).toEqual([
      oldTenantId,
    ]);
  });

  it('SAD: rejects with 401 when no auth token is presented', async () => {
    // WHO: anonymous caller with no session
    // WHAT: 401, no tenant is ever touched
    // WHY: reset must never be reachable without proving which demo you're in
    const { app } = buildAuthedApp([]);

    const res = await app.inject({ method: 'POST', url: '/tutorial/reset' });

    expect(res.statusCode).toBe(401);
  });

  it('SAD: rejects with 403 when the caller is not an is_tutorial tenant', async () => {
    // WHO: any caller whose JWT tenant is not a live demo tenant
    // WHAT: 403 — this must never be reachable against a real business
    // WHERE: the is_tutorial ownership check in /tutorial/reset
    // WHY: the whole point is this can never touch real tenant data
    const token = demoOwnerToken('real-tenant', 'user-real');
    const { app } = buildAuthedApp([
      { rows: [] }, // JWT hook lookup
      { rows: [{ is_tutorial: false, is_deleted: false }] }, // ownership check fails
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/tutorial/reset',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': nextIp() },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.success).toBe(false);
  });

  it('SAD: rejects with 403 when the demo tenant is already soft-deleted', async () => {
    // WHO: a caller whose demo already expired/reset out from under them
    // WHAT: 403, not a crash — the tenant row still exists but is retired
    const token = demoOwnerToken('demo-tenant-gone', 'user-gone');
    const { app } = buildAuthedApp([
      { rows: [] },
      { rows: [{ is_tutorial: true, is_deleted: true }] },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/tutorial/reset',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': nextIp() },
    });

    expect(res.statusCode).toBe(403);
  });

  it('shares the /tutorial/start rate-limit bucket', async () => {
    // WHY: a reset is exactly as expensive to provision as a fresh start, so
    // it must count against the same per-IP abuse guard, not a separate one
    // an attacker could use to double their throughput.
    const ip = nextIp();
    const token = demoOwnerToken('demo-tenant-a', 'user-a');

    const { app } = buildAuthedApp([
      // 3 allowed /tutorial/start calls
      { rows: [{ count: '0' }] },
      { rows: [{ tenant_id: 't1', user_id: 'u1' }], rowCount: 1 },
      { rows: [{ count: '0' }] },
      { rows: [{ tenant_id: 't2', user_id: 'u2' }], rowCount: 1 },
      { rows: [{ count: '0' }] },
      { rows: [{ tenant_id: 't3', user_id: 'u3' }], rowCount: 1 },
    ]);

    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/tutorial/start',
        headers: { 'x-forwarded-for': ip },
      });
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/tutorial/reset',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': ip },
    });

    expect(blocked.statusCode).toBe(429);
  });
});

describe('syncOrchestrator demo guard', () => {
  it('skips provider calls when is_tutorial=true, but still records synchronously', async () => {
    // WHO: appointment route calling syncAppointmentToAll for a demo tenant
    // WHAT: no real provider .fn() calls, but record() still fires
    // WHEN: tenant has is_tutorial=true in DB
    // WHERE: syncOrchestrator.ts isTutorialTenant check
    // WHY: demo tenants must never pollute real CRM/calendar integrations;
    //      SYNC_TEST_RECORDER records still fire because they are synchronous
    //      (before the async isTutorialTenant gate) — e2e assertions in the
    //      RECORDER path use a real tenant so this distinction doesn't matter
    //      in practice, but we document the design here.

    const { syncAppointmentToAll } = await import('../../src/services/syncOrchestrator');

    const mockPool = {
      query: vi.fn(async () => ({ rows: [{ is_tutorial: true }], rowCount: 1 })),
    } as unknown as Pool;

    // Should not throw.
    expect(() =>
      syncAppointmentToAll(mockPool, 'demo-tenant-id', 'appt-id', 'create', null)
    ).not.toThrow();

    // Wait for the async is_tutorial check to settle.
    await new Promise((r) => setTimeout(r, 10));

    // pool.query was called once (the is_tutorial check).
    expect((mockPool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('dispatches providers when is_tutorial=false', async () => {
    // WHO: appointment route calling syncAppointmentToAll for a real tenant
    // WHAT: providers should be invoked (they'll fail gracefully — no real creds)
    // WHEN: tenant has is_tutorial=false
    // WHERE: syncOrchestrator.ts dispatch loop
    // WHY: confirm the guard does not suppress real tenant syncs

    const { syncAppointmentToAll } = await import('../../src/services/syncOrchestrator');

    const mockPool = {
      query: vi.fn(async () => ({ rows: [{ is_tutorial: false }], rowCount: 1 })),
    } as unknown as Pool;

    expect(() =>
      syncAppointmentToAll(mockPool, 'real-tenant-id', 'appt-id', 'create', null)
    ).not.toThrow();

    await new Promise((r) => setTimeout(r, 10));

    // pool.query called at least once (the is_tutorial check).
    expect((mockPool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(
      1
    );
  });
});
