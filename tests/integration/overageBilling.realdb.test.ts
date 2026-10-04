/**
 * Month-end overage billing, against a real database and the Stripe mock.
 *
 * WHO: a paid owner whose line answered more calls than the plan includes | WHAT: the overage
 * becomes ONE invoice item on their next Stripe invoice | WHEN: after the month closes |
 * WHERE: src/services/overageBilling.ts + the overage_charges ledger | WHY: charging money has to be
 * exactly once, whatever retries, restarts or Stripe errors happen in between.
 *
 * The service runs as the app's RLS-scoped role (api_user) through createWithTenantClient, like the
 * worker does, so the ledger's row-level security is exercised too.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type Client, Pool } from 'pg';
import { API_DB_URL, getRootClient, createTenant, skipIfDbDown } from '../utils';
import { createWithTenantClient } from '../../src/database';
import { billTenantOverage, overageIdempotencyKey } from '../../src/services/overageBilling';
import { MockStripe } from '../../src/services/stripe/mockStripe';
import { errorsTotal } from '../../src/services/metrics';

let setup: Client;
let pool: Pool;
let withTenant: ReturnType<typeof createWithTenantClient>;
let dbAvailable = false;
const mock = new MockStripe(); // one for the file, so customer ids stay unique across tenants
const tenants: string[] = [];

/** 'YYYY-MM' of the UTC month `back` months before now. */
function monthBack(back: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
}

async function newTenant(
  opts: {
    plan?: string | null;
    status?: string;
    customer?: boolean;
    tutorial?: boolean;
  } = {}
) {
  const id = await createTenant(
    setup,
    `Overage ${Math.random().toString(36).slice(2, 8)}`,
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
  return { id, customer };
}

/** `n` answered (billable) calls in the UTC month `back` months ago. */
async function addCalls(tenantId: string, n: number, back = 1) {
  await setup.query(
    `INSERT INTO voice_sessions (tenant_id, call_id, caller_phone, status, started_at, ended_at, duration_seconds, transcript)
     SELECT $1, 'ov-' || gen_random_uuid(), '+15551230000', 'completed',
            (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => $2::int)) AT TIME ZONE 'UTC' + interval '2 days' + make_interval(secs => g),
            (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => $2::int)) AT TIME ZONE 'UTC' + interval '2 days' + make_interval(secs => g + 60),
            60,
            E'Assistant [0:00]: Hello\\nCaller [0:04]: Hi there'
       FROM generate_series(1, $3::int) g`,
    [tenantId, back, n]
  );
}

const run = (tenantId: string, gateway = mock) =>
  withTenant(tenantId, (db) => billTenantOverage(db, gateway, tenantId));

const ledger = (tenantId: string) =>
  setup.query(
    'SELECT month, overage_calls, amount_cents, status, stripe_invoice_item_id FROM overage_charges WHERE tenant_id = $1 ORDER BY month',
    [tenantId]
  );

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });
    withTenant = createWithTenantClient(pool);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});
afterAll(async () => {
  if (!dbAvailable) return;
  for (const id of tenants) {
    await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
  }
  await setup.end();
  await pool.end();
});
beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

describe('billing a closed month', () => {
  it('HAPPY: calls past the allowance become one invoice item for exactly the overage', async () => {
    // Solo: 30 included, $1.00 each over. 33 answered calls = 3 over = $3.00 = 300 cents.
    const t = await newTenant();
    await addCalls(t.id, 33);
    const res = await run(t.id);

    const month = monthBack(1);
    expect(res.skipped).toBeUndefined();
    expect(res.months).toEqual([
      {
        month,
        outcome: 'created',
        amountCents: 300,
        invoiceItemId: expect.stringMatching(/^ii_mock_/),
      },
    ]);
    const items = mock.getInvoiceItems(t.customer as string);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ amount: 300, currency: 'usd' });
    expect(items[0].description).toContain('3 answered calls over the 30 included');
    expect(items[0].description).toContain(`in ${month} (solo plan, $1.00 each)`);
    expect(items[0].metadata).toEqual({ tenant_id: t.id, month, overage_calls: '3' });

    const rows = (await ledger(t.id)).rows;
    expect(rows).toEqual([
      {
        month,
        overage_calls: 3,
        amount_cents: 300,
        status: 'created',
        stripe_invoice_item_id: items[0].id,
      },
    ]);
  });

  it('REGRESSION: running again charges NOTHING more (the ledger remembers, not Stripe)', async () => {
    // Stripe forgets idempotency keys after ~24h; only our own ledger makes a late retry safe.
    const t = await newTenant();
    await addCalls(t.id, 35);
    await run(t.id);
    const second = await run(t.id);
    expect(second.months).toEqual([
      { month: monthBack(1), outcome: 'already_billed', amountCents: 500 },
    ]);
    expect(mock.getInvoiceItems(t.customer as string)).toHaveLength(1);
  });

  it('HAPPY: a different plan bills at its own rate (growth: 100 included, $0.75 each)', async () => {
    const t = await newTenant({ plan: 'growth' });
    await addCalls(t.id, 104);
    const res = await run(t.id);
    expect(res.months[0]).toMatchObject({ outcome: 'created', amountCents: 300 }); // 4 x $0.75
  });

  it('HAPPY: exactly at the allowance, or under it, bills nothing and writes no ledger row', async () => {
    const t = await newTenant();
    await addCalls(t.id, 30);
    const res = await run(t.id);
    expect(res.months.every((m) => m.outcome === 'no_overage')).toBe(true);
    expect((await ledger(t.id)).rows).toHaveLength(0);
    expect(mock.getInvoiceItems(t.customer as string)).toHaveLength(0);
  });

  it('HAPPY: the current month is never billed (it is still open)', async () => {
    const t = await newTenant();
    await addCalls(t.id, 40, 0);
    const res = await run(t.id);
    expect(res.months).toEqual([]);
    expect(mock.getInvoiceItems(t.customer as string)).toHaveLength(0);
  });

  it('HAPPY: an earlier unbilled month is caught up (the biller having been off is not a lost month)', async () => {
    const t = await newTenant();
    await addCalls(t.id, 32, 1);
    await addCalls(t.id, 31, 2);
    const res = await run(t.id);
    expect(res.months.map((m) => [m.month, m.outcome])).toEqual([
      [monthBack(1), 'created'],
      [monthBack(2), 'created'],
    ]);
    expect(
      mock
        .getInvoiceItems(t.customer as string)
        .map((i) => i.amount)
        .sort()
    ).toEqual([100, 200]);
  });
});

describe('who is billed', () => {
  it.each([
    ['canceled', 'canceled'],
    ['past_due', 'past_due'],
    ['inactive', 'inactive'],
  ])('SAD: a %s subscription is not billed overage', async (_label, status) => {
    const t = await newTenant({ status });
    await addCalls(t.id, 40);
    const res = await run(t.id);
    expect(res.skipped).toBe('not_active');
    expect(mock.getInvoiceItems(t.customer as string)).toHaveLength(0);
    expect((await ledger(t.id)).rows).toHaveLength(0);
  });

  it('SAD: no Stripe customer, a free/unknown plan, and a tutorial tenant are skipped', async () => {
    const noCustomer = await newTenant({ customer: false });
    await addCalls(noCustomer.id, 40);
    expect((await run(noCustomer.id)).skipped).toBe('no_customer');

    const free = await newTenant({ plan: null });
    await addCalls(free.id, 80);
    expect((await run(free.id)).skipped).toBe('plan_not_billable');

    const tutorial = await newTenant({ tutorial: true });
    await addCalls(tutorial.id, 40);
    expect((await run(tutorial.id)).skipped).toBe('tutorial');
    expect(mock.getInvoiceItems(tutorial.customer as string)).toHaveLength(0);
  });

  it('SAD: a deleted tenant and an unknown tenant are skipped', async () => {
    const t = await newTenant();
    await addCalls(t.id, 40);
    await setup.query('UPDATE tenants SET is_deleted = true WHERE tenant_id = $1', [t.id]);
    // withTenantClient already refuses a deleted tenant; the service must hold the line on its own too.
    const direct = await billTenantOverage(pool, mock, t.id);
    expect(direct.skipped).toBe('deleted');
    expect(mock.getInvoiceItems(t.customer as string)).toHaveLength(0);
    expect(
      (await billTenantOverage(pool, mock, '00000000-0000-4000-8000-0000000000ff')).skipped
    ).toBe('not_found');
  });
});

describe('exactly once, whatever goes wrong', () => {
  it('REGRESSION: a Stripe error leaves the charge pending, and the retry uses the LEDGER amount', async () => {
    // The customer was first told 3 calls / $3.00. Two more calls landing late must not change it.
    const t = await newTenant();
    await addCalls(t.id, 33);
    const failing = {
      ...mock,
      invoiceItems: { create: () => Promise.reject(new Error('stripe down')) },
    } as unknown as MockStripe;

    const before =
      errorsTotal.snapshot().find((s) => s.labels.event === 'overage_charge_failed')?.value ?? 0;
    const first = await run(t.id, failing);
    expect(first.months[0]).toMatchObject({
      outcome: 'failed',
      amountCents: 300,
      error: 'stripe down',
    });
    const after =
      errorsTotal.snapshot().find((s) => s.labels.event === 'overage_charge_failed')?.value ?? 0;
    expect(after).toBe(before + 1); // never silent

    expect((await ledger(t.id)).rows).toEqual([
      {
        month: monthBack(1),
        overage_calls: 3,
        amount_cents: 300,
        status: 'pending',
        stripe_invoice_item_id: null,
      },
    ]);
    expect(mock.getInvoiceItems(t.customer as string)).toHaveLength(0);

    await addCalls(t.id, 2, 1); // the statement now says 5 over...
    const retry = await run(t.id);
    // ...but the customer is charged what the ledger first said.
    expect(retry.months[0]).toMatchObject({ outcome: 'created', amountCents: 300 });
    expect(mock.getInvoiceItems(t.customer as string)).toHaveLength(1);
    expect((await ledger(t.id)).rows[0]).toMatchObject({
      status: 'created',
      overage_calls: 3,
      amount_cents: 300,
    });
  });

  it('REGRESSION: Stripe succeeded but we crashed before marking it created — the retry does NOT charge twice', async () => {
    const t = await newTenant();
    await addCalls(t.id, 33);
    const month = monthBack(1);
    // The earlier attempt: Stripe took the charge, then the process died before the UPDATE.
    const orphan = await mock.invoiceItems.create(
      { customer: t.customer as string, amount: 300, currency: 'usd' },
      { idempotencyKey: overageIdempotencyKey(t.id, month) }
    );
    await setup.query(
      `INSERT INTO overage_charges (tenant_id, month, overage_calls, amount_cents) VALUES ($1, $2, 3, 300)`,
      [t.id, month]
    );

    const res = await run(t.id);
    expect(res.months[0]).toMatchObject({ outcome: 'created', invoiceItemId: orphan.id });
    expect(mock.getInvoiceItems(t.customer as string)).toHaveLength(1); // still ONE charge
    expect((await ledger(t.id)).rows[0]).toMatchObject({
      status: 'created',
      stripe_invoice_item_id: orphan.id,
    });
  });

  it('HAPPY: the idempotency key sent to Stripe is stable per tenant and month', async () => {
    const t = await newTenant();
    await addCalls(t.id, 33);
    const seen: Array<string | undefined> = [];
    const spy = {
      ...mock,
      invoiceItems: {
        create: (p: never, o?: { idempotencyKey?: string }) => {
          seen.push(o?.idempotencyKey);
          return mock.invoiceItems.create(p, o);
        },
      },
    } as unknown as MockStripe;
    await run(t.id, spy);
    expect(seen).toEqual([overageIdempotencyKey(t.id, monthBack(1))]);
    expect(overageIdempotencyKey('t', '2026-09')).toBe('overage-t-2026-09');
  });
});

describe('the ledger table', () => {
  it("SAD: row-level security keeps one tenant from seeing another tenant's charges", async () => {
    const a = await newTenant();
    const b = await newTenant();
    await addCalls(a.id, 33);
    await run(a.id);
    const seenByB = await withTenant(b.id, (db) =>
      db.query('SELECT count(*)::int AS n FROM overage_charges')
    );
    expect(seenByB.rows[0].n).toBe(0);
    const seenByA = await withTenant(a.id, (db) =>
      db.query('SELECT count(*)::int AS n FROM overage_charges')
    );
    expect(seenByA.rows[0].n).toBe(1);
  });

  it('SAD: the database itself refuses an inconsistent or non-positive row', async () => {
    const t = await newTenant();
    const insert = (
      month: string,
      calls: number,
      cents: number,
      status: string,
      item: string | null
    ) =>
      setup.query(
        `INSERT INTO overage_charges (tenant_id, month, overage_calls, amount_cents, status, stripe_invoice_item_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [t.id, month, calls, cents, status, item]
      );
    await expect(insert('2026-09', 3, 300, 'created', null)).rejects.toThrow(/item_matches_status/);
    await expect(insert('2026-09', 3, 300, 'pending', 'ii_x')).rejects.toThrow(
      /item_matches_status/
    );
    await expect(insert('2026-09', 0, 300, 'pending', null)).rejects.toThrow(/positive/);
    await expect(insert('2026-09', 3, 0, 'pending', null)).rejects.toThrow(/positive/);
    await expect(insert('2026-13', 3, 300, 'pending', null)).rejects.toThrow(/month_format/);
    // An unknown status trips both the status list and the status/item pairing; either is a refusal.
    await expect(insert('2026-09', 3, 300, 'refunded', null)).rejects.toThrow(
      /violates check constraint/
    );
    await insert('2026-09', 3, 300, 'pending', null);
    await expect(insert('2026-09', 4, 400, 'pending', null)).rejects.toThrow(/duplicate key|pkey/);
  });
});
