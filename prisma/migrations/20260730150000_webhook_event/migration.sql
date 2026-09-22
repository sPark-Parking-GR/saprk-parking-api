-- Payment webhook replay ledger.
--
-- Payment providers redeliver webhooks: they retry on any non-200 response, and
-- duplicate or out-of-order delivery is documented behavior, not a fault. One row
-- per provider event id makes handling idempotent:
--
--   * The handler INSERTs this row FIRST, inside the same transaction as the state
--     change the event triggers. A redelivered event therefore hits the UNIQUE
--     constraint below (P2002) before any state is touched, is treated as "already
--     handled", and is acknowledged with 200 so the provider stops retrying.
--   * A handler that fails mid-way rolls the insert back together with its state
--     changes, so the provider's retry gets a clean second attempt. Effects are
--     applied at most once; only completed attempts are remembered.
--
-- outcome/processedAt record what the handler decided (processed, unknown type
-- acknowledged, unmatched payment, needs reconciliation) and payload keeps the
-- signature-verified event body — both exist for reconciliation, since a webhook
-- that is acknowledged but not acted on must still leave an audit trail.

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "outcome" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_providerEventId_key" ON "WebhookEvent"("providerEventId");
