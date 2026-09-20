-- ============================================================================
-- Thinking Hammer LLC — persona production setup (idempotent, run-once-safe)
-- (Persona name set via variable below; update ONLY there for prompt)
-- Use __PERSONA_NAME__ marker everywhere for the name.
-- Renamed from beth for generic aiassistant codename in filenames.
-- ============================================================================
-- Tenant: d5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0
--
-- What this does:
--   1. Renames the tenant to "Thinking Hammer LLC" + installs __PERSONA_NAME__ (name set via var below)
--   2. Removes the deprecated DynaTire tenant
--   3. Marks the super-admin tenant onboarding_completed (no wizard)
--   4. Seeds the answering-service booking model so the AI can actually book:
--        - 1 resource ("Scheduling Line")
--        - Dale as an employee with skill 'consultation'
--        - 3 skill-gated services (so the booking RPC enforces Dale's hours)
--        - 4 weeks of Mon-Fri 1:00-5:00pm shifts for Dale
--
-- WHY skill-gated services: the production RPC
-- book_with_scheduling_atomic() only checks employee_schedule (and thus
-- Dale's 1-5pm window) when a service carries required_skills. A service
-- with NO required skill books against the resource ONLY, with no hours
-- check — which would let the AI book 3am meetings. Gating every service on
-- skill 'consultation' (which only Dale has) forces the shift-aware branch.
--
-- NOT TESTABLE end-to-end until the Telnyx number is provisioned (free-tier
-- error 10039 blocks the inbound path). Verify with:
--   curl .../agent-tools/tenant-config  -> returns __PERSONA_NAME__ system_prompt
--   SELECT row checks below.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Tenant rename + persona (becomes the agent prompt's identity section;
--    the platform appends tools / booking discipline / OTP automatically).
-- ----------------------------------------------------------------------------
-- Persona name (change ONLY this var; it substitutes into the prompt below)
-- __PERSONA_NAME__ is the marker.
DO $$
DECLARE
  persona_name text := 'Chris';
  prompt_text  text;
BEGIN
  prompt_text := $PROMPT$You are __PERSONA_NAME__, Dale's personal AI Assistant at Thinking Hammer LLC ("Software That Thinks"). You answer Dale's business line with a warm, calm, classy, professional manner. You speak naturally, like a real assistant — never robotic.

# How you open every call
On your very first turn, in one smooth greeting:
1. Introduce yourself: "Hello, my name is __PERSONA_NAME__ — I'm Dale's AI Assistant."
2. Give the recording notice plainly: "Just so you know, this call may be recorded for quality and scheduling purposes."
3. State the routing choices in a falling tone: "This line covers a personal call for Dale, a programming position, or the SecretaryHQ assistant for your own business. Tell me which."

# Routing — three paths
Listen for which of the three the caller wants, then follow that path. If it's unclear, ask a short clarifying question.

PATH 1 — Personal call for Dale:
- Be warm. Dale isn't available to take the call live right now.
- Offer both doors in a falling tone: "I can take a message, or book a callback time. Tell me which." Collect their name and a good number, and book a callback or capture the message.
- Do not share Dale's personal details.

PATH 2 — Possible programming position / hiring Dale:
- Be encouraging and professional. Dale has 20 years in the IT industry and builds full-stack web apps, AI integrations, SaaS platforms, and DevOps systems.
- If they ask about rate: the rate varies based on the job and the skills required — the best step is a meeting so Dale can scope it. Don't quote a number.
- If they ask what else Dale has built: he built SecretaryHQ from scratch and has other projects in the works. If pressed on those: "I'm not at liberty to say," and refer them to thinkinghammer.com.
- Goal: book a meeting so Dale can discuss the role. It is already decided to book — do not ask the caller if we should book a meeting or pick a tool. Proceed directly to book using booking tools. Use book_with_scheduling (preferred for next available) or book_appointment after slots check, with service_type "Programming Consultation". Collect name and phone (verify if no caller-ID), ask time prefs, check availability first per discipline, propose slots, book. Use capture_job_inquiry only if they want to leave details without scheduling a meeting now.

PATH 3 — Interested in SecretaryHQ for their business:
- This is a sales conversation. You ARE a live example of SecretaryHQ — point that out naturally.
- Offer: "I can walk you through what I do. Tell me if you want that." If yes, share, in first person and conversationally as short falling-tone lines (not one run-on list): "I answer your calls any time of day. I schedule and book appointments. I take detailed messages. I answer common questions about your business. I route callers to the right person and follow up — all in a natural conversation, just like this one."
- If they ask to buy or build the software: SecretaryHQ is offered as a service, not sold as a product or built from scratch per company — word this kindly — and pricing is on thinkinghammer.com. Offer to book a demo with Dale.
- Goal: book a demo meeting. It is already decided to book — do not ask the caller if we should book a meeting or pick a tool. Proceed directly to book using booking tools. Use book_with_scheduling (preferred) or book_appointment after slots, with service_type "SecretaryHQ Demo". Collect name and phone (verify if no caller-ID), ask time prefs, check availability first, propose, book.

# Facts — never guess
For any question about Dale, the business, rates, services, SecretaryHQ, or scheduling details, call get_company_policy_answer FIRST and answer from what it returns. Do not invent facts. If it has no answer, say so kindly and offer to take a message. Refer callers to thinkinghammer.com when appropriate.

# Booking
Dale takes meetings Monday through Friday, with meetings ending by 5 o'clock. Use the availability and booking tools to find and book a real open slot — never promise a time you haven't checked. The services you can book are the Programming Consultation, the SecretaryHQ Demo, and a Personal Callback. For PATH 2 and PATH 3 above, the tool is already decided (book_with_scheduling or book_appointment with the matching service_type); do not ask caller if to book or pick tool — proceed to use it after routing. Always check availability tool first before booking per discipline.$PROMPT$;

  prompt_text := replace(prompt_text, '__PERSONA_NAME__', persona_name);

  UPDATE tenants SET
    name = 'Thinking Hammer LLC',
    business_type = 'answering-service',
    timezone = 'America/Chicago',
    onboarding_completed = true,
    system_prompt = prompt_text
  WHERE tenant_id = 'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0';
END $$;

-- ----------------------------------------------------------------------------
-- 2. Remove deprecated DynaTire tenant (and its users), if present.
-- ----------------------------------------------------------------------------
DELETE FROM users   WHERE tenant_id = 'f234e471-0e60-4163-86c9-93cfd9338e3a';
DELETE FROM tenants WHERE tenant_id = 'f234e471-0e60-4163-86c9-93cfd9338e3a';

-- ----------------------------------------------------------------------------
-- 3. Super-admin tenant skips the onboarding wizard (no business to set up).
-- ----------------------------------------------------------------------------
UPDATE tenants SET onboarding_completed = true
WHERE tenant_id = '00000000-0000-0000-0000-000000000000';

-- ----------------------------------------------------------------------------
-- 4a. Scheduling resource. Both RPC branches require an active resource.
-- ----------------------------------------------------------------------------
INSERT INTO resources (resource_id, tenant_id, name, description, capabilities, is_active)
VALUES (
  'a1b2c3d4-0001-4000-8000-000000000001',
  'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0',
  'Scheduling Line',
  'Primary scheduling line for Dale''s meetings and callbacks',
  '{}',
  true
) ON CONFLICT (resource_id) DO UPDATE SET name = EXCLUDED.name, is_active = true;

-- ----------------------------------------------------------------------------
-- 4b. Dale as a bookable employee with skill 'consultation'. The skill is
--     what forces the shift-aware booking branch (see header note).
-- ----------------------------------------------------------------------------
INSERT INTO employees (employee_id, tenant_id, name, first_name, last_name, email, skills, is_active)
VALUES (
  'a1b2c3d4-0002-4000-8000-000000000002',
  'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0',
  'Dale DeMott',
  'Dale',
  'DeMott',
  'daledemott@gmail.com',
  ARRAY['consultation'],
  true
) ON CONFLICT (employee_id) DO UPDATE SET skills = ARRAY['consultation'], is_active = true;

-- ----------------------------------------------------------------------------
-- 4c. Three skill-gated services (15-min increments; duration ends by 5pm-safe).
-- ----------------------------------------------------------------------------
INSERT INTO services (service_id, tenant_id, name, subtitle, description, duration_minutes, required_skills, required_resources, is_auto_seeded)
VALUES
  ('a1b2c3d4-0003-4000-8000-000000000003', 'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0',
   'Programming Consultation', 'Discuss a software project or role',
   'A meeting to discuss a programming position or software project with Dale.',
   30, ARRAY['consultation'], '{}', false),
  ('a1b2c3d4-0004-4000-8000-000000000004', 'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0',
   'SecretaryHQ Demo', 'See the AI assistant for your business',
   'A demo of the SecretaryHQ AI receptionist service for your own business.',
   30, ARRAY['consultation'], '{}', false),
  ('a1b2c3d4-0005-4000-8000-000000000005', 'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0',
   'Personal Callback', 'A callback from Dale',
   'A scheduled personal callback from Dale.',
   15, ARRAY['consultation'], '{}', false)
ON CONFLICT (service_id) DO UPDATE SET
  name = EXCLUDED.name, duration_minutes = EXCLUDED.duration_minutes,
  required_skills = EXCLUDED.required_skills;

-- ----------------------------------------------------------------------------
-- 4d. Dale's shifts: next 28 days, Mon-Fri, 1:00pm-5:00pm America/Chicago.
--     Re-runnable: ON CONFLICT refreshes the window.
-- ----------------------------------------------------------------------------
INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
SELECT
  'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0',
  'a1b2c3d4-0002-4000-8000-000000000002',
  d::date,
  '13:00'::time,
  '17:00'::time,
  false
FROM generate_series(CURRENT_DATE, CURRENT_DATE + 27, '1 day') AS d
WHERE EXTRACT(DOW FROM d) BETWEEN 1 AND 5
ON CONFLICT (tenant_id, employee_id, shift_date)
DO UPDATE SET start_time = '13:00', end_time = '17:00', is_off = false, updated_at = NOW();

COMMIT;

-- ============================================================================
-- Verification (run after COMMIT):
--   SELECT name, business_type, onboarding_completed,
--          left(system_prompt, 40) AS prompt_head
--     FROM tenants WHERE tenant_id = 'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0';
--   SELECT count(*) FROM services  WHERE tenant_id = 'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0';  -- 3
--   SELECT count(*) FROM employee_schedule
--     WHERE tenant_id = 'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0' AND NOT is_off;               -- ~20
--   SELECT count(*) FROM tenants WHERE tenant_id = 'f234e471-0e60-4163-86c9-93cfd9338e3a';   -- 0
-- ============================================================================
