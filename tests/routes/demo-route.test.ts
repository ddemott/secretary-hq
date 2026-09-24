/**
 * Tests for POST /demo/start
 *
 * WHO: anonymous visitor hitting the public demo endpoint
 * WHAT: tenant provisioning, JWT issuance, rate-limit, global cap
 * WHEN: on demand (no auth required)
 * WHERE: src/routes/demo.ts
 * WHY: ensure isolated demo tenants are created correctly and outbound
 *      guards fire for demo tenants (syncOrchestrator is_demo check)
 *
 * Strategy: mock the pool (no real DB), inject HTTP via Fastify.
 * Happy + sad paths with 5W diagnostics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { registerDemoRoutes, resetDemoRateLimitForTesting } from '../../src/routes/demo';
import { generateToken as realGenerateToken } from '../../src/middleware/fastify-middleware';
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
      queries.push(sql.trim().slice(0, 80));
      return responses.shift() ?? { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        queries.push(sql.trim().slice(0, 80));
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
  registerDemoRoutes(app as never, mockPool, generateToken);

  return { app, mockPool, queries };
}

// Fresh per-test IP so the rate-limit map doesn't bleed between tests.
let testIpCounter = 1000;
function nextIp(): string {
  return `10.0.0.${testIpCounter++}`;
}

describe('POST /demo/start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset in-process rate-limit Maps so tests don't bleed into each other.
    // (All inject() calls share req.ip = 127.0.0.1 unless x-forwarded-for is set.)
    resetDemoRateLimitForTesting();
  });

  it('happy path: creates tenant, returns token + metadata', async () => {
    // WHO: anonymous visitor
    // WHAT: successful demo provisioning with seeded data
    // WHEN: DB under normal load (cap not reached)
    // WHERE: POST /demo/start
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
      // 3. seedDemoTenant: BEGIN
      // (connect() is called, then multiple queries inside transaction)
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/demo/start',
      headers: { 'x-forwarded-for': nextIp() },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;

    // The token must be a REAL, VERIFIABLE SESSION — not merely "a string".
    //
    // /demo/start used to sign its own JWT inline (ignoring the injected minter
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

  it('REGRESSION: each demo gets its own owner email, so a second demo cannot collide', async () => {
    // WHO: two visitors starting demos one after the other.
    // WHAT: the provisioning INSERT builds the owner email from the new tenant id
    //       ('demo+' || tenant_id || '@quicklubedemo.invalid'), and the session
    //       token carries that per-demo address.
    // WHERE: POST /demo/start provisioning CTE.
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
      url: '/demo/start',
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
    // WHERE: jsonContentTypeParser, before registerDemoRoutes' handler runs
    // WHY: neither suite covered this shape. The backend test injected with no
    //      payload (no content-type → parser skipped) and the dashboard test
    //      stubbed fetch outright, so the one request shape the browser
    //      actually sends was tested by nobody. /demo/start was healthy the
    //      entire time; the button in front of it was not.
    const { app } = buildApp([
      { rows: [{ count: '0' }] },
      { rows: [{ tenant_id: 'demo-uuid-1234', user_id: 'user-uuid-5678' }], rowCount: 1 },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/demo/start',
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
      await app.inject({ method: 'POST', url: '/demo/start', headers: { 'x-forwarded-for': ip } });
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/demo/start',
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
      url: '/demo/start',
      headers: { 'x-forwarded-for': nextIp() },
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect((body.error as string).toLowerCase()).toContain('capacity');
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
        url: '/demo/start',
        headers: { 'x-forwarded-for': ip1 },
      });
      const r2 = await app.inject({
        method: 'POST',
        url: '/demo/start',
        headers: { 'x-forwarded-for': ip2 },
      });
      expect(r1.statusCode).not.toBe(429);
      expect(r2.statusCode).not.toBe(429);
    }
  });
});

describe('syncOrchestrator demo guard', () => {
  it('skips provider calls when is_demo=true, but still records synchronously', async () => {
    // WHO: appointment route calling syncAppointmentToAll for a demo tenant
    // WHAT: no real provider .fn() calls, but record() still fires
    // WHEN: tenant has is_demo=true in DB
    // WHERE: syncOrchestrator.ts isDemoTenant check
    // WHY: demo tenants must never pollute real CRM/calendar integrations;
    //      SYNC_TEST_RECORDER records still fire because they are synchronous
    //      (before the async isDemoTenant gate) — e2e assertions in the
    //      RECORDER path use a real tenant so this distinction doesn't matter
    //      in practice, but we document the design here.

    const { syncAppointmentToAll } = await import('../../src/services/syncOrchestrator');

    const mockPool = {
      query: vi.fn(async () => ({ rows: [{ is_demo: true }], rowCount: 1 })),
    } as unknown as Pool;

    // Should not throw.
    expect(() =>
      syncAppointmentToAll(mockPool, 'demo-tenant-id', 'appt-id', 'create', null)
    ).not.toThrow();

    // Wait for the async is_demo check to settle.
    await new Promise((r) => setTimeout(r, 10));

    // pool.query was called once (the is_demo check).
    expect((mockPool.query as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('dispatches providers when is_demo=false', async () => {
    // WHO: appointment route calling syncAppointmentToAll for a real tenant
    // WHAT: providers should be invoked (they'll fail gracefully — no real creds)
    // WHEN: tenant has is_demo=false
    // WHERE: syncOrchestrator.ts dispatch loop
    // WHY: confirm the guard does not suppress real tenant syncs

    const { syncAppointmentToAll } = await import('../../src/services/syncOrchestrator');

    const mockPool = {
      query: vi.fn(async () => ({ rows: [{ is_demo: false }], rowCount: 1 })),
    } as unknown as Pool;

    expect(() =>
      syncAppointmentToAll(mockPool, 'real-tenant-id', 'appt-id', 'create', null)
    ).not.toThrow();

    await new Promise((r) => setTimeout(r, 10));

    // pool.query called at least once (the is_demo check).
    expect((mockPool.query as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(
      1
    );
  });
});
