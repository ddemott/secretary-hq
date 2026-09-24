/**
 * Regression tests for the Critical bug-fix sweep.
 *
 * Feature areas covered (search here when touching any of these):
 *   - **Booking**: timezone-aware shift validation
 *     (BUG-001 — book_appointment_atomic uses tenant timezone, not UTC)
 *   - **Auth / users**: per-tenant email uniqueness
 *     (BUG-002 — same email allowed across different tenants)
 *   - **RLS**: users table tenant scoping via `app.current_tenant_id`
 *     (BUG-006 — RLS policy on users)
 *
 * Why bug-numbered, not feature-named: this file captures the full
 * regression set for the original Critical sweep so a future audit can
 * verify all three bugs stay closed together. Feature-area work should
 * still grep here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getRootClient,
  getApiClient,
  clearDB,
  createTenant,
  createResource,
  createEmployee,
  createScheduleEntry,
  createCustomerFull,
  skipIfDbDown,
} from '../utils';
import { type Client } from 'pg';

describe('Critical Bug Fixes (BUG-001, BUG-002, BUG-006)', () => {
  let root: Client;
  let api: Client;
  let dbAvailable = true;
  beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

  beforeAll(async () => {
    try {
      root = await getRootClient();
      api = await getApiClient();
    } catch (err) {
      dbAvailable = false;
      console.warn('[critical-bugs.test] Skipping DB tests - connection failed', err);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      if (root) await root.end();
      if (api) await api.end();
    }
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    await clearDB(root);
  });

  // =========================================================
  // BUG-001: Shift timezone - uses tenant TZ, not hardcoded UTC
  // =========================================================
  describe('BUG-001: Shift timezone validation', () => {
    it('should validate shifts using tenant timezone, not UTC', async () => {
      // WHO: voice AI booking for an Eastern-timezone shop's caller
      // WHAT: book_appointment_atomic compares the requested wall-time
      //       against the employee's shift in the tenant's timezone
      //       (not in UTC), so 10am-11am Eastern is correctly inside
      //       a 9-5 Eastern shift even though the UTC values differ
      // WHEN: every voice AI booking call where the tenant timezone
      //       is not America/Chicago (the original baseline)
      // WHERE: book_appointment_atomic shift-validation block — it
      //        reads tenants.timezone and converts the booking window
      //        before comparing against employee_schedule rows
      // WHY: BUG-001 — pre-fix the RPC compared raw UTC values against
      //       shift hours, so a tenant in Eastern timezone would see
      //       valid 10am Eastern bookings rejected as "outside shift"
      //       because 15:00 UTC sits inside 9-5 only in the US East
      if (!dbAvailable) return;

      const tenantId = await createTenant(root, 'Eastern Shop', 'auto-shop', 'America/New_York');
      const resourceId = await createResource(root, tenantId, 'Bay 1');
      const customerId = await createCustomerFull(root, tenantId, '+15550001111', 'Alice');
      const employeeId = await createEmployee(root, tenantId, 'Mike', ['oil-change']);
      // 2027-03-01 is a Monday. Booking RPCs read only employee_schedule.
      await createScheduleEntry(root, tenantId, employeeId, '2027-03-01', '09:00', '17:00');

      // Book for Monday 10 AM - 11 AM Eastern (= 15:00 - 16:00 UTC)
      const result = await root.query(
        'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9);',
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2027-03-01T15:00:00Z'),
          new Date('2027-03-01T16:00:00Z'),
          'Oil change',
          'call_tz_001',
          null,
          employeeId.toString(),
        ]
      );

      expect(result.rows[0].success).toBe(true);
      expect(result.rows[0].appointment_id).not.toBeNull();
    });

    it('should reject booking outside shift hours in tenant timezone', async () => {
      // WHO: same Eastern-timezone tenant; voice AI booking 6pm
      //      Eastern (after the employee's 9-5 shift ends)
      // WHAT: RPC returns success=false with the standard
      //       "Employee is not on shift during this time" error string
      //       — same string the agent prompt knows how to relay
      // WHEN: any booking attempt outside the employee's shift window
      //       in the tenant's local time
      // WHERE: book_appointment_atomic shift-validation block (sad path)
      // WHY: BUG-001 sad-path complement to the test above. Pinning
      //      both directions (in-shift accepts, out-of-shift rejects)
      //      catches a regression that broke EITHER the timezone
      //      conversion OR the comparison direction. The exact
      //      error_message string is part of the agent prompt's
      //      failure-mapping contract
      if (!dbAvailable) return;

      const tenantId = await createTenant(root, 'Eastern Shop', 'auto-shop', 'America/New_York');
      const resourceId = await createResource(root, tenantId, 'Bay 1');
      const customerId = await createCustomerFull(root, tenantId, '+15550001111', 'Alice');
      const employeeId = await createEmployee(root, tenantId, 'Mike', ['oil-change']);
      // 2027-03-01 is a Monday. Booking RPCs read only employee_schedule.
      await createScheduleEntry(root, tenantId, employeeId, '2027-03-01', '09:00', '17:00');

      // Book for Monday 6 PM Eastern (= 23:00 UTC) — OUTSIDE shift
      const result = await root.query(
        'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9);',
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2027-03-01T23:00:00Z'),
          new Date('2027-03-02T00:00:00Z'),
          'Late oil change',
          'call_tz_002',
          null,
          employeeId.toString(),
        ]
      );

      expect(result.rows[0].success).toBe(false);
      expect(result.rows[0].error_message).toBe('Employee is not on shift during this time');
    });

    it('should handle UTC-crossing correctly (evening in local TZ is next day in UTC)', async () => {
      // WHO: West-coast tenant whose evening hours cross the UTC
      //      day boundary (8pm Pacific = 4am UTC the next day)
      // WHAT: book_appointment_atomic accepts the booking even though
      //       the UTC date differs from the local date that
      //       employee_schedule was seeded against
      // WHEN: any after-7pm Pacific booking (or 9pm Pacific west of
      //       PST/PDT) — common for trade businesses with evening hours
      // WHERE: book_appointment_atomic timezone-conversion code,
      //        specifically the local-date derivation step
      // WHY: BUG-001 edge case — a naive timezone implementation that
      //      compared the booking's UTC date against employee_schedule
      //      rows would miss the right shift_date. This test pins
      //      that the conversion uses the LOCAL date (2027-03-01)
      //      rather than the UTC date (2027-03-02) for the lookup
      if (!dbAvailable) return;

      const tenantId = await createTenant(
        root,
        'West Coast Shop',
        'auto-shop',
        'America/Los_Angeles'
      );
      const resourceId = await createResource(root, tenantId, 'Bay 1');
      const customerId = await createCustomerFull(root, tenantId, '+15550001111', 'Alice');
      const employeeId = await createEmployee(root, tenantId, 'Steve', ['tire-install']);
      // Booking is local 2027-03-01 (Monday 8 PM Pacific). Seed
      // employee_schedule for that local date.
      await createScheduleEntry(root, tenantId, employeeId, '2027-03-01', '09:00', '21:00');

      // Book for Monday 8 PM Pacific = Tuesday 4 AM UTC
      const result = await root.query(
        'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9);',
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2027-03-02T04:00:00Z'),
          new Date('2027-03-02T05:00:00Z'),
          'Late tire install',
          'call_tz_003',
          null,
          employeeId.toString(),
        ]
      );

      expect(result.rows[0].success).toBe(true);
      expect(result.rows[0].appointment_id).not.toBeNull();
    });
  });

  // =========================================================
  // BUG-002: users.email per-tenant uniqueness
  // =========================================================
  describe('BUG-002: Per-tenant email uniqueness', () => {
    it('REVERSED 2026-09-24: the same email is REJECTED in a different tenant (one account per email)', async () => {
      // WHO: a person who owns/works at multiple tenants on the platform.
      // WHAT: a second users row with the same address in another tenant is
      //       refused by users_email_lower_unique (case-insensitive).
      // WHEN: any cross-tenant signup, admin-create or invite.
      // WHERE: users table — platform-wide unique index on LOWER(email)
      //        (migration 20260924000200), alongside (tenant_id, email).
      // WHY: owner decision 2026-09-24 — "once an email is in the system it
      //      should be unique". This DELIBERATELY reverses BUG-002, which had
      //      scoped uniqueness to (tenant_id, email) so one person could hold
      //      the same email in several businesses; that person now needs a
      //      separate address per business. This test used to assert the
      //      opposite and was written to fail loudly on exactly this change.
      if (!dbAvailable) return;

      const tenantA = await createTenant(root, 'Shop A', 'auto-shop');
      const tenantB = await createTenant(root, 'Shop B', 'salon');

      await root.query(
        "INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, 'admin@example.com', '$2b$10$fakehash', 'Admin A');",
        [tenantA]
      );

      await expect(
        root.query(
          "INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, 'Admin@Example.com', '$2b$10$fakehash', 'Admin B');",
          [tenantB]
        )
      ).rejects.toMatchObject({ code: '23505', constraint: 'users_email_lower_unique' });
    });

    it('should still reject duplicate email within the same tenant', async () => {
      // WHO: an attempted second user registration with an email that
      //      already exists in the same tenant
      // WHAT: INSERT throws a uniqueness-violation error
      // WHEN: any same-tenant duplicate email — typo in admin signup,
      //       a bug that didn't notice the existing user, etc.
      // WHERE: users table UNIQUE (tenant_id, email)
      // WHY: BUG-002 sad-path complement. Without this test, a
      //      regression that dropped the constraint entirely would
      //      pass the previous test (multi-tenant works) but break
      //      same-tenant duplicate detection silently. Pin both halves
      if (!dbAvailable) return;

      const tenantA = await createTenant(root, 'Shop A', 'auto-shop');

      await root.query(
        "INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, 'admin@example.com', '$2b$10$fakehash', 'Admin A');",
        [tenantA]
      );

      await expect(
        root.query(
          "INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, 'admin@example.com', '$2b$10$fakehash', 'Duplicate');",
          [tenantA]
        )
      ).rejects.toThrow(/unique/i);
    });
  });

  // =========================================================
  // BUG-006: Users table RLS uses app.current_tenant_id
  // =========================================================
  describe('BUG-006: Users RLS uses app.current_tenant_id', () => {
    it('should isolate users by tenant using app.current_tenant_id', async () => {
      // WHO: api_user role with tenant context set; a SELECT FROM
      //      users should return only the rows that match
      //      app.current_tenant_id, not all users across tenants
      // WHAT: tenant A sees only User A; tenant B sees only User B
      //       (the correct names, in the correct rows)
      // WHEN: every authenticated dashboard request that lists users
      // WHERE: users RLS policy reading app.current_tenant_id
      // WHY: BUG-006 — the original RLS policy on users table read a
      //      different session variable than the rest of the schema,
      //      causing cross-tenant user list leaks (a bug worse than
      //      BUG-001 since user emails are PII). Pin the canonical
      //      app.current_tenant_id contract uniformly across tables
      if (!dbAvailable) return;

      const tenantA = await createTenant(root, 'A', 't');
      const tenantB = await createTenant(root, 'B', 't');

      await root.query(
        "INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, 'user@a.com', '$2b$10$fakehash', 'User A');",
        [tenantA]
      );
      await root.query(
        "INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, 'user@b.com', '$2b$10$fakehash', 'User B');",
        [tenantB]
      );

      await api.query('SELECT set_tenant_context($1::UUID)', [tenantA]);
      const resA = await api.query('SELECT * FROM users');
      expect(resA.rowCount).toBe(1);
      expect(resA.rows[0].full_name).toBe('User A');

      await api.query('SELECT set_tenant_context($1::UUID)', [tenantB]);
      const resB = await api.query('SELECT * FROM users');
      expect(resB.rowCount).toBe(1);
      expect(resB.rows[0].full_name).toBe('User B');
    });

    it('should prevent cross-tenant user access', async () => {
      // WHO: api_user with tenant A context attempting to UPDATE a
      //      user row in tenant B by guessed UUID
      // WHAT: UPDATE returns rowCount=0; the target row stays untouched
      //       when checked from tenant B's context
      // WHEN: any cross-tenant write probe — same risk shape as the
      //       resources-table cross-tenant UPDATE test in rls.test.ts,
      //       but for the more sensitive users table
      // WHERE: users RLS UPDATE policy
      // WHY: BUG-006 write-side complement to the previous read test.
      //      Reads (test above) leak data; writes corrupt data. A
      //      regression here could let an attacker rename users in
      //      another tenant — escalating from data leak to
      //      account-takeover-adjacent territory
      if (!dbAvailable) return;

      const tenantA = await createTenant(root, 'A', 't');
      const tenantB = await createTenant(root, 'B', 't');

      const userB = (
        await root.query(
          "INSERT INTO users (tenant_id, email, password_hash, full_name) VALUES ($1, 'secret@b.com', '$2b$10$fakehash', 'Secret User') RETURNING user_id;",
          [tenantB]
        )
      ).rows[0].user_id;

      await api.query('SELECT set_tenant_context($1::UUID)', [tenantA]);
      const updateRes = await api.query(
        "UPDATE users SET full_name = 'Hacked' WHERE user_id = $1",
        [userB]
      );
      expect(updateRes.rowCount).toBe(0);

      await api.query('SELECT set_tenant_context($1::UUID)', [tenantB]);
      const checkRes = await api.query('SELECT full_name FROM users WHERE user_id = $1', [userB]);
      expect(checkRes.rows[0].full_name).toBe('Secret User');
    });
  });
});
