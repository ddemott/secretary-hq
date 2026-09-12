/**
 * Live-call cold transfer (SIP REFER).
 *
 * When the caller needs a human, the agent hands the live PSTN leg off the
 * LiveKit room to a real phone (the owner's cell) via
 * `SipClient.transferSipParticipant`. LiveKit sends a SIP REFER back through
 * the inbound trunk, instructing the carrier (Telnyx) to reconnect the caller
 * to `tel:<forwardPhone>`. No separate outbound trunk is required — the REFER
 * rides the existing inbound trunk, which must have call transfer enabled on
 * the provider side.
 *
 * Caller ID on the transferred leg is whatever the trunk is configured with
 * (it can't be set per-transfer through the API), so the owner's phone shows
 * the business/trunk number rather than the original caller — acceptable for
 * the current "ring my cell" use case.
 *
 * This module is intentionally thin and side-effect-isolated so tools.ts stays
 * free of the livekit-server-sdk import and remains unit-testable with a plain
 * mock.
 */
import { SipClient } from 'livekit-server-sdk';

import { getLogger } from './logger.js';
import { reportCallTransferFailed } from './transferReport.js';

export interface TransferDeps {
  /** LiveKit host (the wss:// URL works; the server SDK normalizes it). */
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  /** LiveKit room hosting the live call. */
  roomName: string;
  /** SIP participant identity of the caller leg to transfer. */
  participantIdentity: string;
  /**
   * Backend reporting config, for the fire-and-forget failure/timeout metric
   * (agent/src has no /metrics endpoint of its own — see transferReport.ts).
   * Optional: when absent (e.g. in tests), the report is simply skipped —
   * this must never be the thing that makes a transfer itself fail.
   */
  reportConfig?: { BACKEND_URL: string; AGENT_SECRET: string; tenantId: string };
}

export type TransferResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not_configured' | 'missing_call_context' | 'transfer_failed' | 'transfer_timeout';
    };

/**
 * Hard ceiling on the SIP REFER. `sip.transferSipParticipant` has NO built-in
 * timeout — if Telnyx/the carrier never answers the REFER, the promise never
 * settles, the tool's execute() awaits forever, and the caller hears dead air
 * with no recovery. Bound it so a stuck transfer degrades to "I couldn't
 * connect you — can I take a message?" instead of silence.
 */
const TRANSFER_TIMEOUT_MS = 10_000;

/**
 * Build a transfer executor bound to a single live call. Returns null when the
 * call lacks the room/participant context needed to REFER (e.g. the SIP
 * participant never joined), so the caller can treat transfer as unavailable.
 */
export function createTransferExecutor(
  deps: Partial<TransferDeps>
): ((forwardPhone: string | null) => Promise<TransferResult>) | null {
  const {
    livekitUrl,
    livekitApiKey,
    livekitApiSecret,
    roomName,
    participantIdentity,
    reportConfig,
  } = deps;
  if (!livekitUrl || !livekitApiKey || !livekitApiSecret || !roomName || !participantIdentity) {
    return null;
  }

  const sip = new SipClient(livekitUrl, livekitApiKey, livekitApiSecret);
  const log = getLogger();

  return async (forwardPhone: string | null): Promise<TransferResult> => {
    // Strip everything but digits and a leading '+' so a number entered with
    // spaces/parens (e.g. "+1 608 217 5303") still yields a valid tel: URI —
    // a tel: with embedded whitespace is malformed and the REFER fails. The
    // dashboard normalizes on save, but this is the last line of defense.
    const sanitized = (forwardPhone ?? '').replace(/[^\d+]/g, '');
    if (sanitized.length === 0 || sanitized === '+') {
      return { ok: false, reason: 'not_configured' };
    }
    // tel: URI is the LiveKit cold-transfer form for a PSTN destination.
    const transferTo = `tel:${sanitized}`;
    try {
      // Race the REFER against a timeout — transferSipParticipant has no timeout
      // of its own, so a carrier that never answers would hang the turn forever.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('transfer_timeout')), TRANSFER_TIMEOUT_MS);
      });
      try {
        await Promise.race([
          sip.transferSipParticipant(roomName, participantIdentity, transferTo, {
            // Play a dialtone to the caller while the destination rings so they
            // know the call is being connected rather than sitting in silence.
            playDialtone: true,
          }),
          timeout,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      log.info(
        { event: 'call_transferred', room: roomName, transfer_to: transferTo },
        'live call transferred via SIP REFER'
      );
      return { ok: true };
    } catch (err) {
      const timedOut = err instanceof Error && err.message === 'transfer_timeout';
      const reason: 'transfer_failed' | 'transfer_timeout' = timedOut
        ? 'transfer_timeout'
        : 'transfer_failed';
      log.error(
        {
          event: timedOut ? 'call_transfer_timeout' : 'call_transfer_failed',
          room: roomName,
          transfer_to: transferTo,
          timeout_ms: timedOut ? TRANSFER_TIMEOUT_MS : undefined,
          error_message: err instanceof Error ? err.message : String(err),
        },
        timedOut
          ? `SIP transfer timed out after ${TRANSFER_TIMEOUT_MS}ms — caller stays on the line with the agent`
          : 'SIP transfer failed — caller stays on the line with the agent'
      );
      if (reportConfig) {
        void reportCallTransferFailed(reportConfig, {
          tenantId: reportConfig.tenantId,
          room: roomName,
          reason,
        });
      }
      return { ok: false, reason };
    }
  };
}
