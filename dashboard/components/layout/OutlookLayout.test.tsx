/**
 * OutlookLayout role-gating tests.
 *
 * The dashboard now uses a single flattened nav. Front-desk-only logins
 * (`role === 'front_desk'`) should only see the daily-use tabs and be
 * snapped back to Home if they land on a management tab via a stale URL or
 * back-button.
 *
 * Owners (and super-admins, who keep full access regardless of `role`)
 * should still see the management tabs.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { OutlookLayout } from './OutlookLayout';

// Stub the APIs the layout uses on mount. Without these, the layout
// fires real fetches on render and litters the console with rejected
// promises. Coverage:
//   - knowledge.unanswered → AI Insights badge
//   - voice.getActiveCalls → Calls badge (E3)
//   - tenants.list         → admin tenant-switcher dropdown
//   - services/resources/employees/shifts/mappings → SetupProgressPill
//     (D4 — mounted in OutlookLayout's utility row, hits all five
//     surfaces on mount via useSetupProgress)
const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    knowledge: { unanswered: vi.fn() },
    voice: { getActiveCalls: vi.fn() },
    tenants: { list: vi.fn() },
    services: { list: vi.fn() },
    resources: { list: vi.fn() },
    employees: { list: vi.fn() },
    shifts: { schedule: { bulkForDate: vi.fn() } },
    mappings: { listServiceEmployee: vi.fn() },
  },
}));
vi.mock('../../lib/api', () => ({ Api: mockApi }));

vi.mock('@/lib/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'dark',
    setTheme: vi.fn(),
    themeInfo: { name: 'Dark', preview: { bg: '#000', accent: '#fff' } },
  }),
  THEMES: [{ id: 'dark', name: 'Dark', preview: { bg: '#000', accent: '#fff' } }],
}));

// OutlookLayout pulls tenantsVersion off useSessionContext; the
// FeedbackButton (rendered inside the layout) pulls useActiveTenantId.
// Badge effects only run when managedTenantId is set, so the badge tests
// override this via globalSessionMock below.
let sessionMock: { tenantsVersion: number; managedTenantId: string | null } = {
  tenantsVersion: 0,
  managedTenantId: null,
};
vi.mock('@/lib/SessionContext', () => ({
  useSessionContext: () => sessionMock,
  useActiveTenantId: () => sessionMock.managedTenantId,
}));

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock = { tenantsVersion: 0, managedTenantId: null };
  mockApi.knowledge.unanswered.mockResolvedValue({ questions: [] });
  mockApi.voice.getActiveCalls.mockResolvedValue({ calls: [], total: 0 });
  mockApi.tenants.list.mockResolvedValue([]);
  // SetupProgressPill defaults — empty everything so the pill is hidden
  // by default. Tests that need the pill visible can override per-test.
  mockApi.services.list.mockResolvedValue([]);
  mockApi.resources.list.mockResolvedValue([]);
  mockApi.employees.list.mockResolvedValue([]);
  mockApi.shifts.schedule.bulkForDate.mockResolvedValue([]);
  mockApi.mappings.listServiceEmployee.mockResolvedValue([]);
});

describe('OutlookLayout role gating', () => {
  test('HAPPY: owner sees management tabs', async () => {
    // WHO: Shop owner / manager with the default 'owner' role.
    // WHAT: Daily-use tabs plus management tabs render.
    // WHERE: Desktop nav (FolderTabBar with size="lg").
    // WHEN: On every page load while signed in as an owner.
    // WHY: Owners need access to Services, Staff, and AI/knowledge setup.
    render(
      <OutlookLayout activeTab="dashboard" setActiveTab={vi.fn()} role="owner">
        <div>content</div>
      </OutlookLayout>
    );
    expect(screen.getByRole('tab', { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /schedule/i })).toBeInTheDocument();
    // IA merge (2026-06-03): My Business + My Team + Business Settings collapsed
    // into a single "Setup" tab.
    expect(screen.getByRole('tab', { name: /setup/i })).toBeInTheDocument();
  });

  test('SAD: front_desk user does NOT see management tabs', () => {
    // WHO: Shop staff member promoted to a 'front_desk' role.
    // WHAT: Only the daily-use tabs render; management tabs are hidden.
    // WHERE: Desktop nav and the mobile nav.
    // WHY: Non-technical staff shouldn't have to choose between setup
    //      surfaces to do their daily work.
    render(
      <OutlookLayout activeTab="dashboard" setActiveTab={vi.fn()} role="front_desk">
        <div>content</div>
      </OutlookLayout>
    );
    expect(screen.getByRole('tab', { name: /home/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /setup/i })).not.toBeInTheDocument();
    // Mobile nav has plain <button>s rather than role="tab"; assert by name.
    expect(screen.queryByRole('button', { name: /^businesses$/i })).not.toBeInTheDocument();
  });

  test('SAD: front_desk user landing on a management tab is redirected to dashboard', async () => {
    // WHO: Front-desk user who clicked a stale ?tab=my-business link or
    //      hit the back-button after an admin demoted them.
    // WHAT: The layout snaps activeTab back to 'dashboard' on mount.
    // WHERE: useEffect inside OutlookLayout that watches isFrontDeskOnly +
    //        activeTab.
    // WHY: Without this guard the user would see a management view even
    //      though the tab to switch back is gone — a dead-end for the user.
    const setActiveTab = vi.fn();
    render(
      <OutlookLayout activeTab="setup" setActiveTab={setActiveTab} role="front_desk">
        <div>content</div>
      </OutlookLayout>
    );
    await waitFor(() => {
      expect(setActiveTab).toHaveBeenCalledWith('dashboard');
    });
  });

  test('HAPPY: Calls tab shows an active-call badge when getActiveCalls returns > 0 (E3, 2026-05-17)', async () => {
    // WHO: front-desk operator looking at a non-Calls tab while a live
    //      call lands at the agent
    // WHAT: the Calls tab's <span data-tab-id="calls"> contains a small
    //       numeric badge reporting the active-call count. Without the
    //       badge, the operator would need to switch to the Calls tab
    //       just to know whether anything's happening.
    // WHERE: dashboard/components/OutlookLayout.tsx — the badge-renderer
    //        sibling to the AI Insights / Knowledge unanswered badge.
    // WHY: pins the new E3 surface against regressions. If a future
    //      refactor drops voice.getActiveCalls() from the mount-effect
    //      list or breaks the count-extraction path, this test fails
    //      immediately rather than producing a silently-empty badge.
    mockApi.voice.getActiveCalls.mockResolvedValue({
      calls: [{ id: 'c1' }, { id: 'c2' }],
      total: 2,
    });

    render(
      <OutlookLayout
        activeTab="dashboard"
        setActiveTab={vi.fn()}
        role="owner"
        managedTenantId="tenant-active"
      >
        <div>content</div>
      </OutlookLayout>
    );

    // The badge's aria-label is the authoritative test handle — title-
    // attribute matching is brittle to copy edits. Desktop + mobile
    // nav both render the badge, so we expect at least one match.
    await waitFor(() => {
      expect(screen.getAllByLabelText(/2 active calls/i).length).toBeGreaterThan(0);
    });
  });

  test('SAD: Calls tab badge stays hidden when active-call count is 0', async () => {
    // WHO: operator on a quiet line — no calls in progress
    // WHAT: getActiveCalls returns total: 0 → the badge must NOT render.
    //       A 0-badge would be visual noise and would erode trust in the
    //       badge's actionability.
    mockApi.voice.getActiveCalls.mockResolvedValue({ calls: [], total: 0 });

    render(
      <OutlookLayout
        activeTab="dashboard"
        setActiveTab={vi.fn()}
        role="owner"
        managedTenantId="tenant-quiet"
      >
        <div>content</div>
      </OutlookLayout>
    );

    // Wait for the effect to fire then assert nothing rendered.
    await waitFor(() => {
      expect(mockApi.voice.getActiveCalls).toHaveBeenCalled();
    });
    expect(screen.queryByLabelText(/active call/i)).not.toBeInTheDocument();
  });

  test('HAPPY: the KB badge reads "unanswered" and sits in flow, not over the nav bar', async () => {
    // WHO: an owner who read the old "1 KB" pill as "one customer to take
    //      care of" and found it parked on top of the theme button, which
    //      then read "Na" instead of "Navy" (2026-09-09).
    // WHAT: the notification strip is an in-flow row under the tab bar —
    //       no `fixed` positioning, nothing to overlap — and the badge says
    //       what it counts.
    // WHERE: the nav-notification-strip block in OutlookLayout.tsx.
    // WHEN: any tenant with at least one unanswered KB question.
    // WHY: "KB" reads as kilobytes, and a fixed overlay covers whatever the
    //      AppShell puts in the same corner.
    mockApi.knowledge.unanswered.mockResolvedValue({
      questions: [{ unanswered_question_id: 'q1' }],
    });

    render(
      <OutlookLayout
        activeTab="dashboard"
        setActiveTab={vi.fn()}
        role="owner"
        managedTenantId="tenant-kb"
      >
        <div>content</div>
      </OutlookLayout>
    );

    const strip = await screen.findByTestId('nav-notification-strip');
    expect(strip.className).not.toContain('fixed');
    expect(strip.textContent).toContain('1 unanswered');
    expect(strip.textContent).not.toContain('KB');
  });

  test('HAPPY: super-admin with role=front_desk still sees management tabs', async () => {
    // WHO: Platform super-admin (tenant_id = 00000000...). The role
    //      column doesn't apply to them — admin status is identified by
    //      tenant_id, not by users.role. A super-admin with a stray
    //      'front_desk' role on their user record still needs full UI.
    // WHAT: Management tabs still render because isAdmin overrides role.
    // WHY: Without this, demoting a super-admin's user record would
    //      lock them out of the very dashboard they manage tenants from.
    render(
      <OutlookLayout activeTab="dashboard" setActiveTab={vi.fn()} role="front_desk" isAdmin>
        <div>content</div>
      </OutlookLayout>
    );
    expect(await screen.findByRole('tab', { name: /setup/i })).toBeInTheDocument();
  });
});
