/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

import type { AppFastifyInstance } from '../types/fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { SUPER_ADMIN_TENANT_ID } from '../constants';
import {
  withHandler,
  logEvent,
  requireTenantId,
  requireOwnerRole,
  requireSuperAdmin,
  withPoolClient,
  type AppRequest,
} from '../middleware/fastify-middleware';
import { syncAppointmentToAll, syncCustomerToAll } from '../services/syncOrchestrator';
import { assertRowAffected } from './routeHelpers';
import { parseCsv, CsvParseError } from '../services/csv';
import { normalizePhone } from '../../shared/phone';
import { splitName } from '../../shared/name';

const CustomerCreateSchema = z.object({
  tenant_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(30),
  email: z.string().email().optional().nullable(),
  first_name: z.string().max(100).optional().nullable(),
  last_name: z.string().max(100).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  address_line2: z.string().max(500).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  state: z.string().max(100).optional().nullable(),
  postal_code: z.string().max(20).optional().nullable(),
  timezone: z.string().max(50).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  // Optional convenience (folded into metadata by handler, like update path).
  notes: z.string().max(2000).optional().nullable(),
});

/**
 * A BLANK FORM FIELD IS AN EMPTY FIELD, NOT AN INVALID ONE.
 *
 * Reported from production 2026-07-14: "tried to update customer name but it failed."
 * The name was fine. The EMAIL was blank.
 *
 * The edit form submits every field it has, so a customer with no email on file sends
 * `email: ""`. An empty string is neither `undefined` nor `null`, so `.optional()` and
 * `.nullable()` both let it through to `.email()`, which rejects it — and Zod fails the
 * WHOLE request. The rename dies because of a field the owner never touched, with an
 * error about email that they have no way to connect to what they were doing.
 *
 * Same trap as the `??` bug in the agent, in a different costume: an empty string is not
 * "absent", and a UI produces them constantly. `?? ` does not fall through on `""`, and
 * neither does `.nullable()`.
 *
 * So blanks are normalised at the boundary, once, for every optional string: "" (and
 * whitespace) means "no value", which is what the person clearing a text box meant.
 * Doing it in the SCHEMA rather than in the handler means it holds for every client —
 * the dashboard, a future mobile app, a curl — instead of relying on each one to send
 * exactly the right flavour of nothing.
 */
const blankToNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), schema);

/** Same idea for fields that must not be OVERWRITTEN with nothing (phone, name): a
 *  blank means "I did not change this", not "delete it". */
const blankToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

export const CustomerUpdateSchema = z.object({
  // A blank name/phone is "unchanged", not "wipe it" — the handler preserves the
  // current value for anything undefined. Sending "" used to 400 the whole request.
  name: blankToUndefined(z.string().min(1).max(200).optional()),
  phone: blankToUndefined(z.string().min(1).max(30).optional()),
  email: blankToNull(z.string().email().optional().nullable()),
  first_name: blankToNull(z.string().max(100).optional().nullable()),
  last_name: blankToNull(z.string().max(100).optional().nullable()),
  address: blankToNull(z.string().max(500).optional().nullable()),
  address_line2: blankToNull(z.string().max(500).optional().nullable()),
  city: blankToNull(z.string().max(100).optional().nullable()),
  state: blankToNull(z.string().max(100).optional().nullable()),
  postal_code: blankToNull(z.string().max(20).optional().nullable()),
  timezone: blankToNull(z.string().max(50).optional().nullable()),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  // Top-level convenience field used by CRMView (Internal Notes textarea)
  // and E2E tests. Folded into metadata.notes by the handler below so the
  // value ends up in the canonical customers.metadata.notes location used
  // by the booking path and the voice agent context.
  notes: z.string().max(2000).optional().nullable(),
});

const CustomerImportSchema = z.object({
  tenant_id: z.string().uuid().optional(),
  csv: z.string().min(1),
});

/** Hard limits for POST /customers/import (bulk onboarding, not ETL). */
const IMPORT_MAX_BYTES = 1_000_000; // 1 MB of CSV text
const IMPORT_MAX_ROWS = 2000; // data rows (header excluded)
const IMPORT_MAX_ERRORS = 100; // cap the reported per-row error list

/**
 * Liberal header matching for the import CSV: case-insensitive, trimmed,
 * spaces/dashes treated as underscores. Each canonical field lists the
 * header spellings we accept (Excel/Sheets/CRM exports vary wildly).
 */
const IMPORT_HEADER_ALIASES: Record<string, string[]> = {
  name: ['name', 'full_name', 'customer', 'customer_name', 'contact_name'],
  first_name: ['first_name', 'firstname', 'first', 'given_name'],
  last_name: ['last_name', 'lastname', 'last', 'surname', 'family_name'],
  phone: ['phone', 'phone_number', 'mobile', 'cell', 'telephone', 'tel'],
  email: ['email', 'e_mail', 'email_address', 'mail'],
  notes: ['notes', 'note', 'comments', 'comment'],
};

/** Map a raw CSV header row to canonical-field → column-index. */
function matchImportHeaders(headerRow: string[]): Record<string, number> {
  const indexes: Record<string, number> = {};
  headerRow.forEach((raw, i) => {
    const norm = raw
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    for (const [field, aliases] of Object.entries(IMPORT_HEADER_ALIASES)) {
      if (aliases.includes(norm) && !(field in indexes)) {
        indexes[field] = i;
      }
    }
  });
  return indexes;
}

export function registerCustomerRoutes(
  app: AppFastifyInstance,
  pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>
) {
  app.get(
    '/customers',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      const query = req.query as Record<string, string | undefined>;
      const limit = Math.min(parseInt(query['limit'] ?? '') || 200, 1000);
      const offset = parseInt(query['offset'] ?? '') || 0;

      if (tenantId === SUPER_ADMIN_TENANT_ID) {
        // Cross-tenant customer listing — used ONLY by the super-admin
        // "all businesses" scheduling flow (picking a customer to infer
        // which tenant a new appointment belongs to when no tenant is
        // managed yet). requireTenantId already guarantees the caller's own
        // JWT tenant_id IS the super-admin sentinel (tenantMiddleware
        // rejects any other caller trying to pass this id), but a second,
        // explicit opt-in query param is required on top of that: this
        // route used to return every tenant's customer PII (name/phone/
        // email/address/notes) to ANY request that happened to be running
        // with no managed tenant selected, including side-effect fetches
        // that never asked for it — audit finding 2026-09-16. Without the
        // opt-in, respond with an empty list rather than erroring, so an
        // accidental/legacy caller degrades quietly instead of either
        // leaking data or breaking with a scary error banner.
        if (!requireSuperAdmin(req, reply)) return;
        if (query['all_tenants'] !== 'true') {
          return reply.send([]);
        }
        const res = await withPoolClient(pool, (client) =>
          client.query(
            'SELECT * FROM customers WHERE is_deleted = false ORDER BY name LIMIT $1 OFFSET $2',
            [limit, offset]
          )
        );
        return reply.send(res.rows);
      }

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          'SELECT * FROM customers WHERE tenant_id = $1 AND is_deleted = false ORDER BY name LIMIT $2 OFFSET $3',
          [tenantId, limit, offset]
        );
      });
      return reply.send(res.rows);
    }, 'Failed to fetch customers')
  );

  app.post(
    '/customers/create',
    withHandler(async (req: AppRequest, reply) => {
      const parsed = CustomerCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const body = parsed.data;

      // Fold optional top-level notes into metadata for the canonical storage location.
      const createMetadata =
        body.notes !== undefined
          ? { ...(body.metadata || {}), notes: body.notes }
          : body.metadata || {};

      const res = await withTenantClient(body.tenant_id, async (client) => {
        return client.query(
          `INSERT INTO customers (
           tenant_id, name, phone, email, address, address_line2,
           city, state, postal_code, metadata, first_name, last_name, timezone
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            body.tenant_id,
            body.name,
            body.phone,
            body.email || null,
            body.address || null,
            body.address_line2 || null,
            body.city || null,
            body.state || null,
            body.postal_code || null,
            createMetadata,
            body.first_name || null,
            body.last_name || null,
            body.timezone || 'America/New_York',
          ]
        );
      });

      logEvent(req, 'customer_created', { customerId: res.rows[0].customer_id, name: body.name });
      // Fire-and-forget CRM sync
      syncCustomerToAll(pool, body.tenant_id, res.rows[0].customer_id, 'create', req.log);
      return reply.send({ success: true, customer: res.rows[0] });
    }, 'Failed to create customer')
  );

  // POST /customers/import — bulk CSV onboarding (docs/GAPS.md §6).
  // Body is JSON `{ csv }` (no multipart dependency); the dashboard reads the
  // file client-side via FileReader. Owner-gated: bulk PII writes are not a
  // front-desk operation. Per row: validate + normalizePhone, skip+report
  // invalid rows, dedupe against existing tenant customers AND within the
  // file by normalized phone, insert the rest in one transaction.
  app.post(
    '/customers/import',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      // Owner-only: bulk PII writes are not a front-desk operation. NB
      // exportData.ts's own owner gate (`requireOwnerForExport`) is a
      // separate, not-yet-consolidated inline check with different wording
      // — it is NOT this shared guard, despite the similar intent.
      if (!requireOwnerRole(req, reply)) return;

      const parsed = CustomerImportSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const { csv } = parsed.data;

      if (Buffer.byteLength(csv, 'utf8') > IMPORT_MAX_BYTES) {
        return reply.status(400).send({
          success: false,
          error: `CSV too large — the limit is ${IMPORT_MAX_BYTES / 1_000_000} MB. Split the file and import in parts.`,
        });
      }

      let records: string[][];
      try {
        records = parseCsv(csv);
      } catch (err) {
        if (err instanceof CsvParseError) {
          return reply.status(400).send({ success: false, error: `Malformed CSV: ${err.message}` });
        }
        throw err;
      }

      if (records.length < 2) {
        return reply.status(400).send({
          success: false,
          error: 'CSV must have a header row and at least one data row',
        });
      }

      const [headerRow, ...dataRows] = records;
      if (dataRows.length > IMPORT_MAX_ROWS) {
        return reply.status(400).send({
          success: false,
          error: `Too many rows — the limit is ${IMPORT_MAX_ROWS} data rows per import (got ${dataRows.length}). Split the file and import in parts.`,
        });
      }

      const cols = matchImportHeaders(headerRow);
      if (cols.phone === undefined) {
        return reply.status(400).send({
          success: false,
          error:
            'CSV is missing a phone column (accepted headers: phone, phone_number, mobile, cell, telephone)',
        });
      }
      if (cols.name === undefined && cols.first_name === undefined) {
        return reply.status(400).send({
          success: false,
          error:
            'CSV is missing a name column (accepted headers: name, full_name, customer_name, or first_name/last_name)',
        });
      }

      // Validate + normalize every row BEFORE touching the DB.
      const cell = (row: string[], idx: number | undefined): string =>
        idx === undefined ? '' : (row[idx] ?? '').trim();
      const errors: { row: number; reason: string }[] = [];
      const seenPhones = new Set<string>();
      const candidates: {
        row: number;
        name: string;
        first_name: string | null;
        last_name: string | null;
        phone: string;
        email: string | null;
        notes: string | null;
      }[] = [];
      let inFileDuplicates = 0;

      dataRows.forEach((row, i) => {
        // Row numbers reported to the owner count the header as row 1, so the
        // first data row is 2 — matching what they see in Excel/Sheets.
        const rowNum = i + 2;
        // Skip rows that are entirely blank cells (common trailing junk).
        if (row.every((c) => c.trim() === '')) return;

        let name = cell(row, cols.name);
        const firstRaw = cell(row, cols.first_name);
        const lastRaw = cell(row, cols.last_name);
        if (!name) name = [firstRaw, lastRaw].filter(Boolean).join(' ');
        if (!name) {
          errors.push({ row: rowNum, reason: 'missing name' });
          return;
        }
        const { firstName, lastName } = firstRaw
          ? { firstName: firstRaw, lastName: lastRaw }
          : splitName(name);

        const phoneRaw = cell(row, cols.phone);
        const phone = normalizePhone(phoneRaw);
        if (!phone) {
          errors.push({
            row: rowNum,
            reason: phoneRaw ? `invalid phone "${phoneRaw}"` : 'missing phone',
          });
          return;
        }

        const emailRaw = cell(row, cols.email);
        if (emailRaw && !z.string().email().safeParse(emailRaw).success) {
          errors.push({ row: rowNum, reason: `invalid email "${emailRaw}"` });
          return;
        }

        if (seenPhones.has(phone)) {
          inFileDuplicates++;
          return;
        }
        seenPhones.add(phone);

        candidates.push({
          row: rowNum,
          name,
          first_name: firstName || null,
          last_name: lastName || null,
          phone,
          email: emailRaw || null,
          notes: cell(row, cols.notes) || null,
        });
      });

      // Dedupe against existing (non-deleted) tenant customers by normalized
      // phone, then insert the remainder in one transaction — an import is
      // all-or-nothing for the rows that made it past validation.
      const { imported, existingDuplicates } = await withTenantClient(tenantId, async (client) => {
        const existingRes = await client.query<{ phone: string }>(
          'SELECT phone FROM customers WHERE tenant_id = $1 AND is_deleted = false',
          [tenantId]
        );
        const existingPhones = new Set(
          existingRes.rows.map((r) => normalizePhone(r.phone) ?? r.phone)
        );

        const toInsert = candidates.filter((c) => !existingPhones.has(c.phone));
        const dupCount = candidates.length - toInsert.length;
        if (toInsert.length === 0) return { imported: 0, existingDuplicates: dupCount };

        await client.query('BEGIN');
        try {
          // Multi-row inserts in batches (7 params/row keeps us far under the
          // 65535 bind-parameter cap even at the 2000-row limit).
          const BATCH = 500;
          for (let start = 0; start < toInsert.length; start += BATCH) {
            const batch = toInsert.slice(start, start + BATCH);
            const values: unknown[] = [];
            const tuples = batch.map((c, j) => {
              const base = j * 7;
              values.push(
                tenantId,
                c.name,
                c.first_name,
                c.last_name,
                c.phone,
                c.email,
                c.notes ? { notes: c.notes } : {}
              );
              return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
            });
            await client.query(
              `INSERT INTO customers (tenant_id, name, first_name, last_name, phone, email, metadata)
               VALUES ${tuples.join(',')}`,
              values
            );
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
        return { imported: toInsert.length, existingDuplicates: dupCount };
      });

      const skippedDuplicates = inFileDuplicates + existingDuplicates;
      logEvent(req, 'customers_imported', {
        tenantId,
        imported,
        skippedDuplicates,
        errorCount: errors.length,
        totalRows: dataRows.length,
      });
      // NOTE: no per-row CRM sync dispatch here (unlike POST /customers/create).
      // Firing up to 2000 fire-and-forget syncOrchestrator calls would saturate
      // the 10-slot pool; bulk import is an onboarding operation and connected
      // CRMs pick the rows up on their next full sync.
      return reply.send({
        success: true,
        imported,
        skipped_duplicates: skippedDuplicates,
        total_rows: dataRows.length,
        errors: errors.slice(0, IMPORT_MAX_ERRORS),
        errors_truncated: errors.length > IMPORT_MAX_ERRORS,
      });
    }, 'Failed to import customers')
  );

  app.put(
    '/customers/:id',
    withHandler(async (req: AppRequest, reply) => {
      const { id } = req.params as { id: string };
      const parsed = CustomerUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const body = parsed.data;
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        // Read current row first so we can support partial patches (e.g. the
        // E2E test helper that sends only {tenant_id, notes}) and the real
        // UI path that sends a mix of current field values + top-level notes.
        // Without this, omitting fields would null them out (data corruption).
        const currentQ = await client.query(
          `SELECT name, phone, email, first_name, last_name, address, address_line2,
                  city, state, postal_code, metadata, timezone
             FROM customers
            WHERE customer_id = $1 AND tenant_id = $2`,
          [id, tenantId]
        );
        if (currentQ.rowCount === 0) {
          return { rowCount: 0 } as any;
        }
        const cur = currentQ.rows[0];

        // Merge notes convenience field into metadata (preserve other keys).
        let finalMetadata: Record<string, unknown> =
          body.metadata !== undefined
            ? (body.metadata as Record<string, unknown>)
            : cur.metadata || {};
        if (body.notes !== undefined) {
          finalMetadata = { ...finalMetadata, notes: body.notes };
        }

        // Use COALESCE-style preservation for omitted scalar fields (partial update safety).
        const finalName = body.name !== undefined ? body.name : cur.name;
        const finalPhone = body.phone !== undefined ? body.phone : cur.phone;
        const finalEmail = body.email !== undefined ? body.email : cur.email;
        const finalFirst = body.first_name !== undefined ? body.first_name : cur.first_name;
        const finalLast = body.last_name !== undefined ? body.last_name : cur.last_name;
        const finalAddr = body.address !== undefined ? body.address : cur.address;
        const finalAddr2 =
          body.address_line2 !== undefined ? body.address_line2 : cur.address_line2;
        const finalCity = body.city !== undefined ? body.city : cur.city;
        const finalState = body.state !== undefined ? body.state : cur.state;
        const finalPostal = body.postal_code !== undefined ? body.postal_code : cur.postal_code;
        const finalTz =
          body.timezone !== undefined ? body.timezone : cur.timezone || 'America/New_York';

        return client.query(
          `UPDATE customers SET
             first_name = $1, last_name = $2, name = $3, phone = $4, email = $5,
             address = $6, address_line2 = $7, city = $8, state = $9,
             postal_code = $10, metadata = $11, timezone = $12
           WHERE customer_id = $13 AND tenant_id = $14 RETURNING customer_id`,
          [
            finalFirst || null,
            finalLast || null,
            finalName || null,
            finalPhone,
            finalEmail,
            finalAddr,
            finalAddr2 || null,
            finalCity || null,
            finalState || null,
            finalPostal || null,
            finalMetadata,
            finalTz,
            id,
            tenantId,
          ]
        );
      });
      if (!assertRowAffected(res, reply, 'Customer')) return;

      logEvent(req, 'customer_updated', { customerId: id });
      // Fire-and-forget CRM sync
      syncCustomerToAll(pool, tenantId, id, 'update', req.log);
      return reply.send({ success: true });
    }, 'Failed to update customer')
  );

  // GET /customers/:id/appointments - all appointments for a specific customer
  app.get(
    '/customers/:id/appointments',
    withHandler(async (req: AppRequest, reply) => {
      const { id } = req.params as { id: string };
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const res = await withTenantClient(tenantId, async (client) => {
        return client.query(
          `SELECT a.appointment_id, a.start_time, a.end_time, a.status, a.description, a.location,
                r.name as resource_name,
                e.name as employee_name
         FROM appointments a
         LEFT JOIN resources r ON r.resource_id = a.resource_id
         LEFT JOIN employees e ON e.employee_id = a.employee_id
         WHERE a.customer_id = $1 AND a.tenant_id = $2 AND a.is_deleted = false
         ORDER BY a.start_time DESC`,
          [id, tenantId]
        );
      });
      return reply.send(res.rows);
    }, 'Failed to fetch customer appointments')
  );

  app.delete(
    '/customers/:id',
    withHandler(async (req: AppRequest, reply) => {
      // Owner-only (mirrors /customers/import): a destructive,
      // appointment-cancelling action is not a front-desk operation.
      if (!requireOwnerRole(req, reply)) return;
      const { id } = req.params as { id: string };
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      // Soft-delete (set is_deleted) rather than a hard DELETE. A hard delete
      // (a) failed with a 23503 FK violation whenever the customer had
      // customer_messages / job_inquiries rows (those FKs are NO ACTION), which
      // surfaced to the owner as "deleting customers isn't working", and (b) even
      // when it succeeded it CASCADE-removed the customer's appointments +
      // call_summaries, destroying history. Soft-delete hides the customer from
      // every list (they all filter is_deleted = false) while preserving records.
      const deletedBy = req.auth?.email ?? 'user';
      // Soft-delete + upcoming-cancel in ONE transaction. The list/schedule
      // queries join customers WHERE is_deleted = false, so a deleted
      // customer's future 'scheduled' rows would become INVISIBLE while still
      // holding their slot (they feed the GiST exclusion constraints) — an
      // unbookable, uncancelable ghost. Cancel the upcoming ones (frees the
      // slot); keep past/completed for history/analytics.
      const { res, canceledAppointments } = await withTenantClient(tenantId, async (client) => {
        await client.query('BEGIN');
        try {
          const del = await client.query(
            `UPDATE customers
                SET is_deleted = true, deleted_at = now(), deleted_by = $3
              WHERE customer_id = $1 AND tenant_id = $2 AND is_deleted = false
              RETURNING customer_id`,
            [id, tenantId, deletedBy]
          );
          let canceled: string[] = [];
          if (del.rows.length > 0) {
            const c = await client.query<{ appointment_id: string }>(
              `UPDATE appointments
                  SET status = 'canceled'
                WHERE customer_id = $1 AND tenant_id = $2
                  AND status = 'scheduled'
                  AND start_time > now()
                  AND (is_deleted IS NULL OR is_deleted = false)
                RETURNING appointment_id`,
              [id, tenantId]
            );
            canceled = c.rows.map((r) => r.appointment_id);
          }
          await client.query('COMMIT');
          return { res: del, canceledAppointments: canceled };
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      });
      if (!assertRowAffected(res, reply, 'Customer')) return;

      // Fire-and-forget CRM sync AFTER confirming a row was actually soft-deleted
      // — otherwise a 404 (missing / already-deleted customer) would still
      // dispatch a spurious delete to the CRM. Safe to run after the write
      // because soft-delete leaves the row readable (unlike the old hard DELETE,
      // which forced the sync to run first).
      syncCustomerToAll(pool, tenantId, id, 'delete', req.log);
      // Mirror POST /appointments/:id/cancel: a canceled appointment must also
      // leave external calendars/CRMs so the slot frees everywhere.
      for (const apptId of canceledAppointments) {
        syncAppointmentToAll(pool, tenantId, apptId, 'delete', req.log);
      }

      logEvent(req, 'customer_deleted', {
        customerId: id,
        canceledAppointmentCount: canceledAppointments.length,
      });
      return reply.send({ success: true });
    }, 'Failed to delete customer')
  );
}
