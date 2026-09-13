/**
 * Real-DB companion for POST /tenants/:id/update-config.
 *
 * Motivation: this route is the backend the dashboard "Voice Settings" page
 * (AIConfigView) saves to, and it does three things a mocked test can't prove
 * against real Postgres:
 *   1. PARTIAL-UPDATE SAFETY — a body that omits a field must keep the prior DB
 *      value (undefined → keep, explicit null → clear). A column/type drift or a
 *      COALESCE mistake would silently wipe a hand-tuned persona.
 *   2. BUSINESS-TYPE RESEED CLEANUP — changing business_type DELETEs only the
 *      wizard-auto-seeded rows (is_auto_seeded = true) and PRESERVES user-typed
 *      rows. Destructive; must be exact.
 *   3. LOOP-GUARD ROLLBACK — a transfer number equal to the forwarded-from line
 *      is rejected 400 and the transaction rolls back (row unchanged).
 *
 * 5W for sad-path failures:
 *   WHO  — an owner saving their AI persona / call-forwarding config
 *   WHAT — POST /tenants/:id/update-config
 *   WHEN — every save from the Voice Settings page
 *   WHERE — tenants.ts update-config transaction (partial-merge + reseed + loop guard)
 *   WHY  — a silent field wipe or a preserved auto-seed row corrupts the tenant's setup
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Client, Pool } from 'pg';
import { API_DB_URL, getRootClient, createTenant, skipIfDbDown } from '../utils';
import { createWithTenantClient } from '../../src/database';
import { registerTenantRoutes } from '../../src/routes/tenants';

type TenantRequest = FastifyRequest & {
  tenantId?: string;
  auth?: { tenant_id: string; user_id: string; email: string; role: 'owner' | 'front_desk' };
};

let setup: Client;
let pool: Pool;
let app: FastifyInstance;
let dbAvailable = false;
const tenantsToClean: string[] = [];

beforeAll(async () => {
  try {
    setup = await getRootClient();
    await setup.query('SELECT 1');
    pool = new Pool({ connectionString: API_DB_URL, max: 5 });

    app = Fastify({ logger: false });
    // Mirror the prod auth contract: the JWT preHandler sets req.auth. The
    // route allows a self-tenant update when req.auth.tenant_id === :id, so the
    // header tenant must equal the URL tenant for a 200.
    app.addHook('preHandler', async (request: TenantRequest) => {
      const tid = request.headers['x-tenant-id'] as string | undefined;
      if (tid) {
        request.tenantId = tid;
        request.auth = {
          tenant_id: tid,
          user_id: '55555555-5555-4555-8555-555555555555',
          email: 'realdb-tenants@example.com',
          role: 'owner',
        };
      }
    });
    const withTenantClient = createWithTenantClient(pool);
    registerTenantRoutes(app, pool, withTenantClient);
    await app.ready();
    dbAvailable = true;
  } catch (err) {
    console.warn('[tenants.realdb.test] DB not available, skipping', err);
  }
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (setup) {
    // ON DELETE CASCADE on tenant FKs cleans services/resources too.
    for (const id of tenantsToClean) {
      await setup.query('DELETE FROM tenants WHERE tenant_id = $1', [id]).catch(() => {});
    }
    await setup.end();
  }
});

beforeEach((ctx) => {
  skipIfDbDown(ctx, () => dbAvailable);
});

/** Provision an isolated throwaway tenant so each destructive test owns its data. */
async function freshTenant(name: string, businessType = 'salon'): Promise<string> {
  const id = await createTenant(setup, name, businessType);
  tenantsToClean.push(id);
  return id;
}

function hdr(tenantId: string) {
  return { 'x-tenant-id': tenantId };
}

describe('POST /tenants/:id/update-config → real DB', () => {
  it('HAPPY: a save persists the changed fields', async () => {
    const id = await freshTenant('Tenants Realdb Happy');
    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${id}/update-config`,
      headers: hdr(id),
      payload: { system_prompt: 'You are Nova.', default_buffer_minutes: 15 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const row = await setup.query(
      'SELECT system_prompt, default_buffer_minutes FROM tenants WHERE tenant_id = $1',
      [id]
    );
    expect(row.rows[0].system_prompt).toBe('You are Nova.');
    expect(row.rows[0].default_buffer_minutes).toBe(15);
  });

  it('PARTIAL-UPDATE: a body omitting a field keeps the prior DB value', async () => {
    // WHY: the AIConfigView client sends the whole form, but the route supports
    // partial merge (undefined → keep prior). A regression here would let a save
    // that touches only the buffer silently blank out the tenant's system_prompt,
    // voice, and forward number. Send ONLY default_buffer_minutes and prove the
    // rest survive.
    const id = await freshTenant('Tenants Realdb Partial');
    await setup.query(
      `UPDATE tenants
         SET system_prompt = 'KEEP THIS PROMPT',
             tts_voice = 'onyx',
             forward_phone = '+16085550001',
             save_preferences_enabled = true
       WHERE tenant_id = $1`,
      [id]
    );

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${id}/update-config`,
      headers: hdr(id),
      payload: { default_buffer_minutes: 30 },
    });
    expect(res.statusCode).toBe(200);

    const row = await setup.query(
      `SELECT system_prompt, tts_voice, forward_phone, save_preferences_enabled, default_buffer_minutes
         FROM tenants WHERE tenant_id = $1`,
      [id]
    );
    const t = row.rows[0];
    expect(t.system_prompt).toBe('KEEP THIS PROMPT');
    expect(t.tts_voice).toBe('onyx');
    expect(t.forward_phone).toBe('+16085550001');
    expect(t.save_preferences_enabled).toBe(true);
    expect(t.default_buffer_minutes).toBe(30); // the one field we changed
  });

  it('RESEED: changing business_type deletes only auto-seeded services/resources', async () => {
    // WHY: the wizard re-seeds template defaults on a business_type switch, so
    // stale auto-seeded rows must be purged — but a customer's own hand-typed
    // service/resource (is_auto_seeded = false) must NEVER be deleted. This is
    // the destructive branch; it runs on an isolated tenant.
    const id = await freshTenant('Tenants Realdb Reseed', 'salon');
    await setup.query(
      `INSERT INTO services (tenant_id, name, duration_minutes, is_auto_seeded)
         VALUES ($1, 'auto-seeded-cut', 30, true), ($1, 'hand-typed-cut', 45, false)`,
      [id]
    );
    await setup.query(
      `INSERT INTO resources (tenant_id, name, is_auto_seeded)
         VALUES ($1, 'auto-seeded-chair', true), ($1, 'hand-typed-chair', false)`,
      [id]
    );

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${id}/update-config`,
      headers: hdr(id),
      payload: { business_type: 'automotive' },
    });
    expect(res.statusCode).toBe(200);

    // Membership, not exact list: creating a salon tenant fires a template
    // trigger that seeds a starter resource ("Styling Station 1") with
    // is_auto_seeded = false, so it legitimately survives the switch. Assert on
    // the rows THIS test owns: our auto-seeded row is purged, our hand-typed
    // row is preserved.
    const svc = await setup.query('SELECT name FROM services WHERE tenant_id = $1', [id]);
    const svcNames = svc.rows.map((r) => r.name);
    expect(svcNames).toContain('hand-typed-cut'); // user-typed preserved
    expect(svcNames).not.toContain('auto-seeded-cut'); // auto-seeded purged

    const rsc = await setup.query('SELECT name FROM resources WHERE tenant_id = $1', [id]);
    const rscNames = rsc.rows.map((r) => r.name);
    expect(rscNames).toContain('hand-typed-chair');
    expect(rscNames).not.toContain('auto-seeded-chair');

    const biz = await setup.query('SELECT business_type FROM tenants WHERE tenant_id = $1', [id]);
    expect(biz.rows[0].business_type).toBe('automotive');
  });

  it('LOOP-GUARD: forward == forwarded-from is rejected 400 and rolls back (row unchanged)', async () => {
    // WHY: routing the live transfer to the very line that forwards INTO the AI
    // loops the call back to the assistant. The route rejects it 400 and rolls
    // the transaction back — the prior forward_phone must be untouched.
    const id = await freshTenant('Tenants Realdb Loop');
    await setup.query(`UPDATE tenants SET forward_phone = '+16085559999' WHERE tenant_id = $1`, [
      id,
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${id}/update-config`,
      headers: hdr(id),
      payload: { forward_phone: '+16085550001', forwarded_from_phone: '+16085550001' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/loop/i);

    const row = await setup.query(
      'SELECT forward_phone, forwarded_from_phone FROM tenants WHERE tenant_id = $1',
      [id]
    );
    expect(row.rows[0].forward_phone).toBe('+16085559999'); // rollback: prior kept
    expect(row.rows[0].forwarded_from_phone).toBeNull(); // never written
  });

  it('AUTH: a cross-tenant update is rejected 403', async () => {
    // WHY: req.auth.tenant_id must match the :id (or be super-admin). A mismatch
    // is a cross-tenant write attempt — the isolation boundary.
    const id = await freshTenant('Tenants Realdb Auth');
    const res = await app.inject({
      method: 'POST',
      url: `/tenants/${id}/update-config`,
      headers: { 'x-tenant-id': '99999999-9999-4999-8999-999999999999' },
      payload: { system_prompt: 'hijack' },
    });
    expect(res.statusCode).toBe(403);
  });

  // The harness stamps call_disclosure_attested_by with this fixed id (see the
  // preHandler). It FKs users(user_id), so the row must exist before an attested
  // save; create it against the fresh tenant.
  const ATTESTER = '55555555-5555-4555-8555-555555555555';
  async function seedAttester(tenantId: string) {
    await setup.query(
      `INSERT INTO users (user_id, tenant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'x', 'owner')
       ON CONFLICT (user_id) DO NOTHING`,
      [ATTESTER, tenantId, `attester-${tenantId}@example.com`]
    );
  }

  describe('caller disclosure + attestation gate', () => {
    it('REJECTS a custom disclosure without attestation (400, row untouched)', async () => {
      // WHO: an owner rewording the spoken disclosure | WHAT: setting a non-blank
      // call_disclosure without disclosure_attested is refused | WHY: the legal
      // gate — the platform will not speak a tenant-authored disclosure the owner
      // has not affirmed meets their state's law. The write must not partially land.
      const id = await freshTenant('Disc Reject');
      const res = await app.inject({
        method: 'POST',
        url: `/tenants/${id}/update-config`,
        headers: hdr(id),
        payload: { call_disclosure: 'You are talking to a person.' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/attest/i);

      const row = await setup.query(
        'SELECT call_disclosure, call_disclosure_attested_at FROM tenants WHERE tenant_id = $1',
        [id]
      );
      expect(row.rows[0].call_disclosure).toBeNull(); // rollback: nothing written
      expect(row.rows[0].call_disclosure_attested_at).toBeNull();
    });

    it('ACCEPTS an attested custom disclosure and STAMPS who/when', async () => {
      // WHO: an owner who ticks the attestation box | WHAT: the text persists AND
      // the attestation is recorded (timestamp + user) | WHY: an attestation that
      // is not recorded is worthless as a defense — the stamp IS the evidence.
      const id = await freshTenant('Disc Accept');
      await seedAttester(id);
      const res = await app.inject({
        method: 'POST',
        url: `/tenants/${id}/update-config`,
        headers: hdr(id),
        payload: {
          call_disclosure: 'Soy un asistente de IA; esta llamada se transcribe.',
          disclosure_attested: true,
        },
      });
      expect(res.statusCode).toBe(200);

      const row = await setup.query(
        `SELECT call_disclosure, call_disclosure_attested_at, call_disclosure_attested_by
           FROM tenants WHERE tenant_id = $1`,
        [id]
      );
      expect(row.rows[0].call_disclosure).toBe(
        'Soy un asistente de IA; esta llamada se transcribe.'
      );
      expect(row.rows[0].call_disclosure_attested_at).not.toBeNull();
      expect(row.rows[0].call_disclosure_attested_by).toBe(ATTESTER);
    });

    it('CLEARING to blank reverts to default and wipes the attestation, no attest needed', async () => {
      // WHO: an owner who empties the field | WHAT: call_disclosure → null and the
      // stamp is wiped, with NO attestation required | WHY: clearing returns to the
      // compliant platform default (resolveDisclosure falls back), which is always
      // safe — so it must not be gated, and a stale attestation must not linger on
      // a row that no longer has custom text.
      const id = await freshTenant('Disc Clear');
      await seedAttester(id);
      await app.inject({
        method: 'POST',
        url: `/tenants/${id}/update-config`,
        headers: hdr(id),
        payload: { call_disclosure: 'Custom line.', disclosure_attested: true },
      });
      const cleared = await app.inject({
        method: 'POST',
        url: `/tenants/${id}/update-config`,
        headers: hdr(id),
        payload: { call_disclosure: '   ' }, // whitespace = clear, no attestation
      });
      expect(cleared.statusCode).toBe(200);

      const row = await setup.query(
        `SELECT call_disclosure, call_disclosure_attested_at, call_disclosure_attested_by
           FROM tenants WHERE tenant_id = $1`,
        [id]
      );
      expect(row.rows[0].call_disclosure).toBeNull();
      expect(row.rows[0].call_disclosure_attested_at).toBeNull();
      expect(row.rows[0].call_disclosure_attested_by).toBeNull();
    });

    it('PARTIAL SAVE that omits call_disclosure keeps prior text AND its stamp', async () => {
      // WHO: an owner saving an unrelated field (e.g. buffer) | WHAT: a body without
      // call_disclosure must not disturb the stored disclosure or re-prompt attestation
      // | WHY: the disclosure is set once and attested once; a later unrelated save
      // must neither wipe it nor demand re-attestation (attestMode 'keep').
      const id = await freshTenant('Disc Partial');
      await seedAttester(id);
      await app.inject({
        method: 'POST',
        url: `/tenants/${id}/update-config`,
        headers: hdr(id),
        payload: { call_disclosure: 'Kept line.', disclosure_attested: true },
      });
      const before = await setup.query(
        'SELECT call_disclosure_attested_at FROM tenants WHERE tenant_id = $1',
        [id]
      );
      const res = await app.inject({
        method: 'POST',
        url: `/tenants/${id}/update-config`,
        headers: hdr(id),
        payload: { default_buffer_minutes: 20 }, // unrelated, no disclosure fields
      });
      expect(res.statusCode).toBe(200);

      const after = await setup.query(
        'SELECT call_disclosure, call_disclosure_attested_at FROM tenants WHERE tenant_id = $1',
        [id]
      );
      expect(after.rows[0].call_disclosure).toBe('Kept line.');
      expect(after.rows[0].call_disclosure_attested_at).toEqual(
        before.rows[0].call_disclosure_attested_at
      );
    });

    it('ROUND-TRIP: GET /config returns a saved disclosure so the UI does not blank+wipe it', async () => {
      // WHO: an owner who saved a custom disclosure, then reopens Voice Settings.
      // WHAT: GET /tenants/:id/config must include call_disclosure so AIConfigView
      //        seeds the field with the saved text. If the read omitted the column
      //        the field would load blank, and the very next save would write null
      //        over the custom disclosure — silent data loss (Copilot, PR #234).
      // WHERE: GET /tenants/:id/config SELECT list.
      // WHY: this is the regression that would have caught the missing column; the
      //        write path had it, the read path did not.
      const id = await freshTenant('Disc RoundTrip');
      await seedAttester(id);
      await app.inject({
        method: 'POST',
        url: `/tenants/${id}/update-config`,
        headers: hdr(id),
        payload: { call_disclosure: 'Round-trip line.', disclosure_attested: true },
      });

      const read = await app.inject({
        method: 'GET',
        url: `/tenants/${id}/config`,
        headers: hdr(id),
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().call_disclosure).toBe('Round-trip line.');
    });
  });

  describe('per-tenant email logo (tenants.logo_url, 20260913050000)', () => {
    it('HAPPY: a save persists logo_url and GET /config round-trips it', async () => {
      const id = await freshTenant('Logo Happy');
      const res = await app.inject({
        method: 'POST',
        url: `/tenants/${id}/update-config`,
        headers: hdr(id),
        payload: { logo_url: 'https://example.com/logo.png' },
      });
      expect(res.statusCode).toBe(200);

      const row = await setup.query('SELECT logo_url FROM tenants WHERE tenant_id = $1', [id]);
      expect(row.rows[0].logo_url).toBe('https://example.com/logo.png');

      const read = await app.inject({
        method: 'GET',
        url: `/tenants/${id}/config`,
        headers: hdr(id),
      });
      expect(read.json().logo_url).toBe('https://example.com/logo.png');
    });

    it('PARTIAL-UPDATE: omitting logo_url keeps the prior value', async () => {
      const id = await freshTenant('Logo Partial');
      await setup.query(
        `UPDATE tenants SET logo_url = 'https://example.com/keep.png' WHERE tenant_id = $1`,
        [id]
      );

      const res = await app.inject({
        method: 'POST',
        url: `/tenants/${id}/update-config`,
        headers: hdr(id),
        payload: { default_buffer_minutes: 20 },
      });
      expect(res.statusCode).toBe(200);

      const row = await setup.query('SELECT logo_url FROM tenants WHERE tenant_id = $1', [id]);
      expect(row.rows[0].logo_url).toBe('https://example.com/keep.png');
    });

    it('CLEARING to blank sets logo_url back to NULL', async () => {
      const id = await freshTenant('Logo Clear');
      await setup.query(
        `UPDATE tenants SET logo_url = 'https://example.com/old.png' WHERE tenant_id = $1`,
        [id]
      );

      const res = await app.inject({
        method: 'POST',
        url: `/tenants/${id}/update-config`,
        headers: hdr(id),
        payload: { logo_url: '' },
      });
      expect(res.statusCode).toBe(200);

      const row = await setup.query('SELECT logo_url FROM tenants WHERE tenant_id = $1', [id]);
      expect(row.rows[0].logo_url).toBeNull();
    });
  });
});

describe('GET /templates/full → real DB', () => {
  it('publishes EXACTLY the declared BusinessTemplate fields — no more, no less', async () => {
    // WHO: any authenticated user — the business-type picker, the setup wizard,
    //      SoloWizard, DashboardHome and BusinessTypeSection all read this.
    // WHAT: the response keys must equal the field set declared by
    //       `BusinessTemplate` in dashboard/lib/types.ts.
    // WHEN: onboarding, and every time an owner changes their business type.
    // WHERE: src/routes/tenants.ts GET /templates/full.
    // WHY: the route was `SELECT * FROM business_templates`, which is an
    //      implicit contract that grows by itself — every column added to the
    //      table was published to every authenticated user the moment the
    //      migration landed, with nobody deciding to publish it. This test is
    //      the deciding step: add a column and this fails until someone puts it
    //      in the list on purpose.
    //
    //      NB the fix here is NOT `requireSuperAdmin`, which the backlog
    //      originally prescribed. Five owner-facing surfaces read this route,
    //      and the picker's TemplatePreviewModal renders system_prompt_template
    //      and first_message to the owner deliberately. Locking it to
    //      super-admin would break onboarding for every real customer.
    // The harness's preHandler only populates req.auth when x-tenant-id is
    // present, so without this header the request is not authenticated and
    // the test would pass even if the route accidentally became public.
    const id = await freshTenant('Templates Full Contract');
    const res = await app.inject({ method: 'GET', url: '/templates/full', headers: hdr(id) });
    expect(res.statusCode).toBe(200);

    const rows: Record<string, unknown>[] = res.json();
    // The seed installs the platform's business templates; if this is ever
    // empty the assertion below would pass vacuously.
    expect(rows.length).toBeGreaterThan(0);

    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'booking_label',
        'business_type',
        'category',
        'default_resource_description',
        'default_resource_name',
        'display_name',
        'employee_label',
        'employee_plural',
        'example_services',
        'first_message',
        'resource_label',
        'resource_plural',
        'sort_order',
        'system_prompt_template',
        'voice_id',
      ].sort()
    );
  });

  it('SECURITY: stops shipping the columns no client ever declared', async () => {
    // WHO: every authenticated user, including a self-serve demo tenant.
    // WHAT: voice_provider / voice_name / example_resources are real columns on
    //       business_templates and must not appear in the response.
    // WHY: voice_provider and voice_name are backfilled 'cartesia' and
    //      'elevenlabs' — TTS providers this stack has never used — so the
    //      dashboard was being handed values that are simply false, and
    //      example_resources is a column no client has ever heard of. None of
    //      the three was ever a decision; they rode in on `SELECT *`.
    const id = await freshTenant('Templates Full Undeclared');
    const res = await app.inject({ method: 'GET', url: '/templates/full', headers: hdr(id) });
    const rows: Record<string, unknown>[] = res.json();

    // `voice_provider` and `voice_name` were dropped outright by migration
    // 20260821010000 — they had zero readers and stated something false
    // ('cartesia'/'elevenlabs' for a stack that has only used OpenAI then
    // Deepgram Aura). `example_resources` still exists and is still undeclared,
    // so it remains the live case this test guards.
    expect(Object.keys(rows[0])).not.toContain('example_resources');

    // And prove the column really does exist in the table — otherwise the
    // assertion above passes for the wrong reason.
    const cols = await setup.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'business_templates'`
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toEqual(expect.arrayContaining(['example_resources']));
    // The dropped pair must stay dropped; if either returns, it returns to the
    // `SELECT` list as a decision, not by accident.
    expect(names).not.toContain('voice_provider');
    expect(names).not.toContain('voice_name');
  });
});
