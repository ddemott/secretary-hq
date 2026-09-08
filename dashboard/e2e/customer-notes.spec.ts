/**
 * E2E coverage for the customer Internal Notes lifecycle (the "Internal Notes"
 * textarea in the Customers tab detail panel).
 *
 * WHY THIS EXISTS
 * The "Internal Notes" field (stored as `customers.metadata.notes`) is the
 * primary way operators leave private context for the voice AI and for
 * other staff. It is explicitly referenced in the product as feeding the
 * AI ("Add private notes the AI should consider...").
 *
 * As of 2026-05-27 there was zero E2E coverage on this persistence + visibility
 * contract. The only tests were:
 *   - Component test in CustomerDetailPanel.test.tsx (reactivate affordance only)
 *   - Unit tests on the booking path that correctly fold `notes` into metadata
 *     (QuickBookPanel + appointments route)
 *
 * The CRMView → CustomerDetailPanel edit path sends a top-level `notes` field
 * via Api.customers.update. Backend folds it into metadata.notes (the canonical
 * location also used by booking + voice agent). This test pins the contract.
 *
 * SCOPE FOR V1 (this file)
 * - API-driven happy path for note persistence (the contract that matters most)
 * - DB assertion on metadata.notes
 * - Visibility after fetch (simulating what the UI and the future voice context
 *   tool would see)
 * - One sad path: empty note handling
 *
 * NOT COVERED YET (future increment)
 * - Full mouse/keyboard flow: click into Customers tab → select customer →
 *   Edit Info → type in the Internal Notes textarea → Save Changes → assert
 *   the note appears in the read-only view without refresh.
 *   That flow is higher maintenance and currently blocked on confirming the
 *   notes→metadata mapping in handleSave + the PUT route.
 *
 * Follows the same patterns as appointment-cancel-restore.spec.ts and
 * version-history-restore.spec.ts: fresh tenant, explicit data ownership,
 * excellent 5W comments, DB verification, try/finally cleanup via cascade.
 */

import { test, expect } from './helpers/test';
import { type APIRequestContext } from '@playwright/test';
import { Pool } from 'pg';
import {
  BACKEND_URL,
  PG_URL,
  registerFreshTenant,
  createCustomerAs,
  cleanTenantData,
  type RegisteredTenant,
} from './helpers/fixtures';

let pool: Pool;

async function getCustomerNotes(tenantId: string, customerId: string): Promise<string | null> {
  const r = await pool.query(
    `SELECT metadata->>'notes' AS notes
       FROM customers
      WHERE customer_id = $1 AND tenant_id = $2`,
    [customerId, tenantId]
  );
  return r.rows[0]?.notes ?? null;
}

async function updateCustomerNotesViaApi(
  req: APIRequestContext,
  token: string,
  tenantId: string,
  customerId: string,
  notes: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  // This is the exact shape the frontend (CRMView.handleSave) currently sends.
  // Backend now explicitly accepts top-level "notes" (folded into metadata.notes).
  const res = await req.put(`${BACKEND_URL}/customers/${customerId}`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: {
      tenant_id: tenantId,
      notes,
    },
  });
  return { status: res.status(), body: await res.json() };
}

test.beforeAll(() => {
  pool = new Pool({ connectionString: PG_URL });
});

test.afterAll(async () => {
  await pool.end();
});

// ────────────────────────────────────────────────────────────────────────────
// 1. HAPPY: note set via the documented API shape is persisted in metadata
// ────────────────────────────────────────────────────────────────────────────
test('customer-notes-happy: setting notes via the update payload the UI uses stores it in metadata.notes', async ({
  request,
}) => {
  // WHO: front-desk operator or owner editing a customer record in the
  //      Customers tab (CRMView + CustomerDetailPanel)
  // WHAT: PUT /customers/:id with { notes: "some private context" } results
  //       in the value being stored under customers.metadata.notes (the
  //       canonical location also used by the booking path).
  // WHEN: operator saves the Internal Notes textarea (or any future richer
  //       note UI that calls the same update).
  // WHERE: dashboard/components/CRMView.tsx:270 (the payload), backend
  //        src/routes/customers.ts:122 (PUT /customers/:id) + the UPDATE that
  //        writes the metadata column.
  // WHY: without this contract being reliable, notes typed in the UI
  //      disappear on refresh, and the voice agent never sees the context
  //      the operator intended to provide. This is a core trust feature.
  let tenant: RegisteredTenant | null = null;
  let customerId: string | null = null;

  try {
    tenant = await registerFreshTenant(request);
    customerId = await createCustomerAs(
      request,
      tenant.token,
      tenant.tenantId,
      'Note Test Customer'
    );

    const noteText = 'VIP client — prefers morning appointments and always wants the same bay.';

    const updateRes = await updateCustomerNotesViaApi(
      request,
      tenant.token,
      tenant.tenantId,
      customerId,
      noteText
    );

    // Current reality check: if the backend schema strips the top-level notes
    // key, this will return success but the note will not be stored.
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.success).toBe(true);

    const stored = await getCustomerNotes(tenant.tenantId, customerId);
    expect(stored, 'note must be persisted under metadata.notes').toBe(noteText);
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 2. SAD: empty note is accepted but stored as empty / null (no crash)
// ────────────────────────────────────────────────────────────────────────────
test('customer-notes-sad: empty note does not crash and results in empty or null metadata.notes', async ({
  request,
}) => {
  // WHO: operator who clears the Internal Notes field and saves
  // WHAT: the update succeeds (200) and the stored value becomes empty
  //       string or null (no 500, no data corruption).
  // WHEN: the textarea is cleared and Save is clicked.
  // WHERE: same update path as the happy case.
  // WHY: clearing a note is a normal operation; we must not regress into
  //      500s or leave garbage in the JSONB.
  let tenant: RegisteredTenant | null = null;
  let customerId: string | null = null;

  try {
    tenant = await registerFreshTenant(request);
    customerId = await createCustomerAs(
      request,
      tenant.token,
      tenant.tenantId,
      'Empty Note Customer'
    );

    // First set a real note
    await updateCustomerNotesViaApi(
      request,
      tenant.token,
      tenant.tenantId,
      customerId,
      'initial note'
    );

    // Now clear it (the UI will send empty string)
    const clearRes = await updateCustomerNotesViaApi(
      request,
      tenant.token,
      tenant.tenantId,
      customerId,
      ''
    );

    expect(clearRes.status).toBe(200);
    expect(clearRes.body.success).toBe(true);

    const stored = await getCustomerNotes(tenant.tenantId, customerId);
    // Either null (if we jsonb_set to absent) or empty string is acceptable.
    // The important thing is: no crash and no previous value left behind.
    expect([null, ''].includes(stored as any)).toBe(true);
  } finally {
    if (tenant) await cleanTenantData(pool, tenant.tenantId);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 3. UI visibility smoke (Bella's Hair Studio tenant) — proves the read path works
// ────────────────────────────────────────────────────────────────────────────
test('customer-notes-ui-visibility: notes created via API are visible in the Customers detail panel', async ({
  page,
}) => {
  // WHO: operator who previously saved notes (or notes came from import /
  //      booking flow) and now opens the customer record.
  // WHAT: the Internal Notes section in CustomerDetailPanel shows the text
  //       that exists in metadata.notes.
  // WHEN: navigating to the Customers tab and selecting a customer that has
  //       a note.
  // WHERE: CRMView + CustomerDetailPanel.tsx:259-267 (the read-only display
  //        of metadata.notes).
  // WHY: if a note is persisted but never rendered back to the operator,
  //      the feature is useless. This is the minimal UI contract.

  // We use Bella's Hair Studio (seeded demo tenant) + a customer we create in
  // the test (transactional data). This keeps the test independent while still
  // exercising the real rendered UI.
  const BELLA_TENANT_ID = 'b3e1aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const ADMIN_EMAIL = 'bella@bellashair.com';
  const ADMIN_PASSWORD = 'p@ssw0rd';

  // Create a customer with a note directly in the DB for this UI smoke
  // (fast and avoids any auth complexity for the test customer).
  const noteText = 'E2E note visibility test ' + Date.now();
  const phone = `+1555${Math.floor(Math.random() * 1e7)}`;

  const insert = await pool.query(
    `INSERT INTO customers (tenant_id, phone, name, first_name, last_name, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING customer_id`,
    [
      BELLA_TENANT_ID,
      phone,
      'E2E Notes Visibility',
      'E2E',
      'Notes',
      JSON.stringify({ notes: noteText }),
    ]
  );
  const customerId = insert.rows[0].customer_id as string;

  try {
    await page.goto('/dashboard');

    // If not already logged in as Bella's admin, do a lightweight login.
    const loginLink = page.getByText('Log in', { exact: true }).first();
    if (await loginLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loginLink.click();
      await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
      await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
      await page.locator('button[type="submit"]').click();
      await page.waitForLoadState('networkidle').catch(() => {});
    }

    // Switch to Bella's tenant if on super-admin landing
    const bellaCard = page.getByText("Bella's Hair Studio").first();
    if (await bellaCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await bellaCard.click();
    }

    // Navigate to Customers tab with strong wait
    const customersTab = page.getByRole('tab', { name: /^Customers$/ }).first();
    await expect(customersTab).toBeVisible({ timeout: 15000 });
    await customersTab.click();

    // Wait for the customer list to be ready
    const row = page.getByText('E2E Notes Visibility').first();
    await expect(row).toBeVisible({ timeout: 10000 });
    await row.click();

    // The Internal Notes section should now be visible with our text
    const notesSection = page.getByText(noteText).first();
    await expect(notesSection).toBeVisible({ timeout: 8000 });
  } finally {
    // Clean up the customer we created for this smoke
    await pool.query('DELETE FROM customers WHERE customer_id = $1', [customerId]);
  }
});
