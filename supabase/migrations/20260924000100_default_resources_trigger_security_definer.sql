-- Self-serve signup failed under the RLS-enforced app role.
--
-- Found 2026-09-24 by tests/integration/emailVerification.realdb.test.ts, the
-- first test to drive POST /register end to end against a real, non-bypass
-- database role (every earlier /register test mocked the pg client).
--
-- The chain: createTenantWithOwner INSERTs a tenants row with no
-- app.current_tenant_id set (the tenant does not exist yet, so there is no
-- context to set). The AFTER INSERT trigger on_tenant_created_resources then
-- runs create_default_resources(), which INSERTs the business type's default
-- resource (a salon chair, a service bay, ...). resources has only
-- tenant_isolation_resources (tenant_id = tenant_ctx_uuid()), and with no
-- context tenant_ctx_uuid() is NULL, so the INSERT violates RLS, the whole
-- registration transaction rolls back, and /register answers 500 for every
-- business type that has a template.
--
-- Production connects as app_user (rolbypassrls = false, verified 2026-08-02),
-- so this reaches prod. It stayed hidden because no one has self-registered
-- since RLS enforcement went live: the 3 prod tenants predate it.
--
-- Fix: the trigger runs as its owner (SECURITY DEFINER), the same pattern as
-- fn_audit_trigger and copy_question_tree_templates_to_tenant. It only ever
-- writes a row for NEW.tenant_id — the tenant being created in the same
-- statement — so it cannot be used to write into another tenant. search_path
-- is pinned so a caller cannot shadow business_templates or resources.

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
        INSERT INTO resources (tenant_id, name, description)
        VALUES (NEW.tenant_id, v_template.default_resource_name, v_template.default_resource_description);
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.create_default_resources() IS
'AFTER INSERT ON tenants: create the business type''s default resource. SECURITY DEFINER because tenant creation has no tenant context yet, and resources RLS would otherwise refuse the row (2026-09-24 fix — /register 500''d under app_user). Writes only for NEW.tenant_id.';
