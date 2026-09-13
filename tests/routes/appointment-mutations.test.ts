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

describe('Appointment Update & Cancel', () => {
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
      console.warn('[appointment-mutations.test] Skipping DB tests - connection failed', err);
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

  async function createService(name: string, duration: number) {
    const res = await client.query(
      'INSERT INTO services (tenant_id, name, duration_minutes) VALUES ($1, $2, $3) RETURNING service_id',
      [tenantId, name, duration]
    );
    return res.rows[0].service_id;
  }

  async function createEmployee(name: string) {
    const res = await client.query(
      'INSERT INTO employees (tenant_id, name, first_name, last_name) VALUES ($1, $2, $3, $4) RETURNING employee_id',
      [tenantId, name, name.split(' ')[0], name.split(' ')[1] || '']
    );
    return res.rows[0].employee_id;
  }

  async function bookAppointment(opts: { employeeId?: string; serviceId?: string } = {}) {
    const svcId = opts.serviceId || (await createService('Oil Change', 30));

    // Assign resource to service
    await client.query(
      'INSERT INTO service_resource (tenant_id, service_id, resource_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [tenantId, svcId, resourceId]
    );

    let empId = opts.employeeId;
    if (!empId) {
      empId = await createEmployee('Mike Smith');
      // Assign employee to service
      await client.query(
        'INSERT INTO service_employee (tenant_id, service_id, employee_id) VALUES ($1, $2, $3)',
        [tenantId, svcId, empId]
      );
      // 2027-03-15 is the booking date (Monday). Booking RPCs
      // read only employee_schedule.
      await client.query(
        "INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off) VALUES ($1, $2, '2027-03-15', '08:00', '17:00', false)",
        [tenantId, empId]
      );
    }

    const res = await client.query(
      'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        tenantId,
        resourceId,
        customerId,
        '2027-03-15T10:00:00Z',
        '2027-03-15T10:30:00Z',
        'Oil Change',
        'test',
        null,
        empId,
      ]
    );
    return { appointmentId: res.rows[0].appointment_id, employeeId: empId, serviceId: svcId };
  }

  // --- Cancel Tests ---

  it("should cancel an appointment by setting status to 'canceled'", async () => {
    if (!dbAvailable) return;

    const { appointmentId } = await bookAppointment();

    const res = await client.query(
      "UPDATE appointments SET status = 'canceled' WHERE appointment_id = $1 AND tenant_id = $2 RETURNING appointment_id, status",
      [appointmentId, tenantId]
    );

    expect(res.rows.length).toBe(1);
    expect(res.rows[0].status).toBe('canceled');
  });

  it('should not delete the appointment row on cancel', async () => {
    if (!dbAvailable) return;

    const { appointmentId } = await bookAppointment();

    await client.query(
      "UPDATE appointments SET status = 'canceled' WHERE appointment_id = $1 AND tenant_id = $2",
      [appointmentId, tenantId]
    );

    const res = await client.query(
      'SELECT appointment_id, status FROM appointments WHERE appointment_id = $1',
      [appointmentId]
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].status).toBe('canceled');
  });

  it('should return 0 rows when canceling a non-existent appointment', async () => {
    if (!dbAvailable) return;

    const res = await client.query(
      "UPDATE appointments SET status = 'canceled' WHERE appointment_id = $1 AND tenant_id = $2 RETURNING appointment_id",
      ['00000000-0000-0000-0000-000000000000', tenantId]
    );

    expect(res.rows.length).toBe(0);
  });

  it('should not cancel an appointment from a different tenant', async () => {
    if (!dbAvailable) return;

    const { appointmentId } = await bookAppointment();
    const fakeTenantId = '00000000-0000-0000-0000-999999999999';

    const res = await client.query(
      "UPDATE appointments SET status = 'canceled' WHERE appointment_id = $1 AND tenant_id = $2 RETURNING appointment_id",
      [appointmentId, fakeTenantId]
    );

    expect(res.rows.length).toBe(0);

    // Original still active
    const check = await client.query('SELECT status FROM appointments WHERE appointment_id = $1', [
      appointmentId,
    ]);
    expect(check.rows[0].status).not.toBe('canceled');
  });

  // --- Update Tests ---

  it('should update appointment fields via update_appointment_customer', async () => {
    if (!dbAvailable) return;

    const { appointmentId } = await bookAppointment();

    const res = await client.query(
      'SELECT * FROM update_appointment_customer($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        appointmentId,
        tenantId,
        '2027-03-15T11:00:00Z',
        '2027-03-15T11:30:00Z',
        'Tire Rotation',
        '456 Oak Ave',
        'Alice Updated',
        '+15550002222',
        'VIP customer',
      ]
    );

    expect(res.rows[0].success).toBe(true);

    // Verify appointment was updated
    const appt = await client.query(
      'SELECT description, location, start_time FROM appointments WHERE appointment_id = $1',
      [appointmentId]
    );
    expect(appt.rows[0].description).toBe('Tire Rotation');
    expect(appt.rows[0].location).toBe('456 Oak Ave');
  });

  it('should update customer name and phone via update_appointment_customer', async () => {
    if (!dbAvailable) return;

    const { appointmentId } = await bookAppointment();

    await client.query(
      'SELECT * FROM update_appointment_customer($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        appointmentId,
        tenantId,
        '2027-03-15T10:00:00Z',
        '2027-03-15T10:30:00Z',
        'Oil Change',
        null,
        'Alice Renamed',
        '+15559998888',
        'Updated notes',
      ]
    );

    const cust = await client.query('SELECT name, phone FROM customers WHERE customer_id = $1', [
      customerId,
    ]);
    expect(cust.rows[0].name).toBe('Alice Renamed');
    expect(cust.rows[0].phone).toBe('+15559998888');
  });

  it('should fail update for non-existent appointment', async () => {
    if (!dbAvailable) return;

    const res = await client.query(
      'SELECT * FROM update_appointment_customer($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        '00000000-0000-0000-0000-000000000000',
        tenantId,
        '2027-03-15T10:00:00Z',
        '2027-03-15T10:30:00Z',
        'Test',
        null,
        'Nobody',
        '+15550000000',
        '',
      ]
    );

    expect(res.rows[0].success).toBe(false);
  });

  // --- Delete Tests ---

  it('should hard-delete an appointment', async () => {
    if (!dbAvailable) return;

    const { appointmentId } = await bookAppointment();

    await client.query('DELETE FROM appointments WHERE appointment_id = $1', [appointmentId]);

    const res = await client.query(
      'SELECT appointment_id FROM appointments WHERE appointment_id = $1',
      [appointmentId]
    );
    expect(res.rows.length).toBe(0);
  });

  it('should allow rebooking the same slot after cancel', async () => {
    if (!dbAvailable) return;

    const { appointmentId, employeeId, _serviceId } = await bookAppointment();

    // Cancel
    await client.query("UPDATE appointments SET status = 'canceled' WHERE appointment_id = $1", [
      appointmentId,
    ]);

    // Rebook same slot
    const res = await client.query(
      'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        tenantId,
        resourceId,
        customerId,
        '2027-03-15T10:00:00Z',
        '2027-03-15T10:30:00Z',
        'Oil Change Rebooking',
        'test',
        null,
        employeeId,
      ]
    );

    expect(res.rows[0].success).toBe(true);
    expect(res.rows[0].appointment_id).not.toBe(appointmentId);
  });
});
