/**
 * Route-level tests for the team-login management endpoints:
 *   GET  /users              — list logins for current tenant
 *   POST /users/invite       — create user + email password-set link
 *   PATCH /users/:id/role    — change a user's role
 *
 * These routes back the "Logins" sub-tab under Back Office. They are the
 * only place an owner can promote a teammate to front_desk (or back) and
 * the only programmatic way to create a new login that isn't a tenant
 * registration. The whole role-gating story (Back Office hidden from
 * front_desk) collapses if these routes accept calls from a front_desk
 * user — those tests exist below and would fail loudly if the
 * `requireOwner` gate is ever removed.
 *
 * Email delivery is mocked: the routes still must construct the right
 * link + role + business name, but we don't depend on a real SMTP.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

// Mock the email sender so route tests don't reach for nodemailer.
vi.mock('../../src/services/communications/systemEmail', () => ({
  sendUserInviteEmail: vi.fn(async () => undefined),
  sendPasswordResetEmail: vi.fn(async () => undefined),
}));

import { registerUserRoutes } from '../../src/routes/users';
import {
  createMockClient,
  createMockPool,
  createMockWithTenantClient,
  type MockClient,
  type MockResponse,
} from '../mock';

// Real v4 UUIDs — Zod schemas reject pattern fillers.
const TENANT_ID = 'f234e471-0e60-4163-86c9-93cfd9338e3a';
const SUPER_ADMIN_TENANT = '00000000-0000-0000-0000-000000000000';
const OWNER_USER_ID = 'a1b2c3d4-e5f6-4789-ab12-cdef34567890';
const OTHER_USER_ID = 'b2c3d4e5-f6a7-489b-9cde-f1234567890a';

let app: FastifyInstance;
let mockClient: MockClient;
let queryResponses: MockResponse[];
let queries: { text: string; params: unknown[] }[];
let authStub: {
  tenant_id: string;
  user_id: string;
  email: string;
  role: 'owner' | 'front_desk';
} | null;

function buildApp() {
  const handle = createMockClient();
  mockClient = handle.mockClient;
  queryResponses = handle.queryResponses;
  queries = handle.queries;
  const mockPool = createMockPool(mockClient);
  const withTenantClient = createMockWithTenantClient(mockClient);

  const fastify = Fastify({ logger: false });

  // Stub auth + tenant context. Tests set authStub in beforeEach.
  fastify.addHook('preHandler', async (request) => {
    (request as unknown as { auth: typeof authStub }).auth = authStub;
    const q = request.query as Record<string, string> | undefined;
    const body = request.body as Record<string, string> | undefined;
    const tid = q?.tenant_id || body?.tenant_id || authStub?.tenant_id;
    if (tid) (request as unknown as { tenantId: string }).tenantId = tid;
  });

  registerUserRoutes(
    fastify,
    mockPool,
    withTenantClient as Parameters<typeof registerUserRoutes>[2]
  );
  return fastify;
}

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  queryResponses.length = 0;
  // Default: authenticated as the tenant owner.
  authStub = {
    tenant_id: TENANT_ID,
    user_id: OWNER_USER_ID,
    email: 'owner@biz.com',
    role: 'owner',
  };
});

// ════════════════════════════════════════════════════════════════════
// GET /users — list logins
// ════════════════════════════════════════════════════════════════════

describe('GET /users — happy paths', () => {
  it('HAPPY: owner sees the team list, with is_self=true on their own row', async () => {
    // WHO: tenant owner opening the Logins sub-tab
    // WHAT: route SELECTs all users for the tenant (RLS-scoped via
    //       withTenantClient) and tags the requester's row so the UI
    //       can disable the role dropdown for self
    // WHEN: every page-load of Back Office → Logins
    // WHERE: src/routes/users.ts → app.get('/users', ...)
    // WHY: without `is_self`, the UI would let an owner change their
    //      own role to front_desk and immediately lose Back Office
    //      access on next refresh — a foot-gun the API also rejects
    //      but should never even be attempted by the UI
    queryResponses.push({
      rows: [
        {
          user_id: OWNER_USER_ID,
          email: 'owner@biz.com',
          full_name: 'Owner',
          role: 'owner',
          created_at: '2026-01-01',
        },
        {
          user_id: OTHER_USER_ID,
          email: 'desk@biz.com',
          full_name: 'Desk Staff',
          role: 'front_desk',
          created_at: '2026-02-01',
        },
      ],
      rowCount: 2,
    });

    const res = await app.inject({ method: 'GET', url: `/users?tenant_id=${TENANT_ID}` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.users).toHaveLength(2);
    expect(body.users[0]).toMatchObject({ user_id: OWNER_USER_ID, role: 'owner', is_self: true });
    expect(body.users[1]).toMatchObject({
      user_id: OTHER_USER_ID,
      role: 'front_desk',
      is_self: false,
    });
  });
});

describe('GET /users — sad paths', () => {
  it('SAD: front_desk role is denied with 403 — never sees teammate emails', async () => {
    // WHO: a front_desk user who tried to URL-hack to /users
    // WHAT: requireOwner gate fires before any DB query
    // WHEN: e.g. a curious staff member with the dashboard open
    // WHERE: requireOwner() inside the GET /users handler
    // WHY: front_desk users should not be able to enumerate teammates'
    //      emails — that's a tiny info-leak that compounds with phishing
    authStub = {
      tenant_id: TENANT_ID,
      user_id: OTHER_USER_ID,
      email: 'desk@biz.com',
      role: 'front_desk',
    };

    const res = await app.inject({ method: 'GET', url: `/users?tenant_id=${TENANT_ID}` });

    expect(res.statusCode).toBe(403);
    expect(queries).toHaveLength(0);
  });

  it('SAD: missing auth context → 401 before the DB is touched', async () => {
    // WHO: unauthenticated request reaching the endpoint
    // WHAT: requireOwner sees req.auth=null and returns 401 immediately
    // WHY: the handler must not run a SELECT * users query without an
    //      authenticated principal; logs would have no actor
    authStub = null;

    const res = await app.inject({ method: 'GET', url: `/users?tenant_id=${TENANT_ID}` });

    expect(res.statusCode).toBe(401);
    expect(queries).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// POST /users/invite
// ════════════════════════════════════════════════════════════════════

describe('POST /users/invite — happy paths', () => {
  it('HAPPY: creates user, writes reset token, and triggers invite email', async () => {
    // WHO: owner adding a front-desk teammate
    // WHAT: route resolves business name, INSERTs the user (placeholder
    //       password hash), INSERTs a password_resets row, sends the
    //       invite email with the magic link, returns 201 + user_id
    // WHEN: owner submits the Invite modal in the Logins sub-tab
    // WHERE: src/routes/users.ts → app.post('/users/invite', ...)
    // WHY: pinning the SQL ordering protects against a subtle bug — if
    //      the password_resets INSERT moved before the users INSERT, FK
    //      constraint would fail. If the email were sent first and the
    //      DB writes failed, the recipient would click a 404 link.
    //      The current order (user → token → email) is correct; this
    //      test fails fast if anyone reorders it.
    const sysmail = await import('../../src/services/communications/systemEmail');
    vi.mocked(sysmail.sendUserInviteEmail).mockClear();

    queryResponses.push({ rows: [{ name: 'DynaTire' }], rowCount: 1 }); // tenants lookup
    queryResponses.push({ rows: [], rowCount: 0 }); // platform-wide email check — free
    queryResponses.push({ rows: [{ user_id: OTHER_USER_ID }], rowCount: 1 }); // INSERT users
    queryResponses.push({ rows: [], rowCount: 1 }); // INSERT password_resets

    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: {
        tenant_id: TENANT_ID,
        email: 'NEW@biz.com',
        full_name: 'New Hire',
        role: 'front_desk',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ success: true, user_id: OTHER_USER_ID });

    const insertUser = queries.find((q) => q.text.startsWith('INSERT INTO users'));
    expect(insertUser).toBeDefined();
    // Email must be lowercased and trimmed before insert.
    expect(insertUser!.params[1]).toBe('new@biz.com');
    expect(insertUser!.params[3]).toBe('New Hire');
    expect(insertUser!.params[4]).toBe('front_desk');

    expect(sysmail.sendUserInviteEmail).toHaveBeenCalledTimes(1);
    const [to, link, ttl, biz, role] = vi.mocked(sysmail.sendUserInviteEmail).mock.calls[0];
    expect(to).toBe('new@biz.com');
    expect(link).toMatch(/\/reset-password\?token=[A-Za-z0-9_-]{30,}/);
    expect(ttl).toBeGreaterThan(0);
    expect(biz).toBe('DynaTire');
    expect(role).toBe('front_desk');
  });
});

describe('POST /users/invite — sad paths', () => {
  it('SAD: front_desk caller is denied with 403 — cannot invite teammates', async () => {
    // WHO: a front_desk user who tried to invite their friend
    // WHAT: requireOwner gate blocks before any DB write
    // WHY: only owners can grow the team — otherwise a compromised
    //      front_desk login could escalate by inviting an owner-level
    //      account it controls
    authStub = {
      tenant_id: TENANT_ID,
      user_id: OTHER_USER_ID,
      email: 'desk@biz.com',
      role: 'front_desk',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { tenant_id: TENANT_ID, email: 'x@x.com', full_name: 'X', role: 'owner' },
    });

    expect(res.statusCode).toBe(403);
    expect(queries).toHaveLength(0);
  });

  it('SAD: invalid role payload → 400, no DB writes', async () => {
    // WHO: client sending a payload with role='admin' (typo / unknown role)
    // WHAT: Zod enum rejects, route returns 400 before touching the DB
    // WHY: keeps the role column constrained to the two values the UI
    //      knows; prevents future migrations from inheriting bad rows
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { tenant_id: TENANT_ID, email: 'x@x.com', full_name: 'X', role: 'admin' },
    });

    expect(res.statusCode).toBe(400);
    expect(queries).toHaveLength(0);
  });

  it('SAD: 404 when the named tenant does not exist', async () => {
    // WHO: super-admin inviting into a deleted tenant id (stale UI cache)
    // WHAT: tenant lookup returns no rows → 404 before user INSERT
    // WHY: without this guard, the user row would land in `users` with
    //      a tenant_id that has no `tenants` row to FK against (FK would
    //      fail anyway, but a clear 404 is friendlier than the FK error)
    queryResponses.push({ rows: [], rowCount: 0 }); // tenants lookup empty

    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { tenant_id: TENANT_ID, email: 'x@x.com', full_name: 'X', role: 'front_desk' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('SAD: 409 when the email already has an account in ANY business — no user is created', async () => {
    // WHO: owner inviting someone who already signs in to a different business.
    // WHAT: platform-wide, case-insensitive email check finds them → 409, and
    //       the users INSERT never runs.
    // WHEN: the invite email matches an existing users.email in another tenant.
    // WHERE: src/routes/users.ts POST /users/invite, before the INSERT.
    // WHY: owner decision 2026-09-24 — one account per email across the whole
    //      platform; the DB's own UNIQUE is only per tenant, so it would allow this.
    queryResponses.push({ rows: [{ name: 'DynaTire' }], rowCount: 1 }); // tenants lookup
    queryResponses.push({ rows: [{ '?column?': 1 }], rowCount: 1 }); // email taken elsewhere

    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: {
        tenant_id: TENANT_ID,
        email: 'Taken@Elsewhere.com',
        full_name: 'Already Has One',
        role: 'front_desk',
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already has a SecretaryHQ account/);
    const emailCheck = queries.find((q) => q.text.includes('LOWER(email) = LOWER($1)'));
    expect(emailCheck?.params[0]).toBe('taken@elsewhere.com');
    expect(queries.some((q) => q.text.startsWith('INSERT INTO users'))).toBe(false);
  });

  it('SAD: 409 when the user already exists for that tenant', async () => {
    // WHO: owner re-inviting an email already on the team
    // WHAT: the users insert hits the (tenant_id, email) unique
    //       constraint → pg code 23505 → route translates to 409
    // WHY: returning a generic 500 would have the UI show a scary
    //      error; 409 + clear message lets the UI say "already on team"
    // First call (tenant lookup): return business row.
    // Second call (INSERT users): throw a Postgres unique-violation.
    // Chaining mockImplementationOnce keeps each call's behavior pinned
    // to its position regardless of when the test schedules them.
    mockClient.query.mockImplementationOnce(async (text: string, params?: unknown[]) => {
      queries.push({ text, params: params || [] });
      return { rows: [{ name: 'DynaTire' }], rowCount: 1 };
    });
    // Platform-wide email check passes (a race lets the INSERT still collide).
    mockClient.query.mockImplementationOnce(async (text: string, params?: unknown[]) => {
      queries.push({ text, params: params || [] });
      return { rows: [], rowCount: 0 };
    });
    const dupErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockClient.query.mockImplementationOnce(async (text: string, params?: unknown[]) => {
      queries.push({ text, params: params || [] });
      throw dupErr;
    });

    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: {
        tenant_id: TENANT_ID,
        email: 'dupe@biz.com',
        full_name: 'Dupe',
        role: 'front_desk',
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ success: false });
  });
});

// ════════════════════════════════════════════════════════════════════
// PATCH /users/:id/role
// ════════════════════════════════════════════════════════════════════

describe('PATCH /users/:id/role — happy paths', () => {
  it('HAPPY: owner promotes front_desk teammate to owner', async () => {
    // WHO: owner clicking the role dropdown on a teammate's row
    // WHAT: route runs UPDATE users SET role = $1 ... RETURNING role
    // WHEN: any role change in the Logins sub-tab
    // WHERE: src/routes/users.ts → app.patch('/users/:id/role', ...)
    // WHY: lets the owner trust the UI dropdown — the SQL must touch
    //      exactly one row scoped to their tenant
    queryResponses.push({ rows: [{ user_id: OTHER_USER_ID, role: 'owner' }], rowCount: 1 });

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${OTHER_USER_ID}/role`,
      payload: { tenant_id: TENANT_ID, role: 'owner' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, role: 'owner' });

    const update = queries.find((q) => q.text.startsWith('UPDATE users SET role'));
    expect(update).toBeDefined();
    expect(update!.params).toEqual(['owner', OTHER_USER_ID, TENANT_ID]);
  });
});

describe('PATCH /users/:id/role — sad paths', () => {
  it('SAD: 400 when an owner tries to change their own role', async () => {
    // WHO: owner clicking their own row's dropdown (UI should already
    //      have disabled it via is_self, but the API enforces too)
    // WHAT: request hits the user_id === auth.user_id guard → 400
    // WHY: an owner demoting themselves to front_desk would lose Back
    //      Office on next refresh AND lose the Logins sub-tab where
    //      they could undo it — a hard lockout requiring SQL fix
    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${OWNER_USER_ID}/role`,
      payload: { tenant_id: TENANT_ID, role: 'front_desk' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/own role/i);
    expect(queries).toHaveLength(0);
  });

  it('SAD: super-admin CAN change their own role (gate is tenant-scoped, not super-admin)', async () => {
    // WHO: super-admin (tenant_id = SUPER_ADMIN_TENANT) editing their
    //      own user record's role
    // WHAT: the self-change guard is intentionally skipped for super-
    //       admins — their access is determined by tenant_id, not the
    //       role column, so demoting their user record is harmless
    // WHY: pinning this carve-out so a future "tighten the guard" pass
    //      doesn't accidentally lock super-admins out of /users for
    //      no real safety gain
    authStub = {
      tenant_id: SUPER_ADMIN_TENANT,
      user_id: OWNER_USER_ID,
      email: 'admin@biz.com',
      role: 'owner',
    };
    queryResponses.push({ rows: [{ user_id: OWNER_USER_ID, role: 'front_desk' }], rowCount: 1 });

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${OWNER_USER_ID}/role`,
      payload: { tenant_id: SUPER_ADMIN_TENANT, role: 'front_desk' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('SAD: 404 when the user id does not belong to the tenant', async () => {
    // WHO: owner with a stale UI list racing a concurrent delete, OR
    //      an attacker probing other tenants' user ids
    // WHAT: UPDATE matches zero rows → 404
    // WHY: prevents silent no-op success that would hide stale UI
    //      state; also prevents cross-tenant role updates because the
    //      WHERE clause pins tenant_id alongside id
    queryResponses.push({ rows: [], rowCount: 0 });

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${OTHER_USER_ID}/role`,
      payload: { tenant_id: TENANT_ID, role: 'owner' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('SAD: front_desk caller is denied with 403', async () => {
    // WHO: front_desk user trying to self-promote via direct API call
    // WHAT: requireOwner gate fires; no DB query
    // WHY: a front_desk login that could change roles could escalate
    //      itself to owner — that's the privilege boundary this whole
    //      feature exists to enforce
    authStub = {
      tenant_id: TENANT_ID,
      user_id: OTHER_USER_ID,
      email: 'desk@biz.com',
      role: 'front_desk',
    };

    const res = await app.inject({
      method: 'PATCH',
      url: `/users/${OTHER_USER_ID}/role`,
      payload: { tenant_id: TENANT_ID, role: 'owner' },
    });

    expect(res.statusCode).toBe(403);
    expect(queries).toHaveLength(0);
  });
});
