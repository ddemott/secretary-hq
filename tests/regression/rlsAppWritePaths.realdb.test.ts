/**
 * THE APP'S OWN WRITE PATHS, RUN AS THE NON-BYPASSING ROLE.
 *
 * WHY THIS EXISTS — a production incident, 2026-07-27. `DATABASE_URL` was
 * repointed to `app_user` after the database side had been verified thoroughly:
 * policies null-safe, both landmines probed dead against prod, cross-tenant
 * isolation and WITH CHECK confirmed, and a privilege audit showing zero
 * missing grants on any table, function or sequence.
 *
 * `POST /demo/start` — the public "Try live demo" button — 500'd within seconds:
 *
 *     new row violates row-level security policy for table "tenant_skills"
 *       at async insertDemoData (dist/src/services/demoSeed.js:45)
 *
 * The database was fine. The APPLICATION was not: `seedDemoTenant` wrote through
 * the raw pool with no tenant context — its own comment said so — which is
 * indistinguishable from a correct write while the role bypasses RLS, and is a
 * refused write the moment it doesn't. Only tenants/users/business_templates
 * carry an admin_bypass policy; everything else is isolation-only, so an unset
 * context means `tenant_ctx_uuid()` is NULL and the WITH CHECK denies.
 *
 * rlsIsolation.test.ts proves the POLICIES behave. It cannot catch this, because
 * it issues its own SQL rather than calling the app's services. This file closes
 * that gap: it runs the real service functions against a real database as
 * `app_user`, which is the only arrangement in which the defect is visible.
 *
 * The rule this encodes: a code path that writes tenant-scoped rows must carry a
 * tenant context, and "it works in production today" is not evidence of that
 * while production bypasses RLS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

import { seedDemoTenant } from '../../src/services/demoSeed';
import { withTenantContext } from '../../src/database/index';

const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/test_db';

const APP_USER_URL =
  process.env.TEST_APP_USER_DATABASE_URL ??
  ADMIN_URL.replace(/:\/\/[^@]*@/, '://app_user:app_user@');

let admin: Pool;
/** The pool the application would hold after the switch. */
let appUser: Pool;
let available = false;

const TENANT_ID = 'dddddddd-0000-4000-8000-00000000000d';
const USER_ID = 'dddddddd-0000-4000-8000-00000000000e';

beforeAll(async () => {
  admin = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  appUser = new Pool({ connectionString: APP_USER_URL, connectionTimeoutMillis: 3000 });
  try {
    await admin.query('SELECT 1');
    await appUser.query('SELECT 1');
    const bypass = await appUser.query<{ b: boolean }>(
      'SELECT (rolsuper OR rolbypassrls) AS b FROM pg_roles WHERE rolname = current_user'
    );
    // A bypassing role would make every assertion below vacuous — it would pass
    // against the very bug this file exists to catch.
    if (bypass.rows[0]?.b !== false) {
      throw new Error('app_user can bypass RLS — these assertions would be meaningless');
    }
    available = true;
  } catch (err) {
    if (process.env.REQUIRE_DB_TESTS === '1') throw err;
    available = false;
  }

  if (available) {
    // Fixtures go in as admin: creating the tenant is exactly the cross-tenant
    // act the app does through its own enumerated raw-pool paths.
    await admin.query('DELETE FROM tenants WHERE tenant_id = $1', [TENANT_ID]);
    await admin.query(
      `INSERT INTO tenants (tenant_id, name, business_type, timezone)
       VALUES ($1, 'RLS Write Path Co', 'automotive', 'America/Chicago')`,
      [TENANT_ID]
    );
    await admin.query(
      `INSERT INTO users (user_id, tenant_id, email, password_hash, role, full_name)
       VALUES ($1, $2, 'rls-write-path@example.test', 'x', 'owner', 'RLS Owner')`,
      [USER_ID, TENANT_ID]
    );
  }
});

afterAll(async () => {
  if (available) {
    await admin.query('DELETE FROM tenants WHERE tenant_id = $1', [TENANT_ID]).catch(() => {});
  }
  await admin?.end();
  await appUser?.end();
});

describe('application write paths under RLS enforcement', () => {
  it('THE INCIDENT: seedDemoTenant succeeds as app_user (was: tenant_skills refused)', async () => {
    // WHO: every visitor who clicks "Try live demo" on the landing page.
    // WHAT: the real seedDemoTenant, against a real DB, as the non-bypassing role.
    // WHEN: it 500'd in production at 15:54 UTC on 2026-07-27, six minutes after
    //       DATABASE_URL was repointed, and again on every subsequent click.
    // WHERE: src/services/demoSeed.ts insertDemoData.
    // WHY: it wrote with no tenant context. Under BYPASSRLS that is invisible.
    if (!available) return;

    await expect(
      seedDemoTenant(appUser, { tenantId: TENANT_ID, userId: USER_ID })
    ).resolves.toBeUndefined();

    // The seed is only real if the rows landed — a silently-empty seed would
    // otherwise look identical to success from the caller's side.
    const skills = await admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM tenant_skills WHERE tenant_id = $1',
      [TENANT_ID]
    );
    expect(Number(skills.rows[0].n)).toBeGreaterThan(0);

    const customers = await admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM customers WHERE tenant_id = $1',
      [TENANT_ID]
    );
    expect(Number(customers.rows[0].n)).toBeGreaterThan(0);
  });

  it('is idempotent on a second call (the guard still sees its own rows under RLS)', async () => {
    // The re-entry guard reads `customers` for this tenant. Under RLS that read
    // needs the same context the write did, or the guard sees nothing, re-runs
    // the INSERT block, and dies on the appointments GiST exclusion.
    if (!available) return;
    await expect(
      seedDemoTenant(appUser, { tenantId: TENANT_ID, userId: USER_ID })
    ).resolves.toBeUndefined();
  });

  it('SAD: the same write WITHOUT a tenant context is refused — proves the test is live', async () => {
    // The control. If this ever stops throwing, RLS is not being enforced in
    // this environment and every other assertion in this file is vacuous.
    if (!available) return;
    const client = await appUser.connect();
    try {
      await expect(
        client.query(
          `INSERT INTO tenant_skills (tenant_id, name, description)
           VALUES ($1, 'No Context Skill', 'should be refused')`,
          [TENANT_ID]
        )
      ).rejects.toThrow(/row-level security/i);
    } finally {
      client.release();
    }
  });

  it('withTenantContext RESTORES the previous context instead of clearing it', async () => {
    // A helper that runs inside someone else's flow must not strip their
    // context on the way out: the caller's next statement would start failing
    // for reasons nowhere near the actual cause.
    if (!available) return;
    const outer = '11111111-0000-4000-8000-00000000000f';
    const client = await appUser.connect();
    try {
      await client.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', outer]);
      await withTenantContext(client, TENANT_ID, async () => {
        const inner = await client.query<{ v: string }>(
          "SELECT current_setting('app.current_tenant_id', true) AS v"
        );
        expect(inner.rows[0].v).toBe(TENANT_ID);
      });
      const after = await client.query<{ v: string }>(
        "SELECT current_setting('app.current_tenant_id', true) AS v"
      );
      expect(after.rows[0].v, 'the outer context must survive').toBe(outer);
    } finally {
      client.release();
    }
  });
});
