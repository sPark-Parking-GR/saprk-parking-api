-- CreateEnum
CREATE TYPE "RateUnit" AS ENUM ('PER_MINUTE', 'PER_BLOCK', 'FLAT');

-- CreateEnum
CREATE TYPE "CapScope" AS ENUM ('STAY', 'ROLLING');

-- DropForeignKey
ALTER TABLE "TariffRule" DROP CONSTRAINT "TariffRule_planId_fkey";

-- DropTable
DROP TABLE "TariffRule";

-- DropEnum
DROP TYPE "TariffType";

-- AlterTable
ALTER TABLE "TariffPlan"
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Europe/Athens',
  ADD COLUMN "graceMinutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "incrementMinutes" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "vehicleTypes" "VehicleType"[] DEFAULT ARRAY[]::"VehicleType"[],
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "RateWindow" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "dayMask" INTEGER NOT NULL DEFAULT 127,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "RateWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateTier" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "fromMinute" INTEGER NOT NULL,
    "toMinute" INTEGER,
    "unit" "RateUnit" NOT NULL,
    "blockMinutes" INTEGER,

    CONSTRAINT "RateTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TariffRate" (
    "id" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',

    CONSTRAINT "TariffRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateCap" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "windowMinutes" INTEGER NOT NULL,
    "capCents" INTEGER NOT NULL,
    "scope" "CapScope" NOT NULL DEFAULT 'ROLLING',

    CONSTRAINT "RateCap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateWindow_planId_idx" ON "RateWindow"("planId");

-- CreateIndex
CREATE INDEX "RateTier_planId_idx" ON "RateTier"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "TariffRate_tierId_windowId_key" ON "TariffRate"("tierId", "windowId");

-- CreateIndex
CREATE INDEX "TariffRate_tierId_idx" ON "TariffRate"("tierId");

-- CreateIndex
CREATE INDEX "TariffRate_windowId_idx" ON "TariffRate"("windowId");

-- CreateIndex
CREATE INDEX "RateCap_planId_idx" ON "RateCap"("planId");

-- AddForeignKey
ALTER TABLE "RateWindow" ADD CONSTRAINT "RateWindow_planId_fkey" FOREIGN KEY ("planId") REFERENCES "TariffPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateTier" ADD CONSTRAINT "RateTier_planId_fkey" FOREIGN KEY ("planId") REFERENCES "TariffPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TariffRate" ADD CONSTRAINT "TariffRate_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "RateTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TariffRate" ADD CONSTRAINT "TariffRate_windowId_fkey" FOREIGN KEY ("windowId") REFERENCES "RateWindow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateCap" ADD CONSTRAINT "RateCap_planId_fkey" FOREIGN KEY ("planId") REFERENCES "TariffPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
