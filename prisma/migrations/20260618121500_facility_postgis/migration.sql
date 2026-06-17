-- Enable PostGIS for spatial indexing.
CREATE EXTENSION IF NOT EXISTS postgis;

-- Generated geography point, kept in sync with lat/lng by the database (no trigger
-- needed). STORED so the GiST index can be built on it.
ALTER TABLE "Facility"
  ADD COLUMN "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint("lng"::double precision, "lat"::double precision), 4326)::geography
  ) STORED;

-- Spatial index backing the search bbox / radius prefilter.
CREATE INDEX "Facility_geog_idx" ON "Facility" USING GIST ("geog");
