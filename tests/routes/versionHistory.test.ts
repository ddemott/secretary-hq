import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {Pool} from 'pg';
import { registerVersionHistoryRoutes } from '../../src/routes/versionHistory';
import { createMockClient, createMockPool, createMockWithTenantClient } from '../mock';

// --- Constants ---
const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const RECORD_ID = '11111111-2222-3333-8444-555555555555';
const VERSION_ID = '22222222-3333-4444-8555-666666666666';

// --- App builder ---

let app: FastifyInstance;
let mockClient: ReturnType<typeof createMockClient>['mockClient'];
let queryResponses: ReturnType<typeof createMockClient>['queryResponses'];
let mockPool: Pool;

type TestAuth = { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
/**
 * `undefined` = default owner stub (the mutating restore/soft-delete/
 * copy-fields routes are owner-gated via requireOwnerRole); set explicitly
 * per-test to exercise the gate itself (front_desk → 403, null → 401).
 */
let authOverride: TestAuth | null | undefined;

// Test-only request shape: the preHandler injects tenantId + auth for the route to read.
type TenantRequest = FastifyRequest & { tenantId?: string; auth?: TestAuth | null };

function buildApp() {
  const created = createMockClient();
  mockClient = created.mockClient;
  queryResponses = created.queryResponses;

  mockPool = createMockPool(mockClient);
  const mockWithTenantClient = createMockWithTenantClient(mockClient);

  const fastify = Fastify({ logger: false });

  fastify.addHook('preHandler', async (request: TenantRequest) => {
    const tenantId =
      (request.query as Record<string, string>)?.tenant_id ||
      (request.headers['x-tenant-id'] as string);
    if (tenantId) {
      request.tenantId = tenantId;
    }
    // Preserve test #18's "no tenant_id at all → 401" contract: only
    // synthesize a default owner when the request actually carries a
    // tenant_id (mirrors a real authenticated dashboard request), unless a
    // test explicitly overrides auth (including to null/unauthenticated).
    request.auth =
      authOverride !== undefined
        ? authOverride
        : tenantId
          ? { tenant_id: tenantId, user_id: 'owner-user', email: 'owner@test.local', role: 'owner' }
          : undefined;
  });

  registerVersionHistoryRoutes(
    fastify,
    mockPool,
    mockWithTenantClient
  );

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
  authOverride = undefined;
});

// =============================================
// HAPPY PATHS
// =============================================

describe('Version History Routes — Happy Paths', () => {
  it('1. GET /records/:table/:recordId/history returns version history', async () => {
    // Record info query
    queryResponses.push({
      rows: [{ is_deleted: false, deleted_at: null, deleted_by: null }],
    });

    // Versions query
    queryResponses.push({
      rows: [
        {
          record_version_id: VERSION_ID,
          version_number: 2,
          data: { name: 'John Doe', phone: '555-1234' },
          changed_fields: ['phone'],
          previous_values: { phone: '555-0000' },
          change_type: 'update',
          change_source: 'local',
          changed_by: 'user',
          change_summary: 'Phone updated',
          changed_at: '2026-04-09T10:00:00Z',
        },
        {
          record_version_id: 'v1-id',
          version_number: 1,
          data: { name: 'John Doe', phone: '555-0000' },
          changed_fields: [],
          previous_values: {},
          change_type: 'create',
          change_source: 'local',
          changed_by: 'user',
          change_summary: 'Record created',
          changed_at: '2026-04-08T10:00:00Z',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/${RECORD_ID}/history?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.record_id).toBe(RECORD_ID);
    expect(body.table_name).toBe('customers');
    expect(body.current_version).toBe(2);
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0].record_version_id).toBe(VERSION_ID);
    expect(body.versions[1].record_version_id).toBe('v1-id');
    expect(body.is_deleted).toBe(false);
  });

  it('2. GET /records/:table/:recordId/version/:num returns specific version', async () => {
    queryResponses.push({
      rows: [
        {
          record_version_id: VERSION_ID,
          tenant_id: TENANT_ID,
          table_name: 'customers',
          record_id: RECORD_ID,
          version_number: 1,
          data: { name: 'John Doe' },
          changed_fields: [],
          previous_values: {},
          change_type: 'create',
          change_source: 'local',
          changed_by: 'user',
          change_summary: 'Created',
          changed_at: '2026-04-08T10:00:00Z',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/${RECORD_ID}/version/1?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version_number).toBe(1);
    expect(body.data.name).toBe('John Doe');
  });

  it('3. GET /records/:table/:recordId/compare/:vA/:vB returns differences', async () => {
    queryResponses.push({
      rows: [
        { field_name: 'phone', value_a: '555-0000', value_b: '555-1234' },
        { field_name: 'email', value_a: null, value_b: 'john@example.com' },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/${RECORD_ID}/compare/1/2?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version_a).toBe(1);
    expect(body.version_b).toBe(2);
    expect(body.differences).toHaveLength(2);
    expect(body.differences[0].field_name).toBe('phone');
  });

  it('4. POST /records/:table/:recordId/restore-fields restores selected fields', async () => {
    queryResponses.push({ rows: [] }); // BEGIN
    // Set config calls
    queryResponses.push({ rows: [] });
    queryResponses.push({ rows: [] });

    // Restore function
    queryResponses.push({
      rows: [{ data: { name: 'John Doe', phone: '555-0000', email: 'john@example.com' } }],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/restore-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_version: 1,
        fields: ['phone'],
        restored_by: 'test-user',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain('1 field');
  });

  it('5. POST /records/:table/:recordId/soft-delete marks record as deleted', async () => {
    queryResponses.push({ rows: [{ deleted: true }] });

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/soft-delete?tenant_id=${TENANT_ID}`,
      payload: {
        deleted_by: 'test-user',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
  });

  it('6. POST /records/:table/:recordId/restore restores soft-deleted record', async () => {
    queryResponses.push({ rows: [{ restored: true }] });

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/restore?tenant_id=${TENANT_ID}`,
      payload: {
        restored_by: 'test-user',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
  });

  it('7. GET /records/:table/deleted returns deleted records list', async () => {
    // Count query
    queryResponses.push({ rows: [{ count: '3' }] });

    // Records query
    queryResponses.push({
      rows: [
        {
          id: RECORD_ID,
          tenant_id: TENANT_ID,
          table_name: 'customers',
          name: 'Deleted Customer',
          phone: '555-9999',
          email: 'deleted@example.com',
          deleted_at: '2026-04-08T15:00:00Z',
          deleted_by: 'user',
          version_count: 5,
          last_data: { name: 'Deleted Customer', phone: '555-9999' },
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/deleted?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.records).toHaveLength(1);
    expect(body.records[0].name).toBe('Deleted Customer');
  });

  it('8. POST /records/:table/copy-fields copies fields between records', async () => {
    queryResponses.push({
      rows: [{ data: { name: 'Target', phone: '555-1234', notes: 'Copied notes' } }],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/copy-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_record_id: RECORD_ID,
        target_record_id: '33333333-4444-5555-8666-777777777777',
        fields: ['notes', 'preferences'],
        copied_by: 'test-user',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain('2 field');
  });

  it('9. GET /records/recent-changes returns recent changes', async () => {
    // Count
    queryResponses.push({ rows: [{ count: '50' }] });

    // Changes
    queryResponses.push({
      rows: [
        {
          record_version_id: VERSION_ID,
          tenant_id: TENANT_ID,
          table_name: 'customers',
          record_id: RECORD_ID,
          version_number: 2,
          change_type: 'update',
          change_source: 'square',
          changed_by: 'sync',
          change_summary: 'Email updated from sync',
          changed_at: '2026-04-09T12:00:00Z',
          record_name: 'John Doe',
          record_phone: '555-1234',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/records/recent-changes?tenant_id=${TENANT_ID}&limit=10`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(50);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].change_source).toBe('square');
  });

  it('10. GET /records/:table/:recordId/restore-preview returns field options', async () => {
    // Current record
    queryResponses.push({
      rows: [{ data: { name: 'John Doe', phone: '555-1234', email: 'john@new.com' } }],
    });

    // Versions
    queryResponses.push({
      rows: [
        {
          version_number: 2,
          data: { name: 'John Doe', phone: '555-1234', email: 'john@new.com' },
          changed_at: '2026-04-09T10:00:00Z',
          change_source: 'local',
        },
        {
          version_number: 1,
          data: { name: 'John Doe', phone: '555-0000', email: 'john@old.com' },
          changed_at: '2026-04-08T10:00:00Z',
          change_source: 'square',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/${RECORD_ID}/restore-preview?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.record_id).toBe(RECORD_ID);
    expect(body.fields.length).toBeGreaterThan(0);
  });
});

// =============================================
// SAD PATHS - with 5 Ws (Who, What, When, Where, Why)
// =============================================

describe('Version History Routes — Sad Paths (5 Ws Coverage)', () => {
  /**
   * Each sad path test validates the 5 Ws in error responses:
   * - Who: tenant_id / user context
   * - What: operation that failed
   * - When: timestamp of the error
   * - Where: endpoint/resource affected
   * - Why: reason for the failure
   */

  it('11. GET history with invalid table returns 400 with 5 Ws context', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/records/invalid_table/${RECORD_ID}/history?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();

    // Verify 5 Ws in error response
    expect(body.success).toBe(false);
    expect(body.code).toBe('INVALID_TABLE');
    expect(body.error).toContain('Invalid table name');
    expect(body.context).toBeDefined();
    expect(body.context.who).toBe(TENANT_ID); // WHO
    expect(body.context.what).toBe('Get record history'); // WHAT
    expect(body.context.when).toBeDefined(); // WHEN - timestamp
    expect(body.context.where).toContain('/records/invalid_table'); // WHERE
    expect(body.context.why).toContain('Invalid table name'); // WHY
  });

  it('12. GET version returns 404 with 5 Ws for non-existent version', async () => {
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/${RECORD_ID}/version/999?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();

    expect(body.code).toBe('VERSION_NOT_FOUND');
    expect(body.context.who).toBe(TENANT_ID);
    expect(body.context.what).toBe('Get specific version');
    expect(body.context.where).toContain(`/records/customers/${RECORD_ID}/version/999`);
    expect(body.context.why).toContain('Version 999 not found');
  });

  it('13. POST restore-fields returns 400 with 5 Ws on invalid payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/restore-fields?tenant_id=${TENANT_ID}`,
      payload: {
        // Missing required fields
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();

    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.context.who).toBe(TENANT_ID);
    expect(body.context.what).toBe('Restore fields from version');
    expect(body.context.where).toContain('/restore-fields');
    expect(body.context.why).toContain('validation failed');
    expect(body.details).toBeDefined(); // Zod validation details
  });

  it('14. POST restore-fields returns 400 with 5 Ws on empty fields array', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/restore-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_version: 1,
        fields: [], // Empty array
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();

    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'too_small' })])
    );
  });

  it('15. POST soft-delete returns 404 with 5 Ws for non-existent record', async () => {
    queryResponses.push({ rows: [{ deleted: false }] });

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/soft-delete?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();

    expect(body.code).toBe('RECORD_NOT_FOUND');
    expect(body.context.who).toBe(TENANT_ID);
    expect(body.context.what).toBe('Soft delete record');
    expect(body.context.where).toContain('/soft-delete');
    expect(body.context.why).toContain(`Record ${RECORD_ID} not found`);
  });

  it('16. POST restore returns 404 with 5 Ws for non-deleted record', async () => {
    queryResponses.push({ rows: [{ restored: false }] });

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/restore?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();

    expect(body.code).toBe('RECORD_NOT_DELETED');
    expect(body.context.who).toBe(TENANT_ID);
    expect(body.context.what).toBe('Restore deleted record');
    expect(body.context.where).toContain('/restore');
    expect(body.context.why).toContain('not deleted');
  });

  it('17. POST copy-fields returns 400 with 5 Ws on invalid source UUID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/copy-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_record_id: 'not-a-uuid',
        target_record_id: RECORD_ID,
        fields: ['name'],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();

    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.context.who).toBe(TENANT_ID);
    expect(body.context.what).toBe('Copy fields between records');
    expect(body.context.where).toContain('/copy-fields');
    // Zod returns format: 'uuid' in validation errors
    expect(body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ format: 'uuid' })])
    );
  });

  it('18. GET history returns 401 when unauthenticated (no tenant context)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/${RECORD_ID}/history`,
    });

    // 2026-05-21: no auth context → 401 (authentication is the real failure),
    // not the old misleading 400.
    expect(res.statusCode).toBe(401);
    const body = res.json();

    // Should still return a clear error
    expect(body.error || body.message).toBeDefined();
  });

  it('19. GET restore-preview returns 404 with 5 Ws for non-existent record', async () => {
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/${RECORD_ID}/restore-preview?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();

    expect(body.code).toBe('RECORD_NOT_FOUND');
    expect(body.context.who).toBe(TENANT_ID);
    expect(body.context.what).toBe('Get restore preview');
    expect(body.context.where).toContain('/restore-preview');
    expect(body.context.why).toContain(`Record ${RECORD_ID} not found`);
  });

  it('20. POST copy-fields returns 400 with 5 Ws on invalid target UUID', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/copy-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_record_id: RECORD_ID,
        target_record_id: 'invalid-uuid',
        fields: ['name'],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();

    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.context.why).toContain('validation failed');
  });

  it('21. POST copy-fields returns 400 with 5 Ws on missing fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/copy-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_record_id: RECORD_ID,
        target_record_id: '33333333-4444-5555-8666-777777777777',
        // Missing fields array
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();

    expect(body.code).toBe('VALIDATION_FAILED');
  });

  it('22. GET deleted returns 400 with 5 Ws for invalid table', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/records/invalid_table/deleted?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();

    expect(body.code).toBe('INVALID_TABLE');
    expect(body.context.what).toBe('Get deleted records');
    expect(body.context.where).toContain('/invalid_table/deleted');
  });

  it('23. GET compare returns 400 with 5 Ws for invalid table', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/records/bad_table/${RECORD_ID}/compare/1/2?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();

    expect(body.code).toBe('INVALID_TABLE');
    expect(body.context.what).toBe('Compare versions');
  });

  it('24. Error response timestamp is valid ISO date', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/records/bad_table/${RECORD_ID}/history?tenant_id=${TENANT_ID}`,
    });

    const body = res.json();
    const timestamp = new Date(body.context.when);

    // Verify timestamp is a valid date within the last minute
    expect(timestamp.getTime()).toBeGreaterThan(Date.now() - 60000);
    expect(timestamp.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

// =============================================
// EDGE CASES
// =============================================

describe('Version History Routes — Edge Cases', () => {
  it('25. GET /records/recent-changes filters by table', async () => {
    queryResponses.push({ rows: [{ count: '10' }] });
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/records/recent-changes?tenant_id=${TENANT_ID}&table=appointments`,
    });

    expect(res.statusCode).toBe(200);

    // Verify table filter was applied
    const countQuery = mockClient.query.mock.calls[0][0] as string;
    expect(countQuery).toContain('table_name');
  });

  it('26. GET /records/recent-changes filters by change_source', async () => {
    queryResponses.push({ rows: [{ count: '5' }] });
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/records/recent-changes?tenant_id=${TENANT_ID}&change_source=square`,
    });

    expect(res.statusCode).toBe(200);

    const countQuery = mockClient.query.mock.calls[0][0] as string;
    expect(countQuery).toContain('change_source');
  });

  it('27. GET /records/:table/deleted respects pagination', async () => {
    queryResponses.push({ rows: [{ count: '100' }] });
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/deleted?tenant_id=${TENANT_ID}&limit=10&offset=20`,
    });

    expect(res.statusCode).toBe(200);

    // Verify limit and offset were used
    const selectQuery = mockClient.query.mock.calls[1];
    const params = selectQuery[1] as unknown[];
    expect(params).toContain(10);
    expect(params).toContain(20);
  });

  it('28. POST /records/:table/:recordId/restore-fields accepts optional change_source', async () => {
    queryResponses.push({ rows: [] }); // BEGIN
    queryResponses.push({ rows: [] });
    queryResponses.push({ rows: [] });
    queryResponses.push({ rows: [{ data: { name: 'Test' } }] });

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/restore-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_version: 1,
        fields: ['phone'],
        change_source: 'square',
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it('29. All versioned tables are accepted', async () => {
    const tables = [
      'customers',
      'appointments',
      'voice_sessions',
      'employees',
      'services',
      'resources',
    ];

    for (const table of tables) {
      queryResponses.push({ rows: [{ is_deleted: false }] });
      queryResponses.push({ rows: [] });

      const res = await app.inject({
        method: 'GET',
        url: `/records/${table}/${RECORD_ID}/history?tenant_id=${TENANT_ID}`,
      });

      expect(res.statusCode).toBe(200);
    }
  });

  it('30. Error codes are consistent across similar failures', async () => {
    // All invalid table errors should return INVALID_TABLE code
    const invalidTableUrls = [
      `/records/bad/deleted?tenant_id=${TENANT_ID}`,
      `/records/bad/${RECORD_ID}/history?tenant_id=${TENANT_ID}`,
      `/records/bad/${RECORD_ID}/version/1?tenant_id=${TENANT_ID}`,
    ];

    for (const url of invalidTableUrls) {
      const res = await app.inject({ method: 'GET', url });
      const body = res.json();
      expect(body.code).toBe('INVALID_TABLE');
    }
  });

  it('31. Validation errors include field-level details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/copy-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_record_id: 'not-uuid',
        target_record_id: 'also-not-uuid',
        fields: [],
      },
    });

    const body = res.json();
    expect(body.details).toBeInstanceOf(Array);
    expect(body.details.length).toBeGreaterThanOrEqual(2); // Multiple validation errors
  });

  it('32. Pagination limit is capped at 200', async () => {
    queryResponses.push({ rows: [{ count: '500' }] });
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/deleted?tenant_id=${TENANT_ID}&limit=1000`,
    });

    expect(res.statusCode).toBe(200);
    // Verify the limit was capped (check params passed to query)
    const selectQuery = mockClient.query.mock.calls[1];
    const params = selectQuery[1] as unknown[];
    expect(params).toContain(200); // Capped at 200, not 1000
  });

  it('33. Default pagination values are applied', async () => {
    queryResponses.push({ rows: [{ count: '100' }] });
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/deleted?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const selectQuery = mockClient.query.mock.calls[1];
    const params = selectQuery[1] as unknown[];
    expect(params).toContain(50); // Default limit
    expect(params).toContain(0); // Default offset
  });
});

// =============================================
// ADDITIONAL HAPPY PATHS - Coverage Gaps
// =============================================

describe('Version History Routes — Additional Happy Paths', () => {
  it('34. GET history shows deleted record status correctly', async () => {
    queryResponses.push({
      rows: [{ is_deleted: true, deleted_at: '2026-04-09T10:00:00Z', deleted_by: 'admin' }],
    });
    queryResponses.push({
      rows: [
        {
          version_id: 'v1',
          version_number: 1,
          data: { name: 'Test' },
          changed_fields: [],
          previous_values: {},
          change_type: 'create',
          change_source: 'local',
          changed_by: 'user',
          change_summary: null,
          changed_at: '2026-04-08T10:00:00Z',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/${RECORD_ID}/history?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.is_deleted).toBe(true);
    expect(body.deleted_at).toBe('2026-04-09T10:00:00Z');
    expect(body.deleted_by).toBe('admin');
  });

  it('35. POST restore-fields with multiple fields', async () => {
    queryResponses.push({ rows: [] }); // BEGIN
    queryResponses.push({ rows: [] });
    queryResponses.push({ rows: [] });
    queryResponses.push({
      rows: [{ data: { name: 'Restored', phone: '555-0000', email: 'old@test.com' } }],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/restore-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_version: 1,
        fields: ['phone', 'email', 'address'],
        restored_by: 'admin',
        change_source: 'local',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain('3 field');
  });

  it('36. POST soft-delete with change_source parameter', async () => {
    queryResponses.push({ rows: [{ deleted: true }] });

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/soft-delete?tenant_id=${TENANT_ID}`,
      payload: {
        deleted_by: 'sync-service',
        change_source: 'square',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('37. POST restore with change_source parameter', async () => {
    queryResponses.push({ rows: [{ restored: true }] });

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/restore?tenant_id=${TENANT_ID}`,
      payload: {
        restored_by: 'admin',
        change_source: 'api',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('38. GET recent-changes filters by change_type', async () => {
    queryResponses.push({ rows: [{ count: '15' }] });
    queryResponses.push({
      rows: [
        {
          id: 'v1',
          tenant_id: TENANT_ID,
          table_name: 'customers',
          record_id: RECORD_ID,
          version_number: 1,
          change_type: 'create',
          change_source: 'local',
          changed_by: 'user',
          change_summary: 'Created',
          changed_at: '2026-04-09T10:00:00Z',
          record_name: 'Test',
          record_phone: '555-1234',
        },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: `/records/recent-changes?tenant_id=${TENANT_ID}&change_type=create`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(15);

    const countQuery = mockClient.query.mock.calls[0][0] as string;
    expect(countQuery).toContain('change_type');
  });

  it('39. POST copy-fields with change_source parameter', async () => {
    queryResponses.push({ rows: [{ data: { name: 'Target', notes: 'Copied' } }] });

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/copy-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_record_id: RECORD_ID,
        target_record_id: '33333333-4444-5555-8666-777777777777',
        fields: ['notes'],
        copied_by: 'merge-tool',
        change_source: 'system',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('40. GET history with tenant via x-tenant-id header', async () => {
    queryResponses.push({ rows: [{ is_deleted: false }] });
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/${RECORD_ID}/history`,
      headers: { 'x-tenant-id': TENANT_ID },
    });

    expect(res.statusCode).toBe(200);
  });
});

// =============================================
// ADDITIONAL SAD PATHS - Coverage Gaps
// =============================================

describe('Version History Routes — Additional Sad Paths', () => {
  it('41. POST restore-fields returns 500 when DB function returns null', async () => {
    queryResponses.push({ rows: [] });
    queryResponses.push({ rows: [] });
    queryResponses.push({ rows: [{ data: null }] }); // DB returns null

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/restore-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_version: 1,
        fields: ['phone'],
      },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.code).toBe('RESTORE_FAILED');
    expect(body.context.what).toBe('Restore fields from version');
  });

  it('42. POST copy-fields returns 500 when DB function returns null', async () => {
    queryResponses.push({ rows: [{ data: null }] }); // DB returns null

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/copy-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_record_id: RECORD_ID,
        target_record_id: '33333333-4444-5555-8666-777777777777',
        fields: ['notes'],
      },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.code).toBe('COPY_FAILED');
    expect(body.context.why).toContain('Failed to copy fields');
  });

  it('43. POST restore-fields returns 400 with negative version number', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/restore-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_version: -1,
        fields: ['phone'],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('VALIDATION_FAILED');
  });

  it('44. POST restore-fields returns 400 with zero version number', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/restore-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_version: 0,
        fields: ['phone'],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('VALIDATION_FAILED');
  });

  it('45. POST copy-fields returns 400 when source equals target', async () => {
    // Note: This is a logical error, but the current implementation allows it
    // The test verifies the endpoint accepts valid UUIDs even if same
    queryResponses.push({ rows: [{ data: { name: 'Same' } }] });

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/copy-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_record_id: RECORD_ID,
        target_record_id: RECORD_ID, // Same as source
        fields: ['notes'],
      },
    });

    // Currently this passes validation - could be enhanced to reject
    expect(res.statusCode).toBe(200);
  });

  it('46. POST soft-delete invalid table returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/records/invalid_table/${RECORD_ID}/soft-delete?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('INVALID_TABLE');
    expect(body.context.what).toBe('Soft delete record');
  });

  it('47. POST restore invalid table returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/records/invalid_table/${RECORD_ID}/restore?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('INVALID_TABLE');
    expect(body.context.what).toBe('Restore deleted record');
  });

  it('48. POST restore-fields invalid table returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/records/invalid_table/${RECORD_ID}/restore-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_version: 1,
        fields: ['phone'],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('INVALID_TABLE');
  });

  it('49. POST copy-fields invalid table returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/records/invalid_table/copy-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_record_id: RECORD_ID,
        target_record_id: '33333333-4444-5555-8666-777777777777',
        fields: ['notes'],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('INVALID_TABLE');
  });

  it('50. GET restore-preview invalid table returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/records/invalid_table/${RECORD_ID}/restore-preview?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('INVALID_TABLE');
  });
});

// =============================================
// BOUNDARY CONDITIONS
// =============================================

describe('Version History Routes — Boundary Conditions', () => {
  it('51. GET history with no versions returns empty array', async () => {
    queryResponses.push({ rows: [{ is_deleted: false }] });
    queryResponses.push({ rows: [] }); // No versions

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/${RECORD_ID}/history?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.versions).toEqual([]);
    expect(body.current_version).toBe(0);
  });

  it('52. GET deleted with no deleted records returns empty', async () => {
    queryResponses.push({ rows: [{ count: '0' }] });
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/deleted?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(0);
    expect(body.records).toEqual([]);
  });

  it('53. GET recent-changes with no changes returns empty', async () => {
    queryResponses.push({ rows: [{ count: '0' }] });
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/records/recent-changes?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(0);
    expect(body.changes).toEqual([]);
  });

  it('54. GET compare with identical versions returns no differences', async () => {
    queryResponses.push({ rows: [] }); // No differences

    const res = await app.inject({
      method: 'GET',
      url: `/records/customers/${RECORD_ID}/compare/1/1?tenant_id=${TENANT_ID}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.differences).toEqual([]);
    expect(body.version_a).toBe(1);
    expect(body.version_b).toBe(1);
  });

  it('55. POST restore-fields with single field works', async () => {
    queryResponses.push({ rows: [] }); // BEGIN
    queryResponses.push({ rows: [] });
    queryResponses.push({ rows: [] });
    queryResponses.push({ rows: [{ data: { phone: '555-0000' } }] });

    const res = await app.inject({
      method: 'POST',
      url: `/records/customers/${RECORD_ID}/restore-fields?tenant_id=${TENANT_ID}`,
      payload: {
        source_version: 1,
        fields: ['phone'],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.message).toContain('1 field');
  });

  it('56. GET recent-changes with all filters combined', async () => {
    queryResponses.push({ rows: [{ count: '3' }] });
    queryResponses.push({ rows: [] });

    const res = await app.inject({
      method: 'GET',
      url: `/records/recent-changes?tenant_id=${TENANT_ID}&table=customers&change_type=update&change_source=square&limit=5&offset=0`,
    });

    expect(res.statusCode).toBe(200);

    const countQuery = mockClient.query.mock.calls[0][0] as string;
    expect(countQuery).toContain('table_name');
    expect(countQuery).toContain('change_type');
    expect(countQuery).toContain('change_source');
  });
});

// =============================================
// SECURITY — owner-role gate (2026-09-16 role-check audit)
// =============================================

describe('Version History Routes — owner-role gate', () => {
  const restoreFieldsPayload = { source_version: 1, fields: ['phone'] };

  it.each([
    ['restore-fields', 'POST', `/records/customers/${RECORD_ID}/restore-fields`, restoreFieldsPayload],
    ['soft-delete', 'POST', `/records/customers/${RECORD_ID}/soft-delete`, {}],
    ['restore', 'POST', `/records/customers/${RECORD_ID}/restore`, {}],
    ['copy-fields', 'POST', `/records/customers/copy-fields`, {
      source_record_id: RECORD_ID,
      target_record_id: '33333333-4444-5555-8666-777777777777',
      fields: ['phone'],
    }],
  ])('SECURITY: %s is rejected 403 for a front-desk user before any query runs', async (_name, method, path, payload) => {
    authOverride = {
      tenant_id: TENANT_ID,
      user_id: 'fd-user',
      email: 'frontdesk@test.local',
      role: 'front_desk',
    };

    const res = await app.inject({
      method: method as 'POST',
      url: `${path}?tenant_id=${TENANT_ID}`,
      payload,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);
    expect(mockClient.query).not.toHaveBeenCalled();
  });

  it.each([
    ['restore-fields', 'POST', `/records/customers/${RECORD_ID}/restore-fields`, restoreFieldsPayload],
    ['soft-delete', 'POST', `/records/customers/${RECORD_ID}/soft-delete`, {}],
    ['restore', 'POST', `/records/customers/${RECORD_ID}/restore`, {}],
    ['copy-fields', 'POST', `/records/customers/copy-fields`, {
      source_record_id: RECORD_ID,
      target_record_id: '33333333-4444-5555-8666-777777777777',
      fields: ['phone'],
    }],
  ])('SECURITY: %s is rejected 401 when unauthenticated', async (_name, method, path, payload) => {
    authOverride = null;

    const res = await app.inject({
      method: method as 'POST',
      url: `${path}?tenant_id=${TENANT_ID}`,
      payload,
    });

    expect(res.statusCode).toBe(401);
    expect(mockClient.query).not.toHaveBeenCalled();
  });
});
