/**
 * /consent page — the admin-provisioned-tenant consent-invite confirmation
 * page. Standalone public page (no SessionContext/login dependency), same
 * shape as /reset-password.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('@/lib/api', () => ({ API_BASE_URL: 'http://test' }));

let mockSearchParams = new URLSearchParams('token=abc123');

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

import ConsentPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  mockSearchParams = new URLSearchParams('token=abc123');
  global.fetch = vi.fn();
});

describe('ConsentPage', () => {
  test('HAPPY: shows the attestation copy and a single explicit confirm action, not a dismissible checkbox', () => {
    render(<ConsentPage />);
    expect(screen.getByText(/authorized to set up secretary hq/i)).toBeInTheDocument();
    expect(screen.getByText(/responsible for informing my callers/i)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /confirm and unlock my dashboard/i });
    expect(btn).toBeInTheDocument();
    // Not a checkbox anywhere on the initial screen.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  test('HAPPY: confirming with a valid token shows the business name and a link to /login', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, business_name: 'Sharp Salon' }),
    });
    render(<ConsentPage />);

    fireEvent.click(screen.getByRole('button', { name: /confirm and unlock my dashboard/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/sharp salon is confirmed/i);
    expect(screen.getByRole('link', { name: /go to login/i })).toHaveAttribute('href', '/login');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://test/consent/confirm',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'abc123' }),
      })
    );
  });

  test('SAD: an invalid/expired token shows an error and a resend form', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ success: false, error: 'This link is invalid or has expired' }),
    });
    render(<ConsentPage />);

    fireEvent.click(screen.getByRole('button', { name: /confirm and unlock my dashboard/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/invalid or has expired/i);

    expect(screen.getByRole('button', { name: /resend confirmation email/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
  });

  test('SAD: with no token, an error is shown and no confirm attempt is made', () => {
    mockSearchParams = new URLSearchParams('');
    render(<ConsentPage />);

    expect(screen.getByRole('alert')).toHaveTextContent(/missing confirmation token/i);
    expect(screen.getByRole('button', { name: /confirm and unlock my dashboard/i })).toBeDisabled();
  });

  test('HAPPY: resend form posts to /consent/resend and always shows the same generic confirmation', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({ success: false, error: 'This link is invalid or has expired' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });
    render(<ConsentPage />);

    fireEvent.click(screen.getByRole('button', { name: /confirm and unlock my dashboard/i }));
    await screen.findByRole('alert');

    fireEvent.change(screen.getByLabelText(/^email$/i), {
      target: { value: 'owner@business.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'pass123' } });
    fireEvent.click(screen.getByRole('button', { name: /resend confirmation email/i }));

    const confirmation = await screen.findByText(/a new link was just emailed/i);
    expect(confirmation).toBeInTheDocument();

    expect(global.fetch).toHaveBeenLastCalledWith(
      'http://test/consent/resend',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'owner@business.com', password: 'pass123' }),
      })
    );
  });
});
