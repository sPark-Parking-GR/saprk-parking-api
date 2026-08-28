-- Scope the webhook replay gate PER CONSUMER.
--
-- WHY. WebhookEvent.providerEventId was UNIQUE across the whole table, but three independent
-- handlers insert into it: booking payments, driver subscriptions and operator subscriptions.
-- The subscription pair are TWO Stripe endpoints on ONE Stripe account, both subscribed to
-- checkout.session.completed, customer.subscription.updated, customer.subscription.deleted
-- and invoice.payment_failed, and Stripe cannot filter a subscription by metadata — so it
-- delivers the same `evt_…` to both. Whichever transaction committed first claimed that id
-- table-wide; the other handler's insert then raised P2002 and was read as "already
-- processed", acknowledged 200 and never retried, despite having applied nothing.
--
-- Two ways that lost money: an operator's real checkout.session.completed landing on the
-- driver endpoint first (which correctly no-ops it as "not a driver event" but still commits
-- the ledger row) left the operator charged with no subscription; and a real
-- customer.subscription.deleted swallowed the same way left a cancelled agreement stuck
-- ACTIVE, with no delivery left to reprocess it.
--
-- The gate is still insert-first inside the state transaction — only its scope changes, from
-- "this event id has been seen" to "THIS handler has seen this event id".

-- Nullable first: the column has no sensible default and every existing row must be told
-- apart before it can be made NOT NULL.
ALTER TABLE "WebhookEvent" ADD COLUMN "surface" TEXT;

-- Backfill from `type`, the only column that distinguishes the writers. The booking-payments
-- handler only ever sees the provider's raw payment/refund vocabulary (`payment_intent.*`,
-- `charge.refund.*`); the subscription handlers write the normalised four the billing package
-- emits, which no payment event can collide with.
--
-- Subscription rows are attributed to 'driver-subscription' because that surface is the only
-- one that could have written them: the operator handler ships in this same release and has
-- never run against any database this migration will touch. Rows the driver surface recorded
-- for events that were really an operator's are the bug itself, and attributing them here to
-- the surface that actually recorded them is what lets the operator surface process those
-- event ids for the first time — where applyCheckoutCompleted's providerSubscriptionId check
-- is the second idempotency line for anything that did somehow get applied twice.
UPDATE "WebhookEvent"
SET "surface" = CASE
  WHEN "type" IN (
    'checkout.completed',
    'subscription.updated',
    'subscription.deleted',
    'invoice.payment_failed'
  ) THEN 'driver-subscription'
  ELSE 'payments'
END;

ALTER TABLE "WebhookEvent" ALTER COLUMN "surface" SET NOT NULL;

-- DropIndex
DROP INDEX "WebhookEvent_providerEventId_key";

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_providerEventId_surface_key" ON "WebhookEvent"("providerEventId", "surface");
