import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { formatCsvNumber, viewAmount } from "@/lib/format";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);

  const positions = await prisma.position.findMany({
    // LIVE accounts only, to reconcile with the summary tiles (which are LIVE-only); demo trades were inflating the table
    where: { brokerId, status: "CLOSED", closedAt: { gte: thirtyDaysAgo }, account: { accountMode: "LIVE" } },
    include: { account: { select: { accountNumber: true } }, symbol: { select: { name: true, digits: true } } },
    orderBy: { closedAt: "desc" },
  });

  const csv = toCsv(
    positions.map((p) => ({
      closedAt: p.closedAt?.toISOString() ?? "",
      account: p.account.accountNumber,
      symbol: p.symbol.name,
      side: p.side,
      // step 2 number rules (lib/format.ts): volume 2 dp, prices in the symbol's digits, never -0.00, broker view
      volume: formatCsvNumber(p.volume.toString(), 2),
      openPrice: formatCsvNumber(p.openPrice.toString(), p.symbol.digits),
      closePrice: formatCsvNumber(p.closePrice?.toString(), p.symbol.digits),
      commission: formatCsvNumber(viewAmount("commission", p.commission.toString(), "broker")),
      swap: formatCsvNumber(viewAmount("swap", p.swap.toString(), "broker")),
      realizedPnl: formatCsvNumber(p.realizedPnl?.toString()),
    })),
    [
      { key: "closedAt", label: "Closed At" },
      { key: "account", label: "Account" },
      { key: "symbol", label: "Symbol" },
      { key: "side", label: "Side" },
      { key: "volume", label: "Volume" },
      { key: "openPrice", label: "Open Price" },
      { key: "closePrice", label: "Close Price" },
      { key: "commission", label: "Commission" },
      { key: "swap", label: "Swap" },
      { key: "realizedPnl", label: "Realized P&L" },
    ]
  );

  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="trading-report.csv"' },
  });
}
