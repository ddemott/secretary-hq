'use client';

import React from 'react';
import { PhoneForwarded, Bell } from 'lucide-react';
import { Input } from '../ui/Input';

interface ForwardCallsSectionProps {
  forwardPhone: string;
  ownerPhone: string;
  forwardLoops: boolean;
  onForwardPhoneChange: (val: string) => void;
  onOwnerPhoneChange: (val: string) => void;
}

export function ForwardCallsSection({
  forwardPhone,
  ownerPhone,
  forwardLoops,
  onForwardPhoneChange,
  onOwnerPhoneChange,
}: ForwardCallsSectionProps) {
  return (
    <>
      <section className="space-y-4">
        <h2
          className="text-lg font-bold flex items-center"
          style={{ color: 'var(--text-primary)' }}
        >
          <PhoneForwarded className="w-5 h-5 mr-2" style={{ color: 'var(--accent-soft)' }} />
          Forward Calls to a Person
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          When a caller needs a real person, the assistant can transfer the live call to this number
          (e.g. your cell). Leave blank to have the assistant take a message instead.
        </p>
        <Input
          type="tel"
          label="Forward calls to"
          value={forwardPhone}
          onChange={(e) => onForwardPhoneChange(e.target.value)}
          placeholder="Ex: +1 312 555 0100"
        />
        {forwardLoops && (
          <p
            id="forward-loop-error"
            role="alert"
            aria-live="assertive"
            className="text-sm"
            style={{ color: 'var(--danger, #dc2626)' }}
          >
            This can&apos;t be the same as your forwarded-from number or the assistant&apos;s own
            number — the call would loop back to the assistant. Fix it below before saving.
          </p>
        )}
      </section>

      <section className="space-y-4">
        <h2
          className="text-lg font-bold flex items-center"
          style={{ color: 'var(--text-primary)' }}
        >
          <Bell className="w-5 h-5 mr-2" style={{ color: 'var(--accent-soft)' }} />
          Owner Notification Phone
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Messages a caller leaves always show up in your Calls inbox right away. Once text alerts
          go live, this is the number the AI will also text.
        </p>
        <p className="text-sm" style={{ color: 'var(--warning)' }}>
          Text alerts aren&apos;t live yet on this platform (carrier registration is still pending)
          — check your Calls inbox for new messages until SMS alerts turn on.
        </p>
        <Input
          type="tel"
          label="Notification number"
          value={ownerPhone}
          onChange={(e) => onOwnerPhoneChange(e.target.value)}
          placeholder="Ex: +1 630 555 0100"
        />
      </section>
    </>
  );
}
