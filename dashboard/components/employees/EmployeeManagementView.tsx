'use client';

import React, { useState, useEffect } from 'react';
import { Users, PlusCircle, AlertCircle } from 'lucide-react';
import { Api } from '../../lib/api';
import { useStaticData } from '../../lib/hooks';
import { useActiveTenantId } from '../../lib/SessionContext';
import { useVocabulary } from '@/lib/VocabularyContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ConfirmModal } from '../ui/ConfirmModal';
import { LoadingState } from '../ui/LoadingState';
import { useConfirm } from '../../lib/useConfirm';
import { showToast } from '../ui/Toast';
import { EmployeeCard } from './EmployeeCard';
import { EmployeeEditModal } from './EmployeeEditModal';
import type { EmployeeEditForm } from './EmployeeEditModal';
import type { Employee } from '../../lib/types';

export default function EmployeeManagementView() {
  const tenantId = useActiveTenantId();
  const vocab = useVocabulary();
  const { employees, services, loading, error, refresh } = useStaticData(tenantId);
  const [mappings, setMappings] = useState<{ service_id: string; employee_id?: string }[]>([]);

  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [editForm, setEditForm] = useState<EmployeeEditForm>({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    is_active: true,
  });
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newEmployee, setNewEmployee] = useState({ first_name: '', last_name: '' });
  const { state: confirmState, confirm: confirmAction, close: closeConfirm } = useConfirm();

  useEffect(() => {
    if (tenantId) void fetchMappings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function fetchMappings() {
    try {
      const data = await Api.mappings.listServiceEmployee(tenantId);
      setMappings(Array.isArray(data) ? data : []);
    } catch {
      console.error('Failed to fetch mappings');
      setMappings([]);
    }
  }

  async function handleAddEmployee(e: React.FormEvent) {
    e.preventDefault();
    if (!newEmployee.first_name.trim() || !tenantId) return;
    setSaving(true);
    try {
      const res = await Api.employees.create(tenantId, {
        first_name: newEmployee.first_name.trim(),
        last_name: newEmployee.last_name.trim(),
      });
      if (res.success) {
        setNewEmployee({ first_name: '', last_name: '' });
        void refresh();
      } else {
        // Surface the backend reason (e.g. duplicate-name 409) — without this the
        // add silently did nothing and kept the form values.
        showToast(res.error || `Failed to add ${vocab.employee_label.toLowerCase()}`, 'error');
      }
    } catch (err) {
      console.error('Failed to create employee', err);
      showToast(`Failed to add ${vocab.employee_label.toLowerCase()}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdateEmployee() {
    if (!selectedEmployee || !editForm.first_name.trim()) return;
    setSaving(true);
    try {
      const res = await Api.employees.update(selectedEmployee.employee_id, {
        first_name: editForm.first_name.trim(),
        last_name: editForm.last_name.trim(),
        email: editForm.email.trim() || undefined,
        phone: editForm.phone.trim() || undefined,
        is_active: editForm.is_active,
        tenant_id: tenantId || undefined,
      });
      if (res.success) {
        void refresh();
        setIsEditModalOpen(false);
      } else {
        showToast(res.error || 'Failed to save changes', 'error');
      }
    } catch {
      showToast('Failed to save changes', 'error');
    } finally {
      setSaving(false);
    }
  }

  function handleDeleteEmployee(id: string) {
    confirmAction({
      title: `Remove ${vocab.employee_label.toLowerCase()}?`,
      message: `This will remove the ${vocab.employee_label.toLowerCase()} permanently. Appointments and service assignments stay attached to the record.`,
      confirmLabel: 'Remove',
      confirmVariant: 'danger',
      onConfirm: async () => {
        closeConfirm();
        try {
          const res = await Api.employees.delete(id, tenantId);
          if (res.success) {
            void refresh();
            setIsEditModalOpen(false);
            showToast(`${vocab.employee_label} removed`, 'success');
          } else {
            showToast(res.error || 'Delete failed', 'error');
          }
        } catch {
          // Reaching catch means a network throw — apiMutate resolves {success:false}
          // for HTTP errors, so the FK-constraint message doesn't belong here.
          showToast('Could not remove — please try again.', 'error');
        }
      },
    });
  }

  async function toggleService(serviceId: string, employeeId: string) {
    const isMapped = mappings.some(
      (m) => m.service_id === serviceId && m.employee_id === employeeId
    );
    try {
      if (isMapped) {
        await Api.mappings.unassignServiceEmployee(serviceId, employeeId, tenantId);
        setMappings(
          mappings.filter((m) => !(m.service_id === serviceId && m.employee_id === employeeId))
        );
      } else {
        await Api.mappings.assignServiceEmployee(serviceId, employeeId, tenantId);
        setMappings([...mappings, { service_id: serviceId, employee_id: employeeId }]);
      }
    } catch {
      showToast('Failed to update services', 'error');
    }
  }

  if (loading && employees.length === 0) {
    return <LoadingState message="Loading staff data…" />;
  }

  const staffEmployees = (employees || []).filter((e) => e.type !== 'user');

  return (
    <div
      className="flex-1 flex flex-col overflow-y-auto p-8 transition-colors duration-200"
      style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
    >
      <header className="mb-8">
        <div className="flex items-center mb-6">
          <div className="bg-green-100 dark:bg-green-900/30 p-2 rounded-lg mr-4 text-green-600 dark:text-green-400">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-3xl font-display">{vocab.employee_plural}</h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {`Manage ${vocab.employee_plural.toLowerCase()} and assign them to services.`}
            </p>
          </div>
        </div>

        <form onSubmit={handleAddEmployee} className="max-w-lg flex gap-3">
          <Input
            placeholder="First name"
            aria-label={`New ${vocab.employee_label.toLowerCase()} first name`}
            value={newEmployee.first_name}
            onChange={(e) => setNewEmployee({ ...newEmployee, first_name: e.target.value })}
            className="flex-1"
          />
          <Input
            placeholder="Last name"
            aria-label={`New ${vocab.employee_label.toLowerCase()} last name`}
            value={newEmployee.last_name}
            onChange={(e) => setNewEmployee({ ...newEmployee, last_name: e.target.value })}
            className="flex-1"
          />
          <Button
            type="submit"
            disabled={saving || !newEmployee.first_name.trim()}
            icon={PlusCircle}
            isLoading={saving}
            className="whitespace-nowrap"
          >
            {`Add ${vocab.employee_label}`}
          </Button>
        </form>
      </header>

      {error && (
        <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl text-red-700 dark:text-red-400 flex items-center">
          <AlertCircle className="w-5 h-5 mr-3" />
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {staffEmployees.length === 0 && !loading && (
          <div
            className="col-span-full flex flex-col items-center justify-center py-12 border-2 border-dashed rounded-2xl"
            style={{ borderColor: 'var(--border-soft)', color: 'var(--text-muted)' }}
          >
            <Users className="w-8 h-8 mb-2 opacity-30" aria-hidden="true" />
            <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
              No {vocab.employee_plural.toLowerCase()} yet
            </p>
            <p className="text-xs mt-1">
              Add your first {vocab.employee_label.toLowerCase()} using the form above.
            </p>
          </div>
        )}
        {staffEmployees.map((emp) => (
          <EmployeeCard
            key={emp.employee_id}
            employee={emp}
            services={services || []}
            mappings={mappings}
            onClick={() => {
              setSelectedEmployee(emp);
              setEditForm({
                first_name: emp.first_name || emp.name || '',
                last_name: emp.last_name || '',
                email: emp.email || '',
                phone: emp.phone || '',
                is_active: emp.is_active !== false,
              });
              setIsEditModalOpen(true);
            }}
          />
        ))}
      </div>

      <EmployeeEditModal
        isOpen={isEditModalOpen}
        employee={selectedEmployee}
        form={editForm}
        onFormChange={(updates) => setEditForm((f) => ({ ...f, ...updates }))}
        services={services || []}
        mappings={mappings}
        saving={saving}
        onClose={() => setIsEditModalOpen(false)}
        onSave={handleUpdateEmployee}
        onDelete={handleDeleteEmployee}
        onToggleService={toggleService}
        employeeLabel={vocab.employee_label}
      />

      <ConfirmModal {...confirmState} onClose={closeConfirm} />
    </div>
  );
}
