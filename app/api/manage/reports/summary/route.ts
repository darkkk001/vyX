import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

const DAY_MS = 24 * 60 * 60 * 1000;

// Same four aggregates app/manage/(shell)/reports/page.tsx's Server
// Component used to compute inline -- exposed as JSON so ReportsView
// can fetch it itself (both the website and a bundled manager-shell
// desktop app use this one path now).
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);

  const [volumeAgg, commissionAgg, depositsAgg, withdrawalsAgg, newClients] = await Promise.all([
    prisma.position.aggregate({ where: { brokerId, openedAt: { gte: thirtyDaysAgo } }, _sum: { volume: true } }),
    prisma.position.aggregate({ where: { brokerId, status: "CLOSED", closedAt: { gte: thirtyDaysAgo } }, _sum: { commission: true } }),
    prisma.transaction.aggregate({ where: { brokerId, type: "DEPOSIT", status: "COMPLETED", createdAt: { gte: thirtyDaysAgo } }, _sum: { amount: true } }),
    prisma.transaction.aggregate({ where: { brokerId, type: "WITHDRAWAL", status: "COMPLETED", createdAt: { gte: thirtyDaysAgo } }, _sum: { amount: true } }),
    prisma.account.count({ where: { brokerId, createdAt: { gte: thirtyDaysAgo } } }),
  ]);

  const netDeposits = (depositsAgg._sum.amount?.toNumber() ?? 0) - Math.abs(withdrawalsAgg._sum.amount?.toNumber() ?? 0);

  return NextResponse.json({
    tradingVolume: volumeAgg._sum.volume?.toNumber() ?? 0,
    commissionRevenue: commissionAgg._sum.commission?.toNumber() ?? 0,
    netDeposits,
    newClients,
  });
}
