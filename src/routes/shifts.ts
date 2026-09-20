/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

import type { AppFastifyInstance } from '../types/fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  withHandler,
  logEvent,
  requireTenantId,
  requireOwnerRole,
  type AppRequest,
} from '../middleware/fastify-middleware';
import { expandWeeklyToSchedule } from '../services/expandWeeklyToSchedule';
import { sendValidationError, assertRowAffected } from './routeHelpers';

/**
 * A closure is a DATE and (optionally) a reason for the owner's own eyes.
 * `YYYY-MM-DD` only — a timestamp here would invite a timezone bug into the one
 * concept that is definitionally a calendar day in the business's own locale.
 */
/**
 * Exported so tests can exercise the calendar rule directly — the guard is the
 * interesting part, and reaching it only through HTTP hides which half failed.
 */
export const BlackoutDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'blackout_date must be YYYY-MM-DD')
  // SHAPE IS NOT VALIDITY (review catch on #395). `2026-02-30` and
  // `2026-13-01` match the regex, reach `$2::date`, and Postgres raises
  // `date/time field value out of range` — a 500 the owner reads as "the app
  // is broken" rather than "that day does not exist". Round-tripping through
  // Date and comparing the ISO string back is the cheapest check that
  // actually consults the calendar: JS normalises Feb 30 to Mar 2, so the
  // strings stop matching.
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'blackout_date is not a real calendar date');

const BlackoutSchema = z.object({
  blackout_date: BlackoutDateSchema,
  reason: z.string().max(200).nullable().optional(),
});

const CreateOverrideSchema = z.object({
  tenant_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  shift_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  end_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  is_off: z.boolean().default(false),
});

const UpdateOverrideSchema = z.object({
  tenant_id: z.string().uuid(),
  start_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  end_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  is_off: z.boolean().optional(),
});

const CopyWeekSchema = z.object({
  tenant_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  source_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  target_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const WeeklyPatternRowSchema = z.object({
  day_of_week: z.number().int().min(0).max(6),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
});

const ExpandWeeklySchema = z.object({
  tenant_id: z.string().uuid(),
  employee_id: z.string().uuid(),
  pattern: z.array(WeeklyPatternRowSchema),
  weeks_ahead: z.number().int().min(1).max(52).optional(),
  // Optional anchor date (YYYY-MM-DD). If omitted, server uses "today" (UTC).
  // Tests use this for deterministic day-of-week math and to guarantee
  // the booking date falls inside the expanded coverage window.
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  // Opt-in: clear this employee's FUTURE schedule before expanding, so the
  // supplied pattern becomes the complete truth rather than being merged into
  // whatever is already there. The default (additive, ON CONFLICT DO NOTHING)
  // can only ever ADD days — which means a wizard re-run where the owner
  // UNCHECKED a day would silently leave that day on the schedule. Callers pass
  // replace only when their pattern is a full picture (i.e. they preloaded it);
  // sending it with a half-filled grid would erase the rest.
  replace: z.boolean().optional(),
});

export function registerShiftRoutes(
  app: AppFastifyInstance,
  _pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  // No legacy /shifts CRUD anymore — the wizard collects the weekly
  // pattern in form state and posts it directly to /shifts/expand-weekly.
  // The remaining endpoints all read/write employee_schedule
  // (date-specific) directly.

  // ── Employee Schedule (date-specific) ────────────────────────────

  app.get(
    '/shifts/overrides',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      const { employee_id, start_date, end_date } = req.query as Record<string, string>;

      if (employee_id && start_date && end_date) {
        // Use the RPC for merged view (single employee)
        const res = await withTenantClient(tenantId, async (client) => {
          return client.query('SELECT * FROM get_effective_shifts($1, $2, $3::DATE, $4::DATE)', [
            tenantId,
            employee_id,
            start_date,
            end_date,
          ]);
        });
        return reply.send(res.rows);
      }

      if (start_date && end_date) {
        // Bulk effective shifts for ALL employees (used by scheduler)
        const res = await withTenantClient(tenantId, async (client) => {
          return client.query('SELECT * FROM get_effective_shifts_bulk($1, $2::DATE, $3::DATE)', [
            tenantId,
            start_date,
            end_date,
          ]);
        });
        return reply.send(res.rows);
      }

      // Raw overrides list
      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          'SELECT * FROM employee_schedule WHERE tenant_id = $1 ORDER BY shift_date',
          [tenantId]
        );
      });
      return reply.send(res.rows);
    }, 'Failed to fetch shift overrides')
  );

  app.post(
    '/shifts/overrides/create',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): staffing CRUD, PR #508/TODO.md.
      if (!requireOwnerRole(req, reply)) return;
      const parsed = CreateOverrideSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const body = parsed.data;

      const res = await withTenantClient(body.tenant_id, async (client) => {
        return client.query(
          `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, employee_id, shift_date)
         DO UPDATE SET start_time = $4, end_time = $5, is_off = $6, updated_at = now()
         RETURNING *`,
          [
            body.tenant_id,
            body.employee_id,
            body.shift_date,
            body.start_time || null,
            body.end_time || null,
            body.is_off,
          ]
        );
      });

      logEvent(req, 'shift_override_created', {
        tenantId: body.tenant_id,
        employeeId: body.employee_id,
        date: body.shift_date,
      });
      return reply.send({ success: true, override: res.rows[0] });
    }, 'Failed to create shift override')
  );

  // 2026-05-18 composite-key retrofit pilot #3: the surrogate
  // `employee_schedule_id` was dropped. Both the update and delete
  // routes now take (employee_id, shift_date) as path segments and
  // derive tenant_id from JWT context via requireTenantId, matching
  // the natural-key shape of the row. Tenant_id in the body is no
  // longer consulted (was already redundant with JWT).
  app.post(
    '/shifts/overrides/:employeeId/:shiftDate/update',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): staffing CRUD, PR #508/TODO.md.
      if (!requireOwnerRole(req, reply)) return;
      const { employeeId, shiftDate } = req.params as { employeeId: string; shiftDate: string };
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = UpdateOverrideSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const body = parsed.data;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `UPDATE employee_schedule SET
          start_time = COALESCE($1, start_time), end_time = COALESCE($2, end_time),
          is_off = COALESCE($3, is_off), updated_at = now()
        WHERE tenant_id = $4 AND employee_id = $5 AND shift_date = $6 RETURNING *`,
          [body.start_time, body.end_time, body.is_off, tenantId, employeeId, shiftDate]
        );
      });
      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Override not found' });
      }

      logEvent(req, 'shift_override_updated', { tenantId, employeeId, date: shiftDate });
      return reply.send({ success: true, override: res.rows[0] });
    }, 'Failed to update shift override')
  );

  app.delete(
    '/shifts/overrides/:employeeId/:shiftDate',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): staffing CRUD, PR #508/TODO.md.
      if (!requireOwnerRole(req, reply)) return;
      const { employeeId, shiftDate } = req.params as { employeeId: string; shiftDate: string };
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `DELETE FROM employee_schedule
          WHERE tenant_id = $1 AND employee_id = $2 AND shift_date = $3
          RETURNING tenant_id`,
          [tenantId, employeeId, shiftDate]
        );
      });

      if (res.rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Override not found' });
      }

      logEvent(req, 'shift_override_deleted', { tenantId, employeeId, date: shiftDate });
      return reply.send({ success: true });
    }, 'Failed to delete shift override')
  );

  app.post(
    '/shifts/copy-week',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): staffing CRUD, PR #508/TODO.md.
      if (!requireOwnerRole(req, reply)) return;
      const parsed = CopyWeekSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const { tenant_id, employee_id, source_start, target_start } = parsed.data;

      // Get effective shifts for the source week (7 days)
      const sourceEnd = new Date(source_start);
      sourceEnd.setDate(sourceEnd.getDate() + 6);
      const sourceEndStr = sourceEnd.toISOString().slice(0, 10);

      const effective = await withTenantClient(tenant_id, async (client) => {
        return client.query('SELECT * FROM get_effective_shifts($1, $2, $3::DATE, $4::DATE)', [
          tenant_id,
          employee_id,
          source_start,
          sourceEndStr,
        ]);
      });

      // Calculate day offset between source and target week
      const srcDate = new Date(source_start);
      const tgtDate = new Date(target_start);
      const dayOffset = Math.round((tgtDate.getTime() - srcDate.getTime()) / (1000 * 60 * 60 * 24));

      // Create overrides for the target week
      let created = 0;
      await withTenantClient(tenant_id, async (client) => {
        for (const row of effective.rows) {
          const targetDate = new Date(row.shift_date);
          targetDate.setDate(targetDate.getDate() + dayOffset);
          const targetDateStr = targetDate.toISOString().slice(0, 10);

          await client.query(
            `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (tenant_id, employee_id, shift_date)
           DO UPDATE SET start_time = $4, end_time = $5, is_off = $6, updated_at = now()`,
            [tenant_id, employee_id, targetDateStr, row.start_time, row.end_time, row.is_off]
          );
          created++;
        }
      });

      logEvent(req, 'shifts_copied', {
        employeeId: employee_id,
        from: source_start,
        to: target_start,
        count: created,
      });
      return reply.send({ success: true, copied: created });
    }, 'Failed to copy week')
  );

  // POST /shifts/expand-weekly — fan out a caller-supplied weekly
  // pattern into N weeks of date-specific employee_schedule rows.
  // The setup wizard collects the weekly grid in form state and calls
  // this once at finalize. Idempotent — ON CONFLICT DO NOTHING
  // preserves any date-specific edits the owner already made.
  app.post(
    '/shifts/expand-weekly',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): staffing CRUD, PR #508/TODO.md.
      if (!requireOwnerRole(req, reply)) return;
      const parsed = ExpandWeeklySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const { tenant_id, employee_id, pattern, weeks_ahead, start_date, replace } = parsed.data;

      // Parse optional start_date (YYYY-MM-DD) into a Date (UTC midnight).
      const startDate = start_date ? new Date(`${start_date}T00:00:00Z`) : undefined;

      const result = await withTenantClient(tenant_id, async (client) => {
        if (replace) {
          // Future only — past shifts are history and must survive a re-run.
          await client.query(
            `DELETE FROM employee_schedule
              WHERE tenant_id = $1 AND employee_id = $2
                AND shift_date >= COALESCE($3::date, CURRENT_DATE)`,
            [tenant_id, employee_id, startDate ?? null]
          );
          // The declared RULE has to go with them. expandWeeklyToSchedule
          // rewrites it below for any weekday the new pattern contains, but an
          // EMPTY pattern early-returns without touching it — and `replace`
          // means this pattern is the complete truth, so an empty one means
          // "no hours". Without this the owner clears their schedule, the rows
          // go, and the extender puts the hours straight back from a rule
          // nobody can see. That is the resurrect-what-the-owner-dropped bug
          // the rule table exists to kill, arriving through the rule table.
          await client.query(
            `DELETE FROM employee_schedule_pattern
              WHERE tenant_id = $1 AND employee_id = $2`,
            [tenant_id, employee_id]
          );
        }
        return expandWeeklyToSchedule(client, {
          tenantId: tenant_id,
          employeeId: employee_id,
          pattern,
          weeksAhead: weeks_ahead,
          startDate,
        });
      });

      logEvent(req, 'shifts_expanded_weekly', {
        employeeId: employee_id,
        patternDays: pattern.length,
        weeksAhead: weeks_ahead ?? 4,
        inserted: result.inserted,
      });
      return reply.send({ success: true, ...result });
    }, 'Failed to expand weekly schedule')
  );
  // ── Blackout dates (tenant-wide closures, T-106) ─────────────────
  //
  // `employee_schedule.is_off` says one PERSON is off; this says the BUSINESS
  // is shut. Enforced in the booking RPC (BUSINESS_CLOSED) and excluded by the
  // suggester, so a closed day is neither offered nor bookable.

  app.get(
    '/shifts/blackouts',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      const { start_date, end_date } = req.query as Record<string, string | undefined>;
      const res = await withTenantClient(tenantId, (client) =>
        client.query(
          `SELECT blackout_date, reason, created_at, updated_at
             FROM blackout_dates
            WHERE tenant_id = $1
              AND ($2::date IS NULL OR blackout_date >= $2::date)
              AND ($3::date IS NULL OR blackout_date <= $3::date)
            ORDER BY blackout_date`,
          [tenantId, start_date ?? null, end_date ?? null]
        )
      );
      return reply.send(res.rows);
    }, 'Failed to fetch blackout dates')
  );

  app.post(
    '/shifts/blackouts',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): staffing CRUD, PR #508/TODO.md.
      if (!requireOwnerRole(req, reply)) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      const parsed = BlackoutSchema.safeParse(req.body);
      if (!parsed.success) {
        return sendValidationError(reply, parsed.error.issues);
      }
      const { blackout_date, reason } = parsed.data;

      // UPSERT, not INSERT. Re-declaring a closure is not an error the owner
      // should have to reason about — the second save just updates the reason.
      // The natural PK makes that a one-liner instead of a read-then-write.
      const res = await withTenantClient(tenantId, (client) =>
        client.query(
          `INSERT INTO blackout_dates (tenant_id, blackout_date, reason)
           VALUES ($1, $2::date, $3)
           ON CONFLICT (tenant_id, blackout_date)
             DO UPDATE SET reason = EXCLUDED.reason
           RETURNING blackout_date, reason`,
          [tenantId, blackout_date, reason ?? null]
        )
      );
      logEvent(req, 'blackout_date_saved', { blackout_date });
      return reply.send({ success: true, blackout: res.rows[0] });
    }, 'Failed to save blackout date')
  );

  app.delete(
    '/shifts/blackouts/:date',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): staffing CRUD, PR #508/TODO.md.
      if (!requireOwnerRole(req, reply)) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      const { date } = req.params as { date: string };
      // Same shape-plus-calendar check as the POST — the cast that would 500 is
      // identical on this path, and a guard that covers one of two doors is not
      // a guard.
      const parsedDate = BlackoutDateSchema.safeParse(date);
      if (!parsedDate.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'date must be a real calendar date in YYYY-MM-DD form' });
      }
      const res = await withTenantClient(tenantId, (client) =>
        client.query(
          'DELETE FROM blackout_dates WHERE tenant_id = $1 AND blackout_date = $2::date',
          [tenantId, date]
        )
      );
      // 404 on a zero-row delete rather than a cheerful success — the house
      // rule (assertRowAffected). "Removed a closure that was never there" is
      // the shape that lets an owner believe the business is open when it is not.
      if (!assertRowAffected(res, reply, 'Blackout date')) return;
      logEvent(req, 'blackout_date_removed', { blackout_date: date });
      return reply.send({ success: true });
    }, 'Failed to remove blackout date')
  );
}
