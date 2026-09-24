/**
 * Demo tenant endpoints.
 *
 * POST /demo/start — public, no auth required.
 *   Provisions an ephemeral Postgres tenant (is_demo=true, TTL=30 min),
 *   seeds it with realistic automotive data, and returns a scoped JWT.
 *
 * Safety properties:
 *   - Tenant ID generated server-side only.
 *   - JWT is never super-admin (role='owner', tenant_id = demo tenant).
 *   - Per-IP rate limit: 3 starts per 15 minutes.
 *   - Global cap: at most MAX_ACTIVE_DEMO_TENANTS concurrent demo tenants.
 *   - Demo JWT expiry aligns with demo_expires_at (30 min).
 *   - is_demo=true guards outbound SMS / CRM sync in other services.
 */

import type { AppFastifyInstance } from '../types/fastify';
import type { Pool } from 'pg';
import type { UserRole } from '../middleware/fastify-middleware';
import { withHandler } from '../middleware/fastify-middleware';
import { seedDemoTenant } from '../services/demoSeed';

// Per-IP burst limit for demo provisioning.
const DEMO_RATE_LIMIT_MAX = 3;
const DEMO_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 min

// Maximum concurrent active demo tenants. Keeps the DB from being
// flooded if the rate-limit is bypassed or hits are spread across IPs.
const MAX_ACTIVE_DEMO_TENANTS = 50;

// Demo TTL in minutes.
const DEMO_TTL_MINUTES = 30;

// In-process per-IP store: { ip → count of starts in current window }
// Resets when the process restarts, which is fine — demo rate-limiting
// is a soft DoS guard, not a hard security boundary.
const ipWindowStart = new Map<string, number>();
const ipCount = new Map<string, number>();

function checkIpRateLimit(ip: string): boolean {
  const now = Date.now();
  const windowStart = ipWindowStart.get(ip) ?? 0;
  if (now - windowStart > DEMO_RATE_LIMIT_WINDOW_MS) {
    ipWindowStart.set(ip, now);
    ipCount.set(ip, 1);
    return true; // first request in fresh window
  }
  const count = (ipCount.get(ip) ?? 0) + 1;
  ipCount.set(ip, count);
  return count <= DEMO_RATE_LIMIT_MAX;
}

/** Clear rate-limit state. Only used in tests to prevent cross-test bleed. */
export function resetDemoRateLimitForTesting(): void {
  ipWindowStart.clear();
  ipCount.clear();
}

export function registerDemoRoutes(
  app: AppFastifyInstance,
  pool: Pool,
  // The real minter, injected. It used to be `_generateToken` — passed in and
  // deliberately IGNORED, because it could not take a short expiry and a demo
  // token must die with the demo. So this route hand-rolled its own jwt.sign,
  // and that copy went on to miss the `typ: 'session'` claim (401ing every demo
  // user) and to use a different dev-secret fallback than the verifier. The
  // dependency was here the whole time; it just wasn't usable. It takes an
  // expiry now, so it is.
  generateToken: (
    payload: {
      tenant_id: string;
      user_id: string;
      email: string;
      role: UserRole;
    },
    expiresIn?: string | number
  ) => string
): void {
  // POST /demo/start
  app.post(
    '/demo/start',
    withHandler(async (req, reply) => {
      // Use x-forwarded-for first so we get the real client IP when
      // behind Railway's reverse proxy. Falls back to req.ip for direct
      // connections and local dev.
      const xff = req.headers['x-forwarded-for'];
      const ip = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() ?? req.ip;

      if (!checkIpRateLimit(ip)) {
        return reply.status(429).send({
          success: false,
          error: 'Too many demo sessions from this IP. Try again in 15 minutes.',
        });
      }

      // Global cap check — count non-expired demo tenants.
      const capRes = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM tenants
         WHERE is_demo = true AND demo_expires_at > NOW()`
      );
      const activeCount = parseInt(capRes.rows[0]?.count ?? '0', 10);
      if (activeCount >= MAX_ACTIVE_DEMO_TENANTS) {
        return reply.status(503).send({
          success: false,
          error: 'Demo capacity is full. Please try again in a few minutes.',
        });
      }

      const expiresAt = new Date(Date.now() + DEMO_TTL_MINUTES * 60 * 1000);

      // Provision tenant + owner user in one transaction.
      // Each demo tenant gets its OWN owner address. users.email is unique
      // platform-wide (users_email_lower_unique, 2026-09-24), so a single shared
      // demo login would make the second /demo/start fail. The +<tenant_id> tag
      // keeps every demo address distinct and obviously a demo.
      const provisionRes = await pool.query<{
        tenant_id: string;
        user_id: string;
        email: string;
      }>(
        `WITH new_tenant AS (
           INSERT INTO tenants (name, business_type, timezone, is_demo, demo_expires_at)
           VALUES ('Quick Lube Demo', 'automotive', 'America/Chicago', true, $1)
           RETURNING tenant_id
         ),
         new_user AS (
           INSERT INTO users (tenant_id, email, password_hash, full_name, role)
           SELECT tenant_id,
                  'demo+' || tenant_id || '@quicklubedemo.invalid',
                  -- bcrypt hash of a random 32-char string — no one can log in via password
                  '$2b$10$XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
                  'Demo Owner',
                  'owner'
           FROM new_tenant
           RETURNING tenant_id, user_id, email
         )
         SELECT new_tenant.tenant_id, new_user.user_id, new_user.email
         FROM new_tenant JOIN new_user ON new_tenant.tenant_id = new_user.tenant_id`,
        [expiresAt.toISOString()]
      );

      const { tenant_id: tenantId, user_id: userId, email: demoEmail } = provisionRes.rows[0];

      // Seed business data.
      await seedDemoTenant(pool, { tenantId, userId });

      // Issue a scoped, time-limited JWT. Expiry matches demo_expires_at.
      //
      // Through generateToken — NOT a local jwt.sign. This used to sign inline
      // because generateToken hardcoded JWT_EXPIRY and a demo needs a short life.
      // That copy carried two bugs: it silently missed the `typ: 'session'` claim
      // when that landed (401ing every demo user), and it fell back to a
      // different dev secret than the verifier ('dev-secret' vs
      // 'dev-jwt-secret-change-in-production'), so with no JWT_SECRET set it
      // minted tokens the auth hook could never verify. generateToken takes an
      // expiry now; there is no reason to hand-roll one.
      const ttlSeconds = Math.floor(DEMO_TTL_MINUTES * 60);
      const token = generateToken(
        {
          tenant_id: tenantId,
          user_id: userId,
          email: demoEmail,
          role: 'owner',
        },
        ttlSeconds
      );

      return reply.send({
        success: true,
        token,
        tenant_id: tenantId,
        user_id: userId,
        expires_at: expiresAt.toISOString(),
        ttl_minutes: DEMO_TTL_MINUTES,
      });
    }, 'POST /demo/start failed')
  );
}
