-- The rider's identity at the billing provider, added for the self-serve driver checkout
-- flow. One table, and deliberately not a column on DriverSubscription.
--
-- 1. WHY a separate table rather than `providerCustomerId` on DriverSubscription. A
--    free-tier rider has NO DriverSubscription row at all — that is 20260827100000's
--    explicit no-backfill design — yet a provider customer has to exist the first time they
--    open checkout, which is strictly BEFORE any subscription does. Hanging the customer id
--    off the subscription would make the very first purchase unrepresentable until after it
--    completed.
--
-- 2. WHY it outlives the subscription. A rider whose subscription lapses or is cancelled and
--    who later resubscribes must reach the SAME provider customer, or their payment methods
--    and invoice history fork into two identities the provider will never reconcile. Keying
--    on userId — not on the subscription — is what guarantees that across any number of
--    subscribe/cancel cycles.
--
-- 3. WHY `provider` is stored alongside the id. `cus_mock_…` and a real Stripe `cus_…` are
--    not interchangeable, and a deployment that moves from the mock provider to Stripe must
--    mint a fresh customer instead of handing Stripe an id it has never issued. The column
--    is what lets the read path tell those apart instead of silently sending a dead id
--    upstream.
--
-- 4. WHY the (provider, providerCustomerId) unique. It is the reverse lookup the webhook
--    handler needs: a `customer.subscription.updated` that arrives before the row carries a
--    providerSubscriptionId identifies the rider only by customer id. Unique rather than a
--    plain index because one provider customer belongs to exactly one rider — two rows
--    claiming the same one would make that lookup ambiguous at the exact moment money is
--    involved.
--
-- 5. WHY the primary key is userId itself rather than a cuid with a unique on userId. At
--    most one billing identity per rider is the whole point, and making it the key is the
--    cheapest way for the database to say so — it is also what turns two concurrent
--    first-ever checkouts into one insert and one P2002 the caller re-reads through, rather
--    than two customers for one person.

-- CreateTable
CREATE TABLE "DriverBillingCustomer" (
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerCustomerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriverBillingCustomer_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex (see note 4)
CREATE UNIQUE INDEX "DriverBillingCustomer_provider_providerCustomerId_key" ON "DriverBillingCustomer"("provider", "providerCustomerId");

-- CASCADE from User, matching DriverSubscription: a billing pointer is not a financial
-- record that must survive its subscriber. The invoices and charges the provider holds are,
-- and they live outside this database.
ALTER TABLE "DriverBillingCustomer" ADD CONSTRAINT "DriverBillingCustomer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
