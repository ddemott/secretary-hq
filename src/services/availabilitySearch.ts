import type { PoolClient } from 'pg';

/**
 * Find the next N free time-slots when no employee is available at the
 * requested start time. Used by the agent flow ("2 PM is taken — I have
 * 2:30, 3:15, or 4:00 free, which works?") and the dashboard conflict
 * modal ("Pick another time" suggestions).
 *
 * Algorithm — single SQL query that:
 *   1. Generates every 15-minute slot from `fromTime` forward through
 *      the search horizon (default 24 hours).
 *   2. For each slot, takes every employee and LATERAL-joins one free
 *      resource, filtering by shift coverage, required skills, required
 *      capabilities, and no-overlap with existing scheduled+not-deleted
 *      appointments. A tenant that owns NO resources and a service that
 *      needs no capability yield slots with a null resource rather than
 *      no slots at all (2026-08-15 — see the SQL comment).
 *   3. Within each slot, ranks candidates by skill count ASC + random
 *      (mirrors book_with_scheduling_atomic's ORDER BY) and picks the
 *      lowest-skill qualified employee available at that time.
 *   4. Returns the earliest N slots.
 *
 * Returned slots can overlap each other on the timeline (14:00-14:30
 * and 14:15-14:45 are both valid 30-min windows). The caller may
 * dedupe by start-of-hour or other UX rule if desired.
 */

export interface AvailableSlot {
  /** ISO timestamp of slot start (UTC). */
  start_time: string;
  /** ISO timestamp of slot end (UTC). */
  end_time: string;
  /** UUID of the employee who would be auto-assigned at this slot. */
  employee_id: string;
  /** Display name of the assigned employee. */
  employee_name: string;
  /** UUID of the resource paired with the assignment, or null when the tenant
   *  owns no resources and the service needs none (a consultancy whose only
   *  "resource" is the owner's own time). Callers must not assume a resource. */
  resource_id: string | null;
  /** Display name of the resource, or null — see `resource_id`. */
  resource_name: string | null;
  /** Number of skills the assigned employee has — for transparency in
   *  the UI ("Carlos, 3 skills" vs "Mike, 5 skills"). */
  skill_count: number;
}

export interface FindNextAvailableSlotsParams {
  tenantId: string;
  /** Earliest slot start to consider (typically the originally-requested
   *  time that turned out to be busy). */
  fromTime: Date | string;
  /** Slot duration in minutes (matches the service the caller wants). */
  durationMinutes: number;
  /** Required employee skills — must all be present in `employees.skills`.
   *  Empty array means no skill filter. */
  requiredSkills?: string[];
  /** Required resource capabilities — must all be present in
   *  `resources.capabilities`. Empty array means no capability filter. */
  requiredCapabilities?: string[];
  /** How many slots to return. Default 5. */
  count?: number;
  /** How far forward to search, in hours. Default 24h.
   *  Capped at 168 (7 days) to keep query bounded. */
  searchHorizonHours?: number;
  /** Minimum gap to leave on both sides of an existing appointment, in
   *  minutes (the tenant's default buffer). A slot within this many minutes
   *  of a booking is treated as unavailable, so suggestions match what the
   *  booking RPC will accept under the same buffer. Default 0 (no buffer). */
  bufferMinutes?: number;
  /** The service being booked. When given, the skill map decides — only people
   *  linked to it (`service_employee`) and rooms/lines linked to it
   *  (`service_resource`) count, and requiredSkills/requiredCapabilities are
   *  ignored — exactly as book_with_scheduling_atomic enforces (migration
   *  20260909210000). A service with no links therefore has no slots. Omit for
   *  the legacy tag-based search. */
  serviceId?: string | null;
}

export async function findNextAvailableSlots(
  client: PoolClient,
  params: FindNextAvailableSlotsParams
): Promise<AvailableSlot[]> {
  const {
    tenantId,
    fromTime,
    durationMinutes,
    requiredSkills = [],
    requiredCapabilities = [],
    count = 5,
  } = params;
  const searchHorizonHours = Math.min(params.searchHorizonHours ?? 24, 168);
  const bufferMinutes = params.bufferMinutes && params.bufferMinutes > 0 ? params.bufferMinutes : 0;

  const tzRow = await client.query<{ timezone: string | null }>(
    `SELECT timezone FROM tenants WHERE tenant_id = $1`,
    [tenantId]
  );
  const tenantTz = tzRow.rows[0]?.timezone ?? 'UTC';

  const fromIso = typeof fromTime === 'string' ? fromTime : fromTime.toISOString();

  // The CTE `slot_starts` enumerates every 15-min boundary in the search
  // window. The CTE `candidates` does the same eligibility cross-join the
  // booking RPC does, ranks within each slot by skill count, and picks
  // the lowest-skill candidate per slot. The outer SELECT returns the N
  // earliest slots that had at least one candidate.
  const sql = `
    WITH grid_start AS (
      -- Snap the search origin UP to the next quarter-hour CLOCK boundary.
      -- generate_series steps 15 minutes from whatever instant it is given, so
      -- starting from a raw "now" made every suggested slot inherit now's
      -- minutes and seconds (a 4:34 AM search offered 1:04 PM) — times the
      -- appointments_start/end_time_15min CHECKs can never accept. The booking
      -- then 500'd on a slot WE suggested. Epoch/900 keeps the grid aligned to
      -- the same UTC quarter-hours the CHECK constraints measure.
      SELECT to_timestamp(ceil(extract(epoch from $1::timestamptz) / 900.0) * 900) AS g
    ),
    slot_starts AS (
      SELECT generate_series(
        gs.g,
        gs.g + ($2 || ' hours')::interval,
        interval '15 minutes'
      ) AS s
      FROM grid_start gs
    ),
    candidates AS (
      SELECT
        ss.s AS slot_start,
        ss.s + ($3 || ' minutes')::interval AS slot_end,
        emp.employee_id AS employee_id,
        emp.name AS employee_name,
        res.resource_id AS resource_id,
        res.name AS resource_name,
        COALESCE(array_length(emp.skills, 1), 0) AS skill_count,
        ROW_NUMBER() OVER (
          PARTITION BY ss.s
          ORDER BY
            COALESCE(array_length(emp.skills, 1), 0) ASC,
            random()
        ) AS rn
      FROM slot_starts ss
      -- CLOSED DAYS ARE NOT AVAILABILITY (T-106). The booking RPC refuses a
      -- blackout date with BUSINESS_CLOSED; if the suggester did not also
      -- exclude it, the agent would read out times for a day the doors are
      -- locked and the booking would then fail on the caller — the exact
      -- suggest/enforce split that produced the 11:30 PM offers in the
      -- 2026-07-17 midnight-wrap incident. The date is compared in the TENANT's
      -- timezone ($5), the same conversion the shift join uses, because a
      -- closure is a calendar day where the business is, not in UTC.
      LEFT JOIN blackout_dates bd
        ON bd.tenant_id = $4
       AND bd.blackout_date = (ss.s AT TIME ZONE $5)::date
      CROSS JOIN employees emp
      -- A RESOURCE IS REQUIRED ONLY BY A TENANT THAT HAS ONE (2026-08-15).
      --
      -- This was a plain CROSS JOIN on resources, so a tenant with zero resource
      -- rows produced zero candidates — for every slot, on every day, forever.
      -- Not theoretical: a business with an employee, three services and four
      -- weeks of shifts was told "I'm not finding anything open in the next
      -- week" by the SOONEST path while the DATE path listed 31 open times for
      -- the same day (that one builds intervals in JS and never looks at
      -- resources). Same tenant, same shifts, two answers — and the wrong one
      -- is on the opener the agent leads with.
      --
      -- It survived because the tests seed a resource to make the join fire:
      -- "A resource must EXIST for the availability cross-join to produce
      -- slots — we never reference its id, only its presence." That comment is
      -- the bug, written down and worked around.
      --
      -- LATERAL, not a plain LEFT JOIN, because the resource must be free AT
      -- THIS SLOT: it picks one capability-matching resource with no
      -- overlapping appointment. The tenant-level guard below then keeps the
      -- old behaviour exactly where it was right — a tenant WITH resources
      -- still needs a free one, so a fully-booked bay still blocks the slot.
      -- Only the resourceless tenant falls open, the same shape as the
      -- schedule-less fall-open in migration 20260718003000.
      LEFT JOIN LATERAL (
        SELECT r.resource_id, r.name
          FROM resources r
         WHERE r.tenant_id = $4
           AND r.is_active = true
           AND (r.is_deleted IS NULL OR r.is_deleted = false)
           -- THE SKILL MAP DECIDES (2026-09-11): with a service, only a room or
           -- line linked to it, and the capability tags are not consulted — the
           -- same rule the booking RPC enforces.
           AND ($10::uuid IS NOT NULL OR array_length($6::text[], 1) IS NULL OR r.capabilities @> $6::text[])
           AND ($10::uuid IS NULL OR EXISTS (
             SELECT 1 FROM service_resource sr
              WHERE sr.service_id = $10::uuid AND sr.resource_id = r.resource_id
           ))
           AND NOT EXISTS (
             SELECT 1 FROM appointments a
              WHERE a.resource_id = r.resource_id
                AND a.status = 'scheduled'
                AND (a.is_deleted IS NULL OR a.is_deleted = false)
                AND a.start_time < ss.s + ($3 || ' minutes')::interval + ($9 || ' minutes')::interval
                AND a.end_time > ss.s - ($9 || ' minutes')::interval
           )
         ORDER BY r.name ASC
         LIMIT 1
      ) res ON true
      JOIN employee_schedule es
        ON es.employee_id = emp.employee_id
       AND es.tenant_id = $4
       -- TWO DATES, NOT ONE (2026-09-11): a night shift's row is dated the
       -- evening it STARTED, so a slot after local midnight needs YESTERDAY's
       -- row too — shift_row_covers_booking() below decides whether that row
       -- actually reaches this slot; this IN just stops excluding it upfront.
       AND es.shift_date IN ((ss.s AT TIME ZONE $5)::date, (ss.s AT TIME ZONE $5)::date - 1)
       AND es.is_off = false
       -- Tighten before the function call (Copilot review, PR #412): a plain
       -- day shift dated yesterday can never cover today (the coverage
       -- function already says so), so exclude it here rather than pulling
       -- every previous-day row into the join just to discard it inside the
       -- function, for every slot/employee pair — this join runs once per
       -- 15-minute slot across up to a 7-day horizon.
       AND (
             es.shift_date = (ss.s AT TIME ZONE $5)::date
             OR es.end_time < es.start_time
           )
       -- SHIFT COVERAGE IS ONE FUNCTION, SHARED WITH THE BOOKING RPC.
       -- This clause used to spell the comparison out, and the RPC spelled the
       -- same thing out three more times. Suggest and enforce MUST agree — when
       -- they don't, the agent offers a slot the booking then refuses, which is
       -- exactly what shipped on the 2026-07-17 midnight-wrap call. The rule now
       -- lives in shift_row_covers_booking() (migration 20260911010000, wrapping
       -- shift_covers_booking() from 20260909120000): wrap-aware, shift-shape-aware
       -- (DAY shift: a slot crossing local midnight is never covered; NIGHT shift,
       -- end < start: pre-midnight slots pass on the start check and a wrapping
       -- slot must end by the morning end; a row dated YESTERDAY covers TODAY's
       -- slot only when it is itself a wrapping night shift reaching this far),
       -- plus one minute of slack at each boundary so a 16:59 shift end still
       -- covers the 17:00 the caller actually said.
       AND public.shift_row_covers_booking(
             es.shift_date,
             (ss.s AT TIME ZONE $5)::date,
             es.start_time,
             es.end_time,
             (ss.s AT TIME ZONE $5)::time,
             ((ss.s + ($3 || ' minutes')::interval) AT TIME ZONE $5)::time,
             ((ss.s + ($3 || ' minutes')::interval) AT TIME ZONE $5)::date
               <> (ss.s AT TIME ZONE $5)::date
           )
      WHERE emp.tenant_id = $4
        -- The closed-day exclusion. A LEFT JOIN plus IS NULL rather than NOT
        -- EXISTS so the blackout probe rides the (tenant_id, blackout_date)
        -- primary key once per slot instead of running a subquery per row.
        AND bd.tenant_id IS NULL
        AND emp.is_active = true
        AND (emp.is_deleted IS NULL OR emp.is_deleted = false)
        -- The resource requirement, stated once, and it falls open in exactly
        -- ONE case: the service asks for no capability AND the tenant owns no
        -- active resource at all. Everything else still needs a free resource.
        --
        -- The capability clause is the part to be careful with. If the service
        -- REQUIRES a capability and no resource has it, the LATERAL finds
        -- nothing — and that must stay a refusal, not a fall-open, or the
        -- agent offers a lift bay to a shop that does not own one. So the
        -- escape hatch is gated on there being no capability demand at all.
        AND (
          res.resource_id IS NOT NULL
          OR (
            -- Never for a known service: it must have a linked room (strict).
            $10::uuid IS NULL
            AND array_length($6::text[], 1) IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM resources r0
               WHERE r0.tenant_id = $4
                 AND r0.is_active = true
                 AND (r0.is_deleted IS NULL OR r0.is_deleted = false)
            )
          )
        )
        AND ($10::uuid IS NOT NULL OR array_length($7::text[], 1) IS NULL OR emp.skills @> $7::text[])
        -- With a service, only people the skill map links to it.
        AND ($10::uuid IS NULL OR EXISTS (
          SELECT 1 FROM service_employee se
           WHERE se.service_id = $10::uuid AND se.employee_id = emp.employee_id
        ))
        AND NOT EXISTS (
          SELECT 1 FROM appointments a
           WHERE a.employee_id = emp.employee_id
             AND a.status = 'scheduled'
             AND (a.is_deleted IS NULL OR a.is_deleted = false)
             AND a.start_time < ss.s + ($3 || ' minutes')::interval + ($9 || ' minutes')::interval
             AND a.end_time > ss.s - ($9 || ' minutes')::interval
        )
    )
    SELECT slot_start, slot_end,
           employee_id::text, employee_name,
           resource_id::text, resource_name,
           skill_count
      FROM candidates
     WHERE rn = 1
     ORDER BY slot_start ASC
     LIMIT $8
  `;

  const res = await client.query(sql, [
    fromIso,
    String(searchHorizonHours),
    String(durationMinutes),
    tenantId,
    tenantTz,
    requiredCapabilities.length === 0 ? [] : requiredCapabilities,
    requiredSkills.length === 0 ? [] : requiredSkills,
    String(count),
    String(bufferMinutes),
    params.serviceId ?? null,
  ]);

  return res.rows.map(
    (r: {
      slot_start: Date;
      slot_end: Date;
      employee_id: string;
      employee_name: string;
      resource_id: string | null;
      resource_name: string | null;
      skill_count: number;
    }) => ({
      start_time: r.slot_start.toISOString(),
      end_time: r.slot_end.toISOString(),
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      resource_id: r.resource_id,
      resource_name: r.resource_name,
      skill_count: Number(r.skill_count),
    })
  );
}
