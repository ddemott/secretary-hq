-- Email verification for self-serve signups (owner decision 2026-09-24).
--
-- Before this, POST /register accepted any well-formed email and logged the
-- person straight in: nothing ever proved the address was theirs. A made-up
-- address could open a workspace, and a password reset for it would go to
-- someone else's inbox. Now /register emails a single-use link, and
-- POST /billing/checkout — the only path to a trial, and so (PR #566) to a
-- phone number — refuses until users.email_verified_at is set.
--
-- CRITICAL CONSTRAINT: this must never lock out an existing login. Every row
-- that exists when this migration runs (seed data, Dale's own production
-- account, demo tenants, every self-serve and admin-created user so far) is
-- backfilled as verified at its created_at. Only users created AFTER this
-- migration start unverified.
--
-- Other proofs of inbox ownership also set email_verified_at (see
-- src/routes/auth.ts /reset-password and src/routes/consent.ts
-- /consent/confirm): clicking any emailed single-use link we sent to that
-- address proves the same thing.
--
-- email_verifications mirrors tenant_consent_invites (20260916000000):
-- short-lived, single-use, SHA-256-hashed tokens; the raw token is only ever
-- in the email.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN users.email_verified_at IS
'When this user proved they own users.email by clicking an emailed single-use link. NULL = unverified; POST /billing/checkout refuses until set. Every row that existed on 2026-09-24 was backfilled to its created_at so no existing login is gated.';

UPDATE users
   SET email_verified_at = COALESCE(created_at, NOW())
 WHERE email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS email_verifications (
  email_verification_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id               UUID        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash            TEXT        NOT NULL UNIQUE,
  expires_at            TIMESTAMPTZ NOT NULL,
  used_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE email_verifications IS
'Single-use, hashed-token links emailed at signup (and on resend) so a new user can prove they own their email. 48-hour expiry. Consumed by POST /verify-email.';
COMMENT ON COLUMN email_verifications.token_hash IS
'SHA-256 of the raw token mailed to the user; the raw token is never persisted (same convention as password_resets / tenant_consent_invites).';

CREATE INDEX IF NOT EXISTS idx_email_verifications_user_id
  ON email_verifications(user_id);

CREATE INDEX IF NOT EXISTS idx_email_verifications_expires_at
  ON email_verifications(expires_at);

-- RLS: same tenant_isolation + admin_bypass pair as tenant_consent_invites.
-- Every access path (/register, /verify-email, /verify-email/resend) runs
-- over withPoolClient with no app.current_tenant_id set.
ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verifications FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'email_verifications'
      AND policyname = 'email_verifications_tenant_isolation'
  ) THEN
    CREATE POLICY email_verifications_tenant_isolation ON email_verifications
      USING (tenant_id = tenant_ctx_uuid())
      WITH CHECK (tenant_id = tenant_ctx_uuid());
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'email_verifications'
      AND policyname = 'email_verifications_admin_bypass'
  ) THEN
    CREATE POLICY email_verifications_admin_bypass ON email_verifications
      USING (tenant_ctx() = '')
      WITH CHECK (tenant_ctx() = '');
  END IF;
END $$;
