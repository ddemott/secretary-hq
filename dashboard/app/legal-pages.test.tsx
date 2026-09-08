/**
 * WHO: a visitor who clicked Privacy / Terms / DPA in the footer.
 * WHAT: each public legal route renders the published template + our cover.
 * WHEN: unauthenticated GET.
 * WHERE: dashboard/app/{privacy,terms,dpa}/page.tsx
 * WHY: footer already linked /privacy and /terms; those routes 404'd. The
 *      pages must exist and name Bonterms so we did not invent ToS/DPA text.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';
import PrivacyPage from './privacy/page';
import TermsPage from './terms/page';
import DpaPage from './dpa/page';

describe('public legal pages', () => {
  it('privacy names the controller and the AI call-handling section', () => {
    render(<PrivacyPage />);
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
    expect(screen.getAllByText(/Thinking Hammer LLC/).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: /AI call handling/i })).toBeInTheDocument();
    expect(screen.getByText(/never voiceprints/i)).toBeInTheDocument();
  });

  it('terms incorporate Bonterms Online Cloud Terms by reference', () => {
    render(<TermsPage />);
    expect(screen.getByRole('heading', { name: 'Terms of Service' })).toBeInTheDocument();
    const bonterms = screen.getByRole('link', { name: /Bonterms Standard Online Cloud Terms/i });
    expect(bonterms).toHaveAttribute('href', 'https://bonterms.com/standard/online-cloud-terms');
    expect(screen.getByText(/No HIPAA/i)).toBeInTheDocument();
  });

  it('dpa is a Bonterms v2.0 cover with a subprocessor list', () => {
    render(<DpaPage />);
    expect(screen.getByRole('heading', { name: 'Data Protection Addendum' })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Bonterms Data Protection Addendum Version 2.0/i })
    ).toHaveAttribute('href', 'https://bonterms.com/standard/dpa-v2-cover-page-version');
    expect(screen.getByText(/Deepgram/)).toBeInTheDocument();
    expect(screen.getByText(/OpenAI/)).toBeInTheDocument();
  });
});
