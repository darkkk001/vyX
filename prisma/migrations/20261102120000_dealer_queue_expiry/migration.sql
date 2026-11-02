-- Dealer queue expiry (owner decision 2026-10-29, lib/order-expiry.ts). Column adds ONLY: each is metadata-only (a
-- nullable column, or a constant default on PG 11+), so the ACCESS EXCLUSIVE lock is held for milliseconds, no scan,
-- no rewrite.
--   Broker.requoteExpirySeconds / offerExpirySeconds with the approved defaults (a REQUOTED offer lives 60 s, a client
--   MARKET order waiting for the dealer 300 s); every existing broker gets them.
--   Order.queuedAt: when a MARKET order joined the dealer queue, written once (an SL / TP edit moves updatedAt, never this).
-- No status enum change: an expired order is CANCELLED + OFFER_EXPIRED.
-- NOT here on purpose, both run by hand AFTER this migration (deploy/dealer-queue-expiry-runbook.md, mandatory steps):
--   the sweep's index Order_status_type_idx (CREATE INDEX CONCURRENTLY; a plain CREATE INDEX blocks Order writes), and
--   the queuedAt backfill of orders already waiting (an UPDATE here would scan Order under this migration's lock).
-- Revert: ALTER TABLE "Order" DROP COLUMN "queuedAt";
--   ALTER TABLE "Broker" DROP COLUMN "offerExpirySeconds", DROP COLUMN "requoteExpirySeconds";
ALTER TABLE "Broker"
  ADD COLUMN "requoteExpirySeconds" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "offerExpirySeconds" INTEGER NOT NULL DEFAULT 300;
ALTER TABLE "Order" ADD COLUMN "queuedAt" TIMESTAMPTZ(3);
