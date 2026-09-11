/**
 * Compose the capability tool modules, wrap every execute with the
 * never-freeze contract, and filter by requested capabilities.
 */
import type { SessionContext } from '../sessionContext.js';
import type { ToolResponse, ToolsClient } from '../toolsClient.js';
import type { CallOutcomeTracker } from '../callOutcome.js';
import type { CallPhase } from '../toolPhases.js';
import { wrapToolExecute } from './wrapTool.js';
import { getLogger } from '../logger.js';
import { formatResponse } from './helpers.js';
import { CAPABILITY_OF, type Capability, type ToolMap, type TransferCapability } from './types.js';
import type { ToolBuildDeps } from './deps.js';
import { knowledgeTools } from './knowledge.js';
import { messagingTools } from './messaging.js';
import { identityTools } from './identity.js';
import { schedulingTools } from './scheduling.js';
import { verificationTools } from './verification.js';
import { transferTools } from './transfer.js';
import { smsTools } from './sms.js';

export function buildTools(
  ctx: SessionContext,
  client: ToolsClient,
  transfer?: TransferCapability,
  outcome?: CallOutcomeTracker,
  speakFiller?: (phrase: string) => void,
  opts?: {
    capabilities?: readonly Capability[];
    onPhaseChange?: (phase: CallPhase) => void | Promise<void>;
  }
): ToolMap {
  const hasVerification = !opts?.capabilities || opts.capabilities.includes('verification');
  // Same source of truth as every other capability: index.ts drops 'sms' from
  // activeCapabilities when ENABLE_SMS is off, so the booking tool's reminder
  // parameter can describe itself honestly instead of inviting a promise the
  // platform cannot keep (2026-09-09, two callers told a text was coming).
  const smsEnabled = !opts?.capabilities || opts.capabilities.includes('sms');

  const gateVerificationAdvice = (res: ToolResponse): string => {
    if (
      !hasVerification &&
      res.ok &&
      res.result !== null &&
      typeof res.result === 'object' &&
      (res.result as Record<string, unknown>).requires_verification === true
    ) {
      return JSON.stringify({
        requires_verification: true,
        message:
          'A saved account cannot be opened on this call, and that is fine — treat the caller as NEW. Continue with the name and number they gave you (book, take a message, or answer their question), and do not retry this lookup on this call.',
      });
    }
    return formatResponse(res);
  };

  const canOfferTransfer =
    (!opts?.capabilities || opts.capabilities.includes('transfer')) &&
    !!transfer?.forwardPhone &&
    !!transfer?.execute;
  const transferOrMessage = canOfferTransfer ? 'transfer or take a message' : 'take a message';

  const routeTo = (phase: CallPhase, reply: string): Promise<string> => {
    // DEFER THE SWAP. Do not mutate the toolset from inside a tool's own execute().
    // setTimeout(0) is a MACROTASK — microtasks still run "inside" execute.
    setTimeout(() => {
      void (async () => {
        try {
          await opts?.onPhaseChange?.(phase);
        } catch {
          /* a failed swap must never break the call */
        }
      })();
    }, 0);
    return Promise.resolve(JSON.stringify({ ok: true, next: reply }));
  };

  const d: ToolBuildDeps = {
    ctx,
    client,
    transfer,
    outcome,
    speakFiller,
    hasVerification,
    smsEnabled,
    canOfferTransfer,
    transferOrMessage,
    gateVerificationAdvice,
    routeTo,
  };

  const allTools: ToolMap = {
    ...knowledgeTools(d),
    ...messagingTools(d),
    ...identityTools(d),
    ...schedulingTools(d),
    ...verificationTools(d),
    ...transferTools(d),
    ...smsTools(d),
  };

  const wanted = opts?.capabilities;
  const result: ToolMap = {};
  for (const [name, ft] of Object.entries(allTools)) {
    const cap = CAPABILITY_OF[name];
    if (wanted && (cap === undefined || !wanted.includes(cap))) continue;
    const mutable = ft as unknown as { execute: (args: never, opts: never) => Promise<unknown> };
    mutable.execute = wrapToolExecute(name, mutable.execute, {
      onError: ({ tool, reason, error }) =>
        getLogger().warn(
          {
            event: 'tool_contract_fallback',
            tool,
            reason,
            error_message: error instanceof Error ? error.message : undefined,
          },
          `tool ${tool} ${reason} — returned a graceful fallback so the caller is not left in silence`
        ),
      onCall: ({ tool, ok, durationMs, resultPreview }) =>
        getLogger().info(
          {
            event: 'tool_call',
            tool,
            ok,
            duration_ms: durationMs,
            tenant_id: ctx.tenantId,
            call_id: ctx.callId,
            result_preview: resultPreview,
          },
          `tool_call ${tool} ${ok ? 'ok' : 'FAILED'} in ${durationMs}ms`
        ),
    });
    result[name] = ft;
  }
  return result;
}
