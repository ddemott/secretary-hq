/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

import 'dotenv/config';
// Initialize Sentry BEFORE other imports so an early bootstrap error
// (a module-load throw, a malformed env var) still gets captured.
// No-op when SENTRY_DSN is unset — local dev / tests don't phone home.
import { initSentry, captureException as captureSentry } from './services/sentry';
initSentry({ service: 'secretary-hq-backend' });
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { collectStartupWarnings } from './services/envWarnings';
import multipart from '@fastify/multipart';
import { getPool, closePool, createWithTenantClient } from './database';
import { jsonContentTypeParser } from './jsonContentTypeParser';
import { buildLogger } from './services/logger';
import { httpRequestsTotal, httpRequestDurationMs, errorsTotal } from './services/metrics';
import fs from 'node:fs';
import path from 'node:path';
import { resolveLocalHttpsCertDir } from './localHttpsCerts';

import { registerAuthRoutes } from './routes/auth';
import { registerTenantRoutes } from './routes/tenants';
import { registerAppointmentRoutes } from './routes/appointments';
import { registerCustomerRoutes } from './routes/customers';
import { registerEmployeeRoutes } from './routes/employees';
import { registerUserRoutes } from './routes/users';
import { registerShiftRoutes } from './routes/shifts';
import { registerResourceRoutes } from './routes/resources';
import { registerServiceRoutes } from './routes/services';
import { registerMappingRoutes } from './routes/mappings';
import { registerSkillRoutes } from './routes/skills';
import { registerCalendarRoutes } from './routes/calendar';
import { registerKnowledgeRoutes } from './routes/knowledge';
import { registerAnalyticsRoutes } from './routes/analytics';
import { registerSetupRoutes } from './routes/setup';
import { registerVocabularyRoutes } from './routes/vocabulary';
import { registerBillingRoutes, subscriptionGate } from './routes/billing';
import { registerProvisioningRoutes } from './routes/provisioning';
import { registerSquareRoutes } from './routes/square';
import { registerAgentToolRoutes } from './routes/agentTools/index';
import { registerDemoRoutes } from './routes/demo';
import { registerVoiceRoutes } from './routes/voice';
import { registerVersionHistoryRoutes } from './routes/versionHistory';
import { registerCommunicationRoutes } from './routes/communications';
import { registerReminderRoutes } from './routes/reminders';
import { registerHealthRoutes } from './routes/health';
import { registerCallerSimulatorRoutes } from './routes/callerSimulator';
import { registerSelfServiceRoutes } from './routes/selfService';
import { registerExportRoutes } from './routes/exportData';
import { registerAuditLogRoutes } from './routes/auditLog';
import { TelnyxNumbersClient } from './services/telnyxNumbers';
import { buildStubTelnyxProvisioning } from './services/telnyxNumbersStub';
import { workerEnabled } from './services/workerEnabled';
import { startReminderScheduler, stopReminderScheduler } from './workers/reminderScheduler';
import { startVoiceSessionReaper, stopVoiceSessionReaper } from './workers/voiceSessionReaper';
import { startScheduleExtender, stopScheduleExtender } from './workers/scheduleExtender';
import {
  startWebsiteRescanScheduler,
  stopWebsiteRescanScheduler,
} from './workers/websiteRescanScheduler';
import { createGetEmbedding } from '../shared/getEmbedding';
import { createNormalizer } from '../shared/normalizeForEmbedding';
import { createQueryExpander } from '../shared/expandQueryForEmbedding';
import {
  tenantMiddleware,
  generateToken,
  registerJwtAuthHook,
} from './middleware/fastify-middleware';
import { collectFeatureReadiness } from './services/featureReadiness';

// --- Environment Validation ---
// Fail fast on missing required env vars in production
const isProduction = process.env.NODE_ENV === 'production';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || '';
const TELNYX_SIP_CONNECTION_ID = process.env.TELNYX_SIP_CONNECTION_ID || '';

if (isProduction) {
  const missing: string[] = [];
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (!OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!process.env.STRIPE_SECRET_KEY) missing.push('STRIPE_SECRET_KEY');
  if (missing.length > 0) {
    console.error(`FATAL: Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
  // Warn for optional-but-important vars. Logic lives in envWarnings.ts
  // so the warning list is testable without booting the full server.
  for (const warning of collectStartupWarnings({
    env: process.env,
    TELNYX_API_KEY,
    TELNYX_SIP_CONNECTION_ID,
  })) {
    console.warn(`WARNING: ${warning}`);
  }
}

const getEmbedding = createGetEmbedding(OPENAI_API_KEY);
const normalizeForEmbedding = createNormalizer(OPENAI_API_KEY);
const expandQueryForEmbedding = createQueryExpander(OPENAI_API_KEY);

// --- Server Setup ---

// HTTPS for local dev (mkcert-trusted localhost certs); plain HTTP in
// production (TLS terminated at the Railway proxy) and in CI, where the rest
// of the E2E stack — wait-on, the dashboard's NEXT_PUBLIC_API_URL, Playwright —
// all speak http://localhost:4001. CI sets USE_HTTPS=false so the backend
// doesn't boot TLS the self-signed cert nobody else in the job trusts.
const useHttps = process.env.NODE_ENV !== 'production' && process.env.USE_HTTPS !== 'false';
const certDir = resolveLocalHttpsCertDir(__dirname);
const logger = buildLogger({ service: 'secretary-hq-backend' });
const app = Fastify(
  (useHttps
    ? {
        loggerInstance: logger,
        https: {
          key: fs.readFileSync(path.join(certDir, 'localhost-key.pem')),
          cert: fs.readFileSync(path.join(certDir, 'localhost-cert.pem')),
        },
      }
    : { loggerInstance: logger }) as any
);

// Enforce HTTPS when behind a proxy
app.addHook('onRequest', async (request, reply) => {
  const protoHeader = request.headers['x-forwarded-proto'];
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
  if (proto && proto !== 'https') {
    const hostHeader = request.headers['host'];
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    if (host) {
      const url = `https://${host}${request.raw.url}`;
      return reply.redirect(url);
    }
  }
});

void app.register(helmet, {
  contentSecurityPolicy: false, // CSP managed by frontend framework
});

void app.register(cors, {
  origin: process.env.CORS_ORIGIN || true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
});

void app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  allowList: ['127.0.0.1', '::1'],
});

void app.register(multipart, {
  limits: { fileSize: 10 * 1024 * 1024 },
});

// --- Raw Body Preservation for Stripe Webhooks ---
// Stripe signature verification requires the raw request body.
// This content-type parser preserves the raw buffer for webhook routes and
// parses JSON via done(). See src/jsonContentTypeParser.ts for the why
// (and the unit test that pins the done()-callback contract).
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, jsonContentTypeParser);

// --- Database Pool ---
// Single shared pool (see src/database/index.ts) — same instance is used by
// every Fastify route, the reminder scheduler, and the communications
// service, so deadlock-prevention timeouts apply everywhere. RLS is
// enforced via FORCE ROW LEVEL SECURITY on all tables + set_tenant_context()
// GUC. Works on both local Docker and Supabase.

const pool = getPool();
const withTenantClient = createWithTenantClient(pool);

// --- Auth + Tenant Middleware ---
registerJwtAuthHook(app, pool);
tenantMiddleware(app);

// --- Subscription Gate (after auth, before routes) ---
app.addHook('onRequest', subscriptionGate(pool));

// --- HTTP request metrics ---
// onResponse fires after the body has been sent, so reply.statusCode is
// final and the request->response lifecycle latency is fully measured.
// We label by the route's PATTERN (req.routerPath, e.g. /appointments/:id)
// rather than the rendered URL (/appointments/abc-123) — otherwise label
// cardinality grows once-per-id and the cap kicks in within minutes.
// Skip /health (constant traffic from k8s/Railway, no signal) and
// /metrics itself (recursive scrape contamination).
const METRICS_SKIP_PATTERNS = new Set(['/health', '/ready', '/metrics']);
app.addHook('onResponse', async (req, reply) => {
  const routePattern = (req as unknown as { routerPath?: string }).routerPath ?? req.url;
  if (METRICS_SKIP_PATTERNS.has(routePattern)) return;
  const status = reply.statusCode;
  const statusFamily = `${Math.floor(status / 100)}xx`; // 2xx, 4xx, 5xx — keeps cardinality sane
  const labels = { route: routePattern, method: req.method, status: statusFamily };
  httpRequestsTotal.inc(labels);
  // reply.elapsedTime is Fastify's internal millisecond-resolution timer
  const elapsed = (reply as unknown as { elapsedTime?: number }).elapsedTime;
  if (typeof elapsed === 'number' && Number.isFinite(elapsed)) {
    httpRequestDurationMs.observe(elapsed, labels);
  }
});

// --- Global Error Handler ---
app.setErrorHandler(
  (
    error: Error & { statusCode?: number; code?: string },
    _request: unknown,
    reply: { status: (code: number) => { send: (body: Record<string, unknown>) => void } }
  ) => {
    const statusCode = error.statusCode || 500;
    const code = error.code;
    if (code === 'TENANT_NOT_FOUND') {
      return reply
        .status(404)
        .send({ success: false, error: error.message, code: 'TENANT_NOT_FOUND' });
    }
    app.log.error(
      {
        event: 'unhandled_error',
        error_message: error.message,
        error_code: code || null,
        error_stack: error.stack?.split('\n').slice(0, 5).join('\n'),
        statusCode,
        timestamp: new Date().toISOString(),
      },
      `unhandled_error: ${error.message}`
    );
    errorsTotal.inc({ event: 'unhandled_error' });
    // Forward unhandled errors to Sentry. logError() in middleware.ts
    // already captures errors routed through withHandler; the
    // setErrorHandler path catches everything else (Fastify-internal
    // errors, plugin throws, etc.). No-op when SENTRY_DSN unset.
    captureSentry(error, { event: 'unhandled_error', statusCode });
    return reply
      .status(statusCode)
      .send({ success: false, error: error.message || 'Internal server error' });
  }
);

// --- Register Route Modules ---

registerHealthRoutes(app, pool);
registerCallerSimulatorRoutes(app);
registerAuthRoutes(app, pool, generateToken);
registerTenantRoutes(app, pool, withTenantClient);
registerAppointmentRoutes(app, pool, withTenantClient);
registerCustomerRoutes(app, pool, withTenantClient);
registerEmployeeRoutes(app, pool, withTenantClient);
registerUserRoutes(app, pool, withTenantClient);
registerShiftRoutes(app, pool, withTenantClient);
registerResourceRoutes(app, pool, withTenantClient);
registerServiceRoutes(app, pool, withTenantClient);
registerMappingRoutes(app, pool, withTenantClient);
registerSkillRoutes(app, pool, withTenantClient);
registerCalendarRoutes(app, pool, withTenantClient);
registerKnowledgeRoutes(
  app,
  pool,
  getEmbedding,
  withTenantClient,
  normalizeForEmbedding,
  expandQueryForEmbedding
);
registerAnalyticsRoutes(app, pool, withTenantClient);
registerSetupRoutes(app, pool, withTenantClient);
registerVocabularyRoutes(app, pool, withTenantClient);
registerBillingRoutes(app, pool);

// PROVISIONING_E2E_STUB: lets the provisioning routes stay "configured" (past
// the `if (!telnyx) return 503` guard) with zero real Telnyx credentials, so
// E2E can exercise the real activate/deactivate state machine + DB update
// path. activatePhone() itself short-circuits before calling telnyx.client
// when the stub is active (see provisioningService.ts); this stub client
// exists so any OTHER path that touches it (e.g. deactivatePhone's release())
// degrades to a safe no-op instead of a doomed real HTTP call.
const telnyxProvisioning =
  TELNYX_API_KEY && TELNYX_SIP_CONNECTION_ID
    ? { client: new TelnyxNumbersClient(TELNYX_API_KEY), sipConnectionId: TELNYX_SIP_CONNECTION_ID }
    : process.env.PROVISIONING_E2E_STUB === '1'
      ? buildStubTelnyxProvisioning()
      : null;
registerProvisioningRoutes(app, pool, telnyxProvisioning);
registerSquareRoutes(app, pool, withTenantClient);
registerVoiceRoutes(app, pool, withTenantClient);
registerVersionHistoryRoutes(app, pool, withTenantClient);
registerCommunicationRoutes(app, pool, withTenantClient);
registerReminderRoutes(app, pool, withTenantClient);
registerAgentToolRoutes(
  app,
  pool,
  withTenantClient,
  getEmbedding,
  normalizeForEmbedding,
  expandQueryForEmbedding
);
registerDemoRoutes(app, pool, generateToken);
registerSelfServiceRoutes(app, withTenantClient);
registerExportRoutes(app, pool, withTenantClient);
registerAuditLogRoutes(app, pool, withTenantClient);

// --- Start Reminder Scheduler ---
// Prod: on unless ENABLE_REMINDER_SCHEDULER=false. Elsewhere: off unless =true.
if (workerEnabled(process.env.ENABLE_REMINDER_SCHEDULER, isProduction)) {
  startReminderScheduler();
}

// --- Start Voice Session Reaper ---
// Backstop that finalizes calls the agent never closed (so every call has a
// record). Same gating as the reminder scheduler.
if (workerEnabled(process.env.ENABLE_VOICE_SESSION_REAPER, isProduction)) {
  startVoiceSessionReaper();
}

// --- Start Schedule Extender ---
// Keeps every employee's calendar topped up to a rolling horizon (default 180
// days; SCHEDULE_HORIZON_DAYS overrides). WITHOUT THIS A BUSINESS QUIETLY BECOMES UNBOOKABLE: employee_schedule
// holds one row per DATE, not a recurring rule, so the window the Setup wizard
// fanned out shrinks by a day, every day. Thinking Hammer's ran out on
// 2026-08-19 and a real caller was told "no one is scheduled that day" for a
// normal Wednesday inside the owner's normal hours (2026-07-12). Same gating as
// the other two workers.
if (workerEnabled(process.env.ENABLE_SCHEDULE_EXTENDER, isProduction)) {
  startScheduleExtender();
}

// --- Start Website Re-scan Scheduler ---
// Re-runs website knowledge import for tenants whose last successful scan is
// older than WEBSITE_RESCAN_STALE_DAYS (default 30), capped at
// WEBSITE_RESCAN_BATCH_SIZE (default 5) per daily tick. Stages suggestions only
// — never auto-publishes. Same gating as the other workers.
if (workerEnabled(process.env.ENABLE_WEBSITE_RESCAN_SCHEDULER, isProduction)) {
  startWebsiteRescanScheduler();
}

// --- Feature-readiness boot report ---
// One structured line (not 12 warns) naming each optional capability's status
// (ready/mocked/disabled/missing_config). Same conditions as the prod-only
// WARNINGs above — shared source of truth in src/services/featureReadiness.ts,
// also served live at GET /admin/feature-readiness (super-admin). Emitted in
// every environment so a local boot shows the same shape prod does.
// Log directly via the app logger (mirrors logEvent's {event, ...data} shape)
// — no fake AppRequest, so this can't break if logEvent grows beyond req.log.
app.log.info(
  {
    event: 'feature_readiness_report',
    report: collectFeatureReadiness({
      env: process.env,
      TELNYX_API_KEY,
      TELNYX_SIP_CONNECTION_ID,
    }),
  },
  'feature_readiness_report'
);

// --- Start Server ---

const port = Number(process.env.PORT || 4001);

/**
 * Say out loud whether RLS is actually enforced for the role we connect as.
 *
 * Production connects as a role with rolbypassrls = true (found 2026-07-13), so
 * every RLS policy in this database is INERT and tenant isolation rests entirely
 * on tenantMiddleware. FORCE ROW LEVEL SECURITY does not override BYPASSRLS, and
 * local/CI connect as a superuser — which also bypasses — so no test in this repo
 * could ever have caught it, and none did.
 *
 * This does not fix it (that is a staged role migration with a landmine under it;
 * see readinessHandler.ts). It refuses to let it stay invisible. The 2026-05-21
 * anonymous-tenant hole was survivable precisely BECAUSE someone believed RLS was
 * a second layer. It is not, and everyone reading these logs should know that.
 */
async function reportRlsPosture(): Promise<void> {
  try {
    const { rows } = await getPool().query<{ bypasses: boolean; role: string }>(
      `SELECT rolbypassrls OR rolsuper AS bypasses, rolname AS role
         FROM pg_roles WHERE rolname = current_user`
    );
    const row = rows[0];
    if (!row) return;
    if (row.bypasses) {
      errorsTotal.inc({ event: 'rls_not_enforced' });
      console.warn(
        JSON.stringify({
          event: 'rls_not_enforced',
          level: 'warn',
          db_role: row.role,
          reason:
            'the DB role this app connects as has BYPASSRLS (or is superuser), so every RLS policy is inert — FORCE ROW LEVEL SECURITY does NOT override it',
          impact:
            'tenant isolation rests ENTIRELY on tenantMiddleware; there is no database-level second layer, despite what CLAUDE.md and docs/SECURITY.md claim',
          fix: "connect as a non-superuser, non-BYPASSRLS role — but FIRST change every admin_bypass policy from `current_setting(...) = ''` to `coalesce(current_setting(...), '') = ''`, or getDueReminders() returns zero rows on a cold connection and ALL reminders silently stop",
        })
      );
    } else {
      console.log(
        JSON.stringify({ event: 'rls_enforced', db_role: row.role, msg: 'RLS is enforced' })
      );
    }
  } catch {
    // Never block startup on a diagnostic.
  }
}

app
  .listen({ port, host: '0.0.0.0' })
  .then(async () => {
    app.log.info(`Server listening on port ${port}`);
    await reportRlsPosture();
  })
  .catch((err) => {
    app.log.error(
      {
        event: 'server_startup_failed',
        error_message: (err as Error).message,
        error_stack: (err as Error).stack?.split('\n').slice(0, 5).join('\n'),
        port,
        timestamp: new Date().toISOString(),
      },
      `server_startup_failed: ${(err as Error).message}`
    );
    process.exit(1);
  });

// Graceful shutdown — Railway sends SIGTERM during deploys
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    app.log.info(`Received ${signal}, shutting down...`);
    await stopReminderScheduler();
    stopVoiceSessionReaper();
    stopScheduleExtender();
    stopWebsiteRescanScheduler();
    await app.close();
    await closePool();
    process.exit(0);
  });
}
