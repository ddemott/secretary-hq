/**
 * Feature-readiness report — the single source of truth for "which optional
 * capability is actually live in this process, and why not".
 *
 * Every capability below is derived from the SAME env-var conditions the
 * startup warnings (envWarnings.ts) have always tested — the warning strings
 * now live here, attached to the capability they describe, and
 * collectStartupWarnings() is a thin flatMap over these evaluations. One
 * condition, two consumers: the boot WARNING lines and the structured
 * readiness report (logged once at startup + served at
 * GET /admin/feature-readiness, super-admin only).
 *
 * Statuses:
 *   ready          — fully configured, real side effects will happen
 *   mocked         — code path runs but a mock/simulation adapter swallows it
 *   disabled       — feature is switched off entirely (routes 404/503/no-op)
 *   missing_config — feature runs but with a broken/unsafe default
 */

export type FeatureStatus = 'ready' | 'mocked' | 'disabled' | 'missing_config';

export interface FeatureReadinessRow {
  feature: string;
  status: FeatureStatus;
  detail: string;
}

/**
 * Context shape shared with envWarnings.ts (its EnvWarningContext is an
 * alias of this). TELNYX_* are passed pre-resolved because index.ts computes
 * defaults for them before calling us.
 */
export interface FeatureReadinessContext {
  env: NodeJS.ProcessEnv;
  /** Resolved values the caller already computed (defaults applied). */
  TELNYX_API_KEY: string;
  TELNYX_SIP_CONNECTION_ID: string;
}

/** A readiness row plus the legacy startup-warning strings it contributes. */
export interface CapabilityEvaluation extends FeatureReadinessRow {
  warnings: string[];
}

/**
 * Evaluate every capability once. Order matters only for the derived startup
 * warnings — it preserves the historical envWarnings.ts emission order so
 * the pinned warning tests stay byte-identical.
 */
export function evaluateCapabilities(ctx: FeatureReadinessContext): CapabilityEvaluation[] {
  const { env, TELNYX_API_KEY, TELNYX_SIP_CONNECTION_ID } = ctx;
  const evaluations: CapabilityEvaluation[] = [];

  // ── sms_provider (Telnyx) ────────────────────────────────────────────
  // Condition mirrors ProviderRegistry: no TELNYX_API_KEY → MockAdapter.
  {
    const warnings: string[] = [];
    if (!TELNYX_API_KEY) {
      warnings.push(
        'TELNYX_API_KEY not set — phone provisioning and SMS OTP disabled (voice calls with blocked caller-ID cannot complete bookings)'
      );
    }
    if (TELNYX_API_KEY && !TELNYX_SIP_CONNECTION_ID) {
      warnings.push(
        'TELNYX_SIP_CONNECTION_ID not set — phone provisioning will return 503 (purchased numbers cannot be routed to LiveKit)'
      );
    }
    if (TELNYX_API_KEY && !env.TELNYX_PHONE_NUMBER) {
      warnings.push(
        'TELNYX_PHONE_NUMBER not set — reminder and notification SMS will be sent without a valid from number (messages will fail or be undeliverable)'
      );
    }
    let status: FeatureStatus = 'ready';
    let detail = 'Telnyx SMS + provisioning configured';
    if (!TELNYX_API_KEY) {
      status = 'mocked';
      detail = 'TELNYX_API_KEY not set — SMS routed to MockAdapter; provisioning + OTP disabled';
    } else if (!TELNYX_SIP_CONNECTION_ID) {
      status = 'missing_config';
      detail = 'TELNYX_SIP_CONNECTION_ID not set — provisioning returns 503';
    } else if (!env.TELNYX_PHONE_NUMBER) {
      status = 'missing_config';
      detail = 'TELNYX_PHONE_NUMBER not set — SMS sends without a valid from number';
    }
    evaluations.push({ feature: 'sms_provider', status, detail, warnings });
  }

  // ── email ────────────────────────────────────────────────────────────
  // Condition mirrors emailService/systemEmail: no creds → simulation mode.
  {
    const missing = !env.EMAIL_USER || !env.EMAIL_PASS;
    evaluations.push({
      feature: 'email',
      status: missing ? 'mocked' : 'ready',
      detail: missing
        ? 'EMAIL_USER / EMAIL_PASS not set — email runs in simulation mode, never delivers'
        : 'SMTP credentials configured',
      warnings: missing
        ? [
            'EMAIL_USER / EMAIL_PASS not set — email notifications are running in mock mode and will never deliver',
          ]
        : [],
    });
  }

  // ── stripe_billing ───────────────────────────────────────────────────
  {
    const fixtureRequested = env.STRIPE_FIXTURE_MODE === 'true';
    const fixtureLive = fixtureRequested && env.NODE_ENV !== 'production';
    const missingKey = !env.STRIPE_SECRET_KEY;
    const missingPrice =
      !env.STRIPE_SOLO_PRICE_ID || !env.STRIPE_GROWTH_PRICE_ID || !env.STRIPE_PRO_PRICE_ID;
    const warnings: string[] = [];
    let status: FeatureStatus;
    let detail: string;
    if (fixtureLive) {
      status = 'mocked';
      detail =
        'STRIPE_FIXTURE_MODE — checkout activates a plan locally and does not contact Stripe';
      warnings.push(
        'STRIPE_FIXTURE_MODE is on — billing checkout does not contact Stripe and does not charge a card'
      );
    } else if (missingKey) {
      status = 'disabled';
      detail = 'STRIPE_SECRET_KEY not set — all /billing/* routes return 503';
      warnings.push(
        'STRIPE_SECRET_KEY not set — billing and subscription management disabled (all /billing/* routes return 503)'
      );
    } else if (missingPrice) {
      status = 'missing_config';
      detail =
        'Stripe key set but STRIPE_SOLO_PRICE_ID, STRIPE_GROWTH_PRICE_ID, or STRIPE_PRO_PRICE_ID is empty — that plan checkout returns 503';
      warnings.push(detail);
    } else {
      status = 'ready';
      detail = 'Stripe secret key and price IDs configured';
    }
    if (fixtureRequested && env.NODE_ENV === 'production') {
      warnings.push(
        'STRIPE_FIXTURE_MODE is set in production and is ignored — checkout still requires Stripe'
      );
    }
    evaluations.push({ feature: 'stripe_billing', status, detail, warnings });
  }

  // ── stripe_webhook ───────────────────────────────────────────────────
  // Only meaningful when billing itself is on (legacy warning fired only then).
  {
    let status: FeatureStatus = 'ready';
    let detail = 'Webhook signature verification configured';
    const warnings: string[] = [];
    if (!env.STRIPE_SECRET_KEY) {
      status = 'disabled';
      detail = 'Billing disabled (no STRIPE_SECRET_KEY) — webhook moot';
    } else if (!env.STRIPE_WEBHOOK_SECRET) {
      status = 'missing_config';
      detail = 'STRIPE_WEBHOOK_SECRET not set — webhook signature verification fails';
      warnings.push(
        'STRIPE_WEBHOOK_SECRET not set — Stripe webhook signature verification will fail; checkout.session.completed events are ignored and subscriptions never activate'
      );
    }
    evaluations.push({ feature: 'stripe_webhook', status, detail, warnings });
  }

  // ── cors ─────────────────────────────────────────────────────────────
  {
    const missing = !env.CORS_ORIGIN;
    evaluations.push({
      feature: 'cors',
      status: missing ? 'missing_config' : 'ready',
      detail: missing
        ? 'CORS_ORIGIN not set — server reflects ANY origin (open CORS)'
        : `CORS locked to ${env.CORS_ORIGIN as string}`,
      warnings: missing
        ? [
            'CORS_ORIGIN not set — server reflects ANY origin (open CORS); set to the dashboard URL in production',
          ]
        : [],
    });
  }

  // ── self_service_links (DASHBOARD_URL) ───────────────────────────────
  {
    const missing = !env.DASHBOARD_URL;
    evaluations.push({
      feature: 'self_service_links',
      status: missing ? 'missing_config' : 'ready',
      detail: missing
        ? 'DASHBOARD_URL not set — emails, OAuth redirects, and Stripe URLs default to https://localhost:4400'
        : `Links resolve to ${env.DASHBOARD_URL as string}`,
      warnings: missing
        ? [
            'DASHBOARD_URL not set — emails, OAuth redirects, and Stripe success/cancel URLs default to https://localhost:4400 (broken in production)',
          ]
        : [],
    });
  }

  // ── google_calendar ──────────────────────────────────────────────────
  // Same condition envWarnings always tested (GOOGLE_CLIENT_ID only —
  // calendar.ts gates the OAuth start on it).
  {
    const missing = !env.GOOGLE_CLIENT_ID;
    evaluations.push({
      feature: 'google_calendar',
      status: missing ? 'disabled' : 'ready',
      detail: missing
        ? 'GOOGLE_CLIENT_ID not set — Google Calendar sync disabled'
        : 'Google OAuth client configured',
      warnings: missing ? ['GOOGLE_CLIENT_ID not set — Google Calendar sync disabled'] : [],
    });
  }

  // ── agent_secret ─────────────────────────────────────────────────────
  {
    const missing = !env.AGENT_SECRET;
    evaluations.push({
      feature: 'agent_secret',
      status: missing ? 'missing_config' : 'ready',
      detail: missing
        ? 'AGENT_SECRET not set — /agent-tools/* rejects all LiveKit worker calls'
        : 'Agent shared secret configured',
      warnings: missing
        ? ['AGENT_SECRET not set — /agent-tools/* routes will reject all LiveKit worker calls']
        : [],
    });
  }

  // ── inbound_sms (TELNYX_PUBLIC_KEY) ──────────────────────────────────
  // Mirrors the fail-closed guard in routes/communications.ts: no key → the
  // inbound webhook 503s every request, so a customer texting STOP is never
  // recorded. Reported here because the ONLY other signal is a 503 from a public
  // endpoint, which is indistinguishable from "the service is down" — and that
  // ambiguity cost a live debugging session on 2026-07-12.
  //
  // The key is Telnyx's Ed25519 PUBLIC key, not a secret we generate; the portal
  // no longer exposes it, so fetch it from the API:
  //   curl -H "Authorization: Bearer $TELNYX_API_KEY" https://api.telnyx.com/v2/public_key
  {
    const missing = !env.TELNYX_PUBLIC_KEY;
    const oldPublicKeyPresent = !!env.PUBLIC_KEY;
    evaluations.push({
      feature: 'inbound_sms',
      status: missing ? 'missing_config' : 'ready',
      detail: missing
        ? 'TELNYX_PUBLIC_KEY not set — POST /communications/telnyx/inbound fails closed (503); inbound STOP/START replies are NOT processed'
        : 'Telnyx Ed25519 public key configured — inbound webhook verifies signatures',
      warnings: missing
        ? [
            'TELNYX_PUBLIC_KEY not set — inbound SMS webhook returns 503. A customer who replies STOP is NOT recorded in opt_out_records, and we keep texting them. This is a compliance exposure, not just a missing feature.',
          ]
        : [],
    });

    if (oldPublicKeyPresent) {
      evaluations.push({
        feature: 'env_deprecation',
        status: 'missing_config',
        detail:
          'PUBLIC_KEY (old name) deprecated in favor of TELNYX_PUBLIC_KEY after 2026-07 purge',
        warnings: [
          'PUBLIC_KEY in .env is deprecated (was replaced by TELNYX_PUBLIC_KEY during webhook signature refactor). It is ignored. Update your .env and Railway vars — see DEPLOYMENT.md "Retrieving TELNYX_PUBLIC_KEY".',
        ],
      });
    }
  }

  // ── outlook_calendar (readiness-only; no legacy startup warning) ─────
  // Condition mirrors calendar.ts's Outlook OAuth start (OUTLOOK_CLIENT_ID).
  {
    const missing = !env.OUTLOOK_CLIENT_ID || !env.OUTLOOK_CLIENT_SECRET;
    evaluations.push({
      feature: 'outlook_calendar',
      status: missing ? 'disabled' : 'ready',
      detail: missing
        ? 'OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET not set — Outlook Calendar sync disabled'
        : 'Outlook OAuth client configured',
      warnings: [],
    });
  }

  // ── square_crm (readiness-only) ──────────────────────────────────────
  // Condition mirrors square.ts's OAuth start (SQUARE_CLIENT_ID/SECRET).
  {
    const missing = !env.SQUARE_CLIENT_ID || !env.SQUARE_CLIENT_SECRET;
    evaluations.push({
      feature: 'square_crm',
      status: missing ? 'disabled' : 'ready',
      detail: missing
        ? 'SQUARE_CLIENT_ID / SQUARE_CLIENT_SECRET not set — Square sync disabled'
        : 'Square OAuth client configured',
      warnings: [],
    });
  }

  // ── metrics_endpoint (readiness-only) ────────────────────────────────
  // Condition mirrors health.ts: /metrics returns 404 when METRICS_TOKEN unset.
  {
    const missing = !env.METRICS_TOKEN;
    evaluations.push({
      feature: 'metrics_endpoint',
      status: missing ? 'disabled' : 'ready',
      detail: missing
        ? 'METRICS_TOKEN not set — GET /metrics returns 404'
        : 'Prometheus scrape endpoint enabled (Bearer-gated)',
      warnings: [],
    });
  }

  // ── observability (readiness-only) ───────────────────────────────────
  // Paid vendors were deliberately declined 2026-07-02; "disabled" here is a
  // recorded decision, not an oversight — the free stack (/metrics + Pino
  // stdout + /ready) stands. No startup warning by design.
  {
    const sinks: string[] = [];
    if (env.SENTRY_DSN) sinks.push('Sentry');
    if (env.BETTER_STACK_TOKEN) sinks.push('Better Stack');
    evaluations.push({
      feature: 'observability',
      status: sinks.length > 0 ? 'ready' : 'disabled',
      detail:
        sinks.length > 0
          ? `External sinks active: ${sinks.join(' + ')}`
          : 'No external sink (deliberate — free stack: /metrics + Pino stdout + /ready)',
      warnings: [],
    });
  }

  return evaluations;
}

/** The structured report: one row per capability, warnings stripped. */
export function collectFeatureReadiness(ctx: FeatureReadinessContext): FeatureReadinessRow[] {
  return evaluateCapabilities(ctx).map(({ feature, status, detail }) => ({
    feature,
    status,
    detail,
  }));
}

/**
 * Convenience for callers that don't already hold resolved Telnyx values
 * (the /admin/feature-readiness route). Applies the same `|| ''` defaults
 * index.ts uses at boot.
 */
export function collectFeatureReadinessFromEnv(
  env: NodeJS.ProcessEnv = process.env
): FeatureReadinessRow[] {
  return collectFeatureReadiness({
    env,
    TELNYX_API_KEY: env.TELNYX_API_KEY || '',
    TELNYX_SIP_CONNECTION_ID: env.TELNYX_SIP_CONNECTION_ID || '',
  });
}
