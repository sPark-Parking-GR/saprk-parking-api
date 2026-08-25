-- Pure rename: isVerified was never platform "verification", it gated mobile visibility.
-- RENAME COLUMN keeps every existing value; a drop+add would silently unpublish everything.
ALTER TABLE "Facility" RENAME COLUMN "isVerified" TO "isPublished";

ALTER INDEX "Facility_isActive_isVerified_idx" RENAME TO "Facility_isActive_isPublished_idx";
