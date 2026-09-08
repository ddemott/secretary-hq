/**
 * SoloWizard tests — focused on the integration points that are easy
 * to break: transitioning between the four steps, finalize calling
 * the right API sequence, and (most importantly) the new
 * Api.shifts.expandWeekly bridge that fixes the post-onboarding
 * "EMPLOYEE_NOT_SCHEDULED" bug.
 *
 * Independence: every test renders a fresh wizard, every test sets up
 * its own fetch mock from scratch in beforeEach. No state crosses
 * between tests.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

// Mock SessionContext — fixed tenant + owner name so the wizard's
// "ensure owner employee exists" branch can run.
vi.mock('@/lib/SessionContext', () => ({
  useSessionContext: () => ({
    tenantId: 'f234e471-0e60-4163-86c9-93cfd9338e3a',
    userName: 'Solo Owner',
    isAdmin: false,
    managedTenantId: 'f234e471-0e60-4163-86c9-93cfd9338e3a',
    managedTenantName: 'Test Solo',
    loading: false,
    login: vi.fn(),
    logout: vi.fn(),
    selectManagedTenant: vi.fn(),
    tenantsVersion: 0,
    notifyTenantsChanged: vi.fn(),
  }),
  useActiveTenantId: () => 'f234e471-0e60-4163-86c9-93cfd9338e3a',
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/lib/VocabularyContext', () => ({
  useVocabulary: () => ({
    resource_label: 'Resource',
    resource_plural: 'Resources',
    employee_label: 'Employee',
    employee_plural: 'Employees',
    booking_label: 'Appointment',
  }),
}));

import SoloWizard from './SoloWizard';

const TENANT_ID = 'f234e471-0e60-4163-86c9-93cfd9338e3a';
const OWNER_EMPLOYEE_ID = '11111111-2222-3333-8444-555555555555';
const RESOURCE_ID = 'a1b2c3d4-e5f6-4789-ab12-cdef34567890';

const MOCK_SERVICES = [
  { service_id: 'svc-1', name: 'Oil Change', duration_minutes: 30, price: 50 },
];

/**
 * Build a fresh fetch mock for one test. Returns a vi.fn() so the test
 * can also inspect call history. Each test calls this in its own
 * beforeEach-style setup so no test inherits state from the previous.
 */
function setupFetchMock() {
  (global.fetch as unknown as ReturnType<typeof vi.fn>) = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      const path = typeof url === 'string' ? url : '';

      // Auto-seed flow on step 1
      if (
        path.includes('/services') &&
        (!init || init.method === 'GET' || init.method === undefined)
      ) {
        return Promise.resolve({ ok: true, json: async () => MOCK_SERVICES });
      }
      if (path.includes('/templates')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }

      // Step 2 — wizard creates the owner employee here.
      if (path.includes('/employees/create') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            employee: {
              employee_id: OWNER_EMPLOYEE_ID,
              name: 'Solo Owner',
              first_name: 'Solo',
              last_name: 'Owner',
            },
          }),
        });
      }

      // Step 2 — wizard reads /shifts to load the empty pattern.
      if (path.endsWith('/shifts') || path.includes('/shifts?')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }

      // Step 4 — finalize sequence:
      if (path.includes('/resources/create') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            resource: { resource_id: RESOURCE_ID, name: 'Main Station' },
          }),
        });
      }
      if (path.includes('/mappings')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      }
      if (path.includes('/shifts/expand-weekly')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            inserted: 0,
            rangeStart: '2026-04-30',
            rangeEnd: '2026-05-27',
          }),
        });
      }
      if (path.includes('/coverage')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }

      // Default — empty list, ok: true
      return Promise.resolve({ ok: true, json: async () => [] });
    });
}

beforeEach(() => {
  // Reset every test's data: localStorage, mocks, fetch handlers.
  // No test's setup leaks into the next.
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('tenantId', TENANT_ID);
  setupFetchMock();
});

describe('SoloWizard — finalize fans weekly availability', () => {
  test('handleFinalize calls Api.shifts.expandWeekly for the owner employee', async () => {
    // WHO: solo-business owner finishing the 4-step solo wizard.
    // WHAT: clicking "Complete Setup" on step 4 must trigger a POST
    //       to /shifts/expand-weekly with the owner's employee id —
    //       this is the bridge that makes booking RPCs honor the
    //       weekly availability the owner just set.
    // WHERE: dashboard/components/SetupWizard/SoloWizard.tsx
    //       handleFinalize, between the service-mapping loop and the
    //       coverage refresh.
    // WHEN: every solo onboarding completion. The team-wizard
    //       counterpart fires at goNext step-7→8 and is covered in
    //       SetupWizard/SetupWizard.test.tsx.
    // WHY: pre-fix bug — owners completed onboarding with a green
    //       checkmark, then every booking attempt failed with
    //       EMPLOYEE_NOT_SCHEDULED. This test pins the fix in place
    //       so a future refactor can't quietly drop the call.
    render(<SoloWizard isOpen={true} onClose={() => {}} />);

    // Wait for step 1 to render with the seeded service.
    await waitFor(() => {
      expect(screen.getByText('Oil Change')).toBeInTheDocument();
    });

    // Step 1 → 2.
    fireEvent.click(screen.getByText('Next'));

    // Step 2 triggers the create-owner-employee flow. Wait for the
    // hours step to render (its unique heading).
    await waitFor(() => {
      expect(screen.getByText('When are you available?')).toBeInTheDocument();
    });

    // Step 2 → 3 (Teach Your AI).
    fireEvent.click(screen.getByText('Next'));

    // Step 3 → 4 (Review/Finalize).
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => {
      expect(screen.getByText('Complete Setup')).toBeInTheDocument();
    });

    // Click "Complete Setup" — fires handleFinalize.
    fireEvent.click(screen.getByText('Complete Setup'));

    // Wait for the expandWeekly call to land. Use a fresh assertion
    // each render to avoid stale call history.
    await waitFor(() => {
      const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
      const expandCalls = fetchMock.mock.calls.filter((call) => {
        const url = String(call[0] ?? '');
        const init = call[1] as RequestInit | undefined;
        return url.includes('/shifts/expand-weekly') && init?.method === 'POST';
      });
      expect(expandCalls.length).toBe(1);
    });

    // Verify the call carried the correct employee id.
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const expandCall = fetchMock.mock.calls.find((call) => {
      const url = String(call[0] ?? '');
      return url.includes('/shifts/expand-weekly');
    });
    expect(expandCall).toBeDefined();
    const rawBody = (expandCall![1] as RequestInit).body;
    const body = JSON.parse(typeof rawBody === 'string' ? rawBody : '{}');
    expect(body.employee_id).toBe(OWNER_EMPLOYEE_ID);
    expect(body.tenant_id).toBe(TENANT_ID);
  });

  test('finalize halts at the failing step when expand-weekly errors', async () => {
    // WHO: owner whose finalize sequence partially succeeds (resource
    //      created, services assigned) but expand-weekly fails (e.g.,
    //      transient DB error, RLS context drift).
    // WHAT: the wizard surfaces the error in its error state — no
    //       silent green checkmark — and does NOT proceed to fetch
    //       coverage (which would render success UI on partial state).
    // WHERE: handleFinalize in SoloWizard.tsx — try/catch that wraps
    //       the entire finalize sequence.
    // WHEN: any non-2xx from /shifts/expand-weekly during finalize.
    // WHY: silent failure here is exactly the bug we're fixing.
    //      A finalize that "succeeds" but skips the schedule fan-out
    //      lands the owner on a green screen with broken bookings.
    //      We need the error to surface so the user retries.

    // Override only the expand-weekly call to throw.
    setupFetchMock();
    const baseFetch = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const originalImpl = baseFetch.getMockImplementation();
    baseFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/shifts/expand-weekly')) {
        return Promise.reject(new Error('expand-weekly failed'));
      }
      return (originalImpl as (u: string, i?: RequestInit) => Promise<unknown>)(url, init);
    });

    render(<SoloWizard isOpen={true} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Oil Change')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('When are you available?')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('Complete Setup')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Complete Setup'));

    // Wizard should still be on step 4 (NOT show "You're all set!")
    // because the throw aborted finalize before setFinalized(true).
    await waitFor(() => {
      // Wait for the finalize attempt to settle. The button label
      // returns from "Setting up..." back to "Complete Setup" after
      // the throw is caught.
      expect(screen.getByText('Complete Setup')).toBeInTheDocument();
    });
    expect(screen.queryByText("You're all set!")).not.toBeInTheDocument();
  });
});

describe('SoloWizard — re-running setup on a tenant that already has data', () => {
  test('reuses the existing owner employee instead of creating a duplicate', async () => {
    // WHO: a solo owner (Dale) who already completed setup once and reopens
    //      the Setup Assistant to change something.
    // WHAT: stepping onto step 2 must REUSE the existing staff row whose name
    //       matches the owner, and must NOT POST /employees/create.
    // WHERE: SoloWizard.ensureOwnerEmployee.
    // WHEN: every re-run — `ownerEmployeeId` is null on each open, so the
    //       pre-fix code unconditionally re-created the owner.
    // WHY: regression. The backend duplicate-name guard (src/routes/employees.ts)
    //      answered 409 "An active employee named 'Solo Owner' already exists",
    //      which surfaced as an error and dead-ended the wizard at step 2 —
    //      making setup impossible to redo for exactly the tenants who had
    //      already run it once.
    const EXISTING_ID = '99999999-8888-4777-8666-555555555555';
    const baseFetch = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const originalImpl = baseFetch.getMockImplementation();
    baseFetch.mockImplementation((url: string, init?: RequestInit) => {
      const path = typeof url === 'string' ? url : '';
      // The roster already contains the owner — this is the "already have
      // data" precondition the pre-fix code ignored.
      if (
        path.includes('/employees') &&
        (!init || init.method === 'GET' || init.method === undefined)
      ) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { employee_id: EXISTING_ID, name: 'Solo Owner', is_active: true, skills: [] },
          ],
        });
      }
      return (originalImpl as (u: string, i?: RequestInit) => Promise<unknown>)(url, init);
    });

    render(<SoloWizard isOpen={true} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Oil Change')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('When are you available?')).toBeInTheDocument());

    // The duplicate-creating call must never have been made.
    const createCalls = baseFetch.mock.calls.filter(
      ([u, i]) =>
        typeof u === 'string' &&
        u.includes('/employees/create') &&
        (i as RequestInit | undefined)?.method === 'POST'
    );
    expect(createCalls).toHaveLength(0);

    // And the reused id must be the one finalize writes the hours against —
    // otherwise the owner's schedule would be fanned onto a phantom employee.
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('Complete Setup')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Complete Setup'));

    await waitFor(() => {
      const expand = baseFetch.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('/shifts/expand-weekly')
      );
      expect(expand).toBeTruthy();
      const body = JSON.parse((expand![1] as RequestInit).body as string);
      expect(body.employee_id).toBe(EXISTING_ID);
    });
  });
});

describe('SoloWizard — re-answering "when do you work"', () => {
  test('preloads the existing hours and finalizes with replace, so an unchecked day is dropped', async () => {
    // WHO: a solo owner reopening Setup to change their working days.
    // WHAT: step 2 must show the hours ALREADY on their schedule (not a blank
    //       week), and finalize must send replace=true so a day they uncheck is
    //       actually removed.
    // WHERE: SoloWizard hours-preload effect + handleFinalize.
    // WHY: expand-weekly is ON CONFLICT DO NOTHING — additive only. Pre-fix, the
    //      grid started empty and finalize merged, so re-answering this question
    //      could add days but never remove one. Preload and replace are only safe
    //      TOGETHER: replacing from a grid we never populated would erase the
    //      owner's real hours, which is why replace rides on the preload landing.
    const EXISTING_ID = '99999999-8888-4777-8666-555555555555';
    const baseFetch = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const originalImpl = baseFetch.getMockImplementation();
    baseFetch.mockImplementation((url: string, init?: RequestInit) => {
      const path = typeof url === 'string' ? url : '';
      if (
        path.includes('/employees') &&
        (!init || init.method === 'GET' || init.method === undefined)
      ) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            { employee_id: EXISTING_ID, name: 'Solo Owner', is_active: true, skills: [] },
          ],
        });
      }
      // The owner already works Mondays — this is what the grid must show.
      if (path.includes('/setup/graph')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            services: [],
            resources: [],
            employees: [],
            shifts: [
              {
                employee_id: EXISTING_ID,
                day_of_week: 1,
                start_time: '09:00',
                end_time: '17:00',
              },
            ],
            service_employee: [],
            service_resource: [],
          }),
        });
      }
      return (originalImpl as (u: string, i?: RequestInit) => Promise<unknown>)(url, init);
    });

    render(<SoloWizard isOpen={true} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('Oil Change')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('When are you available?')).toBeInTheDocument());

    // The preload must have landed before finalize can claim replace.
    await waitFor(() => {
      expect(
        baseFetch.mock.calls.some(([u]) => typeof u === 'string' && u.includes('/setup/graph'))
      ).toBe(true);
    });

    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('Complete Setup')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Complete Setup'));

    await waitFor(() => {
      const expand = baseFetch.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('/shifts/expand-weekly')
      );
      expect(expand).toBeTruthy();
      const body = JSON.parse((expand![1] as RequestInit).body as string);
      // replace=true is what makes an unchecked day actually disappear.
      expect(body.replace).toBe(true);
      // And the preloaded Monday is still in the pattern — preloading must not
      // silently drop the hours it just loaded.
      expect(body.pattern).toEqual([{ day_of_week: 1, start_time: '09:00', end_time: '17:00' }]);
    });
  });
});
