import { useState, useEffect, useCallback, useMemo } from 'react';
import { Api } from '../../lib/api';
import type { BulkEffectiveShift } from '../../lib/types';

export interface SchedulerAppointment {
  appointment_id: string;
  tenant_id: string;
  resource_id: string;
  customer_id: string;
  employee_id?: string | null;
  start_time: string;
  end_time: string;
  description: string;
  status: string;
  location?: string;
  customers?: {
    name: string;
    first_name?: string;
    last_name?: string;
    phone?: string;
    metadata?: Record<string, unknown>;
  };
  resources?: { name: string };
}

function toDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Returns the UTC instant of LOCAL midnight for the given date, as an ISO
// string. `new Date(y, m, d)` interprets its arguments as LOCAL time
// components, so its resulting timestamp (and therefore .toISOString())
// already correctly accounts for the host's UTC offset and DST — no manual
// offset arithmetic needed. This is NOT the same as `` `${toDateString(date)}T00:00:00Z` ``,
// which instead appends "Z" to a LOCAL calendar-date string and silently
// treats it as if it were already a UTC date. For any UTC-behind timezone
// (e.g. US Central, UTC-5/-6), that bug shifts the fetch window 5-6 hours
// early: from roughly 19:00-20:00 local onward each day, an appointment
// whose UTC timestamp has already rolled onto the next UTC calendar day
// falls outside the naive [dateStr 00:00Z, nextDateStr 00:00Z) range and
// silently vanishes from the Scheduler List/Day view, even though it's
// still "today" locally and the row is correct in the DB. Found 2026-09-15
// (docs/planning/TODO.md) via a persistent e2e/appointment-cancel-ui.spec.ts
// CI failure that only ever reproduced during the US-Central evening window.
function localMidnightIso(date: Date, dayOffset = 0): string {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset).toISOString();
}

interface SchedulerEmployee {
  employee_id: string;
  name: string;
}
interface SchedulerResource {
  resource_id: string;
  name: string;
}
interface SchedulerShift {
  employee_id?: string;
  start_time?: string;
  end_time?: string;
}

export function useSchedulerData(
  tenantId: string | null,
  selectedDate: Date,
  employees: SchedulerEmployee[],
  resources: SchedulerResource[]
) {
  const [appointments, setAppointments] = useState<SchedulerAppointment[]>([]);
  const [allShifts, setAllShifts] = useState<BulkEffectiveShift[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dateStr = toDateString(selectedDate);

  const fetchData = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);

    const startDate = localMidnightIso(selectedDate);
    const endDate = localMidnightIso(selectedDate, 1);

    try {
      // Fetch appointments + effective shifts for selected date
      const [apptRes, shiftRes] = await Promise.all([
        Api.appointments.list(tenantId, { startDate, endDate }).catch(() => []),
        Api.shifts.schedule.bulkForDate(tenantId, dateStr, dateStr).catch(() => []),
      ]);

      setAppointments(
        (Array.isArray(apptRes) ? apptRes : []).filter(
          (a: SchedulerAppointment) => a.status !== 'canceled'
        )
      );
      setAllShifts(Array.isArray(shiftRes) ? shiftRes : []);
    } catch {
      setAppointments([]);
      setAllShifts([]);
      setError('Failed to load schedule data');
    }

    setLoading(false);
  }, [tenantId, dateStr, selectedDate]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const appointmentsByEmployee = useMemo(() => {
    const map = new Map<string, SchedulerAppointment[]>();
    for (const emp of employees) {
      map.set(String(emp.employee_id), []);
    }
    map.set('unassigned', []);
    for (const appt of appointments) {
      const key = appt.employee_id ? String(appt.employee_id) : 'unassigned';
      const list = map.get(key);
      if (list) {
        list.push(appt);
      } else {
        const unassigned = map.get('unassigned')!;
        unassigned.push(appt);
      }
    }
    return map;
  }, [appointments, employees]);

  const appointmentsByResource = useMemo(() => {
    const map = new Map<string, SchedulerAppointment[]>();
    for (const res of resources) {
      map.set(String(res.resource_id), []);
    }
    for (const appt of appointments) {
      const key = String(appt.resource_id);
      const list = map.get(key);
      if (list) {
        list.push(appt);
      } else {
        map.set(key, [appt]);
      }
    }
    return map;
  }, [appointments, resources]);

  // Group effective shifts by employee (already filtered by date from bulk RPC)
  const shiftsByEmployee = useMemo(() => {
    const map = new Map<string, SchedulerShift[]>();
    for (const emp of employees) {
      map.set(String(emp.employee_id), []);
    }
    for (const shift of allShifts) {
      if (shift.is_off || !shift.start_time || !shift.end_time) continue;
      const empId = String(shift.employee_id);
      const list = map.get(empId);
      if (list) {
        list.push({ employee_id: empId, start_time: shift.start_time, end_time: shift.end_time });
      }
    }
    return map;
  }, [allShifts, employees]);

  return {
    appointments,
    shifts: allShifts,
    loading,
    error,
    appointmentsByEmployee,
    appointmentsByResource,
    shiftsByEmployee,
    refresh: fetchData,
  };
}
