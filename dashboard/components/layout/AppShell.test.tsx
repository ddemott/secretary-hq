/**
 * AppShell — cross-app launcher bar.
 *
 * The critical property is prod-safety: with no apps service configured
 * (NEXT_PUBLIC_APPS_API_URL unset — the default, including prod until the
 * multi-app portal ships), the bar must render NOTHING rather than an empty
 * "My Apps" strip from a failed fetch. Happy + sad with 5W diagnostics.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('AppShell', () => {
  test('SAD: renders nothing when no apps service is configured', async () => {
    // WHO: any dashboard page in an env without the apps portal (incl. prod today)
    // WHAT: AppShell returns null instead of an empty "My Apps" bar
    // WHY: a hardcoded/missing endpoint must not leave a broken empty strip on screen
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_APPS_API_URL', '');
    const { AppShell } = await import('./AppShell');
    const { container } = render(<AppShell currentAppId="secretary-hq" />);
    expect(container).toBeEmptyDOMElement();
  });

  test('HAPPY: renders app tabs when the apps service returns apps', async () => {
    // WHO: a dashboard running alongside the configured multi-app portal
    // WHAT: each app from the service renders as a tab; the current app is marked
    // WHY: the cross-app launcher is the point — it must list the federated apps
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_APPS_API_URL', 'http://apps.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => [
          { id: 'secretary-hq', name: 'Secretary', description: 'd', url: '/', icon: 'phone' },
          {
            id: 'my-accountant',
            name: 'MyAccountant',
            description: 'd',
            url: '/acct',
            icon: 'calculator',
          },
        ],
      }))
    );
    const { AppShell } = await import('./AppShell');
    render(<AppShell currentAppId="secretary-hq" />);
    await waitFor(() => expect(screen.getByText('MyAccountant')).toBeInTheDocument());
    expect(screen.getByText('Secretary')).toBeInTheDocument();
  });

  test('SAD: renders nothing when the apps service returns an empty list', async () => {
    // WHAT: configured endpoint but zero apps → still no empty bar
    // WHY: an empty portal response must not render a brandstrip with no tabs
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_APPS_API_URL', 'http://apps.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => [] }))
    );
    const { AppShell } = await import('./AppShell');
    const { container } = render(<AppShell currentAppId="secretary-hq" />);
    // microtask flush for the fetch().then to settle
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
