import { useEffect, useState } from 'react';
import { type Customer } from './types';
import { detectTimezone } from './constants';
import { formatPhone } from './phone';
import { splitFullName } from './utils';
import { useFormState } from './hooks';
import { Api } from './api';
import { showToast } from '../components/ui/Toast';

const BLANK_FORM = {
  first_name: '',
  last_name: '',
  phone: '',
  email: '',
  address: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  timezone: 'America/New_York',
  notes: '',
};

interface UseCustomerFormOptions {
  selectedCustomer: Customer | null;
  tenantId: string | null;
  onSaved: () => void;
  onCreated: () => void;
}

export function useCustomerForm({
  selectedCustomer,
  tenantId,
  onSaved,
  onCreated,
}: UseCustomerFormOptions) {
  const [isEditing, setIsEditing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const { form: editForm, setField, setForm: setEditForm } = useFormState({ ...BLANK_FORM });

  // Populate form when selected customer changes; also reset edit/create modes.
  useEffect(() => {
    if (selectedCustomer) {
      const { first, last } = splitFullName(selectedCustomer.name || '');
      setEditForm({
        first_name: selectedCustomer.first_name || first || '',
        last_name: selectedCustomer.last_name || last || '',
        phone: formatPhone(selectedCustomer.phone) || '',
        email: selectedCustomer.email || '',
        address: selectedCustomer.address || '',
        address_line2: selectedCustomer.address_line2 || '',
        city: selectedCustomer.city || '',
        state: selectedCustomer.state || '',
        postal_code: selectedCustomer.postal_code || '',
        timezone: selectedCustomer.timezone || 'America/New_York',
        notes: (selectedCustomer.metadata?.notes as string) || '',
      });
      setIsEditing(false);
      setIsCreating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer]);

  // Auto-detect timezone from city/state while editing.
  useEffect(() => {
    if (!isEditing && !isCreating) return;
    const tz = detectTimezone(editForm.city, editForm.state);
    if (tz) setEditForm((prev) => ({ ...prev, timezone: tz }));
  }, [editForm.city, editForm.state, isEditing, isCreating, setEditForm]);

  async function handleSave() {
    if (!selectedCustomer) return;
    setSaving(true);
    try {
      const res = await Api.customers.update(
        selectedCustomer.customer_id,
        selectedCustomer.tenant_id,
        {
          first_name: editForm.first_name,
          last_name: editForm.last_name,
          name: `${editForm.first_name} ${editForm.last_name}`.trim(),
          phone: editForm.phone,
          email: editForm.email,
          address: editForm.address,
          address_line2: editForm.address_line2,
          city: editForm.city,
          state: editForm.state,
          postal_code: editForm.postal_code,
          timezone: editForm.timezone,
          notes: editForm.notes,
        }
      );
      if (res.success) {
        setIsEditing(false);
        setIsCreating(false);
        onSaved();
      } else {
        showToast(res.error || 'Failed to save changes.', 'error');
      }
    } catch (e) {
      console.error(e);
      showToast('Failed to save changes.', 'error');
    }
    setSaving(false);
  }

  async function handleCreate() {
    setSaving(true);
    try {
      const res = await Api.customers.create(tenantId, {
        first_name: editForm.first_name,
        last_name: editForm.last_name,
        name: `${editForm.first_name} ${editForm.last_name}`.trim(),
        phone: editForm.phone,
        email: editForm.email,
        address: editForm.address,
        address_line2: editForm.address_line2,
        city: editForm.city,
        state: editForm.state,
        postal_code: editForm.postal_code,
        timezone: editForm.timezone,
        notes: editForm.notes,
      });
      if (res.success) {
        setIsCreating(false);
        onCreated();
      } else {
        showToast(res.error || 'Failed to create customer.', 'error');
      }
    } catch (e) {
      console.error(e);
      showToast('Failed to create customer.', 'error');
    }
    setSaving(false);
  }

  function startNewCustomer() {
    setIsCreating(true);
    setIsEditing(false);
    setEditForm({ ...BLANK_FORM });
  }

  const handleEditFormChange = (field: string, value: string) =>
    setField(field as keyof typeof editForm, value);

  return {
    isEditing,
    setIsEditing,
    isCreating,
    setIsCreating,
    saving,
    editForm,
    handleEditFormChange,
    setEditForm,
    handleSave,
    handleCreate,
    startNewCustomer,
  };
}
