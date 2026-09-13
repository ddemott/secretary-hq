import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  getRootClient,
  clearDB,
  setupBasicTenant,
  createResource,
  beginTestTransaction,
  rollbackTestTransaction,
  skipIfDbDown,
} from '../../utils';
import { type Client } from 'pg';
import { z } from 'zod';

describe('AI Tools: Modular Integration', () => {
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
      console.warn('[tools.test] Skipping DB-backed tests - connection failed', err);
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

  it('Validation: should fail with malformed UUID in tenant_id', () => {
    const schema = z.string().uuid();
    const result = schema.safeParse('not-a-uuid');
    expect(result.success).toBe(false);
  });

  it('Happy Path: should book a valid slot', async () => {
    if (!dbAvailable) return;
    const start = '2099-06-01T10:00:00Z';
    const end = '2099-06-01T11:00:00Z';

    const bookRes = await client.query(
      'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8)',
      [tenantId, resourceId, customerId, start, end, 'Tire Swap', 'call_abc', null]
    );
    expect(bookRes.rows[0].success).toBe(true);

    const stored = await client.query(
      'SELECT start_time, end_time FROM appointments WHERE appointment_id = $1',
      [bookRes.rows[0].appointment_id]
    );

    expect(stored.rows[0].start_time <= new Date(start)).toBe(true);
    expect(stored.rows[0].end_time >= new Date(end)).toBe(true);
  });

  it('Sad Path: should fail when booking an overlapping slot', async () => {
    if (!dbAvailable) return;
    const start = '2099-06-01T10:00:00Z';
    const end = '2099-06-01T11:00:00Z';

    // Initial book
    await client.query('SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8)', [
      tenantId,
      resourceId,
      customerId,
      start,
      end,
      'First',
      'call_1',
      null,
    ]);

    // Overlap book
    const bookRes = await client.query(
      'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        tenantId,
        resourceId,
        customerId,
        '2099-06-01T10:30:00Z',
        '2099-06-01T11:30:00Z',
        'Conflict',
        'call_2',
        null,
      ]
    );
    expect(bookRes.rows[0].success).toBe(false);
    // Updated 2026-04-30: book_appointment_atomic now returns
    // "Resource already booked during this timeslot" (renamed from
    // "Resource slot already booked" in an earlier RPC iteration).
    expect(bookRes.rows[0].error_message).toBe('Resource already booked during this timeslot');
  });

  it('Multi-bay: overlapping slots allowed on different resources', async () => {
    if (!dbAvailable) return;

    const otherResourceId = await createResource(client, tenantId, 'Truck 2');

    const start = '2099-06-01T10:00:00Z';
    const end = '2099-06-01T11:00:00Z';

    // Book in first bay
    await client.query('SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8)', [
      tenantId,
      resourceId,
      customerId,
      start,
      end,
      'First bay',
      'call_bay1',
      null,
    ]);

    // Overlapping time in second bay should still succeed
    const bookRes = await client.query(
      'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        tenantId,
        otherResourceId,
        customerId,
        '2099-06-01T10:30:00Z',
        '2099-06-01T11:30:00Z',
        'Second bay',
        'call_bay2',
        null,
      ]
    );

    expect(bookRes.rows[0].success).toBe(true);
  });
});
