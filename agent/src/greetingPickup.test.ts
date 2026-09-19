/**
 * WHO: inbound caller, the instant the leg is up.
 * WHAT: we do not wait after pickup for TTS cache to fill, but we do hold
 *       a short fixed pre-roll once the cache IS filled so the caller's own
 *       audio path has time to open.
 * WHEN: 2026-08-14 — 12s post-pickup wait (waiting FOR the cache) was dead
 *       air; Dale: "would you wait 3 seconds before answering?". 2026-09-16
 *       — a DIFFERENT problem: with zero pre-roll, the greeting's first word
 *       or two were getting clipped by the caller's own handset/carrier
 *       audio path not being fully open yet. Fixed 300ms pre-roll added
 *       AFTER the greeting is already warmed and ready — never a wait ON
 *       the greeting, so it does not reintroduce the 2026-08-14 defect.
 * WHERE: greetingPickup.ts, consumed by index.ts say().
 * WHY: a prompt/cap that delays first audio WHILE WAITING FOR THE GREETING
 *      TO BE READY is the pause to avoid; a short pre-roll AFTER it's ready
 *      is a deliberate, bounded trade for not clipping the opener.
 */
import { describe, expect, it } from 'vitest';
import {
  GREETING_POST_PICKUP_WAIT_MS,
  auraTtsStreamingEnabled,
  canWarmGreetingBeforePickup,
  greetingSpeakPath,
  shouldPreRoll,
} from './greetingPickup.js';

describe('greeting pickup', () => {
  it('holds a short fixed pre-roll after the caller is on the line, to avoid clipping the opener', () => {
    expect(GREETING_POST_PICKUP_WAIT_MS).toBe(300);
  });

  it('plays cache if the ring-time warm landed; otherwise speaks live NOW', () => {
    expect(greetingSpeakPath(true)).toBe('play_cache');
    expect(greetingSpeakPath(false)).toBe('speak_live');
  });

  // 2026-09-17 (Copilot review on #525): the pre-roll must be gated on
  // play_cache. On speak_live, the caller already sat through a warm that
  // timed out or failed with nothing to play — stacking a flat 300ms on
  // top of that reintroduces the 2026-08-14 "waiting after pickup" defect.
  it('pre-rolls only when a cached frame is ready to play, never on the live fallback', () => {
    expect(shouldPreRoll('play_cache')).toBe(true);
    expect(shouldPreRoll('speak_live')).toBe(false);
  });

  it('can start the greeting warm from dispatch tenant_id — before pickup', () => {
    expect(canWarmGreetingBeforePickup('d5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0')).toBe(true);
    expect(canWarmGreetingBeforePickup('')).toBe(false);
    expect(canWarmGreetingBeforePickup(null)).toBe(false);
  });

  it('AURA_TTS_STREAMING=false turns the silent WS path off', () => {
    const prev = process.env.AURA_TTS_STREAMING;
    process.env.AURA_TTS_STREAMING = 'false';
    expect(auraTtsStreamingEnabled()).toBe(false);
    if (prev === undefined) delete process.env.AURA_TTS_STREAMING;
    else process.env.AURA_TTS_STREAMING = prev;
  });
});
