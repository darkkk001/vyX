-- CreateEnum
CREATE TYPE "CandleTimeframe" AS ENUM ('M1', 'M5', 'H1');

-- CreateTable
CREATE TABLE "Candle" (
    "symbol" TEXT NOT NULL,
    "timeframe" "CandleTimeframe" NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(18,5) NOT NULL,
    "high" DECIMAL(18,5) NOT NULL,
    "low" DECIMAL(18,5) NOT NULL,
    "close" DECIMAL(18,5) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("symbol","timeframe","bucketStart")
);

-- CreateIndex
CREATE INDEX "Candle_symbol_timeframe_bucketStart_idx" ON "Candle"("symbol", "timeframe", "bucketStart");
