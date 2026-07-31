-- Operator member invites: make the `operator_staff` role reachable.
--
-- 1. OperatorInvite.kind. Until now every invite meant the same thing — "a platform admin
--    is onboarding a brand-new business" — so the flow was implicit in the code path that
--    wrote the row. Adding staff invites gives the table a second flow that attaches to an
--    operator which ALREADY exists, and the two behave differently in three places:
--    who may issue them, whether accept() flips the operator to VERIFIED, and whether
--    revoke() deletes the operator. That last one is destructive, and it currently decides
--    by looking at the operator's status (PENDING => unclaimed shell => delete it). A
--    MEMBER invite must never be able to reach that branch, and guarding it on a status
--    heuristic would leave the guarantee one future state transition away from breaking.
--    The discriminator is therefore stored, not inferred.
--
--    The two flows are NOT split into two tables: they share the token hash (a UNIQUE
--    column that accept()/validate() look an opaque token up by), the status lifecycle,
--    expiry, revoke and resend. Splitting them would duplicate all of that and force
--    every token lookup to probe two tables.
--
-- 2. OperatorInvite.role. accept() hardcoded OperatorMemberRole.ADMIN, which is precisely
--    why no staff member could ever exist. The role the invite provisions now travels with
--    the invite, decided and authorized at issue time rather than at redemption time —
--    the person redeeming the link must not get a say in the privileges it grants.
--
-- 3. Backfill. Both columns take DEFAULTs equal to the old hardcoded behaviour
--    (ONBOARDING / ADMIN), so every pre-existing row is described correctly with no
--    UPDATE: all of them were platform-admin onboarding invites that provisioned an admin.
--    The defaults are kept on the columns afterwards rather than dropped, because
--    ONBOARDING/ADMIN remains the shape of the flow that existed first and every writer
--    of a MEMBER row sets both fields explicitly.
--
-- 4. The operatorId index supports the new tenancy-scoped reads: an operator admin listing
--    or resending invites is filtered to the operators they belong to, which is a lookup
--    by operatorId that previously had no index (the column existed only to be followed
--    to its parent row).

-- CreateEnum
CREATE TYPE "OperatorInviteKind" AS ENUM ('ONBOARDING', 'MEMBER');

-- AlterTable
ALTER TABLE "OperatorInvite" ADD COLUMN     "kind" "OperatorInviteKind" NOT NULL DEFAULT 'ONBOARDING',
ADD COLUMN     "role" "OperatorMemberRole" NOT NULL DEFAULT 'ADMIN';

-- CreateIndex
CREATE INDEX "OperatorInvite_operatorId_idx" ON "OperatorInvite"("operatorId");
