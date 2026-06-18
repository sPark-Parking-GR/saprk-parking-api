-- Manual ranking priority for search results. 0 = unranked (default); higher wins.
ALTER TABLE "Facility" ADD COLUMN "rank" INTEGER NOT NULL DEFAULT 0;
