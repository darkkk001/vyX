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
  const fourteenDaysAgo = new Date(now.getTime() - 14 * DAY_MS);
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
    depositsWithdrawals14d,
  ] = await Promise.all([
    prisma.account.count({ where: { brokerId } }),
    prisma.account.count({ where: { brokerId, createdAt: { gte: sevenDaysAgo } } }),
    prisma.transaction.aggregate({
      where: { brokerId, type: "DEPOSIT", status: "COMPLETED", createdAt: { gte: thirtyDaysAgo } },
      _sum: { amount: true },
    }),
    // 2026-09-06 interim demo-exclusion (Section C audit) -- "Active
    // trades" is a business-volume number a broker checks daily; blending
    // in demo/test accounts' positions overstates real trading activity.
    // Scoped narrowly to just this stat pair (same reasoning applies to
    // the Reports Summary stats in .../reports/summary/route.ts) -- the
    // rest of this route (totalClients, deposits, pending KYC/withdrawal
    // queues) is left as-is, since those are either not business-volume
    // numbers or are operational queues staff still need to act on
    // regardless of account mode. Full demo/live separation across every
    // report is deferred to the Phase 2 Reporting v2 module.
    prisma.position.count({ where: { brokerId, status: "OPEN", account: { accountMode: "LIVE" } } }),
    prisma.position.findMany({
      where: { brokerId, status: "OPEN", account: { accountMode: "LIVE" } },
      select: { accountId: true },
      distinct: ["accountId"],
    }),
    // both KYC queues: in-app (KycRecord) + Client Portal (ClientKycRecord)
    Promise.all([
      prisma.kycRecord.count({ where: { status: "PENDING", account: { brokerId } } }),
      prisma.clientKycRecord.count({ where: { status: "PENDING", client: { brokerId } } }),
    ]).then(([a, b]) => a + b),
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
    // Dashboard "Net deposits (7d)" trend + "Deposits vs withdrawals" chart
    // (design ref: futurix-dashboard-design.html) both need day-bucketed
    // COMPLETED deposit/withdrawal amounts -- one 14-day-back query so the
    // 7d sum and the prior-7d comparator come from the same read, bucketed
    // in JS below rather than 14 separate day-range queries.
    prisma.transaction.findMany({
      where: { brokerId, type: { in: ["DEPOSIT", "WITHDRAWAL"] }, status: "COMPLETED", createdAt: { gte: fourteenDaysAgo } },
      select: { type: true, amount: true, createdAt: true },
    }),
  ]);

  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const byDay = new Map<string, { deposits: number; withdrawals: number }>();
  for (let i = 6; i >= 0; i -= 1) {
    byDay.set(dayKey(new Date(now.getTime() - i * DAY_MS)), { deposits: 0, withdrawals: 0 });
  }
  let netDeposits7d = 0;
  let netDepositsPrior7d = 0;
  for (const t of depositsWithdrawals14d) {
    const amount = t.amount.toNumber();
    const signed = t.type === "DEPOSIT" ? amount : -amount;
    if (t.createdAt >= sevenDaysAgo) {
      netDeposits7d += signed;
      const bucket = byDay.get(dayKey(t.createdAt));
      if (bucket) {
        if (t.type === "DEPOSIT") bucket.deposits += amount;
        else bucket.withdrawals += amount;
      }
    } else {
      netDepositsPrior7d += signed;
    }
  }

  return NextResponse.json({
    totalClients,
    newClients7d,
    depositsSum30d: depositsSum._sum.amount?.toNumber() ?? 0,
    activeTrades,
    activeTradeAccountCount: activeTradeAccounts.length,
    pendingKyc,
    pendingWithdrawalCount: pendingWithdrawals._count,
    pendingWithdrawalSum: pendingWithdrawals._sum.amount?.toNumber() ?? 0,
    netDeposits7d,
    netDepositsPrior7d,
    depositsWithdrawalsByDay: [...byDay.entries()].map(([date, v]) => ({ date, deposits: v.deposits, withdrawals: v.withdrawals })),
    activity: activity.map((a) => ({
      id: a.id,
      actionLabel: humanizeAction(a.action),
      actorEmail: a.actorAdmin?.email ?? "system",
      entityId: a.entityId,
      entityType: a.entityType,
      createdAtLabel: a.createdAt.toISOString().replace("T", " ").slice(0, 19),
    })),
  });
}
