'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import LoginView from '@/components/auth/LoginView';
import { OutlookLayout } from '@/components/layout/OutlookLayout';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { ShortcutsHelpModal } from '@/components/ui/ShortcutsHelpModal';
import { useKeyboardShortcuts, type Shortcut } from '@/lib/useKeyboardShortcuts';
import { useSessionContext } from '@/lib/SessionContext';
import { setSubscriptionRequiredCallback } from '@/lib/api';
import { showToast } from '@/components/ui/Toast';

// Lazy load tab content — only loads the JS for the active tab
const DashboardHome = dynamic(() => import('@/components/DashboardHome'), { ssr: false });
const SchedulerView = dynamic(() => import('@/components/SchedulerView'), { ssr: false });
const CRMView = dynamic(() => import('@/components/crm/CRMView'), { ssr: false });
// IA merge (2026-06-03): My Business + My Team + Business Settings collapsed into
// one "Setup" tab hosting them as sub-tabs. SetupView imports those leaf views.
const SetupView = dynamic(() => import('@/components/SetupView'), { ssr: false });
const AIInsightsView = dynamic(() => import('@/components/analytics/AIInsightsView'), {
  ssr: false,
});
const SettingsView = dynamic(() => import('@/components/SettingsView'), { ssr: false });
const ProfileView = dynamic(() => import('@/components/auth/ProfileView'), { ssr: false });
const SuperAdminDashboard = dynamic(() => import('@/components/team/SuperAdminDashboard'), {
  ssr: false,
});
const VoiceCallsView = dynamic(() => import('@/components/VoiceCallsView'), { ssr: false });

export type Tab =
  | 'dashboard'
  | 'schedule'
  | 'customers'
  | 'calls'
  | 'setup'
  | 'ai-insights'
  | 'settings'
  | 'all-businesses'
  | 'profile';

// IA merge (2026-06-03): the old 'my-business' / 'my-team' / 'business-settings'
// top-level tabs are gone — they're now sub-tabs of 'setup'. Old bookmarks,
// deep links, and tests using ?tab=<legacy> are transparently redirected to
// ?tab=setup&subtab=<section> so nothing 404s.
const LEGACY_TAB_MAP: Record<string, { tab: Tab; subtab: string }> = {
  'my-business': { tab: 'setup', subtab: 'services' },
  'my-team': { tab: 'setup', subtab: 'employees' },
  'business-settings': { tab: 'setup', subtab: 'business-settings' },
};

export default function DashboardPage() {
  const {
    tenantId,
    userName,
    role,
    isAdmin,
    managedTenantId,
    managedTenantName,
    loading,
    login,
    logout,
    selectManagedTenant,
  } = useSessionContext();

  const VALID_TABS: Tab[] = [
    'dashboard',
    'schedule',
    'customers',
    'calls',
    'setup',
    'ai-insights',
    'settings',
    'all-businesses',
    'profile',
  ];

  // Resolve ?tab= → a valid Tab, transparently upgrading legacy tab ids to the
  // merged 'setup' tab (and stamping the matching ?subtab= so the right section
  // shows). Returns null if the param isn't a tab we recognize.
  const resolveUrlTab = useCallback((): Tab | null => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('tab');
    if (!raw) return null;
    const legacy = LEGACY_TAB_MAP[raw];
    if (legacy) {
      params.set('tab', legacy.tab);
      if (!params.get('subtab')) params.set('subtab', legacy.subtab);
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
      return legacy.tab;
    }
    return VALID_TABS.includes(raw as Tab) ? (raw as Tab) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [activeTab, setActiveTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'dashboard';
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('tab');
    const legacy = raw ? LEGACY_TAB_MAP[raw] : undefined;
    if (legacy) {
      // Stamp the upgraded URL SYNCHRONOUSLY here (not in a mount effect) so
      // it's corrected before SetupView mounts and reads ?subtab — otherwise
      // SetupView would race ahead and default to its first sub-tab.
      params.set('tab', legacy.tab);
      if (!params.get('subtab')) params.set('subtab', legacy.subtab);
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
      return legacy.tab;
    }
    if (raw && VALID_TABS.includes(raw as Tab)) return raw as Tab;
    return localStorage.getItem('tenantId') === '00000000-0000-0000-0000-000000000000'
      ? 'all-businesses'
      : 'dashboard';
  });

  // Sync tab to URL so links are shareable and back button works
  const handleSetActiveTab = useCallback((tab: Tab) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.pushState({}, '', url.toString());
  }, []);

  // On mount, rewrite a legacy ?tab=my-business|my-team|business-settings URL to
  // ?tab=setup&subtab=… so the address bar is honest and SetupView reads the
  // right section. (The useState initializer already resolved activeTab; this
  // just corrects the URL.)
  useEffect(() => {
    const resolved = resolveUrlTab();
    if (resolved && resolved !== activeTab) setActiveTab(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire up 402 → upgrade toast. Runs once on mount; the callback navigates
  // to the Billing sub-tab and shows a persistent error toast with a shortcut
  // button so the user has a clear path to upgrade without any breadcrumb loss.
  useEffect(() => {
    setSubscriptionRequiredCallback(() => {
      showToast('Upgrade required to access this feature.', 'error', {
        label: 'Go to Billing',
        onClick: () => {
          handleSetActiveTab('setup');
          const url = new URL(window.location.href);
          url.searchParams.set('subtab', 'billing');
          window.history.replaceState({}, '', url.toString());
        },
      });
    });
    return () => setSubscriptionRequiredCallback(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle browser back/forward
  useEffect(() => {
    const onPopState = () => {
      const next = resolveUrlTab();
      if (next) setActiveTab(next);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard shortcuts (UX audit #10). Help modal is gated by `?`.
  // Chord nav `g h/s/c/k` maps to the four primary tabs; `n` is wired
  // to a global "open new booking" custom event that Home listens for.
  // Custom event keeps the shortcut layer at the page level without
  // having to plumb a setQuickBookOpen handler through OutlookLayout.
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const shortcuts: Shortcut[] = useMemo(
    () => [
      {
        key: 'g h',
        label: 'Go to Home',
        category: 'navigation',
        run: () => handleSetActiveTab('dashboard'),
      },
      {
        key: 'g s',
        label: 'Go to Schedule',
        category: 'navigation',
        run: () => handleSetActiveTab('schedule'),
      },
      {
        key: 'g c',
        label: 'Go to Customers',
        category: 'navigation',
        run: () => handleSetActiveTab('customers'),
      },
      {
        key: 'g k',
        label: 'Go to Calls',
        category: 'navigation',
        run: () => handleSetActiveTab('calls'),
      },
      {
        key: 'n',
        label: 'New booking',
        category: 'actions',
        run: () => {
          // If not on Home, route there first so the QuickBook panel
          // mounts and can receive the event.
          if (activeTab !== 'dashboard') handleSetActiveTab('dashboard');
          // Defer to the next tick so Home's listener is mounted.
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('secretary-hq:new-booking'));
          }, 50);
        },
      },
      {
        // Focus the active tab's search input. Search-bearing views opt
        // in by adding `data-shortcut-target="search"` to their input.
        // We walk the DOM at fire-time so we don't have to wire a
        // per-tab event listener like New Booking does. The first match
        // wins — if a page renders multiple search inputs, order them
        // so the one most useful for a `/` press is first in the tree.
        key: '/',
        label: 'Focus search',
        category: 'actions',
        run: () => {
          const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
            '[data-shortcut-target="search"]'
          );
          if (el) {
            el.focus();
            // Select existing text so the user can replace it without
            // having to clear first — mirrors browser address-bar behavior.
            if ('select' in el && typeof el.select === 'function') el.select();
          }
        },
      },
      {
        key: '?',
        label: 'Show this shortcuts cheat-sheet',
        category: 'help',
        run: () => setShortcutsHelpOpen(true),
      },
    ],
    [activeTab, handleSetActiveTab]
  );
  useKeyboardShortcuts(shortcuts, !!tenantId);

  const handleLoginSuccess = (data: { tenant_id: string; user_name: string; role?: string }) => {
    login(data);
    if (data.tenant_id === '00000000-0000-0000-0000-000000000000') {
      handleSetActiveTab('all-businesses');
    } else {
      handleSetActiveTab('dashboard');
    }
  };

  if (loading)
    return (
      <div
        className="h-screen w-screen flex items-center justify-center"
        style={{ backgroundColor: 'var(--bg-base, #111)' }}
      >
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );

  if (!tenantId) {
    return (
      <div className="relative h-screen w-screen overflow-hidden">
        <LoginView onLoginSuccess={handleLoginSuccess} />
      </div>
    );
  }

  return (
    <OutlookLayout
      activeTab={activeTab}
      setActiveTab={handleSetActiveTab}
      onLogout={logout}
      onShowShortcuts={() => setShortcutsHelpOpen(true)}
      userName={userName}
      role={role}
      isAdmin={isAdmin}
      managedTenantName={managedTenantName}
      managedTenantId={managedTenantId}
      onSelectTenant={selectManagedTenant}
    >
      <ErrorBoundary>
        {activeTab === 'all-businesses' && (
          <SuperAdminDashboard
            onSelectTenant={selectManagedTenant}
            currentTenantId={managedTenantId}
          />
        )}
        {activeTab === 'dashboard' && <DashboardHome onNavigate={handleSetActiveTab} />}
        {activeTab === 'schedule' && <SchedulerView />}
        {activeTab === 'customers' && <CRMView />}
        {activeTab === 'calls' && <VoiceCallsView />}
        {activeTab === 'setup' && <SetupView />}
        {activeTab === 'ai-insights' && <AIInsightsView />}
        {activeTab === 'settings' && <SettingsView />}
        {activeTab === 'profile' && <ProfileView />}
      </ErrorBoundary>
      <ShortcutsHelpModal
        isOpen={shortcutsHelpOpen}
        onClose={() => setShortcutsHelpOpen(false)}
        shortcuts={shortcuts}
      />
    </OutlookLayout>
  );
}
