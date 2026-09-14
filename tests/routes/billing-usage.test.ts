import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from 'pg';
import { Pool } from 'pg';
import { getRootClient, createTenant, skipIfDbDown } from '../utils';
import {
  computeUsageStatements,
  evaluateUsageCap,
  BILLABLE_MIN_SECONDS,
  PLAN_QUOTAS,
} from '../../src/services/billingUsage';

let client: Client;
let pool: Pool;
let tenantId: string;
let noPlanTenantId: string;
let dbAvailable = true;

async function insertSession(
  tid: string,
  opts: {
    status?: string;
    durationSeconds?: number | null;
    callerSpoke?: boolean;
    startedAt?: string;
  }
) {
  const transcript =
    opts.callerSpoke === false
      ? 'Assistant: Hi, thank you for calling!'
      : 'Assistant: Hi, thank you for calling!\nCaller: I would like to book a meeting.';
  await client.query(
    `INSERT INTO voice_sessions (tenant_id, call_id, status, started_at, duration_seconds, transcript)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6)`,
    [
      tid,
      `billing-usage-test-${Math.random().toString(36).slice(2)}`,
      opts.status ?? 'completed',
      opts.startedAt ?? null,
      opts.durationSeconds === undefined ? 120 : opts.durationSeconds,
      transcript,
    ]
  );
}

beforeAll(async () => {
  try {
    client = await getRootClient();
    pool = new Pool({
      connectionString:
        process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/test_db',
      max: 2,
    });
    tenantId = await createTenant(client, 'Billing Usage Test Tenant', 'salon');
    noPlanTenantId = await createTenant(client, 'Billing Usage No-Plan Tenant', 'salon');
    await client.query(`UPDATE tenants SET subscription_plan = 'solo' WHERE tenant_id = $1`, [tenantId]);
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  for (const tid of [tenantId, noPlanTenantId]) {
    await client.query(`DELETE FROM voice_sessions WHERE tenant_id = $1`, [tid]);
    await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [tid]);
  }
  await pool.end();
  await client.end();
});

describe('billingUsage — the answered-call definition', () => {
  it('HAPPY: a completed call where the caller spoke for >= 15s bills; spam/silent/short/active calls are FREE', async (ctx) => {
    // WHO: a tenant owner reviewing whether mixed call outcomes affect billing.
    // WHAT: only completed, caller-spoke, >= threshold calls bill; others stay free.
    // WHEN: the month contains answered, silent, short, null-duration, and active calls.
    // WHERE: computeUsageStatements() answered-call classifier.
    // WHY: billing must charge real answered calls without counting noise or in-flight sessions.
    skipIfDbDown(ctx, () => dbAvailable);
    await insertSession(tenantId, {});
    await insertSession(tenantId, { callerSpoke: false });
    await insertSession(tenantId, { durationSeconds: BILLABLE_MIN_SECONDS - 1 });
    await insertSession(tenantId, { durationSeconds: null });
    await insertSession(tenantId, { status: 'active' });

    const res = await computeUsageStatements(pool, tenantId, 1);
    expect(res.plan).toBe('solo');
    expect(res.quota).toEqual(PLAN_QUOTAS.solo);
    expect(res.statements).toHaveLength(1);
    const m = res.statements[0];
    expect(m.totalCalls).toBe(5);
    expect(m.answeredCalls).toBe(1);
    expect(m.freeCalls).toBe(4);
    expect(m.inProgress).toBe(true);
    expect(m.overageCalls).toBe(0);
    expect(m.packsApplied).toBe(0);
    expect(m.packChargeUsd).toBe(0);
  });

  it('HAPPY: exactly BILLABLE_MIN_SECONDS bills (boundary is inclusive)', async (ctx) => {
    // WHO: an owner whose call hits the exact billable threshold.
    // WHAT: 15 seconds counts as billable; boundary is inclusive.
    // WHEN: duration_seconds === BILLABLE_MIN_SECONDS.
    // WHERE: computeUsageStatements() answered-call filter.
    // WHY: off-by-one here changes invoices.
    skipIfDbDown(ctx, () => dbAvailable);
    const before = await computeUsageStatements(pool, tenantId, 1);
    await insertSession(tenantId, { durationSeconds: BILLABLE_MIN_SECONDS });
    const after = await computeUsageStatements(pool, tenantId, 1);
    expect(after.statements[0].answeredCalls).toBe(before.statements[0].answeredCalls + 1);
  });

  it('C1: null-plan tenant under soft-cap gets free-tier quota (finite, not pack-billed)', async (ctx) => {
    // WHO: inactive/beta tenant with subscription_plan NULL.
    // WHAT: free-tier finite includedCalls; no pack overage charges.
    // WHEN: soft-cap enforce on (default).
    // WHERE: computeUsageStatements() free-tier fallback.
    // WHY: silent unlimited was the unpaid-tenant margin hole.
    skipIfDbDown(ctx, () => dbAvailable);
    await insertSession(noPlanTenantId, {});
    const res = await computeUsageStatements(pool, noPlanTenantId, 1);
    expect(res.plan).toBeNull();
    expect(res.quota).not.toBeNull();
    expect(res.quota!.includedCalls).toBeGreaterThan(0);
    expect(res.cap.freeTierApplied).toBe(true);
    expect(res.cap.limit).toBe(res.quota!.includedCalls);
    expect(res.cap.status).not.toBe('unlimited');
    const m = res.statements[0];
    expect(m.answeredCalls).toBe(1);
    expect(m.includedCalls).toBe(res.quota!.includedCalls);
    expect(m.overageCalls).toBeNull();
    expect(m.packsApplied).toBeNull();
    expect(m.packChargeUsd).toBeNull();
  });

  it('SAD: unknown tenant throws Tenant not found', async (ctx) => {
    // WHO: route caller asking for usage on a nonexistent tenant.
    // WHAT: service throws Tenant not found.
    // WHEN: tenant lookup returns zero rows.
    // WHERE: computeUsageStatements() tenant preflight.
    // WHY: route maps this to 404 instead of fake empty statements.
    skipIfDbDown(ctx, () => dbAvailable);
    await expect(
      computeUsageStatements(pool, '00000000-0000-4000-8000-00000000dead', 1)
    ).rejects.toThrow('Tenant not found');
  });
});


describe('billingUsage — pack math', () => {
  it('HAPPY: overage rounds UP to whole packs, priced at packPriceUsd each', async (ctx) => {
    // WHO: a solo-plan tenant who goes over quota.
    // WHAT: overage rounds up to whole packs at flat pack pricing.
    // WHEN: answeredCalls exceed includedCalls by 31 (env Solo cap 50 + 31).
    // WHERE: computeUsageStatements() pack math.
    // WHY: undercharging leaks revenue; overcharging torches trust.
    skipIfDbDown(ctx, () => dbAvailable);
    const prev = process.env.PLAN_CAP_SOLO;
    process.env.PLAN_CAP_SOLO = '50';
    const packTenant = await createTenant(client, 'Billing Usage Pack Tenant', 'salon');
    try {
      await client.query(`UPDATE tenants SET subscription_plan = 'solo' WHERE tenant_id = $1`, [packTenant]);
      const lastMonth = new Date();
      lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
      lastMonth.setUTCDate(3);
      const soloCap = 50;
      const answered = soloCap + 31;
      await client.query(
        `INSERT INTO voice_sessions (tenant_id, call_id, status, started_at, duration_seconds, transcript)
         SELECT $1, 'pack-test-' || g, 'completed', $2::timestamptz, 60,
                'Assistant: hello' || E'\n' || 'Caller: booking please'
           FROM generate_series(1, $3) g`,
        [packTenant, lastMonth.toISOString(), answered]
      );

      const res = await computeUsageStatements(pool, packTenant, 3);
      const m = res.statements.find((s) => !s.inProgress && s.answeredCalls === answered);
      expect(m).toBeDefined();
      expect(m!.overageCalls).toBe(31);
      expect(m!.packsApplied).toBe(2);
      expect(m!.packChargeUsd).toBe(2 * PLAN_QUOTAS.solo.packPriceUsd);
      expect(m!.inProgress).toBe(false);
    } finally {
      await client.query(`DELETE FROM voice_sessions WHERE tenant_id = $1`, [packTenant]);
      await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [packTenant]);
      if (prev === undefined) delete process.env.PLAN_CAP_SOLO;
      else process.env.PLAN_CAP_SOLO = prev;
    }
  });
});

describe('billingUsage — soft cap evaluation', () => {
  it('HAPPY: evaluateUsageCap blocks when answered >= Solo limit', async (ctx) => {
    // WHO: Solo tenant at monthly cap calling again.
    // WHAT: cap.blocked true; status blocked.
    // WHEN: answeredCallsThisMonth === includedCalls (env-capped to 3 for speed).
    // WHERE: evaluateUsageCap().
    // WHY: soft-cap gate on voice-session-start must refuse the next call.
    skipIfDbDown(ctx, () => dbAvailable);
    const prev = process.env.PLAN_CAP_SOLO;
    process.env.PLAN_CAP_SOLO = '3';
    const capTenant = await createTenant(client, 'Billing Usage Cap Tenant', 'salon');
    try {
      await client.query(`UPDATE tenants SET subscription_plan = 'solo' WHERE tenant_id = $1`, [
        capTenant,
      ]);
      await client.query(
        `INSERT INTO voice_sessions (tenant_id, call_id, status, started_at, duration_seconds, transcript)
         SELECT $1, 'cap-test-' || g, 'completed', now(), 60,
                'Assistant: hello' || E'\n' || 'Caller: booking please'
           FROM generate_series(1, 3) g`,
        [capTenant]
      );
      // Same client as the inserts — avoids cross-connection deadlocks with
      // version-history triggers that lock the tenant row.
      const cap = await evaluateUsageCap(client, capTenant);
      expect(cap.limit).toBe(3);
      expect(cap.used).toBe(3);
      expect(cap.status).toBe('blocked');
      expect(cap.blocked).toBe(true);
      expect(cap.percent).toBe(100);
    } finally {
      await client.query(`DELETE FROM voice_sessions WHERE tenant_id = $1`, [capTenant]);
      await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [capTenant]);
      if (prev === undefined) delete process.env.PLAN_CAP_SOLO;
      else process.env.PLAN_CAP_SOLO = prev;
    }
  });

  it('HAPPY: professional plan never blocks (unlimited)', async (ctx) => {
    skipIfDbDown(ctx, () => dbAvailable);
    const proTenant = await createTenant(client, 'Billing Usage Pro Tenant', 'salon');
    try {
      await client.query(
        `UPDATE tenants SET subscription_plan = 'professional' WHERE tenant_id = $1`,
        [proTenant]
      );
      await insertSession(proTenant, {});
      const cap = await evaluateUsageCap(client, proTenant);
      expect(cap.limit).toBeNull();
      expect(cap.status).toBe('unlimited');
      expect(cap.blocked).toBe(false);
    } finally {
      await client.query(`DELETE FROM voice_sessions WHERE tenant_id = $1`, [proTenant]);
      await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [proTenant]);
    }
  });

  it('HAPPY: computeUsageStatements includes cap for the dashboard meter', async (ctx) => {
    skipIfDbDown(ctx, () => dbAvailable);
    const res = await computeUsageStatements(client, tenantId, 1);
    expect(res.cap).toBeDefined();
    expect(res.cap.plan).toBe('solo');
    expect(res.cap.limit).toBe(PLAN_QUOTAS.solo.includedCalls);
    expect(typeof res.cap.used).toBe('number');
    expect(res.cap.warnRatio).toBeGreaterThan(0);
  });

  it('C1: inactive null-plan tenant is capped (not unlimited) under soft-cap', async (ctx) => {
    skipIfDbDown(ctx, () => dbAvailable);
    const prevFree = process.env.PLAN_CAP_FREE;
    process.env.PLAN_CAP_FREE = '2';
    const inactive = await createTenant(client, 'Billing Usage Inactive Cap', 'salon');
    try {
      await client.query(
        `UPDATE tenants
            SET subscription_plan = NULL, subscription_status = 'inactive'
          WHERE tenant_id = $1`,
        [inactive]
      );
      await client.query(
        `INSERT INTO voice_sessions (tenant_id, call_id, status, started_at, duration_seconds, transcript)
         SELECT $1, 'inactive-cap-' || g, 'completed', now(), 60,
                'Assistant: hello' || E'\n' || 'Caller: booking please'
           FROM generate_series(1, 2) g`,
        [inactive]
      );
      const cap = await evaluateUsageCap(client, inactive);
      expect(cap.freeTierApplied).toBe(true);
      expect(cap.limit).toBe(2);
      expect(cap.used).toBe(2);
      expect(cap.status).toBe('blocked');
      expect(cap.blocked).toBe(true);
    } finally {
      await client.query(`DELETE FROM voice_sessions WHERE tenant_id = $1`, [inactive]);
      await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [inactive]);
      if (prevFree === undefined) delete process.env.PLAN_CAP_FREE;
      else process.env.PLAN_CAP_FREE = prevFree;
    }
  });

  it('C1: unknown plan string is not unlimited under soft-cap', async (ctx) => {
    skipIfDbDown(ctx, () => dbAvailable);
    const prevFree = process.env.PLAN_CAP_FREE;
    process.env.PLAN_CAP_FREE = '1';
    const weird = await createTenant(client, 'Billing Usage Unknown Plan', 'salon');
    try {
      await client.query(
        `UPDATE tenants SET subscription_plan = 'enterprise-gold' WHERE tenant_id = $1`,
        [weird]
      );
      await insertSession(weird, {});
      const cap = await evaluateUsageCap(client, weird);
      expect(cap.freeTierApplied).toBe(true);
      expect(cap.limit).toBe(1);
      expect(cap.blocked).toBe(true);
      expect(cap.status).not.toBe('unlimited');
    } finally {
      await client.query(`DELETE FROM voice_sessions WHERE tenant_id = $1`, [weird]);
      await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [weird]);
      if (prevFree === undefined) delete process.env.PLAN_CAP_FREE;
      else process.env.PLAN_CAP_FREE = prevFree;
    }
  });

  it('C2: soft-delete of billable sessions does not drop the meter', async (ctx) => {
    // WHO: Solo owner at/near cap deleting this month's answered calls.
    // WHAT: used stays after is_deleted=true (metering ignores soft-delete).
    // WHY: owner delete must not be a billing-integrity bypass.
    skipIfDbDown(ctx, () => dbAvailable);
    const prev = process.env.PLAN_CAP_SOLO;
    process.env.PLAN_CAP_SOLO = '2';
    const delTenant = await createTenant(client, 'Billing Usage SoftDelete Meter', 'salon');
    try {
      await client.query(`UPDATE tenants SET subscription_plan = 'solo' WHERE tenant_id = $1`, [
        delTenant,
      ]);
      await client.query(
        `INSERT INTO voice_sessions (tenant_id, call_id, status, started_at, duration_seconds, transcript)
         SELECT $1, 'softdel-cap-' || g, 'completed', now(), 60,
                'Assistant: hello' || E'\n' || 'Caller: booking please'
           FROM generate_series(1, 2) g`,
        [delTenant]
      );
      const before = await evaluateUsageCap(client, delTenant);
      expect(before.used).toBe(2);
      expect(before.blocked).toBe(true);

      await client.query(
        `UPDATE voice_sessions SET is_deleted = true, deleted_at = now()
          WHERE tenant_id = $1`,
        [delTenant]
      );
      const after = await evaluateUsageCap(client, delTenant);
      expect(after.used).toBe(2);
      expect(after.blocked).toBe(true);
    } finally {
      await client.query(`DELETE FROM voice_sessions WHERE tenant_id = $1`, [delTenant]);
      await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [delTenant]);
      if (prev === undefined) delete process.env.PLAN_CAP_SOLO;
      else process.env.PLAN_CAP_SOLO = prev;
    }
  });

  it('C3: active in-flight sessions count toward cap (TOCTOU reserve)', async (ctx) => {
    // WHO: concurrent starts when used = limit - 1 completed.
    // WHAT: one active session fills the last slot → further starts blocked.
    // WHY: completed-only counting allowed N concurrent overshoots.
    skipIfDbDown(ctx, () => dbAvailable);
    const prev = process.env.PLAN_CAP_SOLO;
    process.env.PLAN_CAP_SOLO = '2';
    const raceTenant = await createTenant(client, 'Billing Usage Race Cap', 'salon');
    try {
      await client.query(`UPDATE tenants SET subscription_plan = 'solo' WHERE tenant_id = $1`, [
        raceTenant,
      ]);
      await client.query(
        `INSERT INTO voice_sessions (tenant_id, call_id, status, started_at, duration_seconds, transcript)
         VALUES ($1, 'race-completed-1', 'completed', now(), 60,
                 'Assistant: hello' || E'\n' || 'Caller: booking please')`,
        [raceTenant]
      );
      await client.query(
        `INSERT INTO voice_sessions (tenant_id, call_id, status, started_at, duration_seconds, transcript)
         VALUES ($1, 'race-active-1', 'active', now(), NULL, NULL)`,
        [raceTenant]
      );
      const cap = await evaluateUsageCap(client, raceTenant);
      expect(cap.used).toBe(2);
      expect(cap.limit).toBe(2);
      expect(cap.blocked).toBe(true);
    } finally {
      await client.query(`DELETE FROM voice_sessions WHERE tenant_id = $1`, [raceTenant]);
      await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [raceTenant]);
      if (prev === undefined) delete process.env.PLAN_CAP_SOLO;
      else process.env.PLAN_CAP_SOLO = prev;
    }
  });
});
