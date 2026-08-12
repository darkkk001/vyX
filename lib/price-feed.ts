import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export type Tick = { symbol: string; bid: number; ask: number };

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
