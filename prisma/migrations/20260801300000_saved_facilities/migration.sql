-- Server-side saved facilities, so a bookmark is an account fact rather than a device fact.
--
-- 1. WHY the table exists. The mobile app keeps saved facilities in AsyncStorage. That
--    makes them device-local and reinstall-fatal: the same account on a new phone starts
--    empty, and the list can never be read by anything but that one client. Bookmarks are
--    account state, so they belong next to the account.
--
-- 2. Unique (userId, facilityId). "Saved" is a set, not a log. Without the constraint a
--    double tap on the save control produces two rows, the list renders duplicates, and
--    the unsave has to guess how many to delete. With it, saving is an idempotent upsert
--    and unsaving is a scoped delete that can be repeated safely.
--
-- 3. No status column, and no filtering on the facility here. A saved facility can later
--    be deactivated, unverified or reclassified RESTRICTED. Deleting the bookmark then
--    would silently discard the user's own data over an operator-side state change that is
--    routinely reversed, and an inner join that hides it would make bookmarks vanish with
--    no explanation. The row is kept verbatim; the read joins the facility and derives an
--    `available` flag, so an archived facility is a greyed-out entry, never a 500 and
--    never a disappearance.
--
-- 4. Both foreign keys CASCADE. A bookmark carries no financial or audit weight — unlike
--    Booking, which is deliberately RESTRICT against User — so it must never be the reason
--    a facility or an account row cannot be removed. Account deletion is a tombstone that
--    keeps the User row (see AccountDeletionService), which is precisely why the personal
--    preference data hanging off it has to be cleared explicitly there or removed by
--    cascade here rather than surviving indefinitely.
--
-- 5. Index (userId, createdAt). The only read is "this caller's bookmarks, newest first".
--    The unique index above is already usable for the userId equality, but it orders by
--    facilityId, so the list would sort in memory on every call. This one serves the
--    equality and the ordering together.

-- CreateTable
CREATE TABLE "SavedFacility" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedFacility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- See note 5.
CREATE INDEX "SavedFacility_userId_createdAt_idx" ON "SavedFacility"("userId", "createdAt");

-- CreateIndex
-- See note 2.
CREATE UNIQUE INDEX "SavedFacility_userId_facilityId_key" ON "SavedFacility"("userId", "facilityId");

-- AddForeignKey
ALTER TABLE "SavedFacility" ADD CONSTRAINT "SavedFacility_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedFacility" ADD CONSTRAINT "SavedFacility_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;
