/**
 * ServiceAddressCard — the owner's view of where the business uses the service (sales tax).
 *
 * WHO: an owner who signed up before addresses existed, or who moved.
 * WHAT: loads the saved address, validates with the shared validator, saves through
 *   PUT /billing/service-address.
 * WHY: Stripe Tax needs it; with automatic tax on, checkout is refused without one, so this card
 *   is the only way for an older business to reach checkout.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

const { mockApi } = vi.hoisted(() => ({
  mockApi: { billing: { getServiceAddress: vi.fn(), saveServiceAddress: vi.fn() } },
}));
vi.mock('../../lib/api', () => ({ Api: mockApi }));

import { ServiceAddressCard } from './ServiceAddressCard';
import { showToast } from '../ui/Toast';

type AddressRes = {
  address: { street: string | null; city: string | null; state: string | null; zip: string | null };
};
const empty: AddressRes = { address: { street: null, city: null, state: null, zip: null } };
const saved: AddressRes = {
  address: { street: '1 N State St', city: 'Chicago', state: 'IL', zip: '60602' },
};

async function renderLoaded(res = empty, props: { required?: boolean } = {}) {
  mockApi.billing.getServiceAddress.mockResolvedValue(res);
  render(<ServiceAddressCard tenantId="t-1" {...props} />);
  await waitFor(() => expect(screen.getByLabelText('Street address')).not.toBeDisabled());
}

function fill() {
  fireEvent.change(screen.getByLabelText('Street address'), { target: { value: '1 N State St' } });
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Chicago' } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'IL' } });
  fireEvent.change(screen.getByLabelText('Zip code'), { target: { value: '60602' } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ServiceAddressCard', () => {
  test('HAPPY: shows the saved address', async () => {
    await renderLoaded(saved);
    expect(screen.getByLabelText('Street address')).toHaveValue('1 N State St');
    expect(screen.getByLabelText('City')).toHaveValue('Chicago');
    expect(screen.getByLabelText('State')).toHaveValue('IL');
    expect(screen.getByLabelText('Zip code')).toHaveValue('60602');
  });

  test('HAPPY: saves a new address through the API and confirms', async () => {
    mockApi.billing.saveServiceAddress.mockResolvedValue({ success: true });
    await renderLoaded();
    fill();
    fireEvent.click(screen.getByRole('button', { name: /save address/i }));

    await waitFor(() =>
      expect(mockApi.billing.saveServiceAddress).toHaveBeenCalledWith('t-1', {
        street: '1 N State St',
        city: 'Chicago',
        state: 'IL',
        zip: '60602',
      })
    );
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Business address saved.', 'success')
    );
  });

  test('SAD: a bad zip is caught in the card and nothing is sent', async () => {
    await renderLoaded();
    fill();
    fireEvent.change(screen.getByLabelText('Zip code'), { target: { value: '6060' } });
    fireEvent.click(screen.getByRole('button', { name: /save address/i }));

    expect(await screen.findByText('Use a 5-digit zip code, like 60602.')).toBeInTheDocument();
    expect(mockApi.billing.saveServiceAddress).not.toHaveBeenCalled();
  });

  test('SAD: a refusal from the server shows its message and keeps the form', async () => {
    mockApi.billing.saveServiceAddress.mockResolvedValue({
      success: false,
      error: 'Owner access required',
    });
    await renderLoaded();
    fill();
    fireEvent.click(screen.getByRole('button', { name: /save address/i }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Owner access required', 'error'));
    expect(screen.getByLabelText('City')).toHaveValue('Chicago');
  });

  test('SAD: a network failure on save is reported, not swallowed', async () => {
    mockApi.billing.saveServiceAddress.mockRejectedValue(new Error('offline'));
    await renderLoaded();
    fill();
    fireEvent.click(screen.getByRole('button', { name: /save address/i }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Could not save the address — try again.', 'error')
    );
  });

  test('SAD: a failed load is reported', async () => {
    mockApi.billing.getServiceAddress.mockRejectedValue(new Error('boom'));
    render(<ServiceAddressCard tenantId="t-1" />);
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Failed to load your business address', 'error')
    );
  });

  test('HAPPY: when checkout needed the address, an empty card says so', async () => {
    await renderLoaded(empty, { required: true });
    expect(screen.getByRole('alert')).toHaveTextContent(/add your business address/i);
  });

  test('HAPPY: the notice is not shown once an address exists', async () => {
    await renderLoaded(saved, { required: true });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
