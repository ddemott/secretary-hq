/**
 * WHO: anyone hitting the PUBLIC POST /call-simulator/start (no auth, rate-limited only)
 * WHAT: activeTenantExists() — the real-Postgres check that decides whether the
 *       simulator may dispatch a billable agent session for a named tenant
 * WHEN: a tenant_id is supplied in the request body
 * WHERE: src/routes/callerSimulator.ts
 * WHY: the route test mocks this check; only a real query proves soft-deleted
 *      and unknown tenants are actually refused (2026-09-20 audit finding).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type Client } from 'pg';
import { getRootClient, skipIfDbDown } from '../utils';
import { activeTenantExists } from '../../src/routes/callerSimulator';
import { closePool } from '../../src/database';

let setup: Client;
let dbAvailable = false;
const tenantsToClean: string[] = [];

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (setup) {
    for (const id of tenantsToClean) {
      await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
    }
    await setup.end();
  }
  await closePool().catch(() => {});
});

beforeEach((ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
});

describe('activeTenantExists (real Postgres)', () => {
  it('HAPPY: an existing, live tenant is allowed', async () => {
    const res = await setup.query(
      'INSERT INTO tenants (name, business_type) VALUES ($1, $2) RETURNING tenant_id',
      [`SimTenantLive ${Date.now()}`, 'salon']
    );
    const id = res.rows[0].tenant_id as string;
    tenantsToClean.push(id);

    expect(await activeTenantExists(id)).toBe(true);
  });

  it('SAD: a soft-deleted tenant is refused', async () => {
    const res = await setup.query(
      'INSERT INTO tenants (name, business_type, is_deleted) VALUES ($1, $2, true) RETURNING tenant_id',
      [`SimTenantDeleted ${Date.now()}`, 'salon']
    );
    const id = res.rows[0].tenant_id as string;
    tenantsToClean.push(id);

    expect(await activeTenantExists(id)).toBe(false);
  });

  it('SAD: a well-formed but unknown tenant id is refused', async () => {
    expect(await activeTenantExists('11111111-2222-4333-8444-555555555555')).toBe(false);
  });
});
