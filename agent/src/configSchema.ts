/**
 * The env SCHEMA — no side effects, so a test can import it.
 *
 * It used to live in config.ts, which parses process.env at module scope and
 * process.exit(1)s on a miss. That makes config.ts UNIMPORTABLE from a unit test:
 * merely importing it to read a default kills the test runner. So the defaults were
 * untestable — including ENABLE_OUTPUT_WATCHDOG, which is now the only thing
 * standing between a slow tool and dead air.
 *
 * A default nobody can assert is a default that will silently regress.
 */
import { z } from 'zod';

export const envSchema = z.object({
  LIVEKIT_URL: z.string().startsWith('wss://'),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),

  AGENT_SECRET: z.string().min(32),
  BACKEND_URL: z.string().url(),

  OPENAI_API_KEY: z.string().min(1),
  DEEPGRAM_API_KEY: z.string().min(1),
  // TTS is Deepgram Aura (DEEPGRAM_API_KEY above). Voice is per-tenant (dashboard →
  // tenants.tts_voice, mapped to an Aura model by toAuraVoice()), not env; tts_speed
  // is saved but inert under Aura. The old xAI/Grok TTS vars (XAI_API_KEY, XAI_TTS_VOICE/
  // SPEED/SOFT) were removed 2026-06-25 when the agent went fully OpenAI — they
  // are no longer required for the worker to boot (no XAI_API_KEY needed).

  // Output watchdog (the "never silent" backstop): a session-level timer plays a
  // cached holding phrase if no agent audio is produced within the deadline after
  // the caller's turn, then a recovery line.
  //
  // ON BY DEFAULT as of 2026-07-14. It used to ship inert, waiting for a real-call
  // validation that never came — and that was survivable only because something
  // ELSE was covering the gap: the system prompt told the model to say "one moment
  // while I look that up" before a slow tool.
  //
  // That instruction had to go. It was the thing letting the model NARRATE a
  // lookup instead of performing one — it said "one moment" three times on the
  // 2026-07-13 call and never called a tool, because a sentence satisfied the
  // instruction and a tool call is work. But deleting it removes the ONLY hold
  // line we had: speakFiller has been a NO-OP since 2026-06-25 (calling say() from
  // inside a tool's execute() froze the generation loop, #97).
  //
  // So the prompt fix, alone, would have traded a lying agent for a SILENT one —
  // 2-4s of dead air on every availability check. Dead air is the bug that has
  // taken this line down twice. The watchdog is the supported way to cover it: it
  // fires from a TIMER, never inside execute(), and speaks PRE-SYNTHESIZED audio
  // (PREGEN_LINES), so there is no TTS latency on the hold line itself.
  //
  // The point of the change is WHERE the hold line comes from. It is now spoken by
  // the RUNTIME, because a tool really is taking time — never by the model, as a
  // substitute for calling one. A machine cannot lie about work it did not do.
  //
  // Opt out with ENABLE_OUTPUT_WATCHDOG=false (instantly reversible, no deploy).
  ENABLE_OUTPUT_WATCHDOG: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),

  // SMS. OFF BY DEFAULT until 10DLC registration lands.
  //
  // Not one text this product has ever sent has reached a handset. The number is not
  // 10DLC-registered, so the carriers drop everything — Telnyx reports success and the
  // message dies silently (error 40010). communications_history has had zero delivered
  // rows for the life of the product.
  //
  // Meanwhile the agent has been PROMISING texts. On 2026-07-14 it closed a booking
  // with "You'll receive a text confirmation about your appointment shortly." Nothing
  // was ever going to arrive. That is the same lie we have spent this entire week
  // hunting — the agent claiming work that did not happen — except this time the code
  // agreed with it, and the carrier is the one who says no.
  //
  // An agent that CANNOT text must not be ABLE to say it will. So this gates the
  // record_sms_consent tool AND the prompt's whole texting section: with SMS off, the
  // model has no tool to text with and is told plainly that it cannot. You cannot
  // promise what you have no means to do.
  //
  // Flip to ENABLE_SMS=true the day the campaign is approved. Nothing else changes.
  ENABLE_SMS: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // PHONE VERIFICATION (the OTP code). ON by default — it is a SECURITY control, and a
  // security control must never be switched off by an omission, only by a decision.
  //
  // But it is currently a control that CANNOT RUN. It works by texting the caller a
  // code, and no text this product sends reaches a handset (10DLC, see ENABLE_SMS). So
  // on a forwarded line — where we have no caller ID and the OTP is the only way to
  // trust a spoken number — the agent asks the caller to read back a code that will
  // never arrive. They wait. Nothing comes. The booking dies.
  //
  // The design bug it exposed is worth keeping: **VERIFICATION GATES DISCLOSURE, NOT
  // CREATION.** A booking reveals nothing — the caller supplies every fact in it. An
  // undeliverable text was blocking an appointment it had no business blocking. Reading
  // someone their appointment history is a different matter, and stays gated.
  //
  // With this false, send_verification_code / verify_phone_code are removed from the
  // toolset AND from the prompt (they move together — GH #113: describing a tool the
  // model cannot call is how you get a hallucinated call and dead air), and the agent is
  // told that requires_verification does NOT stop it booking.
  //
  // Set ENABLE_PHONE_VERIFICATION=false on Railway until 10DLC lands.
  ENABLE_PHONE_VERIFICATION: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),

  // Thinking-sound bed: when "true", a looping keyboard-typing ambiance plays
  // while the agent is in the 'thinking' state and stops the instant it starts
  // speaking — covers the pipeline TTS gap / slow tool with a "receptionist is
  // typing" feel instead of dead air. Uses LiveKit's BackgroundAudioPlayer + the
  // bundled KEYBOARD_TYPING clip. OFF by default — acoustic + PSTN-mix behavior
  // can't be CI-verified; enable on Railway after a real-call check, instantly
  // reversible. NOTE: in pipeline mode the agent sits in 'thinking' ~2-3s every
  // reply, so the bed plays before essentially every turn (intended — ambient,
  // unlike a spoken filler that would read as broken). It MASKS dead air; it does
  // NOT fix a slow/failed turn (raise TPM / fix the tool for that — playbook §2.4).
  ENABLE_THINKING_SOUND: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Volume (0-1) of the thinking-sound bed. Env knob so it can be dialed in on a
  // real call with no code change (env edits auto-redeploy). Blank/invalid → 0.5.
  THINKING_SOUND_VOLUME: z
    .string()
    .optional()
    .transform((v) => {
      const n = v?.trim() ? Number(v.trim()) : NaN;
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.5;
    }),

  // OpenAI Realtime (speech-to-speech) mode: when "true", the agent uses
  // openai.realtime.RealtimeModel as the llm instead of the STT→LLM→TTS pipeline,
  // removing the TTS synthesis step (measured 2–3s/reply, non-streaming = dead
  // air). OFF by default — A/B test on Railway, instantly reversible. MODEL/VOICE
  // are the realtime model id + voice (realtime has its own voice set).
  // TASK-GROUP CALL FLOW (the spike). When "true", the call runs through a LiveKit
  // TaskGroup — identity → book → job-intake → schedule-change as host-code rungs the model
  // cannot skip — instead of the prompt-based ladder. The core flow was verified on a live
  // call 2026-07-15 (booked an appointment + recorded a job inquiry); the generic-rung core
  // and the cancel/reschedule rung are sim-verified but not yet voice-tested. Still OFF by
  // default and not ready to merge-and-enable — this flag lets a call be made without
  // disturbing the agent that answers the phone today. See src/tasks/.
  ENABLE_TASK_GROUP: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // QUESTION-TREE CALL FLOW (docs/QUESTION_TREE_ARCHITECTURE.md). The call runs
  // as ONE conversation over a host-tracked checklist of purpose-selected
  // question trees (src/checklist/) — it supersedes both the prompt ladder and
  // the TaskGroup rungs, and takes precedence over ENABLE_TASK_GROUP.
  //
  // ON BY DEFAULT since 2026-07-21 (Dale: "we aren't going back to the rung
  // system"). The flag is now a ROLLBACK ESCAPE HATCH, not an opt-in: set
  // ENABLE_QUESTION_TREE=false to fall back to the ladder without a redeploy
  // during the first real prod calls. Once question-tree has proven itself on
  // live PSTN traffic, stage 2 removes this flag AND the dead ladder/rung code.
  ENABLE_QUESTION_TREE: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),

  // CHECKLIST-AWARE TURN DETECTION (prototype 2026-07-21, src/session/
  // turnDetector.ts). ON by default but only ACTIVE under ENABLE_QUESTION_TREE:
  // a heuristic end-of-turn detector reads the live transcript + the
  // checklist's pending question and chooses, per utterance, between a snappy
  // commit (complete answer) and a patient wait (six digits of a phone number
  // is visibly incomplete). Set "false" to fall back to pure silence timing.
  ENABLE_SEMANTIC_TURN: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),

  ENABLE_REALTIME: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Coerce unset/blank/whitespace → the default (a blank env var in a deploy UI
  // would otherwise bypass .default() and break RealtimeModel init).
  REALTIME_MODEL: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : 'gpt-realtime')),
  REALTIME_VOICE: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim() : 'shimmer')),

  // Barge-in. When false (the DEFAULT), the caller CANNOT cut the agent off:
  // every agent utterance plays to completion. Their speech is not lost — STT
  // still transcribes it and it becomes the next turn once the agent finishes.
  //
  // WHY off by default (product decision 2026-07-12, after a real call):
  // barge-in is what makes the conversation script combinatorially hard. A caller
  // who talks over the agent cancels a half-delivered sentence, and the agent must
  // then reason about a state it never finished reaching — "did she hear the times
  // I offered? did she hear the disclosure?" — so every reply needs a branch for
  // "interrupted mid-way" and there is no end to them. Worse, the AI-identity
  // disclosure is a COMPLIANCE line: if a caller talks over it, we legally did not
  // say it. On the 2026-07-12 call the greeting was cut off mid-disclosure
  // ("...I'm an AI") and the agent then composed a SECOND, different greeting.
  //
  // The cost is real and accepted: a caller cannot cut off a long reply. Mitigated
  // by keeping replies short (the prompt already mandates 1–2 sentences) and by
  // offering ~2 slots at a time, not six.
  //
  // Set ALLOW_BARGE_IN=true to restore interruptions (they are then governed by
  // turnHandling.interruption: adaptive mode, minWords 2, false-interruption
  // resume — see index.ts).
  //
  // NOT HONORED IN REALTIME MODE: OpenAI's speech-to-speech owns barge-in
  // server-side and LiveKit's plugin rejects allowInterruptions:false. Realtime +
  // ALLOW_BARGE_IN=false is a contradiction; index.ts logs a warning.
  ALLOW_BARGE_IN: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // How long to wait for a SIP participant (the caller) to join before treating
  // the dispatch as a GHOST and leaving without greeting or opening a session.
  //
  // A real inbound PSTN call produces a participant in ~1-2s; a browser-sim join
  // (a human opening the meet URL) can take longer. This bounds the ABSENT case
  // only — waitForParticipant resolves the instant a participant joins, so a
  // real call is never delayed. The window must be generous enough that a
  // slow-but-real participant is never cut off (the OLD 5s behavior fell through
  // and greeted anyway, which quietly tolerated a late join; leaving does not,
  // so err long). Default 20s. Raise it (PARTICIPANT_WAIT_MS=30000) for leisurely
  // sim testing. Origin: 2026-07-23 double-dispatch — ghost legs greeted an empty
  // room and sat 300s to the reaper; this caps the ghost's life at the window.
  PARTICIPANT_WAIT_MS: z
    .string()
    .optional()
    .transform((v) => {
      const n = v?.trim() ? Number(v.trim()) : NaN;
      return Number.isFinite(n) && n >= 1000 && n <= 60000 ? n : 20000;
    }),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});
