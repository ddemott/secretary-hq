/**
 * <ProductTour /> — WHEN the tour runs: once on the Tutorial, on request
 * from anywhere, never on its own for a real tenant.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import type { Config as DriverConfig, Driver } from 'driver.js';

const session = vi.hoisted(() => ({ tenantId: 'tutorial-1' as string | null, role: 'owner' }));
vi.mock('../../lib/SessionContext', () => ({
  useActiveTenantId: () => session.tenantId,
  useSessionContext: () => ({ role: session.role }),
}));

import { ProductTour, AUTO_START_DELAY_MS } from './ProductTour';
import { requestProductTour, tourSeenKey } from '../../lib/productTour';

function fakeFactory() {
  const created: { config: DriverConfig; destroy: ReturnType<typeof vi.fn> }[] = [];
  const factory = vi.fn((config: DriverConfig) => {
    let active = false;
    const destroy = vi.fn(() => {
      active = false;
    });
    created.push({ config, destroy });
    return {
      isActive: () => active,
      getActiveIndex: () => 0,
      drive: () => {
        active = true;
      },
      moveTo: () => {},
      destroy,
    } as unknown as Driver;
  });
  return { factory, created };
}

/** Flush the async runProductTour chain. */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  localStorage.clear();
  session.tenantId = 'tutorial-1';
  session.role = 'owner';
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProductTour — auto-start on the Tutorial', () => {
  test('HAPPY: a Tutorial tenant sees the tour after the settle delay, once', async () => {
    // WHO: a prospect who clicked "Try Tutorial".
    // WHAT: the tour starts on its own, and marks itself seen so a reload
    //       does not replay it.
    localStorage.setItem('tutorialTenantId', 'tutorial-1');
    const { factory } = fakeFactory();
    render(<ProductTour driverFactory={factory} />);
    expect(factory).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(AUTO_START_DELAY_MS);
    });
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(tourSeenKey('tutorial-1'))).toBe('shown');
  });

  test('SAD: a Tutorial tenant that already saw it is not interrupted again', async () => {
    localStorage.setItem('tutorialTenantId', 'tutorial-1');
    localStorage.setItem(tourSeenKey('tutorial-1'), 'shown');
    const { factory } = fakeFactory();
    render(<ProductTour driverFactory={factory} />);
    await act(async () => {
      vi.advanceTimersByTime(AUTO_START_DELAY_MS * 2);
    });
    await flush();
    expect(factory).not.toHaveBeenCalled();
  });

  test('SAD: a real tenant never gets the tour on its own', async () => {
    session.tenantId = 'tenant-real';
    const { factory } = fakeFactory();
    render(<ProductTour driverFactory={factory} />);
    await act(async () => {
      vi.advanceTimersByTime(AUTO_START_DELAY_MS * 2);
    });
    await flush();
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('ProductTour — on request', () => {
  test('HAPPY: the start event runs the tour for a real tenant', async () => {
    // WHO: an owner choosing "Take the product tour" in the account menu.
    session.tenantId = 'tenant-real';
    const { factory } = fakeFactory();
    render(<ProductTour driverFactory={factory} />);
    act(() => requestProductTour());
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('SAD: a second request while the tour is open does not stack a second tour', async () => {
    session.tenantId = 'tenant-real';
    const { factory } = fakeFactory();
    render(<ProductTour driverFactory={factory} />);
    act(() => requestProductTour());
    await flush();
    act(() => requestProductTour());
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test('HAPPY: front desk gets the front-desk step list', async () => {
    session.tenantId = 'tenant-real';
    session.role = 'front_desk';
    const { factory, created } = fakeFactory();
    render(<ProductTour driverFactory={factory} />);
    act(() => requestProductTour());
    await flush();
    const ids = (created[0].config.steps ?? []).map((s) => s.element);
    expect(ids).not.toContain('[data-tour="billing"]');
  });

  test('HAPPY: unmounting mid-tour removes the overlay', async () => {
    // WHY: logging out mid-tour must not strand a dark overlay on the login page.
    session.tenantId = 'tenant-real';
    const { factory, created } = fakeFactory();
    const { unmount } = render(<ProductTour driverFactory={factory} />);
    act(() => requestProductTour());
    await flush();
    unmount();
    expect(created[0].destroy).toHaveBeenCalled();
  });

  test('SAD: after unmount the start event does nothing', async () => {
    session.tenantId = 'tenant-real';
    const { factory } = fakeFactory();
    const { unmount } = render(<ProductTour driverFactory={factory} />);
    unmount();
    act(() => requestProductTour());
    await flush();
    expect(factory).not.toHaveBeenCalled();
  });
});
