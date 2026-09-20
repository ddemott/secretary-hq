'use client';

import React, { useState, useEffect } from 'react';
import { Settings, ArrowRight } from 'lucide-react';
import { Api } from '../../lib/api';
import { CRMIntegrationCard } from '../crm/CRMIntegrationCard';
import BusinessTypeSection from './BusinessTypeSection';
import ChecklistPresetSection from '../ui/ChecklistPresetSection';
import { useStaticData } from '../../lib/hooks';
import { useActiveTenantId } from '../../lib/SessionContext';
import { useVocabulary, useVocabularyRefresh } from '@/lib/VocabularyContext';
import { type EffectiveShift } from '../../lib/types';
import { showToast } from '../ui/Toast';
import { AssistantNameCard } from '../settings/AssistantNameCard';
import { EmailBrandingCard } from '../settings/EmailBrandingCard';
import { CalendarSyncCard } from '../settings/CalendarSyncCard';
import { MyAvailabilityCard } from '../settings/MyAvailabilityCard';
import { DataExportCard } from '../settings/DataExportCard';

export default function BusinessSettingsView() {
  const tenantId = useActiveTenantId();
  const { services, employees, loading: staticLoading } = useStaticData(tenantId);
  const vocab = useVocabulary();
  const refreshVocabulary = useVocabularyRefresh();

  const [teamSize, setTeamSize] = useState<number | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [personaName, setPersonaName] = useState('');
  const [savedPersonaName, setSavedPersonaName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [logoUrl, setLogoUrl] = useState('');
  const [savedLogoUrl, setSavedLogoUrl] = useState('');
  const [savingLogoUrl, setSavingLogoUrl] = useState(false);
  const [presetRefreshToken, setPresetRefreshToken] = useState(0);

  const [shifts, setShifts] = useState<EffectiveShift[]>([]);
  const [shiftsLoading, setShiftsLoading] = useState(false);

  const isSolo = teamSize === 1;
  const soloEmployee = isSolo ? employees[0] : null;

  useEffect(() => {
    if (!tenantId) return;
    // Re-engage the loading gate for THIS tenant, and ignore a slow response
    // that belongs to a tenant we have since switched away from — otherwise a
    // super-admin switching tenants would see the previous tenant's settings
    // (and its late response could flip the gate open for the new one).
    setConfigLoaded(false);
    let current = true;
    void fetchTenantConfig(() => current);
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(() => {
    if (isSolo && soloEmployee && tenantId) {
      void fetchShifts(soloEmployee.employee_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSolo, soloEmployee?.employee_id, tenantId]);

  async function fetchTenantConfig(isCurrent: () => boolean) {
    try {
      const config = await Api.tenants.getConfig(tenantId);
      if (!isCurrent()) return;
      setTeamSize(config.team_size ?? null);
      setPersonaName(config.persona_name ?? '');
      setSavedPersonaName(config.persona_name ?? '');
      setLogoUrl(config.logo_url ?? '');
      setSavedLogoUrl(config.logo_url ?? '');
    } catch {
      if (!isCurrent()) return;
      setTeamSize(null);
    } finally {
      // Distinct from `teamSize === null`, which is ALSO the value on a
      // fetch failure — without this flag the loading gate below never
      // cleared on error and the whole settings page (every card, not just
      // team-size-dependent ones) was stuck on "Loading settings..." forever
      // instead of falling back to team mode as intended.
      if (isCurrent()) setConfigLoaded(true);
    }
  }

  async function fetchShifts(employeeId: string) {
    setShiftsLoading(true);
    try {
      const today = new Date();
      const weekOut = new Date(today);
      weekOut.setDate(weekOut.getDate() + 6);
      const startDate = today.toISOString().split('T')[0];
      const endDate = weekOut.toISOString().split('T')[0];
      const data = await Api.shifts.schedule.forDate(tenantId, employeeId, startDate, endDate);
      setShifts(data);
    } catch {
      console.error('Failed to fetch shifts');
    } finally {
      setShiftsLoading(false);
    }
  }

  async function saveAssistantName() {
    if (!tenantId) return;
    setSavingName(true);
    try {
      const trimmed = personaName.trim();
      const res = await Api.tenants.updateConfig(tenantId, { persona_name: trimmed || null });
      // apiMutate resolves {success:false} on non-2xx (never throws), so without
      // this guard a rejected save falsely toasted success.
      if (!res.success) {
        showToast(res.error || 'Could not save the assistant name. Please try again.', 'error');
        return;
      }
      setSavedPersonaName(trimmed);
      setPersonaName(trimmed);
      showToast(
        trimmed ? `Assistant name set to "${trimmed}".` : 'Assistant name cleared.',
        'success'
      );
    } catch {
      showToast('Could not save the assistant name. Please try again.', 'error');
    } finally {
      setSavingName(false);
    }
  }

  async function saveLogoUrl() {
    if (!tenantId) return;
    setSavingLogoUrl(true);
    try {
      const trimmed = logoUrl.trim();
      const res = await Api.tenants.updateConfig(tenantId, { logo_url: trimmed || null });
      if (!res.success) {
        showToast(res.error || 'Could not save the logo URL. Please try again.', 'error');
        return;
      }
      setSavedLogoUrl(trimmed);
      setLogoUrl(trimmed);
      showToast(trimmed ? 'Email logo saved.' : 'Email logo cleared.', 'success');
    } catch {
      showToast('Could not save the logo URL. Please try again.', 'error');
    } finally {
      setSavingLogoUrl(false);
    }
  }

  // Show loading until the tenant config fetch has settled (success or
  // failure). Same gating shape as before (skip if static data is still
  // loading), just keyed on "has the fetch settled" instead of "did it
  // return a team size" — the latter was indistinguishable from a fetch
  // that failed and never will return one.
  if (!configLoaded && !staticLoading) {
    return (
      <div
        className="flex-1 flex items-center justify-center"
        style={{ backgroundColor: 'var(--bg-surface)' }}
        role="status"
        aria-live="polite"
        aria-label="Loading settings"
        aria-busy="true"
      >
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading settings...
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex flex-col overflow-y-auto p-8 transition-colors duration-200"
      style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-primary)' }}
    >
      <header className="mb-8 flex items-center">
        <div
          className="p-2 rounded-lg mr-4"
          style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--accent-soft)' }}
        >
          <Settings className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-3xl font-display">Business Settings</h1>
          <p style={{ color: 'var(--text-secondary)' }}>
            {isSolo
              ? 'Your services, availability, and calendar'
              : `Calendar sync, integrations, and ${vocab.resource_plural.toLowerCase()}`}
          </p>
        </div>
      </header>

      <div className="max-w-3xl space-y-8">
        {/* ─── ASSISTANT NAME ─── Owner-editable; the voice agent introduces
            itself with this name on every call. Stored on tenants.persona_name
            and injected as an authoritative "Your name is X" line. */}
        <AssistantNameCard
          personaName={personaName}
          savedPersonaName={savedPersonaName}
          savingName={savingName}
          onNameChange={setPersonaName}
          onSave={() => void saveAssistantName()}
        />

        {/* ─── EMAIL BRANDING ─── Owner-supplied logo URL, rendered in the
            header of tenant-to-customer emails (emailService.ts). Stored on
            tenants.logo_url. No upload/storage — a plain URL the owner
            pastes here. */}
        <EmailBrandingCard
          logoUrl={logoUrl}
          savedLogoUrl={savedLogoUrl}
          saving={savingLogoUrl}
          onLogoUrlChange={setLogoUrl}
          onSave={() => void saveLogoUrl()}
        />

        {/* ─── BUSINESS TYPE ─── Set once during the wizard; rarely revisited.
            Lives here (not on AI Persona) so prompt-tuning doesn't scroll past
            24 industry cards on every visit. */}
        <BusinessTypeSection
          tenantId={tenantId}
          onChanged={() => {
            refreshVocabulary();
            setPresetRefreshToken((n) => n + 1);
          }}
        />

        <ChecklistPresetSection tenantId={tenantId} refreshToken={presetRefreshToken} />

        {/* ─── SERVICES pointer (solo mode) ─── */}
        {isSolo && (
          <button
            type="button"
            className="w-full flex items-center justify-between p-5 rounded-xl border text-left transition-colors"
            style={{ backgroundColor: 'var(--bg-raised)', borderColor: 'var(--border-soft)' }}
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent('secretary-hq:setup-subtab', { detail: { subtab: 'services' } })
              );
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent-soft)')}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-soft)')}
          >
            <div>
              <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                My Services
              </div>
              <div className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                {services.length > 0
                  ? `${services.length} service${services.length !== 1 ? 's' : ''} — tap to add, edit, or remove`
                  : 'No services yet — tap to add what you offer'}
              </div>
            </div>
            <ArrowRight className="w-4 h-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
          </button>
        )}

        {/* ─── MY AVAILABILITY (solo mode) ─── */}
        {isSolo && <MyAvailabilityCard shifts={shifts} shiftsLoading={shiftsLoading} />}

        {/* ─── CONNECTIONS ─── Calendar + CRM integrations */}
        <div>
          <h2
            className="text-xs font-bold uppercase tracking-widest mb-4"
            style={{ color: 'var(--text-muted)' }}
          >
            Connections
          </h2>
          <div className="space-y-4">
            <CalendarSyncCard tenantId={tenantId} isSolo={isSolo} />

            <CRMIntegrationCard
              tenantId={tenantId}
              provider={{
                name: 'Square',
                color: 'blue',
                icon: 'S',
                description: 'Sync customers and bookings with your Square account.',
                getSettings: Api.square.getSettings,
                getAuthUrl: Api.square.getAuthUrl,
                disconnect: Api.square.disconnect,
                triggerSync: Api.square.triggerSync,
                connectedParam: 'squareConnected',
                getSyncStatus: Api.square.getSyncStatus,
              }}
            />
          </div>
        </div>

        {/* ─── DATA EXPORT ─── */}
        <DataExportCard tenantId={tenantId} />
      </div>
    </div>
  );
}
