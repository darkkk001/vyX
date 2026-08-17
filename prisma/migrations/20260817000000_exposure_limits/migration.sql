-- AlterTable
ALTER TABLE "Broker" ADD COLUMN     "maxOpenPositionsPerAccount" INTEGER;

-- AlterTable
ALTER TABLE "BrokerSymbol" ADD COLUMN     "maxExposure" DECIMAL(18,2);
