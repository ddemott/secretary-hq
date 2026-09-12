/**
 * BusinessSettingsView Tests
 * Tests service management, resource management, calendar connection, CRM integrations, and availability.
 * Each section has happy + sad paths with 5W diagnostic context.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

// Mock tenant context
let mockTenantId = 'test-tenant-123';
vi.mock('../../lib/SessionContext', () => ({
  useActiveTenantId: () => mockTenantId,
}));

// Mock vocabulary
vi.mock('@/lib/VocabularyContext', () => ({
  useVocabulary: () => ({
    resource_label: 'Station',
    resource_plural: 'Stations',
    booking_label: 'Appointment',
  }),
  // Picked up by the new BusinessTypeSection so that applying a template
  // re-fetches vocabulary (the new business_type usually changes labels).
  useVocabularyRefresh: () => () => {},
}));

// Mock static data hook
const mockRefreshResources = vi.fn();
let mockResources: Array<{
  resource_id: string;
  name: string;
  description?: string;
  is_active?: boolean;
}> = [];
let mockServices: Array<{
  service_id: string;
  name: string;
  description?: string;
  duration_minutes: number;
}> = [];
let mockEmployees: Array<{ employee_id: string; name: string }> = [];
let mockStaticLoading = false;
let mockResourcesError: string | null = null;

vi.mock('../../lib/hooks', () => ({
  useStaticData: () => ({
    resources: mockResources,
    services: mockServices,
    employees: mockEmployees,
    loading: mockStaticLoading,
    error: mockResourcesError,
    refresh: mockRefreshResources,
  }),
}));

// Mock API
const mockGetConfig = vi.fn();
const mockGetCalendarSettings = vi.fn();
const mockGetAuthUrl = vi.fn();
const mockDisconnect = vi.fn();
const mockUpdateConfig = vi.fn();
const mockCreateService = vi.fn();
const mockUpdateService = vi.fn();
const mockDeleteService = vi.fn();
const mockCreateResource = vi.fn();
const mockUpdateResource = vi.fn();
const mockGetShiftSchedule = vi.fn();

vi.mock('../../lib/api', () => ({
  Api: {
    tenants: {
      getConfig: (...args: unknown[]) => mockGetConfig(...args),
      updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
    },
    // BusinessTypeSection (mounted at the top of BusinessSettingsView) calls
    // this on mount. Returning [] keeps the Card rendered but with no
    // template grid — the existing tests don't exercise template-switching.
    templates: {
      listFull: vi.fn().mockResolvedValue([]),
    },
    calendar: {
      getSettings: (...args: unknown[]) => mockGetCalendarSettings(...args),
      getAuthUrl: (...args: unknown[]) => mockGetAuthUrl(...args),
      disconnect: (...args: unknown[]) => mockDisconnect(...args),
    },
    services: {
      create: (...args: unknown[]) => mockCreateService(...args),
      update: (...args: unknown[]) => mockUpdateService(...args),
      delete: (...args: unknown[]) => mockDeleteService(...args),
    },
    resources: {
      create: (...args: unknown[]) => mockCreateResource(...args),
      update: (...args: unknown[]) => mockUpdateResource(...args),
    },
    shifts: {
      schedule: {
        forDate: (...args: unknown[]) => mockGetShiftSchedule(...args),
      },
    },
    square: {
      getSettings: vi.fn(),
      getAuthUrl: vi.fn(),
      disconnect: vi.fn(),
      triggerSync: vi.fn(),
    },
    exportData: {
      tenantData: (...args: unknown[]) => mockExportTenantData(...args),
    },
  },
}));

const mockExportTenantData = vi.fn();
const mockExportToast = vi.fn();
vi.mock('../ui/Toast', () => ({ showToast: (...args: unknown[]) => mockExportToast(...args) }));

// Mock CRMIntegrationCard to simplify tests
vi.mock('../crm/CRMIntegrationCard', () => ({
  CRMIntegrationCard: ({ provider }: { provider: { name: string } }) => (
    <div data-testid={`crm-card-${provider.name}`}>{provider.name} Integration</div>
  ),
}));

import BusinessSettingsView from './BusinessSettingsView';

describe('BusinessSettingsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTenantId = 'test-tenant-123';
    mockResources = [];
    mockServices = [];
    mockEmployees = [];
    mockStaticLoading = false;
    mockResourcesError = null;

    // Default team mode (team_size > 1)
    mockGetConfig.mockResolvedValue({ team_size: 3 });
    mockGetCalendarSettings.mockResolvedValue(null);
    mockGetAuthUrl.mockResolvedValue({ url: 'https://oauth.example.com' });
    mockDisconnect.mockResolvedValue({ success: true });
    mockUpdateConfig.mockResolvedValue({ success: true });
    mockCreateService.mockResolvedValue({ success: true });
    mockUpdateService.mockResolvedValue({ success: true });
    mockDeleteService.mockResolvedValue({ success: true });
    mockCreateResource.mockResolvedValue({ success: true });
    mockUpdateResource.mockResolvedValue({ success: true });
    mockGetShiftSchedule.mockResolvedValue([]);

    // Mock window.location for OAuth redirect tests
    // @ts-expect-error — intentional test-only override; window.location is read-only in DOM lib
    delete window.location;
    // @ts-expect-error — intentional test-only override
    window.location = { ...window.location, href: '', search: '' };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Happy Paths - Team Mode', () => {
    test('renders business settings header', async () => {
      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByText('Business Settings')).toBeInTheDocument();
      });
      // WHO: business owners | WHAT: settings page header
      // WHEN: navigating to settings | WHERE: BusinessSettingsView
      // WHY: users need to identify the settings page
    });

    test('shows calendar sync section in team mode', async () => {
      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByText('Calendar Synchronization')).toBeInTheDocument();
      });
      // WHO: team businesses | WHAT: calendar sync header
      // WHEN: team_size > 1 | WHERE: calendar section
      // WHY: team mode has different wording than solo
    });

    test('displays Google and Outlook calendar connection buttons when not connected', async () => {
      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByText('Connect Google Calendar')).toBeInTheDocument();
        expect(screen.getByText('Connect Outlook Calendar')).toBeInTheDocument();
      });
      // WHO: users | WHAT: calendar connection options
      // WHEN: no calendar connected | WHERE: calendar section
      // WHY: offer both major calendar providers
    });

    test('redirects to OAuth URL when connecting Google Calendar', async () => {
      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByText('Connect Google Calendar')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Connect Google Calendar'));

      await waitFor(() => {
        expect(mockGetAuthUrl).toHaveBeenCalledWith('test-tenant-123', 'google');
      });
      // WHO: users connecting calendar | WHAT: OAuth redirect
      // WHEN: clicking connect | WHERE: calendar buttons
      // WHY: initiate OAuth flow for Google
    });

    test('shows connected state and disconnect button when calendar is connected', async () => {
      mockGetCalendarSettings.mockResolvedValue({
        provider: 'google',
        external_calendar_id: 'calendar@gmail.com',
      });

      render(<BusinessSettingsView />);
      await waitFor(() => {
        // Check for disconnect button as it only appears when connected
        expect(screen.getByText('Disconnect')).toBeInTheDocument();
        // Check for calendar ID display
        expect(screen.getByText('ID: calendar@gmail.com')).toBeInTheDocument();
      });
      // WHO: users with connected calendar | WHAT: connected state
      // WHEN: calendar already connected | WHERE: calendar section
      // WHY: show current connection and allow disconnect
    });

    test('disconnects calendar when clicking disconnect', async () => {
      mockGetCalendarSettings.mockResolvedValue({
        provider: 'google',
        external_calendar_id: 'calendar@gmail.com',
      });

      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByText('Disconnect')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Disconnect'));

      await waitFor(() => {
        expect(mockDisconnect).toHaveBeenCalledWith('test-tenant-123');
      });
      // WHO: users | WHAT: calendar disconnect
      // WHEN: clicking disconnect | WHERE: connected state
      // WHY: allow users to unlink calendar
    });

    test('SAD: a failed assistant-name save shows an error toast, not a false success', async () => {
      // WHO: an owner renaming the AI assistant. WHAT: apiMutate resolves
      // {success:false} on non-2xx (never throws), so the handler must inspect
      // it — else it toasted success while the agent kept the OLD name on calls.
      // WHERE: saveAssistantName. WHY: a save that lies is a live-call defect.
      mockUpdateConfig.mockResolvedValue({ success: false, error: 'That name is too long.' });
      render(<BusinessSettingsView />);
      const input = await screen.findByLabelText('Assistant name');
      fireEvent.change(input, { target: { value: 'Beth' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(mockExportToast).toHaveBeenCalledWith('That name is too long.', 'error')
      );
      expect(mockExportToast).not.toHaveBeenCalledWith('Assistant name set to "Beth".', 'success');
    });

    test('SAD: a failed calendar disconnect shows an error toast', async () => {
      // WHO: an owner unlinking a calendar. WHAT: apiMutate {success:false} was
      // swallowed — the "Connected" badge stayed with no feedback. WHERE:
      // handleDisconnectCalendar else branch. WHY: silent failure reads as a hang.
      mockGetCalendarSettings.mockResolvedValue({
        provider: 'google',
        external_calendar_id: 'calendar@gmail.com',
      });
      mockDisconnect.mockResolvedValue({ success: false, error: 'Disconnect failed on server.' });
      render(<BusinessSettingsView />);
      fireEvent.click(await screen.findByText('Disconnect'));
      await waitFor(() =>
        expect(mockExportToast).toHaveBeenCalledWith('Disconnect failed on server.', 'error')
      );
    });

    test('SAD: a failed Google connect shows an error toast', async () => {
      // WHO: an owner starting an OAuth connect. WHAT: getAuthUrl throws on
      // non-2xx; the spinner cleared with no explanation. WHERE:
      // handleConnectCalendar catch. WHY: the click looked like it did nothing.
      mockGetAuthUrl.mockRejectedValue(new Error('boom'));
      render(<BusinessSettingsView />);
      fireEvent.click(await screen.findByText('Connect Google Calendar'));
      await waitFor(() =>
        expect(mockExportToast).toHaveBeenCalledWith(
          'Could not start the Google Calendar connection. Please try again.',
          'error'
        )
      );
    });

    test('displays CRM integration cards', async () => {
      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByTestId('crm-card-Square')).toBeInTheDocument();
      });
      // WHO: users | WHAT: CRM integration options
      // WHEN: viewing settings | WHERE: CRM section
      // WHY: connect to external CRM systems
    });

    // Resource-management tests removed 2026-06-03 (IA merge Phase 2): the
    // resource editor moved to the Setup → Resources sub-tab (ResourceManagerView,
    // covered by its own tests). BusinessSettingsView no longer renders it.
  });

  describe('Happy Paths - Solo Mode', () => {
    beforeEach(() => {
      mockGetConfig.mockResolvedValue({ team_size: 1 });
      mockEmployees = [{ employee_id: 'emp-1', name: 'Dale' }];
      mockServices = [
        { service_id: 'svc-1', name: 'Haircut', duration_minutes: 30, description: 'Standard cut' },
      ];
    });

    test('shows solo-specific header text', async () => {
      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByText('Your services, availability, and calendar')).toBeInTheDocument();
      });
      // WHO: solo practitioners | WHAT: personalized header
      // WHEN: team_size = 1 | WHERE: header subtitle
      // WHY: solo users see personalized wording
    });

    test('shows My Services pointer card in solo mode', async () => {
      // WHO: solo practitioners | WHAT: services pointer card shown
      // WHEN: team_size = 1 | WHERE: My Services button card
      // WHY: services were duplicated between Business Settings and My
      //      Business → Services (the canonical editor); replaced with a
      //      pointer so there is one source of truth. 2026-05-28 P1 dedup.
      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByText('My Services')).toBeInTheDocument();
        // Shows service count from live data
        expect(screen.getByText(/1 service — tap to add, edit, or remove/i)).toBeInTheDocument();
      });
    });

    test('shows My Availability section in solo mode', async () => {
      mockGetShiftSchedule.mockResolvedValue([
        { shift_date: '2026-04-09', start_time: '09:00:00', end_time: '17:00:00', is_off: false },
      ]);

      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByText('My Availability')).toBeInTheDocument();
      });
      // WHO: solo practitioners | WHAT: availability section
      // WHEN: team_size = 1 | WHERE: availability card
      // WHY: show weekly schedule overview
    });

    test('HAPPY: availability tiles render real day/number when shift_date is a full ISO timestamp', async () => {
      // WHO: solo practitioner whose backend returns pg DATE as ISO timestamp string.
      // WHAT: the tile must show a valid short day name ("Thu") and numeric day
      //        (18) — not "NaN" / "undefined" — when shift_date arrives as
      //        "2026-06-18T00:00:00.000Z" instead of bare "2026-06-18".
      // WHEN: every page load after the backend serialises DATE via JSON.
      // WHERE: BusinessSettingsView availability grid tiles.
      // WHY: appending "T12:00:00" to the full ISO string produces an unparseable
      //      date → NaN. The fix slices to YYYY-MM-DD first.
      mockGetConfig.mockResolvedValue({ team_size: 1 });
      mockGetShiftSchedule.mockResolvedValue([
        {
          shift_date: '2026-06-18T00:00:00.000Z',
          start_time: '09:00:00',
          end_time: '17:00:00',
          is_off: false,
        },
      ]);

      render(<BusinessSettingsView />);

      await waitFor(() => {
        expect(screen.getByText('My Availability')).toBeInTheDocument();
        expect(screen.getByText('18')).toBeInTheDocument();
      });

      // Day name must be one of the known short labels — not "NaN" or "undefined".
      const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dayNameEl = DAY_NAMES.map((d) => screen.queryByText(d)).find(Boolean);
      expect(dayNameEl).toBeTruthy();

      // Day number must be a parseable integer — not NaN.
      expect(screen.getByText('18')).toBeInTheDocument();
    });

    test('shows My Calendar in solo mode', async () => {
      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByText('My Calendar')).toBeInTheDocument();
      });
      // WHO: solo practitioners | WHAT: personalized calendar header
      // WHEN: team_size = 1 | WHERE: calendar section
      // WHY: solo users see personalized wording
    });

    test('pointer card shows 0-service empty message', async () => {
      // WHO: new solo user with no services yet
      // WHAT: pointer card shows "No services yet" copy
      // WHEN: services list is empty | WHERE: My Services button
      // WHY: pointer card still gives useful context before redirecting
      mockServices = [];
      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(
          screen.getByText(/No services yet — tap to add what you offer/i)
        ).toBeInTheDocument();
      });
    });
  });

  describe('Sad Paths', () => {
    test('shows loading state while fetching team size', async () => {
      mockGetConfig.mockImplementation(() => new Promise(() => {})); // Never resolves
      render(<BusinessSettingsView />);
      expect(screen.getByText('Loading settings...')).toBeInTheDocument();
      // WHO: users | WHAT: loading indicator
      // WHEN: fetching config | WHERE: main view
      // WHY: feedback while determining team size
    });

    test('handles team size fetch error gracefully', async () => {
      mockGetConfig.mockRejectedValue(new Error('Network error'));
      render(<BusinessSettingsView />);
      await waitFor(() => {
        // Should fall back to team mode (teamSize = null treated as team)
        expect(screen.queryByText('My Services')).not.toBeInTheDocument();
      });
      // WHO: users | WHAT: error fallback
      // WHEN: config API fails | WHERE: view rendering
      // WHY: default to team mode on error
    });

    test('shows empty services message when no services exist', async () => {
      // WHO: new solo users | WHAT: pointer card empty state
      // WHEN: no services | WHERE: My Services pointer card
      // WHY: pointer still gives actionable guidance before navigating
      mockGetConfig.mockResolvedValue({ team_size: 1 });
      mockEmployees = [{ employee_id: 'emp-1', name: 'Dale' }];
      mockServices = [];

      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(
          screen.getByText(/No services yet — tap to add what you offer/i)
        ).toBeInTheDocument();
      });
      // Old: 'No services yet. Add what you offer so clients can book.'
      // New: pointer card copy — 2026-05-28 dedup (editor moved to My Business)
      // WHY: guide user to add services
    });

    test('shows no schedule message when shifts are empty', async () => {
      mockGetConfig.mockResolvedValue({ team_size: 1 });
      mockEmployees = [{ employee_id: 'emp-1', name: 'Dale' }];
      mockGetShiftSchedule.mockResolvedValue([]);

      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByText(/No schedule set yet/)).toBeInTheDocument();
      });
      // WHO: solo users | WHAT: empty schedule state
      // WHEN: no shifts | WHERE: availability section
      // WHY: direct user to set schedule
    });

    // Resource sad-path tests removed 2026-06-03 (IA merge Phase 2) — resource
    // editor moved to Setup → Resources (ResourceManagerView).
  });

  describe('Edge Cases', () => {
    test('hides My Services and My Availability in team mode', async () => {
      mockGetConfig.mockResolvedValue({ team_size: 5 });

      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.queryByText('My Services')).not.toBeInTheDocument();
        expect(screen.queryByText('My Availability')).not.toBeInTheDocument();
      });
    });

    test('shows shifts loading state', async () => {
      mockGetConfig.mockResolvedValue({ team_size: 1 });
      mockEmployees = [{ employee_id: 'emp-1', name: 'Dale' }];
      mockGetShiftSchedule.mockImplementation(() => new Promise(() => {}));

      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByText('Loading schedule...')).toBeInTheDocument();
      });
    });

    test('fetches shifts for solo employee', async () => {
      mockGetConfig.mockResolvedValue({ team_size: 1 });
      mockEmployees = [{ employee_id: 'emp-1', name: 'Dale' }];
      mockGetShiftSchedule.mockResolvedValue([
        { shift_date: '2026-04-09', start_time: '09:00:00', end_time: '17:00:00', is_off: false },
      ]);

      render(<BusinessSettingsView />);

      // Wait for solo mode to be detected and shifts to be fetched
      await waitFor(
        () => {
          expect(mockGetShiftSchedule).toHaveBeenCalled();
        },
        { timeout: 3000 }
      );
      // WHO: solo users | WHAT: shift schedule display
      // WHEN: solo mode detected | WHERE: availability section
      // WHY: show working hours for the solo practitioner
    });

    test('shows Off indicator for days off', async () => {
      mockGetConfig.mockResolvedValue({ team_size: 1 });
      mockEmployees = [{ employee_id: 'emp-1', name: 'Dale' }];
      mockGetShiftSchedule.mockResolvedValue([{ shift_date: '2026-04-09', is_off: true }]);

      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByText('Off')).toBeInTheDocument();
      });
    });

    test('shows Connected badge when calendar is connected', async () => {
      mockGetCalendarSettings.mockResolvedValue({
        provider: 'outlook',
        external_calendar_id: 'user@outlook.com',
      });

      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByText('Connected')).toBeInTheDocument();
      });
    });

    test('pointer card shows plural service count correctly', async () => {
      // WHO: solo user with multiple services
      // WHAT: pointer card count says "2 services" (plural)
      // WHEN: services.length > 1 | WHERE: My Services pointer
      // WHY: verify plural copy path — same button, different count label
      mockGetConfig.mockResolvedValue({ team_size: 1 });
      mockEmployees = [{ employee_id: 'emp-1', name: 'Dale' }];
      mockServices = [
        { service_id: 'svc-1', name: 'Haircut', duration_minutes: 30 },
        { service_id: 'svc-2', name: 'Beard Trim', duration_minutes: 15 },
      ];

      render(<BusinessSettingsView />);
      await waitFor(() => {
        expect(screen.getByText(/2 services — tap to add, edit, or remove/i)).toBeInTheDocument();
      });
    });
  });

  describe('Data export', () => {
    test('HAPPY: "Download my data" fetches the export and triggers a file download', async () => {
      // WHO: an owner exercising their data-portability right.
      // WHAT: clicking the button calls Api.exportData.tenantData and downloads
      //        the returned JSON as a file (Blob → anchor click).
      // WHEN: the export succeeds with a record count.
      // WHERE: the "Your data" card in Business Settings.
      // WHY: completes the export API with an actual owner-facing surface.
      const createObjectURL = vi.fn(() => 'blob:mock');
      const revokeObjectURL = vi.fn();
      // jsdom doesn't implement these — stub them for the download path.
      (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
      (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

      mockExportTenantData.mockResolvedValue({
        success: true,
        tenant_id: 'test-tenant-123',
        generated_at: '2026-06-22T00:00:00Z',
        record_counts: { customers: 2 },
        total_records: 2,
        tables: { customers: [{}, {}] },
      });

      render(<BusinessSettingsView />);
      const btn = await screen.findByRole('button', { name: /Download my data/i });
      fireEvent.click(btn);

      await waitFor(() => expect(mockExportTenantData).toHaveBeenCalledWith('test-tenant-123'));
      await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
      expect(clickSpy).toHaveBeenCalled();
      expect(mockExportToast).toHaveBeenCalledWith('Exported 2 records', 'success');

      clickSpy.mockRestore();
    });

    test('SAD: an export failure toasts an error and does not download', async () => {
      mockExportTenantData.mockResolvedValue({ success: false, error: 'nope' });
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

      render(<BusinessSettingsView />);
      fireEvent.click(await screen.findByRole('button', { name: /Download my data/i }));

      await waitFor(() =>
        expect(mockExportToast).toHaveBeenCalledWith('Failed to export your data', 'error')
      );
      expect(clickSpy).not.toHaveBeenCalled();
      clickSpy.mockRestore();
    });
  });
});
