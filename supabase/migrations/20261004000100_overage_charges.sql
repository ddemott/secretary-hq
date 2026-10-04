-- A ledger of overage charges handed to Stripe: one row per tenant per closed month.
--
-- WHY. A paid plan includes a number of answered calls a month and bills every call past it
-- (docs/planning/TODO.md, "Billing"). The month-end biller (src/workers/overageBiller.ts) adds that
-- amount to the customer's next invoice as a Stripe invoice item. Charging money must be exactly once:
--   - Stripe idempotency keys are only remembered for ~24 hours, so a retry two days later would
--     charge again unless WE remember what was already billed. This table is that memory.
--   - The row is claimed (status 'pending') BEFORE Stripe is called and flipped to 'created' with the
--     Stripe invoice item id after. A crash in between leaves 'pending', which the next run retries
--     with the same idempotency key; it never silently drops the charge and never doubles it.
--
-- The natural key is (tenant_id, month): two short, stable columns that ARE the identity, so no
-- surrogate id (house rule on natural keys).
--
-- RLS: same tenant_isolation + admin_bypass pair as the other tenant tables, on
-- tenant_ctx()/tenant_ctx_uuid() (the null-safe helpers from 20260724000000).
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS overage_charges (
  tenant_id             UUID        NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  -- The UTC calendar month being billed, 'YYYY-MM' (the same boundary the usage statements use).
  month                 TEXT        NOT NULL,
  overage_calls         INT         NOT NULL,
  -- Integer cents, exactly what is sent to Stripe.
  amount_cents          INT         NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'pending',
  -- Stripe's invoice item id once created.
  stripe_invoice_item_id TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, month),
  CONSTRAINT overage_charges_month_format CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT overage_charges_positive CHECK (overage_calls > 0 AND amount_cents > 0),
  CONSTRAINT overage_charges_status_valid CHECK (status IN ('pending', 'created')),
  -- A 'created' row always names the Stripe object; a 'pending' row never does.
  CONSTRAINT overage_charges_item_matches_status CHECK (
    (status = 'created' AND stripe_invoice_item_id IS NOT NULL)
    OR (status = 'pending' AND stripe_invoice_item_id IS NULL)
  )
);

COMMENT ON TABLE overage_charges IS
'One row per tenant per closed UTC month: the overage amount handed to Stripe as an invoice item. Claimed pending before the Stripe call, flipped to created after, so a retry can never double-charge and a crash can never drop the charge.';
COMMENT ON COLUMN overage_charges.amount_cents IS 'Integer cents, exactly what was sent to Stripe (overage_calls x the plan rate, rounded to cents once on the total).';

ALTER TABLE overage_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE overage_charges FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'overage_charges'
      AND policyname = 'overage_charges_tenant_isolation'
  ) THEN
    CREATE POLICY overage_charges_tenant_isolation ON overage_charges
      USING (tenant_id = tenant_ctx_uuid())
      WITH CHECK (tenant_id = tenant_ctx_uuid());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'overage_charges'
      AND policyname = 'overage_charges_admin_bypass'
  ) THEN
    CREATE POLICY overage_charges_admin_bypass ON overage_charges
      USING (tenant_ctx() = '')
      WITH CHECK (tenant_ctx() = '');
  END IF;
END $$;
