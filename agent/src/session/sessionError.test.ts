/**
 * Tests for reading a session error's real cause.
 *
 * 5W:
 *   WHO   — the operator reading a broken call's log, and the outage guard
 *   WHAT  — unwrap LiveKit's `{type, error, recoverable}` envelope, name the
 *           cause, and say whether waiting can fix it
 *   WHEN  — every AgentSession `error` event
 *   WHERE — agent/src/session/sessionError.ts
 *   WHY   — 2026-09-18 1:28 PM CT, SCL_MFD3o5QRKQJB: the OpenAI balance was
 *           empty; the session-error log line said `error_message="[object
 *           Object]"` because the event's `error` is an envelope, not an Error.
 *           The SDK also retries a 429 three times, so the caller waited out
 *           retries for a failure that could never clear.
 *
 * The envelope shape is NOT hand-written here for the main case: a real
 * `openai.LLM` from the pinned SDK is pointed at a local server that answers 429
 * exactly as the provider did, and the error event the SDK actually emits is fed
 * to the code under test. A hand-built fixture would only prove the fixture.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { llm as lk, initializeLogger } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { describeSessionError } from './sessionError.js';

const NO_CREDITS = 'You have no credits remaining. Add credits to continue using the API.';

let server: http.Server;
let baseURL: string;
let respondWith: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  initializeLogger({ pretty: false, level: 'silent' });
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(respondWith.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(respondWith.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Drive one real chat request and return every `error` event the SDK emitted. */
async function realSdkErrorEvents(): Promise<unknown[]> {
  const model = new openai.LLM({ apiKey: 'sk-test', baseURL, model: 'gpt-4.1-mini' });
  const events: unknown[] = [];
  model.on('error', (ev: unknown) => events.push(ev));
  const chatCtx = new lk.ChatContext();
  chatCtx.addMessage({ role: 'user', content: 'hello' });
  const stream = model.chat({
    chatCtx,
    connOptions: { maxRetry: 1, retryIntervalMs: 10, timeoutMs: 5000 },
  });
  try {
    for await (const _chunk of stream) {
      /* drain */
    }
  } catch {
    /* the stream rethrows after the final attempt — we want the events */
  }
  return events;
}

describe('describeSessionError — the real SDK envelope', () => {
  it('SAD: an empty OpenAI balance (429 insufficient_quota) is FATAL and named, not "[object Object]"', async () => {
    respondWith = {
      status: 429,
      body: {
        error: { message: NO_CREDITS, type: 'insufficient_quota', code: 'insufficient_quota' },
      },
    };
    const events = await realSdkErrorEvents();
    expect(events.length).toBeGreaterThan(0);

    // The bug, reproduced: this is what the old handler logged.
    expect(String(events[0])).toBe('[object Object]');

    const info = describeSessionError(events[0]);
    expect(info.message).toContain('no credits remaining');
    expect(info.message).not.toBe('[object Object]');
    expect(info.statusCode).toBe(429);
    expect(info.cause).toBe('quota_exhausted');
    expect(info.fatal).toBe(true);
  });

  it('SAD: the exact prod wording (no `insufficient_quota` code in the body) is still recognised', async () => {
    // The 2026-09-18 log text was "429 You have no credits remaining. Add credits to
    // continue using the API at ...billing/." — no machine-readable code in it.
    respondWith = { status: 429, body: { error: { message: NO_CREDITS } } };
    const events = await realSdkErrorEvents();
    const info = describeSessionError(events[0]);
    expect(info.cause).toBe('quota_exhausted');
    expect(info.fatal).toBe(true);
  });

  it('HAPPY: a genuine rate limit is NOT fatal — retrying is right and the call must survive it', async () => {
    // WHY: treating every 429 as "wallet empty" would hang up on callers during an
    //      ordinary burst. Only the no-money wording may end the call early.
    respondWith = {
      status: 429,
      body: {
        error: {
          message: 'Rate limit reached for gpt-4.1-mini. Try again in 1s.',
          type: 'requests',
          code: 'rate_limit_exceeded',
        },
      },
    };
    const events = await realSdkErrorEvents();
    const info = describeSessionError(events[0]);
    expect(info.cause).toBe('rate_limited');
    expect(info.fatal).toBe(false);
  });

  it('SAD: a rejected key (401) is fatal — it will not fix itself mid-call', async () => {
    respondWith = {
      status: 401,
      body: { error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } },
    };
    const events = await realSdkErrorEvents();
    const info = describeSessionError(events[0]);
    expect(info.cause).toBe('auth_rejected');
    expect(info.fatal).toBe(true);
  });

  it('HAPPY: a 5xx is a provider error, retryable, not fatal', async () => {
    respondWith = { status: 503, body: { error: { message: 'The server is overloaded' } } };
    const events = await realSdkErrorEvents();
    const info = describeSessionError(events[0]);
    expect(info.cause).toBe('provider_error');
    expect(info.fatal).toBe(false);
  });
});

describe('describeSessionError — other shapes', () => {
  it('HAPPY: a plain Error reads through unchanged', () => {
    const info = describeSessionError(new Error('socket hang up'));
    expect(info.message).toBe('socket hang up');
    expect(info.name).toBe('Error');
    expect(info.fatal).toBe(false);
  });

  it('SAD: undefined / null / garbage never throw and never claim a cause', () => {
    for (const bad of [undefined, null, 42, {}, { error: null }]) {
      const info = describeSessionError(bad);
      expect(info.message.length).toBeGreaterThan(0);
      expect(info.fatal).toBe(false);
    }
    expect(describeSessionError(undefined).cause).toBe('unknown');
  });

  it('SAD: a self-referencing envelope cannot loop forever', () => {
    const loop: Record<string, unknown> = { type: 'llm_error' };
    loop.error = loop;
    expect(() => describeSessionError(loop)).not.toThrow();
  });

  it('SAD: HTTP 402 (payment required) is an empty balance whatever the wording', () => {
    const info = describeSessionError({
      error: Object.assign(new Error('nope'), { statusCode: 402 }),
    });
    expect(info.cause).toBe('quota_exhausted');
    expect(info.fatal).toBe(true);
  });
});
