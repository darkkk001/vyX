import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrices } from "@/lib/live-price";

async function requireManager() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return null;
  }
  return session!;
}

// Trader-submitted MARKET orders waiting for a dealer's Accept/Reject --
// see app/api/trade/orders/route.ts's dealingModeAt branch. Same
// permission pair as manual position open (app/api/manage/positions/route.ts).
export async function GET() {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const orders = await prisma.order.findMany({
    where: { brokerId: session.brokerId!, type: "MARKET", status: "PENDING" },
    include: {
      account: { select: { accountNumber: true, fullName: true } },
      symbol: { select: { name: true, digits: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const livePrices = await getFreshPrices(orders.map((o) => o.symbol.name));

  return NextResponse.json(
    orders.map((o) => {
      const live = livePrices.get(o.symbol.name);
      return {
        id: o.id,
        accountNumber: o.account.accountNumber,
        accountFullName: o.account.fullName,
        symbol: o.symbol.name,
        digits: o.symbol.digits,
        side: o.side,
        volume: o.volume.toString(),
        requestedPrice: o.requestedPrice ? o.requestedPrice.toString() : null,
        createdAt: o.createdAt.toISOString(),
        livePrice: live ? { bid: live.bid.toString(), ask: live.ask.toString() } : null,
      };
    })
  );
}
