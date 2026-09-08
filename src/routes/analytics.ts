import type { AppFastifyInstance } from '../types/fastify';
import type { Pool, PoolClient } from 'pg';
import {
  withHandler,
  logEvent,
  requireTenantId,
  requireSuperAdmin,
  withPoolClient,
  type AppRequest,
} from '../middleware/fastify-middleware';
import { queryInSeries } from '../database/index';
import { parseDateRange } from './routeHelpers';
import { getAiCostBreakdown } from '../services/analytics/aiCost';
import { getCohortAnalytics } from '../services/analytics/cohorts';
import { getUtilizationCells } from '../services/analytics/utilization';
import {
  resolveCoverageWindow,
  findDraftGraphProblem,
  previewCoverageForDraft,
} from '../services/analytics/coveragePreview';
import { CoverageDryRunSchema, optionalDateBounds } from '../services/analytics/dateBounds';

export function registerAnalyticsRoutes(
  app: AppFastifyInstance,
  pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  // Top-line stats for the dashboard Home + Analytics views. Returns the
  // AnalyticsStats shape (dashboard/lib/types.ts) directly (not the
  // {success,result} envelope) — apiFetch<AnalyticsStats> consumes it raw.
  // Registered at the full path '/analytics/stats' because these analytics
  // routes are mounted without an '/analytics' prefix (coverage/feedback are
  // root-level), but the dashboard calls '/analytics/stats'.
  app.get(
    '/analytics/stats',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const stats = await withTenantClient(tenantId, async (client) => {
        const [calls, appts, custs, activity] = await queryInSeries(
          () =>
            client.query<{ total: number; today: number; week: number }>(
              `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE started_at >= date_trunc('day', now()))::int AS today,
                    count(*) FILTER (WHERE started_at >= now() - interval '7 days')::int AS week
             FROM voice_sessions WHERE tenant_id = $1 AND is_deleted = false`,
              [tenantId]
            ),
          () =>
            client.query<{ total: number; today: number; week: number; upcoming: number }>(
              `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE start_time >= date_trunc('day', now())
                                       AND start_time < date_trunc('day', now()) + interval '1 day')::int AS today,
                    count(*) FILTER (WHERE start_time >= now() - interval '7 days')::int AS week,
                    count(*) FILTER (WHERE start_time >= now())::int AS upcoming
             FROM appointments WHERE tenant_id = $1 AND is_deleted = false`,
              [tenantId]
            ),
          () =>
            client.query<{ total: number; new_this_week: number }>(
              `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS new_this_week
             FROM customers WHERE tenant_id = $1 AND is_deleted = false`,
              [tenantId]
            ),
          () =>
            client.query<{ type: string; description: string; timestamp: string }>(
              `(SELECT 'appointment' AS type,
                     'Appointment booked: ' || coalesce(description, 'appointment') AS description,
                     created_at AS timestamp
              FROM appointments WHERE tenant_id = $1 AND is_deleted = false
              ORDER BY created_at DESC LIMIT 10)
             UNION ALL
             (SELECT 'call', 'Call from ' || coalesce(caller_phone, 'unknown'), created_at
              FROM voice_sessions WHERE tenant_id = $1 AND is_deleted = false
              ORDER BY created_at DESC LIMIT 10)
             UNION ALL
             (SELECT 'customer', 'New customer: ' || coalesce(name, 'unknown'), created_at
              FROM customers WHERE tenant_id = $1 AND is_deleted = false
              ORDER BY created_at DESC LIMIT 10)
             ORDER BY timestamp DESC LIMIT 15`,
              [tenantId]
            )
        );

        return {
          calls: calls.rows[0] ?? { total: 0, today: 0, week: 0 },
          appointments: appts.rows[0] ?? { total: 0, today: 0, week: 0, upcoming: 0 },
          customers: custs.rows[0] ?? { total: 0, new_this_week: 0 },
          recent_activity: activity.rows,
        };
      });

      return reply.send(stats);
    }, 'Failed to load analytics stats')
  );

  // Call-analytics cut for the Analytics view: outcome breakdown (the "why")
  // + per-day call volume with a booked count. Built entirely from
  // voice_sessions — "booked" is keyed on appointment_id IS NOT NULL (the hard
  // signal), NOT the freeform `outcome` text. The dashboard derives conversion
  // (booked/total), abandonment (no_outcome share) and the volume sparkline
  // from these two arrays. Returns the AnalyticsCalls shape directly (raw, no
  // {success,result} envelope) like /analytics/stats above.
  app.get(
    '/analytics/calls',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      // Optional From/To window (YYYY-MM-DD). Absent → all-time. `end` is
      // inclusive of the whole day. byDay keeps its 30-day default ONLY when no
      // start is supplied, so the sparkline isn't blank on first load.
      const { start, end } = optionalDateBounds(req.query as Record<string, string>);

      const data = await withTenantClient(tenantId, async (client) => {
        const [byOutcome, byDay, totals] = await queryInSeries(
          // Outcome breakdown — powers Conversion, Abandonment, and the WHY cut.
          // NULL/empty outcome collapses to 'no_outcome' (an abandoned/unclassified call).
          () =>
            client.query<{ outcome: string; count: number; booked: number }>(
              `SELECT coalesce(nullif(outcome, ''), 'no_outcome') AS outcome,
                    count(*)::int AS count,
                    count(*) FILTER (WHERE appointment_id IS NOT NULL)::int AS booked
             FROM voice_sessions
             WHERE tenant_id = $1 AND is_deleted = false
               AND ($2::date IS NULL OR started_at >= $2::date)
               AND ($3::date IS NULL OR started_at < ($3::date + interval '1 day'))
             GROUP BY 1
             ORDER BY count DESC`,
              [tenantId, start, end]
            ),
          // Per-day call volume, with booked count. Lower bound: the supplied
          // start, else the last 30 days. Upper bound: the supplied end (inclusive).
          () =>
            client.query<{ day: string; total: number; booked: number }>(
              `SELECT to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day,
                    count(*)::int AS total,
                    count(*) FILTER (WHERE appointment_id IS NOT NULL)::int AS booked
             FROM voice_sessions
             WHERE tenant_id = $1 AND is_deleted = false
               AND started_at >= COALESCE($2::date, (now() - interval '30 days'))
               AND ($3::date IS NULL OR started_at < ($3::date + interval '1 day'))
             GROUP BY 1
             ORDER BY 1 ASC`,
              [tenantId, start, end]
            ),
          // Top-line totals so the dashboard never has to re-derive the denominator.
          () =>
            client.query<{ total: number; booked: number; abandoned: number }>(
              `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE appointment_id IS NOT NULL)::int AS booked,
                    count(*) FILTER (WHERE appointment_id IS NULL
                                       AND coalesce(nullif(outcome, ''), 'no_outcome') = 'no_outcome')::int AS abandoned
             FROM voice_sessions
             WHERE tenant_id = $1 AND is_deleted = false
               AND ($2::date IS NULL OR started_at >= $2::date)
               AND ($3::date IS NULL OR started_at < ($3::date + interval '1 day'))`,
              [tenantId, start, end]
            )
        );

        return {
          totals: totals.rows[0] ?? { total: 0, booked: 0, abandoned: 0 },
          by_outcome: byOutcome.rows,
          by_day: byDay.rows,
        };
      });

      return reply.send(data);
    }, 'Failed to load call analytics')
  );

  // Analytics depth: repeat-caller cohorts + bookings-by-service. Both are
  // derivable from voice_sessions today (no new column). Repeat callers are
  // grouped on the LAST 10 DIGITS of caller_phone (US-centric) so the same
  // person reaching out as "+16305559999" (E.164, with the 1 country code) and
  // "630-555-9999" (10-digit) counts once. Bookings-by-service joins booked
  // calls → appointment → service. CLV (top_customers) ranks customers by
  // lifetime booked revenue. Abandonment-by-service uses
  // voice_sessions.requested_service_id (set best-effort by the
  // book-with-scheduling agent tool) to group abandoned calls (no appointment)
  // by the service the caller was trying to book. First-time-fix
  // (first_time_fix) reports the share of distinct callers whose first call
  // ended in a booking — "resolved on first contact".
  app.get(
    '/analytics/cohorts',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      // Optional From/To window (YYYY-MM-DD). Absent → all-time. `end` is
      // inclusive of the whole day. Voice queries filter on started_at; the
      // revenue (top-customers) query filters on the appointment's start_time.
      const bounds = optionalDateBounds(req.query as Record<string, string>);

      const data = await withTenantClient(tenantId, (client) =>
        getCohortAnalytics(client, tenantId, bounds)
      );

      logEvent(req, 'analytics_cohorts_viewed', { tenantId });
      return reply.send(data);
    }, 'Failed to load cohort analytics')
  );

  // Utilization heatmap (GAPS §6) — weekday × hour grid of staffed capacity vs
  // booked time, powering the dashboard's Utilization panel. For each
  // (dow 0-6, hour 0-23) cell that has ANY staffed capacity in the window:
  //   staffed_minutes — summed employee-minutes from employee_schedule shifts
  //                     (is_off = false) overlapping that hour-of-day
  //   booked_minutes  — summed appointment-minutes overlapping that hour.
  //                     Occupancy statuses: 'scheduled' (the only status the
  //                     booking RPCs treat as blocking a slot) plus 'completed'
  //                     (past appointments that DID consume staffed time —
  //                     excluding them would make history look artificially
  //                     open). 'canceled' and soft-deleted rows are excluded,
  //                     matching the RPCs' occupancy predicate.
  // Hours with zero staffed capacity are omitted (utilization is undefined
  // there — the UI renders them as unstaffed, not as 0%).
  //
  // Cross-midnight night shifts (start_time > end_time) follow the
  // book_with_scheduling_atomic() semantics (see the night-shift OR-branch in
  // 20260430000002_drop_employee_shifts.sql): a row dated D covers day D's
  // wrap-around window — [00:00, end_time) and [start_time, 24:00) — because a
  // 1am booking on day D is validated against day D's night-shift row (the RPC
  // matches shift_date = the booking's local date, then
  // `v_start_tod >= start OR v_end_tod <= end`). So the night shift is split
  // into those two same-day segments, both attributed to D's weekday.
  //
  // All times are tenant-local (tenants.timezone, like the booking RPCs):
  // shift times are already local; appointment timestamptz values are
  // converted via AT TIME ZONE before bucketing, so "Tuesday 2pm" means the
  // tenant's 2pm. Optional From/To window via optionalDateBounds (same
  // contract as /analytics/calls + /analytics/cohorts); absent bounds default
  // to the LAST 28 DAYS (not all-time — four full weeks keeps every weekday
  // equally represented so no day looks artificially busy).
  app.get(
    '/analytics/utilization',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const bounds = optionalDateBounds(req.query as Record<string, string>);
      const cells = await withTenantClient(tenantId, (client) =>
        getUtilizationCells(client, tenantId, bounds)
      );

      logEvent(req, 'analytics_utilization_viewed', { tenantId });
      return reply.send({ cells });
    }, 'Failed to load utilization analytics')
  );

  // Coverage gap detection — returns per-service coverage status for a date range
  app.get(
    '/coverage',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { startDate, endDate } = parseDateRange(req.query as Record<string, string>);

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `SELECT service_id, service_name, check_date, gap_hours, covered_hours,
                total_open_hours, coverage_pct, status, details
         FROM check_coverage_gaps($1, $2::DATE, $3::DATE)`,
          [tenantId, startDate, endDate]
        );
      });
      return reply.send(res.rows);
    }, 'Failed to check coverage gaps')
  );

  // POST /coverage/dry-run — coverage for a DRAFT graph that isn't in the DB yet
  // (setup-wizard Phase B holds services/employees/shifts/mappings in local state
  // and commits only on Done). We reuse the real check_coverage_gaps RPC as the
  // single source of truth by inserting the draft inside a transaction, running
  // the RPC, and ALWAYS rolling back — nothing is ever persisted. Coverage rows
  // come back keyed on the ephemeral service_id created here, so the client
  // matches them to its draft services by NAME.
  app.post(
    '/coverage/dry-run',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = CoverageDryRunSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const draft = parsed.data;
      const window = resolveCoverageWindow(draft);

      // An inverted window makes generate_series() return no rows, which reads
      // as "no gaps" — refuse it rather than answer misleadingly.
      if (window.endDate < window.startDate) {
        return reply
          .status(400)
          .send({ success: false, error: 'end_date must be on or after start_date' });
      }

      const problem = findDraftGraphProblem(draft);
      if (problem) {
        return reply.status(400).send({ success: false, ...problem });
      }

      const rows = await withTenantClient(tenantId, (client) =>
        previewCoverageForDraft(client, tenantId, draft, window)
      );

      logEvent(req, 'coverage_dry_run', {
        services: draft.services.length,
        employees: draft.employees.length,
        shifts: draft.shifts.length,
      });
      return reply.send(rows);
    }, 'Failed to preview coverage')
  );

  // GET /coverage/staffing was removed 2026-04-30 along with the
  // employee_shifts table (historical major refactor; see RESOLVED.md, originally tracked as NEEDS-REFACTORING #4 Phase 2). It joined on
  // weekly patterns to answer "for this day-of-week, who works?" — a
  // question that no longer has a stable answer now that the platform
  // only stores date-specific schedule entries. The dashboard never
  // called it. If we ever need a reframed version it should take a
  // date and read employee_schedule.

  app.get(
    '/call-summaries',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      const customerId = (req.query as { customer_id?: string }).customer_id;
      if (!customerId) {
        return reply.status(400).send({ success: false, error: 'customer_id is required' });
      }

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `SELECT cs.*, ct.created_at as call_timestamp, ct.raw_text IS NOT NULL as has_transcript
         FROM call_summaries cs
         LEFT JOIN call_transcripts ct ON ct.call_id = cs.call_id
         WHERE cs.tenant_id = $1 AND cs.customer_id = $2
         ORDER BY cs.created_at DESC`,
          [tenantId, customerId]
        );
      });
      return reply.send(res.rows);
    }, 'Failed to fetch call summaries')
  );

  // User feedback — contextual feedback from any page
  app.post(
    '/feedback',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      const userId = req.auth?.user_id;

      const body = req.body as { page: string; context?: string; comment: string; rating?: number };
      if (!body.page || !body.comment) {
        return reply.status(400).send({ success: false, error: 'page and comment are required' });
      }

      await withTenantClient(tenantId, async (client) => {
        await client.query(
          `INSERT INTO user_feedback (tenant_id, user_id, page, context, comment, rating)
         VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            tenantId,
            userId || null,
            body.page,
            body.context || null,
            body.comment,
            body.rating || null,
          ]
        );
      });

      logEvent(req, 'feedback_submitted', { page: body.page, rating: body.rating });
      return reply.send({ success: true });
    }, 'Failed to submit feedback')
  );

  // Admin: list all feedback (super-admin sees all tenants, regular user sees own)
  app.get(
    '/feedback',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const isSuperAdmin = tenantId === '00000000-0000-0000-0000-000000000000';

      if (isSuperAdmin) {
        // Super admin sees ALL feedback across all tenants
        return withPoolClient(pool, async (client) => {
          const res = await client.query(
            `SELECT f.*, u.full_name as user_name, t.name as tenant_name
           FROM user_feedback f
           LEFT JOIN users u ON u.user_id = f.user_id
           LEFT JOIN tenants t ON t.tenant_id = f.tenant_id
           ORDER BY f.created_at DESC
           LIMIT 200`
          );
          return reply.send(res.rows);
        });
      }

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `SELECT f.*, u.full_name as user_name
         FROM user_feedback f
         LEFT JOIN users u ON u.user_id = f.user_id
         WHERE f.tenant_id = $1
         ORDER BY f.created_at DESC
         LIMIT 100`,
          [tenantId]
        );
      });
      return reply.send(res.rows);
    }, 'Failed to fetch feedback')
  );

  // GET /analytics/ai-cost — month-to-date AI usage aggregated by provider +
  // model, plus the per-call figures (T-011).
  //
  // SUPER-ADMIN ONLY, enforced HERE (review catch on #394). This is the
  // platform's cost-of-goods: what a call costs us, and therefore the margin on
  // what the tenant pays. `AnalyticsView` renders the panel only for an admin,
  // but a UI gate is a rendering decision, not an authorization one — the route
  // is reachable with any tenant's own JWT, so before this check a customer
  // could read their own margin math with one curl. The same mistake shape as
  // every "we don't show it" control: the data still went over the wire.
  app.get(
    '/analytics/ai-cost',
    withHandler(async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      const result = await withTenantClient(tenantId, (client) =>
        getAiCostBreakdown(client, tenantId)
      );
      return reply.send(result);
    }, 'Failed to load AI cost data')
  );
}
