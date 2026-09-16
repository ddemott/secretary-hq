/**
 * Tests for createTenantWithOwner — the shared transactional helper used
 * by /register (public self-serve) and /tenants/create (admin).
 *
 * Strategy: mock pg Pool + PoolClient to capture the SQL and params,
 * verify transactional shape (BEGIN/COMMIT or BEGIN/ROLLBACK), and
 * confirm the policy switches (email vs tenant_name duplicate check)
 * route to the right SELECT. Real bcrypt is used — it's <100ms per
 * test and matches what production sees.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { createTenantWithOwner } from '../../../src/services/tenants/bootstrap';

interface MockQuery {
  text: string;
  params: unknown[];
}

function buildMockPool(responses: Array<{ rows: unknown[]; rowCount?: number }>) {
  const queries: MockQuery[] = [];
  const remaining = [...responses];

  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params: params ?? [] });
      return remaining.shift() ?? { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };

  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as Pool;

  return { pool, client, queries, connect };
}

const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_ID = '11111111-2222-3333-8444-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════
// HAPPY PATHS — transaction commits, returns ids
// ════════════════════════════════════════════════════════════════════

describe('createTenantWithOwner — happy paths', () => {
  it('1. email policy: commits on no duplicate, returns tenantId+userId', async () => {
    // WHO: Public visitor at /register submitting brand-new business + email.
    // WHAT: BEGIN → SELECT existing user (none) → INSERT tenant → INSERT
    //       user → COMMIT. Returns ok with both ids so the route can
    //       sign a JWT and respond 201.
    // WHERE: Called from src/routes/auth.ts /register handler.
    // WHY: Self-serve onboarding must be atomic — partial state (tenant
    //      without owner, or vice versa) creates orphan rows and lets
    //      a half-registered email block retries.
    const { pool, queries } = buildMockPool([
      { rows: [] }, // BEGIN
      { rows: [] }, // SELECT user_id FROM users (none)
      { rows: [{ tenant_id: TENANT_ID }] }, // INSERT tenant RETURNING tenant_id
      { rows: [{ user_id: USER_ID }] }, // INSERT user RETURNING user_id
      { rows: [] }, // copy_question_tree_templates_to_tenant
      { rows: [] }, // COMMIT
    ]);

    const result = await createTenantWithOwner(pool, {
      tenantName: 'DynaTire',
      businessType: 'mobile-tire',
      ownerEmail: 'dale@test.com',
      ownerPassword: 'secure123',
      ownerFullName: 'Dale DeMott',
      duplicateCheck: 'email',
    });

    expect(result).toEqual({ ok: true, tenantId: TENANT_ID, userId: USER_ID });
    expect(queries.map((q) => q.text)).toEqual([
      'BEGIN',
      'SELECT user_id FROM users WHERE email = $1',
      'INSERT INTO tenants (name, business_type) VALUES ($1, $2) RETURNING tenant_id',
      expect.stringContaining('INSERT INTO users'),
      // A new business gets its OWN copy of its vertical's questions, inside the
      // same transaction that creates it — so a tenant never exists with a
      // business_type and no questions. 2026-08-14.
      expect.stringContaining('copy_question_tree_templates_to_tenant'),
      'COMMIT',
    ]);
    expect(queries[1].params).toEqual(['dale@test.com']);
    expect(queries[2].params).toEqual(['DynaTire', 'mobile-tire']);
    // mobile-tire now resolves to its own dedicated `mobile_tire` vertical — the
    // slot-filling intake tree that shipped with the vertical-intake presets — so
    // a new mobile-tire tenant provisions the mobile_tire questions, not the
    // generic local_service fallback it received before those presets existed.
    expect(queries[4].params).toEqual([TENANT_ID, ['mobile_tire']]);
  });

  it('2. tenant_name policy: commits on no duplicate, persists first/last name', async () => {
    // WHO: Platform admin creating a tenant via the SuperAdmin dashboard.
    // WHAT: SELECT against tenants (LOWER) instead of users; the user
    //       INSERT must persist first_name and last_name when given,
    //       so the dashboard can display structured names.
    // WHERE: src/routes/tenants.ts /tenants/create handler.
    // WHY: Owner first/last names are required by the admin schema —
    //      losing them would force a follow-up edit and break the
    //      "create looks like edit" expectation.
    const { pool, queries } = buildMockPool([
      { rows: [] }, // BEGIN
      { rows: [] }, // SELECT FROM tenants (none)
      { rows: [{ tenant_id: TENANT_ID }] }, // INSERT tenant
      { rows: [{ user_id: USER_ID }] }, // INSERT user RETURNING user_id
      { rows: [] }, // COMMIT
    ]);

    const result = await createTenantWithOwner(pool, {
      tenantName: 'Sharp Salon',
      businessType: 'salon',
      ownerEmail: 'owner@sharp.com',
      ownerPassword: 'secure123',
      ownerFullName: 'Jane Doe',
      ownerFirstName: 'Jane',
      ownerLastName: 'Doe',
      duplicateCheck: 'tenant_name',
    });

    expect(result).toEqual({ ok: true, tenantId: TENANT_ID, userId: USER_ID });
    expect(queries[1].text).toBe('SELECT tenant_id FROM tenants WHERE LOWER(name) = LOWER($1)');
    expect(queries[1].params).toEqual(['Sharp Salon']);
    // user INSERT params: tenantId, email, hash, full, first, last
    const userInsertParams = queries[3].params;
    expect(userInsertParams[0]).toBe(TENANT_ID);
    expect(userInsertParams[1]).toBe('owner@sharp.com');
    expect(userInsertParams[3]).toBe('Jane Doe');
    expect(userInsertParams[4]).toBe('Jane');
    expect(userInsertParams[5]).toBe('Doe');
  });

  it('3. defaults first/last name to null when not provided', async () => {
    // WHAT: The /register flow only collects a single owner_name field;
    //       the helper accepts that and stores null for first/last so
    //       the schema (which allows nullable) stays consistent.
    // WHY: A null first_name is meaningfully different from an empty
    //      string — null says "we didn't ask", '' says "they left it
    //      blank" — and we want the former here.
    const { pool, queries } = buildMockPool([
      { rows: [] },
      { rows: [] },
      { rows: [{ tenant_id: TENANT_ID }] },
      { rows: [{ user_id: USER_ID }] },
      { rows: [] },
    ]);

    await createTenantWithOwner(pool, {
      tenantName: 'Solo Shop',
      businessType: 'auto-shop',
      ownerEmail: 'solo@shop.com',
      ownerPassword: 'secure123',
      ownerFullName: 'Solo Owner',
      duplicateCheck: 'email',
    });

    const userInsertParams = queries[3].params;
    expect(userInsertParams[4]).toBeNull();
    expect(userInsertParams[5]).toBeNull();
  });

  it('4a. legalConsent present: stamps legal_consent_* on tenants after the user INSERT', async () => {
    // WHO: a self-serve /register signup that passed RegisterSchema's
    //      consent_attested: true gate.
    // WHAT: BEGIN → SELECT (none) → INSERT tenant → INSERT user →
    //       UPDATE tenants SET legal_consent_attested_at = NOW(),
    //       legal_consent_attested_by = <new userId>, ip, user agent →
    //       copy templates → COMMIT. The attested_by is the NEW user's
    //       own id — self-serve registration is self-attestation.
    // WHERE: /register route, which always passes legalConsent.
    // WHY: Zod validation alone doesn't persist proof consent was given;
    //      this is the write that actually closes the liability-shift gap.
    const { pool, queries } = buildMockPool([
      { rows: [] }, // BEGIN
      { rows: [] }, // SELECT user (none)
      { rows: [{ tenant_id: TENANT_ID }] }, // INSERT tenant
      { rows: [{ user_id: USER_ID }] }, // INSERT user
      { rows: [] }, // UPDATE tenants legal_consent_*
      { rows: [] }, // copy_question_tree_templates_to_tenant
      { rows: [] }, // COMMIT
    ]);

    const result = await createTenantWithOwner(pool, {
      tenantName: 'ConsentCo',
      businessType: 'salon',
      ownerEmail: 'consent@test.com',
      ownerPassword: 'secure123',
      ownerFullName: 'Consent Owner',
      duplicateCheck: 'email',
      legalConsent: { ip: '198.51.100.7', userAgent: 'Mozilla/5.0' },
    });

    expect(result).toEqual({ ok: true, tenantId: TENANT_ID, userId: USER_ID });
    const consentUpdate = queries.find((q) => /legal_consent_attested_at/i.test(q.text));
    expect(consentUpdate).toBeDefined();
    expect(consentUpdate?.text).toMatch(/UPDATE tenants/i);
    expect(consentUpdate?.text).toContain('legal_consent_attested_by');
    expect(consentUpdate?.text).toContain('legal_consent_ip');
    expect(consentUpdate?.text).toContain('legal_consent_user_agent');
    expect(consentUpdate?.params).toEqual([USER_ID, '198.51.100.7', 'Mozilla/5.0', TENANT_ID]);
    // The UPDATE must run AFTER the user INSERT (attested_by needs the
    // new user's id) and BEFORE COMMIT.
    const updateIndex = queries.findIndex((q) => /legal_consent_attested_at/i.test(q.text));
    const userInsertIndex = queries.findIndex((q) => /INSERT INTO users/i.test(q.text));
    expect(updateIndex).toBeGreaterThan(userInsertIndex);
    expect(queries[queries.length - 1].text).toBe('COMMIT');
  });

  it('4b. legalConsent omitted (admin create flow): no legal_consent_* UPDATE is issued', async () => {
    // WHO: platform admin using POST /tenants/create on someone's behalf.
    // WHAT: the admin flow never passes legalConsent, so no UPDATE
    //       touching legal_consent_* columns should ever run — those
    //       tenants stay NULL, which is the documented, deliberate
    //       behavior (an admin isn't the business owner attesting
    //       anything).
    const { pool, queries } = buildMockPool([
      { rows: [] }, // BEGIN
      { rows: [] }, // SELECT tenants (none)
      { rows: [{ tenant_id: TENANT_ID }] }, // INSERT tenant
      { rows: [{ user_id: USER_ID }] }, // INSERT user
      { rows: [] }, // COMMIT
    ]);

    await createTenantWithOwner(pool, {
      tenantName: 'AdminCreated',
      businessType: 'salon',
      ownerEmail: 'admincreated@test.com',
      ownerPassword: 'secure123',
      ownerFullName: 'Admin Created Owner',
      duplicateCheck: 'tenant_name',
    });

    const consentUpdate = queries.find((q) => /legal_consent/i.test(q.text));
    expect(consentUpdate).toBeUndefined();
  });

  it('4c. legalConsent with null ip/userAgent still stamps attested_at/attested_by', async () => {
    // WHO: a registration whose request carried no resolvable IP/UA
    //      (e.g. a test harness or a proxy that stripped headers).
    // WHAT: the audit-trail fields are best-effort and nullable — a
    //       missing IP/UA must never block recording that consent WAS
    //       given, which is the part that actually matters legally.
    const { pool, queries } = buildMockPool([
      { rows: [] },
      { rows: [] },
      { rows: [{ tenant_id: TENANT_ID }] },
      { rows: [{ user_id: USER_ID }] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ]);

    const result = await createTenantWithOwner(pool, {
      tenantName: 'NoHeaderCo',
      businessType: 'salon',
      ownerEmail: 'noheader@test.com',
      ownerPassword: 'secure123',
      ownerFullName: 'No Header Owner',
      duplicateCheck: 'email',
      legalConsent: { ip: null, userAgent: null },
    });

    expect(result.ok).toBe(true);
    const consentUpdate = queries.find((q) => /legal_consent_attested_at/i.test(q.text));
    expect(consentUpdate?.params).toEqual([USER_ID, null, null, TENANT_ID]);
  });

  it('4. bcrypt hash is passed to user INSERT, not the raw password', async () => {
    // WHO: Any caller — both flows must store hashes, never plaintext.
    // WHAT: The user INSERT's password_hash param ($3) must look like a
    //       bcrypt hash (~$2[a|b]$rounds$saltAndHash) — not the raw
    //       password we sent in.
    // WHY: A regression that drops the hash step would silently leak
    //      plaintext credentials into the DB. Worth a direct guard.
    const { pool, queries } = buildMockPool([
      { rows: [] },
      { rows: [] },
      { rows: [{ tenant_id: TENANT_ID }] },
      { rows: [{ user_id: USER_ID }] },
      { rows: [] },
    ]);

    await createTenantWithOwner(pool, {
      tenantName: 'HashCheck',
      businessType: 'salon',
      ownerEmail: 'hash@test.com',
      ownerPassword: 'plaintext-secret',
      ownerFullName: 'Hash Tester',
      duplicateCheck: 'email',
    });

    const userInsertParams = queries[3].params;
    const hash = userInsertParams[2] as string;
    expect(hash).not.toBe('plaintext-secret');
    expect(hash).toMatch(/^\$2[ab]\$\d{1,2}\$/);
  });
});

// ════════════════════════════════════════════════════════════════════
// SAD PATHS — duplicate detection rolls back, schema errors propagate
// ════════════════════════════════════════════════════════════════════

describe('createTenantWithOwner — duplicate detection', () => {
  it('5. email policy: returns conflict + ROLLBACK when email already exists', async () => {
    // WHO: User retrying registration after their first attempt failed
    //      mid-flow, or a malicious actor probing for taken emails.
    // WHAT: SELECT finds an existing user; helper must ROLLBACK and
    //      return ok:false with a generic conflict message — no
    //      INSERTs reach the DB.
    // WHERE: /register sad path.
    // WHY: A second BEGIN+ROLLBACK without any INSERTs leaves the DB
    //      untouched. Anything else risks orphan tenants (tenant
    //      created, then user INSERT fails because email is taken).
    const { pool, client, queries } = buildMockPool([
      { rows: [] }, // BEGIN
      { rows: [{ user_id: 'existing-user-id' }] }, // SELECT user — FOUND
      { rows: [] }, // ROLLBACK
    ]);

    const result = await createTenantWithOwner(pool, {
      tenantName: 'WontMatter',
      businessType: 'salon',
      ownerEmail: 'taken@test.com',
      ownerPassword: 'secure123',
      ownerFullName: 'Doesnt Matter',
      duplicateCheck: 'email',
    });

    expect(result).toEqual({
      ok: false,
      conflictMessage: 'An account with this email already exists',
    });
    expect(queries.map((q) => q.text)).toEqual([
      'BEGIN',
      'SELECT user_id FROM users WHERE email = $1',
      'ROLLBACK',
    ]);
    expect(client.release).toHaveBeenCalled();
  });

  it('6. tenant_name policy: conflict message includes the requested name', async () => {
    // WHO: Admin trying to create "DynaTire" when one already exists.
    // WHAT: ROLLBACK and return a friendly message with the requested
    //       name so the admin doesn't have to guess what conflicted.
    // WHY: Admin flow surfaces this conflict directly to a human in the
    //      dashboard — wording matters. The case-insensitivity of the
    //      check is verified separately below.
    const { pool, queries } = buildMockPool([
      { rows: [] },
      { rows: [{ tenant_id: 'existing-tenant' }] },
      { rows: [] },
    ]);

    const result = await createTenantWithOwner(pool, {
      tenantName: 'DynaTire',
      businessType: 'mobile-tire',
      ownerEmail: 'admin@platform.com',
      ownerPassword: 'secure123',
      ownerFullName: 'Admin Person',
      duplicateCheck: 'tenant_name',
    });

    expect(result).toEqual({
      ok: false,
      conflictMessage: 'A business named "DynaTire" already exists.',
    });
    expect(queries[2].text).toBe('ROLLBACK');
  });

  it('7. tenant_name policy: SELECT uses LOWER() for case-insensitive match', async () => {
    // WHO: Admin creating "dynatire" when "DynaTire" already exists,
    //      or any case variant.
    // WHAT: The duplicate SELECT must compare lowercased names so case
    //       collisions don't slip through.
    // WHY: Case-only differences in business names confuse the tenant
    //      picker — "DynaTire" and "Dynatire" look identical to a user
    //      glancing at the dropdown.
    const { pool, queries } = buildMockPool([
      { rows: [] },
      { rows: [] },
      { rows: [{ tenant_id: TENANT_ID }] },
      { rows: [{ user_id: USER_ID }] },
      { rows: [] },
    ]);

    await createTenantWithOwner(pool, {
      tenantName: 'dynatire',
      businessType: 'mobile-tire',
      ownerEmail: 'lc@test.com',
      ownerPassword: 'secure123',
      ownerFullName: 'lower case',
      duplicateCheck: 'tenant_name',
    });

    expect(queries[1].text).toBe('SELECT tenant_id FROM tenants WHERE LOWER(name) = LOWER($1)');
  });
});

describe('createTenantWithOwner — error propagation', () => {
  it('8. ROLLBACK and rethrow when tenant INSERT fails', async () => {
    // WHO: Any caller hitting a transient DB error (FK violation, NOT
    //      NULL constraint, deadlock, etc.) on the tenant INSERT.
    // WHAT: Helper must ROLLBACK and rethrow so the route's withHandler
    //       returns the standard 500. We must NOT swallow the error or
    //       leave the transaction open.
    // WHERE: Either flow — error semantics are policy-independent.
    // WHY: An open transaction holds locks and ties up a pool slot; a
    //      swallowed error masks real bugs. The route layer is the
    //      right place for user-facing error formatting, not here.
    const failingClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT (no dup)
        .mockRejectedValueOnce(new Error('not-null violation: business_type'))
        .mockResolvedValueOnce({ rows: [] }), // ROLLBACK
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => failingClient) } as unknown as Pool;

    await expect(
      createTenantWithOwner(pool, {
        tenantName: 'WillFail',
        businessType: 'salon',
        ownerEmail: 'fail@test.com',
        ownerPassword: 'secure123',
        ownerFullName: 'Fail Test',
        duplicateCheck: 'email',
      })
    ).rejects.toThrow(/not-null violation/);

    const queryCalls = failingClient.query.mock.calls.map((c) => c[0]);
    expect(queryCalls[0]).toBe('BEGIN');
    expect(queryCalls[queryCalls.length - 1]).toBe('ROLLBACK');
    expect(failingClient.release).toHaveBeenCalled();
  });

  it('9. releases client even when nothing throws', async () => {
    // WHAT: The finally block must release on success too — leaking a
    //       pool client per registration would exhaust the pool fast.
    // WHY: Pool exhaustion is an outage, not a slowdown. This is the
    //      cheapest test that catches a regression in the finally.
    const { pool, client } = buildMockPool([
      { rows: [] },
      { rows: [] },
      { rows: [{ tenant_id: TENANT_ID }] },
      { rows: [{ user_id: USER_ID }] },
      { rows: [] },
    ]);

    await createTenantWithOwner(pool, {
      tenantName: 'Releases',
      businessType: 'salon',
      ownerEmail: 'rel@test.com',
      ownerPassword: 'secure123',
      ownerFullName: 'Release Tester',
      duplicateCheck: 'email',
    });

    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// HIPAA-vertical denylist — independent of the dashboard picker
// (2026-09-16 role-check audit; RegisterSchema checks this too for the
// self-serve path, but POST /tenants/create has no equivalent Zod schema,
// so this is the one check both entry points share).
// ════════════════════════════════════════════════════════════════════

describe('createTenantWithOwner — HIPAA-vertical denylist', () => {
  it.each(['dental', 'Dental Office', 'veterinary-clinic', 'chiropractic', 'optometry', 'Family Medical Group', 'HIPAA Provider'])(
    '10. rejects business_type %j before opening a connection — no BEGIN, no INSERT',
    async (businessType) => {
      const { pool, queries, connect } = buildMockPool([]);

      const result = await createTenantWithOwner(pool, {
        tenantName: 'Should Not Exist',
        businessType,
        ownerEmail: 'blocked@test.com',
        ownerPassword: 'secure123',
        ownerFullName: 'Blocked Owner',
        duplicateCheck: 'email',
      });

      expect(result).toEqual({
        ok: false,
        conflictMessage: 'This business type is not supported on this platform.',
      });
      // No connection was ever checked out — the denylist check runs before
      // `pool.connect()`, so nothing here can leak a pool slot either.
      expect(connect).not.toHaveBeenCalled();
      expect(queries).toHaveLength(0);
    }
  );

  it('11. an unrelated business_type is not blocked', async () => {
    const { pool, queries } = buildMockPool([
      { rows: [] },
      { rows: [] },
      { rows: [{ tenant_id: TENANT_ID }] },
      { rows: [{ user_id: USER_ID }] },
      { rows: [] },
    ]);

    const result = await createTenantWithOwner(pool, {
      tenantName: 'Fine Business',
      businessType: 'salon',
      ownerEmail: 'fine@test.com',
      ownerPassword: 'secure123',
      ownerFullName: 'Fine Owner',
      duplicateCheck: 'email',
    });

    expect(result.ok).toBe(true);
    expect(queries.length).toBeGreaterThan(0);
  });
});
