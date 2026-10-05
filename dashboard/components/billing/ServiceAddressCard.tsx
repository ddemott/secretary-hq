'use client';

import React, { useEffect, useState } from 'react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Api } from '../../lib/api';
import { showToast } from '../ui/Toast';
import {
  US_STATE_CODES,
  normalizeServiceAddress,
  type ServiceAddressField,
} from '../../../shared/serviceAddress';

interface Props {
  tenantId: string;
  /** Checkout was refused for want of an address — say why, above the form. */
  required?: boolean;
}

const STATE_OPTIONS = [
  { label: 'State', value: '' },
  ...US_STATE_CODES.map((code) => ({ label: code, value: code })),
];

/**
 * Where the business uses the service. Sales tax follows that, so Stripe Tax prices every
 * invoice from it. Collected at signup; this card is how a business that signed up earlier adds
 * one, and how anyone corrects it after a move.
 */
export function ServiceAddressCard({ tenantId, required = false }: Props) {
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [errors, setErrors] = useState<Partial<Record<ServiceAddressField, string>>>({});
  const [loaded, setLoaded] = useState(false);
  const [hadAddress, setHadAddress] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Api.billing
      .getServiceAddress(tenantId)
      .then((res) => {
        if (cancelled) return;
        const a = res.address;
        setStreet(a.street ?? '');
        setCity(a.city ?? '');
        setState(a.state ?? '');
        setZip(a.zip ?? '');
        setHadAddress(!!(a.street && a.city && a.state && a.zip));
      })
      .catch(() => showToast('Failed to load your business address', 'error'))
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    // Same validator the backend runs: fix mistakes here before a round-trip.
    const checked = normalizeServiceAddress({ street, city, state, zip });
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      // apiMutate resolves { success:false, error, details } on a refusal; only a network failure throws.
      const res = await Api.billing.saveServiceAddress(tenantId, checked.address);
      if (res.success) {
        setStreet(checked.address.street);
        setCity(checked.address.city);
        setState(checked.address.state);
        setZip(checked.address.zip);
        setHadAddress(true);
        showToast('Business address saved.', 'success');
      } else {
        if (res.details) setErrors(res.details);
        showToast(res.error || 'Could not save the address.', 'error');
      }
    } catch {
      showToast('Could not save the address — try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6" style={{ backgroundColor: 'var(--bg-raised)' }}>
      <h3 className="text-base font-semibold mb-1">Business address</h3>
      <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>
        Where you use Secretary HQ. We use it to work out sales tax.
      </p>
      {required && !hadAddress && (
        <div
          role="alert"
          className="rounded-md px-4 py-3 text-sm mb-4"
          style={{
            backgroundColor: 'rgba(245, 158, 11, 0.12)',
            color: 'var(--warning)',
            border: '1px solid rgba(245, 158, 11, 0.35)',
          }}
        >
          Add your business address, then choose your plan again.
        </div>
      )}
      <form onSubmit={handleSave} className="space-y-3" aria-busy={!loaded}>
        <Input
          label="Street address"
          value={street}
          onChange={(e) => setStreet(e.target.value)}
          autoComplete="address-line1"
          error={errors.street}
          disabled={!loaded}
        />
        <Input
          label="City"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          autoComplete="address-level2"
          error={errors.city}
          disabled={!loaded}
        />
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="State"
            value={state}
            onChange={(e) => setState(e.target.value)}
            options={STATE_OPTIONS}
            error={errors.state}
            disabled={!loaded}
          />
          <Input
            label="Zip code"
            value={zip}
            onChange={(e) => setZip(e.target.value)}
            inputMode="numeric"
            autoComplete="postal-code"
            error={errors.zip}
            disabled={!loaded}
          />
        </div>
        <Button type="submit" variant="secondary" isLoading={saving} disabled={saving || !loaded}>
          Save address
        </Button>
      </form>
    </Card>
  );
}
