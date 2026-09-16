/**
 * GET /customers — super-admin cross-tenant scope gate.
 *
 * Origin: audit finding 2026-09-16. When the effective tenant on a request
 * is the literal super-admin sentinel UUID (the default state on a fresh
 * super-admin session before a managed tenant is selected, or after "Exit
 * admin mode"), the handler used to run an unfiltered
 * `SELECT * FROM customers` — every tenant's customer PII (name/phone/email/
 * address/notes) in one response, fired even by side-effect fetches that
 * never intended to widen scope (e.g. Setup → Staff/Shifts/Resources).
 *
 * Fix: the branch now requires BOTH requireSuperAdmin AND an explicit
 * `?all_tenants=true` opt-in. Without the opt-in it degrades to an empty
 * list rather than erroring — an accidental/legacy caller loses nothing it
 * was relying on, and gains no cross-tenant data either.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerCustomerRoutes } from '../../src/routes/customers';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';

const SUPER_ADMIN_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const REGULAR_TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let handle: RouteTestAppHandle;

beforeEach(() => {
  handle = buildRouteTestApp((app, pool, withTenantClient) => {
    registerCustomerRoutes(app, pool, withTenantClient);
  });
  handle.auth.current = {
    user_id: '00000000-0000-0000-0000-000000000001',
    tenant_id: SUPER_ADMIN_TENANT_ID,
    email: 'admin@platform',
    role: 'owner',
  };
});

describe('GET /customers — super-admin scope gate', () => {
  it('SAD: super-admin session with no opt-in gets an empty list, not a cross-tenant dump', async () => {
    // WHO: a super-admin with no managed tenant selected (default landing
    //      state, or a stale side-effect fetch from a Setup sub-screen)
    // WHAT: no query runs at all — the route returns [] before touching the DB
    // WHY: this used to be the DEFAULT behavior for ANY request running as
    //      the super-admin sentinel tenant
    const res = await handle.app.inject({ method: 'GET', url: '/customers' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(handle.queries).toHaveLength(0);
  });

  it('HAPPY: super-admin WITH ?all_tenants=true gets the cross-tenant listing', async () => {
    // WHO: the "all businesses" scheduling flow deliberately requesting
    //      cross-tenant customer data (e.g. to resolve which tenant a new
    //      appointment belongs to from the selected customer)
    handle.queryResponses.push({
      rows: [
        { customer_id: 'c-1', tenant_id: REGULAR_TENANT_ID, name: 'Alice' },
        { customer_id: 'c-2', tenant_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', name: 'Bob' },
      ],
    });

    const res = await handle.app.inject({
      method: 'GET',
      url: '/customers?all_tenants=true',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    // Each row is labeled with its own tenant — the super-admin caller can
    // tell which business each customer belongs to.
    expect(body[0].tenant_id).toBe(REGULAR_TENANT_ID);
    expect(handle.queries[0].text).not.toContain('tenant_id = $1');
  });

  it('HAPPY: a normal tenant request is unaffected by the opt-in gate', async () => {
    // Regression guard: the opt-in param is only consulted on the
    // super-admin sentinel path — a real tenant's own request must keep
    // working exactly as before, tenant-scoped, no param required.
    handle.auth.current = {
      user_id: '00000000-0000-0000-0000-000000000002',
      tenant_id: REGULAR_TENANT_ID,
      email: 'owner@business.test',
      role: 'owner',
    };
    handle.queryResponses.push({
      rows: [{ customer_id: 'c-1', tenant_id: REGULAR_TENANT_ID, name: 'Alice' }],
    });

    const res = await handle.app.inject({ method: 'GET', url: '/customers' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(handle.queries[0].text).toContain('tenant_id = $1');
    expect(handle.queries[0].params[0]).toBe(REGULAR_TENANT_ID);
  });
});
