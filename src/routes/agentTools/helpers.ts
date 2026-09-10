/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */
/**
 * Shared helper functions for /agent-tools/* routes.
 * Extracted from agentTools.ts to keep each concern in its own file.
 *
 * Exports:
 *   ok / fail             — uniform 200 response senders
 *   parseOrFail           — Zod parse with inline fail()
 *   pgErrorFields         — structured pg error extraction
 *   bookingOutcomeFromAgentError — maps RPC error → metric label
 *   toolRoute             — POST route factory (auth + parse + metric)
 *   captureRequestedService — fire-and-forget voice_session service stamp
 *   Interval / interval math — timeToMinutes, mergeIntervals, subtractIntervals …
 */
import type { FastifyReply } from 'fastify';
import type { AppFastifyInstance } from '../../types/fastify';
import type { Pool, PoolClient } from 'pg';
import { type z } from 'zod';
import { withHandler, type AppRequest } from '../../middleware/fastify-middleware';
import { toolCallsTotal } from '../../services/metrics';

// ── Shared route-module dependencies ──────────────────────────────────

/** RLS-scoped per-request client helper handed down from src/database/index.ts. */
export type WithTenantClient = <T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
) => Promise<T>;

/**
 * The plumbing every /agent-tools/* route module needs. registerAgentToolRoutes
 * builds this once and passes it to each register*Routes() function, so a module
 * destructures only the pieces it actually uses.
 */
export interface AgentToolDeps {
  app: AppFastifyInstance;
  pool: Pool;
  withTenantClient: WithTenantClient;
  getEmbedding: (text: string) => Promise<number[]>;
  expandQueryForEmbedding?: (text: string, options?: { context?: string }) => Promise<string>;
}

// ── Response helpers ──────────────────────────────────────────────────

export function ok(reply: FastifyReply, result: unknown) {
  // _toolOutcome is read by toolRoute() after the handler returns to bump
  // tool_calls_total{outcome=...}. Both ok() and fail() send 200 (the
  // agent expects to relay both shapes naturally), so we can't distinguish
  // success vs failure from status alone.
  (reply as unknown as { _toolOutcome?: string })._toolOutcome = 'success';
  return reply.status(200).send({ success: true, result });
}

export function fail(reply: FastifyReply, message: string, status = 200) {
  (reply as unknown as { _toolOutcome?: string })._toolOutcome = 'error';
  return reply.status(status).send({ success: false, error: message });
}

// ── Booking outcome label ─────────────────────────────────────────────

/**
 * Map a booking RPC result back to the canonical outcome label used in
 * booking_attempts_total. Prefers the explicit error_code (book-with-
 * scheduling RPC sets one); falls back to keyword-matching the message
 * (book-appointment RPC returns prose only).
 */
export function bookingOutcomeFromAgentError(
  errMessage: string | null | undefined,
  errCode?: string | null
): string {
  if (errCode) {
    const c = errCode.toLowerCase();
    if (c === 'timeslot_occupied') return 'timeslot_occupied';
    if (c === 'employee_not_scheduled') return 'employee_not_scheduled';
    if (c === 'no_skilled_employee') return 'no_skilled_employee';
    if (c === 'no_availability') return 'no_availability';
    if (c === 'invalid_params') return 'validation_error';
  }
  if (!errMessage) return 'other_error';
  const m = errMessage.toLowerCase();
  if (m.includes('timeslot') || m.includes('overlap')) return 'timeslot_occupied';
  if (m.includes('not on shift') || m.includes('not_scheduled')) return 'employee_not_scheduled';
  if (m.includes('skill')) return 'no_skilled_employee';
  if (m.includes('availability')) return 'no_availability';
  if (m.includes('past')) return 'past_time';
  return 'other_error';
}

// ── Zod parse helper ──────────────────────────────────────────────────

export function parseOrFail<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    void fail(reply, `Validation failed: ${msg}`); // reply.send() returns Promise; void satisfies no-floating-promises
    return null;
  }
  return parsed.data;
}

// ── pg error fields ───────────────────────────────────────────────────

/**
 * Pull the diagnostic fields off a node-postgres error so a call-logging
 * failure names its own cause in ONE structured log line — no guessing from
 * a generic 500. `code` is the Postgres SQLSTATE (e.g. 23502 = not_null_violation,
 * 23503 = foreign_key_violation, 23505 = unique_violation); `constraint`,
 * `column`, `table`, and `detail` pinpoint exactly what the RPC rejected.
 * Origin: 2026-06-24 — the first real __PERSONA_NAME__ call never logged because
 * start_voice_session() threw on a NULL caller_phone, but the fire-and-forget
 * failure left no diagnosable trace (see feedback_sad_path_instrumentation).
 */
export function pgErrorFields(err: unknown): {
  error_message: string;
  sqlstate: string | null;
  constraint: string | null;
  column: string | null;
  table: string | null;
  detail: string | null;
} {
  const e = (err ?? {}) as {
    message?: unknown;
    code?: unknown;
    constraint?: unknown;
    column?: unknown;
    table?: unknown;
    detail?: unknown;
  };
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  // Prefer a string `message` field even when the throw isn't an Error instance
  // (some pg/driver layers throw plain objects) — otherwise String(err) yields
  // "[object Object]" and defeats the one-line-diagnosable goal.
  const error_message = err instanceof Error ? err.message : (str(e.message) ?? String(err));
  return {
    error_message,
    sqlstate: str(e.code),
    constraint: str(e.constraint),
    column: str(e.column),
    table: str(e.table),
    detail: str(e.detail),
  };
}

// ── toolRoute factory ─────────────────────────────────────────────────

/**
 * Register a POST /agent-tools/* route with schema validation.
 * Collapses the repeated `app.post + withHandler + parseOrFail` boilerplate.
 * Handler receives already-parsed args; return value is ignored (respond
 * via `ok()` / `fail()`).
 */
export function toolRoute<T>(
  app: AppFastifyInstance,
  path: string,
  schema: z.ZodType<T>,
  handler: (args: T, reply: FastifyReply) => Promise<unknown>,
  errorMessage: string
): void {
  // Strip the "/agent-tools/" prefix to derive the metric label — the
  // kebab-case ROUTE name (e.g. "book-with-scheduling"), not the snake_case
  // LLM tool name. Cardinality is bounded by the number of registered
  // agent-tools routes.
  const toolName = path.replace(/^\/agent-tools\//, '');
  app.post(
    path,
    withHandler(async (req: AppRequest, reply) => {
      const args = parseOrFail(schema, req.body, reply);
      if (!args) {
        toolCallsTotal.inc({ tool: toolName, outcome: 'validation_error' });
        return;
      }
      const result = await handler(args, reply);
      const outcome = (reply as unknown as { _toolOutcome?: string })._toolOutcome ?? 'success';
      toolCallsTotal.inc({ tool: toolName, outcome });
      return result;
    }, errorMessage)
  );
}

// ── captureRequestedService ───────────────────────────────────────────

/**
 * Best-effort, fire-and-forget: stamp the service the caller asked about onto
 * this call's `voice_session` (`requested_service_id`). Used by the booking
 * path AND the pure-availability tools, so a call that only inquired about
 * availability — never attempting a booking — still shows which service they
 * came for (powers abandonment-by-service analytics; the reaper/close finalizes
 * the session as abandoned when no appointment was booked).
 *
 * The agent passes a fuzzy service name; map it to a service_id (shortest ILIKE
 * match). COALESCE keeps any already-captured service so a later, differently-
 * worded mention can't erase the signal with NULL. Never blocks or fails the
 * call — a missing voice_session row (call_id not yet started) is a silent no-op.
 */
export function captureRequestedService(
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>,
  tenantId: string,
  callId: string | undefined,
  serviceType: string | undefined
): void {
  // Trim first (like resolveServiceForBooking) — a whitespace-only serviceType
  // would otherwise issue a useless ILIKE '%   %' write.
  const service = serviceType?.trim();
  if (!callId || !service) return;
  void withTenantClient(tenantId, (client) =>
    client.query(
      `UPDATE voice_sessions
          SET requested_service_id = COALESCE(
            (
              SELECT service_id FROM services
               WHERE tenant_id = $1 AND name ILIKE '%' || $2 || '%'
                 AND (is_deleted IS NULL OR is_deleted = false)
               ORDER BY length(name) ASC
               LIMIT 1
            ),
            requested_service_id
          )
        WHERE tenant_id = $1 AND call_id = $3`,
      [tenantId, service, callId]
    )
  ).catch(() => undefined);
}

// ── Interval math helpers for /available-slots ────────────────────────
// Ported from supabase/functions/vapi-tools/core/service.ts so the voice
// AI flow doesn't change shape when the edge function is retired.

export interface Interval {
  start: number;
  end: number;
}

/** "HH:MM" or "HH:MM:SS" → minutes since midnight */
export function timeToMinutes(t: string): number {
  const parts = t.split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

/** ISO datetime → minutes since midnight (local-date sense) */
export function dateTimeToMinutes(dt: string): number {
  const d = new Date(dt);
  return d.getHours() * 60 + d.getMinutes();
}

/** minutes since midnight → spoken time ("1:00 PM") */
export function minutesToTime(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return min === 0 ? `${hour12} ${period}` : `${hour12}:${String(min).padStart(2, '0')} ${period}`;
}

/** Merge overlapping/adjacent intervals into non-overlapping coverage. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

/** Subtract booked intervals from coverage. */
export function subtractIntervals(coverage: Interval[], booked: Interval[]): Interval[] {
  let open = coverage.map((c) => ({ ...c }));
  for (const b of booked) {
    const next: Interval[] = [];
    for (const o of open) {
      if (b.end <= o.start || b.start >= o.end) {
        next.push(o);
      } else {
        if (b.start > o.start) next.push({ start: o.start, end: b.start });
        if (b.end < o.end) next.push({ start: b.end, end: o.end });
      }
    }
    open = next;
  }
  return open;
}

/**
 * The times to OFFER out loud: earliest-first, stepped by the SERVICE DURATION,
 * walking only through OPEN times (Dale's spec, 2026-07-17 evening call).
 *
 * The model used to pick its own sample from open_times and chose a spread
 * (first / middle / last) — "1:00, 2:45, or 4:30" — which callers heard as
 * arbitrary. The offers are now computed HERE (the model does no arithmetic —
 * the same rule that created open_times) as consecutive meeting-length steps:
 * a 30-minute service offers "1:00, 1:30, 2:00"; a 15-minute one "1:00, 1:15,
 * 1:30"; an hour-long one "1:00, 2:00, 3:00".
 *
 * Stepping walks the OPEN list, not the clock: if 1:00 is booked the offers
 * start at the first real opening ("1:30, 2:00, 2:30"), and a booked block
 * mid-afternoon is skipped to the next open time at or past the step. The
 * full open_times grid stays alongside as the membership authority, so a
 * caller who counter-proposes "how about 1:15?" still gets an honest yes.
 */
export function pickOfferTimes(
  openMinutes: number[],
  openTimes: string[],
  durationMinutes: number,
  count = 3
): string[] {
  const offers: string[] = [];
  let nextEligible = -Infinity;
  for (let i = 0; i < openMinutes.length && offers.length < count; i++) {
    if (openMinutes[i] >= nextEligible) {
      offers.push(openTimes[i]);
      nextEligible = openMinutes[i] + durationMinutes;
    }
  }
  return offers;
}

/**
 * THE THREE OFFERED TIMES ARE A SAMPLE, AND THE SPOKEN SENTENCE MUST SAY SO.
 *
 * 2026-09-09, prod call SCL_HQNeyh5cVKd9: the agent offered 1:30, 2:00 and 2:30,
 * the caller asked for 4 PM, and it answered "4 PM is not available on September
 * 10. The available times are 1:30, 2:00, or 2:30." 4 PM was open — the shift runs
 * to 5 — and the `note` on that very response already said, in plain words, that a
 * time from open_times must never be refused. It refused anyway.
 *
 * So the correction moved out of the instructions and into the words the model
 * reads aloud. A sentence that already contains the rest of the day cannot be
 * spoken as "those three are all there is".
 *
 * Returns '' when the offers ARE the whole day — inviting a caller to name a time
 * that does not exist would trade one wrong answer for another.
 */
export function offerBreadthClause(openTimes: string[], offerTimes: string[]): string {
  const beyondOffers = openTimes.filter((t) => !offerTimes.includes(t));
  if (beyondOffers.length === 0) return '';
  const latest = openTimes[openTimes.length - 1];
  return ` Those are just the soonest — any open quarter hour through ${latest} works too.`;
}
