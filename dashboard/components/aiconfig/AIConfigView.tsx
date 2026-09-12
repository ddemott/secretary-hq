'use client';

import React, { useEffect, useState } from 'react';
import { type Tenant } from '@/lib/types';
import { Settings, MessageSquare } from 'lucide-react';
import { Api } from '../../lib/api';
import { normalizePhone, formatPhone } from '../../../shared/phone';
import { useActiveTenantId } from '../../lib/SessionContext';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { showToast } from '../ui/Toast';
import { LoadingState } from '../ui/LoadingState';
import { GoLivePanel } from '../phone/GoLivePanel';
import { SystemPromptSection } from './SystemPromptSection';
import { ForwardCallsSection } from './ForwardCallsSection';
import { VoiceIdentitySection } from './VoiceIdentitySection';
import { CustomerPreferencesSection } from './CustomerPreferencesSection';
import { BufferSection } from './BufferSection';
import { CallDisclosureSection } from './CallDisclosureSection';

// Business-type / template browsing lives in BusinessSettingsView now
// (BusinessTypeSection.tsx). Owners pick the template once during the
// wizard — putting the 24-card grid here forced every prompt-tuning
// visit to scroll past it, and the unguarded "Apply" click could
// overwrite a hand-tuned persona in one tap.
export default function AIConfigView() {
  const tenantId = useActiveTenantId();
  const [config, setConfig] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [dirty, setDirty] = useState(false);
  // The disclosure text as loaded from the server — used to detect an unsaved
  // change so the attestation checkbox appears only on a real edit, and so an
  // untouched save never trips the backend's attestation gate.
  const [initialDisclosure, setInitialDisclosure] = useState<string>('');
  const [disclosureAttested, setDisclosureAttested] = useState(false);

  useEffect(() => {
    if (tenantId) {
      void fetchConfig();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function fetchConfig() {
    setLoading(true);
    try {
      const data = await Api.tenants.getConfig(tenantId);
      if (!data) {
        // Do NOT fall back to a mock/demo tenant here: this is a real owner's
        // workspace, and loading a foreign tenant's persona (editable, and Save
        // would POST to THAT tenant_id) is a cross-tenant integrity bug. Surface
        // an error instead. MOCK data belongs only to the no-tenant demo path.
        setConfig(null);
        setLoadError(true);
      } else {
        setConfig(data);
        setLoadError(false);
        setInitialDisclosure(data.call_disclosure ?? '');
        setDisclosureAttested(false);
      }
    } catch {
      setConfig(null);
      setLoadError(true);
    }
    setLoading(false);
    setDirty(false);
  }

  // Disclosure change detection, mirroring the backend gate: a custom (non-blank)
  // value that differs from what was loaded requires attestation; blank means
  // "revert to the platform default" and needs none.
  const disclosureNow = (config?.call_disclosure ?? '').trim();
  const disclosureChanged = disclosureNow !== initialDisclosure.trim();
  const disclosureNeedsAttestation = disclosureChanged && disclosureNow.length > 0;

  async function handleSave() {
    if (!config) return;

    // Guard client-side so an unattested custom disclosure never makes a
    // pointless round-trip the backend would 400. The backend still enforces
    // this — the checkbox is convenience, not the security boundary.
    if (disclosureNeedsAttestation && !disclosureAttested) {
      showToast('Confirm the disclosure attestation before saving', 'error');
      return;
    }
    setSaving(true);

    try {
      const res = await Api.tenants.updateConfig(config.tenant_id, {
        // Blank → null reverts to the platform default. Only send the
        // attestation flag when a custom change actually requires it.
        call_disclosure: disclosureNow.length > 0 ? disclosureNow : null,
        ...(disclosureNeedsAttestation ? { disclosure_attested: true } : {}),
        system_prompt: config.system_prompt,
        voice_id: config.voice_id,
        business_type: config.business_type,
        first_message: config.first_message,
        save_preferences_enabled: config.save_preferences_enabled ?? false,
        preferences_instructions: config.preferences_instructions ?? null,
        tts_voice: config.tts_voice ?? null,
        tts_speed: config.tts_speed ?? null,
        tts_soft: config.tts_soft ?? null,
        tts_cheerful: config.tts_cheerful ?? null,
        tts_formal: config.tts_formal ?? null,
        tts_warm: config.tts_warm ?? null,
        tts_concise: config.tts_concise ?? null,
        // Normalize to clean E.164 for storage so the agent builds a valid
        // tel: URI. Blank/invalid → null (forwarding off → AI takes a message).
        forward_phone: normalizePhone(config.forward_phone),
        // forwarded_from_phone is intentionally NOT in this batched save —
        // GoLivePanel owns that field end-to-end with its own immediate
        // Api.tenants.updateConfig call. Two save paths for the same column
        // would let this batched Save silently clobber GoLivePanel's write.
        owner_phone: normalizePhone(config.owner_phone),
        default_buffer_minutes: config.default_buffer_minutes ?? 0,
      });
      setSuccess(res.success);
      if (res.success) {
        setDirty(false);
        // The saved text is the new baseline; a later unrelated save must not
        // re-prompt attestation, and the checkbox resets for the next edit.
        setInitialDisclosure(disclosureNow);
        setDisclosureAttested(false);
        showToast('AI persona saved');
        setTimeout(() => setSuccess(false), 3000);
      } else {
        showToast(res.error || 'Failed to save', 'error');
      }
    } catch (e) {
      console.error('Failed to save config', e);
      showToast('Failed to save', 'error');
    }
    setSaving(false);
  }

  const handleUpdate = (fields: Partial<Tenant>) => {
    setConfig((prev) => (prev ? { ...prev, ...fields } : null));
    setDirty(true);
  };

  // Client-side mirror of the backend loop guard: a transfer target equal to
  // the forwarded-from line or the AI's own DID would loop the live call back.
  const forwardLoops =
    !!normalizePhone(config?.forward_phone) &&
    (normalizePhone(config?.forward_phone) === normalizePhone(config?.forwarded_from_phone) ||
      normalizePhone(config?.forward_phone) === normalizePhone(config?.inbound_phone));

  if (loading) return <LoadingState message="Loading AI configuration…" />;

  if (!config) {
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
        style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
      >
        <p style={{ color: 'var(--text-secondary)' }}>
          {loadError
            ? "We couldn't load your AI settings. Check your connection and try again."
            : 'No AI settings available.'}
        </p>
        <Button variant="secondary" onClick={() => void fetchConfig()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div
      className="flex flex-1 flex-col overflow-y-auto transition-colors duration-200"
      style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
    >
      <header
        className="p-4 md:p-8 flex items-center justify-between sticky top-0 z-10"
        style={{
          borderBottom: '1px solid var(--border-soft)',
          backgroundColor: 'var(--bg-surface)',
        }}
      >
        <div className="flex items-center">
          <div
            className="p-2 rounded-lg mr-4 shadow-md"
            style={{ backgroundColor: 'var(--accent)', color: 'var(--primary-text)' }}
          >
            <Settings className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl md:text-3xl font-display">Voice Settings</h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Customize how your AI sounds and what it says. To change your business type, go to
              Business Settings.
            </p>
          </div>
        </div>
        <Button
          onClick={handleSave}
          isLoading={saving}
          variant={success ? 'success' : 'primary'}
          className="px-6 py-2.5"
          disabled={!dirty || saving || forwardLoops}
        >
          {success ? 'Saved!' : 'Save Changes'}
        </Button>
      </header>

      <div className="p-4 md:p-8 space-y-8 max-w-4xl">
        <SystemPromptSection
          value={config.system_prompt || ''}
          onChange={(val) => handleUpdate({ system_prompt: val })}
        />

        {/* First Message */}
        <section className="space-y-4">
          <h2
            className="text-lg font-bold flex items-center"
            style={{ color: 'var(--text-primary)' }}
          >
            <MessageSquare className="w-5 h-5 mr-2" style={{ color: 'var(--accent-soft)' }} />
            First Message (Greeting)
          </h2>
          <Input
            value={config.first_message || ''}
            onChange={(e) => handleUpdate({ first_message: e.target.value })}
            placeholder="Ex: Thanks for calling! How can I help you today?"
          />
        </section>

        <CallDisclosureSection
          value={config.call_disclosure || ''}
          businessName={config.name || ''}
          personaName={config.persona_name || ''}
          changed={disclosureChanged}
          attested={disclosureAttested}
          onChange={(val) => handleUpdate({ call_disclosure: val })}
          onAttestChange={setDisclosureAttested}
        />

        {/* Go Live — provisioning, test-call verification, and the
            forwarding/porting fork. Owns forwarded_from_phone end-to-end
            (its own immediate save) — deliberately NOT part of handleSave. */}
        <section className="space-y-4">
          <GoLivePanel />
        </section>

        <ForwardCallsSection
          forwardPhone={config.forward_phone || ''}
          ownerPhone={config.owner_phone || ''}
          forwardLoops={forwardLoops}
          onForwardPhoneChange={(val) => handleUpdate({ forward_phone: val })}
          onOwnerPhoneChange={(val) => handleUpdate({ owner_phone: val })}
        />

        <VoiceIdentitySection config={config} onUpdate={handleUpdate} />

        <CustomerPreferencesSection
          savePreferencesEnabled={config.save_preferences_enabled ?? false}
          preferencesInstructions={config.preferences_instructions || ''}
          businessType={config.business_type}
          onToggle={() =>
            handleUpdate({
              save_preferences_enabled: !(config.save_preferences_enabled ?? false),
            })
          }
          onInstructionsChange={(val) => handleUpdate({ preferences_instructions: val })}
        />

        <BufferSection
          defaultBufferMinutes={config.default_buffer_minutes ?? 0}
          onChange={(val) => handleUpdate({ default_buffer_minutes: val })}
        />

        {/* Test Section */}
        <section className="pt-8 border-t" style={{ borderColor: 'var(--border-soft)' }}>
          <Card
            className="p-6 flex flex-col md:flex-row items-center justify-between space-y-4 md:space-y-0"
            style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
          >
            <div>
              <h3 className="text-lg font-bold">Ready to test?</h3>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                Save your changes and call your business number to hear the new persona.
              </p>
            </div>
            {normalizePhone(config.inbound_phone) ? (
              <Button
                variant="secondary"
                className="shrink-0"
                onClick={() => {
                  window.location.href = `tel:${normalizePhone(config.inbound_phone)}`;
                }}
              >
                Call {formatPhone(config.inbound_phone)}
              </Button>
            ) : (
              <p className="text-sm shrink-0" style={{ color: 'var(--text-muted)' }}>
                No business number set up yet.
              </p>
            )}
          </Card>
        </section>
      </div>
    </div>
  );
}
