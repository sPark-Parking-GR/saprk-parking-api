-- Resource lifecycle for platform administration: archive, restore, and genuinely
-- irreversible purge across Facility, TariffPlan, ParkingOperator and User.
--
-- 1. WHY a status column and not a flag. "Delete" today means isActive = false, which
--    conflates two unrelated facts: whether a resource is published/bookable (an
--    operator decision, reversible any time) and whether it administratively exists.
--    lifecycleStatus carries the second fact alone. ACTIVE rows behave exactly as every
--    row did before this migration; ARCHIVED and TOMBSTONED rows are excluded from every
--    default Prisma read by the client extension in src/prisma/lifecycle.extension.ts
--    (raw SQL filters explicitly — see PUBLIC_VISIBLE_SQL); TOMBSTONED rows additionally
--    carry purgeAfter, the instant from which the purge worker may remove them.
--
-- 2. PURGED exists for User only. Booking.userId is ON DELETE RESTRICT and bookings
--    carry payments and refunds, so a user with history physically cannot be deleted.
--    Purge for a User is anonymisation in place (the AccountDeletionService recipe);
--    PURGED marks that as done and terminal, and keeps the row out of the worker's queue
--    (which selects TOMBSTONED only). Other models are physically removed instead.
--
-- 3. lifecycleChangedBy is TEXT with no foreign key. It records who acted — an audit
--    fact that must survive the actor's own account being archived or purged; a FK would
--    make the actor's row undeletable or null the history out.
--
-- 4. The two partial unique indexes are recreated with a lifecycleStatus = 'ACTIVE'
--    predicate. Without it an archived facility would keep occupying its operator's
--    one-facility cap and an archived default plan would keep occupying the operator's
--    default slot, making archive useless for the replace-and-restore flows it exists
--    for. With it, restoring a row RE-ENTERS the constraint domain, so a restore into a
--    now-violated state is rejected by the database — the service layer pre-checks and
--    names the conflict, and these indexes are the concurrency backstop behind it.
--
-- 5. Backfill: users already anonymised by self-service deletion (deletedAt IS NOT NULL)
--    become PURGED. Their identity is already gone, they must never authenticate or be
--    restored, and default reads should not surface them.
--
-- 6. Index (lifecycleStatus, purgeAfter) per table: the purge worker's only query is
--    "TOMBSTONED and due", and admin lifecycle views filter on status.

-- CreateEnum
CREATE TYPE "LifecycleStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'TOMBSTONED', 'PURGED');

-- AlterTable
ALTER TABLE "User"
  ADD COLUMN "lifecycleStatus" "LifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "lifecycleChangedAt" TIMESTAMP(3),
  ADD COLUMN "lifecycleChangedBy" TEXT,
  ADD COLUMN "lifecycleReason" TEXT,
  ADD COLUMN "purgeAfter" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ParkingOperator"
  ADD COLUMN "lifecycleStatus" "LifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "lifecycleChangedAt" TIMESTAMP(3),
  ADD COLUMN "lifecycleChangedBy" TEXT,
  ADD COLUMN "lifecycleReason" TEXT,
  ADD COLUMN "purgeAfter" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Facility"
  ADD COLUMN "lifecycleStatus" "LifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "lifecycleChangedAt" TIMESTAMP(3),
  ADD COLUMN "lifecycleChangedBy" TEXT,
  ADD COLUMN "lifecycleReason" TEXT,
  ADD COLUMN "purgeAfter" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TariffPlan"
  ADD COLUMN "lifecycleStatus" "LifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "lifecycleChangedAt" TIMESTAMP(3),
  ADD COLUMN "lifecycleChangedBy" TEXT,
  ADD COLUMN "lifecycleReason" TEXT,
  ADD COLUMN "purgeAfter" TIMESTAMP(3);

-- CreateIndex (see note 6)
CREATE INDEX "User_lifecycleStatus_purgeAfter_idx" ON "User"("lifecycleStatus", "purgeAfter");
CREATE INDEX "ParkingOperator_lifecycleStatus_purgeAfter_idx" ON "ParkingOperator"("lifecycleStatus", "purgeAfter");
CREATE INDEX "Facility_lifecycleStatus_purgeAfter_idx" ON "Facility"("lifecycleStatus", "purgeAfter");
CREATE INDEX "TariffPlan_lifecycleStatus_purgeAfter_idx" ON "TariffPlan"("lifecycleStatus", "purgeAfter");

-- Recreate the one-facility-per-real-operator cap counting only lifecycle-ACTIVE rows
-- (see note 4; original in 20260724120000_invite_and_facility_cap).
DROP INDEX "Facility_operatorId_claimed_key";
CREATE UNIQUE INDEX "Facility_operatorId_claimed_key"
  ON "Facility" ("operatorId")
  WHERE "operatorId" <> 'osm-unclaimed-operator' AND "lifecycleStatus" = 'ACTIVE';

-- Recreate the one-active-default-plan-per-operator backstop counting only
-- lifecycle-ACTIVE rows (see note 4; original in 20260706100000_tariff_plan_default).
DROP INDEX "TariffPlan_operator_active_default_key";
CREATE UNIQUE INDEX "TariffPlan_operator_active_default_key"
  ON "TariffPlan" ("operatorId")
  WHERE "isDefault" AND "isActive" AND "lifecycleStatus" = 'ACTIVE';

-- Backfill (see note 5): self-service-deleted accounts are already anonymised tombstones.
UPDATE "User"
SET "lifecycleStatus" = 'PURGED',
    "lifecycleChangedAt" = "deletedAt",
    "lifecycleReason" = 'Backfill: self-service account deletion predating the lifecycle model'
WHERE "deletedAt" IS NOT NULL;
