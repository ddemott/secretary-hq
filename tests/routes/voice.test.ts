import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { registerVoiceRoutes } from '../../src/routes/voice';
import { createMockClient, createMockPool, createMockWithTenantClient } from '../mock';

// --- Constants ---
const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CUSTOMER_ID = '11111111-2222-3333-8444-555555555555'; // Valid UUID format (4th segment starts with 8)
const CALL_ID = 'call-abc-123';

// --- App builder ---

let app: FastifyInstance;
let mockClient: ReturnType<typeof createMockClient>['mockClient'];
let queryResponses: ReturnType<typeof createMockClient>['queryResponses'];
let mockPool: Pool;

// Test-only request shape: the preHandler injects tenantId (and optionally an
// auth identity, for owner-gated routes) for the route to read.
type TenantRequest = FastifyRequest & {
  tenantId?: string;
  auth?: { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
};

function buildApp() {
  const created = createMockClient();
  mockClient = created.mockClient;
  queryResponses = created.queryResponses;

  mockPool = createMockPool(mockClient);
  const mockWithTenantClient = createMockWithTenantClient(mockClient);

  const fastify = Fastify({ logger: false });

  // Simulate tenant middleware: inject tenantId from query param or header
  fastify.addHook('preHandler', async (request: TenantRequest) => {
    const tenantId =
      (request.query as Record<string, string>)?.tenant_id ||
      (request.headers['x-tenant-id'] as string);
    if (tenantId) {
      request.tenantId = tenantId;
    }
    // Owner-gated routes read req.auth.role. Inject it from x-role when present
    // so tests can exercise owner vs front_desk; absent header → no auth (the
    // existing tests don't set it and must keep passing).
    const role = request.headers['x-role'] as 'owner' | 'front_desk' | undefined;
    if (role && tenantId) {
      request.auth = {
        tenant_id: tenantId,
        user_id: '99999999-9999-4999-8999-999999999999',
        email: 'tester@example.com',
        role,
      };
    }
  });

  registerVoiceRoutes(fastify, mockPool, mockWithTenantClient);

  return fastify;
}

// --- Setup / teardown ---

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  queryResponses.length = 0;
});

// =============================================
// HAPPY PATHS
// =============================================

describe('Voice Routes — Happy Paths', () => {
  it('1. POST /voice/session/start returns customer context for known customer', async () => {
    const mockContext = {
      is_known_customer: true,
      customer: {
        id: CUSTOMER_ID,
        name: 'John Doe',
        phone: '+1-555-123-4567',
        email: 'john@example.com',
        address: '123 Main St',
        created_at: '2026-01-15T10:00:00Z',
      },
      appointment_history: {
        total: 5,
        completed: 4,
        cancelled: 1,
        last_appointment: {
          id: 'appt-1',
          start_time: '2026-04-01T14:00:00Z',
          end_time: '2026-04-01T15:00:00Z',
          status: 'completed',
          description: 'Haircut',
          resource_name: 'Chair 1',
          employee_name: 'Jane Smith',
        },
        upcoming_appointments: [],
      },
      notes: [
        {
          id: 'note-1',
          text: 'Prefers morning appointments',
          type: 'preference',
          created_at: '2026-02-01T10:00:00Z',
        },
      ],
      preferences: { preferred_time: 'morning' },
      tags: ['VIP', 'regular'],
      member_since: '2025-06-15T00:00:00Z',
    };

    // Mock start_voice_session function response
    queryResponses.push({ rows: [{ context: mockContext }] });

    const res = await app.inject({
      method: 'POST',
      url: `/voice/session/start?tenant_id=${TENANT_ID}`,
      payload: {
        call_id: CALL_ID,
        caller_phone: '+1-555-123-4567',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.context.is_known_customer).toBe(true);
    expect(body.context.customer.name).toBe('John Doe');
    expect(body.context.appointment_history.total).toBe(5);
    expect(body.context.notes).toHaveLength(1);
    expect(body.context.tags).toContain('VIP');
  });

  it('2. POST /voice/session/start returns context for unknown caller', async () => {
    const mockContext = {
      is_known_customer: false,
      customer: null,
      appointment_history: {
        total: 0,
        completed: 0,
        cancelled: 0,
        last_appointment: null,
        upcoming_appointments: [],
      },
      notes: [],
      preferences: {},
      tags: [],
    };

    queryResponses.push({ rows: [{ context: mockContext }] });

    const res = await app.inject({
      method: 'POST',
      url: `/voice/session/start?tenant_id=${TENANT_ID}`,
      payload: {
        call_id: 'call-new-123',
        caller_phone: '+1-555-999-0000',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.context.is_known_customer).toBe(false);
    expect(body.context.customer).toBeNull();
  });

  it('3. POST /voice/session/end successfully ends session', async () => {
    // Mock end_voice_session function response
    queryResponses.push({ rows: [{ ended: true }] });

    const res = await app.inject({
      method: 'POST',
      url: `/voice/session/end?tenant_id=${TENANT_ID}`,
      payload: {
        call_id: CALL_ID,
        duration_seconds: 180,
        outcome: 'appointment_booked',
        transcript: 'Customer: I would like to book...',
        summary: 'Customer booked haircut for Friday at 2pm',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
  });

  it('4. GET /voice/session/:callId returns session details', async () => {
    const mockSession = {
      id: 'session-uuid-1',
      tenant_id: TENANT_ID,
      call_id: CALL_ID,
      caller_phone: '+1-555-123-4567',
      customer_id: CUSTOMER_ID,
      customer_context: { is_known_customer: true },
      status: 'completed',
      started_at: '2026-04-09T10:00:00Z',
      ended_at: '2026-04-09T10:03:00Z',
      duration_seconds: 180,
      transcript: 'Customer: Hello...',
      summary: 'Appointment booked',
      outcome: 'appointment_booked',
      appointment_id: 'appt-1',
      metadata: {},
      created_at: '2026-04-09T10:00:00Z',
      updated_at: '2026-04-09T10:03:00Z',
    };

    queryResponses.push({ rows: [mockSession] });

    const res = await app.inject({
      method: 'GET',
      url: `/voice/session/${CALL_ID}?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.call_id).toBe(CALL_ID);
    expect(body.customer_id).toBe(CUSTOMER_ID);
    expect(body.status).toBe('completed');
    expect(body.duration_seconds).toBe(180);
  });

  it('5. GET /voice/active returns list of active calls', async () => {
    const mockActiveCalls = [
      {
        id: 'session-1',
        call_id: 'call-1',
        caller_phone: '+1-555-111-1111',
        customer_id: CUSTOMER_ID,
        customer_name: 'John Doe',
        status: 'active',
        started_at: '2026-04-09T10:00:00Z',
        duration_seconds: null,
        outcome: null,
        is_known_customer: true,
      },
      {
        id: 'session-2',
        call_id: 'call-2',
        caller_phone: '+1-555-222-2222',
        customer_id: null,
        customer_name: null,
        status: 'active',
        started_at: '2026-04-09T10:01:00Z',
        duration_seconds: null,
        outcome: null,
        is_known_customer: false,
      },
    ];

    queryResponses.push({ rows: mockActiveCalls });

    const res = await app.inject({
      method: 'GET',
      url: `/voice/active?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.calls).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.calls[0].customer_name).toBe('John Doe');
    expect(body.calls[1].is_known_customer).toBe(false);
  });

  it('6. GET /voice/history returns paginated call history', async () => {
    const mockHistory = [
      {
        id: 'session-1',
        call_id: 'call-old-1',
        caller_phone: '+1-555-111-1111',
        status: 'completed',
        started_at: '2026-04-08T10:00:00Z',
        duration_seconds: 120,
        outcome: 'appointment_booked',
        customer_name: 'John Doe',
      },
    ];

    // Count query
    queryResponses.push({ rows: [{ count: '25' }] });
    // Sessions query
    queryResponses.push({ rows: mockHistory });

    const res = await app.inject({
      method: 'GET',
      url: `/voice/history?tenant_id=${TENANT_ID}&limit=10&offset=0`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.calls).toHaveLength(1);
    expect(body.total).toBe(25);
    expect(body.has_more).toBe(true);
  });

  it('7. GET /voice/history filters by customer_id', async () => {
    queryResponses.push({ rows: [{ count: '5' }] });
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/voice/history?tenant_id=${TENANT_ID}&customer_id=${CUSTOMER_ID}`,
    });

    expect(res.statusCode).toBe(200);

    // Verify the query included customer_id filter
    const countQuery = mockClient.query.mock.calls[0][0] as string;
    expect(countQuery).toContain('customer_id');
  });

  it('8a. GET /voice/customer/:customerId/context filters soft-deleted customers in phone lookup', async () => {
    // WHO: Voice agent fetching CRM context for a customer the dashboard
    //      already soft-deleted (is_deleted = true).
    // WHAT: The phone lookup must include `is_deleted = false`; otherwise
    //      we'd hand the agent a phone for a deleted record and call
    //      get_customer_context_for_call() with stale data.
    // WHERE: src/routes/voice.ts:321 — the SELECT phone FROM customers query.
    // WHEN: Every /voice/customer/:customerId/context request, before the
    //       context-builder RPC fires.
    // WHY: BUG-038 partial fix — soft-deletable tables must filter is_deleted
    //      in SELECT to avoid leaking deleted records into voice flows.
    queryResponses.push({ rows: [{ phone: '+1-555-123-4567' }] });
    queryResponses.push({
      rows: [
        {
          context: {
            is_known_customer: true,
            customer: null,
            appointment_history: {
              total: 0,
              completed: 0,
              cancelled: 0,
              last_appointment: null,
              upcoming_appointments: [],
            },
            notes: [],
            preferences: {},
            tags: [],
          },
        },
      ],
    });

    await app.inject({
      method: 'GET',
      url: `/voice/customer/${CUSTOMER_ID}/context?tenant_id=${TENANT_ID}`,
    });

    const phoneLookupSql = mockClient.query.mock.calls[0][0] as string;
    expect(phoneLookupSql).toContain('FROM customers');
    expect(phoneLookupSql).toContain('is_deleted = false');
  });

  it('8. GET /voice/customer/:customerId/context returns CRM context', async () => {
    const mockContext = {
      is_known_customer: true,
      customer: {
        id: CUSTOMER_ID,
        name: 'John Doe',
        phone: '+1-555-123-4567',
        email: 'john@example.com',
        address: '123 Main St',
        created_at: '2026-01-15T10:00:00Z',
      },
      appointment_history: {
        total: 3,
        completed: 2,
        cancelled: 1,
        last_appointment: null,
        upcoming_appointments: [],
      },
      notes: [],
      preferences: {},
      tags: ['regular'],
    };

    // Customer phone lookup
    queryResponses.push({ rows: [{ phone: '+1-555-123-4567' }] });
    // Context function
    queryResponses.push({ rows: [{ context: mockContext }] });

    const res = await app.inject({
      method: 'GET',
      url: `/voice/customer/${CUSTOMER_ID}/context?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.is_known_customer).toBe(true);
    expect(body.customer.id).toBe(CUSTOMER_ID);
  });

  it('9. GET /voice/customer/:customerId/calls returns customer call history', async () => {
    const mockCalls = [
      {
        id: 'session-1',
        call_id: 'call-1',
        caller_phone: '+1-555-123-4567',
        customer_id: CUSTOMER_ID,
        status: 'completed',
        started_at: '2026-04-09T10:00:00Z',
        duration_seconds: 120,
        outcome: 'appointment_booked',
      },
    ];

    queryResponses.push({ rows: mockCalls });

    const res = await app.inject({
      method: 'GET',
      url: `/voice/customer/${CUSTOMER_ID}/calls?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0].customer_id).toBe(CUSTOMER_ID);
  });

  it('10a. POST /voice/customer/note filters soft-deleted customers in existence check', async () => {
    // WHO: Voice agent attempting to attach a note to a customer that was
    //      soft-deleted between when the agent loaded the customer and now.
    // WHAT: The customer-existence check must reject soft-deleted rows; the
    //      add_customer_note RPC would otherwise tag a tombstoned record.
    // WHERE: src/routes/voice.ts:393 — the SELECT id FROM customers query.
    // WHEN: Every POST /voice/customer/note, before invoking add_customer_note.
    // WHY: Prevents notes from being attached to deleted customers, which
    //      would hide audit trail in the dashboard (deleted view excludes
    //      them from default filters).
    queryResponses.push({ rows: [{ customer_id: CUSTOMER_ID }] });
    queryResponses.push({ rows: [{ added: true }] });

    await app.inject({
      method: 'POST',
      url: `/voice/customer/note?tenant_id=${TENANT_ID}`,
      payload: { customer_id: CUSTOMER_ID, note: 'Likes morning slots', note_type: 'preference' },
    });

    const existenceCheckSql = mockClient.query.mock.calls[0][0] as string;
    expect(existenceCheckSql).toContain('FROM customers');
    expect(existenceCheckSql).toContain('is_deleted = false');
  });

  it('10. POST /voice/customer/note adds note to customer', async () => {
    // Customer exists check
    queryResponses.push({ rows: [{ customer_id: CUSTOMER_ID }] });
    // add_customer_note function
    queryResponses.push({ rows: [{ added: true }] });

    const res = await app.inject({
      method: 'POST',
      url: `/voice/customer/note?tenant_id=${TENANT_ID}`,
      payload: {
        customer_id: CUSTOMER_ID,
        note: 'Customer prefers early morning appointments',
        note_type: 'preference',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
  });

  it('11. GET /voice/context/:phone returns context by phone', async () => {
    const mockContext = {
      is_known_customer: true,
      customer: {
        id: CUSTOMER_ID,
        name: 'John Doe',
        phone: '+1-555-123-4567',
        email: 'john@example.com',
        address: null,
        created_at: '2026-01-15T10:00:00Z',
      },
      appointment_history: {
        total: 2,
        completed: 2,
        cancelled: 0,
        last_appointment: null,
        upcoming_appointments: [],
      },
      notes: [],
      preferences: {},
      tags: [],
    };

    queryResponses.push({ rows: [{ context: mockContext }] });

    const res = await app.inject({
      method: 'GET',
      url: `/voice/context/+1-555-123-4567?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.is_known_customer).toBe(true);
    expect(body.customer.phone).toBe('+1-555-123-4567');
  });

  it('12. GET /voice/context/:phone returns empty context for unknown phone', async () => {
    // No customer found - null context
    queryResponses.push({ rows: [{ context: null }] });

    const res = await app.inject({
      method: 'GET',
      url: `/voice/context/+1-555-000-0000?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.is_known_customer).toBe(false);
    expect(body.customer).toBeNull();
  });
});

// =============================================
// SAD PATHS
// =============================================

describe('Voice Routes — Sad Paths', () => {
  it('13. POST /voice/session/start returns 400 on missing call_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/voice/session/start?tenant_id=${TENANT_ID}`,
      payload: {
        caller_phone: '+1-555-123-4567',
        // call_id missing
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Validation failed');
  });

  it('14. POST /voice/session/start returns 400 on missing caller_phone', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/voice/session/start?tenant_id=${TENANT_ID}`,
      payload: {
        call_id: CALL_ID,
        // caller_phone missing
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Validation failed');
  });

  it('15. POST /voice/session/start returns 401 when unauthenticated (no tenant context)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/voice/session/start',
      payload: {
        call_id: CALL_ID,
        caller_phone: '+1-555-123-4567',
      },
    });

    // 2026-05-21: no auth context → 401 (authentication is the real failure),
    // not the old misleading 400.
    expect(res.statusCode).toBe(401);
  });

  it('16. POST /voice/session/end returns 400 on invalid outcome', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/voice/session/end?tenant_id=${TENANT_ID}`,
      payload: {
        call_id: CALL_ID,
        outcome: 'invalid_outcome',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Validation failed');
  });

  // WHO/WHAT: the dashboard/manual /voice/session/end endpoint. WHEN: any caller
  // sends the outcome string the AGENT actually writes (callOutcome/callClassify
  // vocabulary — `booked`, `no_availability`, etc.). WHERE: EndSessionSchema enum
  // in src/routes/voice.ts. WHY: the enum used to accept ONLY the legacy
  // `appointment_booked`/`info_provided`/`voicemail`/`abandoned`/`other` vocabulary
  // — disjoint from the live agent strings — so a real `booked` outcome 400'd. This
  // pins the additive alignment so the live vocab is accepted (legacy still valid).
  it('16b. POST /voice/session/end accepts the live agent outcome vocabulary', async () => {
    for (const outcome of [
      'booked',
      'no_availability',
      'wrong_service',
      'price',
      'message',
      'info',
    ]) {
      queryResponses.push({ rows: [{ ended: true }] });
      const res = await app.inject({
        method: 'POST',
        url: `/voice/session/end?tenant_id=${TENANT_ID}`,
        payload: { call_id: CALL_ID, outcome },
      });
      expect(res.statusCode, `outcome "${outcome}" should be accepted`).toBe(200);
      expect(res.json().success).toBe(true);
    }
  });

  it('17. POST /voice/session/end returns 404 on non-existent session', async () => {
    // end_voice_session returns false
    queryResponses.push({ rows: [{ ended: false }] });

    const res = await app.inject({
      method: 'POST',
      url: `/voice/session/end?tenant_id=${TENANT_ID}`,
      payload: {
        call_id: 'nonexistent-call',
      },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Voice session not found');
  });

  it('18. GET /voice/session/:callId returns 404 on non-existent session', async () => {
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/voice/session/nonexistent-call?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Voice session not found');
  });

  it('19. GET /voice/customer/:customerId/context returns 404 for non-existent customer', async () => {
    // Customer lookup returns empty
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/voice/customer/${CUSTOMER_ID}/context?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Customer not found');
  });

  it('20. POST /voice/customer/note returns 400 on invalid customer_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/voice/customer/note?tenant_id=${TENANT_ID}`,
      payload: {
        customer_id: 'not-a-uuid',
        note: 'Test note',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Validation failed');
  });

  it('21. POST /voice/customer/note returns 404 for non-existent customer', async () => {
    // Customer does not exist
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'POST',
      url: `/voice/customer/note?tenant_id=${TENANT_ID}`,
      payload: {
        customer_id: CUSTOMER_ID,
        note: 'Test note',
      },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Customer not found');
  });

  it('22. POST /voice/customer/note returns 400 on empty note', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/voice/customer/note?tenant_id=${TENANT_ID}`,
      payload: {
        customer_id: CUSTOMER_ID,
        note: '',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Validation failed');
  });

  it('23. POST /voice/customer/note returns 400 on note exceeding max length', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/voice/customer/note?tenant_id=${TENANT_ID}`,
      payload: {
        customer_id: CUSTOMER_ID,
        note: 'x'.repeat(2001), // Exceeds 2000 character limit
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Validation failed');
  });

  it('24. GET /voice/active returns 401 when unauthenticated (no tenant context)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/voice/active',
    });

    // 2026-05-21: no auth context → 401, not the old misleading 400.
    expect(res.statusCode).toBe(401);
  });

  it('25. GET /voice/history respects max limit of 200', async () => {
    queryResponses.push({ rows: [{ count: '500' }] });
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/voice/history?tenant_id=${TENANT_ID}&limit=500`,
    });

    expect(res.statusCode).toBe(200);

    // Verify the limit parameter was capped at 200
    const selectQuery = mockClient.query.mock.calls[1];
    const params = selectQuery[1] as unknown[];
    expect(params).toContain(200); // Should be capped to 200
  });
});

// =============================================
// EDGE CASES
// =============================================

describe('Voice Routes — Edge Cases', () => {
  it('26. POST /voice/session/start handles database function returning null', async () => {
    // Function returns null/empty
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'POST',
      url: `/voice/session/start?tenant_id=${TENANT_ID}`,
      payload: {
        call_id: CALL_ID,
        caller_phone: '+1-555-123-4567',
      },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Failed to create voice session');
  });

  it('27. GET /voice/history handles status filter', async () => {
    queryResponses.push({ rows: [{ count: '10' }] });
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/voice/history?tenant_id=${TENANT_ID}&status=completed`,
    });

    expect(res.statusCode).toBe(200);

    // Verify the query included status filter
    const countQuery = mockClient.query.mock.calls[0][0] as string;
    expect(countQuery).toContain('status');
  });

  it('28. Phone normalization in context lookup works with different formats', async () => {
    const mockContext = {
      is_known_customer: true,
      customer: { id: CUSTOMER_ID, name: 'Test', phone: '5551234567' },
      appointment_history: { total: 0, completed: 0, cancelled: 0, upcoming_appointments: [] },
      notes: [],
      preferences: {},
      tags: [],
    };

    queryResponses.push({ rows: [{ context: mockContext }] });

    // Phone with different format
    const res = await app.inject({
      method: 'GET',
      url: `/voice/context/555-123-4567?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().is_known_customer).toBe(true);
  });

  it('29. POST /voice/session/end accepts minimal payload', async () => {
    queryResponses.push({ rows: [{ ended: true }] });

    const res = await app.inject({
      method: 'POST',
      url: `/voice/session/end?tenant_id=${TENANT_ID}`,
      payload: {
        call_id: CALL_ID,
        // All optional fields omitted
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('30. GET /voice/customer/:customerId/calls respects limit parameter', async () => {
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/voice/customer/${CUSTOMER_ID}/calls?tenant_id=${TENANT_ID}&limit=5`,
    });

    expect(res.statusCode).toBe(200);

    // Verify limit was passed
    const query = mockClient.query.mock.calls[0];
    const params = query[1] as unknown[];
    expect(params).toContain(5);
  });

  it('31. GET /voice/customer/:customerId/calls caps limit at 100', async () => {
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/voice/customer/${CUSTOMER_ID}/calls?tenant_id=${TENANT_ID}&limit=500`,
    });

    expect(res.statusCode).toBe(200);

    // Verify limit was capped to 100
    const query = mockClient.query.mock.calls[0];
    const params = query[1] as unknown[];
    expect(params).toContain(100);
  });
});

// =============================================
// SOFT-DELETE OLD CALLS (owner-gated)
// =============================================

describe('Voice Routes — Soft-delete calls', () => {
  const VOICE_SESSION_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

  it('32. GET /voice/active excludes soft-deleted rows', async () => {
    // WHO: Owner viewing the live Calls tab after deleting an old call.
    // WHAT: The active-calls query must carry `is_deleted = false` so a
    //       soft-deleted row never resurfaces in the list.
    // WHERE: src/routes/voice.ts GET /voice/active WHERE clause.
    // WHEN: Every active-calls fetch.
    // WHY: Soft-delete is meaningless if the list endpoints don't honor it.
    queryResponses.push({ rows: [] });
    const res = await app.inject({ method: 'GET', url: `/voice/active?tenant_id=${TENANT_ID}` });
    expect(res.statusCode).toBe(200);
    const sql = mockClient.query.mock.calls[0][0] as string;
    expect(sql).toContain('is_deleted = false');
  });

  it('33. GET /voice/history excludes soft-deleted rows (count + select)', async () => {
    // WHO: Owner browsing call history after a bulk delete.
    // WHAT: BOTH the count and the page query must filter `is_deleted = false`.
    // WHERE: src/routes/voice.ts GET /voice/history whereClause.
    // WHEN: Every history fetch.
    // WHY: A mismatched count vs rows (one filtered, one not) breaks paging.
    queryResponses.push({ rows: [{ count: '0' }] });
    queryResponses.push({ rows: [] });
    const res = await app.inject({ method: 'GET', url: `/voice/history?tenant_id=${TENANT_ID}` });
    expect(res.statusCode).toBe(200);
    const countSql = mockClient.query.mock.calls[0][0] as string;
    const selectSql = mockClient.query.mock.calls[1][0] as string;
    expect(countSql).toContain('is_deleted = false');
    expect(selectSql).toContain('is_deleted = false');
  });

  it('34. DELETE /voice/session/:id soft-deletes one call for an owner', async () => {
    // WHO: Owner clicking "delete" on a single old call.
    // WHAT: UPDATE sets is_deleted=true + deleted_at + deleted_by; 200 success.
    // WHERE: src/routes/voice.ts DELETE /voice/session/:id.
    // WHEN: Owner-initiated single delete.
    // WHY: Recoverable soft-delete, not a hard DELETE (PII retained, hidden).
    queryResponses.push({ rows: [{ voice_session_id: VOICE_SESSION_ID }] });
    const res = await app.inject({
      method: 'DELETE',
      url: `/voice/session/${VOICE_SESSION_ID}?tenant_id=${TENANT_ID}`,
      headers: { 'x-role': 'owner' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    const sql = mockClient.query.mock.calls[0][0] as string;
    expect(sql).toContain('UPDATE voice_sessions');
    expect(sql).toContain('is_deleted = true');
    expect(sql).toContain('voice_session_id = $1');
    // Guard: never re-delete an already-deleted row.
    expect(sql).toContain('is_deleted = false');
    // Guard: never hide a live/in-progress call.
    expect(sql).toContain("status != 'active'");
  });

  it('34b. DELETE /voice/session/:id rejects a non-UUID id with 400 (not a 500)', async () => {
    // WHO: a malformed / probing request with a non-UUID id segment.
    // WHAT: 400 up front — never reach the UUID column with a bad value.
    // WHERE: requireValidUUID guard in DELETE /voice/session/:id.
    // WHEN: id is not a UUID.
    // WHY: `voice_session_id = 'notauuid'` throws Postgres 22P02 → a 500; the
    //      guard turns it into a clean 400 and avoids any DB round-trip.
    const res = await app.inject({
      method: 'DELETE',
      url: `/voice/session/not-a-uuid?tenant_id=${TENANT_ID}`,
      headers: { 'x-role': 'owner' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockClient.query.mock.calls.length).toBe(0);
  });

  it('35. DELETE /voice/session/:id returns 404 when nothing matched', async () => {
    // WHO: Owner deleting a call that does not exist / is already deleted.
    // WHAT: zero rows updated → 404 (never silent success).
    // WHERE: assertRowAffected in DELETE /voice/session/:id.
    // WHEN: id wrong, cross-tenant, or already soft-deleted.
    // WHY: assertRowAffected discipline — zero-row mutation is a 404.
    queryResponses.push({ rows: [] });
    const res = await app.inject({
      method: 'DELETE',
      url: `/voice/session/${VOICE_SESSION_ID}?tenant_id=${TENANT_ID}`,
      headers: { 'x-role': 'owner' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().success).toBe(false);
  });

  it('36. DELETE /voice/session/:id is forbidden for front_desk', async () => {
    // WHO: A front-desk login attempting to delete a call.
    // WHAT: 403 — deleting call records (caller PII) is owner-only.
    // WHERE: owner-gate in DELETE /voice/session/:id.
    // WHEN: role === 'front_desk'.
    // WHY: Mirrors audit-log/export gating; front-desk can view, not purge.
    const res = await app.inject({
      method: 'DELETE',
      url: `/voice/session/${VOICE_SESSION_ID}?tenant_id=${TENANT_ID}`,
      headers: { 'x-role': 'front_desk' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);
    // No DB write should have been attempted.
    expect(mockClient.query.mock.calls.length).toBe(0);
  });

  it('37. POST /voice/delete-old bulk soft-deletes finished calls older than N days', async () => {
    // WHO: Owner clearing out calls older than 90 days.
    // WHAT: UPDATE all non-deleted, non-active rows older than the cutoff;
    //       returns the count deleted.
    // WHERE: src/routes/voice.ts POST /voice/delete-old.
    // WHEN: Owner-initiated bulk cleanup.
    // WHY: Bulk path excludes active calls so a live call is never killed.
    queryResponses.push({ rows: [{ voice_session_id: 'a' }, { voice_session_id: 'b' }] });
    const res = await app.inject({
      method: 'POST',
      url: `/voice/delete-old?tenant_id=${TENANT_ID}`,
      headers: { 'x-role': 'owner' },
      payload: { older_than_days: 90 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.result.deleted).toBe(2);
    const sql = mockClient.query.mock.calls[0][0] as string;
    expect(sql).toContain('UPDATE voice_sessions');
    expect(sql).toContain('is_deleted = true');
    expect(sql).toContain("status != 'active'");
    const params = mockClient.query.mock.calls[0][1] as unknown[];
    expect(params).toContain(90);
  });

  it('38. POST /voice/delete-old rejects older_than_days < 1', async () => {
    // WHO: Owner (or a buggy client) sending older_than_days=0.
    // WHAT: 400 — a 0/negative window would delete everything; min is 1.
    // WHERE: zod validation in POST /voice/delete-old.
    // WHEN: older_than_days out of range.
    // WHY: Guardrail against an accidental delete-all.
    const res = await app.inject({
      method: 'POST',
      url: `/voice/delete-old?tenant_id=${TENANT_ID}`,
      headers: { 'x-role': 'owner' },
      payload: { older_than_days: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
  });

  it('39. POST /voice/delete-old is forbidden for front_desk', async () => {
    // WHO: A front-desk login attempting a bulk purge.
    // WHAT: 403 before any DB write.
    // WHERE: owner-gate in POST /voice/delete-old.
    // WHEN: role === 'front_desk'.
    // WHY: Bulk PII deletion is owner-only.
    const res = await app.inject({
      method: 'POST',
      url: `/voice/delete-old?tenant_id=${TENANT_ID}`,
      headers: { 'x-role': 'front_desk' },
      payload: { older_than_days: 30 },
    });
    expect(res.statusCode).toBe(403);
    expect(mockClient.query.mock.calls.length).toBe(0);
  });

  it('40. DELETE /voice/session/:id resolves the KB gaps that belong to that call', async () => {
    // WHO: Owner who cleared their Calls screen and still saw the upper-right
    //      badge counting "1 unanswered" for a call they can no longer open
    //      (reported 2026-09-09).
    // WHAT: After the soft-delete, a second UPDATE resolves the
    //      unanswered_questions rows carrying the deleted call's call_id.
    // WHERE: resolveUnansweredForCalls in src/routes/voice.ts.
    // WHEN: A single call delete whose row has a call_id.
    // WHY: The badge counts KB gaps; leaving an orphan gap behind makes it
    //      count a to-do with no evidence attached.
    queryResponses.push({ rows: [{ voice_session_id: VOICE_SESSION_ID, call_id: CALL_ID }] });
    queryResponses.push({ rows: [{ unanswered_question_id: 'q1' }] });
    const res = await app.inject({
      method: 'DELETE',
      url: `/voice/session/${VOICE_SESSION_ID}?tenant_id=${TENANT_ID}`,
      headers: { 'x-role': 'owner' },
    });
    expect(res.statusCode).toBe(200);
    const sql = mockClient.query.mock.calls[1][0] as string;
    expect(sql).toContain('UPDATE unanswered_questions');
    expect(sql).toContain('resolved = true');
    expect(sql).toContain('resolved = false');
    expect(sql).toContain('call_id = ANY($2::text[])');
    const params = mockClient.query.mock.calls[1][1] as unknown[];
    expect(params[0]).toBe(TENANT_ID);
    expect(params[1]).toEqual([CALL_ID]);
  });

  it('41. DELETE /voice/session/:id skips the KB-gap UPDATE when the call has no call_id', async () => {
    // WHO: Owner deleting a legacy row whose call_id is NULL.
    // WHAT: No second query at all — never issue `call_id = ANY('{}')`, which
    //      would scan and update nothing while looking like it worked.
    // WHERE: the ids.length === 0 early return in resolveUnansweredForCalls.
    // WHEN: Every delete of a session with a NULL call_id.
    // WHY: A no-op write is the failure mode this repo keeps re-learning —
    //      cheaper to not issue it than to explain it later.
    queryResponses.push({ rows: [{ voice_session_id: VOICE_SESSION_ID, call_id: null }] });
    const res = await app.inject({
      method: 'DELETE',
      url: `/voice/session/${VOICE_SESSION_ID}?tenant_id=${TENANT_ID}`,
      headers: { 'x-role': 'owner' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockClient.query.mock.calls.length).toBe(1);
  });

  it('42. DELETE /voice/session/:id still succeeds when the KB-gap UPDATE throws', async () => {
    // WHO: Owner deleting a call while the unanswered_questions write fails.
    // WHAT: 200 — the delete already committed; the badge cleanup is
    //      best-effort and must not turn a successful delete into a 500.
    // WHERE: the catch in resolveUnansweredForCalls.
    // WHEN: Any error on the follow-up UPDATE.
    // WHY: Losing the cleanup costs one stale badge; failing the response
    //      tells the owner their delete failed when it did not.
    mockClient.query.mockImplementationOnce(() =>
      Promise.resolve({
        rows: [{ voice_session_id: VOICE_SESSION_ID, call_id: CALL_ID }],
        rowCount: 1,
      })
    );
    mockClient.query.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const res = await app.inject({
      method: 'DELETE',
      url: `/voice/session/${VOICE_SESSION_ID}?tenant_id=${TENANT_ID}`,
      headers: { 'x-role': 'owner' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('43. POST /voice/delete-old resolves the KB gaps of every call it deleted', async () => {
    // WHO: Owner clearing 90+ day calls in bulk.
    // WHAT: One follow-up UPDATE carrying every deleted call_id; rows with a
    //      NULL call_id are dropped from the array, not passed as null.
    // WHERE: resolveUnansweredForCalls, bulk path.
    // WHEN: Every bulk delete that removed at least one call with a call_id.
    // WHY: Same badge honesty as the single delete, one query not N.
    queryResponses.push({
      rows: [
        { voice_session_id: 'a', call_id: 'call-a' },
        { voice_session_id: 'b', call_id: null },
        { voice_session_id: 'c', call_id: 'call-c' },
      ],
    });
    queryResponses.push({ rows: [{ unanswered_question_id: 'q1' }] });
    const res = await app.inject({
      method: 'POST',
      url: `/voice/delete-old?tenant_id=${TENANT_ID}`,
      headers: { 'x-role': 'owner' },
      payload: { older_than_days: 90 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.deleted).toBe(3);
    const sql = mockClient.query.mock.calls[1][0] as string;
    expect(sql).toContain('UPDATE unanswered_questions');
    const params = mockClient.query.mock.calls[1][1] as unknown[];
    expect(params[1]).toEqual(['call-a', 'call-c']);
  });
});
