-- MT5 hedged margin per broker symbol (lib/margin.ts hedgedUsedMargin). 200 = both legs of a hedge charged in full,
-- exactly the behavior before this column existed, so adding it changes no account's margin.
ALTER TABLE "BrokerSymbol" ADD COLUMN "hedgedMarginPct" DECIMAL(6,2) NOT NULL DEFAULT 200;
ALTER TABLE "BrokerSymbol" ADD CONSTRAINT "BrokerSymbol_hedgedMarginPct_range" CHECK ("hedgedMarginPct" >= 0 AND "hedgedMarginPct" <= 200);
