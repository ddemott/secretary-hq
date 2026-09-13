/**
 * Per-call turn-latency samples, on their way to the backend histogram.
 *
 * WHY THIS EXISTS AT ALL: only the agent can measure a turn. The backend never
 * sees one — it sees tool calls and a session-end POST — so `turn_latency_ms`
 * was a log line and nothing else, greppable on Better Stack (which is not set)
 * and invisible on `/metrics`. A number that exists only in a log nobody
 * scrapes cannot be alerted on, which is how the 2026-08-19 call sat through
 * 17s and 20s of dead air with a "healthy" system.
 *
 * The agent does NOT get its own /metrics endpoint for this. It is a LiveKit
 * job process — many short-lived processes, no stable scrape target, and
 * counters that die with the job. Shipping the samples to the one process that
 * already has a scrapeable registry is the shape that survives.
 *
 * Bounded on purpose: a pathological call cannot post a huge array, and the cap
 * is enforced HERE as well as in the Zod schema so the agent never builds a
 * payload the backend would reject wholesale.
 */

/** Matches VoiceSessionEndSchema.turn_latency_ms — keep the two in step. */
export const MAX_TURN_LATENCY_SAMPLES = 100;
export const MAX_TURN_LATENCY_MS = 600_000;

export class TurnLatencyCollector {
  private samples: number[] = [];
  private dropped = 0;

  /**
   * Record one turn. Non-finite, negative, and absurd values are dropped
   * rather than clamped: a clamped 600s sample would sit in the top bucket and
   * read as a real 10-minute turn, which is a worse lie than a missing sample.
   */
  record(latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > MAX_TURN_LATENCY_MS) {
      this.dropped++;
      return;
    }
    if (this.samples.length >= MAX_TURN_LATENCY_SAMPLES) {
      this.dropped++;
      return;
    }
    this.samples.push(Math.round(latencyMs));
  }

  /** How many samples were refused (over cap or out of range). */
  droppedCount(): number {
    return this.dropped;
  }

  /**
   * The TRUE number of turns this call had — accepted samples plus dropped
   * ones. `toPayload()` alone would undercount a pathologically long call
   * once it crosses MAX_TURN_LATENCY_SAMPLES, and turn count (unlike the
   * latency histogram) has no reason to be capped: it's a single integer,
   * not an array shipped over the wire per-sample.
   */
  totalCount(): number {
    return this.samples.length + this.dropped;
  }

  /**
   * The wire payload for voice-session-end, or undefined when no turn was ever
   * measured — an empty array would be a claim of "zero-latency call", and
   * omission is the honest shape for "nothing measured".
   */
  toPayload(): number[] | undefined {
    return this.samples.length > 0 ? [...this.samples] : undefined;
  }
}
