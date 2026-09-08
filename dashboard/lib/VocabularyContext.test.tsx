/**
 * VocabularyContext — unit coverage for provider + hooks.
 *
 * WHO: Dashboard components reading tenant-specific labels (e.g. "Bay" vs "Resource").
 * WHAT: VocabularyProvider fetches from Api.vocabulary.get() and exposes via
 *   useVocabulary(); useVocabularyRefresh() triggers a re-fetch.
 * WHERE: lib/VocabularyContext.tsx — previously 13.04% coverage.
 * WHY: Untested API fetch path means a broken vocabulary endpoint silently
 *   falls through to defaults with no test catching it.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { VocabularyProvider, useVocabulary, useVocabularyRefresh } from './VocabularyContext';

// Api.vocabulary.get is the only external dep
const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    vocabulary: {
      get: vi.fn(),
    },
  },
}));
vi.mock('./api', () => ({ Api: mockApi }));

// useSessionContext provides the tenant + managedTenant IDs
const { sessionRef } = vi.hoisted(() => ({
  sessionRef: {
    current: { tenantId: null as string | null, managedTenantId: null as string | null },
  },
}));
vi.mock('./SessionContext', () => ({
  useSessionContext: () => sessionRef.current,
}));

const REMOTE_VOCAB = {
  resource_label: 'Bay',
  resource_plural: 'Bays',
  employee_label: 'Technician',
  employee_plural: 'Technicians',
  booking_label: 'Job',
  example_services: ['Oil Change', 'Tire Rotation'],
  example_resources: ['Bay 1', 'Bay 2'],
};

function Consumer() {
  const vocab = useVocabulary();
  return (
    <div>
      <span data-testid="resource-label">{vocab.resource_label}</span>
      <span data-testid="employee-label">{vocab.employee_label}</span>
      <span data-testid="booking-label">{vocab.booking_label}</span>
      <span data-testid="example-count">{vocab.example_services.length}</span>
    </div>
  );
}

function RefreshConsumer() {
  const refresh = useVocabularyRefresh();
  const vocab = useVocabulary();
  return (
    <div>
      <span data-testid="resource-label">{vocab.resource_label}</span>
      <button onClick={refresh}>Refresh</button>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionRef.current = {
    tenantId: 'tenant-a' as string | null,
    managedTenantId: null as string | null,
  };
});

describe('VocabularyProvider — fetch on mount', () => {
  test('HAPPY: renders defaults immediately before fetch completes', () => {
    // WHO: first render before API resolves
    // WHAT: component shows fallback labels ("Resource", "Employee", "Appointment")
    // WHY: avoids flash of empty labels on slow connections
    mockApi.vocabulary.get.mockImplementation(() => new Promise(() => {})); // never resolves
    render(
      <VocabularyProvider>
        <Consumer />
      </VocabularyProvider>
    );
    expect(screen.getByTestId('resource-label').textContent).toBe('Resource');
    expect(screen.getByTestId('employee-label').textContent).toBe('Employee');
    expect(screen.getByTestId('booking-label').textContent).toBe('Appointment');
  });

  test('HAPPY: updates labels after API resolves', async () => {
    // WHO: tenant with a custom vocabulary set (automotive shop)
    // WHAT: labels switch from defaults to the fetched values
    // WHY: tenant-specific labels are the whole point of the context
    mockApi.vocabulary.get.mockResolvedValue(REMOTE_VOCAB);
    render(
      <VocabularyProvider>
        <Consumer />
      </VocabularyProvider>
    );
    await waitFor(() => expect(screen.getByTestId('resource-label').textContent).toBe('Bay'));
    expect(screen.getByTestId('employee-label').textContent).toBe('Technician');
    expect(screen.getByTestId('booking-label').textContent).toBe('Job');
    expect(screen.getByTestId('example-count').textContent).toBe('2');
  });

  test('HAPPY: calls Api.vocabulary.get with the active tenant id', async () => {
    mockApi.vocabulary.get.mockResolvedValue(REMOTE_VOCAB);
    render(
      <VocabularyProvider>
        <Consumer />
      </VocabularyProvider>
    );
    await waitFor(() => expect(mockApi.vocabulary.get).toHaveBeenCalledWith('tenant-a'));
  });

  test('HAPPY: uses managedTenantId when set (super-admin impersonating a tenant)', async () => {
    // WHO: super-admin viewing another tenant's dashboard
    // WHY: managedTenantId takes priority over tenantId for super-admin flows
    sessionRef.current = { tenantId: 'admin-tenant', managedTenantId: 'managed-tenant' };
    mockApi.vocabulary.get.mockResolvedValue(REMOTE_VOCAB);
    render(
      <VocabularyProvider>
        <Consumer />
      </VocabularyProvider>
    );
    await waitFor(() => expect(mockApi.vocabulary.get).toHaveBeenCalledWith('managed-tenant'));
    expect(mockApi.vocabulary.get).not.toHaveBeenCalledWith('admin-tenant');
  });
});

describe('VocabularyProvider — no tenant', () => {
  test('HAPPY: returns defaults when tenantId is null and makes no API call', () => {
    // WHO: unauthenticated user or page load before session resolves
    // WHY: no tenant → no fetch → show generic defaults
    sessionRef.current = { tenantId: null, managedTenantId: null };
    render(
      <VocabularyProvider>
        <Consumer />
      </VocabularyProvider>
    );
    expect(screen.getByTestId('resource-label').textContent).toBe('Resource');
    expect(mockApi.vocabulary.get).not.toHaveBeenCalled();
  });
});

describe('VocabularyProvider — error handling', () => {
  test('SAD: falls back to defaults on API error', async () => {
    // WHO: tenant with a broken vocabulary endpoint
    // WHAT: error caught, defaults shown, no crash
    // WHY: the provider must never throw — it's mounted at the app root
    mockApi.vocabulary.get.mockRejectedValue(new Error('Network error'));
    render(
      <VocabularyProvider>
        <Consumer />
      </VocabularyProvider>
    );
    // After rejection, defaults should still be in place
    await waitFor(() => expect(mockApi.vocabulary.get).toHaveBeenCalled());
    expect(screen.getByTestId('resource-label').textContent).toBe('Resource');
  });

  test('SAD: falls back individual fields to defaults when API returns partial data', async () => {
    // WHO: API returns a partial response (missing some fields)
    // WHY: null/undefined fields should degrade to the default string not "null"
    mockApi.vocabulary.get.mockResolvedValue({
      resource_label: null,
      resource_plural: '',
      employee_label: 'Stylist',
      employee_plural: null,
      booking_label: null,
      example_services: null,
      example_resources: undefined,
    });
    render(
      <VocabularyProvider>
        <Consumer />
      </VocabularyProvider>
    );
    await waitFor(() => expect(screen.getByTestId('employee-label').textContent).toBe('Stylist'));
    // null/falsy fields fall back to defaults
    expect(screen.getByTestId('resource-label').textContent).toBe('Resource');
    expect(screen.getByTestId('booking-label').textContent).toBe('Appointment');
    expect(screen.getByTestId('example-count').textContent).toBe('0');
  });
});

describe('useVocabularyRefresh()', () => {
  test('HAPPY: triggers a re-fetch when called', async () => {
    // WHO: a component that saves a new business type and wants fresh vocab
    // WHAT: clicking refresh increments the version → useEffect re-runs → new fetch
    mockApi.vocabulary.get
      .mockResolvedValueOnce(REMOTE_VOCAB)
      .mockResolvedValueOnce({ ...REMOTE_VOCAB, resource_label: 'Room' });

    const { getByText } = render(
      <VocabularyProvider>
        <RefreshConsumer />
      </VocabularyProvider>
    );
    await waitFor(() => expect(screen.getByTestId('resource-label').textContent).toBe('Bay'));
    act(() => {
      getByText('Refresh').click();
    });
    await waitFor(() => expect(screen.getByTestId('resource-label').textContent).toBe('Room'));
    expect(mockApi.vocabulary.get).toHaveBeenCalledTimes(2);
  });
});
