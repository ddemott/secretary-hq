/**
 * KnowledgeBaseView — questionnaire prefill + provenance badge.
 *
 * REGRESSION GUARD for the "from your website" provenance work: scanned answers
 * are saved with source='website-scan' (was 'policy-questionnaire'). The prefill
 * map must accept BOTH sources — otherwise a website-scanned answer would stop
 * pre-filling the questions step, breaking onboarding. This test renders the
 * view with one of each source and asserts both pre-fill, and that the
 * website-sourced one shows the distinct "From your website" marker.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

const mockTenantId = 'test-tenant-kb';
vi.mock('../../lib/SessionContext', () => ({
  useActiveTenantId: () => mockTenantId,
}));

const mockList = vi.fn();
const mockSuggestions = vi.fn();
const mockImportWebsite = vi.fn();
const mockAdd = vi.fn();
vi.mock('../../lib/api', () => ({
  Api: {
    knowledge: {
      list: (...a: unknown[]) => mockList(...a),
      suggestions: (...a: unknown[]) => mockSuggestions(...a),
      importWebsite: (...a: unknown[]) => mockImportWebsite(...a),
      add: (...a: unknown[]) => mockAdd(...a),
    },
  },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../lib/useConfirm', () => ({
  useConfirm: () => ({ confirm: vi.fn(), closeConfirm: vi.fn(), confirmState: { isOpen: false } }),
}));

import { fireEvent } from '@testing-library/react';
import KnowledgeBaseView from './KnowledgeBaseView';

// Both questions are in the first category ("Business Hours & Location"), which
// renders open by default — so both textareas are present without expanding.
const Q_MANUAL = 'What are your hours of operation?';
const Q_SCANNED = 'Where are you located?';

beforeEach(() => {
  mockImportWebsite.mockReset();
  mockAdd.mockReset().mockResolvedValue({ success: true, tenant_doc_id: 'doc-new' });
  mockSuggestions.mockResolvedValue({ success: true, suggestions: [] });
  mockList.mockReset().mockResolvedValue([
    {
      tenant_doc_id: 'doc-manual',
      tenant_id: mockTenantId,
      title: Q_MANUAL,
      content: `Q: ${Q_MANUAL}\nA: Open Mon–Fri 9 to 5.`,
      source: 'policy-questionnaire',
      created_at: '2026-06-01T00:00:00Z',
    },
    {
      tenant_doc_id: 'doc-scanned',
      tenant_id: mockTenantId,
      title: Q_SCANNED,
      content: `Q: ${Q_SCANNED}\nA: 123 Main Street.`,
      source: 'website-scan',
      created_at: '2026-06-01T00:00:00Z',
    },
  ]);
});

describe('KnowledgeBaseView prefill + provenance', () => {
  test('HAPPY: both policy-questionnaire AND website-scan answers pre-fill', async () => {
    // WHO: an owner who ran the website scan during onboarding, now on the KB tab
    // WHAT: the questionnaire pre-fills from BOTH source values
    // WHEN: KnowledgeBaseView mounts and loads saved tenant_docs
    // WHERE: KnowledgeBaseView fetchDocs() prefill loop (accepts both sources)
    // WHY: the regression — widening the scan source to 'website-scan' must not
    //      stop scanned answers from pre-filling the questions step (onboarding).
    render(<KnowledgeBaseView />);
    // Manual answer pre-fills (baseline behavior).
    await waitFor(() =>
      expect(screen.getByDisplayValue('Open Mon–Fri 9 to 5.')).toBeInTheDocument()
    );
    // Website-scanned answer ALSO pre-fills (the guard).
    expect(screen.getByDisplayValue('123 Main Street.')).toBeInTheDocument();
  });

  test('HAPPY: website-scanned answer shows "From your website"; manual shows "Answered"', async () => {
    // WHO: the same owner reviewing pre-filled answers
    // WHAT: the scan-sourced row shows a "From your website" marker; the manual
    //       row shows "Answered"
    // WHEN: after the prefill load resolves
    // WHERE: PolicyQuestionField marker block (fromWebsite branch)
    // WHY: the provenance feature — the owner can tell scan-sourced answers apart
    //      from ones they typed, so they know what to double-check.
    render(<KnowledgeBaseView />);
    await waitFor(() => expect(screen.getByText('From your website')).toBeInTheDocument());
    expect(screen.getByText('Answered')).toBeInTheDocument();
  });
});

describe('KnowledgeBaseView website re-scan', () => {
  // WHO: an owner who already onboarded and wants to re-scan an updated site.
  // WHAT: the "Import policies from your website" box (previously an unwired
  //       placeholder) actually calls the scan + saves the extracted answers.
  // WHEN: 2026-09-13, wiring the TODO left in place since the initial ship.
  // WHERE: KnowledgeBaseView handleWebsiteScan.
  // WHY: the box told owners a real feature existed; it did nothing.
  test('HAPPY: scanning a URL saves matched answers and refreshes the list', async () => {
    mockImportWebsite.mockResolvedValue({
      success: true,
      extracted: [
        {
          questionId: 'business-location',
          question: 'Where are you located?',
          answer: '456 Oak Ave.',
        },
      ],
    });

    render(<KnowledgeBaseView />);
    await waitFor(() => expect(mockList).toHaveBeenCalled());

    const input = screen.getByPlaceholderText('https://www.yourbusiness.com');
    fireEvent.change(input, { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /scan website/i }));

    await waitFor(() =>
      expect(mockImportWebsite).toHaveBeenCalledWith(mockTenantId, 'https://example.com')
    );
    await waitFor(() =>
      expect(mockAdd).toHaveBeenCalledWith(mockTenantId, {
        question: 'Where are you located?',
        answer: '456 Oak Ave.',
        category: 'Business Hours & Location',
        source: 'website-scan',
      })
    );
    // Refetches the doc list after saving so the questionnaire tab reflects it.
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/saved 1 answer/i)).toBeInTheDocument());
  });

  test('SAD: a failed scan shows an error and never calls add', async () => {
    mockImportWebsite.mockResolvedValue({ success: false, error: 'Could not reach that site.' });

    render(<KnowledgeBaseView />);
    await waitFor(() => expect(mockList).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText('https://www.yourbusiness.com'), {
      target: { value: 'https://dead-site.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: /scan website/i }));

    await waitFor(() => expect(screen.getByText('Could not reach that site.')).toBeInTheDocument());
    expect(mockAdd).not.toHaveBeenCalled();
  });
});
