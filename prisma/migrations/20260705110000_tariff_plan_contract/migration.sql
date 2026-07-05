-- Contract phase: TariffPlan is now fully operator-owned (Facility.tariffPlanId,
-- backfilled in the prior migration, is the only link to a facility). Drop the
-- old facility-ownership columns and the per-facility default-plan invariant,
-- which no longer applies now that a facility points at exactly one plan.

DROP INDEX "TariffPlan_facility_active_default_key";
DROP INDEX "TariffPlan_facilityId_isActive_idx";

ALTER TABLE "TariffPlan" DROP CONSTRAINT "TariffPlan_facilityId_fkey";

ALTER TABLE "TariffPlan" DROP COLUMN "facilityId";
ALTER TABLE "TariffPlan" DROP COLUMN "isDefault";

ALTER TABLE "TariffPlan" ALTER COLUMN "operatorId" SET NOT NULL;

CREATE INDEX "TariffPlan_operatorId_isActive_idx" ON "TariffPlan"("operatorId", "isActive");
