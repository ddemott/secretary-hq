'use client';

import React from 'react';
import { Building2, RefreshCw, Search, Globe, ShieldAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { LoadingState } from '../ui/LoadingState';
import { TenantCard } from './TenantCard';
import { TenantCreateForm } from './TenantCreateForm';
import { TenantEditPanel } from './TenantEditPanel';
import { TaxLocationsPanel } from './TaxLocationsPanel';
import { useSuperAdminTenants } from '../../lib/useSuperAdminTenants';

interface SuperAdminProps {
  onSelectTenant?: (id: string, name: string) => void;
  currentTenantId?: string | null;
}

export default function SuperAdminDashboard({ onSelectTenant, currentTenantId }: SuperAdminProps) {
  const {
    tenants,
    selectedTenant,
    setSelectedTenant,
    templates,
    loading,
    saving,
    isEditing,
    setIsEditing,
    error,
    success,
    form,
    setForm,
    dragIndex,
    hasReordered,
    savingOrder,
    search,
    setSearch,
    isDeleteModalOpen,
    setIsDeleteModalOpen,
    deleteConfirmText,
    setDeleteConfirmText,
    deleting,
    isCreateModalOpen,
    setIsCreateModalOpen,
    newBusiness,
    setNewBusiness,
    fetchData,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleSaveOrder,
    handleDiscardOrder,
    handleSave,
    handleDelete,
    confirmDelete,
    handleCreate,
  } = useSuperAdminTenants(onSelectTenant, currentTenantId);

  if (loading) return <LoadingState message="Loading all businesses…" />;

  return (
    <div
      className="flex flex-1 overflow-hidden relative transition-colors duration-200"
      style={{ color: 'var(--text-primary)', backgroundColor: 'var(--bg-base)' }}
    >
      <Modal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        title="Launch New Business"
        disableBackdropClose
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsCreateModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} isLoading={saving} disabled={!newBusiness.tenant_name}>
              Deploy Business
            </Button>
          </>
        }
      >
        <TenantCreateForm
          newBusiness={newBusiness}
          templates={templates}
          onChange={setNewBusiness}
        />
      </Modal>

      {/* Sidebar List */}
      <section
        className="w-full md:w-80 flex flex-col border-r transition-colors duration-200"
        style={{ backgroundColor: 'var(--bg-surface)', borderColor: 'var(--border-soft)' }}
      >
        <header
          className="p-4 border-b sticky top-0 z-10 transition-colors duration-200"
          style={{ borderColor: 'var(--border-soft)', backgroundColor: 'var(--bg-surface)' }}
        >
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold flex items-center">
              <Globe className="w-5 h-5 mr-2" style={{ color: 'var(--accent-soft)' }} />
              All Businesses
            </h2>
            <div className="flex items-center space-x-1">
              <Button
                variant="ghost"
                onClick={() => setIsCreateModalOpen(true)}
                size="sm"
                className="p-1.5"
                title="Launch New Business"
                aria-label="Launch new business"
              >
                <Building2 className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchData}
                className="p-1.5"
                title="Refresh businesses"
                aria-label="Refresh businesses"
                style={{ color: 'var(--text-secondary)' }}
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-gray-400 dark:text-gray-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search businesses..."
              aria-label="Search businesses"
              className="w-full pl-9 pr-4 py-2 border-none rounded-md text-sm outline-none transition-colors duration-200"
              style={{ backgroundColor: 'var(--bg-raised)', color: 'var(--text-primary)' }}
            />
          </div>
        </header>

        {/* Save/Discard reorder bar */}
        {hasReordered && (
          <div className="flex items-center justify-between gap-2 px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800">
            <span className="text-xs font-bold text-amber-700 dark:text-amber-300">
              Order changed
            </span>
            <div className="flex gap-1.5">
              <button
                onClick={handleDiscardOrder}
                className="text-xs font-bold text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 px-2 py-1 rounded transition-colors"
              >
                Discard
              </button>
              <button
                onClick={handleSaveOrder}
                disabled={savingOrder}
                className="text-xs font-bold px-3 py-1 rounded transition-colors disabled:opacity-50 hover:brightness-110"
                style={{ color: '#ffffff', backgroundColor: 'var(--warning)' }}
              >
                {savingOrder ? 'Saving...' : 'Save Order'}
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {(() => {
            const q = search.trim().toLowerCase();
            const isFiltering = q.length > 0;
            const visible = isFiltering
              ? tenants.filter((t) => t.name.toLowerCase().includes(q))
              : tenants;

            if (isFiltering && visible.length === 0) {
              return (
                <div className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
                  No businesses match &quot;{search.trim()}&quot;.
                </div>
              );
            }

            return visible.map((t, idx) => (
              <TenantCard
                key={t.tenant_id}
                tenant={t}
                isSelected={selectedTenant?.tenant_id === t.tenant_id}
                isDragging={dragIndex === idx}
                index={idx}
                draggable={!isFiltering}
                onSelect={() => {
                  setSelectedTenant(t);
                  if (onSelectTenant) onSelectTenant(t.tenant_id, t.name);
                }}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
              />
            ));
          })()}
        </div>
      </section>

      {/* Detail Pane */}
      <section
        className="flex-1 flex flex-col overflow-y-auto transition-colors duration-200"
        style={{ backgroundColor: 'var(--bg-base)' }}
      >
        {selectedTenant && form ? (
          <TenantEditPanel
            selectedTenant={selectedTenant}
            form={form}
            templates={templates}
            isEditing={isEditing}
            saving={saving}
            success={success}
            error={error}
            onFormChange={setForm}
            onEdit={() => setIsEditing(true)}
            onCancelEdit={() => setIsEditing(false)}
            onSave={handleSave}
            onDelete={handleDelete}
            onTenantUpdate={setSelectedTenant}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-6 p-6">
            <div className="text-gray-400 dark:text-gray-600 italic">
              Select a business to manage its global attributes
            </div>
            <TaxLocationsPanel />
          </div>
        )}
      </section>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false);
          setDeleteConfirmText('');
        }}
        title="Delete Business"
        disableBackdropClose
        footer={
          <div className="flex gap-2 justify-end">
            <Button
              variant="ghost"
              onClick={() => {
                setIsDeleteModalOpen(false);
                setDeleteConfirmText('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={confirmDelete}
              disabled={deleteConfirmText !== selectedTenant?.name || deleting}
            >
              {deleting ? 'Deleting...' : 'Permanently Delete'}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
            <div className="text-sm text-red-700 dark:text-red-300">
              <p className="font-bold mb-1">This action is permanent and cannot be undone.</p>
              <p>
                Deleting <strong>{selectedTenant?.name}</strong> will permanently remove all
                associated data including customers, appointments, employees, resources, call
                history, and knowledge base documents.
              </p>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-2">
              Type <strong>{selectedTenant?.name}</strong> to confirm:
            </label>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={selectedTenant?.name || ''}
              aria-label={`Type ${selectedTenant?.name || 'the business name'} to confirm deletion`}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
