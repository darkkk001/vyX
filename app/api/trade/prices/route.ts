import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";

// Polled by the WebTrader client every couple seconds to blend real MT5
// ticks (see /api/internal/price-feed) into the otherwise-simulated market
// state. Symbols with no live tick yet simply stay simulated client-side.
export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const prices = await prisma.livePrice.findMany();
  return NextResponse.json(prices);
}
