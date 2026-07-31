-- Booking credentials and check-out repricing.
--
-- 1. qrTokenHash -> qrSecret. qrTokenHash held an UNSALTED sha256 of accessCode, which
--    was 8 hex characters (32 bits): a leak of the column is reversible by brute force
--    in seconds, and the "secret" was in any case derivable from a code that is printed
--    on receipts and read aloud over the phone. It is replaced by an independent
--    32-byte random secret minted at confirm time, stored in full because the rotating
--    QR codes built on top of it are computed server-side from the secret itself.
--
--    The old column is DROPPED rather than migrated. Its contents are worthless (a hash
--    of a value we still hold) and must not be carried into the new column. Rows that
--    were already CONFIRMED are deliberately NOT backfilled with a fresh secret: no
--    feature reads qrSecret yet, and minting live credentials inside a migration would
--    issue them outside the application's audit trail. They stay NULL until the QR
--    phase decides how to reissue them. No production data exists today, so in practice
--    this affects nothing; the statements are written to be correct if it ever did.
--
-- 2. accessCode rows are left UNTOUCHED. New codes are base32 over 16 random bytes
--    (26 characters) drawn from an alphabet with no visually ambiguous letters; the old
--    8-hex-character codes do not match that shape. Rewriting them would invalidate a
--    code the customer already has in an email, on a printout or written down, i.e. it
--    would lock a paying driver out of a barrier to fix a format. The weak old codes age
--    out with their bookings, and the credential that actually gates entry (qrSecret) is
--    no longer derived from them. No CHECK constraint is added for the same reason: the
--    format is an application concern, and the column must keep accepting legacy values.
--
-- 3. tariffPlanId / tariffPlanVersion persist the pin the quote already computed. The
--    schema documents that "quotes pin (planId, version) so price can't shift mid-hold",
--    but the booking never stored it, so the invariant could not be verified and no
--    historical booking could be traced to the plan revision that priced it. Check-out
--    reprices against this pin. Intentionally plain columns, not a foreign key: this is
--    a historical fact about a past price, and a FK would make plan and operator
--    lifecycle depend on every booking ever taken.
--
-- 4. priceAdjustmentCents records the signed difference check-out computed
--    (finalPriceCents - quotedPriceCents). It is a ledger entry, not a movement: the
--    original payment was captured at confirm, so charging an overstay requires a new
--    payment intent and refunding an early departure is a business-policy decision.
--    Both are deliberately left to an explicit follow-up, and this column is the queue.

-- DropIndex
DROP INDEX "Booking_qrTokenHash_key";

-- AlterTable
ALTER TABLE "Booking" DROP COLUMN "qrTokenHash",
ADD COLUMN     "qrSecret" TEXT,
ADD COLUMN     "tariffPlanId" TEXT,
ADD COLUMN     "tariffPlanVersion" INTEGER,
ADD COLUMN     "priceAdjustmentCents" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Booking_qrSecret_key" ON "Booking"("qrSecret");
