import type { AppFastifyInstance } from '../types/fastify';
import type { Pool, PoolClient } from 'pg';
import {
  withHandler,
  logEvent,
  requireTenantId,
  requireOwnerRole,
  type AppRequest,
} from '../middleware/fastify-middleware';
import {
  DraftGraphSchema,
  findDuplicateTmpIds,
  findMissingTmpIdReferences,
  findRemovalImpact,
  insertDraftGraph,
} from '../services/setupGraph';
import { applyDefaultServicePolicy } from '../services/defaultServicePolicy';

/**
 * POST /setup/commit — the wizard's Phase B commit-on-enter-step-9 endpoint.
 * Twin of POST /coverage/dry-run (src/routes/analytics.ts): same draft graph,
 * same insertDraftGraph body, but COMMITs instead of ROLLBACK. See
 * src/services/setupGraph.ts for why the two share one schema/insert path,
 * and docs/superpowers/specs/2026-07-05-wizard-phase-b-design.md for the
 * full design (Option B rationale, the lossy-insert fix, the idempotency
 * guard, and why the entity-graph commit fires on ENTERING step 9, not on
 * the wizard's final Done click).
 */
export function registerSetupRoutes(
  app: AppFastifyInstance,
  _pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  /**
   * GET /setup/graph — the tenant's CURRENT setup graph, in the exact shape the
   * wizard posts back. This is what makes re-running setup an edit instead of a
   * duplicate: the wizard loads this as its starting draft, so every row already
   * carries its existing_id and the owner sees their real business.
   *
   * It is also a safety precondition for `mode: 'sync'`, not a convenience. A
   * sync commit prunes anything the draft omits — so a wizard that preloaded
   * entities but NOT shifts/mappings would post a draft that looks like "the
   * owner deleted all their hours and assignments" and the prune would dutifully
   * wipe them. Serving all five collections from one query keeps that impossible.
   *
   * Shifts are collapsed back into the weekly pattern the wizard's grid speaks
   * (employee × day-of-week × start/end), reading only from today forward —
   * past shifts are history and must not be re-expanded on commit.
   */
  app.get(
    '/setup/graph',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const graph = await withTenantClient(tenantId, async (client) => {
        const services = await client.query(
          `SELECT service_id, name, subtitle, description, duration_minutes, price
             FROM services
            WHERE tenant_id = $1 AND is_deleted = false
            ORDER BY name ASC`,
          [tenantId]
        );
        const resources = await client.query(
          `SELECT resource_id, name, description
             FROM resources
            WHERE tenant_id = $1 AND is_deleted = false
            ORDER BY name ASC`,
          [tenantId]
        );
        const employees = await client.query(
          `SELECT employee_id, name, first_name, last_name, email, phone
             FROM employees
            WHERE tenant_id = $1 AND is_deleted = false
            ORDER BY name ASC`,
          [tenantId]
        );
        // DISTINCT collapses the 4-week fan-out back to one row per weekday.
        // EXTRACT(DOW) is 0=Sunday, matching the wizard grid's day_of_week.
        const shifts = await client.query(
          `SELECT DISTINCT
                  es.employee_id,
                  EXTRACT(DOW FROM es.shift_date)::int AS day_of_week,
                  to_char(es.start_time, 'HH24:MI') AS start_time,
                  to_char(es.end_time, 'HH24:MI')   AS end_time
             FROM employee_schedule es
             JOIN employees e ON e.employee_id = es.employee_id AND e.tenant_id = es.tenant_id
            WHERE es.tenant_id = $1
              AND es.is_off = false
              AND es.start_time IS NOT NULL
              AND es.end_time IS NOT NULL
              AND es.shift_date >= CURRENT_DATE
              AND e.is_deleted = false
            ORDER BY es.employee_id, day_of_week`,
          [tenantId]
        );
        const serviceEmployee = await client.query(
          `SELECT service_id, employee_id FROM service_employee WHERE tenant_id = $1`,
          [tenantId]
        );
        const serviceResource = await client.query(
          `SELECT service_id, resource_id FROM service_resource WHERE tenant_id = $1`,
          [tenantId]
        );
        return {
          services: services.rows,
          resources: resources.rows,
          employees: employees.rows,
          shifts: shifts.rows,
          service_employee: serviceEmployee.rows,
          service_resource: serviceResource.rows,
        };
      });

      // Bare payload (no {success} envelope) — matches the other GET routes the
      // dashboard's apiFetch consumes, which return their JSON directly.
      return reply.send(graph);
    }, 'Failed to load setup graph')
  );

  /**
   * POST /setup/impact — what a sync commit of THIS draft would destroy.
   *
   * A read-only dry-run of the prune. The wizard calls it BEFORE committing, so
   * the owner is warned while they can still back out. /setup/commit reports the
   * same number, but by then the soft-delete has already happened — which is no
   * use at all to someone deciding whether to go through with it.
   *
   * Only meaningful for a sync (preloaded) draft: a create-mode draft prunes
   * nothing, so it can strand nothing.
   */
  app.post(
    '/setup/impact',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      // Owner-only (mirrors /setup/commit below): a dry-run over the same
      // draft graph, which exposes the same business-structure detail
      // (existing services/resources/employees, upcoming-appointment
      // impact counts) even though it never writes anything itself.
      if (!requireOwnerRole(req, reply)) return;

      const parsed = DraftGraphSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }

      const impact = await withTenantClient(tenantId, (client) =>
        findRemovalImpact(client, tenantId, parsed.data)
      );
      return reply.send({ success: true, impact });
    }, 'Failed to compute setup impact')
  );

  /**
   * POST /setup/default-service — apply the fallthrough-service policy.
   *
   * /setup/commit already does this inside its transaction, but the SOLO wizard
   * never goes through commit: it creates services one at a time via
   * POST /services and finalizes with mappings + shifts. Without this, a solo
   * tenant — the single most common shape of new business on this product —
   * finished setup with `default_service_id` unset, and the next caller whose
   * words matched nothing was booked into whatever service sorted first
   * alphabetically. Explicit endpoint rather than a side effect of creating a
   * service: a write that changes which service every unmatched call books
   * should be something a caller asked for, not something that happens quietly.
   */
  app.post(
    '/setup/default-service',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      // Owner-only: changes which service every unmatched call books.
      if (!requireOwnerRole(req, reply)) return;
      const result = await withTenantClient(tenantId, (client) =>
        applyDefaultServicePolicy(client, tenantId)
      );
      if (result.applied) {
        logEvent(req, 'default_service_applied', {
          tenantId,
          serviceName: result.serviceName,
        });
      }
      return reply.send({ success: true, ...result });
    }, 'Failed to apply default service policy')
  );

  app.post(
    '/setup/commit',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      // Owner-only: this is the same insert/update/prune write surface that
      // services.ts/employees.ts/resources.ts/shifts.ts/mappings.ts are each
      // individually owner-gated for — reaching it through a bulk draft
      // graph instead of the per-entity routes must not bypass that gate.
      // A sync-mode commit soft-deletes/hard-deletes every service,
      // resource, employee, shift and mapping the draft omits
      // (setupGraph.ts), so this is strictly higher blast radius than any
      // single route it stands in for.
      if (!requireOwnerRole(req, reply)) return;

      const parsed = DraftGraphSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const draft = parsed.data;

      // 'sync' = the wizard preloaded this tenant's real graph and the draft is
      // now the COMPLETE desired state: rows carry existing_id (→ UPDATE), new
      // rows don't (→ INSERT), and anything absent was removed (→ soft-delete).
      // 'create' (the default, and every pre-existing caller) keeps the old
      // INSERT-only contract. The mode is explicit rather than inferred from
      // "does the draft contain existing_ids?" because the dangerous case is a
      // draft with NO existing_ids: under create that's a fresh business, but
      // under prune it would soft-delete the entire tenant. Never guess that.
      const mode = (req.body as { mode?: unknown } | null)?.mode === 'sync' ? 'sync' : 'create';

      const duplicates = findDuplicateTmpIds(draft);
      if (duplicates.length > 0) {
        return reply.status(400).send({
          success: false,
          error: 'Draft contains duplicate tmp_ids',
          details: duplicates,
        });
      }

      const missing = findMissingTmpIdReferences(draft);
      if (missing.length > 0) {
        return reply.status(400).send({
          success: false,
          error: 'Draft references unknown tmp_ids',
          details: missing,
        });
      }

      const counts = await withTenantClient(tenantId, async (client) => {
        await client.query('BEGIN');
        try {
          // Per-tenant advisory lock, held for the rest of this transaction:
          // closes the TOCTOU race where two concurrent /setup/commit requests
          // both see "no services" before either commits, and both proceed to
          // insert — doubling the catalog. hashtext(uuid) collapses the tenant
          // id to a lock key; xact_lock auto-releases on COMMIT/ROLLBACK, so a
          // second waiting request only proceeds past this line once the first
          // has fully committed (or rolled back) and its rows are visible.
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tenantId]);

          // Soft-delete-aware idempotency guard: a tenant that legitimately
          // wiped its catalog (soft-deleted) and re-runs setup should not be
          // falsely blocked, but a tenant with ANY real services already
          // committed has finished setup once — a create-mode commit is
          // INSERT-only and would duplicate the whole graph on a second run
          // (e.g. a lost-response retry).
          //
          // Sync mode is exempt: re-running setup on an already-onboarded
          // tenant is the whole POINT there, and it edits in place instead of
          // duplicating. This guard used to fire unconditionally, which made
          // setup impossible to redo for exactly the tenants who had finished
          // it once ("Setup already completed — edit in My Business").
          if (mode === 'create') {
            const existing = await client.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM services WHERE tenant_id = $1 AND is_deleted = false`,
              [tenantId]
            );
            if (Number(existing.rows[0].count) > 0) {
              // Plain Error + statusCode (not AppError): withHandler only echoes
              // a `code` field for AppError, and AppErrorCode is a closed union
              // with no CONFLICT variant — a dead `code` property here would be
              // misleading, so this intentionally carries status + message only.
              const err = new Error('Setup already completed — edit in My Business') as Error & {
                statusCode: number;
              };
              err.statusCode = 409;
              throw err;
            }
          }

          // Count what the owner's removals would strand BEFORE pruning — the
          // soft-delete leaves the appointments themselves untouched, so after
          // the fact there'd be nothing left to detect them by.
          const impact =
            mode === 'sync'
              ? await findRemovalImpact(client, tenantId, draft)
              : { upcomingAppointments: 0 };

          const result = await insertDraftGraph(client, tenantId, draft, {
            // 4-week default horizon — matches the wizard's forward-schedule
            // expansion (and the dry-run endpoint's default when no explicit
            // window is given); commit has no coverage date-range concept.
            weeksAhead: 4,
            startDate: new Date(),
            prune: mode === 'sync',
          });
          // The fallthrough service, chosen by POLICY rather than by sort order.
          // In the same transaction as the graph insert, because a tenant that
          // has services but no usable default is a tenant whose next unmatched
          // call books whatever sorts first alphabetically. See
          // src/services/defaultServicePolicy.ts.
          const defaultService = await applyDefaultServicePolicy(client, tenantId);

          await client.query('COMMIT');
          if (defaultService.applied) {
            logEvent(req, 'default_service_applied', {
              tenantId,
              serviceName: defaultService.serviceName,
            });
          }
          return { ...result.counts, upcoming_appointments_affected: impact.upcomingAppointments };
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      });

      logEvent(req, 'setup_committed', { tenantId, mode, ...counts });
      return reply.send({ success: true, counts });
    }, 'Failed to complete setup')
  );
}
