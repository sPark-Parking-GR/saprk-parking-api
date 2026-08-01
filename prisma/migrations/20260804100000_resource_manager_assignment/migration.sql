-- Per-user management assignment for facilities and tariff plans.
--
-- 1. WHY. Authorization today is role plus OperatorMembership, so every member of an
--    operator sees everything that operator owns. The product needs it narrower: below
--    platform admin, a user may only view and edit the facilities and plans assigned to
--    them. The assignment is layered ON TOP of the operator scope, never instead of it —
--    the predicate is (operator term) AND (manager term), so a row here can never grant
--    access across a tenant boundary.
--
-- 2. Two tables, not one polymorphic one. A single (resourceType, resourceId) table cannot
--    carry a real foreign key, cannot cascade, and makes the narrowing predicate — which
--    runs on every dashboard list query — an un-indexable join on a discriminator. Two
--    tables cost one extra CREATE and buy referential integrity.
--
-- 3. Composite primary key (resourceId, userId). "Managed by" is a set, not a log: the
--    endpoint is an idempotent full replace, so a double submit must not be able to produce
--    two rows for the same pair. No surrogate id, because nothing addresses a single
--    assignment by itself.
--
-- 4. Both foreign keys CASCADE. An assignment is derived access control with no audit or
--    financial value of its own — the AuditLog row for the change is the record that
--    survives — so it must never be the reason a facility, a plan or an account cannot be
--    removed. NOTE that the User cascade does NOT fire for a retention purge: a purged user
--    is anonymised in place rather than deleted (LifecyclePurgeService.anonymiseUser), so
--    that path deletes these rows explicitly.
--
-- 5. assignedBy carries NO foreign key, matching the lifecycleChangedBy convention: it is
--    an audit fact about who granted the access and must outlive the granting actor's row.
--
-- 6. Index on (userId). The primary key leads with the resource id, so it cannot serve
--    "which resources does this user manage". That is exactly the direction the narrowing
--    predicate reads in, on every list, detail and map query, so it gets its own index.

-- CreateTable
CREATE TABLE "FacilityManager" (
    "facilityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT NOT NULL,

    CONSTRAINT "FacilityManager_pkey" PRIMARY KEY ("facilityId", "userId")
);

-- CreateTable
CREATE TABLE "TariffPlanManager" (
    "tariffPlanId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT NOT NULL,

    CONSTRAINT "TariffPlanManager_pkey" PRIMARY KEY ("tariffPlanId", "userId")
);

-- CreateIndex
-- See note 6.
CREATE INDEX "FacilityManager_userId_idx" ON "FacilityManager"("userId");

-- CreateIndex
-- See note 6.
CREATE INDEX "TariffPlanManager_userId_idx" ON "TariffPlanManager"("userId");

-- AddForeignKey
ALTER TABLE "FacilityManager" ADD CONSTRAINT "FacilityManager_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacilityManager" ADD CONSTRAINT "FacilityManager_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TariffPlanManager" ADD CONSTRAINT "TariffPlanManager_tariffPlanId_fkey" FOREIGN KEY ("tariffPlanId") REFERENCES "TariffPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TariffPlanManager" ADD CONSTRAINT "TariffPlanManager_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: assign every existing facility and tariff plan to every current member of its
-- owning operator.
--
-- WITHOUT this the restriction is a lockout, not a narrowing: the new predicate takes
-- effect the instant this migration lands, and every operator user would find their
-- dashboard empty with no way to grant themselves back what they already owned. Seeding
-- exactly today's visibility means nothing changes on deploy — the restriction only starts
-- to bite for resources created afterwards, which are auto-assigned to their creator.
--
-- Deliberately unfiltered by lifecycleStatus: an ARCHIVED facility restored tomorrow must
-- come back to the same people who could manage it yesterday, and an archived row that
-- nobody can be assigned to is a resource only a platform admin could ever recover.
--
-- assignedBy is the sentinel 'system:backfill' rather than any real user id. There was no
-- acting human — this grant is a migration artefact — and a synthetic value that cannot
-- collide with a cuid keeps that legible in the audit trail forever. The column has no
-- foreign key precisely so a non-user value like this one is expressible.
--
-- The ~1,500 ingested facilities under 'osm-unclaimed-operator' have no members at all, so
-- they correctly backfill to nothing and stay platform-admin-only until the operator that
-- claims them is onboarded.
--
-- The member predicate mirrors what ResourceManagersService will accept as an assignee, so
-- the backfill cannot mint a grant the API itself would refuse: an operator role only
-- (a PLATFORM_ADMIN already sees everything and a USER cannot reach an operator surface at
-- all), lifecycle ACTIVE, and not a self-service deletion tombstone. None of those accounts
-- can authenticate into an operator surface today, so excluding them still preserves every
-- bit of access that actually exists.
--
-- ON CONFLICT DO NOTHING makes each statement replayable by hand. Prisma runs a migration
-- once and wraps the file in a transaction, so this is insurance for an operator applying
-- the SQL manually, not a substitute for either.
INSERT INTO "FacilityManager" ("facilityId", "userId", "assignedAt", "assignedBy")
SELECT f."id", m."userId", now(), 'system:backfill'
FROM "Facility" f
JOIN "OperatorMembership" m ON m."operatorId" = f."operatorId"
JOIN "User" u ON u."id" = m."userId"
WHERE u."role" IN ('OPERATOR_ADMIN', 'OPERATOR_STAFF')
  AND u."lifecycleStatus" = 'ACTIVE'
  AND u."deletedAt" IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO "TariffPlanManager" ("tariffPlanId", "userId", "assignedAt", "assignedBy")
SELECT p."id", m."userId", now(), 'system:backfill'
FROM "TariffPlan" p
JOIN "OperatorMembership" m ON m."operatorId" = p."operatorId"
JOIN "User" u ON u."id" = m."userId"
WHERE u."role" IN ('OPERATOR_ADMIN', 'OPERATOR_STAFF')
  AND u."lifecycleStatus" = 'ACTIVE'
  AND u."deletedAt" IS NULL
ON CONFLICT DO NOTHING;
