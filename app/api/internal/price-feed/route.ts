import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Ingest endpoint for the MT5 EA bridge — pushes live bid/ask ticks from a
// broker's own MT5 terminal so the WebTrader chart can show real prices
// instead of the client-side simulator. Temporary Phase-2.5 stopgap; a real
// LP FIX feed replaces this in Phase 5 without touching anything downstream,
// since consumers only ever read the LivePrice table.
//
// Auth: shared-secret bearer token (there is no per-broker identity here,
// the feed is broker-agnostic raw market data — BrokerSymbol.spreadMarkup
// is applied on top when quoting a trader).

type Tick = { symbol: string; bid: number; ask: number };

export async function POST(request: NextRequest) {
  const secret = process.env.PRICE_FEED_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "price feed not configured" }, { status: 503 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const ticks: Tick[] = Array.isArray(body) ? body : body ? [body] : [];
  const valid = ticks.filter(
    (t) => typeof t?.symbol === "string" && Number.isFinite(t.bid) && Number.isFinite(t.ask)
  );
  if (valid.length === 0) {
    return NextResponse.json({ error: "no valid ticks in body" }, { status: 400 });
  }

  await prisma.$transaction(
    valid.map((t) =>
      prisma.livePrice.upsert({
        where: { symbol: t.symbol },
        create: { symbol: t.symbol, bid: t.bid, ask: t.ask },
        update: { bid: t.bid, ask: t.ask },
      })
    )
  );

  return NextResponse.json({ ok: true, count: valid.length });
}
