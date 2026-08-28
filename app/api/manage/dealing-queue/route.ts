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
// Same query app/manage/(shell)/dealing/page.tsx's Server Component used
// to do inline (pending orders + requoted orders in one response) --
// exposed as JSON so DealingQueueManager can fetch it itself (both the
// website and a bundled manager-shell desktop app use this one path
// now). Confirmed unused by anything else before this, so the shape
// (flat liveBid/liveAsk, plus the requoted array) matches page.tsx's
// original exactly rather than this route's own prior shape.
export async function GET() {
  const session = await requireManager();
  if (!session) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session.brokerId!;

  const [pending, requoted] = await Promise.all([
    prisma.order.findMany({
      where: { brokerId, type: "MARKET", status: "PENDING" },
      include: {
        account: { select: { accountNumber: true, fullName: true } },
        symbol: { select: { name: true, digits: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.order.findMany({
      where: { brokerId, type: "MARKET", status: "REQUOTED" },
      include: {
        account: { select: { accountNumber: true, fullName: true } },
        symbol: { select: { name: true, digits: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const priceBySymbol = await getFreshPrices([...new Set(pending.map((o) => o.symbol.name))]);

  return NextResponse.json({
    rows: pending.map((o) => {
      const live = priceBySymbol.get(o.symbol.name);
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
        liveBid: live ? live.bid.toString() : null,
        liveAsk: live ? live.ask.toString() : null,
      };
    }),
    requotedRows: requoted.map((o) => ({
      id: o.id,
      accountNumber: o.account.accountNumber,
      accountFullName: o.account.fullName,
      symbol: o.symbol.name,
      digits: o.symbol.digits,
      side: o.side,
      volume: o.volume.toString(),
      requestedPrice: o.requestedPrice ? o.requestedPrice.toString() : null,
      requotedPrice: o.requotedPrice ? o.requotedPrice.toString() : null,
      createdAt: o.createdAt.toISOString(),
    })),
  });
}
