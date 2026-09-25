/**
 * Route-level tests for the destructive tenant routes:
 *   DELETE /tenants/:id        — admin removes a tenant entirely
 *   POST /tenants/reorder      — admin saves a new sort_order across tenants
 *
 * These are the two routes whose failure modes can lose customer data
 * (delete) or scramble the admin tenant picker (reorder), so the test
 * file pins both happy paths and the validation/auth/rollback contracts.
 *
 * The DB-level reorder schema is covered separately in
 * `src/tenant-reorder.test.ts` (real Postgres, schema + ORDER BY contract).
 * This file covers the route handler surface — auth gates, payload
 * validation, the BEGIN/COMMIT shape, and the response envelope.
 *
 * Origin: historical major refactor (see RESOLVED.md) "Add tests for destructive flows" —
 * the verify-first found that DELETE /tenants/:id and POST /tenants/reorder
 * had no route-handler-level coverage despite the dashboard side
 * exercising them via superadmin.test.tsx.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerTenantRoutes } from '../../src/routes/tenants';
import { createMockClient, createMockPool, type MockClient, type MockResponse } from '../mock';

// Real v4 UUIDs — Zod schemas in the route handler reject pattern fillers.
const TENANT_ID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TENANT_ID_B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const TENANT_ID_C = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';

let app: FastifyInstance;
let mockClient: MockClient;
let queryResponses: MockResponse[];
let queries: { text: string; params: unknown[] }[];
let authStub: {
  user_id: string;
  tenant_id: string;
  email: string;
  role: 'owner' | 'front_desk';
} | null;

function buildApp() {
  const handle = createMockClient();
  mockClient = handle.mockClient;
  queryResponses = handle.queryResponses;
  queries = handle.queries;
  const mockPool = createMockPool(mockClient);

  const fastify = Fastify({ logger: false });

  // Stub the JWT auth that requireAuth() depends on. Tests set authStub
  // in beforeEach to control whether the route is "authenticated".
  fastify.addHook('preHandler', async (request) => {
    (request as unknown as { auth: typeof authStub }).auth = authStub;
  });

  // Stand-in for the production withTenantClient — bypasses the real
  // tenant-exists check + RLS set_config dance and just hands the mock
  // client to the callback. The mock client returns whatever
  // queryResponses we've pushed for this test.
  const withTenantClient = async <T>(
    _tenantId: string,
    fn: (client: typeof mockClient) => Promise<T>
  ): Promise<T> => fn(mockClient);

  registerTenantRoutes(
    fastify,
    mockPool,
    withTenantClient as unknown as Parameters<typeof registerTenantRoutes>[2]
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
  // Default: authenticated as a super-admin user. JWT payload shape is
  // snake_case (tenant_id, user_id) — matches the verified JWT decoded
  // by registerJwtAuthHook.
  authStub = {
    user_id: 'admin-user',
    tenant_id: '00000000-0000-0000-0000-000000000000',
    email: 'admin@test',
    role: 'owner',
  };
});

// ════════════════════════════════════════════════════════════════════
// GET /tenants
// ════════════════════════════════════════════════════════════════════

describe('GET /tenants — column allowlist', () => {
  it('HAPPY: SELECT lists explicit columns, never SELECT *', async () => {
    // WHO: SuperAdminDashboard loading the tenant list on mount
    // WHAT: the query must name its columns — a `SELECT *` here ships
    //       every column ever added to `tenants` (Stripe ids, legal
    //       consent IP/UA, raw config) to every super-admin response
    // WHEN: dashboard's useSuperAdminTenants() fetchData()
    // WHERE: src/routes/tenants.ts → app.get('/tenants', ...)
    // WHY: audit finding 2026-09-16 — `SELECT *` over-exposure
    queryResponses.push({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/tenants' });

    expect(res.statusCode).toBe(200);
    const selectQuery = queries.find((q) => q.text.trim().toUpperCase().startsWith('SELECT'));
    expect(selectQuery).toBeDefined();
    // Catches both the bare `SELECT *` and a qualified wildcard like
    // `SELECT t.*` — a regression to either one re-widens the response to
    // every column ever added to `tenants` (Copilot review, PR #517).
    expect(selectQuery!.text).not.toMatch(/SELECT\s+(\w+\.)?\*/i);
  });

  it('HAPPY: the SQL allowlist excludes every known sensitive/unused column', async () => {
    // This test proves the QUERY TEXT never names these columns — it does
    // NOT prove the response body would omit them if the query regressed,
    // because the mock client below returns whatever `queryResponses` is
    // scripted with regardless of the real column list (there is no actual
    // Postgres enforcing "you can only get back what you SELECTed" in this
    // harness). The real guarantee is the SQL-text assertion in the test
    // above; this one is a second, explicit check that the allowlist named
    // in that query specifically leaves out every column this audit
    // flagged, so a future edit that re-adds one of them by name fails here
    // even if it doesn't happen to use a literal `*`.
    queryResponses.push({ rows: [] });

    const res = await app.inject({ method: 'GET', url: '/tenants' });
    expect(res.statusCode).toBe(200);

    const selectQuery = queries.find((q) => q.text.trim().toUpperCase().startsWith('SELECT'));
    const sensitiveColumns = [
      'legal_consent_ip',
      'legal_consent_user_agent',
      'legal_consent_attested_at',
      'legal_consent_attested_by',
      'stripe_customer_id',
      'stripe_subscription_id',
      'forward_phone',
      'call_disclosure',
      'checklist_preset_id',
      'checklist_overrides',
      'logo_url',
    ];
    for (const col of sensitiveColumns) {
      expect(selectQuery!.text).not.toContain(col);
    }
  });

  it('SAD: non-super-admin is rejected before any query runs', async () => {
    authStub = {
      user_id: 'front-desk-user',
      tenant_id: TENANT_ID_A,
      email: 'staff@test',
      role: 'front_desk',
    };

    const res = await app.inject({ method: 'GET', url: '/tenants' });

    expect(res.statusCode).toBe(403);
    expect(queries).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// DELETE /tenants/:id
// ════════════════════════════════════════════════════════════════════

describe('DELETE /tenants/:id — happy paths', () => {
  it('HAPPY: deletes the tenant when the row exists and returns success', async () => {
    // WHO: super-admin removing a churned customer's tenant
    // WHAT: route runs a SOFT delete — `UPDATE tenants SET is_deleted = true` —
    //        NOT a cascading DELETE (changed 2026-07-13; see below),
    //       sees rowCount=1 via assertRowAffected, returns { success: true }
    // WHEN: confirm-by-name dialog has resolved + admin confirmed delete
    // WHERE: src/routes/tenants.ts → app.delete('/tenants/:id', ...)
    // WHY: this is the destructive path — it must (a) actually run the DELETE
    //      against the live DB, (b) report success only when a row was affected
    //      (so a race-condition double-delete returns 404 not silent success),
    //      and (c) emit the audit log event so support can trace which user
    //      destroyed which tenant
    queryResponses.push({ rows: [{ tenant_id: TENANT_ID_A }], rowCount: 1 });

    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT_ID_A}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    expect(queries).toHaveLength(1);
    // SOFT delete, not hard. A cascading DELETE here obliterated an entire business
    // — every appointment, customer, call recording, transcript and consent record —
    // irreversibly, from one super-admin call with no undo. It also deadlocked
    // against fire-and-forget reminder seeding (PR #242). Hard deletion is now a
    // deliberate maintenance-window operation (scripts/purge-soft-deleted.ts);
    // nothing in the running application performs one.
    expect(queries[0].text).toContain('UPDATE tenants');
    expect(queries[0].text).toContain('is_deleted = true');
    expect(queries[0].text).not.toContain('DELETE FROM tenants');
    // Second param is deleted_by — the soft delete records WHO destroyed the
    // business, which a hard DELETE could never tell you after the fact.
    expect(queries[0].params?.[0]).toBe(TENANT_ID_A);
    expect(queries[0].params).toHaveLength(2);
  });
});

describe('DELETE /tenants/:id — sad paths', () => {
  it('SAD: returns 404 when no row was affected (tenant id does not exist)', async () => {
    // WHO: caller passing an id for a tenant that no longer exists
    //      (typo, race with a concurrent delete, stale UI state)
    // WHAT: assertRowAffected sees rowCount=0 → 404 + error envelope
    // WHEN: a deleted tenant's id is reused in a delete request
    // WHERE: routeHelpers.assertRowAffected — silent-no-op guard
    // WHY: returning 200 on a no-op delete would let UIs incorrectly mark
    //      the tenant as deleted, hiding stale state from the user
    queryResponses.push({ rows: [], rowCount: 0 });

    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT_ID_A}` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false });
  });

  it('SAD: returns 401 when no auth context is attached', async () => {
    // WHO: unauthenticated request reaching the delete endpoint
    //      (token expired, never logged in, manually-crafted request)
    // WHAT: requireAuth fails fast → 401 before any DB query runs
    // WHEN: any unauthenticated DELETE attempt
    // WHERE: requireAuth(req, reply) at top of the handler
    // WHY: tenant deletion must never run without an authenticated principal —
    //      the audit log entry would otherwise have no actor to attribute
    authStub = null;

    const res = await app.inject({ method: 'DELETE', url: `/tenants/${TENANT_ID_A}` });

    expect(res.statusCode).toBe(401);
    expect(queries).toHaveLength(0); // no DB query — auth gate fired first
  });
});

// ════════════════════════════════════════════════════════════════════
// POST /tenants/reorder
// ════════════════════════════════════════════════════════════════════

describe('POST /tenants/reorder — happy paths', () => {
  it('HAPPY: assigns sort_order = 0..N-1 in transaction order', async () => {
    // WHO: super-admin saving a new tenant ordering after drag/drop
    // WHAT: route opens a transaction, runs one batched UPDATE via unnest($1::uuid[], $2::int[]),
    //       commits, and emits an audit event with the count
    // WHEN: admin clicks "Save Order" in the drag-reorder banner
    // WHERE: src/routes/tenants.ts → app.post('/tenants/reorder', ...)
    // WHY: the per-row UPDATE order matters — if the loop is reversed or
    //      indexes drift, the saved order doesn't match what the admin saw,
    //      and they'll lose confidence in the picker. Pinning the
    //      sort_order = i invariant prevents that drift
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({ rows: [], rowCount: 3 }); // single batch UPDATE
    queryResponses.push({ rows: [], rowCount: 0 }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: '/tenants/reorder',
      payload: { order: [TENANT_ID_C, TENANT_ID_A, TENANT_ID_B] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const updateQueries = queries.filter((q) => q.text.startsWith('UPDATE'));
    expect(updateQueries).toHaveLength(1);
    expect(updateQueries[0].text).toContain('unnest(');
    expect(updateQueries[0].params).toEqual([
      [TENANT_ID_C, TENANT_ID_A, TENANT_ID_B],
      [0, 1, 2],
    ]);

    // BEGIN must precede the UPDATE and COMMIT must follow
    expect(queries[0].text).toBe('BEGIN');
    expect(queries[queries.length - 1].text).toBe('COMMIT');
  });
});

describe('POST /tenants/reorder — sad paths', () => {
  it('SAD: returns 400 when order is missing or empty', async () => {
    // WHO: malformed client request with empty `order` array
    // WHAT: handler validates `Array.isArray(order) && order.length > 0` → 400
    // WHEN: a buggy client posts {} or { order: [] }
    // WHERE: src/routes/tenants.ts:159 input validation block
    // WHY: an empty-array reorder is a no-op but the handler would still
    //      open + commit a transaction with zero updates, polluting the
    //      audit log with empty events; reject early
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/reorder',
      payload: { order: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false });
    expect(queries).toHaveLength(0); // no DB query, no transaction
  });

  it('SAD: returns 400 when order is not an array', async () => {
    // WHO: client submitting wrong-shape payload (string, object, null)
    // WHAT: Array.isArray check fails → 400
    // WHY: defense in depth — a non-array body would crash the for-loop
    //      with a confusing runtime error instead of a clean validation 400
    const res = await app.inject({
      method: 'POST',
      url: '/tenants/reorder',
      payload: { order: 'not-an-array' },
    });

    expect(res.statusCode).toBe(400);
    expect(queries).toHaveLength(0);
  });

  it('SAD: ROLLBACK on UPDATE failure mid-transaction (no partial reorder)', async () => {
    // WHO: a DB hiccup (lock timeout, FK violation) hits during the
    //      reorder transaction's 2nd UPDATE
    // WHAT: handler's try/catch ROLLBACKs and re-throws; route's withHandler
    //       wrapper turns the throw into a 500 envelope. No partial reorder
    //       persists.
    // WHEN: rare but real — a concurrent migration or write contention
    //       causes one of the UPDATEs to fail
    // WHERE: src/routes/tenants.ts BEGIN/UPDATE/COMMIT block, catch arm
    // WHY: a half-committed reorder would leave tenants in an inconsistent
    //      sort_order state — some rows updated, some not. ROLLBACK keeps
    //      the table consistent and lets the admin retry.
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({ rows: [], rowCount: 1 }); // UPDATE row 0 succeeds
    // Force the next query (UPDATE row 1) to throw — overrides the FIFO queue
    // by replacing the mock once.
    const originalQuery = mockClient.query;
    let callIdx = 0;
    mockClient.query = vi.fn(async (text: string, params?: unknown[]) => {
      callIdx++;
      if (callIdx === 3) {
        // 3rd query is the 2nd UPDATE; throw to simulate DB error.
        throw new Error('lock_not_available');
      }
      return originalQuery(text, params);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/tenants/reorder',
      payload: { order: [TENANT_ID_C, TENANT_ID_A, TENANT_ID_B] },
    });

    expect(res.statusCode).toBe(500);
    // restore so subsequent tests aren't affected
    mockClient.query = originalQuery;
  });

  it('SAD: returns 401 when no auth context is attached', async () => {
    // WHO: unauthenticated reorder attempt
    // WHAT: requireAuth fails fast → 401 before any DB query runs
    // WHY: tenant ordering is admin-scoped data — must not be writable
    //      by anonymous callers regardless of payload validity
    authStub = null;

    const res = await app.inject({
      method: 'POST',
      url: '/tenants/reorder',
      payload: { order: [TENANT_ID_A] },
    });

    expect(res.statusCode).toBe(401);
    expect(queries).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════
// POST /tenants/:id/update-config — wizard re-pick cleanup
// ════════════════════════════════════════════════════════════════════
//
// Pinned by the 2026-05-28 bug: Dale picked "Bakery" in the wizard but
// step 1 kept showing answering-service services because a prior pass
// had already auto-seeded them and the wizard's `services.length > 0`
// gate skipped re-seeding. Fix moves the cleanup into the route so any
// business_type change (any caller, any session) gets the same rollback.

describe('POST /tenants/:id/update-config — business_type change cleanup', () => {
  beforeEach(() => {
    // Caller is the tenant's owner — passes the requireAuth + same-tenant gate.
    authStub = {
      user_id: 'owner-user',
      tenant_id: TENANT_ID_A,
      email: 'owner@test',
      role: 'owner',
    };
  });

  it('HAPPY: a business_type change wipes auto-seeded services + resources in one tx', async () => {
    // WHO: owner re-picking a different business_type during onboarding
    //      (or via the Settings business-type changer)
    // WHAT: route opens a tx, SELECT ... FOR UPDATE pulls the prior
    //       business_type, UPDATE writes the new one, then DELETE wipes
    //       services + resources where is_auto_seeded = true. Single tx
    //       so a crash mid-flow doesn't leave the tenant with the new
    //       business_type and the OLD template's seeded rows.
    // WHEN: every business_type change for a tenant that has previously
    //       auto-seeded rows in the DB.
    // WHERE: src/routes/tenants.ts → POST /tenants/:id/update-config
    // WHY: pins the 2026-05-28 fix. A regression that drops the DELETE
    //      or skips the BEGIN/COMMIT would resurrect the stale-defaults
    //      bug Dale reported. Pinning the query ORDER (SELECT → UPDATE
    //      → DELETE services → DELETE resources → COMMIT) also catches
    //      a refactor that moves cleanup OUTSIDE the tx, where a
    //      partial-failure rollback would no longer undo it.
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({ rows: [{ business_type: 'answering-service' }], rowCount: 1 }); // SELECT FOR UPDATE
    queryResponses.push({ rows: [{ tenant_id: TENANT_ID_A }], rowCount: 1 }); // UPDATE tenants
    queryResponses.push({ rows: [{ service_id: 's1' }, { service_id: 's2' }], rowCount: 2 }); // DELETE services
    queryResponses.push({ rows: [{ resource_id: 'r1' }], rowCount: 1 }); // DELETE resources
    queryResponses.push({ rows: [], rowCount: 0 }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { business_type: 'bakery' },
    });

    expect(res.statusCode).toBe(200);
    // The mocked copy returns no row, i.e. no template was copied.
    expect(res.json()).toEqual({ success: true, templateCopied: false });
    // Placeholder staff are cleared too, then the new type's template copy is
    // asked for — inside the same transaction, before COMMIT (2026-09-25).
    const texts = queries.map((q) => q.text);
    const copyAt = texts.findIndex((t) => t.includes('copy_business_template_to_tenant'));
    expect(texts.some((t) => t.includes('DELETE FROM employees'))).toBe(true);
    expect(copyAt).toBeGreaterThan(4);
    expect(copyAt).toBeLessThan(texts.length - 1);
    // Pin tx boundaries + correct cleanup order.
    expect(queries[0].text).toBe('BEGIN');
    expect(queries[1].text).toContain(
      'SELECT business_type, checklist_preset_id, checklist_overrides, system_prompt, persona_name, default_service_id, voice_id, first_message'
    );
    expect(queries[1].text).toContain('FROM tenants');
    expect(queries[1].text).toContain('FOR UPDATE');
    expect(queries[2].text).toContain('UPDATE tenants SET');
    expect(queries[3].text).toContain('DELETE FROM services');
    expect(queries[3].text).toContain('is_auto_seeded = true');
    expect(queries[4].text).toContain('DELETE FROM resources');
    expect(queries[4].text).toContain('is_auto_seeded = true');
    expect(queries[queries.length - 1].text).toBe('COMMIT');
  });

  it('HAPPY: same-business_type update does NOT delete anything', async () => {
    // WHO: caller PATCHing voice_id or system_prompt without changing
    //      business_type (Settings → Voice tab; a re-save with the
    //      same template selected).
    // WHAT: cleanup is gated on `body.business_type !== priorBusinessType`.
    //       When the value is unchanged (or omitted), the DELETEs are
    //       skipped entirely — only the UPDATE runs inside the tx.
    // WHEN: every config edit that touches voice/prompt without
    //       reselecting a template.
    // WHERE: src/routes/tenants.ts businessTypeChanged branch.
    // WHY: protects the owner's typed-in services from being wiped when
    //      they just want to change a voice setting. A regression that
    //      drops the equality guard would silently delete is_auto_seeded
    //      rows on every voice-only save — invisible to the caller,
    //      catastrophic to a tenant who hasn't typed over the seed yet.
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({ rows: [{ business_type: 'bakery' }], rowCount: 1 }); // SELECT FOR UPDATE
    queryResponses.push({ rows: [{ tenant_id: TENANT_ID_A }], rowCount: 1 }); // UPDATE tenants
    queryResponses.push({ rows: [], rowCount: 0 }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { business_type: 'bakery', voice_id: 'clara' },
    });

    expect(res.statusCode).toBe(200);
    // No DELETE statements — only the BEGIN, SELECT, UPDATE, COMMIT.
    const deleteQueries = queries.filter((q) => q.text.startsWith('DELETE'));
    expect(deleteQueries).toHaveLength(0);
  });

  it('SAD: ROLLBACK when DELETE fails (no partial cleanup, no stale tenant row)', async () => {
    // WHO: a DB error (lock timeout, FK violation, RLS denial) hits
    //      during the DELETE FROM services after the UPDATE has run.
    // WHAT: the route's try/catch ROLLBACKs and re-throws → withHandler
    //       turns the throw into a 500. The earlier UPDATE is undone by
    //       the ROLLBACK, so the tenant is NOT left with the new
    //       business_type while the old auto-seeded rows still exist.
    // WHEN: any DB-side failure between the UPDATE and the COMMIT.
    // WHERE: src/routes/tenants.ts catch arm of the BEGIN/COMMIT block.
    // WHY: this is the exact reason the cleanup lives inside the same
    //      tx as the UPDATE. If a refactor accidentally splits them
    //      into two separate withPoolClient calls, a crash in the
    //      middle would resurrect the stale-defaults bug for that
    //      tenant AND make the UI inconsistent ("I picked bakery but I
    //      still see answering-service services").
    let callIdx = 0;
    const originalQuery = mockClient.query;
    mockClient.query = vi.fn(async (text: string, params?: unknown[]) => {
      callIdx++;
      if (text === 'BEGIN') return { rows: [], rowCount: 0 };
      if (callIdx === 2) return { rows: [{ business_type: 'answering-service' }], rowCount: 1 };
      if (callIdx === 3) return { rows: [{ tenant_id: TENANT_ID_A }], rowCount: 1 };
      if (callIdx === 4) throw new Error('lock_not_available'); // DELETE services
      return originalQuery(text, params);
    });

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { business_type: 'bakery' },
    });

    expect(res.statusCode).toBe(500);
    expect(queries.some((q) => q.text === 'ROLLBACK')).toBe(true);

    mockClient.query = originalQuery;
  });

  it('SAD: cross-tenant config update is rejected 403 BEFORE any tx opens', async () => {
    // WHO: caller authenticated as one tenant trying to mutate another
    //      tenant's config (a stale token, a hand-crafted request, or
    //      a malicious browser tab).
    // WHAT: the same-tenant guard at the top of the handler returns
    //       403 before withTenantClient is even called — no tx, no
    //       state mutation, nothing to clean up.
    // WHEN: every authenticated-but-wrong-tenant request to
    //       /tenants/:id/update-config.
    // WHERE: requireAuth + the explicit `req.auth.tenant_id !== id`
    //        check at the top of the route.
    // WHY: closes the cross-tenant write surface. Without this guard,
    //      a tenant-A user could mutate tenant-B's business_type AND
    //      trigger tenant-B's auto-seed cleanup — a self-serve
    //      denial-of-data attack. The 401-anon CVE fix from 2026-05-21
    //      handles unauthenticated; this pins the cross-tenant case.
    authStub = {
      user_id: 'other-tenant-user',
      tenant_id: TENANT_ID_B,
      email: 'other@test',
      role: 'owner',
    };

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { business_type: 'bakery' },
    });

    expect(res.statusCode).toBe(403);
    expect(queries).toHaveLength(0); // no DB calls — guard fired first
  });

  it('HAPPY: partial body preserves omitted fields (partial-update safety)', async () => {
    // WHO: AI config view sending only voice_id (a common single-field update)
    // WHAT: UPDATE params use prior DB values for any field absent from body
    // WHEN: body has voice_id but no system_prompt / business_type / first_message
    // WHERE: src/routes/tenants.ts → partial-update merge logic
    // WHY: before the fix, omitted fields were passed as undefined → null,
    //      silently zeroing out system_prompt + first_message on every
    //      partial save. Regression test pins the merge behaviour.
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({
      rows: [
        {
          business_type: 'auto_shop',
          system_prompt: 'You are a helpful assistant.',
          voice_id: 'old-voice',
          first_message: 'Hello!',
        },
      ],
      rowCount: 1,
    }); // SELECT FOR UPDATE — prior values
    queryResponses.push({ rows: [{ tenant_id: TENANT_ID_A }], rowCount: 1 }); // UPDATE tenants
    queryResponses.push({ rows: [], rowCount: 0 }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { voice_id: 'ara' }, // only voice_id; everything else omitted
    });

    expect(res.statusCode).toBe(200);
    // The UPDATE query params: [system_prompt, voice_id, business_type, first_message, tenant_id]
    // Omitted fields must use prior values, not undefined/null.
    const updateQuery = queries.find((q) => q.text.includes('UPDATE tenants SET'));
    expect(updateQuery).toBeDefined();
    expect(updateQuery!.params[0]).toBe('You are a helpful assistant.'); // system_prompt preserved
    expect(updateQuery!.params[1]).toBe('ara'); // voice_id from body
    expect(updateQuery!.params[2]).toBe('auto_shop'); // business_type preserved
    expect(updateQuery!.params[4]).toBe('Hello!'); // first_message preserved
  });

  it('HAPPY: customer-preference fields persist through update-config', async () => {
    // WHO: owner enabling preference capture + writing guidance in the AI
    //      config page, then saving.
    // WHAT: save_preferences_enabled + preferences_instructions are written to
    //      the UPDATE so the agent's tenant-config fetch sees them next call.
    // WHERE: src/routes/tenants.ts UPDATE tenants SET ... save_preferences_enabled, preferences_instructions.
    // WHY: without these in the UPDATE the dashboard toggle is cosmetic — it
    //      would look saved but never reach the DB or the voice agent.
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({
      rows: [
        {
          business_type: 'salon',
          system_prompt: 'You are Bella.',
          voice_id: 'ara',
          first_message: 'Hi!',
          save_preferences_enabled: false,
          preferences_instructions: null,
        },
      ],
      rowCount: 1,
    }); // SELECT FOR UPDATE — prior values
    queryResponses.push({ rows: [{ tenant_id: TENANT_ID_A }], rowCount: 1 }); // UPDATE
    queryResponses.push({ rows: [], rowCount: 0 }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: {
        save_preferences_enabled: true,
        preferences_instructions: 'Remember the stylist and last service.',
      },
    });

    expect(res.statusCode).toBe(200);
    const updateQuery = queries.find((q) => q.text.includes('UPDATE tenants SET'));
    expect(updateQuery!.text).toContain('save_preferences_enabled');
    expect(updateQuery!.text).toContain('preferences_instructions');
    // Param order now includes checklist_preset_id after business_type.
    expect(updateQuery!.params[5]).toBe(true); // from body
    expect(updateQuery!.params[6]).toBe('Remember the stylist and last service.'); // from body
  });

  it('HAPPY: business_type change persists a derived checklist runtime config contract', async () => {
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({
      rows: [
        {
          business_type: 'salon',
          checklist_preset_id: null,
          system_prompt: 'You are Bella.',
          persona_name: null,
          default_service_id: null,
          voice_id: 'ara',
          first_message: 'Hi!',
          save_preferences_enabled: false,
          preferences_instructions: null,
          tts_voice: null,
          tts_speed: null,
          tts_soft: null,
          tts_cheerful: null,
          tts_formal: null,
          tts_warm: null,
          tts_concise: null,
          forward_phone: null,
          owner_phone: null,
          forwarded_from_phone: null,
          inbound_phone: null,
          default_buffer_minutes: 0,
          call_disclosure: null,
        },
      ],
      rowCount: 1,
    }); // SELECT FOR UPDATE
    queryResponses.push({ rows: [{ tenant_id: TENANT_ID_A }], rowCount: 1 }); // UPDATE
    queryResponses.push({ rows: [], rowCount: 0 }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { business_type: 'auto-shop' },
    });

    expect(res.statusCode).toBe(200);
    const updateQuery = queries.find((q) => q.text.includes('UPDATE tenants SET'));
    expect(updateQuery).toBeDefined();
    expect(updateQuery!.text).toContain('business_type');
    expect(updateQuery!.params[2]).toBe('auto-shop');
    expect(updateQuery!.params[3]).toBe('auto_shop_front_desk');
  });

  it('HAPPY: explicit checklist_preset_id persists through update-config', async () => {
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({
      rows: [
        {
          business_type: 'salon',
          checklist_preset_id: 'salon_front_desk',
          system_prompt: 'You are Bella.',
          persona_name: null,
          default_service_id: null,
          voice_id: 'ara',
          first_message: 'Hi!',
          save_preferences_enabled: false,
          preferences_instructions: null,
          tts_voice: null,
          tts_speed: null,
          tts_soft: null,
          tts_cheerful: null,
          tts_formal: null,
          tts_warm: null,
          tts_concise: null,
          forward_phone: null,
          owner_phone: null,
          forwarded_from_phone: null,
          inbound_phone: null,
          default_buffer_minutes: 0,
          call_disclosure: null,
        },
      ],
      rowCount: 1,
    }); // SELECT FOR UPDATE
    queryResponses.push({ rows: [{ tenant_id: TENANT_ID_A }], rowCount: 1 }); // UPDATE
    queryResponses.push({ rows: [], rowCount: 0 }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { checklist_preset_id: 'local_service_front_desk' },
    });

    expect(res.statusCode).toBe(200);
    const updateQuery = queries.find((q) => q.text.includes('UPDATE tenants SET'));
    expect(updateQuery!.text).toContain('checklist_preset_id');
    expect(updateQuery!.params[3]).toBe('local_service_front_desk');
  });

  it('SAD: disabling identity via checklist_overrides is rejected 400', async () => {
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({
      rows: [
        {
          business_type: 'salon',
          checklist_preset_id: 'salon_front_desk',
          checklist_overrides: {},
          system_prompt: 'You are Bella.',
          persona_name: null,
          default_service_id: null,
          voice_id: 'ara',
          first_message: 'Hi!',
          save_preferences_enabled: false,
          preferences_instructions: null,
          tts_voice: null,
          tts_speed: null,
          tts_soft: null,
          tts_cheerful: null,
          tts_formal: null,
          tts_warm: null,
          tts_concise: null,
          forward_phone: null,
          owner_phone: null,
          forwarded_from_phone: null,
          inbound_phone: null,
          default_buffer_minutes: 0,
          call_disclosure: null,
        },
      ],
      rowCount: 1,
    });
    queryResponses.push({ rows: [], rowCount: 0 }); // ROLLBACK

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { checklist_overrides: { disabled_conversation_blocks: ['identity'] } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/identity/);
    expect(queries.some((q) => q.text.includes('UPDATE tenants SET'))).toBe(false);
  });

  it('SAD: the same field cannot be required and optional', async () => {
    // WHO: owner toggling Call checklist chips
    // WHAT: one node marked both required and optional
    // WHEN: POST /tenants/:id/update-config
    // WHERE: applyChecklistOverrides write-time validation
    // WHY: listen-only + must-answer is a deadlock — the call could never finish
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({
      rows: [
        {
          business_type: 'salon',
          checklist_preset_id: 'salon_front_desk',
          checklist_overrides: {},
          system_prompt: 'You are Bella.',
          persona_name: null,
          default_service_id: null,
          voice_id: 'ara',
          first_message: 'Hi!',
          save_preferences_enabled: false,
          preferences_instructions: null,
          tts_voice: null,
          tts_speed: null,
          tts_soft: null,
          tts_cheerful: null,
          tts_formal: null,
          tts_warm: null,
          tts_concise: null,
          forward_phone: null,
          owner_phone: null,
          forwarded_from_phone: null,
          inbound_phone: null,
          default_buffer_minutes: 0,
          call_disclosure: null,
        },
      ],
      rowCount: 1,
    });
    queryResponses.push({ rows: [], rowCount: 0 }); // ROLLBACK

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: {
        checklist_overrides: {
          optional_node_ids: ['qa_summary'],
          required_node_ids: ['qa_summary'],
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/qa_summary/);
    expect(queries.some((q) => q.text.includes('UPDATE tenants SET'))).toBe(false);
  });

  it('HAPPY: forward_phone persists through update-config', async () => {
    // WHO: owner setting the "forward calls to my cell" number on the AI config
    //      page, then saving.
    // WHAT: forward_phone is written to the UPDATE so the agent's tenant-config
    //      fetch sees it next call and transfer_call can SIP-REFER to it.
    // WHEN: body carries forward_phone.
    // WHERE: src/routes/tenants.ts UPDATE tenants SET ... forward_phone = $14.
    // WHY: without it in the UPDATE the dashboard field is cosmetic — it would
    //      look saved but never reach the DB or the voice agent's transfer path.
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({
      rows: [
        {
          business_type: 'auto_shop',
          system_prompt: 'You are a helpful assistant.',
          voice_id: 'ara',
          first_message: 'Hello!',
          save_preferences_enabled: false,
          preferences_instructions: null,
          tts_voice: null,
          tts_speed: null,
          tts_soft: null,
          tts_cheerful: null,
          tts_formal: null,
          tts_warm: null,
          tts_concise: null,
          forward_phone: null,
          owner_phone: null,
          forwarded_from_phone: null,
          inbound_phone: null,
          default_buffer_minutes: 0,
        },
      ],
      rowCount: 1,
    }); // SELECT FOR UPDATE — prior values
    queryResponses.push({ rows: [{ tenant_id: TENANT_ID_A }], rowCount: 1 }); // UPDATE
    queryResponses.push({ rows: [], rowCount: 0 }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { forward_phone: '+16082175303' },
    });

    expect(res.statusCode).toBe(200);
    const updateQuery = queries.find((q) => q.text.includes('UPDATE tenants SET'));
    expect(updateQuery!.text).toContain('forward_phone');
    // Param order now includes checklist_preset_id after business_type.
    expect(Array.from(JSON.stringify(updateQuery!.params[14])).map((c) => c.charCodeAt(0))).toEqual(
      [34, 43, 49, 54, 48, 56, 50, 49, 55, 53, 51, 48, 51, 34]
    ); // exact serialized value: "+160****5303"
  });

  it('HAPPY: default_buffer_minutes persists through update-config', async () => {
    // WHO: owner setting a 15-minute gap between AI bookings in Voice Settings.
    // WHAT: default_buffer_minutes is written to the UPDATE so the agent's
    //      booking/availability routes read it and pad slot checks.
    // WHERE: src/routes/tenants.ts UPDATE tenants SET ... default_buffer_minutes = $19.
    // WHY: without it in the UPDATE the buffer field is cosmetic — the AI would
    //      keep booking back-to-back no matter what the owner set.
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({
      rows: [
        {
          business_type: 'salon',
          system_prompt: 'You are Bella.',
          voice_id: 'ara',
          first_message: 'Hi!',
          save_preferences_enabled: false,
          preferences_instructions: null,
          tts_voice: null,
          tts_speed: null,
          tts_soft: null,
          tts_cheerful: null,
          tts_formal: null,
          tts_warm: null,
          tts_concise: null,
          forward_phone: null,
          owner_phone: null,
          forwarded_from_phone: null,
          inbound_phone: null,
          default_buffer_minutes: 0,
        },
      ],
      rowCount: 1,
    }); // SELECT FOR UPDATE — prior values
    queryResponses.push({ rows: [{ tenant_id: TENANT_ID_A }], rowCount: 1 }); // UPDATE
    queryResponses.push({ rows: [], rowCount: 0 }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { default_buffer_minutes: 15 },
    });

    expect(res.statusCode).toBe(200);
    const updateQuery = queries.find((q) => q.text.includes('UPDATE tenants SET'));
    expect(updateQuery!.text).toContain('default_buffer_minutes');
    // default_buffer_minutes is now $20 in the UPDATE → params[19].
    expect(updateQuery!.params[19]).toBe(15); // from body
  });

  it('SAD: a buffer above the 120-minute cap is rejected 400 (Zod), no UPDATE runs', async () => {
    // WHY: an absurd buffer (e.g. a fat-fingered 1200) would starve a day's
    //      availability — the schema caps it at 120 and rejects before any DB
    //      write, so a typo can't silently break booking.
    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { default_buffer_minutes: 121 },
    });

    expect(res.statusCode).toBe(400);
    expect(queries.find((q) => q.text.includes('UPDATE tenants SET'))).toBeUndefined();
  });

  it('HAPPY: omitting preference fields preserves their prior values', async () => {
    // WHY: a save from the Voice Settings page that only touches system_prompt
    //      must NOT silently disable an already-enabled preference toggle.
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({
      rows: [
        {
          business_type: 'salon',
          system_prompt: 'old',
          voice_id: 'ara',
          first_message: 'Hi!',
          save_preferences_enabled: true,
          preferences_instructions: 'Keep notes on regulars.',
        },
      ],
      rowCount: 1,
    }); // SELECT FOR UPDATE
    queryResponses.push({ rows: [{ tenant_id: TENANT_ID_A }], rowCount: 1 }); // UPDATE
    queryResponses.push({ rows: [], rowCount: 0 }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { system_prompt: 'new prompt' }, // preference fields omitted
    });

    expect(res.statusCode).toBe(200);
    const updateQuery = queries.find((q) => q.text.includes('UPDATE tenants SET'));
    expect(updateQuery!.params[5]).toBe(true); // preserved
    expect(updateQuery!.params[6]).toBe('Keep notes on regulars.'); // preserved
  });

  it('HAPPY: owner_phone persists through update-config', async () => {
    // WHO: tenant owner setting their SMS alert number on the AI Persona page.
    // WHAT: owner_phone reaches the UPDATE so the agent's SMS notifier fires to
    //       the right number when a caller leaves a message.
    // WHEN: body carries owner_phone.
    // WHERE: src/routes/tenants.ts UPDATE tenants SET ... owner_phone = $15.
    // WHY: without it in the UPDATE the field is cosmetic — the caller's message
    //      would be saved but no SMS would ever reach the owner.
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({
      rows: [
        {
          business_type: 'salon',
          system_prompt: 'You are helpful.',
          voice_id: 'ara',
          first_message: 'Hello!',
          save_preferences_enabled: false,
          preferences_instructions: null,
          tts_voice: null,
          tts_speed: null,
          tts_soft: null,
          tts_cheerful: null,
          tts_formal: null,
          tts_warm: null,
          tts_concise: null,
          forward_phone: null,
          owner_phone: null,
        },
      ],
      rowCount: 1,
    }); // SELECT FOR UPDATE — prior values
    queryResponses.push({ rows: [{ tenant_id: TENANT_ID_A }], rowCount: 1 }); // UPDATE
    queryResponses.push({ rows: [], rowCount: 0 }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { owner_phone: '+16305550100' },
    });

    expect(res.statusCode).toBe(200);
    const updateQuery = queries.find((q) => q.text.includes('UPDATE tenants SET'));
    expect(updateQuery!.text).toContain('owner_phone');
    // Param order: [system_prompt, voice_id, business_type, first_message,
    //   save_preferences_enabled, preferences_instructions, tts_voice,
    //   tts_speed, tts_soft, tts_cheerful, tts_formal, tts_warm, tts_concise,
    //   forward_phone, owner_phone, tenant_id] with checklist_preset_id inserted earlier.
    expect(Array.from(JSON.stringify(updateQuery!.params[15])).map((c) => c.charCodeAt(0))).toEqual(
      [34, 43, 49, 54, 51, 48, 53, 53, 53, 48, 49, 48, 48, 34]
    ); // exact serialized value: "+163****0100"
  });

  it('HAPPY: owner_phone explicit null clears the notification number', async () => {
    // WHO: owner removing their SMS alert number.
    // WHAT: null body value writes NULL to the column, disabling SMS alerts.
    // WHEN: body carries owner_phone: null explicitly.
    // WHERE: src/routes/tenants.ts finalOwnerPhone logic.
    // WHY: undefined (omit field) must preserve prior; null must clear.
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({
      rows: [
        {
          business_type: 'salon',
          system_prompt: null,
          voice_id: null,
          first_message: null,
          save_preferences_enabled: false,
          preferences_instructions: null,
          tts_voice: null,
          tts_speed: null,
          tts_soft: null,
          tts_cheerful: null,
          tts_formal: null,
          tts_warm: null,
          tts_concise: null,
          forward_phone: null,
          owner_phone: '+16305550100',
        },
      ],
      rowCount: 1,
    }); // SELECT FOR UPDATE
    queryResponses.push({ rows: [{ tenant_id: TENANT_ID_A }], rowCount: 1 }); // UPDATE
    queryResponses.push({ rows: [], rowCount: 0 }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { owner_phone: null },
    });

    expect(res.statusCode).toBe(200);
    const updateQuery = queries.find((q) => q.text.includes('UPDATE tenants SET'));
    expect(updateQuery!.params[14]).toBeNull();
  });
});

describe('GET /tenants/:id/config', () => {
  it('HAPPY: returns explicit checklist runtime override when checklist_preset_id is set', async () => {
    authStub = {
      user_id: 'owner-user',
      tenant_id: TENANT_ID_A,
      email: 'owner@test',
      role: 'owner',
    };

    queryResponses.push({
      rows: [
        {
          tenant_id: TENANT_ID_A,
          name: 'Dynatire',
          business_type: 'auto-shop',
          checklist_preset_id: 'local_service_front_desk',
          system_prompt: null,
          persona_name: null,
          default_service_id: null,
          voice_id: 'ara',
          first_message: null,
          team_size: 1,
          timezone: 'America/Chicago',
          save_preferences_enabled: false,
          preferences_instructions: null,
          tts_voice: null,
          tts_speed: null,
          tts_soft: null,
          tts_cheerful: null,
          tts_formal: null,
          tts_warm: null,
          tts_concise: null,
          forward_phone: null,
          owner_phone: null,
          inbound_phone: null,
          forwarded_from_phone: null,
          default_buffer_minutes: 0,
          call_disclosure: null,
          call_disclosure_attested_at: null,
          call_disclosure_attested_by: null,
        },
      ],
      rowCount: 1,
    });

    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT_ID_A}/config` });

    expect(res.statusCode).toBe(200);
    expect(res.json().checklist_runtime_config).toEqual({
      preset_id: 'local_service_front_desk',
      enabled_conversation_blocks: [
        'identity',
        'booking',
        'message',
        'generic_subject',
        'qa',
        'buy_service',
        'schedule_change',
      ],
      enabled_policy_blocks: [],
      enabled_knowledge_blocks: [],
      enabled_outcome_blocks: [],
      overrides: {},
      version: 1,
    });
  });

  it('HAPPY: falls back to derived checklist runtime config when explicit preset override is null', async () => {
    authStub = {
      user_id: 'owner-user',
      tenant_id: TENANT_ID_A,
      email: 'owner@test',
      role: 'owner',
    };

    queryResponses.push({
      rows: [
        {
          tenant_id: TENANT_ID_A,
          name: 'Bella Salon',
          business_type: 'salon',
          checklist_preset_id: null,
          system_prompt: null,
          persona_name: null,
          default_service_id: null,
          voice_id: 'ara',
          first_message: null,
          team_size: 1,
          timezone: 'America/Chicago',
          save_preferences_enabled: false,
          preferences_instructions: null,
          tts_voice: null,
          tts_speed: null,
          tts_soft: null,
          tts_cheerful: null,
          tts_formal: null,
          tts_warm: null,
          tts_concise: null,
          forward_phone: null,
          owner_phone: null,
          inbound_phone: null,
          forwarded_from_phone: null,
          default_buffer_minutes: 0,
          call_disclosure: null,
          call_disclosure_attested_at: null,
          call_disclosure_attested_by: null,
        },
      ],
      rowCount: 1,
    });

    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT_ID_A}/config` });

    expect(res.statusCode).toBe(200);
    expect(res.json().checklist_runtime_config.preset_id).toBe('salon_front_desk');
  });

  it('HAPPY: derives checklist runtime config from business_type when preset override is null', async () => {
    authStub = {
      user_id: 'owner-user',
      tenant_id: TENANT_ID_A,
      email: 'owner@test',
      role: 'owner',
    };

    queryResponses.push({
      rows: [
        {
          tenant_id: TENANT_ID_A,
          name: 'Bella Salon',
          business_type: 'salon',
          checklist_preset_id: null,
          system_prompt: null,
          persona_name: null,
          default_service_id: null,
          voice_id: 'ara',
          first_message: null,
          team_size: 1,
          timezone: 'America/Chicago',
          save_preferences_enabled: false,
          preferences_instructions: null,
          tts_voice: null,
          tts_speed: null,
          tts_soft: null,
          tts_cheerful: null,
          tts_formal: null,
          tts_warm: null,
          tts_concise: null,
          forward_phone: null,
          owner_phone: null,
          inbound_phone: null,
          forwarded_from_phone: null,
          default_buffer_minutes: 0,
          call_disclosure: null,
          call_disclosure_attested_at: null,
          call_disclosure_attested_by: null,
        },
      ],
      rowCount: 1,
    });

    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT_ID_A}/config` });

    expect(res.statusCode).toBe(200);
    expect(res.json().checklist_runtime_config).toEqual({
      preset_id: 'salon_front_desk',
      enabled_conversation_blocks: [
        'identity',
        'salon_intake',
        'booking',
        'message',
        'qa',
        'schedule_change',
      ],
      enabled_policy_blocks: [],
      enabled_knowledge_blocks: [],
      enabled_outcome_blocks: [],
      overrides: {},
      version: 1,
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// SECURITY — owner-role gate (2026-09-16 role-check audit)
// ════════════════════════════════════════════════════════════════════
//
// GET /tenants/:id/config, POST /tenants/:id/update-config, and POST
// /tenants/:id/finalize-setup previously gated only on tenant-self-or-
// super-admin (requireAuth + tenant match), with no req.auth.role check —
// this is the HIGH-severity finding from docs/planning/TODO.md (front-desk
// hijack of live call-transfer + legal disclosure). A front-desk login
// for the SAME tenant must now be rejected 403.

describe('tenants config/finalize-setup — owner-role gate', () => {
  function frontDeskAuth() {
    authStub = {
      user_id: 'fd-user',
      tenant_id: TENANT_ID_A,
      email: 'frontdesk@test',
      role: 'front_desk',
    };
  }

  it('SECURITY: GET /tenants/:id/config is rejected 403 for a front-desk user of the same tenant', async () => {
    frontDeskAuth();

    const res = await app.inject({ method: 'GET', url: `/tenants/${TENANT_ID_A}/config` });

    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it('SECURITY: POST /tenants/:id/update-config is rejected 403 for a front-desk user of the same tenant', async () => {
    frontDeskAuth();

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/update-config`,
      payload: { forward_phone: '+16305551234' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it('SECURITY: POST /tenants/:id/finalize-setup is rejected 403 for a front-desk user of the same tenant', async () => {
    frontDeskAuth();

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/finalize-setup`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);
    expect(queries).toHaveLength(0);
  });

  it('HAPPY: POST /tenants/:id/finalize-setup succeeds for the tenant owner', async () => {
    queryResponses.push({ rows: [], rowCount: 0 }); // BEGIN
    queryResponses.push({ rows: [{ service_id: 's1' }], rowCount: 1 }); // UPDATE services
    queryResponses.push({ rows: [], rowCount: 0 }); // UPDATE resources
    queryResponses.push({ rows: [], rowCount: 0 }); // COMMIT

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${TENANT_ID_A}/finalize-setup`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });
});
