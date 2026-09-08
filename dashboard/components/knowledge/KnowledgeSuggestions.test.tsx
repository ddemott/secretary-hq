/**
 * KnowledgeSuggestions — website-extracted Q&A pending review.
 *
 * WHO: Tenant owner reviewing AI knowledge suggestions from a website scan.
 * WHAT: Loads suggestions, approve → adds to KB, reject → discards.
 * WHERE: components/KnowledgeSuggestions.tsx — 1.96% coverage.
 * WHY: Approve/reject paths were untested; a broken approveSuggestion call
 *   would leave the UI stuck in a loading state with no feedback.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    knowledge: {
      suggestions: vi.fn(),
      approveSuggestion: vi.fn(),
      rejectSuggestion: vi.fn(),
    },
  },
}));
vi.mock('../../lib/api', () => ({ Api: mockApi }));

import { KnowledgeSuggestions } from './KnowledgeSuggestions';

const SAMPLE_SUGGESTIONS = [
  {
    id: 'sug-1',
    question: 'What are your hours?',
    answer: 'We are open 9am-5pm weekdays.',
    source_url: 'https://example.com/about',
    confidence: 0.92,
    created_at: '2026-07-07T10:00:00Z',
  },
  {
    id: 'sug-2',
    question: 'Do you offer free estimates?',
    answer: 'Yes, free estimates on all work.',
    source_url: null,
    confidence: null,
    created_at: '2026-07-07T10:01:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.knowledge.suggestions.mockResolvedValue({
    success: true,
    suggestions: SAMPLE_SUGGESTIONS,
  });
});

describe('KnowledgeSuggestions — loading / error / empty states', () => {
  test('HAPPY: shows loading spinner while fetching', () => {
    // Never resolves during this test
    mockApi.knowledge.suggestions.mockReturnValue(new Promise(() => {}));
    render(<KnowledgeSuggestions tenantId="tenant-test" />);
    expect(screen.getByText(/loading suggestions/i)).toBeInTheDocument();
  });

  test('HAPPY: shows empty state when no suggestions pending', async () => {
    mockApi.knowledge.suggestions.mockResolvedValue({ success: true, suggestions: [] });
    render(<KnowledgeSuggestions tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText(/no pending suggestions/i)).toBeInTheDocument());
  });

  test('SAD: API error shows error message', async () => {
    mockApi.knowledge.suggestions.mockResolvedValue({ success: false });
    render(<KnowledgeSuggestions tenantId="tenant-test" />);
    await waitFor(() =>
      expect(screen.getByText(/failed to load suggestions/i)).toBeInTheDocument()
    );
  });

  test('SAD: network throw shows error message', async () => {
    mockApi.knowledge.suggestions.mockRejectedValue(new Error('Network error'));
    render(<KnowledgeSuggestions tenantId="tenant-test" />);
    await waitFor(() =>
      expect(screen.getByText(/failed to load suggestions/i)).toBeInTheDocument()
    );
  });

  test('HAPPY: null tenantId shows empty state and reports count=0', async () => {
    const onCountChange = vi.fn();
    render(<KnowledgeSuggestions tenantId={null} onCountChange={onCountChange} />);
    await waitFor(() => expect(screen.getByText(/no pending suggestions/i)).toBeInTheDocument());
    expect(onCountChange).toHaveBeenCalledWith(0);
    expect(mockApi.knowledge.suggestions).not.toHaveBeenCalled();
  });
});

describe('KnowledgeSuggestions — suggestion cards', () => {
  test('HAPPY: renders suggestion question and answer', async () => {
    render(<KnowledgeSuggestions tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText('What are your hours?')).toBeInTheDocument());
    expect(screen.getByText('We are open 9am-5pm weekdays.')).toBeInTheDocument();
  });

  test('HAPPY: shows source URL when present', async () => {
    render(<KnowledgeSuggestions tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText('https://example.com/about')).toBeInTheDocument());
  });

  test('HAPPY: shows confidence percentage when present', async () => {
    render(<KnowledgeSuggestions tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText(/confidence: 92%/i)).toBeInTheDocument());
  });

  test('HAPPY: reports suggestion count to onCountChange', async () => {
    const onCountChange = vi.fn();
    render(<KnowledgeSuggestions tenantId="tenant-test" onCountChange={onCountChange} />);
    await waitFor(() => expect(onCountChange).toHaveBeenCalledWith(2));
  });
});

describe('KnowledgeSuggestions — approve flow', () => {
  test('HAPPY: clicking Add calls approveSuggestion and removes card', async () => {
    mockApi.knowledge.approveSuggestion.mockResolvedValue({ success: true });
    render(<KnowledgeSuggestions tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText('What are your hours?')).toBeInTheDocument());

    // Each suggestion has an "Add" button
    const addButtons = screen.getAllByRole('button', { name: /add/i });
    fireEvent.click(addButtons[0]);

    await waitFor(() =>
      expect(mockApi.knowledge.approveSuggestion).toHaveBeenCalledWith('sug-1', 'tenant-test')
    );
    // Card removed from list
    await waitFor(() => expect(screen.queryByText('What are your hours?')).not.toBeInTheDocument());
  });
});

describe('KnowledgeSuggestions — reject flow', () => {
  test('HAPPY: clicking Discard calls rejectSuggestion and removes card', async () => {
    mockApi.knowledge.rejectSuggestion.mockResolvedValue({ success: true });
    render(<KnowledgeSuggestions tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText('What are your hours?')).toBeInTheDocument());

    const discardButtons = screen.getAllByRole('button', { name: /discard/i });
    fireEvent.click(discardButtons[0]);

    await waitFor(() =>
      expect(mockApi.knowledge.rejectSuggestion).toHaveBeenCalledWith('sug-1', 'tenant-test')
    );
    await waitFor(() => expect(screen.queryByText('What are your hours?')).not.toBeInTheDocument());
  });

  test('SAD: failed reject leaves card in list so user can retry', async () => {
    mockApi.knowledge.rejectSuggestion.mockRejectedValue(new Error('Server error'));
    render(<KnowledgeSuggestions tenantId="tenant-test" />);
    await waitFor(() => expect(screen.getByText('What are your hours?')).toBeInTheDocument());

    const discardButtons = screen.getAllByRole('button', { name: /discard/i });
    fireEvent.click(discardButtons[0]);

    await waitFor(() => expect(mockApi.knowledge.rejectSuggestion).toHaveBeenCalledTimes(1));
    // Card stays in the list
    expect(screen.getByText('What are your hours?')).toBeInTheDocument();
  });
});
