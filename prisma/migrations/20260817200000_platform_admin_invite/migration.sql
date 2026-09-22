-- A platform administrator recruits a peer.
--
-- Its own table rather than a third OperatorInviteKind: operatorId, businessName and
-- OperatorMemberRole are all meaningless for a platform admin, so reusing OperatorInvite
-- would add three permanently-null columns and a nullable operator relation that every
-- existing read would then have to reason about.
--
-- Only the sha256 hash of the token is stored, matching OperatorInvite: the raw token
-- exists solely inside the email that carried it, so a database leak yields nothing
-- redeemable.
--
-- invitedById is a real foreign key, unlike the lifecycle audit columns: this row is
-- operational rather than a historical fact that has to outlive its actor.
CREATE TABLE "PlatformAdminInvite" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "tokenHash" TEXT NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformAdminInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformAdminInvite_tokenHash_key" ON "PlatformAdminInvite"("tokenHash");
CREATE INDEX "PlatformAdminInvite_email_idx" ON "PlatformAdminInvite"("email");
CREATE INDEX "PlatformAdminInvite_status_idx" ON "PlatformAdminInvite"("status");

ALTER TABLE "PlatformAdminInvite"
  ADD CONSTRAINT "PlatformAdminInvite_invitedById_fkey"
  FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
