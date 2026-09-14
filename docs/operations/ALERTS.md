# Alerting — SecretaryHQ

> **Status 2026-07-09:** **no hosted monitoring destination is planned.** Paid vendors (Sentry, Better Stack) were declined 2026-07-02, and a search for a genuinely free-forever alternative came up empty: **UptimeRobot's free plan has prohibited commercial / revenue-generating use since 2024-12-01**, Grafana Cloud free doesn't expire but is capped (10K active series, 14-day retention, then $6.50/1K), and Healthchecks.io free does heartbeats, not metric thresholds. Every "free forever" tier is free-_within-limits the vendor can move_.
>
> This file **stays** as a collector-agnostic PromQL reference — it costs nothing to keep, matches the live registry exactly, and is paste-and-go if a destination is ever chosen. The metrics themselves are already live and free at `GET /metrics` (Bearer `METRICS_TOKEN`) and `GET /ready`.
>
> If you want the one alert that matters without any vendor — "SMS failure ratio crossed 20%", the signal that would have caught the dead `TELNYX_PHONE_NUMBER` on day one — that is now `.github/workflows/zero-vendor-alerts.yml` (every 30m, opens a GitHub issue). Set repo secret `METRICS_TOKEN`.

Ready-to-apply alert rules for the production backend + agent. The **"Alert rules"
item was dropped from `docs/planning/TODO.md` P2 on 2026-07-09** (no vendor met the
free-forever bar); these rules remain as reference. The metric names, label keys, and
label _values_ below match the live registry in `src/services/metrics.ts`
exactly — paste them as written.

**Incident response for each alert lives in `docs/operations/RUNBOOK.md`.** An alert tells
you _something broke_; the runbook tells you _what to do_. Each rule links its
runbook section.

---

## 0. Status of prerequisites (as of 2026-06-29)

| Prereq                                             | State                       | Note                                                                                                                                    |
| -------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `METRICS_TOKEN` on Railway backend                 | **SET** ✅                  | Verified live: `GET /metrics` returns `401` (not `404`), i.e. the token gate is active. Scrapes work once a collector sends the Bearer. |
| Prometheus / metrics collector scraping `/metrics` | **NOT wired — by decision** | No scraper is hitting prod, and none is planned (see status note above). `/metrics` is live and free; §2 is here if that ever changes.  |
| `BETTER_STACK_TOKEN` on backend + agent            | **NOT set**                 | Until set, logs are stdout-only (Railway live-tail). Better Stack also offers **log-pattern alerts** (§4) as a no-scraper fallback.     |
| `SENTRY_DSN` on backend + agent                    | **NOT set**                 | Sentry covers _exceptions/error grouping_, complementary to the metric alerts here.                                                     |

So today: the metric **data exists and is exposed**; you need either (a) a
Prometheus scrape + alertmanager, or (b) Better Stack log alerts, to
turn it into pages. §2 and §4 cover both. §3 is the rule catalog (collector-agnostic PromQL).

---

## 1. What emits metrics

- **Endpoint:** `GET /metrics` on the backend (`https://secretary-hq-production.up.railway.app/metrics`).
- **Auth:** `Authorization: Bearer $METRICS_TOKEN`. Returns `404` when the env var is unset (strict opt-in), `401` on missing/wrong Bearer, `200` + Prometheus text format when correct.
- **Format:** Prometheus exposition. Counters are monotonic since process boot (Railway restart resets them — alert on `rate()`, never absolute values).
- **Skip list:** `/health`, `/ready`, `/metrics` are excluded from HTTP metrics (no recursive-scrape contamination).
- **Cardinality guard:** hard cap 1000 series/metric; `status` is collapsed to a family (`2xx`/`4xx`/`5xx`), never raw codes.

### Live series (exact names + labels)

| Metric                             | Type      | Labels                         | Label values                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | --------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http_requests_total`              | counter   | `route`, `method`, `status`    | `status` ∈ `2xx`/`4xx`/`5xx`                                                                                                                                                                                                                                                                                                                                                |
| `http_request_duration_ms`         | histogram | `route`, `method`, `status`    | buckets: 10,25,50,100,250,500,1000,2500,5000,10000 ms                                                                                                                                                                                                                                                                                                                       |
| `booking_attempts_total`           | counter   | `outcome`, `source`            | `outcome` ∈ success, timeslot_occupied, employee_not_scheduled, no_skilled_employee, no_availability, validation_error, other_error · `source` ∈ api, agent                                                                                                                                                                                                                 |
| `tool_calls_total`                 | counter   | `tool`, `outcome`              | `outcome` ∈ success, error, validation_error                                                                                                                                                                                                                                                                                                                                |
| `sync_dispatches_total`            | counter   | `provider`, `entity`, `action` | —                                                                                                                                                                                                                                                                                                                                                                           |
| `errors_total`                     | counter   | `event`                        | the `event` arg passed to `logError()` (e.g. `voice_session_reaped`, `provisioning_failed`, `unhandled_route_error`)                                                                                                                                                                                                                                                        |
| `reminders_sent_total`             | counter   | `type`, `outcome`              | `type` ∈ confirmation, 72h, 24h, 2h, custom, unknown · `outcome` ∈ success, failure. **Corrected 2026-08-20** — this row said `channel` (email, sms), a shape only the never-wired parallel implementation emitted; any query filtering on `channel` matched nothing. A reminder can go out on both channels at once and is collapsed to ONE outcome.                       |
| `reminders_skipped_total`          | counter   | `reason`                       | appointment_not_found, appointment_cancelled, appointment_passed, no_consent. **Corrected 2026-08-20** — `processing_error` is never emitted (a processing failure is rethrown so the worker can classify retry-vs-fail, and lands in `errors_total`); `appointment_passed` was emitted but undocumented; `appointment_not_found` was documented but not emitted until now. |
| `sms_sends_total`                  | counter   | `provider`, `outcome`          | `provider` ∈ telnyx, mock · `outcome` ∈ sent, failed, rate_limited                                                                                                                                                                                                                                                                                                          |
| `message_delivery_receipts_total`  | counter   | `status`                       | queued, sending, sent, delivered, undelivered, failed, received                                                                                                                                                                                                                                                                                                             |
| `calls_total`                      | counter   | `source`                       | `source` ∈ phone, browser. **Added 2026-09-03 (T-006).** Incremented on `voice-session-start` BEFORE the DB write, so a database outage cannot silence the denominator and make an outage look like a quiet hour. `browser` is the caller-simulator (a call id of `room:<roomName>`, i.e. a dispatch with no SIP participant).                                              |
| `call_outcome_total`               | counter   | `outcome`                      | booked, transferred, message, price, no_availability, unknown, … (whatever the agent's outcome tracker sends; absent → `unknown`). **Added 2026-09-03 (T-006).** Counted only when `end_voice_session` returns `ended:true` — the agent posts voice-session-end TWICE per call (finalize + enrich) and that flag is the only thing preventing double-counting.              |
| `turn_latency_ms`                  | histogram | —                              | buckets: 250,500,1000,1500,2000,2500,3000,4000,6000,10000 ms. **Added 2026-09-03 (T-006).** Caller turn end → first real agent audio. Measured in the AGENT (the backend never sees a turn) and shipped as per-call samples on `voice-session-end`, capped at 100/call.                                                                                                     |
| `webhook_signature_failures_total` | counter   | `provider`, `endpoint`         | `provider` ∈ stripe, telnyx · `endpoint` ∈ billing_webhook, status_callback, inbound_sms. **Added 2026-09-03 (T-006).** A missing signature counts the same as a bad one.                                                                                                                                                                                                   |

> Histograms expose `_bucket{le=…}`, `_count`, and `_sum` suffixes — the
> `histogram_quantile()` rules below depend on `_bucket`.

---

## 2. Stand up a scrape (Prometheus path)

Minimal `prometheus.yml` scrape job:

```yaml
scrape_configs:
  - job_name: secretaryhq-backend
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: ${METRICS_TOKEN} # same value set on Railway
    static_configs:
      - targets: ['secretary-hq-production.up.railway.app']
    scrape_interval: 30s
```

Point Alertmanager (or any Prometheus-compatible backend) at this scrape and
load the rules in §3. The rules are collector-agnostic — nothing below assumes a
particular vendor.

> Sizing, if you ever evaluate a hosted backend: the registry declares 10 metrics,
> each hard-capped at `MAX_LABEL_CARDINALITY = 1000` (`src/services/metrics.ts:29`),
> so the absolute worst case is 10,000 active series. In practice
> `http_request_duration_ms` dominates (~29 route modules × 3 status families ×
> 12 series each) and the total lands around 2–3K. See the status note at the top
> of this file for why no vendor was chosen.

---

## 3. Alert rule catalog (PromQL)

Drop into a Prometheus rule file (`groups: [{ name: secretaryhq, rules: [...] }]`).
Thresholds are tuned for **beta volume** (low absolute traffic) — revisit once
real call volume lands. Severity: **page** = wake someone; **warn** = review next business day.

### 3.1 Error rate climbing — `page`

```yaml
- alert: ErrorRateHigh
  expr: sum(rate(errors_total[5m])) > 0.2
  for: 10m
  labels: { severity: page }
  annotations:
    summary: 'errors_total climbing ({{ $value | printf "%.2f" }}/s over 5m)'
    runbook: 'docs/operations/RUNBOOK.md — Backend down / DB pool saturation'
```

Per-event breakout (high signal — tells you _which_ failure):

```yaml
- alert: ProvisioningErrors
  expr: rate(errors_total{event="provisioning_failed"}[15m]) > 0
  for: 5m
  labels: { severity: warn }
  annotations: { runbook: 'docs/operations/RUNBOOK.md — Telephony / provisioning' }

- alert: VoiceSessionsReapedSpike
  expr: rate(errors_total{event="voice_session_reaped"}[15m]) > 0.02
  for: 15m
  labels: { severity: warn }
  annotations:
    summary: 'Voice sessions being force-finalized by the reaper — agent may not be sending voice-session-end'
    runbook: 'docs/operations/RUNBOOK.md — Agent silent'

# Volume metering soft-cap (T-009). Fail-open on cap check: under DB stress the
# COUNT can error and every start is allowed → unmetered load amplification.
# Page when the fail-open path fires repeatedly. Also watch start-log failures
# (H2 fail-soft: live call continues without a voice_sessions row).
- alert: UsageCapCheckFailedAmplification
  expr: rate(errors_total{event="usage_cap_check_failed"}[10m]) > 0.05
  for: 10m
  labels: { severity: page }
  annotations:
    summary: 'usage_cap_check_failed rate high — soft-cap fail-open may be allowing unmetered volume'
    runbook: 'docs/operations/RUNBOOK.md — Backend down / DB pool saturation'

- alert: VoiceSessionStartFailedSpike
  expr: rate(errors_total{event="voice_session_start_failed"}[15m]) > 0.05
  for: 15m
  labels: { severity: warn }
  annotations:
    summary: 'voice-session-start DB failures — calls continue unmetered (fail-soft H2)'
    runbook: 'docs/operations/RUNBOOK.md — Backend down / DB pool saturation'

- alert: UsageLimitRejections
  expr: rate(errors_total{event="call_rejected_usage_limit_exceeded"}[15m]) > 0.1
  for: 30m
  labels: { severity: warn }
  annotations:
    summary: 'Tenants hitting monthly call soft-cap — expected near plan limits; spike may mean free-tier mis-set'
```

### 3.2 HTTP 5xx rate — `page`

```yaml
- alert: Http5xxRate
  expr: |
    sum(rate(http_requests_total{status="5xx"}[5m]))
      / clamp_min(sum(rate(http_requests_total[5m])), 0.001) > 0.05
  for: 10m
  labels: { severity: page }
  annotations:
    summary: '>5% of requests are 5xx over 5m'
    runbook: 'docs/operations/RUNBOOK.md — Backend down'
```

### 3.3 p95 latency — `warn`

```yaml
- alert: LatencyP95High
  expr: |
    histogram_quantile(0.95,
      sum(rate(http_request_duration_ms_bucket[5m])) by (le)) > 2500
  for: 15m
  labels: { severity: warn }
  annotations:
    summary: 'p95 request latency >2.5s over 15m'
    runbook: 'docs/operations/RUNBOOK.md — DB pool saturation'
```

### 3.4 Booking failure rate — `page`

Booking is the revenue path. `success` vs everything-else:

```yaml
- alert: BookingFailureRate
  expr: |
    sum(rate(booking_attempts_total{outcome!="success"}[15m]))
      / clamp_min(sum(rate(booking_attempts_total[15m])), 0.001) > 0.5
  for: 15m
  labels: { severity: page }
  annotations:
    summary: '>50% of booking attempts failing over 15m'
    runbook: 'docs/operations/RUNBOOK.md — Booking failures'
```

> Note: a high `no_availability` / `employee_not_scheduled` share can be
> _legitimate_ (genuinely full calendar). If this fires noisily, exclude the
> "expected" outcomes: `outcome=~"timeslot_occupied|other_error|validation_error"`.

### 3.5 Pool saturation — `warn` (synthetic, from `/ready`)

`pool.waiting` is NOT a Prometheus metric — it's in the `/ready` JSON. Two options:

- **Blackbox/JSON probe** on `/ready`, alert when `pool.waiting > 0` sustained.
- **Better Stack heartbeat** monitor on `/ready` expecting `200` + `"db":"ok"`.

```yaml
# If you expose /ready via a json_exporter mapping pool.waiting -> ready_pool_waiting:
- alert: DbPoolWaiting
  expr: ready_pool_waiting > 0
  for: 5m
  labels: { severity: warn }
  annotations:
    summary: 'DB pool has waiting checkouts — approaching max=10 saturation'
    runbook: 'docs/operations/RUNBOOK.md — DB pool saturation'
```

### 3.6 Reminder delivery regression — `warn`

```yaml
- alert: ReminderDeliveryFailing
  expr: |
    sum(rate(reminders_sent_total{outcome="failure"}[30m]))
      / clamp_min(sum(rate(reminders_sent_total[30m])), 0.001) > 0.2
  for: 30m
  labels: { severity: warn }
  annotations:
    summary: '>20% of reminder sends failing — check SMS/email provider creds'
    runbook: 'docs/operations/RUNBOOK.md — Reminders not sending'

- alert: RemindersSkippedNoConsent
  expr: rate(reminders_skipped_total{reason="no_consent"}[1h]) > 0.05
  for: 1h
  labels: { severity: warn }
  annotations:
    summary: 'Reminders skipping for no_consent — callers may not be getting the opt-in prompt'
```

### 3.7 Agent tool error rate — `warn`

```yaml
- alert: ToolCallErrorRate
  expr: |
    sum(rate(tool_calls_total{outcome="error"}[15m])) by (tool)
      / clamp_min(sum(rate(tool_calls_total[15m])) by (tool), 0.001) > 0.3
  for: 15m
  labels: { severity: warn }
  annotations:
    summary: 'Agent tool {{ $labels.tool }} erroring >30% over 15m'
    runbook: 'docs/operations/RUNBOOK.md — Agent silent'
```

### 3.8 No traffic at all — `page` (deploy/outage canary)

Backend up but serving nothing for 15m during the day usually means a broken
deploy or DNS/routing issue:

```yaml
- alert: NoHttpTraffic
  expr: sum(rate(http_requests_total[10m])) == 0
  for: 15m
  labels: { severity: page }
  annotations: { summary: 'Zero HTTP requests for 15m — routing/deploy outage?' }
```

### 3.9 SMS send failures — `page`

Every SMS send attempt at the service layer. `reminders_sent_total` covers only
the reminder worker; this counter also sees the agent's booking confirmations,
`POST /communications/sms`, and opt-out confirmations.

A **dead or unowned `from` number pins this to 1.0 immediately** — that is the
exact failure that ran unnoticed in prod until 2026-07-09 (`TELNYX_PHONE_NUMBER`
held a deleted Telnyx order). `rate_limited` is excluded from the numerator: 429s
are expected under burst and are retried by the worker, not incidents.

```yaml
- alert: SmsSendFailureRate
  expr: |
    sum(rate(sms_sends_total{outcome="failed"}[15m]))
      / clamp_min(sum(rate(sms_sends_total{outcome=~"sent|failed"}[15m])), 0.001) > 0.2
  for: 10m
  labels: { severity: page }
  annotations:
    summary: '>20% of SMS sends failing over 15m — check TELNYX_PHONE_NUMBER is still owned'
    runbook: 'docs/operations/RUNBOOK.md — SMS delivery failures'
```

Earlier warn tier (added 2026-09-03, T-006). 20% is where a `from` number is
dead; **5% is where something is wrong and nobody has noticed yet** — a single
bad recipient format, one carrier rejecting, a partial rate-limit. It warns
rather than pages precisely so it can sit at a threshold a page could not:

```yaml
- alert: SmsSendFailureRateElevated
  expr: |
    sum(rate(sms_sends_total{outcome="failed"}[30m]))
      / clamp_min(sum(rate(sms_sends_total{outcome=~"sent|failed"}[30m])), 0.001) > 0.05
  for: 15m
  labels: { severity: warn }
  annotations:
    summary: '>5% of SMS sends failing over 30m — check for a single bad recipient or a carrier rejecting'
    runbook: 'docs/operations/RUNBOOK.md — SMS delivery failures'
```

Cheaper companion that needs no ratio — any failed opt-out confirmation is a
compliance event, because that path persists no `communications_history` row:

```yaml
- alert: SystemSmsSendFailed
  expr: rate(errors_total{event="system_sms_send_failed"}[15m]) > 0
  for: 5m
  labels: { severity: page }
  annotations:
    summary: 'An opt-out confirmation SMS failed — TCPA exposure, no DB record exists'
    runbook: 'docs/operations/RUNBOOK.md — SMS delivery failures'
```

### 3.10 Reminder batch failing — `page`

**The rule that would have caught the 13-day reminder outage.** On 2026-08-06 the
worker's atomic claim started writing a `status` the CHECK constraint rejected;
every 60s tick threw, the exception bumped `errors_total{event="reminder_batch_failed"}`,
and nobody was looking. `/health` stayed green and zero reminders were sent for
thirteen days. The counter existed the whole time — what was missing was this.

The worker ticks every 60s, so a genuine fault produces ~10 failures per 10
minutes. The threshold sits above transient blips and far below a total outage.

```yaml
- alert: ReminderBatchFailing
  expr: increase(errors_total{event="reminder_batch_failed"}[10m]) > 3
  for: 0m
  labels: { severity: page }
  annotations:
    summary: 'Reminder batch failing repeatedly — no reminders or confirmations are going out'
    runbook: 'docs/operations/RUNBOOK.md — reminder pipeline'
```

Pair it with a silence check: a worker that stops throwing because it stopped
running produces no failures either. See §3.8's no-traffic canary shape.

---

### 3.11 Webhook signature failures — `page`

In normal operation this is **flat zero**: only Stripe can sign a Stripe payload
and only Telnyx can sign a Telnyx one. Any sustained rate means either someone is
POSTing at the endpoint directly, or a secret was rotated on one side only. Both
need a human the same hour — the second one silently drops real traffic.

```yaml
- alert: WebhookSignatureFailures
  expr: increase(webhook_signature_failures_total[1h]) > 0
  for: 0m
  labels: { severity: page }
  annotations:
    summary: 'Webhook signature verification failing on {{ $labels.provider }}/{{ $labels.endpoint }} — forged traffic or a half-rotated secret'
    runbook: 'docs/operations/RUNBOOK.md — webhook verification'
```

Tell the two causes apart by whether legitimate traffic on the SAME endpoint kept
flowing (`http_requests_total{route="/billing/webhook",status="2xx"}`). Still
flowing → forgery attempts. Stopped → the secret is the problem.

---

### 3.12 Turn latency p95 — `warn`

Dead air is the failure callers actually hang up on, and it is invisible in every
other series: the call completes, the outcome is recorded, and the transcript
reads fine. 3000 ms is the line — the hold line fires at 2500 ms, so a p95 above
3000 means the filler has become the normal case rather than a backstop.

```yaml
- alert: TurnLatencyP95
  expr: |
    histogram_quantile(0.95, sum(rate(turn_latency_ms_bucket[15m])) by (le)) > 3000
  for: 10m
  labels: { severity: warn }
  annotations:
    summary: 'p95 agent turn latency above 3s over 15m — callers are sitting in silence'
    runbook: 'docs/operations/RUNBOOK.md — voice latency'
```

**Read the buckets, not just the quantile, before acting.** The 2026-08-15 case
looked like slow TTS and was one DNS lookup taking 11 seconds (`dnsWarm.ts`).
A latency alert says _where the caller waited_, never _why_.

---

---

## 4. No-scraper fallback — Better Stack log alerts

If you don't want to run Prometheus yet, set `BETTER_STACK_TOKEN` on the backend

- agent and alert on **log patterns** instead. Every `logError()` emits a JSON
  line with an `event` field, so Better Stack queries map 1:1 to the counters:

| Better Stack log query                         | Equivalent to                 |
| ---------------------------------------------- | ----------------------------- |
| `event:"unhandled_route_error"` count > N / 5m | §3.1 ErrorRateHigh            |
| `event:"provisioning_failed"` any              | §3.1 ProvisioningErrors       |
| `event:"voice_session_reaped"` rising          | §3.1 VoiceSessionsReapedSpike |
| `level:50` (Pino error) rate                   | broad error-rate page         |
| `event:"stripe_webhook_signature_failed"` any  | Stripe webhook misconfig      |

Plus a **Better Stack heartbeat monitor** hitting `GET /ready` every 60s,
expecting `200` + body `"status":"ready"` — covers backend-down + DB-down +
(via JSON match) pool saturation, with no Prometheus at all. This is the fastest
path to _some_ paging today.

---

## 5. Routing

Route **page** severity to a channel Dale actually watches (phone push /
SMS / PagerDuty-free option: Better Stack → phone call). Route **warn** to email
or a Slack/Discord channel reviewed daily. Don't send everything to one firehose
— alert fatigue silences the pages that matter.

---

## 6. Apply checklist

- [ ] `METRICS_TOKEN` set on Railway backend — **DONE** (verified 2026-06-29).
- [ ] _(No destination planned — see the status note at the top.)_ If one is ever chosen: stand up a scraper per §2, **or** set `BETTER_STACK_TOKEN` + use §4 log alerts. For the single high-value signal without any vendor, see the zero-vendor GitHub Actions option in `docs/planning/TODO.md` P2.
- [ ] Load the §3 rules (or §4 log queries).
- [ ] Configure §5 routing to a watched channel.
- [ ] Fire a test alert (e.g. temporarily lower a threshold) → confirm it reaches your phone → restore.
- [ ] _(Only if a paid/free vendor path is ever chosen — declined 2026-07-02.)_ Set `BETTER_STACK_TOKEN` + `SENTRY_DSN` on backend **and** agent for full log + exception coverage.

When this checklist is green, mark the **"Alert rules"** P0 item done in `docs/planning/TODO.md`.
