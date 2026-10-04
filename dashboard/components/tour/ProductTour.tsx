'use client';

import { useEffect, useRef } from 'react';
import type { Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { useActiveTenantId, useSessionContext } from '../../lib/SessionContext';
import {
  TOUR_START_EVENT,
  markTourSeen,
  runProductTour,
  shouldAutoStart,
  type DriverFactory,
} from '../../lib/productTour';

/** Let Home paint (and the Tutorial banner settle) before the spotlight lands. */
export const AUTO_START_DELAY_MS = 800;

interface ProductTourProps {
  /** Injected for tests; production loads Driver.js on demand. */
  driverFactory?: DriverFactory;
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Mounted once on the dashboard. Renders nothing; it owns WHEN the product
 * tour runs:
 *   - auto-starts once on the public Tutorial (per Tutorial tenant), and
 *   - starts whenever anything dispatches TOUR_START_EVENT (account menu,
 *     first-run welcome card).
 */
export function ProductTour({ driverFactory }: ProductTourProps) {
  const tenantId = useActiveTenantId();
  const { role } = useSessionContext();
  const active = useRef<Driver | null>(null);
  const starting = useRef(false);

  useEffect(() => {
    async function start() {
      if (starting.current || active.current?.isActive()) return;
      starting.current = true;
      markTourSeen(tenantId, safeStorage());
      try {
        active.current = await runProductTour({
          role,
          driverFactory,
          onFinish: () => {
            active.current = null;
          },
        });
      } finally {
        starting.current = false;
      }
    }

    const onRequest = () => void start();
    window.addEventListener(TOUR_START_EVENT, onRequest);

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (shouldAutoStart(tenantId, safeStorage())) {
      timer = setTimeout(() => void start(), AUTO_START_DELAY_MS);
    }

    return () => {
      window.removeEventListener(TOUR_START_EVENT, onRequest);
      if (timer) clearTimeout(timer);
    };
  }, [tenantId, role, driverFactory]);

  // Leaving the dashboard mid-tour must not strand the overlay on the page.
  useEffect(() => () => active.current?.destroy(), []);

  return null;
}
