/**
 * DashboardHome tests — the trust-critical behaviors:
 *   - Load failures are visible (not silently swallowed)
 *   - Retry works without a page reload
 *   - The "Today's Schedule" empty state offers next actions instead of
 *     being a dead end
 *
 * Each test carries 5W diagnostic context.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

// ── Mocks ─────────────────────────────────────────────────────────────
vi.mock('../lib/SessionContext', () => ({
  useActiveTenantId: () => 'tenant-123',
  useSessionContext: () => ({ userName: 'Dale' }),
}));

vi.mock('@/lib/VocabularyContext', () => ({
  useVocabulary: () => ({
    resource_plural: 'Bays',
    employee_plural: 'Techs',
    employee_label: 'Tech',
    booking_label: 'Appointment',
  }),
  useVocabularyRefresh: () => vi.fn(),
}));

// Api mocks. vi.hoisted ensures the mock factory can reference these
// without tripping the "top-level variables in vi.mock factory" lint.
const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    appointments: { list: vi.fn() },
    employees: { list: vi.fn() },
    services: { list: vi.fn() },
    resources: { list: vi.fn() },
    // QuickBookPanel (mounted by DashboardHome after C3) needs the customer
    // list; fetched as part of loadData()'s Promise.allSettled batch.
    customers: { list: vi.fn() },
    templates: { listFull: vi.fn() },
    tenants: {
      updateConfig: vi.fn(),
      // useTenantTimezone (added to QuickBookPanel 2026-05-28) calls getConfig.
      getConfig: vi.fn().mockResolvedValue({ timezone: 'America/Chicago' }),
    },
    shifts: { schedule: { forDate: vi.fn() } },
    // QuickBookPanel suggests employees skilled for the picked service,
    // and resources required for the picked service.
    mappings: { listServiceEmployee: vi.fn(), listServiceResource: vi.fn() },
    // Wired in feat/analytics-reliability-tiles (uses /analytics/stats for home snapshot + reliability).
    analytics: { getStats: vi.fn() },
  },
}));

vi.mock('../lib/api', () => ({
  Api: mockApi,
}));

// Dynamic import AFTER mocks are set up
import DashboardHome from './DashboardHome';

beforeEach(() => {
  // Reset all api mocks. Default: return [] so the component renders its
  // empty states without error. Individual tests override.
  mockApi.appointments.list.mockReset().mockResolvedValue([]);
  // Return ONE employee so "needs setup" branch doesn't auto-open the wizard
  // and hide the dashboard content under test.
  mockApi.employees.list
    .mockReset()
    .mockResolvedValue([{ employee_id: 'e1', name: 'Alice', type: 'employee', is_active: true }]);
  mockApi.services.list.mockReset().mockResolvedValue([{ service_id: 's1', name: 'Oil Change' }]);
  mockApi.resources.list.mockReset().mockResolvedValue([{ resource_id: 'r1', name: 'Bay 1' }]);
  mockApi.customers.list.mockReset().mockResolvedValue([]);
  mockApi.shifts.schedule.forDate.mockReset().mockResolvedValue([]);
  mockApi.templates.listFull.mockReset().mockResolvedValue([]);
  mockApi.mappings.listServiceEmployee.mockReset().mockResolvedValue([]);
  mockApi.mappings.listServiceResource.mockReset().mockResolvedValue([]);
  mockApi.analytics.getStats.mockReset().mockResolvedValue(null);
  // Reset getConfig to baseline: has timezone but no inbound_phone.
  // Individual tests override inbound_phone to test status card states.
  mockApi.tenants.getConfig
    .mockReset()
    .mockResolvedValue({ timezone: 'America/Chicago', inbound_phone: null });
});

describe('DashboardHome — load error visibility', () => {
  test('HAPPY: all calls succeed → no error banner', async () => {
    // WHO: Healthy backend, returning user
    // WHAT: No alert role in the DOM. Baseline for the failure tests below.
    render(<DashboardHome />);
    await screen.findByText(/today's schedule/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('SAD: one call fails → retryable error banner appears', async () => {
    // WHO: Owner opens the dashboard while the appointments API is flaky
    // WHAT: The component must NOT show an empty "no appointments" state
    //        — it must surface the failure with a retry option
    // WHY: Prior code used `.catch(() => [])` which made a network failure
    //        look identical to "no bookings today" — a trust-eroding lie
    mockApi.appointments.list.mockRejectedValue(new Error('network'));
    render(<DashboardHome />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  test('HAPPY: retry button re-fetches and clears the error when it succeeds', async () => {
    // WHO: Owner hits Try Again after a transient network blip
    // WHAT: Fresh fetch, banner disappears, data renders normally
    mockApi.appointments.list.mockRejectedValueOnce(new Error('network')).mockResolvedValue([]);

    render(<DashboardHome />);
    const retryBtn = await screen.findByRole('button', { name: /try again/i });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  test('HAPPY: dismiss button hides the error without re-fetching', async () => {
    // WHY: Sometimes the user knows the cause and doesn't want to retry
    //        (airplane mode, doing something else). Dismissal respects that.
    mockApi.appointments.list.mockRejectedValue(new Error('network'));
    render(<DashboardHome />);

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /dismiss error/i }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});

describe("DashboardHome — Today's Schedule click target (Fitts's Law)", () => {
  test('HAPPY: entire card header is a single button that navigates to schedule', async () => {
    // WHO: Owner glancing at Today's Schedule, wants the full view
    // WHAT: Clicking ANYWHERE on the "Today's Schedule" header (icon,
    //        title text, or "Full schedule" label) should navigate to the
    //        schedule tab. Previously only the 12px text link at the end
    //        was tappable — violates Fitts's Law.
    // WHY: Touch targets under ~24px are slow to hit and misfire often;
    //        promoting the whole header to one target (while preserving
    //        the chevron as visual affordance) is the canonical fix.
    const onNavigate = vi.fn();
    render(<DashboardHome onNavigate={onNavigate} />);
    const target = await screen.findByRole('button', { name: /view full schedule/i });
    fireEvent.click(target);
    expect(onNavigate).toHaveBeenCalledWith('schedule');
  });

  test('HAPPY: click target still has the "Full schedule" label + chevron affordance', async () => {
    // WHY: Making the whole row tappable is useless if the user can't
    //        SEE it's tappable. The chevron + text are the visual cue.
    render(<DashboardHome />);
    const target = await screen.findByRole('button', { name: /view full schedule/i });
    expect(target).toHaveTextContent(/full schedule/i);
  });
});

describe("DashboardHome — Today's Schedule empty state", () => {
  test('HAPPY: no bookings → CTA offers "View this week"', async () => {
    // WHO: Owner checking Monday morning with nothing on the books
    // WHAT: Instead of a dead-end "Nothing booked", offer a next action
    // WHY: Empty states without CTAs increase bounce and reduce feature
    //        discovery. Heuristic H10 + UX empty-state best practice.
    render(<DashboardHome />);
    await screen.findByText(/nothing booked for today yet/i);
    expect(screen.getByRole('button', { name: /view this week/i })).toBeInTheDocument();
  });

  test('HAPPY: solo operator sees no "See staff shifts" CTA (they ARE the staff)', async () => {
    // WHO: Solo tire shop owner with just themselves on staff
    // WHAT: The staff-shifts link is hidden when there's only one
    //        employee — it would just show them their own shift
    mockApi.employees.list.mockResolvedValue([
      { employee_id: 'e1', name: 'Solo', type: 'employee', is_active: true },
    ]);
    render(<DashboardHome />);
    await screen.findByText(/nothing booked for today yet/i);
    expect(screen.queryByRole('button', { name: /see staff shifts/i })).not.toBeInTheDocument();
  });

  test('HAPPY: multi-employee tenant sees both CTAs', async () => {
    // WHO: Shop with 3+ techs
    // WHAT: Both "View this week" and "See staff shifts" are offered
    mockApi.employees.list.mockResolvedValue([
      { employee_id: 'e1', name: 'Alice', type: 'employee', is_active: true },
      { employee_id: 'e2', name: 'Bob', type: 'employee', is_active: true },
      { employee_id: 'e3', name: 'Charlie', type: 'employee', is_active: true },
    ]);
    render(<DashboardHome />);
    await screen.findByText(/nothing booked for today yet/i);
    expect(screen.getByRole('button', { name: /view this week/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /see staff shifts/i })).toBeInTheDocument();
  });
});

describe('DashboardHome — New Booking button (C3, 2026-05-16)', () => {
  // WHY: New Booking is the most-frequent front-desk task. The 2026-05-07
  // audit measured 8+ decisions on the default Schedule landing; Quick
  // Book hoisted to all Schedule sub-tabs dropped that to ~3; C3 puts a
  // primary button on Home itself so the call-in path is one tap from
  // the dashboard landing.

  test('HAPPY: button is visible on a configured tenant and opens the panel', async () => {
    // WHO: Front-desk operator on a normal tenant with employees+services+resources
    // WHAT: The "New Booking" primary button is enabled; clicking it
    //       opens the QuickBookPanel (rendered as a fixed-position dialog).
    // WHERE: Top of Home, right side of the greeting block.
    render(<DashboardHome />);

    const button = await screen.findByRole('button', { name: /create a new booking/i });
    expect(button).toBeEnabled();

    button.click();

    // QuickBookPanel mounts a dialog with a data-testid hook the
    // SchedulerView e2e already relies on.
    expect(await screen.findByTestId('quick-book-panel')).toBeInTheDocument();
  });

  test('SAD: button is disabled when the tenant still needs setup', async () => {
    // WHO: Brand-new tenant whose loadData() returned no services yet
    // WHAT: needsSetup === true → button disabled so the operator can't
    //       open a panel where the service/employee/resource pickers
    //       would all be empty (worse than a clear "set up first" cue).
    // WHY: Empty pickers look like a bug; the wizard banner at the top
    //       of Home is the correct affordance for new tenants.
    mockApi.services.list.mockResolvedValueOnce([]);
    render(<DashboardHome />);

    const button = await screen.findByRole('button', { name: /create a new booking/i });
    expect(button).toBeDisabled();
  });
});

describe('DashboardHome — wizard welcome → mode chooser staging (D1, 2026-05-17)', () => {
  // WHY: A brand-new tenant landing on Home with nothing configured used
  // to be dropped straight into the WizardModeChooser ("Just me" / "I have
  // a team"). The 2026-05-16 UX audit found users hesitated because they
  // didn't know how long setup takes or whether they could pause. D1 adds
  // a Welcome screen ahead of the mode chooser to set scope ("~10 minutes,
  // stop any time") and give an explicit exit.

  // The "needs setup" branch fires when ANY of services/employees/resources
  // is empty. Force all three empty in this block so the wizard auto-opens.
  function withFreshTenant() {
    mockApi.services.list.mockResolvedValue([]);
    mockApi.employees.list.mockResolvedValue([]);
    mockApi.resources.list.mockResolvedValue([]);
  }

  test('HAPPY: fresh tenant auto-opens the welcome screen, NOT the mode chooser directly', async () => {
    // WHO: First-time tenant on the dashboard
    // WHAT: After load completes, the WizardWelcome dialog is visible and
    //       the WizardModeChooser is NOT — the welcome must gate the
    //       chooser, not appear alongside it.
    // WHY: A double-modal would look broken and the mode chooser shouldn't
    //      be reachable until the user has acknowledged scope.
    withFreshTenant();
    render(<DashboardHome />);

    await screen.findByRole('dialog', { name: /welcome/i });
    expect(screen.getByText(/a few quick steps/i)).toBeInTheDocument();
    expect(screen.queryByText(/how is your business set up/i)).not.toBeInTheDocument();
  });

  test('HAPPY: clicking "Let\'s go" advances welcome → mode chooser', async () => {
    // WHO: Fresh tenant who wants to proceed
    // WHAT: After clicking "Let's go", the welcome disappears and the
    //       mode chooser appears in its place.
    // WHY: The staged flow is welcome → chooser → business type → wizard.
    //      Skipping the chooser or showing both at once would be a regression.
    withFreshTenant();
    render(<DashboardHome />);

    await screen.findByRole('dialog', { name: /welcome/i });
    fireEvent.click(screen.getByRole('button', { name: /let's go/i }));

    await screen.findByText(/how is your business set up/i);
    expect(screen.queryByRole('dialog', { name: /welcome/i })).not.toBeInTheDocument();
  });

  test('SAD: "I\'ll set up later" dismisses the entire flow — no mode chooser appears', async () => {
    // WHO: Fresh tenant who wants to explore first
    // WHAT: Click "I'll set up later, just show me around" → both the
    //       welcome AND the mode chooser are absent. The post-dismiss
    //       banner replaces them so the user can come back.
    // WHY: Forcing setup before exploration violates Heuristic H3 (user
    //      control). The dismissal must be a real exit, not a "next step."
    withFreshTenant();
    render(<DashboardHome />);

    await screen.findByRole('dialog', { name: /welcome/i });
    fireEvent.click(screen.getByRole('button', { name: /set up later/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /welcome/i })).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/how is your business set up/i)).not.toBeInTheDocument();
    // Banner offering a re-entry — the user is not abandoned.
    expect(screen.getByRole('button', { name: /open setup assistant/i })).toBeInTheDocument();
  });

  test('HAPPY: re-opening via "Open Setup Assistant" skips welcome and goes straight to the mode chooser', async () => {
    // WHO: Tenant who dismissed welcome earlier and now explicitly wants to set up
    // WHAT: Clicking the banner's "Open Setup Assistant" jumps directly to
    //       the mode chooser — no welcome screen on the re-entry path.
    // WHY: The banner click IS the user saying "yes, set me up" — showing
    //      welcome again would be redundant friction. The auto-open path
    //      is the only one that needs the scope-setting framing.
    withFreshTenant();
    render(<DashboardHome />);

    await screen.findByRole('dialog', { name: /welcome/i });
    fireEvent.click(screen.getByRole('button', { name: /set up later/i }));

    const reopenBtn = await screen.findByRole('button', { name: /open setup assistant/i });
    fireEvent.click(reopenBtn);

    await screen.findByText(/how is your business set up/i);
    expect(screen.queryByRole('dialog', { name: /welcome/i })).not.toBeInTheDocument();
  });
});

describe('DashboardHome — AI Receptionist status card', () => {
  test('HAPPY: inbound_phone set → shows active state with formatted number', async () => {
    // WHO: owner who completed setup + has phone provisioned
    // WHAT: status card shows green "Active on" + formatted number
    // WHEN: loadData resolves with inbound_phone in tenant config
    // WHERE: DashboardHome, between wizard section and Today's Schedule
    // WHY: owners had no signal whether AI was live after finishing wizard
    mockApi.tenants.getConfig.mockResolvedValue({
      timezone: 'America/Chicago',
      inbound_phone: '+16308229086',
    });
    render(<DashboardHome />);
    await waitFor(() => {
      expect(screen.getByText('AI Receptionist')).toBeInTheDocument();
      expect(screen.getByText(/active on/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /configure/i })).not.toBeInTheDocument();
  });

  test('SAD: no inbound_phone → shows not-configured state with configure link', async () => {
    // WHO: owner who completed setup but hasn't provisioned a phone number
    // WHAT: status card shows "No phone number configured yet" + Configure button
    // WHEN: loadData resolves with inbound_phone: null
    // WHERE: DashboardHome status card
    // WHY: owner needs a clear call-to-action to activate the AI
    mockApi.tenants.getConfig.mockResolvedValue({
      timezone: 'America/Chicago',
      inbound_phone: null,
    });
    const onNavigate = vi.fn();
    render(<DashboardHome onNavigate={onNavigate} />);
    await waitFor(() => {
      expect(screen.getByText('AI Receptionist')).toBeInTheDocument();
      expect(screen.getByText(/no phone number configured yet/i)).toBeInTheDocument();
    });
    const configureBtn = screen.getByRole('button', { name: /configure/i });
    expect(configureBtn).toBeInTheDocument();
    fireEvent.click(configureBtn);
    expect(onNavigate).toHaveBeenCalledWith('ai-insights');
  });
});
