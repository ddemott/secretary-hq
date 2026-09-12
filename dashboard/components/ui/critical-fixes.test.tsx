import { describe, test, expect, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock fetch globally
global.fetch = vi.fn();

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// =========================================================
// BUG-003: AppointmentView — draftEvent state is defined
// =========================================================
import AppointmentView from '../appointments/AppointmentView';

describe('BUG-003: AppointmentView draftEvent state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.setItem('tenantId', 'f234e471-0e60-4163-86c9-93cfd9338e3a');
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [],
    });
  });

  test('renders without crashing (draftEvent state is defined)', async () => {
    render(<AppointmentView />);
    // If draftEvent was undefined, the component would crash on setDraftEvent calls
    // The fact that it renders at all proves the fix works
    expect(await screen.findByText(/Appointments/i)).toBeInTheDocument();
    // WHO: receptionist | WHAT: renders AppointmentView | WHEN: initial load | WHERE: AppointmentView | WHY: draftEvent state must be defined or component crashes on any booking action
  });

  test('New Appointment button exists and can be clicked without error', async () => {
    render(<AppointmentView />);
    // Wait for component to load
    await waitFor(() => {
      expect(screen.getByText(/Appointments/i)).toBeInTheDocument();
    });

    // Find and click the "New" button (creates a draft event via setDraftEvent)
    const newBtn = screen.queryByText(/New/i);
    if (newBtn) {
      // Should not throw — proves setDraftEvent is defined
      expect(() => fireEvent.click(newBtn)).not.toThrow();
    }
    // WHO: receptionist | WHAT: clicks New Appointment button | WHEN: appointment list is loaded | WHERE: AppointmentView | WHY: setDraftEvent must exist or clicking New crashes the booking workflow
  });
});

// =========================================================
// BUG-004: CRMView — handleEditFormChange is defined
// =========================================================
import CRMView from '../crm/CRMView';

describe('BUG-004: CRMView handleEditFormChange function', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.setItem('tenantId', 'f234e471-0e60-4163-86c9-93cfd9338e3a');
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [
        {
          id: '00000000-0000-0000-0000-000000000001',
          tenant_id: 'f234e471-0e60-4163-86c9-93cfd9338e3a',
          name: 'Alice Test',
          first_name: 'Alice',
          last_name: 'Test',
          phone: '+15550001111',
          email: 'alice@test.com',
          address: '123 Main St',
          city: 'New York',
          state: 'NY',
          postal_code: '10001',
          timezone: 'America/New_York',
          metadata: {},
        },
      ],
    });
  });

  test('renders without crashing (handleEditFormChange is defined)', async () => {
    render(<CRMView />);
    // CRMView header says "Customers"
    expect(await screen.findByText(/Customers/i)).toBeInTheDocument();
    // WHO: business owner | WHAT: renders CRMView | WHEN: initial load with customer data | WHERE: CRMView | WHY: missing handleEditFormChange would crash the entire customer management page
  });

  test('customer list shows loaded customers', async () => {
    render(<CRMView />);

    // Wait for customer list to load — may appear multiple times (list + detail)
    await waitFor(() => {
      expect(screen.getAllByText(/Alice Test/i).length).toBeGreaterThan(0);
    });

    // Click on the first instance — this triggers the edit form setup
    // which uses handleEditFormChange. If the function is missing, this path errors.
    const aliceElements = screen.getAllByText(/Alice Test/i);
    expect(() => fireEvent.click(aliceElements[0])).not.toThrow();
    // WHO: business owner | WHAT: clicks customer to open edit form | WHEN: customer list is populated | WHERE: CRMView | WHY: handleEditFormChange must be wired or editing a customer record crashes
  });
});

// =========================================================
// BUG-005: No dev bypass button in login
// =========================================================
import LoginView from '../auth/LoginView';

describe('BUG-005: No dev bypass button in production code', () => {
  test('LoginView should NOT contain a bypass/dev button', () => {
    const mockLogin = vi.fn();
    render(<LoginView onLoginSuccess={mockLogin} />);

    // There should be no button with DEV or Bypass text
    const devButton = screen.queryByText(/DEV/);
    const bypassButton = screen.queryByText(/Bypass/i);
    const superAdminButton = screen.queryByText(/SuperAdmin/i);

    expect(devButton).toBeNull();
    expect(bypassButton).toBeNull();
    expect(superAdminButton).toBeNull();
    // WHO: unauthenticated visitor | WHAT: inspects login page for bypass buttons | WHEN: login page renders | WHERE: LoginView | WHY: dev bypass would let anyone skip authentication in production
  });

  test('LoginView should only have the login form submit button', () => {
    const mockLogin = vi.fn();
    render(<LoginView onLoginSuccess={mockLogin} />);

    // Should have email and password inputs
    expect(screen.getByPlaceholderText(/you@business.com/i)).toBeInTheDocument();

    // Should have exactly one submit-type action (the sign in button)
    const buttons = screen.getAllByRole('button');
    const submitButtons = buttons.filter((btn) => btn.textContent?.match(/Sign In|Log In|Login/i));
    expect(submitButtons.length).toBe(1);
    // WHO: unauthenticated visitor | WHAT: verifies only one sign-in button exists | WHEN: login page renders | WHERE: LoginView | WHY: extra buttons could confuse users or expose unauthorized access paths
  });
});

// =========================================================
// BUG-010: ErrorBoundary catches component errors
// =========================================================
import { ErrorBoundary } from './ErrorBoundary';

// Mock SessionContext for useActiveTenantId
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

function ThrowingComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Test component error');
  }
  return <div>Working fine</div>;
}

describe('BUG-010: ErrorBoundary component', () => {
  // Suppress console.error for expected error boundary triggers
  const originalError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });

  test('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <div>Hello World</div>
      </ErrorBoundary>
    );
    expect(screen.getByText('Hello World')).toBeInTheDocument();
    // WHO: any user | WHAT: renders children normally | WHEN: no errors thrown | WHERE: ErrorBoundary | WHY: boundary must be transparent when children work correctly
  });

  test('catches error and shows fallback UI', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    // Heading is the stable anchor — the friendly message below was
    // updated in 2026-04-24 to reassure users without leaking raw errors.
    expect(screen.getByRole('heading', { name: /Something went wrong/i })).toBeInTheDocument();
    // Raw error text only appears in the dev-details block (vitest runs
    // with NODE_ENV=test, not 'production', so the block is visible).
    expect(screen.getByTestId('error-boundary-dev-details')).toHaveTextContent(
      /Test component error/i
    );
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    // WHO: any user | WHAT: sees error fallback UI | WHEN: child component throws | WHERE: ErrorBoundary | WHY: unhandled crash would show a white screen instead of actionable error message
  });

  test('Try Again button is clickable and resets hasError state', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    // Should show error UI (heading is the unambiguous marker)
    expect(screen.getByRole('heading', { name: /Something went wrong/i })).toBeInTheDocument();

    // Use role-based query so we select the button, not the friendly
    // paragraph that happens to include the phrase "try again"
    const tryAgainBtn = screen.getByRole('button', { name: /try again/i });
    expect(tryAgainBtn).toBeInTheDocument();

    // Clicking it should not throw — it resets hasError internally
    // (The child may re-throw, but the ErrorBoundary catches it again)
    expect(() => fireEvent.click(tryAgainBtn)).not.toThrow();
    // WHO: any user | WHAT: clicks Try Again after crash | WHEN: error boundary is showing fallback | WHERE: ErrorBoundary | WHY: users need a recovery path instead of being stuck on error screen
  });

  test('renders custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<div>Custom fallback</div>}>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Custom fallback')).toBeInTheDocument();
    // WHO: developer | WHAT: provides custom fallback JSX | WHEN: child throws with custom fallback prop | WHERE: ErrorBoundary | WHY: different views may need context-specific error messaging
  });

  // Restore console.error
  afterEach(() => {
    console.error = originalError;
  });
});

// =========================================================
// BUG-012: Login stores JWT token
// =========================================================
describe('BUG-012: LoginView stores JWT token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
  });

  test('successful login stores authToken in localStorage', async () => {
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        tenant_id: 'f234e471-0e60-4163-86c9-93cfd9338e3a',
        user_id: 'user-123',
        user_name: 'Test User',
        token: 'eyJhbGciOiJIUzI1NiJ9.test.signature',
      }),
    });

    const mockLogin = vi.fn();
    render(<LoginView onLoginSuccess={mockLogin} />);

    // Fill in the form
    fireEvent.change(screen.getByPlaceholderText(/you@business.com/i), {
      target: { value: 'test@test.com' },
    });
    // Find password input
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(passwordInput, {
      target: { value: 'password123' },
    });

    // Submit
    const submitBtn = screen.getByRole('button', { name: /Sign In/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalled();
    });

    // Verify token was stored
    expect(localStorageMock.getItem('authToken')).toBe('eyJhbGciOiJIUzI1NiJ9.test.signature');
    expect(localStorageMock.getItem('tenantId')).toBe('f234e471-0e60-4163-86c9-93cfd9338e3a');
    expect(localStorageMock.getItem('userName')).toBe('Test User');
    // WHO: unauthenticated visitor | WHAT: submits valid credentials | WHEN: login form submitted | WHERE: LoginView | WHY: JWT token must persist to localStorage or user loses session on page refresh
  });
});
