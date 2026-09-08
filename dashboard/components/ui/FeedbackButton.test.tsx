/**
 * FeedbackButton — UI coverage for the floating feedback widget.
 *
 * WHO: Any tenant user on any page with the feedback button mounted.
 * WHAT: Collapsed → expanded toggle; star rating; comment + submit.
 * WHERE: components/ui/FeedbackButton.tsx — previously 29.16% coverage.
 * WHY: submit path was completely untested; a broken Api.feedback.submit
 *   call would silently swallow feedback or show no error toast.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('../../lib/SessionContext', () => ({ useActiveTenantId: () => 'tenant-test' }));
vi.mock('./Toast', () => ({ showToast: vi.fn() }));

const { mockApi } = vi.hoisted(() => ({
  mockApi: { feedback: { submit: vi.fn() } },
}));
vi.mock('../../lib/api', () => ({ Api: mockApi }));

import { FeedbackButton } from './FeedbackButton';
import { showToast } from './Toast';

const mockToast = vi.mocked(showToast);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FeedbackButton — collapsed state', () => {
  test('HAPPY: renders the Feedback button label and toggle', () => {
    render(<FeedbackButton page="Skill Map" />);
    expect(screen.getByRole('button', { name: /send feedback/i })).toBeInTheDocument();
    expect(screen.getByText('Feedback')).toBeInTheDocument();
  });

  test('HAPPY: clicking the button expands the form', () => {
    render(<FeedbackButton page="Schedule" />);
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    expect(screen.getByPlaceholderText(/What's working/i)).toBeInTheDocument();
  });
});

describe('FeedbackButton — expanded form', () => {
  function openFeedback(page = 'Test Page') {
    render(<FeedbackButton page={page} />);
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));
  }

  test('HAPPY: page name appears in the form header', () => {
    openFeedback('My Business > Skill Map');
    expect(screen.getByText('My Business > Skill Map')).toBeInTheDocument();
  });

  test('HAPPY: clicking the close button collapses the form', () => {
    openFeedback();
    fireEvent.click(screen.getByRole('button', { name: /close feedback/i }));
    expect(screen.queryByPlaceholderText(/What's working/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send feedback/i })).toBeInTheDocument();
  });

  test('HAPPY: Submit button is disabled when comment is empty', () => {
    openFeedback();
    // "Send Feedback" as button text — distinct from the floating "Feedback" span
    const submitBtn = screen.getByRole('button', { name: /send feedback/i });
    // The submit button inside the form is disabled when comment is empty
    const allButtons = screen.getAllByRole('button');
    const submitButton = allButtons.find(
      (b) =>
        b.textContent?.includes('Send Feedback') && b.getAttribute('aria-label') !== 'Send feedback'
    );
    expect(submitButton).toBeDisabled();
  });

  test('HAPPY: typing in the comment enables Submit', () => {
    openFeedback();
    const textarea = screen.getByRole('textbox', { name: /feedback comment/i });
    fireEvent.change(textarea, { target: { value: 'Great UX!' } });
    const allButtons = screen.getAllByRole('button');
    const submitButton = allButtons.find(
      (b) => b.textContent?.includes('Send Feedback') && !b.hasAttribute('aria-label')
    );
    expect(submitButton).not.toBeDisabled();
  });

  test('HAPPY: star rating buttons toggle on/off', () => {
    openFeedback();
    const star3 = screen.getByRole('radio', { name: '3 stars' });
    fireEvent.click(star3);
    expect(star3).toHaveAttribute('aria-checked', 'true');
    // Click again to deselect
    fireEvent.click(star3);
    expect(star3).toHaveAttribute('aria-checked', 'false');
  });

  test('HAPPY: selecting one star deselects another', () => {
    openFeedback();
    const star2 = screen.getByRole('radio', { name: '2 stars' });
    const star5 = screen.getByRole('radio', { name: '5 stars' });
    fireEvent.click(star2);
    expect(star2).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(star5);
    expect(star5).toHaveAttribute('aria-checked', 'true');
    expect(star2).toHaveAttribute('aria-checked', 'false');
  });
});

describe('FeedbackButton — submit', () => {
  function setup() {
    render(<FeedbackButton page="Home" context="overview" />);
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    const textarea = screen.getByRole('textbox', { name: /feedback comment/i });
    fireEvent.change(textarea, { target: { value: 'Really useful!' } });
    return textarea;
  }

  test('HAPPY: submit calls Api.feedback.submit with correct params', async () => {
    mockApi.feedback.submit.mockResolvedValue({ success: true });
    setup();
    // Click 4 stars
    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }));
    const allButtons = screen.getAllByRole('button');
    const submitBtn = allButtons.find(
      (b) => b.textContent?.includes('Send Feedback') && !b.hasAttribute('aria-label')
    )!;
    fireEvent.click(submitBtn);
    await waitFor(() => expect(mockApi.feedback.submit).toHaveBeenCalledTimes(1));
    expect(mockApi.feedback.submit).toHaveBeenCalledWith('tenant-test', {
      page: 'Home',
      context: 'overview',
      comment: 'Really useful!',
      rating: 4,
    });
  });

  test('HAPPY: successful submit shows a success toast and closes the form', async () => {
    mockApi.feedback.submit.mockResolvedValue({ success: true });
    setup();
    const allButtons = screen.getAllByRole('button');
    const submitBtn = allButtons.find(
      (b) => b.textContent?.includes('Send Feedback') && !b.hasAttribute('aria-label')
    )!;
    fireEvent.click(submitBtn);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Thanks for your feedback!'));
    // Form collapses after success
    expect(screen.queryByPlaceholderText(/What's working/i)).not.toBeInTheDocument();
  });

  test('SAD: failed submit shows an error toast and leaves the form open', async () => {
    // WHO: server-side error (network down, API 500)
    // WHAT: form stays open so the user can retry
    mockApi.feedback.submit.mockRejectedValue(new Error('Network error'));
    setup();
    const allButtons = screen.getAllByRole('button');
    const submitBtn = allButtons.find(
      (b) => b.textContent?.includes('Send Feedback') && !b.hasAttribute('aria-label')
    )!;
    fireEvent.click(submitBtn);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Failed to send feedback', 'error'));
    expect(screen.getByPlaceholderText(/What's working/i)).toBeInTheDocument();
  });
});
