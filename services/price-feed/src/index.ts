// PRIORITY 3: the standalone price feed's entry point. The routes and the reasoning are in app.ts.

import { Redis } from "ioredis";

import { createApp } from "./app.js";
import { PriceStore } from "./store.js";

const PORT = Number(process.env.PORT ?? 8299);
const BIND_ADDR = process.env.BIND_ADDR ?? "127.0.0.1";
const REDIS_URL = process.env.REDIS_URL ?? "";
const PRICE_FEED_SECRET = process.env.PRICE_FEED_SECRET ?? "";
const MARKET_DATA_READ_SECRET = process.env.MARKET_DATA_READ_SECRET ?? "";
const TRADING_CORE_URL = (process.env.TRADING_CORE_URL ?? "").trim();

if (!REDIS_URL) {
  console.error("price-feed: REDIS_URL is required -- the shared store IS the point of this process");
  process.exit(1);
}
// Fail closed on the secrets rather than serving an open endpoint: this process accepts the prices
// that orders are filled at, so an unauthenticated ingest is a way to choose someone else's fill price.
if (!PRICE_FEED_SECRET || !MARKET_DATA_READ_SECRET) {
  console.error("price-feed: PRICE_FEED_SECRET and MARKET_DATA_READ_SECRET are required");
  process.exit(1);
}

const redis = new Redis(REDIS_URL);
const { app } = createApp({
  store: new PriceStore(redis),
  priceFeedSecret: PRICE_FEED_SECRET,
  marketDataReadSecret: MARKET_DATA_READ_SECRET,
  tradingCoreUrl: TRADING_CORE_URL,
});

app.listen(PORT, BIND_ADDR, () => {
  console.log(
    `price-feed listening on ${BIND_ADDR}:${PORT} (store=redis, engine fan-out ${TRADING_CORE_URL ? "-> " + TRADING_CORE_URL : "OFF"})`
  );
});
