-- Amount SL / TP in the account currency (owner 2026-11-04): a leg is a price OR an amount (lib/amount-sltp.ts).
ALTER TABLE "Order" ADD COLUMN "slAmount" DECIMAL(18,2), ADD COLUMN "tpAmount" DECIMAL(18,2);
ALTER TABLE "Position" ADD COLUMN "slAmount" DECIMAL(18,2), ADD COLUMN "tpAmount" DECIMAL(18,2);
