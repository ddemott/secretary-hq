/**
 * Shared E2E test fixtures — register a fresh tenant + seed the entities a
 * spec needs, all via the real backend HTTP routes (the ones the dashboard
 * calls in production). Single-DELETE cleanup via tenant cascade.
 *
 * Why this exists: pre-2026-05-09 the booking-enforcement spec depended on
 * seed data for its employee/resource lookups. Any seed change — refresh,
 * rename, soft-delete — would silently break the spec without touching the
 * test code. Per the test-isolation feedback memory, each test should own
 * its full data lifecycle: setup → assert → teardown, runs independently
 * of every other test.
 *
 * Pattern (mirrors setup-wizard-to-booking.spec.ts):
 *   1. Test calls registerFreshTenant(request) → unique tenant + admin token.
 *   2. Test calls seedBookingScenario(...) with the entities it needs.
 *   3. Test drives its scenario via request.post(`${BACKEND_URL}/...`).
 *   4. Test cleans up via cleanTenantData(pool, tenantId) in `finally`.
 *
 * Tenant cascade: `tenants.id` is FK'd from every dependent table with
 * ON DELETE CASCADE, so a single DELETE removes all the test's residue
 * (services, resources, employees, customers, schedules, appointments,
 * mappings, integrations). Verified against the schema 2026-05-09.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import type { Pool } from 'pg';

export const BACKEND_URL = process.env.BACKEND_URL ?? 'https://localhost:4001';
export const PG_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';

export interface RegisteredTenant {
  tenantId: string;
  userId: string;
  token: string;
  email: string;
}

export interface SeedBookingScenarioOptions {
  /** Employee names to create. Defaults to a single 'Test Tech'. */
  employees?: string[];
  /** Resource names to create. Defaults to a single 'Test Bay'. */
  resources?: string[];
  /** Customer name to create. Defaults to 'Walk-In Customer'. */
  customer?: string;
  /** YYYY-MM-DD dates to seed shifts on. Defaults to one date 7 days out. */
  shiftDates?: string[];
  /** Shift hours applied to every (employee, date) pair. Defaults 09:00-17:00. */
  shiftHours?: { start: string; end: string };
}

export interface SeededBookingScenario {
  employeeIds: string[];
  resourceIds: string[];
  customerId: string;
  shiftDates: string[];
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

/**
 * Returns a YYYY-MM-DD string `days` days from today (UTC).
 */
export function isoDateDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Hit POST /register to mint a brand-new tenant + admin user. Returns the
 * tenant_id, user_id, JWT token, and the unique email used (in case the
 * test wants to re-login or reference the user).
 *
 * Why automotive: matches a seeded business_templates entry. The wizard
 * normally auto-seeds example_services from the template, but every test
 * that needs services creates them explicitly via createServiceAs() so the
 * auto-seed timing doesn't matter.
 */
export async function registerFreshTenant(req: APIRequestContext): Promise<RegisteredTenant> {
  const suffix = uniqueSuffix();
  const email = `e2e-${suffix}@example.test`;
  const res = await req.post(`${BACKEND_URL}/register`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      business_name: `E2E Test ${suffix}`,
      business_type: 'automotive',
      owner_name: `Owner ${suffix}`,
      email,
      password: 'password123',
      consent_attested: true,
    },
  });
  expect(res.status(), 'register must succeed for a brand-new tenant').toBe(201);
  const body = await res.json();
  expect(body.success).toBe(true);
  return {
    tenantId: body.tenant_id as string,
    userId: body.user_id as string,
    token: body.token as string,
    email,
  };
}

/**
 * Mark a freshly registered user's email as verified, standing in for the
 * click on the emailed /verify-email link (the E2E backend's mailer is a stub,
 * so the link is never readable). POST /billing/checkout refuses unverified
 * owners — see src/routes/billing.ts and migration 20260924000000.
 */
export async function markEmailVerified(pool: Pool, userId: string): Promise<void> {
  const res = await pool.query(
    'UPDATE users SET email_verified_at = NOW() WHERE user_id = $1 AND email_verified_at IS NULL',
    [userId]
  );
  expect(res.rowCount, 'fresh signup must start unverified').toBe(1);
}

/**
 * Start a subscription for a fresh tenant through POST /billing/checkout in
 * STRIPE_FIXTURE_MODE (no Stripe call; the plan is activated locally). Buying a
 * phone number requires a started subscription — the card-required trial gate
 * on POST /provisioning/activate — so Go Live specs call this first.
 */
export async function startSubscriptionViaFixture(
  req: APIRequestContext,
  token: string,
  plan: 'solo' | 'growth' | 'professional' = 'solo'
): Promise<void> {
  const res = await req.post(`${BACKEND_URL}/billing/checkout`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { plan },
  });
  expect(res.status(), 'fixture checkout needs STRIPE_FIXTURE_MODE=true on the backend').toBe(200);
  expect((await res.json()).fixture).toBe(true);
}

/**
 * Create an employee via POST /employees/create. Splits a full name into
 * first + last; if no space, last_name defaults to 'Tech' so the API's
 * required-field validation passes.
 */
export async function createEmployeeAs(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  fullName: string
): Promise<string> {
  const [first, ...rest] = fullName.split(' ');
  const res = await req.post(`${BACKEND_URL}/employees/create`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: {
      tenant_id: tenantId,
      first_name: first,
      last_name: rest.join(' ') || 'Tech',
    },
  });
  expect(res.status(), `employee ${fullName} create must succeed`).toBe(200);
  const body = await res.json();
  return body.employee.employee_id as string;
}

export async function createServiceAs(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  name: string
): Promise<string> {
  const res = await req.post(`${BACKEND_URL}/services/create`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { tenant_id: tenantId, name, duration_minutes: 30 },
  });
  expect(res.status(), `service ${name} create must succeed`).toBe(200);
  const body = await res.json();
  return body.service.service_id as string;
}

export async function createResourceAs(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  name: string
): Promise<string> {
  const res = await req.post(`${BACKEND_URL}/resources/create`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: { tenant_id: tenantId, name },
  });
  expect(res.status(), `resource ${name} create must succeed`).toBe(200);
  const body = await res.json();
  return body.resource.resource_id as string;
}

export async function createCustomerAs(
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
  expect(res.status(), `customer ${name} create must succeed`).toBe(200);
  const body = await res.json();
  return body.customer.customer_id as string;
}

/**
 * Direct INSERT into employee_schedule. Booking RPCs read this table
 * exclusively for shift-coverage, so seeding here is the most precise
 * way to give a test the shift it needs on a specific date — short of
 * driving /shifts/expand-weekly which only covers the next 4 weeks
 * from today and isn't useful for tests that need far-future dates.
 *
 * Uses ON CONFLICT (tenant, employee, date) DO UPDATE so re-running
 * a partially-cleaned-up test in dev doesn't 23505 on a stale row.
 */
export async function seedShift(
  pool: Pool,
  tenantId: string,
  employeeId: string,
  date: string,
  hours: { start: string; end: string }
): Promise<void> {
  // 2026-05-18 pilot #3 dropped employee_schedule.employee_schedule_id;
  // the composite (tenant_id, employee_id, shift_date) IS the identity.
  // Callers that need to reference the row (delete in afterAll, etc.)
  // use those three columns directly — they passed them to us, so they
  // already have them.
  await pool.query(
    `INSERT INTO employee_schedule (tenant_id, employee_id, shift_date, start_time, end_time, is_off)
       VALUES ($1, $2, $3, $4, $5, false)
       ON CONFLICT (tenant_id, employee_id, shift_date)
         DO UPDATE SET start_time = EXCLUDED.start_time,
                       end_time   = EXCLUDED.end_time,
                       is_off     = false`,
    [tenantId, employeeId, date, hours.start, hours.end]
  );
}

/**
 * Seed the entities a booking-scenario test typically needs:
 *   - N employees (default 1)
 *   - M resources (default 1)
 *   - 1 customer
 *   - shifts for every (employee, shiftDate) pair, default one date 7 days out
 *
 * Returns the IDs in stable order so tests can `const [mike, carlos] = ...`.
 * Pool is required for shift seeding (booking RPCs read employee_schedule
 * directly; there's no /shifts/create-on-date route by design — date-specific
 * shifts are managed via the dashboard's Schedule tab UI which posts to
 * /shifts/overrides; expand-weekly only covers the next 4 weeks).
 */
export async function seedBookingScenario(
  req: APIRequestContext,
  pool: Pool,
  token: string,
  tenantId: string,
  options: SeedBookingScenarioOptions = {}
): Promise<SeededBookingScenario> {
  const employeeNames = options.employees ?? ['Test Tech'];
  const resourceNames = options.resources ?? ['Test Bay'];
  const customerName = options.customer ?? 'Walk-In Customer';
  const shiftDates = options.shiftDates ?? [isoDateDaysFromNow(7)];
  const hours = options.shiftHours ?? { start: '09:00', end: '17:00' };

  const employeeIds: string[] = [];
  for (const name of employeeNames) {
    employeeIds.push(await createEmployeeAs(req, token, tenantId, name));
  }
  const resourceIds: string[] = [];
  for (const name of resourceNames) {
    resourceIds.push(await createResourceAs(req, token, tenantId, name));
  }
  const customerId = await createCustomerAs(req, token, tenantId, customerName);

  for (const empId of employeeIds) {
    for (const date of shiftDates) {
      await seedShift(pool, tenantId, empId, date, hours);
    }
  }

  return { employeeIds, resourceIds, customerId, shiftDates };
}

/**
 * Single-statement teardown. The tenants table cascades to every
 * dependent row (verified against the schema 2026-05-09): users,
 * services, resources, employees, customers, employee_schedule,
 * appointments, service_employee, service_resource, knowledge_base
 * docs, integrations, etc. So one DELETE removes all of the test's residue.
 */
export async function cleanTenantData(
  pool: Pool,
  tenantId: string,
  maxAttempts = 5
): Promise<void> {
  // RETRY ON DEADLOCK (40P01). This is not defensive padding — it fixes a real,
  // reproducible AB-BA lock cycle that failed CI roughly one run in two and read
  // exactly like flake (PR #242, run 29220656800):
  //
  //   Booking routes seed reminders FIRE-AND-FORGET:
  //       void scheduleRemindersForAppointment(...)
  //   so the INSERT into reminder_schedules is STILL RUNNING after the HTTP
  //   response returned and the spec has moved on to teardown.
  //
  //   That INSERT takes FK locks:  tenants ──▶ appointments
  //   This cascading DELETE takes: appointments ──▶ tenants
  //
  //   Opposite order. Each waits on what the other holds; Postgres kills one AT
  //   RANDOM. When it picks the DELETE, teardown explodes. The randomness IS the
  //   "flake". Proved deterministically in
  //   tests/regression/tenantDeleteDeadlock.realdb.test.ts.
  //
  // Retry is the correct remedy, not a workaround: a deadlock is a transient
  // scheduling accident, not a logic error. One transaction is killed precisely
  // so the other can make progress, and the killed statement is perfectly valid
  // the instant it is retried. Postgres's own docs say applications should be
  // prepared to retry transactions aborted by deadlock.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query('DELETE FROM tenants WHERE tenant_id = $1', [tenantId]);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '40P01' || attempt === maxAttempts) throw err;
      // Back off so the racing fire-and-forget insert can finish and release.
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

/**
 * Convenience: POST /appointments/create and return { status, body } so
 * tests can assert on the conflict block returned at 409 without
 * unwrapping the response themselves.
 */
export async function bookAppointmentAs(
  req: APIRequestContext,
  token: string,
  payload: {
    tenant_id: string;
    resource_id: string;
    customer_id: string;
    employee_id?: string | null;
    start_time: string;
    end_time: string;
    description: string;
    location?: string | null;
    service_id?: string | null;
  }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await req.post(`${BACKEND_URL}/appointments/create`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: payload,
  });
  return { status: res.status(), body: await res.json() };
}

/**
 * Convenience: POST /appointments/:id/update and return { status, body }.
 * Used by the edit-overlap scenario to verify symmetric conflict handling
 * on the update path.
 */
export async function updateAppointmentAs(
  req: APIRequestContext,
  token: string,
  appointmentId: string,
  payload: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await req.post(`${BACKEND_URL}/appointments/${appointmentId}/update`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: payload,
  });
  return { status: res.status(), body: await res.json() };
}

/**
 * Convenience: direct INSERT of a scheduled appointment for tests that
 * need a "blocker" row pre-existing before the test's actual booking
 * attempt. Tests own this row's cleanup via cleanTenantData() (cascades).
 */
export async function seedAppointment(
  pool: Pool,
  tenantId: string,
  params: {
    resourceId: string;
    customerId: string;
    employeeId: string | null;
    startTime: string;
    endTime: string;
    description: string;
  }
): Promise<string> {
  const res = await pool.query(
    `INSERT INTO appointments (tenant_id, resource_id, customer_id, employee_id, start_time, end_time, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'scheduled')
       RETURNING appointment_id`,
    [
      tenantId,
      params.resourceId,
      params.customerId,
      params.employeeId,
      params.startTime,
      params.endTime,
      params.description,
    ]
  );
  return res.rows[0].appointment_id as string;
}
