-- Re-enable RLS on schema_migrations, this time with an explicit policy, to
-- close the Supabase security advisor's "Table publicly accessible"
-- (rls_disabled_in_public) finding without repeating the 2026-08-02 outage.
--
-- 20260802000000_schema_migrations_no_rls.sql disabled RLS on this table
-- entirely because RLS-enabled-with-zero-policies is deny-all for any
-- non-owner role that cannot bypass RLS — which locked app_user
-- (rolbypassrls=f) out of its own bookkeeping table the moment prod's
-- DATABASE_URL switched to app_user.
--
-- That reasoning about "no tenant dimension" still holds; the fix isn't a
-- tenant-scoped policy, it's a role-scoped one: an explicit allow-all policy
-- for app_user (so the migration runner and backend keep working), and no
-- policy at all for anon/authenticated (the roles PostgREST exposes on the
-- public API), which under RLS defaults to deny for them. That is what
-- actually closes the "anyone with your project URL can read/edit/delete"
-- finding — disabling RLS left the table open to those roles; this closes it
-- for them while leaving the app role unaffected.
-- FORCE matches every other RLS table in this schema (table owner is
-- postgres locally/in Supabase, not app_user, so this is what actually keeps
-- the owner from silently bypassing) — real superusers still bypass RLS
-- regardless of FORCE, so this does not affect local Docker's superuser
-- connection or CI.
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations FORCE ROW LEVEL SECURITY;

CREATE POLICY schema_migrations_app_user_all ON schema_migrations
  FOR ALL
  TO app_user
  USING (true)
  WITH CHECK (true);
