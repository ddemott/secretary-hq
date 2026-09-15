-- Backend-enforced record of the /register legal-consent attestation.
--
-- Background: the /register page's checkbox ("I am authorized to set up
-- Secretary HQ for this business. I agree to the Terms of Service, Privacy
-- Policy, and Data Protection Addendum... I am responsible for informing my
-- callers as required by law.") was enforced CLIENT-SIDE ONLY — a direct
-- POST /register call with no consent field at all created a fully
-- functional tenant with zero record consent was ever given. That defeats
-- the liability-shift purpose the whole ToS/DPA/consent-checkbox flow
-- exists for (see components/legal/LegalDocLayout.tsx, root CLAUDE.md
-- /dashboard section).
--
-- Same shape as 20260711000000_tenant_call_disclosure.sql's attestation
-- columns: an attestation that is not recorded is worthless as evidence,
-- so the affirmative act is captured on the row.
--
--   legal_consent_attested_at   — when the checkbox was ticked AND the
--                                 backend accepted the registration. NULL
--                                 means either a pre-migration tenant or
--                                 (should never happen post-migration) a
--                                 registration that bypassed the gate.
--   legal_consent_attested_by   — the new owner's own user_id (self-serve
--                                 registration is self-attestation — the
--                                 person ticking the box IS the account
--                                 being created). FK users(user_id).
--   legal_consent_ip            — best-effort request IP, same
--                                 x-forwarded-for-first-hop convention
--                                 already used by /forgot-password and
--                                 consent_records.ip_address.
--   legal_consent_user_agent    — best-effort request User-Agent header.
--
-- NULL across the board for every tenant created before this migration —
-- forward-only, no backfill (there is nothing honest to backfill; those
-- tenants never went through this gate). Tenants created via the admin
-- flow (POST /tenants/create) also stay NULL here by design: an admin
-- creating a tenant on someone else's behalf is not the business owner
-- attesting anything, so createTenantWithOwner() only stamps these columns
-- when the caller explicitly passes a legalConsent object (the /register
-- route only, gated by RegisterSchema's consent_attested: true).
--
-- NO self-managed BEGIN/COMMIT: scripts/setup-db.sh already applies each
-- file with `psql --single-transaction`. See 20260711000000's own note.

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS legal_consent_attested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS legal_consent_attested_by UUID REFERENCES users(user_id),
    ADD COLUMN IF NOT EXISTS legal_consent_ip INET,
    ADD COLUMN IF NOT EXISTS legal_consent_user_agent TEXT;

COMMENT ON COLUMN tenants.legal_consent_attested_at IS 'When the /register legal-consent checkbox was attested and the backend accepted the registration. NULL = pre-migration tenant or admin-created (no self-serve attestation to record).';
COMMENT ON COLUMN tenants.legal_consent_attested_by IS 'user_id of the owner who attested at registration (self-attestation — same person as the new account). FK users(user_id).';
COMMENT ON COLUMN tenants.legal_consent_ip IS 'Best-effort request IP captured at registration (x-forwarded-for first hop, else socket IP). Nullable — never blocks registration if unavailable.';
COMMENT ON COLUMN tenants.legal_consent_user_agent IS 'Best-effort request User-Agent header captured at registration. Nullable — never blocks registration if unavailable.';
