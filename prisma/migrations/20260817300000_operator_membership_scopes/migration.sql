-- What a member may do inside ONE operator, as opposed to across the platform.
--
-- Per membership rather than per user: the same person can administer one operator and
-- work the barrier at another, which a single per-user set could not express.
ALTER TABLE "OperatorMembership" ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- BEHAVIOURALLY A NO-OP ON DEPLOY, and that is the point.
--
-- Every existing STAFF membership is backfilled with exactly what an OPERATOR_STAFF account
-- could already reach before scopes existed — bookings, the barrier scanner and reporting.
-- Introducing a permission axis must not silently take access away from people who are
-- mid-shift, nor hand them anything they did not have; the operator's admin decides changes
-- from here, deliberately.
--
-- ADMIN memberships are left empty on purpose. They derive the full set at read time, so a
-- scope added to the product later applies to existing admins instead of being missing from
-- every row written before it existed.
UPDATE "OperatorMembership"
SET "scopes" = ARRAY['org:booking.read', 'org:scan.execute', 'org:stats.read']
WHERE "role" = 'STAFF';
