-- Falling-tone first_message defaults for business templates.
-- Matches agent voice-prompt rewrites: split stacked "or" questions into a
-- short choice statement + "Tell me which/how I can help."
-- Existing tenants keep their own first_message; this only updates templates
-- (future tenants inherit via the first_message-fill trigger).

UPDATE business_templates
SET first_message =
  'Thanks for calling {{business_name}}! I can help you book an appointment, '
  || 'leave a message, or answer questions about our services. '
  || 'Tell me how I can help.'
WHERE first_message LIKE '%How can I help you today?%';

-- Category templates that still open with a stacked dual question.
UPDATE business_templates SET first_message =
  'Thanks for calling! I can schedule a detail for you. Tell me how I can help.'
WHERE first_message = 'Thanks for calling! Would you like to schedule a detail?';

UPDATE business_templates SET first_message =
  'Thanks for calling! I can help with an estimate, or schedule a repair. Tell me which.'
WHERE first_message = 'Thanks for calling! Do you need an estimate or schedule a repair?';

UPDATE business_templates SET first_message =
  'Thanks for calling! I can schedule an oil change. Tell me how I can help.'
WHERE first_message = 'Thanks for calling! Ready to schedule an oil change?';

UPDATE business_templates SET first_message =
  'Thanks for calling! I can help if your garage door is stuck, or with a new installation. Tell me which.'
WHERE first_message = 'Thanks for calling! Is your garage door stuck, or do you need a new installation?';

UPDATE business_templates SET first_message =
  'Thanks for calling! I can help if you are locked out, or schedule a lock service. Tell me which.'
WHERE first_message = 'Thanks for calling! Are you locked out or need a lock service scheduled?';

UPDATE business_templates SET first_message =
  'Thanks for calling! Tell me what type of insurance we can help you with.'
WHERE first_message = 'Thanks for calling! What type of insurance can we help you with?';

UPDATE business_templates SET first_message =
  'Thanks for calling! Tell me if you are planning an event.'
WHERE first_message = 'Thanks for calling! Are you planning an event?';
