-- Reintroduce TariffPlan.isDefault, this time scoped to the operator (not the
-- facility, cf. the earlier 20260619090000_tariff_default_unique, dropped in
-- 20260705110000_tariff_plan_contract). Invariant: once an operator has 2+ active
-- plans, exactly one must be an active default; enforced in the service layer
-- (this migration only adds the DB-level "at most one" backstop). A plan can only
-- be the default if it prices every vehicle type (vehicleTypes = '{}'), since it
-- serves as the catch-all for facility slots with no explicit override.

ALTER TABLE "TariffPlan" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "TariffPlan_operator_active_default_key"
  ON "TariffPlan" ("operatorId")
  WHERE "isDefault" AND "isActive";

-- Backfill: one default per operator, from active plans with vehicleTypes = '{}'
-- (the only plans allowed to be default). Prefer the most-recently-updated
-- qualifying plan. Safe because every plan that ever backed a wildcard row already
-- has vehicleTypes = '{}' (enforced by the app-level assignment guardrail), so any
-- operator with a wildcard-reliant facility is guaranteed a valid candidate here.
-- Operators with zero qualifying active plans are left with no default; the
-- invariant only bites once 2+ active plans exist, so this is a safe starting state.
WITH ranked AS (
  SELECT
    tp."id",
    tp."operatorId",
    ROW_NUMBER() OVER (
      PARTITION BY tp."operatorId"
      ORDER BY tp."updatedAt" DESC
    ) AS rn
  FROM "TariffPlan" tp
  WHERE tp."isActive" = true
    AND cardinality(tp."vehicleTypes") = 0
)
UPDATE "TariffPlan" tp
SET "isDefault" = true
FROM ranked
WHERE ranked."id" = tp."id" AND ranked.rn = 1;

-- Wildcard rows are superseded by the operator default going forward; the next
-- migration makes vehicleType NOT NULL, so drop them now.
DELETE FROM "FacilityTariffAssignment" WHERE "vehicleType" IS NULL;
