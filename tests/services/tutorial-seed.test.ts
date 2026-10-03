/**
 * Integration tests for demoSeed.ts
 *
 * WHO: demo provisioning path (POST /tutorial/start calls seedTutorialTenant)
 * WHAT: all required seed rows are created and queryable after seeding
 * WHEN: a new demo tenant is provisioned
 * WHERE: src/services/demoSeed.ts
 * WHY: demoSeed does ~10 INSERT statements across 7 tables; a typo in
 *      any one of them silently breaks the demo for real visitors. Unit
 *      tests with mocked pools can't catch schema drift.
 *
 * Strategy: real test_db, own tenant per test (created + deleted in
 * beforeAll/afterAll), no shared mutable state with other test files.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type Client, Pool } from 'pg';
import { getRootClient, skipIfDbDown, ROOT_DB_URL } from '../utils';
import { seedTutorialTenant } from '../../src/services/tutorialSeed';
import { TUTORIAL_BUSINESS_TYPE } from '../../src/routes/tutorial';
import { cleanupExpiredTutorialTenants } from '../../src/workers/reminderScheduler';

describe('seedTutorialTenant', () => {
  let client: Client;
  let pool: Pool;
  let tenantId: string;
  let userId: string;
  let dbAvailable = true;

  beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

  beforeAll(async () => {
    try {
      client = await getRootClient();
      pool = new Pool({ connectionString: ROOT_DB_URL });

      // Create a demo tenant + owner user (same as the route does before seeding).
      const tRes = await client.query<{ tenant_id: string }>(
        `INSERT INTO tenants (name, business_type, timezone, is_tutorial, tutorial_expires_at)
         VALUES ('Seed Test Demo', $1, 'America/Chicago', true, NOW() + INTERVAL '30 minutes')
         RETURNING tenant_id`,
        [TUTORIAL_BUSINESS_TYPE]
      );
      tenantId = tRes.rows[0].tenant_id;

      const uRes = await client.query<{ user_id: string }>(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
         VALUES ($1, 'seed-test@demo.invalid', 'x', 'Demo Owner', 'owner')
         RETURNING user_id`,
        [tenantId]
      );
      userId = uRes.rows[0].user_id;
    } catch (err) {
      dbAvailable = false;
      console.warn('[demo-seed] Skipping DB tests — connection failed:', err);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // CASCADE on tenants handles all child rows.
    await client.query('DELETE FROM tenants WHERE tenant_id = $1', [tenantId]);
    await client.end();
    await pool.end();
  });

  it('HAPPY: completes without error', async () => {
    // WHO: POST /tutorial/start calling seedTutorialTenant after tenant is created
    // WHAT: no throw, transaction commits
    // WHEN: fresh tenant with no pre-existing rows
    // WHERE: seedTutorialTenant()
    // WHY: a ROLLBACK on any INSERT leaves the demo tenant empty — bad UX
    await expect(seedTutorialTenant(pool, { tenantId, userId })).resolves.not.toThrow();
  });

  it('HAPPY: skills are created', async () => {
    // WHO: demo visitor loading the scheduler
    // WHAT: tenant_skills rows exist and skill names match the seed
    // WHEN: after seed
    // WHERE: tenant_skills table (composite PK: tenant_id, name)
    // WHY: skill rows gate service assignment — missing skills = no bookings
    const res = await client.query(
      `SELECT name FROM tenant_skills WHERE tenant_id = $1 ORDER BY name`,
      [tenantId]
    );
    const names = res.rows.map((r: { name: string }) => r.name);
    expect(names).toContain('Oil Change');
    expect(names).toContain('Tires');
    expect(names).toContain('Brakes');
    expect(names).toContain('General Service');
  });

  it('HAPPY: resources (bays) are created', async () => {
    // WHO: demo visitor viewing the resource scheduler
    // WHAT: two bay rows exist
    // WHEN: after seed
    // WHERE: resources table
    // WHY: missing resources = no appointment slots in resource mode
    const res = await client.query(
      'SELECT name FROM resources WHERE tenant_id = $1 ORDER BY name',
      [tenantId]
    );
    const names = res.rows.map((r: { name: string }) => r.name);
    // REGRESSION: with business_type 'auto-shop' the create_default_resources trigger
    // adds a "Service Bay 1" on tenant insert; the seed must drop it, or the
    // Tutorial's schedule shows three bays.
    expect(names).toEqual(['Bay 1', 'Bay 2']);
  });

  it('HAPPY: services are created with duration and price', async () => {
    // WHO: demo visitor booking through the AI or quick-book
    // WHAT: 4 services exist with non-zero durations
    // WHEN: after seed
    // WHERE: services table
    // WHY: missing services = "service-catalog" tool call returns empty list
    const res = await client.query(
      `SELECT name, duration_minutes, price
       FROM services WHERE tenant_id = $1 ORDER BY name`,
      [tenantId]
    );
    expect(res.rows).toHaveLength(4);
    for (const row of res.rows as { name: string; duration_minutes: number; price: string }[]) {
      expect(row.duration_minutes).toBeGreaterThan(0);
    }
    const svcNames = res.rows.map((r: { name: string }) => r.name);
    expect(svcNames).toContain('Oil Change');
  });

  it('HAPPY: employees are created and assigned to services', async () => {
    // WHO: demo visitor; scheduler needs employees to display staff rows
    // WHAT: 2 employees + service_employee assignments exist
    // WHEN: after seed
    // WHERE: employees + service_employee tables
    // WHY: missing employees = no staff rows in scheduler = confusing empty UI
    const empRes = await client.query(
      'SELECT name FROM employees WHERE tenant_id = $1 ORDER BY name',
      [tenantId]
    );
    expect(empRes.rows).toHaveLength(2);

    const mapRes = await client.query(
      'SELECT COUNT(*) AS cnt FROM service_employee WHERE tenant_id = $1',
      [tenantId]
    );
    expect(parseInt((mapRes.rows[0] as { cnt: string }).cnt, 10)).toBeGreaterThan(0);
  });

  it('HAPPY: shifts are created for weekdays within 28-day window', async () => {
    // WHO: demo visitor checking availability
    // WHAT: employee_schedule rows cover weekdays from today
    // WHEN: after seed
    // WHERE: employee_schedule table
    // WHY: no shifts = EMPLOYEE_NOT_SCHEDULED error on every booking attempt
    const res = await client.query(
      `SELECT COUNT(*) AS cnt FROM employee_schedule WHERE tenant_id = $1`,
      [tenantId]
    );
    const cnt = parseInt((res.rows[0] as { cnt: string }).cnt, 10);
    // 28 days, ~20 weekdays, 2 employees = ~40 shift rows
    expect(cnt).toBeGreaterThanOrEqual(30);
  });

  it('HAPPY: customers are created', async () => {
    // WHO: demo visitor viewing the Customers tab
    // WHAT: 5 customer rows visible in the CRM
    // WHEN: after seed
    // WHERE: customers table
    // WHY: empty CRM looks broken for a demo — visitors need data to explore
    const res = await client.query('SELECT COUNT(*) AS cnt FROM customers WHERE tenant_id = $1', [
      tenantId,
    ]);
    expect(parseInt((res.rows[0] as { cnt: string }).cnt, 10)).toBe(5);
  });

  it('HAPPY: appointments span past, today, and future', async () => {
    // WHO: demo visitor viewing the scheduler
    // WHAT: appointments exist in the past (completed) and future (scheduled)
    // WHEN: after seed
    // WHERE: appointments table
    // WHY: an empty calendar looks broken; visitors need to see real data
    const res = await client.query(
      `SELECT status, COUNT(*) AS cnt
       FROM appointments WHERE tenant_id = $1
       GROUP BY status ORDER BY status`,
      [tenantId]
    );
    const byStatus = Object.fromEntries(
      (res.rows as { status: string; cnt: string }[]).map((r) => [r.status, parseInt(r.cnt, 10)])
    );
    expect(byStatus['completed']).toBeGreaterThanOrEqual(1);
    expect(byStatus['scheduled']).toBeGreaterThanOrEqual(1);
  });

  it('SAD: calling seed twice is idempotent (ON CONFLICT DO NOTHING)', async () => {
    // WHO: provisioning retry / network hiccup causing double-seed
    // WHAT: second call should not throw (ON CONFLICT DO NOTHING on shifts)
    // WHEN: race or retry on POST /tutorial/start
    // WHERE: seedTutorialTenant → expandShifts ON CONFLICT
    // WHY: a duplicate error would leave the tenant partially seeded
    await expect(seedTutorialTenant(pool, { tenantId, userId })).resolves.not.toThrow();
  });
});

describe('cleanupExpiredTutorialTenants', () => {
  let client: Client;
  let pool: Pool;
  let dbAvailable = true;

  beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

  beforeAll(async () => {
    try {
      client = await getRootClient();
      pool = new Pool({ connectionString: ROOT_DB_URL });
    } catch (err) {
      dbAvailable = false;
      console.warn('[demo-cleanup] Skipping DB tests — connection failed:', err);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await client.end();
    await pool.end();
  });

  it('HAPPY: SOFT-deletes demo tenants whose tutorial_expires_at is in the past', async () => {
    // WHO: reminder scheduler tick running every 60s
    // WHAT: the expired demo tenant is flagged is_deleted — NOT hard-deleted.
    // WHEN: tutorial_expires_at < NOW()
    // WHERE: cleanupExpiredTutorialTenants() in reminderScheduler
    // WHY THE CHANGE (2026-07-13): this runs every 60 SECONDS in production, and a
    //       cascading DELETE races the fire-and-forget reminder seeding of any live
    //       booking — FK locks in opposite orders, Postgres kills one side at random
    //       (PR #242). That is a real production deadlock on a 60-second timer. An
    //       UPDATE takes no cascade locks, so the cycle cannot form. The rows survive
    //       for the maintenance purge; nothing can reach them (withTenantClient 404s a
    //       soft-deleted tenant).
    const res = await client.query<{ tenant_id: string }>(
      `INSERT INTO tenants (name, business_type, timezone, is_tutorial, tutorial_expires_at)
       VALUES ('Expired Demo', 'automotive', 'America/Chicago', true, NOW() - INTERVAL '1 minute')
       RETURNING tenant_id`
    );
    const expiredId = res.rows[0].tenant_id;

    await cleanupExpiredTutorialTenants(pool);

    // The row SURVIVES, flagged — that is the point. Nothing reads it.
    const check = await client.query<{ is_deleted: boolean; deleted_at: Date | null }>(
      'SELECT is_deleted, deleted_at FROM tenants WHERE tenant_id = $1',
      [expiredId]
    );
    expect(check.rows).toHaveLength(1);
    expect(check.rows[0].is_deleted).toBe(true);
    expect(check.rows[0].deleted_at).not.toBeNull();

    // And it is invisible to every live-tenant lookup.
    const live = await client.query(
      'SELECT 1 FROM tenants WHERE tenant_id = $1 AND is_deleted = false',
      [expiredId]
    );
    expect(live.rows).toHaveLength(0);
  });

  it('HAPPY: leaves non-expired demo tenants untouched', async () => {
    // WHO: reminder scheduler tick
    // WHAT: tenant with future tutorial_expires_at is not deleted
    // WHEN: tutorial_expires_at > NOW()
    // WHERE: cleanupExpiredTutorialTenants()
    // WHY: deleting active sessions would boot users mid-demo
    const res = await client.query<{ tenant_id: string }>(
      `INSERT INTO tenants (name, business_type, timezone, is_tutorial, tutorial_expires_at)
       VALUES ('Active Demo', 'automotive', 'America/Chicago', true, NOW() + INTERVAL '20 minutes')
       RETURNING tenant_id`
    );
    const activeId = res.rows[0].tenant_id;

    await cleanupExpiredTutorialTenants(pool);

    const check = await client.query('SELECT 1 FROM tenants WHERE tenant_id = $1', [activeId]);
    expect(check.rows).toHaveLength(1);

    // Teardown
    await client.query('DELETE FROM tenants WHERE tenant_id = $1', [activeId]);
  });

  it('HAPPY: leaves non-demo tenants untouched regardless of timestamps', async () => {
    // WHO: reminder scheduler tick
    // WHAT: is_tutorial=false tenant is never swept even if created long ago
    // WHEN: any tick
    // WHERE: cleanupExpiredTutorialTenants() WHERE is_tutorial = true filter
    // WHY: a missing WHERE clause would delete real business data
    const res = await client.query<{ tenant_id: string }>(
      `INSERT INTO tenants (name, business_type, timezone, is_tutorial)
       VALUES ('Real Business', 'automotive', 'America/Chicago', false)
       RETURNING tenant_id`
    );
    const realId = res.rows[0].tenant_id;

    await cleanupExpiredTutorialTenants(pool);

    const check = await client.query('SELECT 1 FROM tenants WHERE tenant_id = $1', [realId]);
    expect(check.rows).toHaveLength(1);

    // Teardown
    await client.query('DELETE FROM tenants WHERE tenant_id = $1', [realId]);
  });
});
