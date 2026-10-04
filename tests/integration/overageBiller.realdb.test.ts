/**
 * The overage biller's daily pass, against a real database and the Stripe mock.
 *
 * WHO: the platform, once a day | WHAT: bill every active paid tenant's unbilled closed months, once |
 * WHERE: src/workers/overageBiller.ts | WHY: it moves money, so it is OFF unless asked for, bills only
 * who it should, and one tenant's trouble never stops or doubles anyone else's charge.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type Client, Pool } from 'pg';
import { API_DB_URL, getRootClient, createTenant, skipIfDbDown } from '../utils';
import {
  billOverageNow,
  overageBillingEnabled,
  overageIntervalMs,
  selectOverageCandidates,
  startOverageBiller,
  stopOverageBiller,
  isOverageBillerRunning,
  OVERAGE_BILLER_BOUNDS,
  OVERAGE_BILLER_LOCK_KEY,
} from '../../src/workers/overageBiller';
import { MockStripe } from '../../src/services/stripe/mockStripe';

let setup: Client;
let pool: Pool;
let dbAvailable = false;
const mock = new MockStripe();
const tenants: string[] = [];

async function newTenant(
  opts: { plan?: string | null; status?: string; customer?: boolean; tutorial?: boolean } = {}
) {
  const id = await createTenant(
    setup,
    `Biller ${Math.random().toString(36).slice(2, 8)}`,
    'auto-shop'
  );
  tenants.push(id);
  const customer = opts.customer === false ? null : (await mock.customers.create({})).id;
  await setup.query(
    `UPDATE tenants SET subscription_plan = $2, subscription_status = $3, stripe_customer_id = $4,
            is_tutorial = $5, tutorial_expires_at = CASE WHEN $5 THEN now() + interval '30 minutes' END
      WHERE tenant_id = $1`,
    [
      id,
      opts.plan === undefined ? 'solo' : opts.plan,
      opts.status ?? 'active',
      customer,
      opts.tutorial ?? false,
    ]
  );
  return { id, customer: customer as string };
}

async function addCalls(tenantId: string, n: number) {
  await setup.query(
    `INSERT INTO voice_sessions (tenant_id, call_id, caller_phone, status, started_at, ended_at, duration_seconds, transcript)
     SELECT $1, 'ob-' || gen_random_uuid(), '+15551230000', 'completed',
            (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month') AT TIME ZONE 'UTC' + interval '2 days' + make_interval(secs => g),
            (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month') AT TIME ZONE 'UTC' + interval '2 days' + make_interval(secs => g + 60),
            60, E'Assistant [0:00]: Hello\\nCaller [0:04]: Hi there'
       FROM generate_series(1, $2::int) g`,
    [tenantId, n]
  );
}

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});
afterAll(async () => {
  stopOverageBiller();
  if (!dbAvailable) return;
  for (const id of tenants)
    await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
  await setup.end();
  await pool.end();
});
beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

describe('the on/off switch', () => {
  it('SAD: it is OFF unless ENABLE_OVERAGE_BILLING is exactly "true", production included', () => {
    expect(overageBillingEnabled({})).toBe(false);
    expect(overageBillingEnabled({ ENABLE_OVERAGE_BILLING: 'false' })).toBe(false);
    expect(overageBillingEnabled({ ENABLE_OVERAGE_BILLING: '1' })).toBe(false);
    expect(overageBillingEnabled({ ENABLE_OVERAGE_BILLING: 'TRUE' })).toBe(false);
    expect(overageBillingEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(overageBillingEnabled({ ENABLE_OVERAGE_BILLING: 'true' })).toBe(true);
  });

  it('HAPPY: the interval defaults to a day and is clamped to [1h, 7d]', () => {
    expect(overageIntervalMs({})).toBe(OVERAGE_BILLER_BOUNDS.fallback);
    expect(overageIntervalMs({ OVERAGE_BILLER_INTERVAL_MS: 'abc' })).toBe(
      OVERAGE_BILLER_BOUNDS.fallback
    );
    expect(overageIntervalMs({ OVERAGE_BILLER_INTERVAL_MS: '-5' })).toBe(
      OVERAGE_BILLER_BOUNDS.fallback
    );
    expect(overageIntervalMs({ OVERAGE_BILLER_INTERVAL_MS: '1000' })).toBe(
      OVERAGE_BILLER_BOUNDS.min
    );
    expect(overageIntervalMs({ OVERAGE_BILLER_INTERVAL_MS: '999999999999' })).toBe(
      OVERAGE_BILLER_BOUNDS.max
    );
    expect(overageIntervalMs({ OVERAGE_BILLER_INTERVAL_MS: '7200000' })).toBe(7_200_000);
  });

  it('HAPPY: start and stop are idempotent, and start does not charge at boot', () => {
    expect(isOverageBillerRunning()).toBe(false);
    startOverageBiller(OVERAGE_BILLER_BOUNDS.min);
    startOverageBiller(OVERAGE_BILLER_BOUNDS.min); // second start is a no-op
    expect(isOverageBillerRunning()).toBe(true);
    stopOverageBiller();
    stopOverageBiller();
    expect(isOverageBillerRunning()).toBe(false);
  });
});

describe('a billing pass', () => {
  it('HAPPY: bills exactly the eligible tenants, once, and a second pass bills nothing', async () => {
    const owes = await newTenant();
    await addCalls(owes.id, 33); // 3 over, $3.00
    const growth = await newTenant({ plan: 'growth' });
    await addCalls(growth.id, 102); // 2 over x $0.75 = $1.50
    const within = await newTenant();
    await addCalls(within.id, 12);
    const canceled = await newTenant({ status: 'canceled' });
    await addCalls(canceled.id, 40);
    const tutorial = await newTenant({ tutorial: true });
    await addCalls(tutorial.id, 40);
    const noCustomer = await newTenant({ customer: false });
    await addCalls(noCustomer.id, 40);
    const free = await newTenant({ plan: null });
    await addCalls(free.id, 90);

    const candidates = await selectOverageCandidates(pool);
    for (const t of [owes, growth, within]) expect(candidates).toContain(t.id);
    for (const t of [canceled, tutorial, noCustomer, free]) expect(candidates).not.toContain(t.id);

    const first = await billOverageNow({ pool, gateway: mock, skipLock: true });
    expect(first.failed).toBe(0);
    expect(first.created).toBeGreaterThanOrEqual(2);
    expect(mock.getInvoiceItems(owes.customer).map((i) => i.amount)).toEqual([300]);
    expect(mock.getInvoiceItems(growth.customer).map((i) => i.amount)).toEqual([150]);
    for (const t of [within, canceled, tutorial]) {
      expect(mock.getInvoiceItems(t.customer ?? '')).toHaveLength(0);
    }

    const second = await billOverageNow({ pool, gateway: mock, skipLock: true });
    expect(second.created).toBe(0);
    expect(second.alreadyBilled).toBeGreaterThanOrEqual(2);
    expect(mock.getInvoiceItems(owes.customer)).toHaveLength(1);
    expect(mock.getInvoiceItems(growth.customer)).toHaveLength(1);
  });

  it("REGRESSION: one tenant's Stripe failure does not stop or double anyone else's charge", async () => {
    const bad = await newTenant();
    await addCalls(bad.id, 35);
    const good = await newTenant();
    await addCalls(good.id, 34);

    const flaky = {
      ...mock,
      invoiceItems: {
        create: (p: { customer: string }, o?: { idempotencyKey?: string }) =>
          p.customer === bad.customer
            ? Promise.reject(new Error('card_error'))
            : mock.invoiceItems.create(p, o),
      },
    } as unknown as MockStripe;

    const res = await billOverageNow({ pool, gateway: flaky, skipLock: true });
    expect(res.failed).toBeGreaterThanOrEqual(1);
    expect(mock.getInvoiceItems(bad.customer)).toHaveLength(0);
    expect(mock.getInvoiceItems(good.customer).map((i) => i.amount)).toEqual([400]);

    // Next pass with Stripe healthy: the failed tenant is charged now, the good one is not charged again.
    await billOverageNow({ pool, gateway: mock, skipLock: true });
    expect(mock.getInvoiceItems(bad.customer).map((i) => i.amount)).toEqual([500]);
    expect(mock.getInvoiceItems(good.customer)).toHaveLength(1);
  });

  it('SAD: with billing not configured it does nothing and says so', async () => {
    const t = await newTenant();
    await addCalls(t.id, 40);
    const res = await billOverageNow({ pool, gateway: null, skipLock: true });
    expect(res).toMatchObject({ skippedNoStripe: true, created: 0 });
    expect(mock.getInvoiceItems(t.customer)).toHaveLength(0);
  });

  it('HAPPY: only one replica bills at a time (the advisory lock)', async () => {
    const holder = await pool.connect();
    try {
      const got = await holder.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
        OVERAGE_BILLER_LOCK_KEY,
      ]);
      expect(got.rows[0].ok).toBe(true);
      const t = await newTenant();
      await addCalls(t.id, 40);
      const res = await billOverageNow({ pool, gateway: mock });
      expect(res.skippedLock).toBe(true);
      expect(mock.getInvoiceItems(t.customer)).toHaveLength(0);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [OVERAGE_BILLER_LOCK_KEY]);
      holder.release();
    }
    // Lock released: the same pass now runs.
    const after = await billOverageNow({ pool, gateway: mock });
    expect(after.skippedLock).toBeUndefined();
  });
});
