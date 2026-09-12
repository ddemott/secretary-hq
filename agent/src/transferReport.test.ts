import { describe, it, expect, vi } from 'vitest';
import { reportCallTransferFailed } from './transferReport.js';

// The fire-and-forget SIP-transfer-failure metric report. Verifies it POSTs
// to the right backend route with the agent secret and reason, and —
// critically — NEVER throws, so a metric hiccup can't affect the caller's
// experience beyond the transfer already having failed.
const CFG = { BACKEND_URL: 'https://backend.test', AGENT_SECRET: 's'.repeat(32) };

function okFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: { recorded: true } }),
  });
}

describe('reportCallTransferFailed', () => {
  it('POSTs to the report route with the agent secret, tenant, room, and reason', async () => {
    const fetchImpl = okFetch();
    await reportCallTransferFailed(
      CFG,
      { tenantId: 'tenant-1', room: 'room:call-_123', reason: 'transfer_failed' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://backend.test/agent-tools/report-call-transfer-failed');
    expect(init.method).toBe('POST');
    expect(init.headers['x-agent-secret']).toBe(CFG.AGENT_SECRET);
    expect(JSON.parse(init.body)).toEqual({
      tenant_id: 'tenant-1',
      room: 'room:call-_123',
      reason: 'transfer_failed',
    });
  });

  it('carries the timeout reason distinctly from a hard failure', async () => {
    const fetchImpl = okFetch();
    await reportCallTransferFailed(
      CFG,
      { tenantId: 'tenant-1', room: 'r', reason: 'transfer_timeout' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).reason).toBe('transfer_timeout');
  });

  it('SAD: never throws when the backend POST rejects (metric is best-effort)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('backend down'));
    await expect(
      reportCallTransferFailed(
        CFG,
        { tenantId: 'tenant-1', room: 'r', reason: 'transfer_failed' },
        { fetchImpl: fetchImpl as unknown as typeof fetch }
      )
    ).resolves.toBeUndefined();
  });
});
