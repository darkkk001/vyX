-- Dealer queue expiry (owner decision 2026-10-29, lib/order-expiry.ts). Metadata-only column adds (no rewrite, no long lock)
-- plus a small backfill:
--   Broker.requoteExpirySeconds / offerExpirySeconds with the approved defaults (a REQUOTED offer lives 60 s, a client
--   MARKET order waiting for the dealer 300 s); every existing broker gets them.
--   Order.queuedAt: when a MARKET order joined the dealer queue, written once (an SL / TP edit moves updatedAt, never this).
-- No status enum change: an expired order is CANCELLED + OFFER_EXPIRED.
-- The sweep's index is NOT here (a plain CREATE INDEX blocks Order writes while it builds): it is created out of band
-- with CREATE INDEX CONCURRENTLY, see handoff/dealer-queue-expiry-deploy.md. It is not in schema.prisma either.
-- Revert: ALTER TABLE "Order" DROP COLUMN "queuedAt";
--   ALTER TABLE "Broker" DROP COLUMN "offerExpirySeconds", DROP COLUMN "requoteExpirySeconds";
ALTER TABLE "Broker"
  ADD COLUMN "requoteExpirySeconds" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "offerExpirySeconds" INTEGER NOT NULL DEFAULT 300;
ALTER TABLE "Order" ADD COLUMN "queuedAt" TIMESTAMPTZ(3);
-- Backfill (best effort): orders already waiting for the dealer get their last update as the queue time. They are
-- either expired by the first sweep or within 300 s of it, which clears any backlog.
UPDATE "Order" SET "queuedAt" = "updatedAt" WHERE "type" = 'MARKET' AND "status" = 'PENDING' AND "queuedAt" IS NULL;
