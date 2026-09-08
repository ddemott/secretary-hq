import { useState } from 'react';
import { Api, SUPER_ADMIN_TENANT_ID } from './api';
import {
  type Appointment,
  type Customer,
  type Service,
  type Resource,
  type Employee,
} from './types';
import { MOCK_APPOINTMENTS } from './mockData';
import { toLocalISO, toISOStringWithOffset, formatCustomerAddress } from './utils';
import { validateAppointmentTimeRange } from './appointmentValidation';
import { useAppointmentDetail } from './AppointmentDetailContext';
import { useConfirm } from './useConfirm';
import { showToast } from '../components/ui/Toast';
import type { BookingConflict, AvailableAlternative } from '../components/scheduler/ConflictModal';

interface UseAppointmentCRUDOptions {
  tenantId: string | null;
  customers: Customer[];
  resources: Resource[];
  employees: Employee[];
  services: Service[];
}

export function useAppointmentCRUD({
  tenantId,
  customers,
  resources,
  employees,
  services,
}: UseAppointmentCRUDOptions) {
  const {
    selectedAppointment,
    setSelectedAppointment,
    setIsCreating,
    setIsEditing,
    setSaving,
    setError,
    form,
    setForm,
    setShowConfirmModal,
  } = useAppointmentDetail();

  const {
    state: cancelConfirmState,
    confirm: confirmCancel,
    close: closeCancelConfirm,
  } = useConfirm();

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(false);
  const [usingMockData, setUsingMockData] = useState(false);
  const [, setDraftEvent] = useState<{ start: Date; end: Date } | null>(null);
  const [conflict, setConflict] = useState<BookingConflict | null>(null);
  const [nextAvailable, setNextAvailable] = useState<AvailableAlternative[]>([]);
  const [originalAppointment, setOriginalAppointment] = useState<Appointment | null>(null);

  async function fetchAppointments(selectId?: string) {
    setLoading(true);
    try {
      if (!tenantId) {
        setAppointments(MOCK_APPOINTMENTS);
        setUsingMockData(true);
        if (!selectedAppointment) setSelectedAppointment(MOCK_APPOINTMENTS[0]);
        setLoading(false);
        return;
      }

      const data = await Api.appointments.list(tenantId);

      if (!Array.isArray(data)) {
        throw new Error('Unexpected response shape from /appointments');
      }

      setAppointments(data.filter((a: Appointment) => a.status !== 'canceled'));
      setUsingMockData(false);

      if (data.length === 0) {
        if (selectId) {
          setSelectedAppointment(null);
        } else if (!selectedAppointment) {
          setSelectedAppointment(null);
        }
      } else if (selectId) {
        const newlyCreated = data.find((a: Appointment) => a.appointment_id === selectId);
        if (newlyCreated) setSelectedAppointment(newlyCreated);
      } else if (!selectedAppointment) {
        setSelectedAppointment(data[0]);
      } else {
        const updated = data.find(
          (a: Appointment) => a.appointment_id === selectedAppointment.appointment_id
        );
        if (updated) setSelectedAppointment(updated);
      }
    } catch {
      setAppointments(MOCK_APPOINTMENTS);
      setUsingMockData(true);
      if (!selectedAppointment) setSelectedAppointment(MOCK_APPOINTMENTS[0]);
    }
    setLoading(false);
  }

  async function handleUpdate() {
    if (!selectedAppointment) return;
    if (!tenantId) {
      setError('Please log in to edit appointments.');
      return;
    }
    if (usingMockData) {
      setError(
        'Sample appointments cannot be updated. Create a real appointment after logging in.'
      );
      return;
    }

    const validationError = validateAppointmentTimeRange(form.start_time, form.end_time);
    if (validationError) {
      setError(validationError);
      return;
    }

    setShowConfirmModal(false);
    setSaving(true);
    setError('');

    try {
      const res = await Api.appointments.update(
        selectedAppointment.appointment_id,
        selectedAppointment.tenant_id,
        {
          ...form,
          start_time: toISOStringWithOffset(form.start_time),
          end_time: toISOStringWithOffset(form.end_time),
          resource_id: form.resource_id,
          employee_id: form.employee_id || null,
          customer_name: `${form.customer_first_name} ${form.customer_last_name}`.trim(),
          customer_phone: form.customer_phone,
        }
      );

      if (res.success) {
        setIsEditing(false);
        await fetchAppointments();
      } else {
        setError(res.error || 'Failed to update appointment');
      }
    } catch {
      setError('Connection error');
    } finally {
      setSaving(false);
    }
  }

  async function handleCreate() {
    if (!tenantId) {
      setError('Please log in to create appointments.');
      return;
    }

    if (usingMockData) {
      setError(
        'You are viewing sample data only. Sign in to your business account to create appointments that persist.'
      );
      return;
    }

    const validationError = validateAppointmentTimeRange(form.start_time, form.end_time);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError('');

    let targetTenantId = tenantId;
    if (tenantId === SUPER_ADMIN_TENANT_ID) {
      const selectedCustomerObj = customers.find((c) => c.customer_id === form.customer_id);
      if (selectedCustomerObj) {
        targetTenantId = selectedCustomerObj.tenant_id;
      } else {
        setError(
          'Could not determine which business this appointment belongs to. Please pick a customer first.'
        );
        setSaving(false);
        return;
      }
    }

    const matchedSvc = services.find((s) => s.name === form.description);
    try {
      const res = await Api.appointments.create(targetTenantId, {
        ...form,
        start_time: toISOStringWithOffset(form.start_time),
        end_time: toISOStringWithOffset(form.end_time),
        employee_id: form.employee_id || null,
        customer_phone: form.customer_phone,
        service_id: matchedSvc ? matchedSvc.service_id : null,
      });
      if (res.success) {
        setIsCreating(false);
        setDraftEvent(null);
        setSaving(false);
        void fetchAppointments(res.appointment_id);
      } else if (res.error_code === 'TIMESLOT_OCCUPIED' && res.conflict) {
        setConflict(res.conflict);
        setNextAvailable(res.next_available ?? []);
        setError('');
        setSaving(false);
      } else {
        setError(res.error || 'Failed to create appointment');
        setSaving(false);
      }
    } catch {
      setError('Connection error');
      setSaving(false);
    }
  }

  function handleDelete() {
    if (!selectedAppointment) return;
    if (usingMockData) {
      setError(
        'Sample appointments cannot be canceled. Create a real appointment after logging in.'
      );
      return;
    }
    if (!tenantId) {
      setError('Please log in to cancel appointments.');
      return;
    }
    const appointmentId = selectedAppointment.appointment_id;
    confirmCancel({
      title: 'Cancel appointment?',
      message:
        'It will be marked canceled and the slot will free up, but the record stays for history.',
      confirmLabel: 'Cancel appointment',
      confirmVariant: 'danger',
      onConfirm: async () => {
        closeCancelConfirm();
        try {
          const res = await Api.appointments.cancel(appointmentId, tenantId);
          if (res.success) {
            setSelectedAppointment(null);
            void fetchAppointments();
            showToast('Appointment canceled', 'success', {
              label: 'Undo',
              onClick: () => {
                void (async () => {
                  try {
                    const r = await Api.appointments.reactivate(appointmentId, tenantId);
                    if (r.success) {
                      showToast('Appointment restored', 'success');
                      void fetchAppointments();
                    } else if (r.error_code === 'TIMESLOT_OCCUPIED') {
                      showToast(
                        'That time slot is no longer available. Book a new appointment instead.',
                        'error'
                      );
                    } else {
                      showToast(r.error || 'Could not restore appointment', 'error');
                    }
                  } catch {
                    showToast('Connection error — could not restore appointment', 'error');
                  }
                })();
              },
            });
          } else {
            setError(res.error || 'Failed to cancel appointment');
          }
        } catch (e) {
          console.error(e);
          setError('Connection error — could not cancel appointment');
        }
      },
    });
  }

  function startNewAppointment() {
    setIsCreating(true);
    setIsEditing(false);
    setSelectedAppointment(null);
    const now = new Date();
    const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
    const defaultCustomerId = customers[0]?.customer_id || '';
    const defaultCustomer = customers.find((c) => c.customer_id === defaultCustomerId);
    const defaultLocation = formatCustomerAddress(defaultCustomer);
    setDraftEvent({ start: now, end: inOneHour });
    setForm({
      customer_id: defaultCustomerId,
      resource_id: resources[0]?.resource_id || '',
      employee_id: employees[0]?.employee_id || '',
      description: '',
      start_time: toLocalISO(now),
      end_time: toLocalISO(inOneHour),
      location: defaultLocation,
      customer_first_name: '',
      customer_last_name: '',
      customer_phone: '',
      customer_notes: '',
    });
  }

  function requestUpdateConfirmation() {
    if (!selectedAppointment) return;
    setShowConfirmModal(true);
    setIsEditing(true);
  }

  function cancelUpdate() {
    if (originalAppointment) {
      setAppointments((prev) =>
        prev.map((a) =>
          a.appointment_id === originalAppointment.appointment_id ? originalAppointment : a
        )
      );
      setSelectedAppointment(originalAppointment);
    }
    setError('');
    setIsEditing(false);
    setShowConfirmModal(false);
  }

  return {
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
  };
}
