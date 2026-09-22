-- CreateEnum
CREATE TYPE "FacilityKind" AS ENUM ('BUSINESS', 'FREE_PUBLIC', 'RESTRICTED', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Facility" ADD COLUMN "kind" "FacilityKind" NOT NULL DEFAULT 'UNKNOWN';

-- CreateIndex
CREATE INDEX "Facility_kind_isActive_idx" ON "Facility"("kind", "isActive");
