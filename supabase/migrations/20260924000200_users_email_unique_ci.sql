-- One account per email, platform-wide and case-insensitive (owner decision
-- 2026-09-24). App code already refuses a taken email on every create path
-- (src/services/tenants/bootstrap.ts, src/routes/users.ts invite); this index
-- is the real guarantee — it also closes the race where two concurrent
-- /register calls both pass the app-level SELECT before either INSERTs.
-- users_email_tenant_unique (per tenant) stays; it is now implied.
--
-- Pre-flight, checked on prod 2026-09-24 (read-only): 30 users, 4 distinct
-- lower(email), no mixed-case rows. The ONLY duplicate is the live demo's
-- shared owner login, demo@quicklubedemo.invalid, on 27 rows — every
-- POST /demo/start created a new demo tenant with that same address, and all
-- 27 of those tenants are soft-deleted (expired demos). From this change on,
-- /demo/start gives each demo tenant its own address
-- (demo+<tenant_id>@quicklubedemo.invalid), and the existing rows are renamed
-- the same way below so the index can be built. Demo users cannot log in by
-- password (their hash is a placeholder), so the rename affects no login.

UPDATE users
   SET email = 'demo+' || tenant_id || '@quicklubedemo.invalid'
 WHERE LOWER(email) = 'demo@quicklubedemo.invalid';

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique
    ON users (LOWER(email));

COMMENT ON INDEX users_email_lower_unique IS
'One account per email across the whole platform, case-insensitive (2026-09-24). Also serves /login''s WHERE LOWER(email) = LOWER($1) lookup.';
