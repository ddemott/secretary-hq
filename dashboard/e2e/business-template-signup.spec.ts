/**
 * Template businesses in the browser: a new salon arrives with its own copy of
 * the Salon Template, and the owner is guided to fill it out.
 *
 * WHO  — a brand-new salon signing up
 * WHAT — POST /register copies "Salon Template" (services with no prices,
 *        chairs, placeholder stylists, knowledge starters) into the new
 *        business; Home still opens the setup welcome; Setup shows the copy;
 *        knowledge starters say they are not used yet
 * WHY  — Dale 2026-09-25: the chosen business "is duplicated and used for them
 *        to fill out", and the template itself is never changed.
 */
import { test, expect, type Page } from '@playwright/test';
import { BACKEND_URL, uniqueSuffix } from './helpers/fixtures';

async function registerSalon(page: Page) {
  const suffix = uniqueSuffix();
  const res = await page.request.post(`${BACKEND_URL}/register`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      business_name: `Template Salon ${suffix}`,
      business_type: 'salon',
      owner_name: `Owner ${suffix}`,
      email: `e2e-template-${suffix}@example.test`,
      password: 'password123',
      consent_attested: true,
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return {
    tenantId: body.tenant_id as string,
    token: body.token as string,
    name: `Template Salon ${suffix}`,
  };
}

async function manage(page: Page, tenantId: string, name: string) {
  await page.goto('/dashboard');
  await page.evaluate(
    ({ id, n }) => {
      localStorage.setItem('managedTenantId', id);
      localStorage.setItem('managedTenantName', n);
    },
    { id: tenantId, n: name }
  );
}

test.describe('new business starts from its template', () => {
  test('HAPPY: a new salon gets the Salon Template to fill out', async ({ page }) => {
    const salon = await registerSalon(page);

    // The copy is theirs, with no prices.
    const services = await page.request.get(`${BACKEND_URL}/services?tenant_id=${salon.tenantId}`, {
      headers: { Authorization: `Bearer ${salon.token}` },
    });
    expect(services.ok()).toBe(true);
    const rows = (await services.json()) as { name: string; price: string | null }[];
    expect(rows.map((r) => r.name)).toEqual(
      expect.arrayContaining(["Women's Haircut", 'Highlights', 'Blowout'])
    );
    expect(rows.every((r) => r.price === null)).toBe(true);

    // Home still guides them into setup, even though nothing is empty.
    await manage(page, salon.tenantId, salon.name);
    await page.goto('/dashboard?tab=dashboard');
    await expect(page.getByRole('dialog', { name: /welcome/i })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: /set up later/i }).click();

    // Setup shows the copied services and placeholder stylists.
    await page.goto('/dashboard?tab=setup&subtab=services');
    await expect(page.getByText("Women's Haircut").first()).toBeVisible({ timeout: 15_000 });
    await page.goto('/dashboard?tab=setup&subtab=employees');
    await expect(page.getByText('Stylist 1').first()).toBeVisible({ timeout: 15_000 });

    // Knowledge starters are marked as not used until saved.
    await page.goto('/dashboard?tab=ai-insights&aiTab=knowledge');
    await page
      .getByRole('button', { name: /review everything/i })
      .or(page.getByRole('tab', { name: /review everything/i }))
      .first()
      .click();
    await expect(page.getByText('Do you take walk-ins?').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/not used yet/i).first()).toBeVisible();
  });
});
