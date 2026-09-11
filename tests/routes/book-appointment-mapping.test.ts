/**
 * book_appointment_atomic — mapping-table-aware skill + resource check.
 *
 * Closes the gap where the dashboard's UI alignment filter (commit
 * 967402d) used the service_employee / service_resource mapping tables
 * as the source of truth for "who can do what," but the booking RPC
 * was checking a different model — the `services.required_skills` text
 * array against `employees.skills` text array. The seed data populates
 * the mapping tables but NOT the skills array, so passing service_id
 * from the dashboard would have caused the array check to falsely
 * reject every booking.
 *
 * STRICT since migration 20260911000000 (aligning with the phone path's
 * book_with_scheduling_atomic / 20260909210000 — "the skill map decides
 * who and where"):
 * - When p_service_id is provided, the mapping IS the constraint, full
 *   stop. Mapping miss (a picked employee/resource not in the mapping) →
 *   "not assigned to perform this service".
 * - A service with NO active service_employee/service_resource rows at
 *   all is refused outright — no fall-open, no fallback to the legacy
 *   services.required_skills / employees.skills array check. Two lists
 *   that must agree is a bug this schema has already paid for three
 *   times; the array columns are simply never read here anymore.
 * - When p_service_id is NULL, no check fires at all (legacy path,
 *   unchanged from prior commits).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { type Client } from 'pg';
import {
  getRootClient,
  clearDB,
  createTenant,
  createResource,
  createEmployee,
  createService,
  createScheduleEntry,
  createCustomerFull,
  assignEmployeeToService,
  assignResourceToService,
  beginTestTransaction,
  rollbackTestTransaction,
  skipIfDbDown,
} from '../utils';

let root: Client;
let dbAvailable = false;
beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

beforeAll(async () => {
  try {
    root = await getRootClient();
    dbAvailable = true;
    await clearDB(root);
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (root) await root.end();
});

beforeEach(async () => {
  if (dbAvailable) await beginTestTransaction(root);
});

afterEach(async () => {
  if (dbAvailable) await rollbackTestTransaction(root);
});

async function bookAppointment(params: {
  tenant_id: string;
  resource_id: string;
  customer_id: string;
  start_time: string;
  end_time: string;
  description?: string;
  employee_id?: string | null;
  service_id?: string | null;
}) {
  const res = await root.query(
    `SELECT * FROM book_appointment_atomic(
            $1::UUID, $2::UUID, $3::UUID, $4::TIMESTAMPTZ, $5::TIMESTAMPTZ,
            $6::TEXT, $7::TEXT, NULL::TEXT, $8::TEXT, $9::UUID, NULL::TEXT, NULL::TEXT
        )`,
    [
      params.tenant_id,
      params.resource_id,
      params.customer_id,
      params.start_time,
      params.end_time,
      params.description ?? 'Test booking',
      'test-call',
      params.employee_id ?? null, // p_assignment_id is the employee/user id
      params.service_id ?? null,
    ]
  );
  return res.rows[0] as {
    success: boolean;
    appointment_id: string | null;
    error_message: string | null;
  };
}

describe('book_appointment_atomic — service_employee mapping enforcement', () => {
  it('HAPPY: booking succeeds when employee is mapped to the service', async () => {
    if (!dbAvailable) return;
    const tenantId = await createTenant(root, 'Mapping HAPPY', 'auto-repair', 'America/Chicago');
    const resourceId = await createResource(root, tenantId, 'Bay 1');
    const empId = await createEmployee(root, tenantId, 'Mike');
    const svcId = await createService(root, tenantId, 'Tire Mount', 60);
    const customerId = await createCustomerFull(root, tenantId, '+15555550101', 'Alice');
    await assignEmployeeToService(root, tenantId, svcId, empId);
    await assignResourceToService(root, tenantId, svcId, resourceId);
    await createScheduleEntry(root, tenantId, empId, '2026-07-01', '08:00', '17:00');

    const result = await bookAppointment({
      tenant_id: tenantId,
      resource_id: resourceId,
      customer_id: customerId,
      employee_id: empId,
      service_id: svcId,
      start_time: '2026-07-01T14:00:00-05:00',
      end_time: '2026-07-01T15:00:00-05:00',
    });

    expect(result.success).toBe(true);
    expect(result.appointment_id).toBeTruthy();
    expect(result.error_message).toBeNull();
    // Service id persisted on the new row.
    const row = await root.query('SELECT service_id FROM appointments WHERE appointment_id = $1', [
      result.appointment_id,
    ]);
    expect(row.rows[0].service_id).toBe(svcId);
    // WHO: front-desk operator booking Mike for Tire Mount with the dashboard's alignment filter — Mike appears in the dropdown because he has a service_employee row | WHAT: RPC accepts the booking, persists service_id | WHEN: every dashboard booking once /appointments/create threads serviceId through | WHERE: book_appointment_atomic mapping check + INSERT | WHY: this is the load-bearing happy path — pin both the accept (operator's pick passes the new gate) and the persistence (downstream "what services has Mike performed today" queries can rely on service_id, no free-text matching against description)
  });

  it('SAD: booking rejected when employee is NOT in the service_employee mapping', async () => {
    if (!dbAvailable) return;
    const tenantId = await createTenant(root, 'Mapping SAD', 'auto-repair', 'America/Chicago');
    const resourceId = await createResource(root, tenantId, 'Bay 1');
    const mike = await createEmployee(root, tenantId, 'Mike');
    const dana = await createEmployee(root, tenantId, 'Dana');
    const svcId = await createService(root, tenantId, 'Tire Mount', 60);
    const customerId = await createCustomerFull(root, tenantId, '+15555550102', 'Bob');
    // Only Mike is mapped — Dana is not.
    await assignEmployeeToService(root, tenantId, svcId, mike);
    await assignResourceToService(root, tenantId, svcId, resourceId);
    await createScheduleEntry(root, tenantId, dana, '2026-07-01', '08:00', '17:00');

    const result = await bookAppointment({
      tenant_id: tenantId,
      resource_id: resourceId,
      customer_id: customerId,
      employee_id: dana,
      service_id: svcId,
      start_time: '2026-07-01T14:00:00-05:00',
      end_time: '2026-07-01T15:00:00-05:00',
    });

    expect(result.success).toBe(false);
    expect(result.appointment_id).toBeNull();
    expect(result.error_message).toMatch(/not assigned to perform this service/i);
    // Confirms NO row was inserted (defense against silent half-success).
    const count = await root.query(
      'SELECT COUNT(*)::int AS n FROM appointments WHERE tenant_id = $1',
      [tenantId]
    );
    expect(count.rows[0].n).toBe(0);
    // WHO: a determined caller hitting /appointments/create directly with Dana + Tire Mount, OR a misconfigured dashboard | WHAT: RPC rejects with a clear message, no row created | WHEN: the operator's UI dropdown was bypassed (curl, Postman, future client app, or simply a stale form state) | WHERE: book_appointment_atomic mapping miss branch | WHY: this is the defense-in-depth that the prior commit (UI filter) couldn't provide — the UI filter prevents the easy path to invalid bookings, but the RPC is the only place that can stop a determined-or-misbehaving caller; without this check the operator's "did Mike get to it before me" support question becomes "did the API get tricked into accepting a Dana-can't-do-tire-mount booking"
  });

  it('UNLINKED-SERVICE: booking refused when service has NO active service_employee rows at all', async () => {
    if (!dbAvailable) return;
    const tenantId = await createTenant(root, 'Unlinked Service', 'auto-repair', 'America/Chicago');
    const resourceId = await createResource(root, tenantId, 'Bay 1');
    const empId = await createEmployee(root, tenantId, 'Anyone');
    const svcId = await createService(root, tenantId, 'Inspection', 30);
    const customerId = await createCustomerFull(root, tenantId, '+15555550103', 'Cara');
    await assignResourceToService(root, tenantId, svcId, resourceId);
    await createScheduleEntry(root, tenantId, empId, '2026-07-01', '08:00', '17:00');
    // No assignEmployeeToService — service has zero mapping rows. STRICT
    // (20260911000000): no active link means refused, not fall-open.

    const result = await bookAppointment({
      tenant_id: tenantId,
      resource_id: resourceId,
      customer_id: customerId,
      employee_id: empId,
      service_id: svcId,
      start_time: '2026-07-01T14:00:00-05:00',
      end_time: '2026-07-01T14:30:00-05:00',
    });

    expect(result.success).toBe(false);
    expect(result.appointment_id).toBeNull();
    expect(result.error_message).toMatch(/no one is assigned to take this kind of appointment/i);
    // WHO: a tenant whose service config is partial — service exists but no
    // one is linked to it yet | WHAT: RPC refuses rather than falling open to
    // any active employee | WHEN: brand-new service the owner hasn't yet
    // assigned to anyone | WHERE: book_appointment_atomic STRICT branch,
    // aligned with book_with_scheduling_atomic (20260909210000) | WHY: the
    // phone path already refuses this exact shape ("no one is assigned to
    // take this kind of appointment") — the dashboard silently booking
    // whoever happened to be free was the two-answers-for-one-service bug
    // this migration closes. The skill map's fix panel is what tells the
    // owner to add the link, not a silent fall-open booking.
  });

  it('LEGACY-TAGS-IGNORED: services.required_skills no longer matters once p_service_id is passed', async () => {
    if (!dbAvailable) return;
    const tenantId = await createTenant(root, 'Legacy Tags Ignored', 'auto-repair', 'America/Chicago');
    const resourceId = await createResource(root, tenantId, 'Bay 1');
    const empId = await createEmployee(root, tenantId, 'Mike', ['oil-change']); // skill set, does NOT include brake-cert
    const svcId = await createService(root, tenantId, 'Brake Job', 60);
    const customerId = await createCustomerFull(root, tenantId, '+15555550104', 'Dee');
    // required_skills on the service would have failed Mike under the old
    // array-based check — it must now be ignored entirely once p_service_id
    // is passed, because there is still no service_employee link for Mike.
    await root.query(
      `UPDATE services SET required_skills = ARRAY['brake-cert'] WHERE service_id = $1`,
      [svcId]
    );
    await assignResourceToService(root, tenantId, svcId, resourceId);
    await createScheduleEntry(root, tenantId, empId, '2026-07-01', '08:00', '17:00');

    const result = await bookAppointment({
      tenant_id: tenantId,
      resource_id: resourceId,
      customer_id: customerId,
      employee_id: empId,
      service_id: svcId,
      start_time: '2026-07-01T14:00:00-05:00',
      end_time: '2026-07-01T15:00:00-05:00',
    });

    // Refused, but on the STRICT "no active link" reason — never on the
    // (now-dead) required_skills mismatch. Mike having the "wrong" skill tag
    // is irrelevant; the missing service_employee row is the only fact that
    // matters.
    expect(result.success).toBe(false);
    expect(result.error_message).toMatch(/no one is assigned to take this kind of appointment/i);
    expect(result.error_message).not.toMatch(/required skills/i);
    // WHO: a tenant on the older array-based skill model | WHAT: the array
    // check is dead code once p_service_id is passed — pin that the refusal
    // reason is the STRICT link-map message, never the legacy skills message
    // | WHEN: a tenant that configured required_skills but never migrated to
    // service_employee links | WHERE: book_appointment_atomic STRICT branch |
    // WHY: this is the inverse of the old LEGACY-FALLBACK test — it used to
    // pin that the array check fires; now it pins that it never does, so a
    // future "just add the fallback back" change surfaces here first
  });

  it('NO-SERVICE-ID: legacy callers without p_service_id work unchanged (no skill check)', async () => {
    if (!dbAvailable) return;
    const tenantId = await createTenant(root, 'No Service Id', 'auto-repair', 'America/Chicago');
    const resourceId = await createResource(root, tenantId, 'Bay 1');
    const empId = await createEmployee(root, tenantId, 'Mike');
    const customerId = await createCustomerFull(root, tenantId, '+15555550105', 'Eli');
    await createScheduleEntry(root, tenantId, empId, '2026-07-01', '08:00', '17:00');
    // No service_id passed; even though there's no mapping anywhere, the call should succeed.

    const result = await bookAppointment({
      tenant_id: tenantId,
      resource_id: resourceId,
      customer_id: customerId,
      employee_id: empId,
      start_time: '2026-07-01T14:00:00-05:00',
      end_time: '2026-07-01T15:00:00-05:00',
      description: 'Walk-in tire check',
    });

    expect(result.success).toBe(true);
    // WHO: every existing caller in the codebase before this slice (every
    // /appointments/create, every existing test) | WHAT: backward-compat —
    // when p_service_id is omitted, the entire mapping/array branch is
    // skipped | WHEN: legacy callers that don't yet thread service_id
    // through (the dashboard until the next commit, plus historical
    // tests) | WHERE: book_appointment_atomic top-level p_service_id NULL
    // guard | WHY: pin the no-regression contract — without this test, a
    // future "always require service_id" tightening could land silently
    // and break every legacy caller until tracked down by manual triage
  });
});

describe('book_appointment_atomic — service_resource mapping enforcement', () => {
  it('SAD: booking rejected when resource is NOT in the service_resource mapping', async () => {
    if (!dbAvailable) return;
    const tenantId = await createTenant(root, 'Resource Mapping', 'auto-repair', 'America/Chicago');
    const bay1 = await createResource(root, tenantId, 'Bay 1');
    const bay3 = await createResource(root, tenantId, 'Bay 3');
    const svcId = await createService(root, tenantId, 'Alignment', 60);
    const customerId = await createCustomerFull(root, tenantId, '+15555550201', 'Frank');
    // Only Bay 1 is mapped to the alignment service.
    await assignResourceToService(root, tenantId, svcId, bay1);

    const result = await bookAppointment({
      tenant_id: tenantId,
      resource_id: bay3, // operator picked the wrong bay
      customer_id: customerId,
      service_id: svcId,
      start_time: '2026-07-01T14:00:00-05:00',
      end_time: '2026-07-01T15:00:00-05:00',
    });

    expect(result.success).toBe(false);
    expect(result.error_message).toMatch(/not assigned to perform this service/i);
    // WHO: a determined caller picking Bay 3 for a service that only runs in Bay 1 (e.g., the alignment rack vs. a regular tire bay) | WHAT: RPC rejects with the same shape as the employee mapping miss | WHEN: dashboard caller bypassed the resource-narrowing dropdown OR an API caller submitted directly | WHERE: book_appointment_atomic resource mapping check | WHY: equipment-required services (alignment, balancing, brake lathe) only work on specific bays; without this gate the booking succeeds, the customer arrives, the right bay is occupied, and the shop scrambles. Symmetric with the employee mapping check
  });

  it('UNLINKED-SERVICE: booking refused when service has NO active service_resource rows at all', async () => {
    if (!dbAvailable) return;
    const tenantId = await createTenant(root, 'Resource Unlinked', 'auto-repair', 'America/Chicago');
    const bay1 = await createResource(root, tenantId, 'Bay 1');
    const svcId = await createService(root, tenantId, 'Alignment', 60);
    const customerId = await createCustomerFull(root, tenantId, '+15555550202', 'Grace');
    // No assignResourceToService — service has zero mapping rows.

    const result = await bookAppointment({
      tenant_id: tenantId,
      resource_id: bay1,
      customer_id: customerId,
      service_id: svcId,
      start_time: '2026-07-01T14:00:00-05:00',
      end_time: '2026-07-01T15:00:00-05:00',
    });

    expect(result.success).toBe(false);
    expect(result.appointment_id).toBeNull();
    expect(result.error_message).toMatch(/no room or line is set up for this kind of appointment/i);
    // WHO: a brand-new service nobody has linked to a bay or line yet | WHAT:
    // refused before the resource-specific mapping check even runs, same
    // shape as the phone path's NO_AVAILABILITY refusal | WHERE:
    // book_appointment_atomic STRICT branch, resource leg | WHY: symmetric
    // with the employee-side UNLINKED-SERVICE case above
  });
});
