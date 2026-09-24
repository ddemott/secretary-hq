/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

/**
 * In-process metrics registry — Prometheus-compatible exposition.
 *
 * Why in-process and not prom-client: this codebase already has a
 * structured logging story (Pino → Better Stack). The gap was a
 * scrapeable rate/error/latency surface for dashboards and alerts. A
 * 200-line in-memory store with the standard counter + histogram shapes
 * gives us 95% of what prom-client would, with no extra dependency, no
 * worker thread, and no surprise behavior when the process forks.
 *
 * Memory ceiling: each named metric is a Map<labelKey, number>. To stop
 * a misbehaving caller from blowing the heap with high-cardinality label
 * values (e.g. user-supplied phone numbers), every counter caps at
 * MAX_LABEL_CARDINALITY series — once exceeded, further unique label
 * combinations bucket into `__overflow__`. The cap is per-metric so a
 * single bad actor can't starve the others.
 *
 * Process model: single registry per process. Reset via clearAll() in
 * tests; never reset in prod. Counters are monotonic since boot — that's
 * what Prometheus expects (it computes rates by diffing scrapes).
 */

const MAX_LABEL_CARDINALITY = 1000;

type LabelMap = Record<string, string>;

function labelKey(labels: LabelMap | undefined): string {
  if (!labels) return '';
  // Stable serialization — object key order matters for the map key, so
  // sort to make {a,b} and {b,a} equal.
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join('\x00');
}

function escapeLabelValue(v: string): string {
  // Prometheus label-value escaping: backslash, doublequote, newline.
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function renderLabels(labels: LabelMap | undefined): string {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return '{' + keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(',') + '}';
}

interface MetricBase {
  name: string;
  help: string;
  type: 'counter' | 'histogram';
}

class Counter implements MetricBase {
  type = 'counter' as const;
  private series = new Map<string, { labels: LabelMap; value: number }>();
  private overflowed = false;

  constructor(
    public name: string,
    public help: string
  ) {}

  inc(labels?: LabelMap, by = 1): void {
    const key = labelKey(labels);
    const existing = this.series.get(key);
    if (existing) {
      existing.value += by;
      return;
    }
    if (this.series.size >= MAX_LABEL_CARDINALITY) {
      this.overflowed = true;
      const overflow = this.series.get('__overflow__') ?? {
        labels: { overflow: 'true' },
        value: 0,
      };
      overflow.value += by;
      this.series.set('__overflow__', overflow);
      return;
    }
    this.series.set(key, { labels: labels ?? {}, value: by });
  }

  expose(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} counter`);
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    if (this.overflowed) {
      lines.push(
        `# NOTE ${this.name} hit MAX_LABEL_CARDINALITY=${MAX_LABEL_CARDINALITY}; further series collapsed into overflow="true"`
      );
    }
    return lines.join('\n');
  }

  // Test-only: snapshot of the current series. Don't use in prod code.
  snapshot(): Array<{ labels: LabelMap; value: number }> {
    return Array.from(this.series.values()).map((s) => ({
      labels: { ...s.labels },
      value: s.value,
    }));
  }

  reset(): void {
    this.series.clear();
    this.overflowed = false;
  }
}

class Histogram implements MetricBase {
  type = 'histogram' as const;
  private series = new Map<
    string,
    { labels: LabelMap; bucketCounts: number[]; sum: number; count: number }
  >();
  private overflowed = false;

  constructor(
    public name: string,
    public help: string,
    public buckets: number[]
  ) {
    // Validate buckets are sorted ascending.
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i] <= buckets[i - 1]) {
        throw new Error(`Histogram ${name} buckets must be strictly ascending`);
      }
    }
  }

  observe(value: number, labels?: LabelMap): void {
    const key = labelKey(labels);
    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= MAX_LABEL_CARDINALITY) {
        this.overflowed = true;
        const overflowKey = labelKey({ overflow: 'true' });
        entry = this.series.get(overflowKey);
        if (!entry) {
          entry = {
            labels: { overflow: 'true' },
            bucketCounts: new Array(this.buckets.length).fill(0),
            sum: 0,
            count: 0,
          };
          this.series.set(overflowKey, entry);
        }
      } else {
        entry = {
          labels: labels ?? {},
          bucketCounts: new Array(this.buckets.length).fill(0),
          sum: 0,
          count: 0,
        };
        this.series.set(key, entry);
      }
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) entry.bucketCounts[i]++;
    }
    entry.sum += value;
    entry.count++;
  }

  expose(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} histogram`);
    for (const entry of this.series.values()) {
      // Per-bucket _bucket lines + +Inf
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative = entry.bucketCounts[i];
        const bucketLabels = { ...entry.labels, le: String(this.buckets[i]) };
        lines.push(`${this.name}_bucket${renderLabels(bucketLabels)} ${cumulative}`);
      }
      const infLabels = { ...entry.labels, le: '+Inf' };
      lines.push(`${this.name}_bucket${renderLabels(infLabels)} ${entry.count}`);
      lines.push(`${this.name}_sum${renderLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${renderLabels(entry.labels)} ${entry.count}`);
    }
    if (this.overflowed) {
      lines.push(`# NOTE ${this.name} hit MAX_LABEL_CARDINALITY=${MAX_LABEL_CARDINALITY}`);
    }
    return lines.join('\n');
  }

  snapshot(): Array<{ labels: LabelMap; sum: number; count: number; bucketCounts: number[] }> {
    return Array.from(this.series.values()).map((s) => ({
      labels: { ...s.labels },
      sum: s.sum,
      count: s.count,
      bucketCounts: [...s.bucketCounts],
    }));
  }

  reset(): void {
    this.series.clear();
    this.overflowed = false;
  }
}

class MetricsRegistry {
  private metrics = new Map<string, Counter | Histogram>();

  counter(name: string, help: string): Counter {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== 'counter') {
        throw new Error(`Metric ${name} already registered as ${existing.type}`);
      }
      return existing;
    }
    const c = new Counter(name, help);
    this.metrics.set(name, c);
    return c;
  }

  histogram(name: string, help: string, buckets: number[]): Histogram {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.type !== 'histogram') {
        throw new Error(`Metric ${name} already registered as ${existing.type}`);
      }
      return existing;
    }
    const h = new Histogram(name, help, buckets);
    this.metrics.set(name, h);
    return h;
  }

  /** Prometheus text-format exposition for all registered metrics. */
  expose(): string {
    const sections: string[] = [];
    // Sort by name for stable output (helpful in tests + diffs).
    const names = Array.from(this.metrics.keys()).sort();
    for (const name of names) {
      sections.push(this.metrics.get(name)!.expose());
    }
    return sections.join('\n\n') + '\n';
  }

  // Test-only — clears every counter+histogram series. Never call in prod.
  clearAll(): void {
    for (const m of this.metrics.values()) m.reset();
  }
}

// Singleton — one registry per process. Tests reset via clearAll().
export const registry = new MetricsRegistry();

// ─────────────────────────────────────────────────────────────────────
// Pre-declared metrics — the call sites below import these directly so
// names + help strings live in one place. Adding a new metric? Add it
// here so it's discoverable in code review and the /metrics output.
// ─────────────────────────────────────────────────────────────────────

// HTTP request count by route + method + status family. Emitted by the
// Fastify onResponse hook in src/index.ts.
export const httpRequestsTotal = registry.counter(
  'http_requests_total',
  'HTTP requests received, partitioned by route + method + status family'
);

// HTTP latency histogram. Buckets cover the realistic range for this
// service: most routes <100ms, booking RPC sometimes hits the 500ms
// p99, anything above 2s is a problem worth alerting on.
export const httpRequestDurationMs = registry.histogram(
  'http_request_duration_ms',
  'HTTP request duration in milliseconds, by route + method + status family',
  [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
);

// Booking outcomes — what happens when an operator (or the agent) tries
// to book. The dashboard's "booking success rate" graph reads this.
export const bookingAttemptsTotal = registry.counter(
  'booking_attempts_total',
  'Booking attempts, partitioned by outcome (success, timeslot_occupied, employee_not_scheduled, no_skilled_employee, no_availability, validation_error, other_error) and source (api, agent)'
);

// Tool-call outcomes per tool. Powers the agent reliability dashboard —
// "what fraction of customer-context calls returned success last hour."
export const toolCallsTotal = registry.counter(
  'tool_calls_total',
  'Agent tool calls, partitioned by tool name and outcome (success, error, validation_error)'
);

// Sync dispatch counts — proves the orchestrator is firing in prod the
// way the e2e tests verify it does in dev. Compared against successful
// appointment + customer mutations to flag silent dispatch failures.
export const syncDispatchesTotal = registry.counter(
  'sync_dispatches_total',
  'Sync orchestrator dispatches, partitioned by provider + entity + action'
);

// Generic error counter, keyed by the `event` arg passed to logError().
// Pair with errors_total{event="provisioning_failed"} alerts in Better
// Stack / Grafana — much higher signal than scraping log lines.
export const errorsTotal = registry.counter(
  'errors_total',
  'Errors logged via logError(), partitioned by event name'
);

// Calls that ended with NO CALLER SPEECH at all.
//
// Named for the condition it actually tests, not the story it was written for.
// The first draft called it greeting_only_hangups_total — and batch F then put
// the runtime's own check-in and goodbye into the transcript, so a "greeting
// only" call reliably holds THREE assistant lines and the name became false the
// same day it shipped (review catch on #314). What the number is for is
// unchanged: how often does a caller hang up without ever speaking.
//
// SEPARATE from errors_total{no_caller_audio} on purpose. That one means the
// inbound audio path is broken (codec/RTP) and deliberately ignores calls under
// 20 seconds, because a short hang-up is the ordinary explanation. This one
// counts the hang-ups themselves, bucketed either side of that line: four such
// calls landed in a single afternoon (CALL_IMPROVEMENTS.md #4, #5, #6, #11) and
// nobody could say whether that was a long greeting, a surprised caller, or a
// bad day — because nothing counted them. Measure first, then decide whether the
// greeting needs shortening; a rate that climbs after a greeting change is the
// only honest way to know it made things worse.
export const silentHangupsTotal = registry.counter(
  'silent_hangups_total',
  'Calls that ended with no caller speech at all, bucketed under/over the silent-call threshold'
);

// Reminder delivery outcomes per reminder TYPE. Closes TODO.md Phase 5
// "Monitoring dashboard for reminder delivery rates." A regression that
// silently breaks the SMS provider or Gmail SMTP shows up here as
// outcome="failure" climbing while outcome="success" flattens — long
// before a customer reports a missed appointment. Plot
// `rate(reminders_sent_total{outcome="success"}[5m]) /
//  rate(reminders_sent_total[5m])` as the overall success rate, and add
// `by (type)` to split it. NOT `by (channel)` — see the note below; that
// label has never been emitted by anything running in production, and this
// comment said "per channel" right up until the code that would have emitted
// it was deleted.
export const remindersSentTotal = registry.counter(
  'reminders_sent_total',
  // Labels are `type` and `outcome`. This description said `channel` (email,
  // sms) for months — a shape ONLY the parallel reminder implementation ever
  // emitted, and that code was never wired to anything and is now deleted. The
  // live ReminderService partitions by reminder TYPE (confirmation, 72h, 24h,
  // 2h, custom), because a single reminder can go out on both channels at once
  // and `anyChannelSucceeded` collapses them to one outcome. Any dashboard or
  // alert filtering on `channel` matched nothing.
  'Reminder delivery attempts, partitioned by type (confirmation, 72h, 24h, 2h, custom, unknown) and outcome (success, failure)'
);

// Reminders that did NOT make it to a delivery attempt — appointment
// vanished / cancelled / time passed / no consent recorded. High volume
// in any single reason bucket is a UX signal (e.g. consent dropping off
// means callers aren't being asked to opt in correctly).
export const remindersSkippedTotal = registry.counter(
  'reminders_skipped_total',
  // Reasons corrected to what the LIVE path actually emits. `processing_error`
  // was never emitted by it (a processing failure is rethrown so the worker can
  // classify retry-vs-fail, and lands in errors_total instead), and
  // `appointment_passed` was emitted but undocumented.
  'Reminders that skipped delivery, partitioned by reason (appointment_not_found, appointment_cancelled, appointment_passed, no_consent, sms_disabled)'
);

// the SMS provider SMS delivery receipts — the *carrier-confirmed* outcome, distinct
// from reminders_sent_total (which counts send ATTEMPTS, i.e. "the SMS provider
// accepted the request"). This counter increments when the SMS provider's
// statusCallback fires; status is a bounded enum
// (queued|sending|sent|delivered|undelivered|failed|received) so label
// cardinality is safe. A reminder can be sent (success) yet later land here
// as status="undelivered" — that gap is exactly the transient flake this
// feature was built to surface. Plot
// `rate(message_delivery_receipts_total{status="delivered"}[5m]) /
//  rate(message_delivery_receipts_total[5m])` for true delivery rate.
export const messageDeliveryReceiptsTotal = registry.counter(
  'message_delivery_receipts_total',
  'the SMS provider SMS delivery-status callbacks received, partitioned by status (queued|sending|sent|delivered|undelivered|failed|received)'
);

// Inbound SMS (customer → us) on POST /communications/telnyx/inbound, by outcome:
//   opted_out        — a STOP/UNSUBSCRIBE was honored
//   opted_in         — a START/UNSTOP resumed messaging
//   ignored          — a message we take no action on (phase 1 handles keywords only)
//   unknown_tenant   — the `to` number matched no tenant's inbound_phone
//   rejected         — FAILED SIGNATURE, i.e. a forged/unsigned POST
//
// Watch `rejected`: in normal operation it should be ~0, because only Telnyx can
// sign a payload. A sustained nonzero rate means someone is POSTing directly at
// the endpoint — which is precisely the attack this route's signature check
// exists to stop, and the only way you'd ever find out it was happening.
export const inboundSmsTotal = registry.counter(
  'inbound_sms_total',
  'inbound SMS webhook deliveries, partitioned by outcome (opted_out|opted_in|ignored|unknown_tenant|rejected)'
);

// Every SMS send ATTEMPT at the service layer — the single chokepoint that
// `reminders_sent_total` does not cover. That counter lives in the reminder
// worker, so before 2026-07-09 the agent's booking-confirmation SMS
// (agentTools.ts), POST /communications/sms, and every sendSystemSMS opt-out
// confirmation had NO metric at all: a failure wrote a `status='failed'` row
// (or, for sendSystemSMS, nothing) and a raw console.error that reached no sink.
//
// That blind spot is exactly how a dead `TELNYX_PHONE_NUMBER` (+16308661960,
// order deleted) sent every fallback-tenant confirmation into a provider
// rejection for weeks without anyone noticing. Plot
// `rate(sms_sends_total{outcome="failed"}[5m]) / rate(sms_sends_total[5m])`
// and alert above a few percent — a bad `from` number pins it to 1.0 instantly.
//
// Distinct from message_delivery_receipts_total (carrier-confirmed outcome) and
// from reminders_sent_total (per-reminder-TYPE outcome, one layer up). This one
// answers "did the provider accept the request?"
export const smsSendsTotal = registry.counter(
  'sms_sends_total',
  'SMS send attempts at the service layer, partitioned by provider and outcome (sent, failed, rate_limited)'
);

// ─────────────────────────────────────────────────────────────────────
// T-006 (2026-09-03) — the four series the monitoring task named that the
// registry did not have. Everything below is emitted from a REAL call site;
// a declared-but-never-incremented metric is worse than a missing one,
// because a flat line reads as "healthy" rather than "not measured".
// ─────────────────────────────────────────────────────────────────────

// Every call the agent opens a voice session for. The denominator for
// every per-call rate on the dashboard — without it, `call_outcome_total`
// answers "what happened" but never "out of how many", and a total outage
// (zero calls arriving) looks identical to a quiet hour.
export const callsTotal = registry.counter(
  'calls_total',
  'Voice sessions started, partitioned by source (phone, browser, unknown)'
);

// What the call ENDED as, straight from the agent's own outcome tracker.
// Cardinality is safe: `outcome` is a short bounded vocabulary the agent
// writes (booked, transferred, message, price, no_availability, …) and
// anything absent lands in `unknown` rather than inventing a series.
export const callOutcomeTotal = registry.counter(
  'call_outcome_total',
  'Voice sessions finalized, partitioned by outcome (booked, transferred, message, price, no_availability, unknown, …)'
);

// Time from the caller's turn ending to the first real agent audio, in ms.
// The agent measures it (only the agent can — the backend never sees a
// turn) and ships the per-call samples on voice-session-end; this is where
// they become a scrapeable distribution.
//
// Buckets are chosen around the number that matters: 2500ms is where the
// hold line fires, 3000ms is the p95 alert threshold in docs/ALERTS.md. A
// bucket edge below both makes "we crossed the line" visible instead of
// interpolated.
export const turnLatencyMs = registry.histogram(
  'turn_latency_ms',
  'Agent turn latency in milliseconds — caller turn end to first real agent audio',
  [250, 500, 1000, 1500, 2000, 2500, 3000, 4000, 6000, 10000]
);

// Webhook deliveries REJECTED for a bad/missing signature. In normal
// operation this is flat zero — only Stripe can sign a Stripe payload and
// only Telnyx can sign a Telnyx one — so ANY sustained rate means someone
// is POSTing at the endpoint directly, or a secret rotated on one side
// only. Both are pages, and the two causes are told apart by whether real
// traffic on the same endpoint kept flowing.
//
// Overlaps `inbound_sms_total{outcome="rejected"}` on one endpoint on
// purpose: that counter is about SMS handling, this one is about signature
// integrity across EVERY webhook, so an alert does not need to know which
// provider exists this quarter.
export const webhookSignatureFailuresTotal = registry.counter(
  'webhook_signature_failures_total',
  'Webhook deliveries rejected for an invalid or missing signature, partitioned by provider and endpoint'
);
