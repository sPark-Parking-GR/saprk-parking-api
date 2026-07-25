-- Revoking a pending invite deletes its never-claimed shell operator, but the invite
-- row itself must survive (with status REVOKED) for audit visibility in the invites
-- list. Cascade would have deleted it along with the operator; SetNull keeps it.
ALTER TABLE "OperatorInvite" DROP CONSTRAINT "OperatorInvite_operatorId_fkey";

ALTER TABLE "OperatorInvite" ALTER COLUMN "operatorId" DROP NOT NULL;

ALTER TABLE "OperatorInvite" ADD CONSTRAINT "OperatorInvite_operatorId_fkey"
  FOREIGN KEY ("operatorId") REFERENCES "ParkingOperator"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
