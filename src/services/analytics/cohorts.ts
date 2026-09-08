/**
 * Cohort analytics: repeat callers, per-service mix, top customers by revenue,
 * abandonment, and first-call-fix rate.
 *
 * Extracted from src/routes/analytics.ts (2026-08-21). Six independent queries,
 * run one after another through `queryInSeries`.
 *
 * THEY USED TO SAY "concurrently through Promise.all", AND THAT WAS NEVER TRUE.
 * All six share ONE pg client, and node-postgres serialises statements on a
 * single client no matter how they are launched — so `Promise.all` bought no
 * concurrency at all, it only started every query before the previous one had
 * finished, which is the state pg deprecates and removes in pg@9
 * ("Calling client.query() when the client is already executing a query").
 * Serialising them costs nothing that was ever actually being saved.
 *
 * THE PHONE NORMALIZATION IS NOT COSMETIC. Callers are identified by the LAST
 * TEN DIGITS (`right(regexp_replace(caller_phone, '[^0-9]', '', 'g'), 10)`),
 * because the same person reaches the line as +1 630 822 9086, 6308229086 and
 * (630) 822-9086 depending on carrier and handset. Compare raw strings instead
 * and one caller becomes three cohorts — the report then says nobody ever calls
 * back, which is the opposite of what it exists to measure.
 *
 * Every aggregate falls back to a zero-filled shape rather than null: the
 * dashboard renders these numbers directly, so a null is a crash on a page with
 * no data — which is exactly the state a brand-new tenant is in.
 */
import type { PoolClient } from 'pg';

import { queryInSeries } from '../../database/index';

export async function getCohortAnalytics(
  client: PoolClient,
  tenantId: string,
  bounds: { start: string | null; end: string | null }
) {
  const { start, end } = bounds;

  const [repeatCallers, byService, summary, topCustomers, abandonmentByService, firstTimeFix] =
    await queryInSeries(
      // Callers who reached out more than once, newest-activity first.
      () =>
        client.query<{
          phone: string;
          call_count: number;
          booked_count: number;
          first_call: string;
          last_call: string;
        }>(
          `SELECT right(regexp_replace(caller_phone, '[^0-9]', '', 'g'), 10) AS phone,
                  count(*)::int AS call_count,
                  count(*) FILTER (WHERE appointment_id IS NOT NULL)::int AS booked_count,
                  min(started_at) AS first_call,
                  max(started_at) AS last_call
           FROM voice_sessions
           WHERE tenant_id = $1 AND is_deleted = false
             AND right(regexp_replace(caller_phone, '[^0-9]', '', 'g'), 10) <> ''
             AND ($2::date IS NULL OR started_at >= $2::date)
             AND ($3::date IS NULL OR started_at < ($3::date + interval '1 day'))
           GROUP BY 1
           HAVING count(*) > 1
           ORDER BY last_call DESC
           LIMIT 100`,
          [tenantId, start, end]
        ),
      // Which services the booked calls actually booked.
      () =>
        client.query<{ service: string; booked_count: number }>(
          `SELECT coalesce(nullif(s.name, ''), 'Unknown service') AS service,
                  count(*)::int AS booked_count
           FROM voice_sessions v
           JOIN appointments a ON a.appointment_id = v.appointment_id
           LEFT JOIN services s ON s.service_id = a.service_id
           WHERE v.tenant_id = $1 AND v.is_deleted = false
             AND ($2::date IS NULL OR v.started_at >= $2::date)
             AND ($3::date IS NULL OR v.started_at < ($3::date + interval '1 day'))
           GROUP BY 1
           ORDER BY booked_count DESC`,
          [tenantId, start, end]
        ),
      // Top-line: how many distinct callers, how many are repeat, and how
      // much of total call volume comes from repeat callers.
      () =>
        client.query<{
          distinct_callers: number;
          repeat_callers: number;
          repeat_call_volume: number;
          total_calls: number;
        }>(
          `WITH per_caller AS (
             SELECT right(regexp_replace(caller_phone, '[^0-9]', '', 'g'), 10) AS phone,
                    count(*)::int AS c
             FROM voice_sessions
             WHERE tenant_id = $1 AND is_deleted = false
               AND right(regexp_replace(caller_phone, '[^0-9]', '', 'g'), 10) <> ''
               AND ($2::date IS NULL OR started_at >= $2::date)
               AND ($3::date IS NULL OR started_at < ($3::date + interval '1 day'))
             GROUP BY 1
           )
           SELECT count(*)::int AS distinct_callers,
                  count(*) FILTER (WHERE c > 1)::int AS repeat_callers,
                  coalesce(sum(c) FILTER (WHERE c > 1), 0)::int AS repeat_call_volume,
                  coalesce(sum(c), 0)::int AS total_calls
           FROM per_caller`,
          [tenantId, start, end]
        ),
      // Customer lifetime value: top customers by total booked revenue
      // (sum of each appointment's service price). services.price defaults
      // to 0, so a tenant that hasn't priced services sees visits with $0 —
      // still a useful "who books most" ranking. ::float8 so JSON gets a
      // number, not a Postgres numeric string.
      () =>
        client.query<{
          customer_id: string;
          name: string;
          visits: number;
          revenue: number;
        }>(
          `SELECT c.customer_id,
                  coalesce(nullif(c.name, ''), 'Unknown') AS name,
                  count(a.appointment_id)::int AS visits,
                  coalesce(sum(s.price), 0)::float8 AS revenue
           FROM appointments a
           JOIN customers c ON c.customer_id = a.customer_id
           LEFT JOIN services s ON s.service_id = a.service_id
           WHERE a.tenant_id = $1 AND a.is_deleted = false AND c.is_deleted = false
             AND ($2::date IS NULL OR a.start_time >= $2::date)
             AND ($3::date IS NULL OR a.start_time < ($3::date + interval '1 day'))
           GROUP BY c.customer_id, c.name
           ORDER BY revenue DESC, visits DESC
           LIMIT 20`,
          [tenantId, start, end]
        ),
      // Abandonment-by-service: calls that did NOT book (appointment_id NULL)
      // but recorded a requested_service_id (the caller tried to book that
      // service). Surfaces "what are we losing callers over". Depends on the
      // book-with-scheduling capture writing requested_service_id.
      //
      // FORWARD-COMPATIBLE: this is the ONLY query that reads the
      // voice_sessions.requested_service_id column added by migration
      // 20260622010000. If a deploy lands before that migration is applied
      // (as happened on prod), the column is missing and this query throws
      // — which, without the .catch below, would reject the WHOLE /analytics/
      // cohorts endpoint (500 on every Analytics-tab load). The .catch
      // degrades just this one panel to empty so the rest of the cohort
      // data still renders. Once the migration is applied it returns real
      // rows. (Same "safe pre-migration" stance as the audit-extend work.)
      () =>
        client
          .query<{ service: string; abandoned_count: number }>(
            `SELECT coalesce(nullif(s.name, ''), 'Unknown service') AS service,
                  count(*)::int AS abandoned_count
           FROM voice_sessions v
           JOIN services s ON s.service_id = v.requested_service_id
           WHERE v.tenant_id = $1 AND v.is_deleted = false
             AND v.appointment_id IS NULL
             AND ($2::date IS NULL OR v.started_at >= $2::date)
             AND ($3::date IS NULL OR v.started_at < ($3::date + interval '1 day'))
           GROUP BY 1
           ORDER BY abandoned_count DESC`,
            [tenantId, start, end]
          )
          .catch((err: unknown) => {
            // Degrade ONLY for "column does not exist" (Postgres 42703) — the
            // pre-migration window where requested_service_id isn't there yet.
            // Any other failure (permissions, outage, syntax) must surface as a
            // real error via withHandler, not hide behind an empty panel.
            if (err && typeof err === 'object' && (err as { code?: string }).code === '42703') {
              return { rows: [] as { service: string; abandoned_count: number }[] };
            }
            throw err;
          }),
      // First-time-fix rate: of distinct callers (same last-10-digit phone
      // key as the other cohort cuts; NULL/empty phones excluded), how many
      // had their FIRST call end in a booking — "resolved on first contact".
      // "Booked" is the hard signal (appointment_id IS NOT NULL) OR the
      // agent's 'booked' outcome text, so a booking whose call→appointment
      // link failed to persist still counts. The From/To window bounds the
      // calls considered (same $2/$3 guards as abandonment_by_service), so
      // the "first" call is the earliest one WITHIN the window — consistent
      // with how the summary CTE treats the range. DISTINCT ON + ORDER BY
      // started_at picks each caller's earliest in-window call.
      () =>
        client.query<{ distinct_callers: number; first_call_booked: number }>(
          `WITH first_calls AS (
             SELECT DISTINCT ON (right(regexp_replace(caller_phone, '[^0-9]', '', 'g'), 10))
                    (appointment_id IS NOT NULL OR outcome = 'booked') AS first_booked
             FROM voice_sessions
             WHERE tenant_id = $1 AND is_deleted = false
               AND right(regexp_replace(caller_phone, '[^0-9]', '', 'g'), 10) <> ''
               AND ($2::date IS NULL OR started_at >= $2::date)
               AND ($3::date IS NULL OR started_at < ($3::date + interval '1 day'))
             ORDER BY right(regexp_replace(caller_phone, '[^0-9]', '', 'g'), 10),
                      started_at ASC
           )
           SELECT count(*)::int AS distinct_callers,
                  count(*) FILTER (WHERE first_booked)::int AS first_call_booked
           FROM first_calls`,
          [tenantId, start, end]
        )
    );

  // rate is null (not 0) when there are no callers — "no data" and
  // "0% first-call bookings" are different facts and must render apart.
  const ftf = firstTimeFix.rows[0] ?? { distinct_callers: 0, first_call_booked: 0 };
  return {
    repeat_callers: repeatCallers.rows,
    by_service: byService.rows,
    top_customers: topCustomers.rows,
    abandonment_by_service: abandonmentByService.rows,
    first_time_fix: {
      rate: ftf.distinct_callers > 0 ? ftf.first_call_booked / ftf.distinct_callers : null,
      first_call_booked: ftf.first_call_booked,
      distinct_callers: ftf.distinct_callers,
    },
    summary: summary.rows[0] ?? {
      distinct_callers: 0,
      repeat_callers: 0,
      repeat_call_volume: 0,
      total_calls: 0,
    },
  };
}
