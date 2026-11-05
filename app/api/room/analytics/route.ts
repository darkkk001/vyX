import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { roomAnalytics, loadTrades, periodStart, tradeAccounts, type Period } from "@/lib/room/analytics";
import { toCsv } from "@/lib/csv";

// GET ?account=all|<id>&period=30d|90d|ytd|all[&format=csv]: the Analytics screen (lib/room/analytics.ts), over the same
// accounts as the Journal (tradeAccounts). CSV = the period's trades with session and R.
const PERIODS: Period[] = ["30d", "90d", "ytd", "all"];

export async function GET(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const q = new URL(request.url).searchParams;
  const period = (PERIODS.find((p) => p === q.get("period")) ?? "90d") as Period;
  const own = await prisma.account.findMany({
    where: { clientId: session.clientId, brokerId: session.brokerId },
    select: { id: true, accountNumber: true, accountMode: true, currency: true, group: { select: { displayName: true } } },
    orderBy: { createdAt: "asc" },
  });
  const picked = tradeAccounts(own, q.get("account"));
  const accounts = picked.map((a) => ({ id: a.id, accountNumber: a.accountNumber, plan: a.accountMode === "DEMO" ? "Demo" : a.group?.displayName ?? "Standard" }));

  if (q.get("format") === "csv") {
    const trades = await loadTrades(accounts, periodStart(period));
    const session = (d: Date) => { const h = d.getUTCHours(); return h >= 23 || h < 7 ? "Asia" : h < 12 ? "London" : h < 21 ? "New York" : "Rollover"; };
    const body = toCsv(trades.map((t) => ({
      closed: t.closedAt.toISOString().replace("T", " ").slice(0, 19), account: t.accountNumber, symbol: t.symbol, side: t.side, lots: t.lots.toFixed(2),
      open: t.openPrice, close: t.closePrice, sl: t.sl ?? "", r: t.r == null ? "" : t.r.toFixed(2), session: session(t.openedAt), net: t.net.toFixed(2),
    })), [
      { key: "closed", label: "Closed (UTC)" }, { key: "account", label: "Account" }, { key: "symbol", label: "Symbol" }, { key: "side", label: "Side" },
      { key: "lots", label: "Lots" }, { key: "open", label: "Open price" }, { key: "close", label: "Close price" }, { key: "sl", label: "Stop loss" },
      { key: "r", label: "R" }, { key: "session", label: "Session" }, { key: "net", label: "Net P/L" },
    ]);
    return new NextResponse(body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="analytics-${period}-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" } });
  }

  const data = await roomAnalytics(session.brokerId, accounts, period);
  return NextResponse.json({ ...data, currency: picked[0]?.currency ?? own[0]?.currency ?? "USD" });
}
