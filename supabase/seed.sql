-- Seed Data for SecretaryHQ SaaS (Platform + Demo Tenants)
-- All test data is Chicago / Chicagoland / Chicago suburbs

-- 0. Create a Platform Tenant for the SecretaryHQ Admin (Super Admin)
--    onboarding_completed = true: super-admin has no business to configure,
--    so skip the setup wizard entirely.
INSERT INTO tenants (tenant_id, name, business_type, timezone, onboarding_completed)
VALUES (
    '00000000-0000-0000-0000-000000000000',
    'SecretaryHQ Platform',
    'platform-admin',
    'America/Chicago',
    true
) ON CONFLICT (tenant_id) DO UPDATE SET onboarding_completed = true;

-- 0b. Create a SecretaryHQ Admin User (Platform Admin)
INSERT INTO users (tenant_id, email, password_hash, full_name)
VALUES ('00000000-0000-0000-0000-000000000000', 'admin@secretaryhq.com', '$2b$12$saB6q9myHS/lHi6.R0oNh.cPivd3E7gCJSk6Q0vxsPDcCZM2v7lEC', 'SecretaryHQ Admin')
ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash;

-- 1. Thinking Hammer LLC tenant + Dale's personal owner account.
--    Separates Dale's super-admin platform rights (admin@secretaryhq.com)
--    from his real-business owner identity (daledemott@gmail.com).
INSERT INTO tenants (tenant_id, name, business_type, timezone)
VALUES (
    'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0',
    'Thinking Hammer LLC',
    'answering-service',
    'America/Chicago'
) ON CONFLICT (tenant_id) DO UPDATE SET name = 'Thinking Hammer LLC';

INSERT INTO users (tenant_id, email, password_hash, full_name, role)
VALUES (
    'd5e3c6a1-7b9f-4e2a-bf30-8c11a5d8e9f0',
    'daledemott@gmail.com',
    '$2b$12$saB6q9myHS/lHi6.R0oNh.cPivd3E7gCJSk6Q0vxsPDcCZM2v7lEC',
    'Dale DeMott',
    'owner'
) ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name;

-- 1b. Remove stale DynaTire tenant if it exists (deprecated 2026-06-02)
DELETE FROM users WHERE tenant_id = 'f234e471-0e60-4163-86c9-93cfd9338e3a';
DELETE FROM tenants WHERE tenant_id = 'f234e471-0e60-4163-86c9-93cfd9338e3a';

-- 1c. SECURITY: ensure daledemott@gmail.com exists ONLY on Thinking Hammer,
-- never on the platform/super-admin tenant. A stray duplicate on
-- 00000000 was found in prod 2026-06-02 — it gave Dale's personal email
-- super-admin rights AND made /login resolve his account to the wrong
-- tenant. The design (CLAUDE.md) keeps his business identity strictly
-- separate from the super-admin identity (admin@secretaryhq.com).
DELETE FROM users
 WHERE email = 'daledemott@gmail.com'
   AND tenant_id = '00000000-0000-0000-0000-000000000000';

-- 2. (intentionally empty) Resources are NOT seeded.
-- 3. (intentionally empty) Customers are NOT seeded.
-- 4. (intentionally empty) Appointments are NOT seeded.
-- 5. (intentionally empty) Services, employees, shifts, and the
--    service↔employee/resource mapping tables are NOT seeded either.
--
-- Principle (locked 2026-05-18): seed data starts bare-bones. ONLY the
-- minimum a tenant needs to exist (the tenant row itself + an owner user
-- to log in as) ships in the seed. Every other entity — resources,
-- services, employees, shifts, customers, appointments — is the
-- responsibility of the test that needs it: create in `beforeAll`,
-- delete in `afterAll`.
--
-- Why: pre-strip seed accumulated 17 stray appointments + 12 customers
-- across `db:rebuild` runs (date-derived rows never hit a real ON
-- CONFLICT), so tests ran against a polluted DB that grew silently. A
-- bare-bones seed is a predictable starting state for every test, and a
-- test failure is provably the code or the test — never "the seed left
-- something behind."
--
-- The previous DynaTire business-config layer (resources, services, 3
-- employees, 2-week shift window, service-mapping tables) moved into
-- `dashboard/e2e/helpers/fixtures.ts::seedDynaTireBusinessConfig` on
-- 2026-05-18. The 5 booking specs that rely on those exact rows call
-- the fixture in their beforeAll and tear it down in afterAll.

-- 5. Bella's Hair Studio — salon-vertical demo tenant. Uses a FIXED
--    tenant_id so repeated `db:rebuild` runs are idempotent. The
--    earlier pattern used gen_random_uuid() with ON CONFLICT DO
--    NOTHING, which never conflicted (new UUID every run) and so
--    spawned a fresh duplicate Bella's on every rebuild — by
--    2026-05-18 the local DB had 2 of them.
INSERT INTO tenants (tenant_id, name, business_type, timezone)
VALUES (
    'b3e1aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    'Bella''s Hair Studio',
    'salon',
    'America/Chicago'
) ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO users (tenant_id, email, password_hash, full_name, role)
VALUES (
    'b3e1aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    'bella@bellashair.com',
    '$2b$12$saB6q9myHS/lHi6.R0oNh.cPivd3E7gCJSk6Q0vxsPDcCZM2v7lEC',
    'Bella Rossi',
    'owner'
) ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name;

-- 6-9. (intentionally empty) Services / employees / shifts / service-mapping
-- rows are set up per-test in fixtures. See block-comment above (sections 2-5).

-- 10. Business Templates — vocabulary + display metadata.
-- WHY THIS IS HERE: baseline.sql has only the schema (no data). The rebuild
-- script's --baseline mode marks historical migrations applied without running
-- them, so the template INSERT/UPDATE migrations never execute after a rebuild.
-- Seeding here is idempotent (ON CONFLICT DO UPDATE) and ensures every
-- rebuild ends with the correct vocabulary labels, category groups, and
-- default-resource names that /vocabulary, /templates, and the
-- apply_business_template_defaults trigger all depend on.
-- system_prompt_template and first_message seed as '' (empty) — real values
-- come from the original insert migrations which run before seed in CI.
-- ON CONFLICT UPDATE intentionally omits them so migration data is preserved.
INSERT INTO business_templates (
  business_type, display_name, category, sort_order,
  resource_label, resource_plural, employee_label, employee_plural, booking_label,
  voice_id, default_resource_name, default_resource_description,
  example_services, example_resources,
  system_prompt_template, first_message
) VALUES
  ('auto-shop',         'Auto Repair Shop',               'Auto & Vehicle',          1, 'Bay',            'Bays',            'Mechanic',       'Mechanics',       'Appointment',  'pNInz6ovDWjNkhCspfAY', 'Service Bay 1',     'Standard repair and maintenance bay',  '[]'::jsonb, '{}', '', ''),
  ('body-shop',         'Body & Paint Shop',              'Auto & Vehicle',          1, 'Booth',          'Booths',          'Body Tech',      'Body Techs',      'Appointment',  'pNInz6ovDWjNkhCspfAY', 'Paint Booth 1',     'Main paint and body bay',              '[]'::jsonb, '{}', '', ''),
  ('car-detailing',     'Car Detailing',                  'Auto & Vehicle',          1, 'Detail Bay',     'Detail Bays',     'Detailer',       'Detailers',       'Appointment',  'pNInz6ovDWjNkhCspfAY', 'Detail Bay 1',      'Main detailing bay',                   '[]'::jsonb, '{}', '', ''),
  ('car-wash',          'Car Wash',                       'Auto & Vehicle',          1, 'Wash Bay',       'Wash Bays',       'Washer',         'Washers',         'Appointment',  'pNInz6ovDWjNkhCspfAY', 'Wash Bay 1',        'Automated or hand wash bay',           '[]'::jsonb, '{}', '', ''),
  ('mobile-tire',       'Mobile Tire Shop',               'Auto & Vehicle',          1, 'Truck',          'Trucks',          'Technician',     'Technicians',     'Appointment',  'ba124806-6962-4354-94a0-7607775952f4', 'Service Truck 1', 'Main mobile unit for tire repairs',  '[]'::jsonb, '{}', '', ''),
  ('oil-change',        'Quick Lube / Oil Change',        'Auto & Vehicle',          1, 'Lane',           'Lanes',           'Lube Tech',      'Lube Techs',      'Appointment',  'pNInz6ovDWjNkhCspfAY', 'Lane 1',            'Quick service lane',                   '[]'::jsonb, '{}', '', ''),
  ('barbershop',        'Barbershop',                     'Beauty & Personal Care',  2, 'Chair',          'Chairs',          'Barber',         'Barbers',         'Appointment',  'pNInz6ovDWjNkhCspfAY', 'Chair 1',           'Main barber chair',                    '[]'::jsonb, '{}', '', ''),
  ('lash-studio',       'Lash & Brow Studio',             'Beauty & Personal Care',  2, 'Station',        'Stations',        'Lash Artist',    'Lash Artists',    'Appointment',  '21m00Tcm4llvDq8ikWAM', 'Station 1',         'Lash application station',             '[]'::jsonb, '{}', '', ''),
  ('med-spa',           'Med Spa / Aesthetics',           'Beauty & Personal Care',  2, 'Treatment Room', 'Treatment Rooms', 'Aesthetician',   'Aestheticians',   'Appointment',  '21m00Tcm4llvDq8ikWAM', 'Treatment Room 1',  'Main treatment room',                  '[]'::jsonb, '{}', '', ''),
  ('nail-salon',        'Nail Salon',                     'Beauty & Personal Care',  2, 'Station',        'Stations',        'Nail Tech',      'Nail Techs',      'Appointment',  '21m00Tcm4llvDq8ikWAM', 'Station 1',         'Nail technician station',              '[]'::jsonb, '{}', '', ''),
  ('salon',             'Hair Salon',                     'Beauty & Personal Care',  2, 'Chair',          'Chairs',          'Stylist',        'Stylists',        'Appointment',  '21m00Tcm4llvDq8ikWAM', 'Styling Station 1', 'Main chair for hair services',         '[]'::jsonb, '{}', '', ''),
  ('spa',               'Spa & Wellness',                 'Beauty & Personal Care',  2, 'Treatment Room', 'Treatment Rooms', 'Therapist',      'Therapists',      'Session',      '21m00Tcm4llvDq8ikWAM', 'Treatment Room 1',  'Main treatment room',                  '[]'::jsonb, '{}', '', ''),
  ('personal-trainer',  'Personal Training',              'Fitness & Wellness',      4, 'Studio',         'Studios',         'Trainer',        'Trainers',        'Session',      'pNInz6ovDWjNkhCspfAY', 'Studio 1',          'Training studio',                      '[]'::jsonb, '{}', '', ''),
  ('yoga-studio',       'Yoga Studio',                    'Fitness & Wellness',      4, 'Studio',         'Studios',         'Instructor',     'Instructors',     'Class',        '21m00Tcm4llvDq8ikWAM', 'Studio 1',          'Main yoga studio',                     '[]'::jsonb, '{}', '', ''),
  ('bakery',            'Bakery',                         'Food & Beverage',         6, 'Counter',        'Counters',        'Baker',          'Bakers',          'Order',        '21m00Tcm4llvDq8ikWAM', 'Counter 1',         'Main service counter',                 '[]'::jsonb, '{}', '', ''),
  ('catering',          'Catering Service',               'Food & Beverage',         6, 'Kitchen',        'Kitchens',        'Chef',           'Chefs',           'Event',        '21m00Tcm4llvDq8ikWAM', 'Kitchen 1',         'Main prep kitchen',                    '[]'::jsonb, '{}', '', ''),
  ('cleaning',          'Cleaning Service',               'Home Services',           3, 'Team',           'Teams',           'Cleaner',        'Cleaners',        'Booking',      '21m00Tcm4llvDq8ikWAM', 'Team A',            'Cleaning crew',                        '[]'::jsonb, '{}', '', ''),
  ('electrician',       'Electrical Service',             'Home Services',           3, 'Van',            'Vans',            'Electrician',    'Electricians',    'Service Call', 'pNInz6ovDWjNkhCspfAY', 'Van 1',             'Main service van',                     '[]'::jsonb, '{}', '', ''),
  ('garage-door',       'Garage Door Service',            'Home Services',           3, 'Van',            'Vans',            'Installer',      'Installers',      'Service Call', 'pNInz6ovDWjNkhCspfAY', 'Van 1',             'Main service van',                     '[]'::jsonb, '{}', '', ''),
  ('hvac',              'HVAC Service',                   'Home Services',           3, 'Van',            'Vans',            'Technician',     'Technicians',     'Service Call', 'pNInz6ovDWjNkhCspfAY', 'Van 1',             'Main service van',                     '[]'::jsonb, '{}', '', ''),
  ('landscaping',       'Landscaping Service',            'Home Services',           3, 'Crew',           'Crews',           'Crew Lead',      'Crew Leads',      'Job',          'pNInz6ovDWjNkhCspfAY', 'Crew A',            'Landscaping crew',                     '[]'::jsonb, '{}', '', ''),
  ('locksmith',         'Locksmith',                      'Home Services',           3, 'Van',            'Vans',            'Locksmith',      'Locksmiths',      'Service Call', 'pNInz6ovDWjNkhCspfAY', 'Van 1',             'Mobile locksmith van',                 '[]'::jsonb, '{}', '', ''),
  ('pest-control',      'Pest Control',                   'Home Services',           3, 'Van',            'Vans',            'Technician',     'Technicians',     'Service Call', 'pNInz6ovDWjNkhCspfAY', 'Van 1',             'Main service van',                     '[]'::jsonb, '{}', '', ''),
  ('plumber',           'Plumbing Service',               'Home Services',           3, 'Van',            'Vans',            'Plumber',        'Plumbers',        'Service Call', 'pNInz6ovDWjNkhCspfAY', 'Van 1',             'Main service van',                     '[]'::jsonb, '{}', '', ''),
  ('answering-service', 'Answering & Scheduling Service', 'Professional Services',   0, 'Line',           'Lines',           'Staff',          'Staff',           'Meeting',      'clara',                'Main Office',       'Primary scheduling line',              '[]'::jsonb, '{}', '', ''),
  ('insurance',         'Insurance Agency',               'Professional Services',   5, 'Office',         'Offices',         'Agent',          'Agents',          'Consultation', 'ErXwSzhRj4IW3zYCt9a2', 'Office 1',         'Consultation office',                  '[]'::jsonb, '{}', '', ''),
  ('photography',       'Photography Studio',             'Professional Services',   5, 'Studio',         'Studios',         'Photographer',   'Photographers',   'Session',      '21m00Tcm4llvDq8ikWAM', 'Studio 1',         'Main photography studio',              '[]'::jsonb, '{}', '', ''),
  ('real-estate',       'Real Estate Showings',           'Professional Services',   5, 'Office',         'Offices',         'Agent',          'Agents',          'Showing',      '21m00Tcm4llvDq8ikWAM', 'Office 1',         'Main showing office',                  '[]'::jsonb, '{}', '', ''),
  ('tax-prep',          'Tax Preparation',                'Professional Services',   5, 'Office',         'Offices',         'Preparer',       'Preparers',       'Appointment',  'ErXwSzhRj4IW3zYCt9a2', 'Office 1',         'Tax preparation office',               '[]'::jsonb, '{}', '', ''),
  ('tutoring',          'Tutoring Service',               'Professional Services',   5, 'Room',           'Rooms',           'Tutor',          'Tutors',          'Session',      '21m00Tcm4llvDq8ikWAM', 'Room 1',            'Tutoring room',                       '[]'::jsonb, '{}', '', ''),
  -- Routes to the law_firm_front_desk checklist preset (case_intake tree) via
  -- defaultChecklistPresetIdForBusinessType. 'Matter' is the booking label
  -- because a law firm books a CONSULTATION about a matter, not an appointment
  -- for a service — the vocabulary the dashboard shows an attorney should be
  -- the one they already use.
  ('law-firm',          'Law Firm',                       'Professional Services',   5, 'Office',         'Offices',         'Attorney',       'Attorneys',       'Consultation', 'ErXwSzhRj4IW3zYCt9a2', 'Office 1',          'Consultation office',                  '[]'::jsonb, '{}', '', '')
ON CONFLICT (business_type) DO UPDATE SET
  display_name             = EXCLUDED.display_name,
  category                 = EXCLUDED.category,
  sort_order               = EXCLUDED.sort_order,
  resource_label           = EXCLUDED.resource_label,
  resource_plural          = EXCLUDED.resource_plural,
  employee_label           = EXCLUDED.employee_label,
  employee_plural          = EXCLUDED.employee_plural,
  booking_label            = EXCLUDED.booking_label,
  voice_id                 = COALESCE(business_templates.voice_id, EXCLUDED.voice_id),
  default_resource_name    = EXCLUDED.default_resource_name,
  default_resource_description = EXCLUDED.default_resource_description;

-- BEGIN GENERATED: starter services (scripts/generate-starter-services-sql.ts)
-- Author the content in shared/starterServices.ts, then re-run the generator.
-- Hand-edits here are overwritten and fail `npm run verify:starter-services`.
UPDATE business_templates SET
  example_services  = '[{"name":"Phone consultation","is_default":true},{"name":"Meeting"}]'::jsonb,
  example_resources = ARRAY['Line 1', 'Line 2']::text[]
 WHERE business_type = 'answering-service';
UPDATE business_templates SET
  example_services  = '[{"name":"Diagnostic visit","description":"Look at a noise, a warning light, a leak, or anything that feels wrong, and say what the repair will take.","look_first":true,"is_default":true},{"name":"Oil Change"},{"name":"Tire Rotation"}]'::jsonb,
  example_resources = ARRAY['Bay 1', 'Bay 2']::text[]
 WHERE business_type = 'auto-shop';
UPDATE business_templates SET
  example_services  = '[{"name":"Custom order consult","description":"Talk through a custom cake or large order — the date, the size, the flavours, and what it will cost.","look_first":true,"is_default":true},{"name":"Cake tasting"}]'::jsonb,
  example_resources = ARRAY['Counter 1', 'Counter 2']::text[]
 WHERE business_type = 'bakery';
UPDATE business_templates SET
  example_services  = '[{"name":"Haircut","is_default":true},{"name":"Beard trim"},{"name":"Haircut & beard"}]'::jsonb,
  example_resources = ARRAY['Chair 1', 'Chair 2']::text[]
 WHERE business_type = 'barbershop';
UPDATE business_templates SET
  example_services  = '[{"name":"Damage estimate","description":"Look at collision, dent, or scrape damage and quote what the repair costs and how long it takes.","look_first":true,"is_default":true},{"name":"Dent repair"},{"name":"Paint touch-up"}]'::jsonb,
  example_resources = ARRAY['Booth 1', 'Booth 2']::text[]
 WHERE business_type = 'body-shop';
UPDATE business_templates SET
  example_services  = '[{"name":"Detail consultation","description":"Look at the vehicle and recommend the right detail package for its condition.","look_first":true,"is_default":true},{"name":"Express interior clean"}]'::jsonb,
  example_resources = ARRAY['Detail Bay 1', 'Detail Bay 2']::text[]
 WHERE business_type = 'car-detailing';
UPDATE business_templates SET
  example_services  = '[{"name":"Express wash","is_default":true},{"name":"Hand wash"}]'::jsonb,
  example_resources = ARRAY['Wash Bay 1', 'Wash Bay 2']::text[]
 WHERE business_type = 'car-wash';
UPDATE business_templates SET
  example_services  = '[{"name":"Event consult","description":"Talk through the event — the date, the headcount, the venue, and the kind of meal — before quoting.","look_first":true,"is_default":true},{"name":"Tasting"}]'::jsonb,
  example_resources = ARRAY['Kitchen 1', 'Kitchen 2']::text[]
 WHERE business_type = 'catering';
UPDATE business_templates SET
  example_services  = '[{"name":"Walkthrough estimate","description":"Walk the home or office, see the size and condition, and quote the right clean and how long it takes.","look_first":true,"is_default":true},{"name":"One-time clean"}]'::jsonb,
  example_resources = ARRAY['Team 1', 'Team 2']::text[]
 WHERE business_type = 'cleaning';
UPDATE business_templates SET
  example_services  = '[{"name":"Service call","description":"Come out, find the electrical problem — a dead outlet, a tripping breaker, flickering lights — and say what the fix takes.","look_first":true,"is_default":true},{"name":"Outlet or switch install"},{"name":"Lighting install"}]'::jsonb,
  example_resources = ARRAY['Van 1', 'Van 2']::text[]
 WHERE business_type = 'electrician';
UPDATE business_templates SET
  example_services  = '[{"name":"Service call","description":"Come out, find why the door won''t open, close, or is making noise, and say what the fix takes.","look_first":true,"is_default":true},{"name":"Spring replacement"},{"name":"Opener install"}]'::jsonb,
  example_resources = ARRAY['Van 1', 'Van 2']::text[]
 WHERE business_type = 'garage-door';
UPDATE business_templates SET
  example_services  = '[{"name":"Service call","description":"Come out, find why the heat or air conditioning isn''t working right, and say what the fix takes.","look_first":true,"is_default":true},{"name":"Tune-up"},{"name":"Thermostat install"}]'::jsonb,
  example_resources = ARRAY['Van 1', 'Van 2']::text[]
 WHERE business_type = 'hvac';
UPDATE business_templates SET
  example_services  = '[{"name":"Insurance quote","is_default":true},{"name":"Policy review"}]'::jsonb,
  example_resources = ARRAY['Office 1', 'Office 2']::text[]
 WHERE business_type = 'insurance';
UPDATE business_templates SET
  example_services  = '[{"name":"Walkthrough estimate","description":"Walk the property, see the work, and quote it.","look_first":true,"is_default":true},{"name":"Lawn mowing"}]'::jsonb,
  example_resources = ARRAY['Crew 1', 'Crew 2']::text[]
 WHERE business_type = 'landscaping';
UPDATE business_templates SET
  example_services  = '[{"name":"Lash fill","is_default":true},{"name":"Lash consultation","description":"Look at the natural lashes and recommend the right set and length.","look_first":true}]'::jsonb,
  example_resources = ARRAY['Station 1', 'Station 2']::text[]
 WHERE business_type = 'lash-studio';
UPDATE business_templates SET
  example_services  = '[{"name":"Consultation","description":"Talk through the situation, what happened and when, and whether the firm can take it on.","look_first":true,"is_default":true},{"name":"Case status call"}]'::jsonb,
  example_resources = ARRAY['Office 1', 'Office 2']::text[]
 WHERE business_type = 'law-firm';
UPDATE business_templates SET
  example_services  = '[{"name":"Service call","description":"Come out, look at the lock, key, or door, and say what it takes to get it working.","look_first":true,"is_default":true},{"name":"Lockout"},{"name":"Rekey"}]'::jsonb,
  example_resources = ARRAY['Van 1', 'Van 2']::text[]
 WHERE business_type = 'locksmith';
UPDATE business_templates SET
  example_services  = '[{"name":"Aesthetic consultation","description":"Talk through skin or body goals, look at what is needed, and recommend a treatment plan.","look_first":true,"is_default":true},{"name":"Follow-up visit"}]'::jsonb,
  example_resources = ARRAY['Treatment Room 1', 'Treatment Room 2']::text[]
 WHERE business_type = 'med-spa';
UPDATE business_templates SET
  example_services  = '[{"name":"Flat repair","is_default":true},{"name":"Tire replacement"},{"name":"Tire rotation"}]'::jsonb,
  example_resources = ARRAY['Truck 1', 'Truck 2']::text[]
 WHERE business_type = 'mobile-tire';
UPDATE business_templates SET
  example_services  = '[{"name":"Manicure","is_default":true},{"name":"Pedicure"},{"name":"Gel manicure"}]'::jsonb,
  example_resources = ARRAY['Station 1', 'Station 2']::text[]
 WHERE business_type = 'nail-salon';
UPDATE business_templates SET
  example_services  = '[{"name":"Oil Change","is_default":true},{"name":"Tire Rotation"}]'::jsonb,
  example_resources = ARRAY['Lane 1', 'Lane 2']::text[]
 WHERE business_type = 'oil-change';
UPDATE business_templates SET
  example_services  = '[{"name":"Personal training session","is_default":true},{"name":"Intro consultation","description":"Talk through goals, injuries, and current fitness before recommending a training plan.","look_first":true}]'::jsonb,
  example_resources = ARRAY['Studio 1', 'Studio 2']::text[]
 WHERE business_type = 'personal-trainer';
UPDATE business_templates SET
  example_services  = '[{"name":"Inspection visit","description":"Come out, identify the pest and how far it has spread, and say what treatment it needs.","look_first":true,"is_default":true},{"name":"Treatment visit"}]'::jsonb,
  example_resources = ARRAY['Van 1', 'Van 2']::text[]
 WHERE business_type = 'pest-control';
UPDATE business_templates SET
  example_services  = '[{"name":"Session consultation","description":"Talk through the shoot — what it is for, where, how many people, and how long it needs.","look_first":true,"is_default":true},{"name":"Headshot session"}]'::jsonb,
  example_resources = ARRAY['Studio 1', 'Studio 2']::text[]
 WHERE business_type = 'photography';
UPDATE business_templates SET
  example_services  = '[{"name":"Service call","description":"Come out, find the leak, blockage, or drip, and say what the fix takes.","look_first":true,"is_default":true},{"name":"Drain cleaning"}]'::jsonb,
  example_resources = ARRAY['Van 1', 'Van 2']::text[]
 WHERE business_type = 'plumber';
UPDATE business_templates SET
  example_services  = '[{"name":"Showing","is_default":true},{"name":"Buyer consult","description":"Talk through what the buyer is looking for, their budget, and their timeline before showing homes.","look_first":true}]'::jsonb,
  example_resources = ARRAY['Office 1', 'Office 2']::text[]
 WHERE business_type = 'real-estate';
UPDATE business_templates SET
  example_services  = '[{"name":"Haircut","is_default":true},{"name":"Color"},{"name":"New-client consult","description":"Talk through what a new client wants before booking the right service and the right amount of time.","look_first":true}]'::jsonb,
  example_resources = ARRAY['Chair 1', 'Chair 2']::text[]
 WHERE business_type = 'salon';
UPDATE business_templates SET
  example_services  = '[{"name":"Massage","is_default":true},{"name":"Facial"}]'::jsonb,
  example_resources = ARRAY['Treatment Room 1', 'Treatment Room 2']::text[]
 WHERE business_type = 'spa';
UPDATE business_templates SET
  example_services  = '[{"name":"Tax consultation","description":"Talk through the return — what changed this year, which documents are needed, and what it will cost.","look_first":true,"is_default":true},{"name":"Individual return drop-off"}]'::jsonb,
  example_resources = ARRAY['Office 1', 'Office 2']::text[]
 WHERE business_type = 'tax-prep';
UPDATE business_templates SET
  example_services  = '[{"name":"Intro session","description":"Meet the student, find where they are stuck, and set a plan for the subject.","look_first":true,"is_default":true},{"name":"Tutoring session"}]'::jsonb,
  example_resources = ARRAY['Room 1', 'Room 2']::text[]
 WHERE business_type = 'tutoring';
UPDATE business_templates SET
  example_services  = '[{"name":"Class drop-in","is_default":true},{"name":"Private session"}]'::jsonb,
  example_resources = ARRAY['Studio 1', 'Studio 2']::text[]
 WHERE business_type = 'yoga-studio';
-- END GENERATED: starter services

-- ── Booking-readiness backfill (mirrors migration 20260630000000) ──────────
-- Runs last so any seeded tenant can actually book: (1) every employee mapped
-- to a service holds that service's required_skills (else the booking RPC
-- returns NO_SKILLED_EMPLOYEE), and (2) each tenant has a default_service_id
-- the agent falls through to when a caller doesn't name a matchable service.
-- Idempotent — safe to re-run.
UPDATE employees e
SET skills = ARRAY(SELECT DISTINCT unnest(COALESCE(e.skills, '{}') || agg.req)),
    updated_at = NOW()
FROM (
  SELECT se.employee_id, array_agg(DISTINCT rs) AS req
  FROM service_employee se
  JOIN services s ON s.service_id = se.service_id
  CROSS JOIN LATERAL unnest(COALESCE(s.required_skills, '{}')) AS rs
  GROUP BY se.employee_id
) agg
WHERE e.employee_id = agg.employee_id
  AND NOT (COALESCE(e.skills, '{}') @> agg.req);

UPDATE tenants t
SET default_service_id = (
  SELECT s.service_id FROM services s
  WHERE s.tenant_id = t.tenant_id
    AND COALESCE(s.is_deleted, false) = false
    AND EXISTS (SELECT 1 FROM service_employee se WHERE se.service_id = s.service_id)
  ORDER BY ABS(COALESCE(s.duration_minutes, 30) - 30) ASC, s.name ASC
  LIMIT 1
)
WHERE t.default_service_id IS NULL;
