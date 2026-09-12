import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { Pool } from 'pg';

// registerCalendarRoutes imports `* as gcal` / `* as outlook` directly (not
// injected deps), so the provider modules must be mocked before import.
vi.mock('../../src/services/googleCalendar', () => ({
  isGoogleCalendarEnabled: () => true,
  getAuthUrl: vi.fn(),
  verifyState: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
}));
vi.mock('../../src/services/outlookCalendar', () => ({
  isOutlookCalendarEnabled: () => true,
  getAuthUrl: vi.fn(),
  verifyState: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
}));

import * as gcal from '../../src/services/googleCalendar';
import * as outlook from '../../src/services/outlookCalendar';
import { registerCalendarRoutes } from '../../src/routes/calendar';
import { errorsTotal } from '../../src/services/metrics';

function errorsTotalFor(event: string): number {
  return errorsTotal.snapshot().find((s) => s.labels.event === event)?.value ?? 0;
}

describe('GET /calendar/auth/:provider/callback — OAuth token exchange failure is instrumented', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('SAD: Google token exchange throws — soft redirect, but errors_total bumps', async () => {
    // WHO: platform operator watching /metrics, not the owner mid-OAuth-flow
    // WHAT: exchangeCodeForTokens rejects (provider outage / revoked grant);
    //       the route must still redirect (never 500 an OAuth callback) AND
    //       count the failure — same sad-path-instrumentation gap as billing
    //       (#422) and record-consent (#423)
    // WHY: a systematically-failing calendar connect is invisible today — the
    //      owner just sees ?calendarError=token_exchange_failed once and gives
    //      up; nothing tells the platform this is happening across tenants
    vi.mocked(gcal.verifyState).mockReturnValue('11111111-1111-1111-8111-111111111111');
    vi.mocked(gcal.exchangeCodeForTokens).mockRejectedValue(new Error('invalid_grant'));

    const app = Fastify({ logger: false });
    registerCalendarRoutes(
      app,
      {} as Pool,
      async () => {
        throw new Error('withTenantClient not used by this route');
      }
    );
    await app.ready();

    try {
      const before = errorsTotalFor('calendar_oauth_failed');
      const res = await app.inject({
        method: 'GET',
        url: '/calendar/auth/google/callback?code=abc&state=xyz',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendarError=token_exchange_failed');
      expect(errorsTotalFor('calendar_oauth_failed')).toBe(before + 1);
    } finally {
      await app.close();
    }
  });

  it('SAD: Outlook token exchange throws — soft redirect, but errors_total bumps', async () => {
    vi.mocked(outlook.verifyState).mockReturnValue('11111111-1111-1111-8111-111111111111');
    vi.mocked(outlook.exchangeCodeForTokens).mockRejectedValue(new Error('invalid_grant'));

    const app = Fastify({ logger: false });
    registerCalendarRoutes(
      app,
      {} as Pool,
      async () => {
        throw new Error('withTenantClient not used by this route');
      }
    );
    await app.ready();

    try {
      const before = errorsTotalFor('calendar_oauth_failed');
      const res = await app.inject({
        method: 'GET',
        url: '/calendar/auth/outlook/callback?code=abc&state=xyz',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('calendarError=token_exchange_failed');
      expect(errorsTotalFor('calendar_oauth_failed')).toBe(before + 1);
    } finally {
      await app.close();
    }
  });
});
