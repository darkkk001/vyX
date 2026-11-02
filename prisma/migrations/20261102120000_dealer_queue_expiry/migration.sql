-- Dealer queue expiry (owner decision 2026-10-29, lib/order-expiry.ts). Additive: two broker columns with the approved
-- defaults (a REQUOTED offer lives 60 s, a client MARKET order waiting for the dealer 300 s) and one index for the sweep.
-- Every existing broker gets the defaults. No status enum change: an expired order is CANCELLED + OFFER_EXPIRED.
-- Revert: DROP INDEX "Order_status_type_idx";
--   ALTER TABLE "Broker" DROP COLUMN "offerExpirySeconds", DROP COLUMN "requoteExpirySeconds";
ALTER TABLE "Broker"
  ADD COLUMN "requoteExpirySeconds" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "offerExpirySeconds" INTEGER NOT NULL DEFAULT 300;
CREATE INDEX "Order_status_type_idx" ON "Order"("status", "type");
