import { NextResponse } from "next/server";

export type Tick = { symbol: string; bid: number; ask: number };

// Thin forwarder to the Rust Trading Core's Market Data ingest route
// (engine/server's POST /internal/price-feed) — see docs/market-data.md
// §2/§3: Market Data Core is now the sole writer of LivePrice/Candle, this
// file no longer touches Prisma directly. Both callers
// (app/api/internal/price-feed/route.ts and .../[payload]/route.ts) keep
// their own transport-specific parsing (JSON body, query params, or the
// base64url path workaround for MT5 terminals whose network path strips
// query strings) and just hand the decoded {secret, ticks} to this
// function unchanged.
export async function ingestTicks(secret: string | null, ticksRaw: unknown) {
  const configuredSecret = process.env.PRICE_FEED_SECRET;
  if (!configuredSecret) {
    return NextResponse.json({ error: "price feed not configured" }, { status: 503 });
  }
  if (secret !== configuredSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ticks: Tick[] = Array.isArray(ticksRaw) ? ticksRaw : ticksRaw ? [ticksRaw as Tick] : [];
  const valid = ticks.filter(
    (t) => typeof t?.symbol === "string" && Number.isFinite(t.bid) && Number.isFinite(t.ask)
  );
  if (valid.length === 0) {
    return NextResponse.json({ error: "no valid ticks in body" }, { status: 400 });
  }

  const tradingCoreUrl = process.env.TRADING_CORE_URL ?? "http://127.0.0.1:8081";
  let upstream: Response;
  try {
    upstream = await fetch(`${tradingCoreUrl}/internal/price-feed`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-price-feed-secret": configuredSecret },
      body: JSON.stringify(valid),
    });
  } catch (err) {
    console.error("price-feed: Trading Core unreachable", err);
    return NextResponse.json({ error: "market data core unreachable" }, { status: 502 });
  }

  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
