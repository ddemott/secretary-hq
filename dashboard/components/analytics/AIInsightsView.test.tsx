/**
 * AIInsightsView tests — pins the Phone Assistant sub-tab (AI Persona /
 * Knowledge Base) URL persistence added when the view moved onto the shared
 * useUrlQueryState hook (docs/IMPROVEMENT_IDEAS.md).
 *
 * What we test:
 *   1. Default render → AI Persona (no ?aiTab).
 *   2. Deep-link ?aiTab=knowledge → Knowledge Base.
 *   3. Clicking a tab updates the rendered child AND writes ?aiTab.
 *   4. popstate (browser back/forward) re-syncs the rendered tab.
 *
 * Children (AIConfigView, KnowledgeBaseView) are mocked to thin markers so the
 * tab wiring is the only thing under test.
 *
 * 5W context on each test.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

vi.mock('../aiconfig/AIConfigView', () => ({
  default: () => <div data-testid="persona-marker">persona</div>,
}));
vi.mock('../knowledge/KnowledgeBaseView', () => ({
  default: () => <div data-testid="knowledge-marker">knowledge</div>,
}));

import AIInsightsView from './AIInsightsView';

beforeEach(() => {
  window.history.replaceState({}, '', '/dashboard');
});

describe('AIInsightsView — sub-tab URL persistence', () => {
  test('HAPPY: default render shows AI Persona (no ?aiTab)', () => {
    // WHO: owner opening Phone Assistant with no deep-link.
    // WHY: persona is the default landing sub-tab.
    render(<AIInsightsView />);
    expect(screen.getByTestId('persona-marker')).toBeInTheDocument();
    expect(screen.queryByTestId('knowledge-marker')).not.toBeInTheDocument();
  });

  test('HAPPY: ?aiTab=knowledge deep-links straight to Knowledge Base', () => {
    // WHO: owner following a shared link to the Knowledge Base sub-tab.
    window.history.replaceState({}, '', '/dashboard?aiTab=knowledge');
    render(<AIInsightsView />);
    expect(screen.getByTestId('knowledge-marker')).toBeInTheDocument();
  });

  test('HAPPY: clicking Knowledge Base switches the child AND writes ?aiTab=knowledge', () => {
    // WHY: the selection must be shareable/reload-safe, so the click has to
    // mirror to the URL (persona is stripped; knowledge is written).
    render(<AIInsightsView />);
    fireEvent.click(screen.getByRole('tab', { name: /knowledge base/i }));
    expect(screen.getByTestId('knowledge-marker')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('aiTab')).toBe('knowledge');

    fireEvent.click(screen.getByRole('tab', { name: /ai persona/i }));
    // persona is the default → the param is stripped, not left as ?aiTab=persona.
    expect(new URLSearchParams(window.location.search).has('aiTab')).toBe(false);
  });

  test('HAPPY: popstate (browser back/forward) re-syncs the rendered sub-tab', () => {
    // WHO: owner who deep-linked to knowledge then hit Back.
    window.history.replaceState({}, '', '/dashboard?aiTab=knowledge');
    render(<AIInsightsView />);
    expect(screen.getByTestId('knowledge-marker')).toBeInTheDocument();

    act(() => {
      window.history.replaceState({}, '', '/dashboard');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByTestId('persona-marker')).toBeInTheDocument();
    expect(screen.queryByTestId('knowledge-marker')).not.toBeInTheDocument();
  });
});

describe('AIInsightsView — subdirectory pin', () => {
  test('page.tsx imports AIInsightsView from components/analytics/', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const page = fs.readFileSync(
      path.join(__dirname, '..', '..', 'app', 'dashboard', 'page.tsx'),
      'utf-8'
    );
    expect(page).toContain("import('@/components/analytics/AIInsightsView')");
    expect(page).not.toContain("import('@/components/AIInsightsView')");
  });
});
