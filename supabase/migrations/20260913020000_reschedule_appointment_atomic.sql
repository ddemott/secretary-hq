-- /agent-tools/reschedule-appointment did a raw UPDATE with zero
-- re-validation against the business rules booking already enforces: no
-- blackout-date check, no shift-coverage check (so a caller could reschedule
-- into a time nobody is on shift for, including the night-shift midnight-wrap
-- case just fixed in book_appointment_atomic/get_available_slots), and no
-- re-check that the STRICT skill-map link (service_employee/service_resource)
-- is still active. GiST exclusion constraints still caught a literal
-- double-booking, but "not double-booked" is not "actually staffed."
--
-- Fix: a new reschedule_appointment_atomic() RPC does the ownership lookup,
-- then applies the same guards book_appointment_atomic enforces — blackout
-- date, STRICT skill-map re-check, and night-shift-aware shift coverage via
-- shift_row_covers_booking() (20260911010000) — before writing the new time.
-- The employee/resource/service assignment itself is unchanged by a
-- reschedule; only the shift/closure/staffing facts about the NEW time are
-- re-checked.
--
-- No live tenant runs night shifts, and blackout dates + unlinked-service
-- staffing are both edge cases today, so this changes no current call's
-- happy path — it closes a gap the next caller who reschedules into a closed
-- day, an unstaffed hour, or a since-unlinked service would otherwise walk
-- straight into.

CREATE OR REPLACE FUNCTION public.reschedule_appointment_atomic(
    p_tenant_id UUID,
    p_appointment_id UUID,
    p_phone TEXT,
    p_new_start TIMESTAMPTZ,
    p_new_end TIMESTAMPTZ
) RETURNS TABLE(success BOOLEAN, appointment_id UUID, error_message TEXT, error_code TEXT)
LANGUAGE plpgsql
AS $function$
DECLARE
    v_employee_id UUID;
    v_resource_id UUID;
    v_service_id UUID;
    v_tenant_tz TEXT;
    v_start_local TIMESTAMP;
    v_end_local TIMESTAMP;
    v_on_shift BOOLEAN;
BEGIN
    SELECT COALESCE(t.timezone, 'UTC') INTO v_tenant_tz FROM tenants t WHERE t.tenant_id = p_tenant_id;
    IF v_tenant_tz IS NULL THEN v_tenant_tz := 'UTC'; END IF;

    -- Ownership + eligibility, same WHERE the old raw UPDATE used: phone
    -- match (the LLM can never move another caller's appointment even if it
    -- hallucinates a UUID), still scheduled, still in the future, not soft-
    -- deleted. Reads the CURRENT assignment so the checks below validate the
    -- new time against who/where this appointment is ALREADY staffed for —
    -- rescheduling never reassigns employee/resource/service.
    SELECT a.employee_id, a.resource_id, a.service_id
      INTO v_employee_id, v_resource_id, v_service_id
      FROM appointments a
      JOIN customers c ON a.customer_id = c.customer_id
     WHERE a.appointment_id = p_appointment_id
       AND a.tenant_id = p_tenant_id
       AND c.tenant_id = p_tenant_id
       AND c.phone = p_phone
       AND a.status = 'scheduled'
       AND a.start_time > NOW()
       AND (a.is_deleted IS NULL OR a.is_deleted = false);

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, NULL::UUID,
            'I couldn''t find that appointment under your number, or it may already be past or canceled.'::TEXT,
            'NOT_FOUND'::TEXT;
        RETURN;
    END IF;

    v_start_local := p_new_start AT TIME ZONE v_tenant_tz;
    v_end_local := p_new_end AT TIME ZONE v_tenant_tz;

    -- Closed-day guard (20260903000000) — checked BEFORE any staffing search,
    -- same ordering rule as the booking RPCs: a closed day is "we're closed
    -- that day," never "no one is scheduled."
    IF EXISTS (
        SELECT 1 FROM blackout_dates bd
         WHERE bd.tenant_id = p_tenant_id AND bd.blackout_date = v_start_local::DATE
    ) THEN
        RETURN QUERY SELECT FALSE, NULL::UUID,
            'The business is closed on that date.'::TEXT, 'BUSINESS_CLOSED'::TEXT;
        RETURN;
    END IF;

    -- STRICT skill-map re-check (20260909210000 / 20260911000000): the
    -- staffing valid at BOOKING time must still be valid NOW — a service can
    -- be unlinked from its employee/resource in between. Tags are never
    -- consulted here, matching every other STRICT call site.
    IF v_service_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM service_resource sr
              JOIN resources res ON res.resource_id = sr.resource_id
             WHERE sr.service_id = v_service_id
               AND sr.resource_id = v_resource_id
               AND sr.tenant_id = p_tenant_id
               AND res.is_active = true
               AND (res.is_deleted IS NULL OR res.is_deleted = false)
        ) THEN
            RETURN QUERY SELECT FALSE, NULL::UUID,
                'That room or line is no longer set up for this kind of appointment.'::TEXT,
                'NO_SKILLED_RESOURCE'::TEXT;
            RETURN;
        END IF;

        IF v_employee_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM service_employee se
              JOIN employees emp ON emp.employee_id = se.employee_id
             WHERE se.service_id = v_service_id
               AND se.employee_id = v_employee_id
               AND se.tenant_id = p_tenant_id
               AND emp.is_active = true
               AND (emp.is_deleted IS NULL OR emp.is_deleted = false)
        ) THEN
            RETURN QUERY SELECT FALSE, NULL::UUID,
                'That person is no longer set up to take this kind of appointment.'::TEXT,
                'NO_SKILLED_EMPLOYEE'::TEXT;
            RETURN;
        END IF;
    END IF;

    -- Shift coverage, night-shift aware (shift_row_covers_booking,
    -- 20260911010000) — same DATE-not-DOW multi-day guard as
    -- book_appointment_atomic (20260913010000): a reschedule spanning two
    -- calendar days is refused outright, so p_slot_end_wraps is always FALSE.
    IF v_employee_id IS NOT NULL THEN
        IF v_start_local::DATE <> v_end_local::DATE THEN
            RETURN QUERY SELECT FALSE, NULL::UUID,
                'Appointment spans multiple days and cannot be validated against shifts.'::TEXT,
                'INVALID_PARAMS'::TEXT;
            RETURN;
        END IF;

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
            RETURN QUERY SELECT FALSE, NULL::UUID,
                'Employee is not on shift during this time.'::TEXT, 'EMPLOYEE_NOT_SCHEDULED'::TEXT;
            RETURN;
        END IF;
    END IF;

    BEGIN
        UPDATE appointments
           SET start_time = p_new_start, end_time = p_new_end, updated_at = now()
         WHERE appointments.appointment_id = p_appointment_id;
    EXCEPTION WHEN exclusion_violation THEN
        RETURN QUERY SELECT FALSE, NULL::UUID,
            'That time slot is already booked. Please choose a different time.'::TEXT,
            'TIMESLOT_OCCUPIED'::TEXT;
        RETURN;
    END;

    RETURN QUERY SELECT TRUE, p_appointment_id, NULL::TEXT, NULL::TEXT;
END;
$function$;

COMMENT ON FUNCTION public.reschedule_appointment_atomic IS
'Atomic reschedule for /agent-tools/reschedule-appointment. Verifies phone
ownership, then re-validates the NEW time against the appointment''s EXISTING
employee/resource/service assignment: blackout dates (BUSINESS_CLOSED),
STRICT skill-map links still active (NO_SKILLED_RESOURCE/NO_SKILLED_EMPLOYEE),
and night-shift-aware shift coverage via shift_row_covers_booking
(EMPLOYEE_NOT_SCHEDULED). Does not reassign employee/resource/service — only
the time changes. GiST exclusion constraints still catch a literal
double-booking (TIMESLOT_OCCUPIED).';
