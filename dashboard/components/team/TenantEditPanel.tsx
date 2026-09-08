'use client';

import React from 'react';
import { Building2, Save, X, Phone, LayoutTemplate, Edit, Clock, Trash2 } from 'lucide-react';
import { formatPhone } from '../../lib/phone';
import { US_TIMEZONES } from '../../lib/constants';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { PhoneInput } from '../ui/PhoneInput';
import { Select } from '../ui/Select';
import { Card } from '../ui/Card';
import type { TenantFull } from '../../lib/types';
import { TenantPhoneProvisioning } from '../admin/TenantPhoneProvisioning';
import { TenantCoreAttributesSection } from '../admin/TenantCoreAttributesSection';

type Tenant = TenantFull;

type Template = {
  business_type: string;
  display_name: string;
};

interface TenantEditPanelProps {
  selectedTenant: Tenant;
  form: Tenant;
  templates: Template[];
  isEditing: boolean;
  saving: boolean;
  success: boolean;
  error: string | null;
  onFormChange: (form: Tenant) => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onDelete: () => void;
  onTenantUpdate: (tenant: Tenant) => void;
}

export function TenantEditPanel({
  selectedTenant,
  form,
  templates,
  isEditing,
  saving,
  success,
  error,
  onFormChange,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onTenantUpdate,
}: TenantEditPanelProps) {
  return (
    <>
      <header
        className="p-4 md:p-8 border-b flex items-center justify-between sticky top-0 z-10 transition-colors duration-200"
        style={{ borderColor: 'var(--border-soft)', backgroundColor: 'var(--bg-surface)' }}
      >
        <div className="flex items-center">
          <div
            className="p-2 rounded-lg mr-4 shadow-md"
            style={{ backgroundColor: 'var(--accent)', color: 'var(--primary-text)' }}
          >
            <Building2 className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl md:text-3xl font-display">{selectedTenant.name}</h1>
            <p className="text-sm font-mono italic" style={{ color: 'var(--text-secondary)' }}>
              {isEditing ? 'Global Attributes Editor' : 'Business Settings Overview'}
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-3">
          {success && (
            <span className="text-green-600 dark:text-green-400 text-sm font-bold flex items-center mr-2">
              <Save className="w-4 h-4 mr-1" /> Updated!
            </span>
          )}
          {!isEditing ? (
            <>
              <Button
                variant="danger"
                size="sm"
                onClick={onDelete}
                title="Delete Business"
                aria-label="Delete business"
              >
                <Trash2 className="w-5 h-5" />
              </Button>
              <Button variant="secondary" onClick={onEdit}>
                <Edit className="w-4 h-4 mr-2" /> Modify Attributes
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={onCancelEdit}>
                <X className="w-5 h-5" />
              </Button>
              <Button onClick={onSave} isLoading={saving}>
                {!saving && <Save className="w-4 h-4 mr-2" />}
                Save Changes
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="p-4 md:p-8 space-y-8 max-w-4xl">
        {error && (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/40 text-red-700 dark:text-red-400 rounded-xl text-sm font-medium">
            {error}
          </div>
        )}

        {/* Business Identity */}
        <Card title="Business Identity & Operations" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-4">
              {isEditing ? (
                <Input
                  label="Display Name"
                  value={form.name}
                  onChange={(e) => onFormChange({ ...form, name: e.target.value })}
                />
              ) : (
                <div className="space-y-1">
                  <label
                    className="text-xs font-bold uppercase ml-1"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Display Name
                  </label>
                  <p className="p-2.5 font-bold text-lg" style={{ color: 'var(--text-primary)' }}>
                    {selectedTenant.name}
                  </p>
                </div>
              )}
              {isEditing ? (
                <Select
                  label="Template Type"
                  value={form.business_type}
                  onChange={(e) => onFormChange({ ...form, business_type: e.target.value })}
                  options={templates.map((t) => ({
                    label: t.display_name,
                    value: t.business_type,
                  }))}
                />
              ) : (
                <div className="space-y-1">
                  <label
                    className="text-xs font-bold uppercase ml-1 flex items-center"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <LayoutTemplate className="w-3 h-3 mr-1" /> Template Type
                  </label>
                  <p
                    className="p-2.5 font-bold uppercase tracking-tight text-sm"
                    style={{ color: 'var(--accent-soft)' }}
                  >
                    {templates.find((t) => t.business_type === selectedTenant.business_type)
                      ?.display_name || selectedTenant.business_type}
                  </p>
                </div>
              )}
            </div>
            <div className="space-y-4">
              {isEditing ? (
                <Select
                  label="Timezone"
                  value={form.timezone}
                  onChange={(e) => onFormChange({ ...form, timezone: e.target.value })}
                  options={US_TIMEZONES}
                />
              ) : (
                <div className="space-y-1">
                  <label
                    className="text-xs font-bold uppercase ml-1 flex items-center"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <Clock className="w-3 h-3 mr-1" /> Timezone
                  </label>
                  <p className="p-2.5 font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                    {US_TIMEZONES.find((tz) => tz.value === selectedTenant.timezone)?.label ||
                      selectedTenant.timezone}
                  </p>
                </div>
              )}
              {isEditing ? (
                <PhoneInput
                  label="Owner Notification Phone"
                  value={form.owner_phone || ''}
                  onChange={(val) => onFormChange({ ...form, owner_phone: val })}
                />
              ) : (
                <div className="space-y-1">
                  <label
                    className="text-xs font-bold uppercase ml-1 flex items-center"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <Phone className="w-3 h-3 mr-1" /> Owner Notification Phone
                  </label>
                  <p
                    className="p-2.5 font-medium font-mono"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {selectedTenant.owner_phone
                      ? formatPhone(selectedTenant.owner_phone)
                      : 'Not set'}
                  </p>
                </div>
              )}
              <TenantPhoneProvisioning
                selectedTenant={selectedTenant}
                onTenantUpdate={onTenantUpdate}
              />
            </div>
          </div>
        </Card>

        <TenantCoreAttributesSection
          selectedTenant={selectedTenant}
          form={form}
          isEditing={isEditing}
          onFormChange={onFormChange}
        />

        {isEditing && (
          <div
            className="pt-8 border-t flex flex-col md:flex-row space-y-3 md:space-y-0 md:space-x-4"
            style={{ borderColor: 'var(--border-soft)' }}
          >
            <Button onClick={onSave} isLoading={saving} className="flex-1 py-4 text-lg">
              {!saving && <Save className="w-6 h-6 mr-3" />}
              Save All Global Attributes
            </Button>
            <Button variant="secondary" onClick={onCancelEdit} className="px-8 py-4">
              Cancel
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
