'use client';

import React, { useRef } from 'react';
import { Globe, Phone } from 'lucide-react';
import { formatPhone } from '../../lib/phone';
import { Api } from '../../lib/api';
import { useConfirm } from '../../lib/useConfirm';
import { ConfirmModal } from '../ui/ConfirmModal';
import { showToast } from '../ui/Toast';
import type { TenantFull } from '../../lib/types';

interface TenantPhoneProvisioningProps {
  selectedTenant: TenantFull;
  onTenantUpdate: (tenant: TenantFull) => void;
}

export function TenantPhoneProvisioning({
  selectedTenant,
  onTenantUpdate,
}: TenantPhoneProvisioningProps) {
  const { state: confirmState, confirm: openConfirm, close: closeConfirm } = useConfirm();
  const areaCodeRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <div className="space-y-2" aria-live="polite">
        <label
          className="text-xs font-bold uppercase ml-1 flex items-center"
          style={{ color: 'var(--accent-soft)' }}
        >
          <Globe className="w-3 h-3 mr-1" /> AI Phone Line
        </label>
        {selectedTenant.phone_status === 'active' && selectedTenant.inbound_phone ? (
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
              <span
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ backgroundColor: 'var(--success)' }}
              />{' '}
              Active
            </span>
            <span className="font-mono font-bold" style={{ color: 'var(--accent-soft)' }}>
              {formatPhone(selectedTenant.inbound_phone)}
            </span>
            <button
              onClick={() => {
                openConfirm({
                  title: 'Deactivate Phone Line',
                  message: 'Deactivate this phone line? The number will be released.',
                  onConfirm: async () => {
                    closeConfirm();
                    try {
                      const res = await Api.provisioning.deactivate(selectedTenant.tenant_id);
                      onTenantUpdate({
                        ...selectedTenant,
                        phone_status: 'deprovisioned',
                        inbound_phone: null,
                        telnyx_phone_number_id: null,
                      });
                      // Surfaces the forwarded_from_phone hazard warning
                      // (releasing a DID the tenant still forwards real calls into).
                      res.warnings?.forEach((w) => showToast(w, 'warning'));
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : 'Failed to deactivate phone';
                      showToast(msg, 'error');
                    }
                  },
                });
              }}
              className="text-xs underline hover:brightness-90"
              style={{ color: 'var(--danger)' }}
            >
              Deactivate
            </button>
          </div>
        ) : selectedTenant.phone_status === 'provisioning' ? (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400">
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                  fill="none"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Provisioning...
            </span>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <div>
              <label
                htmlFor="area-code-input"
                className="block text-xs font-bold uppercase ml-1 mb-1"
                style={{ color: 'var(--text-secondary)' }}
              >
                Area code{' '}
                <span className="normal-case font-normal" style={{ color: 'var(--text-muted)' }}>
                  (optional)
                </span>
              </label>
              <input
                type="text"
                maxLength={3}
                placeholder="e.g. 630"
                className="w-24 px-2.5 py-1.5 text-sm border rounded-lg"
                style={{
                  backgroundColor: 'var(--bg-raised)',
                  borderColor: 'var(--border-soft)',
                  color: 'var(--text-primary)',
                }}
                id="area-code-input"
                ref={areaCodeRef}
              />
            </div>
            <button
              onClick={async () => {
                const areaCode = areaCodeRef.current?.value?.trim();
                onTenantUpdate({ ...selectedTenant, phone_status: 'provisioning' });
                try {
                  const result = await Api.provisioning.activate(
                    selectedTenant.tenant_id,
                    areaCode || undefined
                  );
                  onTenantUpdate({
                    ...selectedTenant,
                    phone_status: 'active',
                    inbound_phone: result.phone_number,
                    telnyx_phone_number_id: result.telnyx_phone_number_id,
                  });
                } catch (err: unknown) {
                  onTenantUpdate({ ...selectedTenant, phone_status: 'failed' });
                  const msg = err instanceof Error ? err.message : 'Failed to activate phone';
                  showToast(msg, 'error');
                }
              }}
              className="px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 rounded-lg flex items-center gap-1.5"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              <Phone className="w-3.5 h-3.5" /> Activate Phone
            </button>
            {selectedTenant.phone_status === 'failed' && (
              <span className="text-xs" style={{ color: 'var(--danger)' }}>
                Last attempt failed — try again
              </span>
            )}
          </div>
        )}
      </div>

      <ConfirmModal
        isOpen={confirmState.isOpen}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        confirmVariant={confirmState.confirmVariant}
        onConfirm={confirmState.onConfirm}
        onClose={closeConfirm}
      />
    </>
  );
}
