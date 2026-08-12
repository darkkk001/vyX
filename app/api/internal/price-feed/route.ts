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

async function ingestTicks(secret: string | null, ticksRaw: unknown) {
  const configuredSecret = process.env.PRICE_FEED_SECRET;
  if (!configuredSecret) {
    return NextResponse.json({ error: "price feed not configured" }, { status: 503 });
  }
  if (secret !== configuredSecret) {
    // TEMP DEBUG — remove once the EA auth mismatch is diagnosed.
    return NextResponse.json(
      { error: "unauthorized", debugReceivedSecret: secret, debugReceivedLength: secret?.length ?? 0 },
      { status: 401 }
    );
  }

  const ticks: Tick[] = Array.isArray(ticksRaw) ? ticksRaw : ticksRaw ? [ticksRaw as Tick] : [];
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

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const secret = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  const body = await request.json().catch(() => null);
  return ingestTicks(secret, body);
}

// Fallback transport: some network paths between broker MT5 terminals and
// Vercel (ISP/AV transparent proxies) silently downgrade POST to GET,
// dropping the body — observed in production via Vercel's request log
// showing a GET arriving for what the EA sent as POST. GET with the ticks
// URL-encoded in the query string survives those paths.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const secret = searchParams.get("secret");
  const data = searchParams.get("data");
  let ticksRaw: unknown = null;
  if (data) {
    try {
      ticksRaw = JSON.parse(data);
    } catch {
      ticksRaw = null;
    }
  }
  return ingestTicks(secret, ticksRaw);
}
