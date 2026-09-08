/**
 * CRMIntegrationCard — OAuth connect/disconnect/sync for a CRM provider.
 *
 * WHO: Tenant owner linking their Square or calendar account.
 * WHAT: Renders Connect button (disconnected) / Connected state; handles
 *   OAuth redirect, manual Sync Now, Disconnect.
 * WHERE: components/CRMIntegrationCard.tsx — 0% coverage.
 * WHY: Connect + disconnect paths were completely untested; a broken getAuthUrl
 *   call would silently fail with no user feedback.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

import { CRMIntegrationCard } from './CRMIntegrationCard';

// Capture original location so afterEach can restore it cleanly.
const origLocation = window.location;

// Provider is passed as a prop — mock the provider methods directly.
function makeProvider(
  overrides: Partial<Parameters<typeof CRMIntegrationCard>[0]['provider']> = {}
) {
  return {
    name: 'Square',
    color: 'green',
    icon: 'S',
    description: 'Sync customers and appointments with Square.',
    getSettings: vi.fn().mockResolvedValue(null),
    getAuthUrl: vi
      .fn()
      .mockResolvedValue({ success: true, authUrl: 'https://square.example.com/oauth' }),
    disconnect: vi.fn().mockResolvedValue({ success: true }),
    triggerSync: vi.fn().mockResolvedValue(undefined),
    connectedParam: 'squareConnected',
    getSyncStatus: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Stub window.location so redirect assertions work in jsdom.
  Object.defineProperty(window, 'location', {
    writable: true,
    configurable: true,
    value: { href: '', search: '', pathname: '/dashboard', hostname: 'localhost' },
  });
});

afterEach(() => {
  // Restore the real location object so this stub doesn't bleed into other test files.
  Object.defineProperty(window, 'location', {
    writable: true,
    configurable: true,
    value: origLocation,
  });
});

describe('CRMIntegrationCard — disconnected state', () => {
  test('HAPPY: renders Connect button when not connected', async () => {
    const provider = makeProvider();
    render(<CRMIntegrationCard provider={provider} tenantId="tenant-test" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /connect square/i })).toBeInTheDocument()
    );
  });

  test('HAPPY: provider name appears in card header', async () => {
    const provider = makeProvider();
    render(<CRMIntegrationCard provider={provider} tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText('Square CRM')).toBeInTheDocument());
  });

  test('HAPPY: provider description appears in card header', async () => {
    const provider = makeProvider();
    render(<CRMIntegrationCard provider={provider} tenantId="tenant-test" />);
    await waitFor(() =>
      expect(screen.getByText(/sync customers and appointments with square/i)).toBeInTheDocument()
    );
  });

  test('HAPPY: clicking Connect calls getAuthUrl and redirects', async () => {
    const provider = makeProvider();
    render(<CRMIntegrationCard provider={provider} tenantId="tenant-test" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /connect square/i })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: /connect square/i }));
    await waitFor(() => expect(provider.getAuthUrl).toHaveBeenCalledWith('tenant-test'));
    await waitFor(() => expect(window.location.href).toBe('https://square.example.com/oauth'));
  });
});

describe('CRMIntegrationCard — connected state', () => {
  function makeConnectedProvider() {
    return makeProvider({
      getSettings: vi.fn().mockResolvedValue({
        last_sync_at: '2026-07-07T10:00:00Z',
      }),
    });
  }

  test('HAPPY: shows Connected badge when settings exist', async () => {
    render(<CRMIntegrationCard provider={makeConnectedProvider()} tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());
  });

  test('HAPPY: shows last synced date when available', async () => {
    render(<CRMIntegrationCard provider={makeConnectedProvider()} tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText(/last synced/i)).toBeInTheDocument());
  });

  test('HAPPY: shows "Not yet synced" when last_sync_at is missing', async () => {
    const provider = makeProvider({ getSettings: vi.fn().mockResolvedValue({}) });
    render(<CRMIntegrationCard provider={provider} tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText(/not yet synced/i)).toBeInTheDocument());
  });

  test('HAPPY: Sync Now button triggers triggerSync then refetches', async () => {
    const provider = makeConnectedProvider();
    render(<CRMIntegrationCard provider={provider} tenantId="tenant-test" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /sync now/i })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(provider.triggerSync).toHaveBeenCalledWith('tenant-test'));
    // After sync, getSettings is called again to refresh the last_sync_at
    await waitFor(() => expect(provider.getSettings).toHaveBeenCalledTimes(2));
  });

  test('HAPPY: Disconnect button calls provider.disconnect and reverts to disconnected', async () => {
    const provider = makeConnectedProvider();
    render(<CRMIntegrationCard provider={provider} tenantId="tenant-test" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /disconnect/i })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await waitFor(() => expect(provider.disconnect).toHaveBeenCalledWith('tenant-test'));
    // Reverts to disconnected → Connect button appears
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /connect square/i })).toBeInTheDocument()
    );
  });
});

describe('CRMIntegrationCard — sync status', () => {
  test('HAPPY: shows pending and error counts when getSyncStatus is provided', async () => {
    const provider = makeProvider({
      getSettings: vi.fn().mockResolvedValue({ last_sync_at: '2026-07-07T10:00:00Z' }),
      getSyncStatus: vi.fn().mockResolvedValue({
        pending_count: 3,
        error_count: 1,
        total_mapped: 42,
      }),
    });
    render(<CRMIntegrationCard provider={provider} tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText(/3 pending/i)).toBeInTheDocument());
    expect(screen.getByText(/1 errors/i)).toBeInTheDocument();
    expect(screen.getByText(/42 mapped/i)).toBeInTheDocument();
  });

  test('HAPPY: handles object total_mapped (customers + appointments)', async () => {
    const provider = makeProvider({
      getSettings: vi.fn().mockResolvedValue({ last_sync_at: '2026-07-07T10:00:00Z' }),
      getSyncStatus: vi.fn().mockResolvedValue({
        pending_count: 0,
        error_count: 0,
        total_mapped: { customers: 10, appointments: 25 },
      }),
    });
    render(<CRMIntegrationCard provider={provider} tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText(/35 mapped/i)).toBeInTheDocument());
  });
});
