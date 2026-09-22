-- Every booking must belong to an authenticated consumer account.
--
-- 1. Guest bookings are removed as a product concept, so guestEmail/guestPhone go with
--    them. They were the only reason Booking.userId was nullable.
-- 2. Booking.userId becomes NOT NULL, which flips its FK from ON DELETE SET NULL to
--    ON DELETE RESTRICT. That is the point: SET NULL meant deleting a User silently
--    detached every booking they ever made, destroying revenue attribution with no
--    error. Under RESTRICT the delete fails loudly, and account removal has to go
--    through anonymisation instead.
--
-- The guard below aborts the whole migration if any booking is still unowned. It
-- deliberately does NOT backfill to a synthetic placeholder account: reattributing a
-- stranger's booking to an account that never made it is data corruption, and it would
-- also make that placeholder undeletable forever under the new RESTRICT rule. Pre-launch
-- this is a no-op; if it ever fires, the rows need a human decision, not a default.

DO $$
DECLARE
  orphaned bigint;
BEGIN
  SELECT count(*) INTO orphaned FROM "Booking" WHERE "userId" IS NULL;
  IF orphaned > 0 THEN
    RAISE EXCEPTION
      'Cannot make Booking.userId required: % booking row(s) have a NULL userId. Resolve these rows manually — do not backfill them to a placeholder account.',
      orphaned;
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_userId_fkey";

-- AlterTable
ALTER TABLE "Booking" DROP COLUMN "guestEmail",
DROP COLUMN "guestPhone",
ALTER COLUMN "userId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
