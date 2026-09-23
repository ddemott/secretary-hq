/**
 * Tests for the startup-warning collector. Pure-function tests — no server
 * boot, no env mutation leaks between tests.
 *
 * These tests guard every environment-variable warning currently in
 * effect. When someone adds a new warning they'll also want to pin it
 * here so drift is impossible. 5W comments throughout.
 */
import { describe, it, expect } from 'vitest';
import { collectStartupWarnings } from '../../src/services/envWarnings';

/** Build a ctx with all vars set to "present" by default. */
function baseCtx(
  overrides: {
    env?: Record<string, string | undefined>;
    TELNYX_API_KEY?: string;
    TELNYX_SIP_CONNECTION_ID?: string;
  } = {}
) {
  return {
    env: {
      GOOGLE_CLIENT_ID: 'google-client-id',
      AGENT_SECRET: 'a'.repeat(40),
      TELNYX_PHONE_NUMBER: '+16308229086',
      EMAIL_USER: 'test@example.com',
      EMAIL_PASS: 'app-password',
      CORS_ORIGIN: 'https://app.secretaryhq.com',
      DASHBOARD_URL: 'https://app.secretaryhq.com',
      TELNYX_PUBLIC_KEY: '9xjFfLcMgNjd22BM2J0J2wsHmWFsLMfGSBlGviIarp8=',
      STRIPE_SECRET_KEY: 'sk_test_fake',
      STRIPE_WEBHOOK_SECRET: 'whsec_fake',
      STRIPE_SOLO_PRICE_ID: 'price_solo',
      STRIPE_GROWTH_PRICE_ID: 'price_growth',
      STRIPE_PRO_PRICE_ID: 'price_pro',
      ...(overrides.env ?? {}),
    } as NodeJS.ProcessEnv,
    TELNYX_API_KEY: overrides.TELNYX_API_KEY ?? 'KEY01fake',
    TELNYX_SIP_CONNECTION_ID: overrides.TELNYX_SIP_CONNECTION_ID ?? '12345',
  };
}

describe('collectStartupWarnings — all present', () => {
  it('HAPPY: nothing is missing → no warnings returned', () => {
    // WHO: Fully configured production environment
    // WHAT: The function returns an empty array so startup emits no
    //        noise — the signal-to-noise ratio of WARNINGs matters
    // WHY: If the baseline case ever starts warning, someone added a
    //        check but didn't wire it into their default test ctx
    expect(collectStartupWarnings(baseCtx())).toEqual([]);
  });
});

describe('collectStartupWarnings — TELNYX_API_KEY', () => {
  it('SAD: missing TELNYX_API_KEY → warning mentions provisioning + OTP', () => {
    // WHO: Operator who hasn't configured the Telnyx API key
    // WHAT: Telnyx is responsible for both phone provisioning and SMS OTP, so the
    //        warning needs to mention both consequences so the operator understands
    //        the blast radius without consulting docs
    // WHY: Silent config failures are the slowest bugs to diagnose. The warning text
    //        is the test.
    const warnings = collectStartupWarnings(baseCtx({ TELNYX_API_KEY: '' }));
    const w = warnings.find((x) => x.includes('TELNYX_API_KEY'));
    expect(w).toBeDefined();
    expect(w).toContain('phone provisioning');
    expect(w).toContain('OTP');
  });

  it('SAD: TELNYX_API_KEY set but TELNYX_SIP_CONNECTION_ID missing → routing warning fires', () => {
    // WHO: Operator who has the API key but hasn't pasted the SIP Connection ID yet
    // WHAT: Provisioning will return 503 because purchased numbers can't be routed
    // WHY: This is the exact half-configured state we ship into when keys are added piecemeal —
    //        the warning is the only signal between "boot succeeded" and a 503 at first activation
    const warnings = collectStartupWarnings(baseCtx({ TELNYX_SIP_CONNECTION_ID: '' }));
    const w = warnings.find((x) => x.includes('TELNYX_SIP_CONNECTION_ID'));
    expect(w).toBeDefined();
    expect(w).toContain('503');
  });

  it('HAPPY: TELNYX_API_KEY missing suppresses the SIP connection warning', () => {
    // WHO: Operator with no Telnyx config at all
    // WHY: The SIP-connection warning is meaningless when the key itself is absent —
    //        we'd just be shouting twice for the same condition
    const warnings = collectStartupWarnings(
      baseCtx({ TELNYX_API_KEY: '', TELNYX_SIP_CONNECTION_ID: '' })
    );
    expect(warnings.filter((w) => w.includes('TELNYX_SIP_CONNECTION_ID'))).toHaveLength(0);
  });
});

describe('collectStartupWarnings — AGENT_SECRET', () => {
  it('SAD: missing AGENT_SECRET → warning about agent-tool rejection', () => {
    const warnings = collectStartupWarnings(
      baseCtx({ env: { AGENT_SECRET: undefined, GOOGLE_CLIENT_ID: 'x' } })
    );
    expect(warnings.find((w) => w.includes('AGENT_SECRET'))).toMatch(
      /reject all LiveKit worker calls/i
    );
  });
});

describe('collectStartupWarnings — GOOGLE_CLIENT_ID', () => {
  it('SAD: missing GOOGLE_CLIENT_ID → calendar-sync warning', () => {
    const warnings = collectStartupWarnings(baseCtx({ env: { GOOGLE_CLIENT_ID: undefined } }));
    expect(warnings.find((w) => w.includes('GOOGLE_CLIENT_ID'))).toContain(
      'Google Calendar sync disabled'
    );
  });
});

describe('collectStartupWarnings — TELNYX_PHONE_NUMBER', () => {
  it('SAD: TELNYX_API_KEY set but TELNYX_PHONE_NUMBER missing → SMS from-number warning', () => {
    // WHO: Operator with Telnyx API key but no outbound phone number configured
    // WHAT: Reminder and notification SMS will fail because the from field is invalid
    // WHY: ProviderRegistry now defaults to Telnyx; a missing from number is a silent
    //       delivery failure with no error at the route layer
    const warnings = collectStartupWarnings(baseCtx({ env: { TELNYX_PHONE_NUMBER: undefined } }));
    const w = warnings.find((x) => x.includes('TELNYX_PHONE_NUMBER'));
    expect(w).toBeDefined();
    expect(w).toContain('from number');
  });

  it('HAPPY: TELNYX_API_KEY missing suppresses TELNYX_PHONE_NUMBER warning', () => {
    // WHO: Operator with no Telnyx config at all
    // WHY: Phone number warning is irrelevant when the key itself is absent
    const warnings = collectStartupWarnings(
      baseCtx({ TELNYX_API_KEY: '', env: { TELNYX_PHONE_NUMBER: undefined } })
    );
    expect(warnings.filter((w) => w.includes('TELNYX_PHONE_NUMBER'))).toHaveLength(0);
  });
});

describe('collectStartupWarnings — EMAIL_USER / EMAIL_PASS', () => {
  it('SAD: EMAIL_USER missing → email mock warning fires', () => {
    // WHO: Operator who hasn't set Gmail app-password credentials
    // WHAT: emailService falls back to mock transporter — all confirmation/reminder
    //       emails return a fake messageId but never send
    // WHY: This is a silent prod failure; the warning is the only signal
    const warnings = collectStartupWarnings(baseCtx({ env: { EMAIL_USER: undefined } }));
    expect(warnings.find((w) => w.includes('EMAIL_USER'))).toContain('mock mode');
  });

  it('SAD: EMAIL_PASS missing → email mock warning fires', () => {
    const warnings = collectStartupWarnings(baseCtx({ env: { EMAIL_PASS: undefined } }));
    expect(warnings.find((w) => w.includes('EMAIL_PASS'))).toContain('mock mode');
  });
});

describe('collectStartupWarnings — CORS_ORIGIN', () => {
  it('SAD: CORS_ORIGIN missing → open-CORS security warning', () => {
    // WHO: Operator who hasn't pinned allowed origins
    // WHAT: Fastify reflects any origin — cross-site requests from any domain succeed
    // WHY: Silent security misconfiguration; warning at boot is the cheapest guard
    const warnings = collectStartupWarnings(baseCtx({ env: { CORS_ORIGIN: undefined } }));
    const w = warnings.find((x) => x.includes('CORS_ORIGIN'));
    expect(w).toBeDefined();
    expect(w).toContain('ANY origin');
  });
});

describe('collectStartupWarnings — DASHBOARD_URL', () => {
  it('SAD: DASHBOARD_URL missing → warning about localhost fallback', () => {
    // WHO: Operator who hasn't set the public dashboard URL
    // WHAT: Emails, OAuth redirects, Stripe success/cancel URLs all point at localhost
    // WHY: Production OAuth flows and Stripe redirects silently break
    const warnings = collectStartupWarnings(baseCtx({ env: { DASHBOARD_URL: undefined } }));
    const w = warnings.find((x) => x.includes('DASHBOARD_URL'));
    expect(w).toBeDefined();
    expect(w).toContain('localhost');
  });
});

describe('collectStartupWarnings — Stripe', () => {
  it('SAD: STRIPE_SECRET_KEY missing → billing disabled warning', () => {
    // WHO: Operator who hasn't configured Stripe
    // WHAT: All /billing/* routes return 503 — no checkout, no subscription management
    // WHY: Silent for operators who assume billing works because the UI exists
    const warnings = collectStartupWarnings(
      baseCtx({ env: { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined } })
    );
    const w = warnings.find((x) => x.includes('STRIPE_SECRET_KEY'));
    expect(w).toBeDefined();
    expect(w).toContain('503');
  });

  it('SAD: STRIPE_SECRET_KEY set but STRIPE_WEBHOOK_SECRET missing → webhooks fail warning', () => {
    // WHO: Operator who set the API key but not the webhook signing secret
    // WHAT: constructEvent throws on every inbound webhook → subscriptions never activate
    //       even though checkout sessions complete successfully
    // WHY: The gap between "checkout works" and "subscription activates" is invisible
    //       without this warning — looks like a billing integration bug
    const warnings = collectStartupWarnings(baseCtx({ env: { STRIPE_WEBHOOK_SECRET: undefined } }));
    const w = warnings.find((x) => x.includes('STRIPE_WEBHOOK_SECRET'));
    expect(w).toBeDefined();
    expect(w).toContain('subscriptions never activate');
  });

  it('HAPPY: STRIPE_SECRET_KEY missing suppresses webhook-secret warning', () => {
    // WHO: Operator with no Stripe config at all
    // WHY: Webhook-secret warning is noise when the key itself is absent
    const warnings = collectStartupWarnings(
      baseCtx({ env: { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined } })
    );
    expect(warnings.filter((w) => w.includes('STRIPE_WEBHOOK_SECRET'))).toHaveLength(0);
  });
});

describe('collectStartupWarnings — .env deprecation + TELNYX_PUBLIC_KEY edges', () => {
  it('SAD: TELNYX_PUBLIC_KEY missing → inbound_sms 503 fail-closed warning', () => {
    // WHO: production operator who purged old PUBLIC_KEY but forgot TELNYX_PUBLIC_KEY
    // WHAT: explicit 503 + compliance note so STOP replies are not silently dropped
    // WHY: recent .env PUBLIC_KEY purge (2026-07) left this gap; test pins both edges
    const warnings = collectStartupWarnings(baseCtx({ env: { TELNYX_PUBLIC_KEY: undefined } }));
    const w = warnings.find((x) => x.includes('TELNYX_PUBLIC_KEY') || x.includes('PUBLIC_KEY'));
    expect(w).toBeDefined();
    expect(w).toContain('503');
    expect(w).toContain('inbound SMS webhook returns 503');
    expect(w).toContain('compliance exposure');
  });

  it('HAPPY: TELNYX_PUBLIC_KEY present suppresses warning (post-purge)', () => {
    const warnings = collectStartupWarnings(
      baseCtx({ env: { TELNYX_PUBLIC_KEY: '9xjFfLcMgNjd22BM2J0J2wsHmWFsLMfGSBlGviIarp8=' } })
    );
    expect(
      warnings.filter((w) => w.includes('PUBLIC_KEY') || w.includes('TELNYX_PUBLIC_KEY'))
    ).toHaveLength(0);
  });

  it('DEPRECATION: old PUBLIC_KEY still present logs migration note (no functional effect)', () => {
    // Covers the purge edge — old .env files may still have PUBLIC_KEY=...
    const ctx = baseCtx({
      env: {
        PUBLIC_KEY: 'old-value-to-trigger-deprecation',
        TELNYX_PUBLIC_KEY: 'valid=',
      },
    });
    const warnings = collectStartupWarnings(ctx);
    const dep = warnings.find((w) => w.includes('PUBLIC_KEY') && w.includes('deprecated'));
    expect(dep).toBeDefined(); // or check featureReadiness if it surfaces it
  });
});
