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
import { getRootClient, skipIfDbDown, ROOT_DB_URL, ensureTemplates } from '../utils';
import { seedTutorialTenant } from '../../src/services/tutorialSeed';
import {
  TUTORIAL_CALLS,
  TUTORIAL_KNOWLEDGE,
  TUTORIAL_MESSAGES,
  TUTORIAL_PREFERENCES,
  renderTranscript,
} from '../../src/services/tutorialActivity';
import { preferencesForVertical } from '../../shared/preferenceCatalog';
import { verticalForBusinessType } from '../../shared/checklistPresetDerivation';
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

      // The seed copies the Auto Shop Template; another file in this worker's
      // database may have wiped the templates (clearDB).
      await ensureTemplates(client);

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
    // adds a "Service Bay 1" on tenant insert; the template copy must replace it with
    // the template's own three bays, not leave a fourth.
    expect(names).toEqual(['Alignment Bay', 'Bay 1', 'Bay 2']);
  });

  it('HAPPY: services are a copy of the Auto Shop Template, with no prices', async () => {
    // WHO: demo visitor booking through the AI or quick-book
    // WHAT: the tenant has exactly the template's services, durations kept, price NULL
    // WHEN: after seed
    // WHERE: services table
    // WHY: the Tutorial must show what a new shop gets; and the product never sets prices
    const own = await client.query(
      `SELECT name, duration_minutes, price FROM services
        WHERE tenant_id = $1 AND is_deleted = false ORDER BY name`,
      [tenantId]
    );
    const tpl = await client.query(
      `SELECT s.name, s.duration_minutes FROM services s
         JOIN tenants t ON t.tenant_id = s.tenant_id
        WHERE t.is_template AND t.template_vertical = 'auto_shop' AND s.is_deleted = false
        ORDER BY s.name`
    );
    expect(own.rows.length).toBeGreaterThan(0);
    expect(own.rows.map((r) => [r.name, r.duration_minutes])).toEqual(
      tpl.rows.map((r) => [r.name, r.duration_minutes])
    );
    for (const row of own.rows as { price: string | null }[]) {
      expect(row.price).toBeNull();
    }
  });

  it('HAPPY: the template placeholder staff are renamed to named people', async () => {
    // WHO: demo visitor; scheduler needs employees to display staff rows
    // WHAT: two named mechanics (not "Mechanic 1") + service_employee links exist
    // WHEN: after seed
    // WHERE: employees + service_employee tables
    // WHY: the template's staff are placeholders for an owner to rename; the Tutorial
    //      shows them renamed, and no placeholder name may be left over
    const empRes = await client.query(
      'SELECT name FROM employees WHERE tenant_id = $1 AND is_deleted = false ORDER BY name',
      [tenantId]
    );
    expect(empRes.rows.map((r: { name: string }) => r.name)).toEqual(['Alex Rivera', 'Jordan Kim']);

    const mapRes = await client.query(
      'SELECT COUNT(*) AS cnt FROM service_employee WHERE tenant_id = $1',
      [tenantId]
    );
    expect(parseInt((mapRes.rows[0] as { cnt: string }).cnt, 10)).toBeGreaterThan(0);
  });

  it('HAPPY: knowledge starters are copied from the template', async () => {
    // WHO: demo visitor on the Knowledge page
    // WHAT: tenant_docs rows with source 'template', not yet embedded
    // WHEN: after seed
    // WHERE: tenant_docs
    // WHY: a new shop starts with these; the AI must not read one until it is saved
    const res = await client.query(
      `SELECT COUNT(*) AS cnt, COUNT(embedding) AS embedded
         FROM tenant_docs WHERE tenant_id = $1 AND source = 'template'`,
      [tenantId]
    );
    const row = res.rows[0] as { cnt: string; embedded: string };
    expect(parseInt(row.cnt, 10)).toBeGreaterThan(0);
    expect(parseInt(row.embedded, 10)).toBe(0);
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

  // ── Business-running activity (calls, messages, preferences, knowledge) ──
  // WHY: without these the Calls / Analytics / Messages / Customers / Knowledge
  //      pages are empty on the Tutorial, exactly where the product should prove itself.

  it('HAPPY: calls are seeded with transcripts, summaries and agent-vocabulary outcomes', async () => {
    const res = await client.query<{
      outcome: string;
      transcript: string;
      summary: string;
      duration_seconds: number;
      started_at: Date;
    }>(
      `SELECT outcome, transcript, summary, duration_seconds, started_at
         FROM voice_sessions WHERE tenant_id = $1 AND is_deleted = false`,
      [tenantId]
    );
    expect(res.rows).toHaveLength(TUTORIAL_CALLS.length);
    // Every outcome the Analytics "Why callers reached out" card is meant to show.
    const outcomes = new Set(res.rows.map((r) => r.outcome));
    for (const o of ['booked', 'message', 'transferred', 'info', 'price', 'no_availability']) {
      expect(outcomes.has(o), o).toBe(true);
    }
    for (const r of res.rows) {
      expect(r.transcript).toMatch(/^Assistant \[0:00\]: /);
      expect(r.summary.length).toBeGreaterThan(20);
      expect(r.duration_seconds).toBeGreaterThan(0);
      // All in the past week, so "This week" and analytics count them.
      expect(r.started_at.getTime()).toBeLessThan(Date.now());
      expect(Date.now() - r.started_at.getTime()).toBeLessThan(7 * 24 * 3600 * 1000);
    }
  });

  it('HAPPY: booked calls link to an appointment for the same customer', async () => {
    const res = await client.query<{ call_customer: string; appt_customer: string }>(
      `SELECT v.customer_id AS call_customer, a.customer_id AS appt_customer
         FROM voice_sessions v JOIN appointments a USING (appointment_id)
        WHERE v.tenant_id = $1 AND v.outcome = 'booked'`,
      [tenantId]
    );
    expect(res.rows.length).toBe(TUTORIAL_CALLS.filter((c) => c.outcome === 'booked').length);
    for (const r of res.rows) expect(r.call_customer).toBe(r.appt_customer);
  });

  it("HAPPY: a known caller's call also appears in their customer call history", async () => {
    const res = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM call_summaries WHERE tenant_id = $1',
      [tenantId]
    );
    expect(res.rows[0].n).toBe(TUTORIAL_CALLS.filter((c) => c.customer).length);
  });

  it('HAPPY: messages are seeded, one urgent, each tied to its call', async () => {
    const res = await client.query<{ is_urgent: boolean; call_id: string; status: string }>(
      'SELECT is_urgent, call_id, status FROM customer_messages WHERE tenant_id = $1',
      [tenantId]
    );
    expect(res.rows).toHaveLength(TUTORIAL_MESSAGES.length);
    expect(res.rows.filter((r) => r.is_urgent)).toHaveLength(1);
    const callIds = await client.query<{ call_id: string }>(
      'SELECT call_id FROM voice_sessions WHERE tenant_id = $1',
      [tenantId]
    );
    const known = new Set(callIds.rows.map((r) => r.call_id));
    for (const r of res.rows) {
      expect(known.has(r.call_id)).toBe(true);
      expect(r.status).toBe('new');
    }
  });

  it("SAD: every seeded preference key is on this business type's preference list", async () => {
    // WHY: a key the catalog does not know would show as a raw snake_case label and
    //      is a key the live agent could never have written. The Tutorial is an auto
    //      shop (its business_type must resolve to that vertical), so the keys come
    //      from the auto_shop list.
    expect(verticalForBusinessType(TUTORIAL_BUSINESS_TYPE)).toBe('auto_shop');
    const allowed = new Set(preferencesForVertical('auto_shop').map((p) => p.key));
    const res = await client.query<{ pref_key: string }>(
      'SELECT pref_key FROM customer_preferences WHERE tenant_id = $1',
      [tenantId]
    );
    expect(res.rows).toHaveLength(TUTORIAL_PREFERENCES.length);
    for (const r of res.rows) expect(allowed.has(r.pref_key), r.pref_key).toBe(true);
  });

  it('HAPPY: knowledge answers are seeded without spending an embedding call', async () => {
    const res = await client.query<{ title: string; embedded: boolean }>(
      `SELECT title, embedding IS NOT NULL AS embedded
         FROM tenant_docs WHERE tenant_id = $1 AND source = 'tutorial'`,
      [tenantId]
    );
    expect(res.rows).toHaveLength(TUTORIAL_KNOWLEDGE.length);
    expect(res.rows.every((r) => !r.embedded)).toBe(true);
  });

  it("REGRESSION: appointment times are the shop's local times, not UTC", async () => {
    // WHAT: the 10 AM brake inspection is 10:00 in America/Chicago.
    // WHY: the seed used to write 10:00 UTC, which the dashboard showed as 5:00 AM,
    //      before the shop opens.
    const res = await client.query<{ local_time: string }>(
      `SELECT to_char(start_time AT TIME ZONE 'America/Chicago', 'HH24:MI') AS local_time
         FROM appointments
        WHERE tenant_id = $1 AND description = 'Tutorial: today brake inspection'`,
      [tenantId]
    );
    expect(res.rows[0].local_time).toBe('10:00');
  });

  it('SAD: no seeded transcript has the assistant promising a text message or inventing a price', async () => {
    // WHY: SMS is off until 10DLC, and the product never sets prices, so the
    //      Tutorial must not show the AI promising a text or quoting a number it
    //      was never given. An amount the CALLER stated (an approval limit they
    //      want honoured) may be repeated back.
    for (const call of TUTORIAL_CALLS) {
      const lines = renderTranscript(call.turns).split('\n');
      const callerText = lines.filter((l) => l.startsWith('Caller')).join(' ');
      for (const line of lines.filter((l) => l.startsWith('Assistant'))) {
        expect(line, call.key).not.toMatch(/\b(text|texts|texting|sms)\b/i);
        for (const amount of line.match(/\$\d[\d,.]*/g) ?? []) {
          const spoken = amount.replace('$', '');
          expect(callerText, `${call.key} quotes ${amount}`).toMatch(
            new RegExp(`${spoken}|two hundred`, 'i')
          );
        }
      }
    }
    for (const doc of TUTORIAL_KNOWLEDGE) expect(doc.content, doc.title).not.toMatch(/\$\d/);
  });

  it('SAD: calling seed twice is idempotent (ON CONFLICT DO NOTHING)', async () => {
    // WHO: provisioning retry / network hiccup causing double-seed
    // WHAT: second call should not throw (ON CONFLICT DO NOTHING on shifts)
    // WHEN: race or retry on POST /tutorial/start
    // WHERE: seedTutorialTenant → expandShifts ON CONFLICT
    // WHY: a duplicate error would leave the tenant partially seeded
    const count = async () =>
      (
        await client.query<{ n: number }>(
          `SELECT (SELECT count(*) FROM voice_sessions WHERE tenant_id = $1)::int
                + (SELECT count(*) FROM customer_messages WHERE tenant_id = $1)::int
                + (SELECT count(*) FROM customer_preferences WHERE tenant_id = $1)::int
                + (SELECT count(*) FROM tenant_docs WHERE tenant_id = $1)::int AS n`,
          [tenantId]
        )
      ).rows[0].n;
    const before = await count();
    await expect(seedTutorialTenant(pool, { tenantId, userId })).resolves.not.toThrow();
    // ...and it must not double the sample activity either.
    expect(await count()).toBe(before);
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
