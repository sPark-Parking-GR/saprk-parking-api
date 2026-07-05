-- Contract phase: wildcard rows are gone (deleted in the prior migration), so
-- vehicleType is fully concrete now. Drop the wildcard partial unique index
-- (superseded — the plain FacilityTariffAssignment_facilityId_vehicleType_key
-- alone now fully enforces "at most one row per facility per vehicle type" since
-- NULL can no longer occur) and make the column NOT NULL.

DROP INDEX "FacilityTariffAssignment_facility_wildcard_key";

ALTER TABLE "FacilityTariffAssignment" ALTER COLUMN "vehicleType" SET NOT NULL;
