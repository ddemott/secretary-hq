import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

// Mock SessionContext
vi.mock('@/lib/SessionContext', () => ({
  useSessionContext: () => ({
    tenantId: 'f234e471-0e60-4163-86c9-93cfd9338e3a',
    userName: 'Test User',
    isAdmin: false,
    managedTenantId: 'f234e471-0e60-4163-86c9-93cfd9338e3a',
    managedTenantName: 'DynaTire',
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

// Mock VocabularyContext
vi.mock('@/lib/VocabularyContext', () => ({
  useVocabulary: () => ({
    resource_label: 'Resource',
    resource_plural: 'Resources',
    employee_label: 'Employee',
    employee_plural: 'Employees',
    booking_label: 'Appointment',
  }),
}));

import SetupWizard from './index';

// Phase B (2026-07-05): services/resources/employees are draft-local state —
// nothing is fetched from the API to populate the wizard, and canAdvanceTo
// gates forward navigation on the DRAFT arrays (at least one service to pass
// step 1; at least one service AND one employee to pass step 3). Tests that
// need to get past a step now drive the real "Add a service/employee" UI
// flow instead of pre-seeding via a fetch mock — matching how an owner
// actually clears these gates.
//
// global.fetch stays the mocking mechanism for this file (not @/lib/api):
// the wizard mounts Step7WebsiteScan / Step7CallerQuestions / Step7GoLive on
// later steps, each calling several of their own Api methods — swapping to
// vi.mock('@/lib/api') would require stubbing every method those children
// touch or have them crash on an undefined call. The existing catch-all
// fetch mock already tolerates unmocked paths.
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('tenantId', 'f234e471-0e60-4163-86c9-93cfd9338e3a');
  (global.fetch as unknown as ReturnType<typeof vi.fn>) = vi
    .fn()
    .mockImplementation((url: string, init?: { method?: string }) => {
      const path = typeof url === 'string' ? url : '';
      // /setup/commit fires on the transition into step 9 (see index.tsx
      // goNext) — every test that navigates that far needs this to
      // succeed, or the transition is blocked and the test hangs on step 8.
      if (path.includes('/setup/commit') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, counts: {} }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
});

function addService(name = 'Oil Change') {
  fireEvent.click(screen.getByText('Add a service'));
  fireEvent.change(screen.getByLabelText('Service Name'), { target: { value: name } });
  fireEvent.click(screen.getByText('Add Service'));
}

function addResource(name = 'Bay 1') {
  fireEvent.click(screen.getByText('Add a resource'));
  fireEvent.change(screen.getByLabelText('Resource Name'), { target: { value: name } });
  fireEvent.click(screen.getByText('Add Resource'));
}

function addEmployee(firstName = 'Mike', lastName = 'Smith') {
  fireEvent.click(screen.getByText('Add an employee'));
  fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: firstName } });
  fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: lastName } });
  fireEvent.click(screen.getByText('Add Employee'));
}

describe('SetupWizard: Shell', () => {
  test('does not render when isOpen is false', () => {
    const { container } = render(<SetupWizard isOpen={false} onClose={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  test('renders wizard when isOpen is true', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    expect(screen.getByText('Setup Assistant')).toBeInTheDocument();
  });

  test('shows step 1 by default', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    expect(screen.getByText('What services do you offer?')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 9')).toBeInTheDocument();
  });

  test('displays all 9 step labels in progress bar', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    expect(screen.getByText('What you offer')).toBeInTheDocument();
    expect(screen.getByText('Where it happens')).toBeInTheDocument();
    expect(screen.getByText('Who works here')).toBeInTheDocument();
    expect(screen.getByText('When they work')).toBeInTheDocument();
    expect(screen.getByText('Who does what')).toBeInTheDocument();
    expect(screen.getByText('Look it over')).toBeInTheDocument();
    expect(screen.getByText('Import from website')).toBeInTheDocument();
    expect(screen.getByText('Teach Your AI')).toBeInTheDocument();
    expect(screen.getByText("You're live")).toBeInTheDocument();
  });

  test('calls onClose when X button is clicked', () => {
    const onClose = vi.fn();
    render(<SetupWizard isOpen={true} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close wizard'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SetupWizard: Navigation', () => {
  test('navigates to step 2 when Next is clicked', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Step 2 of 9')).toBeInTheDocument();
    expect(screen.getByText('Where does work happen?')).toBeInTheDocument();
  });

  test('shows Back button on step 2', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    expect(screen.queryByText('Back')).toBeNull();
    addService();
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Back')).toBeInTheDocument();
  });

  test('navigates back to step 1 from step 2', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByText('Step 1 of 9')).toBeInTheDocument();
    expect(screen.getByText('What services do you offer?')).toBeInTheDocument();
  });

  async function advanceToStep8() {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next')); // -> 2
    fireEvent.click(screen.getByText('Next')); // -> 3
    addEmployee();
    fireEvent.click(screen.getByText('Next')); // -> 4
    fireEvent.click(screen.getByText('Next')); // -> 5
    fireEvent.click(screen.getByText('Next')); // -> 6
    fireEvent.click(screen.getByText('Next')); // -> 7
    fireEvent.click(screen.getByText('Next')); // -> 8
    await waitFor(() => expect(screen.getByText('Step 8 of 9')).toBeInTheDocument());
  }

  test('shows Go Live button on step 8 (questions) and Done on step 9', async () => {
    await advanceToStep8();
    fireEvent.click(screen.getByText('Go Live'));
    await waitFor(() => expect(screen.getByText('Done')).toBeInTheDocument());
    expect(screen.queryByText('Next')).toBeNull();
    expect(screen.getByText("You're live")).toBeInTheDocument();
  });

  test('Done button calls onClose', async () => {
    const onClose = vi.fn();
    render(<SetupWizard isOpen={true} onClose={onClose} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    addEmployee();
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('Go Live')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Go Live'));
    await waitFor(() => expect(screen.getByText('Done')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Done'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('clicking a completed step in progress bar navigates to it', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Step 3 of 9')).toBeInTheDocument();
    fireEvent.click(screen.getByText('What you offer'));
    expect(screen.getByText('Step 1 of 9')).toBeInTheDocument();
  });
});

describe('SetupWizard: Step 1 Services', () => {
  test('shows empty state when no services exist', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    expect(
      screen.getByText('No services yet. Add your first service to get started.')
    ).toBeInTheDocument();
  });

  test('shows "Add a service" button', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    expect(screen.getByText('Add a service')).toBeInTheDocument();
  });

  test('clicking "Add a service" shows the form', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Add a service'));
    expect(screen.getByText('New Service')).toBeInTheDocument();
    expect(screen.getByLabelText('Service Name')).toBeInTheDocument();
    expect(screen.getByText('Duration (minutes)')).toBeInTheDocument();
  });

  test('form has Cancel button that hides the form', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Add a service'));
    expect(screen.getByText('New Service')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('New Service')).toBeNull();
  });

  test('shows validation error for empty service name', async () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Add a service'));
    fireEvent.click(screen.getByText('Add Service'));
    await waitFor(() => {
      expect(screen.getByText('Service name is required')).toBeInTheDocument();
    });
  });

  test('shows validation error for zero duration', async () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Add a service'));
    const nameInput = screen.getByLabelText('Service Name');
    const durationInput = screen.getByDisplayValue('30');
    fireEvent.change(nameInput, { target: { value: 'Test Service' } });
    fireEvent.change(durationInput, { target: { value: '0' } });
    fireEvent.click(screen.getByText('Add Service'));
    await waitFor(() => {
      expect(screen.getByText('Duration must be at least 1 minute')).toBeInTheDocument();
    });
  });

  test('default duration is 30 minutes', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Add a service'));
    expect(screen.getByDisplayValue('30')).toBeInTheDocument();
  });

  test('a saved service renders in the list', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService('Tire Rotation');
    expect(screen.getByText('Tire Rotation')).toBeInTheDocument();
  });

  test('resets to step 1 when reopened', () => {
    const { rerender } = render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Step 3 of 9')).toBeInTheDocument();

    rerender(<SetupWizard isOpen={false} onClose={() => {}} />);
    rerender(<SetupWizard isOpen={true} onClose={() => {}} />);
    expect(screen.getByText('Step 1 of 9')).toBeInTheDocument();
    // The draft resets too — the service added before closing is gone.
    expect(
      screen.getByText('No services yet. Add your first service to get started.')
    ).toBeInTheDocument();
  });
});

// --- Step 2: Resources ---

describe('SetupWizard: Step 2 Resources', () => {
  function goToStep2() {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
  }

  test('shows resource step heading', () => {
    goToStep2();
    expect(screen.getByText('Where does work happen?')).toBeInTheDocument();
  });

  test('shows "Add a resource" button', () => {
    goToStep2();
    expect(screen.getByText('Add a resource')).toBeInTheDocument();
  });

  test('clicking "Add a resource" shows the form', () => {
    goToStep2();
    fireEvent.click(screen.getByText('Add a resource'));
    expect(screen.getByText('New Resource')).toBeInTheDocument();
    expect(screen.getByLabelText('Resource Name')).toBeInTheDocument();
  });

  test('form Cancel button hides the form', () => {
    goToStep2();
    fireEvent.click(screen.getByText('Add a resource'));
    expect(screen.getByText('New Resource')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('New Resource')).toBeNull();
  });

  test('shows validation error for empty resource name', async () => {
    goToStep2();
    fireEvent.click(screen.getByText('Add a resource'));
    fireEvent.click(screen.getByText('Add Resource'));
    await waitFor(() => {
      expect(screen.getByText('Resource name is required')).toBeInTheDocument();
    });
  });

  test('a saved resource renders in the list', () => {
    goToStep2();
    addResource('Bay 2');
    expect(screen.getByText('Bay 2')).toBeInTheDocument();
  });
});

// --- Step 3: Employees ---

describe('SetupWizard: Step 3 Employees', () => {
  function goToStep3() {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
  }

  test('shows employee step heading', () => {
    goToStep3();
    expect(screen.getByText('Who works here?')).toBeInTheDocument();
  });

  test('shows empty state when no employees exist', () => {
    goToStep3();
    expect(screen.getByText('No employees yet. Add your first team member.')).toBeInTheDocument();
  });

  test('shows "Add an employee" button', () => {
    goToStep3();
    expect(screen.getByText('Add an employee')).toBeInTheDocument();
  });

  test('clicking "Add an employee" shows the form with first/last name fields', () => {
    goToStep3();
    fireEvent.click(screen.getByText('Add an employee'));
    expect(screen.getByText('New Employee')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('First name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Last name')).toBeInTheDocument();
  });

  test('form Cancel button hides the form', () => {
    goToStep3();
    fireEvent.click(screen.getByText('Add an employee'));
    expect(screen.getByText('New Employee')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('New Employee')).toBeNull();
  });

  test('shows validation error for empty first name', async () => {
    goToStep3();
    fireEvent.click(screen.getByText('Add an employee'));
    fireEvent.click(screen.getByText('Add Employee'));
    await waitFor(() => {
      expect(screen.getByText('First name is required')).toBeInTheDocument();
    });
  });

  test('a saved employee renders in the list as "First Last"', () => {
    goToStep3();
    addEmployee('Sarah', 'Jones');
    expect(screen.getByText('Sarah Jones')).toBeInTheDocument();
  });

  test('shows email and phone fields in the form', () => {
    goToStep3();
    fireEvent.click(screen.getByText('Add an employee'));
    expect(screen.getByPlaceholderText('email@example.com')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('+1 (555) 555-5555')).toBeInTheDocument();
  });
});

// --- Step 4: Shifts ---

describe('SetupWizard: Step 4 Shifts', () => {
  function goToStep4() {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    addEmployee();
    fireEvent.click(screen.getByText('Next'));
  }

  test('shows shift step heading', () => {
    goToStep4();
    expect(screen.getByText('When does everyone work?')).toBeInTheDocument();
  });

  test('shows empty message when no employees exist', () => {
    // Reach step 4 without adding an employee is impossible under the
    // canAdvanceTo guard (step >= 4 requires an employee) — this now tests
    // the guard itself: Next does nothing without one.
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next')); // -> 2
    fireEvent.click(screen.getByText('Next')); // -> 3
    fireEvent.click(screen.getByText('Next')); // blocked — no employee yet
    expect(screen.getByText('Step 3 of 9')).toBeInTheDocument();
  });

  test('shows employee selector and schedule grid (ephemeral form state)', async () => {
    // WHO: owner stepping into Step 4 (Shifts) of the team wizard.
    // WHAT: employee selector lists draft employees; schedule grid shows 7
    //       day rows for the selected employee, starting entirely "Off" —
    //       shifts are ephemeral draft state until POST /setup/commit fires
    //       on entering step 9.
    // WHERE: dashboard/components/SetupWizard/StepShifts.tsx
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next')); // -> 2
    fireEvent.click(screen.getByText('Next')); // -> 3
    addEmployee('Mike', 'Smith');
    addEmployee('Sarah', 'Jones');
    fireEvent.click(screen.getByText('Next')); // -> 4

    expect(screen.getByText(/Mike Smith/)).toBeInTheDocument();
    expect(screen.getByText(/Sarah Jones/)).toBeInTheDocument();
    expect(screen.getByText('Select an employee above to set their schedule.')).toBeInTheDocument();

    fireEvent.click(screen.getAllByText(/Mike Smith/)[0]);

    await waitFor(() => {
      expect(screen.getByText('Sun')).toBeInTheDocument();
      expect(screen.getByText('Mon')).toBeInTheDocument();
      expect(screen.getByText('Sat')).toBeInTheDocument();
    });

    const offLabels = screen.getAllByText('Off');
    expect(offLabels.length).toBe(7);
  });
});

// --- Step 5: Assignments ---

describe('SetupWizard: Step 5 Assignments', () => {
  function goToStep5() {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    addEmployee();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
  }

  test('shows assignment step heading', () => {
    goToStep5();
    expect(screen.getByText('Connect everything together')).toBeInTheDocument();
  });

  test('shows service cards with employee and resource toggles', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService('Oil Change');
    fireEvent.click(screen.getByText('Next'));
    addResource('Bay 1');
    fireEvent.click(screen.getByText('Next'));
    addEmployee('Mike', 'Smith');
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));

    expect(screen.getAllByText('Oil Change').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Employees').length).toBeGreaterThan(0);
    expect(screen.getByText(/Mike Smith/)).toBeInTheDocument();
    expect(screen.getByText('Bay 1')).toBeInTheDocument();
  });
});

// --- Step 6: Review ---

describe('SetupWizard: Step 6 Review', () => {
  function goToStep6() {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    addEmployee();
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByText('Next'));
  }

  test('shows review step heading', () => {
    goToStep6();
    expect(screen.getByText('Review your setup')).toBeInTheDocument();
  });

  test('shows a summary count for the one added service', async () => {
    goToStep6();
    // 1 service, 0 resources (none added on this path), 1 employee.
    await waitFor(() => expect(screen.getAllByText('1').length).toBeGreaterThan(0));
  });

  test('shows "No services configured" when empty', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    // Can't reach step 6 with zero services (guarded) — covered instead by
    // the guard test in Step 4. This pins the copy shown when the coverage
    // dry-run itself returns nothing for a freshly-added service.
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    addEmployee();
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Review your setup')).toBeInTheDocument();
  });
});

// --- Step 9: Go Live ---

describe('SetupWizard: Step 9 Go Live', () => {
  async function goToStep9() {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next')); // -> 2
    fireEvent.click(screen.getByText('Next')); // -> 3
    addEmployee();
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByText('Next')); // -> 7
    fireEvent.click(screen.getByText('Next')); // -> 8
    await waitFor(() => expect(screen.getByText('Step 8 of 9')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Go Live')); // commits, -> 9
    await waitFor(() => expect(screen.getByText('Step 9 of 9')).toBeInTheDocument());
  }

  test('shows Go Live heading and description', async () => {
    await goToStep9();
    expect(screen.getByText('Get your AI receptionist answering real calls.')).toBeInTheDocument();
  });

  test('commits the draft graph exactly once via POST /setup/commit on entering step 9', async () => {
    // WHO: owner who finished setting weekly hours in step 4 and is
    //      progressing through Review → website scan → Teach Your AI → Go Live.
    // WHAT: the transition from step 8 into step 9 must POST /setup/commit
    //      once with the whole draft graph — not the pre-Phase-B per-employee
    //      /shifts/expand-weekly loop, which ran independently of whether
    //      the rest of the entity graph had ever been saved anywhere.
    // WHERE: dashboard/components/SetupWizard/index.tsx goNext().
    await goToStep9();

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const commitCalls = fetchMock.mock.calls.filter((call) => {
      const url = String(call[0] ?? '');
      const init = call[1] as RequestInit | undefined;
      return url.includes('/setup/commit') && init?.method === 'POST';
    });
    expect(commitCalls.length).toBe(1);
    const body = JSON.parse(commitCalls[0][1]!.body as string);
    expect(body.services).toHaveLength(1);
    expect(body.employees).toHaveLength(1);
    // tenant_id must be explicit in the body — requireTenantId() falls back
    // to the JWT's own tenant when it's absent, which is wrong for a
    // super-admin managing a DIFFERENT tenant (found via a real E2E run
    // where a super-admin's wizard commit silently landed in the
    // super-admin's own platform tenant instead of the impersonated one).
    expect(body.tenant_id).toBe('f234e471-0e60-4163-86c9-93cfd9338e3a');
  });

  test('a commit failure blocks the transition and surfaces the error, leaving the draft intact', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (url: string, init?: { method?: string }) => {
        if (url.includes('/setup/commit') && init?.method === 'POST') {
          return Promise.resolve({
            ok: false,
            status: 400,
            json: async () => ({ success: false, error: 'Draft references unknown tmp_ids' }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      }
    );

    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    addEmployee();
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next')); // -> 8
    await waitFor(() => expect(screen.getByText('Step 8 of 9')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Go Live'));

    await waitFor(() => {
      expect(screen.getByText(/Draft references unknown tmp_ids/)).toBeInTheDocument();
    });
    // Stayed on step 8 — nothing advanced, draft (the added service) intact.
    expect(screen.getByText('Step 8 of 9')).toBeInTheDocument();
  });

  test('area code input only accepts digits and max 3 chars', async () => {
    await goToStep9();
    const input = screen.getByPlaceholderText<HTMLInputElement>('e.g. 312');
    fireEvent.change(input, { target: { value: 'abc123xyz' } });
    expect(input.value).toBe('123');
    fireEvent.change(input, { target: { value: '12345' } });
    expect(input.value).toBe('123');
  });

  test('shows skip message', async () => {
    await goToStep9();
    expect(
      screen.getByText('You can skip this step and activate later from Settings.')
    ).toBeInTheDocument();
  });

  test('shows provisioning state when activating', async () => {
    await goToStep9();
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.includes('/provisioning/activate')) {
        return new Promise(() => {}); // never resolves — stuck in provisioning
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    fireEvent.click(screen.getByText('Activate AI Phone Line'));

    await waitFor(() => {
      expect(screen.getByText('Setting up your phone line...')).toBeInTheDocument();
    });
  });

  test('shows success state with phone number after activation', async () => {
    await goToStep9();
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.includes('/provisioning/activate')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            phone_number: '+1 (630) 555-1234',
            assistant_id: 'asst_123',
            phone_number_id: 'pn_456',
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    fireEvent.click(screen.getByText('Activate AI Phone Line'));

    // Activation success lands on Stage B (verify the raw number actually
    // answers) — GoLivePanel never claims "live" before a real call is
    // confirmed. See GoLivePanel.test.tsx for the full stage-by-stage flow.
    //
    // Wait on the DOM outcome, not wall-clock. Default waitFor (1000ms) is
    // what failed once on CI at 1,115ms under load (#362) — same class as the
    // FIND_BUDGET_MS sad-path fix below. findBy* retries until the node
    // appears; the budget is "activation finished", not "machine is fast".
    expect(
      await screen.findByText('Your number is ready', {}, { timeout: 5000 })
    ).toBeInTheDocument();
    expect(await screen.findByText('+1 (630) 555-1234', {}, { timeout: 5000 })).toBeInTheDocument();
  });

  test('shows error state when activation fails', async () => {
    await goToStep9();
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.includes('/provisioning/activate')) {
        return Promise.reject(new Error('Business type not configured'));
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    fireEvent.click(screen.getByText('Activate AI Phone Line'));

    await waitFor(() => {
      expect(screen.getByText('Activation failed')).toBeInTheDocument();
      expect(screen.getByText('Business type not configured')).toBeInTheDocument();
    });
  });

  test('shows already active state when phone is provisioned', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (url: string, init?: { method?: string }) => {
        if (url.includes('/setup/commit') && init?.method === 'POST') {
          return Promise.resolve({ ok: true, json: async () => ({ success: true, counts: {} }) });
        }
        if (url.includes('/provisioning/status')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              phone_status: 'active',
              inbound_phone: '+1 (312) 555-9999',
              telnyx_phone_number_id: 'tnum_abc',
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      }
    );

    await goToStep9();

    // No forwarded_from_phone yet → still Stage B (raw-number verification),
    // not a "live" claim.
    await waitFor(() => {
      expect(screen.getByText('Your number is ready')).toBeInTheDocument();
      expect(screen.getByText('+1 (312) 555-9999')).toBeInTheDocument();
    });
  });

  test('area code is passed to the API', async () => {
    await goToStep9();
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/provisioning/activate')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            phone_number: '+1 (630) 555-0001',
            assistant_id: 'asst_test',
            phone_number_id: 'pn_test',
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    (global.fetch as unknown) = mockFetch;

    const input = screen.getByPlaceholderText<HTMLInputElement>('e.g. 312');
    fireEvent.change(input, { target: { value: '630' } });
    fireEvent.click(screen.getByText('Activate AI Phone Line'));

    await waitFor(() => {
      const activateCall = mockFetch.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === 'string' && call[0].includes('/provisioning/activate')
      );
      expect(activateCall).toBeDefined();
      const body = JSON.parse(activateCall![1]?.body as string);
      expect(body.area_code).toBe('630');
    });
  });

  test('handles status API failure on mount gracefully', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (url: string, init?: { method?: string }) => {
        if (url.includes('/setup/commit') && init?.method === 'POST') {
          return Promise.resolve({ ok: true, json: async () => ({ success: true, counts: {} }) });
        }
        if (url.includes('/provisioning/status')) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      }
    );

    await goToStep9();

    await waitFor(() => {
      expect(screen.getByText('Activate AI Phone Line')).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText('e.g. 312')).toBeInTheDocument();
  });
});

// =============================================================================
// SAD PATH TESTS
// =============================================================================
//
// Phase B removed the entire class of "save failed over the network" sad
// paths for services/resources/employees (and their deletion) — every
// mutation in useWizardCrud is now a synchronous local-array update that
// cannot fail. Those tests (network-failure-during-create, deletion-failure)
// are deleted, not rewritten, per "test it or delete it": there is no
// failure surface left to exercise. What replaces them: the commit-failure
// test above (the one real network call left in the flow), and the
// duplicate-tmp-id / cascade-delete coverage in useWizardCrud.test.ts.

describe('SetupWizard: Sad Paths — Validation (Empty Form Submissions)', () => {
  test('service: empty name and valid duration prevents submission', async () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Add a service'));
    fireEvent.click(screen.getByText('Add Service'));

    await waitFor(() => {
      expect(screen.getByText('Service name is required')).toBeInTheDocument();
    });
    expect(screen.getByText('New Service')).toBeInTheDocument();
  });

  test('service: whitespace-only name is treated as empty', async () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Add a service'));

    fireEvent.change(screen.getByLabelText('Service Name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Add Service'));

    await waitFor(() => {
      expect(screen.getByText('Service name is required')).toBeInTheDocument();
    });
  });

  test('service: negative duration shows validation error', async () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Add a service'));

    fireEvent.change(screen.getByLabelText('Service Name'), { target: { value: 'Haircut' } });
    fireEvent.change(screen.getByDisplayValue('30'), { target: { value: '-5' } });
    fireEvent.click(screen.getByText('Add Service'));

    await waitFor(() => {
      expect(screen.getByText('Duration must be at least 1 minute')).toBeInTheDocument();
    });
  });

  test('resource: empty name prevents submission', async () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Add a resource'));

    fireEvent.click(screen.getByText('Add Resource'));

    await waitFor(() => {
      expect(screen.getByText('Resource name is required')).toBeInTheDocument();
    });
    expect(screen.getByText('New Resource')).toBeInTheDocument();
  });

  test('resource: whitespace-only name is treated as empty', async () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Add a resource'));

    fireEvent.change(screen.getByLabelText('Resource Name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Add Resource'));

    await waitFor(() => {
      expect(screen.getByText('Resource name is required')).toBeInTheDocument();
    });
  });

  test('employee: empty first name prevents submission', async () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Add an employee'));

    fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Doe' } });
    fireEvent.click(screen.getByText('Add Employee'));

    await waitFor(() => {
      expect(screen.getByText('First name is required')).toBeInTheDocument();
    });
    expect(screen.getByText('New Employee')).toBeInTheDocument();
  });

  test('employee: whitespace-only first name is treated as empty', async () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Add an employee'));

    fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('Add Employee'));

    await waitFor(() => {
      expect(screen.getByText('First name is required')).toBeInTheDocument();
    });
  });
});

/**
 * Two timeouts that must NOT be equal.
 *
 * This test failed CI on 2026-09-01 (run 33504352556, Dashboard job) with
 * "Test timed out in 5000ms" — and the component was fine. The inner
 * `findByText` was given a 5000ms budget while vitest's own default test
 * timeout is ALSO 5000ms, so the two raced for the same window: the test spends
 * time in `goToStep9()` first (eight step transitions, each with its own fetch),
 * and whatever is left is less than the 5000ms the inner wait believes it has.
 * On a loaded runner vitest wins the race and kills the test before the wait can
 * report anything useful, so the failure names a timeout instead of naming the
 * missing element.
 *
 * This is the same defect `scripts/purge-soft-deleted.test.ts` documents at
 * length ("Deliberately ABOVE the subprocess budget, not equal to it. If the two
 * match, vitest and spawnSync race on a genuine hang and vitest can win —
 * emitting a bare 'timed out' that names nothing"). Same shape, different pair
 * of clocks.
 *
 * So the outer budget is deliberately well above the inner one. Neither number
 * is an assertion about speed: a genuinely broken component still fails, it just
 * fails with "Unable to find an element with the text: Activation failed", which
 * is the sentence that tells you what actually went wrong.
 */
const FIND_BUDGET_MS = 5_000;
const TEST_TIMEOUT_MS = 20_000;

describe('SetupWizard: Sad Paths — Phone Provisioning Failure', () => {
  async function goToStep9() {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    addEmployee();
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByText('Step 8 of 9')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Go Live'));
    await waitFor(() => expect(screen.getByText('Step 9 of 9')).toBeInTheDocument());
  }

  test('shows error state with descriptive message when activation network fails', async () => {
    await goToStep9();
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.includes('/provisioning/activate')) {
        return Promise.reject(new Error('Connection timed out'));
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    fireEvent.click(screen.getByText('Activate AI Phone Line'));

    await waitFor(() => {
      expect(screen.getByText('Activation failed')).toBeInTheDocument();
      expect(screen.getByText('Connection timed out')).toBeInTheDocument();
    });
  });

  test('activate button is re-enabled after provisioning failure so user can retry', async () => {
    await goToStep9();
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.includes('/provisioning/activate')) {
        return Promise.reject(new Error('Telnyx API error'));
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    fireEvent.click(screen.getByText('Activate AI Phone Line'));

    await waitFor(() => {
      expect(screen.getByText('Activation failed')).toBeInTheDocument();
    });
    expect(screen.getByText('Activate AI Phone Line')).toBeInTheDocument();
  });

  test('skip message is hidden when error is shown', async () => {
    await goToStep9();
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url.includes('/provisioning/activate')) {
        return Promise.reject(new Error('No numbers available'));
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });

    fireEvent.click(screen.getByText('Activate AI Phone Line'));

    await waitFor(() => {
      expect(screen.getByText('Activation failed')).toBeInTheDocument();
    });
    expect(
      screen.queryByText('You can skip this step and activate later from Settings.')
    ).toBeNull();
  });

  test(
    'generic error message used when error is not an Error instance',
    async () => {
      await goToStep9();
      (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: unknown) => {
        const path = typeof url === 'string' ? url : String(url);
        if (path.includes('/provisioning/activate')) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- THE POINT of this sad-path is to exercise the non-Error rejection branch in the production component
          return Promise.reject('string error without Error wrapper');
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      });

      fireEvent.click(screen.getByText('Activate AI Phone Line'));

      // CI runners under load have blown the default 1000ms waitFor here
      // (same class as the recorded SetupWizard flake). The assertion is
      // "the generic copy appeared", not "it appeared in 1s".
      expect(
        await screen.findByText('Activation failed', {}, { timeout: FIND_BUDGET_MS })
      ).toBeInTheDocument();
      expect(screen.getByText('Failed to activate phone')).toBeInTheDocument();
    },
    TEST_TIMEOUT_MS
  );
});

describe('SetupWizard: Sad Paths — Empty Lists / Guards Handled Gracefully', () => {
  test('step 4 (shifts) is unreachable without an employee — Next is a no-op', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next')); // -> 2
    fireEvent.click(screen.getByText('Next')); // -> 3
    fireEvent.click(screen.getByText('Next')); // blocked
    expect(screen.getByText('Step 3 of 9')).toBeInTheDocument();
  });

  test('step 5 (assignments) is unreachable without a service — Next is a no-op from step 1', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Next')); // blocked — no service yet
    expect(screen.getByText('Step 1 of 9')).toBeInTheDocument();
  });
});

describe('SetupWizard: Sad Paths — Navigation After Error', () => {
  test('validation error clears when opening add form again', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Add a service'));
    fireEvent.click(screen.getByText('Add Service'));
    expect(screen.getByText('Service name is required')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('Add a service'));

    expect(screen.queryByText('Service name is required')).toBeNull();
  });

  test('navigating back then forward preserves wizard state without crash', () => {
    render(<SetupWizard isOpen={true} onClose={() => {}} />);
    addService();
    fireEvent.click(screen.getByText('Next')); // -> 2
    fireEvent.click(screen.getByText('Next')); // -> 3
    addEmployee();
    fireEvent.click(screen.getByText('Next')); // -> 4
    expect(screen.getByText('Step 4 of 9')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Back'));
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByText('Step 2 of 9')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Step 4 of 9')).toBeInTheDocument();
    expect(screen.getByText('When does everyone work?')).toBeInTheDocument();
    // The employee added before backing up is still in the draft.
    expect(screen.getByText(/Mike Smith/)).toBeInTheDocument();
  });
});
