/**
 * Real-DB guard: a shift boundary is fuzzy by one minute, and by exactly one.
 *
 * 5W:
 *   WHO  — a caller who names a round time ("five o'clock") against a shift the
 *          owner happened to save as ending 16:59
 *   WHAT — shift_covers_booking() accepts a miss of ONE minute at either edge,
 *          refuses two, and leaves the midnight-wrap rules untouched
 *   WHEN — every booking attempt and every availability suggestion
 *   WHERE— migration 20260909120000_shift_boundary_slack.sql; the function is
 *          called three times inside book_with_scheduling_atomic and once from
 *          src/services/availabilitySearch.ts
 *   WHY  — Dale's rule, 2026-09-09: people butt meetings end to end and speak in
 *          round numbers. Refusing 17:00 against a 16:59 shift end is refusing a
 *          minute nobody meant. The slack lives at the SHIFT boundary only —
 *          appointments still sit on the quarter-hour grid, so no odd-minute
 *          appointment is ever created.
 *
 * WHY REAL POSTGRES: this is a SQL function, and the wrap behaviour it guards
 * against is Postgres's own ('23:59'::time + '1 minute' = '00:00'). A mock has no
 * opinion about time arithmetic; only the database can answer.
 *
 * WHY IT ALSO CHECKS THE CALL SITES: the same coverage rule previously existed as
 * four hand-copied clauses, and suggest/enforce drifting apart is how the
 * 2026-07-17 midnight-wrap call shipped — the agent offered 11:30 PM against a
 * 1-5 PM shift and then booked it. Asserting the function EXISTS is not enough;
 * what matters is that nobody is still spelling the comparison out by hand.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Client } from 'pg';
import { getRootClient, skipIfDbDown } from '../utils';

let setup: Client;
let dbAvailable = false;

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    dbAvailable = true;
  } catch (err) {
    console.warn('[shiftBoundarySlack.realdb] DB not available, skipping', err);
  }
});

afterAll(async () => {
  if (setup) await setup.end();
});

beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

/** shift 13:00-17:00 unless stated; slot start/end; does the shift cover it? */
async function covers(
  shiftStart: string,
  shiftEnd: string,
  slotStart: string,
  slotEnd: string,
  wraps: boolean
): Promise<boolean> {
  const res = await setup.query<{ covered: boolean }>(
    'SELECT public.shift_covers_booking($1::time, $2::time, $3::time, $4::time, $5) AS covered',
    [shiftStart, shiftEnd, slotStart, slotEnd, wraps]
  );
  return res.rows[0].covered;
}

describe('shift_covers_booking — one minute of slack, and only one', () => {
  it('HAPPY: a booking wholly inside the shift is covered', async () => {
    expect(await covers('13:00', '17:00', '13:00', '13:30', false)).toBe(true);
  });

  it("HAPPY: Dale's case — a 17:00 booking against a 16:59 shift end", async () => {
    // The caller says "five o'clock". The shift on file ends 16:59. Before this
    // migration the booking was refused, and the caller heard that the time was
    // unavailable over a one-minute discrepancy no human would call a conflict.
    expect(await covers('13:00', '16:59', '16:30', '17:00', false)).toBe(true);
  });

  it('HAPPY: a booking starting one minute before the shift opens', async () => {
    // Same rule at the other edge: 12:59 against a 13:00 shift start.
    expect(await covers('13:00', '17:00', '12:59', '13:29', false)).toBe(true);
  });

  it('SAD: two minutes over the end is still refused', async () => {
    // The slack is a rounding allowance, not a general softening. A shift that
    // ends 16:58 does not cover a booking that runs to 17:00.
    expect(await covers('13:00', '16:58', '16:30', '17:00', false)).toBe(false);
  });

  it('SAD: two minutes before the start is still refused', async () => {
    expect(await covers('13:00', '17:00', '12:58', '13:28', false)).toBe(false);
  });

  it('SAD: a DAY shift never covers a slot that wraps past local midnight', async () => {
    // The 2026-07-17 live call: an 11:30 PM slot was offered AND booked against a
    // 1-5 PM shift, because the wrapped end (::time 00:00) compared as "before"
    // 17:00. That rule is preserved here verbatim — the slack must not reopen it.
    expect(await covers('13:00', '17:00', '23:30', '00:00', true)).toBe(false);
  });

  it('HAPPY: a NIGHT shift still covers its pre-midnight and wrapping stretches', async () => {
    // The first attempt at the midnight fix used '24:00:00' unconditionally and
    // killed cross-midnight shifts; CI caught it. Both shapes stay covered.
    expect(await covers('23:00', '06:00', '23:30', '00:00', false)).toBe(true);
    expect(await covers('23:00', '06:00', '23:30', '00:00', true)).toBe(true);
  });

  it('SAD: a wrapping slot past a NIGHT shift end is refused', async () => {
    expect(await covers('23:00', '06:00', '05:45', '06:15', true)).toBe(false);
  });

  it('the slack cannot wrap midnight into a false accept', async () => {
    // `time + interval` wraps in Postgres, so a naive widening would turn a 23:59
    // boundary into 00:00 and accept a slot a whole day out of place. The guards
    // keep the un-slacked comparison first, so the fuzzy path can only ever add
    // one minute — never subtract twenty-four hours.
    expect(await covers('00:00', '06:00', '23:59', '00:29', true)).toBe(false);
  });
});

describe('shift coverage has exactly one definition', () => {
  it('the booking RPC calls the function instead of spelling the comparison out', async () => {
    const src = await setup.query<{ def: string }>(
      "SELECT pg_get_functiondef(oid) AS def FROM pg_proc WHERE proname = 'book_with_scheduling_atomic'"
    );
    expect(src.rows).toHaveLength(1);
    const def = src.rows[0].def;
    // Three shift joins inside the RPC (skills path, skill-less path, resource
    // path) — all three must go through the shared function.
    expect(def.split('shift_covers_booking').length - 1).toBe(3);
    expect(def).not.toContain('es.end_time >= v_end_time_of_day');
  });

  it('the SUGGEST side calls the same function — suggest and enforce cannot drift', () => {
    // availabilitySearch.ts is what the agent reads slots from. When it disagreed
    // with the RPC, the agent offered a slot the booking then refused. Reading the
    // file off disk is deliberate: it is the artifact that ships.
    const sql = readFileSync(join(process.cwd(), 'src/services/availabilitySearch.ts'), 'utf8');
    expect(sql).toContain('public.shift_covers_booking(');
    expect(sql).not.toContain('AND es.end_time >= ((ss.s +');
  });
});
