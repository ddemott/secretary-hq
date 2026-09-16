/**
 * Service-level tests for src/services/provisioningService.ts.
 *
 * Tests the state machine directly (no HTTP layer), covering:
 *   - activatePhone happy path — all Telnyx calls succeed, DB updated, result=ok
 *   - activatePhone rollback — orderNumber succeeds, assignToConnection throws →
 *       release(purchasedId) called, status set to 'failed', result carries error context
 *   - activatePhone rollback with cleanup failure — assignToConnection AND release throw →
 *       result carries both error and cleanup_error
 *   - deactivatePhone happy path — release succeeds, DB cleared, warnings=[]
 *   - deactivatePhone partial cleanup — release throws → warnings + release_error in result
 */
/* eslint-disable @typescript-eslint/unbound-method -- mock method-reference assertions (telnyx.client.*) are a deliberate test pattern; see readinessHandler.test.ts / middleware.test.ts precedent */
import { describe, it, expect, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { TelnyxProvisioningConfig } from '../../src/routes/provisioning';
import { activatePhone, deactivatePhone } from '../../src/services/provisioningService';

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// ── Mock helpers ──────────────────────────────────────────────────────────────

function buildMockTelnyxClient(
  overrides: Partial<TelnyxProvisioningConfig['client']> = {}
): TelnyxProvisioningConfig {
  return {
    sipConnectionId: 'sip-conn-123',
    client: {
      searchAvailable: vi.fn(async () => ({
        phone_number: '+16305551234',
        id: 'pn-abc',
      })),
      orderNumber: vi.fn(async () => ({
        id: 'pn-abc',
        phone_number: '+16305551234',
      })),
      findPhoneNumberIdByNumber: vi.fn(async () => 'pn-abc'),
      getPhoneNumber: vi.fn(async () => ({
        id: 'pn-abc',
        phone_number: '+16305551234',
        connection_id: 'sip-conn-123',
        status: 'active',
      })),
      assignToConnection: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      ...overrides,
    },
  };
}

interface MockQueryRow {
  tenant_id?: string;
  name?: string;
  phone_status?: string;
  telnyx_phone_number_id?: string | null;
  forwarded_from_phone?: string | null;
}

function buildMockPool(
  responses: Array<{ rows: MockQueryRow[]; rowCount?: number }>,
  queryLog?: { text: string; params: unknown[] }[]
): Pool {
  let callIndex = 0;
  const mockClient = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queryLog?.push({ text, params: params ?? [] });
      const res = responses[callIndex++] ?? { rows: [], rowCount: 0 };
      return res;
    }),
    release: vi.fn(),
  } as unknown as PoolClient;

  return {
    connect: vi.fn(async () => mockClient),
  } as unknown as Pool;
}

// ── activatePhone ─────────────────────────────────────────────────────────────

describe('activatePhone', () => {
  it('HAPPY: all Telnyx calls succeed → result ok with phone_number, DB set active', async () => {
    // WHO: super-admin provisioning a new phone number for a tenant
    // WHAT: service fetches tenant, sets status=provisioning, orders + assigns number,
    //       sets status=active, returns ok with phone_number + telnyx_phone_number_id
    // WHEN: tenant exists with phone_status='inactive' and Telnyx API works
    // WHERE: activatePhone in provisioningService.ts
    // WHY: the happy path locks that all 5 steps complete and the result contains the
    //      phone_number the route needs to store in the logEvent and response body
    const telnyx = buildMockTelnyxClient();
    const pool = buildMockPool([
      // SELECT tenant
      { rows: [{ tenant_id: TENANT_ID, name: 'Test Biz', phone_status: 'inactive' }] },
      // UPDATE SET provisioning
      { rows: [], rowCount: 1 },
      // UPDATE SET active
      { rows: [], rowCount: 1 },
    ]);

    const result = await activatePhone(pool, telnyx, TENANT_ID);

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.phone_number).toBe('+16305551234');
      expect(result.telnyx_phone_number_id).toBe('pn-abc');
      expect(result.tenant_id).toBe(TENANT_ID);
    }

    expect(telnyx.client.searchAvailable).toHaveBeenCalledOnce();
    expect(telnyx.client.orderNumber).toHaveBeenCalledWith('+16305551234');
    expect(telnyx.client.assignToConnection).toHaveBeenCalledWith('pn-abc', 'sip-conn-123');
    expect(telnyx.client.release).not.toHaveBeenCalled();
  });

  it('E2E STUB: PROVISIONING_E2E_STUB=1 skips telnyx.client entirely, still updates the DB for real', async () => {
    // WHO: an E2E test driving the real wizard/GoLivePanel click-path with no
    //      Telnyx credentials configured.
    // WHAT: the stub short-circuits before any telnyx.client.* call, but the
    //      state-machine (provisioning → active) and DB UPDATE still run for
    //      real — this is what lets E2E assert the real committed row shape,
    //      not just that a button click didn't throw.
    // WHERE: the PROVISIONING_E2E_STUB branch in activatePhone, before the
    //      try block that calls telnyx.client.
    const prev = process.env.PROVISIONING_E2E_STUB;
    process.env.PROVISIONING_E2E_STUB = '1';
    try {
      const telnyx = buildMockTelnyxClient();
      const pool = buildMockPool([
        { rows: [{ tenant_id: TENANT_ID, name: 'Test Biz', phone_status: 'inactive' }] },
        { rows: [], rowCount: 1 }, // UPDATE SET provisioning
        { rows: [], rowCount: 1 }, // UPDATE SET active (stub path)
      ]);

      const result = await activatePhone(pool, telnyx, TENANT_ID, '608');

      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.phone_number).toMatch(/^\+1608\d{7}$/);
        expect(result.telnyx_phone_number_id).toMatch(/^stub-pn-/);
      }
      // The whole point: zero real Telnyx calls.
      expect(telnyx.client.searchAvailable).not.toHaveBeenCalled();
      expect(telnyx.client.orderNumber).not.toHaveBeenCalled();
      expect(telnyx.client.assignToConnection).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.PROVISIONING_E2E_STUB;
      else process.env.PROVISIONING_E2E_STUB = prev;
    }
  });

  it('ROLLBACK: orderNumber succeeds, assignToConnection throws → release called, result failed', async () => {
    // WHO: super-admin whose SIP connection assignment fails mid-provision
    // WHAT: orderNumber returns a purchased ID, assignToConnection throws →
    //       release(purchasedId) is called as rollback, status set to 'failed',
    //       result carries error + number_purchased=true + rolled_back=true
    // WHEN: Telnyx SIP API is temporarily down after the number order succeeds
    // WHERE: activatePhone inner try/catch → rollback branch
    // WHY: a purchased-but-unassigned number wastes Telnyx budget — the rollback
    //      release is load-bearing. This test pins that release() is called with
    //      the exact purchased ID, not skipped on error.
    const assignError = new Error('SIP connection assignment failed');
    const telnyx = buildMockTelnyxClient({
      assignToConnection: vi.fn(async () => {
        throw assignError;
      }),
    });
    const pool = buildMockPool([
      { rows: [{ tenant_id: TENANT_ID, name: 'Test Biz', phone_status: 'inactive' }] },
      { rows: [], rowCount: 1 }, // UPDATE provisioning
      { rows: [], rowCount: 1 }, // UPDATE failed
    ]);

    const result = await activatePhone(pool, telnyx, TENANT_ID);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.detail).toBe('SIP connection assignment failed');
      expect(result.error).toBe(assignError);
      expect(result.number_purchased).toBe(true);
      expect(result.rolled_back).toBe(true);
      expect(result.purchased_id).toBe('pn-abc');
      expect(result.cleanup_error).toBeUndefined(); // release succeeded
    }

    // Rollback release must be called with the purchased number's ID
    expect(telnyx.client.release).toHaveBeenCalledWith('pn-abc');
  });

  it('VERIFY FAILS: assign succeeds but connection_id did not stick → rollback, result failed', async () => {
    // WHO: super-admin provisioning against a connection that silently fails to bind
    // WHAT: orderNumber + assignToConnection both resolve, but getPhoneNumber shows
    //       connection_id != sipConnectionId → activatePhone throws, releases the
    //       number, tenant set to 'failed'. The number is NEVER marked active.
    // WHEN: Telnyx accepts the PATCH but inbound routing never binds (the silent
    //       dead-line failure mode that shipped dead numbers as 'active').
    // WHERE: activatePhone post-assign verification branch
    // WHY: this is the core guard added 2026-06-04 — a number that cannot receive
    //      calls must fail provisioning, not report healthy. Pins that a mismatched
    //      connection_id triggers rollback rather than an 'ok' result.
    const telnyx = buildMockTelnyxClient({
      getPhoneNumber: vi.fn(async () => ({
        id: 'pn-abc',
        phone_number: '+16305551234',
        connection_id: null, // assignment did not take
        status: 'active',
      })),
    });
    const pool = buildMockPool([
      { rows: [{ tenant_id: TENANT_ID, name: 'Test Biz', phone_status: 'inactive' }] },
      { rows: [], rowCount: 1 }, // UPDATE provisioning
      { rows: [], rowCount: 1 }, // UPDATE failed
    ]);

    const result = await activatePhone(pool, telnyx, TENANT_ID);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.detail).toContain('did not take');
      expect(result.number_purchased).toBe(true);
      expect(result.rolled_back).toBe(true);
    }
    // The dead number must be released, never left assigned-but-dead.
    expect(telnyx.client.release).toHaveBeenCalledWith('pn-abc');
  });

  it('ROLLBACK + CLEANUP FAILURE: assignToConnection throws AND release throws → both errors in result', async () => {
    // WHO: super-admin during a Telnyx outage where both assign and rollback fail
    // WHAT: assignToConnection throws, then release also throws →
    //       result has error (original) AND cleanup_error (release error)
    // WHEN: Telnyx API is fully down mid-provision
    // WHERE: activatePhone catch → inner try/catch around release()
    // WHY: the route must log BOTH errors (phone_provisioning_failed +
    //      telnyx_number_cleanup_failed). cleanup_error in the result drives
    //      the conditional logError in the route — without it the cleanup
    //      failure would be silently swallowed.
    const assignError = new Error('assign failed');
    const releaseError = new Error('release also failed');
    const telnyx = buildMockTelnyxClient({
      assignToConnection: vi.fn(async () => {
        throw assignError;
      }),
      release: vi.fn(async () => {
        throw releaseError;
      }),
    });
    const pool = buildMockPool([
      { rows: [{ tenant_id: TENANT_ID, name: 'Test Biz', phone_status: 'inactive' }] },
      { rows: [], rowCount: 1 }, // UPDATE provisioning
      { rows: [], rowCount: 1 }, // UPDATE failed
    ]);

    const result = await activatePhone(pool, telnyx, TENANT_ID);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toBe(assignError);
      expect(result.cleanup_error).toBe(releaseError);
      expect(result.number_purchased).toBe(true);
    }
  });

  it('CONFLICT: phone_status=active → result conflict already_active', async () => {
    // WHO: super-admin re-provisioning a tenant that already has an active number
    // WHAT: status check returns 'conflict' with reason='already_active' before any Telnyx call
    // WHEN: tenant.phone_status is 'active'
    // WHERE: activatePhone status guard
    // WHY: pins that the guard prevents Telnyx API calls for already-active tenants
    const telnyx = buildMockTelnyxClient();
    const pool = buildMockPool([
      { rows: [{ tenant_id: TENANT_ID, name: 'Test Biz', phone_status: 'active' }] },
    ]);

    const result = await activatePhone(pool, telnyx, TENANT_ID);

    expect(result.status).toBe('conflict');
    if (result.status === 'conflict') {
      expect(result.reason).toBe('already_active');
    }
    expect(telnyx.client.searchAvailable).not.toHaveBeenCalled();
  });

  it('SOFT-DELETE: tenant lookup query filters out is_deleted tenants', async () => {
    // WHO: super-admin clicking "Activate Phone" against an already
    //      soft-deleted tenant (e.g. a stale admin tab)
    // WHAT: the tenant-lookup SELECT must scope out is_deleted rows, so a
    //       soft-deleted tenant reads as not_found rather than resuming
    //       real Telnyx purchase/assign against a deleted business
    // WHERE: activatePhone's tenant-lookup query
    // WHY: audit finding 2026-09-16 — this route bypassed the soft-delete
    //      choke point createWithTenantClient enforces everywhere else,
    //      so a deleted tenant's line could be purchased/activated for real
    const telnyx = buildMockTelnyxClient();
    const queryLog: { text: string; params: unknown[] }[] = [];
    const pool = buildMockPool([{ rows: [] }], queryLog);

    const result = await activatePhone(pool, telnyx, TENANT_ID);

    expect(result.status).toBe('not_found');
    expect(queryLog[0].text).toContain('is_deleted = false');
    expect(telnyx.client.searchAvailable).not.toHaveBeenCalled();
  });
});

// ── deactivatePhone ───────────────────────────────────────────────────────────

describe('deactivatePhone', () => {
  it('HAPPY: release succeeds → result ok with empty warnings, DB cleared', async () => {
    // WHO: super-admin deactivating a tenant's phone
    // WHAT: release succeeds, DB columns cleared, result ok with warnings=[]
    // WHEN: Telnyx API is available
    // WHERE: deactivatePhone in provisioningService.ts
    // WHY: pins that DB is always cleared and result shape includes tenant_id + warnings
    const telnyx = buildMockTelnyxClient();
    const pool = buildMockPool([
      { rows: [{ telnyx_phone_number_id: 'pn-abc' }] },
      { rows: [], rowCount: 1 }, // UPDATE deprovisioned
    ]);

    const result = await deactivatePhone(pool, telnyx, TENANT_ID);

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.warnings).toHaveLength(0);
      expect(result.release_error).toBeUndefined();
      expect(result.tenant_id).toBe(TENANT_ID);
    }
    expect(telnyx.client.release).toHaveBeenCalledWith('pn-abc');
  });

  it('PARTIAL CLEANUP: release throws → result ok with warnings + release_error', async () => {
    // WHO: super-admin deactivating when Telnyx API is unavailable
    // WHAT: release throws → warning captured, DB still cleared, release_error in result
    // WHEN: Telnyx release endpoint returns an error
    // WHERE: deactivatePhone catch around telnyx.client.release()
    // WHY: DB columns must be cleared even on Telnyx failure so the tenant is
    //      not stuck in 'active'. release_error drives the logError call in the route.
    const releaseError = new Error('Telnyx timeout');
    const telnyx = buildMockTelnyxClient({
      release: vi.fn(async () => {
        throw releaseError;
      }),
    });
    const pool = buildMockPool([
      { rows: [{ telnyx_phone_number_id: 'pn-abc' }] },
      { rows: [], rowCount: 1 }, // UPDATE deprovisioned
    ]);

    const result = await deactivatePhone(pool, telnyx, TENANT_ID);

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('pn-abc');
      expect(result.release_error).toBe(releaseError);
      expect(result.release_phone_number_id).toBe('pn-abc');
    }
  });

  it('SAFETY: forwarded_from_phone still set → a warning is added, deactivation still proceeds', async () => {
    // WHO: an owner deactivating a DID their business still forwards real
    //      callers into.
    // WHAT: releasing the number while forwarded_from_phone is set strands
    //      every real caller the moment the carrier delivers into a dead
    //      DID. The fix warns (doesn't block — the owner may be
    //      deliberately tearing down) and DB state still clears normally.
    // WHERE: the forwarded_from_phone check added to deactivatePhone.
    const telnyx = buildMockTelnyxClient();
    const pool = buildMockPool([
      { rows: [{ telnyx_phone_number_id: 'pn-abc', forwarded_from_phone: '+16082175303' }] },
      { rows: [], rowCount: 1 },
    ]);

    const result = await deactivatePhone(pool, telnyx, TENANT_ID);

    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('+16082175303');
      expect(result.warnings[0]).toContain('Forwarded-From');
      expect(result.release_error).toBeUndefined();
    }
    // Deactivation still proceeds — this is a warning, not a block.
    expect(telnyx.client.release).toHaveBeenCalledWith('pn-abc');
  });

  it('SOFT-DELETE: tenant lookup query filters out is_deleted tenants', async () => {
    // Same rationale as activatePhone's soft-delete test — a deactivate
    // call against an already soft-deleted tenant should read as
    // not_found rather than releasing a real Telnyx number on its behalf.
    const telnyx = buildMockTelnyxClient();
    const queryLog: { text: string; params: unknown[] }[] = [];
    const pool = buildMockPool([{ rows: [] }], queryLog);

    const result = await deactivatePhone(pool, telnyx, TENANT_ID);

    expect(result.status).toBe('not_found');
    expect(queryLog[0].text).toContain('is_deleted = false');
    expect(telnyx.client.release).not.toHaveBeenCalled();
  });
});
