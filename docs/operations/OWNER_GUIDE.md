# SecretaryHQ — Owner's Guide

A plain-language guide for business owners: what each dashboard tab does, how to
read your call analytics, and answers to the questions owners ask most. No
technical background needed.

For operators diagnosing an outage, see `docs/operations/RUNBOOK.md` instead.

---

## The dashboard at a glance

When you log in you land on **Home**. The top navigation has two groups:

**Everyday tabs** (everyone on your team sees these):

- **Home** — today's snapshot: upcoming appointments, recent calls, quick stats.
- **Schedule** — the calendar. Book, move, or cancel appointments; see each
  staff member's day.
- **Customers** — your address book. Every caller the AI talks to is saved here,
  not just the ones who booked. Notes and contact preferences live on each
  customer.
- **Calls** — the log of every call your AI receptionist handled: who called,
  what they wanted, whether it booked, and the full transcript.

**Owner tabs** (only owners/managers see these):

- **My Business** — your services, prices, hours (set by staff shifts), and
  business profile.
- **My Team** — staff logins, roles, and the weekly schedule grid.
- **Phone Assistant** — how your AI sounds and behaves, including the
  **AI Persona** page (voice, speaking style, greeting, and "Forward Calls to a
  Person"). This is also where per-company preferences live.

> Front-desk logins only see the everyday tabs. If a front-desk user opens an
> owner-only link, they're sent back to Home.

---

## How to read your call analytics

The analytics panels (on the Calls / Home area) turn raw calls into four
answers. All of them are driven by real call records — nothing is estimated.

### Call Volume

How many calls your AI handled over the period. Use it to spot busy days/weeks
and to confirm the assistant is actually receiving traffic. A sudden drop to
zero usually means a phone-routing problem, not a quiet week — check with your
operator.

### Booking Conversion

Of the calls that came in, how many ended in a booked appointment. A call counts
as "booked" when it created an appointment. This is your headline number: it
tells you how much revenue the assistant is capturing.

- **Low conversion** doesn't always mean the AI failed — many calls are
  questions, not booking attempts. Read it alongside "Why Callers Reached Out".

### Caller Abandonment

Calls that ended without a booking **and** without a clear reason captured. A
high abandonment number is the one to watch — it can mean callers are hanging up
because they couldn't get what they needed. Pair it with the transcripts in the
**Calls** tab to hear what happened.

### Why Callers Reached Out

A breakdown of what non-booking callers actually wanted, sorted into:

- **No availability** — they wanted a time you didn't have open. _Action:_
  consider extending staff shifts (your open hours are the union of staff
  shifts) or adding capacity.
- **Wrong service** — they asked for something you don't offer. _Action:_ maybe
  a service to add, or clearer messaging.
- **Price** — they were shopping on price.
- **Message** — they left a message for a person.
- **Info** — a general question (hours, location, policies).

This panel is the most useful for decisions: it tells you _why_ calls didn't
book, so you know whether to change hours, add services, or improve your
knowledge base.

---

## Making the AI answer questions correctly

Your AI answers caller questions ("Do you take walk-ins?", "What's your
cancellation policy?") from a **knowledge base** you control:

1. During setup you can paste your website URL and the assistant imports answers
   automatically (Phone Assistant → onboarding).
2. You can add or edit individual Q&A entries anytime.
3. If the AI ever gives a wrong or "I don't know" answer, an owner can use the
   built-in **answer debugger** to see exactly which knowledge entries the AI
   considered for a question and how strongly each matched — so you know whether
   to add or reword content.

If a caller asks something the knowledge base doesn't cover, the AI says it
doesn't have that information rather than guessing, and the question is logged so
you can add an answer later.

---

## Frequently asked questions

**Does the AI book real appointments on my calendar?**
Yes. Confirmed bookings are written to your Schedule immediately, and the system
prevents double-booking the same staff member or resource.

**Will it take a caller's preferred time?**
Yes — the assistant asks the caller's preferred day/time, offers open slots, and
widens to the next window if nothing fits. It never imposes a slot.

**What happens if a caller wants a human?**
If you've set a forward number (Phone Assistant → AI Persona → "Forward Calls to
a Person"), the AI can transfer the live call to that number.

**Do callers get reminders?**
Yes — confirmation and reminder messages send by SMS/email, subject to the
caller's consent. Customers can cancel or reschedule from a self-service link
without calling back.

**Is every caller saved, even if they don't book?**
Yes. The assistant identifies callers and saves them to your Customers address
book, so a caller who just asked a question is still a lead you can follow up.

**Who can see what?**
Owners see everything. Front-desk logins see the everyday tabs (Home, Schedule,
Customers, Calls) but not business configuration, team management, or the AI
settings. Sensitive views like the change-history audit log are owner-only.

**Can I export my data?**
Yes — owners can download a complete export of their business data (customers,
appointments, call history, knowledge base, and more).

**How do I change the AI's voice or greeting?**
Phone Assistant → AI Persona. You can set the voice, speaking speed/style, and
the greeting per business.

---

_Questions this guide doesn't answer? The Calls transcripts are the best place to
hear exactly how a specific conversation went._
