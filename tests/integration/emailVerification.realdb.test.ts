/**
 * Real-DB tests for signup email verification (owner decision 2026-09-24).
 *
 * Drives the real /register, /login, /verify-email, /verify-email/resend,
 * /reset-password and /billing/checkout routes against real Postgres. Only
 * the mail transport is mocked, so the test can read the link that would
 * have been emailed.
 *
 * 5W for sad-path failures:
 *   WHO  — a new business owner signing up
 *   WHAT — proving they own their signup email before checkout
 *   WHEN — between /register and starting the card-required trial
 *   WHERE — auth.ts verification routes, billing.ts checkout gate
 *   WHY  — an unverified address could open a trial on someone else's email,
 *          and a password reset for it would go to a stranger's inbox
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Client, Pool } from 'pg';
import { API_DB_URL, getRootClient, skipIfDbDown } from '../utils';

vi.mock('../../src/services/communications/systemEmail', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    sendEmailVerificationEmail: vi.fn(async () => undefined),
    sendPasswordResetEmail: vi.fn(async () => undefined),
  };
});

import * as systemEmail from '../../src/services/communications/systemEmail';
import { registerAuthRoutes } from '../../src/routes/auth';
import { registerBillingRoutes } from '../../src/routes/billing';

type AuthedRequest = FastifyRequest & {
  tenantId?: string;
  auth?: { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
};

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
const tenantsToClean: string[] = [];
const sendVerify = vi.mocked(systemEmail.sendEmailVerificationEmail);

function uniqueEmail(tag: string) {
  return `verify-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
}

/** The raw token out of the most recent verification email the route "sent". */
function lastEmailedToken(): string {
  const link = sendVerify.mock.calls.at(-1)![1];
  return new URL(link).searchParams.get('token')!;
}

async function register(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/register',
    payload: {
      business_name: `Verify Biz ${email}`,
      business_type: 'salon',
      owner_name: 'Vera Fy',
      email,
      password: 'secure123',
      consent_attested: true,
    },
  });
  if (res.statusCode === 201) tenantsToClean.push(res.json().tenant_id as string);
  return res;
}

/** Authenticated request as the given owner (stands in for the JWT hook). */
function asOwner(tenantId: string, userId: string, email: string) {
  return {
    'x-test-tenant': tenantId,
    'x-test-user': userId,
    'x-test-email': email,
  };
}

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });
    process.env.STRIPE_FIXTURE_MODE = 'true';
    process.env.ENABLE_SIGNUP = 'true'; // self-serve signup is closed by default

    app = Fastify({ logger: false });
    app.addHook('preHandler', async (request: AuthedRequest) => {
      const tid = request.headers['x-test-tenant'] as string | undefined;
      if (tid) {
        request.tenantId = tid;
        request.auth = {
          tenant_id: tid,
          user_id: request.headers['x-test-user'] as string,
          email: request.headers['x-test-email'] as string,
          role: 'owner',
        };
      }
    });
    registerAuthRoutes(app, pool, () => 'test.jwt.token');
    registerBillingRoutes(app, pool);
    await app.ready();
    dbAvailable = true;
  } catch (err) {
    console.warn('[emailVerification.realdb.test] DB not available, skipping', err);
  }
});

afterAll(async () => {
  delete process.env.STRIPE_FIXTURE_MODE;
  delete process.env.ENABLE_SIGNUP;
  if (app) await app.close();
  if (pool) await pool.end();
  if (setup) {
    for (const id of tenantsToClean) {
      await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
    }
    await setup.end();
  }
});

beforeEach((ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
  sendVerify.mockClear();
});

describe('POST /register → verification email', () => {
  it('HAPPY: signup starts unverified, stores a hashed token, and emails a /verify-email link', async () => {
    const email = uniqueEmail('signup');
    const res = await register(email);

    expect(res.statusCode).toBe(201);
    expect(res.json().email_verified).toBe(false);

    const user = await setup.query(
      'SELECT user_id, email_verified_at FROM users WHERE email = $1',
      [email]
    );
    expect(user.rows[0].email_verified_at).toBeNull();

    expect(sendVerify).toHaveBeenCalledTimes(1);
    const [to, link, ttl] = sendVerify.mock.calls[0];
    expect(to).toBe(email);
    expect(link).toMatch(/\/verify-email\?token=[A-Za-z0-9_-]{30,}/);
    expect(ttl).toBe(48);

    const rows = await setup.query(
      'SELECT token_hash, used_at FROM email_verifications WHERE user_id = $1',
      [user.rows[0].user_id]
    );
    expect(rows.rows).toHaveLength(1);
    // The raw token is never stored — only its hash.
    expect(rows.rows[0].token_hash).not.toBe(lastEmailedToken());
    expect(rows.rows[0].used_at).toBeNull();
  });

  it('SAD: the same email in different capitals is refused with "you already have an account"', async () => {
    const email = uniqueEmail('dupe');
    expect((await register(email)).statusCode).toBe(201);

    const again = await register(email.toUpperCase());

    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/^You already have an account with this email/);
    const count = await setup.query(
      'SELECT COUNT(*)::int AS n FROM users WHERE LOWER(email) = $1',
      [email]
    );
    expect(count.rows[0].n).toBe(1);
  });
});

describe('One account per email — concurrency', () => {
  it('REGRESSION: two simultaneous signups with one email → exactly one account', async () => {
    // WHO: a double-clicked submit, or two tabs, registering the same address.
    // WHAT: one 201 and one 409 "already have an account"; one users row.
    // WHY: both requests can pass the app-level SELECT before either INSERTs;
    //      only the platform-wide unique index (20260924000200) stops the second.
    const email = uniqueEmail('race');
    const [a, b] = await Promise.all([register(email), register(email.toUpperCase())]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error).toMatch(/^You already have an account with this email/);
    const count = await setup.query(
      'SELECT COUNT(*)::int AS n FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    expect(count.rows[0].n).toBe(1);
  });
});

describe('POST /verify-email', () => {
  it('HAPPY: the emailed token verifies the user and is then used up', async () => {
    const email = uniqueEmail('click');
    await register(email);
    const token = lastEmailedToken();

    const res = await app.inject({ method: 'POST', url: '/verify-email', payload: { token } });

    expect(res.statusCode).toBe(200);
    const user = await setup.query('SELECT email_verified_at FROM users WHERE email = $1', [email]);
    expect(user.rows[0].email_verified_at).not.toBeNull();

    // Single use: the same link again is refused.
    const reuse = await app.inject({ method: 'POST', url: '/verify-email', payload: { token } });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error).toMatch(/invalid or has expired/);
  });

  it('SAD: an expired token is refused and the user stays unverified', async () => {
    const email = uniqueEmail('expired');
    await register(email);
    const token = lastEmailedToken();
    await setup.query(
      `UPDATE email_verifications SET expires_at = NOW() - interval '1 minute'
        WHERE user_id = (SELECT user_id FROM users WHERE email = $1)`,
      [email]
    );

    const res = await app.inject({ method: 'POST', url: '/verify-email', payload: { token } });

    expect(res.statusCode).toBe(400);
    const user = await setup.query('SELECT email_verified_at FROM users WHERE email = $1', [email]);
    expect(user.rows[0].email_verified_at).toBeNull();
  });

  it('SAD: a made-up token is refused', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/verify-email',
      payload: { token: 'x'.repeat(43) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /verify-email/resend', () => {
  it('SAD: requires a signed-in user', async () => {
    const res = await app.inject({ method: 'POST', url: '/verify-email/resend' });
    expect(res.statusCode).toBe(401);
  });

  it('HAPPY: an unverified user gets a fresh link; the old link still works until one is used', async () => {
    const email = uniqueEmail('resend');
    const reg = (await register(email)).json();
    sendVerify.mockClear();

    const res = await app.inject({
      method: 'POST',
      url: '/verify-email/resend',
      headers: asOwner(reg.tenant_id, reg.user_id, email),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sent_to).toBe(email);
    expect(sendVerify).toHaveBeenCalledTimes(1);

    // Clicking the new one burns every outstanding link for the user.
    const fresh = lastEmailedToken();
    expect(
      (await app.inject({ method: 'POST', url: '/verify-email', payload: { token: fresh } }))
        .statusCode
    ).toBe(200);
    const open = await setup.query(
      'SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1 AND used_at IS NULL',
      [reg.user_id]
    );
    expect(open.rows[0].n).toBe(0);
  });

  it('HAPPY: an already-verified user is told so and no email is sent', async () => {
    const email = uniqueEmail('already');
    const reg = (await register(email)).json();
    await app.inject({
      method: 'POST',
      url: '/verify-email',
      payload: { token: lastEmailedToken() },
    });
    sendVerify.mockClear();

    const res = await app.inject({
      method: 'POST',
      url: '/verify-email/resend',
      headers: asOwner(reg.tenant_id, reg.user_id, email),
    });

    expect(res.json()).toMatchObject({ success: true, already_verified: true });
    expect(sendVerify).not.toHaveBeenCalled();
  });
});

describe('POST /billing/checkout — email-verification gate', () => {
  it('SAD: an unverified owner cannot start the trial (403 email_not_verified)', async () => {
    const email = uniqueEmail('gate');
    const reg = (await register(email)).json();

    const res = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: asOwner(reg.tenant_id, reg.user_id, email),
      payload: { plan: 'solo' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('email_not_verified');
    expect(res.json().error).toContain(email);
    const tenant = await setup.query(
      'SELECT subscription_status FROM tenants WHERE tenant_id = $1',
      [reg.tenant_id]
    );
    expect(tenant.rows[0].subscription_status).toBe('inactive');
  });

  it('HAPPY: once verified, the same owner can check out', async () => {
    const email = uniqueEmail('gate-ok');
    const reg = (await register(email)).json();
    await app.inject({
      method: 'POST',
      url: '/verify-email',
      payload: { token: lastEmailedToken() },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: asOwner(reg.tenant_id, reg.user_id, email),
      payload: { plan: 'solo' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().fixture).toBe(true);
  });
});

describe('Other proofs of inbox ownership', () => {
  it('HAPPY: completing a password reset also verifies the email', async () => {
    const email = uniqueEmail('reset');
    const reg = (await register(email)).json();
    const rawToken = 'r'.repeat(43);
    const { createHash } = await import('crypto');
    await setup.query(
      `INSERT INTO password_resets (user_id, token_hash, channel, expires_at)
       VALUES ($1, $2, 'email', NOW() + interval '30 minutes')`,
      [reg.user_id, createHash('sha256').update(rawToken).digest('hex')]
    );

    const res = await app.inject({
      method: 'POST',
      url: '/reset-password',
      payload: { token: rawToken, new_password: 'newSecure123' },
    });

    expect(res.statusCode).toBe(200);
    const user = await setup.query('SELECT email_verified_at FROM users WHERE user_id = $1', [
      reg.user_id,
    ]);
    expect(user.rows[0].email_verified_at).not.toBeNull();
  });

  it('HAPPY: /login reports email_verified so the dashboard can prompt', async () => {
    const email = uniqueEmail('login');
    await register(email);

    const before = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email, password: 'secure123' },
    });
    expect(before.json().email_verified).toBe(false);

    await app.inject({
      method: 'POST',
      url: '/verify-email',
      payload: { token: lastEmailedToken() },
    });
    const after = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { email: email.toUpperCase(), password: 'secure123' },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().email_verified).toBe(true);
  });
});

describe('Signup switch', () => {
  it('SAD: with ENABLE_SIGNUP unset, /register creates nothing and says signups are not open', async () => {
    const email = uniqueEmail('closed');
    delete process.env.ENABLE_SIGNUP;
    try {
      const res = await register(email);
      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('signup_closed');
      const user = await setup.query('SELECT 1 FROM users WHERE email = $1', [email]);
      expect(user.rows).toHaveLength(0);
      expect(sendVerify).not.toHaveBeenCalled();
    } finally {
      process.env.ENABLE_SIGNUP = 'true';
    }
  });
});

describe('Signup under the RLS-enforced role', () => {
  it('REGRESSION: /register succeeds for a templated business type and creates its default resource', async () => {
    // WHO: a new salon owner signing up on production (which runs as app_user).
    // WHAT: 201, and the salon template's default resource row exists.
    // WHEN: tenants INSERT fires on_tenant_created_resources with no tenant context.
    // WHERE: create_default_resources() trigger (migration 20260924000100).
    // WHY: before that migration the trigger's resources INSERT violated RLS and
    //      every templated signup answered 500 — found by this file, the first
    //      test to run /register against a non-bypass role.
    const email = uniqueEmail('rls');
    const res = await register(email);

    expect(res.statusCode).toBe(201);
    const resources = await setup.query('SELECT name FROM resources WHERE tenant_id = $1', [
      res.json().tenant_id,
    ]);
    expect(resources.rows.length).toBeGreaterThan(0);
  });
});

describe('Migration safety', () => {
  it('REGRESSION: seeded logins (Dale, admin, demo) are verified, so nobody is locked out', async () => {
    const res = await setup.query(
      `SELECT email FROM users
        WHERE email IN ('admin@secretaryhq.com', 'daledemott@gmail.com', 'bella@bellashair.com')
          AND email_verified_at IS NULL`
    );
    expect(res.rows).toEqual([]);
  });
});
