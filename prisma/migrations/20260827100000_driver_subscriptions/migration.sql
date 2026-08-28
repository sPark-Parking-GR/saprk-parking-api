-- Driver subscription plans. The rider-facing counterpart of the operator pair added in
-- 20260803100000_subscription_entitlements, and deliberately a SCAFFOLD on day one: the
-- tables exist, nothing reads them yet, and no row is created for anybody.
--
-- 1. WHY two tables again, and WHY not one polymorphic plan model shared with the operator
--    side. Catalog-versus-instance is the same argument as before: a plan is a product many
--    subscribers share and must keep describing what was sold long after its price moves on.
--    Keeping the driver catalog SEPARATE from SubscriptionPlan is the second argument: the
--    two entitlement shapes have no key in common — an operator buys platform capacity
--    (maxFacilities, seats, commission), a rider buys perks applied to a booking (discount,
--    fee waiver) — so one shared table would be a JSON column with two disjoint dialects and
--    a discriminator nobody could enforce. This schema already treats differently-shaped
--    "plan" concepts as separate models (SubscriptionPlan vs TariffPlan).
--
-- 2. WHY the enums are REUSED rather than redefined. BillingInterval and SubscriptionStatus
--    describe the lifecycle of a paid agreement, which is identical whoever signed it. Two
--    parallel enums with the same members would be two things to keep in step and a
--    conversion at every boundary that ever handles both.
--
-- 3. WHY NO BACKFILL, and no rider equivalent of the `starter` plan. 20260803100000 put
--    every ParkingOperator on a Starter row because operator entitlements resolve against a
--    real default-plan row and fail closed when it is missing. Riders are consumer-scale:
--    a row per User would be millions of rows carrying no information, and every one of them
--    would have to be maintained by the account lifecycle. Instead a user with no
--    DriverSubscription resolves to FREE_TIER_DRIVER_ENTITLEMENTS in code — all perks off —
--    which is both the safe default and the true one, so there is nothing to fail closed
--    against. See DriverEntitlementService.resolveEffective.
--
-- 4. WHY the PARTIAL unique index on (userId) WHERE status <> 'CANCELLED'. Same reason as
--    OperatorSubscription_operator_live_key: at most one LIVE subscription per subscriber
--    while cancelled ones accumulate as history, and it is the race-free half of
--    assign/change — two administrators (or an admin and a webhook) assigning a plan to the
--    same rider simultaneously produce one live row, not two. Not expressible as a Prisma
--    @@unique, so it is raw SQL here and a plain @@index in the schema.
--
-- 5. WHY entitlements are JSON. Unchanged from the operator side: the set of things a plan
--    grants moves on a marketing cadence, not a schema cadence. The trade is that Postgres
--    cannot type the blob, so EVERY read and write crosses driverEntitlementsSchema (Zod) in
--    src/subscriptions/driver-entitlements.schema.ts.

-- CreateTable (see notes 1 and 5)
CREATE TABLE "DriverSubscriptionPlan" (
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

    CONSTRAINT "DriverSubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable (see note 3 for why nothing is inserted into it)
CREATE TABLE "DriverSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
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

    CONSTRAINT "DriverSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DriverSubscriptionPlan_code_key" ON "DriverSubscriptionPlan"("code");
CREATE INDEX "DriverSubscriptionPlan_lifecycleStatus_sortOrder_idx" ON "DriverSubscriptionPlan"("lifecycleStatus", "sortOrder");

-- Nullable and unique-when-set: Postgres treats NULLs as distinct, so every unwired
-- subscription coexists while a real provider id can never be claimed twice.
CREATE UNIQUE INDEX "DriverSubscription_providerSubscriptionId_key" ON "DriverSubscription"("providerSubscriptionId");
CREATE INDEX "DriverSubscription_userId_status_idx" ON "DriverSubscription"("userId", "status");
CREATE INDEX "DriverSubscription_planId_idx" ON "DriverSubscription"("planId");

-- At most one live subscription per rider (see note 4).
CREATE UNIQUE INDEX "DriverSubscription_user_live_key"
  ON "DriverSubscription" ("userId")
  WHERE "status" <> 'CANCELLED';

-- CASCADE from User: unlike Booking, a subscription row is not a financial record that must
-- survive its subscriber. The payments and invoices a provider holds are, and they live
-- outside this table.
ALTER TABLE "DriverSubscription" ADD CONSTRAINT "DriverSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, not CASCADE: a plan with live subscribers must be archived, never deleted, or
-- the agreements pointing at it lose the terms they were sold under.
ALTER TABLE "DriverSubscription" ADD CONSTRAINT "DriverSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "DriverSubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
