/**
 * Read WHY an AgentSession error happened — and whether retrying can ever help.
 *
 * THE CALL THIS EXISTS FOR (2026-09-18 1:28 PM CT, SCL_MFD3o5QRKQJB). The prod
 * OpenAI account had no credits left. Every LLM request returned
 * `429 You have no credits remaining`. The caller heard the greeting, said
 * "I would like to talk to Dale about hiring him for a job", and got 8 seconds
 * of silence, then a line OFFERING TO TAKE A MESSAGE (a lie — taking a message
 * needs the dead LLM), then "I'm having some technical trouble", then a hang-up.
 *
 * Two things about that call were invisible until the Railway log was read by
 * hand:
 *
 *   1. The session-error log said `error_message="[object Object]"`. The event's
 *      `error` is NOT an Error — it is LiveKit's wrapper
 *      `{ type: 'llm_error', error: APIStatusError, recoverable }` — so
 *      `e instanceof Error ? e.message : String(e)` produced the literal text
 *      "[object Object]". The one line whose only job is to say why the call
 *      broke said nothing. (The 429 text only surfaced in a DIFFERENT log line,
 *      the SDK's own retry warning.)
 *
 *   2. The SDK treats 429 as retryable, always — it cannot tell "slow down" from
 *      "your wallet is empty". A rate limit clears in seconds. An empty balance
 *      never clears, and each retry keeps the failing generation holding the
 *      speech queue, so the outage line the guard queued could not play until the
 *      SDK finished retrying: ~5 seconds of the caller's time spent waiting for
 *      an outcome that was decided on the first response.
 *
 * So this module answers two questions in one place: what is the real message,
 * and is this failure one that no amount of waiting will fix (`fatal`)? Pure
 * logic with no session handle, so it is tested without a LiveKit runtime.
 */

export type SessionErrorCause =
  /** Provider says the account has no money / quota left. Never clears on its own. */
  | 'quota_exhausted'
  /** Provider rejected our credentials (401/403). Never clears on its own. */
  | 'auth_rejected'
  /** A genuine rate limit — clears in seconds; retrying is correct. */
  | 'rate_limited'
  /** Anything else we could read (5xx, timeout, network). */
  | 'provider_error'
  /** Could not extract anything meaningful. */
  | 'unknown';

export interface SessionErrorInfo {
  /** The real message, unwrapped — never "[object Object]". */
  message: string;
  name: string;
  statusCode: number | null;
  /** Provider error code (e.g. `insufficient_quota`) when the body carried one. */
  code: string | null;
  /** LiveKit's own flag: true while the SDK is still going to retry. */
  recoverable: boolean | null;
  cause: SessionErrorCause;
  /** True when waiting cannot fix it — the call should end NOW, not after retries. */
  fatal: boolean;
}

/** Phrases providers use for "the account is out of money", across OpenAI/Deepgram. */
const QUOTA_RE =
  /insufficient[_ ]quota|no credits remaining|credit[_ ]balance|exceeded your current quota|out of credits|billing[_ ]hard[_ ]limit|payment required/i;

const MAX_UNWRAP_DEPTH = 4;
const UNREADABLE = 'unreadable session error';

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

/**
 * Unwrap LiveKit's `{ type, error, recoverable }` envelope down to the innermost
 * thing that carries a message. A plain Error (or a string) is returned as-is.
 */
function unwrap(e: unknown): { inner: unknown; recoverable: boolean | null } {
  let inner: unknown = e;
  let recoverable: boolean | null = null;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const rec = asRecord(inner);
    if (!rec) break;
    if (typeof rec.recoverable === 'boolean' && recoverable === null) recoverable = rec.recoverable;
    // An Error that itself carries a nested `.error` is rare; an envelope always
    // has one. Only descend through a non-Error envelope.
    if (!(inner instanceof Error) && rec.error != null) {
      inner = rec.error;
      continue;
    }
    break;
  }
  return { inner, recoverable };
}

export function describeSessionError(e: unknown): SessionErrorInfo {
  const { inner, recoverable } = unwrap(e);
  const rec = asRecord(inner);
  const body = asRecord(rec?.body);
  const bodyError = asRecord(body?.error);

  const message =
    inner instanceof Error
      ? inner.message
      : (firstString(rec?.message, bodyError?.message, body?.message) ??
        (typeof inner === 'string' ? inner : null) ??
        UNREADABLE);
  const name = inner instanceof Error ? inner.name : (firstString(rec?.name) ?? typeof inner);

  const rawStatus = rec?.statusCode ?? rec?.status;
  const statusCode = typeof rawStatus === 'number' ? rawStatus : null;
  const code = firstString(rec?.code, bodyError?.code, body?.code);

  const haystack = `${message} ${code ?? ''} ${firstString(bodyError?.type, body?.type) ?? ''}`;
  let cause: SessionErrorCause;
  if (QUOTA_RE.test(haystack) || statusCode === 402) {
    cause = 'quota_exhausted';
  } else if (statusCode === 401 || statusCode === 403) {
    cause = 'auth_rejected';
  } else if (statusCode === 429) {
    cause = 'rate_limited';
  } else if (statusCode != null || message !== UNREADABLE) {
    cause = 'provider_error';
  } else {
    cause = 'unknown';
  }

  return {
    message,
    name,
    statusCode,
    code,
    recoverable,
    cause,
    fatal: cause === 'quota_exhausted' || cause === 'auth_rejected',
  };
}
