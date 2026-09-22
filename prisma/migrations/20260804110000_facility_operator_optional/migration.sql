-- A platform admin may create a facility with no operator assigned (to be claimed or
-- assigned later). Operator deletion must still fail while it owns facilities rather
-- than silently orphan them, so onDelete stays RESTRICT, unlike the OperatorInvite
-- SetNull precedent (revoking an invite is expected to detach it from its operator).
ALTER TABLE "Facility" DROP CONSTRAINT "Facility_operatorId_fkey";

ALTER TABLE "Facility" ALTER COLUMN "operatorId" DROP NOT NULL;

ALTER TABLE "Facility" ADD CONSTRAINT "Facility_operatorId_fkey"
  FOREIGN KEY ("operatorId") REFERENCES "ParkingOperator"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
