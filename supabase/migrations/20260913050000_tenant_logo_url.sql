-- Per-tenant email branding: tenants.logo_url.
--
-- src/services/communications/emailService.ts's applyTemplate() has always
-- hard-coded logoUrl: undefined with a comment explaining exactly why and
-- exactly what's missing: "A per-tenant logo is what belongs here. That
-- needs a `tenants.logo_url` column + upload UI + storage." The comment
-- pointed at docs/TODO.md for tracking; grep found zero hits there — the
-- follow-up was never actually filed.
--
-- Scoped as a plain URL string, not a file-upload/storage feature: an owner
-- who already hosts a logo somewhere (their own site, a CDN) pastes the URL
-- on Business Settings. No upload widget, no storage bucket, no image
-- processing — those are real product surface that would need a design
-- decision this migration isn't making. NULL/blank = no per-tenant logo,
-- which is the current (and correct) behavior for every existing tenant.
ALTER TABLE tenants ADD COLUMN logo_url TEXT;

COMMENT ON COLUMN tenants.logo_url IS
'Owner-supplied URL to their own logo image, rendered in the header of
tenant-to-customer emails (appointment confirmations/reminders/etc via
emailService.ts). NULL/blank = no logo (current default for all tenants).
Plain URL string only — no upload/storage is provided by the platform.';
