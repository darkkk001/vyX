-- Smart Dealer auto-accept/reject tolerances (null = off)
ALTER TABLE "Broker" ADD COLUMN "smartDealerAcceptPct" DECIMAL(6,3);
ALTER TABLE "Broker" ADD COLUMN "smartDealerRejectPct" DECIMAL(6,3);

-- A-Book / B-Book routing (record-keeping only, no live execution)
CREATE TYPE "BookType" AS ENUM ('A_BOOK', 'B_BOOK');
ALTER TABLE "BrokerSymbol" ADD COLUMN "defaultBookType" "BookType" NOT NULL DEFAULT 'B_BOOK';
ALTER TABLE "Position" ADD COLUMN "bookType" "BookType" NOT NULL DEFAULT 'B_BOOK';

-- Requote-to-client flow
ALTER TYPE "OrderStatus" ADD VALUE 'REQUOTED';
ALTER TABLE "Order" ADD COLUMN "requotedPrice" DECIMAL(18,5);
