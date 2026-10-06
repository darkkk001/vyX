import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { bookPnlRealized, currencyAmountsJson } from "@/lib/book-pnl";

const DAY_MS = 24 * 60 * 60 * 1000;

// Same four aggregates app/manage/(shell)/reports/page.tsx's Server
// Component used to compute inline -- exposed as JSON so ReportsView
// can fetch it itself (both the website and a bundled manager-shell
// desktop app use this one path now).
export async function GET(req: Request) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);

  // Book P/L for any range (owner 2026-10-06): ?from=&to= (ISO dates/times, [from, to)); no from = the last 30 days,
  // no to = up to now. Same shared function as the Dashboard, so Dashboard "today" == Reports for the same range.
  const url = new URL(req.url);
  const parse = (v: string | null) => (v ? new Date(v) : null);
  const from = parse(url.searchParams.get("from")) ?? thirtyDaysAgo;
  const to = parse(url.searchParams.get("to"));
  if (Number.isNaN(from.getTime()) || (to && Number.isNaN(to.getTime()))) {
    return NextResponse.json({ error: "from and to must be dates, for example 2026-10-01 or 2026-10-01T22:00:00Z" }, { status: 400 });
  }
  if (to && to <= from) return NextResponse.json({ error: "to must be later than from" }, { status: 400 });

  // 2026-09-06 interim demo-exclusion (Section C audit) -- these four are
  // exactly the "how's our business today" numbers a broker looks at
  // daily; blending in demo/test accounts (this dev broker's own
  // stress-test accounts among them) overstates real trading volume,
  // commission revenue, deposits, and client growth. `account:
  // {accountMode: "LIVE"}` on the two relations, `accountMode: "LIVE"`
  // directly on Account itself for newClients. Full demo/live separation
  // across every report (not just these four) is deferred to the Phase 2
  // Reporting v2 module -- this is intentionally narrow.
  const [volumeAgg, commissionAgg, depositsAgg, withdrawalsAgg, newClients] = await Promise.all([
    prisma.position.aggregate({
      where: { brokerId, openedAt: { gte: thirtyDaysAgo }, account: { accountMode: "LIVE", isInternal: false } },
      _sum: { volume: true },
    }),
    prisma.position.aggregate({
      where: { brokerId, status: "CLOSED", closedAt: { gte: thirtyDaysAgo }, account: { accountMode: "LIVE", isInternal: false } },
      _sum: { commission: true },
    }),
    prisma.transaction.aggregate({
      where: { brokerId, type: "DEPOSIT", status: "COMPLETED", createdAt: { gte: thirtyDaysAgo }, account: { accountMode: "LIVE", isInternal: false } },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: { brokerId, type: "WITHDRAWAL", status: "COMPLETED", createdAt: { gte: thirtyDaysAgo }, account: { accountMode: "LIVE", isInternal: false } },
      _sum: { amount: true },
    }),
    prisma.account.count({ where: { brokerId, accountMode: "LIVE", isInternal: false, createdAt: { gte: thirtyDaysAgo } } }),
  ]);
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { coverageAccountId: true } });
  const bookPnl = await bookPnlRealized(prisma, { brokerId, coverageAccountId: broker.coverageAccountId }, from, to);

  const netDeposits = (depositsAgg._sum.amount?.toNumber() ?? 0) - Math.abs(withdrawalsAgg._sum.amount?.toNumber() ?? 0);

  return NextResponse.json({
    tradingVolume: volumeAgg._sum.volume?.toNumber() ?? 0,
    commissionRevenue: commissionAgg._sum.commission?.toNumber() ?? 0,
    netDeposits,
    newClients,
    // per account currency, never summed across currencies; commission and swap are not part of Book P/L
    bookPnl: { from: from.toISOString(), to: to ? to.toISOString() : null, realized: currencyAmountsJson(bookPnl) },
  });
}
