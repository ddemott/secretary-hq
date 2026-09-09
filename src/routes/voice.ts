/**
 * Voice Routes - CRM Context for Voice Calls
 *
 * Provides endpoints for:
 * - Starting voice sessions with customer context lookup
 * - Ending voice sessions with outcome tracking
 * - Getting active calls for dashboard
 * - Getting call history
 * - Adding notes to customers from calls
 */

import type { AppFastifyInstance } from '../types/fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  withHandler,
  logEvent,
  requireTenantId,
  type AppRequest,
} from '../middleware/fastify-middleware';
import { assertRowAffected, requireValidUUID } from './routeHelpers';
import { SUPER_ADMIN_TENANT_ID } from '../constants';
import type { CustomerContext, VoiceSession, VoiceSessionDisplay } from '../types/voiceCrm';

const StartSessionSchema = z.object({
  call_id: z.string().min(1),
  caller_phone: z.string().min(1),
});

const EndSessionSchema = z.object({
  call_id: z.string().min(1),
  duration_seconds: z.number().int().min(0).optional(),
  // Accept the LIVE agent vocabulary (booked/transferred + the callClassify "why"
  // classes) AND the legacy vocabulary (backward-compat). Kept in sync with the
  // shared `VoiceSessionOutcome` type. The live agent path is /agent-tools/
  // voice-session-end (outcome: z.string()); this dashboard/manual endpoint used
  // to reject the real strings (e.g. 'booked') with a 400 — now aligned.
  outcome: z
    .enum([
      // Live vocabulary (agent-emitted)
      'booked',
      'transferred',
      'no_availability',
      'wrong_service',
      'price',
      'message',
      'info',
      // Legacy vocabulary (backward-compat only)
      'appointment_booked',
      'appointment_rescheduled',
      'appointment_cancelled',
      'info_provided',
      'voicemail',
      'abandoned',
      'other',
    ])
    .optional(),
  transcript: z.string().optional(),
  summary: z.string().optional(),
  appointment_id: z.string().uuid().optional(),
});

const DeleteOldCallsSchema = z.object({
  // Min 1 day: a 0/negative window would soft-delete every call. Max ~10y cap.
  older_than_days: z.number().int().min(1).max(3650),
});

const AddNoteSchema = z.object({
  customer_id: z.string().uuid(),
  note: z.string().min(1).max(2000),
  note_type: z.enum(['general', 'call', 'preference', 'important']).optional(),
  call_id: z.string().optional(),
});

// Minimal subset of the Socket.IO server surface this module actually calls —
// avoids pulling socket.io as a build-time dep just for the type.
interface SocketIoLike {
  to(room: string): { emit(event: string, payload: unknown): void };
}

/**
 * Clear the owner's KB-gap to-dos that belong to calls just soft-deleted.
 *
 * WHY: the upper-right nav badge counts `unanswered_questions` rows, and an
 * owner who clears their Calls screen reads that badge as "still one thing to
 * handle" for a call they can no longer open (reported 2026-09-09). Resolving
 * the gap with its call keeps the badge honest.
 *
 * NB rows written before 2026-09-09 have a NULL `call_id` — nothing ever wrote
 * it — so they are unreachable from here by design and stay until the owner
 * resolves them on the Phone Assistant tab. Best-effort: a failure here must
 * never turn a successful delete into a 500, so it is caught and returns 0.
 */
async function resolveUnansweredForCalls(
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>,
  tenantId: string,
  callIds: (string | null)[]
): Promise<number> {
  const ids = callIds.filter((c): c is string => Boolean(c));
  if (ids.length === 0) return 0;
  try {
    const res = await withTenantClient(tenantId, (client) =>
      client.query(
        // No RETURNING: the caller wants a COUNT, and rowCount already carries
        // it for an UPDATE. Returning the ids would materialise every resolved
        // row into a payload nothing reads.
        `UPDATE unanswered_questions
            SET resolved = true
          WHERE tenant_id = $1 AND resolved = false AND call_id = ANY($2::text[])`,
        [tenantId, ids]
      )
    );
    return res.rowCount ?? 0;
  } catch {
    return 0;
  }
}

export function registerVoiceRoutes(
  app: AppFastifyInstance,
  pool: Pool,
  withTenantClient: <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>) => Promise<T>,
  io?: SocketIoLike
) {
  /**
   * POST /voice/session/start
   * Start a voice session and get customer context
   *
   * Called by the LiveKit agent when a call starts
   */
  app.post(
    '/voice/session/start',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = StartSessionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Validation failed',
          details: parsed.error.issues,
        });
      }

      const { call_id, caller_phone } = parsed.data;

      const context = await withTenantClient(tenantId, async (client) => {
        // Use the database function to start session and get context
        const result = await client.query<{ context: CustomerContext }>(
          'SELECT start_voice_session($1, $2, $3) as context',
          [tenantId, call_id, caller_phone]
        );
        return result.rows[0]?.context || null;
      });

      if (!context) {
        return reply.status(500).send({
          success: false,
          error: 'Failed to create voice session',
        });
      }

      logEvent(req, 'voice_session_started', {
        call_id,
        caller_phone,
        is_known_customer: context.is_known_customer,
        customer_id: context.customer?.customer_id,
      });

      // Emit real-time event if Socket.IO is available
      if (io) {
        io.to(`tenant:${tenantId}`).emit('call-started', {
          call_id,
          caller_phone,
          customer_context: context,
          timestamp: new Date().toISOString(),
        });
      }

      return reply.send({
        success: true,
        context,
      });
    }, 'Failed to start voice session')
  );

  /**
   * POST /voice/session/end
   * End a voice session with outcome tracking
   *
   * Called by the LiveKit agent when a call ends
   */
  app.post(
    '/voice/session/end',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = EndSessionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Validation failed',
          details: parsed.error.issues,
        });
      }

      const { call_id, duration_seconds, outcome, transcript, summary, appointment_id } =
        parsed.data;

      const ended = await withTenantClient(tenantId, async (client) => {
        const result = await client.query<{ ended: boolean }>(
          'SELECT end_voice_session($1, $2, $3, $4, $5, $6, $7) as ended',
          [
            tenantId,
            call_id,
            duration_seconds || null,
            outcome || null,
            transcript || null,
            summary || null,
            appointment_id || null,
          ]
        );
        return result.rows[0]?.ended || false;
      });

      if (!ended) {
        return reply.status(404).send({
          success: false,
          error: 'Voice session not found',
        });
      }

      logEvent(req, 'voice_session_ended', {
        call_id,
        duration_seconds,
        outcome,
        appointment_id,
      });

      // Emit real-time event
      if (io) {
        io.to(`tenant:${tenantId}`).emit('call-ended', {
          call_id,
          duration_seconds,
          outcome,
          timestamp: new Date().toISOString(),
        });
      }

      return reply.send({ success: true });
    }, 'Failed to end voice session')
  );

  /**
   * GET /voice/session/:callId
   * Get a specific voice session with full context
   */
  app.get(
    '/voice/session/:callId',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { callId } = req.params as { callId: string };

      const session = await withTenantClient(tenantId, async (client) => {
        const result = await client.query<VoiceSession>(
          `SELECT * FROM voice_sessions WHERE tenant_id = $1 AND call_id = $2 AND is_deleted = false`,
          [tenantId, callId]
        );
        return result.rows[0] || null;
      });

      if (!session) {
        return reply.status(404).send({
          success: false,
          error: 'Voice session not found',
        });
      }

      return reply.send(session);
    }, 'Failed to get voice session')
  );

  /**
   * GET /voice/active
   * Get list of active calls for dashboard
   */
  app.get(
    '/voice/active',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const calls = await withTenantClient(tenantId, async (client) => {
        const result = await client.query<VoiceSessionDisplay>(
          `SELECT
          vs.voice_session_id,
          vs.call_id,
          vs.caller_phone,
          vs.customer_id,
          c.name as customer_name,
          vs.status,
          vs.started_at,
          vs.duration_seconds,
          vs.outcome,
          (vs.customer_context->>'is_known_customer')::boolean as is_known_customer
        FROM voice_sessions vs
        LEFT JOIN customers c ON c.customer_id = vs.customer_id
        WHERE vs.tenant_id = $1 AND vs.is_deleted = false AND vs.status = 'active'
        ORDER BY vs.started_at DESC`,
          [tenantId]
        );
        return result.rows;
      });

      return reply.send({
        calls,
        total: calls.length,
      });
    }, 'Failed to get active calls')
  );

  /**
   * GET /voice/history
   * Get call history with optional filters
   */
  app.get(
    '/voice/history',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const query = req.query as {
        customer_id?: string;
        status?: string;
        limit?: string;
        offset?: string;
      };

      // Validate filters before they reach SQL. Unvalidated, `limit=abc`
      // parseInt's to NaN which pg serializes as the string "NaN" → Postgres
      // `invalid input syntax for type bigint` → 500; a non-UUID customer_id
      // → 22P02 → 500. Both must be clean 400s (found 2026-07-01 by the
      // real-DB companion test; the mocked suite couldn't see either).
      const limitRaw = query.limit ?? '50';
      const offsetRaw = query.offset ?? '0';
      if (!/^\d+$/.test(limitRaw) || !/^\d+$/.test(offsetRaw)) {
        return reply
          .status(400)
          .send({ success: false, error: 'limit and offset must be non-negative integers' });
      }
      if (query.customer_id && !requireValidUUID(query.customer_id, reply, 'customer_id')) {
        return;
      }
      const limit = Math.min(parseInt(limitRaw), 200);
      const offset = parseInt(offsetRaw);

      const { calls, total } = await withTenantClient(tenantId, async (client) => {
        let whereClause = 'WHERE vs.tenant_id = $1 AND vs.is_deleted = false';
        const params: (string | number)[] = [tenantId];
        let paramIndex = 2;

        if (query.customer_id) {
          whereClause += ` AND vs.customer_id = $${paramIndex}`;
          params.push(query.customer_id);
          paramIndex++;
        }

        if (query.status) {
          whereClause += ` AND vs.status = $${paramIndex}`;
          params.push(query.status);
          paramIndex++;
        }

        // Get total count
        const countResult = await client.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM voice_sessions vs ${whereClause}`,
          params
        );
        const totalCount = parseInt(countResult.rows[0]?.count || '0');

        // Get sessions
        params.push(limit, offset);
        const result = await client.query<VoiceSession>(
          `SELECT
          vs.*,
          c.name as customer_name
        FROM voice_sessions vs
        LEFT JOIN customers c ON c.customer_id = vs.customer_id
        ${whereClause}
        ORDER BY vs.started_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
          params
        );

        return {
          calls: result.rows,
          total: totalCount,
        };
      });

      return reply.send({
        calls,
        total,
        has_more: offset + calls.length < total,
      });
    }, 'Failed to get call history')
  );

  /**
   * GET /voice/customer/:customerId/context
   * Get full CRM context for a specific customer
   */
  app.get(
    '/voice/customer/:customerId/context',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { customerId } = req.params as { customerId: string };

      const context = await withTenantClient(tenantId, async (client) => {
        // Get customer phone to use with context function
        const customerResult = await client.query<{ phone: string }>(
          'SELECT phone FROM customers WHERE customer_id = $1 AND tenant_id = $2 AND is_deleted = false',
          [customerId, tenantId]
        );

        if (customerResult.rows.length === 0) {
          return null;
        }

        const result = await client.query<{ context: CustomerContext }>(
          'SELECT get_customer_context_for_call($1, $2) as context',
          [tenantId, customerResult.rows[0].phone]
        );
        return result.rows[0]?.context || null;
      });

      if (!context) {
        return reply.status(404).send({
          success: false,
          error: 'Customer not found',
        });
      }

      return reply.send(context);
    }, 'Failed to get customer context')
  );

  /**
   * GET /voice/customer/:customerId/calls
   * Get call history for a specific customer
   */
  app.get(
    '/voice/customer/:customerId/calls',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { customerId } = req.params as { customerId: string };
      const limit = Math.min(parseInt((req.query as { limit?: string }).limit || '20'), 100);

      const calls = await withTenantClient(tenantId, async (client) => {
        const result = await client.query<VoiceSession>(
          `SELECT * FROM voice_sessions
        WHERE tenant_id = $1 AND customer_id = $2 AND is_deleted = false
        ORDER BY started_at DESC
        LIMIT $3`,
          [tenantId, customerId, limit]
        );
        return result.rows;
      });

      return reply.send({ calls });
    }, 'Failed to get customer call history')
  );

  /**
   * POST /voice/customer/note
   * Add a note to a customer record
   */
  app.post(
    '/voice/customer/note',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const parsed = AddNoteSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: 'Validation failed',
          details: parsed.error.issues,
        });
      }

      const { customer_id, note, note_type, call_id } = parsed.data;

      const added = await withTenantClient(tenantId, async (client) => {
        // Verify customer belongs to tenant
        const checkResult = await client.query(
          'SELECT customer_id FROM customers WHERE customer_id = $1 AND tenant_id = $2 AND is_deleted = false',
          [customer_id, tenantId]
        );

        if (checkResult.rows.length === 0) {
          return false;
        }

        const result = await client.query<{ added: boolean }>(
          'SELECT add_customer_note($1, $2, $3, $4) as added',
          [customer_id, note, note_type || 'general', call_id || null]
        );
        return result.rows[0]?.added || false;
      });

      if (!added) {
        return reply.status(404).send({
          success: false,
          error: 'Customer not found',
        });
      }

      logEvent(req, 'customer_note_added', {
        customer_id,
        note_type,
        call_id,
      });

      return reply.send({ success: true });
    }, 'Failed to add customer note')
  );

  /**
   * GET /voice/context/:phone
   * Get customer context by phone number (used by the LiveKit agent's tool layer)
   * This endpoint can be called during a call to enrich AI context
   */
  app.get(
    '/voice/context/:phone',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      const { phone } = req.params as { phone: string };

      const context = await withTenantClient(tenantId, async (client) => {
        const result = await client.query<{ context: CustomerContext }>(
          'SELECT get_customer_context_for_call($1, $2) as context',
          [tenantId, phone]
        );
        return result.rows[0]?.context || null;
      });

      return reply.send(
        context || {
          is_known_customer: false,
          customer: null,
          appointment_history: { total: 0, completed: 0, cancelled: 0, upcoming_appointments: [] },
          notes: [],
          preferences: {},
          tags: [],
        }
      );
    }, 'Failed to get customer context')
  );

  /**
   * GET /voice/messages
   * List customer messages left during voice calls. Owner-facing inbox.
   * Sorted newest-first; optional ?status=new|read|actioned filter.
   */
  app.get(
    '/voice/messages',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      const query = req.query as Record<string, string | undefined>;
      const status = query['status'] ?? null;
      // Same clamp as /voice/job-inquiries: a negative OFFSET 500s, a negative
      // LIMIT is unbounded. Predates this PR; fixed here because it is the same
      // line of code and leaving one of two copies wrong is how they diverge.
      const limit = Math.min(Math.max(parseInt(query['limit'] ?? '') || 50, 1), 200);
      const offset = Math.max(parseInt(query['offset'] ?? '') || 0, 0);

      const rows = await withTenantClient(tenantId, (client) =>
        client.query(
          `SELECT message_id, caller_name, caller_phone, callback_phone, message,
                  status, call_id, created_at, is_urgent
           FROM customer_messages
          WHERE tenant_id = $1
            ${status ? 'AND status = $4' : ''}
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3`,
          status ? [tenantId, limit, offset, status] : [tenantId, limit, offset]
        )
      );
      return reply.send(rows.rows);
    }, 'Failed to fetch messages')
  );

  /**
   * GET /voice/job-inquiries
   *
   * THE LEAD THE OWNER COULD NOT SEE. On 2026-07-27 a recruiter call captured a
   * complete job inquiry — agency, client, role, rate, location — and the call
   * was filed under an outcome that said "message". The Messages inbox was
   * empty, because a job inquiry is not a message; it lived in its own table
   * with NO route, NO API client method and NO screen (CALL_IMPROVEMENTS.md #1).
   * A lead nobody can find is a lead nobody called back.
   *
   * Same shape as /voice/messages so the inbox can render both in one list.
   */
  app.get(
    '/voice/job-inquiries',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      const query = req.query as Record<string, string | undefined>;
      // Clamped, not merely capped: these come straight off a querystring, and
      // a negative OFFSET makes Postgres throw (a 500 from a URL anyone can
      // type) while a negative LIMIT reads as "no limit" — an unbounded scan.
      // Review catch on #314; the same shape was copied from /voice/messages,
      // which is fixed alongside it.
      const limit = Math.min(Math.max(parseInt(query['limit'] ?? '') || 50, 1), 200);
      const offset = Math.max(parseInt(query['offset'] ?? '') || 0, 0);

      const rows = await withTenantClient(tenantId, (client) =>
        client.query(
          `SELECT job_inquiry_id, caller_name, callback_phone, caller_company, client_company,
                  represents_company, employment_type, role_description, rate_range, duration,
                  location_type, address, timezone, call_id, appointment_id, created_at
             FROM job_inquiries
            WHERE tenant_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3`,
          [tenantId, limit, offset]
        )
      );
      return reply.send(rows.rows);
    }, 'Failed to fetch job inquiries')
  );

  /**
   * PATCH /voice/messages/:id
   * Update message status (new → read → actioned).
   */
  app.patch(
    '/voice/messages/:id',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;
      const { id } = req.params as { id: string };
      const body = req.body as { status?: string };
      const VALID = ['new', 'read', 'actioned'];
      if (!body.status || !VALID.includes(body.status)) {
        return reply
          .status(400)
          .send({ success: false, error: 'status must be new, read, or actioned' });
      }
      const res = await withTenantClient(tenantId, (client) =>
        client.query(
          `UPDATE customer_messages SET status = $1
           WHERE message_id = $2 AND tenant_id = $3
           RETURNING message_id`,
          [body.status, id, tenantId]
        )
      );
      if ((res.rowCount ?? 0) === 0) {
        return reply.status(404).send({ success: false, error: 'Message not found' });
      }
      return reply.send({ success: true });
    }, 'Failed to update message status')
  );

  /**
   * DELETE /voice/session/:id
   * Soft-delete a single call record (owner-gated).
   *
   * Sets is_deleted/deleted_at/deleted_by — the row + its caller PII and
   * transcript are RETAINED but hidden from every list + analytics query (all of
   * which filter `is_deleted = false`). Recoverable; this is deliberately NOT a
   * hard DELETE (hard erasure of caller_phone/transcripts is the legal-held
   * GDPR/retention work). Owner-only because call records carry caller PII —
   * mirrors the audit-log / export gating; front-desk logins get 403.
   */
  app.delete(
    '/voice/session/:id',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      // Owner-only (super-admin bypasses). Affirmative gate: anything that is not
      // a proven owner/super-admin is rejected — a request without req.auth is
      // also blocked here, not just front-desk. (requireTenantId already 401s a
      // no-auth request first; this is defense-in-depth.)
      if (!(req.auth?.tenant_id === SUPER_ADMIN_TENANT_ID || req.auth?.role === 'owner')) {
        return reply.status(403).send({ success: false, error: 'Only owners can delete calls' });
      }

      const { id } = req.params as { id: string };
      // voice_session_id is a UUID column; a non-UUID id would throw 22P02 (→500)
      // instead of a clean 404. Validate up front.
      if (!requireValidUUID(id, reply, 'voice_session_id')) return;
      const deletedBy = req.auth?.email ?? 'owner';

      // Exclude active calls: never hide a live/in-progress call out from under the
      // agent (matches the bulk route). An active id → 0 rows → 404.
      const res = await withTenantClient(tenantId, (client) =>
        client.query<{ voice_session_id: string; call_id: string | null }>(
          `UPDATE voice_sessions
              SET is_deleted = true, deleted_at = now(), deleted_by = $3
            WHERE voice_session_id = $1 AND tenant_id = $2 AND is_deleted = false
              AND status != 'active'
            RETURNING voice_session_id, call_id`,
          [id, tenantId, deletedBy]
        )
      );

      if (!assertRowAffected(res, reply, 'Voice session')) return;

      const resolved = await resolveUnansweredForCalls(
        withTenantClient,
        tenantId,
        res.rows.map((r) => r.call_id)
      );

      logEvent(req, 'voice_session_deleted', {
        voice_session_id: id,
        deleted_by: deletedBy,
        unanswered_questions_resolved: resolved,
      });
      return reply.send({ success: true });
    }, 'Failed to delete voice session')
  );

  /**
   * POST /voice/delete-old  { older_than_days }
   * Bulk soft-delete finished call records older than N days (owner-gated).
   *
   * Excludes `status = 'active'` so a live/in-progress call is never deleted out
   * from under the agent. Returns the number of rows soft-deleted. Same
   * owner-gating + recoverable-soft-delete semantics as the single-delete route.
   */
  app.post(
    '/voice/delete-old',
    withHandler(async (req: AppRequest, reply) => {
      const tenantId = requireTenantId(req, reply);
      if (!tenantId) return;

      // Owner-only (super-admin bypasses) — affirmative gate (see single-delete).
      if (!(req.auth?.tenant_id === SUPER_ADMIN_TENANT_ID || req.auth?.role === 'owner')) {
        return reply.status(403).send({ success: false, error: 'Only owners can delete calls' });
      }

      const parsed = DeleteOldCallsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }

      const { older_than_days } = parsed.data;
      const deletedBy = req.auth?.email ?? 'owner';

      const res = await withTenantClient(tenantId, (client) =>
        client.query<{ voice_session_id: string; call_id: string | null }>(
          `UPDATE voice_sessions
              SET is_deleted = true, deleted_at = now(), deleted_by = $3
            WHERE tenant_id = $1
              AND is_deleted = false
              AND status != 'active'
              AND started_at < now() - make_interval(days => $2)
            RETURNING voice_session_id, call_id`,
          [tenantId, older_than_days, deletedBy]
        )
      );

      const deleted = res.rowCount ?? res.rows.length;
      const resolved = await resolveUnansweredForCalls(
        withTenantClient,
        tenantId,
        res.rows.map((r) => r.call_id)
      );
      logEvent(req, 'voice_sessions_bulk_deleted', {
        older_than_days,
        deleted,
        deleted_by: deletedBy,
        unanswered_questions_resolved: resolved,
      });
      return reply.send({ success: true, result: { deleted } });
    }, 'Failed to delete old voice sessions')
  );
}
