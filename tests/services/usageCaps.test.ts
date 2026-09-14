/**
 * Pure unit tests for tier call-cap resolution + soft-cap status.
 * Real-DB coverage for evaluateUsageCap lives in billing-usage.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  PLAN_QUOTAS,
  USAGE_WARN_RATIO,
  resolvePlanQuota,
  planCallLimit,
  usageCapStatus,
  isSoftCapEnforced,
} from '../../src/services/billingUsage';

const ENV_KEYS = [
  'PLAN_CAP_SOLO',
  'PLAN_CAP_GROWTH',
  'PLAN_CAP_PROFESSIONAL',
  'USAGE_WARN_RATIO',
  'USAGE_SOFT_CAP_ENFORCE',
] as const;

/** Baseline env at module load — restore here so suite-level PLAN_CAP_* is preserved. */
const BASELINE: Record<(typeof ENV_KEYS)[number], string | undefined> = {
  PLAN_CAP_SOLO: process.env.PLAN_CAP_SOLO,
  PLAN_CAP_GROWTH: process.env.PLAN_CAP_GROWTH,
  PLAN_CAP_PROFESSIONAL: process.env.PLAN_CAP_PROFESSIONAL,
  USAGE_WARN_RATIO: process.env.USAGE_WARN_RATIO,
  USAGE_SOFT_CAP_ENFORCE: process.env.USAGE_SOFT_CAP_ENFORCE,
};

afterEach(() => {
  for (const key of ENV_KEYS) {
    const v = BASELINE[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
});

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('resolvePlanQuota / planCallLimit — configurable tier caps', () => {
  it('HAPPY: defaults Solo ~350, Growth ~1000, Professional unlimited', () => {
    // WHO: operator shipping before Dale finalizes Stripe prices
    // WHAT: env-free defaults match TODO P2 placeholder bands
    // WHY: uncapped Solo burns margin; Pro is the unlimited tier
    expect(planCallLimit('solo')).toBe(350);
    expect(planCallLimit('growth')).toBe(1000);
    expect(planCallLimit('professional')).toBeNull();
    expect(resolvePlanQuota('solo')?.includedCalls).toBe(350);
    expect(resolvePlanQuota('growth')?.includedCalls).toBe(1000);
    expect(resolvePlanQuota('professional')?.includedCalls).toBeNull();
    expect(PLAN_QUOTAS.solo.includedCalls).toBe(350);
    expect(PLAN_QUOTAS.growth.includedCalls).toBe(1000);
  });

  it('HAPPY: PLAN_CAP_* env overrides defaults without code change', () => {
    setEnv('PLAN_CAP_SOLO', '400');
    setEnv('PLAN_CAP_GROWTH', '1200');
    setEnv('PLAN_CAP_PROFESSIONAL', '5000');
    expect(planCallLimit('solo')).toBe(400);
    expect(planCallLimit('growth')).toBe(1200);
    expect(planCallLimit('professional')).toBe(5000);
  });

  it('HAPPY: PLAN_CAP_PROFESSIONAL=0 or unlimited stays unlimited', () => {
    setEnv('PLAN_CAP_PROFESSIONAL', '0');
    expect(planCallLimit('professional')).toBeNull();
    setEnv('PLAN_CAP_PROFESSIONAL', 'unlimited');
    expect(planCallLimit('professional')).toBeNull();
  });

  it('SAD: unknown / null plan → no quota, no hard limit', () => {
    expect(resolvePlanQuota(null)).toBeNull();
    expect(resolvePlanQuota('enterprise')).toBeNull();
    expect(planCallLimit(null)).toBeNull();
    expect(planCallLimit('enterprise')).toBeNull();
  });
});

describe('usageCapStatus — 80% warn + soft block', () => {
  it('HAPPY: under warn ratio is ok; at 80% warns; at limit blocks', () => {
    expect(USAGE_WARN_RATIO).toBe(0.8);
    expect(usageCapStatus(0, 100)).toBe('ok');
    expect(usageCapStatus(79, 100)).toBe('ok');
    expect(usageCapStatus(80, 100)).toBe('warn');
    expect(usageCapStatus(99, 100)).toBe('warn');
    expect(usageCapStatus(100, 100)).toBe('blocked');
    expect(usageCapStatus(150, 100)).toBe('blocked');
  });

  it('HAPPY: null limit is unlimited regardless of used', () => {
    expect(usageCapStatus(0, null)).toBe('unlimited');
    expect(usageCapStatus(99999, null)).toBe('unlimited');
  });

  it('HAPPY: USAGE_WARN_RATIO env tunes the banner threshold', () => {
    setEnv('USAGE_WARN_RATIO', '0.9');
    expect(usageCapStatus(89, 100)).toBe('ok');
    expect(usageCapStatus(90, 100)).toBe('warn');
  });
});

describe('isSoftCapEnforced', () => {
  it('HAPPY: defaults on; USAGE_SOFT_CAP_ENFORCE=false disables block', () => {
    expect(isSoftCapEnforced()).toBe(true);
    setEnv('USAGE_SOFT_CAP_ENFORCE', 'false');
    expect(isSoftCapEnforced()).toBe(false);
    setEnv('USAGE_SOFT_CAP_ENFORCE', '0');
    expect(isSoftCapEnforced()).toBe(false);
  });
});
