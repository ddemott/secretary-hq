# Voice dead-air / latency — research findings (2026-06-25)

> ## ⚠️ CORE PREMISE SUPERSEDED (2026-07-14)
>
> This document's central problem — **"OpenAI TTS is non-streaming, so every reply
> starts with a gap"** — was solved by REPLACING THE ENGINE, not by any technique
> researched below. TTS is now **Deepgram Aura**, which streams over a WebSocket as
> the words are produced. Every §-reference to `gpt-4o-mini-tts`, its per-synthesis
> latency, and the workarounds for buffering it describes a provider we no longer use.
>
> What is still live and worth reading: the filler/thinking-sound machinery
> (`agent/src/session/fillerCache.ts`, `thinkingSound.ts`, `watchdog.ts`) and the
> **tool-boundary** rule — never call a filler inside a tool's own `execute()`.
> Dead air today is covered by a TIMER speaking a pre-synthesized hold line
> (`agent/src/session/holdLines.ts`), which may name a lookup only when a tool is
> genuinely in flight — the model is not asked to narrate, because it satisfied that
> instruction with a SENTENCE instead of a tool call.

> **Reference doc, mostly shipped (status 2026-06-30).** This is a research record, not an open-work list. Of its recommendations, adaptive interruption, false-interruption resume, the non-interruptible greeting (#103/#104/#108/#109), and the TTS-model switch all **landed** in the pipeline path. **Cached/pre-rendered filler audio (§2) is also built** — `agent/src/session/fillerCache.ts` (`warmFillers` → synth-once → `say(text,{audio})`), consumed by the **output watchdog** (`watchdog.ts`); plus a thinking-sound bed (`thinkingSound.ts`). Watchdog **defaults ON** as of 2026-07-14 (opt out `ENABLE_OUTPUT_WATCHDOG=false`; deadline must exceed reply latency — PLAYBOOK §8.1). Thinking-sound stays flag-gated OFF (`ENABLE_THINKING_SOUND`) pending real-call volume/mix validation (it has no deadline knob — PLAYBOOK §8.2). The genuine remaining gaps are narrow: (a) Dale listening on a real call (filler vs stutter), and (b) the **tool-boundary** `speakFiller` is still a **no-op** (was disabled after the #97 in-`execute()` freeze; the cached-filler plumbing exists but isn't wired to the tool boundary). Operational voice rules now live in `docs/voice/VOICE_AGENT_PLAYBOOK.md` (authoritative §8). "How this maps to our config" below predates `fillerCache.ts` — read it with this banner.

Cited research into how voice-AI practitioners handle dead air during LLM + tool-call + TTS,
mapped to our stack: **LiveKit Agents (Node) `@livekit/agents` 1.4.5 + Deepgram STT +
OpenAI GPT-4o-mini + OpenAI `gpt-4o-mini-tts` + Telnyx/SIP**. Produced by the deep-research
harness (105 agents, 22 claims verified 3-vote, 3 refuted). Sources are LiveKit-first-party
(docs, engineering blog, agents GitHub tracker) — appropriate since it's our exact framework.

## 1. Filler / "thinking" feedback — trigger at the tool boundary, not inside execute()

**Consensus (high confidence).** LiveKit's latency guide recommends *"Playing a 'Thinking' sound
during tool execution, and notifying the user prior to making the call, so they are not kept
waiting without feedback."* Tool calls are a recognized dead-air source (livekit/agents#4460).

Trigger the filler **at the tool-execution boundary** (just before / during the tool call), driven
by agent state — NOT from inside the tool's `execute()`. (Our own #97 freeze was caused by
`session.say()` inside `execute()` — an unsupported pattern that stalled the generation loop.)

Sources: livekit.com/blog/understand-and-improve-agent-latency, github.com/livekit/agents/issues/4460

## 2. Pre-rendered / cached filler audio — the #1 documented fix

**Consensus (high confidence).** For fixed phrases ("one moment, let me check"), **pre-synthesize
the audio once and replay it via `session.say(text, { audio })`** — this *skips the TTS step
entirely*, giving an instant response with no synthesis gap. Verbatim from LiveKit docs:
*"You can optionally provide pre-synthesized audio for playback. This skips the TTS step and
reduces response time"* and *"For fixed phrases like these, you can cache TTS and use
pre-synthesized audio to avoid redundant TTS calls and reduce latency."*

Confirmed in our installed 1.4.5: `say(text, { audio?: ReadableStream<AudioFrame>, allowInterruptions?: boolean })`.
This is the most relevant fix for our **non-streaming** OpenAI TTS, and it's our own
`tts-phrase-cache-design` plan. It also avoids the #97 freeze (pre-rendered audio at the boundary
is the supported pattern; live synthesis inside execute() is not).

Sources: docs.livekit.io/agents/multimodality/audio/, docs.livekit.io/agents/multimodality/audio/customization/

## 3. Streaming TTS — the bigger latency lever

**Consensus (high confidence).** OpenAI TTS is **non-streaming** (chunked); LiveKit feeds it
incrementally via a `StreamAdapter` sentence tokenizer (auto-wrapped in current versions), which
*reduces but does not eliminate* the synthesis gap. A natively-streaming TTS (e.g. ElevenLabs,
WebSocket + 0–4 latency-optimization param) is lower latency. Streaming the *whole* STT/LLM/TTS
pipeline shifts total latency from **sum-of-stages (~1000–2000ms+) toward max-of-stages
(~400–800ms)**.

**Refuted (do NOT rely on):** the claim that OpenAI TTS takes a *fixed* ~5s per synthesis (0-3).
Measure our own. (Our LESSONS_LEARNED *measured* 2–5s on our pipeline — that's our data, not the
refuted generic figure.)

Sources: github.com/livekit/agents/issues/298, livekit.com/blog/sequential-pipeline-architecture-voice-agents

## 4. Interruption / barge-in — stop "hello?" from cancelling the reply

**Default behavior (high confidence):** the agent stops speaking the moment it detects user speech,
so a caller's "hello?" during a gap **will** cancel the in-flight reply unless tuned.

Four tunable layers (all present in 1.4.5 `InterruptionOptions`):

- **`mode: 'adaptive'`** — a CNN model trained on real conversation that decides whether to yield
  the turn from *acoustic* signals (not transcript), filtering backchannels (mm-hmm, yeah), coughs,
  sighs, background noise. Default-on for **LiveKit Cloud + Node ≥ v1.2.0 + VAD** (we have silero
  VAD ✓). Median 216ms to trigger a true interruption. **This is the proper fix for the "hello?"
  problem.** (Specific benchmark stats 51%/64%/86%/100% were refuted 1-2 — cite the mechanism,
  not the numbers.)
- **`minWords` > 0** — *the* effective lever to ignore brief backchannels when STT is enabled.
- **`minDuration`** — **ineffective when STT is enabled** (verified, LiveKit maintainer, 3-0):
  STT-detected speech bypasses the duration threshold. Raising it does little; raise `minWords`.
- **`falseInterruptionTimeout` (default 2000ms) + `resumeFalseInterruption` (default true)** — if a
  detected interruption is *not* followed by a transcript within the timeout, the agent **resumes
  speaking from where it left off**. Direct guard against a brief "hello?" silently killing the reply.
- **`allowInterruptions: false`** per-`say()` — for critical fixed phrases (greeting, fillers) so
  they play through uninterrupted. Scoped to that one call.

Sources: docs.livekit.io/agents/logic/turns/adaptive-interruption-handling/,
docs.livekit.io/reference/agents/turn-handling-options/, livekit/agents#2339, livekit/agents#3515, livekit/agents#2197

## 5. Endpointing — latency vs. naturalness tradeoff

**Consensus (high confidence).** Endpointing tuning is a tradeoff, not pure latency minimization.
Node defaults: `minDelay` 500ms / `maxDelay` 3000ms (300/2500 under the audio turn detector).
Aggressive (short) endpointing starts the pipeline sooner but cuts callers off mid-thought;
conservative adds latency but catches complete (multi-part) utterances. Practitioner conversational
range ~200–400ms; >500ms noticeable lag.

Our #100 set `minDelay: 1300 / maxDelay: 4000` — deliberately conservative to aggregate multi-part
answers (spoken phone numbers) into one turn. Consistent with the tradeoff; worth re-measuring once
adaptive interruption + cached fillers are in (we may be able to relax it).

Sources: livekit.com/blog/understand-and-improve-agent-latency, livekit.com/blog/sequential-pipeline-architecture-voice-agents

## How this maps to our current config

> **Status (updated 2026-06-29):** most of the interruption-tuning items below have since
> shipped. `agent/src/index.ts` is the source of truth; this section reflects what's actually
> in the non-Realtime pipeline today.

`agent/src/index.ts` (non-Realtime path):
```
turnHandling: {
  interruption: {
    mode: 'adaptive',              // ✅ CNN barge-in — backchannels don't cancel the reply
    minWords: 2,                   // ✅ effective lever when STT is on
    falseInterruptionTimeout: 2000,// ✅ resume if a detected interruption has no transcript
    resumeFalseInterruption: true, // ✅
  },
  endpointing:  { minDelay: 1300, maxDelay: 4000 },  // conservative, aggregates multi-part answers
  // (2026-09-18: with the checklist-aware turn detector active — agent/src/session/turnDetector.ts —
  //  index.ts uses { minDelay: 900, maxDelay: 4500 } and the detector picks per utterance; 1300/4000 is the fallback)
}
session.say(greeting, { allowInterruptions: false })  // ✅ greeting plays through uninterrupted
speakFiller = () => {}      // NO-OP since #97 — awaiting a supported re-enable
```

**Remaining gap vs. the research (updated 2026-08-28):** cached filler audio IS now built —
`agent/src/session/fillerCache.ts` (`warmFillers` synthesizes each fixed line once → replays via
`say(text,{audio})`, exactly section 2) — and consumed by the **output watchdog** (`watchdog.ts`),
flag-gated behind `ENABLE_OUTPUT_WATCHDOG` (default ON as of 2026-07-14; opt out with `=false`; PLAYBOOK §8.1).
What's still NOT done: (a) Dale listening on a real call (filler vs stutter; 2800ms deadline, `HOLD_LINE`), and (b) wiring
the cached frames to the **tool-boundary** `speakFiller`, which remains a **no-op** (disabled after
the #97 in-`execute()` freeze — the `speakFiller?.(…)` call sites in `agent/src/tools.ts` invoke a
callback that `index.ts` deliberately passes as a no-op). Adaptive interruption, false-interruption
resume, and the non-interruptible greeting all landed (#103/#104/#108/#109). Plan:
`docs/superpowers/specs/2026-06-25-filler-interruption-tuning-design.md` and the
`tts-phrase-cache-design` work.

## Open questions (need our own measurement)
- Actual `gpt-4o-mini-tts` per-synthesis latency on our SIP pipeline (decides cached-filler vs.
  switching to ElevenLabs streaming TTS as the bigger fix).
- Confirm adaptive interruption is actually *active* (Cloud + version + VAD all required).
- Does a clear spoken "hello?" get classified as non-interruption by the adaptive model, or does it
  correctly yield? Borderline per docs — test on a real call.
