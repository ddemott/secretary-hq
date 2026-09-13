/**
 * TurnLatencyCollector — the per-call samples that become the backend's
 * turn_latency_ms histogram (T-006).
 *
 * WHO: the agent, on every turn of a live call.
 * WHAT: bounded collection, honest omission, no clamping.
 * WHEN: CI.
 * WHERE: agent/src/session/turnLatency.ts, drained by index.ts at session end.
 * WHY: this is the only place the number exists — the backend never sees a turn.
 *      A silently truncated or clamped sample set is worse than none, because a
 *      p95 computed from it looks exactly as authoritative as a real one.
 */
import { describe, expect, it } from 'vitest';
import {
  TurnLatencyCollector,
  MAX_TURN_LATENCY_MS,
  MAX_TURN_LATENCY_SAMPLES,
} from './turnLatency.js';

describe('TurnLatencyCollector', () => {
  it('HAPPY: records samples in order and rounds to whole milliseconds', () => {
    const c = new TurnLatencyCollector();
    c.record(820);
    c.record(1400.6);
    expect(c.toPayload()).toEqual([820, 1401]);
    expect(c.droppedCount()).toBe(0);
  });

  it('HAPPY: a call with no measured turn sends nothing at all', () => {
    // Omission, not []. An empty array reaching the backend would be a claim
    // about a call that measured nothing — and a silent hang-up measures
    // nothing by definition.
    expect(new TurnLatencyCollector().toPayload()).toBeUndefined();
  });

  it('SAD: stops at the cap instead of growing without bound', () => {
    // The cap is duplicated in VoiceSessionEndSchema. Exceeding it there fails
    // the whole POST, so the agent must never build a payload past it.
    const c = new TurnLatencyCollector();
    for (let i = 0; i < MAX_TURN_LATENCY_SAMPLES + 25; i++) c.record(500);
    expect(c.toPayload()).toHaveLength(MAX_TURN_LATENCY_SAMPLES);
    expect(c.droppedCount()).toBe(25);
  });

  it('SAD: out-of-range and non-finite samples are DROPPED, never clamped', () => {
    // A clamped 600s sample sits in the top bucket and reads as a real
    // ten-minute turn — a worse lie than a missing sample, because it moves the
    // p95 the dead-air alert reads.
    const c = new TurnLatencyCollector();
    c.record(-1);
    c.record(Number.NaN);
    c.record(Number.POSITIVE_INFINITY);
    c.record(MAX_TURN_LATENCY_MS + 1);
    expect(c.toPayload()).toBeUndefined();
    expect(c.droppedCount()).toBe(4);
  });

  it('SAD: the payload is a copy — a later turn cannot mutate an in-flight POST', () => {
    const c = new TurnLatencyCollector();
    c.record(900);
    const payload = c.toPayload()!;
    c.record(1100);
    expect(payload).toEqual([900]);
  });

  describe('totalCount()', () => {
    it('HAPPY: counts accepted samples', () => {
      const c = new TurnLatencyCollector();
      c.record(500);
      c.record(600);
      expect(c.totalCount()).toBe(2);
    });

    it('HAPPY: zero for a call with no measured turn', () => {
      expect(new TurnLatencyCollector().totalCount()).toBe(0);
    });

    it("SAD: includes dropped samples — the real turn count doesn't stop at the latency cap", () => {
      // A call with more turns than MAX_TURN_LATENCY_SAMPLES still had that
      // many real turns; toPayload() truncates for the histogram, but the
      // cost ledger's turn_count must not silently understate a long call.
      const c = new TurnLatencyCollector();
      for (let i = 0; i < MAX_TURN_LATENCY_SAMPLES + 25; i++) c.record(500);
      expect(c.totalCount()).toBe(MAX_TURN_LATENCY_SAMPLES + 25);
    });

    it('SAD: an out-of-range sample still counts as a turn, even though it is not in the payload', () => {
      const c = new TurnLatencyCollector();
      c.record(-1);
      c.record(500);
      expect(c.totalCount()).toBe(2);
    });
  });
});
