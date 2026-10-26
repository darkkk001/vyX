import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission, PERMISSION_LABELS } from "@/lib/permissions";
import { staffRequestMeta } from "@/lib/order-execution";
import { closeBulkForAccount } from "@/lib/bulk-close";

// The hedge account panel's "Close all hedges" / "Close hedges for symbol" (owner 2026-10-26, bo 1.0.96).
//   POST {}                  -> every open leg on the broker's coverage account (Broker.coverageAccountId)
//   POST {symbol: "XAUUSD"}  -> every open leg of that symbol
// Each leg closes at the live market through the same staff close path as Live exposure's bulk close
// (lib/bulk-close.ts: one price snapshot per symbol, its deal + ledger row, and the client it hedged is released and the
// desk told, lib/coverage.ts onClose). DEALING: BROKER_ADMIN, or a MANAGER granted it. One audit row per leg, closed or not.
export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (await forbidUnlessBrokerAdminOrPermission(session!, "DEALING")) {
    return NextResponse.json({ error: "forbidden", permission: "DEALING", permissionLabel: PERMISSION_LABELS.DEALING }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const body = await request.json().catch(() => ({}));
  const symbol = typeof body?.symbol === "string" && body.symbol.trim() ? body.symbol.trim() : null;

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { coverageAccountId: true } });
  if (!broker.coverageAccountId) return NextResponse.json({ error: "no hedge account is set for this broker" }, { status: 409 });
  const account = await prisma.account.findUniqueOrThrow({ where: { id: broker.coverageAccountId }, select: { id: true, accountNumber: true } });

  const legs = await prisma.position.findMany({
    where: { accountId: account.id, status: "OPEN", ...(symbol ? { symbol: { name: symbol } } : {}) },
    select: { id: true, ticket: true, volume: true, side: true, symbol: { select: { name: true } } },
    orderBy: { ticket: "asc" },
  });
  if (legs.length === 0) {
    return NextResponse.json({ coverageAccountNumber: account.accountNumber, symbol, requested: 0, successful: 0, failed: 0, legs: [] });
  }

  const results = await closeBulkForAccount(prisma, {
    accountId: account.id,
    brokerId,
    scope: "ALL",
    positionIds: legs.map((l) => l.id),
    dealSource: "ADMIN",
    adminId: session!.adminId,
    capture: staffRequestMeta(request.headers),
  });
  const byId = new Map(results.map((r) => [r.positionId, r]));
  const rows = legs.map((l) => {
    const r = byId.get(l.id);
    return {
      positionId: l.id,
      ticket: l.ticket,
      symbol: l.symbol.name,
      side: l.side,
      lots: l.volume.toFixed(2),
      closed: r?.closed ?? false,
      closePrice: r?.closePrice ?? null,
      realizedPnl: r?.realizedPnl ?? null,
      error: r ? r.error : "not closed",
    };
  });
  await prisma.auditLog.createMany({
    data: rows.map((r) => ({
      brokerId,
      actorAdminId: session!.adminId,
      action: r.closed ? "COVERAGE_LEG_CLOSED_BY_STAFF" : "COVERAGE_LEG_CLOSE_FAILED",
      entityType: "Position",
      entityId: r.positionId,
      newValue: { scope: symbol ? "SYMBOL" : "ALL", symbol: r.symbol, ticket: r.ticket, lots: r.lots, closePrice: r.closePrice, realizedPnl: r.realizedPnl, error: r.error },
    })),
  });
  return NextResponse.json({
    coverageAccountNumber: account.accountNumber,
    symbol,
    requested: rows.length,
    successful: rows.filter((r) => r.closed).length,
    failed: rows.filter((r) => !r.closed).length,
    legs: rows,
  });
}
