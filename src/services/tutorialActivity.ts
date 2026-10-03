/**
 * A week of "business running" activity for a Tutorial tenant: answered calls
 * with transcripts and outcomes, messages taken, preferences callers
 * mentioned, and a few knowledge-base answers.
 *
 * Why this exists: the Tutorial used to seed only the business SHAPE (services,
 * staff, bays, customers, appointments). Every screen that shows what the AI
 * receptionist DID — Calls, Analytics, Messages, a customer's call history
 * and preferences, the knowledge base — was empty, so a prospect taking the
 * product tour was shown "No call history yet" exactly where the product is
 * supposed to prove itself.
 *
 * Everything here is fictional (555 numbers, invented names) and is written
 * in the exact shapes the live agent writes: outcomes from the agent's own
 * vocabulary (dashboard/components/voice/outcome.tsx), transcripts in
 * TranscriptRecorder's `Speaker [m:ss]: text` format, preference keys from
 * the auto_shop list in shared/preferenceCatalog.ts.
 */

import type { PoolClient } from 'pg';

type Speaker = 'Assistant' | 'Caller';
type Turn = [Speaker, number, string]; // [speaker, seconds into call, words]

export interface TutorialCustomerIds {
  maria: string;
  tyler: string;
  priya: string;
  james: string;
  carmen: string;
}

/** Appointment ids the booked calls link to, keyed by who they are for. */
export interface TutorialAppointmentIds {
  mariaPastOilChange: string;
  priyaBrakeInspection: string;
  carmenOilChange: string;
}

type CustomerKey = keyof TutorialCustomerIds;
type AppointmentKey = keyof TutorialAppointmentIds;

interface TutorialCall {
  key: string;
  /** Minutes before now that the call started. */
  minutesAgo: number;
  customer?: CustomerKey;
  callerPhone: string;
  outcome: string;
  status: 'completed' | 'transferred';
  appointment?: AppointmentKey;
  summary: string;
  turns: Turn[];
}

const GREETING =
  'Thanks for calling Quick Lube Demo, this is the virtual assistant. How can I help?';

export const TUTORIAL_CALLS: readonly TutorialCall[] = [
  {
    key: 'maria-books',
    minutesAgo: 3 * 24 * 60 + 5 * 60,
    customer: 'maria',
    callerPhone: '555-1001',
    outcome: 'booked',
    status: 'completed',
    appointment: 'mariaPastOilChange',
    summary:
      'Maria Santos booked a full synthetic oil change for her 2019 Honda CR-V. She will wait on site and asked for Alex again.',
    turns: [
      ['Assistant', 0, GREETING],
      ['Caller', 4, "Hi, it's Maria Santos. I need an oil change for my CR-V."],
      ['Assistant', 8, 'Happy to help, Maria. Is that the 2019 Honda CR-V we have on file?'],
      ['Caller', 13, "That's the one. Can Alex do it? He did a great job last time."],
      ['Assistant', 18, 'I can put you with Alex. Would you like to wait here or drop it off?'],
      ['Caller', 23, "I'll wait, I'll bring my laptop."],
      ['Assistant', 27, 'Alex has 9 AM or 1 PM open in two days. Which works better?'],
      ['Caller', 31, '9 AM, please.'],
      [
        'Assistant',
        34,
        "You're booked for a full synthetic oil change at 9 AM with Alex, in Bay 1. It takes about 45 minutes. Anything else?",
      ],
      ['Caller', 42, "No, that's it. Thanks!"],
    ],
  },
  {
    key: 'priya-books',
    minutesAgo: 2 * 24 * 60 + 3 * 60,
    customer: 'priya',
    callerPhone: '555-1003',
    outcome: 'booked',
    status: 'completed',
    appointment: 'priyaBrakeInspection',
    summary:
      'Priya Nair booked a brake inspection at 10 AM in two days. Her brakes squeal when stopping. She wants a call before any work over $200.',
    turns: [
      ['Assistant', 0, GREETING],
      ['Caller', 5, 'Hi, my brakes started squealing when I stop. Can someone take a look?'],
      [
        'Assistant',
        10,
        "I'm sorry to hear that. A brake inspection takes about an hour. Can I get your name?",
      ],
      ['Caller', 15, 'Priya Nair.'],
      ['Assistant', 17, 'Thanks, Priya. What are you driving?'],
      ['Caller', 20, 'A 2016 Toyota Camry.'],
      ['Assistant', 23, 'The first opening with Alex is 10 AM, two days from now. Does that work?'],
      [
        'Caller',
        27,
        "Yes. And please call me before doing anything over two hundred dollars, I don't want surprises.",
      ],
      [
        'Assistant',
        33,
        "Noted — we'll call you before any work over $200. You're booked for a brake inspection at 10 AM.",
      ],
    ],
  },
  {
    key: 'carmen-books',
    minutesAgo: 50,
    customer: 'carmen',
    callerPhone: '555-1005',
    outcome: 'booked',
    status: 'completed',
    appointment: 'carmenOilChange',
    summary:
      'Carmen Ortega booked an oil change for tomorrow at 9 AM. She prefers early mornings and email for updates.',
    turns: [
      ['Assistant', 0, GREETING],
      ['Caller', 4, "Hi, I'd like an oil change, as early as you can do tomorrow."],
      ['Assistant', 9, 'Sure. Can I get your name?'],
      ['Caller', 11, 'Carmen Ortega.'],
      ['Assistant', 13, 'Thanks, Carmen. Our first opening tomorrow is 9 AM. Would you like it?'],
      ['Caller', 17, "Perfect. I'm always better first thing in the morning."],
      [
        'Assistant',
        21,
        "You're booked for an oil change tomorrow at 9 AM. How would you like us to reach you if anything changes?",
      ],
      ['Caller', 27, "Email's best."],
      ['Assistant', 29, "Got it, we'll use email. See you tomorrow."],
    ],
  },
  {
    key: 'tyler-message',
    minutesAgo: 2 * 60 + 10,
    customer: 'tyler',
    callerPhone: '555-1002',
    outcome: 'message',
    status: 'completed',
    summary:
      "Tyler Brooks' check engine light is flashing. He asked for a call back today about whether it is safe to drive.",
    turns: [
      ['Assistant', 0, GREETING],
      [
        'Caller',
        4,
        "Hey, it's Tyler Brooks. My check engine light just started flashing. Is it safe to drive it in?",
      ],
      [
        'Assistant',
        11,
        "A flashing light can be serious, so I don't want to guess. Let me take a message and have a technician call you right back. Is 555-1002 the best number?",
      ],
      ['Caller', 20, 'Yes, that works.'],
      [
        'Assistant',
        23,
        "I've marked it urgent. Someone will call you shortly. Until then, it's safest not to drive it far.",
      ],
    ],
  },
  {
    key: 'james-transfer',
    minutesAgo: 35,
    customer: 'james',
    callerPhone: '555-1004',
    outcome: 'transferred',
    status: 'transferred',
    summary:
      'James Whitmore asked to speak with someone about a warranty question on his last repair. Put through to the shop.',
    turns: [
      ['Assistant', 0, GREETING],
      [
        'Caller',
        4,
        "It's James Whitmore. I have a warranty question about the work you did last month. Can I talk to someone?",
      ],
      ['Assistant', 11, "Of course, James. I'll put you through to the shop now."],
    ],
  },
  {
    key: 'hours-question',
    minutesAgo: 26 * 60,
    callerPhone: '555-2201',
    outcome: 'info',
    status: 'completed',
    summary: 'Caller asked about Saturday hours and whether the shop services diesel trucks.',
    turns: [
      ['Assistant', 0, GREETING],
      ['Caller', 4, 'Are you open on Saturdays?'],
      ['Assistant', 7, "We're open Monday to Friday, 8 AM to 5 PM. We're closed on weekends."],
      ['Caller', 12, 'Okay. Do you work on diesel trucks?'],
      [
        'Assistant',
        16,
        'We do oil changes on light-duty diesel pickups. For anything bigger, I can take a message for the shop.',
      ],
      ['Caller', 23, "That's all I needed, thanks."],
    ],
  },
  {
    key: 'price-question',
    minutesAgo: 4 * 24 * 60 + 2 * 60,
    callerPhone: '555-2202',
    outcome: 'price',
    status: 'completed',
    summary:
      'Caller asked the price of a full synthetic oil change. The shop quotes at the counter, so the assistant offered to book or have someone call; the caller said they would shop around.',
    turns: [
      ['Assistant', 0, GREETING],
      ['Caller', 4, 'How much is a full synthetic oil change?'],
      [
        'Assistant',
        7,
        "I don't have a posted price to quote. We give prices at the counter, and I can have someone call you with one. It takes about 45 minutes.",
      ],
      ['Caller', 13, "Hm, okay. I'm going to shop around a bit first."],
      ['Assistant', 17, 'No problem. Call us any time and I can book you in.'],
    ],
  },
  {
    key: 'weekend-request',
    minutesAgo: 3 * 24 * 60 + 60,
    callerPhone: '555-2203',
    outcome: 'no_availability',
    status: 'completed',
    summary: 'Caller wanted a tire rotation on a Saturday; the shop is closed weekends.',
    turns: [
      ['Assistant', 0, GREETING],
      ['Caller', 4, 'Can I get a tire rotation this Saturday?'],
      [
        'Assistant',
        8,
        "I'm sorry, we're closed on weekends. The earliest I have is Monday at 8 AM. Would that work?",
      ],
      ['Caller', 14, "No, weekdays don't work for me. Thanks anyway."],
    ],
  },
  {
    key: 'fleet-message',
    minutesAgo: 5 * 24 * 60 + 4 * 60,
    callerPhone: '555-2204',
    outcome: 'message',
    status: 'completed',
    summary:
      'Linda from Brightside Florist asked about regular service for their 3 delivery vans and wants a call back.',
    turns: [
      ['Assistant', 0, GREETING],
      [
        'Caller',
        4,
        "Hi, this is Linda from Brightside Florist. We have three delivery vans and we're looking for a shop to handle their regular service.",
      ],
      [
        'Assistant',
        12,
        "That sounds like a great fit. I'll have the owner call you to set that up. What's the best number?",
      ],
      ['Caller', 18, '555-2204. Afternoons are best.'],
      [
        'Assistant',
        21,
        "Got it, Linda. I'll pass that along with a note that afternoons are best.",
      ],
    ],
  },
];

interface TutorialMessage {
  call: string;
  customer?: CustomerKey;
  callerName: string;
  phone: string;
  message: string;
  isUrgent: boolean;
}

export const TUTORIAL_MESSAGES: readonly TutorialMessage[] = [
  {
    call: 'tyler-message',
    customer: 'tyler',
    callerName: 'Tyler Brooks',
    phone: '555-1002',
    message:
      'Check engine light is flashing. Wants to know if it is safe to drive in. Please call today.',
    isUrgent: true,
  },
  {
    call: 'fleet-message',
    callerName: 'Linda (Brightside Florist)',
    phone: '555-2204',
    message:
      'Has 3 delivery vans and is looking for a shop for regular service. Call back in the afternoon.',
    isUrgent: false,
  },
];

/** Keys come from the auto_shop list (plus the universal set) in shared/preferenceCatalog.ts. */
export const TUTORIAL_PREFERENCES: readonly {
  customer: CustomerKey;
  key: string;
  value: string;
}[] = [
  { customer: 'maria', key: 'vehicle', value: '2019 Honda CR-V' },
  { customer: 'maria', key: 'preferred_staff', value: 'Alex' },
  { customer: 'maria', key: 'wait_or_drop_off', value: 'Waits on site' },
  { customer: 'priya', key: 'vehicle', value: '2016 Toyota Camry' },
  { customer: 'priya', key: 'approval_threshold', value: 'Call before any work over $200' },
  { customer: 'carmen', key: 'preferred_time_of_day', value: 'Early morning' },
  { customer: 'carmen', key: 'contact_method', value: 'Email' },
];

export const TUTORIAL_KNOWLEDGE: readonly { title: string; content: string }[] = [
  {
    title: 'Hours',
    content: 'We are open Monday to Friday, 8 AM to 5 PM. We are closed on Saturdays and Sundays.',
  },
  {
    title: 'Quotes and walk-ins',
    content:
      'We give price quotes at the counter or by callback. Walk-ins are welcome, but appointments are seen first.',
  },
  {
    title: 'Diesel vehicles',
    content:
      'We do oil changes on light-duty diesel pickups. Heavy-duty diesel work is referred to a partner shop.',
  },
  {
    title: 'Waiting area',
    content: 'Our waiting area has free Wi-Fi and coffee. Most services are done while you wait.',
  },
  {
    title: 'Warranty',
    content:
      'Parts and labor on repairs are covered for 12 months or 12,000 miles, whichever comes first.',
  },
];

/** Render turns in TranscriptRecorder's format: `Speaker [m:ss]: text`, one per line. */
export function renderTranscript(turns: readonly Turn[]): string {
  return turns
    .map(([speaker, sec, text]) => {
      const m = Math.floor(sec / 60);
      const s = String(sec % 60).padStart(2, '0');
      return `${speaker} [${m}:${s}]: ${text}`;
    })
    .join('\n');
}

/** Seconds from the first turn to a few seconds past the last one. */
export function callDurationSeconds(turns: readonly Turn[]): number {
  const last = turns[turns.length - 1];
  return last ? last[1] + 6 : 0;
}

/**
 * Insert the Tutorial activity. Runs inside seedTutorialTenant's transaction and
 * tenant RLS context.
 */
export async function insertTutorialActivity(
  client: PoolClient,
  tenantId: string,
  customers: TutorialCustomerIds,
  appointments: TutorialAppointmentIds
): Promise<void> {
  const callIdFor = (key: string) => `tutorial-${tenantId}-${key}`;

  for (const call of TUTORIAL_CALLS) {
    const customerId = call.customer ? customers[call.customer] : null;
    const duration = callDurationSeconds(call.turns);
    await client.query(
      `INSERT INTO voice_sessions
         (tenant_id, call_id, caller_phone, customer_id, status, started_at, ended_at,
          duration_seconds, transcript, summary, outcome, appointment_id, metadata)
       VALUES ($1, $2, $3, $4, $5,
               now() - make_interval(mins => $6::int),
               now() - make_interval(mins => $6::int) + make_interval(secs => $7::int),
               $7::int, $8, $9, $10, $11, '{"tutorial": true}'::jsonb)`,
      [
        tenantId,
        callIdFor(call.key),
        call.callerPhone,
        customerId,
        call.status,
        call.minutesAgo,
        duration,
        renderTranscript(call.turns),
        call.summary,
        call.outcome,
        call.appointment ? appointments[call.appointment] : null,
      ]
    );
    // A known customer's call also lands in their own call history (CRM).
    if (customerId) {
      await client.query(
        `INSERT INTO call_summaries (tenant_id, customer_id, summary, call_id, created_at)
         VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5::int))`,
        [tenantId, customerId, call.summary, callIdFor(call.key), call.minutesAgo]
      );
    }
  }

  for (const msg of TUTORIAL_MESSAGES) {
    const call = TUTORIAL_CALLS.find((c) => c.key === msg.call);
    await client.query(
      `INSERT INTO customer_messages
         (tenant_id, customer_id, caller_phone, caller_name, callback_phone, message,
          call_id, is_urgent, created_at)
       VALUES ($1, $2, $3, $4, $3, $5, $6, $7, now() - make_interval(mins => $8::int))`,
      [
        tenantId,
        msg.customer ? customers[msg.customer] : null,
        msg.phone,
        msg.callerName,
        msg.message,
        callIdFor(msg.call),
        msg.isUrgent,
        call?.minutesAgo ?? 0,
      ]
    );
  }

  for (const pref of TUTORIAL_PREFERENCES) {
    await client.query(
      `INSERT INTO customer_preferences (tenant_id, customer_id, pref_key, pref_value)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, customers[pref.customer], pref.key, pref.value]
    );
  }

  // No embedding: the knowledge-base screen lists these as-is. Embeddings are
  // an OpenAI call per entry, which the public Tutorial button must not spend.
  for (const doc of TUTORIAL_KNOWLEDGE) {
    await client.query(
      `INSERT INTO tenant_docs (tenant_id, title, content, source)
       VALUES ($1, $2, $3, 'tutorial')`,
      [tenantId, doc.title, doc.content]
    );
  }
}
