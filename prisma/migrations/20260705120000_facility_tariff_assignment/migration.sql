-- A facility can now have a different tariff plan per vehicle type (plus an
-- optional wildcard for "every other vehicle type"), instead of exactly one
-- plan overall. Create the join table and backfill one wildcard row per
-- facility from its current single-pointer assignment; the next migration
-- drops that old pointer once this data is in place.

CREATE TABLE "FacilityTariffAssignment" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "tariffPlanId" TEXT NOT NULL,
    "vehicleType" "VehicleType",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacilityTariffAssignment_pkey" PRIMARY KEY ("id")
);

-- Covers the 4 concrete-vehicleType rows. Postgres treats NULL as distinct in a
-- plain unique index, so it does not by itself stop two wildcard rows for the
-- same facility — the partial index below closes that gap.
CREATE UNIQUE INDEX "FacilityTariffAssignment_facilityId_vehicleType_key" ON "FacilityTariffAssignment"("facilityId", "vehicleType");

CREATE UNIQUE INDEX "FacilityTariffAssignment_facility_wildcard_key" ON "FacilityTariffAssignment"("facilityId") WHERE "vehicleType" IS NULL;

CREATE INDEX "FacilityTariffAssignment_tariffPlanId_idx" ON "FacilityTariffAssignment"("tariffPlanId");

ALTER TABLE "FacilityTariffAssignment" ADD CONSTRAINT "FacilityTariffAssignment_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FacilityTariffAssignment" ADD CONSTRAINT "FacilityTariffAssignment_tariffPlanId_fkey" FOREIGN KEY ("tariffPlanId") REFERENCES "TariffPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one wildcard row per facility that already has an assigned plan.
INSERT INTO "FacilityTariffAssignment" ("id", "facilityId", "tariffPlanId", "vehicleType", "createdAt", "updatedAt")
SELECT 'ftfa-' || f."id", f."id", f."tariffPlanId", NULL, now(), now()
FROM "Facility" f
WHERE f."tariffPlanId" IS NOT NULL;
