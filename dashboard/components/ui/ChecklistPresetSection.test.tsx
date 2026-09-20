/**
 * Call-checklist settings card.
 *
 * WHO: an owner on Business Settings after picking a business type.
 * WHAT: they see the derived preset + enabled blocks, and can override it.
 * WHEN: after setup, or when the live agent is using the wrong tree set.
 * WHERE: dashboard/components/ui/ChecklistPresetSection.tsx
 * WHY: tenant-config already derives the preset; this is the product surface
 *      so an owner can see and change it without a SQL update.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import ChecklistPresetSection from './ChecklistPresetSection';

const mockGetConfig = vi.fn();
const mockUpdateConfig = vi.fn();
const mockToast = vi.fn();

vi.mock('../../lib/api', () => ({
  Api: {
    tenants: {
      getConfig: (...args: unknown[]) => mockGetConfig(...args),
      updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
    },
  },
}));

vi.mock('./Toast', () => ({ showToast: (...args: unknown[]) => mockToast(...args) }));

const SALON_RUNTIME = {
  preset_id: 'salon_front_desk',
  enabled_conversation_blocks: ['identity', 'booking', 'message', 'qa', 'schedule_change'],
  enabled_policy_blocks: [],
  enabled_knowledge_blocks: [],
  enabled_outcome_blocks: [],
  overrides: {},
  version: 1 as const,
};

beforeEach(() => {
  mockGetConfig.mockReset();
  mockUpdateConfig.mockReset();
  mockToast.mockReset();
  mockGetConfig.mockResolvedValue({
    tenant_id: 't1',
    name: 'Bella',
    business_type: 'salon',
    checklist_preset_id: null,
    checklist_runtime_config: SALON_RUNTIME,
  });
  mockUpdateConfig.mockResolvedValue({ success: true });
});

describe('ChecklistPresetSection', () => {
  test('HAPPY: derived salon preset shows the front-desk blocks', async () => {
    render(<ChecklistPresetSection tenantId="t1" />);
    expect(await screen.findByTestId('checklist-preset-name')).toHaveTextContent(
      'Salon front desk'
    );
    expect(screen.getByText('Book a time')).toBeInTheDocument();
    expect(screen.getByText('Take a message')).toBeInTheDocument();
    expect(screen.getByText(/Derived from business type/)).toBeInTheDocument();
    expect(screen.queryByText('Qualify a buyer / demo')).not.toBeInTheDocument();
  });

  test('HAPPY: saving an explicit override posts checklist_preset_id', async () => {
    mockGetConfig
      .mockResolvedValueOnce({
        tenant_id: 't1',
        business_type: 'salon',
        checklist_preset_id: null,
        checklist_runtime_config: SALON_RUNTIME,
      })
      .mockResolvedValueOnce({
        tenant_id: 't1',
        business_type: 'salon',
        checklist_preset_id: 'local_service_front_desk',
        checklist_runtime_config: {
          ...SALON_RUNTIME,
          preset_id: 'local_service_front_desk',
          enabled_conversation_blocks: [
            'identity',
            'booking',
            'message',
            'generic_subject',
            'qa',
            'buy_service',
            'schedule_change',
          ],
        },
      });

    render(<ChecklistPresetSection tenantId="t1" />);
    await screen.findByText('Salon front desk');
    fireEvent.change(screen.getByLabelText('Preset'), {
      target: { value: 'local_service_front_desk' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save checklist' }));

    await waitFor(() => {
      expect(mockUpdateConfig).toHaveBeenCalledWith('t1', {
        checklist_preset_id: 'local_service_front_desk',
        checklist_overrides: {
          disabled_conversation_blocks: [],
          booking_mode: 'offer_once',
          message_mode: 'always',
          optional_node_ids: [],
          required_node_ids: [],
          wording: {},
        },
      });
    });
    expect(screen.getByTestId('checklist-preset-name')).toHaveTextContent(
      'Local service front desk'
    );
    expect(screen.getByText('Qualify a buyer / demo')).toBeInTheDocument();
  });

  test('SAD: a failed save toasts an error and keeps the prior preset', async () => {
    mockUpdateConfig.mockResolvedValue({ success: false, error: 'Forbidden' });
    render(<ChecklistPresetSection tenantId="t1" />);
    await screen.findByText('Salon front desk');
    fireEvent.change(screen.getByLabelText('Preset'), {
      target: { value: 'auto_shop_front_desk' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save checklist' }));
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('Forbidden', 'error');
    });
    expect(screen.getByLabelText('Preset')).toHaveValue('auto_shop_front_desk');
  });

  test('HAPPY: dry-run preview flips a required field before save', async () => {
    render(<ChecklistPresetSection tenantId="t1" />);
    await screen.findByTestId('checklist-dry-run');
    fireEvent.click(screen.getByRole('button', { name: 'Callback number' }));
    expect(screen.getByTestId('checklist-preview-caller_phone')).toHaveAttribute(
      'data-role',
      'required'
    );
  });

  test('SAD: a failed initial load shows an error, not a fabricated derived preset', async () => {
    // WHO: an owner opening Business Settings on a bad connection.
    // WHAT: getConfig rejects, so `config` stays null. Falling straight
    //       through to the "derived" default preset name would read as this
    //       tenant's real (unconfigured) checklist rather than a load error.
    // WHERE: ChecklistPresetSection's initial fetch effect.
    // WHY: same class of gap as AnalyticsView's AiCostPanel — a real fetch
    //      failure and an honest default must not render identically.
    mockGetConfig.mockRejectedValue(new Error('network error'));
    render(<ChecklistPresetSection tenantId="t1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn.t load the call checklist/);
    expect(screen.getByLabelText('Preset')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save checklist' })).toBeDisabled();
  });

  test('SAD: on a failed load the header says "Checklist unavailable" (not a derived preset name) and every toggle is disabled (review thread)', async () => {
    // WHY: with config null the component falls back to a locally derived
    // preset, so without this the header still showed a real-looking preset
    // name ("Local service front desk") beside the error, and the block /
    // optional / required chips were live even though nothing could be saved.
    mockGetConfig.mockRejectedValue(new Error('network error'));
    render(<ChecklistPresetSection tenantId="t1" />);
    await screen.findByRole('alert');
    const name = screen.getByTestId('checklist-preset-name');
    expect(name).toHaveTextContent('Checklist unavailable');
    expect(name).not.toHaveTextContent(/front desk/i);
    expect(screen.queryByText(/Derived from business type/)).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be edited until it loads/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book a time' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Callback number' })).toBeDisabled();
  });

  test('HAPPY: while loading, the preset name is a polite live-region status', async () => {
    // WHY: the UX pass made the in-flight "Loading…" a role="status" region so a
    // screen-reader user is told something is loading; once loaded the name is
    // plain content, not a live region.
    mockGetConfig.mockReturnValue(new Promise(() => {}));
    render(<ChecklistPresetSection tenantId="t1" />);
    const name = screen.getByTestId('checklist-preset-name');
    expect(name).toHaveTextContent('Loading…');
    expect(name).toHaveAttribute('role', 'status');
    expect(name).toHaveAttribute('aria-live', 'polite');
  });

  test('HAPPY: a successful load shows no error alert and drops the live-region role', async () => {
    // WHY: the load-error alert must appear ONLY on a real failure.
    render(<ChecklistPresetSection tenantId="t1" />);
    const name = await screen.findByTestId('checklist-preset-name');
    await waitFor(() => expect(name).toHaveTextContent('Salon front desk'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(name).not.toHaveAttribute('role');
  });

  test('HAPPY: marking callback number required posts required_node_ids', async () => {
    render(<ChecklistPresetSection tenantId="t1" />);
    await screen.findByText('Salon front desk');
    fireEvent.click(screen.getByRole('button', { name: 'Callback number' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save checklist' }));
    await waitFor(() => {
      expect(mockUpdateConfig).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({
          checklist_overrides: expect.objectContaining({
            required_node_ids: ['caller_phone'],
          }),
        })
      );
    });
  });
});
