/**
 * Api.customers.list / Api.appointments.list — super-admin scope opt-in.
 *
 * Origin: audit finding 2026-09-16. `/customers` and `/appointments` now
 * require an explicit `all_tenants=true` query param before the backend
 * will drop tenant scoping for the super-admin sentinel tenant. The
 * client-side helper (`superAdminScopeParam`) is what preserves today's
 * "all businesses" super-admin scheduling behavior by appending that param
 * automatically — but ONLY when the caller is genuinely requesting the
 * super-admin sentinel tenant. Every other caller must not see the param at
 * all, so a normal tenant's request is unaffected and no future accidental
 * `all_tenants=true` leak can creep back in through this helper.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const SUPER_ADMIN_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const REGULAR_TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => [],
  });
  vi.stubGlobal('fetch', fetchMock);
  // ensureTokenFresh reads authToken from localStorage; jsdom's localStorage
  // starts empty, so it returns immediately with no extra network calls.
  localStorage.clear();
});

describe('Api.customers.list — super-admin scope opt-in', () => {
  test('HAPPY: regular tenant request has no all_tenants param', async () => {
    const { Api } = await import('./api');
    await Api.customers.list(REGULAR_TENANT_ID);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`tenant_id=${REGULAR_TENANT_ID}`);
    expect(url).not.toContain('all_tenants');
  });

  test('HAPPY: super-admin sentinel tenant request includes all_tenants=true', async () => {
    const { Api } = await import('./api');
    await Api.customers.list(SUPER_ADMIN_TENANT_ID);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('all_tenants=true');
    expect(url).toContain(`tenant_id=${SUPER_ADMIN_TENANT_ID}`);
  });

  test('HAPPY: null tenant request has no params at all', async () => {
    const { Api } = await import('./api');
    await Api.customers.list(null);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain('?');
  });
});

describe('Api.appointments.list — super-admin scope opt-in', () => {
  test('HAPPY: regular tenant request has no all_tenants param', async () => {
    const { Api } = await import('./api');
    await Api.appointments.list(REGULAR_TENANT_ID);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`tenant_id=${REGULAR_TENANT_ID}`);
    expect(url).not.toContain('all_tenants');
  });

  test('HAPPY: super-admin sentinel tenant request includes all_tenants=true', async () => {
    const { Api } = await import('./api');
    await Api.appointments.list(SUPER_ADMIN_TENANT_ID);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('all_tenants=true');
  });
});
