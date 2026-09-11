-- Three rules a booking system does not get to break, now enforced where every
-- booking passes: book_with_scheduling_atomic.
--
-- 1. YOU CANNOT BOOK IN THE PAST.
--    Proved against production 2026-09-09 at 6:52 PM by booking 1:00 PM the same
--    day — success, row written. The guard lived only in book_appointment_atomic,
--    which production does not call. Shift coverage cannot substitute for it: a
--    past time inside today's shift passes every coverage test there is.
--    One minute of grace matches the shift-boundary slack, so a caller saying
--    "one o'clock" at 12:59:40 is not refused on a rounding edge.
--
-- 2. AN APPOINTMENT IS WITH SOMEBODY.
--    `appointments.employee_id` is nullable and the RPC initialises its candidate
--    to NULL, so the fall-open path (a tenant with no schedule rows) could insert
--    an appointment with no person on it. The owner would open the calendar and
--    see a customer, a time, a room, and nobody to meet them.
--
-- 3. THE SKILL MAP DECIDES WHO AND WHERE (2026-09-11).
--    Dale: "Person -> Role -> Resource, and the resource should be meeting for
--    XYZ." The dashboard's skill map already records exactly that — people linked
--    to a service (`service_employee`), the service linked to its rooms or lines
--    (`service_resource`) — and this function never read either table. It chose
--    people by `employees.skills` tags and rooms by name order, so a meeting
--    linked only to Dale and the Zoom line was booked, in a rolled-back probe,
--    with an unlinked employee in an unlinked storage closet. The owner edits the
--    map and believes it is in charge; on the phone path it was not.
--
--    When the service being booked is known (p_service_id), the links are the
--    rule: only linked people, only linked rooms, and the skill/capability tags
--    are not consulted — two lists that must agree is the failure this schema
--    has already paid for three times. STRICT: a service with no active linked
--    person, or no active linked room, is refused before any search; handing it
--    to whoever happens to be free is the bug being fixed. Without a service id
--    the legacy tag rules apply unchanged.
--
--    availabilitySearch.ts and the get-available-slots date path carry the same
--    rule in the same commit: suggest and enforce must read the same map, or the
--    agent offers a slot the booking then refuses (the 2026-07-17 lesson).
--
-- Refusals reuse error codes the agent already speaks, so no new caller-facing
-- vocabulary is introduced. Otherwise the function is 20260909120000's.

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
    -- Rule 3: when the service is known, the skill map's links decide and the
    -- tag arrays are emptied so no branch below consults them.
    v_by_links BOOLEAN := p_service_id IS NOT NULL;
    v_skills TEXT[];
    v_caps TEXT[];
BEGIN
    v_buffer := (GREATEST(COALESCE(p_buffer_minutes, 0), 0) || ' minutes')::INTERVAL;
    v_skills := CASE WHEN v_by_links THEN '{}'::TEXT[] ELSE COALESCE(p_required_skills, '{}'::TEXT[]) END;
    v_caps := CASE WHEN v_by_links THEN '{}'::TEXT[] ELSE COALESCE(p_required_capabilities, '{}'::TEXT[]) END;

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

    -- RULE: YOU CANNOT BOOK IN THE PAST. Dale, 2026-09-09: "that should be a
    -- given and a rule that we abide by."
    --
    -- It was not a given. Demonstrated against PRODUCTION at 6:52 PM by booking
    -- 1:00 PM the same day: success, appointment_id returned, row written. The
    -- check existed only in book_appointment_atomic, which production does not
    -- use; THIS is the function every phone booking goes through, and it had
    -- nothing. Shift coverage cannot catch it either — 1:00 PM sits squarely
    -- inside a 1-5 PM shift, it is merely six hours gone.
    --
    -- One minute of grace, matching the shift-boundary slack: a caller who says
    -- "one o'clock" at 12:59:40 means the slot that is about to start, and
    -- refusing them on a rounding edge would be its own defect.
    IF v_start < (now() - INTERVAL '1 minute') THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, NULL::UUID,
            'That time has already passed'::TEXT, 'PAST_TIME'::TEXT;
        RETURN;
    END IF;

    -- RULE 3, STRICT: a service nobody is linked to — or that is linked to no
    -- room or line — cannot be booked. Checked before any search so the caller
    -- hears the true reason, not a generic "nothing available". Only ACTIVE,
    -- undeleted people and rooms count: a link to someone who has left is not
    -- somebody to meet the customer.
    IF v_by_links AND NOT EXISTS (
        SELECT 1 FROM service_employee se
          JOIN employees emp ON emp.employee_id = se.employee_id
         WHERE se.service_id = p_service_id
           AND se.tenant_id = p_tenant_id
           AND emp.is_active = true
           AND (emp.is_deleted IS NULL OR emp.is_deleted = false)
    ) THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_customer_id,
            'No one is assigned to take this kind of appointment'::TEXT,
            'NO_SKILLED_EMPLOYEE'::TEXT;
        RETURN;
    END IF;
    IF v_by_links AND NOT EXISTS (
        SELECT 1 FROM service_resource sr
          JOIN resources res ON res.resource_id = sr.resource_id
         WHERE sr.service_id = p_service_id
           AND sr.tenant_id = p_tenant_id
           AND res.is_active = true
    ) THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
            NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_customer_id,
            'No room or line is set up for this kind of appointment'::TEXT,
            'NO_AVAILABILITY'::TEXT;
        RETURN;
    END IF;

    IF array_length(v_skills, 1) IS NOT NULL AND array_length(v_skills, 1) > 0 THEN
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
                AND (array_length(v_caps, 1) IS NULL
                     OR res.capabilities @> v_caps)
                AND emp.skills @> v_skills
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
                AND (array_length(v_caps, 1) IS NULL
                     OR res.capabilities @> v_caps)
                -- Rule 3: only a room or line the skill map links to this service.
                AND (NOT v_by_links OR EXISTS (
                    SELECT 1 FROM service_resource sr
                     WHERE sr.service_id = p_service_id
                       AND sr.resource_id = res.resource_id
                ))
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

        -- AND NOW NAME THE PERSON. Dale, 2026-09-09: "the person needs to be
        -- checked against the calendar... you can't book an appointment with
        -- someone who is not in the resources list."
        --
        -- This branch used to select a RESOURCE and stop. The shift guard below
        -- then proved that SOMEBODY was scheduled and covering — without ever
        -- recording who — so `v_employee_id` stayed NULL and the appointment was
        -- written with a room and no person. Production never showed it only
        -- because its services carry required_skills and take the other branch;
        -- any service without skills booked nobody.
        --
        -- Same three tests the skills branch applies, minus the skill filter: the
        -- employee is ACTIVE, their shift COVERS the window (wrap-aware, via the
        -- shared shift_covers_booking), and they are not already booked across it.
        -- p_preferred_employee_id — the person the caller asked for by name — wins
        -- when supplied, so "book me with Dale" binds to Dale or fails honestly.
        -- Rule 3: and, when the service is known, the skill map links them to it.
        IF v_found THEN
            FOR r IN
                SELECT emp.employee_id AS eid, emp.name AS ename
                FROM employees emp
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
                  AND (NOT v_by_links OR EXISTS (
                      SELECT 1 FROM service_employee se
                       WHERE se.service_id = p_service_id
                         AND se.employee_id = emp.employee_id
                  ))
                  AND (p_preferred_employee_id IS NULL
                       OR emp.employee_id = p_preferred_employee_id::UUID)
                  AND NOT EXISTS (
                      SELECT 1 FROM appointments a
                      WHERE a.employee_id = emp.employee_id
                        AND a.status = 'scheduled'
                        AND (a.is_deleted IS NULL OR a.is_deleted = false)
                        AND a.start_time < v_end + v_buffer
                        AND a.end_time > v_start - v_buffer
                  )
                ORDER BY
                    CASE WHEN emp.employee_id = p_preferred_employee_id::UUID THEN 0 ELSE 1 END,
                    emp.name
                LIMIT 1
            LOOP
                v_employee_id := r.eid;
                v_employee_name := r.ename;
            END LOOP;
        END IF;
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
       AND (array_length(v_skills, 1) IS NULL OR array_length(v_skills, 1) = 0)
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
        -- Rule 3: the service has active linked rooms (checked above), so no free
        -- one means every room for this kind of appointment is taken then.
        IF v_by_links THEN
            RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
                NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_customer_id,
                'Requested time slot is already booked'::TEXT,
                'TIMESLOT_OCCUPIED'::TEXT;
            RETURN;
        END IF;

        IF array_length(v_skills, 1) IS NOT NULL AND array_length(v_skills, 1) > 0 THEN
            SELECT EXISTS(
                SELECT 1 FROM employees
                WHERE tenant_id = p_tenant_id
                AND is_active = true
                AND (is_deleted IS NULL OR is_deleted = false)
                AND skills @> v_skills
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
                AND emp.skills @> v_skills
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
                AND emp.skills @> v_skills
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
        -- Rule 3: a room was found but no linked person was. Say which of the two
        -- true things it is — nobody linked is working then, or they are all
        -- already booked — rather than the generic line below.
        IF v_employee_id IS NULL AND v_by_links THEN
            IF NOT EXISTS (
                SELECT 1 FROM service_employee se
                  JOIN employees emp ON emp.employee_id = se.employee_id
                  JOIN employee_schedule es
                    ON es.employee_id = emp.employee_id
                   AND es.tenant_id = p_tenant_id
                   AND es.shift_date = v_shift_date
                   AND es.is_off = false
                   AND public.shift_covers_booking(
                           es.start_time, es.end_time,
                           v_start_time_of_day, v_end_time_of_day, v_end_wraps)
                 WHERE se.service_id = p_service_id
                   AND emp.is_active = true
                   AND (emp.is_deleted IS NULL OR emp.is_deleted = false)
                   AND (p_preferred_employee_id IS NULL
                        OR emp.employee_id = p_preferred_employee_id::UUID)
            ) THEN
                RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
                    NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_customer_id,
                    'No one who takes this kind of appointment is working then'::TEXT,
                    'EMPLOYEE_NOT_SCHEDULED'::TEXT;
                RETURN;
            END IF;
            RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
                NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, v_customer_id,
                'Requested time slot is already booked'::TEXT,
                'TIMESLOT_OCCUPIED'::TEXT;
            RETURN;
        END IF;

        -- RULE: AN APPOINTMENT IS WITH SOMEBODY. Dale, 2026-09-09: "you can't
        -- book an appointment with a resource that doesn't exist."
        --
        -- appointments.employee_id is NULLABLE and v_employee_id starts NULL, so
        -- a tenant that reaches the fall-open path (no schedule data at all)
        -- could be booked with NO PERSON attached — the owner opens the calendar
        -- and finds a customer, a time, a room, and nobody to meet them. Two live
        -- tenants sat in exactly that state when this was written (Bella's Hair
        -- Studio: 0 active staff; AI Sec Platform: staff but no schedule rows).
        --
        -- Refusing is the honest answer for an unconfigured business, and it
        -- reuses the code the agent already knows how to speak. Demo tenants are
        -- unaffected: demoSeed.ts seeds employees, schedules and resources.
        IF v_employee_id IS NULL THEN
            RETURN QUERY SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TEXT,
                NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, NULL::UUID,
                'No one is scheduled to take this appointment'::TEXT, 'NO_SKILLED_EMPLOYEE'::TEXT;
            RETURN;
        END IF;

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
