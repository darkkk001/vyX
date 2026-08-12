-- CreateTable
CREATE TABLE "LivePrice" (
    "symbol" TEXT NOT NULL,
    "bid" DECIMAL(18,5) NOT NULL,
    "ask" DECIMAL(18,5) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LivePrice_pkey" PRIMARY KEY ("symbol")
);
