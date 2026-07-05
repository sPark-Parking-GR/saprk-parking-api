-- Contract phase: Facility.tariffPlanId is fully superseded by
-- FacilityTariffAssignment (a wildcard-only assignment row is exactly what the
-- old scalar pointer meant), backfilled in the prior migration.

ALTER TABLE "Facility" DROP CONSTRAINT "Facility_tariffPlanId_fkey";

DROP INDEX "Facility_tariffPlanId_idx";

ALTER TABLE "Facility" DROP COLUMN "tariffPlanId";
