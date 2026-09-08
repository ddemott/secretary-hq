'use client';

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Clock } from 'lucide-react';
import { Api } from '../lib/api';
import { useStaticData } from '../lib/hooks';
import { useActiveTenantId } from '../lib/SessionContext';
import { useVocabulary } from '@/lib/VocabularyContext';
import type { EffectiveShift } from '../lib/types';
import { showToast } from './ui/Toast';
import { ConfirmModal } from './ui/ConfirmModal';
import { useConfirm } from '../lib/useConfirm';
import { LoadingState } from './ui/LoadingState';
import {
  toDateStr,
  getWeekStart,
  formatWeekLabel,
  DAY_NAMES,
  formatDate,
  DEFAULT_COL_W,
  ZOOM_STEP,
  MIN_COL_W,
  MAX_COL_W,
} from './shifts/shiftFormatters';
import { SoloScheduleView } from './shifts/SoloScheduleView';
import { WeekControls } from './shifts/WeekControls';
import { ShiftTimeline } from './shifts/ShiftTimeline';
import type { ShiftWeekDay } from './shifts/ShiftTimeline';
import { ShiftEditorModal } from './shifts/ShiftEditorModal';

export default function ShiftManagementView() {
  const tenantId = useActiveTenantId();
  const { employees, loading: empsLoading } = useStaticData(tenantId);
  const vocab = useVocabulary();

  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [weekStart, setWeekStart] = useState<Date>(() => getWeekStart(new Date()));
  const [scheduledShifts, setScheduledShifts] = useState<EffectiveShift[]>([]);
  const [loadingShifts, setLoadingShifts] = useState(false);
  const [copying, setCopying] = useState(false);
  const { state: confirmState, confirm: confirmAction, close: closeConfirm } = useConfirm();

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDate, setEditingDate] = useState<string | null>(null);
  // editingExistsAsOverride: true when the shift row exists in employee_schedule
  // (created via /shifts/overrides/create or wizard's expand-weekly). false means
  // it's a weekly-pattern projection with no override row yet — delete is a no-op.
  const [editingExistsAsOverride, setEditingExistsAsOverride] = useState(false);
  const [modalForm, setModalForm] = useState({
    start_time: '08:00',
    end_time: '17:00',
    is_off: false,
  });

  const [colW, setColW] = useState(DEFAULT_COL_W);

  // Auto-select first employee when list loads
  useEffect(() => {
    if (!selectedEmployeeId && employees.length > 0) {
      setSelectedEmployeeId(employees[0].employee_id);
    }
  }, [employees, selectedEmployeeId]);

  // Fetch scheduled shifts when employee or week changes
  useEffect(() => {
    if (!selectedEmployeeId || !tenantId) {
      setScheduledShifts([]);
      return;
    }
    void fetchShifts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmployeeId, tenantId, weekStart]);

  async function fetchShifts() {
    if (!selectedEmployeeId || !tenantId) return;
    setLoadingShifts(true);
    try {
      const endDate = new Date(weekStart);
      endDate.setDate(endDate.getDate() + 6);
      const data = await Api.shifts.schedule.forDate(
        tenantId,
        selectedEmployeeId,
        toDateStr(weekStart),
        toDateStr(endDate)
      );
      setScheduledShifts(Array.isArray(data) ? data : []);
    } catch {
      setScheduledShifts([]);
    } finally {
      setLoadingShifts(false);
    }
  }

  function shiftForDate(dateStr: string): EffectiveShift | undefined {
    return scheduledShifts.find((s) => s.shift_date.substring(0, 10) === dateStr);
  }

  function openEditor(dateStr: string) {
    const existing = shiftForDate(dateStr);
    setEditingDate(dateStr);
    setEditingExistsAsOverride(!!existing?.is_override);
    if (existing && !existing.is_off && existing.start_time && existing.end_time) {
      setModalForm({
        start_time: existing.start_time.substring(0, 5),
        end_time: existing.end_time.substring(0, 5),
        is_off: false,
      });
    } else {
      setModalForm({ start_time: '08:00', end_time: '17:00', is_off: false });
    }
    setIsModalOpen(true);
  }

  async function handleSave() {
    if (!selectedEmployeeId || !tenantId || !editingDate) return;
    if (!modalForm.is_off) {
      if (!modalForm.start_time || !modalForm.end_time) {
        showToast('Start and end times are required', 'error');
        return;
      }
      if (modalForm.start_time >= modalForm.end_time) {
        showToast('End time must be after start time', 'error');
        return;
      }
    }
    try {
      const res = await Api.shifts.schedule.save(tenantId, {
        employee_id: selectedEmployeeId,
        shift_date: editingDate,
        start_time: modalForm.is_off ? undefined : modalForm.start_time,
        end_time: modalForm.is_off ? undefined : modalForm.end_time,
        is_off: modalForm.is_off,
      });
      if (!res.success) {
        showToast(res.error || 'Failed to save schedule', 'error');
        return;
      }
      setIsModalOpen(false);
      void fetchShifts();
    } catch {
      showToast('Failed to save schedule', 'error');
    }
  }

  async function handleDelete(dateStr: string) {
    if (!tenantId || !selectedEmployeeId) return;
    try {
      const res = await Api.shifts.schedule.remove(selectedEmployeeId, dateStr, tenantId);
      if (!res.success) {
        showToast(res.error || 'Failed to remove schedule', 'error');
        return;
      }
      void fetchShifts();
    } catch {
      showToast('Failed to remove schedule', 'error');
    }
  }

  async function handleClearDay(dateStr: string) {
    if (!selectedEmployeeId || !tenantId) return;
    try {
      const res = await Api.shifts.schedule.save(tenantId, {
        employee_id: selectedEmployeeId,
        shift_date: dateStr,
        is_off: true,
      });
      if (!res.success) {
        showToast(res.error || 'Failed to clear schedule', 'error');
        return;
      }
      void fetchShifts();
    } catch {
      showToast('Failed to clear schedule', 'error');
    }
  }

  // Wires the timeline's delete button to the confirm dialog; after confirm
  // delegates to handleDelete (override row exists) or handleClearDay (weekly
  // pattern projection — mark as OFF since there's no row to DELETE).
  function handleTimelineDeleteShift(dateStr: string) {
    const shift = shiftForDate(dateStr);
    const day = weekDays.find((d) => d.dateStr === dateStr);
    confirmAction({
      title: 'Delete Shift',
      message: `Remove this shift for ${day?.label ?? dateStr}?`,
      confirmLabel: 'Delete',
      onConfirm: () => {
        closeConfirm();
        if (shift?.is_override) {
          void handleDelete(dateStr);
        } else {
          void handleClearDay(dateStr);
        }
      },
    });
  }

  function handleCopyToNextWeek() {
    if (!selectedEmployeeId || !tenantId) return;
    const hasAnyShift = scheduledShifts.some((s) => !s.is_off && s.start_time && s.end_time);
    if (!hasAnyShift) {
      showToast('No shifts to copy — schedule at least one day first', 'warning');
      return;
    }
    const nextWeekStart = new Date(weekStart);
    nextWeekStart.setDate(nextWeekStart.getDate() + 7);
    confirmAction({
      title: 'Copy Week Forward',
      message: `Copy this week's schedule to ${formatWeekLabel(nextWeekStart)}? Any existing shifts that week will be overwritten.`,
      confirmLabel: 'Copy',
      confirmVariant: 'primary',
      onConfirm: async () => {
        closeConfirm();
        setCopying(true);
        try {
          const result = await Api.shifts.copyWeek(
            tenantId,
            selectedEmployeeId,
            toDateStr(weekStart),
            toDateStr(nextWeekStart)
          );
          if (!result.success) {
            showToast(result.error || 'Failed to copy shifts', 'error');
            return;
          }
          showToast(
            `Copied ${result.copied} shift${result.copied === 1 ? '' : 's'} to next week`,
            'success'
          );
        } catch {
          showToast('Failed to copy shifts', 'error');
        } finally {
          setCopying(false);
        }
      },
    });
  }

  const handleZoomIn = useCallback(
    () => setColW((prev) => Math.min(prev + ZOOM_STEP, MAX_COL_W)),
    []
  );
  const handleZoomOut = useCallback(
    () => setColW((prev) => Math.max(prev - ZOOM_STEP, MIN_COL_W)),
    []
  );

  const weekDays = useMemo<ShiftWeekDay[]>(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);
        return {
          date: d,
          dateStr: toDateStr(d),
          label: `${DAY_NAMES[d.getDay()]} ${formatDate(d)}`,
          isToday: toDateStr(d) === toDateStr(new Date()),
        };
      }),
    [weekStart]
  );

  const activeEmployees = useMemo(
    () => employees.filter((e) => e.type === 'employee'),
    [employees]
  );

  if (empsLoading && activeEmployees.length === 0) {
    return <LoadingState message={`Loading ${vocab.employee_label.toLowerCase()} schedule…`} />;
  }

  // Solo path — single employee gets the simple Mon-Sun form instead of the
  // full team timeline. Same data format (expandWeekly) as the setup wizard.
  if (activeEmployees.length === 1) {
    return (
      <SoloScheduleView
        tenantId={tenantId}
        employeeId={activeEmployees[0].employee_id}
        employeeName={activeEmployees[0].first_name || activeEmployees[0].name}
      />
    );
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden p-8 transition-colors duration-200"
      style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
    >
      <header className="mb-4 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center">
            <div
              className="p-2 rounded-lg mr-4"
              style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-soft)' }}
            >
              <Clock className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-3xl font-display">{vocab.employee_label} Schedule</h1>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                Schedule your team&apos;s working hours by date.
              </p>
            </div>
          </div>
        </div>

        {/* Employee selector */}
        <div className="mb-4" data-testid="shift-employee-selector">
          <label
            className="text-xs font-bold uppercase tracking-widest mb-2 block"
            style={{ color: 'var(--text-muted)' }}
          >
            Select {vocab.employee_label}
          </label>
          <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
            {activeEmployees.map((emp) => (
              <button
                key={emp.employee_id}
                onClick={() => setSelectedEmployeeId(emp.employee_id)}
                className={`px-4 py-2 rounded-xl text-sm font-bold whitespace-nowrap transition-all ${selectedEmployeeId === emp.employee_id ? 'text-white shadow-lg scale-105' : ''}`}
                style={
                  selectedEmployeeId === emp.employee_id
                    ? { backgroundColor: 'var(--accent)' }
                    : { backgroundColor: 'var(--bg-raised)', color: 'var(--text-secondary)' }
                }
                data-testid={`shift-employee-${emp.employee_id}`}
              >
                {emp.name}
              </button>
            ))}
            {activeEmployees.length === 0 && (
              <p className="text-sm italic" style={{ color: 'var(--text-muted)' }}>
                No {vocab.employee_plural.toLowerCase()} found. Add them in {vocab.employee_label}{' '}
                Management first.
              </p>
            )}
          </div>
        </div>

        {/* Week navigation + zoom */}
        {selectedEmployeeId && (
          <WeekControls
            weekStart={weekStart}
            copying={copying}
            loadingShifts={loadingShifts}
            colW={colW}
            onPrevWeek={() =>
              setWeekStart((d) => {
                const n = new Date(d);
                n.setDate(n.getDate() - 7);
                return n;
              })
            }
            onNextWeek={() =>
              setWeekStart((d) => {
                const n = new Date(d);
                n.setDate(n.getDate() + 7);
                return n;
              })
            }
            onToday={() => setWeekStart(getWeekStart(new Date()))}
            onCopyToNextWeek={handleCopyToNextWeek}
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
          />
        )}
      </header>

      <div className="flex-1 overflow-hidden">
        <ShiftTimeline
          weekDays={weekDays}
          scheduledShifts={scheduledShifts}
          colW={colW}
          loadingShifts={loadingShifts}
          selectedEmployeeId={selectedEmployeeId}
          shiftForDate={shiftForDate}
          onOpenEditor={openEditor}
          onDeleteShift={handleTimelineDeleteShift}
          employeeLabel={vocab.employee_label}
        />
      </div>

      <ShiftEditorModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        editingDate={editingDate}
        editingExistsAsOverride={editingExistsAsOverride}
        currentShift={editingDate ? shiftForDate(editingDate) : undefined}
        modalForm={modalForm}
        onFormChange={setModalForm}
        onSave={() => void handleSave()}
        onDelete={() => {
          if (editingExistsAsOverride && editingDate) {
            void handleDelete(editingDate);
          } else if (editingDate) {
            void handleClearDay(editingDate);
          }
          setIsModalOpen(false);
        }}
      />
      <ConfirmModal {...confirmState} onClose={closeConfirm} />
    </div>
  );
}
