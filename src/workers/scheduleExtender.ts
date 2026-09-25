/**
 * Schedule Extender
 *
 * Keeps every employee's calendar topped up to a rolling horizon so a business
 * never silently becomes unbookable.
 *
 * WHY (a real call, 2026-07-12): `employee_schedule` holds one row per DATE, not
 * a recurring rule. The Setup wizard fans a weekly grid into ~4 weeks of rows and
 * discards the pattern, so a tenant's bookable window shrinks by a day, every
 * day. Thinking Hammer's ran out on 2026-08-19 — a caller asked for Wednesday
 * Aug 26, inside the owner's normal Mon–Fri 1–5, and the booking RPC correctly
 * said EMPLOYEE_NOT_SCHEDULED because no row existed. The caller heard "no one is
 * scheduled that day" and concluded the business had no staff. The old design
 * assumed owners would press "copy week" forever. They won't.
 *
 * Mirrors reminderScheduler / voiceSessionReaper's start/stop/interval shape —
 * EXCEPT that it must NOT run cross-tenant like they do. It iterates tenants and
 * runs inside tenant context, because `employees` has a tenant-isolation RLS
 * policy and NO admin bypass: a context-free sweep sees zero employee rows and
 * silently extends nothing while reporting success. (`employee_schedule` DOES
 * have an admin bypass — that asymmetry is the trap, and it is what the first
 * draft of this worker fell into.) Do not "simplify" this back to one statement.
 *
 * Usage:
 *   startScheduleExtender(); // begin
 *   stopScheduleExtender();  // graceful shutdown
 */

import { getPool, createWithTenantClient } from '../database/index.js';
import { errorsTotal } from '../services/metrics.js';
import { extendSchedules, DEFAULT_HORIZON_DAYS } from '../services/extendSchedules.js';

// Daily. The horizon recedes by exactly one day per day, so one top-up per day is
// all the work there is — any faster and every extra run is an idempotent no-op
// (ON CONFLICT DO NOTHING against a fully-covered horizon) that burns a query and
// tells you nothing.
//
// A missed day is harmless: the horizon is 180 days out, the tick runs once at
// BOOT (so a Railway deploy re-runs it immediately), and the target range starts
// at CURRENT_DATE — so a run that was skipped for a week simply backfills the
// whole gap on the next pass. There is no drift to accumulate.
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const HORIZON_DAYS = Number(process.env.SCHEDULE_HORIZON_DAYS) || DEFAULT_HORIZON_DAYS;

let extenderInterval: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Top up every tenant's active employees once. Returns rows inserted across all
 * tenants. Exported for tests / manual trigger.
 *
 * Iterates tenants and runs each inside tenant context, rather than one
 * cross-tenant sweep. That is FORCED BY RLS, not a preference: `employees` has a
 * tenant-isolation policy and NO admin bypass, so a context-free worker sees zero
 * employee rows and would silently extend nothing. (`employee_schedule` does have
 * an admin bypass — the asymmetry is the trap.) See extendSchedules.ts.
 *
 * One tenant's failure must not stop the others: a single bad tenant should not
 * mean every other business quietly stops being bookable.
 */
export async function extendSchedulesNow(
  horizonDays: number = HORIZON_DAYS
): Promise<{ rowsInserted: number; tenantsFailed: number }> {
  const pool = getPool();
  const withTenantClient = createWithTenantClient(pool);

  // `tenants` HAS an admin-bypass policy, so this read is safe without context.
  // is_deleted filter: a soft-deleted business must not have its calendar kept alive
  // — it cannot be booked anyway (createWithTenantClient 404s it), so extending it
  // would be pure waste, and a resurrected-by-accident tenant would come back with a
  // suspiciously fresh schedule.
  // Template businesses are read-only and have no hours to extend.
  const tenants = await pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM tenants WHERE is_deleted = false AND is_template = false'
  );

  let rowsInserted = 0;
  let tenantsFailed = 0;

  for (const { tenant_id } of tenants.rows) {
    try {
      const result = await withTenantClient(tenant_id, (client) =>
        extendSchedules(client, { horizonDays })
      );
      rowsInserted += result.rowsInserted;
    } catch (err) {
      tenantsFailed++;
      console.error(`scheduleExtender: tenant ${tenant_id} failed to extend:`, err);
    }
  }

  return { rowsInserted, tenantsFailed };
}

async function tick(horizonDays: number): Promise<void> {
  if (isRunning) return; // skip overlapping ticks
  isRunning = true;
  try {
    const { rowsInserted, tenantsFailed } = await extendSchedulesNow(horizonDays);
    if (tenantsFailed > 0) {
      // A tenant that can't be extended will quietly become unbookable — the exact
      // failure this worker exists to prevent. Never let it pass silently.
      errorsTotal.inc({ event: 'schedule_extender_tenant_failed' });
      console.warn(`⚠️ scheduleExtender: ${tenantsFailed} tenant(s) failed to extend`);
    }
    if (rowsInserted > 0) {
      // INFO, not WARN: inserting rows is the normal steady state (the horizon
      // recedes daily, so each run adds roughly a day's worth). It's only worth
      // a line so the log shows the calendar is being kept alive.
      console.log(
        `📅 scheduleExtender: added ${rowsInserted} shift row(s) — schedules topped up to ${horizonDays} days out`
      );
    }
  } catch (err) {
    // A failure here is silent-but-lethal: the calendar quietly stops growing and
    // the business becomes unbookable weeks later, with the AI telling every
    // caller "no one is scheduled." Bump the counter so it survives log
    // truncation and can be alerted on.
    errorsTotal.inc({ event: 'schedule_extender_failed' });
    console.error('scheduleExtender tick failed:', err);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the extender. Runs once immediately (so a lapsed schedule is repaired at
 * boot, not a day later), then daily.
 */
export function startScheduleExtender(
  intervalMs: number = DEFAULT_INTERVAL_MS,
  horizonDays: number = HORIZON_DAYS
): void {
  if (extenderInterval) {
    console.warn('⚠️ scheduleExtender is already running');
    return;
  }
  console.log(
    `🚀 Starting scheduleExtender (interval: ${intervalMs}ms, horizon: ${horizonDays} days)`
  );
  void tick(horizonDays);
  extenderInterval = setInterval(() => {
    void tick(horizonDays);
  }, intervalMs);
}

/** Stop the extender (graceful shutdown). */
export function stopScheduleExtender(): void {
  if (extenderInterval) {
    clearInterval(extenderInterval);
    extenderInterval = null;
    console.log('🛑 scheduleExtender stopped');
  }
}
