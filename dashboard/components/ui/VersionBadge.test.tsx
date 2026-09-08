/**
 * VersionBadge — build-stamp in the bottom-right corner.
 *
 * WHO: Anyone looking at the deployed dashboard to verify which version is live.
 * WHAT: Hidden by default (env var gate); renders sha+version+time when enabled.
 * WHERE: components/ui/VersionBadge.tsx — 0% coverage.
 * WHY: The component previously had no tests; the env-var gate and the
 *   deterministic ISO-slice format (no toLocaleString) were untested.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';
import { VersionBadge } from './VersionBadge';

const ORIG_ENV: Record<string, string | undefined> = {};
const KEYS = [
  'NEXT_PUBLIC_SHOW_VERSION_BADGE',
  'NEXT_PUBLIC_APP_VERSION',
  'NEXT_PUBLIC_BUILD_SHA',
  'NEXT_PUBLIC_BUILD_TIME',
];

beforeEach(() => {
  KEYS.forEach((k) => {
    ORIG_ENV[k] = process.env[k];
  });
  // Reset to default hidden state before each test
  KEYS.forEach((k) => {
    delete process.env[k];
  });
});

afterEach(() => {
  KEYS.forEach((k) => {
    if (ORIG_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG_ENV[k];
  });
});

describe('VersionBadge — hidden by default', () => {
  test('HAPPY: returns null when NEXT_PUBLIC_SHOW_VERSION_BADGE is not set', () => {
    const { container } = render(<VersionBadge />);
    expect(container.firstChild).toBeNull();
  });

  test('HAPPY: returns null when NEXT_PUBLIC_SHOW_VERSION_BADGE is "false"', () => {
    process.env.NEXT_PUBLIC_SHOW_VERSION_BADGE = 'false';
    const { container } = render(<VersionBadge />);
    expect(container.firstChild).toBeNull();
  });
});

describe('VersionBadge — visible when enabled', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SHOW_VERSION_BADGE = 'true';
    process.env.NEXT_PUBLIC_APP_VERSION = '1.2.3';
    process.env.NEXT_PUBLIC_BUILD_SHA = 'abc1234';
    process.env.NEXT_PUBLIC_BUILD_TIME = '2026-07-07T12:00:42.123Z';
  });

  test('HAPPY: renders the version badge element', () => {
    render(<VersionBadge />);
    expect(screen.getByTestId('version-badge')).toBeInTheDocument();
  });

  test('HAPPY: label includes version, sha, and truncated UTC time', () => {
    render(<VersionBadge />);
    const badge = screen.getByTestId('version-badge');
    expect(badge).toHaveTextContent('v1.2.3');
    expect(badge).toHaveTextContent('abc1234');
    // ISO slice: "2026-07-07T12:00" with T→space + "Z" suffix
    expect(badge).toHaveTextContent('2026-07-07 12:00Z');
  });

  test('HAPPY: title attribute contains the sha and full build time', () => {
    render(<VersionBadge />);
    const badge = screen.getByTestId('version-badge');
    expect(badge).toHaveAttribute('title', expect.stringContaining('abc1234'));
    expect(badge).toHaveAttribute('title', expect.stringContaining('2026-07-07T12:00:42.123Z'));
  });

  test('HAPPY: falls back gracefully when env vars are missing', () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.NEXT_PUBLIC_BUILD_SHA;
    delete process.env.NEXT_PUBLIC_BUILD_TIME;
    render(<VersionBadge />);
    const badge = screen.getByTestId('version-badge');
    expect(badge).toHaveTextContent('v0.0.0');
    expect(badge).toHaveTextContent('dev');
  });
});
