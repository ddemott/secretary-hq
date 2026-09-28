/**
 * Demo tenant endpoints.
 *
 * POST /demo/start — public, no auth required.
 *   Provisions an ephemeral Postgres tenant (is_demo=true, TTL=30 min),
 *   seeds it with realistic automotive data, and returns a scoped JWT.
 *
 * POST /demo/reset — requires the demo session's own JWT.
 *   A prospect (or Dale, mid-walkthrough) may have booked/edited/deleted demo
 *   data. Rather than diff and repair it in place (every table a dashboard
 *   click can touch, race against FK/exclusion constraints), this soft-deletes
 *   the caller's current demo tenant and provisions a brand new one — same
 *   provisioning path as /demo/start, so it inherits its safety properties.
 *   The dashboard swaps in the new token/tenant and reloads.
 *
 * Safety properties:
 *   - Tenant ID generated server-side only.
 *   - JWT is never super-admin (role='owner', tenant_id = demo tenant).
 *   - Per-IP rate limit: 3 starts per 15 minutes (shared with /demo/reset).
 *   - Global cap: at most MAX_ACTIVE_DEMO_TENANTS concurrent demo tenants.
 *   - Demo JWT expiry aligns with demo_expires_at (30 min).
 *   - is_demo=true guards outbound SMS / CRM sync in other services.
 *   - /demo/reset refuses any tenant that is not is_demo=true / already
 *     soft-deleted — it can never touch a real business's data.
 */

import type { AppFastifyInstance } from '../types/fastify';
import type { Pool } from 'pg';
import type { UserRole } from '../middleware/fastify-middleware';
import { withHandler, requireAuth } from '../middleware/fastify-middleware';
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

type GenerateTokenFn = (
  payload: {
    tenant_id: string;
    user_id: string;
    email: string;
    role: UserRole;
  },
  expiresIn?: string | number
) => string;

interface ProvisionedDemo {
  token: string;
  tenant_id: string;
  user_id: string;
  expires_at: string;
  ttl_minutes: number;
}

/**
 * Provision a fresh, isolated demo tenant + owner user, seed it, and mint its
 * scoped JWT. Shared by /demo/start (first visit) and /demo/reset (start
 * over) so both routes provision identically — there is exactly one place
 * that decides what a demo tenant looks like on day zero.
 */
async function provisionDemoTenant(
  pool: Pool,
  generateToken: GenerateTokenFn
): Promise<ProvisionedDemo> {
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

  return {
    token,
    tenant_id: tenantId,
    user_id: userId,
    expires_at: expiresAt.toISOString(),
    ttl_minutes: DEMO_TTL_MINUTES,
  };
}

export function registerDemoRoutes(
  app: AppFastifyInstance,
  pool: Pool,
  generateToken: GenerateTokenFn
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

      const provisioned = await provisionDemoTenant(pool, generateToken);
      return reply.send({ success: true, ...provisioned });
    }, 'POST /demo/start failed')
  );

  // POST /demo/reset — "start over" for a visitor already in a demo session.
  // Requires the demo session's own JWT (not public — an anonymous caller has
  // no tenant to reset). Soft-deletes the caller's current demo tenant and
  // provisions a fresh one, exactly like a brand-new /demo/start.
  app.post(
    '/demo/reset',
    withHandler(async (req, reply) => {
      if (!requireAuth(req, reply)) return;
      const callerTenantId = req.auth?.tenant_id;

      const xff = req.headers['x-forwarded-for'];
      const ip = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() ?? req.ip;

      // Shares the /demo/start bucket on purpose — a reset is exactly as
      // expensive to provision (fresh tenant + seed data) as a first start,
      // so the same abuse guard applies.
      if (!checkIpRateLimit(ip)) {
        return reply.status(429).send({
          success: false,
          error: 'Too many demo sessions from this IP. Try again in 15 minutes.',
        });
      }

      // Refuse anything that is not a live demo tenant — this can never touch
      // a real business's data, whatever the caller's JWT claims.
      const tenantRes = await pool.query<{ is_demo: boolean; is_deleted: boolean }>(
        `SELECT is_demo, is_deleted FROM tenants WHERE tenant_id = $1`,
        [callerTenantId]
      );
      const tenantRow = tenantRes.rows[0];
      if (!tenantRow || !tenantRow.is_demo || tenantRow.is_deleted) {
        return reply.status(403).send({
          success: false,
          error: 'Not an active demo session.',
        });
      }

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

      // Retire the old tenant first so it stops counting toward the cap and
      // can never be reused — same soft-delete the expiry reaper uses.
      await pool.query(
        `UPDATE tenants SET is_deleted = true, deleted_at = now() WHERE tenant_id = $1`,
        [callerTenantId]
      );

      const provisioned = await provisionDemoTenant(pool, generateToken);
      return reply.send({ success: true, ...provisioned });
    }, 'POST /demo/reset failed')
  );
}
