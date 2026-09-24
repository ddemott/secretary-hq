/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

import { createHash, randomBytes } from 'crypto';
import { isIP } from 'net';
import type { AppFastifyInstance } from '../types/fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  withHandler,
  withPoolClient,
  logWarning,
  type AppRequest,
  type UserRole,
} from '../middleware/fastify-middleware';
import {
  sendPasswordResetEmail,
  sendEmailVerificationEmail,
} from '../services/communications/systemEmail';
import { errorsTotal } from '../services/metrics';
import { createTenantWithOwner } from '../services/tenants/bootstrap';
import { isHipaaVertical } from '../../shared/hipaaVerticalDenylist';

const RESET_TTL_MINUTES = 30;
export const EMAIL_VERIFY_TTL_HOURS = 48;

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const RegisterSchema = z
  .object({
    business_name: z.string().min(1).max(200),
    business_type: z.string().min(1).max(50),
    owner_name: z.string().min(1).max(200),
    email: z.string().email(),
    password: z.string().min(6).max(200),
    // Backend-enforced mirror of the /register page's legal-consent checkbox.
    // Must be the literal boolean `true` — missing, false, or any other value
    // fails Zod validation and the request never reaches createTenantWithOwner.
    // A client-side-only checkbox left this bypassable via a direct API call,
    // which defeats the ToS/DPA liability-shift the checkbox exists for.
    consent_attested: z.literal(true, 'You must agree to the Terms of Service to register'),
  })
  // Server-side mirror of the "HIPAA verticals are permanently excluded" rule
  // (root CLAUDE.md). The picker UI normally constrains business_type via a
  // <select>, but falls back to free text on a GET /templates failure, and a
  // direct API call bypasses the picker entirely. shared/hipaaVerticalDenylist.ts
  // is the one enforcement point independent of the UI.
  .refine((data) => !isHipaaVertical(data.business_type), {
    message: 'This business type is not supported on this platform.',
    path: ['business_type'],
  });

const ForgotSchema = z.object({ email: z.string().email() });

const ResetSchema = z.object({
  token: z.string().min(20).max(200),
  new_password: z.string().min(6).max(200),
});

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const VerifyEmailSchema = z.object({ token: z.string().min(20).max(200) });

/**
 * Self-serve signup switch (owner decision 2026-09-24: not open yet).
 * CLOSED unless ENABLE_SIGNUP is exactly 'true' — so production, where it is
 * unset, refuses POST /register. Admin-created tenants (POST /tenants/create)
 * and /demo/start are unaffected. Local dev, CI and E2E set it to 'true'.
 */
export function isSignupOpen(): boolean {
  return process.env.ENABLE_SIGNUP === 'true';
}

export const SIGNUP_CLOSED_MESSAGE =
  "Sign-ups aren't open yet. Try the live demo in the meantime, or check back soon.";

/**
 * Write a fresh email-verification token for a user and send the link.
 * The token row is durable before the send starts; the send is
 * FIRE-AND-FORGET for the same reason as /forgot-password (an awaited SMTP
 * send hung production once) — a failure is metered and logged, and the
 * owner can use POST /verify-email/resend.
 */
async function issueEmailVerification(
  pool: Pool,
  req: AppRequest,
  opts: { tenantId: string; userId: string; email: string }
): Promise<void> {
  const rawToken = randomBytes(32).toString('base64url');
  await withPoolClient(pool, async (client) => {
    await client.query(
      `INSERT INTO email_verifications (tenant_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + ($4 || ' hours')::interval)`,
      [opts.tenantId, opts.userId, hashToken(rawToken), EMAIL_VERIFY_TTL_HOURS]
    );
  });
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://localhost:4000';
  const verifyLink = `${dashboardUrl}/verify-email?token=${rawToken}`;
  void sendEmailVerificationEmail(opts.email, verifyLink, EMAIL_VERIFY_TTL_HOURS).catch(
    (err: unknown) => {
      errorsTotal.inc({ event: 'email_verification_email_failed' });
      req.log.error(
        { err, user_id: opts.userId },
        'email verification email FAILED — the token row exists but the owner never got a link; they can resend from Billing'
      );
    }
  );
}

/**
 * Best-effort request IP for audit trails (e.g. legal_consent_ip below).
 *
 * `x-forwarded-for` is typed `string | string[] | undefined` by Node's
 * IncomingHttpHeaders — most proxies join duplicates into one comma-
 * separated string, but that's a convention, not a guarantee, and a
 * `.split()` on an array would throw. It is also attacker-influenceable
 * (a client or misconfigured proxy can put anything in it), and
 * `legal_consent_ip` is an INET column: a value that isn't a real IP
 * would fail the INSERT and take the whole registration down with it —
 * exactly the kind of "audit trail breaks the main flow" failure this
 * column must never cause. Returns null (never throws) on anything that
 * doesn't parse as a real IPv4/IPv6 address.
 */
export function extractRequestIp(req: AppRequest): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  const candidate = first || req.ip || null;
  return candidate && isIP(candidate) ? candidate : null;
}

/** Best-effort request User-Agent — same array-safety reasoning as above. */
export function extractUserAgent(req: AppRequest): string | null {
  const ua = req.headers['user-agent'];
  return (Array.isArray(ua) ? ua[0] : ua) || null;
}

export function registerAuthRoutes(
  app: AppFastifyInstance,
  pool: Pool,
  generateToken: (payload: {
    tenant_id: string;
    user_id: string;
    email: string;
    role: UserRole;
  }) => string
) {
  app.post(
    '/login',
    { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } },
    withHandler(async (req: AppRequest, reply) => {
      const parsed = LoginSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Invalid email or password format' });
      }
      const { email, password } = parsed.data;
      const user = await withPoolClient(pool, async (client) => {
        // Email is unique per-tenant (users_email_tenant_unique), NOT globally — the
        // same address can legitimately exist on multiple tenants. A bare `rows[0]`
        // with no ORDER BY made login NONDETERMINISTIC across those rows (Postgres
        // returns them in arbitrary order), so the caller could land on a random
        // tenant. Pick the oldest row deterministically and warn so a real
        // multi-tenant collision becomes observable instead of silent.
        // NULLS LAST: created_at is nullable, and a bare ASC sorts NULLs FIRST in
        // Postgres — a legacy row with no created_at would otherwise win the
        // tie-break. user_id ASC is the final deterministic fallback.
        // Soft-deleted tenants cannot log in (2026-07-13). A user whose business was
        // deleted must not get a token: every tenant-scoped route would 404 anyway
        // (createWithTenantClient treats a soft-deleted tenant as not-found), so a
        // session would be a broken shell — and issuing a JWT for a business that no
        // longer exists is exactly the "zombie tenant" failure soft-delete has to
        // avoid. Fail at the door, with the same generic 401 as a bad password, so the
        // response never reveals whether an account existed.
        const res = await client.query(
          `SELECT u.*, t.consent_gate_required, t.legal_consent_attested_at
             FROM users u
             JOIN tenants t ON t.tenant_id = u.tenant_id AND t.is_deleted = false
            WHERE LOWER(u.email) = LOWER($1)
            ORDER BY u.created_at ASC NULLS LAST, u.user_id ASC`,
          [email]
        );
        if (res.rows.length > 1) {
          logWarning(req, 'login_email_multi_tenant', {
            email,
            tenant_count: res.rows.length,
          });
        }
        return res.rows[0];
      });
      if (!user) {
        return reply.status(401).send({ success: false, error: 'Invalid email or password' });
      }
      const bcrypt = await import('bcrypt');
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) {
        return reply.status(401).send({ success: false, error: 'Invalid email or password' });
      }
      // ADMIN-PROVISIONED-TENANT CONSENT GATE. Checked AFTER the password
      // is proven correct — same reasoning as the soft-delete check above:
      // never reveal account state before the credential is proven.
      // consent_gate_required defaults false and is set true ONLY by
      // createTenantWithOwner's admin path (POST /tenants/create); every
      // pre-existing tenant (seed data, self-serve /register tenants,
      // every tenant created before this gate existed) has it false and
      // is completely unaffected — this is the check that must never lock
      // Dale out of his own production account.
      if (user.consent_gate_required === true && user.legal_consent_attested_at === null) {
        return reply.status(403).send({
          success: false,
          error: 'consent_required',
          error_code: 'consent_required',
        });
      }
      const role: UserRole = user.role === 'front_desk' ? 'front_desk' : 'owner';
      const token = generateToken({
        tenant_id: user.tenant_id,
        user_id: user.user_id,
        email: user.email,
        role,
      });
      return reply.send({
        success: true,
        tenant_id: user.tenant_id,
        user_id: user.user_id,
        user_name: user.full_name,
        role,
        token,
        email_verified: user.email_verified_at != null,
      });
    }, 'Login failed')
  );

  // POST /register - Public self-service tenant + user creation
  app.post(
    '/register',
    // Unauthenticated and does real work per call (2 INSERTs, bcrypt hash,
    // consent UPDATE, template-copy RPC) — floodable, and the 409 "account
    // already exists" response is otherwise an unthrottled email-enumeration
    // oracle. Same limit as /login, the other unauthenticated credential route.
    { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } },
    withHandler(async (req: AppRequest, reply) => {
      // Checked first, before validation or any DB work.
      if (!isSignupOpen()) {
        return reply.status(403).send({
          success: false,
          error_code: 'signup_closed',
          error: SIGNUP_CLOSED_MESSAGE,
        });
      }
      const parsed = RegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: 'Validation failed', details: parsed.error.issues });
      }
      const { business_name, business_type, owner_name, password } = parsed.data;
      // One account per email, platform-wide and case-insensitive: store it
      // normalized so Dale@x.com and dale@x.com can never be two accounts.
      const email = parsed.data.email.trim().toLowerCase();

      // Best-effort audit trail for the consent attestation — same
      // x-forwarded-for-first-hop convention as /forgot-password above and
      // consent_records.ip_address. Never blocks registration if absent
      // or malformed (see extractRequestIp).
      const ip = extractRequestIp(req);
      const userAgent = extractUserAgent(req);

      const result = await createTenantWithOwner(pool, {
        tenantName: business_name,
        businessType: business_type,
        ownerEmail: email,
        ownerPassword: password,
        ownerFullName: owner_name,
        duplicateCheck: 'email',
        legalConsent: { ip, userAgent },
      });

      if (!result.ok) {
        return reply.status(409).send({ success: false, error: result.conflictMessage });
      }

      const token = generateToken({
        tenant_id: result.tenantId,
        user_id: result.userId,
        email,
        role: 'owner',
      });

      // Prove the address before anything costs money: checkout (and so the
      // trial and the phone line) stays locked until this link is clicked.
      await issueEmailVerification(pool, req, {
        tenantId: result.tenantId,
        userId: result.userId,
        email,
      });

      return reply.status(201).send({
        success: true,
        tenant_id: result.tenantId,
        user_id: result.userId,
        user_name: owner_name,
        role: 'owner',
        token,
        email_verified: false,
      });
    }, 'Registration failed')
  );

  // POST /auth/refresh - Refresh JWT token (requires valid existing token)
  app.post(
    '/auth/refresh',
    withHandler(async (req: AppRequest, reply) => {
      if (!req.auth) {
        return reply.status(401).send({ success: false, error: 'Authentication required' });
      }
      // Issue a fresh token with the same payload
      const token = generateToken({
        tenant_id: req.auth.tenant_id,
        user_id: req.auth.user_id,
        email: req.auth.email,
        role: req.auth.role,
      });
      return reply.send({ success: true, token });
    }, 'Token refresh failed')
  );

  // POST /forgot-password - Issue a password reset link via email.
  // Always returns 200 (avoid leaking whether the email exists).
  app.post(
    '/forgot-password',
    { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } },
    withHandler(async (req: AppRequest, reply) => {
      const parsed = ForgotSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: 'Invalid email format' });
      }
      const email = parsed.data.email.toLowerCase();
      const user = await withPoolClient(pool, async (client) => {
        const res = await client.query(
          'SELECT user_id FROM users WHERE LOWER(email) = $1 LIMIT 1',
          [email]
        );
        return res.rows[0];
      });
      if (user) {
        const rawToken = randomBytes(32).toString('base64url');
        const tokenHash = hashToken(rawToken);
        const ip =
          (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
          req.ip ||
          null;
        await withPoolClient(pool, async (client) => {
          await client.query(
            `INSERT INTO password_resets (user_id, token_hash, channel, ip, expires_at)
           VALUES ($1, $2, 'email', $3, NOW() + ($4 || ' minutes')::interval)`,
            [user.user_id, tokenHash, ip, RESET_TTL_MINUTES]
          );
        });
        const dashboardUrl = process.env.DASHBOARD_URL || 'https://localhost:4000';
        const resetLink = `${dashboardUrl}/reset-password?token=${rawToken}`;
        // FIRE-AND-FORGET (2026-07-27). This send was AWAITED, and on production
        // the SMTP connection hung: the token row was written, the request never
        // answered (HTTP 000 after 30s), and nothing was logged — because a hang
        // is not an error and the catch below only fires on one. The user is left
        // watching a spinner, and a locked-out owner has no way back in.
        //
        // The token row is already durable at this point, so the response owes
        // the caller nothing further. Same fix, same transport, same failure as
        // the 2026-07-17 job-inquiry email (routes/agentTools/messaging.ts) —
        // that incident named this transport and only one of its two call-site
        // classes got repaired.
        //
        // A failure is now VISIBLE (metric + 5W log) instead of silent. It is
        // still a failure: the user gets no link. That is deliberate — the
        // durable fix is moving off Railway→Gmail SMTP entirely.
        void sendPasswordResetEmail(email, resetLink, RESET_TTL_MINUTES).catch((err: unknown) => {
          errorsTotal.inc({ event: 'password_reset_email_failed' });
          req.log.error(
            { err, email },
            'password reset email FAILED — the token row exists but the user never got a link; they will retry into the 3/hour rate limit'
          );
        });
      }
      return reply.send({ success: true });
    }, 'Forgot password failed')
  );

  // POST /reset-password - Consume a token and set a new password.
  // Force-logs out other sessions by bumping users.password_changed_at.
  app.post(
    '/reset-password',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    withHandler(async (req: AppRequest, reply) => {
      const parsed = ResetSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: 'Invalid request' });
      }
      const { token, new_password } = parsed.data;
      const tokenHash = hashToken(token);
      const result = await withPoolClient(pool, async (client) => {
        await client.query('BEGIN');
        try {
          const r = await client.query(
            `SELECT password_reset_id, user_id FROM password_resets
           WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
           FOR UPDATE`,
            [tokenHash]
          );
          if (r.rows.length === 0) {
            await client.query('ROLLBACK');
            return { invalid: true };
          }
          const { password_reset_id: resetId, user_id: userId } = r.rows[0];
          const bcrypt = await import('bcrypt');
          const hash = await bcrypt.hash(new_password, 10);
          await client.query(
            // Clicking an emailed single-use link proves inbox ownership, so a
            // completed reset also verifies the email (see email_verified_at).
            `UPDATE users SET password_hash = $1, password_changed_at = NOW(),
                    email_verified_at = COALESCE(email_verified_at, NOW())
              WHERE user_id = $2`,
            [hash, userId]
          );
          await client.query(
            'UPDATE password_resets SET used_at = NOW() WHERE password_reset_id = $1',
            [resetId]
          );
          // Invalidate any other unused tokens for the same user
          await client.query(
            'UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
            [userId]
          );
          await client.query('COMMIT');
          return { ok: true };
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      });
      if ('invalid' in result) {
        return reply
          .status(400)
          .send({ success: false, error: 'Reset link is invalid or expired' });
      }
      return reply.send({ success: true });
    }, 'Reset password failed')
  );

  // GET /signup-status - Public: lets the /register page say "not open yet"
  // before someone fills in the form.
  app.get('/signup-status', (_req, reply) => reply.send({ success: true, open: isSignupOpen() }));

  // POST /verify-email - Consume a signup verification token (public: the
  // token itself is the credential, same trust model as /reset-password).
  app.post(
    '/verify-email',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    withHandler(async (req: AppRequest, reply) => {
      const parsed = VerifyEmailSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: 'Invalid request' });
      }
      const tokenHash = hashToken(parsed.data.token);
      const result = await withPoolClient(pool, async (client) => {
        await client.query('BEGIN');
        try {
          const r = await client.query(
            `SELECT email_verification_id, user_id FROM email_verifications
              WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
              FOR UPDATE`,
            [tokenHash]
          );
          if (r.rows.length === 0) {
            await client.query('ROLLBACK');
            return { invalid: true as const };
          }
          const userId = r.rows[0].user_id as string;
          await client.query(
            'UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE user_id = $1',
            [userId]
          );
          // Burn every outstanding link for this user, not just this one.
          await client.query(
            'UPDATE email_verifications SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
            [userId]
          );
          await client.query('COMMIT');
          return { ok: true as const };
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      });
      if ('invalid' in result) {
        return reply
          .status(400)
          .send({ success: false, error: 'This link is invalid or has expired' });
      }
      return reply.send({ success: true });
    }, 'Email verification failed')
  );

  // POST /verify-email/resend - Send a fresh link to the signed-in user.
  app.post(
    '/verify-email/resend',
    { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } },
    withHandler(async (req: AppRequest, reply) => {
      if (!req.auth) {
        return reply.status(401).send({ success: false, error: 'Authentication required' });
      }
      const user = await withPoolClient(pool, async (client) => {
        const res = await client.query(
          'SELECT user_id, tenant_id, email, email_verified_at FROM users WHERE user_id = $1',
          [req.auth!.user_id]
        );
        return res.rows[0];
      });
      if (!user) {
        return reply.status(404).send({ success: false, error: 'User not found' });
      }
      if (user.email_verified_at != null) {
        return reply.send({ success: true, already_verified: true });
      }
      await issueEmailVerification(pool, req, {
        tenantId: user.tenant_id,
        userId: user.user_id,
        email: user.email,
      });
      return reply.send({ success: true, sent_to: user.email });
    }, 'Resend verification failed')
  );
}
