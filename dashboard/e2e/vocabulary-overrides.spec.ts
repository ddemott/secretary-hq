/**
 * E2E coverage for the vocabulary fallback chain — tenant override → business-template
 * default → hardcoded default — and proof that the resolved values reach the dashboard UI.
 *
 * Why this exists: docs/TODO.md "Vocabulary overrides flow through the UI" was a P2 E2E
 * gap. The unit-level `vocabulary-guard` test pins that no jargon strings appear in
 * dashboard tsx files (regression guard for "Tenant"/"RLS"/etc. slipping into customer-
 * facing copy). The wiring tests pin the 3-tier `COALESCE` SQL in /vocabulary. Neither
 * covers the round-trip: register a tenant whose template defines non-default labels,
 * have the dashboard ask for them, and confirm a visible UI surface renders the
 * non-default value. Without that pin, a regression could break the wire (the
 * `useVocabulary` context falling back to DEFAULTS silently on any fetch error) and
 * every salon owner would see "Employees" everywhere instead of "Stylists" — exactly
 * the directional UX feedback the launch-blocker audit flagged (TODO.md:36-50).
 *
 * What's covered:
 *   1. API (salon)        — register tenant with business_type='salon';
 *                            GET /vocabulary returns Stylist/Chair from business_templates
 *                            (per-template default tier).
 *   2. API (mobile-tire)  — same but for business_type='mobile-tire';
 *                            returns Technician/Truck. Cross-template guard against a
 *                            regression that hardcodes one industry's labels.
 *   3. API (override)     — tenant with a custom override seeded into tenants.* columns
 *                            wins over the template default (override tier).
 *   4. API (auth)         — unauthenticated GET /vocabulary is rejected at the
 *                            tenant-resolution layer (defense-in-depth).
 *   5. UI                 — log in, switch into a salon tenant, navigate to the
 *                            Employees view, assert the page heading reads "Stylists"
 *                            and the Add button reads "Add Stylist".
 *
 * Each test owns its own data lifecycle: registers a fresh tenant, runs assertions,
 * DELETEs the tenant on cleanup (FK cascade clears every dependent row).
 */
import { test, expect } from './helpers/test';
import { type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import { cleanTenantData } from './helpers/fixtures';

const PG_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';
const BACKEND_URL = process.env.BACKEND_URL ?? 'https://localhost:4001';

let pool: Pool;

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

interface RegisteredTenant {
  tenantId: string;
  token: string;
  email: string;
  password: string;
}

async function registerFreshTenant(
  req: APIRequestContext,
  businessType: string,
  namePrefix: string
): Promise<RegisteredTenant> {
  const suffix = uniqueSuffix();
  const email = `vocab-e2e-${suffix}@example.test`;
  const password = 'password123';
  const res = await req.post(`${BACKEND_URL}/register`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      business_name: `${namePrefix} ${suffix}`,
      business_type: businessType,
      owner_name: `Owner ${suffix}`,
      email,
      password,
      consent_attested: true,
    },
  });
  expect(res.status(), `register must succeed for business_type=${businessType}`).toBe(201);
  const body = await res.json();
  expect(body.success).toBe(true);
  return {
    tenantId: body.tenant_id as string,
    token: body.token as string,
    email,
    password,
  };
}

test.beforeAll(() => {
  pool = new Pool({ connectionString: PG_URL });
});
test.afterAll(async () => {
  await pool.end();
});

// ────────────────────────────────────────────────────────────────────────────
// Tier 2 — per-template defaults flow through /vocabulary
// ────────────────────────────────────────────────────────────────────────────

test('salon tenant resolves Stylist/Chair from the business-template tier', async ({ request }) => {
  // WHO: a salon owner who just registered. Their `tenants.resource_label` and friends
  //      are NULL (we don't populate per-tenant overrides on register).
  // WHAT: GET /vocabulary?tenant_id=X returns {resource_label:'Chair', resource_plural:'Chairs',
  //       employee_label:'Stylist', employee_plural:'Stylists', booking_label:'Appointment'}.
  // WHEN: every salon tenant's first dashboard load — VocabularyContext.tsx:45 fetches
  //       this on tenant change, and every component using useVocabulary() reads the result.
  // WHERE: src/routes/vocabulary.ts → 3-tier COALESCE(t.resource_label, bt.resource_label, 'Resource').
  //        For a tenant whose own columns are NULL, the bt.* values win.
  // WHY: pin the per-template tier explicitly. A fresh registered tenant whose own
  //      columns are NULL exercises tier 2 (business_templates JOIN) via the real /register
  //      path. A regression that drops the LEFT JOIN on business_templates (e.g., refactor
  //      to a simpler SELECT) would silently degrade every tenant to the
  //      hardcoded 'Resource'/'Employee'/'Appointment' fallback.
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request, 'salon', 'Salon E2E');
    const res = await request.get(`${BACKEND_URL}/vocabulary?tenant_id=${tenant.tenantId}`, {
      headers: { Authorization: `Bearer ${tenant.token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      resource_label: 'Chair',
      resource_plural: 'Chairs',
      employee_label: 'Stylist',
      employee_plural: 'Stylists',
    });
    // booking_label may or may not have a salon-specific value; we don't pin it here
    // because the salon template uses the hardcoded 'Appointment' default, which is fine.
    expect(body.booking_label).toBeTruthy();
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

test('mobile-tire tenant resolves Technician/Truck — cross-template guard', async ({ request }) => {
  // WHO: a mobile-tire owner. Same NULL-per-tenant-override shape as the salon test;
  //      only the business_type differs.
  // WHAT: GET /vocabulary returns Truck/Technician from business_templates.
  // WHEN: a fresh mobile-tire tenant registered via /register — exercises the
  //       JOIN-resolved path, not a per-tenant seed override.
  // WHERE: src/routes/vocabulary.ts JOIN to business_templates on business_type.
  // WHY: defense against a regression that hardcodes one industry's labels into the
  //      route. If a future cleanup pass replaces the JOIN with a SELECT against only
  //      a single template, this test will fail loud.
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request, 'mobile-tire', 'Tire E2E');
    const res = await request.get(`${BACKEND_URL}/vocabulary?tenant_id=${tenant.tenantId}`, {
      headers: { Authorization: `Bearer ${tenant.token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      resource_label: 'Truck',
      employee_label: 'Technician',
    });
    // Sanity: cross-check it ISN'T returning the salon labels (catches a JOIN bug
    // where the LEFT JOIN doesn't filter by business_type).
    expect(body.employee_label).not.toBe('Stylist');
    expect(body.resource_label).not.toBe('Chair');
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Tier 1 — per-tenant override wins over the template default
// ────────────────────────────────────────────────────────────────────────────

test('per-tenant override wins over the business-template default', async ({ request }) => {
  // WHO: a tenant whose owner customized their vocabulary post-onboarding — the
  //      override is written directly to the tenants table (no public write API
  //      exists for this today; product currently relies on the wizard-picked
  //      business_type for vocab. We seed the override via DB to pin the contract
  //      *the read path already implements* in case a future write API ships).
  // WHAT: GET /vocabulary returns the per-tenant override, NOT the template default.
  //       Specifically: salon tenant overridden to employee_label='Aesthetic Specialist'
  //       returns 'Aesthetic Specialist', not 'Stylist'.
  // WHEN: any tenant who has set a custom vocabulary value. Untested by unit tests
  //       because the unit-level wiring tests don't seed the tenants.* override columns
  //       (only the template defaults).
  // WHERE: src/routes/vocabulary.ts COALESCE(t.resource_label, bt.resource_label, ...) —
  //        the FIRST tier of the 3-tier fallback.
  // WHY: this is the LITERAL contract the vocabulary feature exists to enforce. A
  //      regression that drops the tenants.* columns from the SELECT (e.g., a refactor
  //      to "use only business_templates because no UI sets the override today") would
  //      silently lock all tenants to their template default and discard any direct-DB
  //      customizations that ops + support occasionally apply for VIP customers.
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request, 'salon', 'Override E2E');
    await pool.query(
      `UPDATE tenants SET
                employee_label = 'Aesthetic Specialist',
                employee_plural = 'Aesthetic Specialists',
                resource_label = 'Lounge Chair',
                resource_plural = 'Lounge Chairs',
                booking_label = 'Session'
             WHERE tenant_id = $1`,
      [tenant.tenantId]
    );

    const res = await request.get(`${BACKEND_URL}/vocabulary?tenant_id=${tenant.tenantId}`, {
      headers: { Authorization: `Bearer ${tenant.token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Override fields must shadow the template defaults.
    expect(body).toMatchObject({
      resource_label: 'Lounge Chair',
      resource_plural: 'Lounge Chairs',
      employee_label: 'Aesthetic Specialist',
      employee_plural: 'Aesthetic Specialists',
      booking_label: 'Session',
    });
    // example_services / example_resources come from the template (no
    // per-tenant override exists yet); the salon template seeds 5 services.
    // Assert presence and arrayness without pinning the exact list — a
    // template content update shouldn't break this spec.
    expect(Array.isArray(body.example_services)).toBe(true);
    expect(Array.isArray(body.example_resources)).toBe(true);
    // Sanity: the template default was 'Stylist'; the override must shadow it.
    expect(body.employee_label).not.toBe('Stylist');
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Auth — defense-in-depth
// ────────────────────────────────────────────────────────────────────────────

test('SAD: GET /vocabulary without a tenant context is rejected', async ({ request }) => {
  // WHO: an unauthenticated caller, or an authenticated caller who omits tenant_id and
  //      relies on the JWT to provide it but has no tenant claim either.
  // WHAT: the route refuses to return data without resolvable tenant scope.
  //       The exact contract is "requireTenantId returns 400 when no tenant context is
  //       available" — pinned by src/middleware.ts (helper used by /vocabulary).
  // WHEN: an attempt to enumerate vocabulary across the platform via unauthenticated
  //       requests, or a bug in the dashboard that drops tenant context before fetching.
  // WHERE: /vocabulary route's first line — `requireTenantId(req, reply)` short-circuits
  //       before the SQL runs.
  // WHY: vocabulary itself isn't sensitive (labels), but a route that returns data without
  //      tenant resolution is a smell. Pinning the gate keeps the route honest as new
  //      data is appended (e.g., a future addition of system_prompt to the vocab response).
  const res = await request.get(`${BACKEND_URL}/vocabulary`);
  // Either 400 (no tenant context) or 401 (auth required) is acceptable — both fail closed.
  expect([400, 401]).toContain(res.status());
});

// ────────────────────────────────────────────────────────────────────────────
// UI — vocabulary reaches a rendered surface
// ────────────────────────────────────────────────────────────────────────────

test('UI: a salon tenant sees Stylist labels in the Employees view', async ({ page, request }) => {
  // WHO: a super-admin who switched into a salon tenant via the managed-tenant switcher,
  //      or a salon-tenant owner logged in directly.
  // WHAT: the Back Office → My Team → Employees view's h1 reads "Stylists" (vocab.employee_plural)
  //       and the primary "Add Employee" button reads "Add Stylist" (vocab.employee_label).
  // WHEN: every salon-tenant dashboard load. If this E2E breaks, every non-automotive tenant
  //       sees stale "Employees" copy — directly contradicting the UX vocabulary feature.
  // WHERE: dashboard/components/EmployeeManagementView.tsx:150 (h1 heading) +
  //        EmployeeManagementView.tsx:175 (Add button label).
  // WHY: this is the only E2E test that proves /vocabulary → useVocabulary → rendered DOM
  //      works end-to-end. The auth.setup → managedTenantId hop is also exercised here, which
  //      is what super-admins use to switch between tenants for support.
  let tenant: RegisteredTenant | null = null;
  try {
    tenant = await registerFreshTenant(request, 'salon', 'Salon UI');

    // Load the dashboard as the super-admin (storage state inherited from auth.setup),
    // then switch into the new salon tenant via the managed-tenant mechanism the
    // SuperAdminDashboard uses. VocabularyContext respects managedTenantId for super-admins.
    await page.goto('/dashboard');
    await page.evaluate((id: string) => {
      localStorage.setItem('managedTenantId', id);
      localStorage.setItem('managedTenantName', 'Salon UI Test');
    }, tenant.tenantId);
    await page.reload();

    // Navigate to Back Office → My Team → Employees. The dashboard exposes a tab
    // structure where Back Office is the parent and "My Team" leads to a sub-tab list
    // including Employees. URL-driven nav is the stable path.
    await page.goto('/dashboard?tab=my-team&sub=employees');

    // The Employees view renders <h1>{vocab.employee_plural}</h1>. For a salon tenant
    // with no per-tenant override, that resolves to "Stylists".
    const heading = page.locator('h1', { hasText: /Stylists|Employees/ });
    await expect(heading).toBeVisible({ timeout: 10_000 });
    await expect(heading).toHaveText('Stylists', { timeout: 5_000 });

    // The "Add Stylist" button is the second strongest signal — `Add ${vocab.employee_label}`.
    // If managedTenantId switching broke and we fell back to the super-admin's vocab,
    // this would read "Add Employee" and fail.
    const addButton = page.getByRole('button', { name: /Add Stylist|Add Employee/ });
    await expect(addButton.first()).toBeVisible({ timeout: 5_000 });
    await expect(addButton.first()).toHaveText('Add Stylist');
  } finally {
    if (tenant) {
      // Clean up the managedTenantId so the next test doesn't inherit it from
      // the persisted browser context.
      await page
        .evaluate(() => {
          localStorage.removeItem('managedTenantId');
          localStorage.removeItem('managedTenantName');
        })
        .catch(() => {
          /* page may be closed already */
        });
      await cleanTenantData(pool, tenant.tenantId);
    }
  }
});
