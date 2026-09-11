// ─────────────────────────────────────────────────────────────────────────
// WHO  : /agent-tools/available-slots — the SUGGEST layer of booking.
// WHAT : a scheduled appointment must SUBTRACT its slot from open_times, in
//        the TENANT's timezone — regardless of the DB session's timezone.
// WHEN : regression guard for the 2026-07-17 evening call: available-slots
//        offered 1:00 PM Monday while a scheduled appointment sat exactly
//        there. The un-annotated `start_time::text` cast rendered the
//        timestamptz in the SESSION timezone (UTC on the prod pooler), so the
//        1:00 PM CDT booking became "18:00", fell outside the 13:00–17:00
//        shift coverage, and subtracted NOTHING. The caller picked the taken
//        slot and bounced off TIMESLOT_OCCUPIED — the suggest layer lied, the
//        enforce layer knew.
// WHERE: src/routes/agentTools/scheduling.ts day_appointments CTE +
//        timeToMinutes mapping.
// WHY  : the unit tests mock the query, so the rendering bug is invisible to
//        them (review catch on #281). Only real Postgres exercises the cast —
//        and this suite's connection, like CI's and the prod pooler's, runs
//        with a UTC session timezone, which is exactly the condition that
//        exposed the bug. Under the pre-fix code this test FAILS (1:00 PM is
//        offered); under the fix it passes.
// ─────────────────────────────────────────────────────────────────────────
// Pin the NODE process to UTC before anything constructs a Date. The pre-fix
// bug was a CANCELLING PAIR — SQL rendered UTC, JS re-read it in the server's
// local zone — so on a dev machine whose OS timezone equals the tenant's
// (Chicago) the two errors cancelled and the old code looked correct. Railway
// and CI both run Node in UTC, where the pair does NOT cancel. Pinning TZ
// makes this test reproduce the production condition on every machine.
process.env.TZ = 'UTC';

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { type Client, Pool } from 'pg';
import {
  API_DB_URL,
  getRootClient,
  createTenant,
  createResource,
  createEmployee,
  createScheduleEntry,
  createService,
  createCustomerFull,
  assignEmployeeToService,
  assignResourceToService,
  skipIfDbDown,
} from '../utils';
import { createWithTenantClient } from '../../src/database';
import { registerAgentToolRoutes } from '../../src/routes/agentTools';

const AGENT_SECRET = 'test-available-slots-tz-secret';
let prevAgentSecret: string | undefined;
// All-zero embedding: forces the service resolver past the semantic branch to
// the tenant default without a real OpenAI call.
const stubEmbedding = (): Promise<number[]> => Promise.resolve(new Array(1536).fill(0));
const stubNormalizer = async (text: string): Promise<string> => text;

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
let tenantId: string;
const tenantsToClean: string[] = [];

// A fixed FUTURE date so the route's "filter past times when today" branch
// never interferes. Wall-clock times are Chicago-local; the appointment's UTC
// instant is computed BY POSTGRES from the tenant timezone, so the test is
// immune to DST and to whatever timezone the test runner happens to be in.
const DATE = '2027-03-08'; // a Monday
const TZ = 'America/Chicago';

function post(path: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'x-agent-secret': AGENT_SECRET },
    payload,
  });
}

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });
    prevAgentSecret = process.env.AGENT_SECRET;
    process.env.AGENT_SECRET = AGENT_SECRET;

    app = Fastify({ logger: false });
    const withTenantClient = createWithTenantClient(pool);
    registerAgentToolRoutes(app, pool, withTenantClient, stubEmbedding, stubNormalizer);
    await app.ready();

    tenantId = await createTenant(setup, 'TZ Slots Co', 'ai-platform', TZ);
    tenantsToClean.push(tenantId);
    // No buffer: keeps the exclusion arithmetic in the assertions exact.
    await setup.query('UPDATE tenants SET default_buffer_minutes = 0 WHERE tenant_id = $1', [
      tenantId,
    ]);
    const serviceId = await createService(setup, tenantId, 'Programming Consultation', 30, 0);
    await setup.query('UPDATE tenants SET default_service_id = $1 WHERE tenant_id = $2', [
      serviceId,
      tenantId,
    ]);
    const employeeId = await createEmployee(setup, tenantId, 'Dale Test');
    await createScheduleEntry(setup, tenantId, employeeId, DATE, '13:00', '17:00');
    const resourceId = await createResource(setup, tenantId, 'Office Line');
    // The skill map: Dale takes this service, on the Office Line. The date path
    // counts only linked people's shifts (2026-09-11).
    await assignEmployeeToService(setup, tenantId, serviceId, employeeId);
    await assignResourceToService(setup, tenantId, serviceId, resourceId);
    const customerId = await createCustomerFull(setup, tenantId, '+15559990101', 'Jack Taken');

    // THE APPOINTMENT AT 1:00 PM LOCAL. Postgres converts the tenant-local
    // wall-clock to the UTC instant — under a UTC session this row's
    // start_time::text reads "…19:00:00+00" (CST), which is precisely the
    // value the pre-fix cast mis-rendered into the exclusion math.
    await setup.query(
      `INSERT INTO appointments (tenant_id, resource_id, customer_id, employee_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4,
               ($5 || ' 13:00:00')::timestamp AT TIME ZONE $6,
               ($5 || ' 13:30:00')::timestamp AT TIME ZONE $6,
               'the taken slot', 'scheduled')`,
      [tenantId, resourceId, customerId, employeeId, DATE, TZ]
    );

    dbAvailable = true;
  } catch (err) {
    console.warn('[availableSlotsTz.realdb.test] DB not available, skipping', err);
  }
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (setup) {
    for (const id of tenantsToClean) {
      await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
    }
    await setup.end();
  }
  if (prevAgentSecret === undefined) delete process.env.AGENT_SECRET;
  else process.env.AGENT_SECRET = prevAgentSecret;
});

beforeEach((ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
});

describe('available-slots → real DB, non-UTC tenant, UTC session', () => {
  it('SAD→FIXED: a scheduled 1:00 PM local appointment is NOT offered as open', async () => {
    const res = await post('/agent-tools/available-slots', {
      tenant_id: tenantId,
      date: DATE,
      service_type: 'a meeting',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    const openTimes: string[] = body.result.open_times;

    // The booked 30 minutes are gone: a 30-minute service starting at 1:00 or
    // 1:15 would overlap [1:00, 1:30).
    expect(openTimes).not.toContain('1:00 PM');
    expect(openTimes).not.toContain('1:15 PM');
    // The rest of the shift is genuinely open — proves we subtracted the
    // appointment, not the whole day (an over-subtraction would also hide the
    // 1:00 PM absence).
    expect(openTimes).toContain('1:30 PM');
    expect(openTimes).toContain('3:00 PM');
    // And the spoken text never offers the taken time.
    expect(String(body.result.spoken ?? '')).not.toMatch(/\b1:00 PM\b/);

    // offer_times (Dale's spec): earliest OPEN times stepped by the 30-min
    // service duration — with [1:00,1:30) booked, the offers start at the
    // first real opening. "That's assuming those times are open" — they are.
    expect(body.result.offer_times).toEqual(['1:30 PM', '2:00 PM', '2:30 PM']);
  });

  it('HAPPY: NO DATE = the soonest-openings opener — duration-stepped, day-labelled, lead-buffered', async () => {
    // WHO: the lead-with-times opener (Dale's design 2026-07-17): the agent
    //       opens with the next real times instead of "what day works for you?".
    // WHAT: a shift seeded ~3 days out (inside the 168h search horizon, past
    //        the 60-min lead buffer) yields offer_times stepped by the 30-min
    //        service, labelled with the weekday, and a spoken line that closes
    //        with the name-your-own invitation.
    // WHERE: scheduling.ts no-date branch → findNextAvailableSlots →
    //        pickOfferTimes.
    // WHY: the opener must only ever speak REAL bookable times — it inherits
    //       every suggest-layer guarantee this file exists to pin.
    const soonDate = new Date(Date.now() + 3 * 86_400_000).toLocaleDateString('en-CA', {
      timeZone: TZ,
    });
    const empRes = await setup.query<{ employee_id: string }>(
      `SELECT employee_id FROM employees WHERE tenant_id = $1 LIMIT 1`,
      [tenantId]
    );
    await createScheduleEntry(
      setup,
      tenantId,
      empRes.rows[0].employee_id,
      soonDate,
      '13:00',
      '17:00'
    );

    // try/finally (review on #284): a failing assertion must not leak the
    // seeded shift into the dated tests — order-dependent failures are the
    // exact "stray row" class the bare-bones-DB rule exists to kill.
    try {
      const res = await post('/agent-tools/available-slots', {
        tenant_id: tenantId,
        service_type: 'a meeting',
        // no date
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      const offers: string[] = body.result.offer_times;
      // Three offers, stepped by the 30-minute duration from the shift start,
      // each carrying a day label ("Monday at 1:00 PM" — or today/tomorrow).
      expect(offers).toHaveLength(3);
      expect(offers[0]).toMatch(/at 1:00 PM$/);
      expect(offers[1]).toMatch(/at 1:30 PM$/);
      expect(offers[2]).toMatch(/at 2:00 PM$/);
      // The spoken line closes with the caller's own-choice invitation.
      expect(String(body.result.spoken)).toMatch(/another day or time that suits you better/i);
    } finally {
      // Cleanup: the added shift must not leak into the dated tests.
      await setup.query(
        `DELETE FROM employee_schedule WHERE tenant_id = $1 AND shift_date = $2::date`,
        [tenantId, soonDate]
      );
    }
  });

  it('HAPPY: with no appointments on the day, the full shift grid is offered', async () => {
    const res = await post('/agent-tools/available-slots', {
      tenant_id: tenantId,
      date: '2027-03-09', // Tuesday — no shift seeded, then seed and re-ask below
      service_type: 'a meeting',
    });
    // No shift that day → open_times must be empty (and never invent times).
    expect(res.json().result.open_times).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // WHO  : the "if today, filter out past times" branch of available-slots.
  // WHAT : at 7:30 PM tenant-local, the route must NOT offer slots from earlier
  //        that same day (5:00–7:00 PM are in the PAST), only 7:30 PM onward.
  // WHEN : regression guard for the live report — "at 7pm my wife was offered a
  //        meeting earlier that day." The past-time filter computed "now" on the
  //        SERVER clock (UTC on Railway). At 7:30 PM America/Chicago the UTC
  //        date has already rolled to tomorrow, so `isToday` went false,
  //        `currentMinutes` fell to 0, and the filter was skipped ENTIRELY —
  //        every open slot that afternoon, already past, was read aloud.
  // WHERE: src/routes/agentTools/scheduling.ts — the `now` / `isToday` /
  //        `currentMinutes` block, now computed in the tenant timezone.
  // WHY  : the clock is frozen (Date-only fake, so pg's real timers keep
  //        working) at 01:30 UTC 2027-03-11 = 7:30 PM CST 2027-03-10, which is
  //        exactly the "local evening, UTC already tomorrow" condition. Under
  //        the pre-fix code this test FAILS (5:00 PM is offered); under the fix
  //        it passes.
  // ───────────────────────────────────────────────────────────────────────
  it('SAD→FIXED: at 7:30 PM local, earlier-today slots are NOT offered (tz past-time filter)', async () => {
    const EVENING_DATE = '2027-03-10'; // Wednesday, still CST (DST starts 03-14)
    const empRes = await setup.query<{ employee_id: string }>(
      `SELECT employee_id FROM employees WHERE tenant_id = $1 LIMIT 1`,
      [tenantId]
    );
    // A LATE shift (5–9 PM) so "now" can sit mid-shift while the UTC date has
    // already rolled over — the exact shape that disabled the old filter.
    await createScheduleEntry(
      setup,
      tenantId,
      empRes.rows[0].employee_id,
      EVENING_DATE,
      '17:00',
      '21:00'
    );

    // Date-only fake: `new Date()` is frozen, but setTimeout/setInterval (which
    // pg relies on) stay real. 01:30 UTC = 19:30 the PREVIOUS day in CST.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-03-11T01:30:00Z'));
    try {
      const res = await post('/agent-tools/available-slots', {
        tenant_id: tenantId,
        date: EVENING_DATE,
        service_type: 'a meeting',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      const openTimes: string[] = body.result.open_times;

      // The past is gone: nothing before 7:30 PM (the frozen "now") is offered.
      for (const past of ['5:00 PM', '5:30 PM', '6:00 PM', '6:30 PM', '7:00 PM']) {
        expect(openTimes).not.toContain(past);
      }
      // The remaining shift IS offered — proves we filtered the past, not the
      // whole day (which would also make the assertions above vacuously pass).
      expect(openTimes).toContain('7:30 PM');
      expect(openTimes).toContain('8:30 PM');
      // And the spoken line never reads a past time back to the caller.
      expect(String(body.result.spoken ?? '')).not.toMatch(/\b5:00 PM\b/);
    } finally {
      vi.useRealTimers();
      await setup.query(
        `DELETE FROM employee_schedule WHERE tenant_id = $1 AND shift_date = $2::date`,
        [tenantId, EVENING_DATE]
      );
    }
  });
});
