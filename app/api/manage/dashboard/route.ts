import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { humanizeAction, excludeSuperAdminActor } from "@/lib/audit-labels";

const DAY_MS = 24 * 60 * 60 * 1000;

// Same 8-way parallel Prisma read app/manage/(shell)/dashboard/page.tsx's
// Server Component used to do inline (no client component existed for
// this page at all before) -- exposed as JSON so a new DashboardManager.tsx
// can self-fetch it, matching every other converted Manager page. Decimal
// sums are resolved to plain numbers here (RSC serialization never
// allowed raw Decimal across the boundary either), and audit rows are
// pre-humanized server-side, same convention as /api/manage/audit.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);

  const [
    totalClients,
    newClients7d,
    depositsSum,
    activeTrades,
    activeTradeAccounts,
    pendingKyc,
    pendingWithdrawals,
    activity,
  ] = await Promise.all([
    prisma.account.count({ where: { brokerId } }),
    prisma.account.count({ where: { brokerId, createdAt: { gte: sevenDaysAgo } } }),
    prisma.transaction.aggregate({
      where: { brokerId, type: "DEPOSIT", status: "COMPLETED", createdAt: { gte: thirtyDaysAgo } },
      _sum: { amount: true },
    }),
    prisma.position.count({ where: { brokerId, status: "OPEN" } }),
    prisma.position.findMany({ where: { brokerId, status: "OPEN" }, select: { accountId: true }, distinct: ["accountId"] }),
    prisma.kycRecord.count({ where: { status: "PENDING", account: { brokerId } } }),
    prisma.transaction.aggregate({
      where: { brokerId, type: "WITHDRAWAL", status: "PENDING" },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.auditLog.findMany({
      where: { brokerId, ...excludeSuperAdminActor },
      orderBy: { createdAt: "desc" },
      take: 15,
      include: { actorAdmin: { select: { email: true } } },
    }),
  ]);

  return NextResponse.json({
    totalClients,
    newClients7d,
    depositsSum30d: depositsSum._sum.amount?.toNumber() ?? 0,
    activeTrades,
    activeTradeAccountCount: activeTradeAccounts.length,
    pendingKyc,
    pendingWithdrawalCount: pendingWithdrawals._count,
    pendingWithdrawalSum: pendingWithdrawals._sum.amount?.toNumber() ?? 0,
    activity: activity.map((a) => ({
      id: a.id,
      actionLabel: humanizeAction(a.action),
      actorEmail: a.actorAdmin?.email ?? "system",
      entityId: a.entityId,
      createdAtLabel: a.createdAt.toISOString().replace("T", " ").slice(0, 19),
    })),
  });
}
