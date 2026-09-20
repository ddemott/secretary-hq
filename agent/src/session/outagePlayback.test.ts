/**
 * The outage line must play IMMEDIATELY, not after the SDK's retries.
 *
 * 5W:
 *   WHO   — a caller whose LLM provider is out of credits
 *   WHAT  — the outage line finishes playing right after the first error
 *   WHEN  — 2026-09-18 1:28 PM CT, SCL_MFD3o5QRKQJB: OpenAI answered
 *           `429 You have no credits remaining`
 *   WHERE — agent/src/session/outagePlayback.ts, over a REAL voice.AgentSession
 *   WHY   — the guard tripped at 18:28:34, but the outage line only played at
 *           18:28:39: say() queues behind the failing reply, which the SDK keeps
 *           retrying. Mocks cannot show this — it is a property of the SDK's
 *           speech queue — so this drives the real session and real openai.LLM
 *           against a local server that answers 429 forever.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ReadableStream } from 'node:stream/web';
import { voice, initializeLogger } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import { AudioFrame } from '@livekit/rtc-node';
import { speakOutageLine } from './outagePlayback.js';

let server: http.Server;
let baseURL: string;

beforeAll(async () => {
  initializeLogger({ pretty: false, level: 'silent' });
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'You have no credits remaining.' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function silentClip(): ReadableStream<AudioFrame> {
  const frame = new AudioFrame(new Int16Array(2400), 24000, 1, 2400);
  return new ReadableStream<AudioFrame>({
    start(c) {
      c.enqueue(frame);
      c.close();
    },
  });
}

/** Start a real session, let a reply fail on the first 429, then speak the outage line. */
async function msFromFirstErrorToOutageLinePlayed(
  speak: (session: voice.AgentSession) => Promise<void>
): Promise<number> {
  const model = new openai.LLM({ apiKey: 'sk-test', baseURL, model: 'gpt-4.1-mini' });
  const session = new voice.AgentSession({ llm: model });
  await session.start({ agent: new voice.Agent({ instructions: 'be brief' }) });
  try {
    return await new Promise<number>((resolve, reject) => {
      let started = 0;
      // `on`, never `once`: an EventEmitter 'error' with NO listener throws, so a
      // one-shot handler would let the SDK's next retry error crash the generation
      // and make the bare-say() control finish early for the wrong reason.
      session.on(voice.AgentSessionEventTypes.Error, () => {
        if (started) return;
        started = Date.now();
        speak(session).then(() => resolve(Date.now() - started), reject);
      });
      session.generateReply({ userInput: 'I would like to talk to Dale about hiring him' });
    });
  } finally {
    await session.close().catch(() => undefined);
  }
}

describe('speakOutageLine over a real AgentSession whose LLM is out of credits', () => {
  it('SAD: the outage line finishes playing right after the first error, not after the retries', async () => {
    // The SDK's retry schedule for a 429 is 100ms + 2s + 2s. Anything under 1.5s
    // means the failing generation was cut loose rather than waited out.
    const ms = await msFromFirstErrorToOutageLinePlayed((session) =>
      speakOutageLine(session, 'technical trouble', silentClip())
    );
    expect(ms).toBeLessThan(1500);
  }, 20_000);

  it('CONTROL: a bare say() — the old behaviour — waits out the retries (~4s), which is the bug', async () => {
    // Documents WHY the interrupt exists. If the SDK ever stops queueing say()
    // behind a failing generation this control goes red and the interrupt can be
    // reconsidered; until then it is the bug, reproduced.
    const ms = await msFromFirstErrorToOutageLinePlayed(async (session) => {
      const handle = session.say('technical trouble', { audio: silentClip() });
      await (handle as unknown as { waitForPlayout: () => Promise<void> }).waitForPlayout();
    });
    expect(ms).toBeGreaterThan(3000);
  }, 30_000);
});
