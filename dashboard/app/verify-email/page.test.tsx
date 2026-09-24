/**
 * /verify-email — landing page for the signup verification link.
 * WHO: a new owner clicking the link we emailed at signup.
 * WHY: until this succeeds, checkout (the trial and the phone line) is refused.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('@/lib/api', () => ({ API_BASE_URL: 'http://test' }));

let mockSearchParams = new URLSearchParams('token=abc123abc123abc123abc123');

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

import VerifyEmailPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockSearchParams = new URLSearchParams('token=abc123abc123abc123abc123');
  global.fetch = vi.fn();
});

describe('VerifyEmailPage', () => {
  test('HAPPY: confirms automatically on load, marks the browser verified, links to Billing', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true }),
    });
    localStorage.setItem('emailVerified', 'false');

    render(<VerifyEmailPage />);

    expect(await screen.findByText(/your email is confirmed/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to billing/i })).toHaveAttribute(
      'href',
      '/dashboard?tab=setup&subtab=billing'
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://test/verify-email',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'abc123abc123abc123abc123' }),
      })
    );
    expect(localStorage.getItem('emailVerified')).toBe('true');
  });

  test('SAD: an expired or used link shows the server message and how to get a new one', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ success: false, error: 'This link is invalid or has expired' }),
    });

    render(<VerifyEmailPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/invalid or has expired/i);
    expect(alert).toHaveTextContent(/resend email/i);
    expect(localStorage.getItem('emailVerified')).toBeNull();
  });

  test('SAD: a link with no token never calls the API', () => {
    mockSearchParams = new URLSearchParams('');
    render(<VerifyEmailPage />);
    expect(screen.getByRole('alert')).toHaveTextContent(/missing its code/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('SAD: a network failure says so plainly', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('Failed to fetch'));
    render(<VerifyEmailPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't connect/i);
  });
});
