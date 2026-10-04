-- Remove the med-spa preset: the HIPAA "delete on sight" cleanup.
--
-- `med-spa` was removed from signup on 2026-09-25 (Dale: "Anything related to
-- HIPAA is a no"; a medical spa performs procedures under a physician and holds
-- health information). Its preset, intake tree and preference list were left
-- behind in code; they are now deleted, so the platform preset list is one
-- shorter and this migration brings the database in line.
--
-- 1. No tenant may hold the removed preset id. Reset any to NULL (= derive from
--    business_type), so the narrower CHECK below can never be violated by an
--    existing row. Signup has been closed to this type since 2026-09-25, so
--    this is expected to touch nothing.
-- 2. Drop the removed intake tree from the question-tree TEMPLATES so a fresh
--    provisioning can never copy it (nodes go with it via ON DELETE CASCADE).
--    Per-tenant copies are not touched here: those tables are under RLS, and a
--    migration run as a non-owner role would silently skip them.
-- 3. Narrow tenants.checklist_preset_id's CHECK to the shipped catalog. Enforced
--    against shared/checklistPresetDerivation.ts by tests/presetCatalogConstraint.test.ts.
--
-- Idempotent.

UPDATE tenants
   SET checklist_preset_id = NULL
 WHERE checklist_preset_id = 'med_spa_front_desk';

DELETE FROM question_tree_templates
 WHERE tree_id = 'med_spa_intake' OR vertical = 'med_spa';

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_checklist_preset_id_valid;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_checklist_preset_id_valid
  CHECK (
    checklist_preset_id IS NULL OR checklist_preset_id IN (
        'auto_shop_front_desk',
        'salon_front_desk',
        'local_service_front_desk',
        'owner_for_hire_front_desk',
        'law_firm_front_desk',
        'mobile_tire_front_desk',
        'car_detailing_front_desk',
        'body_shop_front_desk',
        'oil_change_front_desk',
        'car_wash_front_desk',
        'barbershop_front_desk',
        'nail_salon_front_desk',
        'spa_front_desk',
        'lash_studio_front_desk',
        'plumber_front_desk',
        'electrician_front_desk',
        'hvac_front_desk',
        'pest_control_front_desk',
        'cleaning_front_desk',
        'landscaping_front_desk',
        'garage_door_front_desk',
        'locksmith_front_desk',
        'personal_trainer_front_desk',
        'yoga_studio_front_desk',
        'tax_prep_front_desk',
        'tutoring_front_desk',
        'photography_front_desk',
        'real_estate_front_desk',
        'insurance_front_desk',
        'answering_service_front_desk',
        'bakery_front_desk',
        'catering_front_desk'
    )
  );

COMMENT ON COLUMN tenants.checklist_preset_id IS
  'Optional explicit checklist preset override. NULL = derive from business_type. The allowed list here MUST match PRESET_LIBRARY in agent/src/checklist/presets.ts and ChecklistPresetId in shared/checklistPresetDerivation.ts — presetCatalogConstraint.test.ts enforces it.';
