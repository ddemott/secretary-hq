import fs from 'node:fs';
import path from 'node:path';
import type { AppFastifyInstance } from '../types/fastify';
import { withHandler } from '../middleware/fastify-middleware';
import { getPool } from '../database';
import { requireValidUUID } from './routeHelpers';
import {
  startBrowserCallerSession,
  type BrowserCallerSession,
} from '../services/browserCallerSession';

function resolvePublicDir(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'public'),
    path.resolve(__dirname, '..', '..', '..', 'public'),
  ];
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, 'caller-simulator.html')));
  if (!found) {
    throw new Error('caller-simulator.html not found in expected public directories');
  }
  return found;
}

function getCallerSimulatorHtml(): string {
  // Read every request. A cached copy hid the in-page join harness from
  // Playwright after the HTML changed and the backend process stayed up.
  return fs.readFileSync(path.join(resolvePublicDir(), 'caller-simulator.html'), 'utf-8');
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Agent names this PUBLIC route may dispatch to: the configured worker plus the
 * documented local-dev worker (`npm run dev:local`). Anything else is refused —
 * the route spawns a real, billable LiveKit agent session, so a caller must not
 * be able to aim it at an arbitrary worker name.
 */
export function allowedAgentNames(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set([env.AGENT_NAME || 'secretary-hq-agent', 'secretary-hq-agent-dev']);
}

/** A tenant the simulator may call: exists and is not soft-deleted. */
export async function activeTenantExists(tenantId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    'SELECT 1 FROM tenants WHERE tenant_id = $1 AND is_deleted = false',
    [tenantId]
  );
  return (rowCount ?? 0) > 0;
}

export function registerCallerSimulatorRoutes(
  app: AppFastifyInstance,
  startSession: (args: {
    tenantId?: string;
    agentName?: string;
  }) => Promise<BrowserCallerSession> = startBrowserCallerSession,
  tenantExists: (tenantId: string) => Promise<boolean> = activeTenantExists
): void {
  app.get('/call-simulator', async (_req, reply) => {
    return reply.type('text/html').send(getCallerSimulatorHtml());
  });

  app.post(
    '/call-simulator/start',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    withHandler(async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const tenantId = readOptionalString(body.tenant_id);
      const agentName = readOptionalString(body.agent_name);

      if (
        'tenant_id' in body &&
        body.tenant_id !== undefined &&
        typeof body.tenant_id !== 'string'
      ) {
        return reply
          .status(400)
          .send({ success: false, error: 'tenant_id must be a string when provided' });
      }
      if (
        'agent_name' in body &&
        body.agent_name !== undefined &&
        typeof body.agent_name !== 'string'
      ) {
        return reply
          .status(400)
          .send({ success: false, error: 'agent_name must be a string when provided' });
      }

      if (agentName && !allowedAgentNames().has(agentName)) {
        return reply.status(400).send({ success: false, error: 'Unknown agent_name' });
      }
      if (tenantId) {
        if (!requireValidUUID(tenantId, reply, 'tenant_id')) return;
        if (!(await tenantExists(tenantId))) {
          return reply.status(404).send({ success: false, error: 'Tenant not found' });
        }
      }

      const session = await startSession({ tenantId, agentName });
      return reply.send({ success: true, ...session });
    }, 'Failed to start browser caller session')
  );
}
