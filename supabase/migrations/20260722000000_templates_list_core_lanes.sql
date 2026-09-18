-- Every business template's greeting should INVITE THE CORE LANES up front.
--
-- Dale (2026-07-22): a caller should hear what the business can do before they
-- speak — the same reasoning behind the per-tenant `greeting_menu` (migration
-- 20260721120000), applied to the DEFAULT a new tenant inherits. The old
-- template `first_message` values each asked one vertical-specific question
-- ("Would you like to book a haircut or shave?"), which is fine but does not
-- tell the caller the lanes exist: booking, leaving a message, asking about
-- services.
--
-- This is deliberately GENERIC — no business's specific catalog is hardcoded
-- into every tenant's mouth (the standing rule from the greeting_menu
-- migration). An owner customizes the specifics on the Phone Assistant → AI
-- Persona page; `first_message` is fully owner-editable and overrides this.
--
-- SCOPE: templates only. Existing tenants already carry a non-null
-- `first_message`, so this changes nothing live — it is the default a FUTURE
-- tenant inherits via the first_message-fill trigger when its own is NULL.
--
-- The trailing "How can I help you today?" is deduped by the greeting composer
-- (agent/src/greeting.ts) — the closer re-adds it once, after the disclosure —
-- so it is spoken a single time at the end, not twice.
UPDATE business_templates
SET first_message =
  'Thanks for calling {{business_name}}! I can help you book an appointment, '
  || 'leave a message, or answer questions about our services. '
  || 'Tell me how I can help.';
