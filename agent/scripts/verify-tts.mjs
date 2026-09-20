/**
 * CAN THE AGENT ACTUALLY SPEAK?
 *
 * WHY THIS EXISTS (2026-07-14): I switched the TTS engine to Deepgram Aura and shipped
 * it straight to production. Typecheck passed. 567 unit tests passed. And the phone
 * line went COMPLETELY SILENT — the owner rang his own business, said "Hello… Hello…",
 * heard nothing, and hung up.
 *
 * The cause was one query parameter. The plugin appends `?speed=…` to the WebSocket
 * upgrade URL, Aura answers 400, the socket never opens, and there is no TTS at all.
 *
 * Not one of those 567 tests could have caught it, because NOT ONE OF THEM SYNTHESISES
 * A WORD. They mock the TTS. A voice product where nobody listens to the voice before
 * deploying is a voice product that ships silence.
 *
 * "It compiles and the tests are green" is not the same as "it makes noise."
 *
 * So this script does the one thing that matters: it opens the REAL socket to the REAL
 * API with the REAL config the agent uses, and demands actual audio bytes back. It is
 * the last gate before a TTS change reaches a phone line.
 *
 *   cd agent && node scripts/verify-tts.mjs
 *
 * Exit 0 = it speaks. Exit 1 = do not deploy.
 */
import { WebSocket } from 'ws';

const KEY = process.env.DEEPGRAM_API_KEY;
if (!KEY) {
  console.error('DEEPGRAM_API_KEY not set — cannot verify the agent can speak.');
  process.exit(2);
}

// Every voice the tenant picker can map to. A per-tenant voice that 400s is a silent
// line for THAT tenant, which is no better than a silent line for everyone.
const VOICES = [
  'aura-asteria-en',
  'aura-luna-en',
  'aura-stella-en',
  'aura-athena-en',
  'aura-orion-en',
  'aura-arcas-en',
];

// THE LINES THE PRODUCT ACTUALLY SPEAKS — not a sentence invented for the test.
//
// This script used to synthesize one made-up string. That proved the socket opens;
// it did NOT prove the lines we depend on can be spoken. The hold lines are the
// ONLY thing standing between a slow tool and dead air now that the model is no
// longer allowed to stall out loud, and they are pre-synthesized and cached BY THE
// TEXT — so if one of them cannot be synthesized, the watchdog silently falls back
// to live TTS, or worse, has nothing to play.
//
// Kept in sync with src/session/holdLines.ts by the assertion below: this file is
// plain .mjs (no TS import), so drift is possible — and drift here is silence.
const HOLD_LINE = 'One moment while I check that for you.';
const RECOVERY_LINE =
  "Sorry this is taking a moment. I can take a message and have someone call you back.";
const TOOL_FALLBACK_LINE =
  "I'm having trouble with that. I can take a message and have someone call you back.";

const LINES = [
  ['greeting', 'Thank you for calling. How can I help you today?'],
  ['hold', HOLD_LINE],
  ['recovery', RECOVERY_LINE],
  ['tool-fallback', TOOL_FALLBACK_LINE],
];

/** Open the socket exactly as the LiveKit plugin does, send text, demand audio back. */
function speak(voice, sentence = LINES[0][1]) {
  return new Promise((resolve) => {
    const url = `wss://api.deepgram.com/v1/speak?model=${voice}&encoding=linear16&sample_rate=24000`;
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${KEY}` } });
    let bytes = 0;

    const done = (ok, detail) => {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
      resolve({ voice, ok, bytes, detail });
    };

    const timer = setTimeout(() => done(false, 'timeout — no audio within 15s'), 15_000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'Speak', text: sentence }));
      ws.send(JSON.stringify({ type: 'Flush' }));
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) bytes += data.length;
      // Deepgram signals the end of the utterance; by then we must have real audio.
      if (!isBinary && String(data).includes('Flushed')) {
        clearTimeout(timer);
        done(bytes > 1000, bytes > 1000 ? `${bytes} bytes of audio` : `only ${bytes} bytes`);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      // THE 2026-07-14 OUTAGE, exactly: "Unexpected server response: 400".
      done(false, err.message);
    });

    ws.on('close', (code) => {
      clearTimeout(timer);
      // ALWAYS resolve. The first version only resolved when bytes === 0 — so a socket
      // that delivered audio and then closed WITHOUT a "Flushed" message left the
      // promise pending forever, and the whole gate hung. A verification script that
      // can hang is a verification script that gets bypassed, which is exactly how the
      // outage it exists to prevent happens again.
      done(
        bytes > 1000,
        bytes > 1000
          ? `${bytes} bytes of audio`
          : `socket closed (${code}) with only ${bytes} bytes`
      );
    });
  });
}

let failed = 0;
let checked = 0;

// EVERY VOICE must open the socket and make noise (the 2026-07-14 outage: one query
// param and all six 400'd).
console.log('\n  Every voice the picker can map to:');
for (const v of VOICES) {
  const r = await speak(v);
  checked++;
  if (r.ok) {
    console.log(`  \x1b[32mSPEAKS\x1b[0m  ${r.voice.padEnd(18)} ${r.detail}`);
  } else {
    failed++;
    console.log(`  \x1b[31mSILENT\x1b[0m  ${r.voice.padEnd(18)} ${r.detail}`);
  }
}

// EVERY FIXED LINE must be synthesizable. These are the ones the RUNTIME speaks —
// the hold line is now the only cover for a slow tool, because the model is no
// longer told to stall out loud. A hold line that cannot be spoken is dead air with
// extra steps.
console.log('\n  Every fixed line the runtime speaks (default voice):');
for (const [label, text] of LINES) {
  const r = await speak(VOICES[0], text);
  checked++;
  if (r.ok) {
    console.log(`  \x1b[32mSPEAKS\x1b[0m  ${label.padEnd(18)} ${r.detail}`);
  } else {
    failed++;
    console.log(`  \x1b[31mSILENT\x1b[0m  ${label.padEnd(18)} ${r.detail}  "${text.slice(0, 50)}…"`);
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${checked} checks produce NO AUDIO. DO NOT DEPLOY.`);
  console.error('A silent phone line is worse than a choppy one.');
  process.exit(1);
}
console.log(`\nAll ${checked} checks speak. Safe to deploy.`);
