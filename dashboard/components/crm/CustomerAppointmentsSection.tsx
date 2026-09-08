'use client';

import React from 'react';
import { Calendar, Clock, History, XCircle } from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';

interface CustomerAppointment {
  appointment_id: string;
  start_time: string;
  end_time: string;
  status: string;
  description: string;
  resource_name?: string;
  employee_name?: string;
  location?: string;
}

interface CustomerAppointmentsSectionProps {
  upcomingAppointments: CustomerAppointment[];
  pastAppointments: CustomerAppointment[];
  onCancelAppointment: (appointmentId: string) => void;
  onReactivateAppointment: (appointmentId: string) => void;
}

export function CustomerAppointmentsSection({
  upcomingAppointments,
  pastAppointments,
  onCancelAppointment,
  onReactivateAppointment,
}: CustomerAppointmentsSectionProps) {
  return (
    <>
      {/* UPCOMING APPOINTMENTS */}
      <div id="customer-upcoming" className="space-y-4">
        <h3
          className="font-bold flex items-center text-lg"
          style={{ color: 'var(--text-primary)' }}
        >
          <Calendar className="w-5 h-5 mr-2" style={{ color: 'var(--text-muted)' }} />
          Upcoming Appointments
        </h3>
        {upcomingAppointments.length > 0 ? (
          <div className="space-y-3">
            {upcomingAppointments.map((a) => (
              <div
                key={a.appointment_id}
                className="p-4 rounded-xl shadow-sm flex justify-between items-start"
                style={{
                  border: '1px solid var(--border-soft)',
                  backgroundColor: 'var(--bg-surface)',
                }}
              >
                <div className="space-y-1">
                  <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {a.description}
                  </p>
                  <p
                    className="text-xs flex items-center"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <Clock className="w-3 h-3 mr-1" />
                    {new Date(a.start_time).toLocaleDateString()} at{' '}
                    {new Date(a.start_time).toLocaleTimeString('en-US', {
                      hour: 'numeric',
                      minute: '2-digit',
                      hour12: true,
                    })}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {a.resource_name}
                    {a.employee_name ? ` / ${a.employee_name}` : ''}
                  </p>
                  {a.location && (
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {a.location}
                    </p>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  <Badge variant="primary">Scheduled</Badge>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => onCancelAppointment(a.appointment_id)}
                    aria-label="Cancel appointment"
                  >
                    <XCircle className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={Calendar} title="No upcoming appointments" variant="compact" />
        )}
      </div>

      {/* APPOINTMENT HISTORY */}
      <div id="customer-history" className="space-y-4">
        <h3
          className="font-bold flex items-center text-lg"
          style={{ color: 'var(--text-primary)' }}
        >
          <History className="w-5 h-5 mr-2" style={{ color: 'var(--text-muted)' }} />
          Appointment History
        </h3>
        {pastAppointments.length > 0 ? (
          <div className="space-y-3">
            {pastAppointments.map((a) => {
              const isCanceled = a.status === 'canceled';
              const dateLabel = `${new Date(a.start_time).toLocaleDateString()} at ${new Date(a.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
              const Body = (
                <>
                  <div className="space-y-1">
                    <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {a.description}
                    </p>
                    <p
                      className="text-xs flex items-center"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      <Clock className="w-3 h-3 mr-1" />
                      {dateLabel}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {a.resource_name}
                      {a.employee_name ? ` / ${a.employee_name}` : ''}
                    </p>
                  </div>
                  <Badge
                    variant={
                      a.status === 'completed' ? 'success' : isCanceled ? 'danger' : 'secondary'
                    }
                  >
                    {a.status === 'completed' ? 'Completed' : isCanceled ? 'Canceled' : a.status}
                  </Badge>
                </>
              );
              // Canceled rows are clickable to surface the reactivate affordance.
              return isCanceled ? (
                <button
                  key={a.appointment_id}
                  type="button"
                  onClick={() => onReactivateAppointment(a.appointment_id)}
                  data-testid={`customer-history-canceled-${a.appointment_id}`}
                  aria-label={`Reactivate canceled appointment: ${a.description} on ${dateLabel}`}
                  className="w-full text-left p-4 rounded-xl shadow-sm flex justify-between items-start transition-colors hover:brightness-110"
                  style={{
                    border: '1px solid var(--border-soft)',
                    backgroundColor: 'var(--bg-surface)',
                    cursor: 'pointer',
                  }}
                >
                  {Body}
                </button>
              ) : (
                <div
                  key={a.appointment_id}
                  className="p-4 rounded-xl shadow-sm flex justify-between items-start"
                  style={{
                    border: '1px solid var(--border-soft)',
                    backgroundColor: 'var(--bg-surface)',
                  }}
                >
                  {Body}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={History} title="No past appointments" variant="compact" />
        )}
      </div>
    </>
  );
}

export type { CustomerAppointment };
