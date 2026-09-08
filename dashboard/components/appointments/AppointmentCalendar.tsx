'use client';

import React from 'react';
import { type Appointment } from '../../lib/types';
import { Calendar as BigCalendar, type View as CalendarViewType } from 'react-big-calendar';
import withDragAndDrop from 'react-big-calendar/lib/addons/dragAndDrop';
import {
  localizer,
  type CalendarEvent,
  ZOOM_LEVELS,
  CALENDAR_TIMESLOTS,
  CALENDAR_MIN,
  CALENDAR_MAX,
  CALENDAR_SCROLL_TO,
} from '../../lib/appointments/calendarConfig';
import { isSlotOnFifteenMinuteGrid } from '../../lib/calendarSlot';
import { showToast } from '../ui/Toast';

const DnDCalendar = withDragAndDrop(BigCalendar);

export interface DnDEventArgs {
  event: CalendarEvent;
  start: Date;
  end: Date;
}

interface AppointmentCalendarProps {
  calendarView: CalendarViewType;
  calendarDate: Date;
  calendarEvents: CalendarEvent[];
  calendarStep: number;
  zoomIndex: number;
  selectedAppointment: Appointment | null;
  appointments: Appointment[];
  onSelectSlot?: (range: { start: Date; end: Date }) => void;
  onViewChange: (view: CalendarViewType) => void;
  onNavigate: (date: Date) => void;
  onSelectEvent: (event: CalendarEvent) => void;
  onEventDrop: (args: DnDEventArgs) => void;
  onEventResize: (args: DnDEventArgs) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

export function AppointmentCalendar({
  calendarView,
  calendarDate,
  calendarEvents,
  calendarStep,
  zoomIndex,
  selectedAppointment,
  appointments,
  onSelectSlot,
  onViewChange,
  onNavigate,
  onSelectEvent,
  onEventDrop,
  onEventResize,
  onZoomIn,
  onZoomOut,
}: AppointmentCalendarProps) {
  return (
    <section
      className="w-full p-4 md:p-6 flex-1 overflow-auto flex flex-col"
      style={{
        borderBottom: '1px solid var(--border-soft)',
        backgroundColor: 'var(--bg-surface)',
      }}
    >
      <div className="flex-1 flex flex-col">
        <div className="w-full flex-1 flex flex-col">
          {(calendarView === 'week' || calendarView === 'day') && (
            <div className="flex items-center gap-2 mb-2 justify-end">
              <span className="text-xs text-gray-400 font-medium">Zoom:</span>
              <button
                onClick={onZoomIn}
                disabled={zoomIndex >= ZOOM_LEVELS.length - 1}
                className="px-2 py-0.5 text-xs font-bold rounded disabled:opacity-30 transition-colors"
                style={{ border: '1px solid var(--border-soft)' }}
                title="Zoom in"
              >
                +
              </button>
              <span
                className="text-xs font-mono w-12 text-center"
                style={{ color: 'var(--text-secondary)' }}
              >
                {calendarStep}min
              </span>
              <button
                onClick={onZoomOut}
                disabled={zoomIndex <= 0}
                className="px-2 py-0.5 text-xs font-bold rounded disabled:opacity-30 transition-colors"
                style={{ border: '1px solid var(--border-soft)' }}
                title="Zoom out"
              >
                {'−'}
              </button>
            </div>
          )}
          <DnDCalendar
            localizer={localizer} // eslint-disable-line @typescript-eslint/no-unsafe-assignment
            events={calendarEvents}
            startAccessor="start"
            endAccessor="end"
            style={{ height: calendarView === 'month' ? 500 : 'calc(100vh - 200px)' }}
            view={calendarView}
            date={calendarDate}
            min={CALENDAR_MIN}
            max={CALENDAR_MAX}
            step={calendarStep}
            timeslots={CALENDAR_TIMESLOTS}
            scrollToTime={CALENDAR_SCROLL_TO}
            resizable
            selectable={!!onSelectSlot}
            onSelectSlot={
              onSelectSlot
                ? ({ start, end }: { start: Date | string; end: Date | string }) => {
                    const slot = { start: new Date(start), end: new Date(end) };
                    if (!isSlotOnFifteenMinuteGrid(slot)) {
                      showToast(
                        'Please pick a time in 15-minute increments (:00, :15, :30, :45).',
                        'warning'
                      );
                      return;
                    }
                    onSelectSlot(slot);
                  }
                : undefined
            }
            draggableAccessor={() => true}
            onView={(view: CalendarViewType) => onViewChange(view)}
            onNavigate={(date: Date) => onNavigate(date)}
            onSelectEvent={(event: CalendarEvent) => onSelectEvent(event)}
            onEventDrop={({ event, start, end }: DnDEventArgs) =>
              onEventDrop({ event, start, end })
            }
            onEventResize={({ event, start, end }: DnDEventArgs) =>
              onEventResize({ event, start, end })
            }
            eventPropGetter={(event: CalendarEvent) => {
              const isSelected =
                selectedAppointment && event.id === selectedAppointment.appointment_id;
              let color = '#3b82f6';
              if (!event.resource_id) {
                color = '#6b7280';
              }
              const overlaps = appointments.filter((a) => {
                if (a.appointment_id === event.id) return false;
                const aStart = new Date(a.start_time);
                const aEnd = new Date(a.end_time);
                const eStart = new Date(event.start);
                const eEnd = new Date(event.end);
                return a.resource_id === event.resource_id && aStart < eEnd && aEnd > eStart;
              });
              if (overlaps.length > 0) {
                color = '#dc2626';
              }
              if (isSelected) {
                color = '#2563eb';
              }
              return {
                style: {
                  backgroundColor: color,
                  borderRadius: '4px',
                  border: 'none',
                  color: 'white',
                },
              };
            }}
          />
        </div>
      </div>
    </section>
  );
}
