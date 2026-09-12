/**
 * Real-DB proof for `findAbandonedTestNumbers()` (scripts/find-abandoned-test-numbers.ts).
 *
 * WHO   — Dale, deciding which Telnyx numbers to stop paying for.
 * WHAT  — the query must find a tenant with a live-but-unused DID and skip
 *         every tenant that is genuinely still in use, by any of the three
 *         signals that mean "this one is real."
 * WHERE — the SQL itself, shared verbatim between the CLI and this test via
 *         the exported `findAbandonedTestNumbers` function — no hand-copied
 *         approximation to drift from the real query.
 * WHY   — a false positive here means Dale reviews (and could release) a
 *         number a real tenant still depends on; a false negative means a
 *         dead number keeps billing forever because nothing ever surfaces it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { type Client } from 'pg';
import {
  getRootClient,
  clearDB,
  createTenant,
  beginTestTransaction,
  rollbackTestTransaction,
  skipIfDbDown,
} from '../utils';
import { findAbandonedTestNumbers } from '../../scripts/find-abandoned-test-numbers';

let root: Client;
let dbAvailable = false;
beforeEach((ctx) => skipIfDbDown(ctx, () => dbAvailable));

beforeAll(async () => {
  try {
    root = await getRootClient();
    dbAvailable = true;
    await clearDB(root);
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (root) await root.end();
});

beforeEach(async () => {
  if (dbAvailable) await beginTestTransaction(root);
});

afterEach(async () => {
  if (dbAvailable) await rollbackTestTransaction(root);
});

async function activatePhone(
  tenantId: string,
  opts: { forwardedFrom?: string; createdDaysAgo?: number } = {}
) {
  await root.query(
    `UPDATE tenants
        SET phone_status = 'active',
            inbound_phone = $2,
            telnyx_phone_number_id = $3,
            forwarded_from_phone = $4,
            created_at = now() - ($5 || ' days')::interval
      WHERE tenant_id = $1`,
    [
      tenantId,
      '+15550001234',
      'txid_' + tenantId.slice(0, 8),
      opts.forwardedFrom ?? null,
      opts.createdDaysAgo ?? 40,
    ]
  );
}

async function callNow(tenantId: string, daysAgo: number) {
  await root.query(
    `INSERT INTO voice_sessions (tenant_id, call_id, status, started_at)
     VALUES ($1, $2, 'completed', now() - ($3 || ' days')::interval)`,
    [tenantId, `call-${tenantId.slice(0, 8)}-${daysAgo}`, daysAgo]
  );
}

describe('findAbandonedTestNumbers', () => {
  it('HAPPY: an active-DID tenant with no forwarding and no recent calls is flagged', async () => {
    if (!dbAvailable) return;
    const t = await createTenant(root, 'Truly Abandoned Co', 'auto-repair', 'America/Chicago');
    await activatePhone(t);

    const rows = await findAbandonedTestNumbers(root, 14);
    expect(rows.map((r) => r.tenant_id)).toContain(t);
    const row = rows.find((r) => r.tenant_id === t)!;
    expect(row.days_since_last_call).toBeNull();
  });

  it('SAD: a tenant with forwarded_from_phone set is a REAL line — never flagged', async () => {
    if (!dbAvailable) return;
    const t = await createTenant(root, 'Real Business Co', 'auto-repair', 'America/Chicago');
    await activatePhone(t, { forwardedFrom: '+15559998888' });

    const rows = await findAbandonedTestNumbers(root, 14);
    expect(rows.map((r) => r.tenant_id)).not.toContain(t);
  });

  it('SAD: a tenant called within the window is still in use — never flagged', async () => {
    if (!dbAvailable) return;
    const t = await createTenant(root, 'Active Test Co', 'auto-repair', 'America/Chicago');
    await activatePhone(t);
    await callNow(t, 2);

    const rows = await findAbandonedTestNumbers(root, 14);
    expect(rows.map((r) => r.tenant_id)).not.toContain(t);
  });

  it('HAPPY: a tenant last called BEFORE the window reopens as abandoned', async () => {
    if (!dbAvailable) return;
    const t = await createTenant(root, 'Gone Quiet Co', 'auto-repair', 'America/Chicago');
    await activatePhone(t);
    await callNow(t, 30);

    const rows = await findAbandonedTestNumbers(root, 14);
    const row = rows.find((r) => r.tenant_id === t);
    expect(row).toBeDefined();
    expect(row!.days_since_last_call).toBeGreaterThanOrEqual(29);
  });

  it('SAD: a soft-deleted tenant is a different cleanup path — never flagged', async () => {
    if (!dbAvailable) return;
    const t = await createTenant(root, 'Deleted Test Co', 'auto-repair', 'America/Chicago');
    await activatePhone(t);
    await root.query('UPDATE tenants SET is_deleted = true WHERE tenant_id = $1', [t]);

    const rows = await findAbandonedTestNumbers(root, 14);
    expect(rows.map((r) => r.tenant_id)).not.toContain(t);
  });

  it('SAD: an inactive/never-provisioned tenant is not billing anything — never flagged', async () => {
    if (!dbAvailable) return;
    const t = await createTenant(root, 'No Phone Co', 'auto-repair', 'America/Chicago');
    // phone_status stays at its default ('inactive') — never activated.

    const rows = await findAbandonedTestNumbers(root, 14);
    expect(rows.map((r) => r.tenant_id)).not.toContain(t);
  });
});
