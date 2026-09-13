import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  getRootClient,
  clearDB,
  setupBasicTenant,
  beginTestTransaction,
  rollbackTestTransaction,
  skipIfDbDown,
} from '../utils';
import { type Client } from 'pg';

describe('TDD: Schema and Atomic Booking (Refactored)', () => {
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
       
      console.warn('[schema.test] Skipping DB tests - connection failed', err);
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

  it('should successfully book a valid slot', async () => {
    // WHO: voice AI agent (or dashboard quick-book) calling
    //      book_appointment_atomic for a free time window
    // WHAT: RPC returns success=true + a non-null appointment_id, and
    //       the inserted appointment row's start/end times match the
    //       requested window (within service-rounding tolerance)
    // WHEN: any unblocked booking — the load-bearing happy path for
    //      every voice-AI booking flow
    // WHERE: book_appointment_atomic RPC in supabase/migrations
    // WHY: this is THE smoke test for the booking RPC. If it fails,
    //      every voice call that tries to book breaks. Pinning both
    //      the success envelope AND the row write at the schema level
    //      prevents a regression in either layer from going unnoticed
    if (!dbAvailable) return;

    const startTime = new Date('2027-03-01T10:00:00Z');
    const endTime = new Date('2027-03-01T11:00:00Z');

    const result = await client.query(
      'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8);',
      [tenantId, resourceId, customerId, startTime, endTime, 'Flat tire repair', 'call_001', null]
    );

    expect(result.rows[0].success).toBe(true);
    expect(result.rows[0].appointment_id).not.toBeNull();

    const row = await client.query(
      'SELECT start_time, end_time FROM appointments WHERE appointment_id = $1',
      [result.rows[0].appointment_id]
    );

    expect(row.rows[0].start_time <= startTime).toBe(true);
    expect(row.rows[0].end_time >= endTime).toBe(true);
  });

  it('should fail to book an overlapping slot', async () => {
    // WHO: a second booking attempt arriving while the first window
    //      is still scheduled (race or replay)
    // WHAT: book_appointment_atomic returns success=false + the exact
    //       error_message string the agent prompt knows how to relay
    //       ("Resource already booked during this timeslot")
    // WHEN: every double-book attempt — pre-2026-05-02 this was a real
    //       race window, now closed by the GiST exclusion constraint
    //       in migration 20260501000000
    // WHERE: book_appointment_atomic resource-availability check (and
    //       since 2026-05-02, also the appointments_no_resource_overlap
    //       exclusion constraint as a final guard)
    // WHY: the error_message string is part of the API contract — the
    //      agent's prompt maps it to "that time just got taken, can we
    //      try a different slot?" If the RPC starts returning a
    //      different string the agent goes mute on conflicts, hanging
    //      live calls. Pin both the failure flag AND the exact message
    if (!dbAvailable) return;

    // Book initial
    await client.query('SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8);', [
      tenantId,
      resourceId,
      customerId,
      new Date('2027-03-01T10:00:00Z'),
      new Date('2027-03-01T11:00:00Z'),
      'First',
      'call_1',
      null,
    ]);

    const result = await client.query(
      'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8);',
      [
        tenantId,
        resourceId,
        customerId,
        new Date('2027-03-01T10:30:00Z'),
        new Date('2027-03-01T11:30:00Z'),
        'Overlap',
        'call_002',
        null,
      ]
    );

    expect(result.rows[0].success).toBe(false);
    // Updated 2026-04-30: see tools.test.ts comment — RPC error
    // message renamed from "slot already booked" to the current
    // "during this timeslot" form.
    expect(result.rows[0].error_message).toBe('Resource already booked during this timeslot');
  });
});
