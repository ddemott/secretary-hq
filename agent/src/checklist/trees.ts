/**
 * THE PLATFORM TREE LIBRARY — question-tree phase 2
 * (docs/QUESTION_TREE_ARCHITECTURE.md §3.1, §4.2).
 *
 * Every tree the purpose selector can hand a call. Typed TS rather than loose
 * JSON on purpose: the compiler checks every node against types.ts, and
 * trees.test.ts constructs a real ChecklistTracker from this exact library — so
 * a malformed tree is a red CI, never a mid-call surprise. (Per-tenant tree
 * delivery via tenant-config is deferred until a real tenant needs a tree the
 * platform doesn't have — build for real customers.)
 *
 * DESCRIPTIONS ARE FOR THE PURPOSE SELECTOR. The model reads them to decide
 * which trees a caller's opener selects, so they carry the hard-won intent
 * boundaries (PR #288: "can someone fix my computer" is a SERVICE REQUEST, not
 * a job inquiry — the "job" there is work the caller wants done, not a role for
 * the owner).
 *
 * ASK TEXT IS FOR THE MODEL, NEVER READ VERBATIM. Where a question has
 * live-call-paid-for rules (the phone read-back), the rules ride in the ask.
 *
 * COMPOSITION OVER DUPLICATION: trees do not embed each other. A repair call
 * that should end in a booking selects identity + fix_computer + booking; the
 * shared node ids (caller_name, caller_phone) merge to one node each.
 */
import type { QuestionTreeDef } from './types.js';
import { VERTICAL_INTAKE_TREES } from './verticalIntakeTrees.js';

/** Shared node ids — every tree that wants these MUST use these exact ids so
 *  the merge dedupes them (tracker enforces type agreement at construction). */
export const CALLER_NAME = 'caller_name';
export const CALLER_PHONE = 'caller_phone';

const callerNameNode = {
  node_id: CALLER_NAME,
  type: 'text',
  ask:
    'the name the caller used for themselves — however it arrived ("this is Mike from Apex", ' +
    'or third-person "tell him Mike called, my number is…" — that "my" makes Mike the caller). ' +
    'The name they used IS their name: never chase a surname or a "full name", and never ask ' +
    'for a name they already spoke',
} as const;

const callerPhoneNode = {
  node_id: CALLER_PHONE,
  type: 'text',
  ask:
    'the best callback number — ask PLAINLY ("What\'s the best number to reach you?") and ' +
    'NEVER tell the caller how to say it: no "digit by digit", no "in three groups", no ' +
    'format coaching of any kind. People know how to say their own phone number (2026-07-21 ' +
    'live call: the agent lectured the 3-3-4 format at the caller twice and he hung up). ' +
    'When they give it, record_answer it IMMEDIATELY — do NOT read it back first: the ' +
    'recording result hands you the exact read-back to speak (one read-back, one yes, ' +
    'never more — a ten-digit number is complete; never ask for "the rest" of it). If ' +
    'they say the number you have (caller ID) is wrong, drop it entirely and collect ' +
    'fresh — never argue, never repeat the disputed number',
} as const;

/** WHO IS THIS — the floor under every goal that needs a contact. */
export const IDENTITY_TREE: QuestionTreeDef = {
  tree_id: 'identity',
  description:
    'Who is calling and how to reach them. Select for EVERY call whose goals need a contact ' +
    '(a booking, a message, a role, a schedule change). Skip ONLY for pure questions-only ' +
    'calls — a caller asking "when are you open?" is answered, never interrogated for a name.',
  nodes: [callerNameNode, callerPhoneNode],
};

/** THE MEETING — always the primary goal when present. */
export const BOOKING_TREE: QuestionTreeDef = {
  tree_id: 'booking',
  description:
    'The caller wants time with someone here — a meeting, appointment, call, viewing, or ' +
    'demo, even mentioned in passing. Also the tree for a SERVICE REQUEST that ends in a ' +
    'visit. The meeting is what they rang for: give this tree priority over intake questions.',
  nodes: [
    {
      node_id: 'meeting_topic',
      type: 'text',
      ask:
        'what the meeting is ABOUT, in the CALLER\'S OWN WORDS ("a meeting to talk about a ' +
        'job position") — the system matches their words to the right service, so record the ' +
        'words and let it choose. **WHO is not WHAT**: "I want to talk with [the owner]" names a ' +
        'person and carries NO topic — never record it here (2026-07-27 live call: it was, ' +
        "the topic question was skipped, and a recruiter's meeting was booked with the role " +
        'never mentioned again). If all you know is who they want, ask what it is about — ' +
        'and when the answer names work for the owner, a purchase, or a repair, that answer ' +
        'also picks the matching tree. Recording a role topic (position, role, job ' +
        'opportunity) ADDS the job tree in host code — do not skip those questions, and ' +
        'do not re-declare purpose as unclear',
    },
    {
      // LISTEN-ONLY (never asked — a caller who says nothing about zones means
      // ours, and asking "what timezone are you in?" on a local call is noise).
      // Recorded ONLY when the caller volunteers one, because on 2026-07-27 a
      // caller said "2:30 EST" plainly, the words went nowhere, and she was
      // booked at 2:30 LOCAL — an hour off what she had agreed to
      // (CALL_IMPROVEMENTS.md #9). Holding the utterance is what lets the
      // conversion rule in the prompt fire, and lets the owner see WHY the
      // booked time differs from the one the caller first said.
      node_id: 'caller_timezone',
      type: 'text',
      listen: true,
      ask:
        'the timezone the caller named for themselves ("2:30 Eastern", "I am on the west ' +
        'coast"), in their words. Convert it to THIS business\'s zone, say both times out ' +
        'loud, and book only the converted time they agree to',
    },
    {
      // LISTEN-ONLY, same reasoning as caller_timezone: a booking does not need
      // a "where" question (most callers come here, and asking it on every call
      // is noise), but when a caller volunteers WHERE or any other detail about
      // the meeting, that detail is the only thing that makes the calendar entry
      // mean something to the owner.
      //
      // 2026-08-13, SCL_KLvqZ2JkaQFU: the caller said "In the Sahara Desert"
      // unprompted at 0:42. The model passed it as a raw `description` arg on a
      // booking attempt that FAILED, and omitted it from the one that succeeded.
      // ACTION_ARG_BACKFILL can only restore values the TRACKER owns, so a value
      // that was never an answer could not survive the retry — the appointment
      // reads "Booking via SecretaryHQ" and the owner has no idea where he is
      // meant to be. Recording it makes the existing backfill machinery cover it.
      node_id: 'meeting_context',
      type: 'text',
      listen: true,
      ask:
        'anything the caller volunteers ABOUT the meeting itself beyond its topic — where it ' +
        'should happen, who else is joining, what they want to bring or cover. Never ask for ' +
        'it; record their own words when they offer them, so the owner opens the calendar and ' +
        'knows what he is walking into',
    },
    {
      node_id: 'book',
      type: 'action',
      tool: 'book_with_scheduling',
      description:
        'book the meeting. NEVER ask "when would you like to meet?" against a calendar ' +
        'the caller cannot see (2026-07-21 live call) — fetch real open times FIRST ' +
        '(get_available_slots), OFFER the nearest ones, and settle on one. If the caller ' +
        'names a day or time on their own, check THAT time and confirm it if open — never ' +
        'answer a named time with a menu that contains it',
      // drop_off_ok is CROSS-TREE: it exists only when fix_computer is selected
      // (ids absent from the call's selected trees are treated as satisfied), and
      // it gates the booking so the "drop-off only" statement is made BEFORE the
      // visit lands on the calendar — never announced after the fact (Dale,
      // 2026-07-21: state the policy, then book).
      requires: [CALLER_NAME, CALLER_PHONE, 'meeting_topic', 'drop_off_ok'],
    },
  ],
};

/** A MESSAGE — the universal catch-all write. */
export const MESSAGE_TREE: QuestionTreeDef = {
  tree_id: 'message',
  description:
    'The caller wants to leave a message, have the owner call back, or pass something along ' +
    'that a booking or a role does not cover. Leaving a message stays a message even when ' +
    'it MENTIONS a job in passing — but a call whose SUBJECT is a role, position, ' +
    'contract, or opening to fill is the job tree, no matter how it is phrased ("run it ' +
    'past him", "let him know about a role", "I have a position / contract for him" ' +
    'included).',
  nodes: [
    callerNameNode,
    {
      node_id: 'message_body',
      type: 'text',
      ask:
        'the WHOLE message, in their words — what they want the owner to know or do. It must ' +
        'stand alone: the owner reads this and nothing else, so it has to make sense to ' +
        'someone who did not hear the call. Include the reason they gave when they FIRST said ' +
        'why they were calling, not just the last detail they added. When a follow-up answer ' +
        'adds to it, record the COMBINED message, not the fragment — a reply like "it\'s for ' +
        'programming" is an answer to your question, not a message (2026-08-13, live call: ' +
        'the caller opened with "is he interested in a position in downtown Seattle", then ' +
        'added "it\'s for programming", and the row the owner received said only ' +
        '"It\'s for programming." — no city, no role, no indication anyone was hiring)',
    },
    {
      node_id: 'take_message_action',
      type: 'action',
      tool: 'take_message',
      description: 'save the message so the owner actually receives it',
      requires: [CALLER_NAME, 'message_body'],
    },
  ],
};

/** THE ELSE — a topic no specific tree covers ("a message about a wedding"). */
export const GENERIC_SUBJECT_TREE: QuestionTreeDef = {
  tree_id: 'generic_subject',
  description:
    "The caller's topic has no specific tree (a wedding, an invoice, anything). Pairs with " +
    'the message or booking tree so EVERY topic has questions and a way to finish — no ' +
    'caller ever falls into a hole where the AI has nothing to ask.',
  nodes: [
    {
      node_id: 'subject_details',
      type: 'text',
      ask:
        'what this concerns, in their own words — enough detail that the owner reads it and ' +
        'knows exactly what the call was about',
    },
  ],
};

/**
 * BUYING THE AI SECRETARY ITSELF — the inbound sales call.
 *
 * The product answers its own sales line, so "I want this for MY business" is a
 * distinct purpose from every other tree: it is not a job brought to the owner
 * (that is `job` — a role FOR him), and not a service request (that is a repair).
 * Without its own tree these callers fell to `generic_subject` + message, which
 * asks one vague "what does this concern?" and leaves the owner ringing back
 * cold, knowing nothing about the business he is selling to.
 *
 * NO ACTION NODE, ON PURPOSE. The outcome of a sales call is the DEMO — the
 * tenant's own "Secretary HQ Demonstration" service — so this tree pairs with
 * `booking`, and the appointment IS the write. If they will not book, it pairs
 * with `message`. Giving it its own action node was considered and rejected:
 * the only fitting tool is `attach_meeting_notes`, which errors when no meeting
 * was booked, and an action node that cannot complete holds the goodbye gate
 * open forever — the caller would be trapped on a call that refuses to end.
 * `attach_meeting_notes` is offered as a PASSTHROUGH instead: reachable when a
 * booking exists, harmless when it does not.
 *
 * The questions are the ones that let the owner price and prepare BEFORE the
 * demo. Budget and decision-maker are deliberately absent — they read as pushy
 * on an inbound call, and he can ask them live once someone is on the calendar.
 */
export const BUY_SERVICE_TREE: QuestionTreeDef = {
  tree_id: 'buy_service',
  description:
    'The caller wants to BUY the AI receptionist service for THEIR OWN business — "I saw ' +
    'your AI answers the phone", "how much is this", "I want one of these for my shop", ' +
    'or any interest in the assistant itself as a product. **Distinguish carefully:** a ' +
    'caller offering the OWNER a job or contract is the `job` tree (work FOR him); a caller ' +
    'wanting something repaired is a service request; THIS is a caller who wants to become ' +
    'a customer of the phone system they are talking to. A VAGUE opener — "a business ' +
    'opportunity", "something for my company", "I saw what you do" — is NOT enough to pick ' +
    'between this and `job`: ask what it is about before selecting either, because guessing ' +
    'wrong sends a buyer into a role intake. If you did guess wrong, remove the tree with ' +
    'set_purpose(wrong_trees) — a wrong tree cannot be talked away. Select it alongside ' +
    '`booking` — ' +
    'the demonstration is the goal — or alongside `message` if they will not commit to a ' +
    'time. Once a demo IS booked, pass the answers on with attach_meeting_notes in ONE ' +
    'line, so the owner reads the business, the volume, and what they want handled before ' +
    'he dials.',
  nodes: [
    {
      node_id: 'business_type',
      type: 'text',
      ask:
        'what kind of business they run, in their own words — a salon and a tyre shop want ' +
        'very different things from a receptionist, and this is what the owner prepares against',
    },
    {
      node_id: 'call_volume',
      type: 'text',
      ask:
        'roughly how many calls a day they take — a rough number or a range is a complete ' +
        'answer ("maybe twenty?"), never push for precision they do not have',
    },
    {
      node_id: 'wants_handled',
      type: 'choice',
      ask:
        'what they most want handled — booking appointments, taking messages, answering ' +
        'questions about the business, or all of it. Ask it as a real question, not a menu ' +
        'read aloud; if they describe it in their own words, map it yourself',
      options: {
        // No follow-ups on any branch: this answer steers the DEMO, not more questions.
        booking: [],
        messages: [],
        answering_questions: [],
        everything: [],
      },
    },
    {
      node_id: 'current_setup',
      type: 'choice',
      ask:
        'what happens to their calls today — voicemail, an answering service, a person, or ' +
        'nothing at all. This is the comparison the owner has to beat, so it is worth asking',
      options: {
        voicemail: [],
        answering_service: [
          {
            node_id: 'current_cost',
            type: 'text',
            ask:
              'roughly what that answering service costs them a month — ask it lightly and ' +
              'take a decline gracefully; a number here is what makes the price land, but ' +
              'nobody owes it to you',
          },
        ],
        a_person: [],
        nothing: [],
      },
    },
    {
      node_id: 'best_email',
      type: 'text',
      ask:
        'the best email to send the details to — read it back once to confirm the spelling, ' +
        'the same way a phone number is confirmed. A wrong address is a lead that silently ' +
        'goes nowhere',
    },
    {
      // THE DEMO MUST BE OFFERED, NOT HOPED FOR (2026-07-28 sim, 0/3).
      // This tree has no action node, so it RESOLVES the moment its questions are
      // answered — the checklist read COMPLETE, the model asked "anything else?",
      // and a qualified buyer was shown the door without ever being offered the
      // demonstration. A goal nothing on the checklist asks for does not happen.
      // Making the offer a NODE is what forces the ask; the caller's answer then
      // decides whether `booking` joins the call.
      node_id: 'demo_offer',
      type: 'choice',
      ask:
        'whether they want to see it working — OFFER the demonstration plainly once you have ' +
        'the basics ("I can put you in with the owner for a walkthrough to see it in action. ' +
        'Tell me if you want that."). Record wants_demo if they say yes — then add the booking tree with ' +
        'set_purpose and book a real time. Record not_now if they would rather think about it ' +
        'or just have the details emailed; that is a fine answer and is never pushed twice',
      options: {
        wants_demo: [],
        not_now: [],
      },
    },
  ],
};

/** QUESTIONS — RAG-answered; the tree only marks "they got what they came for". */
export const QA_TREE: QuestionTreeDef = {
  tree_id: 'qa',
  description:
    'The caller has questions about the business — hours, pricing, services, policies, ' +
    'location, background/experience. Answers come from the knowledge base tool, NEVER from ' +
    'memory. A questions-only caller gets answers immediately, with no identity questions first.',
  nodes: [
    {
      node_id: 'qa_summary',
      type: 'text',
      // NEVER A QUESTION TO THE CALLER. 2026-08-15 sim (THE ELSE): Rosa Delgado
      // asked whether Dale would MC a wedding, the knowledge base had nothing,
      // and the agent answered "Could you please summarize your question about
      // Dale for me?" — it read the [ASK] marker and turned its own note-taking
      // into an interrogation of the caller, then closed the call. She had said
      // her name in the first sentence; nothing was kept, and nobody at the
      // business will ever know she rang. The wording now says whose job it is.
      ask:
        'YOU write this, silently — NEVER ask the caller to summarize their own question. ' +
        'Once their questions are answered and they have what they need, record a one-line ' +
        'summary IN YOUR OWN WORDS of what they asked about (it becomes the call record). ' +
        'If the knowledge base could NOT answer them, that is not a call to close: offer to ' +
        'take a message so the owner can follow up, and add the message tree with set_purpose.',
    },
  ],
};

/**
 * A JOB brought TO the owner — the Thinking Hammer vertical. Ported from the
 * rung-era intake (jobIntakeTask.ts): the two-companies rule, the
 * contract/full-time fork, the onsite/remote fork. Dale's contract_to_hire
 * option (2026-07-21 design) added as the third employment fork.
 */
export const JOB_TREE: QuestionTreeDef = {
  tree_id: 'job',
  description:
    'The caller is BRINGING a job, role, position, contract, or hiring opportunity TO the ' +
    'owner — a recruiter, staffing agency, or someone pitching work for the owner to take. ' +
    'NOT a caller asking the business to do work for THEM ("can someone fix my computer" is ' +
    'a service request → booking/fix_computer, even if they call it "a job"). ' +
    '**"Is [the owner] available for work?" / "is he available for a contract?" / "is he taking on ' +
    'projects?" IS this tree** — an availability QUESTION about paid work is a job call in ' +
    'question form, not qa: whether he is available is HIS decision, so the answer is never ' +
    'read from the knowledge base — it is "that\'s his call — let me grab the details so he ' +
    'can come back to you", and the role intake IS that. ' +
    '"I have a position / role / opening I want to run past him" IS this tree — pass-it-along ' +
    'phrasing does not make it a plain message; the role questions ARE the message. ' +
    '"TALK TO / speak with / meet [the owner] about a job" is TWO goals — select job AND ' +
    'booking together: the meeting is what they rang for, the role details are preparation ' +
    'for it (2026-07-21 live call: job alone was selected, the full intake ran, and the ' +
    'caller hung up with nothing in the diary — the oldest failure this product has).',
  nodes: [
    {
      node_id: 'callers_company',
      type: 'text',
      ask:
        'the company the CALLER works for — their own employer or staffing agency. Ask ' +
        '"which company are you calling from?" EVEN IF they already named a client, because ' +
        "the client is a DIFFERENT company. The client's name never goes here",
    },
    {
      node_id: 'hiring_for',
      type: 'choice',
      ask:
        'say both doors in a falling tone, then invite the choice: "I can note this as hiring ' +
        'for your own company, or as placing someone with a client. Tell me which." Two ' +
        'separate companies must never collapse into one — the owner needs to know who ' +
        'called AND where the work is',
      options: {
        own_company: [], // the work is at their own company — never re-ask which
        placing_with_client: [
          {
            node_id: 'client_company',
            type: 'text',
            ask:
              "which company the work would ACTUALLY be for — different from the caller's. " +
              "NEVER fill this with the caller's own company: if they have not NAMED the " +
              'client, ask ("And which company would the work be for?"); if they don\'t ' +
              "know or won't say, record declined — an honest blank beats the agency's " +
              'name in the client slot (2026-07-30 sim: eTeam landed here and the record ' +
              'claimed an in-house role that was actually a placement)',
          },
        ],
      },
    },
    {
      node_id: 'role_description',
      type: 'text',
      ask: "the role itself, in the caller's own words — title, tech, whatever they lead with",
    },
    {
      node_id: 'employment_type',
      type: 'choice',
      ask: 'contract, full time, or contract-to-hire?',
      options: {
        contract: [
          { node_id: 'rate_range', type: 'text', ask: 'the rate range' },
          { node_id: 'contract_length', type: 'text', ask: 'the length of the contract' },
        ],
        full_time: [{ node_id: 'salary_range', type: 'text', ask: 'the salary range' }],
        contract_to_hire: [
          // rate_range is shared with the contract branch — one question, two
          // paths to relevance; an early "it pays 65 to 80" survives either answer.
          { node_id: 'rate_range', type: 'text', ask: 'the rate range' },
          {
            node_id: 'conversion_terms',
            type: 'text',
            ask: 'the conversion terms — how long until it converts to full time',
          },
        ],
      },
    },
    {
      node_id: 'work_mode',
      type: 'choice',
      ask: 'onsite, remote, or hybrid?',
      options: {
        onsite: [{ node_id: 'position_address', type: 'text', ask: 'the address of the position' }],
        hybrid: [{ node_id: 'position_address', type: 'text', ask: 'the address of the position' }],
        remote: [
          {
            node_id: 'team_timezone',
            type: 'text',
            ask: 'tell me what time zone the job is in.',
          },
        ],
      },
    },
    {
      // THE OFFER — live-path port of the ladder's OFFER_MEETING block (PR #306,
      // inert there: prod runs trees). A business taking job calls is selling the
      // owner's TIME, and a recruiter who describes a role and is handed only a
      // recorded inquiry has been served worse than one asked "would you like to
      // talk it through with him?". Offering is not booking: a yes routes through
      // set_purpose → booking tree → the real book_with_scheduling call, and every
      // consent guard on that path stands untouched. Sits at the END of the intake
      // (the walk order is the ask order) so the offer lands when the role is
      // understood — and being a checklist node, the goodbye gate makes the offer
      // STRUCTURAL: the call cannot close with it silently skipped.
      node_id: 'meeting_offer',
      type: 'choice',
      ask:
        'offer ONCE, falling tone with both doors open: "I can schedule a meeting on the ' +
        "owner's calendar so you can talk it through, or just pass the details along. " +
        'Tell me which." A no / details-only is an answer — NEVER offer twice; a repeated ' +
        'offer is a sales pitch. If they already asked for a meeting themselves, record ' +
        'wants_meeting without asking; if they already said "just pass it along" or ' +
        'equivalent, record details_only without asking',
      options: {
        wants_meeting: [],
        details_only: [],
      },
    },
    {
      node_id: 'capture',
      type: 'action',
      tool: 'capture_job_inquiry',
      description: 'record the role for the owner — the write that makes the lead real',
      // Declined answers SATISFY these (2026-07-21 live call: three declines,
      // capture still landed); the tool's own refuse-gate stays authoritative.
      requires: ['callers_company', 'hiring_for', 'employment_type'],
      // Finish the WHOLE intake before the write: the first mock call fired
      // capture with contract length / work mode / timezone still uncollected.
      await_tree: true,
    },
  ],
};

/** CHANGE an existing appointment — cancel or move, never book-new. */
export const SCHEDULE_CHANGE_TREE: QuestionTreeDef = {
  tree_id: 'schedule_change',
  description:
    'The caller wants to CANCEL or RESCHEDULE an appointment they ALREADY have. Booking a ' +
    'NEW time is the booking tree; changing an existing one is this tree — a reschedule is ' +
    'the latter.',
  nodes: [
    {
      node_id: 'change_type',
      type: 'choice',
      ask: 'do they want to cancel the appointment, or move it to another time?',
      options: {
        cancel: [
          {
            node_id: 'cancel_action',
            type: 'action',
            tool: 'cancel_appointment',
            description: 'cancel the appointment they named',
            requires: [CALLER_PHONE],
          },
        ],
        reschedule: [
          {
            node_id: 'reschedule_action',
            type: 'action',
            tool: 'reschedule_appointment',
            description: 'move the appointment to a new open time',
            requires: [CALLER_PHONE],
          },
        ],
      },
    },
  ],
};

/**
 * The computer-repair vertical (built out 2026-07-21 on Dale's go-ahead — was a
 * stub). Three questions and one branch: what's wrong, how they want it
 * serviced, and whether their data is safe. Composes with identity + booking so
 * the repair always ends with a scheduled visit, drop-off, or remote session on
 * the calendar — never a vague "someone will call you".
 */
export const FIX_COMPUTER_TREE: QuestionTreeDef = {
  tree_id: 'fix_computer',
  description:
    'The caller wants THEIR computer or tech looked at, fixed, or built BY us — a service ' +
    'request ("my laptop won\'t boot", "can someone fix my computer"). Even if they say ' +
    '"job", work the caller wants done is THIS, never the job tree. Compose with identity + ' +
    'booking so the repair ends with a scheduled visit or drop-off.',
  nodes: [
    {
      node_id: 'issue_description',
      type: 'text',
      ask:
        "what's wrong, in the caller's own words — the device (laptop, desktop, phone…), " +
        'the symptom, when it started, and anything they already tried. One open question ' +
        '("what\'s going on with it?") usually gets all of this; record the pieces, ask ' +
        'only for what is still missing',
    },
    {
      node_id: 'drop_off_ok',
      type: 'text',
      // NOT a choice — Dale (2026-07-21): "There should not be a question of
      // will it be dropped off. Just state that only drop-off fixes are
      // available right now." (Remote and in-home were removed the same day.)
      ask:
        'STATE — do not ask — that only DROP-OFF repairs are available right now ("right ' +
        'now we do drop-off repairs — you\'d bring the machine to us"), then record whether ' +
        'that works for them. Say it BEFORE the visit is booked. If it does NOT work for ' +
        'them, do not push and do not problem-solve: record their no, remove the ' +
        'fix_computer and booking trees with set_purpose wrong_trees, thank them warmly ' +
        'for calling, and finish_call',
    },
    {
      node_id: 'data_backup',
      type: 'text',
      ask:
        'whether their data is backed up, and whether anything on the machine is ' +
        'irreplaceable (photos, documents, work files). Ask it plainly ("is your data ' +
        'backed up anywhere?") — repairs can involve wiping a drive, and finding out ' +
        'AFTER is the worst conversation this business can have',
    },
  ],
};

/**
 * A PROSPECTIVE CLIENT describing a legal matter, captured so an attorney can
 * decide whether to TAKE the case. Built for a small plaintiff-side firm (one
 * or two lawyers) whose inbound traffic is denied/underpaid insurance claims
 * and personal injury.
 *
 * THIS TREE COLLECTS. IT NEVER ADVISES. The receptionist is not a lawyer and
 * must not behave like one: no opinion on whether a claim is good, what it is
 * worth, whether a deadline has passed, or what the caller should do next. Every
 * such question has exactly one honest answer — "that's for the attorney to
 * say, let me take the details so they can review it." Guessing here is the
 * unauthorized practice of law, and a wrong reassurance ("sounds like you have
 * a case") is worse than silence because the caller will act on it.
 *
 * THE FOUR ANSWERS THAT DECIDE TAKE-OR-DECLINE, and why each is asked rather
 * than listened for. A firm can be handed a beautifully detailed matter and
 * still be unable to touch it:
 *   - `incident_date` — the statute of limitations runs from it. A matter
 *     outside the window is not a case no matter how strong the facts, and a
 *     matter NEAR the window has to jump the queue today.
 *   - `incident_state` — the firm can only act where it is licensed.
 *   - `existing_counsel` — a caller already represented by another lawyer
 *     cannot simply be signed up; this is an ethics wall, not a preference,
 *     and it has to be known before anything is promised.
 *   - `opposing_parties` — the conflict check. A firm that already acts for the
 *     other side, or the insurer, must decline. Names, not vibes.
 *
 * NEVER SAY THE FIRM WILL TAKE THE CASE. Intake is not acceptance, no
 * attorney-client relationship is formed on this call, and the capture tool's
 * own confirmation is the only promise available: the details reach the
 * attorney, who decides.
 */
export const CASE_INTAKE_TREE: QuestionTreeDef = {
  tree_id: 'case_intake',
  description:
    'A prospective client is describing a LEGAL MATTER they want the firm to look at — a ' +
    'denied or underpaid insurance claim, an injury, or another dispute. Select for "my ' +
    'insurance denied my claim", "I was in an accident", "they won\'t pay what they owe me", ' +
    '"I want to sue", "do you handle cases like mine". ' +
    '**"Do you take X kind of case?" IS this tree, not qa** — whether the firm takes a ' +
    "matter is the ATTORNEY's decision made on the facts, so it is never read out of the " +
    'knowledge base as a yes; the knowledge base can say what the firm GENERALLY handles, ' +
    'and the honest reply to a specific matter is "let me take the details so an attorney ' +
    'can review it" — this intake IS that answer. ' +
    'An EXISTING client calling about a matter the firm already has is NOT this tree — that ' +
    'is a message or a booking; this tree is for a NEW matter being brought in. ' +
    'Fee and cost questions ("do you charge up front?", "what do you take?") are qa — they ' +
    'are facts about the firm, not facts about the case. ' +
    'Select case_intake AND booking together when the caller asks to SPEAK WITH or MEET a ' +
    'lawyer about the matter: the consultation is what they rang for and the facts are the ' +
    'preparation for it.',
  nodes: [
    callerNameNode,
    callerPhoneNode,
    {
      // FIRST, and asked before any facts are collected. A represented caller is
      // an ethics wall, not a preference: keeping them talking about the merits
      // of a matter another lawyer already owns is the one intake mistake that
      // can cost the firm rather than just cost it a client.
      node_id: 'existing_counsel',
      type: 'choice',
      ask:
        'whether another lawyer is ALREADY representing them on this matter. Ask it early ' +
        'and plainly ("Is another attorney already representing you on this?"). If yes, do ' +
        'NOT keep collecting the facts of the matter and do not discuss it — say the firm ' +
        'generally cannot step into a matter another lawyer is handling, that you will pass ' +
        'the message along, and let the attorney make that call',
      options: {
        no_counsel: [],
        has_counsel: [
          {
            node_id: 'counsel_situation',
            type: 'text',
            ask:
              'in one line, what they want given that they already have a lawyer — a second ' +
              'opinion, changing firms, or their lawyer has withdrawn. Record it and stop ' +
              'the case questions there; the attorney decides whether this can go further',
          },
        ],
      },
    },
    {
      node_id: 'matter_type',
      type: 'choice',
      ask:
        'what KIND of matter this is, from how they describe it — do not read the list out ' +
        'as a menu, just place what they said. "They denied my claim" / "the adjuster is ' +
        'lowballing me" is insurance_claim. "I got hurt" / "car accident" / "I fell" is ' +
        'injury. Anything else they are bringing to a lawyer is other_matter',
      options: {
        insurance_claim: [
          {
            node_id: 'insurer_name',
            type: 'text',
            ask: 'which insurance company denied, delayed, or underpaid — the company NAME',
          },
          {
            node_id: 'policy_type',
            type: 'text',
            ask:
              'what kind of policy or coverage it is (auto, homeowners, health, disability, ' +
              'life, business). Their own words are fine',
          },
          {
            node_id: 'claim_outcome',
            type: 'choice',
            ask:
              'what the insurer actually DID — denied it outright, paid less than the claim, ' +
              'or is sitting on it without deciding',
            options: {
              denied: [],
              underpaid: [],
              delayed: [],
            },
          },
          {
            node_id: 'stated_reason',
            type: 'text',
            ask:
              "the reason the INSURER gave, in the insurer's words as the caller heard them " +
              '("pre-existing", "not a covered peril", "late filing"). If they were given no ' +
              'reason, record that — a refusal with no stated reason is itself the fact',
          },
          {
            node_id: 'amount_in_dispute',
            type: 'text',
            ask:
              'roughly how much money is in dispute — claimed versus paid. An estimate is ' +
              'fine and "I don\'t know" is an answer; never push for precision on the phone',
          },
          {
            node_id: 'appeal_status',
            type: 'text',
            listen: true,
            ask:
              'whether they have already appealed or asked the insurer to reconsider, and ' +
              'what came of it. Worth catching, not worth an interrogation',
          },
        ],
        injury: [
          {
            node_id: 'injury_circumstances',
            type: 'text',
            ask:
              "what HAPPENED, in the caller's own words — let them tell it and record the " +
              'account rather than breaking it into a form. This paragraph is the single ' +
              'most useful thing the attorney will read',
          },
          {
            node_id: 'injuries_sustained',
            type: 'text',
            ask: 'what injuries they suffered, as they describe them',
          },
          {
            node_id: 'medical_treatment',
            type: 'text',
            ask:
              'whether they have been treated and where — ER, urgent care, their own doctor, ' +
              'or not yet. Do NOT advise them about treatment, only record it',
          },
          {
            node_id: 'at_fault_party',
            type: 'text',
            ask:
              'who they say is responsible — a driver, a business, a property owner, an ' +
              'employer. Their view of it, not a judgement of it',
          },
          {
            node_id: 'gave_statement',
            type: 'choice',
            ask:
              'whether they have already given a recorded statement to, or signed anything ' +
              "for, the other side's insurer. Record it flatly — do not comment on whether " +
              'that was wise, and do not tell them what to do about it now',
            options: {
              gave_statement: [],
              no_statement: [],
              unsure: [],
            },
          },
          {
            node_id: 'lost_income',
            type: 'text',
            listen: true,
            ask: 'whether they have missed work or lost income because of it, if they say so',
          },
          {
            node_id: 'police_report',
            type: 'text',
            listen: true,
            ask: 'whether a police or incident report exists, and the report number if they have it',
          },
        ],
        other_matter: [
          {
            node_id: 'matter_description',
            type: 'text',
            // Deliberately does NOT ask what they want to happen: `desired_outcome`
            // owns that, and asking both put the same question to the caller twice
            // and wrote the same sentence into two fields of the capture.
            ask:
              "what the dispute is, in the caller's own words. Do not try to classify it " +
              "into a legal category — that is the attorney's job",
          },
        ],
      },
    },
    {
      // THE deadline fact. Asked on every branch because every branch has a clock.
      node_id: 'incident_date',
      type: 'text',
      ask:
        "WHEN it happened — the date of the accident, the injury, or the insurer's denial. " +
        'A month and year is enough if they cannot recall the day, and "about two years ago" ' +
        'is a usable answer worth recording exactly as said. NEVER tell them whether a ' +
        'deadline has passed or is close, even if they ask directly and even if it seems ' +
        'obvious: the limitation period depends on facts you do not have, and a wrong ' +
        'reassurance from a receptionist can cost someone their case',
    },
    {
      node_id: 'incident_state',
      type: 'text',
      ask:
        'which STATE the incident or the policy is in — the firm can only act where it is ' +
        'licensed, so this decides whether the matter is reachable at all. Ask plainly ' +
        '("Which state did this happen in?")',
    },
    {
      // The conflict check. Names, because a conflict search runs on names.
      node_id: 'opposing_parties',
      type: 'text',
      ask:
        'the NAMES on the other side — the person, business, or insurance company the matter ' +
        'is against, plus any lawyer or adjuster they have been dealing with. The firm has to ' +
        'run a conflict check before it can act, and that check runs on names',
    },
    {
      node_id: 'deadline_pressure',
      type: 'text',
      listen: true,
      ask:
        'any date already hanging over them — a court date, a hearing, an appeal window, a ' +
        'letter with a deadline on it. Catch it if they mention it and record it verbatim; a ' +
        'dated letter is the difference between a routine review and one that happens today',
    },
    {
      node_id: 'documents_available',
      type: 'text',
      listen: true,
      ask:
        'what paperwork they already have — the policy, the denial letter, medical records, ' +
        'photos, the police report. Never ask them to send anything yet; the attorney will ' +
        'say what is needed',
    },
    {
      node_id: 'desired_outcome',
      type: 'text',
      listen: true,
      ask:
        'what they want out of it, if they say — the claim paid, medical bills covered, or ' +
        'simply to know where they stand. It tells the attorney whether the firm can offer ' +
        'what this caller actually wants',
    },
    {
      node_id: 'capture',
      type: 'action',
      tool: 'capture_case_inquiry',
      description: 'send the matter to the attorney for a take-or-decline review',
      // A name and a number, plus the two facts that decide whether the firm can
      // act at all. Declined answers satisfy these — the tool's own refuse-gate
      // stays authoritative, exactly as on capture_job_inquiry.
      requires: [CALLER_NAME, CALLER_PHONE, 'matter_type', 'existing_counsel'],
      // Finish the intake, THEN write. A half-captured matter reaching an
      // attorney's desk is worse than a slow one: they will make a take/decline
      // call on facts that merely LOOK complete.
      await_tree: true,
    },
  ],
};

/** The library every call starts from, in canonical selection-render order. */
export const PLATFORM_TREE_LIBRARY: QuestionTreeDef[] = [
  IDENTITY_TREE,
  BOOKING_TREE,
  MESSAGE_TREE,
  GENERIC_SUBJECT_TREE,
  QA_TREE,
  JOB_TREE,
  BUY_SERVICE_TREE,
  CASE_INTAKE_TREE,
  SCHEDULE_CHANGE_TREE,
  FIX_COMPUTER_TREE,
  // The 30 per-vertical slot-filling intake trees. Each is reachable through a
  // vertical front-desk preset (presetCatalog reachability enforces this).
  ...VERTICAL_INTAKE_TREES,
];
