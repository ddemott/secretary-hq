-- The address where a business USES the service, for sales-tax calculation.
--
-- WHY. SaaS sales tax follows where the customer uses the service, not where we are. A billing
-- address can differ from that, so the tenant carries its own service address. It goes to Stripe
-- as the customer address so Stripe Tax can price the sale, and it lets us report sales per state
-- and spot customers in jurisdictions with their own tax (docs/planning/TODO.md, Stripe Tax).
--
-- NULLABLE ON PURPOSE. Existing tenants (and template / tutorial tenants) have no address; signup
-- and checkout enforce it for new businesses in application code. The CHECKs only constrain a value
-- that IS present, so a half-filled or malformed address can never be stored.
--
-- Idempotent.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS service_street  TEXT,
  ADD COLUMN IF NOT EXISTS service_city    TEXT,
  ADD COLUMN IF NOT EXISTS service_state   TEXT,
  ADD COLUMN IF NOT EXISTS service_zip     TEXT,
  ADD COLUMN IF NOT EXISTS service_country TEXT NOT NULL DEFAULT 'US';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_service_state_format') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_service_state_format
      CHECK (service_state IS NULL OR service_state ~ '^[A-Z]{2}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_service_zip_format') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_service_zip_format
      CHECK (service_zip IS NULL OR service_zip ~ '^[0-9]{5}(-[0-9]{4})?$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_service_country_format') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_service_country_format
      CHECK (service_country ~ '^[A-Z]{2}$');
  END IF;
  -- All four parts or none: street/city/state/zip travel together.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_service_address_complete') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_service_address_complete
      CHECK (
        (service_street IS NULL AND service_city IS NULL AND service_state IS NULL AND service_zip IS NULL)
        OR (service_street IS NOT NULL AND service_city IS NOT NULL AND service_state IS NOT NULL AND service_zip IS NOT NULL)
      );
  END IF;
END $$;
