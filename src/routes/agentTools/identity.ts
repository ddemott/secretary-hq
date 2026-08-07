/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method, @typescript-eslint/no-explicit-any */
/**
 * ESLint rules disabled for this file as part of historical full cleanup (REFACTORING_TODO item 10; see RESOLVED.md for details).
 * These are the remaining dynamic/any-heavy areas after previous tranches.
 */

/**
 * Caller-identity agent tools: who is on the phone (identify / look up by name),
 * what we already know about them (context, history, preferences), and the
 * consent + OTP phone-verification flows that make a spoken number trustworthy.
 */
import {
  CODE_DIGITS,
  CODE_TTL_MINUTES,
  MAX_VERIFY_ATTEMPTS,
  MAX_VERIFY_ATTEMPTS_PER_PHONE_PER_HOUR,
  RATE_LIMIT_PER_PHONE_PER_HOUR,
  RATE_LIMIT_PER_TENANT_PER_DAY,
  CustomerHistorySchema,
  FindByNameSchema,
  GetContextSchema,
  IdentifyCallerSchema,
  RecordSmsConsentSchema,
  SaveCustomerPreferenceSchema,
  SendVerificationCodeSchema,
  VerifyPhoneCodeSchema,
} from './schemas';
import type { PoolClient } from 'pg';
import { ok, fail, toolRoute, pgErrorFields, type AgentToolDeps } from './helpers';
import { normalizePhone, isValidPhone } from '../../services/phoneUtils';
import { sendSms, generateVerificationCode } from '../../services/telnyxSms';
import { errorsTotal } from '../../services/metrics';
import { PLACEHOLDER_NAMES } from '../../services/customerLookup';

/**
 * May we read this customer's identity data out loud to whoever is on the line?
 *
 * THE ONE GATE. Three routes hand back the same class of secret — a real
 * person's name, their preferences, their call history:
 *
 *   /agent-tools/identify-caller    (identify_caller)
 *   /agent-tools/customer-context   (get_customer_context)
 *   /agent-tools/customer-history   (get_detailed_customer_history)
 *
 * The gate shipped 2026-07-13 guarded only the FIRST one, which was worth very
 * little: the LLM chooses which tool to call, and `get_customer_context` takes
 * a phone number straight from the model. A stranger rings the forwarded line,
 * says Camille's number, and identify_caller correctly reveals nothing — then
 * the same number goes to customer-context and out comes her name, her stylist
 * and her history. A gate on one of three doors is not a gate; it is a
 * suggestion, and it depended on the model's goodwill to hold.
 *
 * So the rule lives HERE, once, and every disclosure route calls it:
 *
 *   phone_source='caller_id' → the CARRIER attested the number. The caller
 *     supplied nothing and cannot lie about it. Nothing to prove.
 *
 *   phone_source='spoken'    → the caller CLAIMED the number (forwarded line,
 *     or blocked caller ID). Anyone can claim any number. They must first prove
 *     possession: send_verification_code → read the 4-digit code back →
 *     verify_phone_code. Until then we may still SAVE what they tell us
 *     (writing is not leaking) but we reveal NOTHING.
 *
 * Returns true when disclosure is permitted. Logs the decision either way —
 * `identify_caller_gate` is the structured event to grep when a caller says the
 * AI "didn't know them".
 */
async function callerMayHearCustomerData(
  client: { query: PoolClient['query'] },
  app: AgentToolDeps['app'],
  params: {
    tenantId: string;
    phone: string;
    phoneSource: 'caller_id' | 'spoken';
    callId?: string | null;
    route: string;
  }
): Promise<boolean> {
  const { tenantId, phone, phoneSource, callId, route } = params;

  if (phoneSource === 'caller_id') {
    app.log.info(
      {
        event: 'identify_caller_gate',
        decision: 'ALLOWED_carrier_attested',
        route,
        phone_source: 'caller_id',
        otp_verified: false,
        reason:
          'the CARRIER gave us this number — the caller supplied nothing and cannot lie about it, so there is nothing to prove',
        tenant_id: tenantId,
        call_id: callId ?? null,
      },
      'IDENTIFY GATE: allowed — carrier-attested caller ID.'
    );
    return true;
  }

  // Proof must belong to THIS CALL.
  //
  // This used to accept any row verified in the last 24h for (tenant, phone) —
  // so one legitimate verification opened a 24-hour window in which ANY caller
  // who spoke that number was treated as its owner, with no code. The gate
  // degraded into "was this number ever verified recently", which is exactly the
  // claim-based trust it exists to destroy.
  //
  // A NULL call_id can never match: an unattributable proof is not a proof.
  const verified = callId
    ? await client.query(
        `SELECT 1 FROM phone_verifications
          WHERE tenant_id = $1 AND phone = $2 AND call_id = $3
            AND verified_at IS NOT NULL
          LIMIT 1`,
        [tenantId, phone, callId]
      )
    : { rowCount: 0 };

  if (verified.rowCount === 0) {
    app.log.info(
      {
        event: 'identify_caller_gate',
        decision: 'BLOCKED_unverified_spoken_number',
        route,
        phone_source: 'spoken',
        otp_verified: false,
        reason:
          'the caller SPOKE this number (no caller-ID) and possession is unproven — revealing name/preferences/history here would hand a stranger someone else data',
        next: 'agent must send_verification_code then verify_phone_code first',
        tenant_id: tenantId,
        call_id: callId ?? null,
      },
      'IDENTIFY GATE: blocked — spoken number is unverified. Revealing nothing.'
    );
    return false;
  }

  app.log.info(
    {
      event: 'identify_caller_gate',
      decision: 'ALLOWED_spoken_but_otp_verified',
      route,
      phone_source: 'spoken',
      otp_verified: true,
      reason: 'the caller proved possession of this number with a code ON THIS CALL',
      tenant_id: tenantId,
      call_id: callId ?? null,
    },
    'IDENTIFY GATE: allowed — spoken number, but OTP-verified.'
  );
  return true;
}

/**
 * Has this number ALREADY agreed to receive appointment texts?
 *
 * WHY THIS EXISTS: consent has always been durable — ConsentService.checkConsent
 * takes the most recent record and honours it until it is revoked, with no
 * expiry, which is also how TCPA works (prior express consent persists until the
 * customer revokes it). But nothing ever TOLD the agent, so the prompt asked for
 * permission before every single booking. The customer said yes once and got
 * interrogated forever — and it landed immediately after the AI had just greeted
 * them by name, which makes it sound like the AI doesn't actually remember them.
 * The data was right; the conversation was wrong.
 *
 * Mirrors ConsentService.checkConsent's DECISION RULE, and must keep mirroring it
 * — two implementations of "may we text this person?" that can disagree is a
 * worse bug than the one this fixes. Specifically:
 *   - 'sms' OR 'both' counts (a 'both' record covers SMS).
 *   - The MOST RECENT record wins, not any record — a later revocation overrides
 *     an earlier grant.
 *   - revoked_at set → false. This is what makes STOP work: the opt-out path
 *     (consentService.recordOptOut) writes an opt_out_record AND revokes the
 *     consent, so checking consent alone is sufficient to honour STOP.
 *
 * ONE DELIBERATE DIVERGENCE from checkConsent: this helper FAILS CLOSED on a query
 * error (returns false), where checkConsent would let the error propagate. That is
 * not an oversight and it is not a mirror-break, because the two answer different
 * questions. checkConsent gates an actual SEND — if it cannot determine consent it
 * must not silently proceed. This one only decides whether the AGENT ASKS. An
 * unknown consent state here means "ask", which is the safe direction: asking
 * someone who already agreed is mildly annoying; texting someone who never agreed
 * — or who said STOP — is illegal. The send is still gated by checkConsent
 * regardless of what this returns, so a false here can never cause an unlawful
 * text; it can only cause a redundant question.
 */
async function hasSmsConsent(
  client: { query: PoolClient['query'] },
  tenantId: string,
  phone: string
): Promise<boolean> {
  try {
    const res = await client.query<{ consent_given: boolean; revoked_at: string | null }>(
      `SELECT consent_given, revoked_at
         FROM consent_records
        WHERE tenant_id = $1
          AND customer_phone = $2
          AND consent_type IN ('sms', 'both')
        ORDER BY consent_date DESC
        LIMIT 1`,
      [tenantId, phone]
    );
    const latest = res.rows[0];
    if (!latest) return false;
    if (latest.revoked_at) return false;
    return latest.consent_given === true;
  } catch {
    return false;
  }
}

function maskPhoneForConfirmation(phone: string | null): string | null {
  if (!phone) return null;

  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '••••';

  const last4 = digits.slice(-4);
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1•••-•••-${last4}`;
  }

  return `•••-•••-${last4}`;
}

export function registerIdentityRoutes({ app, withTenantClient }: AgentToolDeps): void {
  // record-consent — the caller verbally agreed on the call to receive SMS
  // appointment confirmations/reminders. Writes a dated `consent_records` row
  // (method='verbal', source='voice_call:<call_id>') so reminderProcessor's
  // checkConsent lets this number through. Phone is normalized to match how
  // consent is looked up at send time. Informational only — the agent never
  // records marketing consent here. Best-effort success shape (never a 500)
  // so a hiccup can't derail the live call.
  toolRoute(
    app,
    '/agent-tools/record-consent',
    RecordSmsConsentSchema,
    async (args, reply) => {
      const normalized = normalizePhone(args.phone);
      if (!isValidPhone(normalized)) {
        return fail(reply, "That number isn't complete enough to record consent against.");
      }
      try {
        await withTenantClient(args.tenant_id, (client) =>
          client.query(
            `INSERT INTO consent_records
               (tenant_id, customer_phone, consent_type, consent_given, consent_date,
                consent_method, consent_source)
             VALUES ($1, $2, 'sms', true, now(), 'verbal', $3)`,
            [args.tenant_id, normalized, args.call_id ? `voice_call:${args.call_id}` : 'voice_call']
          )
        );
      } catch (err) {
        // Best-effort: a DB hiccup must NOT 500 mid-call. Log the cause (a
        // systematically-failing consent write should be diagnosable — see
        // sad-path-instrumentation) and hand back a soft failure.
        reply.log.error({ err, tenant_id: args.tenant_id }, 'record-consent insert failed');
        return fail(reply, "I couldn't note that just now — your appointment is still all set.");
      }
      return ok(reply, { recorded: true, channel: 'sms', phone: normalized });
    },
    'Failed to record consent'
  );

  // save_customer_preference — persist a durable fact about a known caller into
  // the customer_preferences table (one row per customer+key; was a jsonb blob
  // on customers.metadata until 2026-07-12). The same rows get_customer_context_
  // for_call reads back on the next call, so this closes the write half of the
  // preference round-trip. No-ops gracefully (success shape with saved=false)
  // when the phone isn't a known customer yet, so the LLM relays "noted" without
  // a scary error mid-call.
  toolRoute(
    app,
    '/agent-tools/save-customer-preference',
    SaveCustomerPreferenceSchema,
    async (args, reply) => {
      const normalized = normalizePhone(args.phone);
      if (!isValidPhone(normalized)) {
        return fail(
          reply,
          "That phone number doesn't look complete enough to save a note against."
        );
      }
      // Normalize the key to a short stable slug so repeat saves of the same
      // concept ("preferred stylist" / "Preferred Stylist") collapse onto one
      // row (the PK is (customer_id, pref_key)) instead of accreting
      // near-duplicates.
      const key = args.key
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      if (!key) {
        return fail(reply, 'Preference name was empty after cleanup — nothing to save.');
      }

      const saved = await withTenantClient(args.tenant_id, async (client) => {
        // INSERT ... ON CONFLICT: re-saving a key UPDATES it in place and bumps
        // updated_at, so a preference carries how recently it was confirmed
        // (a 2-year-old "preferred stylist" is worth re-asking, not asserting).
        // The SELECT sub-query is the "known customer" gate — it yields no row
        // for an unknown or soft-deleted phone, so the INSERT writes nothing and
        // rowCount stays 0, which the caller reports as saved:false.
        const res = await client.query<{ customer_id: string }>(
          `INSERT INTO customer_preferences
                 (tenant_id, customer_id, pref_key, pref_value)
           SELECT c.tenant_id, c.customer_id, $3::text, $4::text
             FROM customers c
            WHERE c.tenant_id = $1 AND c.phone = $2
              AND (c.is_deleted IS NULL OR c.is_deleted = false)
           ON CONFLICT (customer_id, pref_key) DO UPDATE
                  SET pref_value = EXCLUDED.pref_value,
                      updated_at = now()
           RETURNING customer_id`,
          [args.tenant_id, normalized, key, args.value.trim()]
        );
        return (res.rowCount ?? 0) > 0;
      });

      if (!saved) {
        // Not an error — the caller just isn't a known customer yet. Tell the
        // LLM plainly so it doesn't read an alarming failure to the caller.
        return ok(reply, {
          saved: false,
          message: 'No existing customer for that number yet — preference not stored.',
        });
      }
      return ok(reply, { saved: true, key });
    },
    'Failed to save customer preference'
  );

  // identify_caller — upsert caller as a customer by phone. Creates the row
  // if unknown; updates name when the stored name is blank or "Valued Customer".
  // Called by the agent as soon as the caller gives their name, even without booking,
  // so every call leaves a contact record behind.
  //
  // THIS IS THE FORWARDED-LINE PREFERENCE LOAD. On a forwarded line (or a blocked
  // caller ID) the agent starts the call with callerPhone = null — both guards in
  // agent/src/index.ts null it, because the SIP caller-ID is the FORWARDING line,
  // not the customer. So the session-start prefetch (agent/src/customerContext.ts)
  // has nothing to key on and skips. The caller's real number only becomes known
  // when they say it out loud — which is exactly this call. So when the number
  // they gave MATCHES a customer we already have, this route hands back their
  // name, saved preferences, and recent history in the tool result, exactly as
  // the prefetch would have. The alternative — a prompt line asking the model to
  // please call get_customer_context afterwards — is the same "hope the LLM
  // fetches" weakness that made preferences write-only in the first place.
  // (2026-07-12)
  toolRoute(
    app,
    '/agent-tools/identify-caller',
    IdentifyCallerSchema,
    async (args, reply) => {
      const normalized = normalizePhone(args.phone);
      if (!isValidPhone(normalized)) {
        return fail(reply, 'Invalid phone number — cannot create contact.');
      }
      const context = await withTenantClient(args.tenant_id, async (client) => {
        // xmax = 0 is Postgres's "this tuple was INSERTed, not UPDATEd by the
        // ON CONFLICT branch" tell. It's how we know whether the number they just
        // gave us was already ours (a returning caller whose preferences we should
        // load) or brand new (nothing to load).
        const cust = await client.query<{ customer_id: string; is_new: boolean; name: string }>(
          // The placeholder list is SHARED (customerLookup.PLACEHOLDER_NAMES), not
          // inlined. This CASE used to hardcode only 'Valued Customer' — while
          // scheduling.ts writes 'Caller' on every nameless booking. So a caller who
          // booked before giving their name was stored as 'Caller', and when they
          // then gave their name this CASE did not match, so it was never
          // overwritten: "Caller" became permanent, and the session prefetch greeted
          // them as "Caller" on every future call. The 2026-07-12 bug, still live on
          // this path until 2026-07-13. A real name is never clobbered — only a
          // placeholder is.
          `INSERT INTO customers (tenant_id, phone, name)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, phone) DO UPDATE
             SET name = CASE
               WHEN customers.name IS NULL
                 OR customers.name = ''
                 OR customers.name = ANY($4::text[])
                 -- A CORRECTION to a name THIS CALL wrote (2026-08-01). Scoped
                 -- by the agent's host code, which sets the flag only after it
                 -- has already identified this caller on this call and the
                 -- caller then changed the answer. Without it a mishearing was
                 -- permanent: the tracker said Camille and the record said
                 -- Jamil, forever.
                 OR $5::boolean IS TRUE
               THEN EXCLUDED.name
               ELSE customers.name
             END
           RETURNING customer_id, (xmax = 0) AS is_new, name`,
          [
            args.tenant_id,
            normalized,
            args.name ?? null,
            PLACEHOLDER_NAMES as unknown as string[],
            args.is_correction === true && Boolean(args.name),
          ]
        );
        // Backfill the verbally-captured number + customer onto the live call row
        // so the Calls tab shows it (forwarded-line calls started caller_phone
        // null). Best-effort: only the active row for this call; never fatal —
        // a backfill failure (RLS/FK/transient) must not fail the contact save,
        // which is the whole point of identify_caller. COALESCE keeps any
        // existing customer_id rather than nulling it if the upsert RETURNING
        // unexpectedly yielded no row.
        if (args.call_id) {
          try {
            await client.query(
              `UPDATE voice_sessions
                 SET caller_phone = $3,
                     customer_id = COALESCE($4, customer_id),
                     updated_at = now()
               WHERE tenant_id = $1 AND call_id = $2 AND status = 'active'`,
              [args.tenant_id, args.call_id, normalized, cust.rows[0]?.customer_id ?? null]
            );
          } catch (err) {
            app.log.warn(
              { tenantId: args.tenant_id, callId: args.call_id, ...pgErrorFields(err) },
              'identify_caller: voice_sessions backfill failed — contact saved, call row not updated'
            );
          }
        }

        const row = cust.rows[0];
        // Brand-new contact: nothing to recall, and saying "welcome back" to a
        // first-time caller is worse than saying nothing.
        if (!row || row.is_new) return null;

        // THE GATE. Known customer, but who says this is them? Contact is
        // already saved above (writing is not leaking); disclosure is what we
        // withhold. See callerMayHearCustomerData.
        const mayDisclose = await callerMayHearCustomerData(client, app, {
          tenantId: args.tenant_id,
          phone: normalized,
          phoneSource: args.phone_source,
          callId: args.call_id,
          route: 'identify-caller',
        });
        if (!mayDisclose) {
          return { requiresVerification: true as const };
        }

        const prefs = await client.query<{ preferences: Record<string, unknown> }>(
          `SELECT COALESCE(
                    (SELECT jsonb_object_agg(cp.pref_key, cp.pref_value)
                       FROM customer_preferences cp
                      WHERE cp.customer_id = $1 AND cp.tenant_id = $2),
                    '{}'::jsonb
                  ) AS preferences`,
          [row.customer_id, args.tenant_id]
        );
        const sums = await client.query<{ summary: string }>(
          `SELECT summary FROM voice_sessions
            WHERE tenant_id = $1 AND customer_id = $2
              AND summary IS NOT NULL
              AND (is_deleted IS NULL OR is_deleted = false)
            ORDER BY started_at DESC
            LIMIT 3`,
          [args.tenant_id, row.customer_id]
        );

        const preferences = prefs.rows[0]?.preferences ?? {};
        const history = sums.rows.map((s) => s.summary).join('; ');

        // Did they already agree to be texted? Durable — see hasSmsConsent.
        const smsConsent = await hasSmsConsent(client, args.tenant_id, normalized);

        // A returning row with nothing on it is, to the caller, indistinguishable
        // from a new one — don't announce familiarity we can't back up.
        //
        // But consent still rides along. Someone can have said "yes, text me"
        // without ever leaving a preference or a call summary, and re-asking them
        // is the exact pestering this change exists to stop. `returning_customer`
        // governs what the agent SAYS OUT LOUD; `sms_consent` governs what it must
        // not ask again. Different questions.
        if (Object.keys(preferences).length === 0 && !history) {
          return { thin: true as const, smsConsent };
        }

        return { name: row.name || 'Unknown', preferences, history, smsConsent };
      });

      if (!context) return ok(reply, { saved: true, returning_customer: false });

      if ('thin' in context) {
        return ok(reply, {
          saved: true,
          returning_customer: false,
          sms_consent: context.smsConsent,
        });
      }

      // Known customer, but the number was only CLAIMED and hasn't been proven.
      // Tell the agent to verify — and tell it NOTHING about who this is. Not the
      // name, not a hint. "We may know you, prove it" leaks nothing; "Welcome back,
      // Camille — just verify" would already have leaked her name to a stranger.
      if ('requiresVerification' in context) {
        return ok(reply, {
          saved: true,
          returning_customer: false,
          requires_verification: true,
          message:
            "Before I can pull up an account for that number, I need to verify it's yours — I'll text a 4-digit code for you to read back.",
        });
      }

      return ok(reply, {
        saved: true,
        returning_customer: true,
        name: context.name,
        preferences: context.preferences,
        history: context.history || 'No history',
        // TRUE = they already agreed to appointment texts and have not revoked.
        // The agent must NOT run the permission script again — see prompt.ts
        // "Text reminders". Consent is durable (TCPA: prior express consent
        // persists until revoked), and asking a customer to re-consent on every
        // call, immediately after greeting them by name, makes the AI sound like
        // it doesn't actually remember them.
        //
        // This rides INSIDE the disclosure gate on purpose: telling an unverified
        // caller "you're already signed up for texts" would confirm that the
        // number belongs to a real customer — a small existence oracle, and the
        // gate exists precisely to close those.
        sms_consent: context.smsConsent,
      });
    },
    'Failed to identify caller'
  );

  // get_customer_context — look up caller by phone, return name + recent
  // call summaries so the agent can greet returning customers with context.
  toolRoute(
    app,
    '/agent-tools/customer-context',
    GetContextSchema,
    async (args, reply) => {
      const normalized = normalizePhone(args.phone);
      if (!normalized) {
        return ok(reply, 'New caller - no history found.');
      }

      const data = await withTenantClient(args.tenant_id, async (client) => {
        const cust = await client.query<{
          customer_id: string;
          name: string;
          preferences: Record<string, unknown> | null;
        }>(
          // Preferences are aggregated back into the same {key: value} object
          // the LLM has always seen — the storage moved to customer_preferences
          // (2026-07-12) but the wire shape did not, so the agent, the prompt
          // prefetch, and the dashboard are all unaffected.
          `SELECT c.customer_id, c.name,
                  COALESCE(
                    (SELECT jsonb_object_agg(cp.pref_key, cp.pref_value)
                       FROM customer_preferences cp
                      WHERE cp.customer_id = c.customer_id
                        AND cp.tenant_id = c.tenant_id),
                    '{}'::jsonb
                  ) AS preferences
          FROM customers c
          WHERE c.tenant_id = $1 AND c.phone = $2
            AND (c.is_deleted IS NULL OR c.is_deleted = false)`,
          [args.tenant_id, normalized]
        );
        // No such customer — nothing to disclose, so nothing to gate. Answering
        // "new caller" here is what lets a genuine first-time caller on a
        // FORWARDED line (no caller-ID, so their number is always 'spoken') get
        // through without being challenged for a code they have no reason to
        // expect. Gate only what we would actually reveal — same shape as
        // identify_caller, which gates after `is_new`.
        if (cust.rows.length === 0) return null;

        const customer = cust.rows[0];

        // THE GATE — a real person's name + preferences are below this line, and
        // the LLM chose the phone number we looked up. See callerMayHearCustomerData.
        const mayDisclose = await callerMayHearCustomerData(client, app, {
          tenantId: args.tenant_id,
          phone: normalized,
          phoneSource: args.phone_source,
          callId: args.call_id,
          route: 'customer-context',
        });
        if (!mayDisclose) return 'BLOCKED' as const;

        const sums = await client.query<{ summary: string }>(
          `SELECT summary FROM call_summaries
          WHERE customer_id = $1
          ORDER BY created_at DESC
          LIMIT 3`,
          [customer.customer_id]
        );
        // Upcoming appointments — INSIDE the gate, same as name/preferences
        // (an appointment reveals a person's schedule; it is the most sensitive
        // fact on this route). 2026-07-27 (CALL_IMPROVEMENTS.md #8): a caller
        // WITH a live 2:30 appointment was told "you don't have a booked time
        // on file" — the row existed, phone-linked, and the model was never
        // told. This is how the model gets told, on every call, before the
        // first word.
        const upcoming = await client.query<{ start_time: Date | string; service: string | null }>(
          `SELECT a.start_time, s.name AS service
             FROM appointments a
             LEFT JOIN services s ON s.service_id = a.service_id AND s.tenant_id = a.tenant_id
            WHERE a.tenant_id = $1 AND a.customer_id = $2
              AND a.status = 'scheduled' AND a.start_time > NOW()
              AND (a.is_deleted IS NULL OR a.is_deleted = false)
            ORDER BY a.start_time ASC
            LIMIT 3`,
          [args.tenant_id, customer.customer_id]
        );
        const smsConsent = await hasSmsConsent(client, args.tenant_id, normalized);
        return { customer, summaries: sums.rows, smsConsent, upcoming: upcoming.rows };
      });

      // Blocked, not absent. Say so plainly, and tell the LLM the way forward —
      // if we pretended "no history found" the agent would confidently treat a
      // returning customer as a stranger and never think to verify.
      if (data === 'BLOCKED') {
        return ok(reply, {
          requires_verification: true,
          message:
            'This number was given verbally and has not been verified on this call. Use send_verification_code, have the caller read the code back, then verify_phone_code before looking them up.',
        });
      }
      if (!data) return ok(reply, 'New caller - no history found.');
      return ok(reply, {
        name: data.customer.name || 'Unknown',
        // Already agreed to appointment texts? Then do NOT ask again — consent is
        // durable until revoked. Inside the gate: see the note on identify-caller.
        sms_consent: data.smsConsent,
        history: data.summaries.map((s) => s.summary).join('; ') || 'No history',
        // Saved customer preferences (preferred staff, last service, likes)
        // captured by save_customer_preference. THIS is how they reach the
        // LLM on the next call — the agent's get_customer_context tool reads
        // this route, so preferences must ride along here, not only in the
        // dashboard's get_customer_context_for_call path. Default {} when none.
        preferences: data.customer.preferences ?? {},
        // Next 3 scheduled appointments (ISO start_time + service name) — the
        // agent bakes them into the prompt header so the model can never deny
        // a booking the DB holds (#8).
        upcoming_appointments: data.upcoming.map((a) => ({
          start_time: a.start_time instanceof Date ? a.start_time.toISOString() : a.start_time,
          service: a.service,
        })),
      });
    },
    'Failed to fetch customer context'
  );

  // find-customer-by-name — name-first caller identification. The agent asks
  // the caller's name, looks them up by it, and (when found) reads back the
  // stored number to confirm "is this still your number?". Needed because the
  // inbound line is forwarded — caller ID is the forwarding cell, not the
  // caller — so name is the only identifier we can trust on first contact.
  // Returns up to 5 matches (name + phone) so the agent can confirm or, if the
  // number is stale/wrong, collect a new one and create a fresh entry.
  toolRoute(
    app,
    '/agent-tools/find-customer-by-name',
    FindByNameSchema,
    async (args, reply) => {
      const trimmed = args.name.trim();
      if (!trimmed) {
        return ok(reply, { matches: [] });
      }
      if (trimmed.length < 4) {
        return ok(reply, { matches: [] });
      }
      // Escape LIKE metacharacters so a spoken/transcribed name containing
      // `%` or `_` matches literally instead of acting as a wildcard — an
      // unescaped `%` would ILIKE-match the tenant's entire address book and
      // over-disclose names+phones (found 2026-07-01 by the real-DB companion
      // test; see docs/TEST_DB_AUDIT.md). Backslash is Postgres's default
      // LIKE escape character.
      const likeTerm = trimmed.replace(/([\\%_])/g, '\\$1');

      const matches = await withTenantClient(args.tenant_id, async (client) => {
        const res = await client.query<{ name: string | null; phone: string | null }>(
          // Derive a display name from first/last when the `name` column is
          // empty (common for imported rows) so a real match never surfaces as
          // "Unknown" to the agent.
          `SELECT COALESCE(
                    NULLIF(name, ''),
                    NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '')
                  ) AS name,
                  phone
             FROM customers
            WHERE tenant_id = $1
              AND (is_deleted IS NULL OR is_deleted = false)
              AND (
                name ILIKE '%' || $2 || '%'
                OR TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) ILIKE '%' || $2 || '%'
              )
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 5`,
          [args.tenant_id, likeTerm]
        );
        return res.rows;
      });

      // Shape kept LLM-friendly: a plain list of {name, phone}. Empty list =
      // no match → the agent treats them as a new caller.
      return ok(reply, {
        matches: matches.map((m) => ({
          name: m.name || 'Unknown',
          phone: maskPhoneForConfirmation(m.phone),
        })),
      });
    },
    'Failed to search customers by name'
  );

  // customer-history — deeper history than customer-context: last ~10
  // appointments (ANY status — past + upcoming, with service/employee/date/
  // status), the saved preferences map, and the last ~3 post-call summaries
  // from voice_sessions.
  //
  // This used to say the phone was "server-injected by the agent ... so the LLM
  // can never enumerate another caller's history". That was never a property of
  // THIS code — the route accepts whatever phone it is handed. It was a promise
  // about the CALLER (agent/src/tools.ts), enforced nowhere, one prompt change
  // away from being false. It is enforced here now.
  toolRoute(
    app,
    '/agent-tools/customer-history',
    CustomerHistorySchema,
    async (args, reply) => {
      const normalized = normalizePhone(args.phone);
      if (!normalized) {
        return ok(reply, 'New caller - no history found.');
      }

      const data = await withTenantClient(args.tenant_id, async (client) => {
        const cust = await client.query<{
          customer_id: string;
          name: string;
          preferences: Record<string, unknown> | null;
        }>(
          // Same {key: value} aggregation as customer-context — see the note there.
          `SELECT c.customer_id, c.name,
                  COALESCE(
                    (SELECT jsonb_object_agg(cp.pref_key, cp.pref_value)
                       FROM customer_preferences cp
                      WHERE cp.customer_id = c.customer_id
                        AND cp.tenant_id = c.tenant_id),
                    '{}'::jsonb
                  ) AS preferences
           FROM customers c
           WHERE c.tenant_id = $1 AND c.phone = $2
             AND (c.is_deleted IS NULL OR c.is_deleted = false)`,
          [args.tenant_id, normalized]
        );
        // Unknown number — nothing to reveal, nothing to gate. (See the same
        // note in customer-context.)
        if (cust.rows.length === 0) return null;
        const customer = cust.rows[0];

        // THE GATE — appointments, preferences and past call summaries follow.
        const mayDisclose = await callerMayHearCustomerData(client, app, {
          tenantId: args.tenant_id,
          phone: normalized,
          phoneSource: args.phone_source,
          callId: args.call_id,
          route: 'customer-history',
        });
        if (!mayDisclose) return 'BLOCKED' as const;

        const appts = await client.query<{
          start_time: string;
          status: string;
          description: string | null;
          service_name: string | null;
          employee_name: string | null;
        }>(
          `SELECT a.start_time, a.status, a.description,
                  s.name AS service_name,
                  e.name AS employee_name
           FROM appointments a
           LEFT JOIN services s ON a.service_id = s.service_id AND s.tenant_id = a.tenant_id
           LEFT JOIN employees e ON a.employee_id = e.employee_id AND e.tenant_id = a.tenant_id
           WHERE a.tenant_id = $1 AND a.customer_id = $2
             AND (a.is_deleted IS NULL OR a.is_deleted = false)
           ORDER BY a.start_time DESC
           LIMIT 10`,
          [args.tenant_id, customer.customer_id]
        );

        // Post-call summaries live on voice_sessions.summary (written by the
        // agent's callSummary at finalize). Match by customer_id OR the raw
        // phone — forwarded-line calls may have caller_phone backfilled but no
        // customer link (or vice versa).
        const sums = await client.query<{ summary: string; started_at: string }>(
          `SELECT summary, started_at
           FROM voice_sessions
           WHERE tenant_id = $1
             AND (customer_id = $2 OR caller_phone = $3)
             AND summary IS NOT NULL
             AND (is_deleted IS NULL OR is_deleted = false)
           ORDER BY started_at DESC
           LIMIT 3`,
          [args.tenant_id, customer.customer_id, normalized]
        );

        return { customer, appointments: appts.rows, summaries: sums.rows };
      });

      if (data === 'BLOCKED') {
        return ok(reply, {
          requires_verification: true,
          message:
            'This number was given verbally and has not been verified on this call. Use send_verification_code, have the caller read the code back, then verify_phone_code before looking them up.',
        });
      }
      if (!data) return ok(reply, 'New caller - no history found.');
      return ok(reply, {
        name: data.customer.name || 'Unknown',
        preferences: data.customer.preferences ?? {},
        appointments: data.appointments,
        recent_call_summaries: data.summaries,
      });
    },
    'Failed to fetch customer history'
  );

  // send_verification_code — used when caller-ID is blocked/garbled/missing
  // and the caller has verbally provided a phone. Generate a 4-digit code,
  // bcrypt-hash it, store with 10-min TTL, SMS it via Telnyx. Rate-limited
  // to prevent this becoming a free SMS-spam relay.
  toolRoute(
    app,
    '/agent-tools/send-verification-code',
    SendVerificationCodeSchema,
    async (args, reply) => {
      if (!isValidPhone(args.phone)) {
        return fail(
          reply,
          "I couldn't quite catch that number — could you say it again, starting with the area code?"
        );
      }
      const normalized = normalizePhone(args.phone)!;

      // Load tenant's SMS sender phone (inbound_phone doubles as outbound
      // sender since Telnyx numbers are bidirectional).
      const smsOutcome = await withTenantClient(args.tenant_id, async (client) => {
        const tz = await client.query<{ inbound_phone: string | null }>(
          `SELECT inbound_phone FROM tenants WHERE tenant_id = $1`,
          [args.tenant_id]
        );
        const fromPhone = tz.rows[0]?.inbound_phone;
        if (!fromPhone) {
          return { kind: 'no_sender' as const };
        }

        // Rate limit: sends to this phone in the last hour.
        const perPhone = await client.query<{ c: string }>(
          `SELECT COUNT(*)::text AS c
           FROM phone_verifications
          WHERE tenant_id = $1 AND phone = $2
            AND created_at > now() - interval '1 hour'`,
          [args.tenant_id, normalized]
        );
        if (parseInt(perPhone.rows[0].c, 10) >= RATE_LIMIT_PER_PHONE_PER_HOUR) {
          return { kind: 'rate_limited_phone' as const };
        }

        // Rate limit: sends from this tenant in the last 24h.
        const perTenant = await client.query<{ c: string }>(
          `SELECT COUNT(*)::text AS c
           FROM phone_verifications
          WHERE tenant_id = $1
            AND created_at > now() - interval '24 hours'`,
          [args.tenant_id]
        );
        if (parseInt(perTenant.rows[0].c, 10) >= RATE_LIMIT_PER_TENANT_PER_DAY) {
          return { kind: 'rate_limited_tenant' as const };
        }

        // Brute-force cap that a resend CANNOT reset. The per-row
        // MAX_VERIFY_ATTEMPTS was defeated by simply asking for a new code
        // (fresh row, attempt_count = 0, three more guesses, forever). Count
        // wrong guesses across EVERY code issued to this number in the last hour.
        const attempts = await client.query<{ total: string }>(
          `SELECT COALESCE(SUM(attempt_count), 0)::text AS total
             FROM phone_verifications
            WHERE tenant_id = $1 AND phone = $2
              AND created_at > now() - interval '1 hour'`,
          [args.tenant_id, normalized]
        );
        if (parseInt(attempts.rows[0].total, 10) >= MAX_VERIFY_ATTEMPTS_PER_PHONE_PER_HOUR) {
          return { kind: 'locked_out' as const };
        }

        // ONE live code per phone. Issuing a code used to leave every previous
        // one valid, so each guess was tested against a growing set of correct
        // answers — the keyspace shrank with every resend, precisely inverting
        // what the rate limit was meant to buy. Retire the old ones first.
        await client.query(
          `UPDATE phone_verifications
              SET expires_at = now()
            WHERE tenant_id = $1 AND phone = $2
              AND verified_at IS NULL AND expires_at > now()`,
          [args.tenant_id, normalized]
        );

        // Generate + hash + insert. bcrypt cost 10 matches auth routes.
        const code = generateVerificationCode(CODE_DIGITS);
        const bcrypt = await import('bcrypt');
        const codeHash = await bcrypt.hash(code, 10);
        await client.query(
          // call_id binds the proof to THIS call. A code proves you held the
          // handset at a moment; it does not make the number yours for a day.
          // See migration 20260714000000.
          `INSERT INTO phone_verifications (tenant_id, phone, code_hash, expires_at, call_id)
           VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, $5)`,
          [args.tenant_id, normalized, codeHash, String(CODE_TTL_MINUTES), args.call_id ?? null]
        );
        return { kind: 'inserted' as const, code, fromPhone };
      });

      if (smsOutcome.kind === 'no_sender') {
        return fail(
          reply,
          "I'm sorry — I can't send a text from this line right now. Let me take your information another way."
        );
      }
      if (smsOutcome.kind === 'rate_limited_phone') {
        return fail(
          reply,
          "I've already sent a few codes to that number recently. Let me take a message instead and have someone call you back."
        );
      }
      if (smsOutcome.kind === 'locked_out') {
        // Too many WRONG guesses against this number in the last hour, across
        // every code we issued. Refusing to send another is the point: sending
        // one would hand the guesser three more tries and text the real owner's
        // handset again. Same wording as the rate limit — a caller who fumbled
        // and a caller who is grinding get the same, unhelpful answer.
        errorsTotal.inc({ event: 'otp_phone_locked_out' });
        app.log.warn(
          {
            event: 'otp_phone_locked_out',
            reason: `>= ${MAX_VERIFY_ATTEMPTS_PER_PHONE_PER_HOUR} failed code attempts against this number in the last hour`,
            tenant_id: args.tenant_id,
            call_id: args.call_id ?? null,
          },
          'OTP: phone locked out after repeated wrong codes — refusing to issue another'
        );
        return fail(
          reply,
          "I've already sent a few codes to that number recently. Let me take a message instead and have someone call you back."
        );
      }
      if (smsOutcome.kind === 'rate_limited_tenant') {
        return fail(
          reply,
          "I can't send another verification text right now. Let me take a message instead."
        );
      }

      const sms = await sendSms({
        from: smsOutcome.fromPhone,
        to: normalized,
        body: `Your SecretaryHQ verification code is: ${smsOutcome.code}. Reply STOP to opt out.`,
      });
      if (!sms.ok) {
        app.log.warn(
          { event: 'otp_sms_send_failed', error: sms.error, status: sms.status },
          'Telnyx SMS send failed'
        );
        return fail(
          reply,
          'I had trouble sending that text. Could you try saying the number again, or we can take a message instead.'
        );
      }

      return ok(reply, {
        sent: true,
        phone: normalized,
        message:
          'I just sent you a text with a short code. When it comes through, just read it back to me.',
      });
    },
    'Failed to send verification code'
  );

  // verify_phone_code — compare caller-spoken code against the stored hash.
  // On success, marks the row verified. On failure, increments attempt
  // count and refuses further tries once we hit MAX_VERIFY_ATTEMPTS so a
  // stolen phone number can't be brute-forced over a long call.
  toolRoute(
    app,
    '/agent-tools/verify-phone-code',
    VerifyPhoneCodeSchema,
    async (args, reply) => {
      if (!isValidPhone(args.phone)) {
        return fail(reply, "That doesn't look like a valid number — could you say it again?");
      }
      const normalized = normalizePhone(args.phone)!;

      const result = await withTenantClient(args.tenant_id, async (client) => {
        // Most recent unverified row for this phone.
        const row = await client.query<{
          phone_verification_id: string;
          code_hash: string;
          expires_at: string;
          attempt_count: number;
        }>(
          // Scoped to THIS call: a code issued on an earlier call cannot be
          // redeemed on a new one, so overhearing a code buys nothing later.
          // (A NULL call_id matches only a NULL call_id — non-voice callers.)
          `SELECT phone_verification_id, code_hash, expires_at, attempt_count
           FROM phone_verifications
          WHERE tenant_id = $1 AND phone = $2 AND verified_at IS NULL
            AND call_id IS NOT DISTINCT FROM $3
          ORDER BY created_at DESC
          LIMIT 1`,
          [args.tenant_id, normalized, args.call_id ?? null]
        );
        if (row.rows.length === 0) {
          return { kind: 'no_pending' as const };
        }
        const v = row.rows[0];
        if (new Date(v.expires_at).getTime() < Date.now()) {
          return { kind: 'expired' as const };
        }
        if (v.attempt_count >= MAX_VERIFY_ATTEMPTS) {
          return { kind: 'too_many_attempts' as const };
        }

        const bcrypt = await import('bcrypt');
        const match = await bcrypt.compare(args.code, v.code_hash);
        if (match) {
          await client.query(
            `UPDATE phone_verifications SET verified_at = now() WHERE phone_verification_id = $1`,
            [v.phone_verification_id]
          );
          return { kind: 'verified' as const };
        }

        await client.query(
          `UPDATE phone_verifications SET attempt_count = attempt_count + 1 WHERE phone_verification_id = $1`,
          [v.phone_verification_id]
        );
        const remaining = MAX_VERIFY_ATTEMPTS - (v.attempt_count + 1);
        return { kind: 'wrong' as const, remaining };
      });

      if (result.kind === 'verified') {
        return ok(reply, { verified: true, phone: normalized });
      }
      if (result.kind === 'no_pending') {
        return fail(
          reply,
          "I don't have a pending code for that number. Would you like me to send a new one?"
        );
      }
      if (result.kind === 'expired') {
        return fail(reply, "That code has expired. I can send you a new one if you'd like.");
      }
      if (result.kind === 'too_many_attempts') {
        return fail(
          reply,
          "We've tried that a few times without luck. Let me take a message and have someone follow up with you."
        );
      }
      // wrong
      if (result.remaining <= 0) {
        return fail(
          reply,
          "That didn't match, and we've used our tries. Let me take a message instead."
        );
      }
      return fail(
        reply,
        `That didn't quite match — could you read the code again? You have ${result.remaining} ${result.remaining === 1 ? 'try' : 'tries'} left.`
      );
    },
    'Failed to verify phone code'
  );
}
