/**
 * Tests for the live-call cold-transfer executor.
 *
 * WHO: the agent when a caller needs a human (owner's cell).
 * WHAT: createTransferExecutor builds a SipClient-backed closure that SIP-REFERs
 *        the caller leg to tel:<forwardPhone>, mapping success/failure to a
 *        typed result the transfer_call tool turns into LLM guidance.
 * WHEN: once per dispatched SIP call, only when the caller asks to be connected.
 * WHERE: agent/src/transferClient.ts → livekit-server-sdk SipClient.
 * WHY: a transfer that throws must NOT bubble into dead air — it has to degrade
 *        to "take a message", so the failure path is the critical coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK so no real LiveKit call is made. The mock's
// transferSipParticipant is reconfigured per-test to resolve or reject.
const transferSipParticipant = vi.fn();
vi.mock('livekit-server-sdk', () => ({
  // Class (not an arrow fn) so `new SipClient(...)` is a valid constructor.
  SipClient: class {
    transferSipParticipant = transferSipParticipant;
  },
}));

// The fire-and-forget backend-report call — mocked so failure tests can
// assert on it without a real network call.
const mockReportCallTransferFailed = vi.fn().mockResolvedValue(undefined);
vi.mock('./transferReport.js', () => ({
  reportCallTransferFailed: (...args: unknown[]) => mockReportCallTransferFailed(...args),
}));

import { createTransferExecutor } from './transferClient.js';

const FULL_DEPS = {
  livekitUrl: 'wss://example.livekit.cloud',
  livekitApiKey: 'key',
  livekitApiSecret: 'secret',
  roomName: 'sip-room-1',
  participantIdentity: 'sip_caller_1',
};

describe('createTransferExecutor', () => {
  beforeEach(() => {
    transferSipParticipant.mockReset();
    mockReportCallTransferFailed.mockClear();
  });

  it('SAD: returns null when any LiveKit/call dep is missing', () => {
    // WHAT: no creds or no participant identity ⇒ transfer is impossible; the
    //        executor is null so transfer_call reports "not available".
    expect(createTransferExecutor({})).toBeNull();
    expect(createTransferExecutor({ ...FULL_DEPS, participantIdentity: undefined })).toBeNull();
    expect(createTransferExecutor({ ...FULL_DEPS, livekitApiKey: '' })).toBeNull();
  });

  it('SAD: configured executor but null/blank forward number → not_configured', async () => {
    const exec = createTransferExecutor(FULL_DEPS);
    expect(exec).not.toBeNull();
    expect(await exec!(null)).toEqual({ ok: false, reason: 'not_configured' });
    expect(await exec!('   ')).toEqual({ ok: false, reason: 'not_configured' });
    // Never touched the SDK — bailed before the REFER.
    expect(transferSipParticipant).not.toHaveBeenCalled();
  });

  it('HAPPY: REFERs to tel:<forward> and returns ok', async () => {
    transferSipParticipant.mockResolvedValueOnce(undefined);
    const exec = createTransferExecutor(FULL_DEPS);
    const result = await exec!('+16082175303');
    expect(result).toEqual({ ok: true });
    expect(transferSipParticipant).toHaveBeenCalledWith(
      'sip-room-1',
      'sip_caller_1',
      'tel:+16082175303',
      { playDialtone: true }
    );
  });

  it('HAPPY: a number with spaces/parens is sanitized into a valid tel: URI', async () => {
    // WHY: the dashboard placeholder invites "+1 608 217 5303"; a tel: URI with
    //       embedded whitespace is malformed and the REFER fails. Strip to E.164.
    transferSipParticipant.mockResolvedValueOnce(undefined);
    const exec = createTransferExecutor(FULL_DEPS);
    const result = await exec!('+1 (608) 217-5303');
    expect(result).toEqual({ ok: true });
    expect(transferSipParticipant).toHaveBeenCalledWith(
      'sip-room-1',
      'sip_caller_1',
      'tel:+16082175303',
      { playDialtone: true }
    );
  });

  it('SAD: SDK throws → transfer_failed (degrades to take-a-message)', async () => {
    transferSipParticipant.mockRejectedValueOnce(new Error('REFER rejected by trunk'));
    const exec = createTransferExecutor(FULL_DEPS);
    const result = await exec!('+16082175303');
    expect(result).toEqual({ ok: false, reason: 'transfer_failed' });
    expect(mockReportCallTransferFailed).not.toHaveBeenCalled(); // no reportConfig in FULL_DEPS
  });

  it('SAD: a failure with reportConfig set fires the backend metric report', async () => {
    // WHO: platform operator watching /metrics for the transfer failure rate.
    // WHAT: agent/src has no metrics endpoint of its own, so a failed transfer
    //       reports to the backend the same way report-dispatch-no-participant
    //       does — fire-and-forget, never blocking the caller's own result.
    transferSipParticipant.mockRejectedValueOnce(new Error('REFER rejected by trunk'));
    const reportConfig = {
      BACKEND_URL: 'https://backend.test',
      AGENT_SECRET: 'secret-key',
      tenantId: 'tenant-1',
    };
    const exec = createTransferExecutor({ ...FULL_DEPS, reportConfig });
    const result = await exec!('+16082175303');
    expect(result).toEqual({ ok: false, reason: 'transfer_failed' });
    expect(mockReportCallTransferFailed).toHaveBeenCalledWith(reportConfig, {
      tenantId: 'tenant-1',
      room: 'sip-room-1',
      reason: 'transfer_failed',
    });
  });

  it('SAD: SDK hangs (no timeout of its own) → transfer_timeout after 10s, never hangs the turn', async () => {
    // WHO: a live transfer where Telnyx/the carrier never answers the SIP REFER.
    // WHAT: transferSipParticipant never resolves; the executor must NOT await
    //        forever — it races a 10s timeout and returns reason 'transfer_timeout'.
    // WHERE: createTransferExecutor → Promise.race(refer, timeout) in transferClient.ts.
    // WHEN: carrier/network glitch on a cold transfer.
    // WHY: an unbounded REFER stalls the tool's execute() indefinitely → the
    //        caller hears dead air with no recovery — the exact never-silent failure.
    vi.useFakeTimers();
    try {
      // Never settles → only the timeout can resolve the race.
      transferSipParticipant.mockReturnValueOnce(new Promise(() => {}));
      const reportConfig = {
        BACKEND_URL: 'https://backend.test',
        AGENT_SECRET: 'secret-key',
        tenantId: 'tenant-1',
      };
      const exec = createTransferExecutor({ ...FULL_DEPS, reportConfig });
      const resultPromise = exec!('+16082175303');
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;
      expect(result).toEqual({ ok: false, reason: 'transfer_timeout' });
      expect(mockReportCallTransferFailed).toHaveBeenCalledWith(reportConfig, {
        tenantId: 'tenant-1',
        room: 'sip-room-1',
        reason: 'transfer_timeout',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
