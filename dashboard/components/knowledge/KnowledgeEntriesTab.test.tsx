/**
 * KnowledgeEntriesTab — knowledge starters copied from the business's template.
 *
 * WHY: a starter is not read to callers until the owner saves it (copies
 * arrive without an embedding). The owner has to be able to see which
 * answers are still switched off, or they will assume the AI already knows.
 */
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { KnowledgeEntriesTab } from './KnowledgeEntriesTab';
import type { KnowledgeEntry } from '../../lib/types';

function entry(over: Partial<KnowledgeEntry>): KnowledgeEntry {
  return {
    tenant_doc_id: over.tenant_doc_id ?? 'd1',
    title: 'Do you take walk-ins?',
    section: null,
    content: 'We take walk-ins when a chair is open.',
    source: 'template',
    created_at: '2026-09-25T00:00:00Z',
    ...over,
  };
}

function renderTab(docs: KnowledgeEntry[]) {
  render(
    <KnowledgeEntriesTab
      filteredDocs={docs}
      searchTerm=""
      onSearchChange={vi.fn()}
      onDelete={vi.fn()}
    />
  );
}

describe('KnowledgeEntriesTab — template starters', () => {
  test('HAPPY: an unsaved starter is labelled Starter and marked as not used yet', () => {
    renderTab([entry({ is_unreviewed_starter: true })]);
    expect(screen.getByText('Starter')).toBeInTheDocument();
    expect(screen.getByText(/not used yet/i)).toBeInTheDocument();
  });

  test('HAPPY: once the owner has saved it, the warning goes away', () => {
    renderTab([entry({ is_unreviewed_starter: false })]);
    expect(screen.getByText('Starter')).toBeInTheDocument();
    expect(screen.queryByText(/not used yet/i)).toBeNull();
  });

  test('SAD: an ordinary entry never shows the warning', () => {
    renderTab([entry({ source: 'website-scan', is_unreviewed_starter: undefined })]);
    expect(screen.getByText('From website')).toBeInTheDocument();
    expect(screen.queryByText(/not used yet/i)).toBeNull();
  });
});
