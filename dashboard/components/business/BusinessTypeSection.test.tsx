/**
 * BusinessTypeSection — the owner's current business type on Business Settings.
 *
 * WHO:   an owner opening Business Settings
 * WHAT:  loading / loaded / not-set / load-FAILED states of the current label
 * WHEN:  on mount and whenever the tenant changes
 * WHERE: dashboard/components/business/BusinessTypeSection.tsx
 * WHY:   a failed getConfig() left `config` null — the same value an honestly
 *        unconfigured tenant has — so it rendered "Not set" with a live
 *        "Change business type…" button, indistinguishable from a real blank.
 *        The UX pass added a distinct error state. These tests pin the four
 *        states apart so an error can never again impersonate "Not set".
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import BusinessTypeSection from './BusinessTypeSection';

const mockGetConfig = vi.fn();
const mockListFull = vi.fn();

vi.mock('../../lib/api', () => ({
  Api: {
    tenants: { getConfig: (...a: unknown[]) => mockGetConfig(...a) },
    templates: { listFull: (...a: unknown[]) => mockListFull(...a) },
  },
}));
vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/VocabularyContext', () => ({ useVocabularyRefresh: () => () => {} }));

const TEMPLATE = {
  business_type: 'salon',
  display_name: 'Hair Salon',
  category: 'Beauty',
  system_prompt_template: 'x',
  first_message: 'x',
  voice_id: 'x',
  default_resource_name: 'Chair',
  default_resource_description: 'x',
};

const changeBtn = () => screen.getByRole('button', { name: 'Change business type…' });
const ERROR_TEXT = "Couldn't load your business type";

beforeEach(() => {
  mockGetConfig.mockReset();
  mockListFull.mockReset();
});

describe('BusinessTypeSection states', () => {
  test('HAPPY: shows the configured template name, its category, and no alert', async () => {
    mockGetConfig.mockResolvedValue({ tenant_id: 't1', business_type: 'salon' });
    mockListFull.mockResolvedValue([TEMPLATE]);
    render(<BusinessTypeSection tenantId="t1" />);
    expect(await screen.findByText('Hair Salon')).toBeInTheDocument();
    expect(screen.getByText('Beauty')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(changeBtn()).toBeEnabled();
  });

  test('HAPPY: while loading, announces a status and disables the picker', () => {
    mockGetConfig.mockReturnValue(new Promise(() => {}));
    mockListFull.mockReturnValue(new Promise(() => {}));
    render(<BusinessTypeSection tenantId="t1" />);
    const loading = screen.getByText('Loading…');
    expect(loading).toHaveAttribute('role', 'status');
    expect(loading).toHaveAttribute('aria-live', 'polite');
    expect(changeBtn()).toBeDisabled();
  });

  test('HAPPY: an honestly unconfigured tenant shows "Not set" and NO error', async () => {
    // WHY: the error state must not swallow the real empty state.
    mockGetConfig.mockResolvedValue({ tenant_id: 't1', business_type: null });
    mockListFull.mockResolvedValue([TEMPLATE]);
    render(<BusinessTypeSection tenantId="t1" />);
    expect(await screen.findByText('Not set')).toBeInTheDocument();
    expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('SAD: a failed config fetch shows an alert (not "Not set") and disables the picker', async () => {
    mockGetConfig.mockRejectedValue(new Error('network error'));
    mockListFull.mockResolvedValue([TEMPLATE]);
    render(<BusinessTypeSection tenantId="t1" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ERROR_TEXT);
    expect(alert).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByText('Not set')).not.toBeInTheDocument();
    // Templates loaded fine, so the button would otherwise be live — the error
    // alone must disable it (pickers act on a config we could not read).
    expect(changeBtn()).toBeDisabled();
  });

  test('SAD: a failed template fetch (Promise.all rejects) is also a load error', async () => {
    mockGetConfig.mockResolvedValue({ tenant_id: 't1', business_type: 'salon' });
    mockListFull.mockRejectedValue(new Error('templates down'));
    render(<BusinessTypeSection tenantId="t1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(ERROR_TEXT);
    expect(changeBtn()).toBeDisabled();
  });

  test('SAD: no tenant id makes no request and shows no error', () => {
    render(<BusinessTypeSection tenantId={null} />);
    expect(mockGetConfig).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('HAPPY: switching tenants clears a previous error once the new load succeeds', async () => {
    mockGetConfig.mockRejectedValueOnce(new Error('blip'));
    mockListFull.mockResolvedValue([TEMPLATE]);
    const { rerender } = render(<BusinessTypeSection tenantId="t1" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    mockGetConfig.mockResolvedValue({ tenant_id: 't2', business_type: 'salon' });
    rerender(<BusinessTypeSection tenantId="t2" />);
    expect(await screen.findByText('Hair Salon')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
