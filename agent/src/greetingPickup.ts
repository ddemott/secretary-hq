/**
 * Pickup rule: the caller is on the line. A receptionist does not wait
 * 3–12 seconds after answering for a cache fill, then talk.
 *
 * 2026-08-14 sim-call: GREETING_WARM_CAP_MS was raised to 12_000 so local
 * Aura collect() could finish. The caller sat in dead air after join and
 * hung up. Waiting after pickup IS the defect. Warm during ring
 * (tenant_id known, before waitForParticipant). At pickup: speak now —
 * cached frame if ready, live otherwise.
 *
 * 2026-09-16 (Dale, live calls): a DIFFERENT problem than the 12s one above —
 * the opener audio starts so close to the instant pickup is detected that the
 * caller's own handset/carrier audio path isn't fully open yet, and the first
 * word or two get clipped ("...hank you for calling" instead of "Thank you
 * for calling"). This is a fixed 300ms pre-roll AFTER the greeting is already
 * warmed and ready to play, not a wait FOR the greeting to be ready — it does
 * not reintroduce the dead-air defect above, which was caused by waiting on a
 * slow cache fill with nothing to play yet.
 */
export const GREETING_POST_PICKUP_WAIT_MS = 300;

export type GreetingSpeakPath = 'play_cache' | 'speak_live';

/**
 * Aura WebSocket TTS from this environment produced 0 audio bytes
 * (measured 2026-08-14). HTTP collect returns audio. Greeting therefore
 * plays a collected frame. speak_live is last resort only if collect failed.
 */
export function greetingSpeakPath(frameReady: boolean): GreetingSpeakPath {
  return frameReady ? 'play_cache' : 'speak_live';
}

/** Session replies: WS stream is silent here. Opt out with AURA_TTS_STREAMING=false. */
export function auraTtsStreamingEnabled(): boolean {
  return process.env.AURA_TTS_STREAMING !== 'false';
}

/** Warm may start as soon as dispatch gives a tenant_id — the phone can still be ringing. */
export function canWarmGreetingBeforePickup(tenantId: string | null | undefined): boolean {
  return typeof tenantId === 'string' && tenantId.length > 0;
}
