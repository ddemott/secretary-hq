/**
 * Tests for the LLM-outage guard.
 *
 * 5W:
 *   WHO  — a caller on a line whose LLM provider is erroring
 *   WHAT — after 2 consecutive session errors, tell them and hang up
 *   WHEN — mid-call, from the AgentSession error event
 *   WHERE— agent/src/session/outageGuard.ts
 *   WHY  — 2026-07-21 08:56: `insufficient_quota`, seven consecutive session
 *          errors, and the caller heard the greeting and then nothing at all
 *          before hanging up. Every other recovery path on this call routes
 *          through the LLM, so all of them died of the same cause. Silence is
 *          indistinguishable from a dead line.
 */
import { describe, it, expect } from 'vitest';
import {
  createOutageGuard,
  noteSessionError,
  noteAgentSpoke,
  OUTAGE_ERROR_LIMIT,
} from './outageGuard.js';

describe('outageGuard', () => {
  it('SAD: one error does NOT trip it', () => {
    // WHY: a single transient error is survivable and the model usually
    //      recovers on the next turn. Tripping at one would end calls that were
    //      going to be fine — a worse bug than the one this fixes.
    const s = createOutageGuard();
    expect(noteSessionError(s)).toBe(false);
  });

  it('HAPPY: the second consecutive error trips it', () => {
    const s = createOutageGuard();
    noteSessionError(s);
    expect(noteSessionError(s)).toBe(true);
  });

  it('SAD: successful speech in between resets the count — the errors must be CONSECUTIVE', () => {
    // WHO: a long, healthy call that hits one blip in minute two and another in
    //      minute nine.
    // WHY: that is not an outage. Hanging up on that caller would be worse than
    //      the silence this guard exists to prevent.
    const s = createOutageGuard();
    noteSessionError(s);
    noteAgentSpoke(s);
    expect(noteSessionError(s)).toBe(false);
    expect(noteSessionError(s)).toBe(true);
  });

  it('SAD: it trips exactly ONCE, however many errors follow', () => {
    // WHY: the outage line is followed by closing the call. A second trip would
    //      start talking over the goodbye — the caller's last impression would
    //      be the agent interrupting itself.
    const s = createOutageGuard();
    noteSessionError(s);
    expect(noteSessionError(s)).toBe(true);
    for (let i = 0; i < 5; i++) expect(noteSessionError(s)).toBe(false);
  });

  it('SAD: speech AFTER tripping cannot re-arm it', () => {
    // WHY: once the goodbye is playing the call is ending; re-arming could trip
    //      again mid-goodbye.
    const s = createOutageGuard();
    noteSessionError(s);
    noteSessionError(s);
    noteAgentSpoke(s);
    expect(noteSessionError(s)).toBe(false);
  });

  it('the limit is 2 — documented, not incidental', () => {
    // WHY: the real call sat through SEVEN. Pinning the constant makes a future
    //      change to it a deliberate decision with this test in the diff.
    expect(OUTAGE_ERROR_LIMIT).toBe(2);
  });

  it('SAD: a FATAL error (empty balance) trips on the FIRST occurrence, not the second', () => {
    // WHO: the 2026-09-18 1:28 PM CT caller (SCL_MFD3o5QRKQJB).
    // WHY: the second error only arrives after the SDK finishes retrying a "retryable"
    //      429 (~4s), during which the failing generation holds the speech queue and
    //      the outage line cannot play. An empty wallet cannot clear, so waiting for a
    //      second error is pure caller time thrown away.
    const s = createOutageGuard();
    expect(noteSessionError(s, { fatal: true })).toBe(true);
  });

  it('SAD: a fatal trip still fires exactly ONCE', () => {
    const s = createOutageGuard();
    expect(noteSessionError(s, { fatal: true })).toBe(true);
    expect(noteSessionError(s, { fatal: true })).toBe(false);
    expect(noteSessionError(s)).toBe(false);
  });

  it('HAPPY: a non-fatal error still needs two — fatal is opt-in, never the default', () => {
    const s = createOutageGuard();
    expect(noteSessionError(s, { fatal: false })).toBe(false);
    expect(noteSessionError(s, {})).toBe(true);
  });
});
