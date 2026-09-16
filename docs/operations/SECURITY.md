# Security Posture

**Last full review:** 2026-05-09 (security review pass 1 + pass 2 — webhook signature verification, RLS coverage, JWT/refresh, AGENT_SECRET rotation)

**Since then, verified separately and folded in below:** the anonymous `?tenant_id=` read/write/delete hole (2026-05-21), the 2026-07-13→08-02 RLS-is-decorative finding and its closure — production now connects as `app_user`, which cannot bypass policies, probed directly on 2026-08-02 (38/38 tables, 52 policies) and re-probed in CI by `tests/regression/rlsIsolation.test.ts`.

This is a baseline of the production-surface security posture so future audits start from a known shape rather than re-deriving it. Each section names the threat, the current control, where it lives, and any gaps left open with a rationale.

## Threat model

SecretaryHQ is a multi-tenant voice-AI receptionist SaaS for service businesses. The realistic threats:

- **Cross-tenant data leak** — tenant A reading or writing tenant B's customers, appointments, or voice transcripts. Highest-stakes class of breach for this platform.
- **Webhook forgery** — attacker forging a Stripe / Square / Telnyx webhook to manipulate subscription state, customer records, or call routing. (The HubSpot / Jobber / ServiceTitan CRM webhooks were removed 2026-06-12 with those integrations; Square sync was retained.)
- **Account takeover** — password-reset token exfiltration, JWT theft, or replay of an old token after credential rotation.
- **Agent worker impersonation** — caller forging `/agent-tools/*` requests to read a tenant's booking data, customer context, or trigger fraudulent bookings without being on a real call.

Out of scope (not a multi-tenant SaaS concern at this stage): DDoS, application-layer DoS, supply-chain via npm dependencies, encryption-at-rest beyond what Supabase managed Postgres + Railway provide.

## Multi-tenant isolation (cross-tenant leak)

**Control: row-level security with FORCE, plus a per-request middleware gate. TWO layers, both live.**

> ### ✅ RLS IS ENFORCED IN PRODUCTION (verified 2026-08-02)
>
> Production connects as **`app_user`** — `rolsuper = f`, `rolbypassrls = f` — so the policies are a real
> boundary, not decoration. This closes the finding below, which stood from 2026-07-13 until the
> `DATABASE_URL` repoint.
>
> Measured against production, not inferred:
>
> ```
> GET /ready  ->  { "rls_enforced": true, "db_role": "app_user", ... }   # the process's OWN connection
> pg_roles    ->  app_user  rolsuper=f  rolbypassrls=f
> 38 of 38 tables with RLS enabled · 52 policies · 0 reading current_setting() raw
> ```
>
> **How to verify it — and how not to.** `SET ROLE app_user` from a `postgres` session is REFUSED, so a
> probe written that way silently runs as `postgres`, which bypasses RLS. Its "cross-tenant rows" prove
> nothing. (That happened on 2026-08-02 and the output was briefly misread as a leak.) A real probe needs
> a genuine `app_user` connection: `tests/regression/rlsIsolation.test.ts` is that probe, and it runs in
> CI against a local `app_user` created by migration `20260724000100`.
>
> **Reverting is one env var** — keep the old superuser URL to hand.
>
> <details><summary>The original finding, kept because the reasoning still matters</summary>
>
> The application connected to Postgres as a role with **`rolbypassrls = true`**. Every RLS policy in this
> database, and every `FORCE ROW LEVEL SECURITY` declaration, was **decorative**. `FORCE` does **not**
> override `BYPASSRLS` — it only removes the table-_owner_ exemption.
>
> ```
> current_user = postgres   rolsuper = f   rolbypassrls = t
> set_config('app.current_tenant_id', '00000000-0000-0000-0000-0000000000ff')  -- owns nothing
> select count(*) from customers;  -> 1
> select count(*) from tenants;    -> 3      -- ALL of them
> ```
>
> Local and CI connected as a **superuser**, which also bypasses RLS. So RLS had never been enforced in
> any environment, and no test in this repo could have caught it: the isolation probes exercised the
> _middleware_, and the RLS assertions among them checked _configuration metadata_ (that policies exist)
> — not that policies were _applied to the connecting role_. That gap is what
> `tests/regression/rlsIsolation.test.ts` now closes.
>
> </details>
>
> **What it cost while it was true: `tenantMiddleware` was not defense in depth — it was the entire
> defense.** That is exactly why the 2026-05-21 anonymous-`?tenant_id=` bug was a full read/write/delete
> rather than a near-miss: the "second layer" everyone believed was behind it did not exist. It does now,
> which is what makes that class of middleware bug survivable instead of total.
>
> **Observability shipped first, 2026-07-13, and the fix followed:** `GET /ready` reports `rls_enforced`,
> and the backend logs `rls_not_enforced` + `errors_total{event="rls_not_enforced"}` at boot if the
> posture ever regresses (a `DATABASE_URL` pointed back at a superuser would light it up immediately). A
> security property nobody can observe is a security property nobody has.
>
> **The fix has a landmine under it — read this before touching it.** The `admin_bypass` policies test
> `current_setting('app.current_tenant_id', true) = ''`. On a **cold pool connection** that GUC has never
> been set, so `current_setting(...)` returns **NULL**, and `NULL = ''` is NULL — _not_ true. The GUC only
> becomes `''` after `clearTenantContext()` has run on that specific connection. So moving the app to a
> non-BYPASSRLS role **without first** rewriting those policies as `coalesce(current_setting(...), '') = ''`
> makes `getDueReminders()` (a raw cross-tenant sweep) return **zero rows on a cold connection** — and
> **every reminder silently stops**.
>
> Required sequence: (1) `coalesce()` the admin_bypass policies; (2) create a non-superuser,
> non-BYPASSRLS `app_user` role; (3) migrate `DATABASE_URL`; (4) prove isolation with a test that connects
> **as that role** (the only kind that can prove it); (5) then, and only then, rewrite this section.

- `tenants.id` is a UUID; every tenant-scoped table has a `tenant_id` column FK'd to it with `ON DELETE CASCADE`.
- `set_tenant_context(uuid)` sets a session-local GUC (`app.current_tenant_id`); `withTenantClient(tenantId, fn)` in `src/database/index.ts` wraps every tenant-scoped route in a checkout-set-fn-clear-release lifecycle.
- All 29 tenant-scoped tables **declare** `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + a policy of the shape `tenant_id::text = current_setting('app.current_tenant_id', true)`. **They are enforced — see the banner above.** (`message_delivery_status` got its RLS + 2 policies in migration `20260724000050`; it had been enabled with ZERO policies in prod, i.e. deny-all, and functioned only because the app role bypassed. `schema_migrations` is the one deliberate exemption: no tenant dimension, and RLS on it deny-alls the migration runner under `app_user` — see migration `20260802000000`. NB the schema-alignment guard compares tables and columns, **not RLS flags**, so RLS drift between prod and `baseline.sql` is still something only a direct probe will catch.)
- The application middleware adds defense in depth: `tenantMiddleware` in `src/middleware.ts` rejects any request that supplies `?tenant_id=<other>` or `body.tenant_id=<other>` differing from the JWT's `tenant_id` (unless caller is super-admin). Closed cross-tenant override gap on 2026-05-06.
- **Unauthenticated tenant-route access closed 2026-05-21.** The 2026-05-06 override guard only fired when a `jwtTenant` already existed — it never covered the case of _no JWT at all_. An anonymous request (no `Authorization` header) with `?tenant_id=<uuid>` (or a body `tenant_id`) had `tenantMiddleware`'s `candidate || jwtTenant` resolve to the attacker-supplied value; `requireTenantId` accepted it (it also read `body.tenant_id` directly); `withTenantClient` scoped RLS to it; and the route returned that tenant's data — read **and** write **and** delete — with zero authentication. RLS faithfully scoped to the attacker-chosen tenant; RLS was never authentication. Fix: `tenantMiddleware` now rejects any non-public, non-tenant-exempt request lacking `req.auth` with `401` before any tenant resolution; `requireTenantId` no longer falls back to `body.tenant_id` and returns `401` (not the misleading `400`) when there is no authenticated session. Public routes (login, password reset, demo, metrics, OAuth callbacks, HMAC-signed webhooks) and secret-authed `/agent-tools/*` (tenant-exempt) are unaffected.
- `/tenants/*` admin routes gated by `requireSuperAdmin()` (added 2026-05-06).
- 39 multi-tenant isolation probes (`src/multi-tenant-isolation.test.ts`) run on every CI build against real Postgres, exercising query-string override + body-FK injection + cross-tenant id under JWT-only + **unauthenticated `?tenant_id=` access (read/write/delete)** + admin-route gating + RLS configuration metadata.

**Gaps acknowledged:**

- Local test Postgres uses a SUPERUSER+BYPASSRLS `postgres` role. RLS is bypassed in that role regardless of FORCE. The probes use `api_user` (non-super, non-BYPASSRLS) for behavioral cross-tenant tests. Production runs against Supabase-managed Postgres where the `postgres` role is non-super (otherwise the FORCE migrations from 2026-03-23 would have been pointless). FORCE-vs-managed-postgres behavior is not tested locally — it has to be verified post-deploy.
- `audit_log` is `SECURITY DEFINER` so the audit trigger bypasses RLS to write rows. The trigger itself is internal and only ever fires from already-tenant-scoped INSERTs/UPDATEs/DELETEs.
- **`GET /customers` has a code path with zero application-level tenant scoping (found 2026-09-16, tracked `docs/planning/TODO.md`, PR #508).** `src/routes/customers.ts` (~lines 149-157): when the effective tenant on the request equals the literal super-admin UUID (`SUPER_ADMIN_TENANT_ID`) — the default state on a fresh super-admin session before a managed tenant is picked, after "Exit admin mode," or via a bookmarked URL — the handler runs `SELECT * FROM customers WHERE is_deleted = false ORDER BY name LIMIT $1 OFFSET $2` over a raw pool client with **no tenant filter and no `requireSuperAdmin` gate**, returning every tenant's customer PII (name/phone/email/address/notes) in one response. Not confined to the Customers tab: `dashboard/lib/hooks.ts`'s `useStaticData()` — consumed by `EmployeeManagementView`/`ShiftManagementView`/`ResourceManagerView`, none of which render customer data — unconditionally calls this endpoint as a side effect, so simply opening Setup → Staff/Shifts/Resources as a super-admin with no managed tenant selected fires the same cross-tenant query. **Current control (why this is not a confirmed active leak):** `customers`' RLS policy (`tenant_isolation_customers`, `20260323000000_force_rls_single_pool.sql`, `tenant_id = tenant_ctx_uuid()`) predates and was never swept into a table-specific `_admin_bypass` policy the way `customer_preferences` (`20260712000000`) was; the raw pool client this route uses never sets `app.current_tenant_id`, so `tenant_ctx_uuid()` evaluates to `NULLIF('', '')::uuid` = NULL, and `tenant_id = NULL` is NULL, not true — under prod's `app_user` role (which cannot bypass RLS, see the banner above) this denies every row and the endpoint returns empty today. **Gap:** that safety is incidental to the DB role, not to any application-level check in the handler — the same pattern this doc's own 2026-05-21 anonymous-`?tenant_id=` finding above concluded should never be the only defense. A local/CI superuser connection, or the production superuser `DATABASE_URL` deliberately kept on hand for reverting RLS (see above), would turn this into a real full cross-tenant customer-PII dump with no code change required. Fix tracked in `docs/planning/TODO.md`, not yet shipped.

## Same-tenant role authorization

**Control: `req.auth.role === 'owner'` gating on destructive/bulk-PII routes.** Applied inconsistently — see gap below.

- `POST /customers/import` (`src/routes/customers.ts` ~line 230) is the model instance: bulk CSV customer import requires `req.auth.role === 'owner'` (super-admin-tenant callers bypass for cross-tenant support), with the comment "bulk PII writes are not a front-desk operation."

**Gaps acknowledged:**

- **Staffing CRUD (employees/shifts/resources) has no server-side owner/role check (found 2026-09-16, tracked `docs/planning/TODO.md`, PR #508).** `src/routes/employees.ts`, `src/routes/shifts.ts`, and `src/routes/resources.ts` gate every route on `requireTenantId` only — no `req.auth.role` check anywhere in any of the three files, confirmed by grep. This is inconsistent with `customers.ts`'s own `/customers/import` pattern above. The dashboard UI hides staff/shift/resource management from `front_desk`-role users, but that is client-side only: a front-desk user's own valid JWT can call `POST /employees/create`, `DELETE /employees/:id/delete`, `POST /shifts/blackouts`, etc. directly and it succeeds. Same-tenant only — not a cross-tenant break or an RLS bypass — but an authorization gap inconsistent with the product's own stated role model. `DELETE /customers/:id` (`src/routes/customers.ts` ~line 547) shares the same gap despite being a destructive, appointment-cancelling action. Fix tracked in `docs/planning/TODO.md`: add `role === 'owner'` gating (or equivalent) to the mutating routes in these files, matching `/customers/import`'s existing pattern. Not yet shipped.

## Webhook signature verification

**Control: HMAC verification against the raw request body for every external webhook.**

| Webhook                   | Header                          | Algorithm                                            | Verifier                              | Test                         |
| ------------------------- | ------------------------------- | ---------------------------------------------------- | ------------------------------------- | ---------------------------- |
| Stripe `/billing/webhook` | `stripe-signature`              | Stripe v1 (constructEvent)                           | `stripe.webhooks.constructEvent`      | `webhook-signatures.test.ts` |
| Square `/square/webhook`  | `x-square-hmacsha256-signature` | HMAC-SHA256 over `${notificationUrl}${body}`, base64 | `squareClient.verifyWebhookSignature` | `webhook-signatures.test.ts` |
| Telnyx (SIP, not HTTP)    | n/a                             | n/a — SIP layer auth via SIP Connection ID           | n/a                                   | n/a                          |

> The HubSpot / Jobber / ServiceTitan CRM webhooks (and their HMAC verifiers) were removed 2026-06-12 along with those integrations. Stripe and Square are the remaining HMAC-verified HTTP webhooks.

**Critical correctness detail:** all HMAC verifications use `req.rawBody` (preserved by the global content-type parser at `src/index.ts:142`), NOT `JSON.stringify(req.body)`. Re-serializing through V8 doesn't byte-match the original payload (whitespace, key order, number formatting differ), so signature math fails deterministically. This was a bug from 2026-04-22 to 2026-05-09 in the HubSpot/Square/Jobber routes; fixed in commit `4c3205d`. (The HubSpot/Jobber routes were later removed entirely on 2026-06-12; the rule still applies to the surviving Stripe and Square webhooks.)

Square also verifies HMAC against `${notificationUrl}${body}` rather than the body alone, so the registered notification URL must match exactly.

## Password reset flow

**Control: short-lived single-use tokens + per-user invalidation timestamp + RLS.**

- `/forgot-password` issues a 32-byte random token, stores its SHA-256 hash in `password_resets`, and emails the raw token. Always returns 200 (no email-existence oracle). Rate-limited 3/hour per IP.
- `/reset-password` looks up by token hash, verifies expiry + not-yet-used, updates `users.password_hash` + `users.password_changed_at = NOW()`, marks the row used.
- `password_resets` has RLS enabled with FORCE + a policy that only allows access when `app.current_tenant_id` is empty. The `/forgot-password` and `/reset-password` routes run via `withPoolClient` (no setTenantContext call), so they remain authorized; any authenticated tenant session is denied (defense in depth — there's no production caller that should ever read this table from a tenant-scoped connection). Closed RLS-zero gap on 2026-05-09.

## JWT / session management

**Control: 8-hour stateless tokens with password-rotation revocation.**

- `JWT_EXPIRY = 8h` (configurable via env var).
- Every authenticated request goes through `registerJwtAuthHook` which (a) verifies the JWT signature + expiry, (b) looks up `users.password_changed_at` and rejects tokens with `iat < password_changed_at` epoch.
- `/auth/refresh` issues a fresh 8h token to anyone with a valid current token (sliding window).
- Password rotation IS the revocation mechanism: changing a password invalidates all outstanding tokens for that user.

**Gaps acknowledged:**

- No global denylist. A compromised token can't be revoked mid-window without a password change. Mitigation: admin can run `UPDATE users SET password_changed_at = NOW() WHERE id = '<user>'` to force-invalidate sessions without changing the password, but this has no UI surface today.
- 8h is long for an access token. Reasonable for a B2B dashboard where users stay logged in across a workday; would tighten if we ever ship a public API where token theft is more likely.
- `/auth/refresh` lets anyone with a valid token extend indefinitely — there's no maximum session lifetime. Acceptable for the current threat model.

## Agent secret (`/agent-tools/*` auth)

**Control: shared-secret HMAC-style header, constant-time compared, with hot-rotation support.**

- Every `/agent-tools/*` route is gated by `x-agent-secret: $AGENT_SECRET` header.
- Comparison uses `crypto.timingSafeEqual` (added 2026-05-09) with a length-mismatch guard so timing-channel probes cannot extract the secret one byte at a time.
- Rotation is hot-swappable via `AGENT_SECRET` (primary) + `AGENT_SECRET_OLD` (transitional). To rotate:
  1. Generate a new secret (32+ chars).
  2. On the backend Railway service, set `AGENT_SECRET = <new>` AND `AGENT_SECRET_OLD = <old>`. Both values are accepted during the transition.
  3. On the agent-worker Railway service, set `AGENT_SECRET = <new>` and redeploy.
  4. Once every worker is on the new value, drop `AGENT_SECRET_OLD` from the backend service.
- Tests: `agentTools.test.ts` pins missing-header / wrong-value / unset-AGENT_SECRET / shorter-provided-secret-no-crash / rotation-accepts-OLD / rotation-rejects-third-value.

**Gaps acknowledged:**

- One global secret per environment. We don't bind it to a specific worker identity. Mitigation: the secret is 32+ chars (Zod `min(32)` in agent config), only present in two Railway services' env, never logged. Forward path: switch to per-worker JWT auth if/when the agent worker count grows beyond one tenant's worth.

## Open follow-ups

These are tracked in `docs/planning/TODO.md`:

- Admin "lock account" UI surface (currently SQL-only via `password_changed_at` update).
- Per-worker agent identity (only matters when we run multiple agent workers concurrently).
