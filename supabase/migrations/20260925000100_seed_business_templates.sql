-- The first two template businesses: "Auto Shop Template" and "Salon Template".
--
-- See 20260925000000_business_template_tenants.sql for the rules. In short: a
-- new auto shop or salon starts as a COPY of these rows and fills it out;
-- these rows themselves are never changed by the app (a trigger refuses it).
--
-- Deliberately in them: services (no prices), bays/chairs, skills, two
-- placeholder staff to rename, who-does-what, and knowledge-base STARTERS the
-- owner reviews. Deliberately NOT in them: prices, customers, appointments,
-- calls, hours. Starter answers are written to be true for most shops, but
-- they reach callers only after the owner saves them (copies are un-embedded).
--
-- Fixed ids so tests, docs and later migrations can name them.

SELECT set_config('app.template_maintenance', 'on', false);

INSERT INTO tenants (tenant_id, name, business_type, timezone, is_template, template_vertical,
                     resource_label, resource_plural, employee_label, employee_plural, booking_label)
VALUES
  ('7e3a0000-0000-4000-8000-00000000a001', 'Auto Shop Template', 'auto-shop', 'America/Chicago',
   true, 'auto_shop', 'Bay', 'Bays', 'Technician', 'Technicians', 'Appointment'),
  ('7e3a0000-0000-4000-8000-00000000a002', 'Salon Template', 'salon', 'America/Chicago',
   true, 'salon', 'Chair', 'Chairs', 'Stylist', 'Stylists', 'Appointment')
ON CONFLICT (tenant_id) DO NOTHING;

-- The tenants-insert trigger gave each template one generic resource; the
-- templates define their own bays/chairs below.
DELETE FROM resources
 WHERE tenant_id IN ('7e3a0000-0000-4000-8000-00000000a001', '7e3a0000-0000-4000-8000-00000000a002')
   AND NOT EXISTS (SELECT 1 FROM service_resource sr WHERE sr.resource_id = resources.resource_id);

-- ── Auto Shop Template ───────────────────────────────────────────────────────
DO $$
DECLARE
  t uuid := '7e3a0000-0000-4000-8000-00000000a001';
  bay1 uuid; bay2 uuid; bay3 uuid;
  tech1 uuid; tech2 uuid;
  s_oil uuid; s_rot uuid; s_mount uuid; s_brake uuid; s_diag uuid; s_align uuid; s_insp uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM services WHERE tenant_id = t) THEN RETURN; END IF;

  INSERT INTO tenant_skills (tenant_id, name, description) VALUES
    (t, 'Oil Change',      'Engine oil and filter service'),
    (t, 'Tires',           'Mount, balance, rotate and repair tires'),
    (t, 'Brakes',          'Pads, rotors and brake inspection'),
    (t, 'Diagnostics',     'Check-engine lights and electrical faults'),
    (t, 'Alignment',       'Wheel alignment'),
    (t, 'General Service', 'Inspections and general maintenance')
  ON CONFLICT DO NOTHING;

  INSERT INTO resources (tenant_id, name, description) VALUES (t, 'Bay 1', 'Service bay') RETURNING resource_id INTO bay1;
  INSERT INTO resources (tenant_id, name, description) VALUES (t, 'Bay 2', 'Service bay') RETURNING resource_id INTO bay2;
  INSERT INTO resources (tenant_id, name, description) VALUES (t, 'Alignment Bay', 'Bay with the alignment rack') RETURNING resource_id INTO bay3;

  INSERT INTO employees (tenant_id, name, first_name, last_name, skills, is_active)
  VALUES (t, 'Technician 1', 'Technician', '1',
          ARRAY['Oil Change','Tires','Brakes','Diagnostics','Alignment','General Service'], true)
  RETURNING employee_id INTO tech1;
  INSERT INTO employees (tenant_id, name, first_name, last_name, skills, is_active)
  VALUES (t, 'Technician 2', 'Technician', '2', ARRAY['Oil Change','Tires','General Service'], true)
  RETURNING employee_id INTO tech2;

  INSERT INTO services (tenant_id, name, description, duration_minutes, price, required_skills, required_resources)
  VALUES (t, 'Oil Change', 'Oil and filter change', 45, NULL, ARRAY['Oil Change'], ARRAY['Bay 1']) RETURNING service_id INTO s_oil;
  INSERT INTO services (tenant_id, name, description, duration_minutes, price, required_skills, required_resources)
  VALUES (t, 'Tire Rotation', 'Rotate the tires', 30, NULL, ARRAY['Tires'], ARRAY['Bay 1']) RETURNING service_id INTO s_rot;
  INSERT INTO services (tenant_id, name, description, duration_minutes, price, required_skills, required_resources)
  VALUES (t, 'Tire Mount and Balance', 'Mount and balance new tires', 60, NULL, ARRAY['Tires'], ARRAY['Bay 1']) RETURNING service_id INTO s_mount;
  INSERT INTO services (tenant_id, name, description, duration_minutes, price, required_skills, required_resources)
  VALUES (t, 'Brake Inspection', 'Inspect pads, rotors and brake lines', 60, NULL, ARRAY['Brakes'], ARRAY['Bay 1']) RETURNING service_id INTO s_brake;
  INSERT INTO services (tenant_id, name, description, duration_minutes, price, required_skills, required_resources)
  VALUES (t, 'Check Engine Light Diagnostic', 'Read codes and find the cause of a warning light', 60, NULL, ARRAY['Diagnostics'], ARRAY['Bay 1']) RETURNING service_id INTO s_diag;
  INSERT INTO services (tenant_id, name, description, duration_minutes, price, required_skills, required_resources)
  VALUES (t, 'Wheel Alignment', 'Four-wheel alignment', 60, NULL, ARRAY['Alignment'], ARRAY['Alignment Bay']) RETURNING service_id INTO s_align;
  INSERT INTO services (tenant_id, name, description, duration_minutes, price, required_skills, required_resources)
  VALUES (t, 'Vehicle Inspection', 'General safety inspection', 45, NULL, ARRAY['General Service'], ARRAY['Bay 1']) RETURNING service_id INTO s_insp;

  -- Who does what: Technician 1 does everything; Technician 2 the everyday work.
  INSERT INTO service_employee (tenant_id, service_id, employee_id) VALUES
    (t, s_oil, tech1), (t, s_oil, tech2),
    (t, s_rot, tech1), (t, s_rot, tech2),
    (t, s_mount, tech1), (t, s_mount, tech2),
    (t, s_brake, tech1),
    (t, s_diag, tech1),
    (t, s_align, tech1),
    (t, s_insp, tech1), (t, s_insp, tech2);

  -- Where: everyday work in either general bay; alignment only on the rack.
  INSERT INTO service_resource (tenant_id, service_id, resource_id) VALUES
    (t, s_oil, bay1), (t, s_oil, bay2),
    (t, s_rot, bay1), (t, s_rot, bay2),
    (t, s_mount, bay1), (t, s_mount, bay2),
    (t, s_brake, bay1), (t, s_brake, bay2),
    (t, s_diag, bay1), (t, s_diag, bay2),
    (t, s_align, bay3),
    (t, s_insp, bay1), (t, s_insp, bay2);

  INSERT INTO tenant_docs (tenant_id, title, section, content, source) VALUES
    (t, 'Do I need an appointment?', 'Booking',
     'Appointments are recommended so we can have a bay ready for you. Walk-ins are welcome when we have room.', 'template'),
    (t, 'Can I wait while you work on my car?', 'Visit',
     'Yes. Most quick services like oil changes and tire rotations are done while you wait.', 'template'),
    (t, 'Will you call me before doing extra work?', 'Repairs',
     'Yes. We explain what we found and get your approval before doing any work that was not on your appointment.', 'template'),
    (t, 'What should I bring?', 'Visit',
     'Just your vehicle and keys. If you have a wheel lock key, please bring it for tire work.', 'template');
END $$;

-- ── Salon Template ───────────────────────────────────────────────────────────
DO $$
DECLARE
  t uuid := '7e3a0000-0000-4000-8000-00000000a002';
  chair1 uuid; chair2 uuid; chair3 uuid;
  sty1 uuid; sty2 uuid;
  s_wcut uuid; s_mcut uuid; s_kcut uuid; s_blow uuid; s_color uuid; s_high uuid; s_treat uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM services WHERE tenant_id = t) THEN RETURN; END IF;

  INSERT INTO tenant_skills (tenant_id, name, description) VALUES
    (t, 'Cutting',    'Haircuts for all ages'),
    (t, 'Color',      'Single-process color, highlights and toning'),
    (t, 'Styling',    'Blowouts and styling'),
    (t, 'Treatments', 'Conditioning and scalp treatments')
  ON CONFLICT DO NOTHING;

  INSERT INTO resources (tenant_id, name, description) VALUES (t, 'Chair 1', 'Styling chair') RETURNING resource_id INTO chair1;
  INSERT INTO resources (tenant_id, name, description) VALUES (t, 'Chair 2', 'Styling chair') RETURNING resource_id INTO chair2;
  INSERT INTO resources (tenant_id, name, description) VALUES (t, 'Chair 3', 'Styling chair') RETURNING resource_id INTO chair3;

  INSERT INTO employees (tenant_id, name, first_name, last_name, skills, is_active)
  VALUES (t, 'Stylist 1', 'Stylist', '1', ARRAY['Cutting','Color','Styling','Treatments'], true)
  RETURNING employee_id INTO sty1;
  INSERT INTO employees (tenant_id, name, first_name, last_name, skills, is_active)
  VALUES (t, 'Stylist 2', 'Stylist', '2', ARRAY['Cutting','Styling','Treatments'], true)
  RETURNING employee_id INTO sty2;

  INSERT INTO services (tenant_id, name, description, duration_minutes, price, required_skills, required_resources)
  VALUES (t, 'Women''s Haircut', 'Cut and style', 60, NULL, ARRAY['Cutting'], ARRAY['Chair 1']) RETURNING service_id INTO s_wcut;
  INSERT INTO services (tenant_id, name, description, duration_minutes, price, required_skills, required_resources)
  VALUES (t, 'Men''s Haircut', 'Cut and finish', 30, NULL, ARRAY['Cutting'], ARRAY['Chair 1']) RETURNING service_id INTO s_mcut;
  INSERT INTO services (tenant_id, name, description, duration_minutes, price, required_skills, required_resources)
  VALUES (t, 'Kids'' Haircut', 'Haircut for children', 30, NULL, ARRAY['Cutting'], ARRAY['Chair 1']) RETURNING service_id INTO s_kcut;
  INSERT INTO services (tenant_id, name, description, duration_minutes, price, required_skills, required_resources)
  VALUES (t, 'Blowout', 'Wash and blow-dry style', 45, NULL, ARRAY['Styling'], ARRAY['Chair 1']) RETURNING service_id INTO s_blow;
  INSERT INTO services (tenant_id, name, description, duration_minutes, price, required_skills, required_resources)
  VALUES (t, 'Single-Process Color', 'All-over color', 90, NULL, ARRAY['Color'], ARRAY['Chair 1']) RETURNING service_id INTO s_color;
  INSERT INTO services (tenant_id, name, description, duration_minutes, price, required_skills, required_resources)
  VALUES (t, 'Highlights', 'Partial or full highlights', 120, NULL, ARRAY['Color'], ARRAY['Chair 1']) RETURNING service_id INTO s_high;
  INSERT INTO services (tenant_id, name, description, duration_minutes, price, required_skills, required_resources)
  VALUES (t, 'Deep Conditioning Treatment', 'Conditioning treatment', 30, NULL, ARRAY['Treatments'], ARRAY['Chair 1']) RETURNING service_id INTO s_treat;

  -- Stylist 1 does everything; Stylist 2 everything except color.
  INSERT INTO service_employee (tenant_id, service_id, employee_id) VALUES
    (t, s_wcut, sty1), (t, s_wcut, sty2),
    (t, s_mcut, sty1), (t, s_mcut, sty2),
    (t, s_kcut, sty1), (t, s_kcut, sty2),
    (t, s_blow, sty1), (t, s_blow, sty2),
    (t, s_color, sty1),
    (t, s_high, sty1),
    (t, s_treat, sty1), (t, s_treat, sty2);

  INSERT INTO service_resource (tenant_id, service_id, resource_id)
  SELECT t, s, c FROM unnest(ARRAY[s_wcut, s_mcut, s_kcut, s_blow, s_color, s_high, s_treat]) AS s
                CROSS JOIN unnest(ARRAY[chair1, chair2, chair3]) AS c;

  INSERT INTO tenant_docs (tenant_id, title, section, content, source) VALUES
    (t, 'Do you take walk-ins?', 'Booking',
     'Appointments are recommended so a stylist is free for you. We take walk-ins when a chair is open.', 'template'),
    (t, 'Can I request a specific stylist?', 'Booking',
     'Yes. Tell us who you would like to see and we will book you with them when they are available.', 'template'),
    (t, 'What if I need to cancel?', 'Policies',
     'Please let us know as soon as you can so we can offer the time to another client.', 'template'),
    (t, 'Do you do a consultation before color?', 'Color',
     'Yes. Your stylist talks through the look you want before any color service.', 'template');
END $$;

SELECT set_config('app.template_maintenance', 'off', false);
