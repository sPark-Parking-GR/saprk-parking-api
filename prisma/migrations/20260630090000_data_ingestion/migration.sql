-- Trigram matching for cross-source name dedup.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "IngestSource" AS ENUM ('OSM', 'GOOGLE');
CREATE TYPE "RawPlaceStatus" AS ENUM ('PENDING', 'PROCESSED', 'REJECTED', 'DUPLICATE');
CREATE TYPE "TileStatus" AS ENUM ('PENDING', 'FETCHING', 'FETCHED', 'FAILED');

-- AlterTable: Facility ingestion provenance.
ALTER TABLE "Facility"
  ADD COLUMN "source" "IngestSource",
  ADD COLUMN "sourceRef" TEXT,
  ADD COLUMN "sourceUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "contentHash" TEXT;

-- CreateTable
CREATE TABLE "RawPlace" (
    "id" TEXT NOT NULL,
    "source" "IngestSource" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "lat" DECIMAL(10,7) NOT NULL,
    "lng" DECIMAL(10,7) NOT NULL,
    "tileId" TEXT,
    "contentHash" TEXT NOT NULL,
    "status" "RawPlaceStatus" NOT NULL DEFAULT 'PENDING',
    "facilityId" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "RawPlace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestTile" (
    "id" TEXT NOT NULL,
    "source" "IngestSource" NOT NULL,
    "south" DECIMAL(10,7) NOT NULL,
    "west" DECIMAL(10,7) NOT NULL,
    "north" DECIMAL(10,7) NOT NULL,
    "east" DECIMAL(10,7) NOT NULL,
    "status" "TileStatus" NOT NULL DEFAULT 'PENDING',
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestTile_pkey" PRIMARY KEY ("id")
);

-- Generated geography point on RawPlace, kept in sync with lat/lng by the database
-- (mirrors Facility.geog). STORED so the GiST index can be built on it.
ALTER TABLE "RawPlace"
  ADD COLUMN "geog" geography(Point, 4326)
  GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint("lng"::double precision, "lat"::double precision), 4326)::geography
  ) STORED;

-- CreateIndex
CREATE UNIQUE INDEX "RawPlace_source_sourceRef_key" ON "RawPlace"("source", "sourceRef");
CREATE INDEX "RawPlace_status_idx" ON "RawPlace"("status");
CREATE INDEX "RawPlace_tileId_idx" ON "RawPlace"("tileId");
CREATE INDEX "RawPlace_geog_idx" ON "RawPlace" USING GIST ("geog");

-- CreateIndex
CREATE UNIQUE INDEX "IngestTile_source_south_west_north_east_key" ON "IngestTile"("source", "south", "west", "north", "east");
CREATE INDEX "IngestTile_source_status_idx" ON "IngestTile"("source", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Facility_source_sourceRef_key" ON "Facility"("source", "sourceRef");

-- Trigram index backing fuzzy name match during cross-source dedup.
CREATE INDEX "Facility_name_trgm_idx" ON "Facility" USING GIN ("name" gin_trgm_ops);
