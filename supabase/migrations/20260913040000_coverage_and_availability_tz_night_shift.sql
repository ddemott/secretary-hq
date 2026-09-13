-- check_coverage_gaps() (the dashboard's coverage-bars data source) and
-- check_availability_with_tz() (the superseded `/agent-tools/check-availability`
-- RPC — dead on a live call per agent/src/tools/reachability.ts, but still real
-- code with a real caller) both have the same night-shift bug already fixed
-- three times this session in the booking RPCs: coverage was matched on the
-- SLOT's own local date, so a shift dated the evening it started was never
-- consulted for anything after local midnight — and worse, in
-- check_coverage_gaps() even the SAME-day evening hours of a wrapping shift
-- read as uncovered, because comparing bare TIME columns (`start_time <= hr
-- AND end_time > hr`) has no way to know `end_time` (06:00) is smaller than
-- `start_time` (22:00) because the shift wraps, not because it's backwards.
--
-- Concretely, for an employee scheduled 22:00->06:00 (row dated the evening
-- it starts): the coverage dashboard would show every hour of that shift as
-- a GAP — 22:00-23:00 on its own date reads uncovered (22:00 <= hr but 06:00
-- is never > hr for any hr in 22..23), and 00:00-06:00 the next calendar day
-- is never checked against yesterday's row at all (same-date-only join).
--
-- Fix: check_availability_with_tz() checks ONE real requested RANGE, so it
-- reuses shift_row_covers_booking() (shared by every other call site fixed
-- this session) unchanged except for widening the date join and computing
-- p_slot_end_wraps from the caller's own start/end — exactly the same shape
-- as book_appointment_atomic and reschedule_appointment_atomic.
--
-- check_coverage_gaps() is a different shape: it has no real range, only a
-- POINT-per-hour probe ("is hour H covered?") across a generated series.
-- shift_row_covers_booking() is RANGE-vs-RANGE and is the wrong tool here —
-- an early draft of this fix tried framing each hour as a synthetic
-- hr:00->hr+1:00 slot and calling it anyway, and hour 23's synthetic slot
-- (23:00->00:00) necessarily sets p_slot_end_wraps=true, which the DAY-shift
-- branch of shift_covers_booking() treats as NEVER covered — so a perfectly
-- normal day shift running through 11 PM would have shown hour 23 as a gap.
-- Caught by this migration's own red-green test before it ever shipped.
-- Coverage-by-hour instead gets its own small, direct point-in-shift check:
-- a day shift covers hour H when start<=H<end on its own date (unchanged
-- from before); a wrapping night shift covers H on its OWN date when
-- H>=start (the evening portion), and covers H on the date AFTER when
-- H<end (the morning portion, read from yesterday's row). Points don't
-- wrap the way ranges do, so this needs none of shift_row_covers_booking's
-- slack/wrap machinery — just the same two-date join every other fix here
-- already uses.
--
-- No live tenant runs night shifts today, so this changes no current
-- coverage bar or availability answer — it closes a gap the next overnight
-- tenant would otherwise see as permanently unstaffed, and closes a second
-- gap in a route no live call reaches but real code (and its own test
-- suite) still exercises.

CREATE OR REPLACE FUNCTION public.check_availability_with_tz(p_tenant_id uuid, p_resource_id uuid, p_start_time timestamp with time zone, p_end_time timestamp with time zone, p_customer_tz text DEFAULT NULL::text, p_buffer_minutes integer DEFAULT 0) RETURNS TABLE(available boolean, tenant_timezone text, local_start text, local_end text)
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_tenant_tz TEXT;
    v_display_tz TEXT;
    v_resource_free BOOLEAN;
    v_staff_available BOOLEAN;
    v_shift_date DATE;
    v_start_tod TIME;
    v_end_tod TIME;
    v_end_wraps BOOLEAN;
    v_buffer INTERVAL;
BEGIN
    v_buffer := (GREATEST(COALESCE(p_buffer_minutes, 0), 0) || ' minutes')::INTERVAL;

    SELECT COALESCE(t.timezone, 'UTC') INTO v_tenant_tz
    FROM tenants t WHERE t.tenant_id = p_tenant_id;
    IF v_tenant_tz IS NULL THEN v_tenant_tz := 'UTC'; END IF;

    v_display_tz := COALESCE(p_customer_tz, v_tenant_tz);
    v_shift_date := (p_start_time AT TIME ZONE v_tenant_tz)::DATE;
    v_start_tod := (p_start_time AT TIME ZONE v_tenant_tz)::TIME;
    v_end_tod := (p_end_time AT TIME ZONE v_tenant_tz)::TIME;
    -- Does the REQUESTED range itself cross local midnight? Same fact
    -- shift_row_covers_booking's other callers compute — a slot that wraps
    -- into a third day is never covered by any single row.
    v_end_wraps := (p_end_time AT TIME ZONE v_tenant_tz)::DATE <> v_shift_date;

    SELECT NOT EXISTS (
        SELECT 1 FROM appointments
        WHERE resource_id = p_resource_id
        AND tenant_id = p_tenant_id
        AND status = 'scheduled'
        AND (is_deleted IS NULL OR is_deleted = false)
        AND start_time < p_end_time + v_buffer
        AND end_time > p_start_time - v_buffer
    ) INTO v_resource_free;

    -- TWO DATES, NOT ONE: a night shift's row is dated the evening it
    -- started, so a request for the early morning needs YESTERDAY's row
    -- too. shift_row_covers_booking() (20260911010000) decides whether a
    -- candidate row actually reaches this request; the guard below just
    -- stops excluding it upfront (a plain day shift dated yesterday never
    -- covers today).
    SELECT EXISTS (
        SELECT 1 FROM employees emp
        INNER JOIN employee_schedule es ON es.employee_id = emp.employee_id
        WHERE emp.tenant_id = p_tenant_id
        AND emp.is_active = true
        AND (emp.is_deleted IS NULL OR emp.is_deleted = false)
        AND es.tenant_id = p_tenant_id
        AND es.shift_date IN (v_shift_date, v_shift_date - 1)
        AND es.is_off = false
        AND (es.shift_date = v_shift_date OR es.end_time < es.start_time)
        AND public.shift_row_covers_booking(
              es.shift_date, v_shift_date, es.start_time, es.end_time,
              v_start_tod, v_end_tod, v_end_wraps
            )
    ) INTO v_staff_available;

    RETURN QUERY SELECT
        (v_resource_free AND v_staff_available),
        v_display_tz,
        to_char(p_start_time AT TIME ZONE v_display_tz, 'YYYY-MM-DD HH24:MI'),
        to_char(p_end_time AT TIME ZONE v_display_tz, 'YYYY-MM-DD HH24:MI');
END;
$$;

COMMENT ON FUNCTION public.check_availability_with_tz IS
'Superseded by get_available_slots / book_with_scheduling on every live call
(agent/src/tools/reachability.ts) — still real code with a real caller
(/agent-tools/check-availability), so it stays correct rather than
deleted. Night-shift aware (2026-09-13): staff coverage is checked via
shift_row_covers_booking() against both the request''s own date and the day
before, and against whether the REQUESTED range itself wraps midnight.';

CREATE OR REPLACE FUNCTION public.check_coverage_gaps(p_tenant_id uuid, p_start_date date DEFAULT CURRENT_DATE, p_end_date date DEFAULT (CURRENT_DATE + 6)) RETURNS TABLE(service_id uuid, service_name text, check_date date, gap_hours integer[], covered_hours integer[], total_open_hours integer, coverage_pct numeric, status text, details jsonb)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN QUERY
    WITH tenant_services AS (
        SELECT s.service_id AS sid, s.name AS sname
        FROM services s
        WHERE s.tenant_id = p_tenant_id
    ),
    date_series AS (
        SELECT d::DATE AS check_date
        FROM generate_series(p_start_date, p_end_date, '1 day'::INTERVAL) AS d
    ),
    hourly_coverage AS (
        -- Point-in-shift, not range-vs-range (see header comment for why
        -- shift_row_covers_booking doesn't fit here). TWO CANDIDATE DATES
        -- per probe: a row dated ds.check_date covers hour H normally (day
        -- shift) or from H>=start onward (a wrapping shift's evening half);
        -- a row dated the day BEFORE only ever matters if it's a wrapping
        -- shift, and then only covers H<end (its morning half, read into
        -- today).
        SELECT
            ts.sid,
            ds.check_date,
            h.hr,
            CASE WHEN EXISTS (
                SELECT 1
                FROM service_employee se
                JOIN employees e ON e.employee_id = se.employee_id
                JOIN employee_schedule sch
                    ON sch.employee_id = e.employee_id
                    AND sch.tenant_id = p_tenant_id
                    AND sch.shift_date IN (ds.check_date, ds.check_date - 1)
                    AND sch.is_off = false
                WHERE se.service_id = ts.sid
                  AND e.tenant_id = p_tenant_id
                  AND e.is_active = true
                  AND (e.is_deleted IS NULL OR e.is_deleted = false)
                  AND (
                    (sch.shift_date = ds.check_date AND sch.end_time > sch.start_time
                       AND sch.start_time <= make_time(h.hr, 0, 0) AND sch.end_time > make_time(h.hr, 0, 0))
                    OR (sch.shift_date = ds.check_date AND sch.end_time < sch.start_time
                       AND make_time(h.hr, 0, 0) >= sch.start_time)
                    OR (sch.shift_date = ds.check_date - 1 AND sch.end_time < sch.start_time
                       AND make_time(h.hr, 0, 0) < sch.end_time)
                  )
            ) THEN true ELSE false END AS is_covered
        FROM tenant_services ts
        CROSS JOIN date_series ds
        CROSS JOIN generate_series(0, 23) AS h(hr)
    ),
    open_hours AS (
        SELECT
            ds.check_date,
            h.hr
        FROM date_series ds
        CROSS JOIN generate_series(0, 23) AS h(hr)
        WHERE EXISTS (
            SELECT 1 FROM employees e
            JOIN employee_schedule sch
                ON sch.employee_id = e.employee_id
                AND sch.tenant_id = p_tenant_id
                AND sch.shift_date IN (ds.check_date, ds.check_date - 1)
                AND sch.is_off = false
            WHERE e.tenant_id = p_tenant_id
              AND e.is_active = true
              AND (e.is_deleted IS NULL OR e.is_deleted = false)
              AND (
                (sch.shift_date = ds.check_date AND sch.end_time > sch.start_time
                   AND sch.start_time <= make_time(h.hr, 0, 0) AND sch.end_time > make_time(h.hr, 0, 0))
                OR (sch.shift_date = ds.check_date AND sch.end_time < sch.start_time
                   AND make_time(h.hr, 0, 0) >= sch.start_time)
                OR (sch.shift_date = ds.check_date - 1 AND sch.end_time < sch.start_time
                   AND make_time(h.hr, 0, 0) < sch.end_time)
              )
        )
    ),
    service_coverage AS (
        SELECT
            hc.sid,
            hc.check_date,
            array_agg(DISTINCT hc.hr ORDER BY hc.hr) FILTER (WHERE NOT hc.is_covered AND oh.hr IS NOT NULL) AS gap_hrs,
            array_agg(DISTINCT hc.hr ORDER BY hc.hr) FILTER (WHERE hc.is_covered AND oh.hr IS NOT NULL) AS covered_hrs,
            COUNT(DISTINCT oh.hr) AS open_count,
            COUNT(DISTINCT hc.hr) FILTER (WHERE hc.is_covered AND oh.hr IS NOT NULL) AS covered_count
        FROM hourly_coverage hc
        LEFT JOIN open_hours oh ON oh.check_date = hc.check_date AND oh.hr = hc.hr
        GROUP BY hc.sid, hc.check_date
    )
    SELECT
        sc.sid,
        ts.sname,
        sc.check_date,
        COALESCE(sc.gap_hrs, '{}')::INTEGER[],
        COALESCE(sc.covered_hrs, '{}')::INTEGER[],
        sc.open_count::INTEGER,
        CASE WHEN sc.open_count > 0 THEN ROUND((sc.covered_count::NUMERIC / sc.open_count) * 100, 1) ELSE 100.0 END,
        CASE
            WHEN sc.open_count = 0 THEN 'closed'
            WHEN sc.covered_count = sc.open_count THEN 'full'
            WHEN sc.covered_count >= (sc.open_count * 0.8) THEN 'good'
            WHEN sc.covered_count >= (sc.open_count * 0.5) THEN 'partial'
            ELSE 'gap'
        END,
        jsonb_build_object(
            'gap_details', (
                SELECT jsonb_agg(jsonb_build_object('hour', g_hr, 'employees_needed', 1))
                FROM unnest(COALESCE(sc.gap_hrs, '{}')) AS g_hr
            )
        )
    FROM service_coverage sc
    JOIN tenant_services ts ON ts.sid = sc.sid
    ORDER BY sc.check_date, ts.sname;
END;
$$;

COMMENT ON FUNCTION public.check_coverage_gaps IS
'Coverage-bars data source (dashboard + Setup Wizard dry-run). Night-shift
aware (2026-09-13): each hour is checked with a direct point-in-shift test
against both the day''s own employee_schedule rows and a wrapping shift
dated the day before (NOT shift_row_covers_booking — that function is
range-vs-range and misreads a plain day shift''s hour 23 as uncovered when
forced into a per-hour probe shape), so a night shift''s hours read as
covered on both sides of midnight instead of reading as a permanent gap.';
