import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getFreshPrices } from "@/lib/live-price";
import { computeRealizedPnl } from "@/lib/trading";
import { toCsv } from "@/lib/csv";

// Per-account open-exposure/margin snapshot -- same computation as the
// Risk Dashboard stats on app/manage/(shell)/risk/page.tsx, one row per
// account instead of a broker-wide aggregate.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const positions = await prisma.position.findMany({
    where: { brokerId, status: "OPEN" },
    include: {
      account: {
        select: { id: true, accountNumber: true, balance: true, leverage: true, group: { select: { marginCallLevel: true, stopOutLevel: true } } },
      },
      symbol: { select: { name: true, contractSize: true } },
    },
  });

  const priceBySymbol = await getFreshPrices([...new Set(positions.map((p) => p.symbol.name))]);

  const byAccount = new Map<
    string,
    { accountNumber: string; balance: number; leverage: number; marginCallLevel: number; stopOutLevel: number; equity: number; usedMargin: number; exposure: number; positionCount: number }
  >();

  for (const p of positions) {
    const acc = byAccount.get(p.account.id) ?? {
      accountNumber: p.account.accountNumber,
      balance: p.account.balance.toNumber(),
      leverage: p.account.leverage,
      marginCallLevel: p.account.group?.marginCallLevel.toNumber() ?? 100,
      stopOutLevel: p.account.group?.stopOutLevel.toNumber() ?? 50,
      equity: p.account.balance.toNumber(),
      usedMargin: 0,
      exposure: 0,
      positionCount: 0,
    };
    acc.exposure += p.volume.toNumber();
    acc.positionCount += 1;

    const live = priceBySymbol.get(p.symbol.name);
    if (live) {
      const currentPrice = p.side === "BUY" ? live.bid : live.ask;
      acc.equity += computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: currentPrice, volume: p.volume, contractSize: p.symbol.contractSize }).toNumber();
      acc.usedMargin += p.symbol.contractSize.toNumber() * p.volume.toNumber() * live.bid.toNumber() / p.account.leverage;
    }

    byAccount.set(p.account.id, acc);
  }

  const rows = [...byAccount.values()].map((acc) => {
    const marginLevel = acc.usedMargin > 0 ? (acc.equity / acc.usedMargin) * 100 : null;
    return {
      accountNumber: acc.accountNumber,
      openPositions: String(acc.positionCount),
      exposure: acc.exposure.toFixed(2),
      floatingPnl: (acc.equity - acc.balance).toFixed(2),
      marginLevel: marginLevel != null ? marginLevel.toFixed(1) : "",
      marginCallLevel: acc.marginCallLevel.toFixed(1),
      stopOutLevel: acc.stopOutLevel.toFixed(1),
    };
  });

  const csv = toCsv(rows, [
    { key: "accountNumber", label: "Account" },
    { key: "openPositions", label: "Open Positions" },
    { key: "exposure", label: "Exposure (lots)" },
    { key: "floatingPnl", label: "Floating P&L" },
    { key: "marginLevel", label: "Margin Level %" },
    { key: "marginCallLevel", label: "Margin Call Threshold %" },
    { key: "stopOutLevel", label: "Stop-Out Threshold %" },
  ]);

  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="risk-report.csv"' },
  });
}
