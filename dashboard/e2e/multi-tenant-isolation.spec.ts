/**
 * E2E coverage for multi-tenant isolation at the live API surface.
 *
 * Why this exists: src/multi-tenant-isolation.test.ts (25 tests, shipped
 * 2026-05-06) is comprehensive at the unit level and pins the
 * tenantMiddleware + RLS gate against a real Postgres. But the unit
 * probe stubs the auth layer — it doesn't exercise the JWT cookie flow
 * or prove that a real running stack rejects URL-hacked requests.
 * If a future refactor breaks the gate at runtime (e.g. middleware
 * order in src/index.ts changes), the unit tests would still pass.
 *
 * These tests log in as a real tenant user, get a real JWT, then try
 * the highest-risk leak shapes:
 *   1. ?tenant_id=<other> query override on a GET — must 403 (May-6)
 *   2. body.tenant_id=<other> on a POST — must 403 (May-6)
 *   3. GET /tenants as a non-super-admin — must 403 (May-6)
 *   4. NO Authorization header + ?tenant_id=<uuid> — must 401, read AND
 *      write, at the real HTTP layer (May-21 anonymous-tenant hole; the
 *      unit Probe 8 stubs auth, this proves the running stack fails closed)
 * Plus a /ready readiness smoke (deep DB+pool probe shipped May-21).
 *
 * Each test is fully self-contained per the test-isolation memory:
 * creates its own per-tenant data in setup, asserts, deletes in
 * teardown. Any test runs independently in any order.
 */
import { test, expect } from './helpers/test';
import { type Page, request as playwrightRequest } from '@playwright/test';
import { Pool } from 'pg';
import { registerFreshTenant, cleanTenantData } from './helpers/fixtures';

const SUPER_ADMIN_ID = '00000000-0000-0000-0000-000000000000';
// "Other tenant" is Bella's Hair Studio — always seeded, stable UUID.
const OTHER_TENANT_ID = 'b3e1aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PG_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';
const BACKEND_URL = process.env.BACKEND_URL ?? 'https://localhost:4001';

let pool: Pool;
let attackerTenant: { tenantId: string; email: string };

function uniqueTag(): string {
  return `e2e-iso-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

/**
 * Get a JWT for a real tenant user via the /login route. Different from
 * other specs' getApiToken — this one returns the full response so the
 * test can assert on the auth payload's tenant_id (catches a regression
 * where login leaks the wrong tenant_id into the JWT).
 */
async function loginAs(
  page: Page,
  email: string,
  password: string
): Promise<{
  token: string;
  tenant_id: string;
  role: string;
}> {
  const result = await page.evaluate(
    async ({ url, email, password }) => {
      const res = await fetch(`${url}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return await res.json();
    },
    { url: BACKEND_URL, email, password }
  );
  if (!result?.token) throw new Error(`Login failed: ${JSON.stringify(result)}`);
  return result;
}

async function apiGet(
  page: Page,
  token: string,
  path: string
): Promise<{ status: number; body: Record<string, unknown> | unknown[] }> {
  return await page.evaluate(
    async ({ url, token, path }) => {
      const res = await fetch(`${url}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    },
    { url: BACKEND_URL, token, path }
  );
}

async function apiPost(
  page: Page,
  token: string,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  return await page.evaluate(
    async ({ url, token, path, body }) => {
      const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const responseBody = await res.json().catch(() => ({}));
      return { status: res.status, body: responseBody };
    },
    { url: BACKEND_URL, token, path, body }
  );
}

test.beforeAll(async () => {
  pool = new Pool({ connectionString: PG_URL });
  // Register a fresh ephemeral tenant to serve as the "attacker" in
  // cross-tenant isolation probes. Using a registered-fresh tenant
  // means the test never depends on seed data and cleans up after itself.
  const ctx = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
  attackerTenant = await registerFreshTenant(ctx);
  await ctx.dispose();
});
test.afterAll(async () => {
  await cleanTenantData(pool, attackerTenant.tenantId);
  await pool.end();
});

// ────────────────────────────────────────────────────────────────────────────
// 1. Query-string ?tenant_id=<other> override is rejected
// ────────────────────────────────────────────────────────────────────────────
test('isolation: ?tenant_id=<other tenant> on GET is rejected with 403', async ({ page }) => {
  // WHO: malicious attacker tenant user trying to peek at Bella's
  //        customer list by URL-hacking the tenant_id query param
  // WHAT: the tenantMiddleware gate (src/middleware.ts, added 2026-05-06)
  //        must 403 any cross-tenant override unless the caller is super-admin
  // WHEN: any GET /customers, /employees, /resources, /appointments, etc.
  //        with ?tenant_id=<not-my-tenant>
  // WHERE: tenantMiddleware precedence: query > body > JWT, gated by role
  // WHY: the May-6 unit probe found 8 read-leak shapes before this gate
  //        existed. This test pins the runtime behavior — if a refactor
  //        re-orders middleware or drops the role check, this fails fast.
  const tag = uniqueTag();
  let bellaCustomerId: string | null = null;

  try {
    // Setup: insert a customer in Bella's tenant that we'll try to leak.
    const ins = await pool.query(
      `INSERT INTO customers (tenant_id, name, phone)
       VALUES ($1, $2, $3) RETURNING customer_id`,
      [OTHER_TENANT_ID, `${tag}-other-secret`, '+15551112222']
    );
    bellaCustomerId = ins.rows[0].customer_id;

    // Login as the attacker tenant — gets JWT scoped to that tenant.
    const auth = await loginAs(page, attackerTenant.email, 'password123');
    expect(auth.tenant_id).toBe(attackerTenant.tenantId);

    // Sanity: same call WITHOUT the override returns the attacker's own customers.
    const ownTenant = await apiGet(page, auth.token, '/customers');
    expect(ownTenant.status).toBe(200);
    expect(Array.isArray(ownTenant.body)).toBe(true);
    const attackerNames = (ownTenant.body as Array<{ name?: string }>).map((c) => c.name);
    expect(
      attackerNames,
      "Attacker tenant user must NOT see Bella's customer in their own list"
    ).not.toContain(`${tag}-other-secret`);

    // Attack: same user tries ?tenant_id=<Bella> override.
    const cross = await apiGet(page, auth.token, `/customers?tenant_id=${OTHER_TENANT_ID}`);
    expect(cross.status, 'cross-tenant override must be 403').toBe(403);

    // Even if the body somehow returned, it must NOT contain Bella's data.
    if (Array.isArray(cross.body)) {
      const names = (cross.body as Array<{ name?: string }>).map((c) => c.name);
      expect(names).not.toContain(`${tag}-other-secret`);
    }
  } finally {
    if (bellaCustomerId) {
      await pool.query('DELETE FROM customers WHERE customer_id = $1', [bellaCustomerId]);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 2. body.tenant_id=<other> on POST is rejected (write-injection)
// ────────────────────────────────────────────────────────────────────────────
test('isolation: body.tenant_id=<other tenant> on POST /customers/create is rejected', async ({
  page,
}) => {
  // WHO: malicious attacker tenant user trying to inject a customer row under
  //        Bella's tenant_id (ghost-write attack)
  // WHAT: the same tenantMiddleware gate must 403 a cross-tenant body
  //        override; mismatched query-vs-body returns 400
  // WHEN: any mutation route that takes tenant_id in the body
  // WHERE: tenantMiddleware body-tenant_id branch
  // WHY: the May-6 probe found 4 write-injection shapes before this gate.
  //        Customer-write to another tenant would: (a) populate that
  //        tenant's CRM with fake leads, (b) seed the booking flow with
  //        an attacker-controlled phone the agent could call back to.
  //        Both of those are tracked and pinned here.
  const tag = uniqueTag();

  // Snapshot Bella's customer count before — must be unchanged after attack.
  const beforeRes = await pool.query(
    `SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1`,
    [OTHER_TENANT_ID]
  );
  const beforeCount = beforeRes.rows[0].n;

  const auth = await loginAs(page, attackerTenant.email, 'password123');
  expect(auth.tenant_id).toBe(attackerTenant.tenantId);

  // Attack: try to inject a customer into Bella's tenant.
  const inject = await apiPost(page, auth.token, '/customers/create', {
    tenant_id: OTHER_TENANT_ID,
    name: `${tag}-injected`,
    phone: '+15551112222',
  });
  expect(inject.status, 'cross-tenant write must be 403').toBe(403);

  // Bella's count is unchanged — no row got injected.
  const afterRes = await pool.query(
    `SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1`,
    [OTHER_TENANT_ID]
  );
  expect(afterRes.rows[0].n).toBe(beforeCount);

  // Defense-in-depth: even if a row was somehow created, it would not
  // have the injected tag. Verify by name.
  const byName = await pool.query(`SELECT count(*)::int AS n FROM customers WHERE name = $1`, [
    `${tag}-injected`,
  ]);
  expect(byName.rows[0].n, 'injected row must not exist anywhere').toBe(0);
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Non-super-admin GET /tenants is rejected
// ────────────────────────────────────────────────────────────────────────────
test('isolation: non-super-admin GET /tenants is rejected (no enumeration)', async ({ page }) => {
  // WHO: any tenant user (attacker tenant owner) trying to enumerate every
  //        tenant on the platform
  // WHAT: GET /tenants must 403 unless the caller is super-admin
  // WHEN: requireSuperAdmin gate (added 2026-05-06) is applied to /tenants
  //        and other cross-tenant admin routes
  // WHERE: src/middleware.ts requireSuperAdmin + src/routes/tenants.ts
  // WHY: pre-fix, ANY authenticated user could enumerate every tenant
  //        on the platform — full customer list, voice config, billing
  //        tier visible to anyone with a JWT. Critical breach in a paying-
  //        tenant SaaS. This test pins the gate at runtime.
  const auth = await loginAs(page, attackerTenant.email, 'password123');
  expect(auth.tenant_id).toBe(attackerTenant.tenantId);

  const res = await apiGet(page, auth.token, '/tenants');
  expect(res.status, 'tenant enumeration must be 403 for non-super-admin').toBe(403);
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Positive control — super-admin CAN cross tenants by design
// ────────────────────────────────────────────────────────────────────────────
test('isolation: super-admin CAN read across tenants (positive control)', async ({ page }) => {
  // WHO: super-admin (admin@secretaryhq.com), tenant_id 0000-0000-...
  // WHAT: same query that 403s for a tenant user must succeed for super-admin
  // WHEN: any cross-tenant operation — super-admin manages all tenants
  // WHERE: tenantMiddleware role-check + requireSuperAdmin gate
  // WHY: a too-tight gate that 403s super-admin would break the management
  //        UI. This positive control catches over-correction. Without it,
  //        a refactor that hardens the gate could lock the admin out and
  //        we'd only find out at the next browser session.
  const auth = await loginAs(page, 'admin@secretaryhq.com', 'p@ssw0rd');
  expect(auth.tenant_id).toBe(SUPER_ADMIN_ID);

  // GET /tenants must succeed for super-admin.
  const tenants = await apiGet(page, auth.token, '/tenants');
  expect(tenants.status).toBe(200);
  expect(Array.isArray(tenants.body), 'super-admin gets a tenant list').toBe(true);
  // GET /tenants returns rows with the renamed `tenant_id` PK column
  // (May 12 pilot 16). No backward-compat `AS id` alias was added on this
  // route — unlike /customers and a handful of others — so reading `.id`
  // here would silently produce an array of undefineds and the
  // .toContain() below would fail. Origin: 2026-05-13 audit.
  const ids = (tenants.body as Array<{ tenant_id: string }>).map((t) => t.tenant_id);
  expect(ids, 'super-admin sees the attacker tenant').toContain(attackerTenant.tenantId);
  expect(ids, 'super-admin sees other tenant').toContain(OTHER_TENANT_ID);

  // Cross-tenant query override is allowed for super-admin.
  const cross = await apiGet(page, auth.token, `/customers?tenant_id=${OTHER_TENANT_ID}`);
  expect(cross.status, 'super-admin cross-tenant query is permitted').toBe(200);
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Anonymous (no JWT) access with a supplied tenant_id is rejected (May-21)
// ────────────────────────────────────────────────────────────────────────────

/** Fetch with NO Authorization header — simulates an unauthenticated attacker. */
async function apiAnon(
  page: Page,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; raw: string }> {
  return await page.evaluate(
    async ({ url, method, path, body }) => {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, raw: await res.text() };
    },
    { url: BACKEND_URL, method, path, body }
  );
}

test('isolation: anonymous GET ?tenant_id=<other> with no token is rejected 401 and leaks nothing', async ({
  page,
}) => {
  // WHO: an unauthenticated caller — no Authorization header at all
  // WHAT: GET /customers?tenant_id=<other> hoping the server trusts the
  //       query tenant_id without a JWT to validate it against
  // WHEN: 2026-05-21 — found that this returned that tenant's data (200)
  //       because the cross-tenant guard only fired when a jwtTenant existed
  // WHERE: src/middleware.ts tenantMiddleware auth gate (real running stack)
  // WHY: strictly worse than the authed override (cases 1-2) — no
  //       credentials needed at all. Must fail closed (401) at runtime, not
  //       just in the auth-stubbed unit probe.
  const res = await apiAnon(page, 'GET', `/customers?tenant_id=${OTHER_TENANT_ID}`);
  expect(res.status, 'anonymous tenant read must be 401').toBe(401);
  // Body must carry no tenant data — only the auth error.
  expect(res.raw).not.toContain(OTHER_TENANT_ID);
  expect(res.raw.toLowerCase()).toContain('authentication required');
});

test('isolation: anonymous POST with body.tenant_id and no token is rejected 401 (no write)', async ({
  page,
}) => {
  // WHO: unauthenticated caller attempting a cross-tenant write
  // WHAT: POST /customers/create with body.tenant_id=<other>, no token
  // WHEN: 2026-05-21 — the write/delete paths rode the same hole
  // WHERE: tenantMiddleware auth gate, before the handler runs
  // WHY: an anonymous write is worse than a read — must be blocked before
  //       any INSERT. Verify both the 401 and that no row landed.
  const before = await pool.query('SELECT COUNT(*) FROM customers WHERE tenant_id = $1', [
    OTHER_TENANT_ID,
  ]);
  const res = await apiAnon(page, 'POST', '/customers/create', {
    tenant_id: OTHER_TENANT_ID,
    name: 'e2e-anon-injected',
    phone: '+15550000123',
  });
  expect(res.status, 'anonymous tenant write must be 401').toBe(401);
  const after = await pool.query('SELECT COUNT(*) FROM customers WHERE tenant_id = $1', [
    OTHER_TENANT_ID,
  ]);
  expect(after.rows[0].count, 'no customer row created under the other tenant').toBe(
    before.rows[0].count
  );
});

// ────────────────────────────────────────────────────────────────────────────
// 6. /ready readiness probe (deep DB + pool stats) — shipped 2026-05-21
// ────────────────────────────────────────────────────────────────────────────
test('readiness: GET /ready returns 200 with db:ok and pool stats on a healthy stack', async ({
  page,
}) => {
  // WHO: a monitor / load balancer / on-call engineer
  // WHAT: GET /ready (public, no auth) pings the DB and reports pool
  //       saturation; 200 + {db:ok, pool:{...}} when the stack is healthy
  // WHEN: every scrape — the signal we page on (503 / sustained waiting>0)
  // WHERE: src/index.ts /ready handler against the real running backend
  // WHY: /health is shallow liveness; /ready is the only end-to-end proof
  //       the process can actually reach Postgres. A regression that breaks
  //       the DB ping or the pool-stats shape would silence alerting.
  const res = await apiAnon(page, 'GET', '/ready');
  expect(res.status, '/ready must be public + 200 on a healthy stack').toBe(200);
  const body = JSON.parse(res.raw) as {
    status: string;
    db: string;
    pool: { total: number; idle: number; waiting: number };
  };
  expect(body.status).toBe('ready');
  expect(body.db).toBe('ok');
  expect(body.pool).toBeDefined();
  expect(typeof body.pool.waiting).toBe('number');
});
