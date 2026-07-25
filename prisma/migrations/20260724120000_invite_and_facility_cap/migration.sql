-- Invite-only B2B onboarding + one-facility-per-operator cap.
--
-- 1. OperatorInvite: platform-admin-issued, single-use, expiring onboarding tokens.
--    Only the sha256 hash of the raw token is stored (tokenHash unique); the raw
--    token lives solely in the emailed accept link. Cascade-deletes with its operator.
-- 2. User.firebaseUid: nullable + unique. Set only for Firebase-provisioned identities
--    (operator admins created at invite-accept); null for existing authjs users, so the
--    per-user CompositeAuthProvider can route a login to the right concrete strategy.
-- 3. One-facility-per-operator cap: a PARTIAL unique index on Facility.operatorId,
--    excluding the synthetic 'osm-unclaimed-operator' that the ingestion pipeline uses
--    to own every un-onboarded OSM/Google facility (many rows share it by design). A
--    plain unique would break ingestion; the partial index enforces the cap only for
--    real operators, matching the TariffPlan.isDefault partial-unique convention. The
--    plain @@index([operatorId]) is kept for FK/query performance; the app also locks
--    the operator row + counts before insert and maps a P2002 here to a domain conflict.

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "firebaseUid" TEXT;

-- CreateTable
CREATE TABLE "OperatorInvite" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OperatorInvite_tokenHash_key" ON "OperatorInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "OperatorInvite_email_idx" ON "OperatorInvite"("email");

-- CreateIndex
CREATE INDEX "OperatorInvite_status_idx" ON "OperatorInvite"("status");

-- CreateIndex
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");

-- CreateIndex (partial: one facility per REAL operator; the synthetic unclaimed-import
-- operator is exempt so the ingestion pipeline can keep many facilities under it).
CREATE UNIQUE INDEX "Facility_operatorId_claimed_key"
  ON "Facility" ("operatorId")
  WHERE "operatorId" <> 'osm-unclaimed-operator';

-- AddForeignKey
ALTER TABLE "OperatorInvite" ADD CONSTRAINT "OperatorInvite_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "ParkingOperator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorInvite" ADD CONSTRAINT "OperatorInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
