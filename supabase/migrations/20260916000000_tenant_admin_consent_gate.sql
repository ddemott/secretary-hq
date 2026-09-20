-- Admin-provisioned tenants get their own consent gate.
--
-- Background: 20260915000000_tenant_registration_consent.sql closed the gap
-- for self-serve /register (a checkbox + a backend-enforced attestation
-- column), but deliberately left admin-provisioned tenants
-- (POST /tenants/create) with legal_consent_* permanently NULL — an admin
-- creating a tenant on someone else's behalf isn't the business owner
-- attesting anything, so an admin "attesting on their behalf" would have
-- captured nothing legally under general clickwrap-agreement law.
--
-- The fix (docs/planning/TODO.md, decided by Dale 2026-09-16): admin-created
-- tenants get a first-login gate backed by an emailed click-to-consent
-- link. The owner must click through and attest before they can use their
-- dashboard.
--
-- CRITICAL CONSTRAINT: existing admin-created tenants already have real,
-- currently-working logins with legal_consent_attested_at NULL — including
-- Dale's own production account (seeded directly in supabase/seed.sql, not
-- via createTenantWithOwner) and the Bella's Hair Studio demo tenant. This
-- gate must NEVER apply retroactively:
--
--   consent_gate_required BOOLEAN NOT NULL DEFAULT false
--
-- Every existing row (seed data, self-serve tenants, every tenant created
-- before this migration) gets `false` and is never gated. Only
-- createTenantWithOwner's admin path (src/services/tenants/bootstrap.ts)
-- sets this `true`, and only for tenants it creates going forward. See
-- tests/regression/tenantConsentGateRetroactivity.realdb.test.ts for the
-- permanent regression test that pins this.
--
-- tenant_consent_invites mirrors password_resets' shape (short-lived,
-- single-use, hashed-token invite rows) but is per-tenant-and-owner rather
-- than per-password-reset, and follows this repo's `<table_singular>_id` PK
-- convention (password_resets predates that convention with a bare `id` —
-- not copied here).

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS consent_gate_required BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN tenants.consent_gate_required IS
'True only for admin-provisioned tenants (POST /tenants/create) created after 2026-09-16, pending the owner confirming the emailed consent-invite link. Defaults false — every pre-existing row (seed data, self-serve tenants) is never gated. See tests/regression/tenantConsentGateRetroactivity.realdb.test.ts.';

CREATE TABLE IF NOT EXISTS tenant_consent_invites (
  tenant_consent_invite_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id                  UUID        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash               TEXT        NOT NULL UNIQUE,
  expires_at               TIMESTAMPTZ NOT NULL,
  used_at                  TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tenant_consent_invites IS
'Single-use, hashed-token invites emailed to the owner of an admin-provisioned tenant, asking them to click through and attest to the ToS/Privacy/DPA before they can log in. 14-day expiry; POST /consent/resend issues a fresh one on request. No further escalation beyond resend — an owner who never confirms stays gated indefinitely.';
COMMENT ON COLUMN tenant_consent_invites.user_id IS 'The owner this invite is for — the same user_id that will log in once attested.';
COMMENT ON COLUMN tenant_consent_invites.token_hash IS 'SHA-256 of the raw token mailed to the owner; the raw token is never persisted (same convention as password_resets.token_hash).';

CREATE INDEX IF NOT EXISTS idx_tenant_consent_invites_tenant_id
  ON tenant_consent_invites(tenant_id);

CREATE INDEX IF NOT EXISTS idx_tenant_consent_invites_expires_at
  ON tenant_consent_invites(expires_at);

-- RLS. Every real access path (POST /tenants/create, /consent/confirm,
-- /consent/resend) runs over withPoolClient with NO app.current_tenant_id
-- context set (verified against src/middleware/fastify-middleware.ts and
-- the route implementations — none of these three set tenant context).
-- Modeled on phone_verifications' tenant_isolation + admin_bypass pair
-- (rewritten onto tenant_ctx()/tenant_ctx_uuid() per the 20260724000000
-- null-safe-context fix), not on password_resets (whose 20260509000000 RLS
-- migration predates that fix and still reads raw current_setting()).
ALTER TABLE tenant_consent_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_consent_invites FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenant_consent_invites'
      AND policyname = 'tenant_consent_invites_tenant_isolation'
  ) THEN
    CREATE POLICY tenant_consent_invites_tenant_isolation ON tenant_consent_invites
      USING (tenant_id = tenant_ctx_uuid())
      WITH CHECK (tenant_id = tenant_ctx_uuid());
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenant_consent_invites'
      AND policyname = 'tenant_consent_invites_admin_bypass'
  ) THEN
    CREATE POLICY tenant_consent_invites_admin_bypass ON tenant_consent_invites
      USING (tenant_ctx() = '')
      WITH CHECK (tenant_ctx() = '');
  END IF;
END $$;
