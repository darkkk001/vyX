-- Structured close fields (additive, nullable, no data rewrite). docs/POSITION-DEAL-MODEL.md section 0.
ALTER TABLE "Transaction" ADD COLUMN "closeVolume" DECIMAL(10,2),
ADD COLUMN "closePrice" DECIMAL(18,5),
ADD COLUMN "closeSwap" DECIMAL(18,2),
ADD COLUMN "closeByPositionId" TEXT;

ALTER TABLE "Position" ADD COLUMN "closedVolume" DECIMAL(10,2),
ADD COLUMN "closedSwap" DECIMAL(18,2);

ALTER TABLE "Order" ADD COLUMN "closeByPositionId" TEXT;
