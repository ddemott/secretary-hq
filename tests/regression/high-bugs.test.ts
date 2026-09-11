/**
 * Regression tests for the High bug-fix sweep.
 *
 * Feature areas covered (search here when touching any of these):
 *   - **Auth / JWT**: token shape, tenant claims on login, JWT
 *     middleware tenant scoping (BUG-012)
 *   - **RLS**: api_user privilege restrictions and `set_tenant_context`
 *     enforcement (BUG-007, BUG-008)
 *   - **Booking**: required-skill validation in booking RPCs (BUG-009),
 *     customer upsert path during booking (BUG-027)
 *   - **Validation**: input shape guards across routes
 *     (BUG-010, BUG-011, BUG-026)
 *
 * Why bug-numbered, not feature-named: keeps the full regression set
 * for the High sweep together so a future audit can verify all bugs
 * stay closed together. Feature-area work should still grep here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getRootClient,
  getApiClient,
  clearDB,
  setupBasicTenant,
  createTenant,
  createResource,
  createEmployee,
  createScheduleEntry,
  createCustomerFull,
  createUser,
  skipIfDbDown,
} from '../utils';
import { type Client } from 'pg';
import jwt from 'jsonwebtoken';
import type { JwtPayload } from 'jsonwebtoken';
import type { ZodIssue } from 'zod';

type TestJwtPayload = JwtPayload & { tenant_id: string; user_id: string; email: string };

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';

describe('High Bug Fixes (BUG-007, BUG-008, BUG-009, BUG-010, BUG-011, BUG-012, BUG-026, BUG-027)', () => {
  let root: Client;
  let api: Client;
  let dbAvailable = true;
  beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

  beforeAll(async () => {
    try {
      root = await getRootClient();
      api = await getApiClient();
    } catch (err) {
      dbAvailable = false;
      console.warn('[high-bugs.test] Skipping DB tests - connection failed', err);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      if (root) await root.end();
      if (api) await api.end();
    }
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    await clearDB(root);
  });

  // =========================================================
  // BUG-008: api_user should have limited privileges
  // =========================================================
  describe('BUG-008: api_user privilege restriction', () => {
    it('api_user should NOT be able to TRUNCATE tables', async () => {
      if (!dbAvailable) return;
      const { tenantId } = await setupBasicTenant(root);

      await api.query('SELECT set_tenant_context($1::UUID)', [tenantId]);
      const selectRes = await api.query('SELECT count(*) FROM customers');
      expect(parseInt(selectRes.rows[0].count)).toBeGreaterThanOrEqual(0);

      await expect(api.query('TRUNCATE customers')).rejects.toThrow(/permission denied/i);
    });

    it('api_user should be able to SELECT, INSERT, UPDATE, DELETE', async () => {
      if (!dbAvailable) return;
      const { tenantId } = await setupBasicTenant(root);

      await api.query('SELECT set_tenant_context($1::UUID)', [tenantId]);

      const selectRes = await api.query('SELECT * FROM customers WHERE tenant_id = $1', [tenantId]);
      expect(selectRes.rows.length).toBeGreaterThan(0);

      const insertRes = await api.query(
        "INSERT INTO customers (tenant_id, phone, name) VALUES ($1, '+15550009999', 'Test') RETURNING customer_id",
        [tenantId]
      );
      expect(insertRes.rows[0].customer_id).toBeDefined();

      const updateRes = await api.query(
        "UPDATE customers SET name = 'Updated' WHERE customer_id = $1 RETURNING name",
        [insertRes.rows[0].customer_id]
      );
      expect(updateRes.rows[0].name).toBe('Updated');

      const deleteRes = await api.query('DELETE FROM customers WHERE customer_id = $1', [
        insertRes.rows[0].customer_id,
      ]);
      expect(deleteRes.rowCount).toBe(1);
    });
  });

  // =========================================================
  // BUG-009: Service requirements enforced at booking time
  //
  // STRICT since migration 20260911000000: service_resource /
  // service_employee links are the whole rule once p_service_id is passed
  // — required_resources / required_skills tag arrays are never consulted,
  // and a service with no active link is refused outright. Aligns with the
  // phone path's book_with_scheduling_atomic (20260909210000).
  // =========================================================
  describe('BUG-009: Service requirement validation', () => {
    it('should reject booking when service has no active service_resource link (tags ignored)', async () => {
      if (!dbAvailable) return;

      const tenantId = await createTenant(root, 'Cap Shop', 'auto-shop');

      const resourceId = (
        await root.query(
          "INSERT INTO resources (tenant_id, name, capabilities) VALUES ($1, 'Basic Bay', '{}') RETURNING resource_id",
          [tenantId]
        )
      ).rows[0].resource_id;

      const customerId = await createCustomerFull(root, tenantId, '+15550001111', 'Alice');

      const serviceId = (
        await root.query(
          "INSERT INTO services (tenant_id, name, duration_minutes, required_resources) VALUES ($1, 'Tire Install', 60, ARRAY['tire-lift']) RETURNING service_id",
          [tenantId]
        )
      ).rows[0].service_id;
      // No service_resource row. Under the old tag fallback the mismatched
      // 'tire-lift' capability would have rejected this too, for the wrong
      // reason — STRICT rejects it for the real one (no link at all) before
      // capabilities are ever read.

      const result = await root.query(
        'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2026-04-01T10:00:00Z'),
          new Date('2026-04-01T11:00:00Z'),
          'Tire install',
          'call_cap_001',
          null,
          null,
          serviceId,
        ]
      );

      expect(result.rows[0].success).toBe(false);
      expect(result.rows[0].error_message).toContain(
        'No room or line is set up for this kind of appointment'
      );
    });

    it('should allow booking when the resource is linked via service_resource, regardless of capability tags', async () => {
      if (!dbAvailable) return;

      const tenantId = await createTenant(root, 'Cap Shop', 'auto-shop');

      const resourceId = (
        await root.query(
          "INSERT INTO resources (tenant_id, name, capabilities) VALUES ($1, 'Full Bay', '{}') RETURNING resource_id",
          [tenantId]
        )
      ).rows[0].resource_id;

      const customerId = await createCustomerFull(root, tenantId, '+15550001111', 'Alice');

      const serviceId = (
        await root.query(
          // required_resources set to something the resource's (empty)
          // capabilities would fail, proving the tag is never read once
          // the link-map has a row.
          "INSERT INTO services (tenant_id, name, duration_minutes, required_resources) VALUES ($1, 'Tire Install', 60, ARRAY['tire-lift']) RETURNING service_id",
          [tenantId]
        )
      ).rows[0].service_id;
      await root.query(
        'INSERT INTO service_resource (tenant_id, service_id, resource_id) VALUES ($1, $2, $3)',
        [tenantId, serviceId, resourceId]
      );

      const result = await root.query(
        'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2026-04-01T10:00:00Z'),
          new Date('2026-04-01T11:00:00Z'),
          'Tire install',
          'call_cap_002',
          null,
          null,
          serviceId,
        ]
      );

      expect(result.rows[0].success).toBe(true);
    });

    it('should reject booking when service has no active service_employee link (tags ignored)', async () => {
      if (!dbAvailable) return;

      const tenantId = await createTenant(root, 'Skill Shop', 'auto-shop');
      const resourceId = await createResource(root, tenantId, 'Bay 1');
      const customerId = await createCustomerFull(root, tenantId, '+15550001111', 'Alice');
      const employeeId = await createEmployee(root, tenantId, 'Bob', ['oil-change']);
      // 2026-04-01 is a Wednesday. Booking RPCs read only employee_schedule.
      await createScheduleEntry(root, tenantId, employeeId, '2026-04-01', '08:00', '18:00');

      const serviceId = (
        await root.query(
          "INSERT INTO services (tenant_id, name, duration_minutes, required_skills) VALUES ($1, 'Tire Install', 60, ARRAY['tire-install']) RETURNING service_id",
          [tenantId]
        )
      ).rows[0].service_id;
      await root.query(
        'INSERT INTO service_resource (tenant_id, service_id, resource_id) VALUES ($1, $2, $3)',
        [tenantId, serviceId, resourceId]
      );
      // No service_employee row for Bob. Under the old tag fallback his
      // missing 'tire-install' skill would have rejected this too, for the
      // wrong reason — STRICT rejects for the real one (no link at all).

      const result = await root.query(
        'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2026-04-01T10:00:00Z'),
          new Date('2026-04-01T11:00:00Z'),
          'Tire install',
          'call_skill_001',
          null,
          employeeId.toString(),
          serviceId,
        ]
      );

      expect(result.rows[0].success).toBe(false);
      expect(result.rows[0].error_message).toContain(
        'No one is assigned to take this kind of appointment'
      );
    });
  });

  // =========================================================
  // BUG-012: JWT token generation and validation
  // =========================================================
  describe('BUG-012: JWT token handling', () => {
    it('should generate valid JWT tokens', () => {
      const payload = { tenant_id: 'test-uuid', user_id: 'user-uuid', email: 'test@test.com' };
      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });

      const decoded = jwt.verify(token, JWT_SECRET) as TestJwtPayload;
      expect(decoded.tenant_id).toBe('test-uuid');
      expect(decoded.user_id).toBe('user-uuid');
      expect(decoded.email).toBe('test@test.com');
      expect(decoded.exp).toBeDefined();
    });

    it('should reject expired tokens', () => {
      const token = jwt.sign({ tenant_id: 'test', user_id: 'user', email: 'a@b.com' }, JWT_SECRET, {
        expiresIn: '0s',
      });

      expect(() => jwt.verify(token, JWT_SECRET)).toThrow(/expired/i);
    });

    it('should reject tokens with wrong secret', () => {
      const token = jwt.sign(
        { tenant_id: 'test', user_id: 'user', email: 'a@b.com' },
        'wrong-secret',
        { expiresIn: '1h' }
      );

      expect(() => jwt.verify(token, JWT_SECRET)).toThrow(/invalid/i);
    });
  });

  // =========================================================
  // BUG-027: Customer upsert via phone in booking RPC
  // =========================================================
  describe('BUG-027: Customer upsert in booking', () => {
    it('should create customer from phone when customer_id is NULL', async () => {
      if (!dbAvailable) return;

      const tenantId = await createTenant(root, 'Upsert Shop', 'auto-shop');
      const resourceId = await createResource(root, tenantId, 'Bay 1');

      const result = await root.query(
        'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
        [
          tenantId,
          resourceId,
          null,
          new Date('2026-04-01T10:00:00Z'),
          new Date('2026-04-01T11:00:00Z'),
          'Walk-in',
          'call_upsert_001',
          null,
          null,
          null,
          '+15559998888',
          'New Customer',
        ]
      );

      expect(result.rows[0].success).toBe(true);

      const customerRes = await root.query(
        "SELECT * FROM customers WHERE tenant_id = $1 AND phone = '+15559998888'",
        [tenantId]
      );
      expect(customerRes.rows.length).toBe(1);
      expect(customerRes.rows[0].name).toBe('New Customer');
    });

    it('should reuse existing customer when phone matches', async () => {
      if (!dbAvailable) return;

      const tenantId = await createTenant(root, 'Upsert Shop', 'auto-shop');
      const resourceId = await createResource(root, tenantId, 'Bay 1');

      await createCustomerFull(root, tenantId, '+15551112222', 'Existing Customer');

      const result = await root.query(
        'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
        [
          tenantId,
          resourceId,
          null,
          new Date('2026-04-01T10:00:00Z'),
          new Date('2026-04-01T11:00:00Z'),
          'Return visit',
          'call_upsert_002',
          null,
          null,
          null,
          '+15551112222',
          'Ignored Name',
        ]
      );

      expect(result.rows[0].success).toBe(true);

      const customerRes = await root.query(
        "SELECT count(*) FROM customers WHERE tenant_id = $1 AND phone = '+15551112222'",
        [tenantId]
      );
      expect(parseInt(customerRes.rows[0].count)).toBe(1);
    });

    it('should fail if neither customer_id nor phone provided', async () => {
      if (!dbAvailable) return;

      const tenantId = await createTenant(root, 'Upsert Shop', 'auto-shop');
      const resourceId = await createResource(root, tenantId, 'Bay 1');

      const result = await root.query(
        'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
        [
          tenantId,
          resourceId,
          null,
          new Date('2026-04-01T10:00:00Z'),
          new Date('2026-04-01T11:00:00Z'),
          'No customer',
          'call_upsert_003',
          null,
          null,
          null,
          null,
          null,
        ]
      );

      expect(result.rows[0].success).toBe(false);
      expect(result.rows[0].error_message).toContain('Customer ID or phone number is required');
    });
  });

  // =========================================================
  // BUG-007: RLS enforcement via withTenantClient pattern
  // =========================================================
  describe('BUG-007: RLS enforcement via api_user + set_tenant_context', () => {
    it('api_user with tenant A context should NOT see tenant B data', async () => {
      if (!dbAvailable) return;

      const tenantA = await createTenant(root, 'Shop A', 'auto-shop');
      const tenantB = await createTenant(root, 'Shop B', 'salon');

      await createCustomerFull(root, tenantA, '+15550001111', 'Alice A');
      await createCustomerFull(root, tenantB, '+15550002222', 'Bob B');

      await api.query('SELECT set_tenant_context($1::UUID)', [tenantA]);
      const resA = await api.query('SELECT * FROM customers');
      expect(resA.rows.length).toBe(1);
      expect(resA.rows[0].name).toBe('Alice A');

      await api.query('SELECT set_tenant_context($1::UUID)', [tenantB]);
      const resB = await api.query('SELECT * FROM customers');
      expect(resB.rows.length).toBe(1);
      expect(resB.rows[0].name).toBe('Bob B');
    });

    it("api_user with tenant A context should NOT be able to delete tenant B's customer", async () => {
      if (!dbAvailable) return;

      const tenantA = await createTenant(root, 'Shop A', 't');
      const tenantB = await createTenant(root, 'Shop B', 't');

      const customerB = await createCustomerFull(root, tenantB, '+15550002222', 'Secret Bob');

      await api.query('SELECT set_tenant_context($1::UUID)', [tenantA]);
      const deleteRes = await api.query('DELETE FROM customers WHERE customer_id = $1', [
        customerB,
      ]);
      expect(deleteRes.rowCount).toBe(0);

      await api.query('SELECT set_tenant_context($1::UUID)', [tenantB]);
      const checkRes = await api.query('SELECT name FROM customers WHERE customer_id = $1', [
        customerB,
      ]);
      expect(checkRes.rows[0].name).toBe('Secret Bob');
    });

    it('api_user with tenant context should enforce RLS on appointments', async () => {
      if (!dbAvailable) return;

      const tenantA = await createTenant(root, 'Shop A', 't');
      const tenantB = await createTenant(root, 'Shop B', 't');

      const resA = await createResource(root, tenantA, 'Bay A');
      const custA = await createCustomerFull(root, tenantA, '+15550001111', 'Alice');

      const resB = await createResource(root, tenantB, 'Bay B');
      const custB = await createCustomerFull(root, tenantB, '+15550002222', 'Bob');

      await root.query(
        "INSERT INTO appointments (tenant_id, resource_id, customer_id, start_time, end_time, description) VALUES ($1, $2, $3, $4, $5, 'A appt')",
        [tenantA, resA, custA, '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z']
      );
      await root.query(
        "INSERT INTO appointments (tenant_id, resource_id, customer_id, start_time, end_time, description) VALUES ($1, $2, $3, $4, $5, 'B appt')",
        [tenantB, resB, custB, '2026-04-01T10:00:00Z', '2026-04-01T11:00:00Z']
      );

      await api.query('SELECT set_tenant_context($1::UUID)', [tenantA]);
      const apptA = await api.query('SELECT * FROM appointments');
      expect(apptA.rows.length).toBe(1);
      expect(apptA.rows[0].description).toBe('A appt');
    });
  });

  // =========================================================
  // BUG-009 (additional): success paths, STRICT link-map (20260911000000)
  // =========================================================
  describe('BUG-009: Service requirement validation (success paths)', () => {
    it('should allow booking when employee and resource are both linked to the service (skills tag irrelevant)', async () => {
      if (!dbAvailable) return;

      const tenantId = await createTenant(root, 'Skill Shop', 'auto-shop');
      const resourceId = await createResource(root, tenantId, 'Bay 1');
      const customerId = await createCustomerFull(root, tenantId, '+15550001111', 'Alice');
      const employeeId = await createEmployee(root, tenantId, 'Expert Mike', [
        'tire-install',
        'oil-change',
      ]);
      // 2026-04-01 is a Wednesday. Booking RPCs read only employee_schedule.
      await createScheduleEntry(root, tenantId, employeeId, '2026-04-01', '08:00', '18:00');

      const serviceId = (
        await root.query(
          "INSERT INTO services (tenant_id, name, duration_minutes, required_skills) VALUES ($1, 'Tire Install', 60, ARRAY['tire-install']) RETURNING service_id",
          [tenantId]
        )
      ).rows[0].service_id;
      await root.query(
        'INSERT INTO service_resource (tenant_id, service_id, resource_id) VALUES ($1, $2, $3)',
        [tenantId, serviceId, resourceId]
      );
      await root.query(
        'INSERT INTO service_employee (tenant_id, service_id, employee_id) VALUES ($1, $2, $3)',
        [tenantId, serviceId, employeeId]
      );

      const result = await root.query(
        'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2026-04-01T10:00:00Z'),
          new Date('2026-04-01T11:00:00Z'),
          'Tire install',
          'call_skill_pass',
          null,
          employeeId.toString(),
          serviceId,
        ]
      );

      expect(result.rows[0].success).toBe(true);
      expect(result.rows[0].appointment_id).not.toBeNull();
    });

    it('should allow booking with service_id but no employee, as long as the resource is linked (employee check skipped, resource check still STRICT)', async () => {
      if (!dbAvailable) return;

      const tenantId = await createTenant(root, 'Skill Shop', 'auto-shop');

      const resourceId = (
        await root.query(
          "INSERT INTO resources (tenant_id, name, capabilities) VALUES ($1, 'Full Bay', '{}') RETURNING resource_id",
          [tenantId]
        )
      ).rows[0].resource_id;

      const customerId = await createCustomerFull(root, tenantId, '+15550001111', 'Alice');

      const serviceId = (
        await root.query(
          "INSERT INTO services (tenant_id, name, duration_minutes) VALUES ($1, 'Tire Install', 60) RETURNING service_id",
          [tenantId]
        )
      ).rows[0].service_id;
      await root.query(
        'INSERT INTO service_resource (tenant_id, service_id, resource_id) VALUES ($1, $2, $3)',
        [tenantId, serviceId, resourceId]
      );

      const result = await root.query(
        'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2026-04-01T10:00:00Z'),
          new Date('2026-04-01T11:00:00Z'),
          'Tire install unassigned',
          'call_skill_noemp',
          null,
          null,
          serviceId,
        ]
      );

      expect(result.rows[0].success).toBe(true);
    });
  });

  // =========================================================
  // BUG-012 (additional): Integration — login returns JWT
  // =========================================================
  describe('BUG-012: Login returns JWT with tenant claims', () => {
    it('JWT payload should contain tenant_id, user_id, and email', async () => {
      if (!dbAvailable) return;

      const tenantId = await createTenant(root, 'JWT Shop', 'auto-shop');
      const userId = await createUser(root, tenantId, 'jwt@test.com', 'testpass123', 'JWT User');

      const token = jwt.sign(
        { tenant_id: tenantId, user_id: userId, email: 'jwt@test.com' },
        JWT_SECRET,
        { expiresIn: '8h' }
      );

      const decoded = jwt.verify(token, JWT_SECRET) as TestJwtPayload;
      expect(decoded.tenant_id).toBe(tenantId);
      expect(decoded.user_id).toBe(userId);
      expect(decoded.email).toBe('jwt@test.com');

      const now = Math.floor(Date.now() / 1000);
      expect(decoded.exp).toBeGreaterThan(now);
      expect(decoded.exp).toBeLessThanOrEqual(now + 8 * 60 * 60 + 5);
    });

    it('JWT should be tied to a specific tenant — cannot be forged for another', () => {
      const tokenA = jwt.sign(
        { tenant_id: 'tenant-a', user_id: 'u1', email: 'a@a.com' },
        JWT_SECRET,
        { expiresIn: '1h' }
      );

      const decoded = jwt.verify(tokenA, JWT_SECRET) as TestJwtPayload;
      expect(decoded.tenant_id).toBe('tenant-a');
      expect(decoded.tenant_id).not.toBe('tenant-b');

      const forgedToken = jwt.sign(
        { tenant_id: 'tenant-b', user_id: 'u2', email: 'b@b.com' },
        'attacker-secret',
        { expiresIn: '1h' }
      );
      expect(() => jwt.verify(forgedToken, JWT_SECRET)).toThrow();
    });
  });

  // =========================================================
  // BUG-011: Input validation (zod schemas)
  // =========================================================
  describe('BUG-011: Input validation schemas', () => {
    it('should validate correct customer create payload', () => {
      const { z } = require('zod');
      const CustomerCreateSchema = z.object({
        tenant_id: z.string().uuid(),
        name: z.string().min(1).max(200),
        phone: z.string().min(1).max(30),
        email: z.string().email().optional().nullable(),
      });

      const valid = CustomerCreateSchema.safeParse({
        tenant_id: 'f234e471-0e60-4163-86c9-93cfd9338e3a',
        name: 'Alice',
        phone: '+15550001111',
        email: 'alice@example.com',
      });
      expect(valid.success).toBe(true);
    });

    it('should reject invalid UUID in tenant_id', () => {
      const { z } = require('zod');
      const CustomerCreateSchema = z.object({
        tenant_id: z.string().uuid(),
        name: z.string().min(1),
        phone: z.string().min(1),
      });

      const invalid = CustomerCreateSchema.safeParse({
        tenant_id: 'not-a-uuid',
        name: 'Alice',
        phone: '+15550001111',
      });
      expect(invalid.success).toBe(false);
    });

    it('should reject empty name', () => {
      const { z } = require('zod');
      const CustomerCreateSchema = z.object({
        tenant_id: z.string().uuid(),
        name: z.string().min(1),
        phone: z.string().min(1),
      });

      const invalid = CustomerCreateSchema.safeParse({
        tenant_id: '00000000-0000-0000-0000-000000000001',
        name: '',
        phone: '+15550001111',
      });
      expect(invalid.success).toBe(false);
    });
  });

  // =========================================================
  // Error diagnostics — verify error responses contain context
  // =========================================================
  describe('Error diagnostics — contextual error messages', () => {
    it('booking RPC error_message identifies WHY it failed (unlinked resource, STRICT)', async () => {
      if (!dbAvailable) return;

      const tenantId = await createTenant(root, 'Diag Shop', 'auto-shop');
      const resourceId = (
        await root.query(
          "INSERT INTO resources (tenant_id, name, capabilities) VALUES ($1, 'Empty Bay', '{}') RETURNING resource_id",
          [tenantId]
        )
      ).rows[0].resource_id;
      const customerId = await createCustomerFull(root, tenantId, '+15550009876', 'Diag Customer');
      const serviceId = (
        await root.query(
          "INSERT INTO services (tenant_id, name, duration_minutes) VALUES ($1, 'Special Service', 60) RETURNING service_id",
          [tenantId]
        )
      ).rows[0].service_id;
      // No service_resource row for Empty Bay — STRICT (20260911000000)
      // refuses before any capability tag is ever read.

      const result = await root.query(
        'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2026-04-01T10:00:00Z'),
          new Date('2026-04-01T11:00:00Z'),
          'Diagnostic test',
          'call_diag_001',
          null,
          null,
          serviceId,
        ]
      );

      expect(result.rows[0].success).toBe(false);
      const msg = result.rows[0].error_message;
      // Error should be specific — not "booking failed" but WHY
      expect(msg).toBeDefined();
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).toContain('No room or line is set up for this kind of appointment');
      // Should NOT be a generic message
      expect(msg).not.toMatch(/^(error|failed|something went wrong)$/i);
    });

    it('booking RPC error_message identifies WHY it failed (unlinked employee, STRICT)', async () => {
      if (!dbAvailable) return;

      const tenantId = await createTenant(root, 'Skill Diag', 'auto-shop');
      const resourceId = await createResource(root, tenantId, 'Bay 1');
      const customerId = await createCustomerFull(root, tenantId, '+15550005555', 'Diag Alice');
      const employeeId = await createEmployee(root, tenantId, 'Junior', ['sweeping']);
      // 2026-04-01 is a Wednesday. Booking RPCs read only employee_schedule.
      await createScheduleEntry(root, tenantId, employeeId, '2026-04-01', '08:00', '18:00');

      const serviceId = (
        await root.query(
          "INSERT INTO services (tenant_id, name, duration_minutes) VALUES ($1, 'Expert Service', 60) RETURNING service_id",
          [tenantId]
        )
      ).rows[0].service_id;
      await root.query(
        'INSERT INTO service_resource (tenant_id, service_id, resource_id) VALUES ($1, $2, $3)',
        [tenantId, serviceId, resourceId]
      );
      // No service_employee row for Junior — STRICT (20260911000000)
      // refuses before any skill tag is ever read.

      const result = await root.query(
        'SELECT * FROM book_appointment_atomic($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          tenantId,
          resourceId,
          customerId,
          new Date('2026-04-01T10:00:00Z'),
          new Date('2026-04-01T11:00:00Z'),
          'Skill check',
          'call_diag_002',
          null,
          employeeId.toString(),
          serviceId,
        ]
      );

      expect(result.rows[0].success).toBe(false);
      const msg = result.rows[0].error_message;
      expect(msg).toBeDefined();
      expect(msg).toContain('No one is assigned to take this kind of appointment');
      expect(msg).not.toMatch(/^(error|failed|something went wrong)$/i);
    });

    it('zod validation errors include field-level detail', () => {
      const { z } = require('zod');
      const AppointmentSchema = z.object({
        tenant_id: z.string().uuid(),
        resource_id: z.string().uuid(),
        start_time: z.string().datetime(),
        description: z.string().min(1).max(500),
      });

      const result = AppointmentSchema.safeParse({
        tenant_id: 'not-uuid',
        resource_id: '',
        start_time: 'tuesday',
        description: '',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues;
        // Should have multiple field-level errors, not one generic error
        expect(issues.length).toBeGreaterThanOrEqual(3);

        // Each issue should identify WHICH field (path) and WHY (message)
        const paths = issues.map((i: ZodIssue) => i.path[0]);
        expect(paths).toContain('tenant_id');
        expect(paths).toContain('start_time');
        expect(paths).toContain('description');

        // Messages should be specific
        issues.forEach((issue: ZodIssue) => {
          expect(issue.message).toBeDefined();
          expect(issue.message.length).toBeGreaterThan(0);
          expect(issue.message).not.toBe('error');
        });
      }
    });

    it('JWT verification error clearly states reason (expired vs invalid)', () => {
      // Expired token
      const expiredToken = jwt.sign(
        { tenant_id: 'test', user_id: 'u1', email: 'a@b.com' },
        JWT_SECRET,
        { expiresIn: '0s' }
      );

      try {
        jwt.verify(expiredToken, JWT_SECRET);
        expect.fail('Should have thrown');
      } catch (err) {
        // Error should clearly say "expired" — not just "invalid"
        expect(err.message).toMatch(/expired/i);
        expect(err.name).toBe('TokenExpiredError');
        expect(err.expiredAt).toBeDefined();
      }

      // Wrong secret token
      const badSecretToken = jwt.sign(
        { tenant_id: 'test', user_id: 'u1', email: 'a@b.com' },
        'wrong-secret'
      );

      try {
        jwt.verify(badSecretToken, JWT_SECRET);
        expect.fail('Should have thrown');
      } catch (err) {
        // Error should clearly say "invalid signature" — different from expired
        expect(err.message).toMatch(/invalid signature/i);
        expect(err.name).toBe('JsonWebTokenError');
      }
    });
  });
});
