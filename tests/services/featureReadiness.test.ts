/**
 * Tests for the feature-readiness report (src/services/featureReadiness.ts).
 *
 * The report is the structured sibling of the startup warnings: one row per
 * optional capability with status ready/mocked/disabled/missing_config. It is
 * logged once at boot and served at GET /admin/feature-readiness, so an
 * operator diagnosing "why didn't the SMS send" reads THIS instead of
 * grepping 12 console.warn lines.
 *
 * 5W for sad-path failures:
 *   WHO  — an operator (super-admin) checking what's live on a deploy
 *   WHAT — collectFeatureReadiness / collectFeatureReadinessFromEnv rows
 *   WHEN — at boot (logged) and on demand (admin endpoint)
 *   WHERE — src/services/featureReadiness.ts, consumed by index.ts + health.ts
 *   WHY  — a wrong status here sends the operator hunting the wrong config;
 *          drift between report and boot warnings recreates the exact
 *          two-sources-of-truth problem this module exists to kill
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  collectFeatureReadiness,
  collectFeatureReadinessFromEnv,
  evaluateCapabilities,
  type FeatureReadinessContext,
} from '../../src/services/featureReadiness';
import { collectStartupWarnings } from '../../src/services/envWarnings';

/** Build a ctx with every capability fully configured. */
function fullCtx(
  overrides: {
    env?: Record<string, string | undefined>;
    TELNYX_API_KEY?: string;
    TELNYX_SIP_CONNECTION_ID?: string;
  } = {}
): FeatureReadinessContext {
  return {
    env: {
      GOOGLE_CLIENT_ID: 'google-client-id',
      OUTLOOK_CLIENT_ID: 'outlook-client-id',
      OUTLOOK_CLIENT_SECRET: 'outlook-secret',
      SQUARE_CLIENT_ID: 'square-client-id',
      SQUARE_CLIENT_SECRET: 'square-secret',
      AGENT_SECRET: 'a'.repeat(40),
      TELNYX_PHONE_NUMBER: '+16308229086',
      EMAIL_USER: 'test@example.com',
      EMAIL_PASS: 'app-password',
      CORS_ORIGIN: 'https://app.secretaryhq.com',
      DASHBOARD_URL: 'https://app.secretaryhq.com',
      STRIPE_SECRET_KEY: 'sk_test_fake',
      STRIPE_WEBHOOK_SECRET: 'whsec_fake',
      STRIPE_SOLO_PRICE_ID: 'price_solo',
      STRIPE_GROWTH_PRICE_ID: 'price_growth',
      STRIPE_PRO_PRICE_ID: 'price_pro',
      METRICS_TOKEN: 'metrics-token',
      TELNYX_PUBLIC_KEY: '9xjFfLcMgNjd22BM2J0J2wsHmWFsLMfGSBlGviIarp8=',
      SENTRY_DSN: 'https://fake@sentry.io/12345',
      ...(overrides.env ?? {}),
    },
    TELNYX_API_KEY: overrides.TELNYX_API_KEY ?? 'KEY01fake',
    TELNYX_SIP_CONNECTION_ID: overrides.TELNYX_SIP_CONNECTION_ID ?? '12345',
  };
}

function statusOf(rows: ReturnType<typeof collectFeatureReadiness>, feature: string): string {
  const row = rows.find((r) => r.feature === feature);
  expect(row, `report is missing the '${feature}' row`).toBeDefined();
  return row!.status;
}

describe('collectFeatureReadiness — fully configured environment', () => {
  it('HAPPY: every capability reports ready and the report covers all 13 features', () => {
    // WHY: the "everything configured" baseline pins the full feature list —
    // if someone adds a capability without updating this test, drift shows here
    const rows = collectFeatureReadiness(fullCtx());
    expect(rows.map((r) => r.feature).sort()).toEqual(
      [
        'agent_secret',
        'cors',
        'email',
        'google_calendar',
        'inbound_sms',
        'metrics_endpoint',
        'observability',
        'outlook_calendar',
        'self_service_links',
        'sms_provider',
        'square_crm',
        'stripe_billing',
        'stripe_webhook',
      ].sort()
    );
    for (const row of rows) {
      expect(row.status, `${row.feature} should be ready but says: ${row.detail}`).toBe('ready');
      expect(row.detail).toBeTruthy();
    }
  });
});

describe('collectFeatureReadiness — statuses flip per condition', () => {
  it('SAD: no TELNYX_API_KEY → sms_provider is mocked (MockAdapter swallows sends)', () => {
    // WHERE: mirrors ProviderRegistry's `!process.env.TELNYX_API_KEY` mock switch
    const rows = collectFeatureReadiness(fullCtx({ TELNYX_API_KEY: '' }));
    expect(statusOf(rows, 'sms_provider')).toBe('mocked');
  });

  it('SAD: Telnyx key without SIP connection → sms_provider missing_config', () => {
    const rows = collectFeatureReadiness(fullCtx({ TELNYX_SIP_CONNECTION_ID: '' }));
    expect(statusOf(rows, 'sms_provider')).toBe('missing_config');
  });

  it('SAD: Telnyx key without from-number → sms_provider missing_config', () => {
    const rows = collectFeatureReadiness(fullCtx({ env: { TELNYX_PHONE_NUMBER: undefined } }));
    expect(statusOf(rows, 'sms_provider')).toBe('missing_config');
  });

  it('SAD: no EMAIL creds → email is mocked (simulation transporter)', () => {
    const rows = collectFeatureReadiness(fullCtx({ env: { EMAIL_PASS: undefined } }));
    expect(statusOf(rows, 'email')).toBe('mocked');
  });

  it('SAD: no STRIPE_SECRET_KEY → stripe_billing disabled AND stripe_webhook disabled', () => {
    // WHY: webhook without billing is moot — it must not claim missing_config
    // and send the operator hunting a webhook secret that would change nothing
    const rows = collectFeatureReadiness(
      fullCtx({ env: { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined } })
    );
    expect(statusOf(rows, 'stripe_billing')).toBe('disabled');
    expect(statusOf(rows, 'stripe_webhook')).toBe('disabled');
  });

  it('SAD: billing on but no STRIPE_WEBHOOK_SECRET → stripe_webhook missing_config', () => {
    const rows = collectFeatureReadiness(fullCtx({ env: { STRIPE_WEBHOOK_SECRET: undefined } }));
    expect(statusOf(rows, 'stripe_billing')).toBe('ready');
    expect(statusOf(rows, 'stripe_webhook')).toBe('missing_config');
  });

  it('SAD: Stripe key without price IDs → stripe_billing missing_config', () => {
    const rows = collectFeatureReadiness(
      fullCtx({
        env: {
          STRIPE_SOLO_PRICE_ID: undefined,
          STRIPE_GROWTH_PRICE_ID: 'price_growth',
          STRIPE_PRO_PRICE_ID: 'price_pro',
        },
      })
    );
    expect(statusOf(rows, 'stripe_billing')).toBe('missing_config');
  });

  it('HAPPY: STRIPE_FIXTURE_MODE outside production reports stripe_billing mocked', () => {
    const rows = collectFeatureReadiness(
      fullCtx({ env: { STRIPE_FIXTURE_MODE: 'true', NODE_ENV: 'development' } })
    );
    expect(statusOf(rows, 'stripe_billing')).toBe('mocked');
  });

  it('SAD: STRIPE_FIXTURE_MODE in production is ignored and warned', () => {
    const rows = evaluateCapabilities(
      fullCtx({ env: { STRIPE_FIXTURE_MODE: 'true', NODE_ENV: 'production' } })
    );
    const billing = rows.find((r) => r.feature === 'stripe_billing');
    expect(billing?.status).toBe('ready');
    expect(billing?.warnings.join(' ')).toContain('ignored');
  });

  it('SAD: no CORS_ORIGIN → cors missing_config (open CORS)', () => {
    const rows = collectFeatureReadiness(fullCtx({ env: { CORS_ORIGIN: undefined } }));
    expect(statusOf(rows, 'cors')).toBe('missing_config');
  });

  it('SAD: no DASHBOARD_URL → self_service_links missing_config (localhost links)', () => {
    const rows = collectFeatureReadiness(fullCtx({ env: { DASHBOARD_URL: undefined } }));
    expect(statusOf(rows, 'self_service_links')).toBe('missing_config');
  });

  it('SAD: no GOOGLE_CLIENT_ID → google_calendar disabled', () => {
    const rows = collectFeatureReadiness(fullCtx({ env: { GOOGLE_CLIENT_ID: undefined } }));
    expect(statusOf(rows, 'google_calendar')).toBe('disabled');
  });

  it('SAD: no OUTLOOK client pair → outlook_calendar disabled', () => {
    const rows = collectFeatureReadiness(fullCtx({ env: { OUTLOOK_CLIENT_SECRET: undefined } }));
    expect(statusOf(rows, 'outlook_calendar')).toBe('disabled');
  });

  it('SAD: no SQUARE client pair → square_crm disabled', () => {
    const rows = collectFeatureReadiness(fullCtx({ env: { SQUARE_CLIENT_ID: undefined } }));
    expect(statusOf(rows, 'square_crm')).toBe('disabled');
  });

  it('SAD: no METRICS_TOKEN → metrics_endpoint disabled (route 404s)', () => {
    const rows = collectFeatureReadiness(fullCtx({ env: { METRICS_TOKEN: undefined } }));
    expect(statusOf(rows, 'metrics_endpoint')).toBe('disabled');
  });

  it('SAD: no AGENT_SECRET → agent_secret missing_config (worker calls rejected)', () => {
    const rows = collectFeatureReadiness(fullCtx({ env: { AGENT_SECRET: undefined } }));
    expect(statusOf(rows, 'agent_secret')).toBe('missing_config');
  });

  it('HAPPY: observability names each active sink; disabled when neither is set', () => {
    // WHY: "disabled" here is a recorded cost decision (2026-07-02), not an
    // error — but when a sink IS set the report must say which one
    const both = collectFeatureReadiness(fullCtx({ env: { BETTER_STACK_TOKEN: 'bs-token' } })).find(
      (r) => r.feature === 'observability'
    );
    expect(both?.status).toBe('ready');
    expect(both?.detail).toContain('Sentry');
    expect(both?.detail).toContain('Better Stack');

    const none = collectFeatureReadiness(
      fullCtx({ env: { SENTRY_DSN: undefined, BETTER_STACK_TOKEN: undefined } })
    ).find((r) => r.feature === 'observability');
    expect(none?.status).toBe('disabled');
  });
});

describe('shared source of truth with the startup warnings', () => {
  it('HAPPY: a condition that degrades a status also emits its legacy warning — same evaluation, two views', () => {
    // WHY: this is the whole point of the refactor — if the warning and the
    // report ever disagree about the same env var, an operator gets told two
    // different stories at boot vs at /admin/feature-readiness
    const ctx = fullCtx({
      env: { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined },
    });
    const warnings = collectStartupWarnings(ctx);
    expect(warnings.some((w) => w.includes('STRIPE_SECRET_KEY'))).toBe(true);
    expect(statusOf(collectFeatureReadiness(ctx), 'stripe_billing')).toBe('disabled');
  });

  it('SAD: a missing TELNYX_PUBLIC_KEY reports inbound_sms as missing_config + warns at boot', () => {
    // WHO: an operator who deployed the inbound-SMS webhook but never set the key.
    // WHAT: the route fails CLOSED (503 on every request), so a customer who
    //        replies STOP is never recorded in opt_out_records — we keep texting
    //        someone who asked us to stop. That is a compliance exposure, not a
    //        disabled nice-to-have, which is why it WARNS at boot rather than
    //        sitting silently in the readiness report like metrics/outlook/square.
    // WHY (2026-07-12): the only signal for this was a bare 503 from a public
    //        endpoint — indistinguishable from "the service is down". It cost a
    //        live debugging session. The readiness report now answers it flatly.
    const ctx = fullCtx({ env: { TELNYX_PUBLIC_KEY: undefined } });

    expect(statusOf(collectFeatureReadiness(ctx), 'inbound_sms')).toBe('missing_config');
    expect(collectStartupWarnings(ctx).join(' ')).toMatch(/TELNYX_PUBLIC_KEY/);
  });

  it('HAPPY: readiness-only capabilities contribute NO startup warnings', () => {
    // WHY: metrics/observability/outlook/square were never boot warnings —
    // adding them would break the pinned "all present → []" envWarnings test
    // and add noise the operator never asked for
    const ctx = fullCtx({
      env: {
        METRICS_TOKEN: undefined,
        SENTRY_DSN: undefined,
        OUTLOOK_CLIENT_ID: undefined,
        SQUARE_CLIENT_ID: undefined,
      },
    });
    expect(collectStartupWarnings(ctx)).toEqual([]);
    const rows = evaluateCapabilities(ctx);
    for (const feature of ['metrics_endpoint', 'observability', 'outlook_calendar', 'square_crm']) {
      expect(rows.find((r) => r.feature === feature)?.warnings).toEqual([]);
    }
  });
});

describe('collectFeatureReadinessFromEnv — reads process.env at call time', () => {
  // Save + restore the env vars this block mutates so no state leaks into
  // sibling test files that read the same variables.
  const TOUCHED = ['METRICS_TOKEN', 'TELNYX_API_KEY'] as const;
  const saved: Record<string, string | undefined> = {};
  for (const key of TOUCHED) saved[key] = process.env[key];

  afterEach(() => {
    for (const key of TOUCHED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('HAPPY: statuses flip when the process env var is set vs unset', () => {
    // WHO: the /admin/feature-readiness route — it calls this convenience
    // form with no pre-resolved values, so the || '' defaulting must match
    // what index.ts computes at boot
    delete process.env.METRICS_TOKEN;
    delete process.env.TELNYX_API_KEY;
    let rows = collectFeatureReadinessFromEnv();
    expect(statusOf(rows, 'metrics_endpoint')).toBe('disabled');
    expect(statusOf(rows, 'sms_provider')).toBe('mocked');

    process.env.METRICS_TOKEN = 'tok';
    rows = collectFeatureReadinessFromEnv();
    expect(statusOf(rows, 'metrics_endpoint')).toBe('ready');
  });
});
