'use client';

import React, { useState, useEffect } from 'react';
import { PlusCircle, Settings, Wrench, AlertCircle } from 'lucide-react';
import { Api } from '../lib/api';
import { roundUpTo15 } from '../lib/duration';
import { useStaticData } from '../lib/hooks';
import { useActiveTenantId } from '../lib/SessionContext';
import { useVocabulary } from '@/lib/VocabularyContext';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { ConfirmModal } from './ui/ConfirmModal';
import { useConfirm } from '../lib/useConfirm';
import { showToast } from './ui/Toast';
import { LoadingState } from './ui/LoadingState';
import { ServiceCard } from './services/ServiceCard';
import { ServiceEditModal } from './services/ServiceEditModal';
import { ServiceCreateWizard } from './services/ServiceCreateWizard';

type Service = {
  service_id: string;
  name: string;
  description?: string;
  duration_minutes: number;
  price?: number | null;
};

export default function ServiceAssignmentView() {
  const tenantId = useActiveTenantId();
  const vocab = useVocabulary();
  const {
    services,
    resources,
    employees,
    loading,
    error: staticError,
    refresh,
  } = useStaticData(tenantId);

  const [resMappings, setResMappings] = useState<{ service_id: string; resource_id?: string }[]>(
    []
  );
  const [empMappings, setEmpMappings] = useState<{ service_id: string; employee_id?: string }[]>(
    []
  );
  const [actionError, setActionError] = useState<string | null>(null);

  // Wizard state (creation)
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardData, setWizardData] = useState<Partial<Service>>({
    name: '',
    description: '',
    duration_minutes: 30,
  });
  const [selectedResourceIds, setSelectedResourceIds] = useState<string[]>([]);
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);

  // Edit state
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Service>>({});
  const [saving, setSaving] = useState(false);

  const [defaultServiceId, setDefaultServiceId] = useState<string | null>(null);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);

  const { state: confirmState, confirm: confirmAction, close: closeConfirm } = useConfirm();

  useEffect(() => {
    if (tenantId) void fetchMappings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function fetchMappings() {
    try {
      const [rMap, eMap, config] = await Promise.all([
        Api.mappings.listServiceResource(tenantId),
        Api.mappings.listServiceEmployee(tenantId),
        Api.tenants.getConfig(tenantId),
      ]);
      setResMappings(rMap);
      setEmpMappings(eMap);
      setDefaultServiceId(config.default_service_id ?? null);
    } catch {
      console.error('Failed to fetch mappings');
    }
  }

  async function setAsDefault(serviceId: string) {
    if (!tenantId) return;
    setSettingDefaultId(serviceId);
    try {
      await Api.tenants.updateConfig(tenantId, { default_service_id: serviceId });
      setDefaultServiceId(serviceId);
      showToast("Set as the default when a caller doesn't name a service.", 'success');
    } catch {
      showToast('Could not set the default service. Please try again.', 'error');
    } finally {
      setSettingDefaultId(null);
    }
  }

  async function handleCreateService() {
    setActionError(null);
    try {
      const res = await Api.services.create(tenantId, {
        ...wizardData,
        duration_minutes: roundUpTo15(wizardData.duration_minutes),
      });
      if (!res.success) throw new Error(res.error || 'Failed to save service');
      const serviceId = res.service.service_id;
      await Promise.all([
        ...selectedResourceIds.map((rid) =>
          Api.mappings.assignServiceResource(serviceId, rid, tenantId)
        ),
        ...selectedEmployeeIds.map((eid) =>
          Api.mappings.assignServiceEmployee(serviceId, eid, tenantId)
        ),
      ]);
      setIsWizardOpen(false);
      setWizardStep(1);
      setWizardData({ name: '', description: '', duration_minutes: 30 });
      setSelectedResourceIds([]);
      setSelectedEmployeeIds([]);
      void refresh();
      void fetchMappings();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  async function handleUpdateService() {
    if (!selectedService || !editForm.name?.trim()) return;
    setSaving(true);
    setActionError(null);
    try {
      const duration = roundUpTo15(editForm.duration_minutes);
      const price =
        editForm.price === undefined || editForm.price === null || !Number.isFinite(editForm.price)
          ? undefined
          : editForm.price;
      const res = await Api.services.update(selectedService.service_id, tenantId, {
        name: editForm.name,
        description: editForm.description,
        ...(duration >= 5 ? { duration_minutes: duration } : {}),
        ...(price !== undefined ? { price } : {}),
      });
      if (res.success) {
        void refresh();
        setIsEditModalOpen(false);
      } else {
        const details = (res as Record<string, unknown>).details;
        const extra = Array.isArray(details)
          ? ` (${(details as Array<{ message: string }>).map((d) => d.message).join(', ')})`
          : '';
        showToast((res.error || 'Update failed') + extra, 'error');
      }
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  function handleDeleteService(id: string) {
    confirmAction({
      title: 'Remove service?',
      message:
        "This will remove the service definition permanently. Existing appointments keep their record but the service won't be bookable.",
      confirmLabel: 'Remove service',
      confirmVariant: 'danger',
      onConfirm: async () => {
        closeConfirm();
        setActionError(null);
        try {
          const res = await Api.services.delete(id, tenantId);
          if (res.success) {
            void refresh();
            setIsEditModalOpen(false);
            showToast('Service removed', 'success');
          } else {
            setActionError(res.error || 'Delete failed');
            showToast(res.error || 'Delete failed', 'error');
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          setActionError(msg);
          showToast(msg, 'error');
        }
      },
    });
  }

  async function toggleResourceMapping(serviceId: string, resourceId: string) {
    const isMapped = resMappings.some(
      (m) => m.service_id === serviceId && m.resource_id === resourceId
    );
    try {
      if (isMapped) {
        await Api.mappings.unassignServiceResource(serviceId, resourceId, tenantId);
        setResMappings(
          resMappings.filter((m) => !(m.service_id === serviceId && m.resource_id === resourceId))
        );
      } else {
        await Api.mappings.assignServiceResource(serviceId, resourceId, tenantId);
        setResMappings([...resMappings, { service_id: serviceId, resource_id: resourceId }]);
      }
    } catch {
      showToast('Mapping update failed', 'error');
    }
  }

  async function toggleEmployeeMapping(serviceId: string, employeeId: string) {
    const isMapped = empMappings.some(
      (m) => m.service_id === serviceId && m.employee_id === employeeId
    );
    try {
      if (isMapped) {
        await Api.mappings.unassignServiceEmployee(serviceId, employeeId, tenantId);
        setEmpMappings(
          empMappings.filter((m) => !(m.service_id === serviceId && m.employee_id === employeeId))
        );
      } else {
        await Api.mappings.assignServiceEmployee(serviceId, employeeId, tenantId);
        setEmpMappings([...empMappings, { service_id: serviceId, employee_id: employeeId }]);
      }
    } catch {
      showToast('Mapping update failed', 'error');
    }
  }

  if (loading && services.length === 0) {
    return <LoadingState message="Loading catalog…" />;
  }

  const PageHeader = (
    <header className="mb-8 flex items-center justify-between">
      <div className="flex items-center">
        <div
          className="p-2 rounded-lg mr-4"
          style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-soft)' }}
        >
          <Settings className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-3xl font-display">Service Catalog</h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Manage your business offerings and operational logic.
          </p>
        </div>
      </div>
      <Button onClick={() => setIsWizardOpen(true)} icon={PlusCircle}>
        New Service Wizard
      </Button>
    </header>
  );

  if (!loading && services.length === 0) {
    return (
      <div
        className="flex-1 flex flex-col overflow-y-auto p-8 transition-colors duration-200"
        style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
      >
        {PageHeader}
        <Card
          className="p-10 text-center border-dashed"
          style={{ borderColor: 'var(--border-soft)', backgroundColor: 'var(--bg-raised)' }}
        >
          <div
            className="mx-auto mb-4 w-12 h-12 rounded-full flex items-center justify-center"
            style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-soft)' }}
          >
            <Wrench className="w-6 h-6" />
          </div>
          <h2 className="text-2xl font-bold mb-2">No services yet</h2>
          <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
            Create your first service so staff can start booking appointments.
          </p>
          <Button onClick={() => setIsWizardOpen(true)} icon={PlusCircle}>
            New Service Wizard
          </Button>
        </Card>
        <ServiceCreateWizard
          isOpen={isWizardOpen}
          onClose={() => setIsWizardOpen(false)}
          wizardStep={wizardStep}
          onNextStep={() => setWizardStep((s) => s + 1)}
          onPrevStep={() => setWizardStep((s) => s - 1)}
          wizardData={wizardData}
          onWizardDataChange={setWizardData}
          selectedResourceIds={selectedResourceIds}
          onToggleResourceId={(id) =>
            setSelectedResourceIds((prev) =>
              prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
            )
          }
          selectedEmployeeIds={selectedEmployeeIds}
          onToggleEmployeeId={(id) =>
            setSelectedEmployeeIds((prev) =>
              prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
            )
          }
          resources={resources}
          employees={employees}
          vocab={vocab}
          onCreate={handleCreateService}
        />
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-y-auto p-8 transition-colors duration-200"
      style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
    >
      {PageHeader}

      {(staticError || actionError) && (
        <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl text-red-700 dark:text-red-400 flex items-center gap-3">
          <AlertCircle className="w-5 h-5" />
          <span className="font-bold">{actionError || staticError}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {services.map((service) => (
          <ServiceCard
            key={service.service_id}
            service={service}
            defaultServiceId={defaultServiceId}
            settingDefaultId={settingDefaultId}
            resMappings={resMappings}
            empMappings={empMappings}
            vocab={vocab}
            onSelect={(svc) => {
              setSelectedService(svc);
              setEditForm({
                name: svc.name,
                description: svc.description,
                duration_minutes: svc.duration_minutes,
                price: svc.price ?? undefined,
              });
              setIsEditModalOpen(true);
            }}
            onSetDefault={setAsDefault}
          />
        ))}
      </div>

      <ServiceEditModal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        selectedService={selectedService}
        editForm={editForm}
        onEditFormChange={setEditForm}
        resources={resources}
        employees={employees}
        resMappings={resMappings}
        empMappings={empMappings}
        saving={saving}
        vocab={vocab}
        onSave={handleUpdateService}
        onDelete={handleDeleteService}
        onToggleResource={toggleResourceMapping}
        onToggleEmployee={toggleEmployeeMapping}
      />

      <ServiceCreateWizard
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        wizardStep={wizardStep}
        onNextStep={() => setWizardStep((s) => s + 1)}
        onPrevStep={() => setWizardStep((s) => s - 1)}
        wizardData={wizardData}
        onWizardDataChange={setWizardData}
        selectedResourceIds={selectedResourceIds}
        onToggleResourceId={(id) =>
          setSelectedResourceIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
          )
        }
        selectedEmployeeIds={selectedEmployeeIds}
        onToggleEmployeeId={(id) =>
          setSelectedEmployeeIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
          )
        }
        resources={resources}
        employees={employees}
        vocab={vocab}
        onCreate={handleCreateService}
      />

      <ConfirmModal {...confirmState} onClose={closeConfirm} />
    </div>
  );
}
