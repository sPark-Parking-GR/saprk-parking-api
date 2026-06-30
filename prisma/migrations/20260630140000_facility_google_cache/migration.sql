-- Google enrichment cache markers on Facility. place_id is permanent; googleSyncedAt
-- drives the < 30-day refresh required by the Places API terms.
ALTER TABLE "Facility"
  ADD COLUMN "googlePlaceId" TEXT,
  ADD COLUMN "googleSyncedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Facility_googlePlaceId_key" ON "Facility"("googlePlaceId");
