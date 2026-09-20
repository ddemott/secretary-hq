-- Add category grouping to business_templates
-- Categories organize business types into logical groups for the sign-up picker

ALTER TABLE business_templates ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Other';
ALTER TABLE business_templates ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- Assign categories to existing templates
UPDATE business_templates SET category = 'Auto & Vehicle', sort_order = 1 WHERE business_type IN ('mobile-tire', 'auto-shop');
UPDATE business_templates SET category = 'Beauty & Personal Care', sort_order = 2 WHERE business_type IN ('salon', 'barbershop', 'nail-salon', 'spa');
UPDATE business_templates SET category = 'Home Services', sort_order = 3 WHERE business_type IN ('plumber', 'electrician', 'hvac', 'pest-control', 'cleaning', 'landscaping');
UPDATE business_templates SET category = 'Fitness & Wellness', sort_order = 4 WHERE business_type IN ('personal-trainer', 'yoga-studio');
UPDATE business_templates SET category = 'Professional Services', sort_order = 5 WHERE business_type IN ('tax-prep', 'tutoring', 'photography');

-- Add new subtypes for Auto & Vehicle
INSERT INTO business_templates (business_type, display_name, category, sort_order, system_prompt_template, first_message, voice_id, default_resource_name, default_resource_description, resource_label, resource_plural, employee_label, employee_plural, booking_label)
VALUES
(
    'car-detailing', 'Car Detailing', 'Auto & Vehicle', 1,
    'You are a professional receptionist for a car detailing shop called {{business_name}}. Help customers book detailing packages. Collect their name, vehicle make/model, and desired service level.',
    'Thanks for calling! I can schedule a detail for you. Tell me how I can help.',
    'pNInz6ovDWjNkhCspfAY', 'Detail Bay 1', 'Main detailing bay',
    'Detail Bay', 'Detail Bays', 'Detailer', 'Detailers', 'Appointment'
),
(
    'body-shop', 'Body & Paint Shop', 'Auto & Vehicle', 1,
    'You are a professional receptionist for an auto body shop called {{business_name}}. Help customers schedule estimates and repairs for body damage, paint, and collision work. Collect their name, vehicle info, and damage description.',
    'Thanks for calling! I can help with an estimate, or schedule a repair. Tell me which.',
    'pNInz6ovDWjNkhCspfAY', 'Paint Booth 1', 'Main paint and body bay',
    'Booth', 'Booths', 'Body Tech', 'Body Techs', 'Appointment'
),
(
    'oil-change', 'Quick Lube / Oil Change', 'Auto & Vehicle', 1,
    'You are a professional receptionist for a quick lube shop called {{business_name}}. Help customers schedule oil changes and fluid services. Collect their name, vehicle make/model, and preferred oil type.',
    'Thanks for calling! I can schedule an oil change. Tell me how I can help.',
    'pNInz6ovDWjNkhCspfAY', 'Lane 1', 'Quick service lane',
    'Lane', 'Lanes', 'Lube Tech', 'Lube Techs', 'Appointment'
),
(
    'car-wash', 'Car Wash', 'Auto & Vehicle', 1,
    'You are a professional receptionist for a car wash called {{business_name}}. Help customers book wash packages and memberships. Collect their name and vehicle type.',
    'Welcome! Would you like to book a wash or ask about memberships?',
    'pNInz6ovDWjNkhCspfAY', 'Wash Bay 1', 'Automated or hand wash bay',
    'Wash Bay', 'Wash Bays', 'Washer', 'Washers', 'Appointment'
),
-- Add new subtypes for Beauty
(
    'med-spa', 'Med Spa / Aesthetics', 'Beauty & Personal Care', 2,
    'You are a professional receptionist for a medical spa called {{business_name}}. Help clients book aesthetic treatments like facials, injectables, and laser services. Collect their name and desired treatment.',
    'Welcome! Are you looking to book a treatment or consultation?',
    '21m00Tcm4llvDq8ikWAM', 'Treatment Room 1', 'Main treatment room',
    'Treatment Room', 'Treatment Rooms', 'Aesthetician', 'Aestheticians', 'Appointment'
),
(
    'lash-studio', 'Lash & Brow Studio', 'Beauty & Personal Care', 2,
    'You are a professional receptionist for a lash and brow studio called {{business_name}}. Help clients book lash extensions, lifts, brow shaping, and tinting. Collect their name and desired service.',
    'Hi there! Would you like to book a lash or brow appointment?',
    '21m00Tcm4llvDq8ikWAM', 'Station 1', 'Lash application station',
    'Station', 'Stations', 'Lash Artist', 'Lash Artists', 'Appointment'
),
-- Add new subtypes for Home Services
(
    'garage-door', 'Garage Door Service', 'Home Services', 3,
    'You are a professional dispatcher for a garage door company called {{business_name}}. Help customers schedule repairs, installations, and maintenance. Collect their name, address, and issue description.',
    'Thanks for calling! I can help if your garage door is stuck, or with a new installation. Tell me which.',
    'pNInz6ovDWjNkhCspfAY', 'Van 1', 'Main service van',
    'Van', 'Vans', 'Installer', 'Installers', 'Service Call'
),
(
    'locksmith', 'Locksmith', 'Home Services', 3,
    'You are a professional dispatcher for a locksmith called {{business_name}}. Help customers schedule lockouts, rekeying, and lock installations. Collect their name, address, and urgency.',
    'Thanks for calling! I can help if you are locked out, or schedule a lock service. Tell me which.',
    'pNInz6ovDWjNkhCspfAY', 'Van 1', 'Mobile locksmith van',
    'Van', 'Vans', 'Locksmith', 'Locksmiths', 'Service Call'
),
-- Add new subtypes for Professional
(
    'real-estate', 'Real Estate Showings', 'Professional Services', 5,
    'You are a professional assistant for a real estate agent at {{business_name}}. Help callers schedule property showings and consultations. Collect their name, phone, and which property they are interested in.',
    'Hi! Are you calling about a property listing?',
    '21m00Tcm4llvDq8ikWAM', 'Office 1', 'Main showing office',
    'Office', 'Offices', 'Agent', 'Agents', 'Showing'
),
(
    'insurance', 'Insurance Agency', 'Professional Services', 5,
    'You are a professional receptionist for an insurance agency called {{business_name}}. Help callers schedule consultations for auto, home, life, and business insurance. Collect their name and what type of coverage they need.',
    'Thanks for calling! Tell me what type of insurance we can help you with.',
    'ErXwSzhRj4IW3zYCt9a2', 'Office 1', 'Consultation office',
    'Office', 'Offices', 'Agent', 'Agents', 'Consultation'
),
-- Food & Beverage (new category)
(
    'bakery', 'Bakery', 'Food & Beverage', 6,
    'You are a friendly receptionist for a bakery called {{business_name}}. Help customers place custom cake orders, schedule catering, and ask about daily specials. Collect their name and order details.',
    'Hi! Are you calling to place an order or ask about today''s specials?',
    '21m00Tcm4llvDq8ikWAM', 'Counter 1', 'Main service counter',
    'Counter', 'Counters', 'Baker', 'Bakers', 'Order'
),
(
    'catering', 'Catering Service', 'Food & Beverage', 6,
    'You are a professional receptionist for a catering company called {{business_name}}. Help customers plan events, get quotes, and schedule tastings. Collect their name, event date, guest count, and preferences.',
    'Thanks for calling! Tell me if you are planning an event.',
    '21m00Tcm4llvDq8ikWAM', 'Kitchen 1', 'Main prep kitchen',
    'Kitchen', 'Kitchens', 'Chef', 'Chefs', 'Event'
)
ON CONFLICT (business_type) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    category = EXCLUDED.category,
    sort_order = EXCLUDED.sort_order,
    system_prompt_template = EXCLUDED.system_prompt_template,
    first_message = EXCLUDED.first_message,
    voice_id = EXCLUDED.voice_id,
    default_resource_name = EXCLUDED.default_resource_name,
    default_resource_description = EXCLUDED.default_resource_description,
    resource_label = EXCLUDED.resource_label,
    resource_plural = EXCLUDED.resource_plural,
    employee_label = EXCLUDED.employee_label,
    employee_plural = EXCLUDED.employee_plural,
    booking_label = EXCLUDED.booking_label;

-- Populate example_services for new types
UPDATE business_templates SET example_services = ARRAY['Full Detail', 'Interior Only', 'Exterior Wash & Wax', 'Ceramic Coating', 'Paint Correction'] WHERE business_type = 'car-detailing';
UPDATE business_templates SET example_services = ARRAY['Collision Repair', 'Paint Job', 'Dent Removal', 'Bumper Repair', 'Insurance Estimate'] WHERE business_type = 'body-shop';
UPDATE business_templates SET example_services = ARRAY['Conventional Oil Change', 'Synthetic Oil Change', 'Transmission Fluid', 'Coolant Flush'] WHERE business_type = 'oil-change';
UPDATE business_templates SET example_services = ARRAY['Basic Wash', 'Premium Wash', 'Full Detail Wash', 'Monthly Membership'] WHERE business_type = 'car-wash';
UPDATE business_templates SET example_services = ARRAY['Botox', 'Filler', 'Chemical Peel', 'Laser Treatment', 'Microneedling'] WHERE business_type = 'med-spa';
UPDATE business_templates SET example_services = ARRAY['Classic Lash Extensions', 'Volume Lash Extensions', 'Lash Lift', 'Brow Shaping', 'Brow Tinting'] WHERE business_type = 'lash-studio';
UPDATE business_templates SET example_services = ARRAY['Garage Door Repair', 'New Door Installation', 'Opener Replacement', 'Spring Repair', 'Annual Maintenance'] WHERE business_type = 'garage-door';
UPDATE business_templates SET example_services = ARRAY['Lockout Service', 'Rekey Locks', 'New Lock Install', 'Key Duplication', 'Safe Opening'] WHERE business_type = 'locksmith';
UPDATE business_templates SET example_services = ARRAY['Buyer Showing', 'Listing Consultation', 'Open House', 'Property Tour'] WHERE business_type = 'real-estate';
UPDATE business_templates SET example_services = ARRAY['Auto Insurance Quote', 'Home Insurance Quote', 'Life Insurance Consult', 'Business Insurance Review'] WHERE business_type = 'insurance';
UPDATE business_templates SET example_services = ARRAY['Custom Cake Order', 'Cupcake Platter', 'Wedding Cake Consult', 'Daily Bread Order'] WHERE business_type = 'bakery';
UPDATE business_templates SET example_services = ARRAY['Event Catering Quote', 'Tasting Session', 'Corporate Lunch', 'Wedding Reception', 'Party Platter'] WHERE business_type = 'catering';
