/**
 * Real-DB companion for POST /appointments/:id/update's business-rule
 * re-validation (2026-09-13).
 *
 * 5W:
 *   WHO  — a dashboard operator editing an existing appointment's time,
 *          resource, or employee
 *   WHAT — the update route used to do a raw column UPDATE with NO
 *          re-validation: no blackout-date check, no shift-coverage check
 *          on a time change, and no STRICT skill-map re-check on a
 *          resource/employee reassignment. book_appointment_atomic (the
 *          CREATE path) already enforces all three; the EDIT path was the
 *          one door left where "Person -> Role -> Resource" (Dale,
 *          20260911000000) didn't hold.
 *   WHEN — every PATCH-style update that changes start_time/end_time,
 *          resource_id, or employee_id
 *   WHERE — src/routes/appointments.ts POST /:id/update handler
 *   WHY  — an operator could drag an appointment onto a closed day, an
 *          unstaffed hour, or an unlinked resource/employee via the edit
 *          UI, sidestepping every guard enforced at creation
 *
 * WHY REAL POSTGRES: the checks query blackout_dates, employee_schedule,
 * service_resource/service_employee, and call shift_row_covers_booking() —
 * a mocked pool only proves the mock returns what the test told it to.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import { registerAppointmentRoutes } from '../../src/routes/appointments';

interface TestAuth {
  user_id: string;
  tenant_id: string;
  email: string;
  role: string;
}

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
let tenantId: string;
const tenantsToClean: string[] = [];

const auth: { current: TestAuth | null } = { current: null };

function asOwner(forTenantId: string) {
  auth.current = {
    user_id: '00000000-0000-0000-0000-00000000bb01',
    tenant_id: forTenantId,
    email: 'owner@appt-update-realdb.local',
    role: 'owner',
  };
}

function update(appointmentId: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: `/appointments/${appointmentId}/update`,
    payload,
  });
}

/** ISO instant N hours from now, snapped to a 15-min boundary. */
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
    app.addHook('preHandler', async (request) => {
      (request as unknown as { auth: TestAuth | null }).auth = auth.current;
    });
    app.setErrorHandler(async (error: Error & { statusCode?: number }, _request, reply) =>
      reply
        .status(error.statusCode || 500)
        .send({ success: false, error: error.message || 'Internal server error' })
    );
    const withTenantClient = createWithTenantClient(pool);
    registerAppointmentRoutes(app, pool, withTenantClient);
    await app.ready();

    tenantId = await createTenant(setup, 'Appt Update Revalidation Co', 'auto-repair', 'UTC');
    tenantsToClean.push(tenantId);
    asOwner(tenantId);

    dbAvailable = true;
  } catch (err) {
    console.warn('[appointmentUpdateRevalidation.realdb] DB not available, skipping', err);
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

beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

describe('POST /appointments/:id/update — business-rule re-validation', () => {
  it('HAPPY: description-only edit still succeeds (no regression)', async () => {
    const resourceId = await createResource(setup, tenantId, 'Bay 1');
    const customerId = await createCustomerFull(setup, tenantId, '+15550001001', 'Alice');
    const apptRes = await setup.query<{ appointment_id: string }>(
      `INSERT INTO appointments (tenant_id, resource_id, customer_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4, $5, 'original', 'scheduled') RETURNING appointment_id`,
      [tenantId, resourceId, customerId, hoursFromNow(48), hoursFromNow(49)]
    );
    const apptId = apptRes.rows[0].appointment_id;

    const res = await update(apptId, {
      tenant_id: tenantId,
      description: 'edited note only',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('SAD: reassigning to an unlinked resource is refused (NO_SKILLED_RESOURCE)', async () => {
    const serviceId = await createService(setup, tenantId, 'Tire Mount', 30, 0);
    const linkedResourceId = await createResource(setup, tenantId, 'Linked Bay');
    const unlinkedResourceId = await createResource(setup, tenantId, 'Unlinked Bay');
    await assignResourceToService(setup, tenantId, serviceId, linkedResourceId);
    const customerId = await createCustomerFull(setup, tenantId, '+15550001002', 'Bob');
    const apptRes = await setup.query<{ appointment_id: string }>(
      `INSERT INTO appointments (tenant_id, resource_id, customer_id, service_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'tire mount', 'scheduled') RETURNING appointment_id`,
      [tenantId, linkedResourceId, customerId, serviceId, hoursFromNow(50), hoursFromNow(51)]
    );
    const apptId = apptRes.rows[0].appointment_id;

    const res = await update(apptId, {
      tenant_id: tenantId,
      resource_id: unlinkedResourceId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('NO_SKILLED_RESOURCE');

    const row = await setup.query(
      `SELECT resource_id FROM appointments WHERE appointment_id = $1`,
      [apptId]
    );
    expect(row.rows[0].resource_id).toBe(linkedResourceId);
  });

  it('SAD: reassigning to an unlinked employee is refused (NO_SKILLED_EMPLOYEE)', async () => {
    const serviceId = await createService(setup, tenantId, 'Oil Change', 30, 0);
    const resourceId = await createResource(setup, tenantId, 'Bay Oil');
    await assignResourceToService(setup, tenantId, serviceId, resourceId);
    const linkedEmployeeId = await createEmployee(setup, tenantId, 'Linked Employee');
    const unlinkedEmployeeId = await createEmployee(setup, tenantId, 'Unlinked Employee');
    await assignEmployeeToService(setup, tenantId, serviceId, linkedEmployeeId);
    const customerId = await createCustomerFull(setup, tenantId, '+15550001003', 'Carla');
    const apptRes = await setup.query<{ appointment_id: string }>(
      `INSERT INTO appointments (tenant_id, resource_id, employee_id, customer_id, service_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'oil change', 'scheduled') RETURNING appointment_id`,
      [
        tenantId,
        resourceId,
        linkedEmployeeId,
        customerId,
        serviceId,
        hoursFromNow(52),
        hoursFromNow(53),
      ]
    );
    const apptId = apptRes.rows[0].appointment_id;

    const res = await update(apptId, {
      tenant_id: tenantId,
      employee_id: unlinkedEmployeeId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('NO_SKILLED_EMPLOYEE');

    const row = await setup.query(
      `SELECT employee_id FROM appointments WHERE appointment_id = $1`,
      [apptId]
    );
    expect(row.rows[0].employee_id).toBe(linkedEmployeeId);
  });

  it('SAD: moving onto a blackout date is refused (BUSINESS_CLOSED)', async () => {
    const resourceId = await createResource(setup, tenantId, 'Bay Closed');
    const customerId = await createCustomerFull(setup, tenantId, '+15550001004', 'Dana');
    const originalFrom = hoursFromNow(60);
    const apptRes = await setup.query<{ appointment_id: string }>(
      `INSERT INTO appointments (tenant_id, resource_id, customer_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4, $5, 'closed-day test', 'scheduled') RETURNING appointment_id`,
      [tenantId, resourceId, customerId, originalFrom, hoursFromNow(61)]
    );
    const apptId = apptRes.rows[0].appointment_id;

    const blackoutDate = '2027-08-16';
    await setup.query(
      `INSERT INTO blackout_dates (tenant_id, blackout_date, reason) VALUES ($1, $2::date, 'Test holiday')`,
      [tenantId, blackoutDate]
    );
    try {
      const res = await update(apptId, {
        tenant_id: tenantId,
        start_time: `${blackoutDate}T10:00:00.000Z`,
        end_time: `${blackoutDate}T11:00:00.000Z`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error_code).toBe('BUSINESS_CLOSED');

      const row = await setup.query<{ start_time: Date }>(
        `SELECT start_time FROM appointments WHERE appointment_id = $1`,
        [apptId]
      );
      expect(row.rows[0].start_time.toISOString()).toBe(originalFrom);
    } finally {
      await setup.query(
        `DELETE FROM blackout_dates WHERE tenant_id = $1 AND blackout_date = $2::date`,
        [tenantId, blackoutDate]
      );
    }
  });

  it('SAD: moving an employee-assigned appointment onto an unstaffed time is refused (EMPLOYEE_NOT_SCHEDULED)', async () => {
    const employeeId = await createEmployee(setup, tenantId, 'Unscheduled Uma');
    const resourceId = await createResource(setup, tenantId, 'Bay Unstaffed');
    const customerId = await createCustomerFull(setup, tenantId, '+15550001005', 'Eve');
    const originalFrom = hoursFromNow(70);
    const apptRes = await setup.query<{ appointment_id: string }>(
      `INSERT INTO appointments (tenant_id, resource_id, employee_id, customer_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'unstaffed test', 'scheduled') RETURNING appointment_id`,
      [tenantId, resourceId, employeeId, customerId, originalFrom, hoursFromNow(71)]
    );
    const apptId = apptRes.rows[0].appointment_id;

    // No employee_schedule row anywhere near this target date — nobody is on shift.
    const res = await update(apptId, {
      tenant_id: tenantId,
      start_time: '2027-08-20T10:00:00.000Z',
      end_time: '2027-08-20T11:00:00.000Z',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('EMPLOYEE_NOT_SCHEDULED');

    const row = await setup.query<{ start_time: Date }>(
      `SELECT start_time FROM appointments WHERE appointment_id = $1`,
      [apptId]
    );
    expect(row.rows[0].start_time.toISOString()).toBe(originalFrom);
  });

  it('HAPPY: moving into the morning half of a night shift succeeds (night-shift aware)', async () => {
    const employeeId = await createEmployee(setup, tenantId, 'Night Shift Nina');
    await createScheduleEntry(setup, tenantId, employeeId, '2027-08-23', '22:00', '06:00');
    const resourceId = await createResource(setup, tenantId, 'Bay Night');
    const customerId = await createCustomerFull(setup, tenantId, '+15550001006', 'Frank');
    const apptRes = await setup.query<{ appointment_id: string }>(
      `INSERT INTO appointments (tenant_id, resource_id, employee_id, customer_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'night shift test', 'scheduled') RETURNING appointment_id`,
      [tenantId, resourceId, employeeId, customerId, hoursFromNow(80), hoursFromNow(81)]
    );
    const apptId = apptRes.rows[0].appointment_id;

    const res = await update(apptId, {
      tenant_id: tenantId,
      // The wrapped tail of the 2027-08-23 22:00->06:00 shift.
      start_time: '2027-08-24T02:00:00.000Z',
      end_time: '2027-08-24T02:30:00.000Z',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const row = await setup.query<{ start_time: Date }>(
      `SELECT start_time FROM appointments WHERE appointment_id = $1`,
      [apptId]
    );
    expect(row.rows[0].start_time.toISOString()).toBe('2027-08-24T02:00:00.000Z');
  });
});
