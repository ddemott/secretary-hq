# Framework Migrations

Tracks in-flight and recently-completed framework/provider swaps. This is the index — detailed retrospectives live in commit messages, and active follow-ups live in `docs/planning/TODO.md`.

**Last updated:** 2026-09-18 (tool count 26 → 27, PSTN status corrected, §4 marked as-of-then; §3/§4 remain historical)

---

## 1. Voice orchestrator: Vapi → LiveKit Agents

**Status:** Shipped (commit `661d21d`, 2026-04-27). Vapi account deleted, all Vapi code removed.

**Why:** Vapi charged a $0.05/min orchestration tax. LiveKit Cloud free tier covers 1,000 SIP minutes/month at $0.

**Current stack:** Telnyx (carrier + SIP trunk) → LiveKit Cloud (SIP ingress) → LiveKit Agent worker (Node) → Deepgram Nova-3 (STT) + **OpenAI GPT-4.1-mini** (voice LLM; 4o-mini for summaries/classify/fallback) + **Deepgram Aura** (TTS, streaming; per-tenant voice via `tenants.tts_voice` — `tts_speed` is INERT, see §5) → Fastify `/agent-tools/*`. Call SEQUENCING is question trees (§6).

**Open follow-up:** PSTN inbound reaching the agent was confirmed 2026-06-30; the booking + transfer + preference legs on a live different-carrier call are still unverified — see `docs/planning/TODO.md` (P0 Voice) and `docs/operations/RUNBOOK.md` section 7.

---

## 2. Tool runtime: Supabase Edge Functions (Deno) → Fastify (Node)

**Status:** Shipped (commit `661d21d`, 2026-04-27). `supabase/functions/vapi-tools/` deleted; `supabase/functions/` is now empty.

**Why:** LiveKit agent runs as a Node.js worker; keeping tools in Deno edge functions added a network hop and a second runtime. Consolidating into Fastify lets tools share the existing DB pool, middleware, and types.

**Current implementation:** 27 defined voice tools (`agent/src/tools/`, re-exported by `agent/src/tools.ts`) backed by `src/routes/agentTools/`. Auth via `x-agent-secret` header. The live question-tree path exposes a subset of those tools, not the entire catalog. See `docs/architecture/ARCHITECTURE.md` for the current reachability split.

---

## 3. TTS provider: OpenAI TTS → xAI Grok (native in agent) — historical (2026-05)

**Status:** Code-complete 2026-05-01, dead-air guard validated 2026-05-03. This phase is now superseded (see section 4).

The fallback path inside `runFallback()` uses `openai.TTS` as a last-resort voice if config is too broken to construct GrokTTS — intentional, so a misconfigured XAI key never produces dead-air on the caller's end. **Caveat (historical):** between 2026-05-01 and 2026-05-03 this guard was aspirational — the actual `runFallback()` on main wired GrokTTS in both paths. Closed 2026-05-03 by extracting `runFallback()` to `agent/src/fallback.ts`, switching the TTS to OpenAI, and pinning the contract with 13 new 5W tests in `agent/src/fallback.test.ts`.

**Why (at the time):** Cost, latency, and voice quality evaluation. The earlier interim plan (Vapi custom-voice proxy at `src/routes/tts.ts`) was abandoned and that file deleted in `661d21d` along with everything else Vapi-shaped.

**Implementation (historical):** `agent/src/grokTTS.ts` — `GrokTTS` class extending `tts.TTS`, posting to `https://api.x.ai/v1/tts` with `output_format: { codec: 'pcm', sample_rate: 24000 }`. Wired into the primary `voice.AgentSession` at `agent/src/index.ts`. Voice configurable via `XAI_TTS_VOICE` env (eve | ara | rex | sal | leo, default `ara`). 9 unit tests covered request shape, etc. (file and env vars removed 2026-06-25).

---

## 4. TTS provider: xAI Grok → OpenAI TTS (full removal, 2026-06-25) — SUPERSEDED by §5

**Status:** Shipped (chore #94 and follow-ups). All Grok/xAI TTS code, env vars (`XAI_API_KEY`, `XAI_TTS_*`), `grokTTS.ts`, and references removed from the agent. Primary path and fallback are now both `openai.TTS`. Per-tenant control lives entirely in `tenants.tts_voice` (OpenAI ids: shimmer/nova/alloy/echo/onyx/fable) + `tts_speed` (and tone flags for the prompt, not prosody). No `XAI_API_KEY` required anywhere.

**Why:** OpenAI TTS is now smoother (lower latency, better seamlessness in practice) than the prior Grok implementation. Full removal also eliminates a second provider credential surface, simplifies cost tracking (all TTS under OpenAI), and aligns voice selection with the dashboard picker. Legacy Grok voice values (e.g. `ara`) are gracefully mapped to `shimmer` in `agent/src/index.ts:toOpenAIVoice`.

**Implementation at the time (superseded by §5 — only `runFallback()` in `agent/src/fallback.ts` still uses `openai.TTS`):** Standard `@livekit/agents-plugin-openai` TTS in `agent/src/index.ts` (both normal session and `runFallback`). Voice/speed pulled per-tenant in `tenantConfig.ts` and passed to the OpenAI TTS constructor. The output watchdog, adaptive interruption, Realtime mode (separate flag), and cached fillers provide the "never-silent" behavior. Cost events for TTS now always use provider `openai`.

**Verification:** `agent/src/fallback.test.ts` still asserts "uses OpenAI TTS for fallback (independent of primary path)". `simulate.sh call` and real calls exercise it. Docs, comments, and `supabase/baseline.sql` (regenerated as needed) updated for the final state.

---

## Related docs

- `docs/planning/TODO.md` — full active task list
- `docs/architecture/ARCHITECTURE.md` — system architecture
- `CLAUDE.md` — project overview, includes migration callout
- `docs/voice/VOICE_AGENT_PLAYBOOK.md` — rules for building/maintaining voice agents (pipeline vs Realtime, never-silent layers, etc.)

---

## 5. TTS provider: OpenAI TTS → **Deepgram Aura** (2026-07-14) — CURRENT

**Status:** Shipped. `aura-asteria-en` default, per-tenant via `tenants.tts_voice`.

**Why:** the OpenAI LiveKit TTS plugin is **non-streaming** — it buffers the ENTIRE reply
before emitting any audio, so every turn was silence-then-a-burst. Feeding it
sentence-by-sentence through `StreamAdapter` only traded one gap for a gap between every
sentence. **You cannot make a non-streaming engine stream by chopping its input finer.**
Aura streams over a WebSocket as the words are produced.

**The outage this caused, and the guard that came out of it:** the swap passed typecheck
and all 567 unit tests and took the phone line **completely silent**. The plugin appends
`?speed=…` to the WebSocket upgrade URL; Aura answers **400**; the socket never opens;
there is no TTS at all. Not one of those tests synthesises a word — they all mock the TTS.
Hence `cd agent && npm run verify:tts`, which opens the REAL socket with the REAL config
and demands real audio bytes back for every mappable voice. **Mandatory before any TTS
change reaches prod.** "It compiles and the tests are green" is not "it makes noise."

**Consequence:** `tenants.tts_speed` is inert — it is deliberately not passed, because
passing it is what caused the outage. The dashboard control still writes the column.

---

## 6. Call flow: prompt ladder → TaskGroup rungs → **question trees** (2026-07-21) — CURRENT

Not a provider swap — a rebuild of how a call is SEQUENCED. Three generations:

| Gen | Where | Idea | Status |
|---|---|---|---|
| 1. Prompt ladder | `src/services/scripts/blocks.ts` → `tenants.system_prompt` | one long system prompt of RUNG 1-6 the model works down | Fallback (both flags off). The model skipped steps. |
| 2. TaskGroup rungs | `agent/src/tasks/` | host-code rungs the model *cannot* skip; each completes on a real tool id | Fallback (`ENABLE_TASK_GROUP`). Live in prod 2026-07-18 → 2026-07-21. |
| 3. **Question trees** | `agent/src/checklist/` | sequencing removed entirely: purpose-selected trees, host-owned checklist, a **goodbye gate** (`isResolved()`) that refuses to end the call while any goal is unresolved | **CURRENT.** `ENABLE_QUESTION_TREE`, on unless set to `"false"`. |

**Why gen 3:** rungs enforced an ORDER, and real callers do not follow one — they answer
three questions in one breath and change their mind. Trees let answers arrive in any
order; what is enforced is COMPLETION, not sequence.

**What this means in practice:** a tenant's composed `system_prompt` is never passed to the
model on a live call. Editing `blocks.ts`, running `install-script.ts`, or regenerating
`docs/voice/CALL_LADDER.md` changes nothing about how calls go. Behaviour changes go in
`agent/src/checklist/trees.ts`. See `docs/voice/QUESTION_TREE_ARCHITECTURE.md`.
