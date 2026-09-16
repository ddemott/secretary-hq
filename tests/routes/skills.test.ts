/**
 * Route-handler tests for src/routes/skills.ts.
 *
 * Skills use a composite PK (tenant_id, name) — the surrogate UUID was dropped
 * in the 2026-05-18 composite-key retrofit pilot #2. DELETE routes on :name
 * (slug) instead of a UUID, so there is no UUID guard here.
 *
 * Coverage targets:
 *   - GET /skills happy path — list scoped to caller's tenant
 *   - POST /skills/create happy path — normalized name stored + returned
 *   - POST /skills/create validation failures — missing name, short name
 *   - DELETE /skills/:name success
 *   - DELETE /skills/:name 404 when name not found
 *   - DELETE /skills/:name 401 when no tenant context
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerSkillRoutes } from '../../src/routes/skills';
import { buildRouteTestApp, type RouteTestAppHandle } from '../mock';

const TENANT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let handle: RouteTestAppHandle;
let app: FastifyInstance;

beforeAll(async () => {
  handle = buildRouteTestApp((app, pool, withTenantClient) => {
    registerSkillRoutes(app, pool, withTenantClient);
  });
  app = handle.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  handle.queries.length = 0;
  handle.queryResponses.length = 0;
  handle.tenantIdOverride.current = null;
  handle.auth.current = {
    user_id: '00000000-0000-0000-0000-000000000001',
    tenant_id: TENANT_ID,
    email: 'owner@test.local',
    role: 'owner',
  };
});

// ────────────────────────────────────────────────────────────────────
// GET /skills
// ────────────────────────────────────────────────────────────────────

describe('GET /skills', () => {
  it('HAPPY: returns skills scoped to the caller tenant', async () => {
    // WHO: tenant owner loading the Skills section in My Team
    // WHAT: SELECT * FROM tenant_skills WHERE tenant_id = $1 ORDER BY name
    // WHEN: dashboard mounts the skills list
    // WHERE: GET /skills handler
    // WHY: without the tenant_id filter, one tenant could see another's skill labels
    handle.queryResponses.push({
      rows: [
        { tenant_id: TENANT_ID, name: 'alignment', description: 'Wheel alignment' },
        { tenant_id: TENANT_ID, name: 'tire-install', description: null },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/skills' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0].name).toBe('alignment');

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(1);
    expect(dataQueries[0].text).toContain('FROM tenant_skills WHERE tenant_id = $1');
    expect(dataQueries[0].params).toEqual([TENANT_ID]);
  });
});

// ────────────────────────────────────────────────────────────────────
// POST /skills/create
// ────────────────────────────────────────────────────────────────────

describe('POST /skills/create', () => {
  it('HAPPY: normalizes skill name and returns created row', async () => {
    // WHO: tenant owner adding a new skill via the Skills form
    // WHAT: INSERT with name normalized to lowercase-dashes; Zod validates input
    // WHEN: Skills form submit
    // WHERE: POST /skills/create handler
    // WHY: name normalization (toLowerCase+trim+dashes) must be applied at INSERT
    //       time; if bypassed, raw user input would pollute the composite PK
    handle.queryResponses.push({
      rows: [{ tenant_id: TENANT_ID, name: 'tire-install', description: 'Full mount and balance' }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/skills/create',
      payload: {
        tenant_id: TENANT_ID,
        name: '  Tire Install  ',
        description: 'Full mount and balance',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.skill.name).toBe('tire-install');

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(1);
    expect(dataQueries[0].text).toContain('INSERT INTO tenant_skills');
    // normalized name: lowercase + trim + spaces→dashes
    expect(dataQueries[0].params[1]).toBe('tire-install');
  });

  it('SAD: returns 400 when name is missing', async () => {
    // WHO: a buggy client submitting an incomplete payload
    // WHAT: Zod safeParse fails on missing required 'name'
    // WHEN: create request with no name field
    // WHERE: CreateSkillSchema.safeParse check at the top of the handler
    // WHY: without Zod validation, missing name would reach Postgres as NULL
    //       and crash with a NOT NULL constraint error (500), not a clean 400
    const res = await app.inject({
      method: 'POST',
      url: '/skills/create',
      payload: { tenant_id: TENANT_ID },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Validation failed');

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
  });

  it('SAD: returns 400 when tenant_id is not a UUID', async () => {
    // WHO: client sending a malformed tenant identifier
    // WHAT: Zod rejects non-UUID tenant_id before any DB call
    // WHEN: create request where tenant_id fails uuid() check
    // WHERE: CreateSkillSchema — tenant_id: z.string().uuid()
    // WHY: a non-UUID tenant_id would either fail the RLS SET LOCAL or crash Postgres
    const res = await app.inject({
      method: 'POST',
      url: '/skills/create',
      payload: { tenant_id: 'not-a-uuid', name: 'tire-install' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
  });

  it('SECURITY: a front-desk user is rejected 403 before any query runs', async () => {
    handle.auth.current = {
      user_id: '00000000-0000-0000-0000-000000000002',
      tenant_id: TENANT_ID,
      email: 'frontdesk@test.local',
      role: 'front_desk',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/skills/create',
      payload: { tenant_id: TENANT_ID, name: 'tire-install' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// DELETE /skills/:name
// ────────────────────────────────────────────────────────────────────

describe('DELETE /skills/:name', () => {
  it('HAPPY: deletes skill and returns success', async () => {
    // WHO: tenant owner removing a skill that is no longer offered
    // WHAT: DELETE FROM tenant_skills WHERE tenant_id = $1 AND name = $2 RETURNING name
    // WHEN: delete button in the Skills list confirmed
    // WHERE: DELETE /skills/:name handler
    // WHY: the returning clause drives the 404 vs 200 branch — without it,
    //       a delete of a non-existent name would silently return success
    handle.queryResponses.push({ rows: [{ name: 'tire-install' }] });

    const res = await app.inject({ method: 'DELETE', url: '/skills/tire-install' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(1);
    expect(dataQueries[0].text).toContain('DELETE FROM tenant_skills');
    expect(dataQueries[0].text).toContain('AND name = $2');
    expect(dataQueries[0].params).toEqual([TENANT_ID, 'tire-install']);
  });

  it('SAD: returns 404 when skill name not found', async () => {
    // WHO: dashboard user retrying a delete that already completed (stale UI state)
    // WHAT: DELETE returns 0 rows → RETURNING is empty → handler sends 404
    // WHEN: delete request for a name that does not exist in tenant_skills
    // WHERE: `if (res.rows.length === 0)` branch in DELETE handler
    // WHY: the 404 lets the dashboard surface a clear "already deleted" message
    //       instead of silently treating a no-op as a success
    handle.queryResponses.push({ rows: [] });

    const res = await app.inject({ method: 'DELETE', url: '/skills/nonexistent-skill' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ success: false, error: 'Skill not found' });
  });

  it('SAD: returns 401 when no tenant context', async () => {
    // WHO: an unauthenticated request (stale session, missing JWT)
    // WHAT: requireTenantId() returns null → handler short-circuits
    // WHEN: DELETE with no auth context
    // WHERE: requireTenantId() guard at the top of the delete handler
    // WHY: without the guard, tenantId would be undefined and the DELETE
    //       WHERE clause would fail to scope to any tenant
    handle.auth.current = null;
    handle.tenantIdOverride.current = null;

    const res = await app.inject({ method: 'DELETE', url: '/skills/tire-install' });

    expect(res.statusCode).toBe(401);
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
  });

  it('SECURITY: a front-desk user is rejected 403 before any query runs', async () => {
    handle.auth.current = {
      user_id: '00000000-0000-0000-0000-000000000002',
      tenant_id: TENANT_ID,
      email: 'frontdesk@test.local',
      role: 'front_desk',
    };

    const res = await app.inject({ method: 'DELETE', url: '/skills/tire-install' });

    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);
    const dataQueries = handle.queries.filter(
      (q) => !q.text.startsWith('SET LOCAL') && !q.text.startsWith('RESET')
    );
    expect(dataQueries).toHaveLength(0);
  });
});
