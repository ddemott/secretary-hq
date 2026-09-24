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
    expect(m.overageChargeUsd).toBe(0);
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

  it('C1: null-plan tenant under soft-cap gets free-tier quota (finite, never overage-billed)', async (ctx) => {
    // WHO: inactive/beta tenant with subscription_plan NULL.
    // WHAT: free-tier finite includedCalls; no overage charges.
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
    expect(res.quota!.overagePerCallUsd).toBeNull();
    expect(m.overageCalls).toBeNull();
    expect(m.overageChargeUsd).toBeNull();
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


describe('billingUsage — per-call overage', () => {
  async function seedLastMonth(tid: string, answered: number) {
    const lastMonth = new Date();
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    lastMonth.setUTCDate(3);
    await client.query(
      `INSERT INTO voice_sessions (tenant_id, call_id, status, started_at, duration_seconds, transcript)
       SELECT $1, 'overage-test-' || g, 'completed', $2::timestamptz, 60,
              'Assistant: hello' || E'\n' || 'Caller: booking please'
         FROM generate_series(1, $3) g`,
      [tid, lastMonth.toISOString(), answered]
    );
  }

  it('HAPPY: each answered call past the allowance bills at the plan rate', async (ctx) => {
    // WHO: a solo (tier 1) tenant who goes 31 calls over the allowance.
    // WHAT: overageCalls = 31, overageChargeUsd = 31 × $1.00 — per call, no packs.
    // WHEN: last month's answered calls exceed includedCalls (env Solo cap 50).
    // WHERE: computeUsageStatements() overage math.
    // WHY: owner decision 2026-09-24 — tier 1 bills $1.00 per extra call; the old
    //      model rounded up to $25 packs of 30, which overcharged a 1-call overage.
    skipIfDbDown(ctx, () => dbAvailable);
    const prev = process.env.PLAN_CAP_SOLO;
    process.env.PLAN_CAP_SOLO = '50';
    const overTenant = await createTenant(client, 'Billing Usage Overage Tenant', 'salon');
    try {
      await client.query(`UPDATE tenants SET subscription_plan = 'solo' WHERE tenant_id = $1`, [overTenant]);
      await seedLastMonth(overTenant, 81);

      const res = await computeUsageStatements(pool, overTenant, 3);
      const m = res.statements.find((s) => !s.inProgress && s.answeredCalls === 81);
      expect(m).toBeDefined();
      expect(m!.overageCalls).toBe(31);
      expect(m!.overageChargeUsd).toBe(31);
      expect(m!.inProgress).toBe(false);
    } finally {
      await client.query(`DELETE FROM voice_sessions WHERE tenant_id = $1`, [overTenant]);
      await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [overTenant]);
      if (prev === undefined) delete process.env.PLAN_CAP_SOLO;
      else process.env.PLAN_CAP_SOLO = prev;
    }
  });

  it('HAPPY: the charge is rounded to cents on the total (3 × $0.60 = $1.80)', async (ctx) => {
    // WHO: a professional (tier 3) tenant 3 calls over.
    // WHAT: overageChargeUsd is exactly 1.8, not 1.7999999999999998.
    // WHEN: rate 0.6 × 3 overage calls — a product that is inexact in binary floats.
    // WHERE: computeUsageStatements() overage math.
    // WHY: a statement that shows $1.7999999999999998 reads as a billing bug.
    skipIfDbDown(ctx, () => dbAvailable);
    const prev = process.env.PLAN_CAP_PROFESSIONAL;
    process.env.PLAN_CAP_PROFESSIONAL = '5';
    const proTenant = await createTenant(client, 'Billing Usage Rounding Tenant', 'salon');
    try {
      await client.query(
        `UPDATE tenants SET subscription_plan = 'professional' WHERE tenant_id = $1`,
        [proTenant]
      );
      await seedLastMonth(proTenant, 8);

      const res = await computeUsageStatements(pool, proTenant, 3);
      const m = res.statements.find((s) => !s.inProgress && s.answeredCalls === 8);
      expect(m).toBeDefined();
      expect(m!.overageCalls).toBe(3);
      expect(m!.overageChargeUsd).toBe(1.8);
    } finally {
      await client.query(`DELETE FROM voice_sessions WHERE tenant_id = $1`, [proTenant]);
      await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [proTenant]);
      if (prev === undefined) delete process.env.PLAN_CAP_PROFESSIONAL;
      else process.env.PLAN_CAP_PROFESSIONAL = prev;
    }
  });
});

describe('billingUsage — soft cap evaluation', () => {
  it('REGRESSION: a paid Solo tenant at its allowance keeps answering (overage, not blocked)', async (ctx) => {
    // WHO: Solo tenant whose allowance is used up, with a caller on the line.
    // WHAT: cap.status 'overage', cap.blocked false — the next call is answered and billed.
    // WHEN: answeredCallsThisMonth === includedCalls (env-capped to 3 for speed).
    // WHERE: evaluateUsageCap(), which both voice-session-start gates consult.
    // WHY: before this, status was 'blocked' and the gate told the business's own
    //      customer "we're at capacity, try again next month". Owner ruled that out
    //      2026-09-24: paid plans bill per extra call instead.
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
      expect(cap.status).toBe('overage');
      expect(cap.blocked).toBe(false);
      expect(cap.percent).toBe(100);
    } finally {
      await client.query(`DELETE FROM voice_sessions WHERE tenant_id = $1`, [capTenant]);
      await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [capTenant]);
      if (prev === undefined) delete process.env.PLAN_CAP_SOLO;
      else process.env.PLAN_CAP_SOLO = prev;
    }
  });

  it('HAPPY: professional plan past its allowance reports overage and never blocks', async (ctx) => {
    // WHO: tier-3 tenant beyond its allowance (env-capped to 1 for speed).
    // WHAT: status 'overage', blocked false.
    // WHY: tier 3 is no longer unlimited (300 calls) but, like every paid tier,
    //      never refuses a call.
    skipIfDbDown(ctx, () => dbAvailable);
    const prev = process.env.PLAN_CAP_PROFESSIONAL;
    process.env.PLAN_CAP_PROFESSIONAL = '1';
    const proTenant = await createTenant(client, 'Billing Usage Pro Tenant', 'salon');
    try {
      await client.query(
        `UPDATE tenants SET subscription_plan = 'professional' WHERE tenant_id = $1`,
        [proTenant]
      );
      await insertSession(proTenant, {});
      await insertSession(proTenant, {});
      const cap = await evaluateUsageCap(client, proTenant);
      expect(cap.limit).toBe(1);
      expect(cap.used).toBe(2);
      expect(cap.status).toBe('overage');
      expect(cap.blocked).toBe(false);
    } finally {
      await client.query(`DELETE FROM voice_sessions WHERE tenant_id = $1`, [proTenant]);
      await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [proTenant]);
      if (prev === undefined) delete process.env.PLAN_CAP_PROFESSIONAL;
      else process.env.PLAN_CAP_PROFESSIONAL = prev;
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
    // WHY: owner delete must not be a billing-integrity bypass — it would erase
    //      billable overage calls from the statement.
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
      expect(before.status).toBe('overage');

      await client.query(
        `UPDATE voice_sessions SET is_deleted = true, deleted_at = now()
          WHERE tenant_id = $1`,
        [delTenant]
      );
      const after = await evaluateUsageCap(client, delTenant);
      expect(after.used).toBe(2);
      expect(after.status).toBe('overage');
    } finally {
      await client.query(`DELETE FROM voice_sessions WHERE tenant_id = $1`, [delTenant]);
      await client.query(`DELETE FROM tenants WHERE tenant_id = $1`, [delTenant]);
      if (prev === undefined) delete process.env.PLAN_CAP_SOLO;
      else process.env.PLAN_CAP_SOLO = prev;
    }
  });

  it('C3: active in-flight sessions count toward cap (TOCTOU reserve)', async (ctx) => {
    // WHO: concurrent starts on a free-tier (no plan) tenant when used = limit - 1.
    // WHAT: one active session fills the last slot → further starts blocked.
    // WHY: completed-only counting allowed N concurrent overshoots. Only the free
    //      tier still blocks, so that is where the reservation matters.
    skipIfDbDown(ctx, () => dbAvailable);
    const prev = process.env.PLAN_CAP_FREE;
    process.env.PLAN_CAP_FREE = '2';
    const raceTenant = await createTenant(client, 'Billing Usage Race Cap', 'salon');
    try {
      await client.query(`UPDATE tenants SET subscription_plan = NULL WHERE tenant_id = $1`, [
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
      if (prev === undefined) delete process.env.PLAN_CAP_FREE;
      else process.env.PLAN_CAP_FREE = prev;
    }
  });
});
