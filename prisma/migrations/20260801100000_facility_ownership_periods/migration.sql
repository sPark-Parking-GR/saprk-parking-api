-- Facility ownership history, so revenue attribution stops depending on who owns a
-- facility TODAY.
--
-- 1. WHY the table exists. `Facility.operatorId` is a single mutable pointer: it answers
--    "who owns this facility now" and nothing else. A planned platform-admin feature
--    reassigns facilities between operators. Any report that joins historical money to
--    that pointer therefore rewrites itself the instant a facility changes hands — last
--    quarter's payout for operator A silently becomes operator B's, with no record that
--    the number ever said anything different. That is an accounting-integrity failure,
--    not a display bug, and it is unfixable after the fact because the evidence (the old
--    owner) has been overwritten. The fix has to be in place BEFORE the first
--    reassignment exists, which is why this ships with the analytics module even though
--    nothing writes a second period yet.
--
--    Revenue is attributed through the period whose [from, to) interval contains the
--    payment's settlement instant. `Facility.operatorId` stays as the operational
--    "current owner" pointer that every non-historical query already uses; it is not
--    dropped and the two are expected to agree for the open period.
--
-- 2. Half-open interval. `to` NULL means "still the owner". [from, to) makes a handover
--    at instant T unambiguous: the outgoing period ends at T, the incoming one starts at
--    T, and a payment settled exactly at T belongs to exactly one of them. Closed
--    intervals would double-count that payment, which is the one thing a money query may
--    never do.
--
-- 3. One open period per facility (partial unique index). Two open periods would make the
--    lookup ambiguous and duplicate every payment in the join. A general
--    non-overlap guarantee needs an EXCLUDE constraint over a tstzrange, which needs the
--    btree_gist extension; it is deliberately not added here because nothing writes
--    periods yet. The analytics queries defend themselves anyway: they resolve the owner
--    through a LATERAL ... ORDER BY "from" DESC LIMIT 1, so even a malformed overlap
--    yields one row per payment rather than inflated revenue. When reassignment is
--    implemented, add the EXCLUDE constraint with it.
--
-- 4. Backfill. One open-ended row per existing facility, from `Facility.createdAt` — the
--    earliest instant the facility could have taken money, and no facility has ever been
--    reassigned, so a single period describes all of history exactly. Deterministic ids
--    ('fop-' || facility id) follow the FacilityTariffAssignment backfill convention and
--    make the statement re-runnable in review without a uuid extension. `from` is
--    Facility.createdAt rather than now(): dating the period from the migration would
--    orphan every payment settled before today and report zero historical revenue.
--
-- 5. Payment(status, createdAt) index. Every analytics query selects settled payments in
--    a settlement-instant range; Payment had no index on either column, so each aggregate
--    was a sequential scan of the whole table. Status leads because it is the low
--    cardinality equality predicate and the range predicate must come second to stay
--    usable by the index.

-- CreateTable
CREATE TABLE "FacilityOwnershipPeriod" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "from" TIMESTAMP(3) NOT NULL,
    "to" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacilityOwnershipPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Serves the attribution lookup: by facility, newest period whose "from" precedes the
-- settlement instant.
CREATE INDEX "FacilityOwnershipPeriod_facilityId_from_idx" ON "FacilityOwnershipPeriod"("facilityId", "from");

-- CreateIndex
-- Serves the occupancy denominator, which walks periods by owner rather than by facility.
CREATE INDEX "FacilityOwnershipPeriod_operatorId_from_idx" ON "FacilityOwnershipPeriod"("operatorId", "from");

-- CreateIndex
-- At most one CURRENT owner per facility. See note 3.
CREATE UNIQUE INDEX "FacilityOwnershipPeriod_facility_open_key" ON "FacilityOwnershipPeriod"("facilityId") WHERE "to" IS NULL;

-- AddForeignKey
ALTER TABLE "FacilityOwnershipPeriod" ADD CONSTRAINT "FacilityOwnershipPeriod_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT (Prisma's default for a required relation): an operator that owned a facility
-- for any stretch of history must not be deletable out from under its own revenue.
ALTER TABLE "FacilityOwnershipPeriod" ADD CONSTRAINT "FacilityOwnershipPeriod_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "ParkingOperator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: one open-ended period per existing facility. See note 4.
INSERT INTO "FacilityOwnershipPeriod" ("id", "facilityId", "operatorId", "from", "to", "createdAt")
SELECT 'fop-' || f."id", f."id", f."operatorId", f."createdAt", NULL, now()
FROM "Facility" f;

-- CreateIndex
-- See note 5.
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");
