-- Password reset grants.
--
-- Only the sha256 hash of the raw token is stored, mirroring OperatorInvite.tokenHash: the
-- raw 32-byte token exists solely inside the email that carried it, so a dump of this table
-- cannot be replayed. tokenHash is UNIQUE both to enforce that and because lookup is by
-- hash — the raw token is the only thing the API ever receives back.
--
-- usedAt is the single-use marker rather than a DELETE so a consumed grant stays visible for
-- the short window it lives; the same column doubles as the invalidation stamp applied to
-- every outstanding token of a user when a new one is issued or one is consumed.
--
-- ON DELETE CASCADE: these rows are worthless without their user, and unlike Booking there is
-- nothing to preserve for attribution.
--
-- The userId index serves the invalidate-all-outstanding writes; expiresAt is deliberately
-- unindexed — it is only ever read on a row already located by its unique hash.

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
