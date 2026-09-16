/**
 * DELETE /customers/:id — real-DB regression suite for the orphaned-
 * appointments bug (docs/TODO.md, reported 2026-07-01 by Dale while
 * clearing test data, e.g. "Ab Smith").
 *
 * The bug: customer delete is a soft-delete (is_deleted=true), but the
 * schedule/list queries JOIN customers WHERE is_deleted=false — so a
 * deleted customer's appointments VANISH from view while still holding
 * their slot (status='scheduled' feeds the GiST exclusion constraints).
 * An invisible booking can't be clicked "Cancel".
 *
 * Agreed fix: when a customer is soft-deleted, the same transaction
 * auto-cancels their UPCOMING scheduled appointments (frees the slots)
 * and KEEPS past/completed ones (history/analytics).
 *
 * 5W for sad-path failures:
 *   WHO  — an owner deleting a customer from the CRM view
 *   WHAT — DELETE /customers/:id (soft-delete + upcoming-cancel txn)
 *   WHEN — any time a customer with future bookings is removed
 *   WHERE — src/routes/customers.ts delete handler → appointments rows
 *   WHY  — an invisible 'scheduled' row blocks the slot for real callers
 *          and can't be canceled from any UI
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Client, Pool } from 'pg';
import {
  API_DB_URL,
  getRootClient,
  createTenant,
  createResource,
  createCustomerFull,
  createAppointment,
  skipIfDbDown,
} from '../utils';
import { createWithTenantClient } from '../../src/database';
import { registerCustomerRoutes } from '../../src/routes/customers';

// Stand-in for tenantMiddleware/JWT (same pattern as voice.realdb.test.ts):
// x-tenant-id sets req.tenantId + minimal owner req.auth.
type TenantRequest = FastifyRequest & {
  tenantId?: string;
  auth?: { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
};

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
let tenantId: string;
let resourceId: string;
const tenantsToClean: string[] = [];

function del(customerId: string, role: 'owner' | 'front_desk' = 'owner') {
  return app.inject({
    method: 'DELETE',
    url: `/customers/${customerId}`,
    headers: { 'x-tenant-id': tenantId, 'x-test-role': role },
  });
}

async function apptStatus(appointmentId: string): Promise<string> {
  const res = await setup.query(`SELECT status FROM appointments WHERE appointment_id = $1`, [
    appointmentId,
  ]);
  return res.rows[0]?.status as string;
}

/** ISO instant N hours from now, snapped to a 15-minute boundary (the
 *  appointments_end_time_15min check constraint rejects arbitrary times). */
function hoursFromNow(h: number): string {
  const QUARTER = 900_000;
  const t = Math.round((Date.now() + h * 3_600_000) / QUARTER) * QUARTER;
  return new Date(t).toISOString();
}

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });

    app = Fastify({ logger: false });
    app.addHook('preHandler', async (request: TenantRequest) => {
      const tid = request.headers['x-tenant-id'] as string | undefined;
      if (tid) {
        request.tenantId = tid;
        const role = (request.headers['x-test-role'] as 'owner' | 'front_desk' | undefined) ?? 'owner';
        request.auth = {
          tenant_id: tid,
          user_id: '88888888-8888-4888-8888-888888888888',
          email: 'realdb-custdel@example.com',
          role,
        };
      }
    });
    const withTenantClient = createWithTenantClient(pool);
    registerCustomerRoutes(
      app,
      pool,
      withTenantClient
    );
    await app.ready();

    tenantId = await createTenant(setup, 'CustDelete Cancel Tenant', 'salon');
    tenantsToClean.push(tenantId);
    resourceId = await createResource(setup, tenantId, 'Chair 1');

    dbAvailable = true;
  } catch (err) {
     
    console.warn('[customerDelete.realdb.test] DB not available, skipping', err);
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
});

beforeEach((ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
});

describe('DELETE /customers/:id cancels upcoming appointments', () => {
  it('HAPPY: soft-deletes the customer, auto-cancels UPCOMING scheduled appointments, keeps PAST ones', async () => {
    // WHY each fixture: upcoming-scheduled is the bug (invisible slot-holder);
    // past-completed is the history that must survive; already-canceled must
    // stay canceled (idempotent, not flipped or double-processed).
    const customerId = await createCustomerFull(setup, tenantId, '+15554440001', 'Ab Smith');
    const upcoming = await createAppointment(
      setup,
      tenantId,
      resourceId,
      customerId,
      hoursFromNow(48),
      hoursFromNow(49),
      'upcoming haircut'
    );
    const past = await createAppointment(
      setup,
      tenantId,
      resourceId,
      customerId,
      hoursFromNow(-48),
      hoursFromNow(-47),
      'past haircut',
      'completed'
    );
    const alreadyCanceled = await createAppointment(
      setup,
      tenantId,
      resourceId,
      customerId,
      hoursFromNow(72),
      hoursFromNow(73),
      'already canceled',
      'canceled'
    );

    const res = await del(customerId);
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const cust = await setup.query(`SELECT is_deleted FROM customers WHERE customer_id = $1`, [
      customerId,
    ]);
    expect(cust.rows[0].is_deleted).toBe(true);

    // The invisible slot-holder is freed…
    expect(await apptStatus(upcoming)).toBe('canceled');
    // …history survives…
    expect(await apptStatus(past)).toBe('completed');
    // …and already-canceled stays canceled.
    expect(await apptStatus(alreadyCanceled)).toBe('canceled');
  });

  it("HAPPY: another customer's upcoming appointment is untouched", async () => {
    // WHY: the cancel must be scoped to the deleted customer — a tenant-wide
    // (or unscoped) UPDATE would silently cancel the whole book.
    const victim = await createCustomerFull(setup, tenantId, '+15554440002', 'Del Me');
    const bystander = await createCustomerFull(setup, tenantId, '+15554440003', 'Keep Me');
    const victimAppt = await createAppointment(
      setup,
      tenantId,
      resourceId,
      victim,
      hoursFromNow(24),
      hoursFromNow(25),
      'victim upcoming'
    );
    const bystanderAppt = await createAppointment(
      setup,
      tenantId,
      resourceId,
      bystander,
      hoursFromNow(26),
      hoursFromNow(27),
      'bystander upcoming'
    );

    const res = await del(victim);
    expect(res.statusCode).toBe(200);

    expect(await apptStatus(victimAppt)).toBe('canceled');
    expect(await apptStatus(bystanderAppt)).toBe('scheduled');
  });

  it('SAD: deleting a nonexistent / already-deleted customer → 404, nothing canceled', async () => {
    // WHY: assertRowAffected must still 404 (no silent success), and the
    // second delete of the same customer must not re-run side effects.
    const customerId = await createCustomerFull(setup, tenantId, '+15554440004', 'Twice Deleted');
    const upcoming = await createAppointment(
      setup,
      tenantId,
      resourceId,
      customerId,
      hoursFromNow(24),
      hoursFromNow(25),
      'only cancel once'
    );
    expect((await del(customerId)).statusCode).toBe(200);
    expect(await apptStatus(upcoming)).toBe('canceled');

    // Re-cancelable state probe: reactivate the appointment directly, then
    // delete the (already-deleted) customer again — the 404 path must NOT
    // cancel it a second time.
    await setup.query(`UPDATE appointments SET status = 'scheduled' WHERE appointment_id = $1`, [
      upcoming,
    ]);
    const second = await del(customerId);
    expect(second.statusCode).toBe(404);
    expect(await apptStatus(upcoming)).toBe('scheduled');
  });

  it('SECURITY: a front-desk user is rejected 403 before any row is touched', async () => {
    const customerId = await createCustomerFull(setup, tenantId, '+15554440005', 'Front Desk Blocked');

    const res = await del(customerId, 'front_desk');

    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);
    const cust = await setup.query(`SELECT is_deleted FROM customers WHERE customer_id = $1`, [
      customerId,
    ]);
    expect(cust.rows[0].is_deleted).toBe(false);
  });
});
