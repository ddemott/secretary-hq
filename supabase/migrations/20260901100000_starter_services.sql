-- Starter services + example resources for every live business template.
--
-- GENERATED FILE — do not hand-edit. Author the content in
-- shared/starterServices.ts and re-run:
--   npx tsx scripts/generate-starter-services-sql.ts
--
-- WHY THIS MIGRATION EXISTS
-- business_templates.example_services was EMPTY for all 31 live business types
-- (measured 2026-09-01), so the setup wizard asked a new owner "What service do
-- you offer?" against a blank list. This fixes databases that already exist;
-- supabase/seed.sql carries the same generated block for fresh rebuilds, and
-- supabase/baseline.sql is regenerated so the two agree.
--
-- The column becomes jsonb. It was text[] — names only, with nowhere to put a
-- description. resolveServiceForBooking's semantic step embeds
-- concat_ws('. ', name, subtitle, description), so a look-first row seeded
-- name-only ("Diagnostic visit") gives "my check engine light is on" almost
-- nothing to match against. The description is what does the retrieval work.
-- Adding a second column instead would have created yet another list that must
-- agree with the first one; this schema has been bitten by that three times.

-- The type conversion is GUARDED so this file is idempotent. Re-running a
-- migration is a normal thing to do — restoring a database from a snapshot,
-- catching a local DB up by hand, or re-applying after a partial failure — and
-- unguarded, the second run dies on
--   COALESCE(example_services, '{}'::text[])
-- because the column is jsonb by then and the two types no longer match. A
-- migration that only works once is a migration that will strand somebody.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'business_templates'
       AND column_name = 'example_services'
       AND data_type = 'ARRAY'
  ) THEN
    ALTER TABLE business_templates ALTER COLUMN example_services DROP DEFAULT;

    -- Existing text[] values become [{"name": ...}] so nothing is lost on the
    -- way through. Every live row is overwritten below anyway; this matters only
    -- for a database holding a value this generator does not know about.
    --
    -- Two steps, not one: Postgres refuses a subquery inside
    -- ALTER COLUMN ... USING ("cannot use subquery in transform expression"), so
    -- the array becomes a jsonb array of STRINGS first, and a plain UPDATE then
    -- lifts each string into an object. NULL folds to '[]' rather than staying
    -- NULL, because every reader treats this column as a list.
    ALTER TABLE business_templates
      ALTER COLUMN example_services TYPE jsonb
      USING to_jsonb(COALESCE(example_services, '{}'::text[]));

    UPDATE business_templates
       SET example_services = COALESCE(
             (SELECT jsonb_agg(jsonb_build_object('name', value))
                FROM jsonb_array_elements_text(example_services) AS value),
             '[]'::jsonb
           )
     WHERE jsonb_typeof(example_services) = 'array'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(example_services) AS e
          WHERE jsonb_typeof(e) = 'string'
       );

  END IF;
END $$;

-- The END STATE is asserted OUTSIDE the guard, unconditionally, and that
-- distinction is not academic — it is the bug this file already caused once.
--
-- When the conversion above was unguarded, a re-run did DROP DEFAULT, then died
-- on the type change (the column was already jsonb, so
-- COALESCE(example_services, '{}'::text[]) no longer type-checks), and left the
-- column jsonb NOT NULL with NO DEFAULT. Every later
-- INSERT INTO business_templates (...) that omitted the column then failed with
-- "null value in column example_services violates not-null constraint".
-- Guarding the conversion alone would not have repaired that database: the guard
-- sees jsonb, skips, and the missing default stays missing forever.
--
-- So the guard covers only the one-way CONVERSION, and the invariants below run
-- every time. All three statements are idempotent.
UPDATE business_templates SET example_services = '[]'::jsonb WHERE example_services IS NULL;

ALTER TABLE business_templates
  ALTER COLUMN example_services SET DEFAULT '[]'::jsonb,
  ALTER COLUMN example_services SET NOT NULL;

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
  example_services  = '[{"name":"Personal training session","is_default":true},{"name":"Intro consultation","description":"Talk through goals and current fitness before recommending a training plan.","look_first":true}]'::jsonb,
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
