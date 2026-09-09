-- Shift boundaries are fuzzy by one minute — and BOTH sides must agree on that.
--
-- WHY: a caller names a round time ("five o'clock"), never the odd minute the
-- calendar actually has. When the shift on file ends at 16:59 and the caller
-- asks for 17:00, the booking is refused for a discrepancy no human would
-- recognise as a conflict — the caller hears "we can't do that time" about a
-- minute nobody meant. Dale's rule, 2026-09-09: treat a miss of one minute at
-- a shift boundary as a hit. People butt meetings end to end and round to the
-- nearest five minutes when they speak; the schedule should not punish that.
--
-- WHY A FUNCTION AND NOT FOUR COPIES OF THE CLAUSE: this rule already existed in
-- FOUR places — three inside book_with_scheduling_atomic and once more in
-- availabilitySearch.ts, which is the SUGGEST side. When suggest and enforce
-- disagree, the agent offers a slot the booking then refuses; that exact split
-- shipped once already (the 2026-07-17 midnight-wrap call, migration
-- 20260718003000). One function, called from all four sites, makes the drift
-- impossible rather than merely discouraged.
--
-- WHAT IS DELIBERATELY NOT CHANGED: appointments still sit on the quarter-hour
-- grid (appointments_start/end_time_15min CHECKs stay). The slack applies to
-- the SHIFT boundary comparison only — no odd-minute appointment is created,
-- and nothing else in the system that assumes the grid has to be revisited.
--
-- THE WRAP GUARDS ARE LOAD-BEARING. `time + interval` wraps at midnight in
-- Postgres ('23:59'::time + '1 min' = '00:00'), so a naive widening would turn a
-- 23:59 boundary into 00:00 and quietly accept a slot 24 hours out of place. The
-- slack is therefore applied only where it cannot wrap, and the un-slacked
-- comparison is always tried first — so the fuzzy path can only ever ACCEPT what
-- the exact path already accepted, plus one minute either side.

CREATE OR REPLACE FUNCTION public.shift_covers_booking(
    p_shift_start   TIME,
    p_shift_end     TIME,
    p_slot_start    TIME,
    p_slot_end      TIME,
    p_slot_end_wraps BOOLEAN,
    p_slack         INTERVAL DEFAULT INTERVAL '1 minute'
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT
        -- START EDGE: the shift may begin up to p_slack AFTER the booking starts.
        (
            p_shift_start <= p_slot_start
            OR (
                p_slot_start < TIME '23:59'          -- guard: no midnight wrap
                AND p_shift_start <= p_slot_start + p_slack
            )
        )
        AND
        -- END EDGE, per shift SHAPE. The wrap semantics are unchanged from
        -- 20260718003000; only the end comparison gains the slack.
        --   DAY shift  (end > start): a wrapping slot is NEVER covered.
        --   NIGHT shift (end < start): pre-midnight slots are covered by the
        --     start check alone; a wrapping slot must end by the morning end.
        CASE
            WHEN p_shift_end < p_shift_start THEN
                (NOT p_slot_end_wraps)
                OR p_shift_end >= p_slot_end
                OR (p_slot_end >= TIME '00:01' AND p_shift_end >= p_slot_end - p_slack)
            ELSE
                (NOT p_slot_end_wraps)
                AND (
                    p_shift_end >= p_slot_end
                    OR (p_slot_end >= TIME '00:01' AND p_shift_end >= p_slot_end - p_slack)
                )
        END
$$;

COMMENT ON FUNCTION public.shift_covers_booking(TIME, TIME, TIME, TIME, BOOLEAN, INTERVAL) IS
    'Does this employee shift cover this booking? One minute of slack at each boundary. '
    'The single source of truth for shift coverage: book_with_scheduling_atomic calls it three '
    'times and availabilitySearch.ts calls it once, so suggest and enforce cannot drift.';

-- The RPC below is byte-identical to 20260903000000 except that each of its three
-- shift-coverage clauses now calls shift_covers_booking() instead of spelling the
-- comparison out. Recreated in full because CREATE OR REPLACE FUNCTION has no
-- partial form.

CREATE OR REPLACE FUNCTION public.book_with_scheduling_atomic(p_tenant_id uuid, p_phone text, p_customer_name text DEFAULT NULL::text, p_description text DEFAULT 'Booking via SecretaryHQ'::text, p_call_id text DEFAULT NULL::text, p_location text DEFAULT NULL::text, p_start_time timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_time timestamp with time zone DEFAULT NULL::timestamp with time zone, p_window_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_window_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_required_skills text[] DEFAULT '{}'::text[], p_required_capabilities text[] DEFAULT '{}'::text[], p_preferred_resource_id uuid DEFAULT NULL::uuid, p_preferred_employee_id text DEFAULT NULL::text, p_service_type text DEFAULT NULL::text, p_duration_minutes integer DEFAULT 30, p_buffer_minutes integer DEFAULT 0, p_service_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(success boolean, appointment_id uuid, resource_id uuid, resource_name text, employee_id uuid, employee_name text, booked_start timestamp with time zone, booked_end timestamp with time zone, customer_id uuid, error_message text, error_code text)
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_customer_id UUID;
    v_resource_id UUID;
    v_resource_name TEXT;
    v_employee_id UUID := NULL;
    v_employee_name TEXT := NULL;
    v_start TIMESTAMPTZ;
    v_end TIMESTAMPTZ;
    v_appointment_id UUID;
    v_day_of_week INTEGER;
    v_start_time_of_day TIME;
    v_end_time_of_day TIME;
    v_shift_date DATE;
    v_end_wraps BOOLEAN;
    v_tenant_tz TEXT;
    v_found BOOLEAN := FALSE;
    r RECORD;
    v_employee_exists BOOLEAN := FALSE;
    v_employee_scheduled BOOLEAN;
    v_employee_occupied BOOLEAN;
    v_resource_occupied BOOLEAN;
    v_buffer INTERVAL;
BEGIN
    v_buffer := (GREATEST(COALESCE(p_buffer_minutes, 0), 0) || ' minutes')::INTERVAL;

    SELECT COALESCE(t.timezone, 'UTC') INTO v_tenant_tz
    FROM tenants t WHERE t.tenant_id = p_tenant_id;
    IF v_tenant_tz IS NULL THEN v_tenant_tz := 'UTC'; END IF;

    IF p_phone IS NULL OR p_phone = '' THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, NULL::UUID,
            'Phone number is required'::TEXT, 'INVALID_PARAMS'::TEXT;
        RETURN;
    END IF;

    IF p_start_time IS NULL OR p_end_time IS NULL THEN
        IF p_window_from IS NULL OR p_window_to IS NULL THEN
            RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
                NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, NULL::UUID,
                'Either (start_time, end_time) or (window_from, window_to) required'::TEXT,
                'INVALID_PARAMS'::TEXT;
            RETURN;
        END IF;
        v_start := p_window_from;
        v_end := v_start + (p_duration_minutes || ' minutes')::INTERVAL;
    ELSE
        v_start := p_start_time;
        v_end := p_end_time;
    END IF;

    SELECT customers.customer_id INTO v_customer_id FROM customers
    WHERE tenant_id = p_tenant_id AND phone = p_phone
      AND (is_deleted IS NULL OR is_deleted = false)
    LIMIT 1;
    IF v_customer_id IS NULL THEN
        INSERT INTO customers (tenant_id, phone, name)
        VALUES (p_tenant_id, p_phone, COALESCE(p_customer_name, 'Unknown'))
        RETURNING customers.customer_id INTO v_customer_id;
    END IF;

    v_shift_date := (v_start AT TIME ZONE v_tenant_tz)::DATE;

    -- TENANT-WIDE CLOSURE (T-106, 2026-09-03).
    --
    -- `employee_schedule.is_off` says one PERSON is off. Nothing said the
    -- BUSINESS is shut. Closing for Christmas therefore meant editing every
    -- employee's row for that date, and any employee added afterwards silently
    -- became bookable on a day the doors are locked — the failure lands on a
    -- real customer standing outside, which is the same class of harm as the
    -- over-scheduling rule rejected in migration 20260820000000.
    --
    -- Checked HERE, before any employee/resource search, because a closed day
    -- is not a staffing question: with the guard further down, a tenant with no
    -- staff on that date would return EMPLOYEE_NOT_SCHEDULED and the caller
    -- would be told "no one is scheduled" rather than "we are closed". Same
    -- facts, different sentence, and only one of them is true.
    --
    -- availabilitySearch.ts carries the matching exclusion in the same commit:
    -- suggest and enforce must read the same calendar, or the agent offers a
    -- slot the booking then refuses (the 2026-07-17 midnight-wrap lesson).
    IF EXISTS (
        SELECT 1 FROM blackout_dates
         WHERE tenant_id = p_tenant_id
           AND blackout_date = v_shift_date
    ) THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_customer_id,
            'The business is closed on that date'::TEXT,
            'BUSINESS_CLOSED'::TEXT;
        RETURN;
    END IF;
    v_day_of_week := EXTRACT(DOW FROM v_start AT TIME ZONE v_tenant_tz)::INTEGER;
    v_start_time_of_day := (v_start AT TIME ZONE v_tenant_tz)::TIME;
    -- WRAP-AWARE, SHIFT-SHAPE-AWARE (2026-07-17 22:13 CDT live call; night
    -- shifts preserved per Fix #30's tests). A slot ending past local midnight
    -- has an end whose ::TIME compares as tiny once the date is dropped: an
    -- 11:30 PM -> midnight booking yields 00:00:00 and "shift end 17:00 >=
    -- 00:00" PASSED — so a DAY-shift tenant was offered and booked 11:30 PM.
    -- But the very same comparison is how cross-midnight NIGHT shifts
    -- (23:00-06:00, end < start) book their post-midnight stretch; the first
    -- version of this fix ('24:00:00' unconditionally) killed them and CI
    -- caught it. v_end_wraps carries the fact; the coverage joins apply it per
    -- shift shape: DAY shift -> a wrapping slot is never covered; NIGHT shift
    -- -> pre-midnight slots covered by the start check, wrapping slots must
    -- end by the shift's morning end.
    v_end_wraps := (v_end AT TIME ZONE v_tenant_tz)::DATE > v_shift_date;
    v_end_time_of_day := (v_end AT TIME ZONE v_tenant_tz)::TIME;

    IF array_length(p_required_skills, 1) IS NOT NULL AND array_length(p_required_skills, 1) > 0 THEN
        FOR r IN
            SELECT
                res.resource_id AS rid,
                res.name AS rname,
                emp.employee_id AS eid,
                emp.name AS ename
            FROM resources res
            CROSS JOIN employees emp
            JOIN employee_schedule es
                ON es.employee_id = emp.employee_id
                AND es.tenant_id = p_tenant_id
                AND es.shift_date = v_shift_date
                AND es.is_off = false
                AND public.shift_covers_booking(
                        es.start_time, es.end_time,
                        v_start_time_of_day, v_end_time_of_day, v_end_wraps)
            WHERE res.tenant_id = p_tenant_id
                AND res.is_active = true
                AND emp.tenant_id = p_tenant_id
                AND emp.is_active = true
                AND (emp.is_deleted IS NULL OR emp.is_deleted = false)
                AND (array_length(p_required_capabilities, 1) IS NULL
                     OR res.capabilities @> p_required_capabilities)
                AND emp.skills @> p_required_skills
                AND NOT EXISTS (
                    SELECT 1 FROM appointments a
                    WHERE a.resource_id = res.resource_id
                    AND a.status = 'scheduled'
                    AND (a.is_deleted IS NULL OR a.is_deleted = false)
                    AND a.start_time < v_end + v_buffer AND a.end_time > v_start - v_buffer
                )
                AND NOT EXISTS (
                    SELECT 1 FROM appointments a
                    WHERE a.employee_id = emp.employee_id
                    AND a.status = 'scheduled'
                    AND (a.is_deleted IS NULL OR a.is_deleted = false)
                    AND a.start_time < v_end + v_buffer AND a.end_time > v_start - v_buffer
                )
                AND (p_preferred_resource_id IS NULL OR res.resource_id = p_preferred_resource_id)
                AND (p_preferred_employee_id IS NULL OR emp.employee_id = p_preferred_employee_id::UUID)
            ORDER BY
                CASE WHEN res.resource_id = p_preferred_resource_id THEN 0 ELSE 1 END,
                CASE WHEN emp.employee_id = p_preferred_employee_id::UUID THEN 0 ELSE 1 END,
                res.name, emp.name
            LIMIT 1
        LOOP
            v_resource_id := r.rid;
            v_resource_name := r.rname;
            v_employee_id := r.eid;
            v_employee_name := r.ename;
            v_found := TRUE;
        END LOOP;
    ELSE
        FOR r IN
            SELECT res.resource_id AS rid, res.name AS rname
            FROM resources res
            WHERE res.tenant_id = p_tenant_id
                AND res.is_active = true
                AND (array_length(p_required_capabilities, 1) IS NULL
                     OR res.capabilities @> p_required_capabilities)
                AND NOT EXISTS (
                    SELECT 1 FROM appointments a
                    WHERE a.resource_id = res.resource_id
                    AND a.status = 'scheduled'
                    AND (a.is_deleted IS NULL OR a.is_deleted = false)
                    AND a.start_time < v_end + v_buffer AND a.end_time > v_start - v_buffer
                )
                AND (p_preferred_resource_id IS NULL OR res.resource_id = p_preferred_resource_id)
            ORDER BY
                CASE WHEN res.resource_id = p_preferred_resource_id THEN 0 ELSE 1 END,
                res.name
            LIMIT 1
        LOOP
            v_resource_id := r.rid;
            v_resource_name := r.rname;
            v_found := TRUE;
        END LOOP;
    END IF;

    -- NARROW SHIFT GUARD for the skill-less path (review on #285). The ELSE
    -- branch above historically books a resource with NO shift check at all
    -- ("fall open") — which re-opens the midnight-wrap hole for services
    -- without required skills. Fall-open is kept ONLY for tenants with no
    -- schedule data on the date; when non-off schedule rows exist for the day
    -- and none of them cover the window (wrap-aware, same v_*_time_of_day as
    -- the skills branch), the building is closed at that time and the booking
    -- is refused.
    IF v_found
       AND (array_length(p_required_skills, 1) IS NULL OR array_length(p_required_skills, 1) = 0)
       AND EXISTS (
            SELECT 1 FROM employee_schedule es
             WHERE es.tenant_id = p_tenant_id
               AND es.shift_date = v_shift_date
               AND es.is_off = false
       )
       AND NOT EXISTS (
            SELECT 1 FROM employee_schedule es
              JOIN employees emp ON emp.employee_id = es.employee_id
             WHERE es.tenant_id = p_tenant_id
               AND es.shift_date = v_shift_date
               AND es.is_off = false
               AND public.shift_covers_booking(
                       es.start_time, es.end_time,
                       v_start_time_of_day, v_end_time_of_day, v_end_wraps)
               AND emp.tenant_id = p_tenant_id
               AND emp.is_active = true
               AND (emp.is_deleted IS NULL OR emp.is_deleted = false)
       )
    THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_customer_id,
            'No employee available during requested time'::TEXT,
            'EMPLOYEE_NOT_SCHEDULED'::TEXT;
        RETURN;
    END IF;

    IF NOT v_found THEN
        IF array_length(p_required_skills, 1) IS NOT NULL AND array_length(p_required_skills, 1) > 0 THEN
            SELECT EXISTS(
                SELECT 1 FROM employees
                WHERE tenant_id = p_tenant_id
                AND is_active = true
                AND (is_deleted IS NULL OR is_deleted = false)
                AND skills @> p_required_skills
            ) INTO v_employee_exists;

            IF NOT v_employee_exists THEN
                RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
                    NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_customer_id,
                    'No employee with required skills available'::TEXT,
                    'NO_SKILLED_EMPLOYEE'::TEXT;
                RETURN;
            END IF;

            SELECT EXISTS(
                SELECT 1 FROM employees emp
                JOIN employee_schedule es
                    ON es.employee_id = emp.employee_id
                    AND es.tenant_id = p_tenant_id
                    AND es.shift_date = v_shift_date
                    AND es.is_off = false
                    AND public.shift_covers_booking(
                            es.start_time, es.end_time,
                            v_start_time_of_day, v_end_time_of_day, v_end_wraps)
                WHERE emp.tenant_id = p_tenant_id
                AND emp.is_active = true
                AND (emp.is_deleted IS NULL OR emp.is_deleted = false)
                AND emp.skills @> p_required_skills
            ) INTO v_employee_scheduled;

            IF NOT v_employee_scheduled THEN
                RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
                    NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_customer_id,
                    'No employee available during requested time'::TEXT,
                    'EMPLOYEE_NOT_SCHEDULED'::TEXT;
                RETURN;
            END IF;

            SELECT EXISTS(
                SELECT 1 FROM appointments a
                JOIN resources res ON res.resource_id = a.resource_id
                WHERE res.tenant_id = p_tenant_id
                AND res.is_active = true
                AND a.status = 'scheduled'
                AND (a.is_deleted IS NULL OR a.is_deleted = false)
                AND a.start_time < v_end + v_buffer AND a.end_time > v_start - v_buffer
            ) INTO v_resource_occupied;

            SELECT EXISTS(
                SELECT 1 FROM appointments a
                JOIN employees emp ON emp.employee_id = a.employee_id
                WHERE emp.tenant_id = p_tenant_id
                AND emp.is_active = true
                AND (emp.is_deleted IS NULL OR emp.is_deleted = false)
                AND emp.skills @> p_required_skills
                AND a.status = 'scheduled'
                AND (a.is_deleted IS NULL OR a.is_deleted = false)
                AND a.start_time < v_end + v_buffer AND a.end_time > v_start - v_buffer
            ) INTO v_employee_occupied;

            IF v_employee_occupied OR v_resource_occupied THEN
                RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
                    NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_customer_id,
                    'Requested time slot is already booked'::TEXT,
                    'TIMESLOT_OCCUPIED'::TEXT;
                RETURN;
            END IF;
        END IF;

        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_customer_id,
            'No available resource/employee combination found'::TEXT,
            'NO_AVAILABILITY'::TEXT;
        RETURN;
    END IF;

    BEGIN
        INSERT INTO appointments (
            tenant_id, resource_id, customer_id, start_time, end_time,
            description, call_id, location, employee_id, service_id
        ) VALUES (
            p_tenant_id, v_resource_id, v_customer_id, v_start, v_end,
            p_description, p_call_id, p_location, v_employee_id,
            -- Fall back to resolving the service BY NAME when the caller did not pass
            -- an id: p_service_type has always been here, and it was always only used
            -- to pick a skilled employee. The service itself was thrown away.
            COALESCE(
                p_service_id,
                (SELECT s.service_id FROM services s
                  WHERE s.tenant_id = p_tenant_id
                    AND lower(s.name) = lower(p_service_type)
                  LIMIT 1)
            )
        ) RETURNING appointments.appointment_id INTO v_appointment_id;
    EXCEPTION WHEN exclusion_violation THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_customer_id,
            'Requested time slot is already booked'::TEXT,
            'TIMESLOT_OCCUPIED'::TEXT;
        RETURN;
    END;

    RETURN QUERY SELECT TRUE, v_appointment_id, v_resource_id, v_resource_name,
        v_employee_id, v_employee_name, v_start, v_end, v_customer_id, NULL::TEXT, NULL::TEXT;
END;
$function$

;
