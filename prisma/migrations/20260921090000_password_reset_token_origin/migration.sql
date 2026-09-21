-- Which flow minted a password reset grant.
--
-- The grant mechanism itself is deliberately shared: the signed-in change-password flow
-- issues exactly the same single-use, one-hour, sha256-hashed token as the logged-out
-- forgot-password flow and it is consumed by the same endpoint. A second table would have
-- been the same five columns plus a second copy of the consume/invalidate races.
--
-- This column is what keeps the two distinguishable after the fact: the consume path reads
-- it to decide whether it writes `password.reset_completed` or `password.changed` to the
-- audit log. Without it a completed change and a completed reset are the same row, and the
-- knowledge-of-current-password factor the change flow enforces leaves no trace.
--
-- DEFAULT 'FORGOT_PASSWORD' so grants already outstanding when this ships keep their
-- meaning: every token minted before today came from the forgot-password endpoint, which
-- was the only issuer. NOT NULL is therefore safe without a backfill pass.
--
-- Deliberately unindexed: it is only ever read off a row already located by its unique
-- tokenHash, never filtered on.

-- CreateEnum
CREATE TYPE "PasswordResetOrigin" AS ENUM ('FORGOT_PASSWORD', 'CHANGE_PASSWORD');

-- AlterTable
ALTER TABLE "PasswordResetToken" ADD COLUMN     "origin" "PasswordResetOrigin" NOT NULL DEFAULT 'FORGOT_PASSWORD';
