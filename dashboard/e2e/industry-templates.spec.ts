/**
 * E2E coverage for the 5-industry-template invariant: every business_type
 * in the wizard's industry list (salon, mobile-tire, auto-shop, barbershop,
 * plus the "no-template-row" fallback case) produces a tenant that can
 * register → finalize → book without per-template glue code.
 *
 * Why this exists: `docs/TODO.md` P2 "All 5 industry templates produce a
 * working setup" — only `automotive` is exercised end-to-end today via
 * `setup-wizard-to-booking.spec.ts`. The other industry-YAML bundles
 * (salon_v1, mobile_tire_v1, auto_bays_v1, ai_platform_v1) have distinct
 * vocab + system-prompt defaults at the `business_templates` DB layer, and
 * the wizard's auto-seeded defaults differ accordingly. A regression where
 * (say) the salon template's vocab integration silently breaks would have
 * shipped to a beta salon customer before the existing automotive test
 * had any reason to fail.
 *
 * Coverage shape per business_type:
 *   - register with the business_type → tenant created
 *   - GET /vocabulary returns the template's labels (or the hardcoded
 *     defaults for the no-template-row fallback case)
 *   - drive the finalize sequence (services + resource + employee +
 *     mappings + expand-weekly)
 *   - book an appointment → succeeds with appointment_id
 *
 * The matrix:
 *   - salon (template defines Chair/Stylist vocab)
 *   - mobile-tire (Truck/Technician)
 *   - auto-shop (Bay/Mechanic) — the closest match to auto_bays_v1
 *   - barbershop (Chair/Barber) — second non-salon hair-vertical for
 *     cross-template defense (catches a regression where salon's vocab
 *     leaks to barbershop or vice versa)
 *   - automotive (no business_templates row) — proves the hardcoded
 *     fallback path still works; this is the shape ai_platform_v1 also
 *     hits (no DB template row, falls through to defaults)
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

function isoDateDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fullWeekPattern() {
  return Array.from({ length: 7 }, (_, dow) => ({
    day_of_week: dow,
    start_time: '08:00',
    end_time: '18:00',
  }));
}

interface RegisteredTenant {
  tenantId: string;
  token: string;
  ownerName: string;
}

interface IndustryCase {
  /** business_type sent to /register (matches business_templates.business_type when applicable) */
  businessType: string;
  /** human label for the test name */
  industry: string;
  /** Expected vocabulary labels from /vocabulary. If undefined, hardcoded defaults expected. */
  expectedVocab?: {
    resource_label: string;
    employee_label: string;
  };
}

const INDUSTRY_CASES: IndustryCase[] = [
  {
    businessType: 'salon',
    industry: 'salon (salon_v1)',
    expectedVocab: { resource_label: 'Chair', employee_label: 'Stylist' },
  },
  {
    businessType: 'mobile-tire',
    industry: 'mobile-tire (mobile_tire_v1)',
    expectedVocab: { resource_label: 'Truck', employee_label: 'Technician' },
  },
  {
    businessType: 'auto-shop',
    industry: 'auto-shop (auto_bays_v1)',
    expectedVocab: { resource_label: 'Bay', employee_label: 'Mechanic' },
  },
  {
    businessType: 'barbershop',
    industry: 'barbershop (cross-template guard)',
    expectedVocab: { resource_label: 'Chair', employee_label: 'Barber' },
  },
  {
    businessType: 'automotive',
    industry: 'automotive (hardcoded-defaults fallback — ai_platform_v1 shape)',
    // No business_templates row for 'automotive' → hardcoded fallback expected.
    expectedVocab: { resource_label: 'Resource', employee_label: 'Employee' },
  },
];

async function registerTenant(
  req: APIRequestContext,
  businessType: string,
  industryLabel: string
): Promise<RegisteredTenant> {
  const suffix = uniqueSuffix();
  const ownerName = `Owner ${suffix}`;
  const res = await req.post(`${BACKEND_URL}/register`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      business_name: `${industryLabel} ${suffix}`,
      business_type: businessType,
      owner_name: ownerName,
      email: `industry-${businessType}-${suffix}@example.test`,
      password: 'password123',
      consent_attested: true,
    },
  });
  expect(res.status(), `register for business_type=${businessType}`).toBe(201);
  const body = await res.json();
  return {
    tenantId: body.tenant_id as string,
    token: body.token as string,
    ownerName,
  };
}

async function createService(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  name: string
): Promise<string> {
  const res = await req.post(`${BACKEND_URL}/services/create`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { tenant_id: tenantId, name, duration_minutes: 30 },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return body.service.service_id as string;
}

async function createResource(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  name: string
): Promise<string> {
  const res = await req.post(`${BACKEND_URL}/resources/create`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { tenant_id: tenantId, name },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return body.resource.resource_id as string;
}

async function createEmployee(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  ownerName: string
): Promise<string> {
  const parts = ownerName.split(' ');
  const res = await req.post(`${BACKEND_URL}/employees/create`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: {
      tenant_id: tenantId,
      first_name: parts[0] || 'Owner',
      last_name: parts.slice(1).join(' ') || '',
      skills: [],
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return body.employee.employee_id as string;
}

async function assignMappings(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  serviceId: string,
  employeeId: string,
  resourceId: string
): Promise<void> {
  const e = await req.post(`${BACKEND_URL}/services/${serviceId}/employees/${employeeId}/assign`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { tenant_id: tenantId },
  });
  expect(e.status()).toBe(200);
  const r = await req.post(`${BACKEND_URL}/services/${serviceId}/resources/${resourceId}/assign`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { tenant_id: tenantId },
  });
  expect(r.status()).toBe(200);
}

async function expandWeekly(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  employeeId: string
): Promise<void> {
  const res = await req.post(`${BACKEND_URL}/shifts/expand-weekly`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { tenant_id: tenantId, employee_id: employeeId, pattern: fullWeekPattern() },
  });
  expect(res.status()).toBe(200);
}

async function createCustomer(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  name: string
): Promise<string> {
  const phone = `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
  const res = await req.post(`${BACKEND_URL}/customers/create`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { tenant_id: tenantId, name, phone },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return body.customer.customer_id as string;
}

test.beforeAll(() => {
  pool = new Pool({ connectionString: PG_URL });
});
test.afterAll(async () => {
  await pool.end();
});

// One test per industry case. Playwright's test.describe.serial isn't needed —
// workers:1 in playwright.config.ts already serializes everything.
for (const c of INDUSTRY_CASES) {
  test(`${c.industry}: register → vocabulary → finalize → book`, async ({ request }) => {
    // WHO: a beta customer registering with business_type=${c.businessType}.
    //      First-morning UX from "fill in the registration form" to "book
    //      a real customer" must hold for every industry vertical we ship —
    //      not just automotive (the only one previously E2E'd).
    // WHAT: full register → vocab-fetch → wizard-finalize → book pipeline
    //       on a fresh tenant. Each step asserts its own contract:
    //       /register returns 201, /vocabulary returns the expected labels,
    //       /appointments/create returns 200 + appointment_id.
    // WHEN: every wave of business_templates changes. A regression that
    //       drops a template row or breaks the COALESCE join in /vocabulary
    //       would fail HERE for the affected industry — and the test name
    //       (`${c.industry}: ...`) names exactly which vertical broke.
    // WHERE: cross-cuts /register → /vocabulary → /services/create →
    //        /resources/create → /employees/create → /services/:id/...assign
    //        → /shifts/expand-weekly → /appointments/create. The first
    //        complete-loop test for this many industries.
    // WHY: per the docs/TODO.md P2 entry, salon/mobile_tire/auto_bays/ai_platform
    //      "have setup-wizard differences that aren't pinned by E2E." A
    //      beta-blocker if a non-automotive customer tries to onboard and
    //      hits an industry-specific regression we never tested for.
    let tenant: RegisteredTenant | null = null;
    try {
      tenant = await registerTenant(request, c.businessType, c.industry);

      // Vocabulary check — proves the template defaults flow end-to-end.
      const vocabRes = await request.get(`${BACKEND_URL}/vocabulary?tenant_id=${tenant.tenantId}`, {
        headers: { Authorization: `Bearer ${tenant.token}` },
      });
      expect(vocabRes.status()).toBe(200);
      const vocab = await vocabRes.json();
      if (c.expectedVocab) {
        expect(vocab.resource_label).toBe(c.expectedVocab.resource_label);
        expect(vocab.employee_label).toBe(c.expectedVocab.employee_label);
      }

      // Finalize sequence — mirrors what SoloWizard / SetupWizard fire.
      const svcId = await createService(request, tenant.token, tenant.tenantId, 'Sample Service');
      const resourceId = await createResource(
        request,
        tenant.token,
        tenant.tenantId,
        'Sample Resource'
      );
      const employeeId = await createEmployee(
        request,
        tenant.token,
        tenant.tenantId,
        tenant.ownerName
      );
      await assignMappings(request, tenant.token, tenant.tenantId, svcId, employeeId, resourceId);
      await expandWeekly(request, tenant.token, tenant.tenantId, employeeId);

      // Book an appointment. The slot is +7 days, on a Tuesday-ish to
      // avoid weekend-related calendar quirks. Pattern is Mon-Sun, so
      // any weekday works.
      const customerId = await createCustomer(request, tenant.token, tenant.tenantId, 'Walk-In');
      const bookDate = isoDateDaysFromNow(7);
      const bookRes = await request.post(`${BACKEND_URL}/appointments/create`, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant.token}` },
        data: {
          tenant_id: tenant.tenantId,
          service_id: svcId,
          resource_id: resourceId,
          customer_id: customerId,
          employee_id: employeeId,
          start_time: `${bookDate}T14:00:00.000Z`,
          end_time: `${bookDate}T14:30:00.000Z`,
          description: `industry=${c.businessType} booking`,
        },
      });
      const body = await bookRes.json();
      expect(bookRes.status(), `book for ${c.industry}`).toBe(200);
      expect(body.success).toBe(true);
      expect(body.appointment_id ?? body.appointment?.id).toBeTruthy();
    } finally {
      if (tenant) {
        // service_employee.tenant_id_fkey now CASCADEs (migration
        // 20260513000000), but service_resource has always CASCADEd —
        // a plain DELETE FROM tenants takes care of both. Keep the
        // defensive junction-cleanup as a fallback so the test runs
        // green even against DBs that haven't received 20260513000000
        // yet (e.g., a co-worker's clone before bootstrap).
        await pool
          .query('DELETE FROM service_employee WHERE tenant_id = $1', [tenant.tenantId])
          .catch(() => {
            /* ok */
          });
        await cleanTenantData(pool, tenant.tenantId);
      }
    }
  });
}
