-- Template businesses: a new business starts as a COPY of one (Dale 2026-09-25).
--
-- Each supported business type has one TEMPLATE business stored as ordinary
-- rows — "Auto Shop Template", "Salon Template" — with services, bays/chairs,
-- skills, placeholder staff, who-does-what links, and knowledge-base starters.
-- When a customer picks that business, copy_business_template_to_tenant()
-- duplicates those rows into the customer's own tenant; the customer then
-- fills out THEIR copy in the setup wizard.
--
-- Rules, all enforced here rather than by convention:
--   * A template is NEVER changed. Every write to a template's rows is refused
--     by a trigger unless the session sets app.template_maintenance = 'on'
--     (only a migration does). No app code path can alter it.
--   * The copy is theirs. New UUIDs for every row; nothing references the
--     template afterwards, so a later template edit cannot reach a customer and
--     a customer edit cannot reach the template.
--   * No prices. Services carry price NULL — the product never sets a
--     business's prices (Dale: "we never deal with their money").
--   * No customers, calls or appointments — a template holds business SHAPE only.
--   * Knowledge starters are copied WITHOUT an embedding. search_tenant_docs
--     only matches embedded rows, so a starter the owner has not reviewed is
--     never read to a caller; saving it in the dashboard embeds it.
--   * Copied services/resources/staff are marked is_auto_seeded, so the
--     existing business-type-change cleanup (POST /tenants/:id/update-config)
--     swaps them for the new type's template without touching anything the
--     owner typed.

-- ── 1. Mark template businesses ─────────────────────────────────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS is_template boolean NOT NULL DEFAULT false,
  -- The vertical this template serves (verticalForBusinessType's output, e.g.
  -- 'auto_shop', 'salon'). Exactly one template per vertical.
  ADD COLUMN IF NOT EXISTS template_vertical text;

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_template_vertical_iff_template;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_template_vertical_iff_template
  CHECK (is_template = (template_vertical IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS tenants_one_template_per_vertical
  ON tenants (template_vertical) WHERE is_template;

-- Placeholder staff come from a template too, so they must be swappable on a
-- business-type change exactly like services and resources already are.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS is_auto_seeded boolean NOT NULL DEFAULT false;

-- create_default_resources() (20260924000100) inserts the business type's
-- one generic resource on tenant creation but never tagged it is_auto_seeded
-- — the column didn't exist yet when that trigger was written. Section 3
-- below relies on that tag to tell a throwaway placeholder apart from a
-- resource the owner made themselves, so tag it here too, or the copy's
-- placeholder cleanup can't safely find its target.
CREATE OR REPLACE FUNCTION public.create_default_resources()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_template business_templates%ROWTYPE;
BEGIN
    SELECT * INTO v_template FROM business_templates WHERE business_type = NEW.business_type;

    IF FOUND THEN
        INSERT INTO resources (tenant_id, name, description, is_auto_seeded)
        VALUES (NEW.tenant_id, v_template.default_resource_name, v_template.default_resource_description, true);
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.create_default_resources() IS
'AFTER INSERT ON tenants: create the business type''s default resource, tagged is_auto_seeded so a template copy or business-type change can tell it apart from a resource the owner made themselves. SECURITY DEFINER because tenant creation has no tenant context yet, and resources RLS would otherwise refuse the row (2026-09-24 fix — /register 500''d under app_user). Writes only for NEW.tenant_id.';

-- ── 2. Templates are read-only ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tenant_is_template(p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT COALESCE((SELECT is_template FROM tenants WHERE tenant_id = p_tenant_id), false)
$$;

CREATE OR REPLACE FUNCTION refuse_template_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  IF current_setting('app.template_maintenance', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_tenant := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  IF tenant_is_template(v_tenant)
     OR (TG_OP = 'UPDATE' AND tenant_is_template(OLD.tenant_id)) THEN
    RAISE EXCEPTION 'Template businesses are read-only (% on %)', TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  -- Everything a template holds, plus the tables that must never gain rows
  -- under a template (customers, bookings, calls, messages, users).
  FOREACH t IN ARRAY ARRAY[
    'services', 'resources', 'tenant_skills', 'employees', 'service_employee',
    'service_resource', 'tenant_docs', 'employee_schedule', 'customers',
    'appointments', 'voice_sessions', 'customer_messages', 'customer_preferences',
    'users', 'tenant_question_trees'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS refuse_template_write ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER refuse_template_write BEFORE INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION refuse_template_write()', t);
  END LOOP;
END $$;

-- The template's own tenants row: no UPDATE/DELETE, and no tenant may be
-- turned into (or out of) a template outside maintenance.
CREATE OR REPLACE FUNCTION refuse_template_tenant_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_setting('app.template_maintenance', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' AND NEW.is_template THEN
    RAISE EXCEPTION 'Template businesses can only be created by a migration'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.is_template THEN
    RAISE EXCEPTION 'Template businesses are read-only (% on tenants)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.is_template THEN
    RAISE EXCEPTION 'A business cannot be turned into a template'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS refuse_template_tenant_change ON tenants;
CREATE TRIGGER refuse_template_tenant_change
  BEFORE INSERT OR UPDATE OR DELETE ON tenants
  FOR EACH ROW EXECUTE FUNCTION refuse_template_tenant_change();

-- TRUNCATE skips row triggers, so it gets its own statement-level guard: a
-- truncate of any table a template lives in is refused while a template
-- exists (maintenance aside). Test cleanup that wipes the database on purpose
-- sets the flag first.
CREATE OR REPLACE FUNCTION refuse_template_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_setting('app.template_maintenance', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM tenants WHERE is_template) THEN
    RAISE EXCEPTION 'Template businesses are read-only (TRUNCATE on %)', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenants', 'services', 'resources', 'tenant_skills', 'employees',
    'service_employee', 'service_resource', 'tenant_docs'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS refuse_template_truncate ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER refuse_template_truncate BEFORE TRUNCATE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION refuse_template_truncate()', t);
  END LOOP;
END $$;

-- ── 3. The copy ─────────────────────────────────────────────────────────────
-- Returns true when a template was copied, false when there is nothing to do
-- (no template for this vertical, or the business already has services — the
-- copy never merges into or overwrites an owner's own catalog).
CREATE OR REPLACE FUNCTION copy_business_template_to_tenant(p_tenant_id uuid, p_vertical text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_template uuid;
BEGIN
  IF tenant_is_template(p_tenant_id) THEN
    RAISE EXCEPTION 'Cannot copy a template into a template';
  END IF;

  SELECT tenant_id INTO v_template
    FROM tenants WHERE is_template AND template_vertical = p_vertical;
  IF v_template IS NULL THEN
    RETURN false;
  END IF;

  IF EXISTS (SELECT 1 FROM services WHERE tenant_id = p_tenant_id AND is_deleted = false) THEN
    RETURN false;
  END IF;

  -- The business-type trigger (create_default_resources) may already have
  -- given this brand-new business one generic resource. The template brings
  -- its own bays/chairs, so drop that placeholder if nothing uses it yet.
  -- Scoped to is_auto_seeded = true so this never reaches an owner's OWN
  -- resource — e.g. one they created but haven't linked to a service yet —
  -- which would otherwise look identically "unused" and be deleted by
  -- mistake on a later business-type change.
  DELETE FROM resources r
   WHERE r.tenant_id = p_tenant_id
     AND r.is_auto_seeded = true
     AND NOT EXISTS (SELECT 1 FROM service_resource sr WHERE sr.resource_id = r.resource_id)
     AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.resource_id = r.resource_id);

  INSERT INTO tenant_skills (tenant_id, name, description)
  SELECT p_tenant_id, name, description FROM tenant_skills WHERE tenant_id = v_template
  ON CONFLICT DO NOTHING;

  CREATE TEMP TABLE _tpl_resource_map (old_id uuid, new_id uuid) ON COMMIT DROP;
  CREATE TEMP TABLE _tpl_service_map (old_id uuid, new_id uuid) ON COMMIT DROP;
  CREATE TEMP TABLE _tpl_employee_map (old_id uuid, new_id uuid) ON COMMIT DROP;

  INSERT INTO _tpl_resource_map
  SELECT resource_id, gen_random_uuid() FROM resources
   WHERE tenant_id = v_template AND is_deleted = false;
  INSERT INTO resources (resource_id, tenant_id, name, description, is_active, capabilities, is_personal, is_auto_seeded)
  SELECT m.new_id, p_tenant_id, r.name, r.description, r.is_active, r.capabilities, r.is_personal, true
    FROM resources r JOIN _tpl_resource_map m ON m.old_id = r.resource_id;

  INSERT INTO _tpl_service_map
  SELECT service_id, gen_random_uuid() FROM services
   WHERE tenant_id = v_template AND is_deleted = false;
  INSERT INTO services (service_id, tenant_id, name, description, subtitle, duration_minutes,
                        required_skills, required_resources, price, is_auto_seeded, embedding)
  SELECT m.new_id, p_tenant_id, s.name, s.description, s.subtitle, s.duration_minutes,
         s.required_skills, s.required_resources, NULL, true, s.embedding
    FROM services s JOIN _tpl_service_map m ON m.old_id = s.service_id;

  INSERT INTO _tpl_employee_map
  SELECT employee_id, gen_random_uuid() FROM employees
   WHERE tenant_id = v_template AND is_deleted = false;
  INSERT INTO employees (employee_id, tenant_id, name, first_name, last_name, skills, is_active, is_auto_seeded)
  SELECT m.new_id, p_tenant_id, e.name, e.first_name, e.last_name, e.skills, e.is_active, true
    FROM employees e JOIN _tpl_employee_map m ON m.old_id = e.employee_id;

  INSERT INTO service_employee (tenant_id, service_id, employee_id)
  SELECT p_tenant_id, sm.new_id, em.new_id
    FROM service_employee se
    JOIN _tpl_service_map sm ON sm.old_id = se.service_id
    JOIN _tpl_employee_map em ON em.old_id = se.employee_id
   WHERE se.tenant_id = v_template;

  INSERT INTO service_resource (tenant_id, service_id, resource_id)
  SELECT p_tenant_id, sm.new_id, rm.new_id
    FROM service_resource sr
    JOIN _tpl_service_map sm ON sm.old_id = sr.service_id
    JOIN _tpl_resource_map rm ON rm.old_id = sr.resource_id
   WHERE sr.tenant_id = v_template;

  INSERT INTO tenant_docs (tenant_id, title, section, content, source, embedding, normalized_text)
  SELECT p_tenant_id, title, section, content, 'template', NULL, NULL
    FROM tenant_docs WHERE tenant_id = v_template;

  DROP TABLE _tpl_resource_map;
  DROP TABLE _tpl_service_map;
  DROP TABLE _tpl_employee_map;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION copy_business_template_to_tenant(uuid, text) IS
  'Duplicate the template business for a vertical into a new business''s own rows (services with no price, resources, skills, placeholder staff, links, un-embedded knowledge starters). Never modifies the template. No-op (false) when there is no template or the business already has services.';

-- Don't leave this cross-tenant SECURITY DEFINER RPC executable by untrusted
-- roles — same reasoning and pattern as reap_stale_voice_sessions
-- (20260625000000). It takes an arbitrary p_tenant_id with no check that the
-- caller owns it, trusting the app route to have already gated that; PUBLIC
-- (and, on Supabase, the PostgREST-exposed anon/authenticated roles) should
-- not be able to call it directly. app_user is unaffected: it holds its own
-- standing EXECUTE grant via the app_user_role migration's ALTER DEFAULT
-- PRIVILEGES (20260724000100), not the PUBLIC grant this revokes.
REVOKE ALL ON FUNCTION copy_business_template_to_tenant(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION tenant_is_template(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION copy_business_template_to_tenant(uuid, text) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION tenant_is_template(uuid) FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION copy_business_template_to_tenant(uuid, text) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION tenant_is_template(uuid) FROM authenticated';
  END IF;
END $$;
