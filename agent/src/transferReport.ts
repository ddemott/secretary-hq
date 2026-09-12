/**
 * Fire-and-forget metric report: tell the backend that a live SIP cold
 * transfer (REFER) failed or timed out. Bumps
 * errors_total{event="call_transfer_failed"|"call_transfer_timeout"} on the
 * backend /metrics board so the transfer FAILURE RATE is observable (and
 * alertable) rather than only visible as a log line — agent/src has no
 * metrics endpoint of its own. Same pattern as dispatchReport.ts.
 *
 * SAFETY CONTRACT: NEVER throws, NEVER blocks the caller. Short timeout, all
 * errors swallowed. The 5W error log at the call site (transferClient.ts) is
 * the primary record; this is the durable counter.
 */
import { ToolsClient } from './toolsClient.js';

export async function reportCallTransferFailed(
  cfg: { BACKEND_URL: string; AGENT_SECRET: string },
  info: { tenantId: string; room: string; reason: 'transfer_failed' | 'transfer_timeout' },
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<void> {
  try {
    const client = new ToolsClient({
      backendUrl: cfg.BACKEND_URL,
      agentSecret: cfg.AGENT_SECRET,
      timeoutMs: 3000,
      fetchImpl: deps.fetchImpl,
    });
    await client.call('/agent-tools/report-call-transfer-failed', {
      tenant_id: info.tenantId,
      room: info.room,
      reason: info.reason,
    });
  } catch {
    // Best-effort metric only; the call-site error log already captured this.
  }
}
