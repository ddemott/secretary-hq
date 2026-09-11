/**
 * Real-DB tests for findNextAvailableSlots — the helper that powers
 * "next-available-time" suggestions when the originally-requested slot
 * has no qualified employee free.
 *
 * Why real DB (not mocks): the helper is a single SQL query that uses
 * generate_series + window functions + the same skill / shift / overlap
 * checks as book_with_scheduling_atomic. Mocking that surface would
 * mock the thing under test — we'd be proving the mock works, not the
 * SQL. Each test wraps in BEGIN / ROLLBACK so changes don't leak.
 *
 * Three flavors of scenario the helper must get right:
 *
 *   1. All employees idle — earliest slot is the requested time itself,
 *      assigned to the lowest-skill qualified employee.
 *   2. Lower-skill employees busy at requested time — earliest slot
 *      shifts forward to when the next lower-skill tech frees up; OR
 *      same time if a higher-skill tech is already idle.
 *   3. All employees busy at requested time — earliest slot is the
 *      first time ANY qualified employee finishes their current job.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { type Client } from 'pg';
import {
  getRootClient,
  clearDB,
  createTenant,
  createResource,
  createEmployee,
  createScheduleEntry,
  createCustomerFull,
  createAppointment,
  beginTestTransaction,
  rollbackTestTransaction,
  skipIfDbDown,
} from '../utils';

import { findNextAvailableSlots } from '../../src/services/availabilitySearch';

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

describe('findNextAvailableSlots', () => {
  it('HAPPY: all idle — first slot is the requested time, lowest-skill emp wins', async () => {
    if (!dbAvailable) return;
    // WHO: caller asks for tire rotation at 10:00; nobody is busy
    // WHAT: helper returns 10:00 as the first slot, paired with the
    //        3-skill employee (Carlos), not the 5-skill (Mike)
    // WHEN: typical "is there anything next-available?" call when the
    //        original window simply had nothing booked yet
    // WHERE: src/services/availabilitySearch.ts SQL ORDER BY
    // WHY: pin that the helper's per-slot ranking uses the same
    //        lowest-skill-first policy as the booking RPC. Without this,
    //        the helper would suggest Mike for jobs Carlos could do
    //        and waste senior-tech time on simple suggestions.

    const tenantId = await createTenant(root, 'TireCo', 'mobile_tire', 'America/Chicago');
    const _truck1 = await createResource(root, tenantId, 'Truck 1');
    const carlos = await createEmployee(root, tenantId, 'Carlos', [
      'flat-repair',
      'tire-swap',
      'tire-rotation',
    ]);
    const mike = await createEmployee(root, tenantId, 'Mike', [
      'flat-repair',
      'tire-swap',
      'tire-rotation',
      'tire-install',
      'balancing',
    ]);

    // Future weekday with shift coverage 9-17 for both.
    const date = '2030-06-10'; // Monday
    await createScheduleEntry(root, tenantId, carlos, date, '09:00', '17:00');
    await createScheduleEntry(root, tenantId, mike, date, '09:00', '17:00');

    const fromTime = `${date}T15:00:00.000Z`; // 10:00 CDT, in shift
    const slots = await findNextAvailableSlots(
      root as unknown as Parameters<typeof findNextAvailableSlots>[0],
      {
        tenantId,
        fromTime,
        durationMinutes: 30,
        requiredSkills: ['tire-rotation'],
        count: 3,
      }
    );

    expect(slots.length).toBeGreaterThan(0);
    const first = slots[0];
    expect(first.start_time).toBe(new Date(fromTime).toISOString());
    // Carlos has 3 skills; Mike has 5. Carlos must win the first slot.
    expect(first.employee_id).toBe(carlos);
    expect(first.skill_count).toBe(3);
  });

  it('HAPPY: an off-grid fromTime is snapped UP to the next quarter-hour boundary', async () => {
    if (!dbAvailable) return;
    // WHO: the "soonest I can get you in" fallback, whose fromTime is a raw
    //        new Date() — minutes and seconds land wherever the wall clock is.
    // WHAT: every suggested slot must sit on the :00/:15/:30/:45 grid with
    //        zero seconds, and the first slot is the NEXT boundary at or after
    //        fromTime — never fromTime's own off-grid minutes carried forward.
    // WHY: 2026-07-17 live call — a 4:34 AM search offered "1:04 PM" and
    //        "1:19 PM"; the caller picked 1:19, and the booking INSERT died on
    //        appointments_end_time_15min (unhandled 500, agent went silent).
    //        The suggester must only offer times booking can accept.
    const tenantId = await createTenant(root, 'TireCo', 'mobile_tire', 'America/Chicago');
    await createResource(root, tenantId, 'Truck 1');
    const carlos = await createEmployee(root, tenantId, 'Carlos', ['tire-rotation']);
    const date = '2030-06-10'; // Monday
    await createScheduleEntry(root, tenantId, carlos, date, '09:00', '17:00');

    const fromTime = `${date}T15:04:05.123Z`; // 10:04:05 CDT — off-grid on purpose
    const slots = await findNextAvailableSlots(
      root as unknown as Parameters<typeof findNextAvailableSlots>[0],
      {
        tenantId,
        fromTime,
        durationMinutes: 30,
        requiredSkills: ['tire-rotation'],
        count: 3,
      }
    );

    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].start_time).toBe(`${date}T15:15:00.000Z`);
    for (const slot of slots) {
      for (const t of [slot.start_time, slot.end_time]) {
        const d = new Date(t);
        expect([0, 15, 30, 45], `${t} must be on the quarter-hour grid`).toContain(
          d.getUTCMinutes()
        );
        expect(d.getUTCSeconds()).toBe(0);
        expect(d.getUTCMilliseconds()).toBe(0);
      }
    }
  });

  it('HAPPY: lower-skill busy — first slot uses higher-skill emp at SAME time', async () => {
    if (!dbAvailable) return;
    // WHO: Carlos is mid-job; Mike is idle; caller wants a tire rotation now
    // WHAT: helper returns the requested time itself, paired with Mike
    //        (only-available qualified employee at that moment)
    // WHY: this is exactly the scenario the user articulated — "if A and
    //        B (juniors) are busy and C (senior) is idle, pick C." The
    //        busy filter shifts the candidate set; the sort then picks
    //        from whoever's left.

    const tenantId = await createTenant(root, 'TireCo', 'mobile_tire', 'America/Chicago');
    const truck1 = await createResource(root, tenantId, 'Truck 1');
    const truck2 = await createResource(root, tenantId, 'Truck 2');
    const carlos = await createEmployee(root, tenantId, 'Carlos', ['tire-rotation']);
    const mike = await createEmployee(root, tenantId, 'Mike', [
      'flat-repair',
      'tire-swap',
      'tire-rotation',
      'tire-install',
      'balancing',
    ]);

    const date = '2030-06-10';
    await createScheduleEntry(root, tenantId, carlos, date, '09:00', '17:00');
    await createScheduleEntry(root, tenantId, mike, date, '09:00', '17:00');

    // Pre-book Carlos at 15:00-15:30 UTC on Truck 1 — he's mid-job at the
    // requested time. Mike is free.
    const cust = await createCustomerFull(root, tenantId, '+15551112222', 'Existing Customer');
    await createAppointment(
      root,
      tenantId,
      truck1,
      cust,
      `${date}T15:00:00.000Z`,
      `${date}T15:30:00.000Z`,
      'pre-book carlos',
      'scheduled',
      carlos
    );

    const slots = await findNextAvailableSlots(
      root as unknown as Parameters<typeof findNextAvailableSlots>[0],
      {
        tenantId,
        fromTime: `${date}T15:00:00.000Z`,
        durationMinutes: 30,
        requiredSkills: ['tire-rotation'],
        count: 3,
      }
    );

    expect(slots.length).toBeGreaterThan(0);
    const first = slots[0];
    expect(first.start_time).toBe(`${date}T15:00:00.000Z`);
    expect(first.employee_id, 'Mike (only available qualified employee) wins').toBe(mike);
    // Subsequent slots may still pair with Carlos as he frees up — that's fine.
    void truck2;
  });

  it('HAPPY: all busy at requested time — first slot is the next time someone frees up', async () => {
    if (!dbAvailable) return;
    // WHO: every qualified tech is mid-job at 15:00; caller wants a
    //        tire rotation
    // WHAT: helper returns the next 15-min boundary at which any tech
    //        finishes — Carlos at 15:30, then Mike at 16:00 etc.
    // WHEN: a fully-booked moment, common during a busy lunch rush
    // WHERE: SQL slot_starts × candidates predicate
    // WHY: pin the user's articulated principle — "if everyone's busy,
    //        find the next time someone is free, and pick THAT slot
    //        with whoever frees up first." The helper must skip
    //        forward through the 15-min grid, not return empty.

    const tenantId = await createTenant(root, 'TireCo', 'mobile_tire', 'America/Chicago');
    const truck1 = await createResource(root, tenantId, 'Truck 1');
    const truck2 = await createResource(root, tenantId, 'Truck 2');
    const carlos = await createEmployee(root, tenantId, 'Carlos', ['tire-rotation', 'flat-repair']);
    const mike = await createEmployee(root, tenantId, 'Mike', [
      'tire-rotation',
      'flat-repair',
      'tire-install',
      'balancing',
    ]);

    const date = '2030-06-10';
    await createScheduleEntry(root, tenantId, carlos, date, '09:00', '17:00');
    await createScheduleEntry(root, tenantId, mike, date, '09:00', '17:00');

    // Pre-book BOTH techs covering 15:00. Carlos finishes at 15:30, Mike
    // at 16:00. Helper should return 15:30 first.
    const cust = await createCustomerFull(root, tenantId, '+15551112222', 'Existing Customer');
    await createAppointment(
      root,
      tenantId,
      truck1,
      cust,
      `${date}T15:00:00.000Z`,
      `${date}T15:30:00.000Z`,
      'carlos busy',
      'scheduled',
      carlos
    );
    await createAppointment(
      root,
      tenantId,
      truck2,
      cust,
      `${date}T15:00:00.000Z`,
      `${date}T16:00:00.000Z`,
      'mike busy',
      'scheduled',
      mike
    );

    const slots = await findNextAvailableSlots(
      root as unknown as Parameters<typeof findNextAvailableSlots>[0],
      {
        tenantId,
        fromTime: `${date}T15:00:00.000Z`,
        durationMinutes: 30,
        requiredSkills: ['tire-rotation'],
        count: 3,
      }
    );

    expect(slots.length).toBeGreaterThan(0);
    const first = slots[0];
    // Earliest free 30-min window: Carlos 15:30-16:00 (he just finished).
    expect(first.start_time).toBe(`${date}T15:30:00.000Z`);
    expect(first.employee_id).toBe(carlos);
    // The 16:00 slot should also exist — Mike just freed.
    const sixteenSlot = slots.find((s) => s.start_time === `${date}T16:00:00.000Z`);
    expect(sixteenSlot).toBeTruthy();
  });

  it('SAD: nothing in the search horizon — empty array', async () => {
    if (!dbAvailable) return;
    // WHO: caller asks for a service nobody is qualified for, OR a
    //        time outside any employee's shift window
    // WHAT: helper returns [] — never throws, never returns garbage
    // WHY: callers (agent + dashboard) check the array length to decide
    //        whether to surface "no alternatives found" UX. Throwing
    //        would force them all to wrap in try/catch.

    const tenantId = await createTenant(root, 'TireCo', 'mobile_tire', 'America/Chicago');
    await createResource(root, tenantId, 'Truck 1');
    await createEmployee(root, tenantId, 'Carlos', ['tire-rotation']);
    // No shift entries — Carlos isn't on any day's schedule.

    const slots = await findNextAvailableSlots(
      root as unknown as Parameters<typeof findNextAvailableSlots>[0],
      {
        tenantId,
        fromTime: '2030-06-10T15:00:00.000Z',
        durationMinutes: 30,
        requiredSkills: ['tire-rotation'],
        count: 3,
      }
    );

    expect(slots).toEqual([]);
  });

  it('HAPPY: requiredSkills empty — any qualified employee counts (open service)', async () => {
    if (!dbAvailable) return;
    // WHO: caller asks for a generic appointment with no specific skill
    //        required (walk-in, consultation, etc.)
    // WHAT: helper falls open and returns earliest free slots without
    //        a skill filter
    // WHY: the booking RPC has the same fall-open behavior; the helper
    //        must agree so suggestion lists match what the actual book
    //        will accept

    const tenantId = await createTenant(root, 'TireCo', 'mobile_tire', 'America/Chicago');
    const truck1 = await createResource(root, tenantId, 'Truck 1');
    const carlos = await createEmployee(root, tenantId, 'Carlos', []);
    const date = '2030-06-10';
    await createScheduleEntry(root, tenantId, carlos, date, '09:00', '17:00');

    const slots = await findNextAvailableSlots(
      root as unknown as Parameters<typeof findNextAvailableSlots>[0],
      {
        tenantId,
        fromTime: `${date}T15:00:00.000Z`,
        durationMinutes: 30,
        requiredSkills: [],
        count: 1,
      }
    );

    expect(slots.length).toBe(1);
    expect(slots[0].employee_id).toBe(carlos);
    void truck1;
  });

  it('SAD→FIXED: a slot crossing local MIDNIGHT is never offered (the 11:30 PM live bug)', async () => {
    if (!dbAvailable) return;
    // WHO: the 2026-07-17 22:13 CDT caller — offered "today at 11:30 PM or
    //       11:45 PM" against a 1:00–5:00 PM shift, and the RPC then ACCEPTED
    //       the 11:30 PM booking.
    // WHAT: searching from late evening must return NOTHING on a day whose
    //        shift has ended — the midnight-wrapping slots (whose local end
    //        casts to 00:00-ish and compares as "before" any afternoon shift
    //        end) must not leak.
    // WHEN: any search whose horizon crosses local midnight — i.e., every
    //        evening call.
    // WHERE: availabilitySearch.ts shift-coverage join (wrap-aware CASE);
    //        migration 20260718003000 carries the identical RPC fix.
    // WHY: only the wrapping slots leaked, so the caller heard exactly
    //       11:30/11:45 PM and nothing between 5:00 and 11:15 — a nonsense
    //       offer the enforce layer then failed to refuse. Pre-fix this test
    //       FAILS with those two slots; post-fix the next offer is the NEXT
    //       day's shift.
    const tenantId = await createTenant(root, 'NightWrap Co', 'ai-platform', 'America/Chicago');
    await createResource(root, tenantId, 'Line 1');
    const emp = await createEmployee(root, tenantId, 'Dale Test', []);
    const date = '2030-06-10'; // Monday, CDT (UTC-5)
    const nextDate = '2030-06-11';
    await createScheduleEntry(root, tenantId, emp, date, '13:00', '17:00');
    await createScheduleEntry(root, tenantId, emp, nextDate, '13:00', '17:00');

    // 10:00 PM local on the shift day = 03:00Z next calendar day (CDT).
    const slots = await findNextAvailableSlots(
      root as unknown as Parameters<typeof findNextAvailableSlots>[0],
      {
        tenantId,
        fromTime: `${nextDate}T03:00:00.000Z`,
        durationMinutes: 30,
        requiredSkills: [],
        count: 5,
        searchHorizonHours: 24,
      }
    );

    // Nothing tonight — the first legitimate offer is TOMORROW's 1:00 PM
    // (18:00Z), never a 23:30/23:45 wrap tonight.
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].start_time).toBe(`${nextDate}T18:00:00.000Z`);
    for (const s of slots) {
      const localHour = new Date(s.start_time).toLocaleTimeString('en-US', {
        timeZone: 'America/Chicago',
        hour12: false,
        hour: '2-digit',
      });
      expect(Number(localHour), `offered ${s.start_time}`).toBeLessThan(17);
    }
  });

  it('SAD→FIXED: the booking RPC REFUSES a midnight-wrapping slot (EMPLOYEE_NOT_SCHEDULED)', async () => {
    if (!dbAvailable) return;
    // WHO: the enforce layer on the same live call — it ACCEPTED 11:30 PM →
    //       midnight because its v_end_time_of_day had the identical wrap hole.
    // WHAT: book 11:30 PM → midnight local on a 1-5 PM shift day → the RPC
    //        must refuse with EMPLOYEE_NOT_SCHEDULED, not book it.
    // WHERE: book_with_scheduling_atomic (migration 20260718003000).
    // WHY: suggest and enforce must read the same clock AND the same calendar;
    //       the GiST overlap constraints cannot catch a shift-coverage miss.
    // REQUIRED SKILLS on purpose: that selects the RPC branch the LIVE call
    // took (the route derives skills from the service, which is how Dale got
    // assigned to the 11:30 PM booking). The no-skills ELSE branch books a
    // resource with NO shift validation at all — a separate standing gap,
    // documented in the PR, deliberately not this fix.
    const tenantId = await createTenant(root, 'NightWrap RPC Co', 'ai-platform', 'America/Chicago');
    await createResource(root, tenantId, 'Line 1');
    const emp = await createEmployee(root, tenantId, 'Dale Test', ['consulting']);
    const date = '2030-06-10';
    await createScheduleEntry(root, tenantId, emp, date, '13:00', '17:00');

    // 11:30 PM local CDT = 04:30Z next day; end at local midnight = 05:00Z.
    const res = await root.query<{ success: boolean; error_code: string | null }>(
      `SELECT success, error_code FROM book_with_scheduling_atomic(
         p_tenant_id => $1,
         p_phone => '+15550009999',
         p_customer_name => 'Wrap Test',
         p_start_time => '2030-06-11T04:30:00Z'::timestamptz,
         p_end_time => '2030-06-11T05:00:00Z'::timestamptz,
         p_required_skills => ARRAY['consulting'],
         p_duration_minutes => 30
       )`,
      [tenantId]
    );
    expect(res.rows[0].success).toBe(false);
    expect(res.rows[0].error_code).toBe('EMPLOYEE_NOT_SCHEDULED');

    // Control: the same skills-path booking INSIDE the shift books fine —
    // proves the wrap fix rejects the wrap, not the whole branch.
    const okRes = await root.query<{ success: boolean; error_code: string | null }>(
      `SELECT success, error_code FROM book_with_scheduling_atomic(
         p_tenant_id => $1,
         p_phone => '+15550009999',
         p_customer_name => 'Wrap Test',
         p_start_time => '2030-06-10T19:00:00Z'::timestamptz,
         p_end_time => '2030-06-10T19:30:00Z'::timestamptz,
         p_required_skills => ARRAY['consulting'],
         p_duration_minutes => 30
       )`,
      [tenantId]
    );
    expect(okRes.rows[0].error_code).toBeNull();
    expect(okRes.rows[0].success).toBe(true);
  });

  describe('WORKDAY BOUNDARIES (Dale, 2030-07-12): bookable to the edge, refused past it', () => {
    // WHO: every booking near open/close. WHAT: the last slot of the day
    //       (ends exactly AT closing) books; a slot ending one grid-step past
    //       closing, or starting before opening, is refused/never offered.
    // WHY: the midnight-wrap fix must not over-correct — rejecting the wrap
    //       is only right if 4:30–5:00 on a 1–5 shift still works. Boundary
    //       pairs prove both directions.
    const TZCO = 'America/Chicago';
    const DATE = '2030-06-10'; // Monday, CDT (UTC-5): local 13:00 = 18:00Z

    async function seedTenant(): Promise<string> {
      const tenantId = await createTenant(root, 'Edge Co', 'ai-platform', TZCO);
      await createResource(root, tenantId, 'Line 1');
      const emp = await createEmployee(root, tenantId, 'Dale Test', ['consulting']);
      await createScheduleEntry(root, tenantId, emp, DATE, '13:00', '17:00');
      return tenantId;
    }

    async function book(tenantId: string, fromZ: string, toZ: string) {
      const res = await root.query<{ success: boolean; error_code: string | null }>(
        `SELECT success, error_code FROM book_with_scheduling_atomic(
           p_tenant_id => $1, p_phone => '+15550008888', p_customer_name => 'Edge',
           p_start_time => $2::timestamptz, p_end_time => $3::timestamptz,
           p_required_skills => ARRAY['consulting'], p_duration_minutes => 30
         )`,
        [tenantId, fromZ, toZ]
      );
      return res.rows[0];
    }

    it('HAPPY: the LAST slot of the day (4:30–5:00 on a 1–5 shift) books', async () => {
      if (!dbAvailable) return;
      const t = await seedTenant();
      const r = await book(t, `${DATE}T21:30:00Z`, `${DATE}T22:00:00Z`); // 4:30–5:00 PM local
      expect(r.error_code).toBeNull();
      expect(r.success).toBe(true);
    });

    it('HAPPY: the FIRST slot of the day (1:00–1:30) books', async () => {
      if (!dbAvailable) return;
      const t = await seedTenant();
      const r = await book(t, `${DATE}T18:00:00Z`, `${DATE}T18:30:00Z`); // 1:00–1:30 PM local
      expect(r.error_code).toBeNull();
      expect(r.success).toBe(true);
    });

    it('SAD: a slot ENDING past closing (4:45–5:15) is refused', async () => {
      if (!dbAvailable) return;
      const t = await seedTenant();
      const r = await book(t, `${DATE}T21:45:00Z`, `${DATE}T22:15:00Z`); // 4:45–5:15 PM local
      expect(r.success).toBe(false);
      expect(r.error_code).toBe('EMPLOYEE_NOT_SCHEDULED');
    });

    it('SAD: a slot STARTING before opening (12:30–1:00) is refused', async () => {
      if (!dbAvailable) return;
      const t = await seedTenant();
      const r = await book(t, `${DATE}T17:30:00Z`, `${DATE}T18:00:00Z`); // 12:30–1:00 PM local
      expect(r.success).toBe(false);
      expect(r.error_code).toBe('EMPLOYEE_NOT_SCHEDULED');
    });

    it('SAD: a slot fully AFTER closing (5:00–5:30) is refused', async () => {
      if (!dbAvailable) return;
      const t = await seedTenant();
      const r = await book(t, `${DATE}T22:00:00Z`, `${DATE}T22:30:00Z`); // 5:00–5:30 PM local
      expect(r.success).toBe(false);
      expect(r.error_code).toBe('EMPLOYEE_NOT_SCHEDULED');
    });

    it('SAD: the SKILL-LESS path refuses a midnight wrap when schedules exist (review on #285)', async () => {
      if (!dbAvailable) return;
      // WHO: a service with no required skills — the RPC's ELSE branch, which
      //       historically booked a resource with NO shift check at all.
      // WHAT: with non-off schedule rows on the date and none covering the
      //        window, the booking is refused — the narrow guard closes the
      //        wrap hole for skill-less services too.
      const t = await seedTenant();
      const res = await root.query<{ success: boolean; error_code: string | null }>(
        `SELECT success, error_code FROM book_with_scheduling_atomic(
           p_tenant_id => $1, p_phone => '+15550007777', p_customer_name => 'Skilless',
           p_start_time => '2030-06-11T04:30:00Z'::timestamptz,
           p_end_time => '2030-06-11T05:00:00Z'::timestamptz,
           p_duration_minutes => 30
         )`,
        [t]
      );
      expect(res.rows[0].success).toBe(false);
      expect(res.rows[0].error_code).toBe('EMPLOYEE_NOT_SCHEDULED');

      // ...and the same skill-less path INSIDE the shift still books.
      const okRes = await root.query<{ success: boolean; error_code: string | null }>(
        `SELECT success, error_code FROM book_with_scheduling_atomic(
           p_tenant_id => $1, p_phone => '+15550007777', p_customer_name => 'Skilless',
           p_start_time => '${DATE}T19:00:00Z'::timestamptz,
           p_end_time => '${DATE}T19:30:00Z'::timestamptz,
           p_duration_minutes => 30
         )`,
        [t]
      );
      expect(okRes.rows[0].error_code).toBeNull();
      expect(okRes.rows[0].success).toBe(true);
    });

    it('SAD: a tenant with NO staff and NO schedule cannot be booked — the fall-open is gone', async () => {
      if (!dbAvailable) return;
      // WHY: this test used to pin the historical fall-open — a tenant that did
      //       not manage schedules booked "exactly as before". What it booked was
      //       an appointment with a room and NOBODY on it. Migration 20260909210000
      //       retired that on purpose (Dale, 2026-09-09: "you can't book an
      //       appointment with a resource that doesn't exist"; 2026-09-11: a
      //       person is bookable when the skill map links them and they are
      //       scheduled). This is a RULE CHANGE, recorded as one — not a loosened
      //       test: the assertion flipped because the product decision did.
      const tenantId = await createTenant(root, 'NoSchedule Co', 'ai-platform', TZCO);
      await createResource(root, tenantId, 'Line 1');
      const res = await root.query<{ success: boolean; error_code: string | null }>(
        `SELECT success, error_code FROM book_with_scheduling_atomic(
           p_tenant_id => $1, p_phone => '+15550006666', p_customer_name => 'Open',
           p_start_time => '2030-06-11T04:30:00Z'::timestamptz,
           p_end_time => '2030-06-11T05:00:00Z'::timestamptz,
           p_duration_minutes => 30
         )`,
        [tenantId]
      );
      expect(res.rows[0].success).toBe(false);
      expect(res.rows[0].error_code).toBe('NO_SKILLED_EMPLOYEE');
      const written = await root.query(
        'SELECT count(*) AS n FROM appointments WHERE tenant_id = $1',
        [tenantId]
      );
      expect(Number(written.rows[0].n)).toBe(0);
    });

    it("SUGGESTER: the day's LAST offer is 4:30 PM — never 4:45, never a wrap", async () => {
      if (!dbAvailable) return;
      const t = await seedTenant();
      const slots = await findNextAvailableSlots(
        root as unknown as Parameters<typeof findNextAvailableSlots>[0],
        {
          tenantId: t,
          fromTime: `${DATE}T21:00:00Z`, // 4:00 PM local
          durationMinutes: 30,
          requiredSkills: [],
          count: 10,
          searchHorizonHours: 6,
        }
      );
      const starts = slots.map((s) => s.start_time);
      expect(starts).toContain(`${DATE}T21:30:00.000Z`); // 4:30 — last legal start
      for (const s of starts) {
        expect(new Date(s).getTime()).toBeLessThanOrEqual(new Date(`${DATE}T21:30:00Z`).getTime());
      }
    });
  });

  describe('NIGHT SHIFTS keep their midnight (suggest-side parity with Fix #30)', () => {
    it('HAPPY: a 23:00–06:00 shift still offers its pre-midnight wrapping slots', async () => {
      if (!dbAvailable) return;
      // WHO: a night-shift business (the RPC's Fix #30 tests are the enforce
      //       side; this is the suggest side of the same contract).
      // WHAT: the shape-aware wrap rule must NOT hide 23:30 → 00:00 on a shift
      //        whose end < start — only DAY shifts lose their wraps.
      // WHY: the first version of the wrap fix ('24:00:00' unconditionally)
      //       killed night shifts and CI caught it in the RPC; this pins the
      //       suggester against the same regression.
      const tenantId = await createTenant(
        root,
        'Night Suggest Co',
        'auto-repair',
        'America/Chicago'
      );
      await createResource(root, tenantId, 'Bay 1');
      const emp = await createEmployee(root, tenantId, 'Night Worker', []);
      const date = '2030-06-10';
      await createScheduleEntry(root, tenantId, emp, date, '23:00', '06:00');

      const slots = await findNextAvailableSlots(
        root as unknown as Parameters<typeof findNextAvailableSlots>[0],
        {
          tenantId,
          // 11:00 PM CDT on the shift date — which is 04:00Z on the FOLLOWING
          // UTC date (CDT = UTC-5).
          fromTime: `2030-06-11T04:00:00.000Z`,
          durationMinutes: 30,
          requiredSkills: [],
          count: 5,
          searchHorizonHours: 2,
        }
      );
      // 11:30 PM CDT on the shift date = 04:30Z on the following UTC date.
      const starts = slots.map((s) => s.start_time);
      expect(starts).toContain(`2030-06-11T04:30:00.000Z`);
    });
  });

  describe('TENANT-CLOCK RENDERING (Dale, 2030-07-12): the caller hears THEIR wall-clock', () => {
    // WHO: any non-Chicago tenant. WHAT: a New-York tenant's 1:00 PM shift
    //       (17:00Z in June) must surface as 1:00 PM — a UTC-leak would say
    //       5:00 PM. The suggester returns UTC instants; every SPOKEN surface
    //       renders them via the tenant's IANA zone.
    // WHY: Dale's hypothesis on the 11:30 PM call. The rendering was in fact
    //       correct (11:30 PM was accurately local; the SLOT was the lie), but
    //       the property deserves its own pin so a future rendering leak can't
    //       hide behind a coverage bug.
    it("a New-York tenant's slots land on New-York wall-clock boundaries", async () => {
      if (!dbAvailable) return;
      const tenantId = await createTenant(root, 'NY Render Co', 'ai-platform', 'America/New_York');
      await createResource(root, tenantId, 'Line 1');
      const emp = await createEmployee(root, tenantId, 'Ann', []);
      const date = '2030-06-10';
      await createScheduleEntry(root, tenantId, emp, date, '13:00', '17:00');

      const slots = await findNextAvailableSlots(
        root as unknown as Parameters<typeof findNextAvailableSlots>[0],
        {
          tenantId,
          fromTime: `${date}T00:00:00Z`,
          durationMinutes: 30,
          requiredSkills: [],
          count: 1,
        }
      );
      expect(slots.length).toBe(1);
      // 1:00 PM America/New_York in June = 17:00Z (EDT). A Chicago-or-UTC leak
      // would produce 18:00Z / 13:00Z instead.
      expect(slots[0].start_time).toBe(`${date}T17:00:00.000Z`);
      const local = new Date(slots[0].start_time).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
      });
      expect(local).toBe('1:00 PM');
    });
  });
});
