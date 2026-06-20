-- Credentials auth (authjs provider) stores a scrypt password hash on the user.
-- Nullable so externally-provisioned accounts (OAuth/SSO providers) can omit it.
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;
