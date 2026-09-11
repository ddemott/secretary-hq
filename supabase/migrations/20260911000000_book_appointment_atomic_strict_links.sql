-- The dashboard booking RPC and the phone booking RPC disagreed on an
-- UNLINKED service.
--
-- 20260909210000 made book_with_scheduling_atomic (the phone path) STRICT:
-- when p_service_id is known, the skill map's links (service_employee /
-- service_resource) are the whole rule, the employees.skills /
-- services.required_skills tag arrays are never consulted, and a service
-- with no active linked person or room is refused before any search.
--
-- book_appointment_atomic (the dashboard path) was left on the OLD rule: if
-- the mapping tables had zero rows for the service, it fell back to the tag
-- arrays, and if the tags were empty too it fell OPEN — any active employee,
-- any active resource. Same business, same service, two different answers
-- depending on which door the booking came through. Dale, 2026-09-11:
-- "Person -> Role -> Resource" — one rule, not two.
--
-- Fix: when p_service_id is provided, book_appointment_atomic now applies
-- the identical STRICT rule — only ACTIVE service_employee / service_resource
-- links decide, tag arrays are never read, and a service with no active
-- linked person (when an employee is being assigned) or no active linked
-- resource is refused outright rather than falling open or falling back.
--
-- This retires the fall-open "configure-as-you-go" contract the mapping
-- model shipped with (book-appointment-mapping.test.ts's OPEN-SERVICE and
-- LEGACY-FALLBACK cases, now rewritten to expect a refusal) — a service an
-- owner hasn't linked to anyone yet cannot be booked by phone OR dashboard,
-- and the skill map's fix panel (SkillMapFixPanel, `missingEmployees` /
-- `missingResources`) is exactly what tells the owner it needs a link.
-- p_service_id = NULL (legacy callers that never pass a service) is
-- unaffected — that branch was, and remains, skipped entirely.
--
-- required_skills / required_resources / employees.skills are NOT dropped by
-- this migration — book_with_scheduling_atomic still reads them for callers
-- that omit p_service_id, and the columns hold data other tenants may still
-- rely on there. Whether to retire them is the open question CLAUDE.md
-- leaves for later, not this fix.

CREATE OR REPLACE FUNCTION public.book_appointment_atomic(p_tenant_id uuid, p_resource_id uuid, p_customer_id uuid DEFAULT NULL::uuid, p_start_time timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_time timestamp with time zone DEFAULT NULL::timestamp with time zone, p_description text DEFAULT NULL::text, p_call_id text DEFAULT NULL::text, p_location text DEFAULT NULL::text, p_assignment_id text DEFAULT NULL::text, p_service_id uuid DEFAULT NULL::uuid, p_customer_phone text DEFAULT NULL::text, p_customer_name text DEFAULT NULL::text, p_buffer_minutes integer DEFAULT 0)
 RETURNS TABLE(success boolean, appointment_id uuid, error_message text)
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_overlap_exists BOOLEAN;
    v_new_appointment_id UUID;
    v_employee_id UUID := NULL;
    v_user_id UUID := NULL;
    v_tenant_tz TEXT;
    v_actual_customer_id UUID;
    v_start_local TIMESTAMP;
    v_end_local TIMESTAMP;
    v_effective_end TIMESTAMPTZ;
    v_service_duration INTEGER;
    v_on_shift BOOLEAN;
    v_has_active_links BOOLEAN;
    v_buffer INTERVAL;
BEGIN
    v_buffer := (GREATEST(COALESCE(p_buffer_minutes, 0), 0) || ' minutes')::INTERVAL;

    SELECT COALESCE(t.timezone, 'UTC') INTO v_tenant_tz
    FROM tenants t WHERE t.tenant_id = p_tenant_id;
    IF v_tenant_tz IS NULL THEN v_tenant_tz := 'UTC'; END IF;

    IF p_end_time IS NULL AND p_service_id IS NOT NULL THEN
        SELECT s.duration_minutes INTO v_service_duration
        FROM services s WHERE s.service_id = p_service_id AND s.tenant_id = p_tenant_id;
        IF v_service_duration IS NOT NULL THEN
            v_effective_end := p_start_time + (v_service_duration || ' minutes')::INTERVAL;
        ELSE
            RETURN QUERY SELECT FALSE, NULL::UUID, 'Cannot calculate end_time: service not found or has no duration'::TEXT;
            RETURN;
        END IF;
    ELSIF p_end_time IS NULL THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, 'end_time is required when no service_id is provided'::TEXT;
        RETURN;
    ELSE
        v_effective_end := p_end_time;
    END IF;

    IF p_customer_id IS NULL AND p_customer_phone IS NOT NULL THEN
        SELECT customer_id INTO v_actual_customer_id FROM customers
        WHERE tenant_id = p_tenant_id AND phone = p_customer_phone LIMIT 1;
        IF v_actual_customer_id IS NULL THEN
            INSERT INTO customers (tenant_id, phone, name)
            VALUES (p_tenant_id, p_customer_phone, COALESCE(p_customer_name, 'Unknown'))
            RETURNING customer_id INTO v_actual_customer_id;
        END IF;
    ELSE
        v_actual_customer_id := p_customer_id;
    END IF;

    IF v_actual_customer_id IS NULL THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, 'Customer ID or phone number is required'::TEXT;
        RETURN;
    END IF;

    IF p_assignment_id IS NOT NULL AND p_assignment_id <> '' THEN
        IF NOT is_uuid(p_assignment_id) THEN
            RETURN QUERY SELECT FALSE, NULL::UUID,
                ('Invalid assignment_id format: must be a UUID, got "' || p_assignment_id || '"')::TEXT;
            RETURN;
        END IF;

        IF EXISTS (SELECT 1 FROM employees WHERE employee_id = p_assignment_id::UUID AND tenant_id = p_tenant_id) THEN
            v_employee_id := p_assignment_id::UUID;
        ELSIF EXISTS (SELECT 1 FROM users WHERE user_id = p_assignment_id::UUID AND tenant_id = p_tenant_id) THEN
            v_user_id := p_assignment_id::UUID;
        ELSE
            RETURN QUERY SELECT FALSE, NULL::UUID,
                ('Assignment ID not found in employees or users: "' || p_assignment_id || '"')::TEXT;
            RETURN;
        END IF;
    END IF;

    -- STRICT (2026-09-11): the skill map's links decide who and where,
    -- mirroring book_with_scheduling_atomic / 20260909210000. required_skills
    -- / required_resources tags are never consulted when p_service_id is
    -- given — two lists that must agree is the failure this schema has
    -- already paid for three times. A service with no active linked
    -- resource, or (when an employee is being assigned) no active linked
    -- employee, is refused outright rather than falling open.
    IF p_service_id IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM service_resource sr
              JOIN resources res ON res.resource_id = sr.resource_id
             WHERE sr.service_id = p_service_id
               AND sr.tenant_id = p_tenant_id
               AND res.is_active = true
               AND (res.is_deleted IS NULL OR res.is_deleted = false)
        ) INTO v_has_active_links;
        IF NOT v_has_active_links THEN
            RETURN QUERY SELECT FALSE, NULL::UUID,
                'No room or line is set up for this kind of appointment'::TEXT;
            RETURN;
        END IF;
        -- Same ACTIVE + not-deleted contract as the probe above: a link row
        -- surviving after the resource was deactivated or soft-deleted must
        -- not pass this specific-resource check either (Copilot review,
        -- PR #411) — the earlier version only verified the row is_active,
        -- silently ignoring the resource being deleted.
        IF NOT EXISTS (
            SELECT 1 FROM service_resource sr
              JOIN resources res ON res.resource_id = sr.resource_id
             WHERE sr.service_id = p_service_id
               AND sr.resource_id = p_resource_id
               AND sr.tenant_id = p_tenant_id
               AND res.is_active = true
               AND (res.is_deleted IS NULL OR res.is_deleted = false)
        ) THEN
            RETURN QUERY SELECT FALSE, NULL::UUID,
                'Resource is not assigned to perform this service'::TEXT;
            RETURN;
        END IF;

        IF v_employee_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 FROM service_employee se
                  JOIN employees emp ON emp.employee_id = se.employee_id
                 WHERE se.service_id = p_service_id
                   AND se.tenant_id = p_tenant_id
                   AND emp.is_active = true
                   AND (emp.is_deleted IS NULL OR emp.is_deleted = false)
            ) INTO v_has_active_links;
            IF NOT v_has_active_links THEN
                RETURN QUERY SELECT FALSE, NULL::UUID,
                    'No one is assigned to take this kind of appointment'::TEXT;
                RETURN;
            END IF;
            -- Same ACTIVE + not-deleted contract as the probe above (Copilot
            -- review, PR #411) — a link row surviving after the employee was
            -- deactivated or soft-deleted must not pass this specific-employee
            -- check either.
            IF NOT EXISTS (
                SELECT 1 FROM service_employee se
                  JOIN employees emp ON emp.employee_id = se.employee_id
                 WHERE se.service_id = p_service_id
                   AND se.employee_id = v_employee_id
                   AND se.tenant_id = p_tenant_id
                   AND emp.is_active = true
                   AND (emp.is_deleted IS NULL OR emp.is_deleted = false)
            ) THEN
                RETURN QUERY SELECT FALSE, NULL::UUID,
                    'Employee is not assigned to perform this service'::TEXT;
                RETURN;
            END IF;
        END IF;
    END IF;

    -- Resource overlap — padded by the buffer on both sides of the request.
    SELECT EXISTS (
        SELECT 1 FROM appointments
        WHERE resource_id = p_resource_id AND status = 'scheduled'
          AND (is_deleted IS NULL OR is_deleted = false)
          AND start_time < v_effective_end + v_buffer AND end_time > p_start_time - v_buffer
    ) INTO v_overlap_exists;
    IF v_overlap_exists THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, 'Resource already booked during this timeslot'::TEXT;
        RETURN;
    END IF;

    IF v_employee_id IS NOT NULL THEN
        -- Employee overlap — padded by the buffer on both sides of the request.
        SELECT EXISTS (
            SELECT 1 FROM appointments
            WHERE employee_id = v_employee_id AND status = 'scheduled'
              AND (is_deleted IS NULL OR is_deleted = false)
              AND start_time < v_effective_end + v_buffer AND end_time > p_start_time - v_buffer
        ) INTO v_overlap_exists;
        IF v_overlap_exists THEN
            RETURN QUERY SELECT FALSE, NULL::UUID, 'Employee already booked'::TEXT;
            RETURN;
        END IF;

        v_start_local := p_start_time AT TIME ZONE v_tenant_tz;
        v_end_local := v_effective_end AT TIME ZONE v_tenant_tz;

        SELECT EXISTS (
            SELECT 1 FROM employee_schedule
            WHERE employee_id = v_employee_id
              AND tenant_id = p_tenant_id
              AND shift_date = v_start_local::DATE
              AND is_off = false
              AND start_time <= v_start_local::TIME
              AND end_time >= v_end_local::TIME
        ) INTO v_on_shift;

        IF NOT v_on_shift THEN
            IF EXTRACT(DOW FROM v_start_local) <> EXTRACT(DOW FROM v_end_local) THEN
                RETURN QUERY SELECT FALSE, NULL::UUID, 'Appointment spans multiple days and cannot be validated against shifts'::TEXT;
                RETURN;
            END IF;
            RETURN QUERY SELECT FALSE, NULL::UUID, 'Employee is not on shift during this time'::TEXT;
            RETURN;
        END IF;

    ELSIF v_user_id IS NOT NULL THEN
        -- User overlap — padded by the buffer on both sides of the request.
        SELECT EXISTS (
            SELECT 1 FROM appointments
            WHERE assigned_to_user_id = v_user_id AND status = 'scheduled'
              AND (is_deleted IS NULL OR is_deleted = false)
              AND start_time < v_effective_end + v_buffer AND end_time > p_start_time - v_buffer
        ) INTO v_overlap_exists;
        IF v_overlap_exists THEN
            RETURN QUERY SELECT FALSE, NULL::UUID, 'User already booked'::TEXT;
            RETURN;
        END IF;
    END IF;

    BEGIN
        INSERT INTO appointments (
            tenant_id, resource_id, customer_id, start_time, end_time,
            description, call_id, status, location, employee_id, assigned_to_user_id,
            service_id
        ) VALUES (
            p_tenant_id, p_resource_id, v_actual_customer_id, p_start_time, v_effective_end,
            COALESCE(p_description, 'Appointment'), p_call_id, 'scheduled', p_location,
            v_employee_id, v_user_id,
            p_service_id
        ) RETURNING appointments.appointment_id INTO v_new_appointment_id;
    EXCEPTION WHEN exclusion_violation THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, 'Resource already booked during this timeslot'::TEXT;
        RETURN;
    END;

    RETURN QUERY SELECT TRUE, v_new_appointment_id, NULL::TEXT;
END;
$function$;

COMMENT ON FUNCTION public.book_appointment_atomic IS
'Atomic booking, dashboard path. p_buffer_minutes (default 0) pads appointment-overlap
checks to enforce a minimum gap between back-to-back bookings.
STRICT service links (2026-09-11): when p_service_id is given, only ACTIVE
service_employee / service_resource links decide who and where — the
required_skills / required_resources tag arrays are never consulted, and a
service with no active linked resource (or, when an employee is being
assigned, no active linked employee) is refused before any other check.
Matches book_with_scheduling_atomic (20260909210000). p_service_id = NULL
skips the whole block, unchanged.';
