/**
 * forgot-password page — UX-review a11y pass.
 *
 * Pins the fix: the Email input is now programmatically associated with its
 * label (was an adjacent label with no htmlFor/id), so getByLabelText resolves
 * it — a screen reader announces the field and clicking the label focuses it.
 *
 * 5W for failures: WHO a locked-out owner; WHAT the reset-request form; WHERE
 * forgot-password/page.tsx; WHY an unlabeled email field is unusable with a
 * screen reader.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('@/lib/api', () => ({ API_BASE_URL: 'http://test' }));

import ForgotPasswordPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn();
});

describe('ForgotPasswordPage a11y', () => {
  test('the email input is reachable by its label', () => {
    render(<ForgotPasswordPage />);
    const input = screen.getByLabelText('Email');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'email');
    expect(input).toHaveAttribute('autoComplete', 'email');
  });

  test('HAPPY: submit button carries aria-busy while the request is in flight', async () => {
    // WHO: Screen-reader user submitting the forgot-password form
    // WHY: same reasoning as LoginView — aria-busy is the explicit signal for
    //       assistive tech, independent of the visible "Sending..." label
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        })
    );
    render(<ForgotPasswordPage />);
    const btn = screen.getByRole('button', { name: /send reset link/i });
    expect(btn).toHaveAttribute('aria-busy', 'false');

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.com' } });
    fireEvent.click(btn);

    expect(await screen.findByText(/sending/i)).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });
});

describe('ForgotPasswordPage rate-limit copy', () => {
  test("SAD: a rate-limited request shows the plugin's actual wait time, not the bare HTTP reason phrase", async () => {
    // WHO: An owner who has already requested 3 reset links this hour (the
    //       route's own rate limit)
    // WHAT: /forgot-password answers 429 with @fastify/rate-limit's own error
    //        shape — `error: "Too Many Requests"` (generic reason phrase) and
    //        `message: "Rate limit exceeded, retry in 42 minutes"` (the useful
    //        part). Showing only `error` left the caller with no idea how
    //        long to wait — a blocked form with no explanation.
    // WHY: don't discard the response field that actually answers the question
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 429,
      json: () =>
        Promise.resolve({
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'Rate limit exceeded, retry in 42 minutes',
        }),
    });
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send reset link/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/retry in 42 minutes/i);
    expect(alert).not.toHaveTextContent(/^too many requests$/i);
  });
});
