-- book_appointment_atomic (the dashboard booking path) never modeled night
-- shifts, by design at the time: it validated one chosen resource/employee
-- against ONE day's employee_schedule row (`shift_date = v_start_local::DATE`),
-- with no concept of a shift dated the evening before reaching into today's
-- early morning. That was named a deliberate, pre-existing, out-of-scope gap
-- in CLAUDE.md/TODO alongside the phone path's identical bug, which was fixed
-- in book_with_scheduling_atomic and availabilitySearch.ts by
-- 20260911010000's shift_row_covers_booking().
--
-- Concretely: an employee scheduled 22:00->06:00, dated the evening it
-- starts. A dashboard user manually booking that employee for 2:00-3:00 AM
-- the NEXT calendar day looked for an employee_schedule row dated THAT day
-- and found nothing — "Employee is not on shift during this time" — even
-- though the shift plainly covers 2 AM.
--
-- Fix: reuse shift_row_covers_booking() (already shared by three other call
-- sites) instead of the ad-hoc single-day comparison. Checks both today's
-- and yesterday's shift_date, and only pulls yesterday's row in when it's a
-- genuine wrapping shift (end < start) — a plain day shift dated yesterday
-- still never covers today. p_slot_end_wraps is always FALSE here: the
-- function already refuses (above, unchanged) any appointment whose start
-- and end fall on different calendar days, so by the time this check runs
-- the booking itself never wraps midnight — only the SHIFT covering it can.
--
-- Side effect, taken deliberately rather than reimplemented around: reusing
-- shift_row_covers_booking() also picks up its one-minute boundary slack
-- (20260909120000), which this function never had before. Writing a fifth
-- copy of shift-coverage logic instead, just to avoid that, is exactly the
-- "two lists that must agree" failure this schema has already paid for
-- three times.
--
-- No live tenant runs night shifts today, so this changes no current
-- booking's behavior.

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

        -- DATE, not DOW (Copilot review, PR #444): EXTRACT(DOW) only detects
        -- a WEEKDAY change, so a booking exactly 7 (or 14, 21, ...) days long
        -- landed on the same weekday at both ends and slipped this guard —
        -- pre-existing since this check was first written, surfaced now
        -- because the night-shift coverage call below assumes the guard
        -- actually guarantees a single calendar day (p_slot_end_wraps is
        -- passed as a hardcoded FALSE on that assumption).
        IF v_start_local::DATE <> v_end_local::DATE THEN
            RETURN QUERY SELECT FALSE, NULL::UUID, 'Appointment spans multiple days and cannot be validated against shifts'::TEXT;
            RETURN;
        END IF;

        -- TWO DATES, NOT ONE (2026-09-13): a night shift's row is dated the
        -- evening it STARTED, so an early-morning booking needs YESTERDAY's
        -- row too. shift_row_covers_booking() (20260911010000) decides
        -- whether a candidate row actually reaches this booking; the IN
        -- clause just stops excluding it upfront. p_slot_end_wraps is FALSE
        -- because the guard above already refused any booking that itself
        -- spans two calendar days.
        SELECT EXISTS (
            SELECT 1 FROM employee_schedule es
            WHERE es.employee_id = v_employee_id
              AND es.tenant_id = p_tenant_id
              AND es.shift_date IN (v_start_local::DATE, v_start_local::DATE - 1)
              AND es.is_off = false
              AND (es.shift_date = v_start_local::DATE OR es.end_time < es.start_time)
              AND public.shift_row_covers_booking(
                    es.shift_date,
                    v_start_local::DATE,
                    es.start_time,
                    es.end_time,
                    v_start_local::TIME,
                    v_end_local::TIME,
                    FALSE
                  )
        ) INTO v_on_shift;

        IF NOT v_on_shift THEN
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
skips the whole block, unchanged.
Night-shift aware (2026-09-13): shift coverage is checked via
shift_row_covers_booking() against both the booking''s own date and the day
before, so a shift dated the evening it started still covers an early-
morning booking the next calendar day. A booking that itself spans two
calendar days is still refused outright (unchanged) — only the covering
shift may wrap midnight.';
