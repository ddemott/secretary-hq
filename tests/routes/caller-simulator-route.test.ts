import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import { jsonContentTypeParser } from '../../src/jsonContentTypeParser';
import { registerCallerSimulatorRoutes } from '../../src/routes/callerSimulator';

const TENANT = 'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0';

function buildApp(
  startSession = vi.fn(),
  tenantExists = vi.fn(async (id: string) => id === TENANT)
): {
  app: FastifyInstance;
  startSession: ReturnType<typeof vi.fn>;
} {
  const app = Fastify({ logger: false });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, jsonContentTypeParser);
  registerCallerSimulatorRoutes(app as never, startSession as never, tenantExists);
  return { app, startSession };
}

/**
 * WHO: browser caller using the public launcher page
 * WHAT: serve launcher HTML + start a LiveKit-backed caller session safely
 * WHEN: GET /call-simulator and POST /call-simulator/start
 * WHERE: src/routes/callerSimulator.ts
 * WHY: route is public entry point for repeatable browser-based live call testing
 */
describe('caller simulator routes', () => {
  it('serves the browser caller test page', async () => {
    const { app } = buildApp();

    const res = await app.inject({ method: 'GET', url: '/call-simulator' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Start caller session');
    expect(res.body).toContain('Open voice call');
  });

  it('starts a caller session and returns join metadata', async () => {
    const startSession = vi.fn(async () => ({
      join_url:
        'https://meet.livekit.io/custom?liveKitUrl=wss%3A%2F%2Fexample.livekit.cloud&token=abc123',
      livekit_url: 'wss://example.livekit.cloud',
      access_token: 'abc123',
      room: 'sim-call-1750000000000',
      tenant: TENANT,
      agent: 'secretary-hq-agent',
      expires_in_minutes: 30,
    }));
    const { app } = buildApp(startSession);

    const res = await app.inject({
      method: 'POST',
      url: '/call-simulator/start',
      headers: { 'content-type': 'application/json' },
      payload: { tenant_id: TENANT, agent_name: 'secretary-hq-agent' },
    });

    expect(res.statusCode).toBe(200);
    expect(startSession).toHaveBeenCalledWith({
      tenantId: TENANT,
      agentName: 'secretary-hq-agent',
    });
    expect(JSON.parse(res.body)).toMatchObject({
      success: true,
      room: 'sim-call-1750000000000',
      tenant: TENANT,
      agent: 'secretary-hq-agent',
    });
  });

  it('passes through e2e_stub flag when backend uses the caller stub', async () => {
    const startSession = vi.fn(async () => ({
      join_url: 'https://example.invalid/call-simulator-stub?room=sim-call-e2e',
      livekit_url: 'wss://example.invalid/livekit-stub',
      access_token: 'e2e-stub-token',
      room: 'sim-call-e2e',
      tenant: 'tenant-123',
      agent: 'secretary-hq-agent-dev',
      expires_in_minutes: 30,
      e2e_stub: true,
    }));
    const { app } = buildApp(startSession);

    const res = await app.inject({
      method: 'POST',
      url: '/call-simulator/start',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ success: true, e2e_stub: true });
  });

  it('rejects non-string overrides with 400', async () => {
    const { app, startSession } = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/call-simulator/start',
      headers: { 'content-type': 'application/json' },
      payload: { tenant_id: { bad: true } },
    });

    expect(res.statusCode).toBe(400);
    expect(startSession).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toEqual({
      success: false,
      error: 'tenant_id must be a string when provided',
    });
  });

  it('treats blank string overrides as omitted', async () => {
    const startSession = vi.fn(async () => ({
      join_url:
        'https://meet.livekit.io/custom?liveKitUrl=wss%3A%2F%2Fexample.livekit.cloud&token=abc123',
      livekit_url: 'wss://example.livekit.cloud',
      access_token: 'abc123',
      room: 'sim-call-1750000000000',
      tenant: 'tenant-123',
      agent: 'secretary-hq-agent',
      expires_in_minutes: 30,
    }));
    const { app } = buildApp(startSession);

    const res = await app.inject({
      method: 'POST',
      url: '/call-simulator/start',
      headers: { 'content-type': 'application/json' },
      payload: { tenant_id: '   ', agent_name: '' },
    });

    expect(res.statusCode).toBe(200);
    expect(startSession).toHaveBeenCalledWith({ tenantId: undefined, agentName: undefined });
  });

  // SAD: the public route spawns a real, billable agent session — it must not
  // dispatch to an arbitrary worker name or an arbitrary/unknown tenant.
  it('refuses an agent_name that is not the configured or local-dev worker', async () => {
    const { app, startSession } = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/call-simulator/start',
      headers: { 'content-type': 'application/json' },
      payload: { agent_name: 'someone-elses-worker' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ success: false, error: 'Unknown agent_name' });
    expect(startSession).not.toHaveBeenCalled();
  });

  it('accepts the local-dev worker name', async () => {
    const startSession = vi.fn(async () => ({
      room: 'r',
      tenant: TENANT,
      agent: 'secretary-hq-agent-dev',
    }));
    const { app } = buildApp(startSession);

    const res = await app.inject({
      method: 'POST',
      url: '/call-simulator/start',
      headers: { 'content-type': 'application/json' },
      payload: { agent_name: 'secretary-hq-agent-dev' },
    });

    expect(res.statusCode).toBe(200);
    expect(startSession).toHaveBeenCalledWith({
      tenantId: undefined,
      agentName: 'secretary-hq-agent-dev',
    });
  });

  it('refuses a tenant_id that is not a UUID', async () => {
    const { app, startSession } = buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/call-simulator/start',
      headers: { 'content-type': 'application/json' },
      payload: { tenant_id: 'tenant-123' },
    });

    expect(res.statusCode).toBe(400);
    expect(startSession).not.toHaveBeenCalled();
  });

  it('refuses an unknown or deleted tenant with 404', async () => {
    const tenantExists = vi.fn(async () => false);
    const { app, startSession } = buildApp(vi.fn(), tenantExists);

    const res = await app.inject({
      method: 'POST',
      url: '/call-simulator/start',
      headers: { 'content-type': 'application/json' },
      payload: { tenant_id: '11111111-2222-4333-8444-555555555555' },
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ success: false, error: 'Tenant not found' });
    expect(tenantExists).toHaveBeenCalledWith('11111111-2222-4333-8444-555555555555');
    expect(startSession).not.toHaveBeenCalled();
  });
});
