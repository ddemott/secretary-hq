'use client';

import React, { useState, useEffect } from 'react';
import { AlertCircle, Calendar, Plus } from 'lucide-react';
import { Api } from '../lib/api';
import { useActiveTenantId, useSessionContext } from '../lib/SessionContext';
import { useVocabulary, useVocabularyRefresh } from '@/lib/VocabularyContext';
import type { AnalyticsStats } from '../lib/types';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { WizardModeChooser } from './SetupWizard/WizardModeChooser';
import { WizardWelcome } from './SetupWizard/WizardWelcome';
import { BusinessTypePicker } from './SetupWizard/BusinessTypePicker';
import { notifySetupProgressChanged } from '../lib/useSetupProgress';
import { FirstRunTour } from './auth/FirstRunTour';
import SetupWizard from './SetupWizard';
import SoloWizard from './SetupWizard/SoloWizard';
import { QuickBookPanel } from './scheduler/QuickBookPanel';
import { LoadingState } from './ui/LoadingState';
import { useOnboardingState } from '../lib/useOnboardingState';
import type { Tab } from '../app/dashboard/page';
import type { Customer } from '../lib/types';
import { WeekView } from './home/WeekView';
import { HomeTodaySchedule } from './home/HomeTodaySchedule';
import { HomeAiStatus } from './home/HomeAiStatus';
import { HomeAnalyticsBar } from './home/HomeAnalyticsBar';
import { HomeSetupPrompt } from './home/HomeSetupPrompt';

interface DashboardHomeProps {
  onNavigate?: (tab: Tab) => void;
}

interface DashboardAppointment {
  appointment_id: string;
  start_time: string;
  end_time?: string;
  status: string;
  description?: string;
  customer_name?: string;
  employee_id?: string | null;
  customers?: { name?: string; first_name?: string; last_name?: string; phone?: string };
  resources?: { name?: string };
}
interface DashboardEmployee {
  employee_id: string;
  name: string;
  first_name?: string | null;
  last_name?: string | null;
  type?: string;
  is_active: boolean;
}
interface DashboardService {
  service_id: string;
  name: string;
}
interface DashboardResource {
  resource_id: string;
  name: string;
}

export default function DashboardHome({ onNavigate }: DashboardHomeProps) {
  const tenantId = useActiveTenantId();
  const { userName } = useSessionContext();
  const vocab = useVocabulary();
  const refreshVocabulary = useVocabularyRefresh();

  const [appointments, setAppointments] = useState<DashboardAppointment[]>([]);
  const [employees, setEmployees] = useState<DashboardEmployee[]>([]);
  const [services, setServices] = useState<DashboardService[]>([]);
  const [resources, setResources] = useState<DashboardResource[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [quickBookOpen, setQuickBookOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // undefined = not yet fetched, null = fetched but no phone set, string = active phone
  const [tenantPhone, setTenantPhone] = useState<string | null | undefined>(undefined);
  const [analyticsStats, setAnalyticsStats] = useState<AnalyticsStats | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  async function loadData() {
    setLoading(true);
    setLoadError(null);
    const todayDate = new Date();
    // Use local midnight as ISO so Postgres TIMESTAMPTZ >= comparison is timezone-correct.
    const startOfToday = new Date(
      todayDate.getFullYear(),
      todayDate.getMonth(),
      todayDate.getDate()
    );
    const endOfWindow = new Date(
      todayDate.getFullYear(),
      todayDate.getMonth(),
      todayDate.getDate() + 8
    );

    const results = await Promise.allSettled([
      Api.appointments.list(tenantId, {
        startDate: startOfToday.toISOString(),
        endDate: endOfWindow.toISOString(),
      }),
      Api.employees.list(tenantId),
      Api.services.list(tenantId),
      Api.resources.list(tenantId),
      Api.customers.list(tenantId),
      Api.tenants.getConfig(tenantId),
      Api.analytics.getStats(tenantId).catch(() => null),
    ]);

    const [apptsR, empsR, svcsR, resR, custR, configR, statsR] = results;

    setAppointments(
      apptsR.status === 'fulfilled' && Array.isArray(apptsR.value) ? apptsR.value : []
    );
    setEmployees(
      empsR.status === 'fulfilled' && Array.isArray(empsR.value)
        ? empsR.value.filter((e: DashboardEmployee) => e.type === 'employee' && e.is_active)
        : []
    );
    setServices(svcsR.status === 'fulfilled' && Array.isArray(svcsR.value) ? svcsR.value : []);
    setResources(resR.status === 'fulfilled' && Array.isArray(resR.value) ? resR.value : []);
    setCustomers(custR.status === 'fulfilled' && Array.isArray(custR.value) ? custR.value : []);
    if (configR.status === 'fulfilled') {
      setTenantPhone(configR.value?.inbound_phone ?? null);
    }
    if (statsR.status === 'fulfilled' && statsR.value) {
      setAnalyticsStats(statsR.value);
    }

    if (results.some((r) => r.status === 'rejected')) {
      setLoadError("Couldn't load all your data. Check your connection and try again.");
    }
    setLoading(false);
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const needsSetup = services.length === 0 || employees.length === 0 || resources.length === 0;

  const { stage, mode, transitions } = useOnboardingState({ needsSetup, loading, autoOpen: true });

  useEffect(() => {
    function onShortcut() {
      if (loading || needsSetup) return;
      setQuickBookOpen(true);
    }
    window.addEventListener('secretary-hq:new-booking', onShortcut);
    return () => window.removeEventListener('secretary-hq:new-booking', onShortcut);
  }, [loading, needsSetup]);

  function handleCloseWizard() {
    transitions.closeToIdle();
    void loadData();
    notifySetupProgressChanged();
  }

  async function handleBusinessTypeSelected(businessType: string) {
    if (!tenantId) {
      transitions.enterWizard();
      return;
    }
    try {
      const templates = await Api.templates.listFull();
      const tpl = (templates || []).find((t) => t.business_type === businessType);
      await Api.tenants.updateConfig(tenantId, {
        business_type: businessType,
        system_prompt: tpl?.system_prompt_template || undefined,
        voice_id: tpl?.voice_id || undefined,
        first_message: tpl?.first_message || undefined,
      });
      refreshVocabulary();
    } catch {
      // Still proceed — worst case they get default vocabulary
    }
    transitions.enterWizard();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <LoadingState message="Loading dashboard…" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-5xl mx-auto">
      {/* Greeting + New Booking */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display">
            {greeting}, {(userName || 'there').split(' ')[0]}
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            {new Date().toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
            })}
          </p>
        </div>
        <Button
          variant="primary"
          size="lg"
          onClick={() => setQuickBookOpen(true)}
          disabled={loading || needsSetup}
          aria-label="Create a new booking"
        >
          <Plus className="w-4 h-4 mr-1.5" aria-hidden="true" />
          New Booking
        </Button>
      </div>

      {/* Load error — retryable */}
      {loadError && (
        <div
          role="alert"
          className="rounded-xl border-2 p-4 flex items-start gap-3"
          style={{ borderColor: 'var(--red, #dc2626)', backgroundColor: 'var(--bg-raised)' }}
        >
          <AlertCircle
            className="w-5 h-5 mt-0.5 shrink-0"
            style={{ color: 'var(--red, #dc2626)' }}
            aria-hidden="true"
          />
          <div className="flex-1">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {loadError}
            </div>
            <Button variant="secondary" size="sm" className="mt-2" onClick={loadData}>
              Try again
            </Button>
          </div>
          <button
            onClick={() => setLoadError(null)}
            aria-label="Dismiss error"
            className="text-xs px-2 py-1 rounded hover:brightness-125"
            style={{ color: 'var(--text-muted)' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Setup prompt — only when wizard dismissed and setup incomplete */}
      {needsSetup && stage === 'dismissed' && (
        <HomeSetupPrompt
          services={services}
          resources={resources}
          employees={employees}
          vocab={vocab}
          onOpenSetup={transitions.openToChooser}
        />
      )}

      {/* Wizard overlays — exactly one renders at a time (reducer-enforced) */}
      {stage === 'welcome' && (
        <WizardWelcome onContinue={transitions.advanceWelcome} onDismiss={transitions.dismiss} />
      )}
      {stage === 'chooser' && (
        <WizardModeChooser
          onChoose={transitions.chooseMode}
          onClose={transitions.dismiss}
          onBack={transitions.backToWelcome}
        />
      )}
      {stage === 'picker' && (
        <BusinessTypePicker
          onSelect={handleBusinessTypeSelected}
          onBack={transitions.backToChooser}
          onClose={handleCloseWizard}
        />
      )}
      {stage === 'wizard' && mode === 'solo' && (
        <SoloWizard
          isOpen={true}
          onClose={handleCloseWizard}
          onBackToPicker={transitions.backToPicker}
        />
      )}
      {stage === 'wizard' && mode === 'team' && (
        <SetupWizard
          isOpen={true}
          onClose={handleCloseWizard}
          onBackToPicker={transitions.backToPicker}
        />
      )}

      {/* AI Receptionist status */}
      {!needsSetup && <HomeAiStatus tenantPhone={tenantPhone} onNavigate={onNavigate} />}

      {/* Analytics top-line snapshot */}
      {analyticsStats && <HomeAnalyticsBar stats={analyticsStats} />}

      {/* Today's schedule */}
      <HomeTodaySchedule
        appointments={appointments}
        loading={loading}
        needsSetup={needsSetup}
        hasMultipleEmployees={employees.length > 1}
        vocab={vocab}
        onNavigate={onNavigate}
        onNewBooking={() => setQuickBookOpen(true)}
      />

      {/* Next 3 Days */}
      <Card>
        <h2
          className="font-semibold mb-4 flex items-center gap-2"
          style={{ color: 'var(--text-primary)' }}
        >
          <Calendar className="w-4 h-4" style={{ color: 'var(--accent-soft)' }} />
          Next 3 Days
        </h2>
        <WeekView tenantId={tenantId} employees={employees} vocab={vocab} onNavigate={onNavigate} />
      </Card>

      <QuickBookPanel
        isOpen={quickBookOpen}
        onClose={() => setQuickBookOpen(false)}
        tenantId={tenantId}
        prefill={{}}
        customers={customers}
        employees={employees}
        resources={resources}
        services={services}
        onBooked={loadData}
      />

      <FirstRunTour onNavigate={onNavigate} />
    </div>
  );
}
