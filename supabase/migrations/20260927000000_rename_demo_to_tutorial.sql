-- Renames the demo-tenant feature to "tutorial" (product decision 2026-09-27:
-- the public /demo flow is called a Tutorial going forward).
--
-- RENAME COLUMN updates dependent views/policies/index predicates
-- automatically, but NOT plpgsql function bodies. No function body
-- references is_demo or demo_expires_at as of this migration (grep
-- confirmed) — only route/worker code, which is updated in the same
-- deploy as this migration.

ALTER TABLE tenants
  RENAME COLUMN is_demo TO is_tutorial;

ALTER TABLE tenants
  RENAME COLUMN demo_expires_at TO tutorial_expires_at;

ALTER INDEX idx_tenants_demo_expires RENAME TO idx_tenants_tutorial_expires;
