-- Server-side session revocation.
--
-- User.sessionsValidFrom is a watermark set to "now" on sign-out. Any JWT whose standard
-- `iat` claim is not strictly newer than it is rejected: by the API auth guard on every
-- request, and — the one that matters — by the authjs refresh endpoint, which is what
-- actually closes the 30-day stolen-refresh-token window. Access tokens are stateless
-- and short-lived, so before this column there was no way to kill a session at all.
--
-- A timestamp is used instead of an integer version claim because the platform has two
-- token issuers: we mint the authjs JWT and control its claims, but Google mints the
-- Firebase ID token and we do not. Both already carry `iat`, so a single column enforces
-- revocation uniformly with no custom claims on either side.
--
-- Nullable with no backfill: NULL means "never revoked", so this migration invalidates
-- no existing session. No index — the column is only ever read by User primary key.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sessionsValidFrom" TIMESTAMP(3);
