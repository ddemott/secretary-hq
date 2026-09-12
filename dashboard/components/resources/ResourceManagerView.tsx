'use client';

import React, { useEffect, useState } from 'react';
import { Wrench, PlusCircle, AlertCircle } from 'lucide-react';
import { Api } from '../../lib/api';
import { useStaticData } from '../../lib/hooks';
import { useActiveTenantId } from '../../lib/SessionContext';
import { useVocabulary } from '@/lib/VocabularyContext';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ConfirmModal } from '../ui/ConfirmModal';
import { useConfirm } from '../../lib/useConfirm';
import { showToast } from '../ui/Toast';
import { ResourceCard } from './ResourceCard';
import { ResourceEditModal } from './ResourceEditModal';
import type { ResourceEditForm } from './ResourceEditModal';
import type { Resource } from '../../lib/types';

export default function ResourceManagerView() {
  const tenantId = useActiveTenantId();
  const vocab = useVocabulary();
  const {
    resources: staticResources,
    services,
    loading: staticLoading,
    refresh,
  } = useStaticData(tenantId);
  const [resources, setResources] = useState<Resource[]>([]);
  const [mappings, setMappings] = useState<{ service_id: string; resource_id?: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newResource, setNewResource] = useState({ name: '', description: '' });
  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);
  const [editForm, setEditForm] = useState<ResourceEditForm>({
    name: '',
    description: '',
    is_active: true,
  });
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const { state: confirmState, confirm: confirmAction, close: closeConfirm } = useConfirm();

  useEffect(() => {
    if (tenantId) void fetchMappings(tenantId);
  }, [tenantId]);

  useEffect(() => {
    setResources(staticResources);
    setLoading(staticLoading);
  }, [staticResources, staticLoading]);

  async function fetchMappings(tid: string) {
    try {
      const mData = await Api.mappings.listServiceResource(tid);
      setMappings(Array.isArray(mData) ? mData : []);
    } catch {
      setError('Failed to fetch resource mappings');
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newResource.name.trim() || !tenantId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await Api.resources.create(tenantId, newResource);
      if (res.success) {
        void refresh();
        setNewResource({ name: '', description: '' });
      } else {
        setError(res.error || 'Failed to create resource');
      }
    } catch {
      setError('Failed to create resource');
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdateResource() {
    if (!selectedResource || !editForm.name.trim()) return;
    setSaving(true);
    try {
      const res = await Api.resources.update(
        selectedResource.resource_id,
        {
          name: editForm.name.trim(),
          description: editForm.description.trim(),
          is_active: editForm.is_active,
        },
        tenantId
      );
      if (res.success) {
        void refresh();
        setIsEditModalOpen(false);
      } else {
        // Toast not page-level error: the banner renders behind the open modal (invisible).
        showToast(res.error || 'Failed to update resource', 'error');
      }
    } catch {
      showToast('Failed to update resource', 'error');
    } finally {
      setSaving(false);
    }
  }

  function handleDelete(id: string) {
    confirmAction({
      title: `Delete ${vocab.resource_label.toLowerCase()}?`,
      message: `This ${vocab.resource_label.toLowerCase()} will be removed. Existing appointments stay, but new bookings won't be able to use it.`,
      confirmLabel: 'Delete',
      confirmVariant: 'danger',
      onConfirm: async () => {
        closeConfirm();
        setError(null);
        try {
          const res = await Api.resources.delete(id, tenantId);
          if (res.success) {
            void refresh();
            setIsEditModalOpen(false);
            showToast(`${vocab.resource_label} deleted`, 'success');
          } else {
            setError(res.error || 'Failed to delete resource');
            showToast(res.error || 'Failed to delete resource', 'error');
          }
        } catch {
          setError('Failed to delete resource');
          showToast('Failed to delete resource', 'error');
        }
      },
    });
  }

  async function toggleServiceMapping(serviceId: string, resourceId: string) {
    const isMapped = mappings.some(
      (m) => m.service_id === serviceId && m.resource_id === resourceId
    );
    try {
      const res = isMapped
        ? await Api.mappings.unassignServiceResource(serviceId, resourceId, tenantId)
        : await Api.mappings.assignServiceResource(serviceId, resourceId, tenantId);

      if (res.success) {
        if (isMapped) {
          setMappings(
            mappings.filter((m) => !(m.service_id === serviceId && m.resource_id === resourceId))
          );
        } else {
          setMappings([...mappings, { service_id: serviceId, resource_id: resourceId }]);
        }
      } else {
        // Toast, not page-level error: this fires from inside the open modal.
        showToast(res.error || 'Failed to update service mapping', 'error');
      }
    } catch {
      showToast('Failed to update service mapping', 'error');
    }
  }

  if (loading && resources.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Button variant="ghost" isLoading={true} size="lg">
          {`Loading ${vocab.resource_plural.toLowerCase()}...`}
        </Button>
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-y-auto p-8 transition-colors duration-200"
      style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
    >
      <header className="mb-8">
        <div className="flex items-center mb-6">
          <div
            className="p-2 rounded-lg mr-4"
            style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-soft)' }}
          >
            <Wrench className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-3xl font-display">{vocab.resource_plural} & Services</h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Define which services can be performed at each location.
            </p>
          </div>
        </div>

        <form onSubmit={handleCreate} className="max-w-md flex gap-3">
          <div className="flex-1 space-y-2">
            <Input
              placeholder={`${vocab.resource_label} Name (e.g. Bay 1)`}
              aria-label={`New ${vocab.resource_label.toLowerCase()} name`}
              value={newResource.name}
              onChange={(e) => setNewResource({ ...newResource, name: e.target.value })}
              required
            />
            <Input
              placeholder="Description"
              aria-label={`New ${vocab.resource_label.toLowerCase()} description`}
              value={newResource.description}
              onChange={(e) => setNewResource({ ...newResource, description: e.target.value })}
              className="text-sm"
            />
          </div>
          <Button
            type="submit"
            isLoading={saving}
            disabled={!newResource.name.trim()}
            className="self-start py-3 whitespace-nowrap"
          >
            {`Add ${vocab.resource_label}`}
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
        {resources.map((res) => (
          <ResourceCard
            key={res.resource_id}
            resource={res}
            services={services || []}
            mappings={mappings}
            onClick={() => {
              setSelectedResource(res);
              setEditForm({
                name: res.name,
                description: res.description || '',
                is_active: res.is_active !== false,
              });
              setIsEditModalOpen(true);
            }}
          />
        ))}
      </div>

      <ResourceEditModal
        isOpen={isEditModalOpen}
        resource={selectedResource}
        form={editForm}
        onFormChange={(updates) => setEditForm((f) => ({ ...f, ...updates }))}
        services={services || []}
        mappings={mappings}
        saving={saving}
        onClose={() => setIsEditModalOpen(false)}
        onSave={handleUpdateResource}
        onDelete={handleDelete}
        onToggleService={toggleServiceMapping}
        resourceLabel={vocab.resource_label}
      />

      <ConfirmModal {...confirmState} onClose={closeConfirm} />
    </div>
  );
}
