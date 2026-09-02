import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { humanizeAction, summarizeAuditDiff } from "@/lib/audit-labels";

// Impression Pack #5 -- Dealing Replay v1. This app stores M1/M5/... OHLC
// candles, not raw tick history (see docs/market-data.md), so a real
// tick-by-tick replay isn't possible -- this reconstructs the best
// picture available: the M1 bars spanning the fill, the order's own
// requested/filled prices, and the full audit trail for both the order
// and the position it produced. Every consumer of this route's response
// must label it "reconstructed from 1-minute data," not implied to be a
// tick-accurate replay.
const PADDING_MINUTES = 2;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const brokerId = session!.brokerId!;

  const position = await prisma.position.findFirst({
    where: { id, brokerId },
    include: {
      account: { select: { accountNumber: true, fullName: true } },
      symbol: { select: { name: true, digits: true } },
      originOrder: true,
    },
  });
  if (!position) {
    return NextResponse.json({ error: "position not found" }, { status: 404 });
  }

  const rangeStart = new Date(position.openedAt.getTime() - PADDING_MINUTES * 60_000);
  const rangeEnd = new Date((position.closedAt ?? position.openedAt).getTime() + PADDING_MINUTES * 60_000);

  const candles = await prisma.candle.findMany({
    where: { symbol: position.symbol.name, timeframe: "M1", bucketStart: { gte: rangeStart, lte: rangeEnd } },
    orderBy: { bucketStart: "asc" },
  });

  const auditRows = await prisma.auditLog.findMany({
    where: { brokerId, entityId: { in: [position.id, position.originOrderId] } },
    include: { actorAdmin: { select: { email: true } } },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    position: {
      id: position.id,
      accountNumber: position.account.accountNumber,
      accountFullName: position.account.fullName,
      symbol: position.symbol.name,
      digits: position.symbol.digits,
      side: position.side,
      volume: position.volume.toString(),
      openPrice: position.openPrice.toFixed(position.symbol.digits),
      closePrice: position.closePrice ? position.closePrice.toFixed(position.symbol.digits) : null,
      openedAt: position.openedAt.toISOString(),
      closedAt: position.closedAt ? position.closedAt.toISOString() : null,
    },
    order: {
      id: position.originOrder.id,
      type: position.originOrder.type,
      requestedPrice: position.originOrder.requestedPrice ? position.originOrder.requestedPrice.toFixed(position.symbol.digits) : null,
      filledPrice: position.originOrder.filledPrice ? position.originOrder.filledPrice.toFixed(position.symbol.digits) : null,
      requotedPrice: position.originOrder.requotedPrice ? position.originOrder.requotedPrice.toFixed(position.symbol.digits) : null,
    },
    candles: candles.map((c) => ({
      time: c.bucketStart.toISOString(),
      open: c.open.toFixed(position.symbol.digits),
      high: c.high.toFixed(position.symbol.digits),
      low: c.low.toFixed(position.symbol.digits),
      close: c.close.toFixed(position.symbol.digits),
    })),
    auditEvents: auditRows.map((a) => ({
      id: a.id,
      time: a.createdAt.toISOString(),
      label: humanizeAction(a.action),
      actor: a.actorAdmin?.email ?? "system",
      diff: summarizeAuditDiff(a.oldValue, a.newValue),
    })),
  });
}
