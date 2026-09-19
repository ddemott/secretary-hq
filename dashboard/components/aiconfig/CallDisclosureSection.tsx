'use client';

import React from 'react';
import { ShieldCheck, Info } from 'lucide-react';
import { speakableBusinessName } from '../../../shared/name';

interface CallDisclosureSectionProps {
  /** Current custom disclosure text ('' when using the platform default). */
  value: string;
  /** Tenant business name, for previewing the default line. */
  businessName: string;
  /** Assistant persona name ('' when unset) — the default line introduces it. */
  personaName?: string;
  /** True when `value` differs from what was loaded (i.e. an unsaved edit). */
  changed: boolean;
  /** The owner's attestation checkbox state. */
  attested: boolean;
  onChange: (val: string) => void;
  onAttestChange: (checked: boolean) => void;
}

/**
 * Preview of the platform default spoken when the field is left blank. This
 * MIRRORS buildDisclosure() in agent/src/greeting.ts, which is the source of
 * truth — this copy is display-only (a placeholder/hint), never sent to the
 * backend. Keep the two in sync if the default wording ever changes.
 */
function defaultDisclosure(businessName: string, personaName?: string): string {
  // speakableBusinessName strips the legal suffix exactly like the agent does
  // (Copilot on #275): the agent says "Thinking Hammer", so a preview showing
  // "Thinking Hammer LLC" would be showing tenants a line the agent never says.
  const name = speakableBusinessName(businessName) || 'your business';
  const persona = personaName?.trim();
  return persona
    ? `I'm ${persona}, an AI assistant for ${name}. This call is transcribed for quality and service.`
    : `I'm an AI assistant for ${name}. This call is transcribed for quality and service.`;
}

export function CallDisclosureSection({
  value,
  businessName,
  personaName,
  changed,
  attested,
  onChange,
  onAttestChange,
}: CallDisclosureSectionProps) {
  const isCustom = value.trim().length > 0;
  // Attestation is required only when the owner has CHANGED the text to a
  // custom, non-blank value — matching the backend gate. Clearing back to the
  // default needs no attestation.
  const attestationRequired = changed && isCustom;

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-bold flex items-center" style={{ color: 'var(--text-primary)' }}>
        <ShieldCheck className="w-5 h-5 mr-2" style={{ color: 'var(--accent-soft)' }} />
        Caller Disclosure
      </h2>

      <div
        className="border p-4 rounded-xl flex items-start"
        style={{ backgroundColor: 'var(--accent-muted)', borderColor: 'var(--accent-muted)' }}
      >
        <Info
          className="w-5 h-5 mr-3 mt-0.5 flex-shrink-0"
          style={{ color: 'var(--accent-soft)' }}
        />
        <p className="text-sm leading-relaxed" style={{ color: 'var(--accent-soft)' }}>
          Every call opens by telling the caller they&apos;ve reached an AI assistant and that the
          call is transcribed. <strong>Leave this blank</strong> to use the standard wording:{' '}
          <em>&quot;{defaultDisclosure(businessName, personaName)}&quot;</em> You can reword it (for
          a different language, brand voice, or your attorney&apos;s script), but you&apos;re
          responsible for making sure it meets the disclosure laws where your business and your
          callers are located.
        </p>
      </div>

      <textarea
        data-testid="call-disclosure"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        maxLength={600}
        placeholder={defaultDisclosure(businessName, personaName)}
        className="w-full p-3 border rounded-lg text-base focus:ring-2 outline-none resize-y"
        style={{
          borderColor: 'var(--border-soft)',
          backgroundColor: 'var(--bg-raised)',
          color: 'var(--text-primary)',
        }}
        aria-label="Custom caller disclosure"
      />

      {attestationRequired && (
        <label
          data-testid="disclosure-attest"
          className="flex items-start cursor-pointer text-sm p-3 border rounded-lg"
          style={{ borderColor: 'var(--border-soft)', color: 'var(--text-secondary)' }}
        >
          <input
            type="checkbox"
            checked={attested}
            onChange={(e) => onAttestChange(e.target.checked)}
            className="mr-3 mt-0.5 flex-shrink-0"
          />
          <span>
            I confirm this disclosure meets the laws of the states where my business and its callers
            are located, and I&apos;m responsible for its accuracy. Required to save a custom
            disclosure.
          </span>
        </label>
      )}
    </section>
  );
}
