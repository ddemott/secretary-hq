import React, { useEffect, useMemo, useState } from 'react';
import { formatPhone } from '../../lib/phone';
import { type Appointment } from '../../lib/types';
import { toLocalISO, splitFullName } from '../../lib/utils';
import { useStaticData } from '../../lib/hooks';
import { useActiveTenantId } from '../../lib/SessionContext';
import { useVocabulary } from '@/lib/VocabularyContext';
import { type View as CalendarViewType } from 'react-big-calendar';
import { AppointmentListSidebar } from './AppointmentListSidebar';
import { AppointmentDetailPanel } from './AppointmentDetailPanel';
import {
  AppointmentDetailProvider,
  useAppointmentDetail,
} from '../../lib/AppointmentDetailContext';
import { ConflictModal } from '../scheduler/ConflictModal';
import { ConfirmModal } from '../ui/ConfirmModal';
import { AppointmentCalendar, type DnDEventArgs } from './AppointmentCalendar';
import { useAppointmentCRUD } from '../../lib/useAppointmentCRUD';
import { ZOOM_LEVELS, toCalendarEvent } from '../../lib/appointments/calendarConfig';

export interface AppointmentViewProps {
  /** When provided, the BigCalendar becomes `selectable` and slot clicks fire
      with `{ start, end }`. SchedulerView wires this to the Quick Book panel. */
  onSelectSlot?: (range: { start: Date; end: Date }) => void;
  /** Pre-selects this appointment and enters edit mode on mount/change.
      Wired by SchedulerView so the AppointmentPopover's Edit button works
      from non-Calendar sub-tabs. */
  initialEditAppointmentId?: string | null;
  /** Called once after `initialEditAppointmentId` has been consumed. */
  onInitialEditConsumed?: () => void;
}

export default function AppointmentView(props: AppointmentViewProps = {}) {
  return (
    <AppointmentDetailProvider>
      <AppointmentViewInner {...props} />
    </AppointmentDetailProvider>
  );
}

function AppointmentViewInner({
  onSelectSlot,
  initialEditAppointmentId,
  onInitialEditConsumed,
}: AppointmentViewProps) {
  const tenantId = useActiveTenantId();
  const { customers, resources, employees, services } = useStaticData(tenantId);
  const vocab = useVocabulary();
  const {
    selectedAppointment,
    setSelectedAppointment,
    isCreating,
    setIsCreating,
    setIsEditing,
    showDetailOnMobile,
    setShowDetailOnMobile,
    form,
    setForm,
    setShowConfirmModal,
  } = useAppointmentDetail();

  const {
    appointments,
    setAppointments,
    loading,
    usingMockData,
    conflict,
    nextAvailable,
    setConflict,
    setNextAvailable,
    originalAppointment,
    setOriginalAppointment,
    fetchAppointments,
    handleUpdate,
    handleCreate,
    handleDelete,
    startNewAppointment,
    requestUpdateConfirmation,
    cancelUpdate,
    cancelConfirmState,
    closeCancelConfirm,
  } = useAppointmentCRUD({ tenantId, customers, resources, employees, services });

  const calendarEvents = useMemo(
    () => appointments.map((a: Appointment) => toCalendarEvent(a, vocab.booking_label)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appointments, vocab.booking_label]
  );

  const [calendarView, setCalendarView] = useState<CalendarViewType>('month');
  const [calendarDate, setCalendarDate] = useState<Date>(new Date());
  const [zoomIndex, setZoomIndex] = useState(1);
  const calendarStep = ZOOM_LEVELS[zoomIndex];

  const findCustomerById = (id: string) => customers.find((c) => c.customer_id === id);

  function getServiceBaseTimes(appointment: Appointment): { start: Date; end: Date } {
    return {
      start: appointment.start_time ? new Date(appointment.start_time) : new Date(),
      end: appointment.end_time ? new Date(appointment.end_time) : new Date(),
    };
  }

  useEffect(() => {
    void fetchAppointments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(() => {
    if (!initialEditAppointmentId) return;
    if (appointments.length === 0) return;
    const appt = appointments.find((a) => a.appointment_id === initialEditAppointmentId);
    if (!appt) {
      onInitialEditConsumed?.();
      return;
    }
    setSelectedAppointment(appt);
    setShowDetailOnMobile(true);
    setIsCreating(false);
    const t = setTimeout(() => {
      setIsEditing(true);
      onInitialEditConsumed?.();
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialEditAppointmentId, appointments]);

  useEffect(() => {
    if (selectedAppointment) {
      setIsEditing(false);
      setIsCreating(false);
      const customer =
        selectedAppointment.customers || ({} as NonNullable<Appointment['customers']>);
      const customerMetadata = (customer.metadata || {}) as Record<string, string>;
      const { first, last } = splitFullName(customer.name || '');
      const derivedFirst = customer.first_name || first || '';
      const derivedLast = customer.last_name || last || '';
      const baseTimes = getServiceBaseTimes(selectedAppointment);
      setForm({
        customer_id: selectedAppointment.customer_id,
        resource_id: selectedAppointment.resource_id,
        employee_id: selectedAppointment.employee_id || '',
        description: selectedAppointment.description || '',
        start_time: toLocalISO(baseTimes.start),
        end_time: toLocalISO(baseTimes.end),
        location: selectedAppointment.location || '',
        customer_first_name: derivedFirst,
        customer_last_name: derivedLast,
        customer_phone: formatPhone(customer.phone) || '',
        customer_notes: customerMetadata.notes || '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAppointment]);

  function handleEventDrop({ event, start, end }: DnDEventArgs) {
    const apt = appointments.find((a) => a.appointment_id === event.id);
    if (!apt) return;
    setOriginalAppointment(apt);
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    setAppointments((prev) =>
      prev.map((a) =>
        a.appointment_id === apt.appointment_id
          ? { ...a, start_time: startIso, end_time: endIso }
          : a
      )
    );
    setSelectedAppointment({ ...apt, start_time: startIso, end_time: endIso });
    setIsEditing(true);
    setIsCreating(false);
    setShowDetailOnMobile(true);
    setForm((prev) => ({ ...prev, start_time: toLocalISO(start), end_time: toLocalISO(end) }));
    setShowConfirmModal(true);
  }

  function handleEventResize({ event, start, end }: DnDEventArgs) {
    const apt = appointments.find((a) => a.appointment_id === event.id);
    if (!apt) return;
    setOriginalAppointment(apt);
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    setAppointments((prev) =>
      prev.map((a) =>
        a.appointment_id === apt.appointment_id
          ? { ...a, start_time: startIso, end_time: endIso }
          : a
      )
    );
    setSelectedAppointment({ ...apt, start_time: startIso, end_time: endIso });
    setIsEditing(true);
    setIsCreating(false);
    setShowDetailOnMobile(true);
    setForm((prev) => ({ ...prev, start_time: toLocalISO(start), end_time: toLocalISO(end) }));
    setShowConfirmModal(true);
  }

  return (
    <div
      className="flex flex-1 overflow-hidden relative transition-colors duration-200 flex-col"
      style={{ color: 'var(--text-primary)' }}
    >
      <AppointmentCalendar
        calendarView={calendarView}
        calendarDate={calendarDate}
        calendarEvents={calendarEvents}
        calendarStep={calendarStep}
        zoomIndex={zoomIndex}
        selectedAppointment={selectedAppointment}
        appointments={appointments}
        onSelectSlot={onSelectSlot}
        onViewChange={setCalendarView}
        onNavigate={setCalendarDate}
        onSelectEvent={(event) => {
          setSelectedAppointment(appointments.find((a) => a.appointment_id === event.id) || null);
          setShowDetailOnMobile(true);
          setIsCreating(false);
          setCalendarDate(new Date(event.start));
        }}
        onEventDrop={handleEventDrop}
        onEventResize={handleEventResize}
        onZoomIn={() => setZoomIndex((i) => Math.min(i + 1, ZOOM_LEVELS.length - 1))}
        onZoomOut={() => setZoomIndex((i) => Math.max(i - 1, 0))}
      />

      <div className="flex flex-1 overflow-hidden relative">
        <AppointmentListSidebar
          appointments={appointments}
          selectedAppointment={selectedAppointment}
          loading={loading}
          usingMockData={usingMockData}
          showDetailOnMobile={showDetailOnMobile}
          bookingLabel={vocab.booking_label}
          onSelectAppointment={(apt) => {
            setSelectedAppointment(apt);
            setShowDetailOnMobile(true);
            setIsCreating(false);
            setCalendarDate(new Date(apt.start_time));
          }}
          onRefresh={() => fetchAppointments()}
          onStartNew={startNewAppointment}
          getServiceBaseTimes={getServiceBaseTimes}
        />

        <AppointmentDetailPanel
          customers={customers}
          resources={resources}
          employees={employees}
          services={services}
          vocab={vocab}
          getServiceBaseTimes={getServiceBaseTimes}
          findCustomerById={findCustomerById}
          onEdit={() => {
            if (selectedAppointment) {
              setOriginalAppointment(selectedAppointment);
            }
            setIsEditing(true);
          }}
          onCancelEdit={() => {
            setIsEditing(false);
            setIsCreating(false);
          }}
          onDelete={handleDelete}
          onSave={handleCreate}
          onRequestUpdateConfirmation={requestUpdateConfirmation}
          onCancelUpdate={cancelUpdate}
          onConfirmUpdate={handleUpdate}
          onCloseMobile={() => {
            setShowDetailOnMobile(false);
            setIsCreating(false);
          }}
        />
      </div>

      <ConflictModal
        isOpen={conflict !== null}
        conflict={conflict}
        nextAvailable={nextAvailable}
        onPickAlternative={(slot) => {
          const toLocalInputValue = (iso: string) => {
            const d = new Date(iso);
            const offset = d.getTimezoneOffset() * 60000;
            return new Date(d.getTime() - offset).toISOString().slice(0, 16);
          };
          setForm({
            ...form,
            start_time: toLocalInputValue(slot.start_time),
            end_time: toLocalInputValue(slot.end_time),
            // A resourceless business (a consultancy whose only "resource" is
            // the owner's time) returns a null resource on an alternative slot.
            // This form's convention for "none" is the empty string.
            resource_id: slot.resource_id ?? '',
            employee_id: slot.employee_id,
          });
          setConflict(null);
          setNextAvailable([]);
        }}
        onClose={() => {
          setConflict(null);
          setNextAvailable([]);
        }}
      />

      <ConfirmModal {...cancelConfirmState} onClose={closeCancelConfirm} />
    </div>
  );
}
