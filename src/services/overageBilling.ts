/**
 * Month-end overage billing: turn the "calls past your allowance" figure the usage statement already
 * computes into a charge on the customer's next Stripe invoice.
 *
 * A paid plan includes N answered calls a month and bills every call past it at the plan's rate
 * (src/services/billingUsage.ts). The statement shows that figure to the owner; this is what actually
 * charges it, as a Stripe invoice item that rides the customer's next subscription invoice.
 *
 * EXACTLY ONCE is the whole point of the shape:
 *   1. CLAIM the (tenant, month) in `overage_charges` as 'pending' (INSERT .. ON CONFLICT DO NOTHING).
 *   2. Call Stripe with an idempotency key.
 *   3. Mark the row 'created' with the Stripe invoice item id.
 * The ledger, not Stripe's 24-hour idempotency memory, is what makes a retry safe: a 'created' row is
 * never charged again; a 'pending' row (a crash or a Stripe error between 1 and 3) is retried with the
 * AMOUNT FROM THE LEDGER, never a recomputed one, so a call that lands late cannot change what the
 * customer was first told. The charge can be delayed, never lost and never doubled.
 *
 * MUST NOT be run inside a caller's transaction: the claim has to commit before Stripe is called,
 * otherwise a rollback after a successful charge would forget it. (createWithTenantClient does not
 * open a transaction, so the statements here each commit on their own.)
 *
 * Only a month that has CLOSED (UTC) is billed, only for an `active` paid subscription, and never for
 * template, tutorial or deleted tenants.
 */
import type { Pool, PoolClient } from 'pg';
import { computeUsageStatements, resolvePlanQuota } from './billingUsage';
import { errorsTotal } from './metrics';
import type { StripeGateway } from './stripe/gateway';

type Queryable = Pool | PoolClient;

/** How many closed months back a run will catch up on (covers the worker having been off). */
export const OVERAGE_CATCH_UP_MONTHS = 3;

export type OverageOutcome =
  | { month: string; outcome: 'created'; amountCents: number; invoiceItemId: string }
  | { month: string; outcome: 'already_billed'; amountCents: number }
  | { month: string; outcome: 'no_overage' }
  | { month: string; outcome: 'failed'; amountCents: number; error: string };

export interface TenantOverageResult {
  /** Why the tenant was not looked at at all; undefined when it was. */
  skipped?:
    | 'not_found'
    | 'deleted'
    | 'template'
    | 'tutorial'
    | 'not_active'
    | 'no_customer'
    | 'plan_not_billable';
  months: OverageOutcome[];
}

export function overageIdempotencyKey(tenantId: string, month: string): string {
  return `overage-${tenantId}-${month}`;
}

/** UTC 'YYYY-MM' of the month containing `now`. */
function monthOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

function describeCharge(
  month: string,
  plan: string,
  overageCalls: number,
  included: number,
  rateUsd: number
): string {
  return (
    `Overage: ${overageCalls} answered call${overageCalls === 1 ? '' : 's'} over the ${included} ` +
    `included in ${month} (${plan} plan, $${rateUsd.toFixed(2)} each)`
  );
}

export async function billTenantOverage(
  db: Queryable,
  gateway: StripeGateway,
  tenantId: string,
  now: Date = new Date()
): Promise<TenantOverageResult> {
  const tenantRes = await db.query<{
    subscription_plan: string | null;
    subscription_status: string | null;
    stripe_customer_id: string | null;
    is_deleted: boolean;
    is_template: boolean;
    is_tutorial: boolean;
  }>(
    `SELECT subscription_plan, subscription_status, stripe_customer_id,
            is_deleted, is_template, is_tutorial
       FROM tenants WHERE tenant_id = $1`,
    [tenantId]
  );
  const tenant = tenantRes.rows[0];
  if (!tenant) return { skipped: 'not_found', months: [] };
  if (tenant.is_deleted) return { skipped: 'deleted', months: [] };
  if (tenant.is_template) return { skipped: 'template', months: [] };
  if (tenant.is_tutorial) return { skipped: 'tutorial', months: [] };
  // past_due is not billed further (it would only grow a debt the customer is not paying);
  // a canceled customer has no next invoice for an invoice item to ride.
  if (tenant.subscription_status !== 'active') return { skipped: 'not_active', months: [] };
  if (!tenant.stripe_customer_id) return { skipped: 'no_customer', months: [] };

  const quota = resolvePlanQuota(tenant.subscription_plan);
  const rate = quota?.overagePerCallUsd ?? null;
  if (!quota || rate === null || quota.includedCalls === null) {
    return { skipped: 'plan_not_billable', months: [] };
  }

  const current = monthOf(now);
  const statements = await computeUsageStatements(db, tenantId, OVERAGE_CATCH_UP_MONTHS + 1);
  const closed = statements.statements.filter((s) => s.month < current);

  const months: OverageOutcome[] = [];
  for (const statement of closed) {
    const calls = statement.overageCalls ?? 0;
    const usd = statement.overageChargeUsd ?? 0;
    const cents = Math.round(usd * 100);

    // Is it already in the ledger? (The ledger is authoritative over a fresh computation.)
    const claimed = await db.query<{ status: string }>(
      `INSERT INTO overage_charges (tenant_id, month, overage_calls, amount_cents)
       SELECT $1::uuid, $2::text, $3::int, $4::int WHERE $3::int > 0 AND $4::int > 0
       ON CONFLICT (tenant_id, month) DO NOTHING
       RETURNING status`,
      [tenantId, statement.month, calls, cents]
    );

    let billedCalls = calls;
    let billedCents = cents;
    if (claimed.rows.length === 0) {
      const existing = await db.query<{
        status: string;
        overage_calls: number;
        amount_cents: number;
      }>(
        `SELECT status, overage_calls, amount_cents FROM overage_charges
          WHERE tenant_id = $1 AND month = $2`,
        [tenantId, statement.month]
      );
      const row = existing.rows[0];
      if (!row) {
        // Nothing to claim and nothing on the ledger: this month had no overage.
        months.push({ month: statement.month, outcome: 'no_overage' });
        continue;
      }
      if (row.status === 'created') {
        months.push({
          month: statement.month,
          outcome: 'already_billed',
          amountCents: row.amount_cents,
        });
        continue;
      }
      // 'pending': a previous attempt claimed it and did not finish. Retry with the LEDGER's figures.
      billedCalls = row.overage_calls;
      billedCents = row.amount_cents;
    }

    try {
      const item = await gateway.invoiceItems.create(
        {
          customer: tenant.stripe_customer_id,
          amount: billedCents,
          currency: 'usd',
          description: describeCharge(
            statement.month,
            tenant.subscription_plan as string,
            billedCalls,
            quota.includedCalls,
            rate
          ),
          metadata: {
            tenant_id: tenantId,
            month: statement.month,
            overage_calls: String(billedCalls),
          },
        },
        { idempotencyKey: overageIdempotencyKey(tenantId, statement.month) }
      );
      await db.query(
        `UPDATE overage_charges
            SET status = 'created', stripe_invoice_item_id = $3, updated_at = now()
          WHERE tenant_id = $1 AND month = $2 AND status = 'pending'`,
        [tenantId, statement.month, item.id]
      );
      months.push({
        month: statement.month,
        outcome: 'created',
        amountCents: billedCents,
        invoiceItemId: item.id,
      });
    } catch (err) {
      // Leave the row 'pending': the next run retries it. Never swallow it silently.
      errorsTotal.inc({ event: 'overage_charge_failed' });
      months.push({
        month: statement.month,
        outcome: 'failed',
        amountCents: billedCents,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { months };
}
