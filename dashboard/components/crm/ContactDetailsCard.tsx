'use client';

import React from 'react';
import { Mail, MapPin, RefreshCw } from 'lucide-react';
import { Input } from '../ui/Input';
import { PhoneInput } from '../ui/PhoneInput';
import { Select } from '../ui/Select';
import { Card } from '../ui/Card';
import { US_STATES, US_TIMEZONES } from '../../lib/constants';
import type { Customer } from '@/lib/types';
import type { EditForm } from './CustomerDetailHeader';

interface ContactDetailsCardProps {
  selectedCustomer: Customer | null;
  isCreating: boolean;
  isEditing: boolean;
  editForm: EditForm;
  onEditFormChange: (field: string, value: string) => void;
}

export function ContactDetailsCard({
  selectedCustomer,
  isCreating,
  isEditing,
  editForm,
  onEditFormChange,
}: ContactDetailsCardProps) {
  return (
    <Card title="Contact Details & Notes" className="max-w-2xl" id="customer-contact">
      {!isEditing && !isCreating ? (
        <div className="space-y-4 text-sm">
          <div className="flex items-start">
            <Mail className="w-4 h-4 mr-3 mt-0.5" style={{ color: 'var(--text-muted)' }} />
            <span style={{ color: 'var(--text-primary)' }}>
              {selectedCustomer?.email || 'No email provided'}
            </span>
          </div>
          <div className="flex items-start">
            <MapPin className="w-4 h-4 mr-3 mt-0.5" style={{ color: 'var(--text-muted)' }} />
            <span style={{ color: 'var(--text-primary)' }}>
              {selectedCustomer
                ? [
                    selectedCustomer.address,
                    selectedCustomer.address_line2,
                    selectedCustomer.city,
                    [selectedCustomer.state, selectedCustomer.postal_code]
                      .filter(Boolean)
                      .join(' '),
                  ]
                    .filter(Boolean)
                    .join(', ') || 'No address on file'
                : 'No address on file'}
            </span>
          </div>
          <div className="flex items-start">
            <RefreshCw className="w-4 h-4 mr-3 mt-0.5" style={{ color: 'var(--text-muted)' }} />
            <span style={{ color: 'var(--text-primary)' }}>
              Timezone:{' '}
              {US_TIMEZONES.find((t) => t.value === selectedCustomer?.timezone)?.label ||
                selectedCustomer?.timezone ||
                'Not set'}
            </span>
          </div>
          <div className="mt-6 pt-6" style={{ borderTop: '1px solid var(--border-soft)' }}>
            <p className="text-xs font-bold uppercase mb-2" style={{ color: 'var(--text-muted)' }}>
              Internal Notes
            </p>
            <p className="italic leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              {(selectedCustomer?.metadata?.notes as string) || 'No internal notes added yet.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Input
              label="First Name"
              value={editForm.first_name}
              onChange={(e) => onEditFormChange('first_name', e.target.value)}
              placeholder="First Name"
            />
            <Input
              label="Last Name"
              value={editForm.last_name}
              onChange={(e) => onEditFormChange('last_name', e.target.value)}
              placeholder="Last Name"
            />
            <PhoneInput
              label="Phone Number"
              value={editForm.phone}
              onChange={(val) => onEditFormChange('phone', val)}
            />
          </div>
          <Input
            label="Email"
            type="email"
            value={editForm.email}
            onChange={(e) => onEditFormChange('email', e.target.value)}
            placeholder="customer@email.com"
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Address Line 1"
              value={editForm.address}
              onChange={(e) => onEditFormChange('address', e.target.value)}
              placeholder="123 Street St"
            />
            <Input
              label="Address Line 2"
              value={editForm.address_line2}
              onChange={(e) => onEditFormChange('address_line2', e.target.value)}
              placeholder="Apt / Suite / Unit"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Input
              label="City"
              value={editForm.city}
              onChange={(e) => onEditFormChange('city', e.target.value)}
              placeholder="New York"
            />
            <Select
              label="State"
              value={editForm.state}
              onChange={(e) => onEditFormChange('state', e.target.value)}
              options={[
                { label: 'Select state', value: '' },
                ...US_STATES.map((code) => ({ label: code, value: code })),
              ]}
            />
            <Input
              label="ZIP"
              value={editForm.postal_code}
              onChange={(e) => onEditFormChange('postal_code', e.target.value)}
              placeholder="10001"
            />
          </div>
          <Select
            label="Timezone"
            value={editForm.timezone}
            onChange={(e) => onEditFormChange('timezone', e.target.value)}
            options={US_TIMEZONES}
          />
          <div>
            <label
              className="block text-xs font-bold uppercase mb-1"
              style={{ color: 'var(--text-muted)' }}
            >
              Internal Notes
            </label>
            <textarea
              rows={4}
              value={editForm.notes}
              onChange={(e) => onEditFormChange('notes', e.target.value)}
              className="w-full p-2.5 rounded-xl text-sm outline-none focus:ring-2 transition"
              style={
                {
                  backgroundColor: 'var(--bg-raised)',
                  border: '1px solid var(--border-soft)',
                  color: 'var(--text-primary)',
                  '--tw-ring-color': 'var(--accent-glow)',
                } as React.CSSProperties
              }
              placeholder="Add private notes the AI should consider..."
            />
          </div>
        </div>
      )}
    </Card>
  );
}
