-- Completes the behaviour-preserving backfill.
--
-- The first pass granted staff what the DASHBOARD NAVIGATION let them reach — bookings, the
-- scanner and reporting. The API is more permissive than the nav: facilities read routes
-- have always admitted operator_staff, they are simply not linked in the sidebar.
--
-- Since the routes are about to start requiring org:facility.read, granting it here is what
-- keeps the axis a no-op on deploy. Backfilling to match the nav rather than the actual
-- surface would have quietly removed an API capability from every existing staff account.
UPDATE "OperatorMembership"
SET "scopes" = array_append("scopes", 'org:facility.read')
WHERE "role" = 'STAFF'
  AND NOT ('org:facility.read' = ANY("scopes"));
