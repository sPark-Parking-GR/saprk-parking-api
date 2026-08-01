-- Two-person rule for irreversible destruction. Purge is the only action gated by it:
-- archive and tombstone are reversible, so a second pair of eyes buys nothing there and
-- would only train administrators to rubber-stamp.
--
-- 1. WHY a table and not a signed token or a Redis key. The record IS the control: it has
--    to survive a restart, be listable by whoever might approve it, and be readable
--    afterwards as evidence of who asked and who agreed. A token in the requester's own
--    possession is not a second pair of eyes, and an in-memory hold disappears exactly
--    when someone wants to know what happened.
--
-- 2. requestedBy / decidedBy are TEXT with no foreign key, matching lifecycleChangedBy in
--    20260802100000_resource_lifecycle. They record who acted; a FK would either make the
--    actor's own row undeletable or null the history out on their purge.
--
-- 3. The PARTIAL unique index is what makes the rule race-free. Two administrators hitting
--    purge on the same resource simultaneously produce one PENDING row, not two, so an
--    approval can never be split across duplicate requests. It is partial on
--    status = 'PENDING' because the terminal states must be allowed to accumulate: the
--    same resource may legitimately be requested again after a rejection or an expiry.
--    Mirrors the partial-unique convention already used for
--    Facility_operatorId_claimed_key and TariffPlan_operator_active_default_key.
--
-- 4. expiresAt is set 24h out at request time and checked at redemption, never by a
--    sweeper. An approval that is merely old is therefore never silently usable: the read
--    path is the enforcement point, so a stopped background job cannot widen the window.
--    Requesting the same resource again lapses a stale PENDING row to EXPIRED first, which
--    is what keeps the partial unique index above from wedging the resource forever.
--
-- 5. Index (status, expiresAt) serves the only two queries there are: the approvals queue
--    ("PENDING and not yet expired") and the lapse-on-request update.

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "PendingApproval" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedByRole" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedBy" TEXT,
    "decidedByRole" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (see note 5)
CREATE INDEX "PendingApproval_status_expiresAt_idx" ON "PendingApproval"("status", "expiresAt");
CREATE INDEX "PendingApproval_action_resourceType_resourceId_idx" ON "PendingApproval"("action", "resourceType", "resourceId");
CREATE INDEX "PendingApproval_requestedBy_idx" ON "PendingApproval"("requestedBy");

-- At most one live request per resource (see note 3).
CREATE UNIQUE INDEX "PendingApproval_pending_resource_key"
  ON "PendingApproval" ("action", "resourceType", "resourceId")
  WHERE "status" = 'PENDING';
