-- Broker-wide dealing mode toggle -- same shape as tradingHaltedAt.
-- Non-null = new MARKET orders queue for manual dealer accept/reject.
ALTER TABLE "Broker" ADD COLUMN "dealingModeAt" TIMESTAMPTZ(3);
