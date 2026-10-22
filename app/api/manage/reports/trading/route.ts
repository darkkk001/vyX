import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { formatCsvNumber, viewAmount } from "@/lib/format";
import { dealReads } from "@/lib/deal-reads";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);
  if (dealReads("reports_trading")) return dealsCsv(brokerId, thirtyDaysAgo);

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
      volume: formatCsvNumber((p.closedVolume ?? p.volume).toString(), 2),
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

// reader reports_trading (lib/deal-reads.ts): the MT5 Deals report of the last 30 days, LIVE accounts only. One row per
// deal at its own time: every opening deal (IN with its Order; a reverse-in-place IN leg has none) and every close
// (OUT / OUT_BY with its TRADE_PNL row, the rows lib/book-pnl.ts bookPnlRealizedFromDeals sums). Voided trades are left
// out. Side is the deal's direction (a close of a BUY is a SELL). Commission is charged on the IN deal (ledger sign,
// shown in the broker view like the positions report); the Profit column adds up to the realised P/L of the range.
async function dealsCsv(brokerId: string, since: Date) {
  const deals = await prisma.$queryRaw<{
    executedAt: Date; accountNumber: string; symbol: string; digits: number; side: string; entry: string; volume: Prisma.Decimal;
    price: Prisma.Decimal; commission: Prisma.Decimal; swap: Prisma.Decimal; profit: Prisma.Decimal; position: number; deal: bigint;
  }[]>`
    SELECT d."executedAt", a."accountNumber", s.name AS symbol, s.digits, d.side::text AS side, d.entry::text AS entry, d.volume,
           d.price, d.commission, d.swap, d.profit, p.ticket AS position, d.ticket AS deal
      FROM "Deal" d JOIN "Position" p ON p.id = d."positionId" JOIN "Account" a ON a.id = d."accountId" JOIN "Symbol" s ON s.id = d."symbolId"
     WHERE d."brokerId" = ${brokerId} AND a."accountMode" = 'LIVE' AND p.status IN ('OPEN', 'CLOSED') AND d."voidedAt" IS NULL
       AND d."executedAt" >= ${since}
       AND ((d.entry = 'IN' AND d."orderId" IS NOT NULL) OR (d.entry IN ('OUT', 'OUT_BY') AND d."transactionId" IS NOT NULL))
     ORDER BY d."executedAt" DESC, d.ticket DESC`;
  const csv = toCsv(
    deals.map((d) => ({
      time: d.executedAt.toISOString(),
      deal: d.deal.toString(),
      position: String(d.position),
      account: d.accountNumber,
      symbol: d.symbol,
      side: d.side,
      entry: d.entry,
      volume: formatCsvNumber(d.volume.toString(), 2),
      price: formatCsvNumber(d.price.toString(), d.digits),
      // a deal holds the ledger amount (a charge is negative); viewAmount takes the stored positive charge
      commission: formatCsvNumber(viewAmount("commission", d.commission.neg().toString(), "broker")),
      swap: formatCsvNumber(viewAmount("swap", d.swap.toString(), "broker")),
      profit: formatCsvNumber(d.profit.toString()),
    })),
    [
      { key: "time", label: "Time" },
      { key: "deal", label: "Deal" },
      { key: "position", label: "Position" },
      { key: "account", label: "Account" },
      { key: "symbol", label: "Symbol" },
      { key: "side", label: "Side" },
      { key: "entry", label: "Entry" },
      { key: "volume", label: "Volume" },
      { key: "price", label: "Price" },
      { key: "commission", label: "Commission" },
      { key: "swap", label: "Swap" },
      { key: "profit", label: "Profit" },
    ]
  );
  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="trading-report.csv"' },
  });
}
