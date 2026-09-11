/**
 * Regression tests for the Low bug-fix sweep.
 *
 * Feature areas covered (search here when touching any of these):
 *   - **Booking**: auto-calculate end_time from service duration
 *     (BUG-040)
 *   - **Schema**: JSONB metadata CHECK constraints (BUG-052)
 *   - **Timezones**: extended detection across browsers (BUG-057)
 *
 * Why bug-numbered, not feature-named: keeps the full regression set
 * for the Low sweep together so a future audit can verify all bugs
 * stay closed. Feature-area work should still grep here.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  getRootClient,
  clearDB,
  setupBasicTenant,
  createService,
  assignResourceToService,
  beginTestTransaction,
  rollbackTestTransaction,
  skipIfDbDown,
} from '../utils';
import { type Client } from 'pg';
import { detectTimezone } from '../../dashboard/lib/constants';

describe('Low Bug Fixes', () => {
  let client: Client;
  let tenantId: string;
  let resourceId: string;
  let customerId: string;
  let dbAvailable = true;
  beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

  beforeAll(async () => {
    try {
      client = await getRootClient();
      await clearDB(client);
      const setup = await setupBasicTenant(client);
      tenantId = setup.tenantId;
      resourceId = setup.resourceId;
      customerId = setup.customerId;
    } catch (err) {
      dbAvailable = false;
      console.warn('[low-bugs.test] Skipping DB tests - connection failed', err);
    }
  });

  afterAll(async () => {
    if (dbAvailable && client) {
      await client.end();
    }
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    await beginTestTransaction(client);
  });

  afterEach(async () => {
    if (!dbAvailable) return;
    await rollbackTestTransaction(client);
  });

  // ==================================================================
  // BUG-040: Auto-calculate end_time from service duration
  // ==================================================================
  describe('BUG-040: Auto-calculate end_time from service duration', () => {
    let serviceId: string;

    beforeEach(async () => {
      if (!dbAvailable) return;
      serviceId = await createService(client, tenantId, 'LowBug Test Service', 45);
      // STRICT (20260911000000): a service with no active service_resource
      // link is refused before end_time is ever computed — link the shared
      // fixture resource so this describe block's cases test auto-calculate,
      // not the link-map gate.
      await assignResourceToService(client, tenantId, serviceId, resourceId);
    });

    test('auto-calculates end_time when NULL and service_id provided', async () => {
      if (!dbAvailable) return;
      const startTime = new Date('2026-05-01T10:00:00Z');
      const res = await client.query(
        `SELECT * FROM book_appointment_atomic($1, $2, $3, $4, NULL, $5, $6, NULL, NULL, $7)`,
        [
          tenantId,
          resourceId,
          customerId,
          startTime,
          'LowBug auto-end test',
          'low-bug-040-1',
          serviceId,
        ]
      );
      expect(res.rows[0].success).toBe(true);

      const apt = await client.query(
        `SELECT start_time, end_time FROM appointments WHERE appointment_id = $1`,
        [res.rows[0].appointment_id]
      );
      const start = new Date(apt.rows[0].start_time);
      const end = new Date(apt.rows[0].end_time);
      const diffMinutes = (end.getTime() - start.getTime()) / (1000 * 60);
      expect(diffMinutes).toBe(45);
    });

    test('returns error when end_time is NULL and no service_id', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        `SELECT * FROM book_appointment_atomic($1, $2, $3, $4, NULL, $5, $6)`,
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2026-05-02T10:00:00Z'),
          'LowBug no-end no-service',
          'low-bug-040-2',
        ]
      );
      expect(res.rows[0].success).toBe(false);
      expect(res.rows[0].error_message).toContain('end_time is required');
    });

    test('explicit end_time still works when provided', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        `SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2026-05-03T10:00:00Z'),
          new Date('2026-05-03T11:30:00Z'),
          'LowBug explicit end',
          'low-bug-040-3',
        ]
      );
      expect(res.rows[0].success).toBe(true);
    });
  });

  // ==================================================================
  // BUG-052: JSONB metadata CHECK constraint
  // ==================================================================
  describe('BUG-052: JSONB metadata CHECK constraint', () => {
    test('rejects array metadata on customers', async () => {
      if (!dbAvailable) return;
      await expect(
        client.query(
          `INSERT INTO customers (tenant_id, phone, name, metadata)
                     VALUES ($1, '+15550000099', 'ArrayMeta', '[]'::jsonb)`,
          [tenantId]
        )
      ).rejects.toThrow(/customers_metadata_is_object/);
    });

    test('accepts object metadata on customers', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        `INSERT INTO customers (tenant_id, phone, name, metadata)
                 VALUES ($1, '+15550000098', 'ObjMeta', '{"key": "value"}'::jsonb)
                 RETURNING customer_id`,
        [tenantId]
      );
      expect(res.rows.length).toBe(1);
    });

    test('accepts NULL metadata on customers', async () => {
      if (!dbAvailable) return;
      const res = await client.query(
        `INSERT INTO customers (tenant_id, phone, name, metadata)
                 VALUES ($1, '+15550000097', 'NullMeta', NULL)
                 RETURNING customer_id`,
        [tenantId]
      );
      expect(res.rows.length).toBe(1);
    });
  });

  // ==================================================================
  // BUG-057: Extended timezone detection
  // ==================================================================
  describe('BUG-057: Extended timezone detection', () => {
    test('detects timezone for major cities', () => {
      expect(detectTimezone('San Francisco', '')).toBe('America/Los_Angeles');
      expect(detectTimezone('Nashville', '')).toBe('America/Chicago');
      expect(detectTimezone('Boston', '')).toBe('America/New_York');
      expect(detectTimezone('Albuquerque', '')).toBe('America/Denver');
      expect(detectTimezone('Honolulu', '')).toBe('Pacific/Honolulu');
      expect(detectTimezone('Anchorage', '')).toBe('America/Anchorage');
    });

    test('falls back to state-level detection', () => {
      expect(detectTimezone('Unknown City', 'PA')).toBe('America/New_York');
      expect(detectTimezone('Unknown City', 'WI')).toBe('America/Chicago');
      expect(detectTimezone('Unknown City', 'MT')).toBe('America/Denver');
      expect(detectTimezone('Unknown City', 'OR')).toBe('America/Los_Angeles');
      expect(detectTimezone('Unknown City', 'HI')).toBe('Pacific/Honolulu');
      expect(detectTimezone('Unknown City', 'AK')).toBe('America/Anchorage');
    });

    test('returns null for unknown city and state', () => {
      expect(detectTimezone('Unknown City', 'XX')).toBeNull();
    });
  });
});
