import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useStaticData, useTenantTimezone } from '../../lib/hooks';
import { useActiveTenantId } from '../../lib/SessionContext';
import { useVocabulary } from '@/lib/VocabularyContext';
import { useSchedulerData } from './useSchedulerData';
import type { SchedulerAppointment } from './useSchedulerData';
import { ResourceColumnsView } from './ResourceColumnsView';
import { AppointmentListView } from './AppointmentListView';
import { QuickBookPanel } from './QuickBookPanel';
import { EmployeeDayFocusPanel } from './EmployeeDayFocusPanel';
import NewSchedulerView from './NewSchedulerView';
import { AppointmentPopover } from './AppointmentPopover';
import { ConfirmModal } from '../ui/ConfirmModal';
import AppointmentView from '../appointments/AppointmentView';
import { SchedulerToolbar } from './SchedulerToolbar';
import { useSchedulerActions } from '../../lib/useSchedulerActions';

export type SchedulerViewTab = 'day' | 'calendar';
type DayMode = 'staff' | 'resources' | 'list';

const VALID_VIEW_TABS: SchedulerViewTab[] = ['day', 'calendar'];
const VALID_DAY_MODES: DayMode[] = ['staff', 'resources', 'list'];

function resolveInitialView(): SchedulerViewTab {
  if (typeof window === 'undefined') return 'day';
  const raw = new URLSearchParams(window.location.search).get('subtab');
  if (raw && (VALID_VIEW_TABS as string[]).includes(raw)) return raw as SchedulerViewTab;
  return 'day';
}

function resolveInitialDayMode(): DayMode {
  if (typeof window === 'undefined') return 'staff';
  const raw = new URLSearchParams(window.location.search).get('daymode');
  if (raw && (VALID_DAY_MODES as string[]).includes(raw)) return raw as DayMode;
  return 'staff';
}

const ZOOM_LEVELS = [40, 60, 90, 120, 180];

export default function SchedulerView() {
  const tenantId = useActiveTenantId();
  const vocab = useVocabulary();
  const tenantTimezone = useTenantTimezone();
  const [activeView, setActiveView] = useState<SchedulerViewTab>(resolveInitialView);
  const [dayMode, setDayMode] = useState<DayMode>(resolveInitialDayMode);

  const {
    customers,
    resources,
    employees: allStaff,
    services,
    refresh: refreshStaticData,
  } = useStaticData(tenantId);
  const employees = useMemo(() => allStaff.filter((e) => e.type !== 'user'), [allStaff]);

  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [zoomIndex, setZoomIndex] = useState(1);
  const hourWidth = ZOOM_LEVELS[zoomIndex];

  const [focusEmployee, setFocusEmployee] = useState<{ employee_id: string; name: string } | null>(
    null
  );

  const {
    appointments,
    loading,
    appointmentsByEmployee,
    appointmentsByResource,
    shiftsByEmployee,
    refresh: refreshScheduler,
  } = useSchedulerData(tenantId, selectedDate, employees, resources);

  const handleRefresh = useCallback(() => {
    void refreshScheduler();
    void refreshStaticData();
  }, [refreshScheduler, refreshStaticData]);

  const [apptPopover, setApptPopover] = useState<{
    appointment: SchedulerAppointment;
    anchorRect: DOMRect;
  } | null>(null);

  const actions = useSchedulerActions({
    tenantId,
    appointments,
    selectedDate,
    refreshScheduler,
    refreshStaticData,
    onPopoverClose: () => setApptPopover(null),
  });

  const handleAppointmentClick = useCallback((appt: SchedulerAppointment, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setApptPopover((prev) =>
      prev?.appointment.appointment_id === appt.appointment_id
        ? null
        : { appointment: appt, anchorRect: rect }
    );
  }, []);

  // Sync activeView + dayMode to ?subtab=…&daymode=…
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    let changed = false;
    if (params.get('subtab') !== activeView) {
      params.set('subtab', activeView);
      changed = true;
    }
    if (activeView === 'day') {
      if (params.get('daymode') !== dayMode) {
        params.set('daymode', dayMode);
        changed = true;
      }
    } else if (params.has('daymode')) {
      params.delete('daymode');
      changed = true;
    }
    if (changed) {
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
    }
  }, [activeView, dayMode]);

  // Restore view + day-mode from URL on browser back/forward
  useEffect(() => {
    function onPopState() {
      const nextView = resolveInitialView();
      const nextMode = resolveInitialDayMode();
      setActiveView((prev) => (prev === nextView ? prev : nextView));
      setDayMode((prev) => (prev === nextMode ? prev : nextMode));
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  return (
    <div className="flex flex-col flex-1 overflow-hidden" data-testid="scheduler-view">
      <SchedulerToolbar
        activeView={activeView}
        dayMode={dayMode}
        selectedDate={selectedDate}
        zoomIndex={zoomIndex}
        hourWidth={hourWidth}
        loading={loading}
        vocab={vocab}
        tenantTimezone={tenantTimezone}
        onViewChange={setActiveView}
        onDayModeChange={setDayMode}
        onDateChange={setSelectedDate}
        onZoomChange={setZoomIndex}
        onRefresh={handleRefresh}
        onNewQuickBook={() => actions.handleNewQuickBook()}
      />

      <div
        className={
          activeView === 'day' && dayMode === 'staff'
            ? 'flex-1 flex overflow-hidden'
            : 'flex-1 overflow-auto bg-white dark:bg-[#111]'
        }
      >
        {activeView === 'calendar' && (
          <AppointmentView
            initialEditAppointmentId={actions.pendingEditAppointmentId}
            onInitialEditConsumed={() => actions.setPendingEditAppointmentId(null)}
            onSelectSlot={({ start, end }) => {
              const startHour = start.getHours();
              const endHour = end.getHours();
              actions.handleNewQuickBook({
                date: start,
                hour: startHour,
                endHour: endHour > startHour ? endHour : startHour + 1,
              });
            }}
          />
        )}
        {activeView === 'day' && dayMode === 'staff' && (
          <NewSchedulerView
            selectedDate={selectedDate}
            onDateChange={setSelectedDate}
            onQuickBook={actions.handleNewQuickBook}
          />
        )}
        {activeView === 'day' && dayMode === 'resources' && (
          <ResourceColumnsView
            resources={resources}
            appointmentsByResource={appointmentsByResource}
            shiftsByEmployee={shiftsByEmployee}
            employees={employees}
            onAppointmentClick={handleAppointmentClick}
            onAppointmentDelete={actions.handleAppointmentDelete}
            onAppointmentMove={actions.handleAppointmentMove}
            hourWidth={hourWidth}
          />
        )}
        {activeView === 'day' && dayMode === 'list' && (
          <AppointmentListView
            appointments={appointments}
            employees={employees}
            resources={resources}
            onAppointmentClick={handleAppointmentClick}
          />
        )}
      </div>

      <QuickBookPanel
        isOpen={actions.quickBookOpen}
        onClose={() => actions.setQuickBookOpen(false)}
        tenantId={tenantId}
        prefill={actions.quickBookPrefill}
        customers={customers}
        employees={employees}
        resources={resources}
        services={services}
        onBooked={actions.handleQuickBooked}
      />
      <EmployeeDayFocusPanel
        isOpen={!!focusEmployee}
        onClose={() => setFocusEmployee(null)}
        employee={focusEmployee}
        appointments={
          focusEmployee ? appointmentsByEmployee.get(String(focusEmployee.employee_id)) || [] : []
        }
        shifts={focusEmployee ? shiftsByEmployee.get(String(focusEmployee.employee_id)) || [] : []}
        onAppointmentClick={handleAppointmentClick}
      />

      {apptPopover && (
        <AppointmentPopover
          appointment={apptPopover.appointment}
          employeeName={
            apptPopover.appointment.employee_id
              ? employees.find(
                  (e) => String(e.employee_id) === String(apptPopover.appointment.employee_id)
                )?.name || null
              : null
          }
          resourceName={apptPopover.appointment.resources?.name || null}
          anchorRect={apptPopover.anchorRect}
          onClose={() => setApptPopover(null)}
          onEdit={(id) => {
            actions.handlePopoverEdit(id);
            setActiveView('calendar');
            setApptPopover(null);
          }}
          onCancel={actions.handlePopoverCancel}
        />
      )}

      <ConfirmModal {...actions.confirmState} onClose={actions.closeConfirm} />
    </div>
  );
}
