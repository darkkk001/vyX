import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { askRuleWire, loadAskRules } from "@/lib/ask-markup";
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
        closesPosition: { select: { ticket: true, volume: true, openPrice: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.order.findMany({
      where: { brokerId, type: "MARKET", status: "REQUOTED" },
      include: {
        account: { select: { accountNumber: true, fullName: true } },
        symbol: { select: { name: true, digits: true } },
        closesPosition: { select: { ticket: true, volume: true, openPrice: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // each order's account ask rule (lib/ask-markup.ts): a BUY opens and a SELL position closes at the account's ask, so
  // the desk's "accept at market" / requote presets use the price the fill would really use
  const [priceBySymbol, askRules] = await Promise.all([
    getFreshPrices([...new Set(pending.map((o) => o.symbol.name))]),
    loadAskRules(prisma, [...pending, ...requoted].map((o) => ({ accountId: o.accountId, symbolId: o.symbolId }))),
  ]);
  const ruleWire = (o: (typeof pending)[number], bid?: Prisma.Decimal, ask?: Prisma.Decimal) => {
    const r = askRules.get(o.accountId, o.symbolId);
    return r ? askRuleWire(r, bid, ask) : { askMarkup: "0", spreadRule: "markup" as const };
  };

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
        // the account's ask rule (price units; missing on an older server = raw)
        ...ruleWire(o, live?.bid, live?.ask),
        // Closes respect DEALER mode: a queued CLOSE of position #closesTicket (volume = the lots to
        // close; partial when less than the position's volume). kind OPEN = a new position.
        kind: o.closesPositionId ? "CLOSE" : "OPEN",
        closesPositionId: o.closesPositionId,
        closesTicket: o.closesPosition?.ticket ?? null,
        positionVolume: o.closesPosition?.volume.toString() ?? null,
        positionOpenPrice: o.closesPosition?.openPrice.toString() ?? null,
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
      ...ruleWire(o),
      kind: o.closesPositionId ? "CLOSE" : "OPEN",
      closesPositionId: o.closesPositionId,
      closesTicket: o.closesPosition?.ticket ?? null,
      positionVolume: o.closesPosition?.volume.toString() ?? null,
      positionOpenPrice: o.closesPosition?.openPrice.toString() ?? null,
    })),
  });
}
