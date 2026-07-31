-- Repair: open an ownership period for every facility that has none.
--
-- `20260801100000_facility_ownership_periods` backfilled one period per facility that
-- existed AT MIGRATION TIME, but nothing in the application wrote the table afterwards.
-- Every facility created since then is invisible to analytics: the attribution join is
-- `JOIN LATERAL (...) ON TRUE`, an inner join, so a payment whose facility has no period
-- produces no row and its revenue silently disappears rather than being misattributed.
--
-- The write path is fixed (FacilitiesService.create and the ingestion promotion now open a
-- period inside the same transaction as the insert), so this statement only has to close
-- the gap on databases that already ran the earlier migration. It is a no-op elsewhere.
--
-- Same convention as the original backfill: open-ended period from `Facility.createdAt`,
-- the earliest instant the facility could have taken money, with a deterministic id.
-- Facilities that already have ANY period are left untouched — a closed-only history is
-- not something any code path can produce today, and inventing an owner for one would be a
-- guess, not a repair.
INSERT INTO "FacilityOwnershipPeriod" ("id", "facilityId", "operatorId", "from", "to", "createdAt")
SELECT 'fop-' || f."id", f."id", f."operatorId", f."createdAt", NULL, now()
FROM "Facility" f
WHERE NOT EXISTS (
  SELECT 1 FROM "FacilityOwnershipPeriod" o WHERE o."facilityId" = f."id"
);
