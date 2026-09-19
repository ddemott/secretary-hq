/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * Same class of dynamic pg-row access as src/routes/auth.ts and src/routes/tenants.ts.
 */

/**
 * Admin-provisioned-tenant consent gate: confirm + resend.
 *
 * Public routes (no JWT — the token itself is the credential, same trust
 * model as /reset-password). See supabase/migrations/20260916000000_
 * tenant_admin_consent_gate.sql and src/services/tenants/bootstrap.ts for
 * how a tenant ends up gated (POST /tenants/create, consent_gate_required
 * = true) and src/routes/tenants.ts for where the invite email that
 * carries this token is sent.
 */

import { createHash } from 'crypto';
import type { AppFastifyInstance } from '../types/fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  withHandler,
  withPoolClient,
  logError,
  type AppRequest,
} from '../middleware/fastify-middleware';
import { errorsTotal } from '../services/metrics';
import { extractRequestIp, extractUserAgent } from './auth';
import {
  sendTenantConsentInviteEmail,
  sendTenantConsentAttestedEmail,
  PLATFORM_ADMIN_EMAIL,
} from '../services/communications/systemEmail';

const CONSENT_INVITE_TTL_DAYS = 14;

const ConfirmSchema = z.object({
  token: z.string().min(20).max(200),
});

const ResendSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function hashConsentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function registerConsentRoutes(app: AppFastifyInstance, pool: Pool) {
  // POST /consent/confirm — consume a consent-invite token and stamp the
  // tenant's legal_consent_* columns. Modeled directly on /reset-password
  // (src/routes/auth.ts): same transaction/row-lock shape, same generic
  // invalid-or-expired error on a miss.
  app.post(
    '/consent/confirm',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    withHandler(async (req: AppRequest, reply) => {
      const parsed = ConfirmSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: 'Invalid request' });
      }
      const { token } = parsed.data;
      const tokenHash = hashConsentToken(token);
      const ip = extractRequestIp(req);
      const userAgent = extractUserAgent(req);

      const result = await withPoolClient(pool, async (client) => {
        await client.query('BEGIN');
        try {
          const r = await client.query(
            `SELECT tci.tenant_consent_invite_id, tci.tenant_id, tci.user_id, u.email AS owner_email
               FROM tenant_consent_invites tci
               JOIN users u ON u.user_id = tci.user_id
              WHERE tci.token_hash = $1 AND tci.used_at IS NULL AND tci.expires_at > NOW()
              FOR UPDATE OF tci`,
            [tokenHash]
          );
          if (r.rows.length === 0) {
            await client.query('ROLLBACK');
            return { invalid: true as const };
          }
          const {
            tenant_consent_invite_id: inviteId,
            tenant_id: tenantId,
            user_id: userId,
            owner_email: ownerEmail,
          } = r.rows[0];

          const tenantRes = await client.query(
            `UPDATE tenants
                SET legal_consent_attested_at = NOW(),
                    legal_consent_attested_by = $1,
                    legal_consent_ip = $2,
                    legal_consent_user_agent = $3
              WHERE tenant_id = $4
              RETURNING name, legal_consent_attested_at`,
            [userId, ip, userAgent, tenantId]
          );
          const businessName = tenantRes.rows[0].name as string;
          const attestedAt = tenantRes.rows[0].legal_consent_attested_at as Date;

          await client.query(
            'UPDATE tenant_consent_invites SET used_at = NOW() WHERE tenant_consent_invite_id = $1',
            [inviteId]
          );

          await client.query('COMMIT');
          return {
            ok: true as const,
            businessName,
            ownerEmail: ownerEmail as string,
            attestedAt,
          };
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

      // Receipt emails — a SECOND, separate pair from the original invite
      // email, sent after the commit so a mail failure can never undo the
      // attestation that already landed. Fire-and-forget, same reasoning
      // as every other system-mail call site in this codebase (an
      // awaited SMTP send hung production once; see /forgot-password).
      const receiptFields = {
        businessName: result.businessName,
        ownerEmail: result.ownerEmail,
        attestedAt: result.attestedAt,
        ip,
        userAgent,
      };
      void sendTenantConsentAttestedEmail(result.ownerEmail, receiptFields, 'owner').catch(
        (err: unknown) => {
          errorsTotal.inc({ event: 'tenant_consent_receipt_owner_email_failed' });
          logError(req, 'tenant_consent_receipt_owner_email_failed', err);
        }
      );
      // Neither env var configured — skip rather than guess an address.
      // The owner's own receipt above already went out regardless.
      if (!PLATFORM_ADMIN_EMAIL) {
        logError(
          req,
          'tenant_consent_receipt_admin_email_failed',
          new Error('PLATFORM_ADMIN_EMAIL and EMAIL_USER both unset — nowhere to send')
        );
      } else {
        void sendTenantConsentAttestedEmail(PLATFORM_ADMIN_EMAIL, receiptFields, 'admin').catch(
          (err: unknown) => {
            errorsTotal.inc({ event: 'tenant_consent_receipt_admin_email_failed' });
            logError(req, 'tenant_consent_receipt_admin_email_failed', err);
          }
        );
      }

      return reply.send({ success: true, business_name: result.businessName });
    }, 'Consent confirmation failed')
  );

  // POST /consent/resend — self-service reissue of the consent-invite
  // email for an owner who never confirmed. Requires the real login
  // password as proof of identity (this route has no JWT to check
  // against). Same rate-limit shape as /forgot-password (the other
  // unauthenticated, account-state-revealing route) and the same
  // always-200 response, so a wrong password, an unknown email, and an
  // already-attested tenant are all indistinguishable from the outside.
  app.post(
    '/consent/resend',
    { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } },
    withHandler(async (req: AppRequest, reply) => {
      const parsed = ResendSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: 'Invalid request' });
      }
      const { email, password } = parsed.data;

      const candidate = await withPoolClient(pool, async (client) => {
        // Same deterministic tie-break as /login: email is unique per-
        // tenant, not globally, so a bare rows[0] would be nondeterministic
        // across tenants sharing an email.
        const res = await client.query(
          `SELECT u.user_id, u.tenant_id, u.password_hash, u.email,
                  t.name AS tenant_name, t.consent_gate_required, t.legal_consent_attested_at
             FROM users u
             JOIN tenants t ON t.tenant_id = u.tenant_id AND t.is_deleted = false
            WHERE u.email = $1
            ORDER BY u.created_at ASC NULLS LAST, u.user_id ASC`,
          [email]
        );
        return res.rows[0];
      });

      if (candidate) {
        const bcrypt = await import('bcrypt');
        const match = await bcrypt.compare(password, candidate.password_hash);
        const eligible =
          match &&
          candidate.consent_gate_required === true &&
          candidate.legal_consent_attested_at === null;

        if (eligible) {
          const { randomBytes } = await import('crypto');
          const rawToken = randomBytes(32).toString('base64url');
          const tokenHash = hashConsentToken(rawToken);

          await withPoolClient(pool, async (client) => {
            // Invalidate any unused prior invites for this tenant so a
            // stale link from an earlier resend can't also confirm.
            await client.query(
              `UPDATE tenant_consent_invites SET used_at = NOW()
                WHERE tenant_id = $1 AND used_at IS NULL`,
              [candidate.tenant_id]
            );
            await client.query(
              `INSERT INTO tenant_consent_invites (tenant_id, user_id, token_hash, expires_at)
               VALUES ($1, $2, $3, NOW() + ($4 || ' days')::interval)`,
              [candidate.tenant_id, candidate.user_id, tokenHash, CONSENT_INVITE_TTL_DAYS]
            );
          });

          const dashboardUrl = process.env.DASHBOARD_URL || 'https://localhost:4000';
          const consentLink = `${dashboardUrl}/consent?token=${rawToken}`;
          void sendTenantConsentInviteEmail(
            candidate.email,
            consentLink,
            candidate.tenant_name
          ).catch((err: unknown) => {
            errorsTotal.inc({ event: 'tenant_consent_resend_email_failed' });
            logError(req, 'tenant_consent_resend_email_failed', err, {
              tenantId: candidate.tenant_id,
            });
          });
        }
      }

      // Always 200 — never reveal whether the email exists, the password
      // was right, or the tenant's gate/attestation state, same posture
      // as /forgot-password.
      return reply.send({ success: true });
    }, 'Consent resend failed')
  );
}
