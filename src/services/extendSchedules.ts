/**
 * Rolling schedule extension — keep every employee's calendar topped up so a
 * business never silently becomes unbookable.
 *
 * THE BUG THIS EXISTS TO KILL (found on a real call, 2026-07-12):
 *
 * `employee_schedule` stores one concrete row per DATE. It does not store a
 * rule. The Setup wizard collects a weekly grid ("Mon–Fri, 1–5"), fans it out
 * into ~4 weeks of individual rows via expandWeeklyToSchedule(), and then throws
 * the pattern away. Nothing in the database knows the owner works Wednesdays —
 * there are just rows, and then the calendar stops.
 *
 * So a tenant's bookable window SHRINKS BY ONE DAY, EVERY DAY. Thinking Hammer's
 * ran out on 2026-08-19: a caller asked for Wednesday Aug 26 — a normal weekday
 * inside the owner's normal 1–5 hours — and the booking RPC correctly answered
 * EMPLOYEE_NOT_SCHEDULED, because no row existed. To the caller, the AI sounded
 * like it was speaking for a company with no staff. The design assumed owners
 * would extend forward with the Schedule tab's "copy week" button. Nobody did,
 * and nobody would.
 *
 * WHAT THIS DOES: for each active employee, read the pattern from the LAST WEEK
 * of their existing schedule and repeat it forward until the horizon is covered.
 *
 * Why the last WEEK rather than "the most recent row for each weekday": if an
 * owner stops working Wednesdays, the last Wednesday row still sits in the past.
 * Keying off the most recent occurrence per weekday would resurrect it forever.
 * The tail week is the closest thing we have to a statement of current intent —
 * if there is no Wednesday in it, we don't invent one.
 *
 * SAFETY: purely additive. ON CONFLICT DO NOTHING against the
 * (tenant_id, employee_id, shift_date) PK means an existing row — including a
 * day the owner explicitly marked OFF (is_off = true) — is never touched. A day
 * off stays off. Re-running changes nothing.
 */
import type { PoolClient } from 'pg';

/**
 * How far ahead every employee should be bookable.
 *
 * 180 rather than 90 deliberately: 90 days IS "three months", so a caller asking
 * for "the first week of November" in mid-July would land exactly on the boundary
 * and be refused — the same "no one is scheduled" dead end this service exists to
 * kill, just moved further out. Rows are tiny and the insert is idempotent, so
 * headroom is nearly free. Override with SCHEDULE_HORIZON_DAYS.
 */
export const DEFAULT_HORIZON_DAYS = 180;

/** Never project a pattern further than this in one pass (sanity bound). */
const MAX_HORIZON_DAYS = 365;

export interface ExtendResult {
  rowsInserted: number;
}

/**
 * Top up ONE tenant's active employees to `horizonDays` from today, by repeating
 * the final week of each employee's existing pattern.
 *
 * MUST be called with tenant context set (i.e. inside withTenantClient). It is
 * NOT safe as a cross-tenant sweep, and that is not a style preference — it is
 * enforced by RLS, in an asymmetric way that will bite anyone who assumes
 * otherwise:
 *
 *   employee_schedule  → HAS an admin-bypass policy (visible with no tenant ctx)
 *   employees          → tenant-isolation ONLY (INVISIBLE with no tenant ctx)
 *
 * The first draft of this ran cross-tenant like the reminder sweep, joined
 * `employees` to filter out inactive staff, silently saw zero employee rows, and
 * inserted nothing at all. The real-DB test caught it; a mock never would have.
 *
 * One statement per tenant, so it can't half-apply.
 */
export async function extendSchedules(
  client: PoolClient,
  opts: { horizonDays?: number } = {}
): Promise<ExtendResult> {
  const horizon = Math.min(
    Math.max(Math.round(opts.horizonDays ?? DEFAULT_HORIZON_DAYS), 1),
    MAX_HORIZON_DAYS
  );

  const res = await client.query(
    `
    WITH pattern AS (
      -- Interim heuristic from TODO: derive per-(employee, dow) from most recent row in [CURRENT_DATE - 28, CURRENT_DATE + 14]. Immune to far-future one-off and extender's own output. No self-referential, no over-scheduling, no breaking Saturday-only owners.
      SELECT DISTINCT ON (es.tenant_id, es.employee_id, EXTRACT(DOW FROM es.shift_date))
             es.tenant_id,
             es.employee_id,
             EXTRACT(DOW FROM es.shift_date)::int AS dow,
             es.start_time,
             es.end_time
        FROM employee_schedule es
        JOIN employees e
          ON e.employee_id = es.employee_id
         AND e.tenant_id = es.tenant_id
         AND (e.is_active IS NULL OR e.is_active = true)
       WHERE es.is_off IS NOT TRUE
         AND es.shift_date >= CURRENT_DATE - INTERVAL '28 days'
         AND es.shift_date <= CURRENT_DATE + INTERVAL '14 days'
       ORDER BY es.tenant_id, es.employee_id, EXTRACT(DOW FROM es.shift_date), es.shift_date DESC
    ),
    target_days AS (
      SELECT d::date AS shift_date
        FROM generate_series(CURRENT_DATE, CURRENT_DATE + ($1::int - 1), INTERVAL '1 day') d
    )
    INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
    SELECT p.tenant_id, p.employee_id, t.shift_date, p.start_time, p.end_time, false
      FROM pattern p
      JOIN target_days t
        ON EXTRACT(DOW FROM t.shift_date)::int = p.dow
    ON CONFLICT (tenant_id, employee_id, shift_date) DO NOTHING
    `,
    [horizon]
  );

  return { rowsInserted: res.rowCount ?? 0 };
}
