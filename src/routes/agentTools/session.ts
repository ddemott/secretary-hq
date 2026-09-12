/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

/**
 * Call-lifecycle agent tools: the tenant config the worker reads on connect,
 * and the voice_sessions row it opens, incrementally updates, and finalizes.
 */
import {
  GetTenantConfigSchema,
  VoiceSessionStartSchema,
  VoiceSessionEndSchema,
  VoiceSessionTranscriptSchema,
  ReportDispatchNoParticipantSchema,
} from './schemas';
import { ok, fail, toolRoute, pgErrorFields, type AgentToolDeps } from './helpers';
import { getBusinessHours } from '../../services/businessHours';
import { normalizePhone, isValidPhone } from '../../services/phoneUtils';
import {
  getOrCreateCustomerByPhoneOnClient,
  PLACEHOLDER_NAMES,
} from '../../services/customerLookup';
// Direct from shared/ per phoneUtils' own note ("all new code should import
// directly from shared/phone"). canTransfer is THE resolved transfer capability
// — see the transfer_available field below for why the agent gets a boolean
// rather than the two raw numbers.
import { canTransfer } from '../../../shared/phone';
import { deriveChecklistRuntimeConfig } from '../../../shared/checklistPresetDerivation';
import { loadTenantQuestionTrees } from '../../services/questionTrees';
import { sendSms } from '../../services/telnyxSms';
import {
  callOutcomeTotal,
  callsTotal,
  errorsTotal,
  silentHangupsTotal,
  turnLatencyMs,
} from '../../services/metrics';

/**
 * How long a call must last before "the caller never spoke" is evidence of a
 * fault rather than of a caller who hung up. The cached greeting runs ~12s, so
 * anything under that never gave them a turn; 20s clears the greeting plus a
 * beat. Deliberately conservative — a false "your phone line is broken" alarm
 * is worse than a missed short call, and a genuinely broken audio path repeats.
 */
const SILENT_CALL_MIN_SECONDS = 20;

/**
 * Does a rendered transcript contain at least one CALLER line?
 *
 * Accepts both shapes: the timestamped "Caller [1:23]: " (2026-07-30 onward) and
 * the bare "Caller: " of older agents — during a deploy the two coexist, and a
 * mismatch here would mark every healthy call as silent. Defined once because
 * three call sites now depend on it (the alarm, the greeting-only counter, and
 * the phonebook prune) and three drifting copies of one predicate is how the
 * copies stop agreeing.
 */
const CALLER_LINE_RE = /^Caller(?: \[\d+:\d{2}\])?: /m;

export function registerSessionRoutes({ app, withTenantClient }: AgentToolDeps): void {
  // tenant-config — minimal display info the agent worker needs at the
  // start of every call (business name + IANA timezone). Read on connect
  // before the system prompt is built so the LLM greets with the real
  // business name and reasons about "today" in the tenant's local zone.
  toolRoute(
    app,
    '/agent-tools/tenant-config',
    GetTenantConfigSchema,
    async (args, reply) => {
      const row = await withTenantClient(args.tenant_id, async (client) => {
        const res = await client.query<{
          name: string;
          timezone: string | null;
          business_type: string | null;
          checklist_preset_id: string | null;
          checklist_overrides: { disabled_conversation_blocks?: string[] } | null;
          system_prompt: string | null;
          persona_name: string | null;
          first_message: string | null;
          save_preferences_enabled: boolean | null;
          preferences_instructions: string | null;
          tts_voice: string | null;
          tts_speed: number | null;
          tts_soft: boolean | null;
          tts_cheerful: boolean | null;
          tts_formal: boolean | null;
          tts_warm: boolean | null;
          tts_concise: boolean | null;
          forward_phone: string | null;
          forwarded_from_phone: string | null;
          inbound_phone: string | null;
          call_disclosure: string | null;
          greeting_menu: string | null;
          greeting_closer: string | null;
          booking_mechanics: string | null;
        }>(
          `SELECT name, timezone, business_type, checklist_preset_id, checklist_overrides, system_prompt, persona_name, first_message, save_preferences_enabled, preferences_instructions, tts_voice, tts_speed, tts_soft, tts_cheerful, tts_formal, tts_warm, tts_concise, forward_phone, forwarded_from_phone, inbound_phone, call_disclosure, greeting_menu, greeting_closer, booking_mechanics FROM tenants WHERE tenant_id = $1`,
          [args.tenant_id]
        );
        if (!res.rows[0]) return null;
        // The shop's opening hours, derived from who is actually on the schedule
        // (there is no business-hours config — the open window IS the union of
        // staff shifts). Handed to the agent so it can LEAD with them instead of
        // asking "what day and time were you thinking?" against a calendar the
        // caller cannot see — the open-ended question that made the 2026-07-12
        // caller name two impossible dates in a row. 2026-07-12.
        const hours = await getBusinessHours(client, args.tenant_id);
        // WHO THE CALLER CAN ACTUALLY ASK FOR. On 2026-07-27 a caller asked for
        // "Jane" — an STT mangle of "Dale", the tenant's only employee — and the
        // agent adopted the name unchallenged, confirming "You're booked for
        // 1:00 PM with Jane" (CALL_IMPROVEMENTS.md #10). Nothing in the agent
        // knew who worked there, so there was nothing to check the name against.
        // First names only: the roster goes into a PROMPT the model speaks from,
        // and a receptionist says "Dale", not "Dale DeMott".
        const staff = await client.query<{ first: string }>(
          `SELECT DISTINCT COALESCE(NULLIF(TRIM(first_name), ''), split_part(TRIM(name), ' ', 1)) AS first
             FROM employees
            WHERE tenant_id = $1 AND is_active = true
              AND (is_deleted IS NULL OR is_deleted = false)
            ORDER BY 1
            LIMIT 25`,
          [args.tenant_id]
        );
        // THIS TENANT'S OWN QUESTIONS, when they have been provisioned with a
        // copy. An EMPTY ARRAY is meaningful and is not a failure: it means the
        // tenant predates per-tenant trees (or their copy failed), and the agent
        // falls back to the platform TypeScript library — i.e. exactly the
        // behaviour every existing tenant has today. Shipping this field can
        // therefore not change any current call on its own; a call only changes
        // once a tenant actually has rows.
        const questionTrees = await loadTenantQuestionTrees(client, args.tenant_id);
        return {
          ...res.rows[0],
          hours,
          staff: staff.rows.map((r) => r.first).filter((n) => n && n.length > 0),
          questionTrees,
        };
      });
      if (!row) {
        return fail(reply, 'Tenant not found');
      }
      return ok(reply, {
        // Spoken hours ("Monday to Friday, 1:00 PM to 5:00 PM") + how far out we
        // can actually be booked. Empty string / null when nobody is scheduled —
        // the agent must then NOT claim to be open.
        business_hours: row.hours.spoken || null,
        bookable_through: row.hours.bookableThrough,
        name: row.name,
        timezone: row.timezone || 'America/Chicago',
        // 2026-05-18: surface the tenant's custom prompt template so the agent
        // worker can substitute placeholders and use it as the role/identity
        // section. NULL means "use the agent's hardcoded fallback" — preserves
        // backwards compatibility with tenants that haven't customized.
        system_prompt: row.system_prompt,
        // 2026-06-30: owner-editable assistant name (dashboard "Assistant Name").
        // The agent injects "Your name is X" so it overrides any name baked into
        // the system_prompt text. NULL = keep whatever the prompt already says.
        persona_name: row.persona_name ?? null,
        // 2026-06-11: the owner-editable greeting (dashboard "First Message").
        // NULL means the agent speaks its hardcoded "Thanks for calling…"
        // fallback, so a tenant that never set one is unaffected.
        first_message: row.first_message ?? null,
        // 2026-06-06: customer-preference capture config. When enabled, the
        // agent injects preferences_instructions into the prompt and is told
        // to call save_customer_preference. Default false / null is "off".
        save_preferences_enabled: row.save_preferences_enabled ?? false,
        preferences_instructions: row.preferences_instructions ?? null,
        // 2026-06-10 (Grok era): per-tenant TTS voice + delivery. NULL means the
        // agent uses platform defaults, so tenants who haven't picked a voice are
        // unaffected. Post-2026-06-25 tts_voice/tts_speed are OpenAI voice/speed.
        //
        // The tts_soft/cheerful/formal/warm/concise flags are NOT inert — this
        // comment said they were until 2026-07-13, and it was wrong. They started
        // as Grok prosody knobs and were repurposed as LLM PROMPT-STYLE flags: the
        // dashboard still renders toggles for them and agent/src/prompt.ts injects
        // a "# Voice style" section from them. They ride this route to get there.
        tts_voice: row.tts_voice ?? null,
        tts_speed: row.tts_speed ?? null,
        tts_soft: row.tts_soft ?? null,
        tts_cheerful: row.tts_cheerful ?? null,
        tts_formal: row.tts_formal ?? null,
        tts_warm: row.tts_warm ?? null,
        tts_concise: row.tts_concise ?? null,
        // 2026-06-11: live-transfer destination (owner cell). NULL means no
        // forwarding configured — the agent's transfer_call tool stays inert
        // and falls back to taking a message.
        forward_phone: row.forward_phone ?? null,
        // The line the tenant forwards INTO the assistant — caller-ID match
        // tells the agent to collect the caller's real number by voice.
        forwarded_from_phone: row.forwarded_from_phone ?? null,
        // 2026-07-23: THE resolved transfer capability, decided here so the
        // agent never re-derives it from raw numbers.
        //
        // "Is forwarding on?" is the WRONG question — a tenant may forward from
        // a home line and transfer to a shop line, which is two different
        // numbers and a perfectly valid setup. The disqualifying condition is
        // SAMENESS: a transfer target equal to the line that forwards in (or to
        // our own inbound number) rings straight back into the assistant.
        // canTransfer() owns that comparison for every caller, normalized.
        //
        // Handed over as ONE boolean on purpose. The agent already received
        // forward_phone and forwarded_from_phone and did nothing with them; a
        // prompt that re-derives the rule is a second copy of the rule, and a
        // second copy drifts.
        transfer_available: canTransfer(
          row.forward_phone,
          row.forwarded_from_phone,
          row.inbound_phone
        ),
        // 2026-07-11: owner-editable spoken caller disclosure (AI + transcription
        // notice). NULL/blank means the agent speaks the platform default from
        // greeting.ts; a set value is spoken verbatim (attestation-gated on write).
        call_disclosure: row.call_disclosure ?? null,
        // 2026-07-21: owner-editable spoken services menu ("I can help with a
        // job opportunity, a drop-off computer repair…") — spoken between the
        // disclosure and "How can I help you today?". NULL/blank = no menu line.
        greeting_menu: row.greeting_menu ?? null,
        greeting_closer: row.greeting_closer ?? null,
        // 2026-07-31: what happens AT the booked time, spoken verbatim after a
        // successful booking. NULL = say nothing extra. See migration
        // 20260731000000 — the "call Dale on this same number" cascade.
        booking_mechanics: row.booking_mechanics ?? null,
        checklist_runtime_config: deriveChecklistRuntimeConfig(
          row.business_type,
          row.checklist_preset_id,
          row.checklist_overrides
        ),
        question_trees: row.questionTrees,
        // Active staff first names — the roster the agent checks a caller-named
        // person against before repeating it back as fact ("Jane" → "You mean
        // Dale?"). Empty array when a tenant has no employees configured.
        staff_first_names: row.staff,
      });
    },
    'Failed to fetch tenant config'
  );

  // voice-session-start — agent calls this on connect to create the
  // voice_sessions row (and resolve customer context). start_voice_session
  // does a plain INSERT (not idempotent) — the agent calls it once per call
  // and treats failure as non-fatal, so a duplicate/transient error can't
  // affect the live call.
  toolRoute(
    app,
    '/agent-tools/voice-session-start',
    VoiceSessionStartSchema,
    async (args, reply) => {
      // COUNT THE CALL BEFORE ANYTHING CAN FAIL (T-006). Every per-call rate
      // needs a denominator, and the denominator has to be incremented on the
      // way IN — count it after the INSERT and a database outage stops the
      // counter too, so an outage and a quiet hour produce the same flat line.
      //
      // `source` is derived, not claimed: sessionContext.ts sets callId from the
      // SIP call ID when there is a SIP participant, and falls back to
      // `room:<roomName>` when there is none — which is exactly the browser
      // caller-simulator. No third value is invented.
      callsTotal.inc({ source: args.call_id.startsWith('room:') ? 'browser' : 'phone' });
      try {
        await withTenantClient(args.tenant_id, async (client) => {
          await client.query('SELECT start_voice_session($1, $2, $3) AS context', [
            args.tenant_id,
            args.call_id,
            args.caller_phone ?? null,
          ]);

          // EVERY IDENTIFIED CALLER ENTERS THE CRM, on the call itself.
          //
          // start_voice_session resolves customer context via
          // get_customer_context_for_call, which LOOKS UP a customer by phone and
          // stores NULL when there isn't one. So a caller was recorded in the CRM
          // only if they went on to book, leave a message, page the owner or file a
          // job inquiry — and a caller who asked a question, or hung up mid-flow,
          // existed nowhere but the Calls tab.
          //
          // Measured in production 2026-07-27: 10 calls, 10 with caller ID, and
          // ZERO linked to a customer. The owner's phonebook did not contain a
          // single person who had actually phoned the business.
          //
          // This is the same look-up-and-shrug shape fixed in messaging earlier the
          // same day, one layer up — which is the tell that the seam was the lookup
          // habit itself, not the individual routes.
          //
          // The name is a PLACEHOLDER ('Caller'): caller ID gives us a number, not a
          // person. It is deliberately one of PLACEHOLDER_NAMES so the first rung
          // that learns their real name overwrites it (backfillCustomerName), rather
          // than the phonebook keeping "Caller" forever.
          //
          // Deliberate limits:
          //   - No caller ID (blocked/withheld, or a forwarded line) → nothing is
          //     created. We will not invent an identity we do not have.
          //   - This DOES create a row for a wrong number or a hang-up. That is the
          //     cost of "every call is in the CRM"; the alternative — deciding
          //     mid-call whose call was worth recording — is how the 10-for-10 gap
          //     happened. The Calls tab still distinguishes them by outcome.
          //   - Non-fatal by design, inside the existing best-effort try/catch: a
          //     CRM write must never take down a live call.
          const phone = args.caller_phone ? normalizePhone(args.caller_phone) : null;
          if (phone && isValidPhone(phone)) {
            const customerId = await getOrCreateCustomerByPhoneOnClient(
              client,
              args.tenant_id,
              phone,
              null // no name yet — the greeting hasn't even finished
            );
            if (customerId) {
              // Link the CALL to the person, so the Calls tab and the customer's
              // history are two views of one fact instead of two disconnected lists.
              await client.query(
                `UPDATE voice_sessions SET customer_id = $1
                  WHERE tenant_id = $2 AND call_id = $3 AND customer_id IS NULL`,
                [customerId, args.tenant_id, args.call_id]
              );
            }
          }
        });
        // DUPLICATE-DISPATCH DETECTOR (2026-07-23). The double-dispatch bug can
        // create TWO sessions for one inbound call — the 1:46 PM call had two
        // SIP legs 3s apart, both with the same caller_phone. The participant
        // guard in the agent kills the EMPTY-room variant, but a genuine
        // two-leg fork (both legs have a participant) still reaches here twice.
        // When a second live session appears for the same tenant+phone within a
        // short window, bump errors_total{event="duplicate_dispatch_detected"}
        // so the fork RATE is visible on /metrics. Observability ONLY — never
        // affects the session start (own try/catch, swallowed), because a false
        // positive (a real quick call-back) must not break call logging.
        if (args.caller_phone) {
          try {
            const dup = await withTenantClient(args.tenant_id, (client) =>
              client.query<{ n: number }>(
                `SELECT count(*)::int AS n FROM voice_sessions
                  WHERE tenant_id = $1 AND caller_phone = $2 AND call_id <> $3
                    AND started_at > now() - interval '30 seconds'
                    AND (is_deleted IS NULL OR is_deleted = false)`,
                [args.tenant_id, args.caller_phone, args.call_id]
              )
            );
            const priorCount = dup.rows[0]?.n ?? 0;
            if (priorCount > 0) {
              errorsTotal.inc({ event: 'duplicate_dispatch_detected' });
              app.log.warn(
                {
                  event: 'duplicate_dispatch_detected',
                  tenant_id: args.tenant_id,
                  call_id: args.call_id,
                  prior_sessions: priorCount,
                  caller_phone_last4: args.caller_phone.slice(-4),
                },
                'a second voice session opened for the same caller within 30s — likely a duplicate/forked dispatch'
              );
            }
          } catch {
            // Detector is best-effort; a failed observability query must never
            // fail the call-logging write above.
          }
        }
      } catch (err) {
        // 5W sad-path log so a call that fails to log is diagnosable from ONE
        // line. WHO: tenant_id. WHAT: voice_session_start (caller_phone null =
        // forwarded/anonymous line). WHEN: now (call connect). WHERE: this RPC.
        // WHY: the pg SQLSTATE/constraint/column. Plus errors_total{event} so the
        // failure survives log truncation. The agent calls this fire-and-forget,
        // so without this the call simply vanishes (Calls tab empty, no trace).
        errorsTotal.inc({ event: 'voice_session_start_failed' });
        app.log.error(
          {
            event: 'voice_session_start_failed',
            tenant_id: args.tenant_id,
            call_id: args.call_id,
            caller_phone_present: args.caller_phone != null,
            ...pgErrorFields(err),
          },
          'voice-session-start failed — call will NOT appear in the Calls tab'
        );
        return fail(reply, 'Failed to start voice session', 500);
      }
      return ok(reply, { started: true });
    },
    'Failed to start voice session'
  );

  // report-dispatch-no-participant — the agent posts this when a dispatch landed
  // on a room that never got a SIP participant (a ghost/duplicate dispatch) and
  // it left without opening a session. Observability ONLY: bumps
  // errors_total{event="dispatch_no_participant"} so the ghost-leg RATE is on the
  // /metrics board and alertable, and writes a 5W line. No DB write — there is
  // deliberately no voice_sessions row for a call nobody was on. (2026-07-23.)
  toolRoute(
    app,
    '/agent-tools/report-dispatch-no-participant',
    ReportDispatchNoParticipantSchema,

    async (args, reply) => {
      errorsTotal.inc({ event: 'dispatch_no_participant' });
      app.log.warn(
        {
          event: 'dispatch_no_participant',
          tenant_id: args.tenant_id,
          room: args.room,
        },
        'agent left a dispatch with no SIP participant (ghost/duplicate dispatch) — no session opened'
      );
      return ok(reply, { recorded: true });
    },
    'Failed to record dispatch-no-participant'
  );

  // voice-session-end — agent calls this from its shutdown callback when the
  // call ends, recording duration, outcome, the rendered transcript, a post-call
  // summary, and the appointment_id booked during the call (all optional; the
  // agent fills what it has). Returns ended:false if no open row matched.
  toolRoute(
    app,
    '/agent-tools/voice-session-end',
    VoiceSessionEndSchema,
    async (args, reply) => {
      let sessionEnd: { ended: boolean; forwardPhone: string | null; inboundPhone: string | null };
      try {
        sessionEnd = await withTenantClient(args.tenant_id, async (client) => {
          const res = await client.query<{ ended: boolean }>(
            'SELECT end_voice_session($1, $2, $3, $4, $5, $6, $7) AS ended',
            [
              args.tenant_id,
              args.call_id,
              args.duration_seconds ?? null,
              args.outcome ?? null,
              args.transcript ?? null,
              args.summary ?? null,
              args.appointment_id ?? null,
            ]
          );
          // Persist the per-call tool trace into metadata (2026-07-30). A MERGE
          // (`||`), not a SET — metadata may carry other keys, and the RPC above
          // is deliberately untouched (changing its signature creates a second
          // overload; see the booking-RPC "function is not unique" lesson).
          // Only when the agent sent one: the finalize pass carries it, the
          // enrich pass omits it, and omission must never erase it.
          if (args.tool_calls != null) {
            await client.query(
              `UPDATE voice_sessions
                  SET metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object('tool_calls', $3::jsonb),
                      updated_at = now()
                WHERE tenant_id = $1 AND call_id = $2`,
              [args.tenant_id, args.call_id, JSON.stringify(args.tool_calls)]
            );
          }
          if (!['price', 'no_availability'].includes(args.outcome ?? '')) {
            return { ended: res.rows[0]?.ended ?? false, forwardPhone: null, inboundPhone: null };
          }
          const tenant = await client.query<{
            forward_phone: string | null;
            inbound_phone: string | null;
          }>('SELECT forward_phone, inbound_phone FROM tenants WHERE tenant_id = $1', [
            args.tenant_id,
          ]);
          return {
            ended: res.rows[0]?.ended ?? false,
            forwardPhone: tenant.rows[0]?.forward_phone ?? null,
            inboundPhone: tenant.rows[0]?.inbound_phone ?? null,
          };
        });
      } catch (err) {
        // 5W sad-path log: an end failure means duration/transcript/outcome/
        // summary never persisted and the row is stranded 'active'. WHO tenant,
        // WHAT voice_session_end, WHERE this RPC, WHY the pg SQLSTATE/constraint.
        errorsTotal.inc({ event: 'voice_session_end_failed' });
        app.log.error(
          {
            event: 'voice_session_end_failed',
            tenant_id: args.tenant_id,
            call_id: args.call_id,
            outcome: args.outcome ?? null,
            has_transcript: args.transcript != null,
            ...pgErrorFields(err),
          },
          'voice-session-end failed — transcript/duration/summary NOT saved; row left active'
        );
        return fail(reply, 'Failed to end voice session', 500);
      }
      const { ended, forwardPhone, inboundPhone } = sessionEnd;

      // WHAT THE CALL ENDED AS + HOW SLOW ITS TURNS WERE (T-006).
      //
      // Only when `ended` — voice-session-end is called TWICE per call (a
      // finalize pass and a later enrich pass, agent/src/index.ts), and
      // end_voice_session returns false the second time because the row is
      // already closed. Counting on `ended` alone is what keeps one call from
      // being counted as two.
      //
      // Turn latency can only be measured by the agent (the backend never sees
      // a turn), so it arrives as per-call samples here. Observing them one by
      // one is what makes the histogram's p95 mean the same thing it would if
      // the agent scraped itself.
      if (ended) {
        callOutcomeTotal.inc({ outcome: args.outcome ?? 'unknown' });
        for (const ms of args.turn_latency_ms ?? []) turnLatencyMs.observe(ms);
      }

      // SILENT CALL — the caller was on the line long enough to speak and not
      // one word of theirs reached us. The call still finalizes 'completed'
      // with a transcript holding only the agent's own greeting, which reads
      // like a caller who hung up. It is not: it is the shape a BROKEN INBOUND
      // AUDIO PATH makes.
      //
      // ORIGIN (2026-07-24, tenant Thinking Hammer): three of four real calls
      // arrived this way. Dale's wife called twice, spoke both times, and the
      // agent received 15 seconds of digital silence per call — Silero VAD
      // (local, on raw frames) never fired once, so nothing reached Deepgram
      // and the transcript held the greeting alone. Telnyx was offering
      // codecs LiveKit SIP cannot decode (G729 outright; G722 suspected),
      // negotiated per-caller — so it broke for mobile callers and worked for
      // the one overseas VoIP dialer. Nothing in the product said a word about
      // it. We found out because his wife mentioned the call in conversation.
      //
      // A call that produces zero caller speech is never a success. Count it
      // and say so, so the next one surfaces in `errors_total` within minutes
      // instead of being discovered socially.
      // CALLS WHERE THE CALLER NEVER SPOKE, counted separately from the
      // broken-audio alarm.
      //
      // Four calls on 2026-07-27 (13-42s) held the greeting and nothing else.
      // Whether that is a long greeting, a surprised caller, or a bad moment is
      // NOT knowable from one afternoon — and CALL_IMPROVEMENTS.md #4 says so
      // plainly: measure before shortening anything. This is the measurement.
      //
      // Deliberately NOT folded into no_caller_audio: that alarm means "the
      // inbound audio path is broken" and ignores short calls for exactly that
      // reason. A 13-second hang-up is not a codec failure; it is a person
      // deciding not to talk to a robot, and conflating the two would make both
      // numbers useless.
      if (ended && args.transcript && !CALLER_LINE_RE.test(args.transcript)) {
        silentHangupsTotal.inc({
          bucket: (args.duration_seconds ?? 0) < SILENT_CALL_MIN_SECONDS ? 'under_20s' : 'over_20s',
        });
      }

      if (ended && (args.duration_seconds ?? 0) >= SILENT_CALL_MIN_SECONDS) {
        const transcript = args.transcript ?? '';
        // Anchored to line start — "Caller:" inside the assistant's own words
        // must not count as a caller turn. Mirrors renderedHasCallerTurn() in
        // agent/src/transcript.ts, which owns the rendering side of this
        // contract; the two regexes must stay in step. Accepts both the
        // timestamped "Caller [1:23]: " (2026-07-30 onward) and the bare
        // "Caller: " of older agents — during a deploy the two coexist, and a
        // mismatch here would flag EVERY real call as no_caller_audio.
        if (!CALLER_LINE_RE.test(transcript)) {
          errorsTotal.inc({ event: 'no_caller_audio' });
          app.log.warn(
            {
              event: 'no_caller_audio',
              tenant_id: args.tenant_id,
              call_id: args.call_id,
              duration_seconds: args.duration_seconds ?? null,
              has_transcript: args.transcript != null,
              transcript_chars: transcript.length,
            },
            'call completed with ZERO caller speech after the greeting — inbound audio path is likely broken (codec negotiation / RTP), not a caller who hung up'
          );
        }
      }

      // PRUNE THE PHONEBOOK ENTRY A SILENT CALL LEFT BEHIND (2026-08-01).
      //
      // Every caller-ID call creates a customer up front (see voice-session-start
      // above) — a DELIBERATE 2026-07-27 fix, after prod showed 10 calls, 10 with
      // caller ID, and ZERO linked customers: the owner's phonebook contained
      // nobody who had actually phoned him. That fix stays. Its accepted cost was
      // a row for every robocall and wrong number, and the cost came due: prod
      // holds a customer named literally "Caller" created by a robocall that said
      // "Repeat this message." (CALL_IMPROVEMENTS.md #3).
      //
      // So prune at the END instead of refusing to create at the START — by then
      // the call has told us which it was. A row is removed ONLY when all of
      // these hold:
      //   - WE ACTUALLY CAPTURED A TRANSCRIPT, and it contains no caller line.
      //     A NULL transcript is not evidence of silence — it is evidence that
      //     transcript capture failed (agent crash, finalize before the recorder
      //     drained), and treating a capture failure as "nobody spoke" would
      //     delete a REAL customer on the strength of our own bug. Review catch
      //     on #313; the original condition read `args.transcript ?? ''`, which
      //     made absence and silence the same thing on a DELETE path.
      //   - the name is still a placeholder — nobody ever learned who they are,
      //   - the row has NO artifacts: no appointment, message, or job inquiry,
      //   - and no OTHER call is linked to it, so we cannot erase a returning
      //     customer whose earlier calls were real.
      //
      // Deliberately NOT gated on SILENT_CALL_MIN_SECONDS, unlike the
      // no_caller_audio alarm above. That alarm is about a BROKEN AUDIO PATH, so
      // it ignores short calls where a hang-up is the ordinary explanation. This
      // is about an EMPTY PHONEBOOK ROW, and a 13-second greeting-only hang-up
      // creates exactly the row worth pruning (CALL_IMPROVEMENTS.md #4, #11).
      // Same evidence, different questions, so: different thresholds.
      //
      // SOFT delete, the house pattern (tenants, customers): the row stops
      // polluting the phonebook and the CSV export, and the audit trail survives
      // — including for the caller who rings back tomorrow and turns out to be
      // real. Best-effort: never fail a finalized call over housekeeping.
      if (
        ended &&
        typeof args.transcript === 'string' &&
        args.transcript.length > 0 &&
        !CALLER_LINE_RE.test(args.transcript)
      ) {
        try {
          const pruned = await withTenantClient(args.tenant_id, async (client) =>
            client.query<{ customer_id: string }>(
              `UPDATE customers c
                  SET is_deleted = true, deleted_at = now(), deleted_by = 'silent_call_prune'
                FROM voice_sessions vs
               WHERE vs.tenant_id = $1 AND vs.call_id = $2
                 AND c.customer_id = vs.customer_id
                 AND c.tenant_id = $1
                 AND (c.is_deleted IS NULL OR c.is_deleted = false)
                 AND (c.name IS NULL OR c.name = '' OR c.name = ANY($3::text[]))
                 AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.customer_id = c.customer_id)
                 AND NOT EXISTS (SELECT 1 FROM customer_messages m WHERE m.customer_id = c.customer_id)
                 AND NOT EXISTS (SELECT 1 FROM job_inquiries j WHERE j.customer_id = c.customer_id)
                 AND NOT EXISTS (
                       SELECT 1 FROM voice_sessions other
                        WHERE other.customer_id = c.customer_id
                          AND other.call_id <> $2
                     )
               RETURNING c.customer_id`,
              [args.tenant_id, args.call_id, Array.from(PLACEHOLDER_NAMES)]
            )
          );
          if ((pruned.rowCount ?? 0) > 0) {
            app.log.info(
              {
                event: 'silent_call_customer_pruned',
                tenant_id: args.tenant_id,
                call_id: args.call_id,
              },
              'silent call left an anonymous phonebook entry with nothing on it — soft-deleted'
            );
          }
        } catch (err) {
          app.log.warn(
            { event: 'silent_call_prune_failed', call_id: args.call_id, ...pgErrorFields(err) },
            'could not prune the placeholder customer a silent call created — harmless, but the phonebook keeps a junk row'
          );
        }
      }

      if (ended && forwardPhone && inboundPhone) {
        const normalizedForward = normalizePhone(forwardPhone);
        const normalizedInbound = normalizePhone(inboundPhone);
        if (
          normalizedForward &&
          normalizedInbound &&
          isValidPhone(normalizedForward) &&
          isValidPhone(normalizedInbound)
        ) {
          const outcomeMsg =
            args.outcome === 'price'
              ? 'had concerns about pricing'
              : 'could not find an available time';
          const body = `SecretaryHQ: A recent caller ${outcomeMsg}. They may be worth a follow-up. — via SecretaryHQ`;
          // sendSms is a chokepoint that never rejects (see telnyxSms.ts) — it
          // already counts the failure in errors_total, but a bare .catch()
          // here can never fire, so a failed owner-nudge produced no local
          // log line at all. Check result.ok instead.
          void sendSms({ from: normalizedInbound, to: normalizedForward, body }).then((result) => {
            if (!result.ok) {
              app.log.error(
                { error: result.error, status: result.status },
                'Failed to send outcome-follow-up SMS to owner'
              );
            }
          });
        }
      }

      return ok(reply, { ended });
    },
    'Failed to end voice session'
  );

  // voice-session-transcript — incremental transcript save. The agent posts the
  // transcript-so-far after EVERY turn so a call that hangs or never sends
  // voice-session-end still has its conversation persisted up to the last turn.
  // Updates ONLY while the row is still 'active' (a finalized row's transcript is
  // authoritative — don't let a late straggler overwrite it). status is NOT
  // changed here; finalize/reaper own that.
  toolRoute(
    app,
    '/agent-tools/voice-session-transcript',
    VoiceSessionTranscriptSchema,
    async (args, reply) => {
      try {
        const res = await withTenantClient(args.tenant_id, (client) =>
          client.query(
            `UPDATE voice_sessions SET transcript = $3, updated_at = now()
             WHERE tenant_id = $1 AND call_id = $2 AND status = 'active'`,
            [args.tenant_id, args.call_id, args.transcript]
          )
        );
        return ok(reply, { updated: (res.rowCount ?? 0) > 0 });
      } catch (err) {
        // 5W sad-path: a failed incremental save is non-fatal (the next turn or
        // finalize/reaper catches up) but still worth a counter + named cause.
        errorsTotal.inc({ event: 'voice_session_transcript_failed' });
        app.log.error(
          {
            event: 'voice_session_transcript_failed',
            tenant_id: args.tenant_id,
            call_id: args.call_id,
            transcript_len: args.transcript.length,
            ...pgErrorFields(err),
          },
          'voice-session-transcript incremental save failed (non-fatal)'
        );
        return fail(reply, 'Failed to save transcript', 500);
      }
    },
    'Failed to save transcript'
  );
}
