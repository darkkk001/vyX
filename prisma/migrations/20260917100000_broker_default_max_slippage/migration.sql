-- Broker-wide default slippage tolerance (pips). Auto-fills the
-- maxSlippagePips guard when a trade request omits its own value --
-- read at app/api/trade/orders/route.ts's checkSlippage call, edited via
-- app/api/manage/risk (the dealer settings gear). Nullable: null = fall
-- back to lib/risk.ts's hardcoded DEFAULT_MAX_SLIPPAGE_PIPS (5), which is
-- exactly today's behavior, so this is a safe additive change.
-- Hand-written (never `prisma migrate dev` on this DB -- the Rust engine's
-- own tables read as drift and would trigger a reset).

-- AlterTable
ALTER TABLE "Broker" ADD COLUMN "defaultMaxSlippagePips" DECIMAL(8,2);
