/**
 * E2E coverage for auth + identity flows that aren't booking-shaped.
 *
 *   1. Front-desk role hits owner-only routes → 403 (route-level gate,
 *      not just nav-hide).
 *   2. Password reset round-trip — forgot-password → token in DB →
 *      reset-password → login with new password.
 *   3. OTP send / verify round-trip for the voice-agent flow.
 *
 * Each test fully self-contained per the test-isolation memory.
 * The dev environment's email + SMS senders are no-ops (sendPasswordResetEmail
 * logs only; sendSms returns true without dispatching), so the test
 * pulls the reset token / OTP code from the DB tables instead of an
 * inbox or legacy provider mock — same data path the real (Telnyx) provider would
 * deliver, just intercepted at the persistence layer.
 */
import { test, expect } from './helpers/test';
import { type APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { Pool } from 'pg';
import { registerFreshTenant, cleanTenantData, BACKEND_URL } from './helpers/fixtures';
import { createHash, randomUUID } from 'crypto'; // createHash for password-reset token (sha256), randomUUID for token plaintext
import { readFileSync } from 'fs';
import { join } from 'path';

const PG_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';

// AGENT_SECRET read from the backend's .env so the test sends the same
// value the running server expects. Falls back to env var if test is
// run with one already exported (CI pattern).
function readAgentSecret(): string {
  if (process.env.AGENT_SECRET) return process.env.AGENT_SECRET;
  try {
    const envPath = join(__dirname, '..', '..', '.env');
    const content = readFileSync(envPath, 'utf8');
    const match = content.match(/^AGENT_SECRET=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // fall through
  }
  throw new Error('AGENT_SECRET not found in .env or process.env — cannot run agent-tools test');
}
const AGENT_SECRET = readAgentSecret();

let pool: Pool;
let freshTenant: { tenantId: string; email: string; token: string };

function uniqueTag(): string {
  return `e2e-auth-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

/**
 * Use Playwright's APIRequestContext (created from `page.request`) instead
 * of `page.evaluate` for the login + API calls. The context-level request
 * API doesn't depend on the page being navigated to a real origin (which
 * was tripping page.evaluate's fetch with "Failed to fetch" when the
 * dashboard page hadn't fully loaded). Same wire format, simpler call site.
 */
async function loginAs(
  req: APIRequestContext,
  email: string,
  password: string
): Promise<{
  token?: string;
  tenant_id?: string;
  role?: string;
  success?: boolean;
  error?: string;
  status?: number;
}> {
  const res = await req.post(`${BACKEND_URL}/login`, {
    data: { email, password },
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), ...body };
}

async function apiPost(
  req: APIRequestContext,
  token: string | null,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const merged: Record<string, string> = { 'Content-Type': 'application/json', ...headers };
  if (token) merged.Authorization = `Bearer ${token}`;
  const res = await req.post(`${BACKEND_URL}${path}`, { data: body, headers: merged });
  const responseBody = await res.json().catch(() => ({}));
  return { status: res.status(), body: responseBody };
}

async function apiPatch(
  req: APIRequestContext,
  token: string,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await req.patch(`${BACKEND_URL}${path}`, {
    data: body,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  const responseBody = await res.json().catch(() => ({}));
  return { status: res.status(), body: responseBody };
}

async function apiGet(
  req: APIRequestContext,
  token: string,
  path: string
): Promise<{ status: number }> {
  const res = await req.get(`${BACKEND_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status() };
}

// Each run provisions a fresh ephemeral tenant for the tests below so they
// never depend on seed data and clean up after themselves.
test.beforeAll(async () => {
  pool = new Pool({ connectionString: PG_URL });
  const ctx = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
  freshTenant = await registerFreshTenant(ctx);
  await ctx.dispose();
});
test.afterAll(async () => {
  await cleanTenantData(pool, freshTenant.tenantId);
  await pool.end();
});

// ────────────────────────────────────────────────────────────────────────────
// 1. Front-desk role 403 at the route level (not just nav-hide)
// ────────────────────────────────────────────────────────────────────────────
test('role-gate: front_desk user hitting owner-only routes is rejected with 403', async ({
  request,
}) => {
  // WHO: front_desk user who knows the API and tries to invite a teammate
  //        or change a teammate's role via direct API call (bypassing the
  //        UI nav-hide that workflows test 14 verifies)
  // WHAT: src/routes/users.ts requireOwner() gate must reject them with
  //        403 on POST /users/invite, PATCH /users/:id/role, GET /users
  // WHEN: any owner-only route invoked with a JWT carrying role='front_desk'
  // WHERE: src/routes/users.ts requireOwner() lines 40+
  // WHY: workflows test 14 verifies the layout HIDES Back Office tabs
  //        from front-desk; this test verifies the SERVER ALSO rejects
  //        them. Without the route-level gate, a determined caller could
  //        bypass the UI hide and grant themselves owner role.

  const tag = uniqueTag();
  let frontDeskUserId: string | null = null;
  let inviteeUserId: string | null = null;

  try {
    // Setup: insert a front_desk user we'll log in as, plus a target
    // teammate whose role we'll try to change. Hash 'password' via bcrypt
    // dynamically (rather than a hardcoded seed-style hash) so the test
    // doesn't depend on a specific bcrypt version's output.
    const bcrypt = await import('bcrypt');
    const bcryptHash = await bcrypt.hash('password', 10);
    const fd = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, 'front_desk') RETURNING user_id`,
      [freshTenant.tenantId, `${tag}-fd@example.test`, bcryptHash, 'Front Desk Test']
    );
    frontDeskUserId = fd.rows[0].user_id;

    const tt = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, 'owner') RETURNING user_id`,
      [freshTenant.tenantId, `${tag}-target@example.test`, bcryptHash, 'Target Owner']
    );
    inviteeUserId = tt.rows[0].user_id;

    // Log in as the front_desk user.
    const auth = await loginAs(request, `${tag}-fd@example.test`, 'p@ssw0rd');
    expect(auth.token, `login should succeed: ${JSON.stringify(auth)}`).toBeTruthy();
    expect(auth.role).toBe('front_desk');

    // Attack 1: POST /users/invite — front_desk gets 403.
    const invite = await apiPost(request, auth.token!, '/users/invite', {
      tenant_id: freshTenant.tenantId,
      email: `${tag}-injected@example.test`,
      full_name: 'Injected User',
      role: 'owner',
    });
    expect(invite.status, '/users/invite must reject front_desk').toBe(403);

    // Attack 2: PATCH /users/:id/role — front_desk gets 403 trying to
    // demote another owner to front_desk (or promote themselves).
    const patch = await apiPatch(request, auth.token!, `/users/${inviteeUserId}/role`, {
      tenant_id: freshTenant.tenantId,
      role: 'front_desk',
    });
    expect(patch.status, '/users/:id/role must reject front_desk').toBe(403);

    // Attack 3: GET /users — also owner-gated.
    const list = await apiGet(request, auth.token!, '/users');
    expect(list.status, 'GET /users must reject front_desk').toBe(403);

    // Belt-and-suspenders: target user's role is unchanged.
    const targetCheck = await pool.query('SELECT role FROM users WHERE user_id = $1', [
      inviteeUserId,
    ]);
    expect(targetCheck.rows[0].role).toBe('owner');
  } finally {
    if (frontDeskUserId) {
      await pool.query('DELETE FROM users WHERE user_id = $1', [frontDeskUserId]);
    }
    if (inviteeUserId) {
      await pool.query('DELETE FROM users WHERE user_id = $1', [inviteeUserId]);
    }
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${tag}-%`]);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Password reset round-trip
// ────────────────────────────────────────────────────────────────────────────
test('password-reset: forgot-password → token persisted → reset-password → login with new password works', async ({
  request,
}) => {
  // WHO: tenant user who locked themselves out and uses the public
  //        password-reset flow
  // WHAT: POST /forgot-password seeds password_resets table; user
  //        receives the token (email or — in dev — query the DB), POSTs
  //        /reset-password with token + new password, can then log
  //        in with the new password
  // WHEN: any forgotten-password recovery in production
  // WHERE: src/routes/auth.ts /forgot-password + /reset-password
  // WHY: this is the only recovery path for a user who lost their password
  //        and isn't an admin's responsibility. If it breaks silently (e.g.
  //        a refactor changes the token-hashing approach), users get locked
  //        out permanently. Pin the round-trip end-to-end.

  const tag = uniqueTag();
  const email = `${tag}-resetuser@example.test`;
  const oldPassword = 'oldpassword';
  const newPassword = 'newsecurepassword';
  let userId: string | null = null;

  try {
    // Seed user with a known starting password.
    const bcrypt = await import('bcrypt');
    const oldHash = await bcrypt.hash(oldPassword, 10);
    const u = await pool.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, 'owner') RETURNING user_id`,
      [freshTenant.tenantId, email, oldHash, 'Reset Test User']
    );
    userId = u.rows[0].user_id;

    // Confirm initial login works.
    const initialLogin = await loginAs(request, email, oldPassword);
    expect(initialLogin.token, 'old password should work pre-reset').toBeTruthy();

    // 1. Request a password reset.
    const forgot = await apiPost(request, null, '/forgot-password', { email });
    expect(forgot.status).toBeLessThan(400);

    // 2. Pull the most recent reset token's hash from the DB. The route
    //    sends the unhashed token via email and stores its sha256 hash.
    //    Email is a no-op in dev — the test bypasses delivery and asserts
    //    the row exists, then constructs a token whose hash matches the
    //    stored row. Since we can't decrypt the hash, we replace it with
    //    a known-token's hash, mirroring what the real flow would deliver.
    const knownToken = randomUUID() + randomUUID();
    const knownHash = createHash('sha256').update(knownToken).digest('hex');
    const updateRes = await pool.query(
      `UPDATE password_resets
          SET token_hash = $1
        WHERE user_id = $2 AND used_at IS NULL
          AND password_reset_id = (
            SELECT password_reset_id FROM password_resets
             WHERE user_id = $2 AND used_at IS NULL
             ORDER BY created_at DESC LIMIT 1
          )
       RETURNING password_reset_id`,
      [knownHash, userId]
    );
    expect(updateRes.rowCount, 'a fresh reset row must exist after forgot-password').toBe(1);

    // 3. Reset the password using the known token.
    const reset = await apiPost(request, null, '/reset-password', {
      token: knownToken,
      new_password: newPassword,
    });
    expect(reset.status, `reset response: ${JSON.stringify(reset)}`).toBeLessThan(400);

    // 4. Old password no longer works.
    const oldFail = await loginAs(request, email, oldPassword);
    expect(oldFail.token, 'old password must NOT log in after reset').toBeUndefined();

    // 5. New password works.
    const newWorks = await loginAs(request, email, newPassword);
    expect(newWorks.token, 'new password must log in after reset').toBeTruthy();
  } finally {
    if (userId) {
      await pool.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
    }
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 3. OTP verify route — happy path (known bcrypt-hashed code) + sad path
// ────────────────────────────────────────────────────────────────────────────
test('otp-verify: /verify-phone-code accepts a matching code and rejects a wrong one', async ({
  request,
}) => {
  // WHO: voice-agent caller whose phone needs verification before the
  //        agent will book on their behalf (post-2026-04-23 OTP gating)
  // WHAT: /agent-tools/verify-phone-code matches the unhashed code
  //        against a bcrypt-hashed row in phone_verifications. Match →
  //        sets verified_at, returns success. Mismatch → returns success:
  //        false without modifying the row.
  // WHEN: any caller responding with a 6-digit OTP
  // WHERE: src/routes/agentTools.ts verify-phone-code
  // WHY: the SEND path is harder to E2E without actually dispatching an
  //        SMS via Telnyx (which costs money + requires inbound_phone +
  //        risks the wrong number receiving a real text). The VERIFY path
  //        is the more interesting half — it's what proves the caller
  //        owns the number — and is fully testable by direct INSERT of a
  //        bcrypt-hashed known-plaintext row. Send is unit-tested.

  const phone = `+1555${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`;
  // 4-digit code (2026-07-13 — shortened from 6; it is read back ALOUD mid-call).
  const knownCode = '1234';
  let phoneVerificationId: string | null = null;

  try {
    // Pre-INSERT a phone_verifications row with a bcrypt-hashed code we
    // control. Mirrors what /send-verification-code would have done after
    // generating + hashing a fresh code.
    const bcrypt = await import('bcrypt');
    const codeHash = await bcrypt.hash(knownCode, 10);
    const ins = await pool.query(
      `INSERT INTO phone_verifications (tenant_id, phone, code_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '10 minutes')
       RETURNING phone_verification_id`,
      [freshTenant.tenantId, phone, codeHash]
    );
    phoneVerificationId = ins.rows[0].phone_verification_id;

    // SAD: wrong code is rejected without marking the row verified.
    const wrong = await apiPost(
      request,
      null,
      '/agent-tools/verify-phone-code',
      { tenant_id: freshTenant.tenantId, phone, code: '9999' },
      { 'x-agent-secret': AGENT_SECRET }
    );
    expect(wrong.status).toBe(200); // route returns 200 + success:false (LLM relays naturally)
    expect(wrong.body.success, `wrong-code body: ${JSON.stringify(wrong.body)}`).toBe(false);

    const afterWrong = await pool.query(
      `SELECT verified_at FROM phone_verifications WHERE phone_verification_id = $1`,
      [phoneVerificationId]
    );
    expect(afterWrong.rows[0].verified_at, 'wrong code must NOT mark verified').toBeNull();

    // HAPPY: correct code accepts + marks verified.
    const right = await apiPost(
      request,
      null,
      '/agent-tools/verify-phone-code',
      { tenant_id: freshTenant.tenantId, phone, code: knownCode },
      { 'x-agent-secret': AGENT_SECRET }
    );
    expect(right.status).toBe(200);
    expect(right.body.success, `right-code body: ${JSON.stringify(right.body)}`).toBe(true);

    const afterRight = await pool.query(
      `SELECT verified_at FROM phone_verifications WHERE phone_verification_id = $1`,
      [phoneVerificationId]
    );
    expect(afterRight.rows[0].verified_at, 'correct code must populate verified_at').not.toBeNull();
  } finally {
    if (phoneVerificationId) {
      await pool.query('DELETE FROM phone_verifications WHERE phone_verification_id = $1', [
        phoneVerificationId,
      ]);
    }
    await pool.query(`DELETE FROM phone_verifications WHERE tenant_id = $1 AND phone = $2`, [
      freshTenant.tenantId,
      phone,
    ]);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// JSON content-type parser — real registration must not hang on bad JSON
// ────────────────────────────────────────────────────────────────────────────
test('content-parser: malformed JSON body returns 400 quickly (no hang)', async ({ request }) => {
  // WHO: any client sending Content-Type: application/json with a bad body
  // WHAT: the production parser (src/jsonContentTypeParser.ts, wired in
  //       index.ts) must done(Error) → Fastify 400, NOT a sync return
  // WHEN: 2026-05-21 regression guard — a require-await lint sweep once
  //       stripped `async` and made the parser sync-return, hanging EVERY
  //       JSON POST. The route-test harness uses a different async parser,
  //       so only an E2E against the real registration proves it's wired.
  // WHERE: src/index.ts addContentTypeParser('application/json', ...)
  // WHY: a hang would manifest as this test timing out; a 400 within the
  //       default timeout proves the done()-callback path is live.
  const res = await request.post(`${BACKEND_URL}/login`, {
    data: '{ this is : not valid json',
    headers: { 'Content-Type': 'application/json' },
  });
  // Fastify maps a content-type parser error to 400. The key assertions are
  // (a) we get a definitive 4xx and (b) the request returned at all (no hang).
  expect(res.status(), 'malformed JSON must be rejected, not hang').toBe(400);
});
