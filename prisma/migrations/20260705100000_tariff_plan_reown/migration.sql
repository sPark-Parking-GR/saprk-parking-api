-- Expand phase: TariffPlan moves from facility-owned to operator-owned so one
-- plan can be shared across many facilities. Adds the new nullable columns and
-- backfills them from the still-present facilityId/isDefault; the contract
-- migration that follows drops the old columns once this data is in place.

ALTER TABLE "TariffPlan" ADD COLUMN "operatorId" TEXT;

ALTER TABLE "Facility" ADD COLUMN "tariffPlanId" TEXT;

CREATE INDEX "Facility_tariffPlanId_idx" ON "Facility"("tariffPlanId");

-- Backfill TariffPlan.operatorId from the facility it currently belongs to.
UPDATE "TariffPlan" tp
SET "operatorId" = f."operatorId"
FROM "Facility" f
WHERE tp."facilityId" = f."id";

-- Backfill Facility.tariffPlanId: prefer an active default plan, else the most
-- recently created active plan; leave null if the facility has no active plan.
WITH ranked AS (
  SELECT
    tp."facilityId",
    tp."id" AS plan_id,
    ROW_NUMBER() OVER (
      PARTITION BY tp."facilityId"
      ORDER BY tp."isDefault" DESC, tp."createdAt" DESC
    ) AS rn
  FROM "TariffPlan" tp
  WHERE tp."isActive" = true
)
UPDATE "Facility" f
SET "tariffPlanId" = ranked.plan_id
FROM ranked
WHERE ranked."facilityId" = f."id" AND ranked.rn = 1;

ALTER TABLE "TariffPlan" ADD CONSTRAINT "TariffPlan_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "ParkingOperator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Facility" ADD CONSTRAINT "Facility_tariffPlanId_fkey" FOREIGN KEY ("tariffPlanId") REFERENCES "TariffPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;
