import React, { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Input } from './Input';
import { PhoneInput } from './PhoneInput';
import { Select } from './Select';
import { Button } from './Button';
import { US_STATES, US_TIMEZONES } from '../../lib/constants';
import type { CustomerOption } from './CustomerCombobox';

/**
 * Full draft of a walk-in customer collected by CustomerCreateModal. Mirrors
 * the fields the CRMView create form captures so a walk-in added at the
 * counter is a first-class record (split name, contact, address, timezone,
 * internal notes) — not a name+phone stub the owner has to re-open and finish
 * later. `name` is derived from first+last by the modal so callers don't have
 * to recompose it.
 */
export interface CustomerCreateDraft {
  name: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  address: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  timezone: string;
  notes: string;
}

const EMPTY: Omit<CustomerCreateDraft, 'name'> = {
  first_name: '',
  last_name: '',
  phone: '',
  email: '',
  address: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  // Match CRMView's create-form default so a walk-in lands in the same
  // timezone an owner-created record would.
  timezone: 'America/New_York',
  notes: '',
};

export interface CustomerCreateModalProps {
  isOpen: boolean;
  /** Pre-fill first/last from whatever the operator typed into the combobox search. */
  seedFirstName?: string;
  seedLastName?: string;
  /** Close without creating (Cancel / Escape / X). */
  onClose: () => void;
  /** Performs the create (owned by the caller, which holds the API + tenant). Resolves the new customer, or null on failure. */
  onCreate: (draft: CustomerCreateDraft) => Promise<CustomerOption | null>;
  /** Called with the created customer so the caller can select it in the combobox. */
  onCreated: (customer: CustomerOption) => void;
}

/**
 * Walk-in customer creation modal. Replaces the name+phone inline mini-form
 * that CustomerCombobox first shipped with — that form's single "Full name"
 * field couldn't populate the split first_name/last_name columns the customer
 * record actually stores, so every walk-in created through it lost the name
 * split. This modal captures the same fields as the CRMView detail form and
 * derives `name` from first+last on submit.
 */
export function CustomerCreateModal({
  isOpen,
  seedFirstName = '',
  seedLastName = '',
  onClose,
  onCreate,
  onCreated,
}: CustomerCreateModalProps) {
  const [form, setForm] = useState<Omit<CustomerCreateDraft, 'name'>>(EMPTY);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset + seed the form each time the modal opens so a previous cancelled
  // attempt's values never bleed into the next walk-in, and the name the
  // operator already typed into the combobox search carries over.
  useEffect(() => {
    if (isOpen) {
      setForm({ ...EMPTY, first_name: seedFirstName, last_name: seedLastName });
      setError('');
      setSaving(false);
    }
  }, [isOpen, seedFirstName, seedLastName]);

  function set<K extends keyof Omit<CustomerCreateDraft, 'name'>>(field: K, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function submit() {
    const first = form.first_name.trim();
    const last = form.last_name.trim();
    const phone = form.phone.trim();
    // Backend requires name (min 1) + phone (min 1). We derive name from
    // first+last, so guard on first name (last is optional — one-name
    // walk-ins exist) and phone. Inline guard avoids a wasted round-trip.
    if (!first) {
      setError('First name is required.');
      return;
    }
    if (!phone) {
      setError('Phone is required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const created = await onCreate({
        ...form,
        first_name: first,
        last_name: last,
        phone,
        name: `${first} ${last}`.trim(),
      });
      if (created && created.customer_id) {
        onCreated(created);
        onClose();
      } else {
        setError("Couldn't create customer. Try again.");
      }
    } catch {
      setError('Connection error. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="New customer (walk-in)"
      // Form holds typed state — an accidental backdrop click discarding it
      // is the wrong default. Escape, Cancel, and X remain the exits.
      disableBackdropClose
      footer={
        <div className="flex gap-2 justify-end">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={saving}
            data-testid="customer-create-cancel"
          >
            Cancel
          </Button>
          <Button onClick={submit} isLoading={saving} data-testid="customer-create-save">
            Add &amp; select
          </Button>
        </div>
      }
    >
      <div
        className="space-y-4 max-h-[60vh] overflow-y-auto pr-1"
        data-testid="customer-create-form"
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Input
            label="First Name"
            value={form.first_name}
            onChange={(e) => set('first_name', e.target.value)}
            placeholder="First Name"
            autoFocus
            disabled={saving}
            data-testid="customer-create-first-name"
          />
          <Input
            label="Last Name"
            value={form.last_name}
            onChange={(e) => set('last_name', e.target.value)}
            placeholder="Last Name"
            disabled={saving}
            data-testid="customer-create-last-name"
          />
          <PhoneInput
            label="Phone Number"
            value={form.phone}
            onChange={(val) => set('phone', val)}
          />
        </div>
        <Input
          label="Email"
          type="email"
          value={form.email}
          onChange={(e) => set('email', e.target.value)}
          placeholder="customer@email.com"
          disabled={saving}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            label="Address Line 1"
            value={form.address}
            onChange={(e) => set('address', e.target.value)}
            placeholder="123 Street St"
            disabled={saving}
          />
          <Input
            label="Address Line 2"
            value={form.address_line2}
            onChange={(e) => set('address_line2', e.target.value)}
            placeholder="Apt / Suite / Unit"
            disabled={saving}
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Input
            label="City"
            value={form.city}
            onChange={(e) => set('city', e.target.value)}
            placeholder="New York"
            disabled={saving}
          />
          <Select
            label="State"
            value={form.state}
            onChange={(e) => set('state', e.target.value)}
            disabled={saving}
            options={[
              { label: 'Select state', value: '' },
              ...US_STATES.map((code) => ({ label: code, value: code })),
            ]}
          />
          <Input
            label="ZIP"
            value={form.postal_code}
            onChange={(e) => set('postal_code', e.target.value)}
            placeholder="10001"
            disabled={saving}
          />
        </div>
        <Select
          label="Timezone"
          value={form.timezone}
          onChange={(e) => set('timezone', e.target.value)}
          disabled={saving}
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
            rows={3}
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            disabled={saving}
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
        {error && (
          <div className="text-xs" role="alert" style={{ color: 'var(--red, #dc2626)' }}>
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
