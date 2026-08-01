-- Subscription plans and entitlements. This replaces the hardcoded one-facility-per-
-- operator cap with a limit the platform can sell against, and it is deliberately a PURE
-- REFACTOR on day one: every existing operator lands on a Starter plan whose maxFacilities
-- is 1, which is exactly what the dropped index enforced.
--
-- 1. WHY catalog and instance are two tables. A plan is a product many tenants share and
--    that must keep describing what was sold long after its price moves on; a subscription
--    is one tenant's agreement with its own period, status and negotiated deviations.
--    Collapsing them would either rewrite history when pricing changes or duplicate the
--    whole product definition per tenant.
--
-- 2. WHY entitlements are JSON and not columns. The set of things a plan grants is product
--    surface that changes on a marketing cadence, not a schema cadence; a column per limit
--    turns "add a feature flag" into a migration. The trade is that Postgres cannot type
--    the blob, so EVERY read and write crosses entitlementsSchema (Zod) in
--    src/subscriptions/entitlements.schema.ts. An unvalidated JSON blob deciding what a
--    customer may do is where drift becomes a billing dispute.
--
-- 3. WHY Starter leaves maxTariffPlans and maxStaffSeats NULL (unlimited). Nothing limits
--    either today. Any finite number here would retroactively put existing tenants over
--    quota on the day this migration runs, which is precisely the silent breakage the
--    downgrade guard exists to prevent. A real limit is a deliberate product decision,
--    applied later through a plan change that now fails loudly instead of quietly.
--    maxFacilities is 1 because that number is not new — it is the dropped index.
--
-- 4. WHY commissionBps is 0. No commission is charged anywhere in the codebase today and
--    nothing reads this field yet. Seeding a non-zero rate that no code enforces would be
--    a number that looks authoritative and is not.
--
-- 5. WHY the PARTIAL unique index on (operatorId) WHERE status <> 'CANCELLED'. At most one
--    LIVE subscription per operator, while cancelled ones accumulate as history. This is
--    also the race-free half of assign/change: two administrators assigning a plan to the
--    same operator simultaneously produce one live row, not two. Mirrors the convention
--    already used by Facility_operatorId_claimed_key and
--    TariffPlan_operator_active_default_key.
--
-- 6. WHY the synthetic unclaimed operator gets NO subscription row. It holds ~1,500
--    ingested facilities and is an ingestion artifact, not a customer. The old index
--    exempted it by name (WHERE "operatorId" <> 'osm-unclaimed-operator'); the entitlement
--    service exempts it by the same name before any quota is read. Giving it a Starter row
--    would render it in the admin surface as a tenant 1,499 facilities over quota.
--
-- 7. WHY Facility_operatorId_claimed_key is dropped rather than widened. A unique index
--    cannot express "at most N", and N is now per-operator data rather than a constant.
--    The serialization guarantee it provided moves to the SELECT ... FOR UPDATE on the
--    ParkingOperator row that FacilitiesService.create already takes before counting —
--    previously belt-and-suspenders behind this index, now the primary control, and
--    covered by test/subscriptions/facility-quota.e2e-spec.ts racing real creates.

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'YEARLY');
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED');

-- CreateTable (see notes 1 and 2)
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "interval" "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
    "entitlements" JSONB NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "lifecycleStatus" "LifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
    "lifecycleChangedAt" TIMESTAMP(3),
    "lifecycleChangedBy" TEXT,
    "lifecycleReason" TEXT,
    "purgeAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorSubscription" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentPeriodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodEnd" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "providerSubscriptionId" TEXT,
    "entitlementOverride" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_code_key" ON "SubscriptionPlan"("code");
CREATE INDEX "SubscriptionPlan_lifecycleStatus_sortOrder_idx" ON "SubscriptionPlan"("lifecycleStatus", "sortOrder");

-- Nullable and unique-when-set: Postgres treats NULLs as distinct, so every unwired
-- subscription coexists while a real provider id can never be claimed twice.
CREATE UNIQUE INDEX "OperatorSubscription_providerSubscriptionId_key" ON "OperatorSubscription"("providerSubscriptionId");
CREATE INDEX "OperatorSubscription_operatorId_status_idx" ON "OperatorSubscription"("operatorId", "status");
CREATE INDEX "OperatorSubscription_planId_idx" ON "OperatorSubscription"("planId");

-- At most one live subscription per operator (see note 5).
CREATE UNIQUE INDEX "OperatorSubscription_operator_live_key"
  ON "OperatorSubscription" ("operatorId")
  WHERE "status" <> 'CANCELLED';

-- AddForeignKey
ALTER TABLE "OperatorSubscription" ADD CONSTRAINT "OperatorSubscription_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "ParkingOperator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE: a plan with live subscribers must be archived, never deleted, or
-- the agreements pointing at it lose the terms they were sold under.
ALTER TABLE "OperatorSubscription" ADD CONSTRAINT "OperatorSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed the Starter plan (see notes 3 and 4). Fixed id so the backfill below and any
-- environment that re-runs this chain agree on which row it is.
INSERT INTO "SubscriptionPlan" (
  "id", "code", "name", "description", "priceCents", "currency", "interval",
  "entitlements", "isPublic", "sortOrder", "createdAt", "updatedAt"
) VALUES (
  'plan_starter',
  'starter',
  'Starter',
  'One facility, unlimited tariff plans and staff. The plan every operator predating billing was migrated onto.',
  0,
  'EUR',
  'MONTHLY',
  '{"maxFacilities":1,"maxTariffPlans":null,"maxStaffSeats":null,"features":[],"commissionBps":0}'::jsonb,
  true,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

-- Backfill every real operator onto Starter (see note 6 for the one exclusion). Archived
-- and tombstoned operators are included on purpose: a restore must not land a tenant with
-- no subscription, and an operator with no live subscription resolves to Starter anyway,
-- so including them costs nothing and keeps the admin surface honest.
INSERT INTO "OperatorSubscription" (
  "id", "operatorId", "planId", "status", "currentPeriodStart", "createdAt", "updatedAt"
)
SELECT
  'opsub_' || "id",
  "id",
  'plan_starter',
  'ACTIVE',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "ParkingOperator"
WHERE "id" <> 'osm-unclaimed-operator';

-- Drop the hardcoded cap (see note 7). Original in 20260724120000_invite_and_facility_cap,
-- recreated with the lifecycle predicate in 20260802100000_resource_lifecycle as
-- WHERE "operatorId" <> 'osm-unclaimed-operator' AND "lifecycleStatus" = 'ACTIVE'.
-- EntitlementService.assertCanCreateFacility now counts under exactly that same predicate,
-- so an archived facility frees its slot precisely as it did before.
DROP INDEX "Facility_operatorId_claimed_key";
