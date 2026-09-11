// ─────────────────────────────────────────────────────────────────────────
// WHO  : /agent-tools/book-with-scheduling → book_with_scheduling_atomic, the
//        production booking path — exercised at the EXACT edges of the business
//        day, the way Dale asked to test the timezone fix (2026-07-22):
//        "clear the data, make a meeting at 4:30–5, then try to book at 5 and
//        watch it fail. Also do it at the other end of the opening time."
// WHAT : with a shift 1:00–5:00 PM tenant-local, the last valid 30-min slot
//        (4:30–5:00) books, but a booking that STARTS at 5:00 (the close) is
//        refused, and one that starts BEFORE 1:00 (the open) is refused, while
//        1:00 exactly books. The SUCCESSFUL bookings must be stored at the
//        correct UTC instant for the tenant's wall-clock.
// WHY  : this is the "the scheduling mechanism and the calendar both calculate
//        in the SAME timezone" attestation. The whole file pins the Node
//        process to UTC (below) — Railway/CI's condition — while the tenant is
//        America/Chicago. If the enforce layer read the SERVER clock, a 5:00 PM
//        local start would be seen as 23:00 UTC and the 1–5 PM shift check would
//        misfire; a 4:30 PM booking would be stored six hours wrong. Passing
//        under UTC proves both the shift-coverage check and the stored instant
//        are computed in the TENANT's zone. Sibling of availableSlotsTz (the
//        SUGGEST layer); this is the ENFORCE layer.
// ─────────────────────────────────────────────────────────────────────────
// Pin the process to UTC BEFORE any Date is constructed — the real prod
// condition, and the only way a tenant-tz bug cannot be cancelled out by a dev
// machine whose OS zone happens to equal the tenant's. See availableSlotsTz.
process.env.TZ = 'UTC';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { type Client, Pool } from 'pg';
import {
  API_DB_URL,
  getRootClient,
  createTenant,
  createService,
  createEmployee,
  createResource,
  createScheduleEntry,
  assignEmployeeToService,
  assignResourceToService,
  skipIfDbDown,
} from '../utils';
import { createWithTenantClient } from '../../src/database';
import { registerAgentToolRoutes } from '../../src/routes/agentTools';

const AGENT_SECRET = 'test-booking-day-edges-secret';
const stubEmbedding = (): Promise<number[]> => Promise.resolve(new Array(1536).fill(0));
const stubNormalizer = async (text: string): Promise<string> => text;

const TENANT_TZ = 'America/Chicago';
const DATE = '2027-03-08'; // a Monday, still CST (DST starts 2027-03-14)

/** Expected UTC instant for a tenant-local wall-clock, computed independently of
 *  the app's applyTimezone (via Intl longOffset) so an app tz bug can't cancel
 *  out in the assertion. Same technique as multiEmployeeScheduling. */
function expectedUtc(time: string): string {
  const probe = new Date(`${DATE}T12:00:00Z`);
  const offset = new Intl.DateTimeFormat('en-US', {
    timeZone: TENANT_TZ,
    timeZoneName: 'longOffset',
  })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName')!
    .value.replace('GMT', '');
  return new Date(`${DATE}T${time}${offset || 'Z'}`).toISOString();
}

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
let tenantId: string;
const tenantsToClean: string[] = [];

function post(path: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { 'x-agent-secret': AGENT_SECRET },
    payload,
  });
}

let bookSeq = 0;
function book(fromLocal: string, toLocal: string) {
  // A fresh phone per call so the get-or-create customer step never collides.
  bookSeq += 1;
  const phone = `+1555000${String(1000 + bookSeq).slice(-4)}`;
  return post('/agent-tools/book-with-scheduling', {
    tenant_id: tenantId,
    phone,
    name: `Edge Caller ${bookSeq}`,
    requirements: { serviceType: 'Consultation' },
    window: { from: `${DATE}T${fromLocal}`, to: `${DATE}T${toLocal}` },
  });
}

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });
    process.env.AGENT_SECRET = AGENT_SECRET;

    app = Fastify({ logger: false });
    const withTenantClient = createWithTenantClient(pool);
    registerAgentToolRoutes(app, pool, withTenantClient, stubEmbedding, stubNormalizer);
    await app.ready();

    tenantId = await createTenant(setup, 'Edge Test Co', 'ai-platform', TENANT_TZ);
    tenantsToClean.push(tenantId);
    // No buffer: keeps the boundary arithmetic exact (a buffer would push the
    // last bookable start earlier and blur the 5:00 edge).
    await setup.query('UPDATE tenants SET default_buffer_minutes = 0 WHERE tenant_id = $1', [
      tenantId,
    ]);
    // A 30-minute service with NO required skills, so any on-shift employee can
    // take it — the boundary, not skill-matching, is what's under test.
    const serviceId = await createService(setup, tenantId, 'Consultation', 30, 0);
    await setup.query('UPDATE tenants SET default_service_id = $1 WHERE tenant_id = $2', [
      serviceId,
      tenantId,
    ]);
    const employeeId = await createEmployee(setup, tenantId, 'Sam Edge');
    const roomId = await createResource(setup, tenantId, 'Room 1');
    // The skill map: Sam takes consultations, in Room 1. The route passes the
    // resolved service id, so the RPC books only linked people and rooms.
    await assignEmployeeToService(setup, tenantId, serviceId, employeeId);
    await assignResourceToService(setup, tenantId, serviceId, roomId);
    // THE BUSINESS DAY: 1:00 PM – 5:00 PM, tenant-local.
    await createScheduleEntry(setup, tenantId, employeeId, DATE, '13:00', '17:00');

    dbAvailable = true;
  } catch (err) {
    console.warn('[bookingDayEdges.realdb.test] DB not available, skipping', err);
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
  delete process.env.AGENT_SECRET;
});

beforeEach(async (ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
  // "Clear the data" — every edge starts from an empty calendar so a prior
  // booking never confounds the boundary under test (the bare-bones-DB rule).
  if (dbAvailable) {
    await setup.query('DELETE FROM appointments WHERE tenant_id = $1', [tenantId]);
  }
});

describe('booking day-edges → real RPC, Chicago tenant, UTC process', () => {
  it('END OF DAY: 4:30–5:00 books (stored at the correct UTC instant); 5:00 is refused', async () => {
    // The last valid 30-minute slot lands, exactly at the 5:00 close.
    const ok = await book('16:30:00', '17:00:00');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().success).toBe(true);

    // The calendar stored it in the TENANT's zone, not the server's UTC: 4:30 PM
    // CST is 22:30Z, not 16:30Z. (A server-clock bug would store 16:30Z.)
    const rows = await setup.query<{ start_time: Date }>(
      `SELECT start_time FROM appointments WHERE tenant_id = $1 AND status = 'scheduled'`,
      [tenantId]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].start_time.toISOString()).toBe(expectedUtc('16:30:00'));

    // Booking that STARTS at the 5:00 close runs to 5:30 — past the shift end.
    // The enforce layer must refuse it, in the tenant's clock.
    const past = await book('17:00:00', '17:30:00');
    expect(past.statusCode).toBe(200);
    expect(past.json().success).toBe(false);
    expect(past.json().error_code).toBe('EMPLOYEE_NOT_SCHEDULED');
  });

  it('START OF DAY: 12:30 (before open) is refused; 1:00 (the open) books', async () => {
    // Before the shift opens — refused.
    const early = await book('12:30:00', '13:00:00');
    expect(early.statusCode).toBe(200);
    expect(early.json().success).toBe(false);
    expect(early.json().error_code).toBe('EMPLOYEE_NOT_SCHEDULED');

    // Exactly at the open — the first valid slot books, stored 1:00 PM CST = 19:00Z.
    const ok = await book('13:00:00', '13:30:00');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().success).toBe(true);
    const rows = await setup.query<{ start_time: Date }>(
      `SELECT start_time FROM appointments WHERE tenant_id = $1 AND status = 'scheduled'`,
      [tenantId]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].start_time.toISOString()).toBe(expectedUtc('13:00:00'));
  });
});
