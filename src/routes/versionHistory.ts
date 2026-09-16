/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

/**
 * Version History Routes
 *
 * Provides endpoints for:
 * - Viewing record history and versions
 * - Restoring fields from historical versions
 * - Managing soft-deleted records
 * - Copying fields between records
 * - Viewing recent changes across all tables
 */

import type { AppFastifyInstance } from '../types/fastify';
import type { Pool, PoolClient } from 'pg';
import {
  withHandler,
  logEvent,
  requireTenantId,
  requireOwnerRole,
  type AppRequest,
} from '../middleware/fastify-middleware';
import type {
  RecordVersion,
  RecordHistoryResponse,
  DeletedRecord,
  RecentChange,
  VersionComparison,
  VersionedTable,
  ChangeSource,
} from '../types/versionHistory';
import { PK_COLUMN_BY_TABLE, excludedSystemFields } from '../../shared/versionHistoryFields';
import {
  type RecordHistoryRow,
  RestoreFieldsSchema,
  CopyFieldsSchema,
  SoftDeleteSchema,
  createErrorResponse,
  validateTable,
  validateBody,
} from './versionHistoryHelpers';

export function registerVersionHistoryRoutes(
  app: AppFastifyInstance,
  pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  /**
   * GET /records/:table/:recordId/history
   * Get full version history for a record
   */
  app.get(
    '/records/:table/:recordId/history',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { table, recordId } = req.params as { table: string; recordId: string };
      const endpoint = `/records/${table}/${recordId}/history`;

      const tableError = validateTable(table, tenantId, 'Get record history', endpoint);
      if (tableError) return reply.status(400).send(tableError);

      const history = await withTenantClient(tenantId, async (client) => {
        // Get record info including soft delete status
        const pkColumn = PK_COLUMN_BY_TABLE[table];
        const recordResult = await client.query(
          `SELECT is_deleted, deleted_at, deleted_by FROM ${table}
         WHERE ${pkColumn} = $1 AND tenant_id = $2`,
          [recordId, tenantId]
        );

        const record = recordResult.rows[0];

        // Get all versions
        const versionsResult = await client.query<RecordHistoryRow>(
          `SELECT * FROM get_record_history($1, $2, $3)`,
          [tenantId, table, recordId]
        );

        const versions = versionsResult.rows.map((row) => ({
          record_version_id: row.record_version_id,
          tenant_id: tenantId,
          table_name: table as VersionedTable,
          record_id: recordId,
          version_number: row.version_number,
          data: row.data,
          changed_fields: row.changed_fields || [],
          previous_values: row.previous_values || {},
          change_type: row.change_type,
          change_source: row.change_source as ChangeSource,
          changed_by: row.changed_by,
          change_summary: row.change_summary,
          changed_at: row.changed_at,
        }));

        return {
          record_id: recordId,
          table_name: table as VersionedTable,
          current_version: versions.length > 0 ? versions[0].version_number : 0,
          versions,
          is_deleted: record?.is_deleted || false,
          deleted_at: record?.deleted_at || null,
          deleted_by: record?.deleted_by || null,
        } as RecordHistoryResponse;
      });

      return reply.send(history);
    }, 'Failed to get record history')
  );

  /**
   * GET /records/:table/:recordId/version/:versionNumber
   * Get a specific version of a record
   */
  app.get(
    '/records/:table/:recordId/version/:versionNumber',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { table, recordId, versionNumber } = req.params as {
        table: string;
        recordId: string;
        versionNumber: string;
      };
      const endpoint = `/records/${table}/${recordId}/version/${versionNumber}`;

      const tableError = validateTable(table, tenantId, 'Get specific version', endpoint);
      if (tableError) return reply.status(400).send(tableError);

      const version = await withTenantClient(tenantId, async (client) => {
        const result = await client.query<RecordVersion>(
          `SELECT * FROM record_versions
         WHERE tenant_id = $1 AND table_name = $2 AND record_id = $3 AND version_number = $4`,
          [tenantId, table, recordId, parseInt(versionNumber)]
        );
        return result.rows[0] || null;
      });

      if (!version) {
        return reply.status(404).send(
          createErrorResponse({
            who: tenantId,
            what: 'Get specific version',
            where: `/records/${table}/${recordId}/version/${versionNumber}`,
            why: `Version ${versionNumber} not found for record ${recordId} in table ${table}`,
            code: 'VERSION_NOT_FOUND',
          })
        );
      }

      return reply.send(version);
    }, 'Failed to get record version')
  );

  /**
   * GET /records/:table/:recordId/compare/:versionA/:versionB
   * Compare two versions of a record
   */
  app.get(
    '/records/:table/:recordId/compare/:versionA/:versionB',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { table, recordId, versionA, versionB } = req.params as {
        table: string;
        recordId: string;
        versionA: string;
        versionB: string;
      };
      const endpoint = `/records/${table}/${recordId}/compare/${versionA}/${versionB}`;

      const tableError = validateTable(table, tenantId, 'Compare versions', endpoint);
      if (tableError) return reply.status(400).send(tableError);

      const comparison = await withTenantClient(tenantId, async (client) => {
        const result = await client.query<VersionComparison>(
          `SELECT * FROM compare_versions($1, $2, $3, $4, $5)`,
          [tenantId, table, recordId, parseInt(versionA), parseInt(versionB)]
        );
        return result.rows;
      });

      return reply.send({
        record_id: recordId,
        table_name: table,
        version_a: parseInt(versionA),
        version_b: parseInt(versionB),
        differences: comparison,
      });
    }, 'Failed to compare versions')
  );

  /**
   * POST /records/:table/:recordId/restore-fields
   * Restore specific fields from a historical version
   */
  app.post(
    '/records/:table/:recordId/restore-fields',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): field-level restore from
      // version history is a destructive rewrite, not a front-desk action.
      if (!requireOwnerRole(req, reply)) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { table, recordId } = req.params as { table: string; recordId: string };
      const endpoint = `/records/${table}/${recordId}/restore-fields`;
      const operation = 'Restore fields from version';

      const tableError = validateTable(table, tenantId, operation, endpoint);
      if (tableError) return reply.status(400).send(tableError);

      const bodyResult = validateBody(
        RestoreFieldsSchema,
        req.body,
        tenantId,
        operation,
        endpoint,
        'provide { source_version, fields[] } or { restores: [{ source_version, fields[] }] }'
      );
      if ('error' in bodyResult) return reply.status(400).send(bodyResult.error);

      const { restored_by, change_source } = bodyResult.data;
      // Normalize both accepted shapes to a list of restore groups.
      const groups =
        'restores' in bodyResult.data
          ? bodyResult.data.restores
          : [{ source_version: bodyResult.data.source_version, fields: bodyResult.data.fields }];
      const totalFields = groups.reduce((n, g) => n + g.fields.length, 0);
      let failedVersion: number | null = null;

      const result = await withTenantClient(tenantId, async (client) => {
        // ONE transaction wraps every group so a partial failure rolls the
        // whole batch back — the modal never lands the record in a half-
        // restored state. (BEGIN also lets the two set_config(local) calls
        // apply to the grouped restore RPCs.)
        try {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.change_source', $1, true)`, [
            change_source || 'local',
          ]);
          await client.query(`SELECT set_config('app.changed_by', $1, true)`, [
            restored_by || 'user',
          ]);

          let lastData: Record<string, unknown> | null = null;
          for (const group of groups) {
            // Mark this group as the suspect BEFORE the RPC — the DB function
            // RAISEs a P0001 exception for a missing record/version (it does
            // NOT return null), so we can't rely on inspecting the result to
            // know which group failed. Cleared only after the group succeeds.
            failedVersion = group.source_version;
            const restoreResult = await client.query<{ data: Record<string, unknown> }>(
              `SELECT restore_fields_from_version($1, $2, $3, $4, $5, $6, $7) as data`,
              [
                tenantId,
                table,
                recordId,
                group.source_version,
                group.fields,
                restored_by || 'user',
                change_source || 'local',
              ]
            );
            const data = restoreResult.rows[0]?.data ?? null;
            if (!data) throw new Error(`RESTORE_FAILED:${group.source_version}`);
            lastData = data;
            failedVersion = null; // this group committed cleanly
          }

          await client.query('COMMIT');
          return lastData;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          // Expected restore failure — the RPC RAISEd (P0001) or returned no
          // data for the group named in failedVersion. Return null so the
          // route emits the structured RESTORE_FAILED 5W body below. An error
          // with no failedVersion set is unexpected → propagate to withHandler.
          const code = (err as { code?: string } | null)?.code;
          if (failedVersion !== null || code === 'P0001') return null;
          throw err;
        }
      });

      if (!result) {
        return reply.status(500).send(
          createErrorResponse({
            who: tenantId,
            what: 'Restore fields from version',
            where: `/records/${table}/${recordId}/restore-fields`,
            why: `Failed to restore fields from version ${failedVersion ?? 'unknown'}. The version or record may not exist; no fields were changed.`,
            code: 'RESTORE_FAILED',
          })
        );
      }

      logEvent(req, 'fields_restored', {
        table_name: table,
        record_id: recordId,
        groups: groups.length,
        total_fields: totalFields,
      });

      return reply.send({
        success: true,
        data: result,
        message: `Restored ${totalFields} field(s) from ${groups.length} version(s)`,
      });
    }, 'Failed to restore fields')
  );

  /**
   * POST /records/:table/:recordId/soft-delete
   * Soft delete a record
   */
  app.post(
    '/records/:table/:recordId/soft-delete',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): a destructive action.
      if (!requireOwnerRole(req, reply)) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { table, recordId } = req.params as { table: string; recordId: string };
      const endpoint = `/records/${table}/${recordId}/soft-delete`;

      const tableError = validateTable(table, tenantId, 'Soft delete record', endpoint);
      if (tableError) return reply.status(400).send(tableError);

      const parsed = SoftDeleteSchema.safeParse(req.body || {});
      const { deleted_by, change_source } = parsed.success
        ? parsed.data
        : { deleted_by: undefined, change_source: undefined };

      const deleted = await withTenantClient(tenantId, async (client) => {
        const result = await client.query<{ deleted: boolean }>(
          `SELECT soft_delete_record($1, $2, $3, $4, $5) as deleted`,
          [tenantId, table, recordId, deleted_by || 'user', change_source || 'local']
        );
        return result.rows[0]?.deleted || false;
      });

      if (!deleted) {
        return reply.status(404).send(
          createErrorResponse({
            who: tenantId,
            what: 'Soft delete record',
            where: `/records/${table}/${recordId}/soft-delete`,
            why: `Record ${recordId} not found in table ${table}, or already deleted`,
            code: 'RECORD_NOT_FOUND',
          })
        );
      }

      logEvent(req, 'record_soft_deleted', {
        table_name: table,
        record_id: recordId,
      });

      return reply.send({ success: true, message: 'Record deleted' });
    }, 'Failed to delete record')
  );

  /**
   * POST /records/:table/:recordId/restore
   * Restore a soft-deleted record
   */
  app.post(
    '/records/:table/:recordId/restore',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): reverses a deletion.
      if (!requireOwnerRole(req, reply)) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { table, recordId } = req.params as { table: string; recordId: string };
      const endpoint = `/records/${table}/${recordId}/restore`;

      const tableError = validateTable(table, tenantId, 'Restore deleted record', endpoint);
      if (tableError) return reply.status(400).send(tableError);

      const { restored_by, change_source } = (req.body || {}) as {
        restored_by?: string;
        change_source?: ChangeSource;
      };

      const restored = await withTenantClient(tenantId, async (client) => {
        const result = await client.query<{ restored: boolean }>(
          `SELECT restore_deleted_record($1, $2, $3, $4, $5) as restored`,
          [tenantId, table, recordId, restored_by || 'user', change_source || 'local']
        );
        return result.rows[0]?.restored || false;
      });

      if (!restored) {
        return reply.status(404).send(
          createErrorResponse({
            who: tenantId,
            what: 'Restore deleted record',
            where: `/records/${table}/${recordId}/restore`,
            why: `Record ${recordId} not found in table ${table}, or record is not deleted`,
            code: 'RECORD_NOT_DELETED',
          })
        );
      }

      logEvent(req, 'record_restored', {
        table_name: table,
        record_id: recordId,
      });

      return reply.send({ success: true, message: 'Record restored' });
    }, 'Failed to restore record')
  );

  /**
   * GET /records/:table/deleted
   * Get list of soft-deleted records for a table
   */
  app.get(
    '/records/:table/deleted',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { table } = req.params as { table: string };
      const { limit, offset } = req.query as { limit?: string; offset?: string };

      const tableError = validateTable(
        table,
        tenantId,
        'Get deleted records',
        `/records/${table}/deleted`
      );
      if (tableError) return reply.status(400).send(tableError);

      const limitNum = Math.min(parseInt(limit || '50'), 200);
      const offsetNum = parseInt(offset || '0');

      const response = await withTenantClient(tenantId, async (client) => {
        // Get count
        const countResult = await client.query(
          `SELECT COUNT(*) as count FROM ${table} WHERE tenant_id = $1 AND is_deleted = true`,
          [tenantId]
        );
        const total = parseInt(countResult.rows[0]?.count || '0');

        // Each versioned table has its own renamed PK column post-pilot-sprint
        // (module-level PK_COLUMN_BY_TABLE) AND its own display columns: only
        // customers/employees have both name+phone; appointments and
        // voice_sessions have neither, services/resources have no phone.
        // Pre-2026-07-01 this SELECT hardcoded t.name/t.phone for every table,
        // which threw 42703 (undefined_column) → 500 on 4 of the 6 supported
        // tables; the mocked unit tests never parse the SQL, so it shipped
        // green (caught by src/versionHistory.realdb.test.ts). Response shape
        // stays {name, phone, email} — values are null for tables without a
        // natural counterpart.
        const pkColumn = PK_COLUMN_BY_TABLE[table];
        const display = (
          {
            customers: { name: 't.name', phone: 't.phone', email: 't.email' },
            appointments: {
              // Appointments have no name column — describe the booking.
              name: `COALESCE(t.description, 'Appointment at ' || t.start_time::text)`,
              phone: 'NULL',
              email: 'NULL',
            },
            voice_sessions: {
              name: 't.call_id',
              phone: 't.caller_phone',
              email: 'NULL',
            },
            employees: { name: 't.name', phone: 't.phone', email: 't.email' },
            services: { name: 't.name', phone: 'NULL', email: 'NULL' },
            resources: { name: 't.name', phone: 'NULL', email: 'NULL' },
          } as Record<string, { name: string; phone: string; email: string }>
        )[table];
        const result = await client.query<DeletedRecord>(
          `SELECT
          t.${pkColumn} AS record_id,
          t.tenant_id,
          '${table}' as table_name,
          ${display.name} AS name,
          ${display.phone} AS phone,
          ${display.email} AS email,
          t.deleted_at,
          t.deleted_by,
          (SELECT COUNT(*) FROM record_versions rv WHERE rv.record_id = t.${pkColumn} AND rv.table_name = '${table}') as version_count,
          (SELECT data FROM record_versions rv WHERE rv.record_id = t.${pkColumn} AND rv.table_name = '${table}'
           ORDER BY version_number DESC LIMIT 1) as last_data
        FROM ${table} t
        WHERE t.tenant_id = $1 AND t.is_deleted = true
        ORDER BY t.deleted_at DESC
        LIMIT $2 OFFSET $3`,
          [tenantId, limitNum, offsetNum]
        );

        return {
          records: result.rows,
          total,
        };
      });

      return reply.send(response);
    }, 'Failed to get deleted records')
  );

  /**
   * POST /records/:table/copy-fields
   * Copy fields from one record to another (including from deleted records)
   */
  app.post(
    '/records/:table/copy-fields',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): overwrites fields on a
      // live record from another record's data.
      if (!requireOwnerRole(req, reply)) return;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { table } = req.params as { table: string };
      const endpoint = `/records/${table}/copy-fields`;
      const operation = 'Copy fields between records';

      const tableError = validateTable(table, tenantId, operation, endpoint);
      if (tableError) return reply.status(400).send(tableError);

      const bodyResult = validateBody(
        CopyFieldsSchema,
        req.body,
        tenantId,
        operation,
        endpoint,
        'source_record_id, target_record_id (UUIDs), and fields (non-empty array) are required'
      );
      if ('error' in bodyResult) return reply.status(400).send(bodyResult.error);

      const { source_record_id, target_record_id, fields, copied_by, change_source } =
        bodyResult.data;

      const result = await withTenantClient(tenantId, async (client) => {
        const copyResult = await client.query<{ data: Record<string, unknown> }>(
          `SELECT copy_fields_between_records($1, $2, $3, $4, $5, $6, $7) as data`,
          [
            tenantId,
            table,
            source_record_id,
            target_record_id,
            fields,
            copied_by || 'user',
            change_source || 'local',
          ]
        );
        return copyResult.rows[0]?.data || null;
      });

      if (!result) {
        return reply.status(500).send(
          createErrorResponse({
            who: tenantId,
            what: 'Copy fields between records',
            where: `/records/${table}/copy-fields`,
            why: `Failed to copy fields from ${source_record_id} to ${target_record_id}. One or both records may not exist.`,
            code: 'COPY_FAILED',
          })
        );
      }

      logEvent(req, 'fields_copied', {
        table_name: table,
        source_record_id,
        target_record_id,
        fields,
      });

      return reply.send({
        success: true,
        data: result,
        message: `Copied ${fields.length} field(s) from ${source_record_id} to ${target_record_id}`,
      });
    }, 'Failed to copy fields')
  );

  /**
   * GET /records/recent-changes
   * Get recent changes across all versioned tables
   */
  app.get(
    '/records/recent-changes',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { limit, offset, table, change_type, change_source } = req.query as {
        limit?: string;
        offset?: string;
        table?: string;
        change_type?: string;
        change_source?: string;
      };

      const limitNum = Math.min(parseInt(limit || '50'), 200);
      const offsetNum = parseInt(offset || '0');

      const response = await withTenantClient(tenantId, async (client) => {
        let whereClause = 'WHERE rv.tenant_id = $1';
        const params: (string | number)[] = [tenantId];
        let paramIndex = 2;

        if (table) {
          whereClause += ` AND rv.table_name = $${paramIndex}`;
          params.push(table);
          paramIndex++;
        }

        if (change_type) {
          whereClause += ` AND rv.change_type = $${paramIndex}`;
          params.push(change_type);
          paramIndex++;
        }

        if (change_source) {
          whereClause += ` AND rv.change_source = $${paramIndex}`;
          params.push(change_source);
          paramIndex++;
        }

        // Get count
        const countResult = await client.query(
          `SELECT COUNT(*) as count FROM record_versions rv ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0]?.count || '0');

        // Get changes
        params.push(limitNum, offsetNum);
        const result = await client.query<RecentChange>(
          `SELECT
          rv.record_version_id,
          rv.tenant_id,
          rv.table_name,
          rv.record_id,
          rv.version_number,
          rv.change_type,
          rv.change_source,
          rv.changed_by,
          rv.change_summary,
          rv.changed_at,
          rv.data->>'name' as record_name,
          rv.data->>'phone' as record_phone
        FROM record_versions rv
        ${whereClause}
        ORDER BY rv.changed_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          params
        );

        return {
          changes: result.rows,
          total,
        };
      });

      return reply.send(response);
    }, 'Failed to get recent changes')
  );

  /**
   * GET /records/:table/:recordId/restore-preview
   * Get preview of all fields with their historical values for restoration UI
   */
  app.get(
    '/records/:table/:recordId/restore-preview',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { table, recordId } = req.params as { table: string; recordId: string };
      const endpoint = `/records/${table}/${recordId}/restore-preview`;

      const tableError = validateTable(table, tenantId, 'Get restore preview', endpoint);
      if (tableError) return reply.status(400).send(tableError);

      const preview = await withTenantClient(tenantId, async (client) => {
        const pkColumn = PK_COLUMN_BY_TABLE[table];
        // Get current record
        const currentResult = await client.query(
          `SELECT to_jsonb(t.*) as data FROM ${table} t WHERE ${pkColumn} = $1 AND tenant_id = $2`,
          [recordId, tenantId]
        );

        if (currentResult.rows.length === 0) {
          return null;
        }

        const currentData = currentResult.rows[0].data;

        // Get all versions
        const versionsResult = await client.query<RecordVersion>(
          `SELECT version_number, data, changed_at, change_source
         FROM record_versions
         WHERE tenant_id = $1 AND table_name = $2 AND record_id = $3
         ORDER BY version_number DESC`,
          [tenantId, table, recordId]
        );

        // Build field options. Exclude the common audit/system columns AND the
        // table's real PK (customer_id, …) via the shared helper — a bare 'id'
        // list would leak the renamed PK into the restorable-field options.
        const fields: Record<string, unknown> = {};
        const excludeFields = excludedSystemFields(table);

        // Get all unique fields from current and historical data
        const allFields = new Set<string>();
        Object.keys(currentData).forEach((k) => allFields.add(k));
        versionsResult.rows.forEach((v) => {
          Object.keys(v.data).forEach((k) => allFields.add(k));
        });

        for (const field of allFields) {
          if (excludeFields.has(field)) continue;

          fields[field] = {
            field,
            current_value: currentData[field],
            versions: versionsResult.rows.map((v) => ({
              version_number: v.version_number,
              value: v.data[field],
              changed_at: v.changed_at,
              change_source: v.change_source,
            })),
          };
        }

        return {
          record_id: recordId,
          table_name: table,
          fields: Object.values(fields),
        };
      });

      if (!preview) {
        return reply.status(404).send(
          createErrorResponse({
            who: tenantId,
            what: 'Get restore preview',
            where: `/records/${table}/${recordId}/restore-preview`,
            why: `Record ${recordId} not found in table ${table}`,
            code: 'RECORD_NOT_FOUND',
          })
        );
      }

      return reply.send(preview);
    }, 'Failed to get restore preview')
  );
}
