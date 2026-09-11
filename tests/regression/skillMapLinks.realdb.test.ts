/**
 * Real-DB guard: the skill map decides WHO takes a meeting and WHERE it happens.
 *
 * 5W:
 *   WHO  — every caller who books by phone, on every tenant with more than one
 *          person or more than one room
 *   WHAT — when the service is known, book_with_scheduling_atomic and
 *          findNextAvailableSlots use ONLY people linked to it (service_employee)
 *          and ONLY rooms/lines linked to it (service_resource); a service with
 *          no active link is refused (strict)
 *   WHEN — every booking and every suggestion that knows its service
 *   WHERE— migration 20260909210000 (rule 3) + src/services/availabilitySearch.ts
 *   WHY  — Dale, 2026-09-11: "Person -> Role -> Resource and the resource should
 *          be meeting for XYZ." The dashboard skill map records exactly that, and
 *          the phone path never read it: in a rolled-back probe a meeting linked
 *          only to Dale and the Zoom line was booked with an UNLINKED employee in
 *          an UNLINKED storage closet — first alphabetically, and free. This file
 *          is that probe, kept.
 *
 * Every slot is a FIXED time tomorrow, so the suite passes at any hour it runs
 * (the now-relative booking tests failed at 00:51 CT on 2026-09-11).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Client, PoolClient } from 'pg';
import { getRootClient, skipIfDbDown } from '../utils';
import { findNextAvailableSlots } from '../../src/services/availabilitySearch';

const TZ = 'America/Chicago';
let setup: Client;
let dbAvailable = false;
let tenantId: string;
let dale: string;
let amy: string;
let zoom: string;
let closet: string;
let meeting: string;
let tomorrow9am: string;

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    dbAvailable = true;
  } catch (err) {
    console.warn('[skillMapLinks.realdb] DB not available, skipping', err);
    return;
  }

  const one = async (sql: string, params: unknown[]): Promise<string> =>
    Object.values((await setup.query(sql, params)).rows[0] as Record<string, string>)[0];

  tenantId = await one(
    `INSERT INTO tenants (name, business_type, timezone) VALUES ('Skill Map Fixture', 'local-service', $1)
     RETURNING tenant_id`,
    [TZ]
  );
  // The closet sorts FIRST and Amy sorts FIRST — the old code's tie-breakers —
  // so a pass here cannot be name-order luck.
  closet = await one(
    `INSERT INTO resources (tenant_id, name, is_active) VALUES ($1, 'Aaa Storage Closet', true) RETURNING resource_id`,
    [tenantId]
  );
  zoom = await one(
    `INSERT INTO resources (tenant_id, name, is_active) VALUES ($1, 'Zoom Meeting Line', true) RETURNING resource_id`,
    [tenantId]
  );
  amy = await one(
    `INSERT INTO employees (tenant_id, name, is_active, skills) VALUES ($1, 'Amy NotAssigned', true, ARRAY['consulting'])
     RETURNING employee_id`,
    [tenantId]
  );
  // Dale carries MORE tags than Amy, so the suggester's lowest-skill-first ranking
  // would pick Amy — only the link rule can put Dale on the slot.
  dale = await one(
    `INSERT INTO employees (tenant_id, name, is_active, skills)
     VALUES ($1, 'Dale Assigned', true, ARRAY['consulting', 'planning', 'strategy'])
     RETURNING employee_id`,
    [tenantId]
  );
  meeting = await one(
    `INSERT INTO services (tenant_id, name, duration_minutes) VALUES ($1, 'Meeting for Consulting', 30)
     RETURNING service_id`,
    [tenantId]
  );
  await setup.query(
    `INSERT INTO service_employee (service_id, employee_id, tenant_id) VALUES ($1, $2, $3)`,
    [meeting, dale, tenantId]
  );
  await setup.query(
    `INSERT INTO service_resource (service_id, resource_id, tenant_id) VALUES ($1, $2, $3)`,
    [meeting, zoom, tenantId]
  );
  // Both people work tomorrow 09:00-17:00, so coverage is never the reason Amy loses.
  for (const e of [amy, dale]) {
    await setup.query(
      `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
       VALUES ($1, $2, (now() AT TIME ZONE $3)::date + 1, '09:00', '17:00', false)`,
      [tenantId, e, TZ]
    );
  }
  tomorrow9am = await one(
    `SELECT to_char((((now() AT TIME ZONE $1)::date + 1) + time '09:00') AT TIME ZONE $1, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS t`,
    [TZ]
  );
});

afterAll(async () => {
  if (!dbAvailable) {
    if (setup) await setup.end();
    return;
  }
  await setup.query('DELETE FROM appointments WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM service_employee WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM service_resource WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM services WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM employee_schedule WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM employees WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM resources WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM customers WHERE tenant_id = $1', [tenantId]);
  await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [tenantId]);
  await setup.end();
});

beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

interface BookRow {
  success: boolean;
  error_code: string | null;
  employee_id: string | null;
  resource_id: string | null;
}

/** Book tomorrow at `hour`:00 local for 30 minutes. */
async function bookAt(
  hour: number,
  opts: { serviceId?: string | null; skills?: string[]; phone?: string } = {}
): Promise<BookRow> {
  const res = await setup.query<BookRow>(
    `SELECT success, error_code, employee_id, resource_id FROM book_with_scheduling_atomic(
       p_tenant_id => $1,
       p_phone => $2,
       p_customer_name => 'Map Caller',
       p_window_from => (((now() AT TIME ZONE $3)::date + 1) + make_time($4, 0, 0)) AT TIME ZONE $3,
       p_window_to   => (((now() AT TIME ZONE $3)::date + 1) + make_time($4, 30, 0)) AT TIME ZONE $3,
       p_duration_minutes => 30,
       p_required_skills => $5::text[],
       p_service_id => $6::uuid
     )`,
    [tenantId, opts.phone ?? '+15555550160', TZ, hour, opts.skills ?? [], opts.serviceId ?? null]
  );
  return res.rows[0];
}

const clearAppointments = () =>
  setup.query('DELETE FROM appointments WHERE tenant_id = $1', [tenantId]);

describe('the booking follows the skill map when the service is known', () => {
  it('SAD→FIXED: the meeting goes to the LINKED person in the LINKED room', async () => {
    // The 2026-09-11 probe: before the fix this booked Amy in the storage closet.
    const r = await bookAt(10, { serviceId: meeting });
    await clearAppointments();
    expect(r.success).toBe(true);
    expect(r.employee_id).toBe(dale);
    expect(r.resource_id).toBe(zoom);
  });

  it('SAD: the linked person is booked → refused as TAKEN, not handed to the free unlinked one', async () => {
    const first = await bookAt(11, { serviceId: meeting, phone: '+15555550161' });
    expect(first.success).toBe(true);
    const second = await bookAt(11, { serviceId: meeting, phone: '+15555550162' });
    await clearAppointments();
    // Amy is free and the closet is free. Neither is linked. Neither is used.
    expect(second.success).toBe(false);
    expect(second.error_code).toBe('TIMESLOT_OCCUPIED');
  });

  it('SAD: the linked person is not working → EMPLOYEE_NOT_SCHEDULED, though Amy is', async () => {
    await setup.query(
      `UPDATE employee_schedule SET is_off = true
        WHERE tenant_id = $1 AND employee_id = $2 AND shift_date = (now() AT TIME ZONE $3)::date + 1`,
      [tenantId, dale, TZ]
    );
    try {
      const r = await bookAt(12, { serviceId: meeting });
      expect(r.success).toBe(false);
      expect(r.error_code).toBe('EMPLOYEE_NOT_SCHEDULED');
    } finally {
      await setup.query(
        `UPDATE employee_schedule SET is_off = false WHERE tenant_id = $1 AND employee_id = $2`,
        [tenantId, dale]
      );
      await clearAppointments();
    }
  });

  it('the skill TAGS are not consulted once the service is known — the links replace them', async () => {
    // A tag nobody holds would refuse on the legacy path. With the service, the
    // map says Dale, and Dale it is: two lists that must agree is the bug.
    const r = await bookAt(13, { serviceId: meeting, skills: ['nobody-has-this'] });
    await clearAppointments();
    expect(r.success).toBe(true);
    expect(r.employee_id).toBe(dale);
  });
});

describe('STRICT: a service the map links to nobody, or to no room, cannot be booked', () => {
  it('no person linked → NO_SKILLED_EMPLOYEE, and nothing is written', async () => {
    const lonely = (
      await setup.query<{ service_id: string }>(
        `INSERT INTO services (tenant_id, name, duration_minutes) VALUES ($1, 'Unstaffed Service', 30)
         RETURNING service_id`,
        [tenantId]
      )
    ).rows[0].service_id;
    await setup.query(
      `INSERT INTO service_resource (service_id, resource_id, tenant_id) VALUES ($1, $2, $3)`,
      [lonely, zoom, tenantId]
    );
    try {
      const r = await bookAt(14, { serviceId: lonely });
      expect(r.success).toBe(false);
      expect(r.error_code).toBe('NO_SKILLED_EMPLOYEE');
      const n = await setup.query('SELECT count(*) AS n FROM appointments WHERE tenant_id = $1', [
        tenantId,
      ]);
      expect(Number(n.rows[0].n)).toBe(0);
    } finally {
      await setup.query('DELETE FROM service_resource WHERE service_id = $1', [lonely]);
      await setup.query('DELETE FROM services WHERE service_id = $1', [lonely]);
    }
  });

  it('no room linked → NO_AVAILABILITY, though two free rooms exist', async () => {
    const roomless = (
      await setup.query<{ service_id: string }>(
        `INSERT INTO services (tenant_id, name, duration_minutes) VALUES ($1, 'Roomless Service', 30)
         RETURNING service_id`,
        [tenantId]
      )
    ).rows[0].service_id;
    await setup.query(
      `INSERT INTO service_employee (service_id, employee_id, tenant_id) VALUES ($1, $2, $3)`,
      [roomless, dale, tenantId]
    );
    try {
      const r = await bookAt(14, { serviceId: roomless });
      expect(r.success).toBe(false);
      expect(r.error_code).toBe('NO_AVAILABILITY');
    } finally {
      await setup.query('DELETE FROM service_employee WHERE service_id = $1', [roomless]);
      await setup.query('DELETE FROM services WHERE service_id = $1', [roomless]);
    }
  });

  it('a link to someone INACTIVE is not somebody — refused', async () => {
    await setup.query('UPDATE employees SET is_active = false WHERE employee_id = $1', [dale]);
    try {
      const r = await bookAt(15, { serviceId: meeting });
      expect(r.success).toBe(false);
      expect(r.error_code).toBe('NO_SKILLED_EMPLOYEE');
    } finally {
      await setup.query('UPDATE employees SET is_active = true WHERE employee_id = $1', [dale]);
    }
  });
});

describe('without a service id the legacy tag rules are unchanged', () => {
  it('HAPPY: a tag request books the tagged person, links or no links', async () => {
    const r = await bookAt(16, { skills: ['consulting'] });
    await clearAppointments();
    expect(r.success).toBe(true);
    expect(r.employee_id).toBe(amy);
  });
});

describe('suggest agrees with enforce (findNextAvailableSlots)', () => {
  it('every slot offered for the service is Dale on the Zoom line — never Amy, never the closet', async () => {
    const slots = await findNextAvailableSlots(setup as unknown as PoolClient, {
      tenantId,
      fromTime: tomorrow9am,
      durationMinutes: 30,
      count: 8,
      searchHorizonHours: 24,
      serviceId: meeting,
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.employee_id).toBe(dale);
      expect(s.resource_id).toBe(zoom);
    }
  });

  it('a service linked to nobody has no slots at all (strict), matching the refusal', async () => {
    const lonely = (
      await setup.query<{ service_id: string }>(
        `INSERT INTO services (tenant_id, name, duration_minutes) VALUES ($1, 'Unstaffed Suggest', 30)
         RETURNING service_id`,
        [tenantId]
      )
    ).rows[0].service_id;
    try {
      const slots = await findNextAvailableSlots(setup as unknown as PoolClient, {
        tenantId,
        fromTime: tomorrow9am,
        durationMinutes: 30,
        count: 8,
        searchHorizonHours: 24,
        serviceId: lonely,
      });
      expect(slots).toEqual([]);
    } finally {
      await setup.query('DELETE FROM services WHERE service_id = $1', [lonely]);
    }
  });

  it('without a service id the search still offers the unlinked people and rooms (legacy)', async () => {
    const slots = await findNextAvailableSlots(setup as unknown as PoolClient, {
      tenantId,
      fromTime: tomorrow9am,
      durationMinutes: 30,
      count: 8,
      searchHorizonHours: 24,
    });
    expect(slots.some((s) => s.employee_id === amy || s.resource_id === closet)).toBe(true);
  });
});
