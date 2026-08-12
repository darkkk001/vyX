import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type Tick = { symbol: string; bid: number; ask: number };

const TIMEFRAMES = ["M1", "M5", "M30", "H1", "H4", "D1", "W1", "MN1", "Y1"] as const;

// M1..D1 are fixed-duration and bucket cleanly by floor-division. W1/MN1/Y1
// aren't — weeks don't align to the epoch at a Monday boundary, and
// months/years vary in length — so those need real calendar math instead
// of a fixed millisecond divisor.
const FIXED_MS: Partial<Record<(typeof TIMEFRAMES)[number], number>> = {
  M1: 60_000,
  M5: 300_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
};

function bucketStart(tf: (typeof TIMEFRAMES)[number], now: number): Date {
  const fixedMs = FIXED_MS[tf];
  if (fixedMs) return new Date(Math.floor(now / fixedMs) * fixedMs);

  const d = new Date(now);
  if (tf === "W1") {
    const daysSinceMonday = (d.getUTCDay() + 6) % 7; // getUTCDay: 0=Sun..6=Sat
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday));
  }
  if (tf === "MN1") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); // Y1
}

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

  const now = Date.now();

  // Candle history built at write time (one upsert per open timeframe
  // bucket) so chart reads (/api/trade/candles) are a plain indexed select,
  // never an aggregation over raw ticks.
  const candleUpserts = valid.flatMap((t) =>
    TIMEFRAMES.map(
      (tf) => Prisma.sql`
        INSERT INTO "Candle" (symbol, timeframe, "bucketStart", open, high, low, close, "updatedAt")
        VALUES (${t.symbol}, ${tf}::"CandleTimeframe", ${bucketStart(tf, now)}, ${t.bid}, ${t.bid}, ${t.bid}, ${t.bid}, now())
        ON CONFLICT (symbol, timeframe, "bucketStart")
        DO UPDATE SET
          high = GREATEST("Candle".high, EXCLUDED.high),
          low = LEAST("Candle".low, EXCLUDED.low),
          close = EXCLUDED.close,
          "updatedAt" = now()
      `
    )
  );

  await prisma.$transaction([
    ...valid.map((t) =>
      prisma.livePrice.upsert({
        where: { symbol: t.symbol },
        create: { symbol: t.symbol, bid: t.bid, ask: t.ask },
        update: { bid: t.bid, ask: t.ask },
      })
    ),
    ...candleUpserts.map((sql) => prisma.$executeRaw(sql)),
  ]);

  return NextResponse.json({ ok: true, count: valid.length });
}
