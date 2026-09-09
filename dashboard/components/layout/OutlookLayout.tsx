'use client';

import React, { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  Calendar,
  Users,
  Settings,
  Bot,
  Globe,
  User,
  Wrench,
  ShieldCheck,
  ChevronRight,
  LayoutDashboard,
  Phone,
} from 'lucide-react';
import { Api } from '../../lib/api';
import { FolderTab, FolderTabBar } from '../ui/FolderTabs';
import { useTheme, THEMES } from '@/lib/ThemeContext';
import { useSessionContext, type UserRole } from '@/lib/SessionContext';
import { FeedbackButton } from '../ui/FeedbackButton';
import { SetupProgressPill } from '../ui/SetupProgressPill';
import { DemoBanner } from '../ui/DemoBanner';
import { useAnchorRect } from '../../lib/useAnchorRect';
import { AppShell } from './AppShell';
import { TenantSwitcherDropdown } from './TenantSwitcherDropdown';
import { ProfileMenuDropdown } from './ProfileMenuDropdown';
import { ThemeSelectorDropdown } from './ThemeSelectorDropdown';
import { MobileTabBar } from './MobileTabBar';

type Tab =
  | 'dashboard'
  | 'schedule'
  | 'customers'
  | 'calls'
  | 'setup'
  | 'ai-insights'
  | 'settings'
  | 'all-businesses'
  | 'profile';

interface LayoutProps {
  children: ReactNode;
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  onLogout?: () => void;
  onShowShortcuts?: () => void;
  userName?: string | null;
  role?: UserRole;
  isAdmin?: boolean;
  managedTenantName?: string | null;
  managedTenantId?: string | null;
  onSelectTenant?: (id: string, name: string) => void;
}

const PRIMARY_TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'dashboard', label: 'Home', icon: LayoutDashboard },
  { id: 'schedule', label: 'Schedule', icon: Calendar },
  { id: 'customers', label: 'Customers', icon: Users },
  { id: 'calls', label: 'Calls', icon: Phone },
];

// Top-level labels say what the section is FOR, not what's inside the
// database. Compound noun-pairs ("Services & Resources") describe the
// schema; possessive plain-English ("My Business") describes the user's
// job-to-be-done. Also: shorter labels survive the mobile bottom-nav's
// 64px-wide tap targets without truncation.
// IA merge (2026-06-03): "My Business" + "My Team" + "Business Settings" were
// three destinations answering one question — "where do I configure my
// business?" They're now one "Setup" tab with those areas as sub-tabs.
const ADVANCED_TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'setup', label: 'Setup', icon: Wrench },
  { id: 'ai-insights', label: 'Phone Assistant', icon: Bot },
];

const ACCOUNT_TABS: Record<'profile' | 'all-businesses', string> = {
  profile: 'My Profile',
  'all-businesses': 'All Businesses',
};

function getTabLabel(tab: Tab): string {
  const match = [...PRIMARY_TABS, ...ADVANCED_TABS].find((t) => t.id === tab);
  return match?.label || ACCOUNT_TABS[tab as keyof typeof ACCOUNT_TABS] || tab;
}

export function OutlookLayout({
  children,
  activeTab,
  setActiveTab,
  onLogout,
  onShowShortcuts,
  userName,
  role = 'owner',
  isAdmin,
  managedTenantName,
  managedTenantId,
  onSelectTenant,
}: LayoutProps) {
  // WHY: front-desk staff are the dashboard's primary daily-use audience —
  // owners can configure services/skills/vocabulary, but the people who
  // actually answer calls don't need (and shouldn't see) those tabs. Super-
  // admins keep full access; the role column doesn't apply to them since
  // they're identified by tenant_id, not by users.role.
  const isFrontDeskOnly = role === 'front_desk' && !isAdmin;
  const { theme, setTheme, themeInfo } = useTheme();
  const [allTenants, setAllTenants] = useState<
    { tenant_id: string; name: string; business_type: string }[]
  >([]);
  const [tenantDropdownOpen, setTenantDropdownOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [themeSelectorOpen, setThemeSelectorOpen] = useState(false);
  const tenantBtnRef = useRef<HTMLButtonElement>(null);
  const profileBtnRef = useRef<HTMLButtonElement>(null);
  const themeBtnRef = useRef<HTMLButtonElement>(null);

  const { tenantsVersion } = useSessionContext();
  // Anchor rects for the floating dropdowns. Track scroll/resize so
  // the menus stay glued to their triggers (UX audit 4.2 row 7).
  const tenantBtnRect = useAnchorRect(tenantBtnRef, tenantDropdownOpen);
  const profileBtnRect = useAnchorRect(profileBtnRef, profileMenuOpen);
  const themeBtnRect = useAnchorRect(themeBtnRef, themeSelectorOpen);
  const [unansweredCount, setUnansweredCount] = useState(0);
  // E3 (2026-05-17): count of currently-active voice calls, used as a
  // badge on the Calls tab so front-desk can see live activity at a
  // glance even when looking at another tab. Mirrors the unanswered-KB
  // pattern — refresh on activeTab change rather than poll on a timer.
  const [activeCallCount, setActiveCallCount] = useState(0);

  const visibleTabs = isFrontDeskOnly ? PRIMARY_TABS : [...PRIMARY_TABS, ...ADVANCED_TABS];

  // WHY: a front-desk-only user could still land on a management tab via a
  // stale ?tab=my-business URL or a back-button. Snap them back to Home so
  // they always land on the simplest working surface.
  useEffect(() => {
    if (!isFrontDeskOnly) return;
    const restrictedTabs = new Set<Tab>(['setup', 'ai-insights', 'settings', 'all-businesses']);
    if (restrictedTabs.has(activeTab)) setActiveTab('dashboard');
  }, [isFrontDeskOnly, activeTab, setActiveTab]);

  // Live-badge polling (UX audit #3, 2026-05-18).
  //
  // Before: both effects ran with `[effectiveTenantId, activeTab]` as the
  // sole dependencies, so the "active call" red pulse only refreshed when
  // the user changed tabs — front-desk staff staring at Home for ten
  // minutes never saw an incoming call indicator. After: each count
  // polls every 5s while the tenant is active. Polling stops when the
  // tenant context goes null (logout, super-admin with no managed tenant).
  //
  // 5s matches the cadence used by Slack/Linear/Gmail for "soft live"
  // counters. SSE would be tighter but introduces a server contract
  // (single connection per tab, reconnect logic, auth-on-stream) that's
  // out of scope here. The polled counter feels live enough.
  const effectiveTenantId = managedTenantId || null;

  useEffect(() => {
    if (!effectiveTenantId) return;
    let cancelled = false;
    const fetchUnanswered = () => {
      if (cancelled) return;
      Api.knowledge
        .unanswered(effectiveTenantId)
        .then((res) => {
          if (!cancelled) setUnansweredCount(res?.questions?.length || 0);
        })
        .catch(() => {}); // non-fatal — silent: a missing badge beats a toast on every tick
    };
    fetchUnanswered();
    const id = setInterval(fetchUnanswered, 30_000); // KB unanswered drifts slowly, 30s is plenty
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [effectiveTenantId]);

  useEffect(() => {
    if (!effectiveTenantId) return;
    let cancelled = false;
    const fetchActiveCalls = () => {
      if (cancelled) return;
      Api.voice
        .getActiveCalls(effectiveTenantId)
        .then((res) => {
          if (cancelled) return;
          setActiveCallCount(typeof res?.total === 'number' ? res.total : res?.calls?.length || 0);
        })
        .catch(() => {});
    };
    fetchActiveCalls();
    const id = setInterval(fetchActiveCalls, 5_000); // active calls demand a tighter cadence
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [effectiveTenantId]);

  useEffect(() => {
    if (isAdmin) {
      void Api.tenants.list().then((data) => {
        setAllTenants(Array.isArray(data) ? data : []);
      });
    }
  }, [isAdmin, tenantsVersion]);

  // Screen-reader announcement region for the live badges. The visual
  // pulse is sighted-user candy; screen-reader users need an explicit
  // text update. Renders off-screen via the standard sr-only pattern;
  // aria-live=polite keeps announcements quiet unless something changes.
  const liveAnnouncement = (() => {
    const parts: string[] = [];
    if (activeCallCount > 0)
      parts.push(`${activeCallCount} active call${activeCallCount > 1 ? 's' : ''}`);
    if (unansweredCount > 0)
      parts.push(`${unansweredCount} unanswered question${unansweredCount > 1 ? 's' : ''}`);
    return parts.join('. ');
  })();

  return (
    <>
      <div
        className="flex flex-col h-screen overflow-hidden transition-colors duration-200"
        style={{
          backgroundColor: 'var(--bg-base)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-body)',
        }}
      >
        {/* SR-only live region. Off-screen via clip; aria-live="polite" so
          screen readers announce when the live-call count flips. Mirrors
          the visual red-pulse + KB-badge UI. */}
        <div
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
            whiteSpace: 'nowrap',
            border: 0,
          }}
        >
          {liveAnnouncement}
        </div>

        {/* CROSS-APP NAV */}
        <AppShell
          currentAppId="secretary-hq"
          userName={userName ?? undefined}
          onSignOut={onLogout}
        />

        {/* ADMIN HEADER (super-admin only) */}
        {isAdmin && managedTenantName && (
          <header
            className="px-6 py-2 flex items-center justify-between shadow-sm shrink-0 transition-colors duration-200"
            style={{ backgroundColor: 'var(--accent)', color: 'var(--bg-base)' }}
          >
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" />
              <span className="text-xs font-bold uppercase tracking-widest opacity-80">
                Admin Mode
              </span>
              <span className="mx-2 opacity-30">|</span>
              <button
                ref={tenantBtnRef}
                onClick={() => setTenantDropdownOpen(!tenantDropdownOpen)}
                className="flex items-center gap-2 px-3 py-1 rounded-lg transition-all cursor-pointer"
                style={{ backgroundColor: 'rgba(0,0,0,0.15)', border: '1px solid rgba(0,0,0,0.1)' }}
              >
                <span className="text-sm font-bold truncate max-w-[200px]">
                  {managedTenantName}
                </span>
                <ChevronRight className="w-3 h-3 transition-transform rotate-90" />
              </button>
            </div>
            {/* UX audit Natural 4.5.4 (2026-05-18): the previous label
              "Configure Businesses" sounded like a destination, not
              an exit. Renamed to make the return-to-super-admin
              path explicit; the action is the same (jump to the
              all-businesses grid, which IS the super-admin landing). */}
            <button
              onClick={() => setActiveTab('all-businesses')}
              className="text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full transition-all inline-flex items-center gap-1.5"
              style={{ backgroundColor: 'rgba(0,0,0,0.15)' }}
              aria-label="Exit admin mode — return to the businesses grid"
            >
              <ChevronRight className="w-3 h-3 rotate-180" aria-hidden="true" />
              Exit admin mode
            </button>
          </header>
        )}

        {/* PRIMARY NAVIGATION BAR — Daily-use tabs + utility buttons */}
        <FolderTabBar
          size="lg"
          ariaLabel="Main navigation"
          right={
            <>
              {isAdmin && (
                <button
                  aria-label="All businesses"
                  title="All businesses"
                  onClick={() => setActiveTab('all-businesses')}
                  className={`inline-flex items-center justify-center gap-1.5 min-h-[40px] px-2.5 rounded-md transition-all ${activeTab === 'all-businesses' ? '' : 'hover:brightness-110'}`}
                  style={
                    activeTab === 'all-businesses'
                      ? { color: 'var(--accent-soft)', backgroundColor: 'var(--accent-muted)' }
                      : { color: 'var(--text-muted)' }
                  }
                >
                  <Globe className="w-4 h-4" aria-hidden="true" />
                  {/* UX audit Natural 4.5.2 (2026-05-18): icon-only had
                    only a title attribute, which is silent on touch
                    and on quick scans. Showing the word as a sibling
                    span gives sighted users the same cue screen
                    readers have always had via aria-label. */}
                  <span className="text-xs font-bold uppercase tracking-wider">All businesses</span>
                </button>
              )}
              <SetupProgressPill />
              <button
                ref={themeBtnRef}
                aria-label={`Theme: ${themeInfo.name}`}
                title={`Theme: ${themeInfo.name}`}
                onClick={() => setThemeSelectorOpen(!themeSelectorOpen)}
                className="inline-flex items-center gap-1.5 min-h-[40px] px-2 rounded-md transition-all hover:brightness-110"
                style={{ color: 'var(--text-secondary)' }}
              >
                <span
                  className="flex rounded overflow-hidden shrink-0"
                  style={{ width: 22, height: 14, border: '1px solid rgba(255,255,255,0.15)' }}
                >
                  <span style={{ flex: 2, backgroundColor: themeInfo.preview.bg }} />
                  <span style={{ flex: 1, backgroundColor: themeInfo.preview.accent }} />
                </span>
                <span className="text-xs hidden sm:inline">{themeInfo.name}</span>
              </button>
              <button
                ref={profileBtnRef}
                aria-label={userName ? `Account menu for ${userName}` : 'Account menu'}
                aria-expanded={profileMenuOpen}
                aria-haspopup="menu"
                title={`Account: ${userName || 'Profile'}`}
                onClick={() => setProfileMenuOpen(!profileMenuOpen)}
                className={`inline-flex items-center justify-center min-w-[40px] min-h-[40px] p-2 rounded-md transition-all ${
                  profileMenuOpen || activeTab === 'profile' ? '' : 'hover:brightness-110'
                }`}
                style={
                  profileMenuOpen || activeTab === 'profile'
                    ? { color: 'var(--accent-soft)', backgroundColor: 'var(--accent-muted)' }
                    : undefined
                }
              >
                <User className="w-4 h-4" aria-hidden="true" />
              </button>
            </>
          }
        >
          {visibleTabs.map((tab) => (
            <span key={tab.id} data-tab-id={tab.id} className="relative">
              <FolderTab
                label={tab.label}
                icon={tab.icon}
                size="lg"
                isActive={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
              />
            </span>
          ))}
        </FolderTabBar>

        {/* NOTIFICATION STRIP — live counters (KB unanswered on Phone
          Assistant, active voice calls on Calls). They started life as
          floating "-top-1 -right-1" badges glued to their tab; because the
          FolderTab row uses pointer-events: none on the border trick that
          gives the active tab its lift, those absolutely-positioned
          children rendered against the wrong layer and got visually
          sliced. The next attempt — `fixed top-3 right-4` — moved them out
          of the tab row but straight ON TOP of the AppShell bar's own
          right slot, covering the theme name (2026-09-09: the theme button
          read "Na" with the pill sitting over "vy"). Now it is an IN-FLOW
          row directly under the tab bar: it cannot overlap anything,
          because nothing else occupies that line. */}
        {(unansweredCount > 0 || activeCallCount > 0) && (
          <div
            className="shrink-0 flex items-center justify-end gap-2 px-4 py-1.5"
            data-testid="nav-notification-strip"
          >
            {activeCallCount > 0 && (
              <button
                type="button"
                onClick={() => setActiveTab('calls')}
                aria-label={`${activeCallCount} active call${activeCallCount > 1 ? 's' : ''} — open Calls tab`}
                className="inline-flex items-center gap-1.5 min-h-[28px] px-2.5 rounded-full text-xs font-bold animate-pulse cursor-pointer"
                style={{
                  backgroundColor: 'var(--danger, #dc2626)',
                  color: 'var(--primary-text)',
                }}
                title={`${activeCallCount} call${activeCallCount > 1 ? 's' : ''} in progress`}
              >
                <Phone className="w-3.5 h-3.5" aria-hidden="true" />
                {activeCallCount > 99 ? '99+' : activeCallCount} live
              </button>
            )}
            {unansweredCount > 0 && (
              <button
                type="button"
                onClick={() => setActiveTab('ai-insights')}
                aria-label={`${unansweredCount} unanswered question${unansweredCount > 1 ? 's' : ''} — open Phone Assistant tab`}
                className="inline-flex items-center gap-1.5 min-h-[28px] px-2.5 rounded-full text-xs font-bold cursor-pointer"
                style={{
                  backgroundColor: 'var(--accent)',
                  color: 'var(--primary-text)',
                }}
                title={`${unansweredCount} unanswered question${unansweredCount > 1 ? 's' : ''} from callers`}
              >
                <Bot className="w-3.5 h-3.5" aria-hidden="true" />
                {unansweredCount > 99 ? '99+' : unansweredCount} unanswered
              </button>
            )}
          </div>
        )}

        {/* DEMO BANNER — renders only when demoTenantId is in localStorage */}
        <DemoBanner />

        {/* CONTENT AREA */}
        <div role="main" className="flex-1 flex overflow-hidden">
          {children}
        </div>

        {/* MOBILE NAVIGATION — mirrors the primary tabs only (no admin Globe;
          Globe is in FolderTabBar right slot visible at all viewports).
          Label font is text-[11px] — fits 4 primary tabs at 375px without overflow. */}
        <MobileTabBar
          tabs={visibleTabs}
          activeTab={activeTab}
          unansweredCount={unansweredCount}
          activeCallCount={activeCallCount}
          onSelectTab={(tab) => setActiveTab(tab as Tab)}
        />
      </div>

      {/* Tenant switcher dropdown — uses CSS vars to theme-match all 8 themes */}
      {tenantDropdownOpen && (
        <TenantSwitcherDropdown
          allTenants={allTenants}
          managedTenantId={managedTenantId}
          anchorRect={tenantBtnRect}
          onClose={() => setTenantDropdownOpen(false)}
          onSelect={(id, name) => {
            if (onSelectTenant) onSelectTenant(id, name);
          }}
          onSelectTab={(tab) => setActiveTab(tab as Tab)}
          activeTab={activeTab}
        />
      )}

      {/* Profile dropdown menu */}
      {profileMenuOpen && (
        <ProfileMenuDropdown
          userName={userName}
          anchorRect={profileBtnRect}
          activeTab={activeTab}
          onClose={() => setProfileMenuOpen(false)}
          onSelectTab={(tab) => setActiveTab(tab as Tab)}
          onShowShortcuts={onShowShortcuts}
          onLogout={onLogout}
        />
      )}

      {/* Theme swatch picker */}
      {themeSelectorOpen && (
        <ThemeSelectorDropdown
          currentTheme={theme}
          themes={THEMES}
          anchorRect={themeBtnRect}
          onClose={() => setThemeSelectorOpen(false)}
          onSelect={setTheme}
        />
      )}

      {/* Feedback button — appears on every page with automatic context */}
      <FeedbackButton
        page={getTabLabel(activeTab)}
        context={managedTenantName ? `Viewing as: ${managedTenantName}` : undefined}
      />
    </>
  );
}
