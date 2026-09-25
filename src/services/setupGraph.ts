/**
 * Shared draft-graph schema + insert logic for the setup wizard's Phase B
 * draft-commit flow. Two callers share this module:
 *   - POST /coverage/dry-run (src/routes/analytics.ts) — inserts the draft
 *     inside a transaction, runs check_coverage_gaps, ALWAYS ROLLS BACK.
 *   - POST /setup/commit (src/routes/setup.ts) — inserts the same draft,
 *     COMMITs. This is the only difference between preview and real setup.
 *
 * The schema carries the FULL column set (description/price/subtitle on
 * services, description on resources, contact fields on employees) even
 * though dry-run doesn't need them for a coverage preview — sharing one
 * schema/insert means the client can serialize its draft once and post the
 * same payload shape to either endpoint. It also closes a real bug found in
 * design review: an earlier version of dry-run wrote NULL for these columns,
 * and reusing that INSERT verbatim for commit would have silently discarded
 * every description/price/employee-contact field the owner typed, with no
 * test catching it. insertDraftGraph always writes what it's given.
 */
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { expandWeeklyToSchedule, type WeeklyShiftRow } from './expandWeeklyToSchedule';

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * `existing_id` is what makes a re-run an EDIT rather than a duplicate.
 *
 * When the wizard preloads a tenant that has already been set up, each
 * preloaded row carries its real UUID here (its `tmp_id` stays the graph key,
 * so shifts/mappings reference it exactly as they do a brand-new row). Rows
 * with an existing_id are UPDATEd in place; rows without one are INSERTed. The
 * client never has to reshape its draft — the only difference between "create"
 * and "edit" is the presence of this field.
 */
const ExistingId = z.string().uuid().optional();

export const DraftGraphSchema = z.object({
  services: z
    .array(
      z.object({
        tmp_id: z.string().min(1),
        existing_id: ExistingId,
        name: z.string().min(1),
        duration_minutes: z.number().int().positive().max(1440),
        subtitle: z.string().max(200).optional(),
        description: z.string().max(2000).optional(),
        price: z.number().nonnegative().optional(),
      })
    )
    .max(200),
  resources: z
    .array(
      z.object({
        tmp_id: z.string().min(1),
        existing_id: ExistingId,
        name: z.string().min(1),
        description: z.string().max(2000).optional(),
      })
    )
    .max(200)
    .default([]),
  employees: z
    .array(
      z.object({
        tmp_id: z.string().min(1),
        existing_id: ExistingId,
        name: z.string().min(1),
        first_name: z.string().max(100).optional(),
        last_name: z.string().max(100).optional(),
        email: z.string().email().max(200).optional(),
        phone: z.string().max(30).optional(),
      })
    )
    .max(200)
    .default([]),
  shifts: z
    .array(
      z.object({
        employee_tmp_id: z.string().min(1),
        day_of_week: z.number().int().min(0).max(6),
        start_time: z.string().regex(HHMM_RE),
        end_time: z.string().regex(HHMM_RE),
      })
    )
    .max(2000)
    .default([]),
  service_employee: z
    .array(z.object({ service_tmp_id: z.string().min(1), employee_tmp_id: z.string().min(1) }))
    .max(2000)
    .default([]),
  service_resource: z
    .array(z.object({ service_tmp_id: z.string().min(1), resource_tmp_id: z.string().min(1) }))
    .max(2000)
    .default([]),
});

export type DraftGraph = z.infer<typeof DraftGraphSchema>;

/**
 * A repeated tmp_id within services/resources/employees is a client bug: the
 * Map in insertDraftGraph keys on tmp_id, so a duplicate silently overwrites
 * the earlier entry — insertDraftGraph still creates BOTH DB rows (each loop
 * iteration inserts unconditionally), but only the last one is reachable from
 * mappings/shifts, orphaning the first and skewing counts. Returns the
 * duplicated tmp_ids — empty means every id in the graph is unique.
 */
export function findDuplicateTmpIds(draft: DraftGraph): string[] {
  const duplicates = new Set<string>();
  for (const list of [draft.services, draft.resources, draft.employees]) {
    const seen = new Set<string>();
    for (const item of list) {
      if (seen.has(item.tmp_id)) duplicates.add(item.tmp_id);
      seen.add(item.tmp_id);
    }
  }
  return [...duplicates];
}

/**
 * Fail fast on a broken draft graph: a shift or mapping referencing a tmp_id
 * not present in the entity lists is a client bug. Silently dropping it (as
 * an early cut of dry-run did) produces a misleading preview or, worse for
 * commit, a partially-wired real business. Returns the list of missing
 * references — empty means the graph is internally consistent.
 */
export function findMissingTmpIdReferences(draft: DraftGraph): string[] {
  const serviceTmpIds = new Set(draft.services.map((s) => s.tmp_id));
  const employeeTmpIds = new Set(draft.employees.map((e) => e.tmp_id));
  const resourceTmpIds = new Set(draft.resources.map((r) => r.tmp_id));
  const missing: string[] = [];
  for (const sh of draft.shifts) {
    if (!employeeTmpIds.has(sh.employee_tmp_id))
      missing.push(`shift → employee ${sh.employee_tmp_id}`);
  }
  for (const m of draft.service_employee) {
    if (!serviceTmpIds.has(m.service_tmp_id)) missing.push(`mapping → service ${m.service_tmp_id}`);
    if (!employeeTmpIds.has(m.employee_tmp_id))
      missing.push(`mapping → employee ${m.employee_tmp_id}`);
  }
  for (const m of draft.service_resource) {
    if (!serviceTmpIds.has(m.service_tmp_id)) missing.push(`mapping → service ${m.service_tmp_id}`);
    if (!resourceTmpIds.has(m.resource_tmp_id))
      missing.push(`mapping → resource ${m.resource_tmp_id}`);
  }
  return [...new Set(missing)];
}

/** Weeks needed so expandWeeklyToSchedule's fan-out spans [startDate, endDate]. */
export function weeksAheadFor(startDate: string, endDate: string): number {
  const spanDays =
    Math.round(
      (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000
    ) + 1;
  return Math.max(1, Math.ceil(spanDays / 7));
}

export interface InsertDraftGraphCounts {
  services: number;
  resources: number;
  employees: number;
  serviceEmployee: number;
  serviceResource: number;
  /** Rows UPDATEd in place because the draft carried their existing_id. */
  updated: number;
  /** Rows soft-deleted by the prune pass (sync mode only). */
  pruned: number;
}

export interface InsertDraftGraphResult {
  serviceId: Map<string, string>;
  resourceId: Map<string, string>;
  employeeId: Map<string, string>;
  counts: InsertDraftGraphCounts;
}

/** Thrown when a draft's existing_id doesn't name a live row of this tenant. */
export class UnknownExistingIdError extends Error {
  statusCode = 400;
  constructor(entity: string, id: string) {
    super(`Draft references a ${entity} that no longer exists for this business: ${id}`);
    this.name = 'UnknownExistingIdError';
  }
}

/**
 * Inserts a full draft graph on `client` — resources, services, employees,
 * their weekly shift patterns fanned into employee_schedule, then both
 * mapping tables. Caller decides COMMIT vs ROLLBACK; this function never
 * manages the transaction boundary itself. Always writes the full column set
 * it's given (see module doc) — never silently drops owner-typed fields.
 */
export async function insertDraftGraph(
  client: PoolClient,
  tenantId: string,
  draft: DraftGraph,
  opts: { weeksAhead: number; startDate: Date; prune?: boolean }
): Promise<InsertDraftGraphResult> {
  const prune = opts.prune === true;
  let updated = 0;

  const resourceId = new Map<string, string>();
  for (const r of draft.resources) {
    if (r.existing_id) {
      const res = await client.query(
        // No updated_at column on resources (unlike services/employees) — don't
        // add one to the SET list or this UPDATE fails at runtime.
        // is_auto_seeded = false: the owner reviewed this row in the wizard, so
        // a template's bay/chair is theirs now (same rule as services below).
        `UPDATE resources SET name = $1, description = $2, is_auto_seeded = false
          WHERE resource_id = $3 AND tenant_id = $4 AND is_deleted = false`,
        [r.name, r.description ?? null, r.existing_id, tenantId]
      );
      // Zero rows means the id is bogus, belongs to another tenant, or was
      // deleted while the wizard was open. Failing loudly beats silently
      // INSERTing a duplicate of the row the owner thought they were editing.
      if ((res.rowCount ?? 0) === 0) throw new UnknownExistingIdError('resource', r.existing_id);
      resourceId.set(r.tmp_id, r.existing_id);
      updated++;
      continue;
    }
    const { rows: rr } = await client.query<{ resource_id: string }>(
      `INSERT INTO resources (tenant_id, name, description, is_auto_seeded)
       VALUES ($1, $2, $3, false) RETURNING resource_id`,
      [tenantId, r.name, r.description ?? null]
    );
    resourceId.set(r.tmp_id, rr[0].resource_id);
  }

  const serviceId = new Map<string, string>();
  for (const s of draft.services) {
    if (s.existing_id) {
      const res = await client.query(
        // is_auto_seeded = false: an owner who reviewed this row in the wizard
        // now owns it, so a later business-type change must not wipe it (same
        // promotion rule as POST /services/:id/update).
        `UPDATE services
            SET name = $1, subtitle = $2, description = $3, duration_minutes = $4,
                price = $5, is_auto_seeded = false, updated_at = NOW()
          WHERE service_id = $6 AND tenant_id = $7 AND is_deleted = false`,
        [
          s.name,
          s.subtitle ?? null,
          s.description ?? null,
          s.duration_minutes,
          s.price ?? null,
          s.existing_id,
          tenantId,
        ]
      );
      if ((res.rowCount ?? 0) === 0) throw new UnknownExistingIdError('service', s.existing_id);
      serviceId.set(s.tmp_id, s.existing_id);
      updated++;
      continue;
    }
    const { rows: sr } = await client.query<{ service_id: string }>(
      `INSERT INTO services
         (tenant_id, name, subtitle, description, duration_minutes, price,
          required_skills, required_resources, is_auto_seeded)
       VALUES ($1, $2, $3, $4, $5, $6, '{}', '{}', false) RETURNING service_id`,
      [
        tenantId,
        s.name,
        s.subtitle ?? null,
        s.description ?? null,
        s.duration_minutes,
        s.price ?? null,
      ]
    );
    serviceId.set(s.tmp_id, sr[0].service_id);
  }

  const employeeId = new Map<string, string>();
  for (const e of draft.employees) {
    if (e.existing_id) {
      const res = await client.query(
        `UPDATE employees
            SET name = $1, first_name = $2, last_name = $3, email = $4, phone = $5,
                -- Reviewed in the wizard: a template placeholder is claimed.
                is_auto_seeded = false,
                updated_at = NOW()
          WHERE employee_id = $6 AND tenant_id = $7 AND is_deleted = false`,
        [
          e.name,
          e.first_name ?? null,
          e.last_name ?? null,
          e.email ?? null,
          e.phone ?? null,
          e.existing_id,
          tenantId,
        ]
      );
      if ((res.rowCount ?? 0) === 0) throw new UnknownExistingIdError('employee', e.existing_id);
      employeeId.set(e.tmp_id, e.existing_id);
      updated++;
      continue;
    }
    const { rows: er } = await client.query<{ employee_id: string }>(
      `INSERT INTO employees (tenant_id, name, first_name, last_name, email, phone, skills)
       VALUES ($1, $2, $3, $4, $5, $6, '{}') RETURNING employee_id`,
      [
        tenantId,
        e.name,
        e.first_name ?? null,
        e.last_name ?? null,
        e.email ?? null,
        e.phone ?? null,
      ]
    );
    employeeId.set(e.tmp_id, er[0].employee_id);
  }

  // Sync mode: an employee whose hours the owner just re-set must not keep the
  // OLD pattern alongside the new one. expandWeeklyToSchedule is ON CONFLICT DO
  // NOTHING (idempotent, never overwrites), so without clearing first, removing
  // a Wednesday shift in the wizard would leave the original Wednesday row in
  // employee_schedule and the change would appear to do nothing. Only future
  // rows are cleared — past shifts are history and stay put.
  if (prune) {
    const editedEmployeeIds = [...employeeId.values()];
    if (editedEmployeeIds.length > 0) {
      await client.query(
        `DELETE FROM employee_schedule
          WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[]) AND shift_date >= $3::date`,
        [tenantId, editedEmployeeIds, opts.startDate]
      );
      // Clear the declared RULE for the same employees. The fan-out below
      // rewrites it for everyone who still has shifts in the draft; the ones
      // who do NOT are exactly the case this covers — an employee whose shifts
      // the owner removed entirely never reaches expandWeeklyToSchedule at all,
      // so nothing else would ever retire their rule and the schedule extender
      // would keep projecting hours the draft no longer contains.
      await client.query(
        `DELETE FROM employee_schedule_pattern
          WHERE tenant_id = $1 AND employee_id = ANY($2::uuid[])`,
        [tenantId, editedEmployeeIds]
      );
    }
  }

  // Fan each employee's weekly pattern into date-specific employee_schedule
  // rows, reusing the batched expand-weekly helper (one multi-row INSERT per
  // employee — avoids the historical per-row deadlock + N round-trips).
  const patternByEmployee = new Map<string, WeeklyShiftRow[]>();
  for (const sh of draft.shifts) {
    const empId = employeeId.get(sh.employee_tmp_id);
    if (!empId) continue; // caller validates references before calling; defensive
    const rowsForEmp = patternByEmployee.get(empId) ?? [];
    rowsForEmp.push({
      day_of_week: sh.day_of_week,
      start_time: sh.start_time,
      end_time: sh.end_time,
    });
    patternByEmployee.set(empId, rowsForEmp);
  }
  for (const [empId, pattern] of patternByEmployee) {
    await expandWeeklyToSchedule(client, {
      tenantId,
      employeeId: empId,
      pattern,
      weeksAhead: opts.weeksAhead,
      startDate: opts.startDate,
    });
  }

  // Sync mode: mappings are declarative — the draft IS the desired set. Clear
  // the existing rows for the services in this draft so an assignment the owner
  // UNCHECKED in the wizard actually goes away (the inserts below are ON
  // CONFLICT DO NOTHING, so they can only ever add, never remove).
  if (prune) {
    const keptServiceIds = [...serviceId.values()];
    if (keptServiceIds.length > 0) {
      await client.query(
        `DELETE FROM service_employee WHERE tenant_id = $1 AND service_id = ANY($2::uuid[])`,
        [tenantId, keptServiceIds]
      );
      await client.query(
        `DELETE FROM service_resource WHERE tenant_id = $1 AND service_id = ANY($2::uuid[])`,
        [tenantId, keptServiceIds]
      );
    }
  }

  let serviceEmployeeCount = 0;
  for (const m of draft.service_employee) {
    const sid = serviceId.get(m.service_tmp_id);
    const eid = employeeId.get(m.employee_tmp_id);
    if (sid && eid) {
      const { rowCount } = await client.query(
        `INSERT INTO service_employee (service_id, employee_id, tenant_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [sid, eid, tenantId]
      );
      // ON CONFLICT DO NOTHING returns rowCount 0 on a skipped duplicate — only
      // count rows actually inserted, so a repeated mapping in the draft
      // doesn't inflate the reported count past what's really in the DB.
      serviceEmployeeCount += rowCount ?? 0;
    }
  }
  let serviceResourceCount = 0;
  for (const m of draft.service_resource) {
    const sid = serviceId.get(m.service_tmp_id);
    const rid = resourceId.get(m.resource_tmp_id);
    if (sid && rid) {
      const { rowCount } = await client.query(
        `INSERT INTO service_resource (service_id, resource_id, tenant_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [sid, rid, tenantId]
      );
      serviceResourceCount += rowCount ?? 0;
    }
  }

  // Prune: anything live for this tenant that the draft no longer mentions was
  // REMOVED by the owner in the wizard. Soft-delete only (is_deleted = true) —
  // appointments still reference these rows by FK, and the booking RPCs already
  // filter on is_deleted, so history stays intact and readable while the entity
  // stops being bookable. A hard DELETE here would break existing appointments.
  //
  // Guarded on `prune` because it is only correct when the draft is a FULL
  // picture of the business (i.e. the wizard preloaded it). A create-mode draft
  // is a partial graph, and pruning against it would soft-delete every entity
  // the wizard didn't happen to carry.
  let pruned = 0;
  if (prune) {
    // `<> ALL(...)` with an empty array is TRUE for every row, which is exactly
    // right: a draft with zero services means the owner removed them all.
    const keptServices = [...serviceId.values()];
    const keptResources = [...resourceId.values()];
    const keptEmployees = [...employeeId.values()];

    const prunedServices = await client.query(
      `UPDATE services SET is_deleted = true, deleted_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1 AND is_deleted = false AND service_id <> ALL($2::uuid[])`,
      [tenantId, keptServices]
    );
    const prunedResources = await client.query(
      `UPDATE resources SET is_deleted = true, deleted_at = NOW(), is_active = false
        WHERE tenant_id = $1 AND is_deleted = false AND resource_id <> ALL($2::uuid[])`,
      [tenantId, keptResources]
    );
    const prunedEmployees = await client.query(
      `UPDATE employees SET is_deleted = true, deleted_at = NOW(), is_active = false,
              updated_at = NOW()
        WHERE tenant_id = $1 AND is_deleted = false AND employee_id <> ALL($2::uuid[])`,
      [tenantId, keptEmployees]
    );
    pruned =
      (prunedServices.rowCount ?? 0) +
      (prunedResources.rowCount ?? 0) +
      (prunedEmployees.rowCount ?? 0);
  }

  return {
    serviceId,
    resourceId,
    employeeId,
    counts: {
      services: serviceId.size,
      resources: resourceId.size,
      employees: employeeId.size,
      serviceEmployee: serviceEmployeeCount,
      serviceResource: serviceResourceCount,
      updated,
      pruned,
    },
  };
}

/**
 * Which upcoming appointments would be orphaned by committing this draft in
 * sync mode — i.e. are booked against a service/employee/resource the owner
 * removed in the wizard. Read-only: the caller decides whether to warn or block.
 *
 * Counted BEFORE the prune runs (the soft-delete doesn't touch appointments, so
 * after the fact these bookings would still point at now-invisible entities with
 * nothing to flag them). Only 'scheduled' appointments in the future matter — a
 * past or canceled booking referencing a retired service is just history.
 */
export interface RemovedEntityImpact {
  kind: 'service' | 'employee' | 'resource';
  name: string;
  upcomingAppointments: number;
}

export interface RemovalImpact {
  upcomingAppointments: number;
  /** Only entities that actually strand a booking — see the query comment. */
  removed: RemovedEntityImpact[];
}

export async function findRemovalImpact(
  client: PoolClient,
  tenantId: string,
  draft: DraftGraph
): Promise<RemovalImpact> {
  const keptServices = draft.services.map((s) => s.existing_id).filter(Boolean) as string[];
  const keptEmployees = draft.employees.map((e) => e.existing_id).filter(Boolean) as string[];
  const keptResources = draft.resources.map((r) => r.existing_id).filter(Boolean) as string[];

  const res = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM appointments a
      WHERE a.tenant_id = $1
        AND a.status = 'scheduled'
        AND a.start_time > NOW()
        AND (a.is_deleted IS NULL OR a.is_deleted = false)
        AND (
          (a.service_id  IS NOT NULL AND a.service_id  <> ALL($2::uuid[])) OR
          (a.employee_id IS NOT NULL AND a.employee_id <> ALL($3::uuid[])) OR
          (a.resource_id IS NOT NULL AND a.resource_id <> ALL($4::uuid[]))
        )`,
    [tenantId, keptServices, keptEmployees, keptResources]
  );

  // Name WHAT is being removed and how many bookings each one strands. A bare
  // count ("3 appointments affected") isn't actionable — the owner can't tell
  // whether they're retiring a dead service or the one their whole book is on.
  // Only entities that actually hold an upcoming booking are listed: removing an
  // unbooked service is unremarkable and must not nag.
  //
  // GROUP BY the PRIMARY KEY, not the name. Nothing enforces name uniqueness
  // within a tenant — two stylists really can both be "Alex" (the employees
  // duplicate-name guard is a soft 409 that deliberately allows namesakes).
  // Grouping by name would MERGE those distinct rows into one line and misstate
  // the counts: an owner removing only one Alex would be told both Alexes'
  // bookings were at risk.
  //
  // `upcoming` is ::int, not ::text, so `ORDER BY 3 DESC` sorts NUMERICALLY. As
  // text it sorted lexicographically — "10" before "2" — burying the
  // most-affected entity below a trivial one and inverting the whole point of
  // the ordering.
  const removed = await client.query<{
    kind: 'service' | 'employee' | 'resource';
    name: string;
    upcoming: number;
  }>(
    `SELECT 'service' AS kind, s.name AS name, count(a.appointment_id)::int AS upcoming
       FROM services s
       JOIN appointments a
         ON a.service_id = s.service_id
        AND a.status = 'scheduled' AND a.start_time > NOW()
        AND (a.is_deleted IS NULL OR a.is_deleted = false)
      WHERE s.tenant_id = $1 AND s.is_deleted = false AND s.service_id <> ALL($2::uuid[])
      GROUP BY s.service_id, s.name
     UNION ALL
     SELECT 'employee', e.name, count(a.appointment_id)::int
       FROM employees e
       JOIN appointments a
         ON a.employee_id = e.employee_id
        AND a.status = 'scheduled' AND a.start_time > NOW()
        AND (a.is_deleted IS NULL OR a.is_deleted = false)
      WHERE e.tenant_id = $1 AND e.is_deleted = false AND e.employee_id <> ALL($3::uuid[])
      GROUP BY e.employee_id, e.name
     UNION ALL
     SELECT 'resource', r.name, count(a.appointment_id)::int
       FROM resources r
       JOIN appointments a
         ON a.resource_id = r.resource_id
        AND a.status = 'scheduled' AND a.start_time > NOW()
        AND (a.is_deleted IS NULL OR a.is_deleted = false)
      WHERE r.tenant_id = $1 AND r.is_deleted = false AND r.resource_id <> ALL($4::uuid[])
      GROUP BY r.resource_id, r.name
      ORDER BY 3 DESC, 2 ASC`,
    [tenantId, keptServices, keptEmployees, keptResources]
  );

  return {
    upcomingAppointments: Number(res.rows[0]?.count ?? 0),
    removed: removed.rows.map((r) => ({
      kind: r.kind,
      name: r.name,
      upcomingAppointments: Number(r.upcoming),
    })),
  };
}
