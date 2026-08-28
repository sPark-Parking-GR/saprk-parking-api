-- Operator self-serve billing: the tenant's identity at the provider, and the ordering
-- high-water mark its webhook handler needs. Both are the exact mirrors of what
-- 20260827300000 and 20260827500000 added for drivers, so the reasoning is recorded there
-- in full and only what DIFFERS for operators is repeated here.

-- 1. WHY the key is operatorId and not the admin's userId. The customer the invoices belong
--    to is the BUSINESS. An operator's admins come and go — a second admin is invited, the
--    founder leaves, ownership changes — and keying the billing identity to whichever person
--    happened to open checkout first would fork one tenant's payment methods and invoice
--    history across its staff, and orphan them entirely when that person's account is purged.
--
-- 2. WHY it is not a column on OperatorSubscription. Same as the driver case: an operator on
--    the default Starter plan has no OperatorSubscription row at all (entitlements fall back
--    to the default plan in code), yet a provider customer must exist the first time they
--    open checkout — strictly before any subscription does.
--
-- 3. WHY `provider` travels with the id, and why (provider, providerCustomerId) is UNIQUE.
--    `cus_mock_…` is not interchangeable with a real Stripe `cus_…`, and the composite is the
--    reverse lookup the webhook takes when an event names only the customer. Unique rather
--    than indexed because one provider customer belongs to exactly one operator.

-- CreateTable
CREATE TABLE "OperatorBillingCustomer" (
    "operatorId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerCustomerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorBillingCustomer_pkey" PRIMARY KEY ("operatorId")
);

-- CreateIndex (see note 3)
CREATE UNIQUE INDEX "OperatorBillingCustomer_provider_providerCustomerId_key" ON "OperatorBillingCustomer"("provider", "providerCustomerId");

-- CASCADE from ParkingOperator, matching OperatorSubscription: a billing pointer is not a
-- financial record that must survive its subscriber. The invoices and charges the provider
-- holds are, and they live outside this database.
ALTER TABLE "OperatorBillingCustomer" ADD CONSTRAINT "OperatorBillingCustomer_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "ParkingOperator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Out-of-order webhook defence, identical in purpose to
-- 20260827500000_driver_subscription_last_event_at: a retried `subscription.updated` that
-- lands after the `subscription.deleted` which really ended the agreement must not flip a
-- cancelled tenant back to ACTIVE — which for an operator restores facility, tariff and seat
-- quota nobody is paying for. Nullable and deliberately NOT backfilled: NULL means "no
-- provider event has touched this row yet, accept the next one", which is the only safe
-- reading for the manual assignments every existing row is.
ALTER TABLE "OperatorSubscription" ADD COLUMN "lastEventAt" TIMESTAMP(3);
