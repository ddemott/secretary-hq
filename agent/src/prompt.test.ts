/**
 * Tests for the system prompt builder. These assert on CONTENT the prompt
 * must contain, not exact wording — we don't want a reword to break the
 * test, but we do want regressions on critical behavior to get caught.
 */
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, formatDateForPrompt, formatTimeForPrompt } from './prompt.js';

const BASE_CTX = {
  tenantName: 'DynaTire',
  callerPhone: '+15551234567',
  currentDate: 'Friday, April 24, 2026',
  currentTime: '3:00 PM',
  timezone: 'America/Chicago',
};

describe('buildSystemPrompt', () => {
  it('HAPPY: injects tenant name and current date into the prompt', () => {
    // WHO: LiveKit agent boots a session for DynaTire
    // WHAT: The date-of-the-call + tenant-name must be present verbatim
    //        so the LLM has fresh context — BUG-061 was a stale date
    //        baked into the old Vapi prompt and we never recover that
    //        class of bug quietly
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain('DynaTire');
    expect(prompt).toContain('Friday, April 24, 2026');
    expect(prompt).toContain('America/Chicago');
  });

  it('HAPPY: an owner-set personaName injects an authoritative "Your name is X" line', () => {
    // WHO: an owner who set the Assistant Name to "Chris" on Business Settings.
    // WHAT: the prompt must prepend a "Your name is Chris" directive that
    //        overrides any name baked into the custom prompt text.
    // WHEN: every session for a tenant with persona_name set.
    // WHERE: buildSystemPrompt identity section.
    // WHY: the name lived only inside system_prompt free text before — a client
    //        couldn't change it without editing the raw prompt.
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      personaName: 'Chris',
      customPrompt: 'You are Beth, the assistant.',
    });
    expect(prompt).toMatch(/Your name is Chris/);
    expect(prompt).toMatch(/introduce yourself as Chris/i);
  });

  it('SAD: no personaName → no name directive (prior behavior preserved)', () => {
    // WHO: a tenant that never set an assistant name.
    // WHAT: the prompt must NOT contain a "Your name is" directive — identity
    //        stays exactly the base/custom prompt.
    const prompt = buildSystemPrompt({ ...BASE_CTX, personaName: null });
    expect(prompt).not.toMatch(/Your name is/);
  });

  it('HAPPY: instructs the agent to offer the service menu, not ask blind', () => {
    // WHO: Caller wants to book but __PERSONA_NAME__ previously asked "what service?"
    //       without listing the options, so the caller couldn't answer.
    // WHAT: The prompt must tell the agent to call get_service_catalog FIRST
    //        and read the real options back, plus offer to take a message.
    // WHY: An open-ended "which service?" with no menu is a dead end — the
    //        caller can't guess what's on offer. Fix lives in the prompt.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain('get_service_catalog');
    expect(prompt).toMatch(/never ask an open-ended/i);
    expect(prompt).toMatch(/take a message/i);
  });

  it('HAPPY: forbids re-checking/re-announcing a slot the caller already picked', () => {
    // WHO: Caller picked 1PM from the offered slots and confirmed it, but the
    //       agent said "let me check availability", re-listed the same slots, and
    //       re-asked for confirmation before booking.
    // WHAT: The prompt must tell the agent that a picked slot is already
    //        available — no re-check, no re-announce, no second confirmation —
    //        go straight to book_with_scheduling with one confirmation.
    // WHEN: real call 2026-07-01; asserted at prompt-build time.
    // WHERE: buildSystemPrompt booking-flow section (step 4).
    // WHY: repeating what the caller just chose sounds like it wasn't listening.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toMatch(/already have availability/i);
    expect(prompt).toMatch(/do NOT re-check/i);
    expect(prompt).toMatch(/book_with_scheduling/);
  });

  it('HAPPY: instructs the agent to read back a phone number + never go silent on partial input', () => {
    // WHO: a caller whose spoken number came through partial (STT split/dropped
    //       digits), e.g. only 6 of 10 captured.
    // WHAT: the prompt must tell the agent to read the number back, ask for the
    //        missing digits when it has fewer than 10, and ALWAYS respond rather
    //        than wait silently.
    // WHY: __PERSONA_NAME__ was stalling after an incomplete number (dead air = "frozen
    //        call"). The fix is prompt guidance to confirm/re-prompt, never hang.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toMatch(/read it back|read back/i);
    expect(prompt).toMatch(/10 digits/i);
    expect(prompt).toMatch(/never (go silent|leave dead air)/i);
    // partial-number recovery: ask for the rest, don't stall
    expect(prompt).toMatch(/fewer than 10|the rest|only caught/i);
    // an 11-digit "1-..." must not be treated as incomplete
    expect(prompt).toMatch(/leading 1 or \+1|country code/i);
  });

  it('HAPPY: caller-ID present → includes the phone with a verified-by-caller-ID note', () => {
    // WHO: Normal inbound call, caller-ID came through clean
    // WHAT: Prompt tells the LLM the phone is trusted so it can skip
    //        OTP and book directly when the caller asks
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain('+15551234567');
    expect(prompt).toContain('verified by caller ID');
    // WHY: The OTP script should NOT be the default path — only for
    //       anonymous callers. Prompt must not pre-require verification.
    expect(prompt).not.toContain('You MUST collect and verify');
  });

  it('HAPPY: anonymous caller → MUST-verify language is present', () => {
    // WHO: Caller with blocked/withheld caller-ID
    // WHAT: Prompt explicitly instructs the LLM to collect and OTP-verify
    //        a phone before any booking. Without this, the LLM might try
    //        to book with an empty phone and hit the gate confusingly.
    const prompt = buildSystemPrompt({ ...BASE_CTX, callerPhone: null });
    expect(prompt).toContain("do NOT have the caller's number");
    expect(prompt).toContain('MUST collect and verify');
  });

  it('HAPPY: phone verification section documents the OTP turn order', () => {
    // WHY: The LLM has to know the EXACT sequence (send code, read
    //       message, wait for caller to speak code, verify). If the
    //       section disappears in a refactor, the OTP feature is
    //       effectively dead even though the backend routes are live.
    const prompt = buildSystemPrompt({ ...BASE_CTX, callerPhone: null });
    expect(prompt).toContain('send_verification_code');
    expect(prompt).toContain('verify_phone_code');
    expect(prompt).toMatch(/VERBATIM/);
  });

  it('HAPPY: booking-error-code translations are documented', () => {
    // WHY: The backend returns error_code values (TIMESLOT_OCCUPIED,
    //        NO_SKILLED_EMPLOYEE, etc.) and the LLM must translate them
    //        to human speech. If the prompt drops these mappings, the
    //        agent starts saying "error code TIMESLOT_OCCUPIED" to
    //        callers — which has happened with prior prompt regressions.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain('TIMESLOT_OCCUPIED');
    expect(prompt).toContain('NO_SKILLED_EMPLOYEE');
    expect(prompt).toContain('EMPLOYEE_NOT_SCHEDULED');
    expect(prompt).toContain('NO_AVAILABILITY');
  });

  it('HAPPY: infrastructure-error guidance is documented (no raw technical text to callers)', () => {
    // WHY: 2026-05-21 — domain error codes had a translation table but
    //        INFRASTRUCTURE failures (a backend 500 / tool timeout) did not.
    //        The LLM would receive raw "Backend returned 500" / "timed out"
    //        text with no instruction and could read it aloud or improvise.
    //        This pins the technical-glitch section so a future prompt edit
    //        can't silently drop graceful recovery and re-expose callers to
    //        raw error strings (or dead air).
    const prompt = buildSystemPrompt(BASE_CTX);
    // The section names the technical signatures it must NOT speak aloud...
    expect(prompt).toContain('Backend returned 500');
    expect(prompt).toContain('timed out');
    // ...and instructs graceful, in-character recovery instead.
    expect(prompt).toContain('NEVER read the technical error text aloud');
    expect(prompt.toLowerCase()).toContain('take your name and number');
  });

  it('HAPPY: mentions the core tools by name so the LLM knows its toolkit', () => {
    // WHY: If a tool name drifts here vs. the tool registry, the LLM
    //        may invoke the wrong name and the router 404s. Listing
    //        every tool in the prompt keeps this aligned.
    const prompt = buildSystemPrompt(BASE_CTX);
    for (const toolName of [
      'get_customer_context',
      'get_detailed_customer_history',
      'get_service_catalog',
      'get_available_slots',
      'get_scheduling_options',
      'check_availability',
      'book_appointment',
      'book_with_scheduling',
      'get_company_policy_answer',
      'send_verification_code',
      'verify_phone_code',
      'transfer_call',
      'send_self_service_link',
      'page_owner_via_sms',
    ]) {
      expect(prompt).toContain(toolName);
    }
  });

  it('HAPPY: cancel/reschedule flow proactively offers the self-service text link', () => {
    // WHO: caller who wants to cancel or reschedule an existing appointment.
    // WHAT: the prompt instructs the agent to OFFER texting a self-service
    //        link before doing the change live (GAPS.md "next-level voice
    //        tools" — link-first instead of always live).
    // WHERE: "# Canceling and rescheduling" step 3.
    // WHY: many callers prefer handling it themselves; the offer must be a
    //       scripted step or the model will never volunteer it.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain('PROACTIVELY offer the self-service option');
    expect(prompt).toContain('send_self_service_link(appointment_id)');
  });

  it('HAPPY: urgent-page section mandates the one-page-per-call rule and the message fallback', () => {
    // WHO: caller with a genuinely urgent matter for the owner.
    // WHAT: the "# Urgent matters" section exists, limits paging to once per
    //        call, and steers failures to take_message (never retry loops).
    // WHY: the tool enforces the guard structurally, but the prompt must say
    //       it too or the model narrates failed retries at the caller.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain('# Urgent matters');
    expect(prompt).toContain('AT MOST ONCE per call');
    expect(prompt).toMatch(/take a message instead/i);
  });

  it('SAD: prompt forbids markdown and "as an AI" filler', () => {
    // WHY: Prior Vapi calls surfaced markdown bullet points spoken
    //        aloud (the TTS said "dash, tire rotation, dash, oil
    //        change..."). Prompt must explicitly reject that.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toMatch(/no markdown/i);
    expect(prompt).toMatch(/no.*formatting/i);
    expect(prompt).toMatch(/no.*disclaimers/i);
  });

  it('HAPPY: availability-discipline section requires checking BEFORE booking', () => {
    // WHO: voice agent picking up a call where the caller wants to book
    // WHAT: prompt explicitly establishes that availability tools must
    //        run BEFORE booking tools, not in parallel and not skipped
    // WHEN: every booking conversation
    // WHERE: # Availability discipline section
    // WHY: pre-fix the agent would sometimes call book_appointment with
    //        a time it guessed from context — backend rejects with
    //        NO_AVAILABILITY, awkward "actually that's taken" follow-up
    //        on the phone. Prompt now mandates the check-first flow.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toMatch(/Availability discipline/i);
    // Both check-availability tools called out as the gate before booking.
    expect(prompt).toMatch(/get_available_slots[\s\S]*get_scheduling_options[\s\S]*FIRST/i);
    // Sequence is explicit — caller asks → check → propose → book.
    expect(prompt).toMatch(/before.*booking|check.*before.*book/i);
  });

  it('HAPPY: next_available alternatives section instructs the agent to propose them aloud', () => {
    // WHO: agent that just called book_with_scheduling and got
    //        NO_AVAILABILITY back (or TIMESLOT_OCCUPIED), but the
    //        response included a next_available array
    // WHAT: prompt tells the agent to read those alternatives to the
    //        caller verbally instead of asking "what other time?"
    // WHEN: any failed booking attempt where alternatives are present
    // WHERE: # When a booking response includes next_available section
    // WHY: shipping the next_available data plumbing (commits e2cf4a9 +
    //        ba8cc43) provides the alternatives, but without prompt
    //        guidance the agent ignores the array and falls back to the
    //        old "want to pick another time?" line — feature has zero
    //        runtime impact until this section exists.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toMatch(/next_available/);
    // Includes a concrete usage example — pre-formatted slot → spoken line.
    expect(prompt).toMatch(/employee_name/);
    // Empty-array fallback is documented so the agent knows when to
    // revert to the old "pick another time" behavior.
    expect(prompt).toMatch(/empty.*missing|missing.*empty/i);
  });

  it('HAPPY: NO_AVAILABILITY mapping references next_available rather than just "pick another time"', () => {
    // WHY: pin the explicit linkage between the error code and the
    //        alternatives surface — if a refactor breaks the mapping
    //        the agent reverts to the generic line and the new feature
    //        silently dies in production.
    const prompt = buildSystemPrompt(BASE_CTX);
    // The NO_AVAILABILITY mapping must reference next_available so the
    // agent knows to read those alternatives before falling back.
    const noAvailIdx = prompt.indexOf('NO_AVAILABILITY');
    expect(noAvailIdx).toBeGreaterThan(-1);
    // Within the next 200 chars after NO_AVAILABILITY, next_available
    // must appear — keeps the mapping concrete and findable for the LLM.
    const slice = prompt.slice(noAvailIdx, noAvailIdx + 300);
    expect(slice).toMatch(/next_available/);
  });

  // ── AI-prevention conversation-shape tests (booking enforcement Slice 4) ──
  // These pin the four rules the prompt establishes for the agent's
  // tool-call ordering + fallback behavior. They don't run an LLM (cost +
  // determinism); they pin the prompt content the agent reads from. If the
  // prompt loses any of these rules in a refactor, the LLM has license to
  // skip the check, propose off-grid times, or strand the caller — every
  // failure mode the booking-enforcement chain was meant to prevent.

  it('CONVERSATION-SHAPE (a): prompt mandates check-before-book as a HARD RULE, not a hint', () => {
    // WHO: voice agent picking up a call where the caller wants to book
    // WHAT: prompt establishes that an availability tool MUST run before
    //        any booking tool — strong language ("MUST", "hard rule",
    //        "before every"), not soft language ("usually", "try to")
    // WHEN: every booking conversation — without exception
    // WHERE: # Availability discipline section
    // WHY: pre-tightening the prompt said "the booking tools enforce this
    //        server-side" which gave the LLM license to skip the check
    //        and let the backend catch it — but by the time the backend
    //        rejects, the caller has already heard a time the agent
    //        couldn't deliver. The hard rule prevents that.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toMatch(/hard rule/i);
    expect(prompt).toMatch(/MUST call an availability tool BEFORE/);
    // All three availability tools called out so the LLM knows it has
    // multiple paths into the gate (different tools fit different shapes
    // of caller request).
    expect(prompt).toMatch(/get_available_slots/);
    expect(prompt).toMatch(/get_scheduling_options/);
    expect(prompt).toMatch(/check_availability/);
    // Pin the warning against the old "backend will catch it" excuse.
    expect(prompt).toMatch(/Don't rely on the backend|don't rely on the backend/i);
  });

  it('CONVERSATION-SHAPE (b): on TIMESLOT_OCCUPIED, prompt directs propose-alternative not retry', () => {
    // WHO: agent that just got a TIMESLOT_OCCUPIED back from book_appointment
    // WHAT: prompt tells the agent to (1) acknowledge "that time just got
    //        taken", (2) propose alternatives from next_available if
    //        present, NOT to retry the same slot or guess a new one
    // WHEN: any booking response with TIMESLOT_OCCUPIED + a populated
    //        conflict block / next_available array
    // WHERE: # Booking rules + # When a booking response includes next_available
    // WHY: without this, the agent might just say "sorry that's taken,
    //        what other time?" — putting the work back on the caller.
    //        The conflict response carries enough info for the agent to
    //        proactively offer alternatives.
    const prompt = buildSystemPrompt(BASE_CTX);
    // TIMESLOT_OCCUPIED mapping must reference proposing alternatives.
    const timeslotIdx = prompt.indexOf('TIMESLOT_OCCUPIED');
    expect(timeslotIdx).toBeGreaterThan(-1);
    // Within the next ~250 chars after the code, "alternatives" or
    // "next_available" must appear so the LLM knows to look there.
    const slice = prompt.slice(timeslotIdx, timeslotIdx + 250);
    expect(slice).toMatch(/alternatives|next_available/i);
    // The user-friendly translation must NOT include the raw code.
    expect(slice).toMatch(/that time just got taken|just got taken/i);
  });

  it("CONVERSATION-SHAPE (c): prompt requires 15-minute grid times in the agent's spoken proposals", () => {
    // WHO: agent reading back times to a caller after an availability tool
    //        returned slots
    // WHAT: prompt explicitly tells the agent every spoken time must land
    //        on the 15-min clock grid (:00, :15, :30, :45) — not :07,
    //        :23, :40 etc. — because the system rejects off-grid times
    //        at booking time.
    // WHEN: any time the agent verbalizes a candidate slot to the caller
    // WHERE: # Availability discipline section, the proposal step
    // WHY: pre-rule, the agent could rephrase a returned slot ("I have
    //        2:07") which would then fail at book_appointment with
    //        INVALID_INCREMENT, forcing an awkward correction. Pinning
    //        the grid in the prompt closes that gap before the booking
    //        call happens.
    const prompt = buildSystemPrompt(BASE_CTX);
    // The four grid minute values must appear together as the canonical
    // set so the LLM can match against them.
    expect(prompt).toMatch(/:00, :15, :30, :45/);
    // Forbidden examples must appear so the rule has teeth ("never X").
    expect(prompt).toMatch(/never :07|never :07,|:07/);
    // "15-minute" or "grid" must appear as the conceptual label.
    expect(prompt).toMatch(/15-minute|15 minute|clock grid/i);
  });

  it('CONVERSATION-SHAPE (d): when nothing fits, prompt directs the agent to take a message gracefully', () => {
    // WHO: agent that has cycled through next_available + get_scheduling_options
    //        and the caller has rejected every alternative
    // WHAT: prompt tells the agent to STOP guessing and offer to take a
    //        message — capturing name + reason — instead of looping back
    //        to "want another time?" indefinitely
    // WHEN: caller has rejected every available slot, or a tool returned
    //        zero slots and there's no point trying further
    // WHERE: # When the caller can't be accommodated section
    // WHY: without this, the agent's natural fallback ("any other time
    //        work for you?") creates infinite loops on phones with no
    //        real availability. The take-a-message path is the graceful
    //        exit that keeps the lead alive without booking a doomed slot.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toMatch(/take a message/i);
    // The exhaustion condition must be documented so the LLM knows when
    // to escalate vs. keep trying.
    expect(prompt).toMatch(/run out|turned down several|searches come back empty|zero slots/i);
    // Customer-led booking (2026-06-06): when the offered times don't work
    // the agent must WIDEN the search and offer the next set, not jump
    // straight to a message. Pin both halves so a reword can't drop the loop.
    expect(prompt).toMatch(/do NOT jump to taking a message|widen, don't give up/i);
    expect(prompt).toMatch(/next set of open times|NEXT window/i);
    // Capture rules: name + reason. Pre-rule the agent might forget to
    // ask for the reason, leaving the call summary ambiguous.
    expect(prompt).toMatch(/name.*reason|reason.*name/i);
    // Don't-promise-a-specific-callback rule — preserves trust.
    expect(prompt).toMatch(/don't promise|do not promise/i);
  });

  it('CONVERSATION-SHAPE (e): booking is customer-led — ask the caller their time, never impose', () => {
    // WHO: any caller who hasn't already volunteered a specific day/time.
    // WHAT: the prompt directs the agent to ASK what works for the caller and
    //        states plainly that the caller chooses the time, not the agent.
    // WHEN: the start of every booking flow.
    // WHERE: # Availability discipline section.
    // WHY: 2026-06-06 feedback — an agent that announces a slot it picked
    //      ("you're booked at 2") treats the caller's day as filler for the
    //      shop's gaps. The caller's time is theirs; the agent fits the shop
    //      around it, asking politely and offering options to choose from.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toMatch(/caller chooses the time/i);
    expect(prompt).toMatch(
      /what day works for you|caller still chooses their time|what day were you thinking/i
    );
    expect(prompt).toMatch(/never (announce|impose)|don't (assume|impose)/i);
  });

  // ───────────────────────────────────────────────────────────────────
  // Custom system prompt (2026-05-18): tenants.system_prompt overrides
  // the hardcoded "You are Clara..." identity line. Placeholders get
  // substituted from PromptContext fields. Everything else (tools, OTP,
  // booking discipline) stays platform-controlled.
  // ───────────────────────────────────────────────────────────────────

  it('CUSTOM PROMPT: when set, replaces the hardcoded Clara line as the identity section', () => {
    // WHO: tenant whose AI Persona page in the dashboard says "You are
    //      a friendly virtual receptionist for {{business_name}}..."
    // WHAT: that text appears at the top of the prompt verbatim (minus
    //      the substituted placeholder); the default Clara line does NOT.
    // WHERE: agent/src/prompt.ts buildSystemPrompt identity branch.
    // WHY: pre-2026-05-18 the dashboard customization was dead weight —
    //      the agent built its own prompt and ignored the DB column.
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      customPrompt: 'You are a friendly virtual receptionist for {{business_name}}.',
    });
    expect(prompt).toContain('You are a friendly virtual receptionist for DynaTire.');
    expect(prompt).not.toContain('You are Clara, the AI receptionist');
  });

  it('CUSTOM PROMPT: platform-level sections (tools, OTP, booking) still appear below the custom identity', () => {
    // WHY: customization is for __PERSONA_NAME__ only. Booking discipline +
    //      tool listings are load-bearing for correctness and must NOT
    //      be replaceable by a tenant who edits their persona.
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      customPrompt: 'Custom persona text.',
    });
    expect(prompt).toContain('# Conversation style');
    expect(prompt).toContain('# Available tools');
    expect(prompt).toContain('# Phone Verification');
    expect(prompt).toContain('get_company_policy_answer');
    expect(prompt).toContain('TIMESLOT_OCCUPIED');
  });

  it('CUSTOM PROMPT: substitutes {{business_name}}, {{current_date}}, {{caller_phone}}', () => {
    // WHAT: all three Handlebars placeholders supported at prompt build time.
    // WHY: the DB-stored templates use these exact tokens (see
    //      supabase/baseline.sql seeded answering-service template).
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      customPrompt: 'Hello {{business_name}} — caller {{caller_phone}} on {{current_date}}.',
    });
    expect(prompt).toContain('Hello DynaTire — caller +15551234567 on Friday, April 24, 2026.');
  });

  it('CUSTOM PROMPT: anonymous-caller substitution yields "unknown" (not blank or "null")', () => {
    // WHY: a blank substitution produces "caller  on Friday..." which
    //      is mid-sentence ungrammatical; "null" leaks an internal type
    //      to the LLM. "unknown" reads naturally on both written and
    //      spoken paths.
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      callerPhone: null,
      customPrompt: 'Caller {{caller_phone}}.',
    });
    expect(prompt).toContain('Caller unknown.');
    expect(prompt).not.toContain('Caller null.');
    expect(prompt).not.toContain('Caller .');
  });

  it('CUSTOM PROMPT: unknown placeholders pass through unchanged', () => {
    // WHY: a typo like {{busniess_name}} should be visible to the
    //      operator (so they fix the template), not silently blanked
    //      out so the caller hears "Hello  thanks for calling".
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      customPrompt: 'Hello {{busniess_name}} from {{business_name}}.',
    });
    expect(prompt).toContain('Hello {{busniess_name}} from DynaTire.');
  });

  it('CUSTOM PROMPT: null / undefined / empty / whitespace falls back to the hardcoded Clara identity', () => {
    // WHY: tenants that haven't customized their persona must continue
    //      to get the working default. Whitespace-only counts as empty
    //      (catches the edge case of an owner who clears the textarea
    //      but leaves a trailing space).
    for (const customPrompt of [null, undefined, '', '   \n\t  ']) {
      const prompt = buildSystemPrompt({ ...BASE_CTX, customPrompt });
      expect(prompt).toContain('You are Clara, the AI receptionist for DynaTire.');
    }
  });

  it('PREFERENCES OFF: no "Customer preferences" section and no save tool when explicitly disabled', () => {
    // WHO: a tenant owner who opted out of preference capture in the dashboard.
    // WHAT: the prompt omits the preferences section + save tool.
    // WHEN: every call for a tenant with save_preferences_enabled = false.
    // WHERE: buildSystemPrompt preferencesEnabled branch.
    // WHY: an opt-out tenant must not have the agent saving data they didn't want captured.
    // NOTE: undefined/null/true all ENABLE (default-on); only explicit false disables.
    for (const ctx of [
      { ...BASE_CTX, savePreferencesEnabled: false },
      { ...BASE_CTX, savePreferencesEnabled: false, preferencesInstructions: 'ignored when off' },
    ]) {
      const prompt = buildSystemPrompt(ctx);
      expect(prompt).not.toContain('# Customer preferences');
      expect(prompt).not.toContain('save_customer_preference');
    }
  });

  it('PREFERENCES ON (default): section and save tool present when flag unset or true', () => {
    // WHO: any tenant that hasn't explicitly opted out (the default state).
    // WHAT: prompt includes the preferences section + save tool.
    // WHEN: every call where savePreferencesEnabled is undefined, null, or true.
    // WHERE: buildSystemPrompt preferencesEnabled = (ctx.savePreferencesEnabled !== false).
    // WHY: preferences are on by default — returning callers should be recognized.
    for (const ctx of [
      BASE_CTX,
      { ...BASE_CTX, savePreferencesEnabled: true },
      { ...BASE_CTX, savePreferencesEnabled: undefined },
    ]) {
      const prompt = buildSystemPrompt(ctx);
      expect(prompt).toContain('# Customer preferences');
      expect(prompt).toContain('save_customer_preference(phone, key, value)');
    }
  });

  it('PREFERENCES ON: owner instructions injected verbatim', () => {
    // WHO: a salon owner who wrote their own preference guidance.
    // WHAT: their exact text appears in the prompt's preferences section.
    // WHY: the owner's words are the steering signal — generic defaults don't
    //      know this business's nuances.
    const ownerText = 'Always offer the same stylist and ask about nails.';
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      preferencesInstructions: ownerText,
    });
    expect(prompt).toContain('# Customer preferences');
    expect(prompt).toContain(ownerText);
    expect(prompt).toContain('save_customer_preference(phone, key, value)');
  });

  it('PREFERENCES ON, no instructions: falls back to built-in default guidance', () => {
    // WHO: a tenant with preferences on but no custom instructions.
    // WHAT: sensible default guidance renders so the tool is immediately useful.
    // WHERE: buildSystemPrompt ownerPrefGuidance `||` default branch.
    // WHY: a blank instruction box must not produce an empty, useless section.
    for (const preferencesInstructions of [null, undefined, '   ']) {
      const prompt = buildSystemPrompt({
        ...BASE_CTX,
        preferencesInstructions,
      });
      expect(prompt).toContain('# Customer preferences');
      expect(prompt).toContain('Remember what each customer likes');
      expect(prompt).toContain('save_customer_preference');
    }
  });
});

describe('buildSystemPrompt — capability gating (Realtime tool subset)', () => {
  // Origin: GH issue #113. In Realtime mode the tool set is trimmed to a
  // capability subset (identity/scheduling/messaging), but the prompt used to
  // advertise knowledge/verification/transfer tools unconditionally. The model
  // would then try to call tools that aren't in the ToolContext → error or
  // hallucination → dead air on a voice call. The prompt must describe ONLY the
  // tools the active capability set actually exposes. `capabilities` undefined =
  // all capabilities (pipeline mode, backward compatible).
  const REALTIME = ['identity', 'scheduling', 'messaging'] as const;

  it('HAPPY: undefined capabilities = all tools/sections present (backward compatible)', () => {
    // WHO: pipeline-mode call (the default, ENABLE_REALTIME off).
    // WHAT: with no capabilities passed, every tool + section renders exactly
    //        as before — knowledge, verification, transfer all included.
    // WHY: capability gating must be strictly additive; the no-capabilities
    //        path is the production default and must not change.
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).toContain('get_company_policy_answer');
    expect(prompt).toContain('send_verification_code');
    expect(prompt).toContain('verify_phone_code');
    expect(prompt).toContain('transfer_call');
    expect(prompt).toContain('# Phone Verification');
    expect(prompt).toContain('# Knowledge base');
  });

  it('HAPPY: Realtime subset omits EVERY reference to dropped tools (zero-occurrence)', () => {
    // WHO: a Realtime (speech-to-speech) call where tools are trimmed to
    //       identity/scheduling/messaging.
    // WHAT: the prompt must contain NONE of the dropped tools or their
    //        dedicated sections — a single lingering mention is enough for the
    //        LLM to attempt a non-existent tool call.
    // WHY: issue #113 — prompt↔tool drift causes dead air. A zero-occurrence
    //        assertion (not an enumerated eyeball) is what proves we caught
    //        every reference.
    const prompt = buildSystemPrompt({ ...BASE_CTX, capabilities: REALTIME });
    for (const dropped of [
      'get_company_policy_answer',
      'send_verification_code',
      'verify_phone_code',
      'transfer_call',
      // 'sms'-gated since 2026-07-17 (they TEXT the caller; ENABLE_SMS off =
      // tools absent) — and the Realtime subset has no 'sms' either.
      'send_self_service_link',
      'record_sms_consent',
      '# Phone Verification',
      '# Knowledge base',
    ]) {
      expect(prompt, `dropped reference still present: ${dropped}`).not.toContain(dropped);
    }
  });

  it('HAPPY: without the sms capability, NOTHING points at send_self_service_link (zero-occurrence)', () => {
    // WHO: every prod call today — ENABLE_SMS=false until 10DLC lands, so no
    //       text this product sends reaches a handset.
    // WHAT: the link tool is 'sms'-gated (2026-07-17: it was mis-filed under
    //        'scheduling' and ESCAPED the gate — the model could truthfully
    //        relay a tool-reported "text sent" for a text that dies at the
    //        carrier). With 'sms' absent the tool is gone, and per GH #113 the
    //        doc line, the manage-door description, the PROACTIVE offer step,
    //        and the honesty-line parenthetical must all go with it.
    // WHY: found because Dale asked, of a green eval case: "But we aren't
    //       texting." Layer-1 honesty (claim vs tool called) was graded;
    //       layer-2 (tool result vs reality) was not.
    const NO_SMS = [
      'identity',
      'scheduling',
      'messaging',
      'knowledge',
      'verification',
      'transfer',
    ] as const;
    const prompt = buildSystemPrompt({ ...BASE_CTX, capabilities: NO_SMS });
    for (const dropped of [
      'send_self_service_link',
      'PROACTIVELY offer the self-service option',
      'self-service link',
      // Caught by review on this very fix: record_sms_consent had the SAME
      // mis-advertising (sms-gated tool, unconditionally named by the booking
      // door and the tool list) — the pre-existing instance of the class.
      'record_sms_consent',
    ]) {
      expect(prompt, `sms-gated reference still present: ${dropped}`).not.toContain(dropped);
    }
    // The live path remains: changes are handled on the call.
    expect(prompt).toContain('Handle the change live on this call');
    // And with sms PRESENT, the offer comes back.
    const withSms = buildSystemPrompt({ ...BASE_CTX, capabilities: [...NO_SMS, 'sms'] });
    expect(withSms).toContain('send_self_service_link');
    expect(withSms).toContain('PROACTIVELY offer the self-service option');
  });

  it('HAPPY: Realtime subset KEEPS identity + scheduling + messaging content', () => {
    // WHO: same Realtime call.
    // WHAT: the tools that ARE in the subset must still be described so the
    //        model knows its actual toolkit.
    // WHY: over-trimming would strand the model with no booking/identity tools.
    const prompt = buildSystemPrompt({ ...BASE_CTX, capabilities: REALTIME });
    expect(prompt).toContain('get_customer_context'); // identity
    expect(prompt).toContain('identify_caller'); // identity
    expect(prompt).toContain('get_service_catalog'); // scheduling
    expect(prompt).toContain('book_with_scheduling'); // scheduling
    expect(prompt).toContain('TIMESLOT_OCCUPIED'); // scheduling error map kept
    expect(prompt).toMatch(/take a message/i); // messaging path kept
  });

  it('HAPPY: blocked caller WITHOUT verification → no OTP, steer to read-back + message (no dangling section ref)', () => {
    // WHO: anonymous caller (no caller-ID) on a Realtime call where the
    //       verification capability is NOT available.
    // WHAT: the caller line must NOT promise an OTP flow that no longer exists
    //        (no "Phone Verification section below" pointer, no "verify"); it
    //        steers to collecting/confirming a number verbally and offering a
    //        message instead.
    // WHY: issue #113 — gating verification out while leaving the blocked-caller
    //        line pointing at the deleted "# Phone Verification" section is the
    //        same dead-air bug class (a dangling reference the model can't act on).
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      callerPhone: null,
      capabilities: REALTIME,
    });
    expect(prompt).toContain("do NOT have the caller's number"); // still tells the model caller-ID is missing
    expect(prompt).not.toContain('Phone Verification section'); // no dangling pointer
    expect(prompt).not.toContain('MUST collect and verify'); // no OTP promise
    expect(prompt).not.toContain('# Phone Verification');
  });

  it('HAPPY: blocked caller WITH verification (pipeline) → keeps the OTP MUST-verify line', () => {
    // WHO: anonymous caller in pipeline mode (verification available).
    // WHAT: the existing OTP behavior is unchanged — collect + verify.
    // WHY: regression guard — capability gating must not weaken the verified
    //        path when verification IS present.
    const prompt = buildSystemPrompt({ ...BASE_CTX, callerPhone: null });
    expect(prompt).toContain('MUST collect and verify');
    expect(prompt).toContain('# Phone Verification');
  });

  it('HAPPY: a scheduling+knowledge subset keeps the KB section but still drops transfer/verification', () => {
    // WHO: a scheduling + knowledge subset (no transfer, no verification) — the
    //       array passed is exactly ['scheduling','knowledge'].
    // WHAT: gating is per-capability and independent — knowledge present keeps
    //        get_company_policy_answer + # Knowledge base; transfer + verification
    //        absent drop transfer_call + send_verification_code.
    // WHY: pins that the gates are independent booleans, not an all-or-nothing
    //        realtime flag — so future capability mixes render correctly.
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      capabilities: ['scheduling', 'knowledge'] as const,
    });
    expect(prompt).toContain('get_company_policy_answer');
    expect(prompt).toContain('# Knowledge base');
    expect(prompt).not.toContain('transfer_call');
    expect(prompt).not.toContain('send_verification_code');
  });
});

describe('buildSystemPrompt — voice style injection', () => {
  it('HAPPY: ttsFormal=true injects # Voice style section with formal instruction', () => {
    // WHO: tenant with the Formal voice style checkbox checked
    // WHAT: the prompt gains a "# Voice style" section containing the formal
    //        language instruction (no contractions, precise sentences)
    // WHEN: every call session for that tenant
    // WHERE: buildSystemPrompt styleSection branch — ttsFormal guard
    // WHY: the LLM must read the instruction to apply it; without the section
    //       the "Formal" checkbox on the dashboard has zero runtime effect
    const prompt = buildSystemPrompt({ ...BASE_CTX, ttsFormal: true });
    expect(prompt).toContain('# Voice style');
    expect(prompt).toContain('formal language');
    expect(prompt).toContain('no contractions');
  });

  it('HAPPY: ttsWarm=true injects warm instruction', () => {
    // WHO: tenant with the Warm voice style checkbox checked
    // WHAT: the # Voice style section includes the warm-and-caring delivery note
    // WHEN: every call session for that tenant
    // WHERE: buildSystemPrompt styleSection branch — ttsWarm guard
    // WHY: without the instruction, the toggle is cosmetic and the LLM
    //       continues its default neutral delivery regardless of the setting
    const prompt = buildSystemPrompt({ ...BASE_CTX, ttsWarm: true });
    expect(prompt).toContain('# Voice style');
    expect(prompt).toContain('warm and caring');
  });

  it('HAPPY: ttsConcise=true injects concise instruction', () => {
    // WHO: tenant with the Concise voice style checkbox checked
    // WHAT: the # Voice style section includes the brevity instruction
    // WHEN: every call session for that tenant
    // WHERE: buildSystemPrompt styleSection branch — ttsConcise guard
    // WHY: brevity must be explicitly instructed; the LLM's default verbosity
    //       doesn't change unless it reads the instruction at call time
    const prompt = buildSystemPrompt({ ...BASE_CTX, ttsConcise: true });
    expect(prompt).toContain('# Voice style');
    expect(prompt).toContain('one sentence is better than two');
  });

  it('HAPPY: ttsSoft=true injects a gentle/soothing delivery instruction', () => {
    // WHO: tenant with the Soft voice style checkbox checked (re-activated 2026-06-30).
    // WHAT: the # Voice style section includes the soft/gentle delivery note.
    // WHERE: buildSystemPrompt styleSection branch — ttsSoft guard.
    // WHY: the column existed but was inert post-Grok; this re-wires it.
    const prompt = buildSystemPrompt({ ...BASE_CTX, ttsSoft: true });
    expect(prompt).toContain('# Voice style');
    expect(prompt).toMatch(/softly and gently/i);
  });

  it('HAPPY: ttsCheerful=true injects an upbeat instruction', () => {
    // WHO: tenant with the Cheerful voice style checkbox checked.
    // WHAT: the # Voice style section includes the cheerful/upbeat note.
    // WHERE: buildSystemPrompt styleSection branch — ttsCheerful guard.
    const prompt = buildSystemPrompt({ ...BASE_CTX, ttsCheerful: true });
    expect(prompt).toContain('# Voice style');
    expect(prompt).toMatch(/cheerful and upbeat/i);
  });

  it('HAPPY: all three flags true — all three instructions present, header appears once', () => {
    // WHO: tenant with Formal + Warm + Concise all checked
    // WHAT: the # Voice style section contains all three instruction bullets
    //        and the section header appears exactly once (no duplication)
    // WHEN: every call session for that tenant
    // WHERE: buildSystemPrompt styleSection — three-item styleLines array
    // WHY: if each flag independently injected the header, the LLM would
    //       see "# Voice style" three times which could confuse parsing
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      ttsFormal: true,
      ttsWarm: true,
      ttsConcise: true,
    });
    expect(prompt).toContain('formal language');
    expect(prompt).toContain('warm and caring');
    expect(prompt).toContain('one sentence is better than two');
    // Header appears exactly once.
    const occurrences = (prompt.match(/# Voice style/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('HAPPY: no style flags — no # Voice style section injected', () => {
    // WHO: tenant with no voice style checkboxes checked (the default)
    // WHAT: the prompt is byte-for-byte unchanged — no # Voice style section
    // WHEN: every call for a tenant who hasn't enabled any style flag
    // WHERE: buildSystemPrompt — styleLines.length === 0 → styleSection = ''
    // WHY: the feature must be strictly opt-in; a blank tenant must not see
    //       any style instructions in their prompt
    const prompt = buildSystemPrompt(BASE_CTX);
    expect(prompt).not.toContain('# Voice style');
  });

  it('HAPPY: null style flags treated as off — no style section', () => {
    // WHO: tenant whose DB columns are NULL (never set — the DB default)
    // WHAT: null values must behave identically to false — no style section
    // WHEN: a brand-new tenant who has never visited the AI Persona page
    // WHERE: buildSystemPrompt styleLines — falsy-check on null
    // WHY: DB nullable booleans arrive as null in JS; treating null as true
    //       would inject style instructions for every new tenant by default
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      ttsFormal: null,
      ttsWarm: null,
      ttsConcise: null,
    });
    expect(prompt).not.toContain('# Voice style');
  });

  it('HAPPY: false style flags treated as off — no style section', () => {
    // WHO: tenant who explicitly unchecked all style checkboxes and saved
    // WHAT: explicit false values produce no style section (same as null)
    // WHEN: after an owner visits AI Persona and saves with all boxes unchecked
    // WHERE: buildSystemPrompt styleLines — falsy-check on false
    // WHY: regression guard; a change to the if-condition must not treat
    //       false as truthy and accidentally re-enable style injection
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      ttsFormal: false,
      ttsWarm: false,
      ttsConcise: false,
    });
    expect(prompt).not.toContain('# Voice style');
  });

  it('HAPPY: two of three flags — only those two instructions appear', () => {
    // WHO: tenant with Formal and Warm checked, Concise unchecked
    // WHAT: exactly two instructions are injected; the concise instruction
    //        is absent so the LLM has no brevity directive
    // WHEN: every call for that tenant
    // WHERE: buildSystemPrompt styleLines — flag-by-flag push
    // WHY: each flag must be independently controlled; checking Formal must
    //       not silently enable Concise as a side-effect
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      ttsFormal: true,
      ttsWarm: true,
      ttsConcise: false,
    });
    expect(prompt).toContain('formal language');
    expect(prompt).toContain('warm and caring');
    expect(prompt).not.toContain('one sentence is better than two');
  });

  it("HAPPY: style section appears AFTER # Conversation style, BEFORE # Today's context", () => {
    // WHO: any tenant with at least one style flag enabled
    // WHAT: the # Voice style section is positioned inside the conversation
    //        style block — after # Conversation style content, before # Today's context
    // WHEN: every call for a tenant with style flags set
    // WHERE: buildSystemPrompt template — styleSection injected at end of
    //         Conversation style bullet list, before Today's context header
    // WHY: section order affects LLM attention; putting voice style AFTER the
    //       conversation-style rules and BEFORE the call-specific context
    //       keeps it near peer instructions and away from factual data blocks
    const prompt = buildSystemPrompt({ ...BASE_CTX, ttsFormal: true });
    const convStyleIdx = prompt.indexOf('# Conversation style');
    const voiceStyleIdx = prompt.indexOf('# Voice style');
    const todaysCtxIdx = prompt.indexOf("# Today's context");
    expect(convStyleIdx).toBeGreaterThan(-1);
    expect(voiceStyleIdx).toBeGreaterThan(convStyleIdx);
    expect(voiceStyleIdx).toBeLessThan(todaysCtxIdx);
  });

  it('SAD: style flags present but identity section still correct', () => {
    // WHO: tenant with Formal checked and a custom persona prompt
    // WHAT: the identity section (Clara line or custom prompt) is not
    //        corrupted by the presence of style flags
    // WHEN: any call where both a custom prompt and style flags are set
    // WHERE: buildSystemPrompt — identitySection built independently of styleSection
    // WHY: the two features operate on different output regions; a merge
    //       conflict or code reorder could accidentally overwrite the identity
    const prompt = buildSystemPrompt({ ...BASE_CTX, ttsFormal: true });
    // Default identity is present and correct.
    expect(prompt).toContain('You are Clara, the AI receptionist for DynaTire.');
    // Style section is also present.
    expect(prompt).toContain('# Voice style');
    expect(prompt).toContain('formal language');
  });

  it('SAD: style section does not bleed into preference section', () => {
    // WHO: tenant with Formal checked and Customer Preferences enabled
    // WHAT: both the # Customer preferences section and # Voice style section
    //        appear separately — the style injection must not corrupt or
    //        replace the preferences block
    // WHEN: any call where both features are active simultaneously
    // WHERE: buildSystemPrompt — preferencesSection and styleSection are
    //         independently constructed strings appended at different points
    // WHY: two independent prompt features must be additive; enabling one
    //       must not suppress or garble the other
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      ttsFormal: true,
      preferencesInstructions: 'Note preferred stylist.',
    });
    expect(prompt).toContain('# Customer preferences');
    expect(prompt).toContain('# Voice style');
    // Both sections exist and are distinct.
    expect(prompt.indexOf('# Customer preferences')).not.toBe(prompt.indexOf('# Voice style'));
  });
});

describe('formatTimeForPrompt', () => {
  // WHO: Camille, prod call SCL_HQNeyh5cVKd9, 2026-09-09 18:08 CT.
  // WHAT: the prompt carried the DATE and no time, so the model invented one —
  //       "It's currently 3 PM here", twice, then argued when she corrected it.
  // WHEN: any call where the caller mentions the time or asks if we are open.
  // WHERE: this helper feeds CallRuntime.currentTime.
  // WHY: a model with no clock does not decline to answer; it guesses and defends
  //      the guess. Verified separately that every clock in the stack was correct —
  //      server UTC, Postgres, and tenants.timezone — so this was a missing input,
  //      not a timezone bug.
  it('HAPPY: renders the local wall clock in the tenant timezone', () => {
    const at608pmCentral = new Date('2026-09-09T23:08:00Z');
    expect(formatTimeForPrompt(at608pmCentral, 'America/Chicago')).toBe('6:08 PM');
  });

  it('HAPPY: the same instant reads differently per zone — the tenant zone decides', () => {
    const instant = new Date('2026-09-09T23:08:00Z');
    expect(formatTimeForPrompt(instant, 'America/New_York')).toBe('7:08 PM');
    expect(formatTimeForPrompt(instant, 'Pacific/Honolulu')).toBe('1:08 PM');
  });

  it('HAPPY: midnight and noon are unambiguous', () => {
    // "12:00 AM" beats "0:00" out loud, and a receptionist says the former.
    expect(formatTimeForPrompt(new Date('2026-09-10T05:00:00Z'), 'America/Chicago')).toBe(
      '12:00 AM'
    );
    expect(formatTimeForPrompt(new Date('2026-09-10T17:00:00Z'), 'America/Chicago')).toBe(
      '12:00 PM'
    );
  });
});

describe('formatDateForPrompt', () => {
  it('HAPPY: renders a full weekday+month+day+year string in the tenant timezone', () => {
    // WHO: Scheduler said "book me Tuesday" — the LLM needs to know
    //        today to compute Tuesday's date
    const date = new Date('2026-04-24T17:30:00Z'); // 12:30 PM CDT
    expect(formatDateForPrompt(date, 'America/Chicago')).toBe('Friday, April 24, 2026');
  });

  it('HAPPY: different timezone across a date boundary yields different dates', () => {
    // WHY: Prior bug: we used UTC date for all tenants, so a tenant in
    //        Hawaii saw "tomorrow's" date at 10 PM local. Using the
    //        tenant's IANA zone is the correct fix.
    const lateUTC = new Date('2026-04-24T05:00:00Z'); // 10 PM the 23rd in HST
    expect(formatDateForPrompt(lateUTC, 'Pacific/Honolulu')).toContain('April 23');
    expect(formatDateForPrompt(lateUTC, 'America/New_York')).toContain('April 24');
  });
});

describe('buildSystemPrompt — prefetched caller context', () => {
  const KNOWN = {
    name: 'Dale',
    history: 'Booked a cut on May 2',
    preferences: { preferred_stylist: 'Maria', last_service: 'balayage' },
    upcomingAppointments: [],
  };

  it('HAPPY: bakes the returning caller name, preferences, and history into the prompt', () => {
    // WHO: a returning customer whose record was prefetched at session start.
    // WHAT: name + every saved preference + recent-call summary must appear in
    //        the instructions the LLM sees on turn one.
    // WHEN: every call where caller ID resolves to a known customer.
    // WHY: this is the read-back half of the preference loop. Before 2026-07-12
    //        preferences were written by save_customer_preference and then
    //        almost never read — nothing put them in front of the model.
    const prompt = buildSystemPrompt({ ...BASE_CTX, knownCustomer: KNOWN });

    expect(prompt).toContain("# Who you're speaking to");
    expect(prompt).toContain('Dale');
    expect(prompt).toContain('preferred_stylist: Maria');
    expect(prompt).toContain('last_service: balayage');
    expect(prompt).toContain('Booked a cut on May 2');
  });

  it('HAPPY: tells the model the context is already loaded, so it does not re-fetch', () => {
    // WHY: the old prompt claimed context was already present when it was NOT.
    //       Now that the claim is true, it must be paired with an explicit
    //       "don't call get_customer_context for it" so the model doesn't burn
    //       a round-trip (and a silent pause) re-fetching what it already has.
    const prompt = buildSystemPrompt({ ...BASE_CTX, knownCustomer: KNOWN });
    expect(prompt).toContain('do NOT call get_customer_context');
  });

  it('SAD: with no prefetched context, the prompt tells the model to FETCH rather than claiming it has it', () => {
    // WHO: a new caller, a blocked caller ID, or a backend that missed the 1.5s
    //       prefetch deadline.
    // WHAT: the preferences guidance must NOT assert "you already have this
    //        caller's preferences" — it must direct the model to call
    //        get_customer_context(phone) itself.
    // WHY: THE ORIGINAL BUG. The prompt asserted context it never received, so
    //        the model had no reason to fetch — and saved preferences went unread
    //        on every call. Asserting absent context is worse than saying nothing.
    const prompt = buildSystemPrompt({ ...BASE_CTX, knownCustomer: null });

    expect(prompt).not.toContain("# Who you're speaking to");
    expect(prompt).toContain('You do NOT have this caller');
    expect(prompt).toContain('call get_customer_context(phone)');
  });

  it('SAD: an owner who turned preference capture OFF gets no saved preferences in the prompt', () => {
    // WHO: a tenant with save_preferences_enabled = false on the AI Persona page.
    // WHAT: the caller's name/history may still be used (that's plain CRM), but
    //        saved preferences must not be surfaced to the model.
    // WHY: the toggle means "don't do preferences on my calls" — honoring it on
    //        the write path while replaying preferences on the read path would
    //        leak exactly what the owner opted out of.
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      knownCustomer: KNOWN,
      savePreferencesEnabled: false,
    });

    expect(prompt).toContain('Dale'); // name still available
    expect(prompt).not.toContain('preferred_stylist: Maria');
    expect(prompt).not.toContain('balayage');
    expect(prompt).not.toContain('# Customer preferences');
  });
});

describe('buildSystemPrompt — business hours (prevent the impossible guess)', () => {
  it('HAPPY: states the real hours and forbids the open-ended "what day?" question', () => {
    // WHO: the 2026-07-12 caller. The agent asked "what day and time were you
    //       thinking?" — an open question against a calendar she could not see.
    //       She named May 26 (already past), then Aug 26 (past the end of the
    //       schedule). Refused both times. Gave up after seven minutes.
    // WHAT: the prompt now carries the shop's REAL hours, derived from who is
    //        actually scheduled, and tells the agent to lead with them.
    // WHY: prevention beats recovery. A receptionist says "we're open weekdays
    //       one to five — what day works?" and the impossible answer never happens.
    const prompt = buildSystemPrompt({
      ...BASE_CTX,
      businessHours: 'Monday to Friday, 1:00 PM to 5:00 PM',
      bookableThrough: '2027-01-08',
    });

    expect(prompt).toContain("# When we're open");
    expect(prompt).toContain('Monday to Friday, 1:00 PM to 5:00 PM');
    expect(prompt).toContain('2027-01-08'); // how far out it can book
    // The behavioral rule, not just the data.
    expect(prompt).toMatch(/before asking the caller for a day/i);
    expect(prompt).toMatch(/date in the PAST/i);
  });

  it('SAD: with NO hours (nobody scheduled) it must NOT claim to be open', () => {
    // WHY: a shop with an empty schedule has no hours to state. Inventing one
    //       would have the AI promising a caller a time nobody is there to work —
    //       strictly worse than admitting we can't say.
    const prompt = buildSystemPrompt({ ...BASE_CTX, businessHours: null });

    expect(prompt).not.toContain("# When we're open");
  });
});
