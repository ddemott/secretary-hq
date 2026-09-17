/**
 * PERMANENT REGRESSION TEST — do not delete, do not weaken.
 *
 * The admin-tenant consent gate (supabase/migrations/
 * 20260916000000_tenant_admin_consent_gate.sql) must NEVER apply
 * retroactively. Dale's own production account (Thinking Hammer LLC,
 * seeded directly in supabase/seed.sql, never through
 * createTenantWithOwner) and the Bella's Hair Studio demo tenant both
 * have legal_consent_attested_at = NULL today. If tenants.consent_gate_
 * required ever defaulted to true, or if anything ever ran a backfill
 * that flipped existing rows to true, both of those real, currently-
 * working logins would be locked out by the 403 'consent_required' gate
 * in src/routes/auth.ts's /login handler.
 *
 * This is why the test lives here rather than folded into
 * tests/services/tenants/bootstrap.test.ts (which mocks the pool and so
 * cannot prove anything about the schema's actual default) or
 * tests/routes/tenants-create-consent.test.ts (which proves the ROUTE's
 * side effects, not the column's real-Postgres behavior).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type Client, Pool } from 'pg';
import { ROOT_DB_URL, getRootClient, skipIfDbDown } from '../utils';
import { createTenantWithOwner } from '../../src/services/tenants/bootstrap';

let setup: Client;
let pool: Pool;
let dbAvailable = false;
const tenantsToClean: string[] = [];

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: ROOT_DB_URL, max: 5 });
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (pool) await pool.end();
  if (setup) {
    for (const id of tenantsToClean) {
      await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
    }
    await setup.end();
  }
});

beforeEach((ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
});

describe('tenants.consent_gate_required — never retroactive', () => {
  it("THE SCHEMA DEFAULT IS false, NOT true: a row inserted the exact way supabase/seed.sql and tests/utils.ts's createTenant() do — naming only (name, business_type) — reads back consent_gate_required=false", async () => {
    // WHO: every pre-existing tenant — Dale's own production account and
    //      the Bella's Hair Studio demo tenant chief among them — plus
    //      every test fixture in this repo that builds a tenant with a
    //      bare INSERT rather than going through createTenantWithOwner.
    // WHAT: no migration, trigger, or DEFAULT can ever flip this to true
    //       for a row that never asked for it.
    // WHY: if this default were ever changed to true (or a trigger added
    //      that computes it), every one of those rows would be gated on
    //      its very next login with zero attestation on file.
    const res = await setup.query(
      'INSERT INTO tenants (name, business_type) VALUES ($1, $2) RETURNING tenant_id, consent_gate_required',
      [`RetroactivityCheck ${Date.now()}`, 'salon']
    );
    tenantsToClean.push(res.rows[0].tenant_id);
    expect(res.rows[0].consent_gate_required).toBe(false);
  });

  it('THE COLUMN IS NOT NULL with a literal false default at the information_schema level (belt-and-suspenders on the migration itself, independent of any application code)', async () => {
    const res = await setup.query(
      `SELECT column_default, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'tenants' AND column_name = 'consent_gate_required'`
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].is_nullable).toBe('NO');
    expect(res.rows[0].column_default).toContain('false');
  });

  it('an admin-provisioned tenant created via createTenantWithOwner (no legalConsent) DOES get gated true — proving the default is not a blanket false regardless of how the row was made, only for rows that never asked for a gate', async () => {
    // This is the other half of the guarantee: retroactivity-safety would
    // be meaningless if the gate could never actually turn on for the
    // path it exists for. Round-tripped against real Postgres, not a
    // mocked pool, so a future migration that (say) drops the DEFAULT or
    // adds a conflicting trigger fails HERE, against the real schema.
    const result = await createTenantWithOwner(pool, {
      tenantName: `AdminGated ${Date.now()}`,
      businessType: 'salon',
      ownerEmail: `admin-gated-${Date.now()}@test.com`,
      ownerPassword: 'secure123',
      ownerFullName: 'Admin Gated Owner',
      duplicateCheck: 'tenant_name',
      // legalConsent deliberately omitted — this is the admin create path.
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    tenantsToClean.push(result.tenantId);
    expect(result.consentGateRequired).toBe(true);

    const res = await setup.query(
      'SELECT consent_gate_required, legal_consent_attested_at FROM tenants WHERE tenant_id = $1',
      [result.tenantId]
    );
    expect(res.rows[0].consent_gate_required).toBe(true);
    expect(res.rows[0].legal_consent_attested_at).toBeNull();
  });

  it('a self-serve tenant created via createTenantWithOwner WITH legalConsent is never gated', async () => {
    const result = await createTenantWithOwner(pool, {
      tenantName: `SelfServe ${Date.now()}`,
      businessType: 'salon',
      ownerEmail: `self-serve-${Date.now()}@test.com`,
      ownerPassword: 'secure123',
      ownerFullName: 'Self Serve Owner',
      duplicateCheck: 'email',
      legalConsent: { ip: '198.51.100.1', userAgent: 'RegressionTest/1.0' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    tenantsToClean.push(result.tenantId);
    expect(result.consentGateRequired).toBe(false);

    const res = await setup.query(
      'SELECT consent_gate_required FROM tenants WHERE tenant_id = $1',
      [result.tenantId]
    );
    expect(res.rows[0].consent_gate_required).toBe(false);
  });
});
