/**
 * Skill + Resource Matching Reliability Sweep
 * ============================================
 *
 * Pre-launch validation gate (docs/TODO.md "Pre-launch validation").
 *
 * Why this file exists separately from scheduling-atomic.test.ts:
 *   scheduling-atomic.test.ts exercises the RPC's logic layers in
 *   abstract terms ("Mike Smith", "Tire Rotation"). This file exercises
 *   the same RPC against realistic seed data per industry, so a future
 *   change that silently breaks one vocabulary (e.g. hyphenated skills
 *   like "tire-mount", multi-word capabilities like "lift station",
 *   apostrophes in salon services) surfaces immediately.
 *
 * Coverage:
 *   1. Per-template HAPPY: 5 industries, each books a realistic service
 *      end-to-end. Catches schema drift / vocabulary breakage.
 *   2. Error-code matrix: each of the 5 specific error codes
 *      (INVALID_PARAMS, NO_SKILLED_EMPLOYEE, EMPLOYEE_NOT_SCHEDULED,
 *      TIMESLOT_OCCUPIED, NO_AVAILABILITY) pinned to a single canonical
 *      scenario. The CLAUDE.md contract for these codes is load-bearing
 *      for the voice agent's caller-facing error messages — a regression
 *      that maps the wrong scenario to the wrong code is silent in
 *      production but caught here.
 *   3. Cross-template guard: a salon's skill-named "color" must not
 *      accidentally route a brake job; tenant_id isolation is the
 *      durable guard, but a vocabulary-collision sanity check is cheap.
 *
 * What this file does NOT cover (already covered elsewhere):
 *   - Concurrency races (booking-concurrency.test.ts)
 *   - Timezone correctness (scheduling-timezone-bug.test.ts)
 *   - Performance under load (scheduling-atomic.test.ts → Performance)
 *   - Override-shifts mechanics (scheduling-overrides.test.ts)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { type Client } from 'pg';
import {
  getRootClient,
  clearDB,
  createTenant,
  createEmployee,
  createScheduleEntry,
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

// ── Service helper ───────────────────────────────────────────────────
//
// The default test-utils createService() takes only name+duration; for
// this sweep we need required_skills and required_resources populated
// so the per-industry seed mirrors the dashboard's setup-wizard output.

async function createServiceWithRequirements(
  client: Client,
  tenantId: string,
  name: string,
  durationMinutes: number,
  requiredSkills: string[],
  requiredResources: string[]
): Promise<string> {
  const res = await client.query(
    `INSERT INTO services (tenant_id, name, duration_minutes, required_skills, required_resources)
         VALUES ($1, $2, $3, $4, $5) RETURNING service_id`,
    [tenantId, name, durationMinutes, requiredSkills, requiredResources]
  );
  return res.rows[0].service_id;
}

async function createResourceWithCapabilities(
  client: Client,
  tenantId: string,
  name: string,
  capabilities: string[]
): Promise<string> {
  const res = await client.query(
    `INSERT INTO resources (tenant_id, name, capabilities)
         VALUES ($1, $2, $3) RETURNING resource_id`,
    [tenantId, name, capabilities]
  );
  return res.rows[0].resource_id;
}

// ── RPC wrapper ──────────────────────────────────────────────────────

type BookParams = {
  tenantId: string;
  phone?: string;
  customerName?: string | null;
  description?: string;
  callId?: string;
  startTime?: string | null;
  endTime?: string | null;
  requiredSkills?: string[];
  requiredCapabilities?: string[];
  preferredResourceId?: string | null;
  preferredEmployeeId?: string | null;
  durationMinutes?: number;
};

type BookResult = {
  success: boolean;
  appointment_id: string | null;
  resource_id: string | null;
  resource_name: string | null;
  employee_id: string | null;
  employee_name: string | null;
  booked_start: string | null;
  booked_end: string | null;
  customer_id: string | null;
  error_message: string | null;
  error_code: string | null;
};

async function bookWithScheduling(p: BookParams): Promise<BookResult> {
  const res = await root.query(
    `SELECT * FROM book_with_scheduling_atomic(
            $1::UUID, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT, $6::TEXT,
            $7::TIMESTAMPTZ, $8::TIMESTAMPTZ, $9::TIMESTAMPTZ, $10::TIMESTAMPTZ,
            $11::TEXT[], $12::TEXT[], $13::UUID, $14::TEXT, $15::TEXT, $16::INTEGER
        )`,
    [
      p.tenantId,
      p.phone ?? '+15551112222',
      p.customerName ?? null,
      p.description ?? 'Sweep test',
      p.callId ?? 'sweep-call-1',
      null,
      p.startTime ?? null,
      p.endTime ?? null,
      null,
      null,
      p.requiredSkills ?? [],
      p.requiredCapabilities ?? [],
      p.preferredResourceId ?? null,
      p.preferredEmployeeId ?? null,
      null,
      p.durationMinutes ?? 30,
    ]
  );
  return res.rows[0] as BookResult;
}

// ────────────────────────────────────────────────────────────────────
// 1. Per-template HAPPY tests
// ────────────────────────────────────────────────────────────────────

describe('Skill + resource matching — per-industry HAPPY paths', () => {
  it('automotive: books brake job with brakes-skilled tech in a brake-capable bay', async () => {
    // WHO: caller asks for brake service at an auto repair shop
    // WHAT: services.required_skills=['brakes'], resources.capabilities=['lift'],
    //       employee has 'brakes' skill, employee on shift → success
    // WHEN: weekday afternoon during business hours
    // WHERE: book_with_scheduling_atomic, automotive_v1 vocabulary
    // WHY: the most common shop interaction; if hyphenless lowercase-vocab
    //       breaks the array-contains operator (@>) the whole industry stops booking
    if (!dbAvailable) return;

    const tenantId = await createTenant(root, 'Acme Auto Repair', 'auto-shop');
    const bayId = await createResourceWithCapabilities(root, tenantId, 'Bay 1', ['lift']);
    const techId = await createEmployee(root, tenantId, 'Bob the Mechanic', ['brakes', 'engine']);
    await createScheduleEntry(root, tenantId, techId, '2030-04-10', '08:00', '17:00');
    await createServiceWithRequirements(
      root,
      tenantId,
      'Brake pad replacement',
      60,
      ['brakes'],
      ['lift']
    );

    const result = await bookWithScheduling({
      tenantId,
      startTime: '2030-04-10T14:00:00Z',
      endTime: '2030-04-10T15:00:00Z',
      requiredSkills: ['brakes'],
      requiredCapabilities: ['lift'],
    });

    expect(
      result.error_code,
      `expected success but got ${result.error_code}: ${result.error_message}`
    ).toBeNull();
    expect(result.success).toBe(true);
    expect(result.resource_id).toBe(bayId);
    expect(result.employee_id).toBe(techId);
  });

  it("salon: books haircut with stylist skilled in 'cut' at a salon chair", async () => {
    // WHO: caller booking a haircut at a salon
    // WHAT: short single-word skill ('cut'), no resource capability requirement
    // WHEN: weekday afternoon
    // WHERE: book_with_scheduling_atomic, salon_v1 vocabulary
    // WHY: salons often skip resource capability filters (every chair is fungible);
    //       confirm an empty capabilities array doesn't accidentally filter out resources
    if (!dbAvailable) return;

    const tenantId = await createTenant(root, "Bella's Salon", 'salon');
    // Delete template-auto-seeded resources so "Chair 1" is the only
    // candidate. The new assignment policy's random() tiebreaker (2026-
    // 05-08) picks any matching resource, breaking the chairId-specific
    // assertion below if auto-seeded chairs aren't cleared first.
    await root.query('DELETE FROM resources WHERE tenant_id = $1', [tenantId]);
    const chairId = await createResourceWithCapabilities(root, tenantId, 'Chair 1', []);
    const stylistId = await createEmployee(root, tenantId, 'Lila', ['cut', 'color']);
    await createScheduleEntry(root, tenantId, stylistId, '2030-04-10', '09:00', '18:00');
    await createServiceWithRequirements(root, tenantId, "Women's Cut", 45, ['cut'], []);

    const result = await bookWithScheduling({
      tenantId,
      startTime: '2030-04-10T14:00:00Z',
      endTime: '2030-04-10T14:45:00Z',
      requiredSkills: ['cut'],
      requiredCapabilities: [],
    });

    expect(result.error_code).toBeNull();
    expect(result.success).toBe(true);
    expect(result.resource_id).toBe(chairId);
    expect(result.employee_id).toBe(stylistId);
  });

  it("mobile_tire: books tire mount with hyphenated 'tire-mount' skill on a truck", async () => {
    // WHO: caller asks for tire mounting at a mobile tire service
    // WHAT: hyphenated skill name ('tire-mount'), single truck (resource)
    // WHEN: weekday morning
    // WHERE: book_with_scheduling_atomic, mobile_tire_v1 vocabulary
    // WHY: PostgreSQL TEXT[] @> operator must match hyphenated tokens exactly;
    //       a regex-based skill check would fail here, this catches that drift
    if (!dbAvailable) return;

    const tenantId = await createTenant(root, 'DynaTire Mobile', 'mobile-tire');
    const truckId = await createResourceWithCapabilities(root, tenantId, 'Truck 1', ['mobile']);
    const techId = await createEmployee(root, tenantId, 'Mike Rivera', [
      'tire-mount',
      'tire-balance',
    ]);
    await createScheduleEntry(root, tenantId, techId, '2030-04-10', '08:00', '17:00');
    await createServiceWithRequirements(
      root,
      tenantId,
      '4-Tire Mount + Balance',
      60,
      ['tire-mount'],
      ['mobile']
    );

    const result = await bookWithScheduling({
      tenantId,
      startTime: '2030-04-10T10:00:00Z',
      endTime: '2030-04-10T11:00:00Z',
      requiredSkills: ['tire-mount'],
      requiredCapabilities: ['mobile'],
    });

    expect(result.error_code).toBeNull();
    expect(result.success).toBe(true);
    expect(result.resource_id).toBe(truckId);
    expect(result.employee_id).toBe(techId);
  });

  it('auto_bays: books alignment requiring multi-skill match (alignment + lift capability)', async () => {
    // WHO: caller requesting alignment at a multi-bay auto shop
    // WHAT: service requires BOTH alignment skill AND a lift-equipped resource
    // WHEN: weekday afternoon
    // WHERE: book_with_scheduling_atomic, auto_bays_v1 vocabulary
    // WHY: when a tech has 'alignment' but the bay lacks 'lift', RPC must
    //       reject — cross-axis filtering on skills × capabilities is the
    //       fragile join most likely to break under schema changes
    if (!dbAvailable) return;

    const tenantId = await createTenant(root, 'MultiBay Auto', 'auto-shop');

    // Bay 1: lift-equipped. Bay 2: no lift. Service requires lift.
    const bay1 = await createResourceWithCapabilities(root, tenantId, 'Bay 1', [
      'lift',
      'alignment-rack',
    ]);
    await createResourceWithCapabilities(root, tenantId, 'Bay 2', []);

    // Tech 1: alignment-skilled. Tech 2: oil-change only.
    const tech1 = await createEmployee(root, tenantId, 'Tech Alpha', [
      'alignment',
      'tire-rotation',
    ]);
    const tech2 = await createEmployee(root, tenantId, 'Tech Beta', ['oil-change']);
    await createScheduleEntry(root, tenantId, tech1, '2030-04-10', '08:00', '17:00');
    await createScheduleEntry(root, tenantId, tech2, '2030-04-10', '08:00', '17:00');

    await createServiceWithRequirements(
      root,
      tenantId,
      '4-Wheel Alignment',
      45,
      ['alignment'],
      ['alignment-rack']
    );

    const result = await bookWithScheduling({
      tenantId,
      startTime: '2030-04-10T14:00:00Z',
      endTime: '2030-04-10T14:45:00Z',
      requiredSkills: ['alignment'],
      requiredCapabilities: ['alignment-rack'],
    });

    expect(result.error_code).toBeNull();
    expect(result.success).toBe(true);
    expect(result.resource_id, 'must pick Bay 1 (only one with alignment-rack)').toBe(bay1);
    expect(result.employee_id, 'must pick Tech Alpha (only one with alignment skill)').toBe(tech1);
  });

  it('ai_platform: books generic consultation with no skills/capabilities required', async () => {
    // WHO: caller booking a consultation at an AI Platform demo tenant
    // WHAT: no skills, no capabilities — first-available resource path
    // WHEN: weekday afternoon
    // WHERE: book_with_scheduling_atomic, ai_platform_v1 vocabulary
    // WHY: the platform demo / unconfigured tenant must still book successfully
    //       on the no-requirements path. This exercises the RPC's "ELSE" branch
    //       (resource-only scan, no skill join) which is otherwise dead code in
    //       most industry tests.
    if (!dbAvailable) return;

    const tenantId = await createTenant(root, 'AI Platform Demo', 'ai-platform');
    const roomId = await createResourceWithCapabilities(root, tenantId, 'Meeting Room', []);
    await createServiceWithRequirements(root, tenantId, 'Discovery Call', 30, [], []);
    // RULE CHANGE (migration 20260909210000): the no-requirements path used to
    // book the room with NOBODY on it. An appointment is with somebody now, so a
    // consultant is on shift; the ELSE branch still runs (no skills requested) and
    // now names the person it found instead of leaving employee_id NULL.
    const consultantId = await createEmployee(root, tenantId, 'Demo Consultant');
    await createScheduleEntry(root, tenantId, consultantId, '2030-04-10', '00:00', '23:59');

    const result = await bookWithScheduling({
      tenantId,
      startTime: '2030-04-10T15:00:00Z',
      endTime: '2030-04-10T15:30:00Z',
      requiredSkills: [],
      requiredCapabilities: [],
    });

    expect(result.error_code).toBeNull();
    expect(result.success).toBe(true);
    expect(result.resource_id).toBe(roomId);
    expect(
      result.employee_id,
      'no skills required → still a scheduled person on it (was toBeNull before 20260909210000)'
    ).toBe(consultantId);
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. Error-code matrix
// ────────────────────────────────────────────────────────────────────

describe('Skill + resource matching — error-code matrix', () => {
  it('INVALID_PARAMS when neither (start_time + end_time) nor (window_from + window_to) provided', async () => {
    // WHO: a malformed agent request that omits both time-providing branches
    // WHAT: RPC must return error_code='INVALID_PARAMS' with a clear message
    // WHEN: any time
    // WHERE: book_with_scheduling_atomic top-level param check (line ~285)
    // WHY: voice agent must distinguish "you need to ask for a time" from
    //       "no slot found" — different caller-facing scripts
    if (!dbAvailable) return;

    const tenantId = await createTenant(root, 'ParamCheck Co', 'auto-shop');

    const result = await bookWithScheduling({
      tenantId,
      startTime: null,
      endTime: null,
    });

    expect(result.success).toBe(false);
    expect(result.error_code).toBe('INVALID_PARAMS');
    expect(result.error_message).toContain('required');
  });

  it('NO_SKILLED_EMPLOYEE when tenant has no employee with the requested skill', async () => {
    // WHO: caller asks for a service the shop doesn't actually offer (no skilled tech)
    // WHAT: RPC returns NO_SKILLED_EMPLOYEE so the agent can say "we don't do that here"
    //       rather than a generic "no availability"
    // WHEN: requested time has resource availability but no skill match
    // WHERE: book_with_scheduling_atomic v_employee_exists EXISTS check (line ~386)
    // WHY: BUG-064 added these specific codes precisely so the voice AI's caller
    //       message can be diagnostic ("we don't offer brakes") not generic
    if (!dbAvailable) return;

    const tenantId = await createTenant(root, 'Engine-Only Shop', 'auto-shop');
    await createResourceWithCapabilities(root, tenantId, 'Bay 1', ['lift']);
    const techId = await createEmployee(root, tenantId, 'Engine Eddie', ['engine']);
    await createScheduleEntry(root, tenantId, techId, '2030-04-10', '08:00', '17:00');

    const result = await bookWithScheduling({
      tenantId,
      startTime: '2030-04-10T14:00:00Z',
      endTime: '2030-04-10T15:00:00Z',
      requiredSkills: ['transmission'], // no employee has this
    });

    expect(result.success).toBe(false);
    expect(result.error_code).toBe('NO_SKILLED_EMPLOYEE');
  });

  it('EMPLOYEE_NOT_SCHEDULED when skilled employee exists but is not on shift at requested time', async () => {
    // WHO: caller asks for service at 6pm when the only skilled employee works 8-5
    // WHAT: skill match exists in employees table, but no shift covers the slot
    // WHEN: outside scheduled hours
    // WHERE: book_with_scheduling_atomic v_employee_scheduled EXISTS check (line ~402)
    // WHY: distinct from NO_SKILLED_EMPLOYEE: agent should say "Bob's gone for the day,
    //       can you come tomorrow?" not "we don't do that"
    if (!dbAvailable) return;

    const tenantId = await createTenant(root, 'Daytime Auto', 'auto-shop');
    await createResourceWithCapabilities(root, tenantId, 'Bay 1', []);
    const techId = await createEmployee(root, tenantId, 'Daytime Dave', ['brakes']);
    // Dave's shift is 08:00-17:00 local; we book at 18:00 local (outside)
    await createScheduleEntry(root, tenantId, techId, '2030-04-10', '08:00', '17:00');

    const result = await bookWithScheduling({
      tenantId,
      startTime: '2030-04-10T23:00:00Z', // 18:00 in America/Chicago (default tz)
      endTime: '2030-04-10T23:30:00Z',
      requiredSkills: ['brakes'],
    });

    expect(result.success).toBe(false);
    expect(result.error_code).toBe('EMPLOYEE_NOT_SCHEDULED');
  });

  it('TIMESLOT_OCCUPIED when the only candidate employee+resource pair is already booked', async () => {
    // WHO: caller asks for the same slot a prior caller already took
    // WHAT: skill match exists, employee on shift, but appointment already overlaps
    // WHEN: requested slot conflicts with existing appointment
    // WHERE: book_with_scheduling_atomic v_employee_occupied/v_resource_occupied (line ~425)
    // WHY: post-BUG-064, agent maps TIMESLOT_OCCUPIED to "that time just got taken,
    //       can we try a different slot?"
    if (!dbAvailable) return;

    const tenantId = await createTenant(root, 'OneTech Shop', 'auto-shop');
    const _bayId = await createResourceWithCapabilities(root, tenantId, 'Bay 1', []);
    const techId = await createEmployee(root, tenantId, 'Solo Sam', ['brakes']);
    await createScheduleEntry(root, tenantId, techId, '2030-04-10', '08:00', '17:00');

    // First booking takes the only slot
    const first = await bookWithScheduling({
      tenantId,
      phone: '+15551110001',
      startTime: '2030-04-10T14:00:00Z',
      endTime: '2030-04-10T15:00:00Z',
      requiredSkills: ['brakes'],
    });
    expect(first.success, `first booking must succeed: ${first.error_message}`).toBe(true);

    // Second caller hits the same slot — should be TIMESLOT_OCCUPIED, not NO_AVAILABILITY
    const second = await bookWithScheduling({
      tenantId,
      phone: '+15551110002',
      startTime: '2030-04-10T14:00:00Z',
      endTime: '2030-04-10T15:00:00Z',
      requiredSkills: ['brakes'],
    });

    expect(second.success).toBe(false);
    expect(second.error_code, `expected TIMESLOT_OCCUPIED, got ${second.error_code}`).toBe(
      'TIMESLOT_OCCUPIED'
    );
  });

  it('NO_AVAILABILITY catch-all when no skills required and no resource available', async () => {
    // WHO: caller at a no-skill-required tenant whose only resource is taken
    // WHAT: no required_skills means RPC takes the simpler path (no skill diagnostics);
    //       when the find loop comes up empty, it falls through to NO_AVAILABILITY
    // WHEN: every resource is occupied at the requested time
    // WHERE: book_with_scheduling_atomic NOT v_found path (line ~454)
    // WHY: the catch-all branch is the last-resort error code; if a refactor
    //       accidentally moves a more-specific code below it, that specific code
    //       becomes unreachable. Pin the contract here.
    if (!dbAvailable) return;

    const tenantId = await createTenant(root, 'Demo Tenant', 'ai-platform');
    const roomId = await createResourceWithCapabilities(root, tenantId, 'Meeting Room', []);
    // Somebody on shift, so the FIRST booking can land at all (an appointment is
    // with somebody — 20260909210000). The catch-all under test is the second
    // caller finding the only ROOM taken, which this does not change.
    const hostId = await createEmployee(root, tenantId, 'Demo Host');
    await createScheduleEntry(root, tenantId, hostId, '2030-04-10', '00:00', '23:59');

    // Book the only room first
    const first = await bookWithScheduling({
      tenantId,
      phone: '+15551112221',
      startTime: '2030-04-10T15:00:00Z',
      endTime: '2030-04-10T15:30:00Z',
    });
    expect(first.success).toBe(true);
    expect(first.resource_id).toBe(roomId);

    // Second caller, same slot, no skills required → NO_AVAILABILITY
    const second = await bookWithScheduling({
      tenantId,
      phone: '+15551112222',
      startTime: '2030-04-10T15:00:00Z',
      endTime: '2030-04-10T15:30:00Z',
    });

    expect(second.success).toBe(false);
    expect(second.error_code).toBe('NO_AVAILABILITY');
  });

  it('NO_AVAILABILITY when capability-required and no matching resource exists', async () => {
    // WHO: caller at a tenant whose resources don't have the requested capability
    // WHAT: required_capabilities=['lift'] but only resource has []
    // WHEN: any time
    // WHERE: book_with_scheduling_atomic res.capabilities @> p_required_capabilities filter
    // WHY: capability mismatch with no skill requirement also routes through
    //       the catch-all NO_AVAILABILITY path — distinct from skill-driven misses
    //       which take the diagnostic NO_SKILLED_EMPLOYEE / EMPLOYEE_NOT_SCHEDULED branches
    if (!dbAvailable) return;

    const tenantId = await createTenant(root, 'NoLift Shop', 'auto-shop');
    await createResourceWithCapabilities(root, tenantId, 'Plain Bay', []); // no lift

    const result = await bookWithScheduling({
      tenantId,
      startTime: '2030-04-10T14:00:00Z',
      endTime: '2030-04-10T14:30:00Z',
      requiredSkills: [], // empty triggers the no-skill find path
      requiredCapabilities: ['lift'], // but capability is required
    });

    expect(result.success).toBe(false);
    expect(result.error_code).toBe('NO_AVAILABILITY');
  });
});

// ────────────────────────────────────────────────────────────────────
// 3. Cross-template guard
// ────────────────────────────────────────────────────────────────────

describe('Skill + resource matching — cross-template guards', () => {
  it('does not route across tenants even when skill names collide', async () => {
    // WHO: tenant A (salon) has employee with 'color' skill;
    //       tenant B (auto shop) requests 'color' (paint?) — must not match A's stylist
    // WHAT: RPC queries are tenant-scoped; skill name overlap across tenants
    //       must never let one tenant's employee fulfill another tenant's booking
    // WHEN: both tenants exist in the same DB; identical skill string in both
    // WHERE: book_with_scheduling_atomic — emp.tenant_id = p_tenant_id filter
    // WHY: this is the load-bearing tenant isolation guarantee; a regression
    //       here is a multi-tenant data leak. The vocabulary collision makes
    //       it the most concrete way to detect a tenant-scoping bug
    if (!dbAvailable) return;

    const salonId = await createTenant(root, 'Salon Cross', 'salon');
    const autoId = await createTenant(root, 'Auto Cross', 'auto-shop');

    // Salon has a 'color' stylist
    const stylistId = await createEmployee(root, salonId, 'Color Carla', ['color']);
    await createScheduleEntry(root, salonId, stylistId, '2030-04-10', '09:00', '18:00');
    await createResourceWithCapabilities(root, salonId, 'Chair 1', []);

    // Auto shop has NO 'color' employee (doesn't do paint)
    await createResourceWithCapabilities(root, autoId, 'Bay 1', []);
    const techId = await createEmployee(root, autoId, 'Brake Bob', ['brakes']);
    await createScheduleEntry(root, autoId, techId, '2030-04-10', '08:00', '17:00');

    // Auto shop tries to book a 'color' job — must NOT pull Carla from the salon
    const result = await bookWithScheduling({
      tenantId: autoId,
      startTime: '2030-04-10T14:00:00Z',
      endTime: '2030-04-10T15:00:00Z',
      requiredSkills: ['color'],
    });

    expect(result.success).toBe(false);
    expect(
      result.error_code,
      "must reject — no 'color' employee in auto tenant despite one existing in salon tenant"
    ).toBe('NO_SKILLED_EMPLOYEE');
    expect(result.employee_id).toBeNull();
  });

  it("required_skills matching is exact, not substring (no 'cut' matching 'haircut')", async () => {
    // WHO: a tenant whose employee has the literal skill 'haircut' (compound word)
    // WHAT: RPC requested 'cut' must NOT match an employee with only 'haircut' —
    //       PostgreSQL TEXT[] @> uses element equality, not substring containment
    // WHEN: any time with employee on shift
    // WHERE: book_with_scheduling_atomic emp.skills @> p_required_skills
    // WHY: substring matching would silently route bookings to ill-suited employees;
    //       a future refactor that switches to fuzzy matching for "convenience"
    //       would break this contract — pin it explicitly
    if (!dbAvailable) return;

    const tenantId = await createTenant(root, 'ExactMatch Salon', 'salon');
    await createResourceWithCapabilities(root, tenantId, 'Chair 1', []);
    const stylistId = await createEmployee(root, tenantId, 'Compound Cathy', ['haircut']); // not 'cut'
    await createScheduleEntry(root, tenantId, stylistId, '2030-04-10', '09:00', '18:00');

    const result = await bookWithScheduling({
      tenantId,
      startTime: '2030-04-10T14:00:00Z',
      endTime: '2030-04-10T14:30:00Z',
      requiredSkills: ['cut'], // not 'haircut'
    });

    expect(result.success).toBe(false);
    expect(result.error_code).toBe('NO_SKILLED_EMPLOYEE');
  });
});
