# Voice Agent Playbook — rules & guidelines for building customer voice scripts

**Purpose:** a living rulebook so a new customer voice agent can be built **without days of troubleshooting.** Every rule here is something we verified the hard way (mostly the 2026-06-24→26 go-live + Realtime work). Append new rules as we learn — date them.

**Stack this covers (CURRENT; re-verified 2026-09-18):** LiveKit Agents (Node/TS, `@livekit/agents` ^1.6.4) + Deepgram Nova-3 STT + **OpenAI GPT-4.1-mini** (voice LLM; 4o-mini still runs summaries/classify/fallback) + **Deepgram Aura TTS** (`aura-asteria-en`, native WebSocket streaming) + Telnyx/SIP. Agent code in `/agent`; per-tenant config in `tenants` (DB). Deploys from `main` to Railway service `secretary-hq-agent`.

> **CALL FLOW — read this before any rule below.** The rules here are about the
> voice PIPELINE (STT/LLM/TTS, turn-taking, latency), which is shared by every call.
> They are NOT about how a call is SEQUENCED. Live calls run the **question-tree**
> architecture (`agent/src/checklist/`, `ENABLE_QUESTION_TREE`, on by default) — one
> agent, a host-owned checklist, and a goodbye gate. Any rule below that talks about
> a "script", a "ladder", rungs, or `tenants.system_prompt` driving the conversation
> is describing a fallback path. See `docs/voice/QUESTION_TREE_ARCHITECTURE.md`.

---

## 0. The two modes — pick first, everything else follows

> **The TTS half of this table is HISTORY.** It compares Realtime against the OLD
> OpenAI-TTS pipeline. OpenAI TTS was replaced by **Deepgram Aura on 2026-07-14**
> precisely because the OpenAI plugin is non-streaming; Aura streams over a
> WebSocket as words are produced, so the "2–3s gap per reply" line below no longer
> describes the pipeline we ship. `tenants.tts_speed` is INERT under Aura (passing
> it appends `?speed=` to the WS upgrade URL, Aura answers 400, and the line goes
> completely silent — that outage is why `npm run verify:tts` exists).

| | **Pipeline** (STT→LLM→TTS) | **Realtime** (speech-to-speech) |
|---|---|---|
| How | Deepgram Nova-3 → GPT-4.1-mini → Deepgram Aura | `openai.realtime.RealtimeModel` as the `llm`; no STT/TTS |
| Smoothness | ~~choppy — non-streaming TTS, **2–3s gap per reply**~~ → **smooth since Aura (2026-07-14)**; audio streams as it is produced | **smooth, near-instant, no inter-word gaps** (native audio) |
| Voice | Aura voices; per-tenant `tenants.tts_voice` (`tts_speed` inert under Aura) | Realtime voice set (alloy/ballad/coral/sage/…) via `REALTIME_VOICE` |
| Transcript | reliable (Calls tab populates) | **thin — caller turns often missing** (known gap) |
| Tokens / cost | cheap, no per-minute wall | **expensive; audio burns tokens fast; TPM rate-limit wall** |
| Turn-taking | LiveKit `turnHandling` (you tune it) | **server-side VAD** (don't fight it) |
| Flag | default | `ENABLE_REALTIME=true` |

**RULE 0.1** — Realtime wins on *feel*; pipeline wins on *reliability/cost*. For a polished demo or premium tenant → Realtime (if the OpenAI tier can pay the token bill). For high call volume / tight budget / transcript-critical → pipeline. _(Superseded 2026-07-14: "add a streaming TTS such as ElevenLabs to fix the gap" was the standing advice; the gap was fixed with **Deepgram Aura** instead, and the pipeline is what ships. ElevenLabs was never wired.)_

**RULE 0.2** — Both modes are flag-gated and live side-by-side in `agent/src/index.ts`. The session-construction `if (config.ENABLE_REALTIME)` branch is the ONLY place they diverge; everything after (tools, transcript, finalize, greeting) is shared. **Note the word "prompt" was removed from that list 2026-07-27:** the call architecture is chosen separately and later (`ENABLE_QUESTION_TREE` → `ENABLE_TASK_GROUP` → ladder), and each builds its own instructions — the question-tree path composes its prompt in `buildChecklistPrompt()` and never reads `tenants.system_prompt`.

---

## 1. Model ids — verify before you set (cost us a dead call)

**RULE 1.1** — NEVER trust a model id from memory/docs. Before setting `REALTIME_MODEL` (or any model), list the account's actual models:
```
curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_KEY" | grep -i realtime
```
**Gotcha (2026-06-26):** `gpt-4o-mini-realtime-preview` (the old preview name) **does not exist** on our account → realtime failed to init → **no greeting, dead call**, error `"model ... does not exist or you do not have access"`. The real ids are `gpt-realtime`, `gpt-realtime-mini`, `gpt-realtime-2`, dated variants.

**RULE 1.2** — Known-good realtime ids on our org: full = `gpt-realtime`; cheaper = `gpt-realtime-mini`. Mini = fewer tokens/sec + more TPM headroom, slightly lower quality.

---

## 2. Token burn & rate limits — the #1 Realtime failure (dead space / "couldn't retrieve times")

**The wall:** OpenAI Realtime is rate-limited on **tokens-per-minute (TPM)**, by usage **tier**. **Tier 1 = 40,000 TPM.** Realtime **audio** tokens accrue fast and the **whole conversation is re-processed each turn**, so tokens climb per turn. When a turn (esp. a token-heavy one like scheduling) needs more than the remaining minute budget → the OpenAI response **fails** → silence until the caller speaks again.

**Error signature** (in `agent_session_error` log `error_body`):
```
type: tokens, code: rate_limit_exceeded
"... tokens per min (TPM): Limit 40000, Used 36948, Requested 8836"
```

**RULE 2.1 — Reduce burn (controllable, no spend), highest impact first:**
1. **Concise replies.** Output audio tokens scale with how much it says. Persona MUST enforce "1–2 short sentences, never long-winded." (Wordy bios are a top burner.)
2. **Use `gpt-realtime-mini`** — fewer tokens/sec + higher TPM.
3. **Slim __PERSONA_NAME__.** We cut __PERSONA_NAME__ 9.3k→1.5k chars. Persona is sent as instructions every turn.
4. **Fewer tools.** Each tool JSON schema is input tokens every turn. Use the `buildTools` capability filter — expose only what the flow needs (e.g. `['identity','scheduling','messaging']` for a message+meeting bot).

**RULE 2.2 — Raise the wall (durable):** advance OpenAI usage tier. **Tier 2 = $50 cumulative *paid* + 7 days since first payment** (not monthly, not a post-$50 timer — the 7 days is account-payment age). Tier 2 ≈ 5× TPM (~200k). Prepaid credits count + last ~1 year. Cost per token is unchanged by tier — tier only widens the per-minute *flow*.

**RULE 2.3** — Audio tokens can't be trimmed; you can't fully eliminate burn. A 40k TPM cap stays tight on longer calls → for real traffic on full `gpt-realtime`, you NEED Tier 2+. Lean flow + mini model is the way to test under Tier 1.

**RULE 2.4** — A filler/"thinking" sound MASKS a rate-limit stall but the response still FAILS (the caller never gets the real answer). Masking ≠ fixing. Fix the TPM.

---

## 3. Greeting — mode-specific, and a hard gotcha each

**RULE 3.1 (pipeline):** greet with `session.say(text, { allowInterruptions: false })`.

**RULE 3.2 (Realtime):** `session.say(text)` **THROWS** `"trying to generate speech from text without a TTS model"` — Realtime has no TTS plugin. Greet with `session.generateReply({ instructions: "...say this exact line..." })`.

**RULE 3.3 (Realtime):** do **NOT** pass `allowInterruptions: false` to `generateReply` — Realtime uses server-side turn detection and rejects it (`"allowInterruptions cannot be false ..."`), which leaves the session **not listening after the greeting → the caller's first turn is dropped → silence.** Omit it.

**RULE 3.4** — the greeting fires on session start. On the browser sim the agent may greet before the tester's mic is subscribed → "no greeting." Open the join URL FAST, or say "hello" to prompt. (Real PSTN doesn't have this race the same way.)

**RULE 3.5** — greeting is fire-and-forget; guard its rejection. `SpeechHandle` is a thenable with **no `.catch`** — wrap in `void (async()=>{ try{ await session.say/generateReply }catch{ log } })()`, never a bare `.catch`.

**RULE 3.6 (2026-08-14) — do the warm BEFORE pickup, and never wait AFTER it.** `waitForParticipant()` IS pickup. Anything you do after it — tenant-config fetch, greeting synthesis, cache fill — is dead air the caller is already listening to, and a receptionist does not answer the phone and then go quiet for several seconds. Dispatch metadata gives you `tenant_id` while the phone is still ringing, so fetch the config and synthesise the greeting there, and set the post-pickup wait to **zero**. This rule was learned backwards: the wait cap was *raised* to 12s so a slow local synthesis could finish, and the caller sat in silence after join and hung up. If the audio is not ready at pickup, speak live and take the lesser gap — never hold the line.

**RULE 3.7 (2026-08-14; prod-risk closed 2026-09-14) — a TTS engine can accept your connection and return no audio, which is indistinguishable from a dead line.** Aura's WebSocket `speak` path returned zero audio bytes from one dev host while the HTTP `collect` path returned audio on the same key, voice, and minute. **2026-09-14:** same Deepgram key as Railway prod + `npm run verify:tts` → 10/10 SPEAKS on the WS path; Railway `AURA_TTS_STREAMING` UNSET. Verdict = **dev-host-only artifact**, not a platform outage — prod keeps the streaming default. Still design for it: the greeting plays a collected frame, and `AURA_TTS_STREAMING=false` moves session replies to the collect path. The general rule is the one `verify:tts` exists to enforce: **a socket that opens is not audio that plays.** Prove bytes, not status codes.

---

## 4. Speaking primitives — what works where

- `session.say(text)` — synthesizes via TTS. **Pipeline only.** Throws in Realtime.
- `session.say(text, { audio })` — plays **pre-rendered** `AudioFrame`s, skips TTS. **Both modes.** This is how cached fillers work.
- `session.generateReply({ instructions })` — model generates a reply. **Both modes** (the Realtime greeting path).
- **NEVER call `session.say()` inside a tool's `execute()`** — it's a circular wait (tool holds the SpeechHandle; `say` waits on playout; mainTask blocks) → froze the call (#97). Now guarded by `SpeechHandleCircularWaitError`, but still forbidden. Speak from event/timer callbacks instead.
- Pre-render a cached clip once: `const frame = await tts.synthesize(text).collect()` → replay via `say(text,{audio: frameStreamOf(frame)})`. Zero TTS latency.

**RULE 4.1** — `mainTask` **serializes** the speech queue (`_waitForGeneration()` before popping next) → **audio frames never overlap.** Two queued speeches play back-to-back, never on top of each other. The only risk is *double-speak* (filler then reply), fixed by interrupting the filler. The `"rotateSegment called while previous segment is still being rotated"` warning is **harmless** (transcript-segment sync, not audio).

---

## 5. Tools / capabilities — non-freeze by construction

**RULE 5.1** — Every tool is built through `wrapToolExecute` (`agent/src/tools/wrapTool.ts`): **timeout (25s) + catch→string + never-empty.** So no tool — including a new one — can hang the turn, throw, or hand the model nothing. Build new capabilities through it; it's the contract.

**RULE 5.2** — `buildTools(ctx, client, transfer, outcome, speakFiller, { capabilities })` composes a subset. Capability groups: `knowledge | messaging | identity | scheduling | verification | transfer | sms` (`sms` is its own group so it can stay off until 10DLC lands). A customer script picks only what it needs (fewer tools = fewer tokens in Realtime).

**RULE 5.3** — `ToolsClient.call()` does NOT throw on 5xx — it RESOLVES `{ ok:false, status }`. Inspect `res.ok`; a bare `.catch()` won't catch a backend failure. It IS timeout-bounded (8s write / 16s read). Non-HTTP tool paths (e.g. SIP `transferSipParticipant`) have NO built-in timeout — wrap them (`Promise.race`).

**RULE 5.4** — backend `/agent-tools/*` must NEVER return a raw 500/JSON to the agent (it gets read aloud). On a handled failure (e.g. embeddings down) return a graceful `{success:true, result:"I don't have that — want to leave a message?"}` (see the RAG embedding try/catch).

**RULE 5.5 (anti-"LLM theater")** — __PERSONA_NAME__ MUST explicitly mandate the tool call ("you MUST call take_message; saying you'll pass it along without calling it means it's lost"). Models will otherwise *say* they did something without calling the tool.

---

## 6. Persona / prompt rules (per-tenant `tenants.system_prompt`)

**RULE 6.1** — The persona lives ONLY in the prod DB (`tenants.system_prompt`), not the repo. Back it up before editing (`SELECT system_prompt ...` → file). Restore-points matter — we used to keep `docs/aiassistant-persona-rich-backup-*.txt` (no such files exist in the repo today).

**RULE 6.2** — `customPrompt` replaces only the identity line; the platform prompt (conversation style, tools, OTP, booking discipline) is appended below it by `agent/src/prompt.ts`. So per-tenant personas inherit the platform rules.

**RULE 6.3 (Realtime)** — a top-of-prompt **VOICE & DELIVERY** directive steers tone/pace/accent (the model generates audio from instructions). Accent nudges toward the directive but the base voice's accent dominates — pick the base voice closest first (e.g. `ballad` is the most British-leaning OpenAI realtime voice). TTS (pipeline) ignores accent text (except `gpt-4o-mini-tts`'s `instructions` param, which we don't use).

**RULE 6.4** — keep personas LEAN for Realtime (every char is per-turn tokens). Enforce brief replies. Strip anything the flow doesn't use (long bios, unused branches) — they cost tokens every turn.

---

## 7. Interruption / turn-taking

**RULE 7.1 (pipeline `turnHandling.interruption`):** `mode:'adaptive'` (CNN barge-in, filters backchannels), `minWords:2` (the EFFECTIVE lever when STT is on — `minDuration` is INERT on the STT path per a LiveKit maintainer), `falseInterruptionTimeout:2000` + `resumeFalseInterruption:true` (resume if a detected interruption has no transcript). Endpointing `minDelay`/`maxDelay` is a latency-vs-completeness tradeoff (flat 1300/4000 to aggregate multi-part answers like spoken phone numbers; when the checklist-aware turn detector `agent/src/session/turnDetector.ts` is active it is 900/4500 and the detector picks per utterance).

**RULE 7.2 (Realtime):** turn-taking is server-side — don't pass pipeline turn options; let server VAD own it.

**RULE 7.3 (testing artifact):** the **browser sim call echoes** — the tester's mic picks up the agent's audio → false "new user turns" that interrupt the reply. Use **headphones** (or real PSTN with echo-cancellation) to validate interruption/turn behavior. Don't diagnose "it keeps cutting out" from a speaker-on sim call.

---

## 8. Dead air / never-silent (layered)

Sources of silence + the layer that covers each:
- TTS synthesis gap (pipeline) → streaming TTS (Deepgram Aura since 2026-07-14; ElevenLabs was never wired) or cached filler
- Reply cancelled by "hello?" → adaptive interruption + resume (RULE 7.1)
- Tool hang → `wrapTool` timeout (RULE 5.1)
- Tool empty/throw → `wrapTool` never-empty/catch
- Rate-limit stall (Realtime) → fix TPM (§2); filler only masks
- LLM stall / agent 'speaking' but no audio (#3418) → output watchdog
- Session-init throw → `runFallback` (+ ideally a pre-rendered static clip; provider-key outage shares the TTS failure domain)

**RULE 8.1** — the **output watchdog** (`agent/src/session/watchdog.ts`, behind `ENABLE_OUTPUT_WATCHDOG`) is the cause-agnostic backstop: arms on `agent_state=thinking`, plays a cached filler if no audio by a deadline, cancels on real audio. **Tuning matters:** its deadline must be LONGER than normal reply latency or it fires every turn (it did, at 2.5s, when pipeline TTS was 2–3s). With Realtime (sub-second) a 2.5s deadline is fine. **Default ON** (opt out with `ENABLE_OUTPUT_WATCHDOG=false`). Railway `secretary-hq-agent` is `true` as of 2026-08-28. Whether the filler *sounds* like cover and not a stutter is still a real-call check (RULE 10.4), not a CI gate.

**RULE 8.2 (thinking-sound bed)** — the **SFX cover** (`agent/src/session/thinkingSound.ts`, behind `ENABLE_THINKING_SOUND`) is a looping keyboard-typing ambiance played while `agent_state=thinking`, stopped on `speaking`. It uses LiveKit's built-in `voice.BackgroundAudioPlayer` (`thinkingSound: { source: voice.BuiltinAudioClip.KEYBOARD_TYPING, volume }`) — the framework owns the 2nd-track publish, looping, mixing, and agent-state wiring; we just attach/detach it. **Key difference from the watchdog:** `thinkingSound` has **no deadline knob** — it plays on *every* `thinking` transition. Under pipeline (~2–3s thinking every reply) that means a typing bed before essentially every turn. That's acceptable for an *ambient* bed (reads as "receptionist typing") where a spoken filler every turn was not (RULE 8.1). It's all-or-nothing per turn. **It MASKS dead air, doesn't fix it** (RULE 2.4) — a stalled/failed turn still fails. The bed and the watchdog filler are **independent flags and not layered** (the watchdog's `say()` → `speaking` would stop the bed; composing them is a future real-call design). Volume is an env knob (`THINKING_SOUND_VOLUME`, 0–1, default 0.5) so it's dial-able on a live call without a redeploy-by-merge. **Validate on a real call** (does the 2nd track mix through to PSTN, volume, feel) — OFF by default until then.

---

## 9. Observability — how to actually debug a call (don't guess)

**RULE 9.1 — measure first.** One timing test / one log pull beats hours of theorizing. (The original "freeze" was OpenAI TTS latency, guessed wrong ~5 times before a 2-min curl settled it.)

**RULE 9.2 — the error detail is in log *attributes*, not the message.** Railway `deploymentLogs.message` is just the rendered text; the real cause (`error_message`, `error_body`) is in structured attributes:
```
deploymentLogs(deploymentId,limit){ message attributes{key value} }
```
The `agent_session_error` log's `error_body` carries the provider's exact error (e.g. the TPM numbers). We added it specifically so realtime failures are diagnosable.

**RULE 9.3 — data sources that bypass throttled APIs:** prod `voice_sessions` (transcript/status/duration directly in the DB), `/metrics` (gated by `METRICS_TOKEN`: `tool_calls_total`, `booking_attempts_total`, `errors_total`), Railway `deploymentLogs` (team token via GraphQL), the agent boot marker (`event=agent_boot, build=...`) to confirm which code is live.

**RULE 9.4 — every sad/fire-and-forget path emits a metric (survives log truncation) + a 5W log naming the cause** (SQLSTATE/status/payload). This is what made calls diagnosable.

---

## 10. Deploy & config mechanics

**RULE 10.1** — Agent code deploys by **merge to `main`** → Railway auto-redeploys `secretary-hq-agent`. A branch push deploys nothing. An **env-var change auto-redeploys** too.

**RULE 10.2** — Ship risky/unvalidatable-in-CI features **flag-gated, default OFF**, so merge is inert; enable on Railway + validate on a real call; instantly reversible. (`ENABLE_REALTIME`, `UNTRUSTED_CALLER_ID_TENANTS`.) **Exception:** `ENABLE_OUTPUT_WATCHDOG` defaults ON (opt out with `false`) — dead air is worse than an unvalidated filler.

**RULE 10.3 — config knobs (env on `secretary-hq-agent`):** `ENABLE_REALTIME`, `REALTIME_MODEL` (verify id!), `REALTIME_VOICE`, `ENABLE_OUTPUT_WATCHDOG`, `ENABLE_THINKING_SOUND` + `THINKING_SOUND_VOLUME` (0–1, default 0.5), `UNTRUSTED_CALLER_ID_TENANTS`. Blank-in-UI env values bypass `.default()` — coerce blank→default (we do for `REALTIME_MODEL`/`VOICE`, and `THINKING_SOUND_VOLUME` clamps blank/invalid→0.5).

**RULE 10.4 — validate on a real/sim call, never CI alone.** Acoustic/timing/turn behavior has no unit-test seam. `./scripts/simulate.sh call --env prod --tenant <id>` → browser join URL → headphones. CI-green ≠ behavior-verified for voice.

---

## 11. Recipe — build a new customer voice script (checklist)

> **THIS RECIPE IS LADDER-ERA.** Steps 2–3 ("pick capabilities" → `buildTools`, "write a
> LEAN persona") describe the `SpeakingAgent` path, which a live call does not run —
> under question trees the composed persona is one line and the toolset is rebuilt from
> the selected trees. Steps 1, 4, 6 and 7 (mode, Realtime config, deploy-then-real-call,
> known gotchas) are still correct, because they are about the PIPELINE.
> **To build a call section under the live architecture, use
> `docs/voice/CALL_ARCHITECTURE.md` §8.4.**

1. **Pick the mode** (§0). Lean/cheap/high-volume → pipeline (+ streaming TTS). Premium feel + tier budget → Realtime.
2. **Pick capabilities** the flow needs → `buildTools(..., { capabilities: [...] })`. Fewer = fewer tokens.
3. **Write a LEAN persona** (§6): identity, the 1–3 actions, brief-reply directive, voice/delivery directive, MANDATE tool calls.
4. **Realtime?** set `REALTIME_VOICE` (verify), `REALTIME_MODEL` (verify id via §1), greet via `generateReply` (§3), expect TPM limits (§2) → mini model + slim persona under Tier 1, or raise tier.
5. **Wire/confirm tools** go through `wrapTool` (§5).
6. **Deploy** (merge to main; set env), **then real-call validate** with headphones (§10.4) and **pull the trace** (§9) — don't trust "it worked" from one happy turn.
7. **Watch for the known gotchas** (greeting say-vs-generateReply, allowInterruptions on Realtime greeting, model-id, TPM dead space, sim echo).

---

## Appendix — gotchas log (dated, append new ones)

- 2026-07-04 — toolselect eval baselines ROT with zero code change: while adding the 3 new tools (page_owner_via_sms / get_detailed_customer_history / send_self_service_link) + 2 new eval cases, the pre-existing `take_message` case turned up failing — the model replies in plain text ("I'll pass that along") without calling the tool. Verified NOT a regression: the same case fails on the UNMODIFIED main checkout (control run), so gpt-4o-mini's behavior drifted since the 6/6 baseline (2026-07-01). Two lessons: (1) when a toolselect case fails after a prompt/tool change, re-run the eval AGAINST MAIN first before blaming the diff — the 0.8 threshold exists precisely because these cases are probabilistic; (2) when writing a case for a tool with an optional-lookup path (e.g. send_self_service_link with appointment_id omitted = next upcoming), the `required` ordered-subsequence must allow the DIRECT call — listing the optional lookup in an earlier required set silently demands the target tool be called twice. Current baseline: 7/8 (the two new-tool cases pass; take_message is the drift casualty).

- 2026-07-04 — books early + confirms the WRONG time (PR #185): a caller asked for 4:30, the booking landed at 4:00 (`book_with_scheduling_atomic` takes the earliest open slot ≥ `window_from`), and the agent then CONFIRMED "4:30" — because `book_with_scheduling` handed the LLM the raw response JSON with no directive to read the actual `booked_start`. Two-part fix: (1) prompt/tool description now set `window_from` to EXACTLY the caller's picked time (a window starting earlier books earlier) — MITIGATES, doesn't prevent (a hard stop needs intent-aware slot selection in the RPC). (2) `formatBookingResponse()` (`agent/src/tools.ts`) surfaces the actual tenant-local `booked_time` + employee, and when the caller named a specific time (new optional `requested_start` tool param) and the slot differs, flags `time_changed` so the prompt (step 5 + a scoped exception to the one-confirmation rule) makes the agent say the real slot ("the 4:30 wasn't open — I got you 4:00, ok?"). Regression guard: mismatch fires ONLY off the explicit `requested_start`, never `window_from`, so the "next available" flow (window_from = search bound) gets no spurious "your 9am wasn't open" note. Backend already returned `booked_start`/`employee_name` (agentTools.ts:1677). tz-frame watch: `bookedTimeDiffers` compares local wall-clock digits — a genuine UTC instant in `requested_start` would false-fire. Unit-verified only; closes on a live specific-time-taken call + `toolselect` (OpenAI-gated).
- 2026-07-01 — booking over-confirm / re-check: after the caller PICKED a time from the slots already offered, the model said "let me check availability," **re-announced the same slot list**, and asked the caller to confirm a time they'd already confirmed — then booked. Root trigger (from the transcript, not a tool trace): the model treats a slot it already offered as still needing a fresh availability check, and that re-check regenerates the list. Fix (prompt, booking step 4): once the caller picks from offered slots you ALREADY have availability — never re-check, never re-announce the list, never re-confirm an already-confirmed time; go straight to `book_with_scheduling` + ONE confirmation. Carve-out preserved: a genuine mishearing you haven't cleanly captured (caller says "1 a.m." when only afternoon was offered) still gets ONE read-back — that's disambiguation, not re-confirmation. Same principle as "never re-ask name/phone." Verify only by a fresh call + transcript pull (prompt tuning has no build-time check).

- 2026-07-01 — booking tool-selection dead-end: `get_available_slots` returns SPOKEN times with NO resource_id, but `book_appointment`/`check_availability` REQUIRE a `resource_id` (`z.string().uuid()`). The LLM paired available_slots → book_appointment → Zod 400 (`validation_error`), so every booking silently failed ("having trouble pulling that up") even after the SQL-crash + tz fixes. Fix (prompt): steer to **book_with_scheduling** (self-contained window-based booking that finds the resource AND assigns staff — no resource_id) as the default after get_available_slots; only use book_appointment/check_availability with a real resource_id from get_scheduling_options. book_with_scheduling also fixes the "Unassigned" symptom (it assigns an employee; book_appointment to a bare resource leaves it staffless).

- **2026-07-14 — TTS moved to Deepgram Aura (CURRENT).** Aura streams over a WebSocket as words are produced, which is what actually killed the pipeline gap. The swap passed typecheck + 567 unit tests and took the line COMPLETELY SILENT: the plugin appends `?speed=` to the WS upgrade URL, Aura answers 400, the socket never opens. Hence `npm run verify:tts` (opens the real socket, demands real bytes) — mandatory before any TTS change ships. `tenants.tts_speed` is inert under Aura.
- 2026-06-25 — OpenAI TTS non-streaming = 2–3s dead air/reply; switched gpt-4o-mini-tts→Realtime to kill it. _(Superseded by the 2026-07-14 entry above — the pipeline was fixed by changing engine, not by moving to Realtime.)_
- 2026-06-26 — `gpt-4o-mini-realtime-preview` invalid id → dead call; real id `gpt-realtime-mini`.
- 2026-06-26 — Realtime greeting: `say(text)` throws (no TTS) → use `generateReply`; `allowInterruptions:false` on generateReply leaves it not-listening → silence after greeting.
- 2026-06-26 — Realtime TPM 40k (Tier 1) → mid-call dead space + failed appointment read-back (`rate_limit_exceeded`). Lean flow + mini model under Tier 1; Tier 2 ($50+7d) to widen.
- 2026-06-25 — output watchdog fires every turn if its deadline < reply latency; harmful under pipeline TTS; OK under Realtime. Keep it OFF until reworked. _(Superseded: now default ON — see RULE 8.1.)_
- 2026-06-25 — browser sim echo creates false interruptions; use headphones.
- 2026-06-29 — thinking-sound bed shipped (`ENABLE_THINKING_SOUND`, OFF) via LiveKit `BackgroundAudioPlayer` + bundled `KEYBOARD_TYPING` clip (no asset to source — ships in `@livekit/agents/resources`). `thinkingSound` has no per-turn deadline → plays before every reply in pipeline; fine as ambient, unlike a spoken filler. Independent of the watchdog; not layered. Volume = `THINKING_SOUND_VOLUME` env. Real-call validate PSTN mix + volume.
- 2026-06-24 — `caller_phone NOT NULL` blocked forwarded-line calls from logging; finalize on session `Close` (not job shutdown); transcript per-turn; dashboard auto-refresh.
