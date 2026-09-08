'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { type Customer } from '@/lib/types';
import { MOCK_CUSTOMERS, MOCK_SUMMARIES } from '@/lib/mockData';
import { Api } from '../../lib/api';
import { useActiveTenantId, useSessionContext } from '../../lib/SessionContext';
import { CustomerDetailPanel } from '../CustomerDetailPanel';
import { CustomerSidebar } from './CustomerSidebar';
import { useCustomerForm } from '../../lib/useCustomerForm';
import { useConfirm } from '../../lib/useConfirm';
import { ConfirmModal } from '../ui/ConfirmModal';
import { showToast } from '../ui/Toast';

export default function CRMView() {
  const tenantId = useActiveTenantId();
  const { role, isAdmin } = useSessionContext();
  const isOwner = role === 'owner' || isAdmin;

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [summaries, setSummaries] = useState<
    {
      call_summary_id: string;
      customer_id: string;
      summary: string;
      call_timestamp?: string;
      created_at?: string;
      has_transcript?: boolean;
    }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [showDetailOnMobile, setShowDetailOnMobile] = useState(false);
  const [customerAppointments, setCustomerAppointments] = useState<
    {
      appointment_id: string;
      start_time: string;
      end_time: string;
      status: string;
      description: string;
      resource_name?: string;
      employee_name?: string;
      location?: string;
    }[]
  >([]);

  const { state: confirmState, confirm, close: closeConfirm } = useConfirm();

  const {
    isEditing,
    setIsEditing,
    isCreating,
    setIsCreating,
    saving,
    editForm,
    handleEditFormChange,
    handleSave,
    handleCreate,
    startNewCustomer,
  } = useCustomerForm({
    selectedCustomer,
    tenantId,
    onSaved: () => void fetchCustomers(),
    onCreated: () => void fetchCustomers(),
  });

  useEffect(() => {
    if (tenantId) void fetchCustomers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(() => {
    if (selectedCustomer) {
      void fetchHistory(selectedCustomer.customer_id);
      void fetchCustomerAppointments(selectedCustomer.customer_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer]);

  async function fetchCustomers() {
    setLoading(true);
    try {
      const data = await Api.customers.list(tenantId);
      if (!data || data.length === 0) {
        if (!tenantId) {
          setCustomers(MOCK_CUSTOMERS);
          if (!selectedCustomer) setSelectedCustomer(MOCK_CUSTOMERS[0]);
        } else {
          setCustomers([]);
        }
      } else {
        setCustomers(data);
        if (!selectedCustomer) setSelectedCustomer(data[0]);
      }
    } catch {
      if (!tenantId) {
        setCustomers(MOCK_CUSTOMERS);
        if (!selectedCustomer) setSelectedCustomer(MOCK_CUSTOMERS[0]);
      } else {
        setCustomers([]);
        setSelectedCustomer(null);
        showToast('Could not load customers. Please try again.', 'error');
      }
    }
    setLoading(false);
  }

  async function fetchHistory(customerId: string) {
    try {
      const data = await Api.callSummaries.list(tenantId, customerId);
      setSummaries(
        !data || data.length === 0
          ? tenantId
            ? []
            : MOCK_SUMMARIES.filter((s) => s.customer_id === customerId)
          : data
      );
    } catch {
      setSummaries(tenantId ? [] : MOCK_SUMMARIES.filter((s) => s.customer_id === customerId));
    }
  }

  async function fetchCustomerAppointments(customerId: string) {
    try {
      const data = await Api.customers.appointments(customerId, tenantId);
      setCustomerAppointments(data || []);
    } catch {
      setCustomerAppointments([]);
    }
  }

  function handleDelete() {
    if (!selectedCustomer) return;
    confirm({
      title: 'Delete Customer',
      message: `Are you sure you want to delete ${selectedCustomer.name}? This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        closeConfirm();
        try {
          const res = await Api.customers.delete(selectedCustomer.customer_id);
          if (res.success) {
            showToast('Customer deleted.', 'success');
            setSelectedCustomer(null);
            void fetchCustomers();
          } else {
            showToast(res.error || 'Failed to delete customer.', 'error');
          }
        } catch (e) {
          console.error(e);
          showToast('Failed to delete customer.', 'error');
        }
      },
    });
  }

  function handleCancelAppointment(appointmentId: string) {
    confirm({
      title: 'Cancel Appointment',
      message: 'Are you sure you want to cancel this appointment?',
      confirmLabel: 'Cancel Appointment',
      onConfirm: async () => {
        closeConfirm();
        try {
          const res = await Api.appointments.cancel(appointmentId, tenantId);
          if (res.success) {
            showToast('Appointment canceled.', 'success');
            if (selectedCustomer) void fetchCustomerAppointments(selectedCustomer.customer_id);
          } else {
            showToast(res.error || 'Failed to cancel appointment.', 'error');
          }
        } catch (e) {
          console.error(e);
          showToast('Failed to cancel appointment.', 'error');
        }
      },
    });
  }

  function handleReactivateAppointment(appointmentId: string) {
    confirm({
      title: 'Reactivate Appointment',
      message:
        'Restore this canceled appointment to the schedule? It will be added back to connected calendars.',
      confirmLabel: 'Reactivate',
      onConfirm: async () => {
        closeConfirm();
        try {
          const res = await Api.appointments.reactivate(appointmentId, tenantId);
          if (res.success) {
            showToast('Appointment reactivated.', 'success');
            if (selectedCustomer) void fetchCustomerAppointments(selectedCustomer.customer_id);
            return;
          }
          if (res.error_code === 'TIMESLOT_OCCUPIED') {
            showToast(
              'That time slot is no longer available. Book a new appointment instead.',
              'error'
            );
          } else if (res.error_code === 'NOT_CANCELED') {
            showToast('This appointment is already active.', 'info');
            if (selectedCustomer) void fetchCustomerAppointments(selectedCustomer.customer_id);
          } else {
            showToast(res.error || 'Failed to reactivate appointment.', 'error');
          }
        } catch (e) {
          console.error(e);
          showToast('Failed to reactivate appointment.', 'error');
        }
      },
    });
  }

  const upcomingAppointments = useMemo(
    () =>
      customerAppointments.filter(
        (a) => a.status === 'scheduled' && new Date(a.start_time) > new Date()
      ),
    [customerAppointments]
  );

  const pastAppointments = useMemo(
    () =>
      customerAppointments.filter(
        (a) => a.status !== 'scheduled' || new Date(a.start_time) <= new Date()
      ),
    [customerAppointments]
  );

  function handleSelectCustomer(customer: Customer) {
    setSelectedCustomer(customer);
    setIsCreating(false);
    setShowDetailOnMobile(true);
  }

  return (
    <div
      className="flex flex-1 overflow-hidden relative transition-colors duration-200"
      style={{ color: 'var(--text-primary)' }}
    >
      <CustomerSidebar
        customers={customers}
        selectedCustomer={selectedCustomer}
        loading={loading}
        isOwner={isOwner}
        tenantId={tenantId}
        showDetailOnMobile={showDetailOnMobile}
        onSelectCustomer={handleSelectCustomer}
        onAddCustomer={() => {
          setSelectedCustomer(null);
          startNewCustomer();
          setShowDetailOnMobile(true);
        }}
        onRefresh={() => void fetchCustomers()}
        onImportDone={() => void fetchCustomers()}
      />

      <CustomerDetailPanel
        selectedCustomer={selectedCustomer}
        isCreating={isCreating}
        isEditing={isEditing}
        saving={saving}
        showDetailOnMobile={showDetailOnMobile}
        editForm={editForm}
        summaries={summaries}
        upcomingAppointments={upcomingAppointments}
        pastAppointments={pastAppointments}
        onEditFormChange={handleEditFormChange}
        onEdit={() => setIsEditing(true)}
        onCancelEdit={() => {
          setIsEditing(false);
          setIsCreating(false);
        }}
        onSave={() => void handleSave()}
        onCreate={() => void handleCreate()}
        onDelete={handleDelete}
        onCancelAppointment={handleCancelAppointment}
        onReactivateAppointment={handleReactivateAppointment}
        onCloseMobile={() => {
          setShowDetailOnMobile(false);
          setIsCreating(false);
        }}
      />
      <ConfirmModal {...confirmState} onClose={closeConfirm} />
    </div>
  );
}
