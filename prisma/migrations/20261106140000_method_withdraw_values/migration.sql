-- Withdrawal terms per method. Additive: null on every row.
ALTER TABLE "PaymentMethod" ADD COLUMN "withdrawMinAmount" DECIMAL(18,2);
ALTER TABLE "PaymentMethod" ADD COLUMN "withdrawMaxAmount" DECIMAL(18,2);
ALTER TABLE "PaymentMethod" ADD COLUMN "withdrawProcessingTime" TEXT;
