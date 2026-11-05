-- New method types and the "listed" switch. Additive: no existing row changes.
ALTER TYPE "PaymentMethodType" ADD VALUE IF NOT EXISTS 'BNB';
ALTER TYPE "PaymentMethodType" ADD VALUE IF NOT EXISTS 'BINANCE_PAY';
ALTER TYPE "PaymentMethodType" ADD VALUE IF NOT EXISTS 'EASYPAISA';
ALTER TYPE "PaymentMethodType" ADD VALUE IF NOT EXISTS 'JAZZCASH';
ALTER TYPE "PaymentMethodType" ADD VALUE IF NOT EXISTS 'NETELLER';
ALTER TABLE "PaymentMethod" ADD COLUMN "listed" BOOLEAN NOT NULL DEFAULT false;
