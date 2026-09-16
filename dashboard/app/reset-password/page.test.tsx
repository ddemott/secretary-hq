/**
 * reset-password page — UX-review a11y pass.
 *
 * Pins the fix: the New password + Confirm password inputs are now
 * programmatically associated with their labels (were adjacent labels with no
 * htmlFor/id), so getByLabelText resolves each — screen-reader operable.
 *
 * 5W for failures: WHO a user completing a reset link; WHAT the two password
 * fields; WHERE reset-password/page.tsx; WHY unlabeled password fields are
 * unusable with assistive tech.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('@/lib/api', () => ({ API_BASE_URL: 'http://test' }));

const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams('token=abc123');

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
}));

import ResetPasswordPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  mockSearchParams = new URLSearchParams('token=abc123');
  global.fetch = vi.fn();
});

describe('ResetPasswordPage a11y', () => {
  test('both password inputs are reachable by their labels', () => {
    render(<ResetPasswordPage />);
    expect(screen.getByLabelText('New password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('type', 'password');
  });

  test('HAPPY: submit button carries aria-busy while the reset request is in flight', async () => {
    // WHO: Screen-reader user submitting a valid reset link
    // WHY: same reasoning as LoginView/forgot-password — aria-busy is the
    //       explicit signal for assistive tech
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        })
    );
    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'newpass1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'newpass1' },
    });
    const btn = screen.getByRole('button', { name: /reset password/i });
    expect(btn).toHaveAttribute('aria-busy', 'false');

    fireEvent.click(btn);

    expect(await screen.findByText(/resetting/i)).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-busy', 'true');
  });

  test('SAD: with no token, the disabled fields and Reset button are wired via aria-describedby to the reason, plus a direct link to request a new one', () => {
    // WHO: A caller who opened an old, already-consumed, or hand-truncated
    //       reset link — the page mounts with no `token` query param
    // WHAT: Both password inputs and the submit button are disabled with no
    //       visible reason of their own; the only explanation lives in the
    //       alert box above the form. Wire it via aria-describedby (same
    //       pattern as AIConfigView's Save-button fix, PR #492) so the reason
    //       is reachable from the control itself, and add a direct link to
    //       request a new one instead of making the caller navigate back to
    //       login and click "Forgot password?" again from scratch.
    // WHY: "disabled with no visible reason" and "no guidance where a sibling
    //       flow (forgot-password's success screen) gives a clear next step"
    //       are exactly the owner-judgment defects this pass targets.
    mockSearchParams = new URLSearchParams('');
    render(<ResetPasswordPage />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/missing reset token/i);
    expect(alert.id).toBe('reset-password-error');

    const newPassword = screen.getByLabelText('New password');
    const confirmPassword = screen.getByLabelText('Confirm password');
    const submit = screen.getByRole('button', { name: /reset password/i });

    expect(newPassword).toBeDisabled();
    expect(confirmPassword).toBeDisabled();
    expect(submit).toBeDisabled();
    expect(newPassword).toHaveAttribute('aria-describedby', 'reset-password-error');
    expect(confirmPassword).toHaveAttribute('aria-describedby', 'reset-password-error');
    expect(submit).toHaveAttribute('aria-describedby', 'reset-password-error');

    const requestNewLink = screen.getByRole('link', { name: /request a new reset link/i });
    expect(requestNewLink).toHaveAttribute('href', '/forgot-password');
  });

  test('HAPPY: with a valid token, no describedby/link noise is added', () => {
    // WHY: the aria-describedby + "request a new link" affordance is only
    //       correct when the token is actually missing — asserting its
    //       absence in the happy path prevents it from leaking into the
    //       normal flow, where it would just be confusing
    render(<ResetPasswordPage />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /request a new reset link/i })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('New password')).not.toHaveAttribute('aria-describedby');
  });

  test('SAD: a rate-limited reset attempt shows the wait time, not the bare HTTP reason phrase', async () => {
    // WHO: A caller who has already retried the reset form 5 times in 15
    //       minutes (this route's own rate limit)
    // WHAT: /reset-password answers 429 with @fastify/rate-limit's own error
    //        shape (`error` = generic reason phrase, `message` = the actual
    //        wait time). Showing only `error` gave no indication of how long
    //        to wait.
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 429,
      json: () =>
        Promise.resolve({
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'Rate limit exceeded, retry in 10 minutes',
        }),
    });
    render(<ResetPasswordPage />);
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'newpass1' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'newpass1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/retry in 10 minutes/i);
    expect(alert).not.toHaveTextContent(/^too many requests$/i);
  });
});
