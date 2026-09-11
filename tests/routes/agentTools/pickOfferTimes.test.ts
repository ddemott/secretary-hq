/**
 * WHO : pickOfferTimes — the times the agent OFFERS out loud.
 * WHAT: earliest-first, stepped by the SERVICE duration, walking only OPEN
 *       times; never more than three; the full open_times grid stays the
 *       membership authority alongside.
 * WHEN: every get_available_slots response with a non-empty day.
 * WHERE: src/routes/agentTools/helpers.ts, consumed by the available-slots
 *       route (offer_times + the spoken sentence).
 * WHY : Dale's spec from the 2026-07-17 evening call — the model's own sample
 *       spread first/middle/last ("1:00, 2:45, or 4:30"), which callers heard
 *       as arbitrary jumps, rattled off too fast to tell apart. Offers are now
 *       computed server-side (the model does no arithmetic) as consecutive
 *       meeting-length steps, and the route's note mandates one comma-paced
 *       sentence.
 */
import { describe, it, expect } from 'vitest';
import { pickOfferTimes, offerBreadthClause } from '../../../src/routes/agentTools/helpers';

/** Build the parallel arrays the route builds: a 15-min grid over [from, to). */
function grid(fromMin: number, toMin: number, duration: number): [number[], string[]] {
  const mins: number[] = [];
  const labels: string[] = [];
  for (let t = fromMin; t + duration <= toMin; t += 15) {
    mins.push(t);
    const h24 = Math.floor(t / 60);
    const m = t % 60;
    const ampm = h24 >= 12 ? 'PM' : 'AM';
    const h = h24 % 12 === 0 ? 12 : h24 % 12;
    labels.push(`${h}:${String(m).padStart(2, '0')} ${ampm}`);
  }
  return [mins, labels];
}

describe('pickOfferTimes — duration-stepped offers from the OPEN list', () => {
  it('HAPPY: a wide-open afternoon offers consecutive meeting-length steps', () => {
    const [mins, labels] = grid(13 * 60, 17 * 60, 30); // 1:00–5:00, 30-min service
    expect(pickOfferTimes(mins, labels, 30)).toEqual(['1:00 PM', '1:30 PM', '2:00 PM']);
  });

  it('HAPPY: the step is the DURATION, not a hardcoded 30 — a 60-min service offers hourly', () => {
    const [mins, labels] = grid(13 * 60, 17 * 60, 60);
    expect(pickOfferTimes(mins, labels, 60)).toEqual(['1:00 PM', '2:00 PM', '3:00 PM']);
  });

  it('SAD: a booked 1:00–1:30 shifts the offers to the first REAL opening (Dale: "that\'s assuming those times are open")', () => {
    // Open list starts at 1:30 because [1:00,1:30) is subtracted upstream.
    const [mins, labels] = grid(13 * 60 + 30, 17 * 60, 30);
    expect(pickOfferTimes(mins, labels, 30)).toEqual(['1:30 PM', '2:00 PM', '2:30 PM']);
  });

  it('SAD: a booked block MID-afternoon is skipped to the next open time at or past the step', () => {
    // Open: 1:00–2:00 and 3:00–5:00 (2:00–3:00 booked upstream). 30-min steps:
    // 1:00 → next eligible 1:30 → next eligible 2:00 is NOT open, first open
    // ≥2:00 is 3:00.
    const g1 = grid(13 * 60, 14 * 60, 30);
    const g2 = grid(15 * 60, 17 * 60, 30);
    const mins = [...g1[0], ...g2[0]];
    const labels = [...g1[1], ...g2[1]];
    expect(pickOfferTimes(mins, labels, 30)).toEqual(['1:00 PM', '1:30 PM', '3:00 PM']);
  });

  it('SAD: fewer than three open steps → offer what exists, never invent', () => {
    const [mins, labels] = grid(16 * 60, 17 * 60, 30); // 4:00–5:00 only
    expect(pickOfferTimes(mins, labels, 30)).toEqual(['4:00 PM', '4:30 PM']);
    expect(pickOfferTimes([], [], 30)).toEqual([]);
  });
});

describe('offerBreadthClause — the offers are a sample, and the sentence says so', () => {
  // WHO: Camille, prod call SCL_HQNeyh5cVKd9, 2026-09-09 18:08 CT.
  // WHAT: offered 1:30 / 2:00 / 2:30; she asked for 4 PM; the agent said "4 PM is
  //       not available on September 10. The available times are 1:30, 2:00, or
  //       2:30." 4 PM was open — the shift runs to 5.
  // WHEN: every availability answer where more is open than is offered.
  // WHERE: offerBreadthClause, appended to the `spoken` string.
  // WHY: the response's own `note` already forbade refusing a time that appears in
  //      open_times, in plain words, and the model refused anyway. An instruction it
  //      can skim loses to a sentence it must read aloud, so the rest of the day now
  //      travels inside the sentence itself.

  it('names the last open time when more is open than offered', () => {
    const open = ['1:30 PM', '1:45 PM', '2:00 PM', '3:00 PM', '4:30 PM'];
    const offers = ['1:30 PM', '2:00 PM', '3:00 PM'];
    const clause = offerBreadthClause(open, offers);
    expect(clause).toContain('just the soonest');
    expect(clause).toContain('as late as 4:30 PM');
  });

  it('never claims every quarter hour up to the latest is open — open_times has gaps', () => {
    // WHO: PR #410 review | WHAT: "any open quarter hour through 4:30 works" is heard
    // as continuous availability, but 1:45→3:00 and 3:00→4:30 below are GAPS. A caller
    // who names 2:15 on that promise is then refused. Name the latest start only.
    const open = ['1:30 PM', '1:45 PM', '2:00 PM', '3:00 PM', '4:30 PM'];
    const clause = offerBreadthClause(open, ['1:30 PM', '2:00 PM', '3:00 PM']);
    expect(clause).not.toMatch(/\bany\b/i);
    expect(clause).not.toMatch(/\bthrough\b/i);
  });

  it('says NOTHING when the offers are the whole day', () => {
    // Inviting a caller to name a time that does not exist would trade one wrong
    // answer for another.
    const only = ['1:30 PM'];
    expect(offerBreadthClause(only, only)).toBe('');
  });

  it('says nothing for a fully booked day (no open times at all)', () => {
    expect(offerBreadthClause([], [])).toBe('');
  });

  it('counts breadth by MEMBERSHIP, not by length — a gap mid-day still widens it', () => {
    // open has 4 entries and offers 3, but the point is that 4:00 PM is reachable
    // and unoffered; a length check alone would be a coincidence that happens to work.
    const open = ['1:00 PM', '1:15 PM', '1:30 PM', '4:00 PM'];
    const offers = ['1:00 PM', '1:15 PM', '1:30 PM'];
    expect(offerBreadthClause(open, offers)).toContain('as late as 4:00 PM');
  });
});
