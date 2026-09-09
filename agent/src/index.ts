/**
 * LiveKit agent worker entry point.
 *
 * On every dispatched call:
 *   1. Connect to the room
 *   2. Parse room.metadata for tenant_id (set by the SIP dispatch rule)
 *   3. Wait for the SIP participant, extract caller-ID phone + call_id
 *   4. Build tool handlers (closure-scoped over tenant + call context)
 *   5. Build system prompt with runtime context baked in
 *   6. Start the voice session; say a greeting
 *
 * Critical design: `tenant_id` is NEVER passed to the LLM — the LLM never
 * sees it, the prompt never references it. It lives in closure scope on
 * every tool handler. Same for `call_id`. The only things the LLM
 * provides are conversation-level values (phone, service name, times).
 */
// Initialize Sentry BEFORE other imports so an early bootstrap error
// still gets captured. No-op when SENTRY_DSN is unset.
import { initSentry, captureException as captureSentry } from './sentry.js';
initSentry();

import { type JobContext, WorkerOptions, cli, defineAgent, voice } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { runFallback } from './fallback.js';
import { reportDispatchNoParticipant } from './dispatchReport.js';
import { buildGreeting } from './greeting.js';
import { getLogger } from './logger.js';
import { sanitizeStream } from './speechSanitizer.js';
import { summarizeToolCalls } from './redactToolArgs.js';
import { buildSessionContext, callerIdIsForwardNumber } from './sessionContext.js';
import { fetchCustomerContext } from './customerContext.js';
import { fetchTenantConfig } from './tenantConfig.js';
import { ToolsClient } from './toolsClient.js';
import { buildTools } from './tools.js';
import { toolsForPhase, type CallPhase } from './toolPhases.js';
import { CallRootAgent } from './tasks/callRootAgent.js';
import { ChecklistAgent } from './checklist/checklistAgent.js';
import { createChecklistTurnDetector } from './session/turnDetector.js';
import { warmFillers, getFillerFrame, frameStream } from './session/fillerCache.js';
import {
  createOutageGuard,
  noteSessionError,
  noteAgentSpoke,
  OUTAGE_ERROR_LIMIT,
} from './session/outageGuard.js';
import { callPathHosts, warmDns, slowOrFailed } from './session/dnsWarm.js';
import { forceIpv4Enabled, installIpv4OnlyLookup, warmLookupFor } from './session/dnsIpv4.js';
import { idleProcessOverride } from './session/workerTuning.js';
import {
  greetingSpeakPath,
  canWarmGreetingBeforePickup,
  auraTtsStreamingEnabled,
} from './greetingPickup.js';
import {
  HOLD_LINE,
  THINKING_LINE,
  RECOVERY_LINE,
  RECOVERY_LINE_AFTER_MESSAGE,
  CALLER_CHECK_IN_LINE,
  CALLER_SILENCE_GOODBYE,
  OUTAGE_LINE,
  HOLD_LINES,
} from './session/holdLines.js';
import {
  attachOutputWatchdog,
  attachSilentTurnRecovery,
  attachCallerSilenceWatch,
} from './session/watchdog.js';
import { attachThinkingSound } from './session/thinkingSound.js';
import { resetCallActivity } from './session/toolActivity.js';
import { TurnLatencyCollector } from './session/turnLatency.js';
import { TranscriptRecorder } from './transcript.js';
import { ToolCallLog } from './toolCallLog.js';
import { CallOutcomeTracker } from './callOutcome.js';
import { summarizeCall } from './callSummary.js';
import { classifyCallOutcome } from './callClassify.js';
import { createTransferExecutor } from './transferClient.js';
import { buildSystemPrompt, formatDateForPrompt } from './prompt.js';

// DNS_FORCE_IPV4=true patches dns.lookup to ask for A records only, for hosts
// whose resolver stalls on AAAA. Installed at module load — before any plugin
// opens a socket — and it must run in the JOB process too, which imports this
// same file. Default off; see session/dnsIpv4.ts for the measurements and for
// why the real fix is the host's resolver.
if (forceIpv4Enabled()) {
  installIpv4OnlyLookup();
}

/**
 * Per-turn tool-call cap (see gotcha I in docs/BUILDING_SCRIPT_NOTES.md for
 * what hitting it does: the turn ends WITHOUT SPEECH). Parsed defensively —
 * `Number("")` is 0 and `Number("abc")` is NaN, and either handed to LiveKit
 * as maxToolSteps would cripple tool calling outright, which is a worse
 * outage than the one this knob exists to tune. Gotcha A's blank-string
 * lesson, env-var edition: a misconfigured value falls back to 5, never to 0.
 */
const MAX_TOOL_STEPS = (() => {
  const parsed = Number.parseInt(process.env.MAX_TOOL_STEPS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 5;
})();

/**
 * A duration from the environment, or the default — never NaN, never 0.
 *
 * `Number('')` is 0 and `Number('abc')` is NaN, and setTimeout treats BOTH as
 * "fire immediately". For the caller-silence timers that means a typo in an env
 * var checks in on the caller the instant the agent stops talking, then hangs up
 * on them — a misconfiguration that ends calls (review catch on #314). Same
 * shape as MAX_TOOL_STEPS above, for the same reason.
 */
function envMs(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The tenant's saved voice, mapped to its nearest Deepgram Aura equivalent.
 *
 * The dashboard picker stores OpenAI voice ids (shimmer/nova/…), and owners have
 * already chosen one. Switching the TTS engine must not silently reset their voice
 * or make the picker meaningless, so the saved value is honoured — translated, not
 * discarded. Matched on timbre: the two feminine-bright voices go to Asteria/Luna,
 * the neutral ones to Stella/Athena, the masculine ones to Orion/Arcas.
 *
 * Anything unknown (a legacy Grok id, a typo) falls back to Asteria rather than
 * erroring at the API — the same fail-soft contract toOpenAIVoice has always had.
 */
const AURA_BY_OPENAI_VOICE: Record<string, DeepgramVoice> = {
  shimmer: 'aura-asteria-en',
  nova: 'aura-luna-en',
  alloy: 'aura-stella-en',
  echo: 'aura-athena-en',
  onyx: 'aura-orion-en',
  fable: 'aura-arcas-en',
};
type DeepgramVoice =
  | 'aura-asteria-en'
  | 'aura-luna-en'
  | 'aura-stella-en'
  | 'aura-athena-en'
  | 'aura-orion-en'
  | 'aura-arcas-en';

function toAuraVoice(v: string | null | undefined): DeepgramVoice {
  return (v && AURA_BY_OPENAI_VOICE[v]) || 'aura-asteria-en';
}

export default defineAgent({
  prewarm: async (proc) => {
    // WHAT CODE IS THIS WORKER ACTUALLY RUNNING?
    //
    // This used to be a hand-written string: build:'spoken-phone-v3-openai-tts',
    // features:[…,'untrusted_caller_id',…]. UNTRUSTED_CALLER_ID was deleted from this
    // codebase weeks ago. The stamp had been lying ever since, which makes it worse
    // than no stamp: it answers the question confidently and wrongly.
    //
    // It cost a real call. On 2026-07-14 the owner was told the voice fix was live
    // because `simulate.sh --deep` reported "dispatch picked up" — which proves the
    // worker is ALIVE, not that it is NEW. His call ran on the old binary; the worker
    // did not actually restart until five minutes after he hung up. This is the exact
    // stale-binary trap CLAUDE.md warns about, and a hand-maintained version string is
    // no defence against it, because nobody remembers to bump it.
    //
    // Railway injects the deployed commit. Print THAT. A stamp that a human has to
    // remember to update is a stamp that will eventually lie.
    const commit =
      process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 8) ??
      process.env.GIT_COMMIT_SHA?.slice(0, 8) ??
      'unknown';
    getLogger().info(
      {
        event: 'agent_boot',
        commit,
        booted_at: new Date().toISOString(),
        // NOT hardcoded. Realtime mode is speech-to-speech and has NO Deepgram TTS at
        // all — a stamp that says "deepgram-aura" on a Realtime worker is a NEW lying
        // stamp inside the PR that fixes a lying stamp. Report what will actually run.
        tts: process.env.ENABLE_REALTIME === 'true' ? 'openai-realtime (s2s)' : 'deepgram-aura',
      },
      `secretary-hq-agent worker booting — commit ${commit}`
    );
    // LET PEOPLE FINISH THEIR SENTENCES.
    //
    // We were running Silero's defaults, and its minSilenceDuration is 550ms. Half a
    // second of silence is not the end of a thought — it is a person RECALLING
    // something. On the 2026-07-14 call Dale said "I was hoping to speak to him about
    // a contract that I possibly have from…", paused to bring the company name to
    // mind, and the agent decided he was done and asked him what the company was. He
    // had to stop it and say "hey, you didn't get the company name."
    //
    // It is worse than an ordinary interruption because BARGE-IN IS OFF by product
    // decision (ALLOW_BARGE_IN, default false): once the agent starts talking the
    // caller cannot talk over it. So an early endpoint is unrecoverable — they must
    // sit and listen to a question they were already answering.
    //
    // 900ms costs ~350ms of extra latency before the agent replies. That is a good
    // trade: a beat of silence reads as "listening"; cutting someone off reads as
    // "not listening", and it is the single rudest thing a receptionist can do.
    // Tunable on a real call without a code change.
    // 1300ms, not 900. And 900 was already up from Silero's 550 default.
    //
    // The thing that keeps breaking is PHONE NUMBERS. Nobody says a phone number as
    // one continuous run of sound — they say it in chunks, with a beat between them:
    // "eight eight eight … six five six … one one eight two". Those beats are a
    // SECOND long, easily. At 900ms the endpointer decided the caller was finished
    // after the area code, and the agent talked over the rest of his own number. He
    // reported it twice: "you never took my phone number", and "doesn't wait for me to
    // say my phone number."
    //
    // A phone number is the single most important string a receptionist collects, and
    // it is the one most likely to contain a pause. Bias the whole call toward
    // patience: being a little slow reads as "listening". Talking over someone reads
    // as "not listening", and here it is unrecoverable — barge-in is off, so once the
    // agent starts, the caller must sit and listen to the end.
    //
    // 1300ms IS THE CEILING — 1800 was tried and REVERTED the same day (2026-07-21).
    // The raise to 1800 (bought by yet another mid-number cutoff) created a LIVELOCK
    // on the very next call: the caller finished a sentence, waited about a second for
    // a reply, got silence (the VAD still counting to 1.8s), assumed he wasn't heard,
    // and resumed talking — which reset the counter. His patience threshold (~1–1.5s)
    // was SHORTER than the endpoint, so no turn could EVER commit: 13 seconds of
    // speech, 14 STT fragments, zero response, hang-up. A silence threshold above the
    // caller's own re-speak reflex is not "patient", it is deaf.
    //
    // So the two failure modes now box the value in from both sides: below ~1300 the
    // agent cuts off number-recall pauses; above ~1500 it livelocks against normal
    // conversational pacing. A single fixed threshold cannot serve both — the real fix
    // is semantic/content-aware endpointing. Until then 1300 is the least bad point:
    // cutoffs are rarer than every-turn conversation, and a cutoff has a recovery
    // path ("it seems you got cut off — please finish") while a livelock has none.
    //
    // AND NOW THE REAL FIX EXISTS (2026-07-21, prototype): under the question-tree
    // flow with ENABLE_SEMANTIC_TURN, the checklist-aware turn detector
    // (src/session/turnDetector.ts) reads the WORDS — a partial phone number waits,
    // a crisp "yes" commits — so the VAD can drop back near Silero's default and
    // stop being the only judge of "done". The 1300 fallback stands whenever the
    // detector is off.
    // Mirror configSchema's defaults exactly (question-tree ON unless 'false',
    // semantic-turn ON unless 'false') — config isn't loaded yet in prewarm.
    const semanticTurn =
      process.env.ENABLE_QUESTION_TREE !== 'false' && process.env.ENABLE_SEMANTIC_TURN !== 'false';
    const minSilenceMs = Number(process.env.VAD_MIN_SILENCE_MS ?? (semanticTurn ? 600 : 1300));

    // RESOLVE THE CALL PATH'S HOSTS WHILE NOBODY IS LISTENING.
    //
    // 2026-08-15, measured on a browser sim call: the greeting landed 11,765 ms
    // after the caller joined with `pregenerated: true` — the frame was cached
    // and the caller still heard ~12 seconds of nothing. The wait was one DNS
    // lookup: `dns.lookup('api.deepgram.com')` took 11,069 ms on this host
    // because getaddrinfo waits for the AAAA answer and the WSL resolver takes
    // 11 s to give one (`dns.resolve4` alone: 24 ms; the same AAAA query against
    // 1.1.1.1: 46 ms). Every FIRST outbound connection in a fresh job process
    // pays it.
    //
    // Fire-and-forget on purpose. Awaiting it here would just move the same
    // 11 s in front of the same caller whenever a process is spawned on demand
    // (numIdleProcesses is 0 in dev mode). Unawaited, it runs concurrently with
    // VAD load and finishes during the idle window when there IS one — which is
    // the case in production, where the pool is pre-spawned. Failure is silent
    // by design: the call path resolves DNS itself regardless.
    void warmDns(callPathHosts(), { lookup: warmLookupFor() }).then((results) => {
      const flagged = slowOrFailed(results);
      const payload = {
        event: 'dns_warm',
        hosts: results.length,
        slow_or_failed: flagged.map((r) => `${r.host}:${r.ok ? '' : 'FAIL:'}${r.ms}ms`),
      };
      if (flagged.length > 0) {
        // A slow resolver here is the early warning for dead air at pickup —
        // it belongs at warn level with the number attached, not buried.
        getLogger().warn(
          payload,
          'DNS warm found a slow or failing host — a caller would wait this long at pickup'
        );
      } else {
        getLogger().info(payload, 'DNS warm complete — call-path hosts resolved before pickup');
      }
    }, undefined);

    proc.userData.vad = await silero.VAD.load({
      minSilenceDuration: Number.isFinite(minSilenceMs) ? minSilenceMs : 900,
    });
  },

  entry: async (ctx: JobContext) => {
    // GREETING-LATENCY REFERENCE POINTS. Both 2026-08-13 calls show the greeting
    // at [0:17] on the transcript clock — consistent enough to be structural,
    // and never actually measured, because the transcript clock is not the
    // caller's clock. What the caller experiences is answer → first audio, and
    // the two reference points that bracket it are entry (the job starts) and
    // the participant joining (the leg is up). MEASURE before fixing: the last
    // voice "freeze" turned out to be TTS, not any of the things that were
    // guessed at, and a whole afternoon went into the guesses.
    // Module-level per-call state starts CLEAN, whether or not this process has
    // handled a call before (see session/toolActivity.ts). Two assignments, and
    // the "are job processes reused?" question stops mattering.
    resetCallActivity();
    const entryAtMs = Date.now();
    let participantAtMs: number | null = null;

    await ctx.connect();

    const log = getLogger();
    log.info({ event: 'call_start', room: ctx.room.name }, 'agent entry — call dispatched');

    // 1. Tenant_id from dispatch metadata (preferred — set on the agent
    //    job by the LiveKit dispatch rule's "Dispatch metadata" field)
    //    falling back to room metadata. Robust to either wiring.
    const jobMetadata = ctx.job.metadata;
    const roomMetadata = ctx.room.metadata;
    const preliminaryCtx = buildSessionContext({
      jobMetadata,
      roomMetadata,
      participantAttributes: null, // SIP participant not joined yet
    });
    if (!preliminaryCtx) {
      // Dispatch rule misconfigured — no tenant_id means we can't safely
      // do anything. Start a bare session and say a fallback message.
      log.error(
        { event: 'fallback_triggered', reason: 'dispatch_metadata_invalid', room: ctx.room.name },
        'no tenant_id in dispatch/room metadata — running fallback'
      );
      captureSentry(new Error('dispatch_metadata_invalid'), {
        event: 'fallback_triggered',
        reason: 'dispatch_metadata_invalid',
        room: ctx.room.name,
      });
      await runFallback(
        ctx,
        "I'm sorry, we're having a system issue. Please try calling back in a moment.",
        config
      );
      return;
    }

    // 2. Tenant config + greeting warm BEFORE pickup.
    //    A receptionist does not answer and then wait 3–12s for TTS. Dispatch
    //    already has tenant_id. Fetch config and start collect() while the
    //    phone can still be ringing (or while join-first has not yet been
    //    treated as answered). waitForParticipant is pickup.
    const earlyClient = new ToolsClient({
      backendUrl: config.BACKEND_URL,
      agentSecret: config.AGENT_SECRET,
    });
    let warmedTenant: Awaited<ReturnType<typeof fetchTenantConfig>> | undefined;
    let warmedVoice: DeepgramVoice | undefined;
    let warmedGreeting: string | undefined;
    let warmedGreetingP: Promise<unknown> = Promise.resolve();
    if (canWarmGreetingBeforePickup(preliminaryCtx.tenantId)) {
      warmedTenant = await fetchTenantConfig(earlyClient, preliminaryCtx.tenantId);
      warmedVoice = toAuraVoice(warmedTenant.ttsVoice);
      warmedGreeting = buildGreeting(warmedTenant);
      {
        const tts = new deepgram.TTS({
          apiKey: config.DEEPGRAM_API_KEY,
          model: warmedVoice,
        }) as unknown as Parameters<typeof warmFillers>[0];
        warmedGreetingP = warmFillers(tts, warmedVoice, [warmedGreeting]);
        void warmedGreetingP
          .then(() => warmFillers(tts, warmedVoice!, [...HOLD_LINES]))
          .then(
            ({ warmed, failed }) =>
              log.info(
                { event: 'pregen_warmed', warmed: warmed.length, failed: failed.length },
                `pre-generated ${warmed.length} hold line(s); ${failed.length} failed (they fall back to live synthesis)`
              ),
            () => undefined
          );
      }
    }

    // 3. Wait for the SIP participant (the caller) to join, to get caller-ID
    //    phone + callID.
    //
    //    THE GHOST-DISPATCH GUARD (2026-07-23). A REAL inbound call — or a
    //    browser-sim join — always produces a participant. A room that never
    //    gets one is a DUPLICATE/GHOST dispatch: the double-dispatch bug creates
    //    a second, empty room per call, and the old code here greeted it and
    //    opened a voice_sessions row anyway — the phantom 300s / 0-turn "call"
    //    in the Calls tab that then got a fabricated summary. The comment used to
    //    say "bail rather than hang silent"; it never did. Now it does: if no
    //    participant joins within the window, LEAVE without greeting or opening a
    //    session (returning ends the job and closes the empty room now, not at
    //    the 300s reaper). The window is generous (config.PARTICIPANT_WAIT_MS,
    //    default 20s) so a slow-but-real participant is never cut off —
    //    waitForParticipant resolves the instant one joins, so a real call is
    //    not delayed; the window only bounds the ABSENT case.
    let participantAttributes: Record<string, string> | null = null;
    let participantIdentity: string | null = null;
    let sawParticipant = false;
    try {
      const sipParticipant = await Promise.race([
        ctx.waitForParticipant(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), config.PARTICIPANT_WAIT_MS)),
      ]);
      if (sipParticipant) {
        sawParticipant = true;
        participantAtMs = Date.now();
        participantAttributes = sipParticipant.attributes;
        // Identity is the handle the SIP transfer (cold REFER) targets — capture
        // it now so transfer_call can hand the live leg off to a human.
        participantIdentity = sipParticipant.identity;

        // DIAGNOSTIC (2026-07-12): log the SIP attribute KEYS the carrier actually
        // sent, plus whether the one we key caller-ID off is among them.
        //
        // Why this exists: on the 2026-07-12 call the caller dialed the number
        // DIRECTLY, yet caller_phone landed NULL — so the agent asked a caller who
        // had a perfectly good caller ID to read out her own number. We could not
        // tell from the data whether (a) Telnyx/LiveKit never sent
        // `sip.phoneNumber`, or (b) one of our own guards nulled it. `sip.callID`
        // DID arrive (the call is in the Calls tab), so the attribute bag was
        // present — which makes (a) a real possibility, not a stretch.
        //
        // Keys only, never values: an attribute bag can carry PII and this line
        // runs on every call. The presence flags are what disambiguate; the values
        // would tell us nothing extra.
        log.info(
          {
            event: 'sip_attributes_received',
            attribute_keys: Object.keys(participantAttributes ?? {}).sort(),
            has_sip_phone_number: Boolean(participantAttributes?.['sip.phoneNumber']),
            has_sip_from: Boolean(participantAttributes?.['sip.from']),
            has_sip_call_id: Boolean(participantAttributes?.['sip.callID']),
          },
          'SIP participant attributes — what the carrier actually sent'
        );
      }
    } catch {
      // Non-fatal — we can still greet without a caller phone
      participantAttributes = null;
    }

    if (!sawParticipant) {
      // No caller ever joined this room — a ghost/duplicate dispatch. Do NOT
      // open a voice_sessions row and do NOT greet an empty room. Emit the
      // metric (durable counter on the backend /metrics board) + a 5W log, then
      // return: that ends the LiveKit job and closes the room now.
      log.warn(
        {
          event: 'dispatch_no_participant',
          tenant_id: preliminaryCtx.tenantId,
          room: ctx.room.name,
          waited_ms: config.PARTICIPANT_WAIT_MS,
        },
        'no SIP participant joined within the window — treating as a ghost/duplicate dispatch, leaving without greeting'
      );
      void reportDispatchNoParticipant(config, {
        tenantId: preliminaryCtx.tenantId,
        room: ctx.room.name,
      });
      return;
    }

    const sessionCtx = buildSessionContext({
      jobMetadata,
      roomMetadata,
      participantAttributes,
      roomName: ctx.room.name,
      participantIdentity,
    });
    if (!sessionCtx) {
      // Shouldn't happen — preliminaryCtx already succeeded — but be safe
      log.error(
        {
          event: 'fallback_triggered',
          reason: 'session_context_lost',
          tenant_id: preliminaryCtx.tenantId,
          room: ctx.room.name,
        },
        'session context unexpectedly null after participant join — running fallback'
      );
      captureSentry(new Error('session_context_lost'), {
        event: 'fallback_triggered',
        reason: 'session_context_lost',
        tenant_id: preliminaryCtx.tenantId,
        room: ctx.room.name,
      });
      await runFallback(ctx, "I'm sorry, we're having a system issue.", config);
      return;
    }

    // Per-call child logger — every subsequent line on this call carries
    // tenant_id + call_id + caller_phone so a Better Stack filter pulls
    // the full timeline for "the call at 2:14pm" support questions.
    const callLog = log.child({
      tenant_id: sessionCtx.tenantId,
      call_id: sessionCtx.callId,
      caller_phone: sessionCtx.callerPhone ?? null,
      room: ctx.room.name,
    });
    callLog.info({ event: 'session_context_resolved' }, 'tenant + caller resolved');

    // 3. Build tools client + fetch the tenant's display config. The
    //    fetch is a single round-trip to /agent-tools/tenant-config; on
    //    any failure (5xx, 401, missing fields, unknown tenant) it
    //    soft-falls to "this business" / America/Chicago so a config
    //    blip never hangs up a live caller. See agent/src/tenantConfig.ts.
    //
    //    Outer try/catch: if anything from here through session.start throws
    //    unexpectedly (e.g. a constructor error, a rejected promise slipping
    //    past fetchTenantConfig's internal guard), propagation out of entry
    //    kills the LiveKit job and leaves the caller in dead air. The outer
    //    catch degrades to a fallback message instead of silence.
    let client: ToolsClient;
    let tenantConfig: Awaited<ReturnType<typeof fetchTenantConfig>>;
    // Resolved the INSTANT the tenant is known, so the greeting can be synthesised
    // while the phone is still ringing. See the warm block below.
    let ttsVoiceKey: DeepgramVoice;
    let greeting: string;
    // Accumulates the spoken conversation (caller STT + agent replies) so the
    // shutdown callback can persist it as the call's transcript. Declared here
    // — above both the shutdown registration and the session listener — so both
    // close over the same recorder.
    const transcript = new TranscriptRecorder();
    // Same lifecycle as the transcript: fed by the FunctionToolsExecuted
    // listener, shipped once at finalize into voice_sessions.metadata. The Pino
    // copy of the same data rotates with the container (2026-07-28 restart ate
    // every tool trace for the 07-27 calls — CALL_IMPROVEMENTS.md); this one
    // lands in the row next to the transcript it explains.
    const toolCallLog = new ToolCallLog();
    // INBOUND-AUDIO EVIDENCE. Two independent counters that, read together at
    // finalize, say WHERE a caller's speech was lost — the one distinction that
    // matters when a call comes back empty, and the one that is impossible to
    // recover after the fact because both signals are in-memory only.
    //
    //   vadSpeechEvents  — Silero VAD transitions to 'speaking'. Silero runs
    //                      LOCALLY on the raw decoded frames (see the session's
    //                      `vad:` option), BEFORE any network hop to Deepgram.
    //   sttTranscribed   — LiveKit UserInputTranscribed events (Deepgram output).
    //
    // Reading the pair:
    //   vad=0, stt=0  → NO DECODABLE AUDIO REACHED THE PROCESS. Media/codec/RTP,
    //                   upstream of us. Not the caller, not Deepgram, not the
    //                   prompt. This is what the 2026-07-24 silent calls looked
    //                   like and it took a manual log dig to establish.
    //   vad>0, stt=0  → audio arrived and Deepgram returned nothing: STT socket,
    //                   API key, or model. A completely different fix.
    //   vad>0, stt>0  → speech was captured; any emptiness is downstream.
    let vadSpeechEvents = 0;
    let sttTranscribed = 0;
    // Per-turn latency samples, shipped on voice-session-end so the backend can
    // observe them into the `turn_latency_ms` histogram (T-006). The agent has
    // no scrapeable registry of its own — see session/turnLatency.ts.
    const turnLatency = new TurnLatencyCollector();
    // Tracks what happened on the call (booked / transferred + appointment_id),
    // mutated by the booking/transfer tools, read at shutdown for session-end.
    const outcomeTracker = new CallOutcomeTracker();
    // Accumulates per-model AI usage (LLM tokens, STT audio, TTS chars) from
    // LiveKit's SessionUsageUpdated events. Updated during the call; read once
    // at shutdown to POST costs to /agent-tools/record-ai-cost.
    // Shape matches RecordAiCostSchema.model_usage — LiveKit's Partial<ModelUsage>
    // is wider (cached/audio token splits) so we snapshot only what the ledger stores.
    type CostUsageItem = {
      type: 'llm_usage' | 'tts_usage' | 'stt_usage' | 'interruption_usage';
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      charactersCount: number;
      audioDurationMs: number;
    };
    const COST_USAGE_TYPES = new Set<CostUsageItem['type']>([
      'llm_usage',
      'tts_usage',
      'stt_usage',
      'interruption_usage',
    ]);
    function snapshotCostUsage(raw: {
      type?: string;
      provider?: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      charactersCount?: number;
      audioDurationMs?: number;
    }): CostUsageItem | null {
      const type = raw.type;
      if (typeof type !== 'string' || !COST_USAGE_TYPES.has(type as CostUsageItem['type'])) {
        return null;
      }
      const num = (v: number | undefined): number =>
        typeof v === 'number' && Number.isFinite(v) ? v : 0;
      return {
        type: type as CostUsageItem['type'],
        provider: raw.provider ?? '',
        model: raw.model ?? '',
        inputTokens: num(raw.inputTokens),
        outputTokens: num(raw.outputTokens),
        charactersCount: num(raw.charactersCount),
        audioDurationMs: num(raw.audioDurationMs),
      };
    }
    let sessionModelUsage: CostUsageItem[] = [];
    try {
      client = earlyClient;

      // Call logging (2026-06-11): persist a voice_sessions row so the
      // dashboard Calls tab + customer call history populate. START is
      // fire-and-forget — it must NEVER delay the greeting or risk dead air,
      // so a failure is logged and swallowed. END is awaited inside the
      // shutdown callback so duration lands before the job tears down.
      // finalizeCall is assigned inside the callId block below and invoked from
      // the session 'close' event (registered after session.start). Declared at
      // this scope so the close handler can see it. Null when there's no callId.
      let finalizeCall: ((hook: 'close' | 'shutdown' | 'outage') => Promise<void>) | null = null;
      // Skipped when callId is absent (nothing to key the session on).
      if (sessionCtx.callId) {
        const callId = sessionCtx.callId;
        const startedAtMs = Date.now();
        // 5W sad path: callLog already carries tenant_id/call_id/caller_phone/
        // room (WHO/WHERE). ToolsClient.call() does NOT throw on a backend 5xx —
        // it RESOLVES to { ok:false, error, status } — so we must inspect the
        // result, not only .catch() (which fires only on a network/throw). Both
        // branches log the breadcrumb that this call never created a
        // voice_sessions row (so it won't show in the Calls tab). The backend
        // logs the pg SQLSTATE/constraint; this is the agent-side marker.
        void client
          .call('/agent-tools/voice-session-start', {
            tenant_id: sessionCtx.tenantId,
            call_id: callId,
            caller_phone: sessionCtx.callerPhone ?? null,
          })
          .then((res) => {
            if (!res.ok) {
              callLog.error(
                {
                  event: 'voice_session_start_failed',
                  forwarded_line: sessionCtx.callerPhone == null,
                  status: res.status ?? null,
                  error_message: res.error,
                },
                'call-logging START failed (non-fatal to the live call) — this call will NOT appear in the Calls tab'
              );
            }
          })
          .catch((e: unknown) =>
            callLog.error(
              {
                event: 'voice_session_start_failed',
                forwarded_line: sessionCtx.callerPhone == null,
                error_message: e instanceof Error ? e.message : String(e),
              },
              'call-logging START threw (non-fatal to the live call) — this call will NOT appear in the Calls tab'
            )
          );
        // Fire-once writer of the call's completion record. Invoked from BOTH
        // the session 'close' event (participant hangup — the reliable signal)
        // and ctx.addShutdownCallback (job teardown — backstop). On a single
        // hangup the worker often stays alive for the next job, so the shutdown
        // callback may never run; 'close' is what actually fires. The guard makes
        // the first caller win; the other no-ops. (A server-side reaper catches
        // anything that still slips through.)
        // callFinalized flips true ONLY after a successful finalize write, so a
        // failed 'close' attempt leaves the shutdown backstop free to retry.
        // finalizing dedupes concurrent entry (close + shutdown firing together).
        let callFinalized = false;
        let finalizing = false;
        finalizeCall = async (hook: 'close' | 'shutdown' | 'outage'): Promise<void> => {
          if (callFinalized || finalizing) return;
          finalizing = true;
          callLog.info({ event: 'voice_session_finalize_entered', hook }, 'finalizing call record');
          try {
            const rendered = transcript.render();
            const { outcome: trackedOutcome, appointmentId } = outcomeTracker.result();
            const durationSeconds = Math.round((Date.now() - startedAtMs) / 1000);

            // The caller said nothing we could hear. Emit the verdict WITH the
            // evidence, while the counters still exist — they are in-memory and
            // die with this process. The backend raises the alarm (errors_total
            // no_caller_audio); this line is what tells you which layer to fix.
            if (!transcript.hasCallerTurn()) {
              callLog.warn(
                {
                  event: 'no_caller_audio',
                  vad_speech_events: vadSpeechEvents,
                  stt_transcribed_events: sttTranscribed,
                  duration_seconds: durationSeconds,
                  agent_spoke: rendered != null,
                  likely_layer:
                    vadSpeechEvents === 0
                      ? 'inbound_media' // codec/RTP — nothing decodable arrived
                      : sttTranscribed === 0
                        ? 'stt' // audio arrived, Deepgram returned nothing
                        : 'downstream', // speech captured but no turn committed
                },
                'call ended with NO caller turn — see likely_layer for where the speech was lost'
              );
            }

            // 1. FINALIZE FIRST — close the row with the data we already have,
            //    BEFORE the slow LLM steps below. An abrupt disconnect/process
            //    teardown during summarize/classify must not strand the row
            //    'active' with no duration/transcript (the exact bug seen on the
            //    first real __PERSONA_NAME__ call). end_voice_session overwrites by
            //    (tenant_id, call_id) with no status guard, so the enrich pass
            //    can safely add summary/outcome afterward. trackedOutcome is only
            //    ever a real tool outcome (booked/transferred/message) — never the
            //    classify-only price/no_availability that triggers the owner SMS
            //    — so this first write can't double-send that alert.
            const finalizeRes = await client.call('/agent-tools/voice-session-end', {
              tenant_id: sessionCtx.tenantId,
              call_id: callId,
              duration_seconds: durationSeconds,
              // null when nothing was spoken (e.g. silent hang-up) → SQL NULL.
              transcript: rendered,
              outcome: trackedOutcome,
              appointment_id: appointmentId,
              // Persisted tool trace (voice_sessions.metadata.tool_calls) —
              // omitted entirely when no tool fired. Only this first call
              // carries it; the enrich pass merges nothing, so a re-SET of the
              // other columns can't erase it.
              tool_calls: toolCallLog.toPayload() ?? undefined,
              // Turn latencies measured during THIS call. Omitted entirely when
              // no turn was measured (silent hang-up) — an empty array would
              // read as a call with zero-latency turns.
              turn_latency_ms: turnLatency.toPayload(),
            });
            // ToolsClient.call() resolves { ok:false } on a backend 5xx (does NOT
            // throw), so the catch below won't fire on a 500 — inspect the result
            // so a finalize failure (row left active, no duration/transcript) is
            // actually logged, not silently swallowed.
            if (!finalizeRes.ok) {
              callLog.error(
                {
                  event: 'voice_session_end_failed',
                  phase: 'finalize',
                  status: finalizeRes.status ?? null,
                  outcome: trackedOutcome,
                  has_transcript: rendered != null,
                  error_message: finalizeRes.error,
                },
                'call-logging FINALIZE failed — row may stay active with no duration/transcript'
              );
              // Leave callFinalized=false so the shutdown backstop (or, failing
              // everything, the server-side reaper) can still close this row.
              return;
            }
            // Finalize succeeded — safe to suppress retries now.
            callFinalized = true;

            // 2. Best-effort enrichment — bounded LLM summary + outcome class.
            //    Both are bounded + failsafe (resolve null on timeout/error), so
            //    they can never undo the finalize above. classifyCallOutcome
            //    names WHY the caller reached out when no tool set an outcome.
            //
            //    GUARD: only enrich when the CALLER actually spoke. A
            //    greeting-only call has nothing to summarize, and handing the
            //    greeting alone to the summary model makes it FABRICATE an
            //    outcome from the greeting's own menu ("left a message" when no
            //    message exists — real call 2026-07-23). No caller turn → no
            //    LLM summary/classify; the finalize above already stored the
            //    real duration + (greeting-only) transcript.
            const callerSpoke = transcript.hasCallerTurn();
            const summaryResult = callerSpoke
              ? await summarizeCall(rendered ?? '', config.OPENAI_API_KEY)
              : { summary: null };
            const summary = summaryResult.summary;
            // Classify ONLY when no tool established the outcome. A call that
            // booked, transferred, or took a message already has its answer from
            // the system's own records — asking the model WHY on top of that is
            // both wasted latency/tokens and a chance to be overruled by a guess
            // (Camille, 2026-07-25: message taken, filed `wrong_service`).
            const classifyResult =
              callerSpoke && trackedOutcome == null
                ? await classifyCallOutcome(rendered ?? '', config.OPENAI_API_KEY)
                : { outcome: null };
            const outcome = trackedOutcome ?? classifyResult.outcome;

            // 3. ENRICH PASS — re-call only when there's something new (a summary,
            //    or a classified outcome we didn't already have). Re-pass the
            //    durable fields because end_voice_session SETs every column — a
            //    partial call would null out the duration/transcript just saved.
            if (summary != null || outcome !== trackedOutcome) {
              const enrichRes = await client.call('/agent-tools/voice-session-end', {
                tenant_id: sessionCtx.tenantId,
                call_id: callId,
                duration_seconds: durationSeconds,
                transcript: rendered,
                outcome,
                appointment_id: appointmentId,
                summary,
              });
              if (!enrichRes.ok) {
                callLog.warn(
                  {
                    event: 'voice_session_enrich_failed',
                    status: enrichRes.status ?? null,
                    error_message: enrichRes.error,
                  },
                  'call-logging summary/outcome enrich failed — row already finalized, summary not attached'
                );
              }
            }
            // Fire-and-forget: POST session AI usage to the cost ledger.
            // sessionModelUsage is empty when the session never started (e.g.
            // fallback path) — skip silently rather than inserting a zero row.
            let finalModelUsage = sessionModelUsage;
            if (summaryResult.usage) {
              finalModelUsage = [
                ...finalModelUsage,
                {
                  type: 'llm_usage',
                  provider: 'openai',
                  model: 'gpt-4o-mini',
                  inputTokens: summaryResult.usage.inputTokens,
                  outputTokens: summaryResult.usage.outputTokens,
                  charactersCount: 0,
                  audioDurationMs: 0,
                },
              ];
            }
            if (classifyResult.usage) {
              finalModelUsage = [
                ...finalModelUsage,
                {
                  type: 'llm_usage',
                  provider: 'openai',
                  model: 'gpt-4o-mini',
                  inputTokens: classifyResult.usage.inputTokens,
                  outputTokens: classifyResult.usage.outputTokens,
                  charactersCount: 0,
                  audioDurationMs: 0,
                },
              ];
            }
            if (finalModelUsage.length > 0) {
              void client
                .call('/agent-tools/record-ai-cost', {
                  tenant_id: sessionCtx.tenantId,
                  call_id: callId,
                  source: 'voice_call',
                  model_usage: finalModelUsage,
                })
                .catch((e: unknown) =>
                  callLog.warn(
                    {
                      event: 'ai_cost_record_failed',
                      error_message: e instanceof Error ? e.message : String(e),
                    },
                    'AI cost record failed (non-fatal)'
                  )
                );
            }
          } catch (e) {
            // 5W sad path: callLog carries tenant_id/call_id/caller_phone/room.
            // Add WHY + which write was in flight so a stranded 'active' row (no
            // duration/transcript/summary) is diagnosable. Backend logs the pg
            // SQLSTATE; this is the agent-side breadcrumb at shutdown.
            callLog.error(
              {
                event: 'voice_session_end_failed',
                error_message: e instanceof Error ? e.message : String(e),
              },
              'call-logging END failed (non-fatal to the caller) — duration/transcript/summary NOT saved; row may stay active'
            );
            // callFinalized stays false (set only on success) → backstop retries.
          } finally {
            finalizing = false;
          }
        };
        // Hangup ('close') is the reliable finalize signal; job-shutdown is the
        // backstop. callFinalized (set only after a successful write) dedupes;
        // finalizing guards against the two hooks racing into a double-write.
        ctx.addShutdownCallback(() => finalizeCall?.('shutdown') ?? Promise.resolve());
      }

      // Tenant + greeting warm already started before pickup. Reuse them.
      // A second fetch here would push first audio even later.
      tenantConfig = warmedTenant ?? (await fetchTenantConfig(client, sessionCtx.tenantId));
      ttsVoiceKey = warmedVoice ?? toAuraVoice(tenantConfig.ttsVoice);
      greeting = warmedGreeting ?? buildGreeting(tenantConfig);
      callLog.info(
        {
          event: 'tenant_config_fetched',
          tenant_name: tenantConfig.name,
          timezone: tenantConfig.timezone,
          warmed_before_pickup: Boolean(warmedTenant),
          // WHOSE QUESTIONS IS THIS CALL ABOUT TO ASK?
          //
          // A tenant with rows in tenant_question_trees runs ITS OWN copy — the
          // one an owner can edit without a deploy. A tenant with none silently
          // falls back to the platform library baked into this worker. Both
          // answer the phone identically today, which is exactly why the
          // difference has to be logged: after a per-tenant edit, "why didn't my
          // change take effect" and "the copy never happened" look the same from
          // the outside.
          question_tree_source: tenantConfig.questionTrees ? 'tenant_db' : 'platform_fallback',
          question_tree_count: tenantConfig.questionTrees?.length ?? 0,
        },
        'tenant config resolved'
      );

      // Forwarded-line guard (number match): when the SIP caller-ID equals the
      // tenant's forwarded-from line (the published number the carrier forwards
      // INTO the assistant), the call was forwarded — so the caller-ID is the
      // forwarding line, NOT the customer. Null it so the agent collects the real
      // number verbally instead (identify_caller then saves name + number to the CRM).
      //
      // THIS IS THE ONLY CALLER-ID GUARD (2026-07-13). It replaced a per-TENANT env
      // kill switch (UNTRUSTED_CALLER_ID_TENANTS) that had been a five-day stopgap in
      // June and then outlived its own replacement by three weeks — still set on
      // Railway, still running FIRST, and still nulling the caller ID of EVERY call to
      // the tenant, direct or forwarded, because it keyed off the BUSINESS rather than
      // the CALL. It had no phone number to compare against; a tenant UUID cannot tell
      // you how a call arrived. It therefore starved this guard of a number to check,
      // so this line has never once fired in production.
      //
      // The cost was real: a customer who dialed the number DIRECTLY had her caller ID
      // destroyed, was asked to read out her own phone number, never got a preference
      // prefetch, and was saved to the CRM as "Caller" (2026-07-12). Deleted, config
      // and all, so it cannot shadow this again.
      //
      // Keys off forwarded_from_phone (a dedicated field), so it's independent of
      // forward_phone (the live-transfer target) and the two can be distinct numbers
      // without looping. Known v1 gap: this runs after fetchTenantConfig, so a
      // forwarding number still reaches the child logger + voice-session-start record
      // for that call.
      if (callerIdIsForwardNumber(sessionCtx.callerPhone, tenantConfig.forwardedFromPhone)) {
        callLog.info(
          {
            event: 'caller_id_decision',
            decision: 'DISCARDED_forwarded_line',
            reason:
              'caller-ID equals the tenant forwarded_from_phone — this call came IN through the owner line, so the number we see is the OWNER, not the customer',
            had_caller_id: true,
            forwarded_from_configured: true,
            next: 'agent must collect BOTH name and number verbally, then OTP-verify before revealing any account',
          },
          'CALLER ID: discarded (forwarded line) — will collect number verbally'
        );
        sessionCtx.callerPhone = null;
      } else if (sessionCtx.callerPhone) {
        callLog.info(
          {
            event: 'caller_id_decision',
            decision: 'TRUSTED_carrier_attested',
            reason:
              'the carrier gave us this number and it is NOT the forwarding line — the caller supplied nothing, so there is nothing to prove',
            had_caller_id: true,
            forwarded_from_configured: Boolean(tenantConfig.forwardedFromPhone),
            next: 'agent must NOT ask for the number; it only needs the name. Preferences load without OTP.',
          },
          'CALLER ID: trusted (direct call) — number known, no verification needed'
        );
      } else {
        callLog.info(
          {
            event: 'caller_id_decision',
            decision: 'ABSENT_blocked_or_withheld',
            reason:
              'the carrier sent no caller-ID at all (blocked/withheld), or Telnyx did not populate sip.phoneNumber',
            had_caller_id: false,
            forwarded_from_configured: Boolean(tenantConfig.forwardedFromPhone),
            next: 'agent must collect BOTH name and number verbally, then OTP-verify before revealing any account',
          },
          'CALLER ID: absent — will collect number verbally'
        );
      }

      // Live-transfer capability. The executor is null when the call lacks the
      // room/participant context needed to REFER (SIP participant never joined),
      // in which case transfer_call gracefully reports it can't transfer. The
      // forward number comes from the tenant config (NULL = no destination).
      const transferExecutor = createTransferExecutor({
        livekitUrl: config.LIVEKIT_URL,
        livekitApiKey: config.LIVEKIT_API_KEY,
        livekitApiSecret: config.LIVEKIT_API_SECRET,
        roomName: sessionCtx.roomName ?? undefined,
        participantIdentity: sessionCtx.participantIdentity ?? undefined,
      });
      // Realtime is token-constrained — expose only the lean message+meeting
      // capability subset. The SAME array drives BOTH the tool set (buildTools
      // below) AND the system prompt (buildSystemPrompt) so the prompt never
      // advertises a tool that isn't in the ToolContext — a mismatch makes the
      // model call a non-existent tool → error/hallucination → dead air on a
      // voice call (GH issue #113). undefined = all capabilities (pipeline mode).
      // ONE list, driving BOTH the toolset and the prompt (GH #113 — if they drift,
      // the model is told about a tool it cannot call, tries anyway, and the caller
      // gets dead air).
      //
      // 'sms' is absent unless ENABLE_SMS=true, and it is absent TODAY: the number is
      // not 10DLC-registered, so no text this product sends has ever reached a handset.
      // The agent nevertheless closed a real booking with "you'll receive a text
      // confirmation shortly." Removing the capability removes record_sms_consent AND
      // swaps the prompt's texting section for one that says, plainly, that it cannot
      // text. It cannot promise what it has no means to do.
      const ALL_CAPS = [
        'identity',
        'scheduling',
        'messaging',
        'knowledge',
        'verification',
        'transfer',
        'sms',
      ] as const;
      const REALTIME_CAPS = ['identity', 'scheduling', 'messaging', 'sms'] as const;
      const activeCapabilities = (config.ENABLE_REALTIME ? REALTIME_CAPS : ALL_CAPS).filter(
        (c) =>
          (c !== 'sms' || config.ENABLE_SMS) &&
          // OTP is a security control, so it defaults ON and is only removed by an explicit
          // decision — but it works by TEXTING a code, and no text reaches a handset until
          // 10DLC lands. On a forwarded line the agent asks the caller to read back a code
          // that will never arrive, they wait, nothing comes, and the booking dies.
          //
          // Verification gates DISCLOSURE, not CREATION. A booking reveals nothing — the
          // caller supplies every fact in it.
          //
          // AND IT REQUIRES SMS TO EXIST AT ALL. The paragraph above described the
          // failure exactly and then left the remedy as an ops note ("set
          // ENABLE_PHONE_VERIFICATION=false on Railway"), which nobody had set. On
          // 2026-08-15 the model duly called send_verification_code and the tool
          // answered "I'm sorry — I can't send a text from this line right now",
          // which the caller heard, mid-booking, right after being asked for a
          // number "to text or call". An OTP is a text; with texting off it is not
          // a control that is merely disabled, it is a control that CANNOT RUN.
          // Derive it instead of remembering it — the same reason the SMS tools
          // are gated in code rather than trusted to a prompt line.
          (c !== 'verification' || (config.ENABLE_PHONE_VERIFICATION && config.ENABLE_SMS))
      );

      // 3b. Prefetch the caller's CRM record so the prompt can carry their name,
      //     saved preferences, and recent history into turn one. Runs AFTER both
      //     forwarded-line guards above, so it never keys off a forwarding number.
      //     Bounded (1.5s) and soft-failing: on timeout/5xx/unknown caller it
      //     returns null and the prompt tells the model to call
      //     get_customer_context itself. Adds one round-trip before the greeting —
      //     the deadline is what keeps that from becoming dead air.
      const knownCustomer = await fetchCustomerContext(
        client,
        sessionCtx.tenantId,
        sessionCtx.callerPhone,
        // call_id rides along for the disclosure gate's audit log. (The gate
        // itself passes on carrier attestation — see the phone_source note in
        // fetchCustomerContext, which is what un-broke this whole prefetch.)
        { callId: sessionCtx.callId }
      );
      callLog.info(
        {
          event: 'customer_context_prefetched',
          known_customer: knownCustomer !== null,
          preference_count: knownCustomer ? Object.keys(knownCustomer.preferences).length : 0,
        },
        knownCustomer
          ? 'returning caller — name/preferences/history baked into the prompt'
          : 'no prefetched context (new caller, blocked ID, or lookup missed the deadline)'
      );

      // 4. Build prompt with runtime context
      const instructions = buildSystemPrompt({
        tenantName: tenantConfig.name,
        callerPhone: sessionCtx.callerPhone,
        currentDate: formatDateForPrompt(new Date(), tenantConfig.timezone),
        timezone: tenantConfig.timezone,
        capabilities: activeCapabilities,
        // 2026-05-18: feed the tenant's customized persona (from
        // tenants.system_prompt, displayed/edited in the dashboard's AI
        // Persona page) into the prompt's identity section. NULL falls
        // back to the hardcoded "You are Clara, ..." line.
        customPrompt: tenantConfig.systemPrompt,
        // 2026-06-30: owner-editable assistant name (dashboard "Assistant
        // Name"). Prepends an authoritative "Your name is X" line that
        // overrides any name in the custom prompt. NULL = no change.
        personaName: tenantConfig.personaName,
        // 2026-06-06: per-tenant customer-preference capture. When enabled, the
        // prompt gains a "Customer preferences" section + save tool guidance.
        savePreferencesEnabled: tenantConfig.savePreferencesEnabled,
        preferencesInstructions: tenantConfig.preferencesInstructions,
        // 2026-07-12: the shop's real opening hours + booking horizon, so the
        // agent LEADS with them ("we're open weekdays one to five — what day
        // works?") instead of asking an open question against a calendar the
        // caller cannot see. NULL = nobody scheduled; the prompt then omits the
        // section and the agent must not claim to be open.
        businessHours: tenantConfig.businessHours,
        bookableThrough: tenantConfig.bookableThrough,
        // 2026-07-12: the caller's prefetched CRM record (name + saved
        // preferences + recent calls). NULL = unknown/blocked caller, or the
        // lookup missed its deadline — the prompt then tells the model to fetch.
        knownCustomer,
        ttsFormal: tenantConfig.ttsFormal,
        ttsWarm: tenantConfig.ttsWarm,
        ttsConcise: tenantConfig.ttsConcise,
        ttsSoft: tenantConfig.ttsSoft,
        ttsCheerful: tenantConfig.ttsCheerful,
      });

      // 5. Start the voice session. Wrapped in try/catch → runFallback: a
      //    throw here (LiveKit session.start, a plugin constructor, an STT/LLM/
      //    TTS upstream that rejects at init) would otherwise propagate out of
      //    `entry`, kill the job, and leave the caller in dead air. The fallback
      //    speaks a short message so the call degrades to "sorry" instead of
      //    silence. (2026-05-21 — closes the gap-1 outer-throw dead-air path.)
      // Realtime + no-barge-in is a CONTRADICTION we cannot honor. OpenAI's
      // speech-to-speech owns barge-in server-side, and LiveKit's plugin rejects
      // allowInterruptions:false on generateReply (it left the session deaf after
      // the greeting the last time it was tried). So under Realtime the caller CAN
      // cut the agent off, including mid-disclosure, no matter what ALLOW_BARGE_IN
      // says. Say so loudly rather than let the operator believe the greeting is
      // protected when it isn't — that belief is exactly what the 2026-07-12 call
      // cost us.
      if (config.ENABLE_REALTIME && !config.ALLOW_BARGE_IN) {
        callLog.warn(
          {
            event: 'barge_in_setting_ignored',
            enable_realtime: true,
            allow_barge_in: false,
          },
          'ENABLE_REALTIME=true IGNORES ALLOW_BARGE_IN=false — the caller CAN interrupt the agent, including the AI disclosure. Turn ENABLE_REALTIME off to get an uninterruptible greeting.'
        );
      }

      // CHECKLIST-AWARE TURN DETECTION (prototype 2026-07-21): "were my
      // questions answered?" — the detector reads the live transcript plus the
      // checklist's pending question to decide if the caller is done talking.
      // The session is constructed BEFORE the agent, so the pending-question
      // accessor is a ref that the ChecklistAgent fills in below.
      const pendingAskRef: { get: () => string | null } = { get: () => null };
      const semanticTurnDetector =
        config.ENABLE_QUESTION_TREE && config.ENABLE_SEMANTIC_TURN && !config.ENABLE_REALTIME
          ? createChecklistTurnDetector(() => pendingAskRef.get(), callLog)
          : undefined;

      try {
        // ttsVoiceKey + greeting were resolved the moment the tenant was known (see
        // the warm block above) — the live TTS, the pre-generation cache and the
        // watchdog all read the SAME value, or the cache misses and the hold line
        // comes out in a different voice from the rest of the call.

        const session = config.ENABLE_REALTIME
          ? new voice.AgentSession({
              // OpenAI Realtime (speech-to-speech) — one model does STT+LLM+TTS
              // over a streamed connection with server-side VAD/turn detection,
              // removing the separate TTS synthesis step whose 2–3s non-streaming
              // latency was the dead air on every reply. Pass it as the llm and
              // omit stt/tts/turnHandling. inputAudioTranscription keeps the
              // caller-side transcript populated for the Calls tab. A/B behind a
              // flag (2026-06-25) — default OFF, set ENABLE_REALTIME on Railway.
              llm: new openai.realtime.RealtimeModel({
                apiKey: config.OPENAI_API_KEY,
                model: config.REALTIME_MODEL,
                voice: config.REALTIME_VOICE,
                inputAudioTranscription: { model: 'whisper-1' },
              }),
              // See the pipeline branch below for why 5, not LiveKit's default 3.
              maxToolSteps: MAX_TOOL_STEPS,
            })
          : new voice.AgentSession({
              // 5 TOOL STEPS PER TURN, not LiveKit's default 3 — and know what the
              // cap DOES: a turn that hits it ends WITHOUT GENERATING SPEECH.
              // On a live call 2026-07-17 the caller said "Monday at 1:30", the
              // model spent its 3 steps on intake lookups (catalog → history →
              // context) without ever reaching the start_booking router, and the
              // turn simply ENDED — thinking → listening, no audio, "Hello?"
              // twice, hang-up. 5 lets a legitimate lookup-then-route chain fit
              // in one turn; the silent-turn recovery below covers whatever
              // still hits the cap. Tunable without a deploy (MAX_TOOL_STEPS,
              // parsed + clamped at module scope).
              maxToolSteps: MAX_TOOL_STEPS,
              // HOW LONG A SILENT TTS STREAM IS ALLOWED TO HOLD THE CALLER.
              //
              // The framework default is 10_000 ms (agent_session defaults,
              // `ttsReadIdleTimeout`). On 2026-08-15 that default WAS the dead
              // air: TTS accepted two turns, produced zero audio frames, and the
              // caller waited the full ten seconds each time — "Hello? Are you
              // there?", then "I said it already. Didn't you hear it?".
              //
              // Ten seconds is longer than any healthy synthesis and far longer
              // than a caller's patience. Measured time-to-first-frame on this
              // stack after the DNS fix: ~300 ms. 4 s leaves an order of
              // magnitude of headroom and still converts a dead stream into a
              // recovery line while the caller is merely puzzled rather than
              // gone. Raise it with TTS_READ_IDLE_TIMEOUT_MS if a slower voice
              // ever needs it — the same envMs guard as the silence timers, so a
              // typo can never mean "give up instantly".
              ttsReadIdleTimeout: envMs('TTS_READ_IDLE_TIMEOUT_MS', 4000),
              vad: ctx.proc.userData.vad as silero.VAD,
              stt: new deepgram.STT({ apiKey: config.DEEPGRAM_API_KEY, model: 'nova-3' }),
              // temperature: 0 — PICKING A TOOL IS NOT A CREATIVE ACT.
              //
              // We never passed a temperature, so every call ran at OpenAI's default
              // of 1.0: full sampling randomness, applied to a 23-way tool-selection
              // decision. Then we called the resulting run-to-run variance "flaky" and
              // went looking for the bug in the prompt.
              //
              // The variance WAS the bug. At temperature 1 the model can sample its way
              // into narrating a lookup instead of performing one, or into the wrong one
              // of two similar tools, and it will do it on some calls and not others —
              // which is exactly the signature we spent days chasing. Warmth in this
              // product comes from the persona and the voice, not from the token
              // sampler.
              // gpt-4.1-mini (2026-07-20, was gpt-4o-mini): same mini-class
              // latency/cost tier, one generation newer instruction-following.
              // Eval evidence with the Thinking Hammer ladder loaded: 4o-mini
              // never exceeded 13/14 and reliably failed the third-person
              // one-breath-message case; 4.1-mini passed that case in every
              // run and scored the suite's first 14/14. The auxiliary models
              // (summary/classify/fallback) stay on 4o-mini — cheap and
              // uncritical there.
              llm: new openai.LLM({
                apiKey: config.OPENAI_API_KEY,
                model: 'gpt-4.1-mini',
                temperature: 0,
              }),
              // TTS IS DEEPGRAM AURA — native WebSocket streaming.
              // This is the "voice isn't smooth" fix, take two.
              //
              // THE HISTORY, because it is the whole lesson:
              //
              //   tts-1              — 2–5s per sentence. Multi-second dead air; callers
              //                        said "hello?" and cancelled the reply.
              //   gpt-4o-mini-tts    — ~1.3s and consistent, but the OpenAI plugin is
              //                        NON-STREAMING: it buffers the ENTIRE reply and
              //                        emits audio only when the whole clip is done. So
              //                        every turn was: silence … silence … [paragraph].
              //                        The owner called it "broken up / not natural".
              //   + StreamAdapter    — my first fix. It splits the reply into SENTENCES
              //                        and synthesises each one separately. Time-to-first-
              //                        word improved — but every sentence became its own
              //                        HTTP round-trip, so I traded one gap at the start
              //                        for a small gap between EVERY sentence. The owner's
              //                        verdict: "a bit choppy still, not as smooth as it
              //                        once was." He was right. I had moved the stutter,
              //                        not removed it.
              //
              // You cannot make a non-streaming engine stream by chopping its input
              // finer. Each chop is another round-trip. The only real fix is an engine
              // that streams audio as it generates it.
              //
              // Deepgram Aura does: a WebSocket connection, audio flowing continuously as
              // the words are produced. No buffering, no per-sentence handshake. We
              // already pay Deepgram for STT, so the key and the vendor relationship
              // already exist — this adds no new dependency, only removes a bad one.
              //
              // The tenant's saved voice is honoured, translated to its nearest Aura
              // timbre (see toAuraVoice) — an engine swap must not silently reset a
              // choice the owner made in the dashboard.
              tts: new deepgram.TTS({
                apiKey: config.DEEPGRAM_API_KEY,
                model: ttsVoiceKey,
                // WS speak from this host returned 0 bytes (2026-08-14). HTTP
                // collect returns audio. AURA_TTS_STREAMING=false uses that path
                // so the line is not silent. Prod keeps the default (stream).
                // NO `speed` — Aura WS 400s on ?speed= and there is no TTS at all.
                capabilities: { streaming: auraTtsStreamingEnabled() },
              }),
              turnHandling: {
                interruption: {
                  // HALF-DUPLEX BY DEFAULT (product decision 2026-07-12, after a real
                  // call). The caller CANNOT cut the agent off — every utterance plays
                  // to completion.
                  //
                  // Why: barge-in is what makes the conversation script combinatorially
                  // hard. A caller who talks over a half-delivered sentence leaves the
                  // agent reasoning about a state it never finished reaching ("did she
                  // hear the times I offered? did she hear the disclosure?"), so every
                  // reply needs an "interrupted mid-way" branch and there is no end to
                  // them. And the AI-identity disclosure is a COMPLIANCE line: if the
                  // caller talks over it, we legally did not say it. On the 2026-07-12
                  // call the greeting was cut off mid-disclosure ("...I'm an AI") and
                  // the agent then composed a SECOND, different greeting — the caller
                  // heard two openings, neither complete.
                  //
                  // The accepted cost: a caller cannot cut off a long reply. Mitigated
                  // by keeping replies to 1–2 sentences (the prompt mandates it) and
                  // offering ~2 slots at a time, not six.
                  enabled: config.ALLOW_BARGE_IN,
                  // KEEP what she says while the agent is talking. LiveKit's default is
                  // TRUE — it DISCARDS buffered audio whenever the agent is
                  // uninterruptible — which would mean "I changed my mind" spoken over a
                  // reply is silently thrown away and she has to say it twice. Instead we
                  // buffer it and answer it as the next turn: she can't derail a sentence
                  // mid-way, but nothing she says is lost.
                  //
                  // The GREETING is the deliberate exception — see the say() below, which
                  // calls session.clearUserTurn() once the opener finishes. Nothing said
                  // over a fixed script is actionable, and keeping it is what turned her
                  // "Bye." into a phantom turn that produced the second greeting.
                  discardAudioIfUninterruptible: false,

                  // Everything below governs barge-in only when ALLOW_BARGE_IN=true
                  // restores it; it is inert in the default half-duplex mode. Kept
                  // because the tuning was hard-won and we want it back verbatim if the
                  // no-interruption experiment is reversed.
                  //
                  // 'adaptive' = LiveKit's CNN barge-in model: it decides whether to
                  // yield the turn from the ACOUSTICS of the overlapping speech, not
                  // from a raw VAD/duration threshold — so a brief "hello?"/backchannel
                  // during the TTS gap no longer cancels the in-flight reply.
                  mode: 'adaptive',
                  // minWords is the EFFECTIVE lever when STT is on: a verified LiveKit
                  // maintainer note says STT-detected speech bypasses minDuration, so
                  // raising duration alone does nothing — require ≥2 words to interrupt.
                  minWords: 2,
                  // If speech is detected but NO transcript follows within 2s (a false
                  // trigger — line noise, a cough, a half-word), resume speaking from
                  // where __PERSONA_NAME__ left off instead of staying silent. Direct guard against
                  // a phantom "interruption" killing the reply → dead air.
                  falseInterruptionTimeout: 2000,
                  resumeFalseInterruption: true,
                },
                // Endpointing = how long of a pause ends the caller's turn. Default
                // minDelay 500ms ends the turn on the brief pause BETWEEN spoken
                // fragments — so a phone number ("312 865" … "1186") or a multi-part
                // answer ("it's W2" … "in Chicago" … "$65/hr") arrives as several
                // turns, each starting a generation the next fragment then discards →
                // __PERSONA_NAME__ never finishes a reply → freeze. Wait ~1.3s of silence so a
                // multi-part answer AGGREGATES into one turn → one reply. maxDelay
                // caps the wait so a truly-finished caller isn't left hanging.
                //
                // WITH THE CHECKLIST-AWARE DETECTOR (semanticTurnDetector below), the
                // detector chooses per utterance: a complete-looking answer commits at
                // minDelay (900 — SNAPPIER than the flat 1300), a visibly mid-thought
                // one (six digits of a phone number, a trailing "I'd like to…") gets
                // maxDelay grace (4500) — and any resumed speech cancels the commit.
                ...(semanticTurnDetector ? { turnDetection: semanticTurnDetector } : {}),
                endpointing: semanticTurnDetector
                  ? { minDelay: 900, maxDelay: 4500 }
                  : { minDelay: 1300, maxDelay: 4000 },
                // WAIT FOR THE WHOLE UTTERANCE BEFORE REPLYING. Preemptive generation is
                // ON by LiveKit's default: it starts composing a reply from the INTERIM
                // transcript, before the caller finishes. On a live call the caller read a
                // phone number in groups ("five eight six" … "one eight two" … "three two
                // three two"); preemptive generation fired on "five eight six" alone and
                // the agent answered "I only caught 586 — give me the next three digits",
                // committing to a reply built from a third of the number even though the
                // endpointer (minDelay 1300ms) went on to aggregate the FULL number into
                // one turn. So the two fought and the fragment won. Disabling it makes the
                // agent generate only from the endpointer's final, aggregated transcript —
                // the cost is a little latency after the caller stops; the win is that it
                // stops answering half-heard numbers and multi-part answers. (This is the
                // "didn't wait for me" report, 2026-07-15.)
                preemptiveGeneration: { enabled: false },
              },
            });

        // Tools are built after the session exists. speakFiller is now a no-op
        // (it used to call session.say() from inside execute(), which stalled the
        // generation — see the no-op comment below), so it no longer depends on
        // session being initialized; the ordering is harmless either way.
        // THE MODEL SEES ONE PHASE OF THE CALL AT A TIME (toolPhases.ts).
        //
        // Handing gpt-4o-mini all 23 tools on every turn is over every published
        // ceiling (OpenAI: "<20 at the start of a turn"; LiveKit: 5-12), and our own
        // eval shows what it costs — asked to take a message, the model called NO
        // tool at all and told the caller "I've sent the owner a message". Prompt
        // rules did not fix that. Neither did temperature 0. A model cannot pick the
        // wrong tool from a set that does not contain it, and it picks the right one
        // far more often from six candidates than from twenty-three.
        //
        // The agent starts in 'intake' and moves when the model calls a router
        // (start_booking / manage_appointment). The routers are the ONLY door out:
        // the scheduling tools are not visible during intake, so the model cannot
        // TALK its way to get_available_slots — the cheapest path to what the caller
        // asked for now runs THROUGH a tool call instead of around it.
        //
        // Late-bound on purpose: the tools must exist before the Agent, and the
        // Agent must exist before a tool can swap its toolset. `phaseAgent` closes
        // that loop. A router that fires before the Agent exists (impossible today —
        // the model cannot call a tool before session.start) is a no-op, not a crash.
        let phaseAgent: voice.Agent | null = null;
        let phase: CallPhase = 'intake';
        const applyPhase = async (next: CallPhase): Promise<void> => {
          phase = next;
          if (!phaseAgent) return;
          const scoped = toolsForPhase(allTools, next);
          await phaseAgent.updateTools(scoped);
          callLog.info(
            {
              event: 'tool_phase_changed',
              phase: next,
              tool_count: Object.keys(scoped).length,
              tools: Object.keys(scoped),
            },
            `tool phase → ${next} (${Object.keys(scoped).length} tools visible)`
          );
        };

        const allTools = buildTools(
          sessionCtx,
          client,
          {
            // Gated on the backend-resolved capability, not on the raw column.
            // A forward_phone equal to the line that forwards INTO us rings
            // straight back through the carrier — so when transfer is not
            // available we hand the tool NO destination, which is already the
            // signal every downstream check reads (tools.ts gates the transfer
            // affordance on `!!transfer?.forwardPhone`, and greeting.ts offers
            // the human opt-out on the same field). One boolean, decided once,
            // and the whole chain follows it. 2026-07-23.
            forwardPhone: tenantConfig.transferAvailable ? tenantConfig.forwardPhone : null,
            execute: transferExecutor,
          },
          outcomeTracker,
          // speakFiller is intentionally a NO-OP. It used to call
          // session.say('one moment…') from INSIDE a tool's execute() — but
          // injecting a say() into the middle of the LLM's function-call
          // generation is an unsupported LiveKit pattern that can stall the
          // generation loop (the agent froze exactly when a tool fired —
          // get_scheduling_options / policy-answer / take_message — and the
          // tool's HTTP call never reached the backend). Tools are fast; a brief
          // pause beats a frozen call. (Re-add a filler later via a supported
          // mechanism if perceived latency is an issue.) 2026-06-25.
          () => {
            /* no-op — see comment above */
          },
          // Realtime is rate-limited on tokens/min (Tier-1 = 40k TPM); audio +
          // a growing context burn fast. For the lean "message + meeting" flow we
          // expose ONLY the tools that flow needs — identity (who's calling),
          // scheduling (book a meeting), messaging (take a message) — dropping
          // knowledge/RAG, transfer, and OTP to shrink the per-turn schema tokens.
          // `activeCapabilities` (computed once above) drives this AND the system
          // prompt, so the two can never drift (GH issue #113). Pipeline = all tools.
          //
          // Capabilities and phases compose, and the order matters: capabilities are
          // authoritative and decide what this SESSION has at all; phases only ever
          // narrow that further, per turn. A phase can never hand back a tool a
          // capability withheld — toolsForPhase intersects, it does not union. So
          // ENABLE_PHONE_VERIFICATION=false still means no OTP tool exists, in any
          // phase, no matter what toolPhases.ts lists.
          {
            ...(activeCapabilities ? { capabilities: activeCapabilities } : {}),
            onPhaseChange: applyPhase,
          }
        );

        // MARKDOWN MUST NEVER REACH THE VOICE.
        //
        // On the 2026-07-13 call the model emitted, inside one turn:
        //
        //   "Let me check ... Just a moment.   *One moment while I look that up...*"
        //
        // The asterisks are literal characters handed to TTS, and gpt-4o-mini-tts
        // does not quietly ignore them — they distort prosody and insert pauses.
        // The owner's report was "voice was broken up, did not sound natural", and
        // that is what he was hearing.
        //
        // The prompt has forbidden markdown the entire time ("no markdown, no
        // bullet points, no formatting"). The model did it anyway. A prompt is a
        // REQUEST; ttsNode is where we can make it a GUARANTEE. Overriding it means
        // no future prompt regression, and no new model's habits, can put
        // punctuation into a customer's ear.
        class SpeakingAgent extends voice.Agent {
          override async ttsNode(
            text: ReadableStream<string>,
            modelSettings: Parameters<typeof voice.Agent.default.ttsNode>[2]
          ): ReturnType<typeof voice.Agent.default.ttsNode> {
            return voice.Agent.default.ttsNode(this, sanitizeStream(text), modelSettings);
          }
        }

        // Open in INTAKE: identity, the catalog, the policy answerer, every way to
        // reach a human — and the two routers. Not the calendar. The model cannot
        // offer, refuse, or invent a time before it has called a tool that returns
        // one, because the tools that return times are not in the room yet.
        const intakeTools = toolsForPhase(allTools, 'intake');

        // QUESTION-TREE FLOW (ENABLE_QUESTION_TREE — takes precedence). ONE
        // conversation over a host-tracked checklist of purpose-selected question
        // trees (docs/QUESTION_TREE_ARCHITECTURE.md). Same tools, same backend;
        // sequencing is gone entirely — the tracker's completion gate replaces it.
        // TASK-GROUP FLOW (ENABLE_TASK_GROUP). Runs the call as a LiveKit
        // TaskGroup of host-code rungs the model cannot skip, instead of the prompt
        // ladder. Same tools, same backend, same tenant — only the SEQUENCING moves from
        // prompt-space into the loop. Both off by default; each got (gets) its first
        // real call without touching the agent that answers the phone.
        const agent = config.ENABLE_QUESTION_TREE
          ? new ChecklistAgent({
              tools: allTools,
              persona: `You are ${tenantConfig.personaName?.trim() || 'Clara'}, the AI receptionist for ${tenantConfig.name}.`,
              // WHAT THE BUSINESS IS. The persona line names it; these two say
              // what it DOES. Without them the model could not answer "what is
              // this?" without inventing services (which the prompt forbids), so
              // it answered with a bare "no, this is X" and went quiet — the
              // wrong-number dead air. greeting_menu is already the owner's own
              // spoken services line, so it is the same words the caller heard.
              businessName: tenantConfig.name,
              businessBlurb: tenantConfig.greetingMenu,
              runtime: {
                currentDate: formatDateForPrompt(new Date(), tenantConfig.timezone),
                timezone: tenantConfig.timezone,
                businessHours: tenantConfig.businessHours,
                bookableThrough: tenantConfig.bookableThrough,
              },
              // Carrier-attested number (nulled upstream on forwarded lines) —
              // seeds the caller_phone node so the question never exists.
              callerPhone: sessionCtx.callerPhone,
              // The CRM snapshot, finally on the LIVE path (2026-07-30). It was
              // prefetched on every call and passed only to buildSystemPrompt —
              // the ladder, which prod never runs — so the model greeted every
              // returning customer as a stranger and once denied a live booking
              // outright (CALL_IMPROVEMENTS.md #8).
              knownCustomer,
              // The roster a caller-named person is checked against before the
              // agent repeats it back ("Jane" → "Do you mean Dale?").
              staffFirstNames: tenantConfig.staffFirstNames,
              // Preset catalog is theater until this lands: tenant-config already
              // derives checklist_runtime_config; dropping it here ran every call
              // against the full PLATFORM_TREE_LIBRARY. Absent/invalid → omit
              // and keep the historical full-library fallback.
              ...(tenantConfig.checklistRuntimeConfig
                ? { runtimeConfig: tenantConfig.checklistRuntimeConfig }
                : {}),
              // THE TENANT'S OWN QUESTIONS, when they have a copy in the
              // database. Passed ALONGSIDE runtimeConfig, not instead of it:
              // the library says which questions exist, the runtime config says
              // which are switched off or reworded, and resolveSelectableTreeIds
              // intersects them so an owner's disable still subtracts.
              // Null (no rows, older backend, or a library that failed
              // validation) omits the field and keeps the platform library —
              // the behaviour every call has today.
              ...(tenantConfig.questionTrees ? { library: tenantConfig.questionTrees } : {}),
            })
          : config.ENABLE_TASK_GROUP
            ? new CallRootAgent({
                ctx: sessionCtx,
                tools: allTools,
                // THE PERSONA MUST NOT BE THE LADDER. `instructions` is the full
                // prompt-ladder system prompt — a script that tells the model to run
                // the whole call conversationally (ask their name, take the message
                // yourself). Passing it here buried CallRootAgent's one hand-off job
                // under 130 lines of contradiction: on 2026-07-16 the root agent
                // followed the ladder instead, collected name+number itself, never
                // called begin_call, and the caller's message was never recorded (it
                // holds no take_message tool). The root agent gets an IDENTITY line;
                // the rungs carry their own instructions.
                persona: `You are ${tenantConfig.personaName?.trim() || 'Clara'}, the AI receptionist for ${tenantConfig.name}.`,
                // The date + hours the rungs must not guess. On the first live call a task
                // with no date context booked October and every attempt failed
                // EMPLOYEE_NOT_SCHEDULED — because each task REPLACES the system prompt
                // (where these live) with its own.
                runtime: {
                  currentDate: formatDateForPrompt(new Date(), tenantConfig.timezone),
                  timezone: tenantConfig.timezone,
                  businessHours: tenantConfig.businessHours,
                  bookableThrough: tenantConfig.bookableThrough,
                },
              })
            : new SpeakingAgent({
                instructions,
                tools: intakeTools,
              });
        if (!config.ENABLE_TASK_GROUP && !config.ENABLE_QUESTION_TREE) phaseAgent = agent;

        // Late-bind the turn detector's pending-question accessor to the live
        // checklist (the session — and thus the detector — was built first).
        if (semanticTurnDetector && agent instanceof ChecklistAgent) {
          pendingAskRef.get = () => agent.pendingAskNodeId();
        }

        await session.start({ agent, room: ctx.room });
        callLog.info(
          {
            event: 'session_started',
            phase,
            tool_count: Object.keys(intakeTools).length,
            // The count the model actually sees. If this creeps back toward 23,
            // the narrowing has silently regressed and the hallucinations return.
            tool_count_all: Object.keys(allTools).length,
          },
          'voice session started — agent ready to greet'
        );

        // Record every finalized turn (caller STT + agent replies) for the
        // call transcript. Attached BEFORE the greeting `say()` below — which
        // itself emits a `conversation_item_added` (addToChatCtx defaults true)
        // — so the transcript opens with the actual first line, no manual add.
        // Never leave a caller in silence when the LLM provider is down.
        // Declared here so both the error handler and the state handler share it.
        const outageGuard = createOutageGuard();

        session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
          if (ev.item.type !== 'message') return;
          transcript.add(ev.item.role, ev.item.textContent);
          // Incremental durability: persist the transcript-so-far after EVERY
          // turn (fire-and-forget), not only at finalize. So a call that hangs or
          // never sends voice-session-end still shows its conversation in the DB
          // up to the last turn — the record reflects what was actually said,
          // regardless of agent lifecycle. status stays 'active'; finalize/reaper
          // fill duration/outcome later. Best-effort: a failed update just means
          // this turn isn't persisted yet; the next turn (or finalize) catches up.
          const cid = sessionCtx.callId;
          const soFar = transcript.render();
          if (cid && soFar) {
            void client
              .call('/agent-tools/voice-session-transcript', {
                tenant_id: sessionCtx.tenantId,
                call_id: cid,
                transcript: soFar,
              })
              .then((res) => {
                // ToolsClient.call() resolves { ok:false } on 5xx/401/{success:false}
                // (it does NOT throw), so .catch alone would hide a persistent
                // failure (auth/route-missing). Surface it — best-effort, but not
                // silent. Finalize/reaper remain the durability backstops.
                if (!res.ok) {
                  callLog.warn(
                    {
                      event: 'voice_session_transcript_failed',
                      status: res.status ?? null,
                      error_message: res.error,
                    },
                    'incremental transcript save failed (non-fatal; finalize/reaper backstop)'
                  );
                }
              })
              .catch((e: unknown) =>
                callLog.warn(
                  {
                    event: 'voice_session_transcript_failed',
                    error_message: e instanceof Error ? e.message : String(e),
                  },
                  'incremental transcript save threw (non-fatal)'
                )
              );
          }
        });

        // Accumulate per-model usage so the shutdown callback can POST it.
        // SessionUsageUpdated fires after each LLM/STT/TTS turn and carries
        // the running totals — keeping the last snapshot is sufficient.
        session.on(voice.AgentSessionEventTypes.SessionUsageUpdated, (ev) => {
          sessionModelUsage = ev.usage.modelUsage
            .map((u) => snapshotCostUsage(u))
            .filter((u): u is CostUsageItem => u !== null);
        });

        // ── Turn-state instrumentation (5W) ──────────────────────────────
        // Traces EXACTLY where a call stalls — the dead-air / name-loop bug.
        // callLog already carries WHO/WHERE (tenant_id/call_id/caller_phone/room).
        //  - user_input_transcribed: did STT capture the caller's speech at all?
        //    (If a short answer like a name never appears here → STT/turn-detection
        //     dropped it. If it appears but no agent_state→thinking follows →
        //     the LLM turn never started.)
        //  - agent_state_changed: listening→thinking→speaking. Stuck in 'speaking'
        //    = a TTS playout that never completed (agent stops listening) = dead air.
        //  - user_state_changed: caller speaking/listening/away.
        //  - function_tools_executed: which tools the LLM actually invoked — proves
        //    whether find_caller_by_name/identify_caller fired on the name turn.
        //  - error: STT/LLM/TTS/realtime errors surfaced by the session — the most
        //    likely direct cause of a mid-call hang.
        session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
          sttTranscribed += 1;
          // Mask digit runs (phone numbers, card numbers) before logging the
          // caller's transcribed speech to centralized logs — keep the words
          // (names/intent, what we need to debug the turn) but not raw PII digits.
          const preview = (ev.transcript ?? '').slice(0, 300).replace(/\d/g, '•');
          callLog.info(
            {
              event: 'user_input_transcribed',
              is_final: ev.isFinal,
              text_len: ev.transcript?.length ?? 0,
              text_preview: preview,
            },
            'caller speech transcribed (STT)'
          );
        });
        session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
          // Reaching 'speaking' means audio actually reached the caller, which
          // is what makes the outage guard's error count CONSECUTIVE rather
          // than cumulative — see outageGuard.ts.
          if (ev.newState === 'speaking') noteAgentSpoke(outageGuard);
          callLog.info(
            { event: 'agent_state_changed', from: ev.oldState, to: ev.newState },
            `agent state ${ev.oldState} -> ${ev.newState}`
          );
        });
        session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
          // 'speaking' is Silero's verdict on the raw frames — count only the
          // transitions INTO it, so one long utterance counts once rather than
          // per frame.
          if (ev.newState === 'speaking') vadSpeechEvents += 1;
          callLog.info(
            { event: 'user_state_changed', from: ev.oldState, to: ev.newState },
            `caller state ${ev.oldState} -> ${ev.newState}`
          );
        });
        session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
          const tools = (ev.functionCalls ?? []).map((c) => c?.name ?? '(unknown)');
          // Log ARGS too (PII-redacted), not just names — a 2026-07-01 live
          // incident was undiagnosable because nothing showed what time
          // string the LLM sent. is_error pairs each call with its output.
          const toolCalls = summarizeToolCalls(
            ev.functionCalls ?? [],
            ev.functionCallOutputs ?? []
          );
          callLog.info(
            { event: 'function_tools_executed', tools, tool_calls: toolCalls },
            `tools executed: ${tools.join(', ')}`
          );
          // Same entries, PERSISTED — the log line above rotates with the
          // container; this accumulates for voice_sessions.metadata at finalize.
          toolCallLog.recordBatch(ev.functionCalls ?? [], ev.functionCallOutputs ?? []);
        });
        session.on(voice.AgentSessionEventTypes.Error, (ev) => {
          const e: unknown = ev.error;
          // Surface the provider error body too — a RealtimeModel APIError carries
          // a `body` with the precise cause (e.g. token/context-limit details);
          // without it the message is just "...error type: tokens" with no numbers.
          let errorBody: string | undefined;
          try {
            const b = (e as { body?: unknown }).body;
            if (b != null) errorBody = JSON.stringify(b).slice(0, 1000);
          } catch {
            /* body not serializable — skip */
          }
          callLog.error(
            {
              event: 'agent_session_error',
              error_message: e instanceof Error ? e.message : String(e),
              error_name: e instanceof Error ? e.name : typeof e,
              error_body: errorBody,
            },
            'AgentSession error (STT/LLM/TTS/realtime) — a prime suspect for mid-call dead air'
          );
          captureSentry(e instanceof Error ? e : new Error(String(e)), {
            event: 'agent_session_error',
            tenant_id: sessionCtx.tenantId,
            call_id: sessionCtx.callId ?? null,
          });

          // OUTAGE VOICE. On the Nth consecutive session error with no
          // successful speech in between, tell the caller and hang up.
          //
          // This must NOT go through the model. Every other recovery path here
          // does — the silent-turn nudge is a generateReply, the watchdog's
          // escalation is a say() that needs a live TTS round trip — so when
          // the LLM is the thing that is down they all die of the same cause,
          // which is exactly what happened on 2026-07-21: seven consecutive
          // errors, and the caller heard nothing at all. The line below plays
          // from the pre-synthesized cache and falls back to a plain say() only
          // if the warm never completed.
          if (noteSessionError(outageGuard)) {
            callLog.error(
              {
                event: 'outage_voice_triggered',
                consecutive_errors: OUTAGE_ERROR_LIMIT,
                error_message: e instanceof Error ? e.message : String(e),
              },
              'LLM/session errors back to back — telling the caller and ending the call rather than leaving dead air'
            );
            void (async () => {
              try {
                const frame = ttsVoiceKey ? getFillerFrame(ttsVoiceKey, OUTAGE_LINE) : undefined;
                const handle = frame
                  ? session.say(OUTAGE_LINE, { audio: frameStream(frame) })
                  : session.say(OUTAGE_LINE);
                await (handle as { waitForPlayout?: () => Promise<void> })?.waitForPlayout?.();
              } catch (sayErr) {
                // Saying it is best-effort: if even the cached path fails there
                // is nothing left to try, and closing is still better than
                // holding an already-dead line open.
                callLog.error(
                  {
                    event: 'outage_voice_say_failed',
                    error_message: sayErr instanceof Error ? sayErr.message : String(sayErr),
                  },
                  'could not speak the outage line — closing anyway'
                );
              } finally {
                void finalizeCall?.('outage');
                try {
                  await session.close();
                } catch {
                  /* already closing */
                }
              }
            })();
          }
        });

        // Finalize the call record the instant the caller hangs up. The job
        // often outlives a single call (worker reused for the next one), so the
        // 'close' event — not the job-shutdown backstop — is what normally writes
        // voice-session-end. Fire-once guard dedupes against the shutdown hook.
        session.on(voice.AgentSessionEventTypes.Close, () => {
          void finalizeCall?.('close');
        });

        // Output watchdog (never-silent backstop) — ON unless ENABLE_OUTPUT_WATCHDOG=false.
        // Pre-synthesize the fixed hold lines once (per voice, async — never blocks
        // the call; until warm, the watchdog falls back to live TTS), then attach
        // the session-level deadline timer.
        if (config.ENABLE_OUTPUT_WATCHDOG) {
          // Same voice AND same cache key as the main pre-generation above, or the
          // watchdog would synthesise its own copies under a different key — paying
          // twice for identical audio, and (worse) speaking the hold line in a
          // DIFFERENT VOICE from the rest of the call. Both lines are already in
          // PREGEN_LINES; this warm is now a no-op cache hit in the normal case.
          const watchdogVoice = ttsVoiceKey;
          // ONE definition (session/holdLines.ts). These used to be string literals
          // here AND in PREGEN_LINES below — and the filler cache is keyed BY THE
          // TEXT, so a one-character drift between the two copies would silently
          // miss the cache and put live TTS latency back on the line whose only job
          // is to cover latency. Nothing would error. It would just get slow again.
          const fillerText = HOLD_LINE;
          const thinkingText = THINKING_LINE;
          const recoveryText = RECOVERY_LINE;
          const fillerTts = new deepgram.TTS({
            apiKey: config.DEEPGRAM_API_KEY,
            model: ttsVoiceKey,
          }) as unknown as Parameters<typeof warmFillers>[0];
          void warmFillers(fillerTts, watchdogVoice, [
            fillerText,
            recoveryText,
            RECOVERY_LINE_AFTER_MESSAGE,
          ]).then(
            ({ failed }) => {
              if (failed.length > 0) {
                callLog.warn(
                  { event: 'watchdog_filler_warm_failed', failed_count: failed.length },
                  'watchdog filler pre-synthesis failed — will fall back to live TTS on the hold line'
                );
              }
            },
            () => undefined
          );
          const detachWatchdog = attachOutputWatchdog(session, {
            voice: watchdogVoice,
            thinkingText,
            // T-006: same measurement the turn_latency_ms log line carries, on
            // its way to the backend histogram. Exactly one watchdog feeds the
            // collector — see outputWatchdogActive below.
            onTurnLatency: (ms) => turnLatency.record(ms),
            // 3.5s, not 2.5s. At 2.5s it fired SEVEN TIMES in one call — the pipeline
            // (STT → gpt-4o-mini → TTS) routinely takes longer than that to produce a
            // first word, so the "backstop" became the normal case and the caller was
            // held on nearly every turn. A backstop that fires every turn is not a
            // backstop, it is a stutter. Tunable without a deploy.
            // 2800ms. It was 2500 (fired 7x in one call, and LIED each time — "let me
            // check that for you" when nothing was being checked), then 3500 to shut it
            // up, which traded the lying for LONG SILENCES the caller filled with
            // "Hello?".
            //
            // The line is HONEST now — "Just a moment." when no tool is running — so
            // firing is cheap again, and the right move is to cover the gap sooner
            // rather than leave a caller wondering if the line dropped. The real cure
            // is the agent being faster; this is the dressing on the wound.
            deadline1Ms: Number(process.env.WATCHDOG_DEADLINE_1_MS ?? 2800),
            fillerText,
            recoveryText,
            // Once a message exists, the recovery line stops offering to take one
            // (2026-09-09, SCL_A5wnBexPbwCC at 4:14 — it offered, and the caller
            // had to say "No. No message. Just pass this on.").
            recoveryTextAfterMessage: RECOVERY_LINE_AFTER_MESSAGE,
            log: callLog,
            // Hold lines are addToChatCtx:false (never pollute the model's
            // context) — this puts them in the TRANSCRIPT anyway, so a silent
            // call shows whether dead-air handling actually fired (the 07-27
            // 40s-of-nothing calls could not).
            onSpoken: (text) => transcript.add('assistant', text),
          });
          session.on(voice.AgentSessionEventTypes.Close, detachWatchdog);
        }

        // Silent-turn-death recovery — UNCONDITIONAL, deliberately NOT behind
        // ENABLE_OUTPUT_WATCHDOG. Prod had that flag off as of 2026-07-17
        // (maxToolSteps-capped turn, permanent silence, nothing covered it).
        // The recovery stays unconditional even when the watchdog is on: a
        // turn that ends with zero audio is a dropped call, not a polish
        // option. See attachSilentTurnRecovery for the full post-mortem.
        const detachTurnRecovery = attachSilentTurnRecovery(session, {
          voice: ttsVoiceKey,
          recoveryText: RECOVERY_LINE,
          log: callLog,
          // When the output watchdog is ALSO attached (ENABLE_OUTPUT_WATCHDOG
          // on), IT owns turn_latency_ms — it can tell a filler's 'speaking'
          // apart from the real reply's; this function cannot. See the option's
          // doc comment in watchdog.ts for what goes wrong without this.
          outputWatchdogActive: config.ENABLE_OUTPUT_WATCHDOG,
          // Fires only when this function owns the measurement (i.e. the output
          // watchdog is off), so a turn is never recorded twice.
          onTurnLatency: (ms) => turnLatency.record(ms),
          onSpoken: (text) => transcript.add('assistant', text),
          // The turn made no sound, but its text is already in the transcript —
          // the framework records assistant turns off the token stream, not off
          // playout. Mark it rather than let the call record claim the caller
          // heard something they did not.
          onUnheardTurn: () => {
            const marked = transcript.markLastAssistantUnheard();
            if (marked) {
              callLog.info(
                { event: 'transcript_marked_unheard' },
                'the last assistant line was marked NOT HEARD — its audio never reached the caller'
              );
            }
          },
        });
        session.on(voice.AgentSessionEventTypes.Close, detachTurnRecovery);

        // CALLER-side silence — the gap the two watchdogs above never covered,
        // because both arm on the AGENT's state and stand down exactly when the
        // caller's silence begins. Four calls on 2026-07-27 held 13-42 seconds
        // of dead air after the greeting and said nothing into it; one caller
        // had been told to ring back at that time and was waiting for a human
        // (CALL_IMPROVEMENTS.md #5, #6, #4, #11).
        //
        // Unconditional, like attachSilentTurnRecovery and for the same reason:
        // an empty line held open until the caller gives up is a dropped call,
        // not a polish item. Tunable without a deploy.
        const detachCallerSilence = attachCallerSilenceWatch(session, {
          checkInText: CALLER_CHECK_IN_LINE,
          silenceMs: envMs('CALLER_SILENCE_MS', 10_000),
          giveUpMs: envMs('CALLER_SILENCE_GIVEUP_MS', 12_000),
          log: callLog,
          onSpoken: (text) => transcript.add('assistant', text),
          onGiveUp: () => {
            // Say goodbye, then close — a call that ends because nobody was
            // there should still END, rather than sit open until the carrier
            // times it out and leaves a session with no outcome.
            void (async () => {
              try {
                await session
                  .say(CALLER_SILENCE_GOODBYE, { allowInterruptions: false, addToChatCtx: false })
                  .waitForPlayout();
                transcript.add('assistant', CALLER_SILENCE_GOODBYE);
              } catch {
                /* draining/closed — close anyway; a silent hangup beats a stuck line */
              }
              // Macrotask, same as finish_call's close: tearing the session down
              // inside an event handler is what made the goodbye register as an
              // internal error on 2026-07-21.
              setTimeout(() => {
                session.close().catch(() => {
                  /* already closing */
                });
              }, 0);
            })();
          },
        });
        session.on(voice.AgentSessionEventTypes.Close, detachCallerSilence);

        // Thinking-sound bed (never-silent polish) — OFF unless ENABLE_THINKING_SOUND.
        // A looping keyboard-typing ambiance plays while the agent is 'thinking'
        // and stops on 'speaking' (LiveKit BackgroundAudioPlayer owns the track,
        // loop, mix, and agent_state wiring). ctx.room is connected (ctx.connect
        // above) and the session is started, so the bed's track can publish.
        if (config.ENABLE_THINKING_SOUND) {
          const detachThinkingSound = attachThinkingSound(session, ctx.room, {
            volume: config.THINKING_SOUND_VOLUME,
            log: callLog,
          });
          session.on(voice.AgentSessionEventTypes.Close, detachThinkingSound);
        }

        // 6. Greeting = tenant opener + fixed disclosure + fixed closer.
        // The owner's "First Message" is the OPENER only; it is no longer spoken
        // verbatim as the whole greeting. The AI-identity + transcription
        // disclosure is appended by the platform on every call for every tenant
        // and cannot be edited or removed from the dashboard. See greeting.ts for
        // the wording rules and why each clause is worded the way it is.
        //
        // `greeting` and `ttsVoiceKey` were resolved — and their audio warmed — the
        // moment the tenant was known, while the phone was still ringing. By the time
        // we get here the frame is usually already in the cache, so the opener plays
        // instantly instead of synthesising live at pickup.
        // Greeting. Pipeline mode plays it via say() uninterrupted (a caller's
        // "hi?"/line noise at pickup shouldn't truncate the opening line); Realtime
        // mode speaks it via generateReply with server-side turn-taking (it rejects
        // allowInterruptions:false — see the Realtime branch below).
        // Fire-and-forget (don't block entry on full playout), but guard the
        // rejection: a say()/TTS failure here is OUTSIDE the enclosing try/catch,
        // so unguarded it becomes an unhandled promise rejection that can
        // destabilize the worker. SpeechHandle is a thenable WITHOUT a .catch
        // method, so wrap in an async IIFE + try/catch (await uses .then). Log
        // and continue; the session lives on.
        void (async () => {
          try {
            if (config.ENABLE_REALTIME) {
              // Realtime is speech-to-speech with NO TTS plugin, so say(text)
              // throws "trying to generate speech from text without a TTS model".
              // Have the model SPEAK the opener via generateReply instead.
              // NOTE: no allowInterruptions here — RealtimeModel uses server-side
              // turn detection and rejects allowInterruptions:false on
              // generateReply ("...cannot be false..."), which left the session
              // not listening after the greeting → the caller's next turn was
              // dropped → silence. Let server VAD own turn-taking.
              await session.generateReply({
                // Greeting on its own lines (not quote-wrapped) so a tenant
                // greeting containing a " or newline can't make the instruction
                // ambiguous.
                instructions: `Greet the caller now by speaking this exact opening line verbatim, then wait for their reply:\n\n${greeting}`,
              });
            } else {
              // Uninterruptible: the opener carries the AI-identity + transcription
              // disclosure, which is a COMPLIANCE line. If the caller talks over it,
              // we legally did not say it. allowInterruptions:false here is belt-and-
              // braces on top of the session-level interruption.enabled:false — this
              // one utterance must survive even if barge-in is ever re-enabled.
              // PRE-GENERATED GREETING — zero TTS latency on pickup.
              //
              // The greeting is the ONE line that is fully deterministic: it is built
              // from the tenant's own config and is byte-identical on every call this
              // worker ever answers. Synthesising it live meant every caller heard a
              // beat of silence at pickup — the worst possible place for it, because a
              // caller who has just been connected and hears nothing assumes the line is
              // dead. It is also the longest single utterance of the call.
              //
              // So we synthesise it ONCE and replay the frame. session.say(text, {audio})
              // skips synthesis entirely. The machinery already existed (fillerCache, built
              // for the watchdog's hold lines) and was simply never pointed at the one
              // utterance that needed it most.
              //
              // Warming is best-effort and off the hot path: if it hasn't landed yet (first
              // call after a deploy) or the synth failed, `frame` is undefined and say()
              // falls back to live synthesis — slower, but never silent. A cache miss must
              // degrade to the old behaviour, never to dead air.
              // WAIT FOR THE VOICE TO BE READY — but never longer than it would have
              // taken to just synthesise it live.
              //
              // Starting the warm early was not enough. Fire-and-forget means the
              // say() fires microseconds later and reads an EMPTY cache, so the
              // pre-generation lost its own race on every cold worker and the greeting
              // synthesised live anyway — measured, twice, on this branch:
              // `greeting_spoken pregenerated=false`. Work started but not awaited is
              // work wasted.
              //
              // So await it, with a hard cap. The cap is what makes this safe: if the
              // synth is slow or Deepgram is having a bad day, we stop waiting and
              // stream live exactly as before. Worst case is TODAY'S behaviour; best
              // case the opener plays instantly from a frame. There is no case where a
              // caller waits longer than they already do.
              //
              // On a real PSTN call this is nearly free — the phone is RINGING through
              // ctx.connect() and waitForParticipant(), and the warm started back when
              // the tenant resolved. By here it is usually already done.
              // Greeting audio MUST be HTTP-collected frames. Live WS say()
              // from this host delivered 0 bytes — "no answer". The warm
              // started before pickup; finish it, then play. Do not fall
              // through to the silent stream just to avoid waiting.
              await warmedGreetingP.catch(() => undefined);
              const greetingFrame = getFillerFrame(ttsVoiceKey, greeting);
              const speak = greetingSpeakPath(Boolean(greetingFrame));
              const opener =
                speak === 'play_cache' && greetingFrame
                  ? session.say(greeting, {
                      allowInterruptions: false,
                      audio: frameStream(greetingFrame),
                    })
                  : session.say(greeting, { allowInterruptions: false });
              const greetingAtMs = Date.now();
              // ms_since_participant is THE number — the silence the caller
              // actually sits through. ms_since_entry brackets it from the other
              // side (dispatch/config/prefetch before the leg is even up), so a
              // slow greeting can be attributed instead of guessed at.
              callLog.info(
                {
                  event: 'greeting_spoken',
                  pregenerated: Boolean(greetingFrame),
                  chars: greeting.length,
                  ms_since_entry: greetingAtMs - entryAtMs,
                  ms_since_participant:
                    participantAtMs === null ? null : greetingAtMs - participantAtMs,
                },
                greetingFrame
                  ? 'greeting played from cache — no TTS latency'
                  : 'greeting synthesised live (warm missed the cap) — audible pause at pickup'
              );
              await opener.waitForPlayout();

              // Drop whatever the caller said OVER the greeting.
              //
              // The session keeps buffered audio by default (discardAudioIfUninterruptible
              // = false, above) so nothing a caller says mid-reply is ever lost. The
              // greeting is the ONE place we don't want that: it is a fixed script where
              // nothing the caller says is actionable, and keeping it is exactly what
              // broke the 2026-07-12 call — she made a noise over the opener, it landed
              // as a turn ("Bye."), and the model answered it by composing a SECOND,
              // different greeting. The caller heard two openings, neither complete.
              //
              // After this line, everything she says is buffered and answered in order.
              session.clearUserTurn();
            }
          } catch (e) {
            callLog.error(
              {
                event: 'greeting_say_failed',
                error_message: e instanceof Error ? e.message : String(e),
              },
              'greeting failed — caller may not hear the opening line; session continues'
            );
          }
        })();
      } catch (err) {
        callLog.error(
          {
            event: 'fallback_triggered',
            reason: 'session_start_failed',
            tenant_id: sessionCtx.tenantId,
            room: ctx.room.name,
            error_message: err instanceof Error ? err.message : String(err),
          },
          'voice session failed to start — running fallback so the caller is not left in dead air'
        );
        captureSentry(err instanceof Error ? err : new Error(String(err)), {
          event: 'fallback_triggered',
          reason: 'session_start_failed',
          tenant_id: sessionCtx.tenantId,
          room: ctx.room.name,
        });
        await runFallback(ctx, "I'm sorry, we're having a system issue.", config);
        return;
      }
    } catch (err) {
      // Outer catch: unexpected throw from tool-client setup, buildTools,
      // fetchTenantConfig, or buildSystemPrompt. Inner session.start errors
      // are caught above and never reach here. Log + degrade to fallback so
      // the caller is not left in silence.
      callLog.error(
        {
          event: 'fallback_triggered',
          reason: 'entry_setup_failed',
          tenant_id: sessionCtx.tenantId,
          room: ctx.room.name,
          error_message: err instanceof Error ? err.message : String(err),
        },
        'unexpected error in agent entry setup — running fallback'
      );
      captureSentry(err instanceof Error ? err : new Error(String(err)), {
        event: 'fallback_triggered',
        reason: 'entry_setup_failed',
        tenant_id: sessionCtx.tenantId,
        room: ctx.room.name,
      });
      await runFallback(ctx, "I'm sorry, we're having a system issue.", config);
    }
  },
});

cli.runApp(
  new WorkerOptions({
    agent: fileURLToPath(import.meta.url),
    // Must match the agentName in the LiveKit dispatch rule
    // (SDR_WEL49AwBB4NW / thinkinghammer-dispatch). If these drift, dispatched
    // jobs won't route to this worker and calls will hit dead air.
    //
    // OVERRIDABLE so a BRANCH can be heard without racing production.
    //
    // LiveKit load-balances a dispatch across every worker registered under the
    // same agentName. So running a local worker on a feature branch — the only way
    // to actually LISTEN to a change before merging it — silently entered it into a
    // coin-flip with the Railway worker running main. Whichever won the job is the
    // code you heard, and nothing in the output told you which.
    //
    // That is not hypothetical. On 2026-07-14 the owner was told a fix was live
    // because a dispatch "picked up"; it had landed on the OLD binary, and the
    // worker did not actually restart until five minutes after he hung up. A test
    // whose result you cannot attribute to a specific commit is not a test.
    //
    // Set AGENT_NAME=secretary-hq-agent-dev on both the worker and the dispatcher
    // (scripts/sim-call.mjs reads the same var) and the job can ONLY land on yours.
    agentName: process.env.AGENT_NAME ?? 'secretary-hq-agent',
    // WHO PAYS FOR PROCESS STARTUP.
    //
    // A job runs in its own process, and prewarm (Silero VAD load, DNS warm)
    // runs inside it. With an idle process waiting, all of that is already done
    // when the call arrives. With none, the caller waits through it.
    //
    // The SDK default is min(cpus, 4) in production and ZERO in dev mode — so a
    // local `dev` worker spawns the process on demand and the developer testing
    // the call hears every millisecond of startup, which is exactly the pause we
    // were chasing on 2026-08-15. Undefined keeps the SDK default (do not hard-
    // code a number here: forcing 1 would SHRINK the production pool from 4).
    numIdleProcesses: idleProcessOverride(),
  })
);
