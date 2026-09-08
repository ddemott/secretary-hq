'use client';

import React from 'react';
import { Clock } from 'lucide-react';
import { type EffectiveShift } from '@/lib/types';
import { Card } from '../ui/Card';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatTime(t: string) {
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}

function navigateToShifts() {
  window.dispatchEvent(
    new CustomEvent('secretary-hq:setup-subtab', { detail: { subtab: 'shifts' } })
  );
}

interface MyAvailabilityCardProps {
  shifts: EffectiveShift[];
  shiftsLoading: boolean;
}

export function MyAvailabilityCard({ shifts, shiftsLoading }: MyAvailabilityCardProps) {
  return (
    <Card className="p-6" style={{ backgroundColor: 'var(--bg-raised)' }}>
      <div className="flex items-center mb-6">
        <div
          className="p-2 rounded-lg mr-4"
          style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-soft)' }}
        >
          <Clock className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold">My Availability</h2>
          <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
            When clients can book you. Edit your schedule in{' '}
            <button
              onClick={navigateToShifts}
              className="underline font-bold"
              style={{ color: 'var(--accent)' }}
            >
              Staff &amp; Shifts
            </button>
            .
          </p>
        </div>
      </div>

      {shiftsLoading ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading schedule...
        </div>
      ) : shifts.length === 0 ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No schedule set yet. Set your hours in{' '}
          <button
            onClick={navigateToShifts}
            className="underline font-bold"
            style={{ color: 'var(--accent)' }}
          >
            Staff &amp; Shifts
          </button>
          .
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-2">
          {shifts.map((shift, i) => {
            const date = new Date(String(shift.shift_date).slice(0, 10) + 'T12:00:00');
            const dayName = DAY_NAMES[date.getDay()];
            const dayNum = date.getDate();
            const isOff = shift.is_off;
            return (
              <div
                key={i}
                className="rounded-xl p-3 text-center border"
                style={{
                  borderColor: isOff ? 'var(--border-soft)' : 'var(--accent)',
                  backgroundColor: isOff ? 'var(--bg-surface)' : 'var(--accent-muted)',
                }}
              >
                <div
                  className="text-xs font-bold uppercase tracking-widest"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {dayName}
                </div>
                <div
                  className="text-lg font-bold"
                  style={{ color: isOff ? 'var(--text-muted)' : 'var(--text-primary)' }}
                >
                  {dayNum}
                </div>
                {isOff ? (
                  <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    Off
                  </div>
                ) : (
                  <div className="text-xs mt-1" style={{ color: 'var(--accent-soft)' }}>
                    {shift.start_time && formatTime(shift.start_time)}
                    <br />
                    {shift.end_time && formatTime(shift.end_time)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
