/**
 * Happy + sad path tests for the shared token management module.
 *
 * Tests cover:
 * - getIntegrationTokens: valid tokens, expired token refresh, inactive integration,
 *   missing tokens, missing row, refresh failure marking inactive, extra columns
 * - syncCtx: log prefix formatting
 * - TOKEN_BUFFER_MS: constant values
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getIntegrationTokens,
  syncCtx,
  TOKEN_BUFFER_MS,
  type SyncLogger,
} from '../../src/services/tokenManagement';

import { createMockClient, createMockPool } from '../mock';
import { errorsTotal } from '../../src/services/metrics';

function errorsTotalFor(event: string): number {
  return errorsTotal.snapshot().find((s) => s.labels.event === event)?.value ?? 0;
}

// ── Mock helpers ─────────────────────────────────────────────────────

function makeSilentLogger(): SyncLogger & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
}

const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeTokenRow(overrides: Record<string, any> = {}) {
  return {
    access_token: 'valid-access-token',
    refresh_token: 'valid-refresh-token',
    token_expires_at: new Date(Date.now() + 3600_000).toISOString(), // 1h from now
    is_active: true,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

// ═══════════════════════════════════════════════════════════════════════
// syncCtx
// ═══════════════════════════════════════════════════════════════════════

describe('syncCtx — log prefix helper', () => {
  it('happy: formats prefix with provider and tenant', () => {
    expect(syncCtx('jobber', TENANT_ID)).toBe(`[jobber-sync] tenant=${TENANT_ID}`);
  });

  it('happy: includes entity and action when provided', () => {
    expect(syncCtx('hubspot', TENANT_ID, 'customer', 'create')).toBe(
      `[hubspot-sync] tenant=${TENANT_ID} entity=customer action=create`
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TOKEN_BUFFER_MS
// ═══════════════════════════════════════════════════════════════════════

describe('TOKEN_BUFFER_MS constants', () => {
  it('STANDARD is 5 minutes', () => {
    expect(TOKEN_BUFFER_MS.STANDARD).toBe(5 * 60 * 1000);
  });

  it('SQUARE is 24 hours', () => {
    expect(TOKEN_BUFFER_MS.SQUARE).toBe(24 * 60 * 60 * 1000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getIntegrationTokens — HAPPY PATHS
// ═══════════════════════════════════════════════════════════════════════

describe('getIntegrationTokens — happy paths', () => {
  it('returns valid tokens when not expired', async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);
    const logger = makeSilentLogger();

    queryResponses.push({ rows: [makeTokenRow()] });

    const refreshFn = vi.fn();
    const result = await getIntegrationTokens(
      pool,
      TENANT_ID,
      'jobber',
      refreshFn,
      TOKEN_BUFFER_MS.STANDARD,
      logger
    );

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('valid-access-token');
    expect(result!.refreshToken).toBe('valid-refresh-token');
    expect(refreshFn).not.toHaveBeenCalled(); // Token not expired, no refresh needed
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('refreshes expired token and returns new access token', async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);
    const logger = makeSilentLogger();

    // Token expired 10 minutes ago
    const expiredRow = makeTokenRow({
      token_expires_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    queryResponses.push({ rows: [expiredRow] });
    // UPDATE response
    queryResponses.push({ rows: [], rowCount: 1 });

    const refreshFn = vi.fn().mockResolvedValue({
      access_token: 'refreshed-token',
      expiry_date: Date.now() + 3600_000,
    });

    const result = await getIntegrationTokens(
      pool,
      TENANT_ID,
      'hubspot',
      refreshFn,
      TOKEN_BUFFER_MS.STANDARD,
      logger
    );

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('refreshed-token');
    expect(refreshFn).toHaveBeenCalledWith('valid-refresh-token');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('token refreshed'));
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('uses custom buffer (e.g., Square 24h) for refresh check', async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);

    // Token expires in 12h — within Square's 24h buffer but outside standard 5min
    const row = makeTokenRow({
      token_expires_at: new Date(Date.now() + 12 * 3600_000).toISOString(),
    });
    queryResponses.push({ rows: [row] });
    queryResponses.push({ rows: [], rowCount: 1 });

    const refreshFn = vi.fn().mockResolvedValue({
      access_token: 'square-refreshed',
      expiry_date: Date.now() + 30 * 24 * 3600_000,
    });

    const result = await getIntegrationTokens(
      pool,
      TENANT_ID,
      'square',
      refreshFn,
      TOKEN_BUFFER_MS.SQUARE
    );

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('square-refreshed');
    expect(refreshFn).toHaveBeenCalled(); // Should refresh — 12h < 24h buffer
  });

  it('includes extra columns (e.g., settings) when requested', async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);

    queryResponses.push({ rows: [makeTokenRow({ settings: { tenant_sid: '12345' } })] });

    const result = await getIntegrationTokens(
      pool,
      TENANT_ID,
      'servicetitan',
      vi.fn(),
      TOKEN_BUFFER_MS.STANDARD,
      undefined,
      'settings'
    );

    expect(result).not.toBeNull();
    expect(result!.settings).toEqual({ tenant_sid: '12345' });

    // Verify the query included the extra column
    // By CONTENT, not position — withTenantContext adds RLS-context statements
    // to the call log and a fixed index silently retargets the assertion.
    const queryText = String(
      mockClient.query.mock.calls.find((c) => String(c[0]).includes('FOR UPDATE'))?.[0]
    );
    expect(queryText).toContain('settings');
    expect(queryText).toContain('FOR UPDATE');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getIntegrationTokens — SAD PATHS
// ═══════════════════════════════════════════════════════════════════════

describe('getIntegrationTokens — sad paths', () => {
  it('returns null when no integration row exists (WHO: tenant, WHAT: lookup, WHERE: tenant_integration_settings, HOW: no row for provider)', async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);

    queryResponses.push({ rows: [] }); // No row

    const result = await getIntegrationTokens(pool, TENANT_ID, 'jobber', vi.fn());

    expect(result).toBeNull();
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('returns null and logs when integration is inactive (WHO: tenant, WHAT: token check, WHERE: getIntegrationTokens, HOW: is_active=false)', async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);
    const logger = makeSilentLogger();

    queryResponses.push({ rows: [makeTokenRow({ is_active: false })] });

    const result = await getIntegrationTokens(
      pool,
      TENANT_ID,
      'hubspot',
      vi.fn(),
      TOKEN_BUFFER_MS.STANDARD,
      logger
    );

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('integration inactive'));
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('returns null and logs when tokens are missing (WHO: tenant, WHAT: token check, WHERE: getIntegrationTokens, HOW: access_token/refresh_token null)', async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);
    const logger = makeSilentLogger();

    queryResponses.push({ rows: [makeTokenRow({ access_token: null, refresh_token: null })] });

    const result = await getIntegrationTokens(
      pool,
      TENANT_ID,
      'square',
      vi.fn(),
      TOKEN_BUFFER_MS.STANDARD,
      logger
    );

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing tokens'));
  });

  it('marks integration inactive and returns null when refresh fails (WHO: tenant, WHAT: token refresh, WHERE: getIntegrationTokens, WHY: OAuth revoked, HOW: is_active set to false)', async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);
    const logger = makeSilentLogger();

    // Expired token
    queryResponses.push({
      rows: [makeTokenRow({ token_expires_at: new Date(Date.now() - 60_000).toISOString() })],
    });
    // UPDATE is_active = false response
    queryResponses.push({ rows: [], rowCount: 1 });

    const refreshFn = vi.fn().mockRejectedValue(new Error('OAuth grant revoked'));

    const before = errorsTotalFor('integration_token_refresh_failed');
    const result = await getIntegrationTokens(
      pool,
      TENANT_ID,
      'jobber',
      refreshFn,
      TOKEN_BUFFER_MS.STANDARD,
      logger
    );

    expect(result).toBeNull();
    expect(refreshFn).toHaveBeenCalledOnce();
    // WHY: a per-tenant log line alone is invisible until a customer
    // complains — errors_total is what a dashboard could alert on across
    // every tenant's OAuth grants going bad.
    expect(errorsTotalFor('integration_token_refresh_failed')).toBe(before + 1);

    // Verify is_active was set to false
    // Located by CONTENT, not position (see withTenantContext, 2026-07-27).
    const updateCall = mockClient.query.mock.calls.find((c) =>
      String(c[0]).includes('is_active = false')
    )!;
    expect(updateCall, 'no query matched: is_active = false').toBeDefined();
    expect(updateCall[0]).toContain('is_active = false');

    // Verify error was logged with 5W context
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/token refresh FAILED.*WHO.*WHAT.*WHY.*HOW.*ERROR/)
    );

    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('always releases the DB client even if query throws (WHO: system, WHAT: DB error, WHERE: getIntegrationTokens, HOW: finally block)', async () => {
    const { mockClient } = createMockClient();
    const pool = createMockPool(mockClient);

    mockClient.query.mockRejectedValueOnce(new Error('Connection lost'));

    await expect(getIntegrationTokens(pool, TENANT_ID, 'hubspot', vi.fn())).rejects.toThrow(
      'Connection lost'
    );

    expect(mockClient.release).toHaveBeenCalledOnce();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getCalendarTokens — HAPPY PATHS
// ═══════════════════════════════════════════════════════════════════════

import {
  getCalendarTokens,
  setSyncContext,
  clearSyncContext,
  withSyncContext,
} from '../../src/services/tokenManagement';

function makeCalendarRow(overrides: Record<string, any> = {}) {
  return {
    provider: 'google',
    external_calendar_id: 'cal-123@google.com',
    access_token: 'cal-access-token',
    refresh_token: 'cal-refresh-token',
    token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    is_active: true,
    ...overrides,
  };
}

describe('getCalendarTokens — happy paths', () => {
  it('returns tokens and calendarId when not expired (WHO: calendar sync | WHAT: valid tokens from tenant_calendar_settings | WHERE: getCalendarTokens | WHY: needed to push/pull calendar events)', async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);
    const logger = makeSilentLogger();

    queryResponses.push({ rows: [makeCalendarRow()] });

    const result = await getCalendarTokens(
      pool,
      TENANT_ID,
      { google: vi.fn(), outlook: vi.fn() },
      logger
    );

    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('cal-access-token');
    expect(result!.refreshToken).toBe('cal-refresh-token');
    expect(result!.calendarId).toBe('cal-123@google.com');
    expect(result!.provider).toBe('google');
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('refreshes expired calendar token (WHO: calendar sync | WHAT: expired token triggers refresh → new access_token stored | WHERE: getCalendarTokens | WHY: prevents 401 from Google/Outlook API)', async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);
    const logger = makeSilentLogger();

    queryResponses.push({
      rows: [
        makeCalendarRow({
          token_expires_at: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
    });
    queryResponses.push({ rows: [], rowCount: 1 }); // UPDATE response

    const googleRefresh = vi.fn().mockResolvedValue({
      access_token: 'refreshed-cal-token',
      expiry_date: Date.now() + 3600_000,
    });
    const outlookRefresh = vi.fn();

    const result = await getCalendarTokens(
      pool,
      TENANT_ID,
      { google: googleRefresh, outlook: outlookRefresh },
      logger
    );

    expect(result!.accessToken).toBe('refreshed-cal-token');
    expect(googleRefresh).toHaveBeenCalledWith('cal-refresh-token');
    // WHY: helper must pick the google refresh, not outlook, based on the row
    expect(outlookRefresh).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Google token refreshed'));
  });

  it("supports Outlook provider (WHO: Outlook calendar sync | WHAT: provider='outlook' accepted | WHERE: getCalendarTokens | WHY: both Google and Outlook are valid providers)", async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);

    queryResponses.push({
      rows: [
        makeCalendarRow({
          provider: 'outlook',
          token_expires_at: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
    });
    queryResponses.push({ rows: [], rowCount: 1 }); // UPDATE response

    const googleRefresh = vi.fn();
    const outlookRefresh = vi.fn().mockResolvedValue({
      access_token: 'outlook-refreshed',
      expiry_date: Date.now() + 3600_000,
    });

    const result = await getCalendarTokens(pool, TENANT_ID, {
      google: googleRefresh,
      outlook: outlookRefresh,
    });
    expect(result!.provider).toBe('outlook');
    // WHY: helper must pick outlook refresh based on the row's provider, not google
    expect(outlookRefresh).toHaveBeenCalledWith('cal-refresh-token');
    expect(googleRefresh).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getCalendarTokens — SAD PATHS
// ═══════════════════════════════════════════════════════════════════════

describe('getCalendarTokens — sad paths', () => {
  it("returns null when no calendar settings row (WHO: tenant without calendar | WHAT: no row in tenant_calendar_settings | WHERE: getCalendarTokens | WHY: tenants don't have to connect calendar)", async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);

    queryResponses.push({ rows: [] });

    const result = await getCalendarTokens(pool, TENANT_ID, { google: vi.fn(), outlook: vi.fn() });
    expect(result).toBeNull();
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('returns null when calendar inactive (WHO: disabled calendar | WHAT: is_active=false | WHERE: getCalendarTokens | WHY: user disconnected calendar from dashboard)', async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);
    const logger = makeSilentLogger();

    queryResponses.push({ rows: [makeCalendarRow({ is_active: false })] });

    const result = await getCalendarTokens(
      pool,
      TENANT_ID,
      { google: vi.fn(), outlook: vi.fn() },
      logger
    );
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('calendar marked inactive'));
  });

  it('returns null when provider is unsupported (WHO: misconfigured tenant | WHAT: provider is not google/outlook | WHERE: getCalendarTokens | WHY: only 2 calendar providers supported)', async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);
    const logger = makeSilentLogger();

    queryResponses.push({ rows: [makeCalendarRow({ provider: 'yahoo' })] });

    const result = await getCalendarTokens(
      pool,
      TENANT_ID,
      { google: vi.fn(), outlook: vi.fn() },
      logger
    );
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not supported'));
  });

  it('returns null when tokens missing (WHO: incomplete OAuth | WHAT: access_token null | WHERE: getCalendarTokens | WHY: OAuth flow was interrupted before tokens were stored)', async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);
    const logger = makeSilentLogger();

    queryResponses.push({ rows: [makeCalendarRow({ access_token: null })] });

    const result = await getCalendarTokens(
      pool,
      TENANT_ID,
      { google: vi.fn(), outlook: vi.fn() },
      logger
    );
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing tokens'));
  });

  it('marks calendar inactive on refresh failure (WHO: revoked OAuth | WHAT: refresh throws → is_active=false | WHERE: getCalendarTokens | WHY: prevents repeated failed refresh attempts)', async () => {
    const { mockClient, queryResponses } = createMockClient();
    const pool = createMockPool(mockClient);
    const logger = makeSilentLogger();

    queryResponses.push({
      rows: [
        makeCalendarRow({
          token_expires_at: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
    });
    queryResponses.push({ rows: [], rowCount: 1 }); // UPDATE is_active=false

    const googleRefresh = vi.fn().mockRejectedValue(new Error('OAuth revoked'));

    const before = errorsTotalFor('calendar_token_refresh_failed');
    const result = await getCalendarTokens(
      pool,
      TENANT_ID,
      { google: googleRefresh, outlook: vi.fn() },
      logger
    );
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('token refresh FAILED'));
    expect(errorsTotalFor('calendar_token_refresh_failed')).toBe(before + 1);

    // Located by CONTENT, not position (see withTenantContext, 2026-07-27).
    const updateCall = mockClient.query.mock.calls.find((c) =>
      String(c[0]).includes('is_active = false')
    )!;
    expect(updateCall, 'no query matched: is_active = false').toBeDefined();
    expect(updateCall[0]).toContain('is_active = false');
  });

  it('always releases client even on query error (WHO: system | WHAT: pool client released | WHERE: getCalendarTokens finally | WHY: prevents pool exhaustion)', async () => {
    const { mockClient } = createMockClient();
    const pool = createMockPool(mockClient);

    mockClient.query.mockRejectedValueOnce(new Error('DB down'));

    await expect(
      getCalendarTokens(pool, TENANT_ID, { google: vi.fn(), outlook: vi.fn() })
    ).rejects.toThrow('DB down');
    expect(mockClient.release).toHaveBeenCalledOnce();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// setSyncContext / clearSyncContext / withSyncContext
// ═══════════════════════════════════════════════════════════════════════

describe('setSyncContext', () => {
  it('sets change_source session variable (WHO: sync service | WHAT: SET LOCAL app.change_source | WHERE: setSyncContext | WHY: version tracking records which CRM made the change)', async () => {
    const client = { query: vi.fn() };
    await setSyncContext(client, 'square');

    expect(client.query).toHaveBeenCalledWith("SET LOCAL app.change_source = 'square'");
  });

  it('sets changed_by when provided (WHO: sync service | WHAT: SET LOCAL app.changed_by | WHERE: setSyncContext | WHY: tracks which sync process made the change for audit)', async () => {
    const client = { query: vi.fn() };
    await setSyncContext(client, 'square', 'sync-square');

    expect(client.query).toHaveBeenCalledWith("SET LOCAL app.change_source = 'square'");
    expect(client.query).toHaveBeenCalledWith("SET LOCAL app.changed_by = 'sync-square'");
  });

  it('skips changed_by when not provided (WHO: sync service | WHAT: only change_source set | WHERE: setSyncContext | WHY: changed_by is optional)', async () => {
    const client = { query: vi.fn() };
    await setSyncContext(client, 'square');

    expect(client.query).toHaveBeenCalledTimes(1);
  });
});

describe('clearSyncContext', () => {
  it('resets both session variables (WHO: sync service | WHAT: RESET app.change_source + app.changed_by | WHERE: clearSyncContext | WHY: prevents context leak to next query on same connection)', async () => {
    const client = { query: vi.fn() };
    await clearSyncContext(client);

    expect(client.query).toHaveBeenCalledWith('RESET app.change_source');
    expect(client.query).toHaveBeenCalledWith('RESET app.changed_by');
  });
});

describe('withSyncContext', () => {
  it('wraps operation with set+clear context (WHO: sync service | WHAT: set → operation → clear | WHERE: withSyncContext | WHY: ensures context is always cleaned up even on error)', async () => {
    const client = { query: vi.fn() };
    const result = await withSyncContext(client, 'square', 'sync-sq', async () => 'done');

    expect(result).toBe('done');
    expect(client.query).toHaveBeenCalledWith("SET LOCAL app.change_source = 'square'");
    expect(client.query).toHaveBeenCalledWith("SET LOCAL app.changed_by = 'sync-sq'");
    expect(client.query).toHaveBeenCalledWith('RESET app.change_source');
    expect(client.query).toHaveBeenCalledWith('RESET app.changed_by');
  });

  it('clears context even when operation throws (WHO: sync service | WHAT: error in operation → context still cleared | WHERE: withSyncContext finally | WHY: leaked context would attribute subsequent writes to wrong source)', async () => {
    const client = { query: vi.fn() };

    await expect(
      withSyncContext(client, 'square', 'sync-square', async () => {
        throw new Error('sync failed');
      })
    ).rejects.toThrow('sync failed');

    expect(client.query).toHaveBeenCalledWith('RESET app.change_source');
    expect(client.query).toHaveBeenCalledWith('RESET app.changed_by');
  });

  it('returns the operation result (WHO: sync service | WHAT: return value propagated | WHERE: withSyncContext | WHY: callers need the result of the wrapped operation)', async () => {
    const client = { query: vi.fn() };
    const result = await withSyncContext(client, 'local', undefined, async () => ({ id: 42 }));
    expect(result).toEqual({ id: 42 });
  });
});
