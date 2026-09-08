'use client';

import React from 'react';
import { Navigation, Save } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Card } from '../ui/Card';
import { CustomerCombobox } from '../ui/CustomerCombobox';
import { formatCustomerAddress } from '../../lib/utils';

interface AppointmentFormShape {
  location: string;
  start_time: string;
  end_time: string;
  customer_id: string;
  customer_first_name: string;
  customer_last_name: string;
  customer_phone: string;
  resource_id: string;
  employee_id: string;
  description: string;
  customer_notes: string;
}

interface AppointmentEditFormProps {
  form: AppointmentFormShape;
  onFormChange: (f: AppointmentFormShape) => void;
  services: { service_id: string; name: string; duration_minutes: number }[];
  vocab: { resource_label: string; employee_label: string; booking_label: string };
  eligibleEmployees: { employee_id: string | number; name: string; type?: string }[];
  eligibleResources: { resource_id: string; name: string }[];
  alignmentBlocked: boolean;
  noEligibleEmployees: boolean;
  noEligibleResources: boolean;
  customers: {
    customer_id: string;
    name: string;
    phone: string;
    address?: string;
    address_line2?: string;
    city?: string;
    state?: string;
    postal_code?: string;
  }[];
  findCustomerById: (id: string) =>
    | {
        customer_id: string;
        name: string;
        phone: string;
        address?: string;
        address_line2?: string;
        city?: string;
        state?: string;
        postal_code?: string;
      }
    | undefined;
  isCreating: boolean;
  saving: boolean;
  onCancelEdit: () => void;
  onSave: () => void;
  onRequestUpdateConfirmation: () => void;
}

export function AppointmentEditForm({
  form,
  onFormChange,
  services,
  vocab,
  eligibleEmployees,
  eligibleResources,
  alignmentBlocked,
  noEligibleEmployees,
  noEligibleResources,
  customers,
  findCustomerById,
  isCreating,
  saving,
  onCancelEdit,
  onSave,
  onRequestUpdateConfirmation,
}: AppointmentEditFormProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
      <div className="space-y-6">
        <Card title="Drive To" icon={<Navigation className="w-4 h-4" />} variant="success">
          <div className="space-y-4">
            <Input
              label="Location / Address"
              value={form.location}
              onChange={(e) => onFormChange({ ...form, location: e.target.value })}
              placeholder="Business address or mobile location"
            />
            <div className="grid grid-cols-2 gap-4">
              <Input
                type="datetime-local"
                label="Start Time"
                step="900"
                value={form.start_time}
                onChange={(e) => onFormChange({ ...form, start_time: e.target.value })}
              />
              <Input
                type="datetime-local"
                label="End Time"
                step="900"
                value={form.end_time}
                onChange={(e) => onFormChange({ ...form, end_time: e.target.value })}
              />
            </div>
          </div>
        </Card>

        <Card title="Customer Details">
          <div className="space-y-4">
            {isCreating ? (
              <CustomerCombobox
                label="Select Customer"
                customers={customers}
                value={form.customer_id}
                onChange={(newCustomerId) => {
                  const customer = findCustomerById(newCustomerId);
                  const suggestedLocation = formatCustomerAddress(customer);
                  onFormChange({
                    ...form,
                    customer_id: newCustomerId,
                    location: form.location || suggestedLocation,
                  });
                }}
                selectTestId="appointment-customer-select"
                searchTestId="appointment-customer-search"
              />
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="First Name"
                  value={form.customer_first_name}
                  onChange={(e) => onFormChange({ ...form, customer_first_name: e.target.value })}
                />
                <Input
                  label="Last Name"
                  value={form.customer_last_name}
                  onChange={(e) => onFormChange({ ...form, customer_last_name: e.target.value })}
                />
              </div>
            )}
            <Input
              label="Phone Number"
              value={form.customer_phone}
              onChange={(e) => onFormChange({ ...form, customer_phone: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-4">
              <Select
                label={vocab.resource_label}
                value={form.resource_id}
                onChange={(e) => onFormChange({ ...form, resource_id: e.target.value })}
                options={eligibleResources.map((r) => ({
                  label: r.name,
                  value: r.resource_id,
                }))}
              />
              <Select
                label={`${vocab.employee_label} Assigned`}
                value={form.employee_id}
                onChange={(e) => onFormChange({ ...form, employee_id: e.target.value })}
                options={[
                  { label: 'Unassigned', value: '' },
                  ...eligibleEmployees.map((e) => ({
                    label: `${e.name} ${e.type === 'user' ? '(Owner)' : ''}`,
                    value: e.employee_id.toString(),
                  })),
                ]}
              />
            </div>
            {alignmentBlocked && (
              <div
                className="p-3 text-sm rounded-lg border"
                style={{
                  color: 'var(--warning, #eab308)',
                  background: 'var(--warning-muted, rgba(234,179,8,0.10))',
                  borderColor: 'var(--warning-muted, rgba(234,179,8,0.3))',
                }}
                role="status"
                data-testid="appointment-alignment-blocked"
              >
                {noEligibleEmployees && noEligibleResources
                  ? `No qualified ${vocab.employee_label.toLowerCase()} or ${vocab.resource_label.toLowerCase()} configured for this service. Assign one in Back Office → Service Assignments first.`
                  : noEligibleEmployees
                    ? `No ${vocab.employee_label.toLowerCase()} is configured to perform this service. Assign one in Back Office → Service Assignments first.`
                    : `No ${vocab.resource_label.toLowerCase()} is configured for this service. Assign one in Back Office → Service Assignments first.`}
              </div>
            )}
            <div>
              <label
                className="block text-xs font-bold uppercase mb-1"
                style={{ color: 'var(--text-muted)' }}
              >
                Internal Notes
              </label>
              <textarea
                rows={2}
                value={form.customer_notes}
                onChange={(e) => onFormChange({ ...form, customer_notes: e.target.value })}
                className="w-full p-2.5 rounded-lg outline-none text-sm italic"
                style={{
                  backgroundColor: 'var(--bg-raised)',
                  border: '1px solid var(--border-soft)',
                  color: 'var(--text-primary)',
                }}
                placeholder="Private notes..."
              />
            </div>
          </div>
        </Card>
      </div>

      <div className="space-y-6">
        <Card title="Summary" variant="dark">
          <div className="space-y-4">
            <Select
              label="Service"
              value={form.description}
              onChange={(e) => onFormChange({ ...form, description: e.target.value })}
              options={[
                { label: 'Walk-in (no service)', value: '' },
                ...services.map((s) => ({
                  label: `${s.name} (${s.duration_minutes}min)`,
                  value: s.name,
                })),
              ]}
            />
          </div>
        </Card>

        <div className="flex flex-col md:flex-row space-y-3 md:space-y-0 md:space-x-3 pt-6">
          <Button variant="secondary" className="px-8 py-3" onClick={onCancelEdit}>
            Discard
          </Button>
          <Button
            className="flex-1 py-3"
            onClick={isCreating ? onSave : onRequestUpdateConfirmation}
            isLoading={saving}
            disabled={alignmentBlocked}
            data-testid="update-appointment-btn"
          >
            {!saving && <Save className="w-5 h-5 mr-2" />}
            {isCreating ? `Create ${vocab.booking_label}` : `Update ${vocab.booking_label}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
