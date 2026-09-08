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
