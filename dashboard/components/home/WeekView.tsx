'use client';

/**
 * Next-3-days mini-calendar for the DashboardHome.
 * Shows appointment counts + first 4 bookings + who's working (if team).
 * Extracted from DashboardHome.tsx (dense-view decomposition).
 */

import React, { useState, useEffect } from 'react';
import { Api } from '../../lib/api';
import type { Tab } from '../../app/dashboard/page';

interface WeekEmployee {
  employee_id: string;
  name: string;
  first_name?: string | null;
  last_name?: string | null;
}

interface WeekViewProps {
  tenantId: string | null;
  employees: WeekEmployee[];
  vocab: { booking_label: string; employee_label: string };
  onNavigate?: (tab: Tab) => void;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatShiftTime(t: string) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'p' : 'a';
  const hour = h % 12 || 12;
  return m === 0 ? `${hour}${ampm}` : `${hour}:${String(m).padStart(2, '0')}${ampm}`;
}

function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function WeekView({ tenantId, employees, vocab, onNavigate }: WeekViewProps) {
  const [weekAppts, setWeekAppts] = useState<
    { date: string; count: number; appts: { time: string; desc: string; employee?: string }[] }[]
  >([]);
  const [weekShifts, setWeekShifts] = useState<
    Record<string, { name: string; start: string; end: string; isOff: boolean }[]>
  >({});

  useEffect(() => {
    if (!tenantId) return;
    void loadWeekData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function loadWeekData() {
    const today = new Date();
    const days: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      days.push(toLocalDateStr(d));
    }

    // Local midnight → ISO so Postgres TIMESTAMPTZ comparison is timezone-correct.
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfWindow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3);
    try {
      const appts = await Api.appointments.list(tenantId, {
        startDate: startOfToday.toISOString(),
        endDate: endOfWindow.toISOString(),
      });
      const apptList = Array.isArray(appts) ? appts.filter((a) => a.status === 'scheduled') : [];

      const byDay = days.map((date) => {
        const dayAppts = apptList
          .filter((a) => toLocalDateStr(new Date(a.start_time)) === date)
          .sort((a, b) => a.start_time.localeCompare(b.start_time));
        return {
          date,
          count: dayAppts.length,
          appts: dayAppts.slice(0, 4).map((a) => {
            const empName =
              a.employee_id && employees.find((e) => e.employee_id === String(a.employee_id));
            return {
              time: new Date(a.start_time).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              }),
              desc: a.description || vocab.booking_label,
              employee: empName ? empName.first_name || empName.name : undefined,
            };
          }),
        };
      });
      setWeekAppts(byDay);
    } catch {
      // Silent fail — week view is supplementary
    }

    if (employees.length > 0 && employees.length <= 10) {
      const shiftMap: Record<
        string,
        { name: string; start: string; end: string; isOff: boolean }[]
      > = {};
      try {
        const shiftPromises = employees.map((emp) =>
          Api.shifts.schedule
            .forDate(tenantId, emp.employee_id, days[0], days[2])
            .then((shifts) => ({
              empId: emp.employee_id,
              empName: emp.first_name || emp.name,
              shifts,
            }))
            .catch(() => ({
              empId: emp.employee_id,
              empName: emp.first_name || emp.name,
              shifts: [],
            }))
        );
        const results = await Promise.all(shiftPromises);
        for (const { empName, shifts } of results) {
          for (const shift of shifts) {
            const dateKey = shift.shift_date;
            if (!shiftMap[dateKey]) shiftMap[dateKey] = [];
            shiftMap[dateKey].push({
              name: empName,
              start: shift.start_time || '',
              end: shift.end_time || '',
              isOff: shift.is_off,
            });
          }
        }
        setWeekShifts(shiftMap);
      } catch {
        // Silent fail
      }
    }
  }

  if (weekAppts.length === 0) {
    return (
      <p className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>
        No recent activity
      </p>
    );
  }

  return (
    <div className="grid grid-cols-3 gap-4">
      {weekAppts.map((day) => {
        const date = new Date(day.date + 'T12:00:00');
        const dayName = DAY_NAMES[date.getDay()];
        const dayNum = date.getDate();
        const todayLocal = toLocalDateStr(new Date());
        const isToday = day.date === todayLocal;
        const dayShifts = weekShifts[day.date] || [];
        const workingStaff = dayShifts.filter((s) => !s.isOff);

        return (
          <button
            key={day.date}
            onClick={() => onNavigate?.('schedule')}
            className="rounded-xl p-2.5 border text-left transition-colors"
            style={{
              borderColor: isToday ? 'var(--accent)' : 'var(--border-soft)',
              backgroundColor: isToday ? 'var(--accent-muted)' : 'var(--bg-surface)',
            }}
          >
            <div className="flex items-baseline justify-between mb-1.5">
              <span
                className="text-xs font-bold uppercase tracking-widest"
                style={{ color: 'var(--text-muted)' }}
              >
                {dayName}
              </span>
              <span
                className="text-lg font-bold"
                style={{ color: isToday ? 'var(--accent-soft)' : 'var(--text-primary)' }}
              >
                {dayNum}
              </span>
            </div>

            {day.count > 0 ? (
              <div className="text-xs font-medium mb-1" style={{ color: 'var(--accent-soft)' }}>
                {day.count}{' '}
                {day.count === 1
                  ? vocab.booking_label.toLowerCase()
                  : `${vocab.booking_label.toLowerCase()}s`}
              </div>
            ) : (
              <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
                No bookings
              </div>
            )}

            {day.appts.slice(0, 4).map((a, i) => (
              <div key={i} className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                {a.time} {a.desc}
              </div>
            ))}
            {day.count > 4 && (
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                +{day.count - 4} more
              </div>
            )}

            {workingStaff.length > 0 && employees.length > 1 && (
              <div className="mt-1.5 pt-1.5 border-t" style={{ borderColor: 'var(--border-soft)' }}>
                {workingStaff.slice(0, 3).map((s, i) => (
                  <div key={i} className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                    {s.name} {formatShiftTime(s.start)}–{formatShiftTime(s.end)}
                  </div>
                ))}
                {workingStaff.length > 3 && (
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    +{workingStaff.length - 3} more
                  </div>
                )}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
