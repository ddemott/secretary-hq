'use client';

import React, { useState, useEffect } from 'react';
import { Settings, ArrowRight } from 'lucide-react';
import { Api } from '../lib/api';
import { CRMIntegrationCard } from './crm/CRMIntegrationCard';
import BusinessTypeSection from './BusinessTypeSection';
import ChecklistPresetSection from './ui/ChecklistPresetSection';
import { useStaticData } from '../lib/hooks';
import { useActiveTenantId } from '../lib/SessionContext';
import { useVocabulary, useVocabularyRefresh } from '@/lib/VocabularyContext';
import { type EffectiveShift } from '../lib/types';
import { showToast } from './ui/Toast';
import { AssistantNameCard } from './settings/AssistantNameCard';
import { CalendarSyncCard } from './settings/CalendarSyncCard';
import { MyAvailabilityCard } from './settings/MyAvailabilityCard';
import { DataExportCard } from './settings/DataExportCard';

export default function BusinessSettingsView() {
  const tenantId = useActiveTenantId();
  const { services, employees, loading: staticLoading } = useStaticData(tenantId);
  const vocab = useVocabulary();
  const refreshVocabulary = useVocabularyRefresh();

  const [teamSize, setTeamSize] = useState<number | null>(null);
  const [personaName, setPersonaName] = useState('');
  const [savedPersonaName, setSavedPersonaName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [presetRefreshToken, setPresetRefreshToken] = useState(0);

  const [shifts, setShifts] = useState<EffectiveShift[]>([]);
  const [shiftsLoading, setShiftsLoading] = useState(false);

  const isSolo = teamSize === 1;
  const soloEmployee = isSolo ? employees[0] : null;

  useEffect(() => {
    if (tenantId) {
      void fetchTenantConfig();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(() => {
    if (isSolo && soloEmployee && tenantId) {
      void fetchShifts(soloEmployee.employee_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSolo, soloEmployee?.employee_id, tenantId]);

  async function fetchTenantConfig() {
    try {
      const config = await Api.tenants.getConfig(tenantId);
      setTeamSize(config.team_size ?? null);
      setPersonaName(config.persona_name ?? '');
      setSavedPersonaName(config.persona_name ?? '');
    } catch {
      setTeamSize(null);
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

  // Show loading until we know team_size
  if (teamSize === null && !staticLoading) {
    return (
      <div
        className="flex-1 flex items-center justify-center"
        style={{ backgroundColor: 'var(--bg-surface)' }}
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
