/**
 * Api.billing.checkout / portal / resendVerification — the request each sends,
 * and the RESOLVED error shape BillingView depends on.
 *
 * WHY: apiMutate resolves { success: false, error, ...body } on a non-2xx and
 * only throws on a network failure. BillingView read these as throwing, which
 * redirected a refused checkout to "undefined" (fixed in #567). These tests pin
 * the helper's side of that contract so the two cannot drift apart again.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let fetchMock: ReturnType<typeof vi.fn>;

const respond = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone() {
      return this;
    },
  });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

describe('Api.billing', () => {
  test('HAPPY: checkout POSTs tenant + plan and resolves the Stripe URL with success:true', async () => {
    const { Api } = await import('./api');
    respond(200, { url: 'https://checkout.stripe.test/s' });

    const res = await Api.billing.checkout(TENANT, 'growth');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/billing\/checkout$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ tenant_id: TENANT, plan: 'growth' });
    expect(res).toMatchObject({ success: true, url: 'https://checkout.stripe.test/s' });
  });

  test('SAD: a 403 email_not_verified RESOLVES success:false with error_code — it does not throw', async () => {
    const { Api } = await import('./api');
    respond(403, {
      success: false,
      error_code: 'email_not_verified',
      error: 'Confirm your email first — we sent a link to o@b.test.',
    });

    const res = await Api.billing.checkout(TENANT, 'solo');

    expect(res).toMatchObject({
      success: false,
      error_code: 'email_not_verified',
      error: 'Confirm your email first — we sent a link to o@b.test.',
    });
  });

  test('HAPPY: portal POSTs the tenant and resolves the portal URL', async () => {
    const { Api } = await import('./api');
    respond(200, { url: 'https://billing.stripe.test/p' });

    const res = await Api.billing.portal(TENANT);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/billing\/portal$/);
    expect(JSON.parse(String(init.body))).toEqual({ tenant_id: TENANT });
    expect(res).toMatchObject({ success: true, url: 'https://billing.stripe.test/p' });
  });

  test('HAPPY: resendVerification POSTs with no body and resolves sent_to', async () => {
    const { Api } = await import('./api');
    respond(200, { success: true, sent_to: 'o@b.test' });

    const res = await Api.billing.resendVerification();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/verify-email\/resend$/);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(res).toMatchObject({ success: true, sent_to: 'o@b.test' });
  });

  test('SAD: a network failure DOES throw (the only case that does)', async () => {
    const { Api } = await import('./api');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(Api.billing.resendVerification()).rejects.toThrow('Failed to fetch');
  });
});
