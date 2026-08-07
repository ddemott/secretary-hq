import type { AppFastifyInstance } from '../types/fastify';
import type { Pool } from 'pg';
import { timingSafeEqual } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withHandler, requireSuperAdmin, type AppRequest } from '../middleware';
import { registry as metricsRegistry } from '../services/metrics';
import { runReadinessCheck } from '../readinessHandler';
import { collectFeatureReadinessFromEnv } from '../services/featureReadiness';

// Captured once at module load — the same point the server process first imports
// this module. Exposed via /health so E2E can detect a stale backend binary.
const PROCESS_STARTED_AT = new Date().toISOString();

// Static pages read once (lazily, on first request) then cached — the hot
// path never re-reads the file, and {{DASHBOARD_URL}} is substituted per-request.
// Lazy rather than at module load because the path is dist-relative.
const publicDir = path.resolve(__dirname, '..', '..', '..', 'public');
let landingHtmlCache: string | null = null;
function getLandingHtml(): string {
  if (landingHtmlCache === null) {
    landingHtmlCache = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8');
  }
  return landingHtmlCache;
}

/**
 * Constant-time comparison for a secret arriving over the network. Same shape as
 * the /agent-tools x-agent-secret gate. Length is allowed to leak (negligible
 * next to per-character timing); the bytes are not.
 */
function safeEquals(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function registerHealthRoutes(app: AppFastifyInstance, pool: Pool): void {
  // Public marketing landing page
  app.get('/', async (_req, reply) => {
    const dashboardUrl = process.env.DASHBOARD_URL || 'https://localhost:4000';
    const html = getLandingHtml().replace(/\{\{DASHBOARD_URL\}\}/g, dashboardUrl);
    return reply.type('text/html').send(html);
  });

  // Demo page — redirect to real React dashboard demo (matches live site exactly)
  app.get('/demo', async (_req, reply) => {
    const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:4000';
    return reply.redirect(`${dashboardUrl}/demo`);
  });

  // Liveness: process is up. Intentionally shallow + synchronous — does NOT
  // touch the DB so a transient DB blip can't restart-loop the container.
  // Shape {status, started_at} is pinned by the E2E stale-binary check.
  app.get('/health', () => ({ status: 'ok', started_at: PROCESS_STARTED_AT }));

  // Readiness: pings the DB + reports pool saturation. A monitoring/alerting
  // signal — page on 503 or sustained waiting>0. Not a traffic gate unless
  // Railway's healthcheck path is repointed here.
  app.get('/ready', (_req, reply) => runReadinessCheck(pool, app.log, reply));

  // Prometheus-format metrics scrape. Strict opt-in: 404 when METRICS_TOKEN
  // is unset so a fresh deploy can't expose tenant-keyed counters publicly.
  app.get('/metrics', async (req, reply) => {
    const token = process.env.METRICS_TOKEN;
    if (!token) {
      return reply.status(404).send({ success: false, error: 'Metrics endpoint disabled' });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const auth = req.headers.authorization;
    const provided =
      typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    // Constant-time compare, matching the x-agent-secret hook. `!==` on a
    // NETWORK-SUPPLIED string short-circuits at the first differing byte, which
    // is a genuine (if low-yield) timing oracle: an attacker can recover the
    // token one character at a time. Cheap to close, and the agent secret was
    // hardened against exactly this in 2026-05 — this was the last `!==` left on
    // a secret.
    if (provided === null || !safeEquals(provided, token)) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(metricsRegistry.expose());
  });

  // Admin: structured feature-readiness report — which optional capability is
  // live in THIS process and why not (ready/mocked/disabled/missing_config).
  // Same conditions as the boot warnings (src/services/featureReadiness.ts),
  // evaluated at request time so an env-var change on redeploy is visible
  // immediately. Super-admin only (same gate as /tenants/*); deliberately NOT
  // in PUBLIC_ROUTES — the report enumerates the prod config surface.
  app.get(
    '/admin/feature-readiness',
    withHandler(async (req: AppRequest, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
      return reply.send({ success: true, report: collectFeatureReadinessFromEnv() });
    }, 'Failed to build feature-readiness report')
  );

  // Admin: manually trigger the soft-reservation cleanup RPC. Not tenant-scoped
  // (runs as superuser against the whole DB). Wrapped in withHandler for
  // consistent error logging and errorsTotal ticking.
  app.post(
    '/admin/purge-soft-reservations',
    withHandler(async (_req, reply) => {
      const client = await pool.connect();
      try {
        const res = await client.query('SELECT purge_expired_soft_reservations() as deleted_count');
        const row = res.rows[0] as { deleted_count: number };
        return reply.send({ success: true, deleted_count: row.deleted_count });
      } finally {
        client.release();
      }
    }, 'Failed to purge soft reservations')
  );
}
