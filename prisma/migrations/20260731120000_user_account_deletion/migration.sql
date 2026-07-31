-- Self-service account deletion (App Store Review Guideline 5.1.1(v)).
--
-- Deletion anonymises rather than removes. Booking.userId is NOT NULL and its foreign key
-- is ON DELETE RESTRICT on purpose: a booking is a financial record with a payment, a
-- refund and an operator on the other side of it, so cascading a user delete through it
-- would destroy accounting history, and RESTRICT would simply make deletion impossible for
-- anyone who has ever parked. The row therefore stays and is stripped instead — email
-- rewritten to a non-routable placeholder, displayName/avatarUrl/passwordHash/firebaseUid
-- nulled — leaving bookings, payments and reviews pointing at an identity that no longer
-- identifies anybody.
--
-- This column is what tells a tombstone apart from a live account: it fails authentication
-- unconditionally in the session-revocation check, independently of the sessionsValidFrom
-- watermark deletion also sets. Nullable with no backfill — every existing account is live.
-- No index: read only by User primary key, alongside sessionsValidFrom.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletedAt" TIMESTAMP(3);
